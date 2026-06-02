#!/usr/bin/env node
// budget-guard — window fingerprint for once-only / hard-crossing reminders.
//
// File: $BUDGET_STATE_DIR/notified/<agent>_<scope>.json
//   scope  = sha256(realpath(cwd))[:16]   — pwd -P analogue
//   body   = [{fp, at, util_at_fire}, ...]
//   fp     = "<agent>|<scope>|<bucket_id>|<reset_epoch>|<threshold>"
//
// shouldFire(...) — returns true iff the given fp is NOT in the file yet.
//   On true, appends {fp, at, util_at_fire} and atomically rewrites the file.
//   On false, returns false (no update).
//
// pruneNotified(now) — walks every fingerprint file, drops entries whose
//   reset_epoch has passed (since the window rolled, the fp can't match again).
//
// Spec-locked invariant: do NOT clear by util<T1. Replay at the threshold
// boundary is exactly what the fingerprint is for. Bucket/reset moves are
// what re-arm the shot (new fp).
//
// Fail-open: every filesystem call is wrapped; errors are silent and cause
// the fingerprint to behave as if the entry doesn't exist (so we'd re-fire).
// Acceptable duplicate notifications are better than dropped ones.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SCOPE_LEN = 16;

// ─── paths ───────────────────────────────────────────────────────────────

function notifiedDir() {
  const dir = join(process.env.BUDGET_STATE_DIR || join(homedir(), '.budget-guard'), 'notified');
  try { mkdirSync(dir, { recursive: true }); } catch (_) { /* fail-open */ }
  return dir;
}

function scopeHash() {
  const cwd = process.env.BUDGET_CWD_OVERRIDE || process.cwd();
  let canonical;
  try { canonical = realpathSync(cwd); } catch (_) { canonical = cwd; }
  return createHash('sha256').update(String(canonical)).digest('hex').slice(0, SCOPE_LEN);
}

function fileFor(agent) {
  const scope = scopeHash();
  return join(notifiedDir(), `${agent}_${scope}.json`);
}

function buildFp(agent, bucketId, resetEpoch, threshold) {
  const scope = scopeHash();
  return `${agent}|${scope}|${bucketId || ''}|${Number.isFinite(resetEpoch) ? resetEpoch : 0}|${threshold}`;
}

// ─── R/W ─────────────────────────────────────────────────────────────────

function readArray(path) {
  try {
    if (!existsSync(path)) return [];
    const txt = readFileSync(path, 'utf8');
    const j = JSON.parse(txt);
    return Array.isArray(j) ? j : [];
  } catch (_) { return []; }
}

function writeArray(path, arr) {
  try {
    const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(arr));
    renameSync(tmp, path);
    return true;
  } catch (_) { return false; }
}

// ─── public ──────────────────────────────────────────────────────────────

/**
 * Returns true iff this (agent, bucket, reset, threshold) tuple has not
 * been fired in the current scope+window. On true, records the fire.
 * Fail-open: any error returns true (so we'd re-fire rather than miss).
 */
export function shouldFire(agent, util, bucketId, resetEpoch, threshold) {
  if (!agent || typeof agent !== 'string') return true;
  if (!Number.isFinite(threshold)) return true;
  try {
    const path = fileFor(agent);
    const fp = buildFp(agent, bucketId, resetEpoch, threshold);
    const now = nowSec();
    const arr = readArray(path);
    const idx = arr.findIndex((e) => e && typeof e === 'object' && e.fp === fp);
    if (idx !== -1) {
      // Existing fp. For a resettable window (resetEpoch>0) the fp key already
      // includes the reset, so a match means "same window, already fired" →
      // suppress. For a resetLESS fp (resetEpoch<=0, the non-resettable-bucket
      // case) there is no reset to re-arm us, so we self-age: if the recorded
      // fire is older than fpMaxAge, re-arm here rather than waiting for the
      // next pruneNotified (which only runs on resume — a long single session
      // would otherwise never re-warn). Resettable fps are never aged here.
      const re = Number(resetEpoch);
      if (Number.isFinite(re) && re > 0) return false;
      const at = Number(arr[idx].at);
      if (Number.isFinite(at) && now - at < fpMaxAge()) return false;
      // aged out → re-arm: refresh this entry's timestamp and fire.
      arr[idx] = { fp, at: now, util_at_fire: Number.isFinite(util) ? util : 0 };
      writeArray(path, arr);
      return true;
    }
    arr.push({ fp, at: now, util_at_fire: Number.isFinite(util) ? util : 0 });
    return writeArray(path, arr);
  } catch (_) {
    return true;
  }
}

// Max age for a fingerprint entry whose reset_epoch is unknown (0). The
// non-resettable-bucket case (bucket_id='', reset_epoch=0) produces fps that
// can never be pruned by reset (there is no reset to wait for) and would never
// re-arm. We age them out instead: after BUDGET_FP_MAX_AGE seconds (default 8
// days, longer than the 7-day weekly window) the entry is dropped, so a
// persistent non-resettable bucket re-warns at most once per ~window.
function fpMaxAge() {
  const v = Number.parseInt(process.env.BUDGET_FP_MAX_AGE || '', 10);
  return Number.isFinite(v) && v > 0 ? v : 8 * 24 * 3600;
}

/**
 * Prune fingerprint entries that can no longer match a live window:
 *   1. reset_epoch in the fp has passed (reset > 0 && reset <= now) — the
 *      window rolled, the fp key changed, the old entry is dead weight.
 *   2. entries with no usable reset (reset <= 0) older than fpMaxAge — the
 *      non-resettable-bucket case, aged out so it can re-arm.
 * Returns number of entries dropped.
 */
export function pruneNotified(now) {
  const nowS = Number.isFinite(now) ? now : nowSec();
  const maxAge = fpMaxAge();
  let pruned = 0;
  let entries;
  try { entries = readdirSync(notifiedDir()); } catch (_) { return 0; }
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const path = join(notifiedDir(), name);
    const arr = readArray(path);
    if (arr.length === 0) continue;
    const kept = arr.filter((e) => {
      if (!e || typeof e !== 'object' || typeof e.fp !== 'string') return false;
      const parts = e.fp.split('|');
      const re = Number.parseInt(parts[3] || '0', 10);
      if (Number.isFinite(re) && re > 0) {
        // resettable window: drop once its reset has passed
        if (re <= nowS) { pruned++; return false; }
        return true;
      }
      // non-resettable (reset 0/unknown): age out by `at`
      const at = Number(e.at);
      if (Number.isFinite(at) && nowS - at >= maxAge) { pruned++; return false; }
      return true;
    });
    if (kept.length !== arr.length) {
      writeArray(path, kept);
    }
  }
  return pruned;
}

/** Read current fingerprint file (for doctor). */
export function listNotified(agent) {
  if (!agent) return [];
  return readArray(fileFor(agent));
}

/** Count fingerprint files (for doctor). */
export function countNotifiedFiles() {
  try {
    return readdirSync(notifiedDir()).filter((f) => f.endsWith('.json')).length;
  } catch (_) { return 0; }
}

// ─── internal ────────────────────────────────────────────────────────────

function nowSec() {
  if (process.env.BUDGET_NOW_EPOCH) {
    const n = Number.parseInt(process.env.BUDGET_NOW_EPOCH, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return Math.floor(Date.now() / 1000);
}
