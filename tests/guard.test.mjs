/**
 * Unit tests for lib/guard/fingerprint.mjs and lib/guard/checkpoint.mjs
 * Coverage: shouldFire (fingerprint dedup), isCheckpointWrite (allowlist),
 *           three-tier threshold boundaries via phasePost.
 *
 * Run: node --test tests/guard.test.mjs
 */

import assert from 'node:assert/strict';
import {
  existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { shouldFire } from '../lib/guard/fingerprint.mjs';
import { isCheckpointWrite } from '../lib/guard/checkpoint.mjs';
import * as hook from '../lib/guard/hook.mjs';
import { writeCache } from '../lib/probe/index.mjs';

const { phasePost, phasePre, phaseStop } = hook;

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
const TH_V32 = { warnOnce: 80, warnRepeat: 90, checkpointLead: 95, hard: 99 };

function readSinglePending(dir, agent = 'claude') {
  const pendingFiles = readdirSync(join(dir, 'pending')).filter((f) => new RegExp(`^${agent}_.*\\.json$`).test(f));
  assert.equal(pendingFiles.length, 1, 'scoped pending file written');
  const scoped = JSON.parse(readFileSync(join(dir, 'pending', pendingFiles[0]), 'utf8'));
  const legacy = JSON.parse(readFileSync(join(dir, `pending_${agent}.json`), 'utf8'));
  assert.deepEqual(legacy, scoped, 'legacy pending mirrors scoped pending');
  return scoped;
}

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
    assert.match(msg, /硬线 92%/, `T3 message should mention hard threshold percent: ${msg}`);

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

test('phasePre: hard reminder names the driving Codex usage window without denying', async () => {
  const dir = tempDir();
  try {
    const codexFx = join(dir, 'codex-primary-hard.json');
    writeFileSync(codexFx, JSON.stringify({
      rate_limit: {
        primary_window: { used_percent: 100, reset_at: NOW + 3600, limit_window_seconds: 18000, reset_after_seconds: 3600 },
        secondary_window: { used_percent: 71, reset_at: NOW + 604800, limit_window_seconds: 604800, reset_after_seconds: 604800 },
      },
      additional_rate_limits: [],
    }));
    const result = await withEnvAsync(
      { BUDGET_STATE_DIR: dir, BUDGET_USAGE_FIXTURE: codexFx, BUDGET_NOW_EPOCH: String(NOW), BUDGET_CWD_OVERRIDE: dir },
      () => phasePre('codex', { tool_name: 'Bash', tool_input: { command: 'true' } }, TH),
    );

    assert.equal(result?.hookSpecificOutput?.permissionDecision, undefined);
    assert.equal(result?.hookSpecificOutput?.permissionDecisionReason, undefined);
    const msg = result?.systemMessage || '';
    assert.match(msg, /额度 100%≥92% 硬线/);
    assert.match(msg, /触发窗口:rate_limit\.primary_window/);
    assert.match(msg, /rate_limit\.secondary_window=71%/);
    assert.match(msg, /不会强制拦截/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('phasePre: checkpoint lead reminder fires below the 99 hard fuse without denying', async () => {
  const dir = tempDir();
  try {
    const fx = makeClaudeFixture(dir, 95);
    const result = await withEnvAsync(
      { BUDGET_STATE_DIR: dir, BUDGET_USAGE_FIXTURE: fx, BUDGET_NOW_EPOCH: String(NOW), BUDGET_CWD_OVERRIDE: dir },
      () => phasePre('claude', { tool_name: 'Bash', tool_input: { command: 'true' } }, TH_V32),
    );

    assert.equal(result?.hookSpecificOutput?.permissionDecision, undefined);
    const msg = result?.hookSpecificOutput?.additionalContext || '';
    assert.match(msg, /checkpoint|收尾|进度写进/, 'lead reminder should explicitly ask for a checkpoint');
    assert.match(msg, /95%/, 'lead reminder names the checkpoint lead');
    assert.match(msg, /99%/, 'lead reminder keeps the hard fuse visible');
    assert.match(msg, /不会强制拦截/, 'PreToolUse remains advisory');
    assert.doesNotMatch(msg, /≥99% 硬线/, '95% lead must not pretend the 99% hard line has fired');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('phasePost: checkpoint lead warns before the 99 hard fuse without threatening Stop', async () => {
  const dir = tempDir();
  try {
    const fx = makeClaudeFixture(dir, 95);
    const result = await withEnvAsync(
      { BUDGET_STATE_DIR: dir, BUDGET_USAGE_FIXTURE: fx, BUDGET_NOW_EPOCH: String(NOW), BUDGET_CWD_OVERRIDE: dir },
      () => phasePost('claude', {}, TH_V32),
    );

    const msg = result?.hookSpecificOutput?.additionalContext || '';
    assert.match(msg, /95%/, 'lead warning names the lead threshold');
    assert.match(msg, /99%/, 'lead warning names the hard fuse');
    assert.match(msg, /checkpoint|进度写进/, 'lead warning asks for checkpoint');
    assert.doesNotMatch(msg, /Stop 钩子将强停/, 'below hard fuse must not claim Stop will force-stop');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('phasePre: provider rate-limit writes normal pending and remains advisory', async () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, 'ratelimit_codex.json'), JSON.stringify({
      rate_limited_until: NOW + 300,
      recorded_at: NOW,
      source: 'http_429',
    }));
    const result = await withEnvAsync(
      { BUDGET_STATE_DIR: dir, BUDGET_NOW_EPOCH: String(NOW), BUDGET_CWD_OVERRIDE: dir },
      () => phasePre('codex', { session_id: 's-rate-pre', tool_name: 'Bash', tool_input: { command: 'true' } }, TH_V32),
    );

    assert.equal(result?.hookSpecificOutput?.permissionDecision, undefined);
    assert.match(result?.systemMessage || '', /限流|rate/i);
    assert.match(result?.systemMessage || '', /checkpoint|续接|进度/);
    const pending = readSinglePending(dir, 'codex');
    assert.equal(pending.status, 'paused');
    assert.equal(pending.agent, 'codex');
    assert.equal(pending.session_id, 's-rate-pre');
    assert.equal(pending.cwd, dir);
    assert.equal(pending.reset_epoch, 0);
    assert.equal(pending.util, 0);
    assert.equal(pending.warn_util, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('phasePre: reminder 触发窗口 names the warn winner when a non-resettable bucket is the real max', async () => {
  const dir = tempDir();
  try {
    // primary=50 (resettable → hard winner); secondary=95 with NO reset_at
    // (non-resettable → not a hard winner, but the true max → warn winner).
    const codexFx = join(dir, 'codex-nonreset-max.json');
    writeFileSync(codexFx, JSON.stringify({
      rate_limit: {
        primary_window: { used_percent: 50, reset_at: NOW + 3600, limit_window_seconds: 18000, reset_after_seconds: 3600 },
        secondary_window: { used_percent: 95 },
      },
      additional_rate_limits: [],
    }));
    const result = await withEnvAsync(
      { BUDGET_STATE_DIR: dir, BUDGET_USAGE_FIXTURE: codexFx, BUDGET_NOW_EPOCH: String(NOW), BUDGET_CWD_OVERRIDE: dir },
      () => phasePre('codex', { tool_name: 'Bash', tool_input: { command: 'true' } }, TH),
    );
    assert.equal(result?.hookSpecificOutput?.permissionDecision, undefined);
    const msg = result?.systemMessage || '';
    // gating + label both follow warn_util=95 (the non-resettable real max)
    assert.match(msg, /额度 95%≥92% 硬线/);
    assert.match(msg, /触发窗口:rate_limit\.secondary_window/);
    // the resettable hard winner (primary=50) must NOT be labeled as the trigger
    assert.doesNotMatch(msg, /触发窗口:rate_limit\.primary_window/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('selectFinishingBucket: confident runway below horizon is a strong finish signal', () => {
  assert.equal(typeof hook.selectFinishingBucket, 'function');
  const result = hook.selectFinishingBucket({
    warn_bucket_id: 'five_hour',
    bucket_id: 'seven_day',
    buckets: [
      {
        id: 'five_hour',
        util: 80,
        burn_confident: true,
        burn_rate_pct_per_hour: 60,
        runway_seconds: 1200,
      },
      {
        id: 'seven_day',
        util: 80,
        burn_confident: true,
        burn_rate_pct_per_hour: 8,
        runway_seconds: 9000,
      },
    ],
  }, 1800);

  assert.equal(result.level, 'strong');
  assert.equal(result.bucket?.id, 'five_hour');
  assert.equal(result.runwaySeconds, 1200);
});

test('selectFinishingBucket: asymmetric burn — picks the fastest-filling bucket, not the warn winner', () => {
  // MEDIUM fix: the warn winner is purely the highest-util bucket (probe/claude.mjs
  // warnWinner ignores burn rate). Here the warn winner (seven_day, util 85) burns
  // slowly: genuine burn-to-full = (100-85)/5*3600 = 10800s = 3h. A *different*,
  // lower-util bucket (five_hour, util 70) burns fast: (100-70)/180*3600 = 600s =
  // 10min < horizon. selectFinishingBucket must walk ALL buckets and flag the
  // fastest-filling one as a strong finish signal, not just look at the warn winner.
  assert.equal(typeof hook.selectFinishingBucket, 'function');
  const result = hook.selectFinishingBucket({
    warn_bucket_id: 'seven_day',
    bucket_id: 'seven_day',
    buckets: [
      {
        id: 'five_hour',
        util: 70,
        burn_confident: true,
        burn_rate_pct_per_hour: 180,
        // genuine burn-to-full = (100-70)/180*3600 = 600s < 1800 horizon.
        runway_seconds: 600,
      },
      {
        id: 'seven_day',
        util: 85,
        burn_confident: true,
        burn_rate_pct_per_hour: 5,
        // genuine burn-to-full = (100-85)/5*3600 = 10800s = 3h (well above horizon).
        runway_seconds: 10800,
      },
    ],
  }, 1800);

  // Current impl only inspects the warn winner (seven_day, 10800s) → returns
  // soft on the slow bucket. Correct behavior: strong on the fast five_hour bucket.
  assert.equal(result.level, 'strong');
  assert.equal(result.bucket?.id, 'five_hour');
  assert.equal(result.runwaySeconds, 600);
});

test('selectFinishingBucket: confident runway at or above horizon is a soft finish signal', () => {
  assert.equal(typeof hook.selectFinishingBucket, 'function');
  const result = hook.selectFinishingBucket({
    warn_bucket_id: 'five_hour',
    buckets: [
      {
        id: 'five_hour',
        util: 90,
        burn_confident: true,
        burn_rate_pct_per_hour: 10,
        runway_seconds: 3600,
      },
    ],
  }, 1800);

  assert.equal(result.level, 'soft');
  assert.equal(result.runwaySeconds, 3600);
});

test('selectFinishingBucket: reset-bound capped runway below horizon does not become strong', () => {
  assert.equal(typeof hook.selectFinishingBucket, 'function');
  const result = hook.selectFinishingBucket({
    warn_bucket_id: 'five_hour',
    buckets: [
      {
        id: 'five_hour',
        util: 30,
        burn_confident: true,
        burn_rate_pct_per_hour: 0.5,
        // burn-rate truncates runway at reset, but true burn-to-full is 140h.
        runway_seconds: 600,
        depleted_at_epoch: NOW + 600,
        reset_epoch: NOW + 600,
      },
    ],
  }, 1800);

  assert.equal(result.level, 'static');
  assert.equal(result.runwaySeconds, null);
});

test('selectFinishingBucket: unconfident, missing runway, or empty buckets fall back to static', () => {
  assert.equal(typeof hook.selectFinishingBucket, 'function');

  assert.equal(hook.selectFinishingBucket({
    warn_bucket_id: 'five_hour',
    buckets: [{ id: 'five_hour', burn_confident: false, runway_seconds: 1200 }],
  }, 1800).level, 'static');

  assert.equal(hook.selectFinishingBucket({
    warn_bucket_id: 'five_hour',
    buckets: [{ id: 'five_hour', burn_confident: true }],
  }, 1800).level, 'static');

  assert.equal(hook.selectFinishingBucket({
    warn_bucket_id: 'five_hour',
    buckets: [{ id: 'five_hour', burn_confident: true, burn_rate_pct_per_hour: 120 }],
  }, 1800).level, 'static');

  assert.equal(hook.selectFinishingBucket({ warn_bucket_id: 'five_hour', buckets: [] }, 1800).level, 'static');
});

test('selectFinishingBucket: when warn winner and fastest-filling diverge, picks the soonest to fill', () => {
  // Both buckets are below the horizon (both are finish signals on their own),
  // but the warn winner (seven_day, util 95, the highest-util bucket) fills in
  // (100-95)/6*3600 = 3000s, while a lower-util bucket (five_hour, util 60)
  // fills sooner: (100-60)/180*3600 = 800s. The selector must report the
  // soonest-to-fill bucket (five_hour, 800s), not the warn winner.
  const result = hook.selectFinishingBucket({
    warn_bucket_id: 'seven_day',
    bucket_id: 'seven_day',
    buckets: [
      { id: 'seven_day', util: 95, burn_confident: true, burn_rate_pct_per_hour: 6, runway_seconds: 3000 },
      { id: 'five_hour', util: 60, burn_confident: true, burn_rate_pct_per_hour: 180, runway_seconds: 800 },
    ],
  }, 1800);

  assert.equal(result.level, 'strong');
  assert.equal(result.bucket?.id, 'five_hour');
  assert.equal(result.runwaySeconds, 800);
});

test('finishingHorizonSec: BUDGET_FINISHING_HORIZON env overrides the default only for unsigned integers', () => {
  assert.equal(typeof hook.finishingHorizonSec, 'function');

  assert.equal(withEnv({ BUDGET_FINISHING_HORIZON: undefined }, () => hook.finishingHorizonSec()), 1800);
  assert.equal(withEnv({ BUDGET_FINISHING_HORIZON: '900' }, () => hook.finishingHorizonSec()), 900);
  assert.equal(withEnv({ BUDGET_FINISHING_HORIZON: '15m' }, () => hook.finishingHorizonSec()), 1800);
});

test('phasePre: fail-open when usage is unavailable', async () => {
  const dir = tempDir();
  try {
    const nullFixture = join(dir, 'null-fixture.json');
    writeFileSync(nullFixture, JSON.stringify({
      five_hour: null,
      seven_day: null,
    }));
    const result = await withEnvAsync(
      { BUDGET_STATE_DIR: dir, BUDGET_USAGE_FIXTURE: nullFixture, BUDGET_NOW_EPOCH: String(NOW), BUDGET_CWD_OVERRIDE: dir },
      () => phasePre('claude', { tool_name: 'Bash', tool_input: { command: 'true' } }, TH),
    );
    assert.equal(result, null, 'phasePre fail-open: bad probe → null output, no throw');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('phasePre: confident runway below horizon triggers finishing reminder before hard line', async () => {
  const dir = tempDir();
  try {
    const raw = {
      five_hour: { utilization: 80, resets_at: new Date((NOW + 7200) * 1000).toISOString() },
    };
    const env = {
      BUDGET_STATE_DIR: dir,
      BUDGET_CACHE_TTL: '300',
      BUDGET_CWD_OVERRIDE: dir,
      BUDGET_NOW_EPOCH: String(NOW + 5),
      BUDGET_FINISHING_HORIZON: '1800',
      BUDGET_USAGE_FIXTURE: undefined,
      BUDGET_NO_TOKEN_DISCOVERY: '1',
    };
    const result = await withEnvAsync(env, async () => {
      assert.equal(writeCache('claude', { fetched_at: NOW, raw, cap_util: 80 }), true);
      writeFileSync(join(dir, 'burn_claude.json'), JSON.stringify({
        version: 1,
        buckets: {
          five_hour: {
            kind: 'short',
            samples: [],
            ewma: {
              rate_pct_per_hour: 120,
              updated_at: NOW,
              valid_samples: 6,
              first_valid_ts: NOW - 3600,
            },
          },
        },
      }));
      return phasePre('claude', { tool_name: 'Bash', tool_input: { command: 'true' } }, TH);
    });

    assert.equal(result?.hookSpecificOutput?.permissionDecision, undefined);
    const msg = result?.hookSpecificOutput?.additionalContext || '';
    assert.match(msg, /额度 80%\(硬线 92%\)/);
    assert.match(msg, /距打满 约 10 分钟/);
    assert.match(msg, /低于收尾窗口 约 30 分钟/);
    assert.doesNotMatch(msg, /80%≥92% 硬线/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('phasePre: reset-bound capped runway below horizon does not trigger early finishing reminder', async () => {
  const dir = tempDir();
  try {
    const raw = {
      five_hour: { utilization: 30, resets_at: new Date((NOW + 605) * 1000).toISOString() },
    };
    const env = {
      BUDGET_STATE_DIR: dir,
      BUDGET_CACHE_TTL: '300',
      BUDGET_CWD_OVERRIDE: dir,
      BUDGET_NOW_EPOCH: String(NOW + 5),
      BUDGET_FINISHING_HORIZON: '1800',
      BUDGET_USAGE_FIXTURE: undefined,
      BUDGET_NO_TOKEN_DISCOVERY: '1',
    };
    const result = await withEnvAsync(env, async () => {
      assert.equal(writeCache('claude', { fetched_at: NOW, raw, cap_util: 30 }), true);
      writeFileSync(join(dir, 'burn_claude.json'), JSON.stringify({
        version: 1,
        buckets: {
          five_hour: {
            kind: 'short',
            samples: [],
            ewma: {
              rate_pct_per_hour: 0.5,
              updated_at: NOW,
              valid_samples: 6,
              first_valid_ts: NOW - 3600,
            },
          },
        },
      }));
      return phasePre('claude', { tool_name: 'Bash', tool_input: { command: 'true' } }, TH);
    });

    assert.equal(result, null, 'reset-bound runway must not emit util<hard early finishing reminder');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('phasePre: hard-line reset-bound runway uses static reminder without burn-to-full wording', async () => {
  const dir = tempDir();
  try {
    const raw = {
      five_hour: { utilization: 95, resets_at: new Date((NOW + 605) * 1000).toISOString() },
    };
    const env = {
      BUDGET_STATE_DIR: dir,
      BUDGET_CACHE_TTL: '300',
      BUDGET_CWD_OVERRIDE: dir,
      BUDGET_NOW_EPOCH: String(NOW + 5),
      BUDGET_FINISHING_HORIZON: '1800',
      BUDGET_USAGE_FIXTURE: undefined,
      BUDGET_NO_TOKEN_DISCOVERY: '1',
    };
    const result = await withEnvAsync(env, async () => {
      assert.equal(writeCache('claude', { fetched_at: NOW, raw, cap_util: 95 }), true);
      writeFileSync(join(dir, 'burn_claude.json'), JSON.stringify({
        version: 1,
        buckets: {
          five_hour: {
            kind: 'short',
            samples: [],
            ewma: {
              rate_pct_per_hour: 0.5,
              updated_at: NOW,
              valid_samples: 6,
              first_valid_ts: NOW - 3600,
            },
          },
        },
      }));
      return phasePre('claude', { tool_name: 'Bash', tool_input: { command: 'true' } }, TH);
    });

    assert.equal(result?.hookSpecificOutput?.permissionDecision, undefined);
    const msg = result?.hookSpecificOutput?.additionalContext || '';
    assert.match(msg, /额度 95%≥92% 硬线/);
    assert.doesNotMatch(msg, /距打满/);
    assert.doesNotMatch(msg, /低于收尾窗口|高于收尾窗口/);
    assert.match(msg, /不会强制拦截/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('phasePre: strong finishing line names finishing.bucket (fast bucket), not the warn-winner headline bucket', async () => {
  // Cross-bucket consistency (LOW fix). Asymmetric burn:
  //   - seven_day util 85 (warn winner = highest util → headline %), slow burn
  //     (rate 5 → genuine burn-to-full (100-85)/5*3600 = 10800s = 3h ≫ horizon)
  //   - five_hour util 70 (lower util, NOT the warn winner), fast burn
  //     (rate 180 → genuine burn-to-full (100-70)/180*3600 = 600s = 10min < horizon)
  // selectFinishingBucket picks five_hour (soonest to fill) → strong. The headline
  // describes the warn state (85%, seven_day) but the "距打满" clause MUST be
  // attributed to five_hour(70%) — the bucket the 10-min figure was computed from —
  // otherwise the reader thinks seven_day fills in 10 minutes (it fills in 3h).
  const dir = tempDir();
  try {
    const raw = {
      seven_day: { utilization: 85, resets_at: new Date((NOW + 8 * 86400) * 1000).toISOString() },
      five_hour: { utilization: 70, resets_at: new Date((NOW + 7200) * 1000).toISOString() },
    };
    const env = {
      BUDGET_STATE_DIR: dir,
      BUDGET_CACHE_TTL: '300',
      BUDGET_CWD_OVERRIDE: dir,
      BUDGET_NOW_EPOCH: String(NOW + 5),
      BUDGET_FINISHING_HORIZON: '1800',
      BUDGET_USAGE_FIXTURE: undefined,
      BUDGET_NO_TOKEN_DISCOVERY: '1',
    };
    const result = await withEnvAsync(env, async () => {
      assert.equal(writeCache('claude', { fetched_at: NOW, raw, cap_util: 85 }), true);
      writeFileSync(join(dir, 'burn_claude.json'), JSON.stringify({
        version: 1,
        buckets: {
          five_hour: {
            kind: 'short',
            samples: [],
            ewma: {
              rate_pct_per_hour: 180, // fast → 600s burn-to-full
              updated_at: NOW,
              valid_samples: 6,
              first_valid_ts: NOW - 3600, // 1h span ≥ short min
            },
          },
          seven_day: {
            kind: 'long',
            samples: [],
            ewma: {
              rate_pct_per_hour: 5, // slow → 10800s burn-to-full
              updated_at: NOW,
              valid_samples: 6,
              first_valid_ts: NOW - 13 * 3600, // 13h span ≥ long min (12h)
            },
          },
        },
      }));
      return phasePre('claude', { tool_name: 'Bash', tool_input: { command: 'true' } }, TH);
    });

    assert.equal(result?.hookSpecificOutput?.permissionDecision, undefined);
    const msg = result?.hookSpecificOutput?.additionalContext || '';
    // headline: warn winner (seven_day, 85%) — still describes the warn state.
    assert.match(msg, /额度 85%\(硬线 92%\)/);
    assert.match(msg, /触发窗口:seven_day/);
    // strong level (below horizon) → 低于收尾窗口, with the 10-min runway.
    assert.match(msg, /低于收尾窗口 约 30 分钟/);
    assert.match(msg, /距打满 约 10 分钟/);
    // CRITICAL: the "距打满" clause is attributed to the fast finishing bucket
    // (five_hour, 70%), NOT the headline's seven_day. The fast bucket's id+util
    // appear immediately before the burn-to-full duration.
    assert.match(msg, /窗口 five_hour\(70%\)按当前消耗速度预计距打满 约 10 分钟/);
    // and the slow warn-winner bucket id must NOT be the one credited with the
    // 10-minute burn-to-full (it fills in 3h, not 10min).
    assert.doesNotMatch(msg, /窗口 seven_day[^，]*距打满/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('phasePre: genuine slow burn far below hard with no fast bucket → claude silent (soft never strong, no early line)', async () => {
  // RECOMMEND coverage ①: util 50 < hard 92, single slow bucket whose GENUINE
  // burn-to-full (uncapped by reset) is ≫ horizon. selectFinishingBucket returns
  // 'soft' (genuine burn-to-full ≥ horizon), and phasePre only emits below the
  // hard line when level === 'strong' — so soft + below-hard → null (静默).
  const dir = tempDir();
  try {
    const raw = {
      five_hour: { utilization: 50, resets_at: new Date((NOW + 86400) * 1000).toISOString() },
    };
    const env = {
      BUDGET_STATE_DIR: dir,
      BUDGET_CACHE_TTL: '300',
      BUDGET_CWD_OVERRIDE: dir,
      BUDGET_NOW_EPOCH: String(NOW + 5),
      BUDGET_FINISHING_HORIZON: '1800',
      BUDGET_USAGE_FIXTURE: undefined,
      BUDGET_NO_TOKEN_DISCOVERY: '1',
    };
    const result = await withEnvAsync(env, async () => {
      assert.equal(writeCache('claude', { fetched_at: NOW, raw, cap_util: 50 }), true);
      writeFileSync(join(dir, 'burn_claude.json'), JSON.stringify({
        version: 1,
        buckets: {
          five_hour: {
            kind: 'short',
            samples: [],
            ewma: {
              // (100-50)/2*3600 = 90000s = 25h ≫ 1800s horizon (genuine, and the
              // 24h reset does not truncate it below the horizon either).
              rate_pct_per_hour: 2,
              updated_at: NOW,
              valid_samples: 6,
              first_valid_ts: NOW - 3600,
            },
          },
        },
      }));
      return phasePre('claude', { tool_name: 'Bash', tool_input: { command: 'true' } }, TH);
    });

    assert.equal(result, null, 'below-hard soft finish (genuine slow burn) must stay silent');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('phasePre: codex early finishing (util<hard + strong) → systemMessage with 距打满, no permissionDecision', async () => {
  // RECOMMEND coverage ②: codex side, below the hard line but a fast bucket pushes
  // selectFinishingBucket to 'strong' (genuine burn-to-full < horizon). phasePre
  // must surface a codex systemMessage that names the finishing window and shows
  // 距打满, with NO permissionDecision / additionalContext (codex uses systemMessage).
  //
  // Codex fixtures are stateless (no burn enrichment), so drive the cache+burn-state
  // path: write a codex-shaped cache raw + burn_codex.json. The bucket id is the
  // codex-resolved name (rate_limit.primary_window).
  const dir = tempDir();
  try {
    const raw = {
      rate_limit: {
        primary_window: {
          used_percent: 70,
          reset_at: NOW + 7200,
          limit_window_seconds: 18000,
          reset_after_seconds: 7200,
        },
      },
      additional_rate_limits: [],
    };
    const env = {
      BUDGET_STATE_DIR: dir,
      BUDGET_CACHE_TTL: '300',
      BUDGET_CWD_OVERRIDE: dir,
      BUDGET_NOW_EPOCH: String(NOW + 5),
      BUDGET_FINISHING_HORIZON: '1800',
      BUDGET_USAGE_FIXTURE: undefined,
      BUDGET_NO_TOKEN_DISCOVERY: '1',
    };
    const result = await withEnvAsync(env, async () => {
      assert.equal(writeCache('codex', { fetched_at: NOW, raw, cap_util: 70 }), true);
      writeFileSync(join(dir, 'burn_codex.json'), JSON.stringify({
        version: 1,
        buckets: {
          'rate_limit.primary_window': {
            kind: 'short',
            samples: [],
            ewma: {
              rate_pct_per_hour: 180, // (100-70)/180*3600 = 600s < 1800 horizon
              updated_at: NOW,
              valid_samples: 6,
              first_valid_ts: NOW - 3600,
            },
          },
        },
      }));
      return phasePre('codex', { tool_name: 'Bash', tool_input: { command: 'true' } }, TH);
    });

    // codex output channel is systemMessage — never permissionDecision/additionalContext.
    assert.equal(result?.hookSpecificOutput, undefined);
    const msg = result?.systemMessage || '';
    assert.match(msg, /额度 70%\(硬线 92%\)/);
    assert.match(msg, /距打满 约 10 分钟/);
    assert.match(msg, /低于收尾窗口 约 30 分钟/);
    // the finishing clause names the codex-resolved window id + its util.
    assert.match(msg, /窗口 rate_limit\.primary_window\(70%\)按当前消耗速度预计距打满 约 10 分钟/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('phasePre: hard-line slow burn uses soft finishing reminder without denial', async () => {
  const dir = tempDir();
  try {
    const raw = {
      five_hour: { utilization: 95, resets_at: new Date((NOW + 86400) * 1000).toISOString() },
    };
    const env = {
      BUDGET_STATE_DIR: dir,
      BUDGET_CACHE_TTL: '300',
      BUDGET_CWD_OVERRIDE: dir,
      BUDGET_NOW_EPOCH: String(NOW + 5),
      BUDGET_FINISHING_HORIZON: '1800',
      BUDGET_USAGE_FIXTURE: undefined,
      BUDGET_NO_TOKEN_DISCOVERY: '1',
    };
    const result = await withEnvAsync(env, async () => {
      assert.equal(writeCache('claude', { fetched_at: NOW, raw, cap_util: 95 }), true);
      writeFileSync(join(dir, 'burn_claude.json'), JSON.stringify({
        version: 1,
        buckets: {
          five_hour: {
            kind: 'short',
            samples: [],
            ewma: {
              rate_pct_per_hour: 1,
              updated_at: NOW,
              valid_samples: 6,
              first_valid_ts: NOW - 3600,
            },
          },
        },
      }));
      return phasePre('claude', { tool_name: 'Bash', tool_input: { command: 'true' } }, TH);
    });

    assert.equal(result?.hookSpecificOutput?.permissionDecision, undefined);
    const msg = result?.hookSpecificOutput?.additionalContext || '';
    assert.match(msg, /高于收尾窗口/);
    assert.doesNotMatch(msg, /低于收尾窗口/);
    assert.match(msg, /不会强制拦截/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('phasePre: active manual skip suppresses the util<hard early finishing reminder', async () => {
  // Same fast-burn fixture as the "below horizon triggers finishing reminder"
  // case (util 80 < hard 92, rate 120 → genuine burn-to-full 600s < horizon →
  // strong). An active hard-line skip authorization must silence even the early
  // (below-hard) finishing line: skipRemaining>0 short-circuits phasePre to null.
  const dir = tempDir();
  try {
    const raw = {
      five_hour: { utilization: 80, resets_at: new Date((NOW + 7200) * 1000).toISOString() },
    };
    const env = {
      BUDGET_STATE_DIR: dir,
      BUDGET_CACHE_TTL: '300',
      BUDGET_CWD_OVERRIDE: dir,
      BUDGET_NOW_EPOCH: String(NOW + 5),
      BUDGET_FINISHING_HORIZON: '1800',
      BUDGET_SKIP_TTL: '1800',
      BUDGET_USAGE_FIXTURE: undefined,
      BUDGET_NO_TOKEN_DISCOVERY: '1',
    };
    const result = await withEnvAsync(env, async () => {
      assert.equal(writeCache('claude', { fetched_at: NOW, raw, cap_util: 80 }), true);
      writeFileSync(join(dir, 'burn_claude.json'), JSON.stringify({
        version: 1,
        buckets: {
          five_hour: {
            kind: 'short',
            samples: [],
            ewma: {
              rate_pct_per_hour: 120,
              updated_at: NOW,
              valid_samples: 6,
              first_valid_ts: NOW - 3600,
            },
          },
        },
      }));
      // Arm a real hard-line skip via the override phrase (same code path the
      // user takes), scoped to this cwd/state dir.
      const armed = await hook.phasePrompt('claude', { prompt: '/budget-skip' }, TH);
      assert.ok(armed?.hookSpecificOutput?.additionalContext?.includes('硬线手动跳过'));
      return phasePre('claude', { tool_name: 'Bash', tool_input: { command: 'true' } }, TH);
    });

    assert.equal(result, null, 'active skip must silence the early finishing reminder');
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
      () => phaseStop('claude', { session_id: 's-hard' }, TH),
    );
    assert.ok(result && result.continue === false, 'warn_util=95 >= hard=92 must force-stop even when hard_max(util)=0');
    const pendingFiles = readdirSync(join(dir, 'pending')).filter((f) => /^claude_.*\.json$/.test(f));
    assert.equal(pendingFiles.length, 1, 'scoped pending file written');
    assert.ok(existsSync(join(dir, 'pending_claude.json')), 'legacy pending file written');
    const scoped = JSON.parse(readFileSync(join(dir, 'pending', pendingFiles[0]), 'utf8'));
    const legacy = JSON.parse(readFileSync(join(dir, 'pending_claude.json'), 'utf8'));
    for (const pending of [scoped, legacy]) {
      assert.equal(pending.status, 'paused');
      assert.equal(pending.agent, 'claude');
      assert.equal(pending.session_id, 's-hard');
      assert.equal(pending.cwd, dir);
      assert.equal(pending.reset_epoch, 0);
      assert.equal(pending.util, 95);
      assert.equal(pending.warn_util, 95);
      assert.equal(typeof pending.at, 'number');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('phaseStop: checkpoint lead below the 99 hard fuse does not force-stop or write pending', async () => {
  const dir = tempDir();
  try {
    const fx = makeClaudeFixture(dir, 95);
    const claudeResult = await withEnvAsync(
      { BUDGET_STATE_DIR: dir, BUDGET_USAGE_FIXTURE: fx, BUDGET_NOW_EPOCH: String(NOW), BUDGET_CWD_OVERRIDE: dir },
      () => phaseStop('claude', { session_id: 's-lead' }, TH_V32),
    );
    assert.equal(claudeResult, null, 'claude stop stays silent at checkpoint lead');
    assert.equal(existsSync(join(dir, 'pending')), false, 'lead does not write pending');

    const codexFx = join(dir, 'codex-lead.json');
    writeFileSync(codexFx, JSON.stringify({
      rate_limit: {
        primary_window: { used_percent: 95, reset_at: NOW + 3600, limit_window_seconds: 18000, reset_after_seconds: 3600 },
        secondary_window: { used_percent: 40, reset_at: NOW + 604800, limit_window_seconds: 604800, reset_after_seconds: 604800 },
      },
      additional_rate_limits: [],
    }));
    const codexResult = await withEnvAsync(
      { BUDGET_STATE_DIR: join(dir, 'codex-state'), BUDGET_USAGE_FIXTURE: codexFx, BUDGET_NOW_EPOCH: String(NOW), BUDGET_CWD_OVERRIDE: dir },
      () => phaseStop('codex', { session_id: 's-lead' }, TH_V32),
    );
    assert.equal(codexResult?.continue, undefined, 'codex lead does not force-stop');
    assert.match(codexResult?.systemMessage || '', /95%/);
    assert.match(codexResult?.systemMessage || '', /checkpoint|收尾|进度/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('phaseStop: provider rate-limit writes normal pending and force-stops before fail-open return', async () => {
  const dir = tempDir();
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'ratelimit_claude.json'), JSON.stringify({
      rate_limited_until: NOW + 300,
      recorded_at: NOW,
      source: 'http_429',
    }));
    const result = await withEnvAsync(
      { BUDGET_STATE_DIR: dir, BUDGET_NOW_EPOCH: String(NOW), BUDGET_CWD_OVERRIDE: dir },
      () => phaseStop('claude', { session_id: 's-rate' }, TH_V32),
    );

    assert.ok(result && result.continue === false, 'rate-limit stop must force-stop cleanly');
    assert.match(result.stopReason || '', /限流|rate/i);
    const pending = readSinglePending(dir, 'claude');
    assert.equal(pending.status, 'paused');
    assert.equal(pending.agent, 'claude');
    assert.equal(pending.session_id, 's-rate');
    assert.equal(pending.cwd, dir);
    assert.equal(pending.reset_epoch, 0);
    assert.equal(pending.util, 0);
    assert.equal(pending.warn_util, 0);
    assert.equal(typeof pending.at, 'number');
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
