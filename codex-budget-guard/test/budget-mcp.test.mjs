import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const probe = resolve(root, "budget-probe");

async function readToml(path) {
  const { stdout } = await execFileAsync("python3", ["-c", [
    "import json, sys, tomllib",
    "with open(sys.argv[1], 'rb') as f:",
    "    data = tomllib.load(f)",
    "print(json.dumps(data))"
  ].join("\n"), path]);
  return JSON.parse(stdout);
}

test("budget-probe parses Codex wham usage and picks model weekly max", async () => {
  const fixture = resolve(root, "..", "tests", "fixtures", "codex-wham-usage.json");

  const { stdout } = await execFileAsync(probe, ["--agent", "codex"], {
    env: {
      ...process.env,
      BUDGET_USAGE_FIXTURE: fixture,
      BUDGET_NOW_EPOCH: "1760000900",
      BUDGET_STATE_DIR: await mkdtemp(resolve(tmpdir(), "budget-state-"))
    }
  });

  const parsed = JSON.parse(stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.util, 93);
  assert.equal(parsed.warn_util, 93);
  assert.equal(parsed.bucket_id, "additional_rate_limits[GPT-5.3-Codex-Spark].secondary_window");
  assert.equal(parsed.reset_epoch, 1760500100);
  assert.equal(parsed.buckets.length, 4);
});

test("budget-probe parses Claude model buckets and ignores extra_usage for hard max", async () => {
  const fixture = resolve(root, "..", "tests", "fixtures", "claude-usage.json");

  const { stdout } = await execFileAsync(probe, ["claude"], {
    env: {
      ...process.env,
      BUDGET_USAGE_FIXTURE: fixture,
      BUDGET_NOW_EPOCH: "1780369200",
      BUDGET_STATE_DIR: await mkdtemp(resolve(tmpdir(), "budget-state-"))
    }
  });

  const parsed = JSON.parse(stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.util, 94);
  assert.equal(parsed.bucket_id, "seven_day_sonnet");
  assert.equal(parsed.extra_usage.utilization, 99);
});

test("checkBudget invokes the configured probe and preserves normalized JSON", async () => {
  const { checkBudget } = await import("../mcp-tools.mjs");
  const dir = await mkdtemp(resolve(tmpdir(), "budget-probe-"));
  const fakeProbe = resolve(dir, "budget-probe");
  await writeFile(fakeProbe, "#!/usr/bin/env node\nconsole.log(JSON.stringify({ok:true,agent:process.argv.at(-1),util:55,warn_util:60,reset_epoch:2500,now_epoch:Number(process.env.BUDGET_NOW_EPOCH),source:'fake'}));\n", { mode: 0o755 });

  const result = await checkBudget({ agent: "claude" }, {
    env: { ...process.env, BUDGET_PROBE: fakeProbe, BUDGET_NOW_EPOCH: "1200" }
  });

  assert.equal(result.agent, "claude");
  assert.equal(result.util, 55);
  assert.equal(result.hard_util, 55);
  assert.equal(result.warn_util, 60);
  assert.equal(result.reset_epoch, 2500);
  assert.equal(result.now_epoch, 1200);
  assert.equal(result.source, "fake");
});

test("checkBudget returns probe failure JSON instead of throwing", async () => {
  const { checkBudget } = await import("../mcp-tools.mjs");
  const dir = await mkdtemp(resolve(tmpdir(), "budget-probe-fail-"));
  const fakeProbe = resolve(dir, "budget-probe");
  await writeFile(fakeProbe, "#!/usr/bin/env node\nconsole.log(JSON.stringify({ok:false,agent:'codex',error:'rate_limited',fetched_at:1300}));\nprocess.exit(2);\n", { mode: 0o755 });

  const result = await checkBudget({ agent: "codex" }, {
    env: { ...process.env, BUDGET_PROBE: fakeProbe }
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "rate_limited");
  assert.equal(result.agent, "codex");
});

test("findBudgetProbe only accepts configured env or canonical installed bin", async () => {
  const { findBudgetProbe } = await import("../mcp-tools.mjs");
  const home = await mkdtemp(resolve(tmpdir(), "budget-home-"));

  await assert.rejects(
    () => findBudgetProbe({ HOME: home }),
    /budget-probe not found/
  );
});

test("codex installer keeps budget-probe canonical instead of copying into MCP dir", async () => {
  const installer = await readFile(resolve(root, "install.sh"), "utf8");

  assert.match(installer, /cp "\$HERE\/budget-probe" "\$BIN\/"/);
  assert.doesNotMatch(installer, /cp "\$HERE\/budget-probe" "\$MCP_DIR\/"/);
});

test("codex installer writes config.toml hooks idempotently and uninstalls them", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "budget-install-home-"));
  const fakeBin = resolve(home, "fake-bin");
  await mkdir(fakeBin, { recursive: true });
  await writeFile(resolve(fakeBin, "npm"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });

  const codexDir = resolve(home, ".codex");
  await mkdir(codexDir, { recursive: true });
  const configPath = resolve(codexDir, "config.toml");
  await writeFile(configPath, [
    '[projects."/tmp/existing"]',
    'trust_level = "trusted"',
    "",
    "[hooks]",
    "",
    "[[hooks.PreToolUse]]",
    'matcher = "^Read$"',
    "",
    "[[hooks.PreToolUse.hooks]]",
    'type = "command"',
    'command = "/Users/example/budget-guard-dashboard/notify.sh"',
    "timeout = 9",
    "",
    "[[hooks.PostToolUse]]",
    'matcher = "^Read$"',
    "",
    "[[hooks.PostToolUse.hooks]]",
    'type = "command"',
    'command = "/home/me/my_budget_guard.sh check"',
    "timeout = 9",
    "",
    "[[hooks.Stop]]",
    "",
    "[[hooks.Stop.hooks]]",
    'type = "command"',
    'command = """',
    'printf "%s\\n" "mention budget_guard.sh in body"',
    'echo done',
    '"""',
    "timeout = 9",
    "",
    "[mcp_servers.other]",
    'command = "node"'
  ].join("\n") + "\n");
  const legacyHooksPath = resolve(codexDir, "hooks.json");
  await writeFile(legacyHooksPath, JSON.stringify({
    hooks: {
      PreToolUse: [
        {
          matcher: "^Read$",
          hooks: [{ type: "command", command: "echo legacy-user", timeout: 9 }]
        },
        {
          matcher: "^Bash$",
          hooks: [{ type: "command", command: "/old/.budget-guard/bin/budget_guard.sh codex pre", timeout: 15 }]
        }
      ],
      Stop: [
        {
          hooks: [{ type: "command", command: "/old/.budget-guard/bin/budget_guard.sh codex stop", timeout: 15 }]
        }
      ]
    }
  }, null, 2) + "\n");

  const env = {
    ...process.env,
    HOME: home,
    PATH: `${fakeBin}:${process.env.PATH}`,
    BUDGET_MCP_TOOL_TIMEOUT_SEC: "18000"
  };
  await execFileAsync(resolve(root, "install.sh"), [], { cwd: root, env, timeout: 20_000 });
  await execFileAsync(resolve(root, "install.sh"), [], { cwd: root, env, timeout: 20_000 });

  const installed = await readFile(configPath, "utf8");
  assert.doesNotMatch(installed, /hooks\.json/);
  assert.match(installed, /\[hooks\]/);
  assert.match(installed, /\[\[hooks\.UserPromptSubmit\]\]/);
  assert.match(installed, /\[\[hooks\.PreToolUse\]\]\nmatcher = "\*"/);
  assert.match(installed, /\[\[hooks\.PostToolUse\]\]\nmatcher = "\*"/);
  assert.match(installed, /\[\[hooks\.Stop\]\]/);
  assert.match(installed, /\[\[hooks\.SessionStart\]\]/);
  assert.equal((installed.match(/budget_guard\.sh codex pre/g) || []).length, 1);
  assert.equal((installed.match(/budget_guard\.sh codex post/g) || []).length, 1);
  assert.equal((installed.match(/budget_guard\.sh codex stop/g) || []).length, 1);
  assert.match(installed, /command = "\/Users\/example\/budget-guard-dashboard\/notify\.sh"/);
  assert.match(installed, /command = "\/home\/me\/my_budget_guard\.sh check"/);
  assert.match(installed, /mention budget_guard\.sh in body/);
  assert.match(installed, /\[mcp_servers\.other\]/);
  assert.match(installed, /\[mcp_servers\.budget-guard\]/);
  assert.match(installed, /tool_timeout_sec = 18000\.0/);
  const legacyAfterInstall = await readFile(legacyHooksPath, "utf8");
  assert.doesNotMatch(legacyAfterInstall, /budget_guard\.sh/);
  assert.match(legacyAfterInstall, /legacy-user/);
  await execFileAsync(resolve(root, "install.sh"), [], { cwd: root, env, timeout: 20_000 });
  const reinstalled = await readFile(configPath, "utf8");
  assert.equal(reinstalled, installed, "install is byte-idempotent with an existing user [hooks] table");

  const backups = (await readdir(codexDir)).filter((name) => name.startsWith("config.toml.bak."));
  assert.ok(backups.length >= 1, "installer writes a config.toml backup");

  await execFileAsync(resolve(root, "install.sh"), ["--uninstall"], { cwd: root, env, timeout: 20_000 });
  const uninstalled = await readFile(configPath, "utf8");
  assert.doesNotMatch(uninstalled, /budget_guard\.sh codex/);
  assert.doesNotMatch(uninstalled, /\[mcp_servers\.budget-guard\]/);
  assert.match(uninstalled, /command = "\/Users\/example\/budget-guard-dashboard\/notify\.sh"/);
  assert.match(uninstalled, /command = "\/home\/me\/my_budget_guard\.sh check"/);
  assert.match(uninstalled, /mention budget_guard\.sh in body/);
  assert.match(uninstalled, /\[mcp_servers\.other\]/);
  const legacyAfterUninstall = await readFile(legacyHooksPath, "utf8");
  assert.doesNotMatch(legacyAfterUninstall, /budget_guard\.sh/);
  assert.match(legacyAfterUninstall, /legacy-user/);
});

test("codex installer recognizes single-quoted managed TOML hooks", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "budget-install-single-quote-home-"));
  const fakeBin = resolve(home, "fake-bin");
  await mkdir(fakeBin, { recursive: true });
  await writeFile(resolve(fakeBin, "npm"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });

  const codexDir = resolve(home, ".codex");
  await mkdir(codexDir, { recursive: true });
  const configPath = resolve(codexDir, "config.toml");
  const managedGuard = resolve(home, ".budget-guard", "bin", "budget_guard.sh");
  await writeFile(configPath, [
    "[hooks]",
    "",
    "[[hooks.PreToolUse]]",
    'matcher = "*"',
    "",
    "[[hooks.PreToolUse.hooks]]",
    'type = "command"',
    `command = '${managedGuard} codex pre'`,
    "timeout = 15",
    "",
    "[[hooks.PostToolUse]]",
    'matcher = "*"',
    "",
    "[[hooks.PostToolUse.hooks]]",
    'type = "command"',
    `command = '''${managedGuard} codex post'''`,
    "timeout = 15"
  ].join("\n") + "\n");

  const env = {
    ...process.env,
    HOME: home,
    PATH: `${fakeBin}:${process.env.PATH}`,
    BUDGET_MCP_TOOL_TIMEOUT_SEC: "18000"
  };
  await execFileAsync(resolve(root, "install.sh"), [], { cwd: root, env, timeout: 20_000 });

  const installed = await readFile(configPath, "utf8");
  assert.equal((installed.match(/budget_guard\.sh codex pre/g) || []).length, 1);
  assert.equal((installed.match(/budget_guard\.sh codex post/g) || []).length, 1);

  await execFileAsync(resolve(root, "install.sh"), ["--uninstall"], { cwd: root, env, timeout: 20_000 });
  const uninstalled = await readFile(configPath, "utf8");
  assert.doesNotMatch(uninstalled, /budget_guard\.sh codex/);
});

test("codex installer preserves free text after hooks header across repeated installs", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "budget-install-hooks-comment-home-"));
  const fakeBin = resolve(home, "fake-bin");
  await mkdir(fakeBin, { recursive: true });
  await writeFile(resolve(fakeBin, "npm"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });

  const codexDir = resolve(home, ".codex");
  await mkdir(codexDir, { recursive: true });
  const configPath = resolve(codexDir, "config.toml");
  await writeFile(configPath, [
    "[hooks]",
    "",
    "# my custom hooks section",
    "",
    "[[hooks.PreToolUse]]",
    'matcher = "^Read$"',
    "",
    "[[hooks.PreToolUse.hooks]]",
    'type = "command"',
    'command = "/Users/example/notify.sh"',
    "timeout = 9"
  ].join("\n") + "\n");

  const env = {
    ...process.env,
    HOME: home,
    PATH: `${fakeBin}:${process.env.PATH}`,
    BUDGET_MCP_TOOL_TIMEOUT_SEC: "18000"
  };
  await execFileAsync(resolve(root, "install.sh"), [], { cwd: root, env, timeout: 20_000 });
  const installed = await readFile(configPath, "utf8");
  assert.equal((installed.match(/# my custom hooks section/g) || []).length, 1);
  assert.match(installed, /# my custom hooks section\n\n\[\[hooks\.PreToolUse\]\]/);

  await execFileAsync(resolve(root, "install.sh"), [], { cwd: root, env, timeout: 20_000 });
  const reinstalled = await readFile(configPath, "utf8");
  assert.equal(reinstalled, installed, "install is byte-idempotent when free text follows [hooks]");
  assert.equal((reinstalled.match(/# my custom hooks section/g) || []).length, 1);
});

test("codex installer does not treat brackets inside multiline command strings as table boundaries", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "budget-install-bracket-string-home-"));
  const fakeBin = resolve(home, "fake-bin");
  await mkdir(fakeBin, { recursive: true });
  await writeFile(resolve(fakeBin, "npm"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });

  const codexDir = resolve(home, ".codex");
  await mkdir(codexDir, { recursive: true });
  const configPath = resolve(codexDir, "config.toml");
  await writeFile(configPath, [
    "[hooks]",
    "",
    "[[hooks.PreToolUse]]",
    'matcher = "^Read$"',
    "",
    "[[hooks.PreToolUse.hooks]]",
    'type = "command"',
    'command = """',
    "echo start",
    "[ -f /tmp/x ] && echo found",
    "echo end",
    '"""',
    "timeout = 9"
  ].join("\n") + "\n");

  const env = {
    ...process.env,
    HOME: home,
    PATH: `${fakeBin}:${process.env.PATH}`,
    BUDGET_MCP_TOOL_TIMEOUT_SEC: "18000"
  };
  await execFileAsync(resolve(root, "install.sh"), [], { cwd: root, env, timeout: 20_000 });

  const parsed = await readToml(configPath);
  assert.deepEqual(Object.keys(parsed.hooks).sort(), [
    "PostToolUse",
    "PreToolUse",
    "SessionStart",
    "Stop",
    "UserPromptSubmit"
  ].sort());
  const userCommand = parsed.hooks.PreToolUse[0].hooks[0].command;
  assert.match(userCommand, /^echo start\n\[ -f \/tmp\/x \] && echo found\necho end\n$/);
  assert.doesNotMatch(userCommand, /\[\[hooks\.UserPromptSubmit\]\]/);
  assert.equal((parsed.hooks.UserPromptSubmit ?? []).length, 1);
  assert.equal((parsed.hooks.PostToolUse ?? []).length, 1);
  assert.equal((parsed.hooks.Stop ?? []).length, 1);
  assert.equal((parsed.hooks.SessionStart ?? []).length, 1);
});

test("codex installer keeps trailing section comments adjacent and uninstalls byte-cleanly", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "budget-install-section-comment-home-"));
  const fakeBin = resolve(home, "fake-bin");
  await mkdir(fakeBin, { recursive: true });
  await writeFile(resolve(fakeBin, "npm"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });

  const codexDir = resolve(home, ".codex");
  await mkdir(codexDir, { recursive: true });
  const configPath = resolve(codexDir, "config.toml");
  const original = [
    "[hooks]",
    "",
    "[[hooks.PreToolUse]]",
    'matcher = "^Read$"',
    "",
    "[[hooks.PreToolUse.hooks]]",
    'type = "command"',
    'command = "/Users/example/notify.sh"',
    "timeout = 9",
    "",
    "# Bob's other MCP server",
    "[mcp_servers.other]",
    'command = "node"'
  ].join("\n") + "\n";
  await writeFile(configPath, original);

  const env = {
    ...process.env,
    HOME: home,
    PATH: `${fakeBin}:${process.env.PATH}`,
    BUDGET_MCP_TOOL_TIMEOUT_SEC: "18000"
  };
  await execFileAsync(resolve(root, "install.sh"), [], { cwd: root, env, timeout: 20_000 });
  const installed = await readFile(configPath, "utf8");
  assert.match(installed, /# Bob's other MCP server\n\[mcp_servers\.other\]/);

  await execFileAsync(resolve(root, "install.sh"), ["--uninstall"], { cwd: root, env, timeout: 20_000 });
  const uninstalled = await readFile(configPath, "utf8");
  assert.equal(uninstalled, original);
});

test("codex installer preserves glued suffix spacing when uninstalling", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "budget-install-glued-suffix-home-"));
  const fakeBin = resolve(home, "fake-bin");
  await mkdir(fakeBin, { recursive: true });
  await writeFile(resolve(fakeBin, "npm"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });

  const codexDir = resolve(home, ".codex");
  await mkdir(codexDir, { recursive: true });
  const configPath = resolve(codexDir, "config.toml");
  const original = [
    "[hooks]",
    "",
    "[[hooks.PreToolUse]]",
    'matcher = "^Read$"',
    "",
    "[[hooks.PreToolUse.hooks]]",
    'type = "command"',
    'command = "/Users/example/notify.sh"',
    "timeout = 9",
    "# glued comment",
    "[mcp_servers.other]",
    'command = "node"'
  ].join("\n") + "\n";
  await writeFile(configPath, original);

  const env = {
    ...process.env,
    HOME: home,
    PATH: `${fakeBin}:${process.env.PATH}`,
    BUDGET_MCP_TOOL_TIMEOUT_SEC: "18000"
  };
  await execFileAsync(resolve(root, "install.sh"), [], { cwd: root, env, timeout: 20_000 });
  const installed = await readFile(configPath, "utf8");
  assert.match(installed, /# glued comment\n\[mcp_servers\.other\]/);

  await execFileAsync(resolve(root, "install.sh"), [], { cwd: root, env, timeout: 20_000 });
  const reinstalled = await readFile(configPath, "utf8");
  assert.equal(reinstalled, installed, "install is byte-idempotent with glued suffix content");

  await execFileAsync(resolve(root, "install.sh"), ["--uninstall"], { cwd: root, env, timeout: 20_000 });
  const uninstalled = await readFile(configPath, "utf8");
  assert.equal(uninstalled, original);
});

test("codex installer preserves CRLF line endings in config.toml", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "budget-install-crlf-home-"));
  const fakeBin = resolve(home, "fake-bin");
  await mkdir(fakeBin, { recursive: true });
  await writeFile(resolve(fakeBin, "npm"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });

  const codexDir = resolve(home, ".codex");
  await mkdir(codexDir, { recursive: true });
  const configPath = resolve(codexDir, "config.toml");
  const original = [
    "[hooks]",
    "[[hooks.PreToolUse]]",
    'matcher = "^Read$"',
    "[[hooks.PreToolUse.hooks]]",
    'type = "command"',
    'command = "/Users/example/notify.sh"',
    "timeout = 9"
  ].join("\r\n") + "\r\n";
  await writeFile(configPath, original);

  const env = {
    ...process.env,
    HOME: home,
    PATH: `${fakeBin}:${process.env.PATH}`,
    BUDGET_MCP_TOOL_TIMEOUT_SEC: "18000"
  };
  await execFileAsync(resolve(root, "install.sh"), [], { cwd: root, env, timeout: 20_000 });
  const installedBuffer = await readFile(configPath);
  const installed = installedBuffer.toString("utf8");
  assert.equal((installed.match(/\r\n/g) || []).length, (installed.match(/\n/g) || []).length);
  assert.equal((installed.match(/(?<!\r)\n/g) || []).length, 0);
  assert.ok(installed.includes("[[hooks.UserPromptSubmit]]\r\n"));
  await readToml(configPath);
});

test("codex installer validates MCP timeout before modifying files", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "budget-install-invalid-timeout-home-"));
  const fakeBin = resolve(home, "fake-bin");
  await mkdir(fakeBin, { recursive: true });
  await writeFile(resolve(fakeBin, "npm"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });

  const codexDir = resolve(home, ".codex");
  await mkdir(codexDir, { recursive: true });
  const legacyHooksPath = resolve(codexDir, "hooks.json");
  const legacyBefore = JSON.stringify({
    hooks: {
      PreToolUse: [
        {
          matcher: "^Bash$",
          hooks: [{ type: "command", command: "/old/.budget-guard/bin/budget_guard.sh codex pre", timeout: 15 }]
        }
      ]
    }
  }, null, 2) + "\n";
  await writeFile(legacyHooksPath, legacyBefore);
  const configPath = resolve(codexDir, "config.toml");
  const configBefore = '[mcp_servers.other]\ncommand = "node"\n';
  await writeFile(configPath, configBefore);

  const env = {
    ...process.env,
    HOME: home,
    PATH: `${fakeBin}:${process.env.PATH}`,
    BUDGET_MCP_TOOL_TIMEOUT_SEC: "abc"
  };
  let error;
  try {
    await execFileAsync(resolve(root, "install.sh"), [], { cwd: root, env, timeout: 20_000 });
  } catch (err) {
    error = err;
  }
  assert.ok(error, "install should reject invalid MCP timeout");
  assert.equal(error.code, 1);
  assert.match(`${error.stdout}\n${error.stderr}`, /BUDGET_MCP_TOOL_TIMEOUT_SEC 非数字/);
  assert.equal(await readFile(legacyHooksPath, "utf8"), legacyBefore);
  assert.equal(await readFile(configPath, "utf8"), configBefore);
  await assert.rejects(() => access(resolve(home, ".budget-guard", "bin", "budget_guard.sh")));
  await assert.rejects(() => access(resolve(home, ".budget-guard", "mcp", "mcp-server.mjs")));
});

test("codex installer removes only managed hooks inside shared legacy hooks.json entries", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "budget-install-shared-legacy-home-"));
  const fakeBin = resolve(home, "fake-bin");
  await mkdir(fakeBin, { recursive: true });
  await writeFile(resolve(fakeBin, "npm"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });

  const codexDir = resolve(home, ".codex");
  await mkdir(codexDir, { recursive: true });
  const legacyHooksPath = resolve(codexDir, "hooks.json");
  await writeFile(legacyHooksPath, JSON.stringify({
    hooks: {
      PreToolUse: [
        {
          matcher: "^Bash$",
          hooks: [
            { type: "command", command: "echo user-keep", timeout: 9 },
            { type: "command", command: "/old/.budget-guard/bin/budget_guard.sh codex pre", timeout: 15 }
          ]
        },
        {
          matcher: "^Read$",
          hooks: [{ type: "command", command: "echo read-keep", timeout: 9 }]
        }
      ],
      Stop: [
        {
          hooks: [{ type: "command", command: "/old/.budget-guard/bin/budget_guard.sh codex stop", timeout: 15 }]
        }
      ]
    }
  }, null, 2) + "\n");

  const env = {
    ...process.env,
    HOME: home,
    PATH: `${fakeBin}:${process.env.PATH}`,
    BUDGET_MCP_TOOL_TIMEOUT_SEC: "18000"
  };
  await execFileAsync(resolve(root, "install.sh"), [], { cwd: root, env, timeout: 20_000 });

  const installed = JSON.parse(await readFile(legacyHooksPath, "utf8"));
  assert.equal(installed.hooks.PreToolUse.length, 2);
  const shared = installed.hooks.PreToolUse.find((entry) => entry.matcher === "^Bash$");
  assert.deepEqual(shared.hooks.map((hook) => hook.command), ["echo user-keep"]);
  assert.deepEqual(
    installed.hooks.PreToolUse.find((entry) => entry.matcher === "^Read$").hooks.map((hook) => hook.command),
    ["echo read-keep"]
  );
  assert.equal(installed.hooks.Stop, undefined);

  await execFileAsync(resolve(root, "install.sh"), ["--uninstall"], { cwd: root, env, timeout: 20_000 });
  const uninstalled = JSON.parse(await readFile(legacyHooksPath, "utf8"));
  assert.deepEqual(uninstalled.hooks.PreToolUse.find((entry) => entry.matcher === "^Bash$").hooks.map((hook) => hook.command), ["echo user-keep"]);
  assert.deepEqual(uninstalled.hooks.PreToolUse.find((entry) => entry.matcher === "^Read$").hooks.map((hook) => hook.command), ["echo read-keep"]);
});

test("codex installer ignores non-object legacy hooks.json instead of aborting", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "budget-install-non-object-legacy-home-"));
  const fakeBin = resolve(home, "fake-bin");
  await mkdir(fakeBin, { recursive: true });
  await writeFile(resolve(fakeBin, "npm"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });

  const codexDir = resolve(home, ".codex");
  await mkdir(codexDir, { recursive: true });
  const legacyHooksPath = resolve(codexDir, "hooks.json");
  const legacyBefore = "[]\n";
  await writeFile(legacyHooksPath, legacyBefore);

  const env = {
    ...process.env,
    HOME: home,
    PATH: `${fakeBin}:${process.env.PATH}`,
    BUDGET_MCP_TOOL_TIMEOUT_SEC: "18000"
  };
  await execFileAsync(resolve(root, "install.sh"), [], { cwd: root, env, timeout: 20_000 });
  assert.equal(await readFile(legacyHooksPath, "utf8"), legacyBefore);
  assert.match(await readFile(resolve(codexDir, "config.toml"), "utf8"), /\[hooks\]/);

  await execFileAsync(resolve(root, "install.sh"), ["--uninstall"], { cwd: root, env, timeout: 20_000 });
  assert.equal(await readFile(legacyHooksPath, "utf8"), legacyBefore);
});

test("codex installer ignores malformed legacy hooks wrapper instead of aborting", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "budget-install-malformed-wrapper-legacy-home-"));
  const fakeBin = resolve(home, "fake-bin");
  await mkdir(fakeBin, { recursive: true });
  await writeFile(resolve(fakeBin, "npm"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });

  const codexDir = resolve(home, ".codex");
  await mkdir(codexDir, { recursive: true });
  const legacyHooksPath = resolve(codexDir, "hooks.json");
  const legacyBefore = JSON.stringify({
    hooks: [
      {
        hooks: [{ type: "command", command: "/old/.budget-guard/bin/budget_guard.sh codex pre" }]
      }
    ],
    x: "keep"
  }, null, 2) + "\n";
  await writeFile(legacyHooksPath, legacyBefore);

  const env = {
    ...process.env,
    HOME: home,
    PATH: `${fakeBin}:${process.env.PATH}`,
    BUDGET_MCP_TOOL_TIMEOUT_SEC: "18000"
  };
  await execFileAsync(resolve(root, "install.sh"), [], { cwd: root, env, timeout: 20_000 });
  assert.equal(await readFile(legacyHooksPath, "utf8"), legacyBefore);
  assert.match(await readFile(resolve(codexDir, "config.toml"), "utf8"), /\[hooks\]/);

  await execFileAsync(resolve(root, "install.sh"), ["--uninstall"], { cwd: root, env, timeout: 20_000 });
  assert.equal(await readFile(legacyHooksPath, "utf8"), legacyBefore);
});

test("codex installer preserves empty non-dict legacy hooks wrapper", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "budget-install-empty-array-wrapper-legacy-home-"));
  const fakeBin = resolve(home, "fake-bin");
  await mkdir(fakeBin, { recursive: true });
  await writeFile(resolve(fakeBin, "npm"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });

  const codexDir = resolve(home, ".codex");
  await mkdir(codexDir, { recursive: true });
  const legacyHooksPath = resolve(codexDir, "hooks.json");
  const legacyBefore = '{\n  "hooks": []\n}\n';
  await writeFile(legacyHooksPath, legacyBefore);

  const env = {
    ...process.env,
    HOME: home,
    PATH: `${fakeBin}:${process.env.PATH}`,
    BUDGET_MCP_TOOL_TIMEOUT_SEC: "18000"
  };
  await execFileAsync(resolve(root, "install.sh"), [], { cwd: root, env, timeout: 20_000 });
  assert.equal(await readFile(legacyHooksPath, "utf8"), legacyBefore);

  await execFileAsync(resolve(root, "install.sh"), ["--uninstall"], { cwd: root, env, timeout: 20_000 });
  assert.equal(await readFile(legacyHooksPath, "utf8"), legacyBefore);
});

test("codex installer preserves empty legacy hook arrays when no managed hook exists", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "budget-install-empty-event-legacy-home-"));
  const fakeBin = resolve(home, "fake-bin");
  await mkdir(fakeBin, { recursive: true });
  await writeFile(resolve(fakeBin, "npm"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });

  const codexDir = resolve(home, ".codex");
  await mkdir(codexDir, { recursive: true });
  const legacyHooksPath = resolve(codexDir, "hooks.json");
  const legacyBefore = '{\n  "hooks": {\n    "PreToolUse": []\n  }\n}\n';
  await writeFile(legacyHooksPath, legacyBefore);

  const env = {
    ...process.env,
    HOME: home,
    PATH: `${fakeBin}:${process.env.PATH}`,
    BUDGET_MCP_TOOL_TIMEOUT_SEC: "18000"
  };
  await execFileAsync(resolve(root, "install.sh"), [], { cwd: root, env, timeout: 20_000 });
  assert.equal(await readFile(legacyHooksPath, "utf8"), legacyBefore);

  await execFileAsync(resolve(root, "install.sh"), ["--uninstall"], { cwd: root, env, timeout: 20_000 });
  assert.equal(await readFile(legacyHooksPath, "utf8"), legacyBefore);
});

test("codex installer leaves legacy hooks intact when config.toml update fails", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "budget-install-partial-state-home-"));
  const fakeBin = resolve(home, "fake-bin");
  await mkdir(fakeBin, { recursive: true });
  await writeFile(resolve(fakeBin, "npm"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });

  const codexDir = resolve(home, ".codex");
  await mkdir(codexDir, { recursive: true });
  const legacyHooksPath = resolve(codexDir, "hooks.json");
  const legacyBefore = JSON.stringify({
    hooks: {
      PreToolUse: [
        {
          hooks: [{ type: "command", command: "/old/.budget-guard/bin/budget_guard.sh codex pre", timeout: 15 }]
        }
      ]
    }
  }, null, 2) + "\n";
  await writeFile(legacyHooksPath, legacyBefore);
  await mkdir(resolve(codexDir, "config.toml"));

  const env = {
    ...process.env,
    HOME: home,
    PATH: `${fakeBin}:${process.env.PATH}`,
    BUDGET_MCP_TOOL_TIMEOUT_SEC: "18000"
  };
  await assert.rejects(
    () => execFileAsync(resolve(root, "install.sh"), [], { cwd: root, env, timeout: 20_000 })
  );
  assert.equal(await readFile(legacyHooksPath, "utf8"), legacyBefore);
});

test("codex installer removes only managed nested TOML hooks inside shared hook groups", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "budget-install-shared-toml-home-"));
  const fakeBin = resolve(home, "fake-bin");
  await mkdir(fakeBin, { recursive: true });
  await writeFile(resolve(fakeBin, "npm"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });

  const codexDir = resolve(home, ".codex");
  await mkdir(codexDir, { recursive: true });
  const configPath = resolve(codexDir, "config.toml");
  const managedGuard = resolve(home, ".budget-guard", "bin", "budget_guard.sh");
  await writeFile(configPath, [
    "[hooks]",
    "",
    "[[hooks.PreToolUse]]",
    'matcher = "*"',
    "",
    "[[hooks.PreToolUse.hooks]]",
    'type = "command"',
    'command = "/Users/example/user-hook.sh"',
    "timeout = 9",
    "",
    "[[hooks.PreToolUse.hooks]]",
    'type = "command"',
    `command = "${managedGuard} codex pre"`,
    "timeout = 15"
  ].join("\n") + "\n");

  const env = {
    ...process.env,
    HOME: home,
    PATH: `${fakeBin}:${process.env.PATH}`,
    BUDGET_MCP_TOOL_TIMEOUT_SEC: "18000"
  };
  await execFileAsync(resolve(root, "install.sh"), [], { cwd: root, env, timeout: 20_000 });
  const installed = await readFile(configPath, "utf8");
  assert.match(installed, /command = "\/Users\/example\/user-hook\.sh"/);
  assert.equal((installed.match(/budget_guard\.sh codex pre/g) || []).length, 1);

  await execFileAsync(resolve(root, "install.sh"), ["--uninstall"], { cwd: root, env, timeout: 20_000 });
  const uninstalled = await readFile(configPath, "utf8");
  assert.match(uninstalled, /command = "\/Users\/example\/user-hook\.sh"/);
  assert.doesNotMatch(uninstalled, /budget_guard\.sh codex/);
});

test("codex installer recognizes quoted TOML hook table headers", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "budget-install-quoted-hook-home-"));
  const fakeBin = resolve(home, "fake-bin");
  await mkdir(fakeBin, { recursive: true });
  await writeFile(resolve(fakeBin, "npm"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });

  const codexDir = resolve(home, ".codex");
  await mkdir(codexDir, { recursive: true });
  const configPath = resolve(codexDir, "config.toml");
  const managedGuard = resolve(home, ".budget-guard", "bin", "budget_guard.sh");
  await writeFile(configPath, [
    "[hooks]",
    "",
    '[[hooks."PreToolUse"]]',
    'matcher = "*"',
    "",
    '[[hooks."PreToolUse".hooks]]',
    'type = "command"',
    `command = "${managedGuard} codex pre"`,
    "timeout = 15"
  ].join("\n") + "\n");

  const env = {
    ...process.env,
    HOME: home,
    PATH: `${fakeBin}:${process.env.PATH}`,
    BUDGET_MCP_TOOL_TIMEOUT_SEC: "18000"
  };
  await execFileAsync(resolve(root, "install.sh"), [], { cwd: root, env, timeout: 20_000 });
  const installed = await readFile(configPath, "utf8");
  assert.equal((installed.match(/budget_guard\.sh codex pre/g) || []).length, 1);

  await execFileAsync(resolve(root, "install.sh"), ["--uninstall"], { cwd: root, env, timeout: 20_000 });
  const uninstalled = await readFile(configPath, "utf8");
  assert.doesNotMatch(uninstalled, /budget_guard\.sh codex/);
});

test("codex installer replaces quoted MCP budget table without duplicating it", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "budget-install-quoted-mcp-home-"));
  const fakeBin = resolve(home, "fake-bin");
  await mkdir(fakeBin, { recursive: true });
  await writeFile(resolve(fakeBin, "npm"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });

  const codexDir = resolve(home, ".codex");
  await mkdir(codexDir, { recursive: true });
  const configPath = resolve(codexDir, "config.toml");
  await writeFile(configPath, [
    '[mcp_servers."budget-guard"]',
    'command = "node"',
    'args = ["/old/server.mjs"]',
    "tool_timeout_sec = 18000.0"
  ].join("\n") + "\n");

  const env = {
    ...process.env,
    HOME: home,
    PATH: `${fakeBin}:${process.env.PATH}`,
    BUDGET_MCP_TOOL_TIMEOUT_SEC: "18000"
  };
  await execFileAsync(resolve(root, "install.sh"), [], { cwd: root, env, timeout: 20_000 });
  const parsed = await readToml(configPath);
  assert.equal(parsed.mcp_servers["budget-guard"].command, "node");
  assert.equal((await readFile(configPath, "utf8")).match(/\[mcp_servers\.budget-guard\]/g).length, 1);
});

test("codex installer preserves comments that follow the budget MCP table", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "budget-install-mcp-comment-home-"));
  const fakeBin = resolve(home, "fake-bin");
  await mkdir(fakeBin, { recursive: true });
  await writeFile(resolve(fakeBin, "npm"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });

  const codexDir = resolve(home, ".codex");
  await mkdir(codexDir, { recursive: true });
  const configPath = resolve(codexDir, "config.toml");
  await writeFile(configPath, [
    "[mcp_servers.budget-guard]",
    'command = "node"',
    'args = ["/old/server.mjs"]',
    "tool_timeout_sec = 18000.0",
    "# Bob's other MCP server",
    "[mcp_servers.other]",
    'command = "node"'
  ].join("\n") + "\n");

  const env = {
    ...process.env,
    HOME: home,
    PATH: `${fakeBin}:${process.env.PATH}`,
    BUDGET_MCP_TOOL_TIMEOUT_SEC: "18000"
  };
  await execFileAsync(resolve(root, "install.sh"), [], { cwd: root, env, timeout: 20_000 });
  const installed = await readFile(configPath, "utf8");
  assert.match(installed, /# Bob's other MCP server\n\[mcp_servers\.other\]/);
  await readToml(configPath);
});

test("codex installer preserves trailing user whitespace after install and uninstall", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "budget-install-trailing-space-home-"));
  const fakeBin = resolve(home, "fake-bin");
  await mkdir(fakeBin, { recursive: true });
  await writeFile(resolve(fakeBin, "npm"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });

  const codexDir = resolve(home, ".codex");
  await mkdir(codexDir, { recursive: true });
  const configPath = resolve(codexDir, "config.toml");
  const original = '[mcp_servers.other]\ncommand = "node"   \n\n\n';
  await writeFile(configPath, original);

  const env = {
    ...process.env,
    HOME: home,
    PATH: `${fakeBin}:${process.env.PATH}`,
    BUDGET_MCP_TOOL_TIMEOUT_SEC: "18000"
  };
  await execFileAsync(resolve(root, "install.sh"), [], { cwd: root, env, timeout: 20_000 });
  await execFileAsync(resolve(root, "install.sh"), ["--uninstall"], { cwd: root, env, timeout: 20_000 });
  assert.equal(await readFile(configPath, "utf8"), original);
});

test("codex installer recognizes TOML table headers with trailing comments", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "budget-install-header-comment-home-"));
  const fakeBin = resolve(home, "fake-bin");
  await mkdir(fakeBin, { recursive: true });
  await writeFile(resolve(fakeBin, "npm"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });

  const codexDir = resolve(home, ".codex");
  await mkdir(codexDir, { recursive: true });
  const configPath = resolve(codexDir, "config.toml");
  const managedGuard = resolve(home, ".budget-guard", "bin", "budget_guard.sh");
  await writeFile(configPath, [
    "[hooks] # hook section",
    "",
    "[[hooks.PreToolUse]] # managed old hook",
    'matcher = "*"',
    "",
    "[[hooks.PreToolUse.hooks]] # nested old hook",
    'type = "command"',
    `command = "${managedGuard} codex pre"`,
    "timeout = 15",
    "",
    "[mcp_servers.budget-guard] # existing budget guard table",
    'command = "node"',
    'args = ["/old/server.mjs"]',
    "tool_timeout_sec = 18000.0"
  ].join("\n") + "\n");

  const env = {
    ...process.env,
    HOME: home,
    PATH: `${fakeBin}:${process.env.PATH}`,
    BUDGET_MCP_TOOL_TIMEOUT_SEC: "18000"
  };
  await execFileAsync(resolve(root, "install.sh"), [], { cwd: root, env, timeout: 20_000 });
  const installed = await readFile(configPath, "utf8");
  await readToml(configPath);
  assert.equal((installed.match(/budget_guard\.sh codex pre/g) || []).length, 1);
  assert.equal((installed.match(/\[mcp_servers\.budget-guard\]/g) || []).length, 1);

  await execFileAsync(resolve(root, "install.sh"), ["--uninstall"], { cwd: root, env, timeout: 20_000 });
  const uninstalled = await readFile(configPath, "utf8");
  assert.doesNotMatch(uninstalled, /budget_guard\.sh codex/);
  assert.doesNotMatch(uninstalled, /mcp_servers\.budget-guard/);
});

test("codex installer replaces managed inline hook arrays without invalid TOML", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "budget-install-inline-hooks-home-"));
  const fakeBin = resolve(home, "fake-bin");
  await mkdir(fakeBin, { recursive: true });
  await writeFile(resolve(fakeBin, "npm"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });

  const codexDir = resolve(home, ".codex");
  await mkdir(codexDir, { recursive: true });
  const configPath = resolve(codexDir, "config.toml");
  await writeFile(configPath, [
    "[hooks]",
    'PreToolUse = [{ matcher = "^Read$", hooks = [{ type = "command", command = "/Users/example/notify.sh", timeout = 9 }] }]'
  ].join("\n") + "\n");

  const env = {
    ...process.env,
    HOME: home,
    PATH: `${fakeBin}:${process.env.PATH}`,
    BUDGET_MCP_TOOL_TIMEOUT_SEC: "18000"
  };
  await execFileAsync(resolve(root, "install.sh"), [], { cwd: root, env, timeout: 20_000 });
  const parsed = await readToml(configPath);
  assert.match(parsed.hooks.PreToolUse[0].hooks[0].command, /notify\.sh/);
  assert.equal(
    parsed.hooks.PreToolUse.filter((entry) => entry.hooks?.some((hook) => /budget_guard\.sh codex pre/.test(hook.command))).length,
    1
  );
});

test("codex installer is byte-symmetric when adding hooks to config without hooks", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "budget-install-no-hooks-byte-home-"));
  const fakeBin = resolve(home, "fake-bin");
  await mkdir(fakeBin, { recursive: true });
  await writeFile(resolve(fakeBin, "npm"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });

  const codexDir = resolve(home, ".codex");
  await mkdir(codexDir, { recursive: true });
  const configPath = resolve(codexDir, "config.toml");
  const original = '[mcp_servers.other]\ncommand = "node"\nargs = ["x"]\n';
  await writeFile(configPath, original);

  const env = {
    ...process.env,
    HOME: home,
    PATH: `${fakeBin}:${process.env.PATH}`,
    BUDGET_MCP_TOOL_TIMEOUT_SEC: "18000"
  };
  await execFileAsync(resolve(root, "install.sh"), [], { cwd: root, env, timeout: 20_000 });
  await execFileAsync(resolve(root, "install.sh"), ["--uninstall"], { cwd: root, env, timeout: 20_000 });
  assert.equal(await readFile(configPath, "utf8"), original);
});

test("codex installer removes config.toml on uninstall when install created it", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "budget-install-created-config-home-"));
  const fakeBin = resolve(home, "fake-bin");
  await mkdir(fakeBin, { recursive: true });
  await writeFile(resolve(fakeBin, "npm"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });

  const configPath = resolve(home, ".codex", "config.toml");
  await assert.rejects(() => access(configPath));

  const env = {
    ...process.env,
    HOME: home,
    PATH: `${fakeBin}:${process.env.PATH}`,
    BUDGET_MCP_TOOL_TIMEOUT_SEC: "18000"
  };
  await execFileAsync(resolve(root, "install.sh"), [], { cwd: root, env, timeout: 20_000 });
  await access(configPath);

  await execFileAsync(resolve(root, "install.sh"), ["--uninstall"], { cwd: root, env, timeout: 20_000 });
  await assert.rejects(() => access(configPath));
});

test("codex installer removes self-created config.toml after repeated install uninstall cycles", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "budget-install-created-config-repeat-home-"));
  const fakeBin = resolve(home, "fake-bin");
  await mkdir(fakeBin, { recursive: true });
  await writeFile(resolve(fakeBin, "npm"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });

  const configPath = resolve(home, ".codex", "config.toml");
  const markerPath = `${configPath}.budget-guard-created`;
  const env = {
    ...process.env,
    HOME: home,
    PATH: `${fakeBin}:${process.env.PATH}`,
    BUDGET_MCP_TOOL_TIMEOUT_SEC: "18000"
  };

  for (let i = 0; i < 2; i++) {
    await execFileAsync(resolve(root, "install.sh"), [], { cwd: root, env, timeout: 20_000 });
    await access(configPath);
    await execFileAsync(resolve(root, "install.sh"), ["--uninstall"], { cwd: root, env, timeout: 20_000 });
    await assert.rejects(() => access(configPath));
    await assert.rejects(() => access(markerPath));
  }
});

test("codex installer preserves user config created after uninstalling a self-created config", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "budget-install-created-then-user-config-home-"));
  const fakeBin = resolve(home, "fake-bin");
  await mkdir(fakeBin, { recursive: true });
  await writeFile(resolve(fakeBin, "npm"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });

  const codexDir = resolve(home, ".codex");
  const configPath = resolve(codexDir, "config.toml");
  const env = {
    ...process.env,
    HOME: home,
    PATH: `${fakeBin}:${process.env.PATH}`,
    BUDGET_MCP_TOOL_TIMEOUT_SEC: "18000"
  };

  await execFileAsync(resolve(root, "install.sh"), [], { cwd: root, env, timeout: 20_000 });
  await execFileAsync(resolve(root, "install.sh"), ["--uninstall"], { cwd: root, env, timeout: 20_000 });
  await assert.rejects(() => access(configPath));

  const userConfig = '[mcp_servers.user]\ncommand = "node"\nargs = ["server.mjs"]\n';
  await mkdir(codexDir, { recursive: true });
  await writeFile(configPath, userConfig);

  await execFileAsync(resolve(root, "install.sh"), [], { cwd: root, env, timeout: 20_000 });
  await execFileAsync(resolve(root, "install.sh"), ["--uninstall"], { cwd: root, env, timeout: 20_000 });
  assert.equal(await readFile(configPath, "utf8"), userConfig);
  await assert.rejects(() => access(`${configPath}.budget-guard-created`));
});

test("codex installer preserves marker examples and replaces AGENTS.md block in place", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "budget-install-agents-marker-home-"));
  const fakeBin = resolve(home, "fake-bin");
  await mkdir(fakeBin, { recursive: true });
  await writeFile(resolve(fakeBin, "npm"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });

  const codexDir = resolve(home, ".codex");
  await mkdir(codexDir, { recursive: true });
  const memoryPath = resolve(codexDir, "AGENTS.md");
  const markStart = "<!-- budget-guard:start -->";
  const markEnd = "<!-- budget-guard:end -->";
  const markerExample = [
    "```md",
    markStart,
    "## 额度守卫协议(自动安装,无需手动配置)",
    "example only; do not treat this as managed",
    markEnd,
    "```"
  ].join("\n");
  await writeFile(memoryPath, [
    "# Existing AGENTS",
    markerExample,
    "",
    "before managed block",
    `${markStart} adjacent text should not count`,
    "text after adjacent marker",
    `${markEnd} adjacent text should not count`,
    "broken example before managed block",
    markStart,
    "example start only; should stay as user content",
    "",
    "user content between broken example and real managed block",
    markStart,
    "## 额度守卫协议(自动安装,无需手动配置)",
    "old managed block",
    markEnd,
    markStart,
    "## 额度守卫协议(自动安装,无需手动配置)",
    "duplicate old managed block",
    markEnd,
    "after managed block"
  ].join("\n") + "\n");

  const env = {
    ...process.env,
    HOME: home,
    PATH: `${fakeBin}:${process.env.PATH}`,
    BUDGET_MCP_TOOL_TIMEOUT_SEC: "18000"
  };
  await execFileAsync(resolve(root, "install.sh"), [], { cwd: root, env, timeout: 20_000 });
  const installed = await readFile(memoryPath, "utf8");
  assert.match(installed, new RegExp(markerExample.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(installed, /example start only; should stay as user content/);
  assert.match(installed, /user content between broken example and real managed block/);
  assert.match(installed, /<!-- budget-guard:start --> adjacent text should not count/);
  assert.match(installed, /<!-- budget-guard:end --> adjacent text should not count/);
  assert.doesNotMatch(installed, /old managed block/);
  assert.doesNotMatch(installed, /duplicate old managed block/);
  assert.equal((installed.match(/<!-- budget-guard:start -->/g) || []).length, 4);
  assert.equal((installed.match(/你运行在一个会监控订阅额度的环境里/g) || []).length, 1);
  assert.ok(
    installed.indexOf("after managed block") > installed.lastIndexOf(markEnd),
    "content after a managed block stays after the replacement"
  );

  await execFileAsync(resolve(root, "install.sh"), [], { cwd: root, env, timeout: 20_000 });
  const reinstalled = await readFile(memoryPath, "utf8");
  assert.equal(reinstalled, installed, "AGENTS.md protocol replacement is byte-idempotent");

  await execFileAsync(resolve(root, "install.sh"), ["--uninstall"], { cwd: root, env, timeout: 20_000 });
  const uninstalled = await readFile(memoryPath, "utf8");
  assert.match(uninstalled, new RegExp(markerExample.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(uninstalled, /example start only; should stay as user content/);
  assert.match(uninstalled, /user content between broken example and real managed block/);
  assert.match(uninstalled, /<!-- budget-guard:start --> adjacent text should not count/);
  assert.match(uninstalled, /<!-- budget-guard:end --> adjacent text should not count/);
  assert.doesNotMatch(uninstalled, /你运行在一个会监控订阅额度的环境里/);
  assert.equal((uninstalled.match(/<!-- budget-guard:start -->/g) || []).length, 3);
  assert.ok(uninstalled.indexOf("after managed block") > uninstalled.indexOf("before managed block"));
});

test("codex installer preserves indented marker examples as Markdown code blocks", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "budget-install-agents-indented-marker-home-"));
  const fakeBin = resolve(home, "fake-bin");
  await mkdir(fakeBin, { recursive: true });
  await writeFile(resolve(fakeBin, "npm"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });

  const codexDir = resolve(home, ".codex");
  await mkdir(codexDir, { recursive: true });
  const memoryPath = resolve(codexDir, "AGENTS.md");
  const markStart = "<!-- budget-guard:start -->";
  const markEnd = "<!-- budget-guard:end -->";
  const indentedExample = [
    `    ${markStart}`,
    "    ## 额度守卫协议(自动安装,无需手动配置)",
    "    example only; should remain as indented code",
    `    ${markEnd}`
  ].join("\n");
  await writeFile(memoryPath, [
    "# Existing AGENTS",
    "",
    indentedExample,
    "",
    "after"
  ].join("\n") + "\n");

  const env = {
    ...process.env,
    HOME: home,
    PATH: `${fakeBin}:${process.env.PATH}`,
    BUDGET_MCP_TOOL_TIMEOUT_SEC: "18000"
  };
  await execFileAsync(resolve(root, "install.sh"), [], { cwd: root, env, timeout: 20_000 });
  await execFileAsync(resolve(root, "install.sh"), ["--uninstall"], { cwd: root, env, timeout: 20_000 });
  const uninstalled = await readFile(memoryPath, "utf8");
  assert.match(uninstalled, new RegExp(indentedExample.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(uninstalled, /after/);
});

test("codex installer removes AGENTS.md when uninstalling an only-protocol file", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "budget-install-agents-only-home-"));
  const fakeBin = resolve(home, "fake-bin");
  await mkdir(fakeBin, { recursive: true });
  await writeFile(resolve(fakeBin, "npm"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });

  const env = {
    ...process.env,
    HOME: home,
    PATH: `${fakeBin}:${process.env.PATH}`,
    BUDGET_MCP_TOOL_TIMEOUT_SEC: "18000"
  };
  await execFileAsync(resolve(root, "install.sh"), [], { cwd: root, env, timeout: 20_000 });
  const memoryPath = resolve(home, ".codex", "AGENTS.md");
  assert.match(await readFile(memoryPath, "utf8"), /额度守卫协议/);

  await execFileAsync(resolve(root, "install.sh"), ["--uninstall"], { cwd: root, env, timeout: 20_000 });
  await assert.rejects(() => access(memoryPath));
});

test("waitUntilBudgetRefresh blocks until a probe confirms utilization below threshold", async () => {
  const { waitUntilBudgetRefresh } = await import("../mcp-tools.mjs");
  const dir = await mkdtemp(resolve(tmpdir(), "budget-wait-"));
  const fakeProbe = resolve(dir, "budget-probe");
  await writeFile(fakeProbe, [
    "#!/usr/bin/env node",
    "import { readFileSync, writeFileSync } from 'node:fs';",
    "const state = process.env.STATE_FILE;",
    "let count = 0;",
    "try { count = Number(readFileSync(state, 'utf8')); } catch {}",
    "count += 1;",
    "writeFileSync(state, String(count));",
    "const util = count < 2 ? 91 : 20;",
    "console.log(JSON.stringify({ok:true,agent:'codex',util,hard_util:util,reset_epoch:1000,now_epoch:1000 + count,source:'fake'}));"
  ].join("\n"), { mode: 0o755 });

  const result = await waitUntilBudgetRefresh({
    agent: "codex",
    resume_below: 30,
    poll_seconds: 0.01,
    max_wait_seconds: 2
  }, {
    env: { ...process.env, BUDGET_PROBE: fakeProbe, STATE_FILE: resolve(dir, "count") }
  });

  assert.equal(result.status, "ready");
  assert.equal(result.agent, "codex");
  assert.equal(result.final.hard_util, 20);
  assert.equal(result.probes, 2);
});

test("waitUntilBudgetRefresh retries transient probe failures", async () => {
  const { waitUntilBudgetRefresh } = await import("../mcp-tools.mjs");
  const dir = await mkdtemp(resolve(tmpdir(), "budget-wait-fail-"));
  const fakeProbe = resolve(dir, "budget-probe");
  await writeFile(fakeProbe, [
    "#!/usr/bin/env node",
    "import { readFileSync, writeFileSync } from 'node:fs';",
    "const state = process.env.STATE_FILE;",
    "let count = 0;",
    "try { count = Number(readFileSync(state, 'utf8')); } catch {}",
    "count += 1;",
    "writeFileSync(state, String(count));",
    "if (count === 1) { console.log(JSON.stringify({ok:false,agent:'codex',error:'rate_limited',fetched_at:1000})); process.exit(2); }",
    "console.log(JSON.stringify({ok:true,agent:'codex',util:20,hard_util:20,reset_epoch:1000,now_epoch:1000 + count,source:'fake'}));"
  ].join("\n"), { mode: 0o755 });

  const result = await waitUntilBudgetRefresh({
    agent: "codex",
    resume_below: 30,
    poll_seconds: 0.01,
    max_wait_seconds: 2
  }, {
    env: { ...process.env, BUDGET_PROBE: fakeProbe, STATE_FILE: resolve(dir, "count") }
  });

  assert.equal(result.status, "ready");
  assert.equal(result.probes, 2);
});

test("waitUntilBudgetRefresh retries probe exec failures without stdout", async () => {
  const { waitUntilBudgetRefresh } = await import("../mcp-tools.mjs");
  const dir = await mkdtemp(resolve(tmpdir(), "budget-wait-exec-fail-"));
  const fakeProbe = resolve(dir, "budget-probe");
  await writeFile(fakeProbe, [
    "#!/usr/bin/env node",
    "import { readFileSync, writeFileSync } from 'node:fs';",
    "const state = process.env.STATE_FILE;",
    "let count = 0;",
    "try { count = Number(readFileSync(state, 'utf8')); } catch {}",
    "count += 1;",
    "writeFileSync(state, String(count));",
    "if (count === 1) process.exit(9);",
    "console.log(JSON.stringify({ok:true,agent:'codex',util:20,hard_util:20,reset_epoch:1000,now_epoch:1000 + count,source:'fake'}));"
  ].join("\n"), { mode: 0o755 });

  const result = await waitUntilBudgetRefresh({
    agent: "codex",
    resume_below: 30,
    poll_seconds: 0.01,
    max_wait_seconds: 2
  }, {
    env: { ...process.env, BUDGET_PROBE: fakeProbe, STATE_FILE: resolve(dir, "count") }
  });

  assert.equal(result.status, "ready");
  assert.equal(result.probes, 2);
  assert.equal(result.final.hard_util, 20);
});

test("waitUntilBudgetRefresh falls back when default env numbers are invalid", async () => {
  const oldResume = process.env.BUDGET_RESUME_BELOW;
  const oldPoll = process.env.BUDGET_MCP_POLL_SECONDS;
  const oldMax = process.env.BUDGET_MCP_MAX_WAIT_SECONDS;
  process.env.BUDGET_RESUME_BELOW = "not-a-number";
  process.env.BUDGET_MCP_POLL_SECONDS = "not-a-number";
  process.env.BUDGET_MCP_MAX_WAIT_SECONDS = "not-a-number";
  const { waitUntilBudgetRefresh } = await import(`../mcp-tools.mjs?invalid-env=${Date.now()}`);
  if (oldResume === undefined) delete process.env.BUDGET_RESUME_BELOW; else process.env.BUDGET_RESUME_BELOW = oldResume;
  if (oldPoll === undefined) delete process.env.BUDGET_MCP_POLL_SECONDS; else process.env.BUDGET_MCP_POLL_SECONDS = oldPoll;
  if (oldMax === undefined) delete process.env.BUDGET_MCP_MAX_WAIT_SECONDS; else process.env.BUDGET_MCP_MAX_WAIT_SECONDS = oldMax;

  const dir = await mkdtemp(resolve(tmpdir(), "budget-wait-invalid-env-"));
  const fakeProbe = resolve(dir, "budget-probe");
  await writeFile(fakeProbe, "#!/usr/bin/env node\nconsole.log(JSON.stringify({ok:true,agent:'codex',util:20,hard_util:20,reset_epoch:1000,now_epoch:1001,source:'fake'}));\n", { mode: 0o755 });

  const result = await waitUntilBudgetRefresh({
    agent: "codex"
  }, {
    env: {
      ...process.env,
      BUDGET_PROBE: fakeProbe
    }
  });

  assert.equal(result.status, "ready");
  assert.equal(result.resume_below, 30);
  assert.equal(Number.isFinite(result.waited_seconds), true);
});
