import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const probe = resolve(root, "budget-probe");

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
