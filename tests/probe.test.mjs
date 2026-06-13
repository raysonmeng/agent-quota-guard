/**
 * Unit tests for lib/probe/index.mjs
 * Coverage: normalizeUtil, isoToEpoch, checkThresholds, parseUsage (claude), fail-open
 *
 * Run: node --test tests/probe.test.mjs
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  normalizeUtil,
  isoToEpoch,
  checkThresholds,
  parseUsage,
  fetchUsage,
  writeCache,
  readCache,
} from '../lib/probe/index.mjs';

// ─── helpers ────────────────────────────────────────────────────────────────

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'budget-probe-test-'));
}

function withEnv(overrides, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(overrides)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ─── normalizeUtil ────────────────────────────────────────────────────────────

test('normalizeUtil: 0.8 → 1 (no legacy ×100 heuristic)', () => {
  // Old heuristic: v<=1 → v*100, which would give 80. New: trust the API.
  assert.equal(normalizeUtil(0.8), 1);
});

test('normalizeUtil: 0.0 → 0', () => {
  assert.equal(normalizeUtil(0.0), 0);
});

test('normalizeUtil: 1.0 → 1 (not 100)', () => {
  assert.equal(normalizeUtil(1.0), 1);
});

test('normalizeUtil: 47 → 47', () => {
  assert.equal(normalizeUtil(47), 47);
});

test('normalizeUtil: 100 → 100', () => {
  assert.equal(normalizeUtil(100), 100);
});

test('normalizeUtil: 150 → clamped to 100', () => {
  assert.equal(normalizeUtil(150), 100);
});

test('normalizeUtil: negative → 0', () => {
  assert.equal(normalizeUtil(-5), 0);
});

test('normalizeUtil: NaN → 0', () => {
  assert.equal(normalizeUtil(NaN), 0);
});

test('normalizeUtil: Infinity → 0 (non-finite is invalid, not clamped)', () => {
  // utilization from the API is always a finite 0-100 number; a non-finite
  // value means a parse/schema error, so it is treated as invalid (0), NOT
  // clamped to 100. Clamping happens only for finite out-of-range numbers.
  assert.equal(normalizeUtil(Infinity), 0);
  assert.equal(normalizeUtil(-Infinity), 0);
  // finite over-range IS clamped:
  assert.equal(normalizeUtil(150), 100);
});

test('normalizeUtil: non-number → 0', () => {
  assert.equal(normalizeUtil('80'), 0);
  assert.equal(normalizeUtil(null), 0);
  assert.equal(normalizeUtil(undefined), 0);
});

test('normalizeUtil: rounding: 47.6 → 48', () => {
  assert.equal(normalizeUtil(47.6), 48);
});

// ─── isoToEpoch ─────────────────────────────────────────────────────────────

test('isoToEpoch: ISO with Z parses correctly', () => {
  // 2026-06-02T07:00:00Z → epoch
  const epoch = isoToEpoch('2026-06-02T07:00:00Z');
  assert.ok(Number.isFinite(epoch) && epoch > 0, `expected positive epoch, got ${epoch}`);
  assert.equal(epoch, Math.floor(Date.parse('2026-06-02T07:00:00Z') / 1000));
});

test('isoToEpoch: ISO with fractional seconds', () => {
  const iso = '2026-06-08T03:35:00.500Z';
  const epoch = isoToEpoch(iso);
  assert.ok(Number.isFinite(epoch) && epoch > 0);
  assert.equal(epoch, Math.floor(Date.parse(iso) / 1000));
});

test('isoToEpoch: invalid string → 0', () => {
  assert.equal(isoToEpoch('not-a-date'), 0);
});

test('isoToEpoch: empty string → 0', () => {
  assert.equal(isoToEpoch(''), 0);
});

test('isoToEpoch: non-string → 0', () => {
  assert.equal(isoToEpoch(null), 0);
  assert.equal(isoToEpoch(undefined), 0);
  assert.equal(isoToEpoch(12345), 0);
});

test('isoToEpoch: epoch 0 time (1970-01-01T00:00:00Z) → 0 (rejected as non-positive)', () => {
  // ms is 0 which is ≤0, so we expect 0
  assert.equal(isoToEpoch('1970-01-01T00:00:00Z'), 0);
});

// ─── checkThresholds ─────────────────────────────────────────────────────────

test('checkThresholds: defaults when no env set', () => {
  const r = checkThresholds({});
  assert.equal(r.ok, true);
  assert.equal(r.warnOnce, 80);
  assert.equal(r.warnRepeat, 90);
  assert.equal(r.hard, 92);
  assert.equal(r.errors.length, 0);
});

test('checkThresholds: 0 <= warnOnce < warnRepeat < hard <= 100 valid', () => {
  const r = checkThresholds({ BUDGET_WARN_ONCE: '75', BUDGET_WARN_REPEAT: '85', BUDGET_HARD: '95' });
  assert.equal(r.ok, true);
  assert.equal(r.warnOnce, 75);
  assert.equal(r.warnRepeat, 85);
  assert.equal(r.hard, 95);
  assert.equal(r.errors.length, 0);
});

test('checkThresholds: warnOnce >= warnRepeat → invalid, falls back to defaults', () => {
  const r = checkThresholds({ BUDGET_WARN_ONCE: '90', BUDGET_WARN_REPEAT: '80', BUDGET_HARD: '92' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.length > 0);
  // falls back to defaults
  assert.equal(r.warnOnce, 80);
  assert.equal(r.warnRepeat, 90);
  assert.equal(r.hard, 92);
});

test('checkThresholds: warnRepeat >= hard → invalid', () => {
  const r = checkThresholds({ BUDGET_WARN_ONCE: '80', BUDGET_WARN_REPEAT: '95', BUDGET_HARD: '92' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes('warnRepeat')));
});

test('checkThresholds: hard > 100 → invalid', () => {
  const r = checkThresholds({ BUDGET_WARN_ONCE: '80', BUDGET_WARN_REPEAT: '90', BUDGET_HARD: '101' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes('hard')));
});

test('checkThresholds: BUDGET_SOFT alias for warnRepeat', () => {
  const r = checkThresholds({ BUDGET_WARN_ONCE: '70', BUDGET_SOFT: '85', BUDGET_HARD: '92' });
  assert.equal(r.ok, true);
  assert.equal(r.warnRepeat, 85);
  assert.equal(r.sources.warnRepeat, 'BUDGET_SOFT_alias');
});

test('checkThresholds: BUDGET_WARN_REPEAT takes precedence over BUDGET_SOFT', () => {
  const r = checkThresholds({
    BUDGET_WARN_ONCE: '70',
    BUDGET_WARN_REPEAT: '82',
    BUDGET_SOFT: '85',
    BUDGET_HARD: '92',
  });
  assert.equal(r.ok, true);
  assert.equal(r.warnRepeat, 82);
  assert.equal(r.sources.warnRepeat, 'env');
});

test('checkThresholds: non-integer value → invalid, falls back to defaults', () => {
  const r = checkThresholds({ BUDGET_WARN_ONCE: 'abc', BUDGET_WARN_REPEAT: '90', BUDGET_HARD: '92' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes('warnOnce') && e.includes('abc')));
});

test('checkThresholds: numeric prefixes are invalid, not partially parsed', () => {
  const inline = checkThresholds({ BUDGET_WARN_ONCE: '80', BUDGET_WARN_REPEAT: '90', BUDGET_HARD: '95 # inline' });
  assert.equal(inline.ok, false);
  assert.equal(inline.hard, 92);
  assert.ok(inline.errors.some(e => e.includes('hard') && e.includes('95 # inline')));

  const suffix = checkThresholds({ BUDGET_WARN_ONCE: '80', BUDGET_WARN_REPEAT: '90', BUDGET_HARD: '95x' });
  assert.equal(suffix.ok, false);
  assert.equal(suffix.hard, 92);
  assert.ok(suffix.errors.some(e => e.includes('hard') && e.includes('95x')));
});

test('checkThresholds: empty string values → treated as default', () => {
  const r = checkThresholds({ BUDGET_WARN_ONCE: '', BUDGET_WARN_REPEAT: '', BUDGET_HARD: '' });
  assert.equal(r.ok, true);
  assert.equal(r.warnOnce, 80);
  assert.equal(r.warnRepeat, 90);
  assert.equal(r.hard, 92);
});

test('checkThresholds: warnOnce=0 is valid (>= 0)', () => {
  const r = checkThresholds({ BUDGET_WARN_ONCE: '0', BUDGET_WARN_REPEAT: '50', BUDGET_HARD: '92' });
  assert.equal(r.ok, true);
  assert.equal(r.warnOnce, 0);
});

// ─── parseUsage (claude) ─────────────────────────────────────────────────────

const ROOT = resolve(new URL('.', import.meta.url).pathname, '..');
const NOW = 1748844000; // fixed epoch for deterministic tests

// claude-mixed: five_hour=47 (resettable), seven_day=23 (resettable),
//              seven_day_sonnet=88 (resettable) wins hard+warn,
//              seven_day_opus=null (skip), extra_usage=3 (excluded),
//              iguana_necktie=12 (no resets_at → not resettable)
test('parseUsage claude: sonnet bucket wins (highest resettable util)', () => {
  const raw = {
    five_hour: { utilization: 47, resets_at: '2026-06-02T07:00:00Z' },
    seven_day: { utilization: 23, resets_at: '2026-06-08T12:00:00Z' },
    seven_day_sonnet: { utilization: 88, resets_at: '2026-06-08T12:00:00Z' },
    extra_usage: { utilization: 99, is_enabled: true },
  };
  const r = parseUsage('claude', raw, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.util, 88, 'hard_max should be sonnet util');
  assert.equal(r.bucket_id, 'seven_day_sonnet');
  // when all buckets are resettable, warn winner == hard winner
  assert.equal(r.warn_bucket_id, 'seven_day_sonnet');
  // extra_usage must NOT drive util
  assert.ok(r.util <= 88, 'extra_usage must not inflate util to 99');
});

test('parseUsage claude: null bucket is skipped', () => {
  const raw = {
    seven_day_opus: null,
    five_hour: { utilization: 47, resets_at: '2026-06-02T07:00:00Z' },
  };
  const r = parseUsage('claude', raw, NOW);
  assert.equal(r.ok, true);
  // null bucket should not appear in buckets[]
  assert.ok(r.buckets.every(b => b.id !== 'seven_day_opus'), 'null bucket must be excluded');
});

test('parseUsage claude: extra_usage does not drive util', () => {
  const raw = {
    five_hour: { utilization: 30, resets_at: '2026-06-02T07:00:00Z' },
    extra_usage: { utilization: 99, is_enabled: true },
  };
  const r = parseUsage('claude', raw, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.util, 30, 'extra_usage must not drive util');
  assert.equal(r.bucket_id, 'five_hour');
  // extra_usage is surfaced separately
  assert.ok(r.extra_usage !== null, 'extra_usage should be in the result');
  assert.equal(r.extra_usage.util, 99);
});

test('parseUsage claude: all-null → schema_no_buckets, ok=false', () => {
  const raw = {
    five_hour: null,
    seven_day: null,
    seven_day_opus: null,
    seven_day_sonnet: null,
  };
  const r = parseUsage('claude', raw, NOW);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'schema_no_buckets');
  assert.equal(r.util, 0);
  assert.equal(r.bucket_id, '');
  assert.equal(r.warn_bucket_id, '');
});

test('parseUsage claude: no resettable bucket → util=0, warn_util>0, bucket_id=""', () => {
  // iguana_necktie has no resets_at (non-resettable), so not a hard_max winner.
  const raw = {
    iguana_necktie: { utilization: 70 }, // no resets_at
  };
  const r = parseUsage('claude', raw, NOW);
  assert.equal(r.ok, true, 'ok should be true (buckets exist)');
  assert.equal(r.util, 0, 'util (hard_max) should be 0 — no resettable bucket wins');
  assert.equal(r.warn_util, 70, 'warn_util takes any util-bearing bucket');
  assert.equal(r.bucket_id, '', 'no resettable bucket → bucket_id is empty string');
  assert.equal(r.warn_bucket_id, 'iguana_necktie', 'warn_bucket_id names the true max even when non-resettable');
});

test('parseUsage claude: hardWinner≠warnWinner — warn_bucket_id names the true max, bucket_id stays the resettable winner', () => {
  const raw = {
    five_hour: { utilization: 50, resets_at: '2026-06-02T07:00:00Z' }, // resettable → hard winner
    weekly_capped: { utilization: 95 }, // no resets_at → non-resettable, but the true max (warn winner)
  };
  const r = parseUsage('claude', raw, NOW);
  assert.equal(r.ok, true);
  // hard_max trio (util/bucket_id/reset) stays on the resettable winner —
  // keeps reset pairing + fingerprint + watchdog consistent.
  assert.equal(r.util, 50);
  assert.equal(r.bucket_id, 'five_hour');
  // warn_max names the bucket actually at the top — what gating + usageDetail use.
  assert.equal(r.warn_util, 95);
  assert.equal(r.warn_bucket_id, 'weekly_capped');
});

test('parseUsage claude: empty object → schema_no_buckets', () => {
  const r = parseUsage('claude', {}, NOW);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'schema_no_buckets');
});

test('parseUsage: unknown agent → ok=false error', () => {
  const r = parseUsage('unknown', {}, NOW);
  assert.equal(r.ok, false);
  assert.ok(r.error.startsWith('unknown_agent:'));
});

test('parseUsage: null rawJson → ok=false', () => {
  const r = parseUsage('claude', null, NOW);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'invalid_raw_json');
});

test('parseUsage: non-object rawJson → ok=false', () => {
  const r = parseUsage('claude', 'string', NOW);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'invalid_raw_json');
});

test('parseUsage claude: multiple resettable — highest util wins (tie → first encountered)', () => {
  const raw = {
    five_hour: { utilization: 88, resets_at: '2026-06-02T07:00:00Z' },
    seven_day: { utilization: 88, resets_at: '2026-06-08T12:00:00Z' }, // tie
  };
  const r = parseUsage('claude', raw, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.util, 88);
  // first encountered wins on tie → five_hour
  assert.equal(r.bucket_id, 'five_hour');
});

test('parseUsage claude: extra_usage with currency preserved', () => {
  const raw = {
    five_hour: { utilization: 30, resets_at: '2026-06-02T07:00:00Z' },
    extra_usage: { utilization: 5, is_enabled: true, currency: 'USD' },
  };
  const r = parseUsage('claude', raw, NOW);
  assert.equal(r.extra_usage?.currency, 'USD');
});

// ─── fetchUsage: fail-open (network errors / bad token / corrupt JSON) ────────

test('fetchUsage: fail-open — fetchUsage never throws even on bad URL', async () => {
  // Point to a localhost port that is not listening → connection refused → ok:false.
  // This verifies the fail-open invariant regardless of Keychain / token presence.
  const dir = tempDir();
  try {
    let result;
    // Override the token (so Keychain is bypassed) and force a URL that refuses connections.
    // We do this for the claude provider by supplying an explicit bad fixture path that doesn't exist.
    const missingFixture = join(dir, 'does-not-exist.json');
    result = await withEnv(
      {
        BUDGET_STATE_DIR: dir,
        BUDGET_USAGE_FIXTURE: missingFixture,
        BUDGET_NOW_EPOCH: String(NOW),
      },
      () => fetchUsage('claude', { now: NOW }),
    );
    // Should not throw; fixture_read_failed → ok:false
    assert.equal(result.ok, false);
    assert.ok(typeof result.error === 'string' && result.error.length > 0,
      `expected error string, got ${JSON.stringify(result.error)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fetchUsage: fail-open on corrupt fixture JSON', async () => {
  const dir = tempDir();
  const fixturePath = join(dir, 'bad.json');
  writeFileSync(fixturePath, 'NOT_JSON{{{');
  try {
    const result = await withEnv(
      {
        BUDGET_STATE_DIR: dir,
        BUDGET_USAGE_FIXTURE: fixturePath,
        BUDGET_NOW_EPOCH: String(NOW),
      },
      () => fetchUsage('claude', { now: NOW }),
    );
    assert.equal(result.ok, false);
    assert.ok(typeof result.error === 'string', 'must have error field');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fetchUsage: fixture path → parsed result, no network', async () => {
  const dir = tempDir();
  const fixturePath = join(ROOT, 'tests', 'fixtures', 'claude-usage.json');
  try {
    const result = await withEnv(
      {
        BUDGET_STATE_DIR: dir,
        BUDGET_NOW_EPOCH: String(NOW),
      },
      () => fetchUsage('claude', { fixture: fixturePath, now: NOW }),
    );
    assert.equal(result.ok, true);
    assert.equal(result.source, 'fixture');
    // claude-usage.json: seven_day_sonnet=94 is the highest resettable
    assert.equal(result.util, 94);
    assert.equal(result.bucket_id, 'seven_day_sonnet');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fetchUsage: cache TTL numeric prefixes are invalid, not partially parsed', async () => {
  const dir = tempDir();
  const raw = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'codex-wham-low.json'), 'utf8'));
  try {
    await withEnv(
      {
        HOME: dir,
        BUDGET_STATE_DIR: dir,
        BUDGET_CACHE_TTL: '999999 # inline',
        BUDGET_CODEX_AUTH_JSON: join(dir, 'missing-auth.json'),
        BUDGET_CODEX_TOKEN: undefined,
        BUDGET_CODEX_ACCOUNT_ID: undefined,
      },
      async () => {
        assert.equal(writeCache('codex', { fetched_at: NOW - 1000, raw, cap_util: 18 }), true);
        const result = await fetchUsage('codex', { now: NOW });
        assert.equal(result.source, 'cache', 'network failure may serve stale cache');
        assert.equal(result.stale, true, 'invalid TTL must fall back to default and mark old cache stale');
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('probe CLI continues with default thresholds when config threshold is invalid', () => {
  const dir = tempDir();
  const project = join(dir, 'project');
  const state = join(dir, 'state');
  const fixture = join(ROOT, 'tests', 'fixtures', 'codex-wham-low.json');
  mkdirSync(project, { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(project, '.budget-guard.conf'), 'BUDGET_HARD=101\n');
  try {
    const stdout = execFileSync(process.execPath, [join(ROOT, 'bin', 'probe.mjs'), 'codex', 'probe', '--fixture', fixture], {
      cwd: project,
      env: {
        ...process.env,
        HOME: dir,
        PWD: project,
        BUDGET_STATE_DIR: state,
        BUDGET_HARD: undefined,
      },
      encoding: 'utf8',
    });
    const result = JSON.parse(stdout);
    assert.equal(result.ok, true);
    assert.equal(result.source, 'fixture');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fetchUsage: unknown agent → ok=false, no throw', async () => {
  const dir = tempDir();
  try {
    const result = await withEnv(
      { BUDGET_STATE_DIR: dir, BUDGET_NOW_EPOCH: String(NOW) },
      () => fetchUsage('badagent', { now: NOW }),
    );
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('badagent'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


// ─── cache CAS same-second tiebreak (review round-4) ──────────────────────

test('writeCache CAS: older second rejected; same-second lower util rejected; higher accepted', () => {
  const dir = tempDir();
  withEnv({ BUDGET_STATE_DIR: dir }, () => {
    assert.equal(writeCache('claude', { fetched_at: 1000, raw: { a: 1 }, cap_util: 95 }), true);
    // strictly older second → reject
    assert.equal(writeCache('claude', { fetched_at: 999, raw: { a: 2 }, cap_util: 99 }), false);
    assert.equal(readCache('claude').cap_util, 95);
    // same second, LOWER util → reject (keep higher, stale-race guard)
    assert.equal(writeCache('claude', { fetched_at: 1000, raw: { a: 3 }, cap_util: 10 }), false);
    assert.equal(readCache('claude').cap_util, 95);
    // same second, HIGHER util → accept (escalation must win)
    assert.equal(writeCache('claude', { fetched_at: 1000, raw: { a: 4 }, cap_util: 97 }), true);
    assert.equal(readCache('claude').cap_util, 97);
    // strictly newer second → accept
    assert.equal(writeCache('claude', { fetched_at: 1001, raw: { a: 5 }, cap_util: 5 }), true);
    assert.equal(readCache('claude').cap_util, 5);
  });
  rmSync(dir, { recursive: true, force: true });
});
