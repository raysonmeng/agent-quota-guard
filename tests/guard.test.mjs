/**
 * Unit tests for lib/guard/fingerprint.mjs and lib/guard/checkpoint.mjs
 * Coverage: shouldFire (fingerprint dedup), isCheckpointWrite (allowlist),
 *           three-tier threshold boundaries via phasePost.
 *
 * Run: node --test tests/guard.test.mjs
 */

import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { shouldFire } from '../lib/guard/fingerprint.mjs';
import { isCheckpointWrite } from '../lib/guard/checkpoint.mjs';
import { phasePost, phaseStop } from '../lib/guard/hook.mjs';

// ─── helpers ────────────────────────────────────────────────────────────────

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'budget-guard-test-'));
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

const NOW = 1748850000; // fixed epoch

// ─── fingerprint: shouldFire ──────────────────────────────────────────────────

test('shouldFire: first call returns true and records the fingerprint', () => {
  const dir = tempDir();
  try {
    const fired = withEnv(
      {
        BUDGET_STATE_DIR: dir,
        BUDGET_NOW_EPOCH: String(NOW),
        BUDGET_CWD_OVERRIDE: dir,
      },
      () => shouldFire('claude', 85, 'five_hour', NOW + 3600, 80),
    );
    assert.equal(fired, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shouldFire: same fingerprint second call returns false', () => {
  const dir = tempDir();
  try {
    const args = ['claude', 85, 'five_hour', NOW + 3600, 80];
    const env = {
      BUDGET_STATE_DIR: dir,
      BUDGET_NOW_EPOCH: String(NOW),
      BUDGET_CWD_OVERRIDE: dir,
    };
    withEnv(env, () => shouldFire(...args)); // first call records it
    const second = withEnv(env, () => shouldFire(...args)); // same fp
    assert.equal(second, false, 'second call with same fp should return false');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shouldFire: changing reset_epoch re-arms (new fingerprint)', () => {
  const dir = tempDir();
  try {
    const env = {
      BUDGET_STATE_DIR: dir,
      BUDGET_NOW_EPOCH: String(NOW),
      BUDGET_CWD_OVERRIDE: dir,
    };
    withEnv(env, () => shouldFire('claude', 85, 'five_hour', NOW + 3600, 80));
    // New reset_epoch → different fp → should fire again
    const reArmed = withEnv(env, () => shouldFire('claude', 85, 'five_hour', NOW + 7200, 80));
    assert.equal(reArmed, true, 'different reset_epoch → new fp → should fire');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shouldFire: different threshold → different fingerprint → fires again', () => {
  const dir = tempDir();
  try {
    const env = {
      BUDGET_STATE_DIR: dir,
      BUDGET_NOW_EPOCH: String(NOW),
      BUDGET_CWD_OVERRIDE: dir,
    };
    withEnv(env, () => shouldFire('claude', 80, 'five_hour', NOW + 3600, 80)); // T1
    const t2 = withEnv(env, () => shouldFire('claude', 90, 'five_hour', NOW + 3600, 90)); // T2
    assert.equal(t2, true, 'T2 threshold fires separately from T1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shouldFire: different bucketId → different fp → fires', () => {
  const dir = tempDir();
  try {
    const env = {
      BUDGET_STATE_DIR: dir,
      BUDGET_NOW_EPOCH: String(NOW),
      BUDGET_CWD_OVERRIDE: dir,
    };
    withEnv(env, () => shouldFire('claude', 85, 'five_hour', NOW + 3600, 80));
    const other = withEnv(env, () => shouldFire('claude', 85, 'seven_day', NOW + 3600, 80));
    assert.equal(other, true, 'different bucketId → new fp → fires');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── isCheckpointWrite ────────────────────────────────────────────────────────

test('isCheckpointWrite: exact match on file_path → true', () => {
  const dir = tempDir();
  const cp = join(dir, 'checkpoint.md');
  const input = {
    tool_input: { file_path: cp },
  };
  assert.equal(isCheckpointWrite(input, 'claude', cp), true);
  rmSync(dir, { recursive: true, force: true });
});

test('isCheckpointWrite: non-checkpoint file in same dir → false', () => {
  const dir = tempDir();
  const cp = join(dir, 'checkpoint.md');
  const other = join(dir, 'notes.md');
  const input = { tool_input: { file_path: other } };
  assert.equal(isCheckpointWrite(input, 'claude', cp), false);
  rmSync(dir, { recursive: true, force: true });
});

test('isCheckpointWrite: symlink to checkpoint → false (symlink bypass denied)', () => {
  const dir = tempDir();
  const cp = join(dir, 'checkpoint.md');
  const sym = join(dir, 'sym.md');
  // Create a real file then symlink to it
  writeFileSync(cp, '# checkpoint');
  symlinkSync(cp, sym);
  const input = { tool_input: { file_path: sym } };
  // sym points to cp but is itself a symlink → must be denied
  assert.equal(isCheckpointWrite(input, 'claude', cp), false,
    'symlink pointing at checkpoint must be denied');
  rmSync(dir, { recursive: true, force: true });
});

test('isCheckpointWrite: ANCESTOR-dir symlink under cwd → false (ancestor bypass denied)', () => {
  // Reproduce the ancestor-symlink bypass: a project-local dir component is a
  // symlink pointing elsewhere. A write that string-matches the checkpoint
  // would land in the symlink target. Must be denied. Boundary walk must catch
  // this because the symlink is BELOW cwd (agent-plantable).
  const prevCwd = process.cwd();
  const dir = tempDir();
  try {
    process.chdir(dir);
    mkdirSync(join(dir, 'evil'));
    symlinkSync(join(dir, 'evil'), join(dir, '.agent')); // .agent → evil (in cwd)
    const input = { tool_input: { file_path: '.agent/checkpoint.md' } };
    assert.equal(isCheckpointWrite(input, 'claude', '.agent/checkpoint.md'), false,
      'ancestor symlink within cwd must be denied');
  } finally {
    process.chdir(prevCwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isCheckpointWrite: benign system symlink ancestor (tmpdir under /var) → true (no false-positive)', () => {
  // tempDir() lives under /var/folders/... on macOS where /var → /private/var
  // is a benign system symlink ABOVE cwd. The boundary walk must NOT treat it
  // as an attack, otherwise every real checkpoint write is wrongly denied.
  const prevCwd = process.cwd();
  const dir = tempDir();
  try {
    process.chdir(dir);
    mkdirSync(join(dir, '.agent'));
    const input = { tool_input: { file_path: '.agent/checkpoint.md' } };
    assert.equal(isCheckpointWrite(input, 'claude', '.agent/checkpoint.md'), true,
      'benign system symlink above cwd must not cause a false deny');
  } finally {
    process.chdir(prevCwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isCheckpointWrite: apply_patch Add File → true', () => {
  const dir = tempDir();
  const cp = join(dir, 'checkpoint.md');
  const patch = `*** Begin Patch\n*** Add File: ${cp}\n+content\n*** End Patch`;
  const input = { tool_input: { patch } };
  assert.equal(isCheckpointWrite(input, 'codex', cp), true);
  rmSync(dir, { recursive: true, force: true });
});

test('isCheckpointWrite: apply_patch Update File → true', () => {
  const dir = tempDir();
  const cp = join(dir, 'checkpoint.md');
  const patch = `*** Begin Patch\n*** Update File: ${cp}\n@@\n-old\n+new\n*** End Patch`;
  const input = { tool_input: { patch } };
  assert.equal(isCheckpointWrite(input, 'codex', cp), true);
  rmSync(dir, { recursive: true, force: true });
});

test('isCheckpointWrite: apply_patch Delete File checkpoint → FALSE (delete erases recovery artifact)', () => {
  const dir = tempDir();
  const cp = join(dir, 'checkpoint.md');
  const patch = `*** Begin Patch\n*** Delete File: ${cp}\n*** End Patch`;
  const input = { tool_input: { patch } };
  // Hard line permits only WRITING the checkpoint; deleting it (even itself)
  // is denied — it would erase the artifact the hard line exists to preserve.
  assert.equal(isCheckpointWrite(input, 'codex', cp), false);
  rmSync(dir, { recursive: true, force: true });
});

test('isCheckpointWrite: delete-capable tool (path=checkpoint) → FALSE (cannot erase checkpoint at hard line)', () => {
  const dir = tempDir();
  const cp = join(dir, 'checkpoint.md');
  // An MCP/extension tool whose tool_input is just { path } must NOT be
  // allowed to write/erase the checkpoint when its name signals a delete.
  assert.equal(isCheckpointWrite({ tool_name: 'Delete', tool_input: { path: cp } }, 'codex', cp), false);
  assert.equal(isCheckpointWrite({ tool_name: 'fs_remove', tool_input: { path: cp } }, 'codex', cp), false);
  assert.equal(isCheckpointWrite({ tool_name: 'unlink_file', tool_input: { path: cp } }, 'codex', cp), false);
  // a genuine write tool, and the no-tool_name backward-compat case, still pass
  assert.equal(isCheckpointWrite({ tool_name: 'Write', tool_input: { file_path: cp } }, 'claude', cp), true);
  assert.equal(isCheckpointWrite({ tool_name: 'MultiEdit', tool_input: { file_path: cp } }, 'claude', cp), true);
  assert.equal(isCheckpointWrite({ tool_input: { file_path: cp } }, 'claude', cp), true);
  rmSync(dir, { recursive: true, force: true });
});

test('isCheckpointWrite: destructive tool-name detection (snake + camelCase) without benign false-positives', () => {
  const cp = '/tmp/some-proj/.agent/checkpoint.md';
  const deny = (name) =>
    isCheckpointWrite({ tool_name: name, tool_input: { path: cp } }, 'codex', cp);
  // destructive names → must deny (cannot erase checkpoint at hard line)
  for (const n of ['Delete', 'fs_remove', 'unlink_file', 'deleteFile', 'fsDelete',
    'removeFile', 'DeleteFile', 'deleteResource', 'mcp__fs__delete', 'rm', 'rmdir',
    'trash_item', 'destroyAll']) {
    assert.equal(deny(n), false, `destructive name must deny: ${n}`);
  }
  // benign names that merely CONTAIN a verb substring → must NOT false-deny.
  // (These can't actually write — cp path won't match cwd in this test — but
  // the point is they must not be rejected by the destructive-name guard;
  // they fall through to the normal path-matching logic.)
  for (const n of ['format', 'confirm', 'transform', 'reformat', 'undelete',
    'redmine', 'model', 'delta', 'form_render', 'preformatter']) {
    // benign name + non-matching path → false via path mismatch, NOT via guard.
    // Use the actual checkpoint path so a non-destructive name would pass the
    // guard; we assert it is NOT short-circuited as destructive by checking a
    // matching write IS allowed for these names.
    assert.equal(
      isCheckpointWrite({ tool_name: n, tool_input: { file_path: cp } }, 'codex', cp),
      true,
      `benign name must not be treated as destructive: ${n}`,
    );
  }
});

test('isCheckpointWrite: apply_patch filename with spaces does NOT bypass (rest-of-line capture)', () => {
  const dir = tempDir();
  const cp = join(dir, 'checkpoint.md');
  // Codex treats the rest of the line as the filename, so this patch targets
  // "<cp> evil", NOT <cp>. A \S+ capture would wrongly match <cp> and allow.
  const patch = `*** Begin Patch\n*** Update File: ${cp} evil\n*** End Patch`;
  const input = { tool_input: { patch } };
  assert.equal(isCheckpointWrite(input, 'codex', cp), false,
    'filename-with-spaces must not be truncated to match the checkpoint');
  rmSync(dir, { recursive: true, force: true });
});

test('isCheckpointWrite: apply_patch Move to checkpoint (pure) → true', () => {
  const dir = tempDir();
  const cp = join(dir, 'checkpoint.md');
  // A patch that ONLY touches the checkpoint (move the checkpoint to itself,
  // degenerate but the point is no other path is touched) → allowed.
  const patch = `*** Begin Patch\n*** Update File: ${cp}\n*** Move to: ${cp}\n*** End Patch`;
  const input = { tool_input: { patch } };
  assert.equal(isCheckpointWrite(input, 'codex', cp), true);
  rmSync(dir, { recursive: true, force: true });
});

test('isCheckpointWrite: apply_patch Update other + Move to checkpoint → FALSE (touches non-checkpoint)', () => {
  const dir = tempDir();
  const cp = join(dir, 'checkpoint.md');
  // Update /some/other.md AND move it onto the checkpoint: this WRITES a
  // non-checkpoint path under the hard line, so it must be denied even though
  // one of the touched paths is the checkpoint. (Security: all-must-match.)
  const patch = `*** Begin Patch\n*** Update File: /some/other.md\n*** Move to: ${cp}\n*** End Patch`;
  const input = { tool_input: { patch } };
  assert.equal(isCheckpointWrite(input, 'codex', cp), false);
  rmSync(dir, { recursive: true, force: true });
});

test('isCheckpointWrite: .bak path → false', () => {
  const dir = tempDir();
  const cp = join(dir, 'checkpoint.md');
  const bak = join(dir, 'checkpoint.md.bak');
  const input = { tool_input: { file_path: bak } };
  assert.equal(isCheckpointWrite(input, 'claude', cp), false);
  rmSync(dir, { recursive: true, force: true });
});

test('isCheckpointWrite: path field (codex alternative) → true', () => {
  const dir = tempDir();
  const cp = join(dir, 'checkpoint.md');
  const input = { tool_input: { path: cp } };
  assert.equal(isCheckpointWrite(input, 'codex', cp), true);
  rmSync(dir, { recursive: true, force: true });
});

test('isCheckpointWrite: null input → false', () => {
  assert.equal(isCheckpointWrite(null, 'claude', '/tmp/checkpoint.md'), false);
});

test('isCheckpointWrite: missing tool_input → false', () => {
  assert.equal(isCheckpointWrite({}, 'claude', '/tmp/checkpoint.md'), false);
});

test('isCheckpointWrite: empty checkpointPath → false', () => {
  const input = { tool_input: { file_path: '/tmp/checkpoint.md' } };
  assert.equal(isCheckpointWrite(input, 'claude', ''), false);
});

// ─── threshold boundary tests via phasePost ────────────────────────────────────
// phasePost reads util from fetchUsage. We supply a fixture via BUDGET_USAGE_FIXTURE
// and override thresholds to test each tier boundary.
//
// claude-usage.json: seven_day_sonnet=94 is highest resettable (util),
//   warn_util is also 94 because it's the highest util-bearing bucket.
// We need fixtures at different util levels, so we build them in tempDir.

function makeClaudeFixture(dir, util) {
  const future = NOW + 3600;
  // resets_at in ISO format so isoToEpoch gives a value > NOW
  const resetsAt = new Date(future * 1000).toISOString();
  const obj = {
    five_hour: { utilization: util, resets_at: resetsAt },
  };
  const path = join(dir, `claude-util-${util}.json`);
  writeFileSync(path, JSON.stringify(obj));
  return path;
}

const TH = { warnOnce: 80, warnRepeat: 90, hard: 92 };

test('phasePost: util=79 → no message (below T1)', async () => {
  const dir = tempDir();
  try {
    const fx = makeClaudeFixture(dir, 79);
    const result = await withEnvAsync(
      {
        BUDGET_STATE_DIR: dir,
        BUDGET_USAGE_FIXTURE: fx,
        BUDGET_NOW_EPOCH: String(NOW),
        BUDGET_CWD_OVERRIDE: dir,
      },
      () => phasePost('claude', {}, TH),
    );
    assert.equal(result, null, 'util=79 < warnOnce=80, should be silent');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('phasePost: util=80 → T1 message fires once', async () => {
  const dir = tempDir();
  try {
    const fx = makeClaudeFixture(dir, 80);
    const result = await withEnvAsync(
      {
        BUDGET_STATE_DIR: dir,
        BUDGET_USAGE_FIXTURE: fx,
        BUDGET_NOW_EPOCH: String(NOW),
        BUDGET_CWD_OVERRIDE: dir,
      },
      () => phasePost('claude', {}, TH),
    );
    assert.notEqual(result, null, 'util=80 >= warnOnce=80, T1 should fire');
    const msg = JSON.stringify(result);
    // T1 is once-per-window — should mention warnOnce threshold
    assert.ok(msg.includes('80'), `Expected 80 in message: ${msg}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('phasePost: util=89 → T1 zone (still fires once per window)', async () => {
  const dir = tempDir();
  try {
    const fx = makeClaudeFixture(dir, 89);
    const result = await withEnvAsync(
      {
        BUDGET_STATE_DIR: dir,
        BUDGET_USAGE_FIXTURE: fx,
        BUDGET_NOW_EPOCH: String(NOW),
        BUDGET_CWD_OVERRIDE: dir,
      },
      () => phasePost('claude', {}, TH),
    );
    assert.notEqual(result, null, 'util=89 in T1 zone, should fire once');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('phasePost: util=90 → T2 message (fires every call)', async () => {
  const dir = tempDir();
  try {
    const fx = makeClaudeFixture(dir, 90);
    const env = {
      BUDGET_STATE_DIR: dir,
      BUDGET_USAGE_FIXTURE: fx,
      BUDGET_NOW_EPOCH: String(NOW),
      BUDGET_CWD_OVERRIDE: dir,
    };
    const r1 = await withEnvAsync(env, () => phasePost('claude', {}, TH));
    const r2 = await withEnvAsync(env, () => phasePost('claude', {}, TH));
    assert.notEqual(r1, null, 'T2 fires first time');
    assert.notEqual(r2, null, 'T2 fires every call (no fingerprint gate)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('phasePost: util=91 → T2 zone', async () => {
  const dir = tempDir();
  try {
    const fx = makeClaudeFixture(dir, 91);
    const result = await withEnvAsync(
      {
        BUDGET_STATE_DIR: dir,
        BUDGET_USAGE_FIXTURE: fx,
        BUDGET_NOW_EPOCH: String(NOW),
        BUDGET_CWD_OVERRIDE: dir,
      },
      () => phasePost('claude', {}, TH),
    );
    assert.notEqual(result, null, 'util=91 in T2 zone');
    const msg = JSON.stringify(result);
    // T2 mentions soft line / warnRepeat
    assert.ok(msg.includes('90') || msg.includes('91'), `T2 message should mention threshold/util: ${msg}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('phasePost: util=92 → T3 message fires once (fingerprint)', async () => {
  const dir = tempDir();
  try {
    const fx = makeClaudeFixture(dir, 92);
    const env = {
      BUDGET_STATE_DIR: dir,
      BUDGET_USAGE_FIXTURE: fx,
      BUDGET_NOW_EPOCH: String(NOW),
      BUDGET_CWD_OVERRIDE: dir,
    };
    const r1 = await withEnvAsync(env, () => phasePost('claude', {}, TH));
    assert.notEqual(r1, null, 'T3 fires on first crossing');
    const msg = JSON.stringify(r1);
    // T3 message mentions hard line
    assert.ok(msg.includes('92') || msg.includes('硬线'), `T3 message should mention hard: ${msg}`);

    // Second call same fp → fingerprint prevents double-fire
    const r2 = await withEnvAsync(env, () => phasePost('claude', {}, TH));
    assert.equal(r2, null, 'T3 fingerprint prevents second fire');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('phasePost: fail-open — fetchUsage returns ok:false → null output', async () => {
  const dir = tempDir();
  try {
    // Write a fixture that will produce schema_no_buckets (all null)
    const nullFixture = join(dir, 'null-fixture.json');
    writeFileSync(nullFixture, JSON.stringify({
      five_hour: null,
      seven_day: null,
    }));
    const result = await withEnvAsync(
      {
        BUDGET_STATE_DIR: dir,
        BUDGET_USAGE_FIXTURE: nullFixture,
        BUDGET_NOW_EPOCH: String(NOW),
        BUDGET_CWD_OVERRIDE: dir,
      },
      () => phasePost('claude', {}, TH),
    );
    // fetchUsage returns ok:false when schema_no_buckets → phasePost returns null (fail-open)
    assert.equal(result, null, 'fail-open: bad probe → null output, no throw');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── fingerprint: resetless self-aging re-arm (review round-4) ─────────────

test('shouldFire: resetless fp self-ages without pruneNotified (re-arms after BUDGET_FP_MAX_AGE)', () => {
  const dir = tempDir();
  try {
    const base = {
      BUDGET_STATE_DIR: dir,
      BUDGET_CWD_OVERRIDE: dir,
      BUDGET_FP_MAX_AGE: '10',
    };
    // resetEpoch=0 (non-resettable bucket), bucketId=''
    const a = withEnv({ ...base, BUDGET_NOW_EPOCH: '1000' }, () => shouldFire('claude', 95, '', 0, 92));
    const b = withEnv({ ...base, BUDGET_NOW_EPOCH: '1000' }, () => shouldFire('claude', 95, '', 0, 92));
    // 11s later > maxAge 10 → re-arm WITHOUT any pruneNotified call
    const c = withEnv({ ...base, BUDGET_NOW_EPOCH: '1011' }, () => shouldFire('claude', 95, '', 0, 92));
    assert.equal(a, true, 'first fire');
    assert.equal(b, false, 'dedup within window');
    assert.equal(c, true, 're-arm after max age');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shouldFire: resettable fp is NOT aged out (still deduped past max age, only reset re-arms)', () => {
  const dir = tempDir();
  try {
    const base = {
      BUDGET_STATE_DIR: dir,
      BUDGET_CWD_OVERRIDE: dir,
      BUDGET_FP_MAX_AGE: '10',
    };
    const a = withEnv({ ...base, BUDGET_NOW_EPOCH: '1000' }, () => shouldFire('claude', 95, 'five_hour', 5000, 92));
    // 11s later (past max age) but reset 5000 not reached → must STILL dedup
    const b = withEnv({ ...base, BUDGET_NOW_EPOCH: '1011' }, () => shouldFire('claude', 95, 'five_hour', 5000, 92));
    assert.equal(a, true);
    assert.equal(b, false, 'resettable fp must not age out by time, only by reset');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── phaseStop: hard-line + soft-line gate on warn_util (review round-4) ────
// A non-resettable bucket (no resets_at) yields util(hard_max)=0 but
// warn_util=high. phaseStop must gate on warn_util for BOTH the hard stop and
// the soft nudge, consistent with phasePost.

function makeNonResettableFixture(dir, util) {
  // bucket with utilization but NO resets_at → not resettable → util=0, warn_util=util
  const obj = { seven_day_opus: { utilization: util } };
  const path = join(dir, `claude-nonreset-${util}.json`);
  writeFileSync(path, JSON.stringify(obj));
  return path;
}

test('phaseStop: non-resettable warn_util>=hard → force stop (continue:false), gated on warn_util not hard_max', async () => {
  const dir = tempDir();
  try {
    const fx = makeNonResettableFixture(dir, 95); // util=0, warn_util=95
    const result = await withEnvAsync(
      { BUDGET_STATE_DIR: dir, BUDGET_USAGE_FIXTURE: fx, BUDGET_NOW_EPOCH: String(NOW), BUDGET_CWD_OVERRIDE: dir },
      () => phaseStop('claude', {}, TH),
    );
    assert.ok(result && result.continue === false, 'warn_util=95 >= hard=92 must force-stop even when hard_max(util)=0');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('phaseStop: soft band → codex systemMessage, claude silent (each with its own fixture format)', async () => {
  const dir = tempDir();
  try {
    // claude: a non-resettable bucket at 91 → util=0, warn_util=91. Soft band.
    // claude stays silent at Stop (systemMessage isn't surfaced there).
    const claudeFx = makeNonResettableFixture(dir, 91);
    const claudeRes = await withEnvAsync(
      { BUDGET_STATE_DIR: dir, BUDGET_USAGE_FIXTURE: claudeFx, BUDGET_NOW_EPOCH: String(NOW), BUDGET_CWD_OVERRIDE: dir },
      () => phaseStop('claude', {}, TH),
    );
    assert.equal(claudeRes, null, 'claude stays silent at Stop soft line');

    // codex: windows always carry reset_at, so util==warn_util. Build a codex
    // fixture in the soft band (used_percent=91) → codex emits systemMessage.
    const codexFx = join(dir, 'codex-soft.json');
    writeFileSync(codexFx, JSON.stringify({
      rate_limit: {
        primary_window: { used_percent: 91, reset_at: NOW + 3600, limit_window_seconds: 18000, reset_after_seconds: 3600 },
        secondary_window: { used_percent: 40, reset_at: NOW + 604800, limit_window_seconds: 604800, reset_after_seconds: 604800 },
      },
    }));
    const codexRes = await withEnvAsync(
      { BUDGET_STATE_DIR: join(dir, 's2'), BUDGET_USAGE_FIXTURE: codexFx, BUDGET_NOW_EPOCH: String(NOW), BUDGET_CWD_OVERRIDE: dir },
      () => phaseStop('codex', {}, TH),
    );
    assert.ok(codexRes && typeof codexRes.systemMessage === 'string',
      'codex soft line emits systemMessage');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('phaseStop: below soft → null', async () => {
  const dir = tempDir();
  try {
    const fx = makeNonResettableFixture(dir, 50);
    const result = await withEnvAsync(
      { BUDGET_STATE_DIR: dir, BUDGET_USAGE_FIXTURE: fx, BUDGET_NOW_EPOCH: String(NOW), BUDGET_CWD_OVERRIDE: dir },
      () => phaseStop('claude', {}, TH),
    );
    assert.equal(result, null, 'below soft → silent');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
