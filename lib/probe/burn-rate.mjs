// burn-rate — EWMA burn-rate estimation + runway computation for budget-probe.
// Pure ESM, zero external deps, Node >=18. Pure functions only: all disk IO
// (the burn_<agent>.json state file) lives in lib/probe/index.mjs.
//
// Field contract (probe_schema 2, shared with agent-bridge — keep in sync):
//   per bucket (appended only when enough samples exist; omitted otherwise):
//     burn_rate_pct_per_hour  EWMA burn rate (half-life: 2h short / 24h long)
//     burn_confident          ≥6 valid samples AND span ≥1h (short) / ≥12h (long)
//     runway_seconds          (100 − util)/rate in seconds, truncated at
//                             (reset_epoch − now); neutral "time to full" —
//                             policy lines are the consumer's business
//     depleted_at_epoch       now + runway_seconds
//     five_hour_windows_left  weekly bucket only: runway_seconds / 5h, one
//                             decimal, emitted only when burn_confident=true
//
// Sample-pair rejection rules (ported from agent-bridge burn-history design):
//   non-monotonic  time went backwards or stood still (duplicate/cached probe)
//                  → sample dropped entirely
//   cross-reset    reset_epoch moved more than the jitter bucket → window
//                  rolled over → sample kept as new baseline, no rate
//   regression     util dropped without a reset (upstream correction)
//                  → sample kept, no rate
//   ok             valid instantaneous-rate observation → fed into the EWMA
//
// Invariants:
//   - every function is pure: state in → state out, no Date.now, no IO;
//   - immutable updates: callers can compare references to detect change;
//   - corrupt persisted state degrades to an empty state, never throws.

export const BURN_STATE_VERSION = 1;

/** Reset-epoch jitter tolerance: a bigger diff means the window rolled over. */
export const RESET_EPOCH_BUCKET_SEC = 600;

/** Sample ring cap per bucket (archive for future parameter calibration). */
export const DEFAULT_SAMPLE_CAP = 500;

/** Confidence gate: minimum valid instantaneous rates folded into the EWMA. */
export const CONFIDENT_MIN_SAMPLES = 6;

/** EWMA half-lives in hours: long (weekly-class) smooths the diurnal cycle. */
export const EWMA_HALF_LIFE_HOURS = { short: 2, long: 24 };

/** Confidence gate: minimum span (hours) covered by valid samples. */
export const CONFIDENT_MIN_SPAN_HOURS = { short: 1, long: 12 };

/** Windows with a reset horizon beyond this are weekly-class ("long"). */
export const SHORT_WINDOW_MAX_SEC = 6 * 3600;

const FIVE_HOUR_WINDOW_SEC = 5 * 3600;

// ─── window-kind classification ──────────────────────────────────────────

const LONG_ID_RE = /seven_day|week|secondary_window/i;
const SHORT_ID_RE = /five_hour|primary_window/i;

/**
 * Classify a bucket as a short (5h-class) or long (weekly-class) window.
 * Known id patterns win; otherwise fall back to the reset horizon with a
 * sticky upgrade (a weekly window observed near its reset must not flap back
 * to "short" once it has been seen with a long horizon).
 */
export function classifyWindowKind(id, resetAfterSec, prevKind) {
  if (typeof id === 'string') {
    if (LONG_ID_RE.test(id)) return 'long';
    if (SHORT_ID_RE.test(id)) return 'short';
  }
  if (prevKind === 'long') return 'long';
  return Number.isFinite(resetAfterSec) && resetAfterSec > SHORT_WINDOW_MAX_SEC
    ? 'long'
    : 'short';
}

// ─── sample-pair classification / instantaneous rate ─────────────────────

/** Sample shape: { ts, util, reset_epoch } (unix seconds / percent / unix seconds). */
export function classifySamplePair(prev, next) {
  if (next.ts <= prev.ts) return 'non-monotonic';
  if (Math.abs(next.reset_epoch - prev.reset_epoch) > RESET_EPOCH_BUCKET_SEC) return 'cross-reset';
  if (next.util < prev.util) return 'regression';
  return 'ok';
}

/** Instantaneous burn rate (pct/h) for a valid adjacent pair, else null. */
export function instantRate(prev, next) {
  if (classifySamplePair(prev, next) !== 'ok') return null;
  return (next.util - prev.util) / ((next.ts - prev.ts) / 3600);
}

// ─── EWMA ─────────────────────────────────────────────────────────────────

/**
 * Time-weighted EWMA update: alpha = 1 − 0.5^(Δt / halfLife), so a gap of
 * exactly one half-life moves the estimate halfway toward the new observation
 * regardless of sampling cadence.
 *
 * EWMA state shape (snake_case, persisted as-is):
 *   { rate_pct_per_hour, updated_at, valid_samples, first_valid_ts }
 */
export function updateEwma(prev, ratePctPerHour, spanStartTs, ts, halfLifeHours) {
  if (!prev) {
    return {
      rate_pct_per_hour: ratePctPerHour,
      updated_at: ts,
      valid_samples: 1,
      first_valid_ts: spanStartTs,
    };
  }
  const dtHours = (ts - prev.updated_at) / 3600;
  const alpha = 1 - Math.pow(0.5, dtHours / halfLifeHours);
  return {
    rate_pct_per_hour: prev.rate_pct_per_hour + alpha * (ratePctPerHour - prev.rate_pct_per_hour),
    updated_at: ts,
    valid_samples: prev.valid_samples + 1,
    first_valid_ts: prev.first_valid_ts,
  };
}

// ─── per-bucket history reducer ──────────────────────────────────────────

export const EMPTY_BUCKET_HISTORY = Object.freeze({
  kind: 'short',
  samples: Object.freeze([]),
  ewma: null,
});

/**
 * Fold one sample into a bucket history (immutable reducer). Returns the SAME
 * reference when nothing changed (non-monotonic duplicate) so callers can
 * cheaply detect "no write needed".
 *
 * Ring/rate handling per pair class:
 *   non-monotonic → sample dropped entirely;
 *   cross-reset   → sample kept as the new baseline, no rate;
 *   regression    → sample kept, no rate;
 *   ok            → sample kept + instantaneous rate folded into the EWMA.
 */
export function addSample(history, sampleIn, opts) {
  const prev = history.samples.length > 0 ? history.samples[history.samples.length - 1] : null;
  if (prev && classifySamplePair(prev, sampleIn) === 'non-monotonic') return history;

  const cap = Math.max(1, opts.cap);
  const samples = [...history.samples, sampleIn].slice(-cap);
  const rate = prev ? instantRate(prev, sampleIn) : null;
  if (rate === null || !prev) {
    return { ...history, samples };
  }
  return {
    ...history,
    samples,
    ewma: updateEwma(history.ewma, rate, prev.ts, sampleIn.ts, opts.halfLifeHours),
  };
}

// ─── confidence gate ──────────────────────────────────────────────────────

/** Enough valid samples over a long enough span for the window class. */
export function isConfident(ewma, kind) {
  if (!ewma) return false;
  if (ewma.valid_samples < CONFIDENT_MIN_SAMPLES) return false;
  const minSpanHours = CONFIDENT_MIN_SPAN_HOURS[kind] ?? CONFIDENT_MIN_SPAN_HOURS.short;
  return ewma.updated_at - ewma.first_valid_ts >= minSpanHours * 3600;
}

// ─── whole-agent state ────────────────────────────────────────────────────

export function emptyBurnState() {
  return { version: BURN_STATE_VERSION, buckets: {} };
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function parseSample(raw) {
  if (raw == null || typeof raw !== 'object') return null;
  if (!isFiniteNumber(raw.ts) || !isFiniteNumber(raw.util) || !isFiniteNumber(raw.reset_epoch)) {
    return null;
  }
  return { ts: raw.ts, util: raw.util, reset_epoch: raw.reset_epoch };
}

function parseEwma(raw) {
  if (raw == null || typeof raw !== 'object') return null;
  if (
    !isFiniteNumber(raw.rate_pct_per_hour) ||
    !isFiniteNumber(raw.updated_at) ||
    !isFiniteNumber(raw.valid_samples) ||
    !isFiniteNumber(raw.first_valid_ts)
  ) {
    return null;
  }
  return {
    rate_pct_per_hour: raw.rate_pct_per_hour,
    updated_at: raw.updated_at,
    valid_samples: raw.valid_samples,
    first_valid_ts: raw.first_valid_ts,
  };
}

function parseBucketHistory(raw) {
  if (raw == null || typeof raw !== 'object') return null;
  const samples = Array.isArray(raw.samples)
    ? raw.samples.map(parseSample).filter((s) => s !== null)
    : [];
  return {
    kind: raw.kind === 'long' ? 'long' : 'short',
    samples,
    ewma: parseEwma(raw.ewma),
  };
}

/**
 * Parse a persisted burn-state object; any structural problem (bad shape,
 * unknown version, null) yields an empty state so the caller rebuilds —
 * corruption degrades to "no burn fields", never to a crash.
 */
export function parseBurnState(raw) {
  if (raw == null || typeof raw !== 'object') return emptyBurnState();
  if (raw.version !== BURN_STATE_VERSION) return emptyBurnState();
  if (raw.buckets == null || typeof raw.buckets !== 'object' || Array.isArray(raw.buckets)) {
    return emptyBurnState();
  }
  const buckets = {};
  for (const [id, value] of Object.entries(raw.buckets)) {
    const history = parseBucketHistory(value);
    if (history) buckets[id] = history;
  }
  return { version: BURN_STATE_VERSION, buckets };
}

/**
 * Fold one probe observation (all buckets, one shared fetch timestamp) into
 * the agent state. Pure: returns { state, changed }. Duplicate observations
 * (same fetched_at — cache hits) collapse to changed=false via the
 * non-monotonic rule, so high-frequency repeated calls never flood the ring.
 * Only live resettable windows (reset_epoch > ts) feed the estimator.
 */
export function recordSamples(state, buckets, ts) {
  if (!isFiniteNumber(ts) || ts <= 0 || !Array.isArray(buckets)) {
    return { state, changed: false };
  }
  let nextBuckets = state.buckets;
  for (const bucket of buckets) {
    if (!bucket || typeof bucket.id !== 'string' || bucket.id.length === 0) continue;
    if (!isFiniteNumber(bucket.util)) continue;
    const resetEpoch = isFiniteNumber(bucket.reset_epoch) ? bucket.reset_epoch : 0;
    if (resetEpoch <= ts) continue;

    const prevHistory = nextBuckets[bucket.id] || EMPTY_BUCKET_HISTORY;
    const kind = classifyWindowKind(bucket.id, resetEpoch - ts, prevHistory.kind);
    const based = prevHistory.kind === kind ? prevHistory : { ...prevHistory, kind };
    const updated = addSample(
      based,
      { ts, util: bucket.util, reset_epoch: resetEpoch },
      { cap: DEFAULT_SAMPLE_CAP, halfLifeHours: EWMA_HALF_LIFE_HOURS[kind] },
    );
    if (updated === prevHistory) continue;
    nextBuckets = { ...nextBuckets, [bucket.id]: updated };
  }
  if (nextBuckets === state.buckets) return { state, changed: false };
  return { state: { version: BURN_STATE_VERSION, buckets: nextBuckets }, changed: true };
}

// ─── derived output fields ───────────────────────────────────────────────

function roundRate(rate) {
  return Math.round(rate * 1000) / 1000;
}

function roundOneDecimal(value) {
  return Math.round(value * 10) / 10;
}

/**
 * Burn fields for one bucket, or null when samples are insufficient (no EWMA
 * yet) — contract: omit the fields rather than emit nulls.
 *
 * Runway: (100 − util)/rate converted to seconds, truncated at
 * (reset_epoch − now). Neutral "time until full"; with rate ≤ 0 the window
 * can never fill before its reset, so the reset bound IS the runway. When
 * neither bound is finite (no positive rate, no future reset) runway is
 * unknowable and the runway fields are omitted while the rate stays.
 */
export function burnFieldsForBucket(history, bucket, now) {
  if (!history || !history.ewma) return null;
  const rate = history.ewma.rate_pct_per_hour;
  const fields = {
    burn_rate_pct_per_hour: roundRate(rate),
    burn_confident: isConfident(history.ewma, history.kind),
  };
  let runwayHours = rate > 0 ? Math.max(0, (100 - bucket.util) / rate) : Infinity;
  if (isFiniteNumber(bucket.reset_epoch) && bucket.reset_epoch > now) {
    runwayHours = Math.min(runwayHours, (bucket.reset_epoch - now) / 3600);
  }
  if (Number.isFinite(runwayHours)) {
    const runwaySeconds = Math.max(0, Math.round(runwayHours * 3600));
    fields.runway_seconds = runwaySeconds;
    fields.depleted_at_epoch = now + runwaySeconds;
    if (history.kind === 'long' && fields.burn_confident === true) {
      fields.five_hour_windows_left = roundOneDecimal(runwaySeconds / FIVE_HOUR_WINDOW_SEC);
    }
  }
  return fields;
}

/**
 * Append burn fields to every bucket that has enough history. Buckets without
 * history pass through unchanged (same reference) — pure additive contract.
 */
export function enrichBuckets(state, buckets, now) {
  if (!Array.isArray(buckets)) return buckets;
  return buckets.map((bucket) => {
    if (!bucket || typeof bucket.id !== 'string') return bucket;
    const fields = burnFieldsForBucket(state.buckets[bucket.id], bucket, now);
    return fields ? { ...bucket, ...fields } : bucket;
  });
}
