// Codex provider for budget-probe.
//
// Endpoint verified against CodexBar/Codex live schema:
//   GET https://chatgpt.com/backend-api/wham/usage
//   Headers:
//     Authorization: Bearer <tokens.access_token>
//     ChatGPT-Account-Id: <tokens.account_id>
//     Accept: application/json
//
// Schema:
//   rate_limit.primary_window / secondary_window
//   additional_rate_limits[].rate_limit.primary_window / secondary_window
//   window = { used_percent, reset_at, reset_after_seconds, limit_window_seconds }

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { requestJson } from './http.mjs';

const DEFAULT_BASE = 'https://chatgpt.com/backend-api/';
const FETCH_TIMEOUT_MS = 5000;

export function codexUsageUrl(env = process.env) {
  let base = env.BUDGET_CODEX_URL || readChatGPTBaseURL(env) || DEFAULT_BASE;
  base = base.replace(/\/+$/, '');
  if (base.endsWith('/wham/usage') || base.endsWith('/api/codex/usage')) return base;
  if ((base.startsWith('https://chatgpt.com') || base.startsWith('https://chat.openai.com')) && !base.includes('/backend-api')) {
    base += '/backend-api';
  }
  return base.includes('/backend-api') ? `${base}/wham/usage` : `${base}/api/codex/usage`;
}

function readChatGPTBaseURL(env) {
  const cfg = env.BUDGET_CODEX_CONFIG_TOML || join(homedir(), '.codex', 'config.toml');
  if (!existsSync(cfg)) return '';
  try {
    const text = readFileSync(cfg, 'utf8');
    const m = text.match(/^\s*chatgpt_base_url\s*=\s*["']?([^"'\n#]+)["']?/m);
    return m ? m[1].trim() : '';
  } catch (_) {
    return '';
  }
}

export function readAuth(env = process.env) {
  const token = env.BUDGET_CODEX_TOKEN;
  const accountId = env.BUDGET_CODEX_ACCOUNT_ID;
  if (token && accountId) return { token, accountId };

  const authPath = env.BUDGET_CODEX_AUTH_JSON || join(homedir(), '.codex', 'auth.json');
  if (!existsSync(authPath)) return null;
  try {
    const j = JSON.parse(readFileSync(authPath, 'utf8'));
    const t = j?.tokens?.access_token || j?.access_token || '';
    const a = j?.tokens?.account_id || j?.account_id || '';
    return t && a ? { token: t, accountId: a } : null;
  } catch (_) {
    return null;
  }
}

export async function fetch(opts = {}) {
  const auth = readAuth(opts.env || process.env);
  if (!auth) return { ok: false, error: 'no_token' };
  return requestJson(codexUsageUrl(opts.env || process.env), {
    timeoutMs: opts.timeoutMs || FETCH_TIMEOUT_MS,
    headers: {
      'Authorization': `Bearer ${auth.token}`,
      'ChatGPT-Account-Id': auth.accountId,
      'Accept': 'application/json',
      'User-Agent': 'codex-cli',
    },
  });
}

function windowBucket(id, window, normalizeUtil, now) {
  if (!window || typeof window !== 'object' || typeof window.used_percent !== 'number') return null;
  const resetEpoch = typeof window.reset_at === 'number' ? Math.floor(window.reset_at) : 0;
  const resetAfterSeconds = typeof window.reset_after_seconds === 'number'
    ? Math.max(0, Math.floor(window.reset_after_seconds))
    : (resetEpoch > 0 ? Math.max(0, resetEpoch - now) : undefined);
  return {
    id,
    util: normalizeUtil(window.used_percent),
    reset_epoch: resetEpoch,
    reset_after_seconds: resetAfterSeconds,
    resettable: resetEpoch > 0,
  };
}

export function parse(raw, now, helpers) {
  const { normalizeUtil } = helpers;
  const buckets = [];
  const add = (id, w) => {
    const bucket = windowBucket(id, w, normalizeUtil, now);
    if (bucket) buckets.push(bucket);
  };

  add('rate_limit.primary_window', raw?.rate_limit?.primary_window);
  add('rate_limit.secondary_window', raw?.rate_limit?.secondary_window);
  for (const rl of raw?.additional_rate_limits || []) {
    const name = rl?.limit_name || rl?.metered_feature || 'additional';
    add(`additional_rate_limits[${name}].primary_window`, rl?.rate_limit?.primary_window);
    add(`additional_rate_limits[${name}].secondary_window`, rl?.rate_limit?.secondary_window);
  }

  if (buckets.length === 0) {
    return {
      ok: false, util: 0, warn_util: 0, bucket_id: '', warn_bucket_id: '',
      reset_epoch: 0, reset_after_seconds: undefined,
      buckets: [], extra_usage: null,
      error: 'schema_no_buckets',
    };
  }

  let hardWinner = null;
  let warnWinner = null;
  for (const b of buckets) {
    if (b.util <= 0) continue;
    if (b.resettable && (!hardWinner || b.util > hardWinner.util)) hardWinner = b;
    if (!warnWinner || b.util > warnWinner.util) warnWinner = b;
  }

  return {
    ok: true,
    util: hardWinner ? hardWinner.util : 0,
    warn_util: warnWinner ? warnWinner.util : 0,
    bucket_id: hardWinner ? hardWinner.id : '',
    // warn_util winner (top bucket across all windows). Equals bucket_id when the
    // top window is resettable; names the real max otherwise. See claude.mjs.
    warn_bucket_id: warnWinner ? warnWinner.id : '',
    reset_epoch: hardWinner ? hardWinner.reset_epoch : 0,
    reset_after_seconds: hardWinner ? hardWinner.reset_after_seconds : undefined,
    buckets,
    extra_usage: null,
  };
}

