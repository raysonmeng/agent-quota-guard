/**
 * Regression tests for the manual hard-line skip (override) feature.
 *
 * The hard line denies by default. When the user EXPLICITLY authorizes a skip
 * (an override phrase — never plain "继续"), pre/stop stop enforcing the hard
 * line for a time-boxed, project-scoped window. The grant auto-expires.
 *
 * Two surfaces must behave identically:
 *   - Node hook core: lib/guard/hook.mjs  (phasePrompt / phasePre / phasePost / phaseStop)
 *   - Bash guard:     budget_guard.sh     (prompt / pre / stop phases)
 *
 * Run: node --test tests/override.test.mjs
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  phasePost, phasePre, phasePrompt, phaseStop,
} from '../lib/guard/hook.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(here, '..');
const NOW = 1748850000; // fixed epoch
const TH = { warnOnce: 80, warnRepeat: 90, hard: 92 };

// ─── shared helpers ───────────────────────────────────────────────────────

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'budget-override-test-'));
}

async function withEnvAsync(overrides, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(overrides)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// Reconstruct the Node skip-marker path (mirrors hook.mjs skipScope/skipMarkerPath:
// sha256(path.resolve(cwd)).slice(0,16)). cwd here is the BUDGET_CWD_OVERRIDE value.
function nodeSkipMarker(stateDir, agent, cwd) {
  const scope = createHash('sha256').update(resolve(cwd)).digest('hex').slice(0, 16);
  return join(stateDir, 'skip', `${agent}_${scope}.json`);
}

function makeClaudeHardFixture(dir, util) {
  const resetsAt = new Date((NOW + 3600) * 1000).toISOString();
  const obj = { five_hour: { utilization: util, resets_at: resetsAt } };
  const path = join(dir, `claude-hard-${util}.json`);
  writeFileSync(path, JSON.stringify(obj));
  return path;
}

function makeCodexHardFixture(dir, usedPercent) {
  const obj = {
    rate_limit: {
      primary_window: { used_percent: usedPercent, reset_at: NOW + 3600, limit_window_seconds: 18000, reset_after_seconds: 3600 },
      secondary_window: { used_percent: 40, reset_at: NOW + 604800, limit_window_seconds: 604800, reset_after_seconds: 604800 },
    },
    additional_rate_limits: [],
  };
  const path = join(dir, `codex-hard-${usedPercent}.json`);
  writeFileSync(path, JSON.stringify(obj));
  return path;
}

const BASH_INPUT = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } });

// ─── Node: phasePrompt grant semantics ────────────────────────────────────

test('Node phasePrompt: /budget-skip grants a scoped, time-boxed marker (claude additionalContext)', async () => {
  const dir = tempDir();
  try {
    const res = await withEnvAsync(
      { BUDGET_STATE_DIR: dir, BUDGET_CWD_OVERRIDE: dir, BUDGET_NOW_EPOCH: String(NOW) },
      () => phasePrompt('claude', { prompt: '/budget-skip 还差一点收尾' }, TH),
    );
    const ctx = res?.hookSpecificOutput?.additionalContext || '';
    assert.match(ctx, /手动跳过授权/, 'grant emits a confirmation to the agent');
    assert.equal(res.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.ok(existsSync(nodeSkipMarker(dir, 'claude', dir)), 'marker file written');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Node phasePrompt: plain "继续" does NOT grant (no marker, returns null)', async () => {
  const dir = tempDir();
  try {
    const res = await withEnvAsync(
      { BUDGET_STATE_DIR: dir, BUDGET_CWD_OVERRIDE: dir, BUDGET_NOW_EPOCH: String(NOW) },
      () => phasePrompt('claude', { prompt: '继续完成刚才的任务' }, TH),
    );
    assert.equal(res, null, 'plain 继续 is not an override phrase');
    assert.equal(existsSync(nodeSkipMarker(dir, 'claude', dir)), false, 'no marker written');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Node phasePrompt: every documented override phrase grants', async () => {
  for (const phrase of ['/budget-skip', 'force-continue', '跳过硬线', '强制继续', 'FORCE-CONTINUE']) {
    const dir = tempDir();
    try {
      const res = await withEnvAsync(
        { BUDGET_STATE_DIR: dir, BUDGET_CWD_OVERRIDE: dir, BUDGET_NOW_EPOCH: String(NOW) },
        () => phasePrompt('claude', { prompt: `请 ${phrase} 把这步做完` }, TH),
      );
      const ctx = res?.hookSpecificOutput?.additionalContext || '';
      assert.match(ctx, /手动跳过授权/, `phrase should grant: ${phrase}`);
      assert.ok(existsSync(nodeSkipMarker(dir, 'claude', dir)), `marker written for: ${phrase}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('Node phasePrompt: codex override grant uses systemMessage', async () => {
  const dir = tempDir();
  try {
    const res = await withEnvAsync(
      { BUDGET_STATE_DIR: dir, BUDGET_CWD_OVERRIDE: dir, BUDGET_NOW_EPOCH: String(NOW) },
      () => phasePrompt('codex', { prompt: '强制继续' }, TH),
    );
    assert.match(res?.systemMessage || '', /手动跳过授权/);
    assert.ok(existsSync(nodeSkipMarker(dir, 'codex', dir)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Node: pre / stop honor an active skip; remind/force-stop without one ───

test('Node phasePre: active skip allows at hard line; absent skip reminds without deny', async () => {
  // with skip
  const dir = tempDir();
  try {
    const fx = makeClaudeHardFixture(dir, 95);
    const env = { BUDGET_STATE_DIR: dir, BUDGET_CWD_OVERRIDE: dir, BUDGET_NOW_EPOCH: String(NOW), BUDGET_USAGE_FIXTURE: fx };
    await withEnvAsync(env, () => phasePrompt('claude', { prompt: '/budget-skip' }, TH));
    const allowed = await withEnvAsync(env, () => phasePre('claude', JSON.parse(BASH_INPUT), TH));
    assert.equal(allowed, null, 'active skip → pre returns null (allow)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // without skip (fresh scope)
  const dir2 = tempDir();
  try {
    const fx2 = makeClaudeHardFixture(dir2, 95);
    const env2 = { BUDGET_STATE_DIR: dir2, BUDGET_CWD_OVERRIDE: dir2, BUDGET_NOW_EPOCH: String(NOW), BUDGET_USAGE_FIXTURE: fx2 };
    const reminded = await withEnvAsync(env2, () => phasePre('claude', JSON.parse(BASH_INPUT), TH));
    assert.equal(reminded?.hookSpecificOutput?.permissionDecision, undefined, 'no skip → pre does not deny');
    assert.equal(reminded?.hookSpecificOutput?.permissionDecisionReason, undefined, 'no skip → no deny reason');
    assert.match(reminded?.hookSpecificOutput?.additionalContext || '', /不会强制拦截/, 'no skip → pre reminds');
  } finally {
    rmSync(dir2, { recursive: true, force: true });
  }
});

test('Node phaseStop: active skip does NOT force-stop; absent skip does', async () => {
  // claude, with skip → null (no continue:false), and no pending written
  const dir = tempDir();
  try {
    const fx = makeClaudeHardFixture(dir, 95);
    const env = { BUDGET_STATE_DIR: dir, BUDGET_CWD_OVERRIDE: dir, BUDGET_NOW_EPOCH: String(NOW), BUDGET_USAGE_FIXTURE: fx };
    await withEnvAsync(env, () => phasePrompt('claude', { prompt: '/budget-skip' }, TH));
    const res = await withEnvAsync(env, () => phaseStop('claude', { session_id: 's1' }, TH));
    assert.equal(res, null, 'claude + active skip → no continue:false at Stop');
    assert.equal(existsSync(join(dir, 'pending')), false, 'no pending queue written under skip');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // claude, without skip → continue:false + pending written
  const dir2 = tempDir();
  try {
    const fx2 = makeClaudeHardFixture(dir2, 95);
    const env2 = { BUDGET_STATE_DIR: dir2, BUDGET_CWD_OVERRIDE: dir2, BUDGET_NOW_EPOCH: String(NOW), BUDGET_USAGE_FIXTURE: fx2 };
    const res2 = await withEnvAsync(env2, () => phaseStop('claude', { session_id: 's1' }, TH));
    assert.ok(res2 && res2.continue === false, 'no skip → force-stop');
    assert.ok(existsSync(join(dir2, 'pending')), 'pending queue written when forcing stop');
  } finally {
    rmSync(dir2, { recursive: true, force: true });
  }
});

test('Node phaseStop: codex + active skip surfaces a systemMessage, not continue:false', async () => {
  const dir = tempDir();
  try {
    const fx = makeCodexHardFixture(dir, 95);
    const env = { BUDGET_STATE_DIR: dir, BUDGET_CWD_OVERRIDE: dir, BUDGET_NOW_EPOCH: String(NOW), BUDGET_USAGE_FIXTURE: fx };
    await withEnvAsync(env, () => phasePrompt('codex', { prompt: '/budget-skip' }, TH));
    const res = await withEnvAsync(env, () => phaseStop('codex', { session_id: 's1' }, TH));
    assert.equal(res?.continue, undefined, 'codex + skip → no continue:false');
    assert.match(res?.systemMessage || '', /已手动跳过/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Node phasePost: skip-active T3 acknowledges once and does NOT swallow the post-expiry warning', async () => {
  // Regression guard: the skip-active message must use a separate fingerprint
  // namespace so it does not consume the real hard-crossing fingerprint. The
  // fp key is bucket+reset+threshold (not util), so a consumed real fp would
  // never re-arm — permanently suppressing the genuine "Stop 钩子将强停" warning
  // after the skip lapses.
  const dir = tempDir();
  try {
    const fx = makeClaudeHardFixture(dir, 95);
    const base = { BUDGET_STATE_DIR: dir, BUDGET_CWD_OVERRIDE: dir, BUDGET_USAGE_FIXTURE: fx };

    // grant a 60s skip at NOW
    await withEnvAsync(
      { ...base, BUDGET_NOW_EPOCH: String(NOW), BUDGET_SKIP_TTL: '60' },
      () => phasePrompt('claude', { prompt: '/budget-skip' }, TH),
    );

    // first post under skip → acknowledges the skip, never threatens force-stop
    const r1 = await withEnvAsync({ ...base, BUDGET_NOW_EPOCH: String(NOW) }, () => phasePost('claude', {}, TH));
    const c1 = r1?.hookSpecificOutput?.additionalContext || '';
    assert.match(c1, /手动跳过/, 'T3 post acknowledges the skip');
    assert.doesNotMatch(c1, /Stop 钩子将强停/, 'no false force-stop threat while skip is active');

    // second post under skip → silent (skip-ack fingerprint already fired)
    const r2 = await withEnvAsync({ ...base, BUDGET_NOW_EPOCH: String(NOW) }, () => phasePost('claude', {}, TH));
    assert.equal(r2, null, 'skip-ack fires once per window (silence-first)');

    // skip expired → the REAL T3 warning must still fire exactly once
    const r3 = await withEnvAsync({ ...base, BUDGET_NOW_EPOCH: String(NOW + 61) }, () => phasePost('claude', {}, TH));
    const c3 = r3?.hookSpecificOutput?.additionalContext || '';
    assert.match(c3, /Stop 钩子将强停/, 'post-expiry: real T3 warning fires (fp was not consumed by the skip)');

    // and only once
    const r4 = await withEnvAsync({ ...base, BUDGET_NOW_EPOCH: String(NOW + 62) }, () => phasePost('claude', {}, TH));
    assert.equal(r4, null, 'real T3 fingerprint then dedups');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Node phasePost: without a skip, T3 warns the Stop hook will force-stop', async () => {
  const dir = tempDir();
  try {
    const fx = makeClaudeHardFixture(dir, 95);
    const env = { BUDGET_STATE_DIR: dir, BUDGET_CWD_OVERRIDE: dir, BUDGET_NOW_EPOCH: String(NOW), BUDGET_USAGE_FIXTURE: fx };
    const res = await withEnvAsync(env, () => phasePost('claude', {}, TH));
    const ctx = res?.hookSpecificOutput?.additionalContext || '';
    assert.match(ctx, /Stop 钩子将强停/, 'no skip → T3 warns Stop will force-stop');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Node: an expired skip re-enables the hard-line reminder and cleans the marker', async () => {
  const dir = tempDir();
  try {
    const fx = makeClaudeHardFixture(dir, 95);
    const grantEnv = { BUDGET_STATE_DIR: dir, BUDGET_CWD_OVERRIDE: dir, BUDGET_NOW_EPOCH: String(NOW), BUDGET_SKIP_TTL: '60' };
    await withEnvAsync(grantEnv, () => phasePrompt('claude', { prompt: '/budget-skip' }, TH));
    assert.ok(existsSync(nodeSkipMarker(dir, 'claude', dir)), 'marker present right after grant');

    // 61s later: marker expired → pre must remind again and remove the stale marker
    const lateEnv = { BUDGET_STATE_DIR: dir, BUDGET_CWD_OVERRIDE: dir, BUDGET_NOW_EPOCH: String(NOW + 61), BUDGET_USAGE_FIXTURE: fx };
    const reminded = await withEnvAsync(lateEnv, () => phasePre('claude', JSON.parse(BASH_INPUT), TH));
    assert.equal(reminded?.hookSpecificOutput?.permissionDecision, undefined, 'expired skip → no deny');
    assert.match(reminded?.hookSpecificOutput?.additionalContext || '', /不会强制拦截/, 'expired skip → reminder returns');
    assert.equal(existsSync(nodeSkipMarker(dir, 'claude', dir)), false, 'expired marker cleaned up');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Bash integration: spawn budget_guard.sh and feed hook JSON on stdin ───

const guardPath = join(rootDir, 'codex-budget-guard', 'budget_guard.sh');

function runBash(args, { cwd, env, input } = {}) {
  return new Promise((res, rej) => {
    const child = spawn('bash', args, { cwd, env });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); rej(new Error(`bash timed out: ${args.join(' ')}`)); }, 10_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', (e) => { clearTimeout(timer); rej(e); });
    child.on('close', (code) => { clearTimeout(timer); res({ code, stdout, stderr }); });
    if (input !== undefined) child.stdin.write(input);
    child.stdin.end();
  });
}

async function bashScratch() {
  const root = mkdtempSync(join(tmpdir(), 'budget-override-bash-'));
  const state = join(root, 'state');
  const proj = join(root, 'proj');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(state, { recursive: true });
  await mkdir(proj, { recursive: true });
  const fakeProbe = join(root, 'fake-probe');
  await writeFile(
    fakeProbe,
    ['#!/usr/bin/env bash', 'printf \'{"ok":true,"util":95,"warn_util":95,"reset_epoch":0}\\n\''].join('\n') + '\n',
    { mode: 0o755 },
  );
  return { root, state, proj, fakeProbe };
}

test('Bash prompt: /budget-skip writes a scoped marker and confirms the grant', async () => {
  const { root, state, proj } = await bashScratch();
  try {
    const res = await runBash([guardPath, 'claude', 'prompt'], {
      cwd: proj,
      env: { ...process.env, HOME: root, BUDGET_STATE_DIR: state },
      input: JSON.stringify({ prompt: '/budget-skip 还差一点点就完成' }),
    });
    assert.equal(res.code, 0, `prompt phase should exit 0, stderr=${res.stderr}`);
    assert.match(res.stdout, /手动跳过授权/, 'grant message emitted');
    const markers = await readdir(join(state, 'skip'));
    assert.ok(markers.some((f) => /^claude_.*\.json$/.test(f)), 'a claude skip marker was written');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Bash: an active skip lets pre allow at the hard line and keeps stop from force-stopping', async () => {
  const { root, state, proj, fakeProbe } = await bashScratch();
  try {
    const env = { ...process.env, HOME: root, BUDGET_STATE_DIR: state, BUDGET_PROBE: fakeProbe, BUDGET_HARD: '92' };

    // grant (same cwd → same scope as the pre/stop calls below)
    const grant = await runBash([guardPath, 'claude', 'prompt'], {
      cwd: proj, env, input: JSON.stringify({ prompt: '跳过硬线' }),
    });
    assert.equal(grant.code, 0, `grant stderr=${grant.stderr}`);

    // pre at hard line → allowed silently (no deny payload)
    const pre = await runBash([guardPath, 'claude', 'pre'], { cwd: proj, env, input: BASH_INPUT });
    assert.equal(pre.code, 0, `pre stderr=${pre.stderr}`);
    assert.equal(pre.stdout.trim(), '', 'active skip → pre allows with no output');

    // stop at hard line → no continue:false, no pending written
    const stop = await runBash([guardPath, 'claude', 'stop'], {
      cwd: proj, env, input: JSON.stringify({ session_id: 's1' }),
    });
    assert.equal(stop.code, 0, `stop stderr=${stop.stderr}`);
    assert.doesNotMatch(stop.stdout, /"continue":\s*false/, 'active skip → stop does not force-stop');
    assert.equal(existsSync(join(state, 'pending')), false, 'no pending queue written under skip');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Bash: without a skip, the hard line reminds (pre) and force-stops (stop)', async () => {
  const { root, state, proj, fakeProbe } = await bashScratch();
  try {
    const env = { ...process.env, HOME: root, BUDGET_STATE_DIR: state, BUDGET_PROBE: fakeProbe, BUDGET_HARD: '92' };

    const pre = await runBash([guardPath, 'claude', 'pre'], { cwd: proj, env, input: BASH_INPUT });
    assert.equal(pre.code, 0, `pre stderr=${pre.stderr}`);
    assert.match(pre.stdout, /额度已达硬线\(95% ≥ 92%\)/, 'no skip → pre emits static hard-line reminder');
    assert.doesNotMatch(pre.stdout, /permissionDecision/, 'no skip → pre does not deny');
    assert.match(pre.stdout, /不会强制拦截/, 'bash pre uses static slowdown reminder');

    const stop = await runBash([guardPath, 'claude', 'stop'], {
      cwd: proj, env, input: JSON.stringify({ session_id: 's1' }),
    });
    assert.equal(stop.code, 0, `stop stderr=${stop.stderr}`);
    assert.match(stop.stdout, /"continue":\s*false/, 'no skip → stop force-stops');
    assert.ok(existsSync(join(state, 'pending')), 'pending queue written when forcing stop');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Bash: an expired skip marker re-enables the hard-line reminder', async () => {
  const { root, state, proj, fakeProbe } = await bashScratch();
  try {
    const env = { ...process.env, HOME: root, BUDGET_STATE_DIR: state, BUDGET_PROBE: fakeProbe, BUDGET_HARD: '92' };

    // grant, then corrupt the marker's expiry into the past (deterministic, no sleep)
    const grant = await runBash([guardPath, 'claude', 'prompt'], {
      cwd: proj, env, input: JSON.stringify({ prompt: 'force-continue' }),
    });
    assert.equal(grant.code, 0, `grant stderr=${grant.stderr}`);
    const skipDir = join(state, 'skip');
    const markers = (await readdir(skipDir)).filter((f) => /^claude_.*\.json$/.test(f));
    assert.equal(markers.length, 1, 'exactly one claude marker after grant');
    await writeFile(join(skipDir, markers[0]), JSON.stringify({ expires: 1 }));

    const pre = await runBash([guardPath, 'claude', 'pre'], { cwd: proj, env, input: BASH_INPUT });
    assert.equal(pre.code, 0, `pre stderr=${pre.stderr}`);
    assert.match(pre.stdout, /额度已达硬线/, 'expired skip → pre reminds again');
    assert.doesNotMatch(pre.stdout, /permissionDecision/, 'expired skip → no deny');
    assert.equal(existsSync(join(skipDir, markers[0])), false, 'expired marker cleaned up');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Bash pending payload matches Node schema and writes scoped plus legacy files', async () => {
  const nodeDir = tempDir();
  const { root, state, proj, fakeProbe } = await bashScratch();
  try {
    const nodeFixture = makeClaudeHardFixture(nodeDir, 95);
    await withEnvAsync(
      { BUDGET_STATE_DIR: nodeDir, BUDGET_CWD_OVERRIDE: nodeDir, BUDGET_NOW_EPOCH: String(NOW), BUDGET_USAGE_FIXTURE: nodeFixture },
      () => phaseStop('claude', { session_id: 's1' }, TH),
    );
    const nodeScopedName = readdirSync(join(nodeDir, 'pending')).find((f) => /^claude_.*\.json$/.test(f));
    const nodePending = JSON.parse(await readFile(join(nodeDir, 'pending', nodeScopedName), 'utf8'));

    const env = { ...process.env, HOME: root, BUDGET_STATE_DIR: state, BUDGET_PROBE: fakeProbe, BUDGET_HARD: '92' };
    const stop = await runBash([guardPath, 'claude', 'stop'], {
      cwd: proj, env, input: JSON.stringify({ session_id: 's1' }),
    });
    assert.equal(stop.code, 0, `stop stderr=${stop.stderr}`);

    const bashScopedName = readdirSync(join(state, 'pending')).find((f) => /^claude_.*\.json$/.test(f));
    const bashPending = JSON.parse(await readFile(join(state, 'pending', bashScopedName), 'utf8'));
    const bashLegacy = JSON.parse(await readFile(join(state, 'pending_claude.json'), 'utf8'));

    assert.deepEqual(Object.keys(bashPending).sort(), Object.keys(nodePending).sort());
    assert.deepEqual(Object.keys(bashLegacy).sort(), Object.keys(nodePending).sort());
    assert.equal(bashPending.status, 'paused');
    assert.equal(bashPending.agent, 'claude');
    assert.equal(bashPending.session_id, 's1');
    assert.equal(realpathSync(bashPending.cwd), realpathSync(proj));
    assert.equal(bashPending.reset_epoch, 0);
    assert.equal(bashPending.util, 95);
    assert.equal(bashPending.warn_util, 95);
    assert.equal(typeof bashPending.at, 'number');
    assert.deepEqual(bashLegacy, bashPending);
  } finally {
    rmSync(nodeDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('Bash rate-limit probe result writes the same pending schema and force-stops at Stop', async () => {
  const { root, state, proj } = await bashScratch();
  try {
    const rateProbe = join(root, 'rate-probe');
    await writeFile(
      rateProbe,
      ['#!/usr/bin/env bash', 'printf \'{"ok":false,"error":"rate_limited","rate_limited_until":9999999999,"util":0,"warn_util":0,"reset_epoch":0}\\n\''].join('\n') + '\n',
      { mode: 0o755 },
    );
    const env = { ...process.env, HOME: root, BUDGET_STATE_DIR: state, BUDGET_PROBE: rateProbe };
    const stop = await runBash([guardPath, 'claude', 'stop'], {
      cwd: proj, env, input: JSON.stringify({ session_id: 's-rate' }),
    });
    assert.equal(stop.code, 0, `stop stderr=${stop.stderr}`);
    assert.match(stop.stdout, /"continue":\s*false/, 'rate-limit stop force-stops cleanly');
    assert.match(stop.stdout, /限流|rate/i, 'stop reason names provider rate-limit');

    const bashScopedName = readdirSync(join(state, 'pending')).find((f) => /^claude_.*\.json$/.test(f));
    const pending = JSON.parse(await readFile(join(state, 'pending', bashScopedName), 'utf8'));
    const legacy = JSON.parse(await readFile(join(state, 'pending_claude.json'), 'utf8'));
    assert.deepEqual(legacy, pending);
    assert.equal(pending.status, 'paused');
    assert.equal(pending.agent, 'claude');
    assert.equal(pending.session_id, 's-rate');
    assert.equal(realpathSync(pending.cwd), realpathSync(proj));
    assert.equal(pending.reset_epoch, 0);
    assert.equal(pending.util, 0);
    assert.equal(pending.warn_util, 0);
    assert.equal(typeof pending.at, 'number');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Bash stale cache with active rate-limit still writes pending instead of treating usage as healthy', async () => {
  const { root, state, proj } = await bashScratch();
  try {
    const staleRateProbe = join(root, 'stale-rate-probe');
    await writeFile(
      staleRateProbe,
      ['#!/usr/bin/env bash', 'printf \'{"ok":true,"stale":true,"source":"cache","rate_limited_until":9999999999,"util":95,"warn_util":95,"reset_epoch":0}\\n\''].join('\n') + '\n',
      { mode: 0o755 },
    );
    const env = { ...process.env, HOME: root, BUDGET_STATE_DIR: state, BUDGET_PROBE: staleRateProbe };
    const stop = await runBash([guardPath, 'claude', 'stop'], {
      cwd: proj, env, input: JSON.stringify({ session_id: 's-stale-rate' }),
    });
    assert.equal(stop.code, 0, `stop stderr=${stop.stderr}`);
    assert.match(stop.stdout, /限流|rate/i, 'active rate-limit must win over stale healthy cache');
    assert.match(stop.stdout, /"continue":\s*false/);

    const bashScopedName = readdirSync(join(state, 'pending')).find((f) => /^claude_.*\.json$/.test(f));
    const pending = JSON.parse(await readFile(join(state, 'pending', bashScopedName), 'utf8'));
    assert.equal(pending.session_id, 's-stale-rate');
    assert.equal(pending.status, 'paused');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── invariant: both Bash packages stay byte-identical ─────────────────────

test('Bash packages stay byte-identical (budget_guard.sh / watchdog.sh / budget-probe)', async () => {
  for (const name of ['budget_guard.sh', 'watchdog.sh', 'budget-probe']) {
    const a = await readFile(join(rootDir, 'claude-budget-guard', name));
    const b = await readFile(join(rootDir, 'codex-budget-guard', name));
    assert.ok(a.equals(b), `${name} must be byte-identical across packages`);
  }
});
