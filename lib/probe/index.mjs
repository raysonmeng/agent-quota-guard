// budget-probe — shared usage probe for Claude Code / Codex.
// Pure ESM, zero external deps, Node 22+. Imported by hook, MCP server, watchdog.
//
// Public API (all callers must use this entry; do not import provider files
// directly so future providers can be added without touching downstream code):
//   fetchUsage(agent, opts)          async → normalized result (cache aware)
//   parseUsage(agent, rawJson, now)  pure  → normalized result fragment
//   doctor(agent)                    async → diagnostic object {code, ...}
//   getCacheDir()                          → ~/.budget-guard (env override)
//   readCache(agent) / writeCache / clearCache
//   readRateLimitGate(agent) / recordRateLimit / recordSuccess
//   checkThresholds(env)             → {warnOnce, warnRepeat, hard, errors, source}
//   isoToEpoch(iso) / normalizeUtil(v)
//
// Invariants:
//   - fail-open: any error returns ok=false with diagnostic fields, never throws.
//   - parseUsage is a pure function (no I/O, no Date.now — `now` comes in).
//   - shared caches use atomic rename + lockfile mutex (Node has no fs.flockSync).

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, openSync, closeSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as claude from './claude.mjs';
import * as codex from './codex.mjs';

const PROVIDERS = { claude, codex };
const CACHE_TTL_DEFAULT = 45;
const GATE_FALLBACK_SEC = 300;             // CodexBar parity: 5min default 429 cool-down
const LOCK_MAX_WAIT_MS = 1500;
const LOCK_STALE_MS = 5000;

// ─── paths ───────────────────────────────────────────────────────────────

export function getCacheDir() {
  const dir = process.env.BUDGET_STATE_DIR || join(homedir(), '.budget-guard');
  try { mkdirSync(dir, { recursive: true }); } catch (_) { /* fail-open */ }
  return dir;
}
const cacheFile = (agent) => join(getCacheDir(), `usage_${agent}.json`);
const gateFile  = (agent) => join(getCacheDir(), `ratelimit_${agent}.json`);
const lockFile  = (path)  => path + '.lock';

// ─── lockfile mutex (fs.flockSync absent in Node; use O_EXCL lockfile) ───

function withLock(target, fn) {
  const lockPath = lockFile(target);
  const start = Date.now();
  while (Date.now() - start < LOCK_MAX_WAIT_MS) {
    let fd;
    try {
      fd = openSync(lockPath, 'wx');
      try {
        try { writeSync(fd, `${process.pid} ${Date.now()}`); } catch (_) { /* ignore */ }
        return fn();
      } finally {
        try { closeSync(fd); } catch (_) {}
        try { unlinkSync(lockPath); } catch (_) {}
      }
    } catch (e) {
      if (e && e.code !== 'EEXIST') throw e;
      try {
        const st = statSync(lockPath);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          try { unlinkSync(lockPath); } catch (_) {}
          continue;
        }
      } catch (_) { continue; }
      // brief blocking nap (no setImmediate in sync API)
      const end = Date.now() + 15;
      while (Date.now() < end) { /* spin briefly */ }
    }
  }
  // give up, run uncontested — fail-open
  return fn();
}

function atomicWriteJSON(path, obj) {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(obj));
  renameSync(tmp, path);
}

function readJSON(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (_) { return null; }
}

// ─── cache R/W ───────────────────────────────────────────────────────────

export function readCache(agent) {
  return readJSON(cacheFile(agent));
}

export function writeCache(agent, data) {
  const path = cacheFile(agent);
  return withLock(path, () => {
    try {
      // Compare-and-swap so a slower/older in-flight fetch can't clobber a
      // fresher cache entry another process already wrote (which would mask a
      // hard reading for the whole TTL). Order by (fetched_at, then cap_util):
      //   - strictly older second → reject.
      //   - SAME second but our utilization is LOWER → reject (keep the higher
      //     reading). Within one second real usage never drops — a genuine
      //     drop only happens at a window refresh, which crosses a second
      //     boundary. So a same-second lower value is a stale race, not a real
      //     decrease; keeping the higher value is the safe direction.
      // `cap_util` is written by fetchUsage as max(util, warn_util).
      const incoming = Number(data && data.fetched_at);
      const incomingUtil = Number(data && data.cap_util);
      if (Number.isFinite(incoming)) {
        const existing = readJSON(path);
        const prev = existing && Number(existing.fetched_at);
        if (Number.isFinite(prev)) {
          if (prev > incoming) return false; // strictly newer cache wins
          if (prev === incoming) {
            const prevUtil = Number(existing.cap_util);
            if (Number.isFinite(prevUtil) && Number.isFinite(incomingUtil)
                && prevUtil > incomingUtil) {
              return false; // same second, keep the higher reading
            }
          }
        }
      }
      atomicWriteJSON(path, data);
      return true;
    } catch (_) { return false; }
  });
}

export function clearCache(agent) {
  try { unlinkSync(cacheFile(agent)); } catch (_) {}
  try { unlinkSync(gateFile(agent));  } catch (_) {}
}

// ─── 429 gate (CodexBar parity: Retry-After or 5min, longest-wins on race) ─

export function readRateLimitGate(agent) {
  const g = readJSON(gateFile(agent));
  if (!g || typeof g.rate_limited_until !== 'number') return null;
  return g;
}

export function recordRateLimit(agent, retryAfterSec) {
  const path = gateFile(agent);
  const wait = Number.isFinite(retryAfterSec) && retryAfterSec > 0
    ? Math.ceil(retryAfterSec)
    : GATE_FALLBACK_SEC;
  return withLock(path, () => {
    const now = Math.floor(Date.now() / 1000);
    const until = now + wait;
    const existing = readJSON(path);
    // longest-wins: never shorten an existing backoff
    const effective = existing && typeof existing.rate_limited_until === 'number'
      ? Math.max(existing.rate_limited_until, until)
      : until;
    try {
      atomicWriteJSON(path, { rate_limited_until: effective, recorded_at: now, source: 'http_429' });
      return effective;
    } catch (_) { return effective; }
  });
}

export function recordSuccess(agent) {
  try { unlinkSync(gateFile(agent)); } catch (_) {}
}

// ─── utilities ───────────────────────────────────────────────────────────

export function isoToEpoch(iso) {
  if (typeof iso !== 'string' || iso.length === 0) return 0;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.floor(ms / 1000);
}

export function normalizeUtil(v) {
  // Trust the API: drop the legacy `v<=1 ⇒ ×100` heuristic that inflated 0.8% → 80%.
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 100) return 100;
  return Math.round(v);
}

// ─── threshold validation (T1 once / T2 repeat / T3 hard) ────────────────

export function checkThresholds(env = process.env) {
  const errors = [];
  const sources = {};
  const num = (raw, fallback, name) => {
    if (raw === undefined || raw === null || raw === '') { sources[name] = 'default'; return fallback; }
    const text = String(raw).trim();
    if (!/^[0-9]+$/.test(text)) {
      errors.push(`${name}=${raw} is not an integer`);
      sources[name] = 'invalid';
      return fallback;
    }
    const n = Number.parseInt(text, 10);
    sources[name] = 'env';
    return n;
  };

  const warnOnce  = num(env.BUDGET_WARN_ONCE,   80, 'warnOnce');
  // BUDGET_SOFT is deprecated alias for BUDGET_WARN_REPEAT (legacy SOFT semantics = each-time soft prompt).
  let warnRepeat;
  if (env.BUDGET_WARN_REPEAT !== undefined && env.BUDGET_WARN_REPEAT !== '') {
    warnRepeat = num(env.BUDGET_WARN_REPEAT, 90, 'warnRepeat');
  } else if (env.BUDGET_SOFT !== undefined && env.BUDGET_SOFT !== '') {
    warnRepeat = num(env.BUDGET_SOFT, 90, 'warnRepeat');
    sources.warnRepeat = 'BUDGET_SOFT_alias';
  } else {
    warnRepeat = 90;
    sources.warnRepeat = 'default';
  }
  const hard      = num(env.BUDGET_HARD,        92, 'hard');

  const check = (cond, msg) => { if (!cond) errors.push(msg); };
  check(warnOnce  >= 0,   `warnOnce(${warnOnce}) must be >= 0`);
  check(warnOnce  <  warnRepeat, `warnOnce(${warnOnce}) must be < warnRepeat(${warnRepeat})`);
  check(warnRepeat <  hard,      `warnRepeat(${warnRepeat}) must be < hard(${hard})`);
  check(hard      <= 100, `hard(${hard}) must be <= 100`);

  if (errors.length) {
    // fall back to defaults so callers can keep running, but surface the errors
    return { warnOnce: 80, warnRepeat: 90, hard: 92, errors, sources, ok: false };
  }
  return { warnOnce, warnRepeat, hard, errors, sources, ok: true };
}

// ─── orchestrator ────────────────────────────────────────────────────────

function nowSec() {
  if (process.env.BUDGET_NOW_EPOCH) {
    const n = Number.parseInt(process.env.BUDGET_NOW_EPOCH, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return Math.floor(Date.now() / 1000);
}

function cacheTTL() {
  const raw = process.env.BUDGET_CACHE_TTL;
  if (!raw) return CACHE_TTL_DEFAULT;
  const text = String(raw).trim();
  if (!/^[0-9]+$/.test(text)) return CACHE_TTL_DEFAULT;
  const n = Number.parseInt(text, 10);
  return Number.isFinite(n) && n >= 0 ? n : CACHE_TTL_DEFAULT;
}

function emptyResult(agent, now, extra = {}) {
  return {
    ok: false, agent, util: 0, warn_util: 0, bucket_id: '',
    reset_epoch: 0, reset_after_seconds: undefined,
    buckets: [], extra_usage: null,
    source: 'live', fetched_at: now, stale: false,
    rate_limited_until: undefined,
    ...extra,
  };
}

export function parseUsage(agent, rawJson, now) {
  const provider = PROVIDERS[agent];
  if (!provider || typeof provider.parse !== 'function') {
    return emptyResult(agent, now, { error: `unknown_agent:${agent}` });
  }
  if (rawJson == null || typeof rawJson !== 'object') {
    return emptyResult(agent, now, { error: 'invalid_raw_json' });
  }
  try {
    return { agent, ...provider.parse(rawJson, now, { isoToEpoch, normalizeUtil }) };
  } catch (e) {
    return emptyResult(agent, now, { error: `parse_failed:${e && e.message || e}` });
  }
}

export async function fetchUsage(agent, opts = {}) {
  const now = opts.now ?? nowSec();
  const provider = PROVIDERS[agent];
  if (!provider) return emptyResult(agent, now, { error: `unknown_agent:${agent}` });

  // 1. fixture path (env or opt) — short-circuits network, still runs parser
  const fixturePath = opts.fixture || process.env.BUDGET_USAGE_FIXTURE;
  if (fixturePath) {
    try {
      const raw = JSON.parse(readFileSync(fixturePath, 'utf8'));
      const parsed = parseUsage(agent, raw, now);
      return { ...parsed, source: 'fixture', fetched_at: now, stale: false };
    } catch (e) {
      return emptyResult(agent, now, { error: `fixture_read_failed:${e && e.message || e}`, source: 'fixture' });
    }
  }

  // 2. cache hit within TTL → return cached parse with source="cache"
  const ttl = opts.cacheTTL ?? cacheTTL();
  const cached = readCache(agent);
  if (cached && typeof cached.fetched_at === 'number' && now - cached.fetched_at < ttl && cached.raw) {
    const parsed = parseUsage(agent, cached.raw, now);
    return { ...parsed, source: 'cache', fetched_at: cached.fetched_at, stale: false };
  }

  // 3. 429 gate active → don't probe; return stale cache (if any) with flag
  const gate = readRateLimitGate(agent);
  if (gate && gate.rate_limited_until > now) {
    if (cached && cached.raw) {
      const parsed = parseUsage(agent, cached.raw, now);
      return { ...parsed, ok: false, source: 'cache', fetched_at: cached.fetched_at, stale: true, rate_limited_until: gate.rate_limited_until };
    }
    return emptyResult(agent, now, { rate_limited_until: gate.rate_limited_until, error: 'rate_limited' });
  }

  // 4. live fetch via provider
  let fetched;
  try {
    fetched = await provider.fetch(opts);
  } catch (e) {
    fetched = { ok: false, error: `provider_threw:${e && e.message || e}` };
  }

  if (fetched && fetched.status === 429) {
    const until = recordRateLimit(agent, fetched.retryAfter);
    if (cached && cached.raw) {
      const parsed = parseUsage(agent, cached.raw, now);
      return { ...parsed, ok: false, source: 'cache', fetched_at: cached.fetched_at, stale: true, rate_limited_until: until };
    }
    return emptyResult(agent, now, { rate_limited_until: until, error: 'rate_limited' });
  }

  if (!fetched || !fetched.ok || !fetched.raw) {
    // serve stale cache on network failure
    if (cached && cached.raw) {
      const parsed = parseUsage(agent, cached.raw, now);
      return { ...parsed, ok: false, source: 'cache', fetched_at: cached.fetched_at, stale: true, error: fetched && fetched.error };
    }
    return emptyResult(agent, now, { error: (fetched && fetched.error) || 'fetch_failed' });
  }

  // 5. success → clear gate, parse, only persist raw when parse succeeds
  recordSuccess(agent);
  const parsed = parseUsage(agent, fetched.raw, now);
  // Guard: only cache when parse produced usable data. If parseUsage returned
  // ok:false (e.g. schema_no_buckets), writing the cache would lock out retries
  // for a full TTL window. Skip writeCache so the next call re-fetches live.
  if (parsed.ok) {
    // cap_util = the most alarming reading this entry carries; writeCache uses
    // it to break same-second CAS ties so a lower reading can't mask a higher.
    const capUtil = Math.max(
      Number.isFinite(parsed.util) ? parsed.util : 0,
      Number.isFinite(parsed.warn_util) ? parsed.warn_util : 0,
    );
    writeCache(agent, { fetched_at: now, raw: fetched.raw, cap_util: capUtil });
  }
  return { ...parsed, source: 'live', fetched_at: now, stale: false };
}

// ─── doctor ──────────────────────────────────────────────────────────────

export async function doctor(agent) {
  const out = { agent, now: nowSec(), checks: [], code: 0 };
  const add = (name, ok, detail) => out.checks.push({ name, ok, detail });

  // threshold validation — CRITICAL: code 4 is config-invalid
  const th = checkThresholds(process.env);
  out.thresholds = th;
  add('thresholds', th.ok, th.ok ? `warnOnce=${th.warnOnce} warnRepeat=${th.warnRepeat} hard=${th.hard}` : th.errors.join('; '));
  if (!th.ok) { out.code = 4; return out; }

  add('cache_dir', existsSync(getCacheDir()), getCacheDir());
  const gate = readRateLimitGate(agent);
  if (gate && gate.rate_limited_until > out.now) {
    add('rate_limit_gate', false, `active until ${gate.rate_limited_until} (in ${gate.rate_limited_until - out.now}s)`);
    out.code = Math.max(out.code, 1);
  } else {
    add('rate_limit_gate', true, 'clear');
  }

  // attempt a fetch
  const probed = await fetchUsage(agent);
  out.probe = probed;
  add('fetch', !!probed.ok, probed.ok ? `source=${probed.source} bucket=${probed.bucket_id} util=${probed.util}` : (probed.error || 'failed'));

  if (!probed.ok) {
    out.code = Math.max(out.code, probed.rate_limited_until ? 1 : 2);
  }
  if (probed && Array.isArray(probed.buckets) && probed.buckets.length === 0) {
    add('schema', false, 'no parseable buckets in response');
    out.code = Math.max(out.code, 3);
  } else {
    add('schema', true, `${probed.buckets.length} bucket(s); winner=${probed.bucket_id || '<none>'}`);
  }

  return out;
}
