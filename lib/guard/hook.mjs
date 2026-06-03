#!/usr/bin/env node
// budget-guard — Claude Code / Codex hook core (Node 22+, zero deps).
//
// Public API (consumed by bin/guard.mjs and unit tests):
//   run(agent, phase, input, thresholds)  → JSON output or null
//   runDoctor(agent, thresholds)          → never returns; calls process.exit
//   phasePrompt / phasePre / phasePost / phaseStop / phaseResume  (exported)
//
// stdin  : one JSON object (the hook event). Empty / malformed → silent.
// stdout : zero or one JSON object (the hook response per CC/Codex protocol).
// stderr : one diagnostic line per swallowed error. NEVER on the success path.
//
// Phases:
//   prompt  UserPromptSubmit   — /goal /loop /batch /background → estimate
//   pre     PreToolUse         — hard line: deny new work; allow checkpoint
//   post    PostToolUse        — T1 once / T2 each / T3 urgent soft warning
//   stop    Stop / SubagentStop— hard line: continue:false + pending_<agent>.json
//   resume  SessionStart       — inject last checkpoint
//   doctor  (not a hook)       — human-readable diagnostics, exit 0-4
//
// Invariants (per CLAUDE.md / spec):
//   - fail-open: any error → stderr log, stdout empty, exit 0
//   - exit 0 + JSON only (no exit 2 mixing)
//   - thresholds resolved once at startup; per-call only via env override
//   - probe is the only network source; cache + 429 gate handled there

import { createHash } from 'node:crypto';
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync,
  renameSync, statSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve as resolvePath } from 'node:path';

import { checkThresholds, doctor, fetchUsage } from '../probe/index.mjs';
import { isCheckpointWrite } from './checkpoint.mjs';
import { shouldFire, pruneNotified } from './fingerprint.mjs';

// ─── small helpers ───────────────────────────────────────────────────────

function nowSec() {
  if (process.env.BUDGET_NOW_EPOCH) {
    const n = Number.parseInt(process.env.BUDGET_NOW_EPOCH, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return Math.floor(Date.now() / 1000);
}

function stateDir() {
  return process.env.BUDGET_STATE_DIR || join(homedir(), '.budget-guard');
}

function checkpointPath() {
  return process.env.BUDGET_CHECKPOINT || '.agent/checkpoint.md';
}

function fmtClock(epoch) {
  if (!Number.isFinite(epoch) || epoch <= 0) return '未知';
  try {
    const d = new Date(epoch * 1000);
    if (Number.isNaN(d.getTime())) return '未知';
    const h = String(d.getHours()).padStart(2, '0');
    const m = String(d.getMinutes()).padStart(2, '0');
    return `${h}:${m}`;
  } catch (_) { return '未知'; }
}

function fmtDuration(secs) {
  if (!Number.isFinite(secs)) return '充足';
  if (secs < 0) return '充足';
  if (secs < 5400) return `约 ${Math.ceil(secs / 60)} 分钟`;
  return `约 ${(secs / 3600).toFixed(1)} 小时`;
}

// Render a window-detail suffix for hard-line messages, e.g.
//   （触发窗口:rate_limit.primary_window; 窗口:primary=100%,secondary=76%）
// `触发窗口` is usage.bucket_id = the highest-util *resettable* bucket (see
// probe parse()). For every real Claude/Codex response that equals the gating
// window, because both APIs give every window a reset time (all buckets are
// resettable → hardWinner === warnWinner). It could only diverge in a defensive
// edge where a non-resettable bucket is the global max — unreachable for the
// supported agents — and even then the full `窗口:` list still shows every
// bucket's real util, so no information is lost. (Tracked as a known limitation.)
function usageDetail(usage) {
  const bucketId = typeof usage?.bucket_id === 'string' ? usage.bucket_id.trim() : '';
  const buckets = Array.isArray(usage?.buckets)
    ? usage.buckets
        .filter((b) => b && typeof b.id === 'string' && Number.isFinite(Number(b.util)))
        .map((b) => `${b.id.replace(/\s+/g, '_')}=${Math.floor(Number(b.util))}%`)
    : [];
  const parts = [];
  if (bucketId) parts.push(`触发窗口:${bucketId.replace(/\s+/g, '_')}`);
  if (buckets.length) parts.push(`窗口:${buckets.join(',')}`);
  return parts.length ? `（${parts.join('; ')}）` : '';
}

// Match /goal /loop /batch /background as standalone tokens. We allow any
// non-letter character on either side (slash command at the start of a
// message, after whitespace, after punctuation, in a code block, etc.).
// Bash counterpart: `(^|[[:space:]])/(goal|loop|batch|background)([[:space:]]|$)`.
const LONG_TASK_RE = /(?:^|[^\p{L}\p{N}_])\/(goal|loop|batch|background)(?=$|[^\p{L}\p{N}_])/iu;

function pickPromptText(input) {
  if (!input || typeof input !== 'object') return '';
  const v = input.prompt ?? input.user_prompt ?? input.tool_input?.prompt;
  return typeof v === 'string' ? v : '';
}

function readBody(path) {
  try {
    if (!existsSync(path)) return null;
    const body = readFileSync(path, 'utf8');
    if (!body || !body.trim()) return null;
    return body;
  } catch (_) { return null; }
}

async function readStdin() {
  // Hook stdin is one JSON object per invocation. Read whatever is available
  // (TTY/empty input just resolves to ''), and let parseInput() handle it.
  return new Promise((resolve) => {
    if (process.stdin.isTTY) { resolve(''); return; }
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { buf += chunk; });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', () => resolve(''));
  });
}

function parseInput(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); }
  catch (_) {
    // Some hosts buffer and send a trailing line — try last non-empty line.
    const lines = trimmed.split(/\r?\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try { return JSON.parse(lines[i]); } catch (_) { /* keep trying */ }
    }
    return null;
  }
}

// ─── pending queue (watchdog reads this) ────────────────────────────────
//
// Per-scope file: pending/<agent>_<scope>.json
//   scope = sha256(realpath(cwd) + sessionId).slice(0,16)
//
// This prevents concurrent projects from overwriting each other's pending
// state.  Watchdog (watchdog.sh) reads pending/<agent>_*.json (glob) so it
// naturally picks up all scopes.
//
// Legacy flat file: pending_<agent>.json
// Written simultaneously for backward compatibility with watchdog versions
// that only know the old path.  Both files carry identical payload; watchdog
// de-duplicates by session_id if needed.

function pendingScope(cwd, sessionId) {
  let realCwd = cwd;
  try { realCwd = resolvePath(cwd); } catch (_) { /* keep cwd as-is */ }
  return createHash('sha256')
    .update(realCwd + sessionId)
    .digest('hex')
    .slice(0, 16);
}

function writePending(agent, input, usage) {
  try {
    const dir = stateDir();
    const pendingDir = join(dir, 'pending');
    mkdirSync(pendingDir, { recursive: true });

    const sessionId = String(input?.session_id || input?.thread_id || '');
    const cwd = process.env.BUDGET_CWD_OVERRIDE || process.cwd();

    // Hard-line semantics (T3): the value that triggered the stop is
    // warn_util (the conservative max across all util-bearing buckets).
    // util (= hard_max) can be 0 if no resettable bucket was the trigger
    // (e.g. a non-resettable bucket hit T3). Watchdog must see this same
    // number on resume to make the right "is the window refreshed?" call.
    const triggerUtil = Number.isFinite(usage.warn_util)
      ? usage.warn_util
      : (Number.isFinite(usage.util) ? usage.util : 0);
    const pending = {
      status: 'paused',
      agent,
      session_id: sessionId,
      cwd,
      reset_epoch: Number.isFinite(usage.reset_epoch) ? usage.reset_epoch : 0,
      util: triggerUtil,
      warn_util: triggerUtil,
      at: nowSec(),
    };
    const payload = JSON.stringify(pending);

    // Primary: per-scope file (prevents multi-project collisions)
    const scope = pendingScope(cwd, sessionId);
    const scopedPath = join(pendingDir, `${agent}_${scope}.json`);
    const scopedTmp = `${scopedPath}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(scopedTmp, payload);
    renameSync(scopedTmp, scopedPath);

    // Legacy: flat file for watchdog backward compatibility
    const legacyPath = join(dir, `pending_${agent}.json`);
    const legacyTmp = `${legacyPath}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(legacyTmp, payload);
    renameSync(legacyTmp, legacyPath);
  } catch (_) { /* fail-open */ }
}

// ─── manual hard-line skip (override) ────────────────────────────────────
//
// The hard line denies by default. When the user EXPLICITLY authorizes a skip
// (an override phrase in their prompt — never plain "继续"), we record a
// time-boxed, project-scoped marker. While valid, pre/stop do NOT enforce the
// hard line, letting the user finish a task that is "just short" of done. The
// marker auto-expires (default 30 min). Bash counterpart: budget_guard.sh
// write_skip / skip_remaining / override phrase grep — must stay behaviorally
// identical.
//
// Trigger phrases (latin case-insensitive): /budget-skip, force-continue,
// 跳过硬线, 强制继续.  Scoped per project (cwd), not per session, so the grant
// survives across turns within the same project for its TTL.

const OVERRIDE_RE = /\/budget-skip|force-continue|跳过硬线|强制继续/i;

function skipScope() {
  const cwd = process.env.BUDGET_CWD_OVERRIDE || process.cwd();
  let real = cwd;
  try { real = resolvePath(cwd); } catch (_) { /* keep cwd */ }
  return createHash('sha256').update(real).digest('hex').slice(0, 16);
}

function skipTtl() {
  const raw = process.env.BUDGET_SKIP_TTL;
  if (raw !== undefined && /^\d+$/.test(String(raw).trim())) {
    return Number.parseInt(String(raw).trim(), 10);
  }
  return 1800; // 30 min
}

function skipMarkerPath(agent) {
  return join(stateDir(), 'skip', `${agent}_${skipScope()}.json`);
}

// Record a hard-line skip authorization. Returns the expiry epoch (0 on error).
function writeSkip(agent) {
  try {
    const dir = join(stateDir(), 'skip');
    mkdirSync(dir, { recursive: true });
    const path = skipMarkerPath(agent);
    const expires = nowSec() + skipTtl();
    const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmp, JSON.stringify({ expires }));
    renameSync(tmp, path);
    return expires;
  } catch (_) { return 0; }
}

// Seconds remaining on an active skip authorization, or 0 if none/expired.
// Cleans up the marker once expired.
function skipRemaining(agent) {
  try {
    const path = skipMarkerPath(agent);
    if (!existsSync(path)) return 0;
    const data = JSON.parse(readFileSync(path, 'utf8'));
    const expires = Number(data?.expires);
    if (!Number.isFinite(expires)) return 0;
    const rem = expires - nowSec();
    if (rem > 0) return rem;
    try { unlinkSync(path); } catch (_) { /* best-effort */ }
    return 0;
  } catch (_) { return 0; }
}

// ─── phase: prompt (UserPromptSubmit) ────────────────────────────────────

export async function phasePrompt(agent, input, th) {
  const text = pickPromptText(input);

  // Manual hard-line skip authorization. Explicit phrase only (never plain
  // "继续"). Records a time-boxed marker; does not need a usage lookup.
  if (text && OVERRIDE_RE.test(text)) {
    writeSkip(agent);
    const mins = Math.max(1, Math.round(skipTtl() / 60));
    const msg = `[额度] 已记录硬线手动跳过授权:接下来约 ${mins} 分钟内,即使到硬线也不强停`
      + `(触发窗口仍会提示),到期自动恢复拦截。`;
    if (agent === 'claude') {
      return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: msg } };
    }
    if (agent === 'codex') return { systemMessage: msg };
    return null;
  }

  if (!text || !LONG_TASK_RE.test(text)) return null;

  const usage = await fetchUsage(agent);
  if (!usage || !usage.ok) return null;

  const util = usage.util;
  const resetEpoch = usage.reset_epoch;
  const cp = checkpointPath();
  const remaining = Math.max(0, 100 - util);
  const resetFmt = fmtClock(resetEpoch);

  // P1 has no burn-rate algorithm; the estimate is util + reset time only.
  // (Burn-rate math is P2; we just don't fabricate a duration number here.)
  const tail = `当前已用 ${util}%(剩余 ${remaining}%,预警线 ${th.warnRepeat}%,硬线 ${th.hard}%)。`
    + `额度刷新时间 ${resetFmt}。`
    + `建议把目标切成能在该时长内完成的小块,每块结束写一次 ${cp};`
    + `若长任务可能超时,先做最关键的部分。`;

  if (agent === 'claude') {
    return {
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: `[额度预估] ${tail}`,
      },
    };
  }
  if (agent === 'codex') {
    return { systemMessage: `[额度预估] ${tail}` };
  }
  return null;
}

// ─── phase: pre (PreToolUse) ─────────────────────────────────────────────

export async function phasePre(agent, input, th) {
  const usage = await fetchUsage(agent);
  if (!usage || !usage.ok) return null;

  // Hard line gates on warn_util (max across ALL util-bearing buckets,
  // including non-resettable ones), consistent with phasePost T3 and
  // phaseStop. Using util (=hard_max) here would let an agent keep running
  // tools when a non-resettable bucket is the one maxed out (warn_util high,
  // hard_max 0) right up until the Stop boundary — Stop would force-stop but
  // Pre would not deny. All three phases now agree on warn_util.
  const hardUtil = Number.isFinite(usage.warn_util) ? usage.warn_util : usage.util;
  if (hardUtil < th.hard) return null;

  // Hard line. Allow writes to the checkpoint itself; deny everything else.
  const cp = checkpointPath();
  if (isCheckpointWrite(input, agent, cp)) return null;

  // Manual skip active → allow silently (silence-first; the user already got a
  // confirmation when granting the skip, and post/stop keep them informed).
  if (skipRemaining(agent) > 0) return null;

  const reset = fmtClock(usage.reset_epoch);
  const reason = `额度 ${hardUtil}%≥${th.hard}% 硬线${usageDetail(usage)}。停止新工作,只写 ${cp},别绕。`
    + (reset !== '未知' ? ` 刷新约 ${reset}。` : '');

  if (agent === 'claude' || agent === 'codex') {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    };
  }
  return null;
}

// ─── phase: post (PostToolUse) ───────────────────────────────────────────

export async function phasePost(agent, input, th) {
  const usage = await fetchUsage(agent);
  if (!usage || !usage.ok) return null;

  // warn_util drives T1/T2; util drives T3. fall back to util if missing.
  const warnUtil = Number.isFinite(usage.warn_util) ? usage.warn_util : usage.util;
  const bucketId = usage.bucket_id || '';
  const resetEpoch = Number.isFinite(usage.reset_epoch) ? usage.reset_epoch : 0;
  const cp = checkpointPath();

  let message = null;

  if (warnUtil >= th.hard) {
    // T3 imminent (in PostToolUse, before Stop): strong reminder, fires once
    // per hard crossing. Check the skip FIRST so an active skip does NOT consume
    // the real hard-crossing fingerprint — the fp key is bucket+reset+threshold,
    // NOT util (see fingerprint.mjs buildFp), so it would not re-arm as util
    // climbs, and consuming it under skip would permanently suppress the genuine
    // "Stop will force-stop" warning once the skip lapses. Under skip we
    // acknowledge once via a separate fingerprint namespace (`<bucket>#skip`),
    // leaving the real fp untouched so it fires once after the skip expires.
    const skipRem = skipRemaining(agent);
    if (skipRem > 0) {
      if (shouldFire(agent, warnUtil, `${bucketId}#skip`, resetEpoch, th.hard)) {
        const mins = Math.max(1, Math.round(skipRem / 60));
        message = `额度已用 ${warnUtil}%≥硬线 ${th.hard}%${usageDetail(usage)}。`
          + `硬线已手动跳过,约 ${mins} 分钟内不强停;到期恢复拦截,注意刷新前收尾。`;
      }
    } else if (shouldFire(agent, warnUtil, bucketId, resetEpoch, th.hard)) {
      message = `额度已用 ${warnUtil}%≥硬线 ${th.hard}%${usageDetail(usage)}。本轮 Stop 钩子将强停:`
        + `立即把进度写进 ${cp},然后调 wait_until_budget_refresh 原地 park,`
        + `或交给 watchdog 续跑。别等硬切。`;
    }
  } else if (warnUtil >= th.warnRepeat) {
    // T2: every PostToolUse. No fingerprint.
    message = `额度已用 ${warnUtil}%(≥软线 ${th.warnRepeat}%)。收尾手头这步,`
      + `把进度写进 ${cp} 准备暂停,别等硬线被打断。`;
  } else if (warnUtil >= th.warnOnce) {
    // T1: once per window.
    if (shouldFire(agent, warnUtil, bucketId, resetEpoch, th.warnOnce)) {
      message = `额度已用 ${warnUtil}%(≥预警线 ${th.warnOnce}%)。本会话额度已过半,`
        + `长任务请规划好分块,每块结束写 ${cp} 续接点。`;
    }
  }

  if (!message) return null;

  if (agent === 'claude') {
    return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: message } };
  }
  if (agent === 'codex') {
    return { systemMessage: message };
  }
  return null;
}

// ─── phase: stop (Stop / SubagentStop) ───────────────────────────────────

export async function phaseStop(agent, input, th) {
  const usage = await fetchUsage(agent);
  if (!usage || !usage.ok) return null;

  // Use warn_util (max across ALL util-bearing buckets, including ones
  // without a parsable reset) for hard-line gating, not the narrower
  // hard_max. Reason: PostToolUse (T3) fires on warn_util; Stop must agree,
  // otherwise PostToolUse can announce "Stop 钩子将强停" and then Stop
  // fails to fire (because hard_max=0) — leaving the agent running.
  // See review finding T3/stop util drift.
  const warnUtil = Number.isFinite(usage.warn_util) ? usage.warn_util : usage.util;
  const cp = checkpointPath();

  if (warnUtil >= th.hard) {
    // Manual skip active → do NOT force-stop; let the loop continue. No pending
    // is written (we're not pausing). Codex gets a surfaced note; on claude the
    // Stop stdout isn't surfaced, so we just decline to set continue:false.
    const skipRem = skipRemaining(agent);
    if (skipRem > 0) {
      const mins = Math.max(1, Math.round(skipRem / 60));
      const note = `额度 ${warnUtil}%≥${th.hard}% 硬线${usageDetail(usage)},但已手动跳过`
        + `(约 ${mins} 分钟后恢复拦截)。继续推进,注意在刷新前完成收尾。`;
      if (agent === 'codex') return { systemMessage: note };
      return null;
    }

    // Hard line at the round boundary: write pending state, force stop.
    writePending(agent, input, usage);
    const reset = fmtClock(usage.reset_epoch);
    let stopReason = `额度 ${warnUtil}%≥${th.hard}% 硬线${usageDetail(usage)},已干净停下。`
      + (reset !== '未知' ? `刷新约 ${reset}。` : '')
      + `刷新后请调 wait_until_budget_refresh 或由 watchdog 续跑。`;
    if (agent === 'codex') {
      // Collaborative (not enforced — hooks cannot call /goal slash). The
      // agent reads stopReason and chooses to pause via app-server.
      stopReason += ' 建议调 /goal pause 或 continue 走 app-server pause。';
    }
    return { continue: false, stopReason };
  }

  // Soft line: just a nudge to wrap up. No stop. Gate on warn_util (same
  // policy as phasePost T2) so a non-resettable bucket at e.g. 91% nudges
  // consistently — using hard_max here would stay silent while PostToolUse
  // already warned, an inconsistency flagged in review.
  if (warnUtil >= th.warnRepeat) {
    // On claude, Stop hook stdout is consumed by the harness — systemMessage
    // is generally not surfaced to the user at this phase, so we stay silent
    // (静默优先) and only emit on codex where systemMessage is surfaced.
    if (agent === 'codex') {
      return { systemMessage: `额度 ${warnUtil}%,建议本轮收尾并写 ${cp}。` };
    }
    return null;
  }

  return null;
}

// ─── phase: resume (SessionStart) ────────────────────────────────────────

// Read the cwd recorded in the most-recent pending file for this agent.
// Returns null if no pending file exists or cwd field is absent/invalid.
//
// "Most-recent" is by file mtime (NOT readdir order, which is filesystem /
// alphabetical and would pick an arbitrary project's checkpoint when several
// scopes have pending files). The legacy flat file is the last fallback.
function pendingCwd(agent) {
  const dir = stateDir();
  let scoped = [];
  try {
    const pendingDir = join(dir, 'pending');
    scoped = readdirSync(pendingDir)
      .filter((f) => f.startsWith(`${agent}_`) && f.endsWith('.json'))
      .map((f) => join(pendingDir, f))
      .map((p) => {
        let mtime = 0;
        try { mtime = statSync(p).mtimeMs; } catch (_) { /* unreadable */ }
        return { p, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime) // newest first
      .map((e) => e.p);
  } catch (_) { /* pending dir may not exist */ }

  const candidates = [...scoped, join(dir, `pending_${agent}.json`)];
  for (const p of candidates) {
    try {
      const raw = readFileSync(p, 'utf8');
      const obj = JSON.parse(raw);
      if (typeof obj.cwd === 'string' && obj.cwd.length > 0) return obj.cwd;
    } catch (_) { /* skip unreadable or malformed */ }
  }
  return null;
}

export async function phaseResume(agent, input, th) {
  // SessionStart fires once per session — a natural, low-frequency point to
  // prune stale fingerprint entries (passed-reset windows + aged-out
  // non-resettable fps). Best-effort; never blocks resume.
  try { pruneNotified(nowSec()); } catch (_) { /* hygiene only */ }

  const cp = checkpointPath();

  // Resolution priority (matches writePending's BUDGET_CWD_OVERRIDE logic):
  //  1. BUDGET_CWD_OVERRIDE env var (explicit override)
  //  2. process.cwd() — works correctly when cwd did NOT change
  //  3. cwd recorded in the most-recent pending file for this agent — fallback
  //     when a worktree or multi-project scenario changes cwd between sessions
  const overrideCwd = process.env.BUDGET_CWD_OVERRIDE;
  const resolvedBase = overrideCwd || process.cwd();
  const absCp = isAbsolute(cp) ? cp : resolvePath(resolvedBase, cp);

  let body = readBody(absCp);
  if (!body && !overrideCwd && !isAbsolute(cp)) {
    // cwd may have changed between sessions; try the cwd from the pending file.
    const savedCwd = pendingCwd(agent);
    if (savedCwd) {
      const altCp = resolvePath(savedCwd, cp);
      body = readBody(altCp);
    }
  }
  if (!body) return null;

  // Best-effort util for the "(当前已用 X%)" annotation. Missing is fine —
  // we just report '?' rather than failing the whole resume.
  let utilStr = '?';
  try {
    const usage = await fetchUsage(agent);
    if (usage && usage.ok && Number.isFinite(usage.util)) utilStr = String(usage.util);
  } catch (_) { /* ignore */ }

  const msg = `【续接】发现上次未完成任务的 checkpoint(当前已用 ${utilStr}%)。`
    + `从「下一步」继续,跳过「已完成」。\n\n${body}`;

  if (agent === 'claude') {
    return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: msg } };
  }
  if (agent === 'codex') {
    return { systemMessage: msg };
  }
  return null;
}

// ─── dispatcher (library entry) ─────────────────────────────────────────

/**
 * Run a single hook event. Returns the JSON to write to stdout, or null
 * for silent. Never throws — any internal error is swallowed and returns
 * null (fail-open).
 *
 * @param {string}  agent
 * @param {string}  phase       one of prompt|pre|post|stop|resume
 * @param {object}  input       parsed stdin JSON (or null)
 * @param {object}  thresholds  result of checkThresholds(process.env)
 */
export async function run(agent, phase, input, th) {
  if (!agent || !phase) return null;
  try {
    switch (phase) {
      case 'prompt': return await phasePrompt(agent, input, th);
      case 'pre':    return await phasePre(agent, input, th);
      case 'post':   return await phasePost(agent, input, th);
      case 'stop':   return await phaseStop(agent, input, th);
      case 'resume': return await phaseResume(agent, input, th);
      default:       return null;
    }
  } catch (e) {
    process.stderr.write(`guard[${phase}] ${agent}: ${e?.message || e}\n`);
    return null;
  }
}

// ─── doctor (human-readable diagnostics, exit 0-4) ──────────────────────

// Re-export so bin/guard.mjs can resolve thresholds through the same module
// graph without taking a separate dependency on ../probe/index.mjs.
export { checkThresholds } from '../probe/index.mjs';

export async function runDoctor(agent, th) {
  let d;
  try {
    d = await doctor(agent);
  } catch (e) {
    process.stdout.write(`guard[${agent}]: probe doctor failed: ${e?.message || e}\n`);
    process.exit(2);
  }

  const dir = stateDir();
  const cp = checkpointPath();
  const notifiedDir = join(dir, 'notified');
  let fingerprintFiles = 0;
  try {
    fingerprintFiles = readdirSync(notifiedDir).filter((f) => f.endsWith('.json')).length;
  } catch (_) { /* ignore */ }

  process.stdout.write(`guard[${agent}]: ${d.code === 0 ? 'OK' : `EXIT=${d.code}`}\n`);
  process.stdout.write(`  thresholds: warnOnce=${th.warnOnce} warnRepeat=${th.warnRepeat} hard=${th.hard}\n`);
  for (const c of d.checks || []) {
    process.stdout.write(`  [${c.ok ? '+' : '-'}] ${c.name}: ${c.detail}\n`);
  }
  process.stdout.write(`  state_dir: ${dir}\n`);
  process.stdout.write(`  checkpoint: ${cp}\n`);
  process.stdout.write(`  fingerprints: ${fingerprintFiles} file(s) in ${notifiedDir}\n`);

  if (d.probe && Array.isArray(d.probe.buckets)) {
    for (const b of d.probe.buckets) {
      const tag = b.id === d.probe.bucket_id ? '*' : ' ';
      const r = b.reset_epoch > 0 ? new Date(b.reset_epoch * 1000).toISOString() : '<no reset>';
      process.stdout.write(`    ${tag} ${b.id}: util=${b.util} resettable=${b.resettable} resets_at=${r}\n`);
    }
    if (d.probe.extra_usage) {
      process.stdout.write(`      extra_usage: util=${d.probe.extra_usage.util} enabled=${d.probe.extra_usage.is_enabled}\n`);
    }
  }

  // doctor is a CLI subcommand — exit with the probe's code.
  process.exit(d.code);
}

// ─── CLI dispatch lives in bin/guard.mjs (this module is a library) ──────
