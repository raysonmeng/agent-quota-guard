import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const watchdog = resolve(root, "claude-budget-guard", "watchdog.sh");

async function makeProject(prefix = "budget-project-") {
  const dir = await mkdtemp(resolve(tmpdir(), prefix));
  await mkdir(resolve(dir, ".agent"), { recursive: true });
  await writeFile(resolve(dir, ".agent", "checkpoint.md"), "# Checkpoint\n## 下一步: continue\n");
  return dir;
}

async function makeProbe(json) {
  const dir = await mkdtemp(resolve(tmpdir(), "budget-probe-"));
  const probe = resolve(dir, "budget-probe");
  await writeFile(probe, `#!/usr/bin/env bash\nprintf '%s\\n' '${JSON.stringify(json)}'\n`, { mode: 0o755 });
  return probe;
}

async function runWatchdog(stateDir, probe) {
  const { stdout } = await execFileAsync("bash", [watchdog, "claude"], {
    env: {
      ...process.env,
      BUDGET_STATE_DIR: stateDir,
      BUDGET_PROBE: probe,
      BUDGET_RESUME_BELOW: "30",
      BUDGET_WATCHDOG_ARM: "0"
    }
  });
  return stdout;
}

test("watchdog gates resume on warn_util, not resettable util", async () => {
  const stateDir = await mkdtemp(resolve(tmpdir(), "budget-state-"));
  const pendingDir = resolve(stateDir, "pending");
  const cwd = await makeProject();
  await mkdir(pendingDir, { recursive: true });
  await writeFile(resolve(pendingDir, "claude_scope.json"), JSON.stringify({
    status: "paused",
    agent: "claude",
    session_id: "s-warn",
    cwd,
    util: 95,
    warn_util: 95
  }));
  const probe = await makeProbe({
    ok: true,
    agent: "claude",
    util: 20,
    warn_util: 95,
    reset_epoch: 2000,
    now_epoch: 1000
  });

  const stdout = await runWatchdog(stateDir, probe);

  assert.match(stdout, /用量 95%,未达续跑线/);
  assert.doesNotMatch(stdout, /已刷新/);
});

test("watchdog does not resume both scoped and matching legacy pending files", async () => {
  const stateDir = await mkdtemp(resolve(tmpdir(), "budget-state-"));
  const pendingDir = resolve(stateDir, "pending");
  const cwd = await makeProject();
  await mkdir(pendingDir, { recursive: true });
  const pending = {
    status: "paused",
    agent: "claude",
    session_id: "same-session",
    cwd,
    util: 95,
    warn_util: 95
  };
  await writeFile(resolve(pendingDir, "claude_scope.json"), JSON.stringify(pending));
  await writeFile(resolve(stateDir, "pending_claude.json"), JSON.stringify(pending));
  const probe = await makeProbe({
    ok: true,
    agent: "claude",
    util: 10,
    warn_util: 10,
    reset_epoch: 2000,
    now_epoch: 1000
  });

  const stdout = await runWatchdog(stateDir, probe);
  const resumes = stdout.match(/same-session/g) || [];

  assert.equal(resumes.length, 1);
});
