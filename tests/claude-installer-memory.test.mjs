import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { install, uninstall, MARK_END, MARK_START } from "../lib/installer/claude.mjs";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("claude installer preserves marker examples and replaces CLAUDE.md block in place", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "budget-claude-memory-home-"));
  const claudeDir = resolve(home, ".claude");
  await mkdir(claudeDir, { recursive: true });

  const memoryPath = resolve(claudeDir, "CLAUDE.md");
  const markerExample = [
    "```md",
    MARK_START,
    "## 额度守卫协议(自动安装,无需手动配置)",
    "example only; do not treat this as managed",
    MARK_END,
    "```"
  ].join("\n");
  await writeFile(memoryPath, [
    "# Existing CLAUDE",
    markerExample,
    "",
    "before managed block",
    `${MARK_START} adjacent text should not count`,
    "text after adjacent marker",
    `${MARK_END} adjacent text should not count`,
    "broken example before managed block",
    MARK_START,
    "example start only; should stay as user content",
    "",
    "user content between broken example and real managed block",
    MARK_START,
    "## 额度守卫协议(自动安装,无需手动配置)",
    "old managed block",
    MARK_END,
    MARK_START,
    "## 额度守卫协议(自动安装,无需手动配置)",
    "duplicate old managed block",
    MARK_END,
    "after managed block"
  ].join("\n") + "\n");

  const result = install({ home, srcRoot: root, skipDoctor: true });
  const installed = await readFile(memoryPath, "utf8");
  assert.match(installed, new RegExp(escapeRe(markerExample)));
  assert.match(installed, /example start only; should stay as user content/);
  assert.match(installed, /user content between broken example and real managed block/);
  assert.match(installed, /<!-- budget-guard:start --> adjacent text should not count/);
  assert.match(installed, /<!-- budget-guard:end --> adjacent text should not count/);
  assert.doesNotMatch(installed, /old managed block/);
  assert.doesNotMatch(installed, /duplicate old managed block/);
  assert.equal((installed.match(/<!-- budget-guard:start -->/g) || []).length, 4);
  assert.equal((installed.match(/你运行在一个会监控订阅额度的环境里/g) || []).length, 1);
  assert.ok(
    installed.indexOf("after managed block") > installed.lastIndexOf(MARK_END),
    "content after a managed block stays after the replacement"
  );

  install({ home, srcRoot: root, skipDoctor: true });
  const reinstalled = await readFile(memoryPath, "utf8");
  assert.equal(reinstalled, installed, "CLAUDE.md protocol replacement is byte-idempotent");

  uninstall({
    settingsPath: result.settingsPath,
    memoryPath: result.memoryPath,
    binDir: result.binDir,
    claudeDir: result.claudeDir
  });
  const uninstalled = await readFile(memoryPath, "utf8");
  assert.match(uninstalled, new RegExp(escapeRe(markerExample)));
  assert.match(uninstalled, /example start only; should stay as user content/);
  assert.match(uninstalled, /user content between broken example and real managed block/);
  assert.match(uninstalled, /<!-- budget-guard:start --> adjacent text should not count/);
  assert.match(uninstalled, /<!-- budget-guard:end --> adjacent text should not count/);
  assert.doesNotMatch(uninstalled, /你运行在一个会监控订阅额度的环境里/);
  assert.equal((uninstalled.match(/<!-- budget-guard:start -->/g) || []).length, 3);
  assert.ok(uninstalled.indexOf("after managed block") > uninstalled.indexOf("before managed block"));
});

test("claude installer preserves indented marker examples as Markdown code blocks", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "budget-claude-indented-marker-home-"));
  const claudeDir = resolve(home, ".claude");
  await mkdir(claudeDir, { recursive: true });

  const memoryPath = resolve(claudeDir, "CLAUDE.md");
  const indentedExample = [
    `    ${MARK_START}`,
    "    ## 额度守卫协议(自动安装,无需手动配置)",
    "    example only; should remain as indented code",
    `    ${MARK_END}`
  ].join("\n");
  await writeFile(memoryPath, [
    "# Existing CLAUDE",
    "",
    indentedExample,
    "",
    "after"
  ].join("\n") + "\n");

  const result = install({ home, srcRoot: root, skipDoctor: true });
  uninstall({
    settingsPath: result.settingsPath,
    memoryPath: result.memoryPath,
    binDir: result.binDir,
    claudeDir: result.claudeDir
  });
  const uninstalled = await readFile(memoryPath, "utf8");
  assert.match(uninstalled, new RegExp(escapeRe(indentedExample)));
  assert.match(uninstalled, /after/);
});

test("claude installer removes only managed hooks inside shared settings.json entries", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "budget-claude-settings-home-"));
  const claudeDir = resolve(home, ".claude");
  await mkdir(claudeDir, { recursive: true });

  const settingsPath = resolve(claudeDir, "settings.json");
  await writeFile(settingsPath, JSON.stringify({
    hooks: {
      PreToolUse: [
        {
          matcher: "Bash|Edit",
          hooks: [
            { type: "command", command: "echo user-keep", timeout: 9 },
            { type: "command", command: "/old/.budget-guard/bin/guard.mjs claude pre", timeout: 30 }
          ]
        },
        {
          matcher: "Read",
          hooks: [{ type: "command", command: "echo read-keep", timeout: 9 }]
        }
      ]
    }
  }, null, 2) + "\n");

  const result = install({ home, srcRoot: root, skipDoctor: true });
  const installed = JSON.parse(await readFile(settingsPath, "utf8"));
  const shared = installed.hooks.PreToolUse.find((entry) => entry.matcher === "Bash|Edit");
  assert.deepEqual(shared.hooks.map((hook) => hook.command), ["echo user-keep"]);
  assert.deepEqual(
    installed.hooks.PreToolUse.find((entry) => entry.matcher === "Read").hooks.map((hook) => hook.command),
    ["echo read-keep"]
  );
  assert.equal(
    installed.hooks.PreToolUse.filter((entry) => entry.hooks?.some((hook) => /guard\.mjs claude pre/.test(hook.command))).length,
    1
  );

  uninstall({
    settingsPath: result.settingsPath,
    memoryPath: result.memoryPath,
    binDir: result.binDir,
    claudeDir: result.claudeDir
  });
  const uninstalled = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.deepEqual(uninstalled.hooks.PreToolUse.find((entry) => entry.matcher === "Bash|Edit").hooks.map((hook) => hook.command), ["echo user-keep"]);
  assert.deepEqual(uninstalled.hooks.PreToolUse.find((entry) => entry.matcher === "Read").hooks.map((hook) => hook.command), ["echo read-keep"]);
  assert.equal(
    uninstalled.hooks.PreToolUse.some((entry) => entry.hooks?.some((hook) => /guard\.mjs claude pre/.test(hook.command))),
    false
  );
});

test("claude installer recognizes managed hook commands when HOME contains spaces", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "budget claude space home "));
  const claudeDir = resolve(home, ".claude");
  await mkdir(claudeDir, { recursive: true });

  const result = install({ home, srcRoot: root, skipDoctor: true });
  install({ home, srcRoot: root, skipDoctor: true });

  const installed = JSON.parse(await readFile(result.settingsPath, "utf8"));
  assert.equal(
    installed.hooks.PreToolUse.filter((entry) => entry.hooks?.some((hook) => /guard\.mjs claude pre/.test(hook.command))).length,
    1
  );

  uninstall({
    settingsPath: result.settingsPath,
    memoryPath: result.memoryPath,
    binDir: result.binDir,
    claudeDir: result.claudeDir
  });
  const uninstalled = JSON.parse(await readFile(result.settingsPath, "utf8"));
  assert.equal(
    uninstalled.hooks?.PreToolUse?.some((entry) => entry.hooks?.some((hook) => /guard\.mjs claude pre/.test(hook.command))),
    undefined
  );
});

test("claude bash fallback can uninstall managed hooks when node is unavailable", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "budget-claude-no-node-home-"));
  const claudeDir = resolve(home, ".claude");
  await mkdir(claudeDir, { recursive: true });
  const settingsPath = resolve(claudeDir, "settings.json");
  await writeFile(settingsPath, JSON.stringify({
    hooks: {
      PreToolUse: [
        {
          hooks: [
            { type: "command", command: "echo user-keep", timeout: 9 },
            { type: "command", command: "/old/.budget-guard/bin/budget_guard.sh claude pre", timeout: 15 }
          ]
        }
      ]
    }
  }, null, 2) + "\n");

  const python = (await execFileAsync("python3", ["-c", "import sys; print(sys.executable)"])).stdout.trim();
  const fakeBin = resolve(home, "fake-bin");
  await mkdir(fakeBin, { recursive: true });
  await writeFile(resolve(fakeBin, "python3"), `#!/bin/sh\nexec "${python}" "$@"\n`, { mode: 0o755 });
  await writeFile(resolve(fakeBin, "dirname"), "#!/bin/sh\nexec /usr/bin/dirname \"$@\"\n", { mode: 0o755 });

  await execFileAsync("/bin/bash", [resolve(root, "claude-budget-guard", "install.sh"), "--uninstall"], {
    cwd: root,
    env: { ...process.env, HOME: home, PATH: fakeBin },
    timeout: 20_000
  });

  const uninstalled = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.deepEqual(uninstalled.hooks.PreToolUse[0].hooks.map((hook) => hook.command), ["echo user-keep"]);
});

test("claude installer deploys only runtime bin files, not the installer CLIs", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "budget-claude-binwhitelist-home-"));
  const claudeDir = resolve(home, ".claude");
  await mkdir(claudeDir, { recursive: true });

  const result = install({ home, srcRoot: root, skipDoctor: true });
  const deployed = (await readdir(result.binDir)).sort();

  // runtime executables MUST be deployed
  assert.ok(deployed.includes("probe.mjs"), "probe.mjs should be deployed");
  assert.ok(deployed.includes("guard.mjs"), "guard.mjs should be deployed");
  assert.ok(deployed.includes("budget-probe"), "bash budget-probe should be deployed for watchdog/MCP compatibility");
  assert.ok(deployed.includes("budget_guard.sh"), "bash budget_guard.sh should be deployed for upgrade/uninstall parity");
  assert.ok(deployed.includes("watchdog.sh"), "watchdog.sh should be deployed for README cron/launchd usage");
  assert.ok(deployed.includes("budget-config.sh"), "budget-config.sh should be deployed for bash runtime config loading");
  // installer-only CLIs MUST NOT pollute the user's runtime bin dir
  assert.ok(!deployed.includes("cli.mjs"), "cli.mjs (npx launcher) must not be deployed");
  assert.ok(
    !deployed.includes("install-claude.mjs"),
    "install-claude.mjs (installer shim) must not be deployed"
  );
  assert.ok(!deployed.includes("install.sh"), "bash install.sh must not be deployed");
});
