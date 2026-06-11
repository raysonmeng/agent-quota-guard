/**
 * Unit + integration tests for lib/probe/burn-rate.mjs and the burn-rate
 * wiring inside lib/probe/index.mjs (probe_schema 2).
 *
 * Pure-function tests are ported from the agent-bridge reference suite
 * (src/unit-test/burn-history.test.ts) — same rejection rules, EWMA math,
 * confidence gates and runway semantics, adapted to this repo's snake_case
 * field contract.
 *
 * Run: node --test tests/burn-rate.test.mjs
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  BURN_STATE_VERSION,
  CONFIDENT_MIN_SAMPLES,
  CONFIDENT_MIN_SPAN_HOURS,
  DEFAULT_SAMPLE_CAP,
  EMPTY_BUCKET_HISTORY,
  EWMA_HALF_LIFE_HOURS,
  RESET_EPOCH_BUCKET_SEC,
  SHORT_WINDOW_MAX_SEC,
  addSample,
  burnFieldsForBucket,
  classifySamplePair,
  classifyWindowKind,
  emptyBurnState,
  enrichBuckets,
  instantRate,
  isConfident,
  parseBurnState,
  recordSamples,
  updateEwma,
} from '../lib/probe/burn-rate.mjs';
import { fetchUsage, writeCache } from '../lib/probe/index.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const NOW = 1_700_000_000;
const RESET = NOW + 4 * 3600;

// ─── helpers ────────────────────────────────────────────────────────────────

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'burn-rate-test-'));
}

// Async-safe env scope: restores AFTER the inner promise settles (the sync
// withEnv in probe.test.mjs restores at first await, which is unsafe here).
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

function sample(overrides = {}) {
  return { ts: NOW, util: 10, reset_epoch: RESET, ...overrides };
}

function closeTo(actual, expected, eps = 1e-6) {
  assert.ok(
    Math.abs(actual - expected) < eps,
    `expected ${actual} to be within ${eps} of ${expected}`,
  );
}

// ─── classifySamplePair / instantRate ───────────────────────────────────────

test('classifySamplePair: normal monotonic pair yields pct-per-hour rate', () => {
  const prev = sample({ ts: NOW, util: 10 });
  const next = sample({ ts: NOW + 1800, util: 10.6 });
  assert.equal(classifySamplePair(prev, next), 'ok');
  closeTo(instantRate(prev, next), 1.2);
});

test('classifySamplePair: equal util is a valid zero rate (idle account)', () => {
  const prev = sample({ ts: NOW, util: 10 });
  const next = sample({ ts: NOW + 1800, util: 10 });
  assert.equal(instantRate(prev, next), 0);
});

test('classifySamplePair: reset_epoch beyond the jitter bucket → cross-reset, no rate', () => {
  const prev = sample({ ts: NOW, util: 90 });
  const next = sample({ ts: NOW + 1800, util: 2, reset_epoch: RESET + RESET_EPOCH_BUCKET_SEC + 1 });
  assert.equal(classifySamplePair(prev, next), 'cross-reset');
  assert.equal(instantRate(prev, next), null);
});

test('classifySamplePair: reset_epoch jitter within the bucket does NOT count as a reset', () => {
  const prev = sample({ ts: NOW, util: 10 });
  const next = sample({ ts: NOW + 1800, util: 10.6, reset_epoch: RESET + RESET_EPOCH_BUCKET_SEC });
  assert.equal(classifySamplePair(prev, next), 'ok');
});

test('classifySamplePair: util regression without a reset → dropped pair, no rate', () => {
  const prev = sample({ ts: NOW, util: 50 });
  const next = sample({ ts: NOW + 1800, util: 48 });
  assert.equal(classifySamplePair(prev, next), 'regression');
  assert.equal(instantRate(prev, next), null);
});

test('classifySamplePair: non-monotonic timestamps (backwards or duplicate) → no rate', () => {
  const prev = sample({ ts: NOW, util: 10 });
  assert.equal(classifySamplePair(prev, sample({ ts: NOW - 60, util: 11 })), 'non-monotonic');
  assert.equal(classifySamplePair(prev, sample({ ts: NOW, util: 11 })), 'non-monotonic');
  assert.equal(instantRate(prev, sample({ ts: NOW - 60, util: 11 })), null);
});

// ─── updateEwma ──────────────────────────────────────────────────────────────

test('updateEwma: first valid rate initializes state', () => {
  const state = updateEwma(null, 1.2, NOW, NOW + 1800, 2);
  closeTo(state.rate_pct_per_hour, 1.2);
  assert.equal(state.valid_samples, 1);
  assert.equal(state.first_valid_ts, NOW);
  assert.equal(state.updated_at, NOW + 1800);
});

test('updateEwma: a gap of exactly one half-life moves halfway', () => {
  const initial = updateEwma(null, 1.0, NOW, NOW, 2);
  const next = updateEwma(initial, 2.0, NOW, NOW + 2 * 3600, 2);
  closeTo(next.rate_pct_per_hour, 1.5);
  assert.equal(next.valid_samples, 2);
});

test('updateEwma: a gap of two half-lives moves three quarters of the way', () => {
  const initial = updateEwma(null, 1.0, NOW, NOW, 2);
  const next = updateEwma(initial, 2.0, NOW, NOW + 4 * 3600, 2);
  closeTo(next.rate_pct_per_hour, 1.75);
});

test('updateEwma: converges to a constant rate stream', () => {
  let state = updateEwma(null, 0, NOW, NOW, 2);
  for (let i = 1; i <= 40; i++) {
    state = updateEwma(state, 1.2, NOW, NOW + i * 1800, 2);
  }
  closeTo(state.rate_pct_per_hour, 1.2, 0.01);
});

test('updateEwma: does not mutate the previous state (immutability)', () => {
  const initial = updateEwma(null, 1.0, NOW, NOW, 2);
  const frozen = JSON.stringify(initial);
  updateEwma(initial, 2.0, NOW, NOW + 3600, 2);
  assert.equal(JSON.stringify(initial), frozen);
});

// ─── addSample ───────────────────────────────────────────────────────────────

const OPTS = { cap: DEFAULT_SAMPLE_CAP, halfLifeHours: 2 };

test('addSample: first sample is stored without producing a rate', () => {
  const next = addSample(EMPTY_BUCKET_HISTORY, sample(), OPTS);
  assert.equal(next.samples.length, 1);
  assert.equal(next.ewma, null);
});

test('addSample: second monotonic sample produces the first EWMA state', () => {
  const h1 = addSample(EMPTY_BUCKET_HISTORY, sample({ ts: NOW, util: 10 }), OPTS);
  const h2 = addSample(h1, sample({ ts: NOW + 1800, util: 10.6 }), OPTS);
  assert.notEqual(h2.ewma, null);
  closeTo(h2.ewma.rate_pct_per_hour, 1.2);
});

test('addSample: regression sample is kept in the ring but produces no rate', () => {
  const h1 = addSample(EMPTY_BUCKET_HISTORY, sample({ ts: NOW, util: 50 }), OPTS);
  const h2 = addSample(h1, sample({ ts: NOW + 1800, util: 48 }), OPTS);
  assert.equal(h2.samples.length, 2);
  assert.equal(h2.ewma, null);
});

test('addSample: non-monotonic-timestamp sample is dropped entirely (same reference)', () => {
  const h1 = addSample(EMPTY_BUCKET_HISTORY, sample({ ts: NOW, util: 10 }), OPTS);
  const h2 = addSample(h1, sample({ ts: NOW - 60, util: 11 }), OPTS);
  assert.equal(h2, h1);
  assert.equal(h2.samples.length, 1);
  assert.equal(h2.samples[0].ts, NOW);
});

test('addSample: cross-reset sample becomes the new baseline without producing a rate', () => {
  const h1 = addSample(EMPTY_BUCKET_HISTORY, sample({ ts: NOW, util: 90 }), OPTS);
  const h2 = addSample(h1, sample({ ts: NOW + 1800, util: 2, reset_epoch: RESET + 7200 }), OPTS);
  assert.equal(h2.samples.length, 2);
  assert.equal(h2.ewma, null);
  // the next pair measures from the new baseline
  const h3 = addSample(h2, sample({ ts: NOW + 3600, util: 2.6, reset_epoch: RESET + 7200 }), OPTS);
  closeTo(h3.ewma.rate_pct_per_hour, 1.2);
});

test('addSample: ring truncation keeps only the newest cap samples', () => {
  let history = EMPTY_BUCKET_HISTORY;
  for (let i = 0; i < 8; i++) {
    history = addSample(history, sample({ ts: NOW + i * 1800, util: 10 + i }), {
      cap: 5,
      halfLifeHours: 2,
    });
  }
  assert.equal(history.samples.length, 5);
  assert.equal(history.samples[0].ts, NOW + 3 * 1800);
  assert.equal(history.samples[4].ts, NOW + 7 * 1800);
});

test('addSample: does not mutate the input history (immutability)', () => {
  const h1 = addSample(EMPTY_BUCKET_HISTORY, sample({ ts: NOW, util: 10 }), OPTS);
  const frozen = JSON.stringify(h1);
  addSample(h1, sample({ ts: NOW + 1800, util: 11 }), OPTS);
  assert.equal(JSON.stringify(h1), frozen);
});

// ─── isConfident ─────────────────────────────────────────────────────────────

function ewmaState(validSamples, spanHours) {
  return {
    rate_pct_per_hour: 1.2,
    updated_at: NOW + spanHours * 3600,
    valid_samples: validSamples,
    first_valid_ts: NOW,
  };
}

test('isConfident: null state is never confident', () => {
  assert.equal(isConfident(null, 'short'), false);
});

test('isConfident: short window needs ≥6 valid samples AND ≥1h span', () => {
  assert.equal(isConfident(ewmaState(CONFIDENT_MIN_SAMPLES - 1, 2), 'short'), false);
  assert.equal(isConfident(ewmaState(CONFIDENT_MIN_SAMPLES, 0.5), 'short'), false);
  assert.equal(isConfident(ewmaState(CONFIDENT_MIN_SAMPLES, 1), 'short'), true);
});

test('isConfident: long window needs ≥6 valid samples AND ≥12h span', () => {
  assert.equal(isConfident(ewmaState(CONFIDENT_MIN_SAMPLES, 11), 'long'), false);
  assert.equal(isConfident(ewmaState(CONFIDENT_MIN_SAMPLES, 12), 'long'), true);
});

test('constants match the shared field contract', () => {
  assert.equal(CONFIDENT_MIN_SAMPLES, 6);
  assert.equal(CONFIDENT_MIN_SPAN_HOURS.short, 1);
  assert.equal(CONFIDENT_MIN_SPAN_HOURS.long, 12);
  assert.equal(EWMA_HALF_LIFE_HOURS.short, 2);
  assert.equal(EWMA_HALF_LIFE_HOURS.long, 24);
  assert.equal(RESET_EPOCH_BUCKET_SEC, 600);
});

// ─── classifyWindowKind ──────────────────────────────────────────────────────

test('classifyWindowKind: known id patterns win over horizon', () => {
  assert.equal(classifyWindowKind('five_hour', 7 * 24 * 3600, undefined), 'short');
  assert.equal(classifyWindowKind('seven_day', 100, undefined), 'long');
  assert.equal(classifyWindowKind('seven_day_sonnet', 100, undefined), 'long');
  assert.equal(classifyWindowKind('rate_limit.primary_window', 7 * 24 * 3600, undefined), 'short');
  assert.equal(classifyWindowKind('rate_limit.secondary_window', 100, undefined), 'long');
  assert.equal(
    classifyWindowKind('additional_rate_limits[GPT].secondary_window', 100, undefined),
    'long',
  );
});

test('classifyWindowKind: unknown id falls back to reset horizon', () => {
  assert.equal(classifyWindowKind('mystery', SHORT_WINDOW_MAX_SEC, undefined), 'short');
  assert.equal(classifyWindowKind('mystery', SHORT_WINDOW_MAX_SEC + 1, undefined), 'long');
});

test('classifyWindowKind: long classification is sticky for unknown ids', () => {
  // a weekly-class window observed near its reset must not flap back to short
  assert.equal(classifyWindowKind('mystery', 300, 'long'), 'long');
  assert.equal(classifyWindowKind('mystery', 300, 'short'), 'short');
});

// ─── burnFieldsForBucket / enrichBuckets ─────────────────────────────────────

function historyWith(ewma, kind = 'short') {
  return { kind, samples: [], ewma };
}

test('burnFieldsForBucket: no EWMA state → null (fields omitted, not null-valued)', () => {
  assert.equal(burnFieldsForBucket(EMPTY_BUCKET_HISTORY, sample(), NOW), null);
  assert.equal(burnFieldsForBucket(undefined, sample(), NOW), null);
});

test('burnFieldsForBucket: basic runway = (100 − util)/rate when shorter than reset', () => {
  const history = historyWith(ewmaState(10, 2));
  // rate 1.2 %/h, util 80 → (100-80)/1.2 h = 60000 s; reset far away
  const bucket = { id: 'five_hour', util: 80, reset_epoch: NOW + 100 * 3600 };
  const fields = burnFieldsForBucket(history, bucket, NOW);
  assert.equal(fields.burn_rate_pct_per_hour, 1.2);
  assert.equal(fields.burn_confident, true);
  assert.equal(fields.runway_seconds, 60000);
  assert.equal(fields.depleted_at_epoch, NOW + 60000);
});

test('burnFieldsForBucket: runway truncated at reset_epoch − now when burn is slow', () => {
  const history = historyWith({ ...ewmaState(10, 2), rate_pct_per_hour: 0.5 });
  const bucket = { id: 'five_hour', util: 80, reset_epoch: NOW + 6 * 3600 };
  const fields = burnFieldsForBucket(history, bucket, NOW);
  assert.equal(fields.runway_seconds, 6 * 3600);
  assert.equal(fields.depleted_at_epoch, NOW + 6 * 3600);
});

test('burnFieldsForBucket: util at/above 100 → zero runway', () => {
  const history = historyWith(ewmaState(10, 2));
  const bucket = { id: 'five_hour', util: 100, reset_epoch: NOW + 3600 };
  const fields = burnFieldsForBucket(history, bucket, NOW);
  assert.equal(fields.runway_seconds, 0);
  assert.equal(fields.depleted_at_epoch, NOW);
});

test('burnFieldsForBucket: zero rate → runway is the full time-to-reset', () => {
  const history = historyWith({ ...ewmaState(10, 2), rate_pct_per_hour: 0 });
  const bucket = { id: 'five_hour', util: 50, reset_epoch: NOW + 2 * 3600 };
  const fields = burnFieldsForBucket(history, bucket, NOW);
  assert.equal(fields.burn_rate_pct_per_hour, 0);
  assert.equal(fields.runway_seconds, 2 * 3600);
});

test('burnFieldsForBucket: zero rate + no future reset → rate fields only, no runway', () => {
  const history = historyWith({ ...ewmaState(10, 2), rate_pct_per_hour: 0 });
  const bucket = { id: 'odd', util: 50, reset_epoch: 0 };
  const fields = burnFieldsForBucket(history, bucket, NOW);
  assert.equal(fields.burn_rate_pct_per_hour, 0);
  assert.ok(!('runway_seconds' in fields));
  assert.ok(!('depleted_at_epoch' in fields));
});

test('burnFieldsForBucket: non-confident long window reports burn_confident=false', () => {
  const history = historyWith(ewmaState(10, 2), 'long'); // span 2h < 12h
  const bucket = { id: 'seven_day', util: 50, reset_epoch: NOW + 86400 };
  const fields = burnFieldsForBucket(history, bucket, NOW);
  assert.equal(fields.burn_confident, false);
});

test('enrichBuckets: buckets without history pass through unchanged (same reference)', () => {
  const state = emptyBurnState();
  const bucket = { id: 'five_hour', util: 10, reset_epoch: RESET, resettable: true };
  const out = enrichBuckets(state, [bucket], NOW);
  assert.equal(out[0], bucket);
});

test('enrichBuckets: appends fields without touching existing bucket keys', () => {
  const state = {
    version: BURN_STATE_VERSION,
    buckets: { five_hour: historyWith(ewmaState(10, 2)) },
  };
  const bucket = { id: 'five_hour', util: 10, reset_epoch: NOW + 3600, resettable: true };
  const out = enrichBuckets(state, [bucket], NOW)[0];
  assert.equal(out.id, 'five_hour');
  assert.equal(out.util, 10);
  assert.equal(out.reset_epoch, NOW + 3600);
  assert.equal(out.resettable, true);
  assert.equal(typeof out.burn_rate_pct_per_hour, 'number');
  assert.equal(typeof out.burn_confident, 'boolean');
  // input bucket not mutated
  assert.ok(!('burn_rate_pct_per_hour' in bucket));
});

// ─── parseBurnState (corruption → rebuild) ───────────────────────────────────

test('parseBurnState: null / non-object / wrong version → empty state', () => {
  assert.deepEqual(parseBurnState(null), emptyBurnState());
  assert.deepEqual(parseBurnState('garbage'), emptyBurnState());
  assert.deepEqual(parseBurnState({ version: 99, buckets: {} }), emptyBurnState());
  assert.deepEqual(parseBurnState({ version: BURN_STATE_VERSION, buckets: [] }), emptyBurnState());
});

test('parseBurnState: malformed samples / ewma are filtered, valid parts survive', () => {
  const raw = {
    version: BURN_STATE_VERSION,
    buckets: {
      five_hour: {
        kind: 'short',
        samples: [sample(), { ts: 'NaN' }, null, sample({ ts: NOW + 60 })],
        ewma: { rate_pct_per_hour: 'bad' },
      },
      seven_day: { kind: 'long', samples: [], ewma: ewmaState(8, 13) },
    },
  };
  const state = parseBurnState(raw);
  assert.equal(state.buckets.five_hour.samples.length, 2);
  assert.equal(state.buckets.five_hour.ewma, null);
  assert.equal(state.buckets.seven_day.ewma.valid_samples, 8);
});

test('parseBurnState: roundtrips its own output', () => {
  const { state } = recordSamples(
    emptyBurnState(),
    [{ id: 'five_hour', util: 10, reset_epoch: RESET, resettable: true }],
    NOW,
  );
  const reparsed = parseBurnState(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(reparsed, state);
});

// ─── recordSamples ───────────────────────────────────────────────────────────

const BUCKETS = (util, ts0 = NOW) => [
  { id: 'five_hour', util, reset_epoch: ts0 + 5 * 3600, resettable: true },
  { id: 'seven_day', util, reset_epoch: ts0 + 5 * 86400, resettable: true },
];

test('recordSamples: fresh sample → changed=true, both windows tracked', () => {
  const { state, changed } = recordSamples(emptyBurnState(), BUCKETS(10), NOW);
  assert.equal(changed, true);
  assert.equal(state.buckets.five_hour.samples.length, 1);
  assert.equal(state.buckets.five_hour.kind, 'short');
  assert.equal(state.buckets.seven_day.kind, 'long');
});

test('recordSamples: duplicate fetched_at (cache hit) → changed=false, no flooding', () => {
  const first = recordSamples(emptyBurnState(), BUCKETS(10), NOW);
  const second = recordSamples(first.state, BUCKETS(10), NOW);
  assert.equal(second.changed, false);
  assert.equal(second.state, first.state);
  assert.equal(second.state.buckets.five_hour.samples.length, 1);
});

test('recordSamples: expired / non-resettable windows are skipped', () => {
  const buckets = [
    { id: 'expired', util: 10, reset_epoch: NOW - 10, resettable: true },
    { id: 'no_reset', util: 10, reset_epoch: 0, resettable: false },
  ];
  const { state, changed } = recordSamples(emptyBurnState(), buckets, NOW);
  assert.equal(changed, false);
  assert.deepEqual(state.buckets, {});
});

test('recordSamples: two polls 30min apart produce the first rate', () => {
  const r1 = recordSamples(emptyBurnState(), BUCKETS(10), NOW);
  const r2 = recordSamples(r1.state, BUCKETS(11), NOW + 1800);
  assert.equal(r2.changed, true);
  closeTo(r2.state.buckets.five_hour.ewma.rate_pct_per_hour, 2);
  closeTo(r2.state.buckets.seven_day.ewma.rate_pct_per_hour, 2);
});

test('recordSamples: bad ts or non-array buckets → changed=false, same state', () => {
  const state = emptyBurnState();
  assert.equal(recordSamples(state, BUCKETS(10), 0).changed, false);
  assert.equal(recordSamples(state, BUCKETS(10), NaN).changed, false);
  assert.equal(recordSamples(state, 'nope', NOW).changed, false);
});

// ─── integration: fetchUsage cache path (the bridge's repeated-call shape) ───

const FIVE_RESET = NOW + 5 * 3600;
const SEVEN_RESET = NOW + 5 * 86400;

function claudeRaw(util) {
  return {
    five_hour: { utilization: util, resets_at: new Date(FIVE_RESET * 1000).toISOString() },
    seven_day: { utilization: util, resets_at: new Date(SEVEN_RESET * 1000).toISOString() },
  };
}

function baseEnv(dir) {
  return {
    BUDGET_STATE_DIR: dir,
    BUDGET_CACHE_TTL: '300',
    BUDGET_NO_TOKEN_DISCOVERY: '1',
    BUDGET_CLAUDE_TOKEN: undefined,
    BUDGET_USAGE_FIXTURE: undefined,
    BUDGET_NOW_EPOCH: undefined,
  };
}

// seed the usage cache as if a live fetch happened at `t`, then probe at t+5
async function pollAt(t, util) {
  assert.equal(writeCache('claude', { fetched_at: t, raw: claudeRaw(util), cap_util: util }), true);
  return fetchUsage('claude', { now: t + 5 });
}

function readBurnFile(dir) {
  return JSON.parse(readFileSync(join(dir, 'burn_claude.json'), 'utf8'));
}

test('integration: first probe → probe_schema 2, v1 fields intact, burn fields omitted', async () => {
  const dir = tempDir();
  try {
    await withEnvAsync(baseEnv(dir), async () => {
      const result = await pollAt(NOW, 10);
      assert.equal(result.probe_schema, 2);
      // v1 contract untouched
      assert.equal(result.ok, true);
      assert.equal(result.util, 10);
      assert.equal(result.warn_util, 10);
      assert.equal(result.bucket_id, 'five_hour');
      assert.equal(result.reset_epoch, FIVE_RESET);
      assert.equal(result.source, 'cache');
      assert.equal(result.stale, false);
      assert.equal(result.buckets.length, 2);
      // one sample is not enough for a rate — fields omitted, not null
      for (const b of result.buckets) {
        assert.ok(!('burn_rate_pct_per_hour' in b), `${b.id} must omit rate`);
        assert.ok(!('runway_seconds' in b), `${b.id} must omit runway`);
      }
      // state persisted
      assert.equal(readBurnFile(dir).version, BURN_STATE_VERSION);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('integration: second probe 30min later → rate appears, runway truncated at reset', async () => {
  const dir = tempDir();
  try {
    await withEnvAsync(baseEnv(dir), async () => {
      await pollAt(NOW, 10);
      const result = await pollAt(NOW + 1800, 11);
      const now = NOW + 1805;
      const five = result.buckets.find((b) => b.id === 'five_hour');
      closeTo(five.burn_rate_pct_per_hour, 2);
      assert.equal(five.burn_confident, false); // 1 valid pair < 6
      // (100-11)/2 = 44.5h ≫ time-to-reset → truncated
      assert.equal(five.runway_seconds, FIVE_RESET - now);
      assert.equal(five.depleted_at_epoch, FIVE_RESET);
      const seven = result.buckets.find((b) => b.id === 'seven_day');
      closeTo(seven.burn_rate_pct_per_hour, 2);
      assert.equal(seven.burn_confident, false);
      // (100-11)/2 = 44.5h < 5d time-to-reset → rate-bound runway
      assert.equal(seven.runway_seconds, Math.round(((100 - 11) / 2) * 3600));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('integration: EWMA converges over 7 polls; confident flips for short but not long', async () => {
  const dir = tempDir();
  try {
    await withEnvAsync(baseEnv(dir), async () => {
      let result = null;
      for (let i = 0; i < 7; i++) {
        result = await pollAt(NOW + i * 1800, 10 + i);
      }
      const five = result.buckets.find((b) => b.id === 'five_hour');
      closeTo(five.burn_rate_pct_per_hour, 2, 0.001);
      // 6 valid pairs over a 3h span: ≥6 samples + ≥1h → short window confident
      assert.equal(five.burn_confident, true);
      const seven = result.buckets.find((b) => b.id === 'seven_day');
      // same samples but a long window needs a 12h span → not confident yet
      assert.equal(seven.burn_confident, false);
      const onDisk = readBurnFile(dir);
      assert.equal(onDisk.buckets.five_hour.ewma.valid_samples, 6);
      assert.equal(onDisk.buckets.five_hour.samples.length, 7);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('integration: repeated probes on the same cached fetch do not flood samples', async () => {
  const dir = tempDir();
  try {
    await withEnvAsync(baseEnv(dir), async () => {
      await pollAt(NOW, 10);
      // same cache entry, three more reads at different wall times
      await fetchUsage('claude', { now: NOW + 10 });
      await fetchUsage('claude', { now: NOW + 20 });
      const result = await fetchUsage('claude', { now: NOW + 30 });
      assert.equal(result.source, 'cache');
      const onDisk = readBurnFile(dir);
      assert.equal(onDisk.buckets.five_hour.samples.length, 1, 'dedup by fetched_at');
      assert.equal(onDisk.buckets.five_hour.ewma, null);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('integration: corrupt burn state file → rebuilt empty, probe keeps working', async () => {
  const dir = tempDir();
  try {
    await withEnvAsync(baseEnv(dir), async () => {
      writeFileSync(join(dir, 'burn_claude.json'), '{ not json !!!');
      const r1 = await pollAt(NOW, 10);
      assert.equal(r1.ok, true); // no throw, fail-open
      const r2 = await pollAt(NOW + 1800, 11);
      const five = r2.buckets.find((b) => b.id === 'five_hour');
      closeTo(five.burn_rate_pct_per_hour, 2);
      assert.equal(readBurnFile(dir).version, BURN_STATE_VERSION);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('integration: stale cache (ok=false) is never sampled', async () => {
  const dir = tempDir();
  try {
    await withEnvAsync(baseEnv(dir), async () => {
      // cache far older than TTL; live fetch fails (token discovery disabled)
      writeCache('claude', { fetched_at: NOW - 4000, raw: claudeRaw(10), cap_util: 10 });
      const result = await fetchUsage('claude', { now: NOW });
      assert.equal(result.ok, false);
      assert.equal(result.stale, true);
      assert.equal(result.probe_schema, 2);
      assert.equal(existsSync(join(dir, 'burn_claude.json')), false, 'stale data must not seed state');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('integration: fixture probes are stateless — no sampling, no enrichment', async () => {
  const dir = tempDir();
  try {
    await withEnvAsync(baseEnv(dir), async () => {
      const fixture = join(ROOT, 'tests', 'fixtures', 'claude-usage.json');
      const result = await fetchUsage('claude', { fixture, now: NOW });
      assert.equal(result.ok, true);
      assert.equal(result.source, 'fixture');
      assert.equal(result.probe_schema, 2);
      for (const b of result.buckets) {
        assert.ok(!('burn_rate_pct_per_hour' in b));
      }
      assert.equal(existsSync(join(dir, 'burn_claude.json')), false);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('integration: bin/probe.mjs emits probe_schema 2 + burn fields on stdout', async () => {
  const dir = tempDir();
  try {
    await withEnvAsync(baseEnv(dir), async () => {
      const run = (nowEpoch) => {
        const stdout = execFileSync(
          process.execPath,
          [join(ROOT, 'bin', 'probe.mjs'), 'claude', 'probe'],
          {
            encoding: 'utf8',
            cwd: dir,
            env: {
              ...process.env,
              HOME: dir, // keep the spawned process away from any real config
              BUDGET_STATE_DIR: dir,
              BUDGET_CACHE_TTL: '300',
              BUDGET_NO_TOKEN_DISCOVERY: '1',
              BUDGET_NOW_EPOCH: String(nowEpoch),
            },
          },
        );
        return JSON.parse(stdout.trim().split('\n').pop());
      };

      writeCache('claude', { fetched_at: NOW, raw: claudeRaw(10), cap_util: 10 });
      const first = run(NOW + 5);
      assert.equal(first.probe_schema, 2);
      assert.equal(first.ok, true);

      writeCache('claude', { fetched_at: NOW + 1800, raw: claudeRaw(11), cap_util: 11 });
      const second = run(NOW + 1805);
      assert.equal(second.probe_schema, 2);
      const five = second.buckets.find((b) => b.id === 'five_hour');
      closeTo(five.burn_rate_pct_per_hour, 2);
      assert.equal(typeof five.burn_confident, 'boolean');
      assert.equal(typeof five.runway_seconds, 'number');
      assert.equal(typeof five.depleted_at_epoch, 'number');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
