// Claude provider for budget-probe.
//
// Token discovery:
//   macOS:  `security find-generic-password -s "Claude Code-credentials" -w`
//   Linux/WSL: ~/.claude/.credentials.json
//   Both contain {"claudeAiOauth":{"accessToken":"..."}}.
//
// Endpoint:
//   GET https://api.anthropic.com/api/oauth/usage
//   Headers per CodexBar's OAuthUsageFetcher (live-verified 2026-06):
//     Authorization: Bearer <token>
//     anthropic-beta: oauth-2025-04-20
//     Accept: application/json
//     User-Agent: claude-code/<version>     (req'd; older CLI sent 401 without it)
//     Content-Type: application/json
//
// Parser: walks every top-level object whose shape looks like a bucket
// ({utilization: number, resets_at?: ISO8601}). `extra_usage` is excluded
// from hard_max/warn_max — it's monthly overage and would cause false stops.
// Reset-pairing follows the hard_max winner (legacy fixed `five_hour` was a bug).

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { requestJson } from './http.mjs';

const USAGE_HOST  = 'api.anthropic.com';
const USAGE_PATH  = '/api/oauth/usage';
const USER_AGENT  = process.env.BUDGET_CLAUDE_UA || 'claude-code/2.1.88';
const FETCH_TIMEOUT_MS = 5000;

// ─── token discovery ─────────────────────────────────────────────────────

export function readToken() {
  // explicit env override (test/CI)
  if (process.env.BUDGET_CLAUDE_TOKEN) return process.env.BUDGET_CLAUDE_TOKEN;

  // Hard disable of token discovery — for tests/CI/sandboxes that must NOT
  // touch the real Keychain / credentials file (e.g. to exercise the
  // no-token fail-open path on a developer machine that happens to be
  // logged in). When set, only the explicit BUDGET_CLAUDE_TOKEN env counts.
  if (process.env.BUDGET_NO_TOKEN_DISCOVERY === '1') return null;

  if (platform() === 'darwin') {
    try {
      const r = spawnSync('security',
        ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
        { encoding: 'utf8', timeout: 3000 });
      if (r.status === 0 && r.stdout) {
        const raw = r.stdout.trim();
        const tok = extractTokenFromCreds(raw);
        if (tok) return tok;
      }
    } catch (_) { /* fall through to fs */ }
  }
  const credPath = join(homedir(), '.claude', '.credentials.json');
  if (existsSync(credPath)) {
    try { return extractTokenFromCreds(readFileSync(credPath, 'utf8')); }
    catch (_) { return null; }
  }
  return null;
}

function extractTokenFromCreds(raw) {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw);
    return j?.claudeAiOauth?.accessToken || null;
  } catch (_) { return null; }
}

// ─── live fetch ──────────────────────────────────────────────────────────

export async function fetch(_opts = {}) {
  const token = readToken();
  if (!token) return { ok: false, error: 'no_token' };

  return requestJson(`https://${USAGE_HOST}${USAGE_PATH}`, {
    timeoutMs: FETCH_TIMEOUT_MS,
    headers: {
      'Authorization': `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'Accept': 'application/json',
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/json',
    },
  });
}

// ─── parser (pure) ───────────────────────────────────────────────────────

// `extra_usage` semantics: monthly billable overage, not a window — never
// drives hard_max / warn_max (would falsely stop on every billing cycle).
const SHOW_ONLY_KEYS = new Set(['extra_usage']);

function isBucketShape(v) {
  return v && typeof v === 'object' && !Array.isArray(v) && typeof v.utilization === 'number';
}

export function parse(raw, now, helpers) {
  const { isoToEpoch, normalizeUtil } = helpers;
  const buckets = [];
  let extraUsage = null;

  for (const [id, v] of Object.entries(raw || {})) {
    if (SHOW_ONLY_KEYS.has(id)) {
      if (isBucketShape(v)) {
        const eu = { util: normalizeUtil(v.utilization), is_enabled: !!v.is_enabled };
        if (typeof v.currency === 'string' && v.currency.length) eu.currency = v.currency;
        extraUsage = eu;
      }
      continue;
    }
    if (!isBucketShape(v)) continue;
    const util = normalizeUtil(v.utilization);
    const reset_epoch = typeof v.resets_at === 'string' ? isoToEpoch(v.resets_at) : 0;
    buckets.push({ id, util, reset_epoch, resettable: reset_epoch > 0 });
  }

  if (buckets.length === 0) {
    return {
      ok: false, util: 0, warn_util: 0, bucket_id: '',
      reset_epoch: 0, reset_after_seconds: undefined,
      buckets: [], extra_usage: extraUsage,
      error: 'schema_no_buckets',
    };
  }

  // hard_max: only resettable buckets with util > 0 contend for the winner;
  // tie → first encountered (object key order, deterministic in modern V8).
  let hardWinner = null;
  let warnWinner = null;
  for (const b of buckets) {
    if (b.util <= 0) continue;
    if (b.resettable && (!hardWinner || b.util > hardWinner.util)) hardWinner = b;
    if (!warnWinner || b.util > warnWinner.util) warnWinner = b;
  }

  const hardUtil = hardWinner ? hardWinner.util : 0;
  const warnUtil = warnWinner ? warnWinner.util : 0;
  // bucket_id is the *driving* winner — the bucket that put us at the
  // hard-line threshold. If hardWinner is null (no resettable bucket with
  // util>0), there is no driving bucket yet, so bucket_id is ''. Falling
  // back to warnWinner would report a bucket id whose util is NOT in
  // `util` — confusing for any consumer that reads util/bucket_id together
  // (CLI, watchdog, dashboard). The warn_max winner is still discoverable
  // from `buckets[]` for the curious.
  const reset_epoch = hardWinner ? hardWinner.reset_epoch : 0;
  const reset_after_seconds = reset_epoch > 0 ? Math.max(0, reset_epoch - now) : undefined;

  return {
    ok: true,
    util: hardUtil,
    warn_util: warnUtil,
    bucket_id: hardWinner ? hardWinner.id : '',
    reset_epoch,
    reset_after_seconds,
    buckets,
    extra_usage: extraUsage,
  };
}
