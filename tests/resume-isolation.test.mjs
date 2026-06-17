/**
 * Regression tests for phaseResume cross-project isolation.
 *
 * The SessionStart `resume` hook injects the last checkpoint. When the current
 * cwd has no checkpoint of its own it may fall back to the cwd recorded in the
 * most-recent pending file — but that fallback must be scoped to the SAME
 * project (same git repo, including worktrees). Opening an UNRELATED project
 * must never resume another project's checkpoint.
 */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(here, "..");
const guard = join(rootDir, "bin", "guard.mjs");
const FIXTURE = join(rootDir, "tests", "fixtures", "claude-usage.json");

function runResume(cwd, stateDir) {
  return new Promise((resolveP, reject) => {
    const child = spawn(process.execPath, [guard, "claude", "resume"], {
      cwd,
      env: {
        ...process.env,
        BUDGET_STATE_DIR: stateDir,
        BUDGET_USAGE_FIXTURE: FIXTURE,
        // Must be unset so the fallback path (resolvedBase = process.cwd()) runs.
        BUDGET_CWD_OVERRIDE: "",
      },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("guard resume timed out"));
    }, 10_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", () => { clearTimeout(timer); resolveP({ stdout, stderr }); });
    child.stdin.end();
  });
}

async function writeCheckpoint(dir, body) {
  await mkdir(join(dir, ".agent"), { recursive: true });
  await writeFile(join(dir, ".agent", "checkpoint.md"), body);
}

async function writePending(stateDir, cwd) {
  await mkdir(join(stateDir, "pending"), { recursive: true });
  const payload = JSON.stringify({ status: "paused", agent: "claude", cwd });
  await writeFile(join(stateDir, "pending", "claude_scope.json"), payload);
  await writeFile(join(stateDir, "pending_claude.json"), payload);
}

// Write one scoped pending file with an explicit mtime, so tests can control
// the newest-first ordering pendingCwds() relies on.
async function writeScopedPending(stateDir, scope, cwd, mtimeSec) {
  await mkdir(join(stateDir, "pending"), { recursive: true });
  const p = join(stateDir, "pending", `claude_${scope}.json`);
  await writeFile(p, JSON.stringify({ status: "paused", agent: "claude", cwd }));
  await utimes(p, mtimeSec, mtimeSec);
}

test("resume does NOT cross into an unrelated project's checkpoint", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "bg-state-"));
  // Project A hard-stopped last and left a checkpoint + pending pointing at it.
  const projA = await mkdtemp(join(tmpdir(), "bg-projA-"));
  await writeCheckpoint(projA, "# Checkpoint A\n## 下一步: 1) do A stuff\n");
  await writePending(stateDir, projA);
  // Project B is a different, unrelated project with no checkpoint of its own.
  const projB = await mkdtemp(join(tmpdir(), "bg-projB-"));

  const { stdout } = await runResume(projB, stateDir);

  assert.ok(
    !stdout.includes("续接"),
    `must not resume across unrelated projects, but injected: ${stdout}`,
  );
});

test("resume DOES follow the pending cwd within the same git repo (worktree/subdir)", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "bg-state-"));
  const repo = await mkdtemp(join(tmpdir(), "bg-repo-"));
  execFileSync("git", ["-C", repo, "init", "-q"], { stdio: "ignore" });
  await writeCheckpoint(repo, "# Checkpoint R\n## 下一步: 1) continue repo task\n");
  await writePending(stateDir, repo);
  // Current cwd is a subdir of the SAME repo, with no checkpoint of its own.
  const sub = join(repo, "sub", "deep");
  await mkdir(sub, { recursive: true });

  const { stdout } = await runResume(sub, stateDir);

  assert.ok(
    stdout.includes("续接"),
    `same-repo resume should still work, but got: ${stdout}`,
  );
  assert.ok(
    stdout.includes("continue repo task"),
    "should inject the same-repo checkpoint body",
  );
});

test("resume picks the same-project pending even when an unrelated project stopped more recently", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "bg-state-"));
  // Current project: a git repo with its own checkpoint, hard-stopped EARLIER.
  const repo = await mkdtemp(join(tmpdir(), "bg-repo-"));
  execFileSync("git", ["-C", repo, "init", "-q"], { stdio: "ignore" });
  await writeCheckpoint(repo, "# Checkpoint R\n## 下一步: 1) continue repo task\n");
  await writeScopedPending(stateDir, "repo", repo, 1_000_000);
  // An UNRELATED project hard-stopped MORE recently (newer mtime → first in order).
  const other = await mkdtemp(join(tmpdir(), "bg-other-"));
  await writeCheckpoint(other, "# Checkpoint OTHER\n## 下一步: 1) do unrelated work\n");
  await writeScopedPending(stateDir, "other", other, 2_000_000);
  // Current cwd: a subdir of repo with no checkpoint of its own.
  const sub = join(repo, "sub");
  await mkdir(sub, { recursive: true });

  const { stdout } = await runResume(sub, stateDir);

  assert.ok(stdout.includes("续接"), `same-project resume should still fire; got: ${stdout}`);
  assert.ok(stdout.includes("continue repo task"), "should resume the repo checkpoint, not the unrelated one");
  assert.ok(!stdout.includes("do unrelated work"), "must not resume the more-recent unrelated project");
});
