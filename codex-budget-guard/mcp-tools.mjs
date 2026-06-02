import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_AGENT = "codex";
const FALLBACK_RESUME_BELOW = 30;
const FALLBACK_POLL_SECONDS = 180;
const FALLBACK_MAX_WAIT_SECONDS = 700000;

async function executable(path) {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function findBudgetProbe(env = process.env) {
  const candidates = [
    env.BUDGET_PROBE,
    resolve(env.HOME || homedir(), ".budget-guard/bin/budget-probe")
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (await executable(candidate)) return candidate;
  }
  throw new Error("budget-probe not found");
}

function assertAgent(agent) {
  const value = agent || DEFAULT_AGENT;
  if (!["claude", "codex"].includes(value)) throw new Error("agent must be claude or codex");
  return value;
}

function normalizeProbeResult(value, agent) {
  const result = typeof value === "string" ? JSON.parse(value) : value;
  if (!result || typeof result !== "object") throw new Error("budget-probe returned non-object JSON");
  if (result.ok === false) {
    return {
      ...result,
      ok: false,
      agent: result.agent || agent,
      hard_util: null,
      now_epoch: Number(result.now_epoch || result.fetched_at || Math.floor(Date.now() / 1000))
    };
  }
  const util = Number(result.util);
  if (!Number.isFinite(util)) throw new Error("budget-probe result missing numeric util");
  const hardUtil = Number(result.hard_util ?? result.hard_utilization ?? util);
  if (!Number.isFinite(hardUtil)) throw new Error("budget-probe result missing numeric hard_util");
  return {
    ...result,
    ok: result.ok ?? true,
    agent: result.agent || agent,
    util,
    hard_util: hardUtil,
    reset_epoch: Number(result.reset_epoch || result.reset || 0),
    now_epoch: Number(result.now_epoch || result.fetched_at || Math.floor(Date.now() / 1000)),
    source: result.source || "budget-probe"
  };
}

export async function checkBudget(args = {}, options = {}) {
  const env = options.env || process.env;
  const agent = assertAgent(args.agent);
  let probe;
  try {
    probe = await findBudgetProbe(env);
  } catch (error) {
    return {
      ok: false,
      agent,
      error: "probe_not_found",
      message: error?.message || String(error),
      hard_util: null,
      now_epoch: Math.floor(Date.now() / 1000)
    };
  }
  let stdout;
  try {
    ({ stdout } = await execFileAsync(probe, ["--agent", agent], {
      env,
      timeout: options.timeout_ms || 10_000,
      maxBuffer: 1024 * 1024
    }));
  } catch (error) {
    stdout = error?.stdout;
    if (!stdout) {
      return {
        ok: false,
        agent,
        error: "probe_exec_failed",
        message: error?.message || String(error),
        exit_code: error?.code,
        hard_util: null,
        now_epoch: Math.floor(Date.now() / 1000)
      };
    }
  }
  return normalizeProbeResult(stdout, agent);
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function numberOrDefault(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
}

function envNumberOrDefault(env, key, fallback) {
  const numeric = Number(env?.[key]);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
}

function pollSecondsOrDefault(value, fallback) {
  return Math.max(1, numberOrDefault(value, fallback));
}

function isBelowResumeThreshold(probeResult, resumeBelow) {
  if (probeResult?.ok === false || probeResult?.hard_util == null) return false;
  const hardUtil = Number(probeResult.hard_util);
  return Number.isFinite(hardUtil) && hardUtil < resumeBelow;
}

export async function waitUntilBudgetRefresh(args = {}, options = {}) {
  const env = options.env || process.env;
  const agent = assertAgent(args.agent);
  const resumeBelow = numberOrDefault(
    args.resume_below,
    envNumberOrDefault(env, "BUDGET_RESUME_BELOW", FALLBACK_RESUME_BELOW)
  );
  const pollSeconds = pollSecondsOrDefault(
    args.poll_seconds,
    envNumberOrDefault(env, "BUDGET_MCP_POLL_SECONDS", FALLBACK_POLL_SECONDS)
  );
  const maxWaitSeconds = numberOrDefault(
    args.max_wait_seconds,
    envNumberOrDefault(env, "BUDGET_MCP_MAX_WAIT_SECONDS", FALLBACK_MAX_WAIT_SECONDS)
  );
  const startedAt = Math.floor(Date.now() / 1000);
  const deadline = Date.now() + maxWaitSeconds * 1000;
  let probes = 0;
  let last = null;

  while (Date.now() <= deadline) {
    last = await checkBudget({ agent }, options);
    probes += 1;
    if (isBelowResumeThreshold(last, resumeBelow)) {
      return {
        status: "ready",
        agent,
        resume_below: resumeBelow,
        probes,
        waited_seconds: Math.max(0, last.now_epoch - startedAt),
        final: last
      };
    }

    const now = Number(last.now_epoch || Math.floor(Date.now() / 1000));
    if (last.ok !== false && last.reset_epoch > 0 && now >= last.reset_epoch) {
      const fresh = await checkBudget({ agent }, options);
      probes += 1;
      if (isBelowResumeThreshold(fresh, resumeBelow)) {
        return {
          status: "ready",
          agent,
          resume_below: resumeBelow,
          probes,
          waited_seconds: Math.max(0, fresh.now_epoch - startedAt),
          final: fresh
        };
      }
      last = fresh;
    }

    await sleep(Math.min(pollSeconds * 1000, Math.max(0, deadline - Date.now())));
  }

  return {
    status: "timeout",
    agent,
    resume_below: resumeBelow,
    probes,
    waited_seconds: maxWaitSeconds,
    final: last
  };
}
