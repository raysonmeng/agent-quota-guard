import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import https from "node:https";
import { access, cp, mkdtemp, mkdir, readFile, writeFile, rm, symlink as fsSymlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { loadBudgetConfig } from "../lib/guard/config.mjs";
import { checkThresholds } from "../lib/probe/index.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(here, "..");

async function scratch() {
  const root = await mkdtemp(join(tmpdir(), "bgc-test-"));
  const state = join(root, "state");
  const deep = join(root, "proj", "sub", "deep");
  await mkdir(state, { recursive: true });
  await mkdir(deep, { recursive: true });
  return { root, state, proj: join(root, "proj"), deep };
}

async function withProcessEnv(overrides, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(overrides)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`node child timed out: ${args.join(" ")}`));
    }, options.timeout || 10_000);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
    child.stdin?.end();
  });
}

function runNode(args, options = {}) {
  return runCommand(process.execPath, args, options);
}

test("loads global + project, project overrides global, quotes stripped", async () => {
  const { root, state, proj, deep } = await scratch();
  await writeFile(join(state, "config"), [
    "# global defaults",
    "BUDGET_WARN_ONCE=70",
    "BUDGET_HARD=90",
    'BUDGET_CLAUDE_UA="continue from global"',
    "NOT_BUDGET_KEY=ignored",
    "malformed line without equals",
  ].join("\n") + "\n");
  await writeFile(join(proj, ".budget-guard.conf"), [
    "BUDGET_HARD=85",
    "BUDGET_WARN_REPEAT='88'",
  ].join("\n") + "\n");

  const env = { HOME: root, BUDGET_STATE_DIR: state };
  const res = loadBudgetConfig({ env, cwd: deep });

  assert.equal(env.BUDGET_WARN_ONCE, "70", "global value applied");
  assert.equal(env.BUDGET_WARN_REPEAT, "88", "project quoted value, quotes stripped");
  assert.equal(env.BUDGET_HARD, "85", "project overrides global");
  assert.equal(env.BUDGET_CLAUDE_UA, "continue from global", "quotes stripped, spaces kept");
  assert.equal(env.NOT_BUDGET_KEY, undefined, "non-BUDGET key never applied");
  assert.ok(res.applied.includes("BUDGET_HARD"));
  await rm(root, { recursive: true, force: true });
});

test("environment variable wins over both config files", async () => {
  const { root, state, proj, deep } = await scratch();
  await writeFile(join(state, "config"), "BUDGET_HARD=90\n");
  await writeFile(join(proj, ".budget-guard.conf"), "BUDGET_HARD=85\n");

  const env = { HOME: root, BUDGET_STATE_DIR: state, BUDGET_HARD: "88" };
  loadBudgetConfig({ env, cwd: deep });

  assert.equal(env.BUDGET_HARD, "88", "pre-set env value is not overwritten");
});

test("BUDGET_SOFT alias participates in config precedence", async () => {
  const { root, state, proj, deep } = await scratch();
  await writeFile(join(state, "config"), "BUDGET_WARN_REPEAT=90\n");
  await writeFile(join(proj, ".budget-guard.conf"), "BUDGET_SOFT=85\n");

  const projectEnv = { HOME: root, BUDGET_STATE_DIR: state, BUDGET_WARN_ONCE: "70", BUDGET_HARD: "92" };
  loadBudgetConfig({ env: projectEnv, cwd: deep });
  assert.equal(projectEnv.BUDGET_WARN_REPEAT, "85", "project BUDGET_SOFT overrides global BUDGET_WARN_REPEAT");
  assert.equal(checkThresholds(projectEnv).warnRepeat, 85);

  await writeFile(join(state, "config"), "BUDGET_WARN_REPEAT=90\n");
  const processEnv = { HOME: root, BUDGET_STATE_DIR: state, BUDGET_WARN_ONCE: "70", BUDGET_SOFT: "84", BUDGET_HARD: "92" };
  loadBudgetConfig({ env: processEnv, cwd: deep });
  assert.equal(processEnv.BUDGET_WARN_REPEAT, undefined, "config BUDGET_WARN_REPEAT must not override env BUDGET_SOFT");
  assert.equal(checkThresholds(processEnv).warnRepeat, 84);

  const bash = await runCommand("bash", ["-c", [
    ". \"$1\"",
    "load_budget_config",
    "printf '%s\\n' \"${BUDGET_WARN_REPEAT-}\" \"${BUDGET_SOFT-}\""
  ].join("; "), "bash", join(rootDir, "codex-budget-guard", "budget-config.sh")], {
    cwd: deep,
    env: {
      ...process.env,
      HOME: root,
      BUDGET_STATE_DIR: state,
      BUDGET_SOFT: "83"
    },
    timeout: 10_000
  });
  assert.equal(bash.code, 0, `bash loader should run, stderr=${bash.stderr}`);
  assert.equal(bash.stdout, "\n83\n", "Bash config BUDGET_WARN_REPEAT must not override env BUDGET_SOFT");
  await rm(root, { recursive: true, force: true });
});

test("no config files → nothing applied (pure defaults)", async () => {
  const { root, state, deep } = await scratch();
  const env = { HOME: root, BUDGET_STATE_DIR: state };
  const res = loadBudgetConfig({ env, cwd: deep });

  assert.equal(env.BUDGET_WARN_ONCE, undefined);
  assert.equal(env.BUDGET_HARD, undefined);
  assert.deepEqual(res.applied, []);
  assert.equal(res.global, null);
  assert.equal(res.project, null);
  await rm(root, { recursive: true, force: true });
});

test("Node entrypoints fail open when the config loader is absent", async () => {
  const { root, state } = await scratch();
  const deploy = join(root, "deploy");
  await mkdir(join(deploy, "bin"), { recursive: true });
  await cp(join(rootDir, "bin", "probe.mjs"), join(deploy, "bin", "probe.mjs"));
  await cp(join(rootDir, "bin", "guard.mjs"), join(deploy, "bin", "guard.mjs"));
  await cp(join(rootDir, "lib", "probe"), join(deploy, "lib", "probe"), { recursive: true });
  await cp(join(rootDir, "lib", "guard"), join(deploy, "lib", "guard"), { recursive: true });
  await rm(join(deploy, "lib", "guard", "config.mjs"));

  const probe = await runNode([join(deploy, "bin", "probe.mjs"), "claude", "probe", "--fixture", join(rootDir, "tests", "fixtures", "claude-usage.json")], {
    cwd: deploy,
    env: {
      ...process.env,
      HOME: root,
      BUDGET_STATE_DIR: state,
      BUDGET_NOW_EPOCH: "1748844000"
    },
    timeout: 10_000
  });
  assert.equal(probe.code, 0, `probe should run without config loader, stderr=${probe.stderr}`);
  assert.equal(JSON.parse(probe.stdout).ok, true);

  const guard = await runNode([join(deploy, "bin", "guard.mjs"), "claude", "pre"], {
    cwd: deploy,
    env: {
      ...process.env,
      HOME: root,
      BUDGET_STATE_DIR: state,
      BUDGET_NO_TOKEN_DISCOVERY: "1"
    },
    timeout: 10_000
  });
  assert.equal(guard.code, 0, `guard should fail open without config loader, stderr=${guard.stderr}`);
  assert.equal(guard.stdout, "");
  await rm(root, { recursive: true, force: true });
});

test("project config discovered by walking up from a nested cwd", async () => {
  const { root, state, proj, deep } = await scratch();
  await writeFile(join(proj, ".budget-guard.conf"), "BUDGET_WARN_ONCE=42\n");

  const env = { HOME: root, BUDGET_STATE_DIR: state };
  const res = loadBudgetConfig({ env, cwd: deep });

  assert.equal(env.BUDGET_WARN_ONCE, "42");
  assert.equal(res.project, join(proj, ".budget-guard.conf"));
  await rm(root, { recursive: true, force: true });
});

test("Node loader ignores non-regular project config paths", async () => {
  const { root, state, proj, deep } = await scratch();
  await fsSymlink("/dev/null", join(proj, ".budget-guard.conf"));

  const env = { HOME: root, BUDGET_STATE_DIR: state };
  const res = loadBudgetConfig({ env, cwd: deep });

  assert.equal(env.BUDGET_WARN_ONCE, undefined);
  assert.equal(res.project, null);
  await rm(root, { recursive: true, force: true });
});

test("malformed lines, comments, and blank lines are ignored safely", async () => {
  const { root, state, proj, deep } = await scratch();
  await writeFile(join(proj, ".budget-guard.conf"), [
    "",
    "   # indented comment",
    "BUDGET_CACHE_TTL = 10   ",        // spaces around = and trailing
    "PATH=/evil/path",                 // non-BUDGET key must be rejected
    "BUDGET BAD KEY=1",                // invalid key shape
    "=novalue",
    "BUDGET_HARD=88",
  ].join("\n") + "\n");

  const env = { HOME: root, BUDGET_STATE_DIR: state };
  loadBudgetConfig({ env, cwd: deep });

  assert.equal(env.BUDGET_CACHE_TTL, "10", "trimmed key/value applied");
  assert.equal(env.BUDGET_HARD, "88");
  assert.equal(env.PATH, undefined, "PATH must never be set from config");
  assert.equal(env["BUDGET BAD KEY"], undefined);
  await rm(root, { recursive: true, force: true });
});

test("config files ignore env-only executable credential and endpoint keys", async () => {
  const { root, state, proj, deep } = await scratch();
  await writeFile(join(proj, ".budget-guard.conf"), [
    "BUDGET_WARN_ONCE=44",
    "BUDGET_PROBE=/tmp/fake-probe",
    "BUDGET_CODEX_URL=https://attacker.invalid/api",
    "BUDGET_CLAUDE_TOKEN=secret-from-config",
    "BUDGET_USAGE_FIXTURE=/tmp/fake-fixture.json",
    "BUDGET_HTTP_MAX_TIME=999",
    "BUDGET_HTTP_MAX_BODY_BYTES=999999999",
    "BUDGET_WATCHDOG_ARM=1",
    "BUDGET_RESUME_PROMPT=repo-controlled unattended prompt",
    "BUDGET_RESUME_BELOW=100"
  ].join("\n") + "\n");

  const env = {
    HOME: root,
    BUDGET_STATE_DIR: state,
    BUDGET_PROBE: "/env/probe"
  };
  loadBudgetConfig({ env, cwd: deep });

  assert.equal(env.BUDGET_WARN_ONCE, "44", "safe tuning key still applies");
  assert.equal(env.BUDGET_PROBE, "/env/probe", "process env value remains available");
  assert.equal(env.BUDGET_CODEX_URL, undefined);
  assert.equal(env.BUDGET_CLAUDE_TOKEN, undefined);
  assert.equal(env.BUDGET_USAGE_FIXTURE, undefined);
  assert.equal(env.BUDGET_HTTP_MAX_TIME, undefined);
  assert.equal(env.BUDGET_HTTP_MAX_BODY_BYTES, undefined);
  assert.equal(env.BUDGET_WATCHDOG_ARM, undefined);
  assert.equal(env.BUDGET_RESUME_PROMPT, undefined);
  assert.equal(env.BUDGET_RESUME_BELOW, undefined);
  await rm(root, { recursive: true, force: true });
});

test("Bash loader ignores config-provided BUDGET_PROBE command path", async () => {
  const { root, state, proj, deep } = await scratch();
  const marker = join(root, "probe-ran");
  const fakeProbe = join(root, "fake-probe");
  await writeFile(fakeProbe, [
    "#!/usr/bin/env bash",
    `printf 'ran %s\\n' "$*" > ${JSON.stringify(marker)}`,
    "printf '{\"ok\":true,\"util\":1,\"reset_epoch\":0}\\n'"
  ].join("\n") + "\n", { mode: 0o755 });
  await writeFile(join(proj, ".budget-guard.conf"), `BUDGET_PROBE=${fakeProbe}\n`);

  const result = await runCommand("bash", [join(rootDir, "codex-budget-guard", "budget_guard.sh"), "codex", "post"], {
    cwd: deep,
    env: {
      ...process.env,
      HOME: root,
      BUDGET_STATE_DIR: state
    },
    timeout: 10_000
  });

  assert.equal(result.code, 0, `budget_guard should fail open, stderr=${result.stderr}`);
  await assert.rejects(() => access(marker), "config-provided BUDGET_PROBE must not execute");
  await rm(root, { recursive: true, force: true });
});

test("Bash guard falls back to default thresholds when config hard is out of range", async () => {
  const { root, state, proj, deep } = await scratch();
  const fakeProbe = join(root, "fake-probe");
  await writeFile(fakeProbe, [
    "#!/usr/bin/env bash",
    "printf '{\"ok\":true,\"util\":95,\"reset_epoch\":0}\\n'"
  ].join("\n") + "\n", { mode: 0o755 });
  await writeFile(join(proj, ".budget-guard.conf"), "BUDGET_HARD=101\n");

  const result = await runCommand("bash", [join(rootDir, "codex-budget-guard", "budget_guard.sh"), "codex", "pre"], {
    cwd: deep,
    env: {
      ...process.env,
      HOME: root,
      BUDGET_STATE_DIR: state,
      BUDGET_PROBE: fakeProbe
    },
    timeout: 10_000
  });

  assert.equal(result.code, 0, `budget_guard should fail open only on probe issues, stderr=${result.stderr}`);
  assert.match(result.stdout, /额度已达硬线\(95% ≥ 92%\)/);
  await rm(root, { recursive: true, force: true });
});

test("Bash guard hard-line message names the driving Codex usage window", async () => {
  const { root, state, deep } = await scratch();
  const fakeProbe = join(root, "fake-probe");
  await writeFile(fakeProbe, [
    "#!/usr/bin/env bash",
    "cat <<'JSON'",
    JSON.stringify({
      ok: true,
      agent: "codex",
      util: 100,
      hard_util: 100,
      warn_util: 100,
      bucket_id: "additional_rate_limits[GPT 5 Codex].secondary_window",
      reset_epoch: 1780488339,
      buckets: [
        { id: "rate_limit.primary_window", util: 77, reset_epoch: 1780488339, resettable: true },
        { id: "additional_rate_limits[GPT 5 Codex].secondary_window", util: 100, reset_epoch: 1780856526, resettable: true }
      ]
    }),
    "JSON"
  ].join("\n") + "\n", { mode: 0o755 });

  const result = await runCommand("bash", [join(rootDir, "codex-budget-guard", "budget_guard.sh"), "codex", "pre"], {
    cwd: deep,
    env: {
      ...process.env,
      HOME: root,
      BUDGET_STATE_DIR: state,
      BUDGET_PROBE: fakeProbe
    },
    timeout: 10_000
  });

  assert.equal(result.code, 0, `budget_guard should deny without crashing, stderr=${result.stderr}`);
  assert.match(result.stdout, /额度已达硬线\(100% ≥ 92%\)/);
  assert.match(result.stdout, /触发窗口:additional_rate_limits\[GPT_5_Codex\]\.secondary_window/);
  assert.match(result.stdout, /rate_limit\.primary_window=77%/);
  await rm(root, { recursive: true, force: true });
});

test("Bash probe falls back when config cache TTL is invalid", async () => {
  const { root, state, proj, deep } = await scratch();
  await writeFile(join(state, "probe_codex.json"), JSON.stringify({
    ok: true,
    agent: "codex",
    util: 12,
    hard_util: 12,
    reset_epoch: 0,
    fetched_at: 999,
    now_epoch: 999
  }) + "\n");
  await writeFile(join(proj, ".budget-guard.conf"), "BUDGET_CACHE_TTL=abc\n");

  const result = await runCommand("bash", [join(rootDir, "codex-budget-guard", "budget-probe"), "codex"], {
    cwd: deep,
    env: {
      ...process.env,
      HOME: root,
      BUDGET_STATE_DIR: state,
      BUDGET_NOW_EPOCH: "1000"
    },
    timeout: 10_000
  });

  assert.equal(result.code, 0, `budget-probe should use default TTL, stderr=${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.source, "cache");
  assert.equal(parsed.stale, false);
  await rm(root, { recursive: true, force: true });
});

test("Bash probe honors config-provided Claude user agent", async () => {
  const { root, state, proj, deep } = await scratch();
  const fakeBin = join(root, "bin");
  const capturedHeaders = join(root, "headers.txt");
  await mkdir(fakeBin, { recursive: true });
  await mkdir(join(root, ".claude"), { recursive: true });
  await writeFile(join(proj, ".budget-guard.conf"), "BUDGET_CLAUDE_UA=configured-from-file\n");
  await writeFile(
    join(root, ".claude", ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "test-token" } }) + "\n"
  );
  await writeFile(join(fakeBin, "security"), [
    "#!/usr/bin/env bash",
    "printf '%s\\n' '{\"claudeAiOauth\":{\"accessToken\":\"test-token\"}}'"
  ].join("\n") + "\n", { mode: 0o755 });
  await writeFile(join(fakeBin, "curl"), [
    "#!/usr/bin/env bash",
    "out=''",
    "hdr=''",
    "while [ \"$#\" -gt 0 ]; do",
    "  case \"$1\" in",
    "    -o) out=\"$2\"; shift 2 ;;",
    "    -D) hdr=\"$2\"; shift 2 ;;",
    "    -H) printf '%s\\n' \"$2\" >> \"$BUDGET_CAPTURE_HEADERS\"; shift 2 ;;",
    "    -w) shift 2 ;;",
    "    *) shift ;;",
    "  esac",
    "done",
    "printf '%s\\n' 'HTTP/1.1 200 OK' > \"$hdr\"",
    "printf '%s\\n' '{\"five_hour\":{\"utilization\":1,\"resets_at\":\"2026-06-02T07:00:00Z\"}}' > \"$out\"",
    "printf '200'"
  ].join("\n") + "\n", { mode: 0o755 });

  const result = await runCommand("bash", [join(rootDir, "codex-budget-guard", "budget-probe"), "claude"], {
    cwd: deep,
    env: {
      ...process.env,
      HOME: root,
      BUDGET_STATE_DIR: state,
      BUDGET_CAPTURE_HEADERS: capturedHeaders,
      BUDGET_NOW_EPOCH: "1748844000",
      PATH: `${fakeBin}:${process.env.PATH}`
    },
    timeout: 10_000
  });

  assert.equal(result.code, 0, `budget-probe should parse fake Claude usage, stderr=${result.stderr}`);
  assert.match(result.stdout, /"ok":true/);
  const headers = await readFile(capturedHeaders, "utf8");
  assert.match(headers, /^User-Agent: configured-from-file$/m);
  await rm(root, { recursive: true, force: true });
});

test("watchdog ignores config-provided resume prompt in dry-run command", async () => {
  const { root, state, proj, deep } = await scratch();
  const fakeProbe = join(root, "fake-probe");
  const pendingDir = join(state, "pending");
  await mkdir(pendingDir, { recursive: true });
  await writeFile(fakeProbe, [
    "#!/usr/bin/env bash",
    "printf '{\"ok\":true,\"util\":1,\"warn_util\":1,\"reset_epoch\":0}\\n'"
  ].join("\n") + "\n", { mode: 0o755 });
  await writeFile(join(pendingDir, "codex_sid123.json"), JSON.stringify({
    status: "paused",
    session_id: "sid123",
    cwd: deep
  }) + "\n");
  await writeFile(join(proj, ".budget-guard.conf"), [
    "BUDGET_RESUME_PROMPT=CONFIG_PROMPT_SHOULD_NOT_CONTROL_UNATTENDED_RESUME",
    "BUDGET_RESUME_BELOW=30"
  ].join("\n") + "\n");

  const result = await runCommand("bash", [join(rootDir, "codex-budget-guard", "watchdog.sh"), "codex"], {
    cwd: deep,
    env: {
      ...process.env,
      HOME: root,
      BUDGET_STATE_DIR: state,
      BUDGET_PROBE: fakeProbe
    },
    timeout: 10_000
  });

  assert.equal(result.code, 0, `watchdog should dry-run cleanly, stderr=${result.stderr}`);
  assert.match(result.stdout, /继续上次未完成的任务/, "default resume prompt should remain in command");
  assert.doesNotMatch(result.stdout, /CONFIG_PROMPT_SHOULD_NOT_CONTROL_UNATTENDED_RESUME/);
  await rm(root, { recursive: true, force: true });
});

test("watchdog ignores config-provided resume threshold", async () => {
  const { root, state, proj, deep } = await scratch();
  const fakeProbe = join(root, "fake-probe");
  const pendingDir = join(state, "pending");
  await mkdir(pendingDir, { recursive: true });
  await writeFile(fakeProbe, [
    "#!/usr/bin/env bash",
    "printf '{\"ok\":true,\"util\":95,\"warn_util\":95,\"reset_epoch\":0}\\n'"
  ].join("\n") + "\n", { mode: 0o755 });
  await writeFile(join(pendingDir, "codex_sid123.json"), JSON.stringify({
    status: "paused",
    session_id: "sid123",
    cwd: deep
  }) + "\n");
  await writeFile(join(proj, ".budget-guard.conf"), "BUDGET_RESUME_BELOW=100\n");

  const result = await runCommand("bash", [join(rootDir, "codex-budget-guard", "watchdog.sh"), "codex"], {
    cwd: deep,
    env: {
      ...process.env,
      HOME: root,
      BUDGET_STATE_DIR: state,
      BUDGET_PROBE: fakeProbe
    },
    timeout: 10_000
  });

  assert.equal(result.code, 0, `watchdog should dry-run cleanly, stderr=${result.stderr}`);
  assert.match(result.stdout, /未达续跑线\(<30%\),跳过/);
  assert.doesNotMatch(result.stdout, /准备.*续跑/s);
  await rm(root, { recursive: true, force: true });
});

test("project config lookup uses logical PWD when cwd is not explicitly passed", async () => {
  const root = await mkdtemp(join(tmpdir(), "bgc-symlink-test-"));
  const state = join(root, "state");
  const physicalProject = join(root, "actual", "project");
  const logicalRoot = join(root, "logical");
  await mkdir(join(physicalProject, "sub"), { recursive: true });
  await mkdir(logicalRoot, { recursive: true });
  await mkdir(state, { recursive: true });
  await fsSymlink(physicalProject, join(logicalRoot, "project"));
  await writeFile(join(logicalRoot, ".budget-guard.conf"), "BUDGET_WARN_ONCE=41\n");

  const env = {
    HOME: root,
    BUDGET_STATE_DIR: state,
    PWD: join(logicalRoot, "project", "sub")
  };
  loadBudgetConfig({ env });

  assert.equal(env.BUDGET_WARN_ONCE, "41");
  await rm(root, { recursive: true, force: true });
});

test("Claude probe user agent honors config loaded after module import", async () => {
  const { root, state, proj, deep } = await scratch();
  await writeFile(join(proj, ".budget-guard.conf"), "BUDGET_CLAUDE_UA=configured-from-file\n");

  const originalRequest = https.request;
  let seenHeaders = null;
  https.request = (_url, opts) => {
    seenHeaders = opts.headers;
    const req = new EventEmitter();
    req.end = () => process.nextTick(() => req.emit("error", new Error("blocked")));
    req.destroy = () => {};
    return req;
  };

  try {
    await withProcessEnv({
      HOME: root,
      BUDGET_STATE_DIR: state,
      BUDGET_CLAUDE_TOKEN: "test-token",
      BUDGET_CLAUDE_UA: undefined
    }, async () => {
      const mod = await import(`../lib/probe/claude.mjs?ua-after-config=${Date.now()}`);
      loadBudgetConfig({ cwd: deep });
      await mod.fetch();
    });
  } finally {
    https.request = originalRequest;
    await rm(root, { recursive: true, force: true });
  }

  assert.equal(seenHeaders?.["User-Agent"], "configured-from-file");
});

test("guard CLI argv agent and phase are not overridden by config files", async () => {
  const { root, state, proj, deep } = await scratch();
  await writeFile(join(proj, ".budget-guard.conf"), [
    "BUDGET_AGENT=codex",
    "BUDGET_PHASE=doctor"
  ].join("\n") + "\n");

  const result = await runNode([join(rootDir, "bin", "guard.mjs"), "claude", "pre"], {
    cwd: deep,
    env: {
      ...process.env,
      HOME: root,
      BUDGET_STATE_DIR: state,
      BUDGET_NO_TOKEN_DISCOVERY: "1"
    },
    timeout: 10_000
  });

  assert.equal(result.code, 0, `guard should run argv phase, stdout=${result.stdout || ""}`);
  assert.equal(result.stdout, "");
  await rm(root, { recursive: true, force: true });
});
