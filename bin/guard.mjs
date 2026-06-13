#!/usr/bin/env node
// budget-guard CLI — see lib/guard/hook.mjs for the real implementation.
//
//   node bin/guard.mjs <agent> <phase>          (agent, phase from argv)
//   BUDGET_AGENT + BUDGET_PHASE env also accepted.
//
// stdin  : one JSON object (the hook event). Empty / malformed → silent.
// stdout : zero or one JSON object (the hook response per CC/Codex protocol).
// stderr : one diagnostic line per swallowed error.
// exit   : 0 always (fail-open); doctor uses 0-4 (probe scale).

import { checkThresholds, run, runDoctor } from '../lib/guard/hook.mjs';

async function loadBudgetConfigFailOpen() {
  try {
    const mod = await import('../lib/guard/config.mjs');
    mod.loadBudgetConfig();
  } catch (_) {
    // Older or partial deployments may not have the optional config loader yet.
  }
}

async function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) { resolve(''); return; }
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { buf += chunk; });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', () => resolve(''));
  });
}

function parseInput(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); }
  catch (_) {
    const lines = trimmed.split(/\r?\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try { return JSON.parse(lines[i]); } catch (_) { /* keep trying */ }
    }
    return null;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const envAgent = process.env.BUDGET_AGENT;
  const envPhase = process.env.BUDGET_PHASE;
  await loadBudgetConfigFailOpen(); // global + project .conf → process.env (env still wins)
  const agent = envAgent || args[0];
  const phase = envPhase || args[1];
  if (!agent || !phase) return; // silent fail-open

  const th = checkThresholds(process.env);

  if (phase === 'doctor') {
    await runDoctor(agent, th);
    return; // runDoctor calls process.exit
  }

  const raw = await readStdin();
  const input = parseInput(raw);
  const output = await run(agent, phase, input, th);
  if (output) {
    try {
      process.stdout.write(JSON.stringify(output) + '\n');
    } catch (e) {
      process.stderr.write(`guard serialize: ${e?.message || e}\n`);
    }
  }
}

main().catch((e) => {
  // Last-resort: stderr only, exit 0.
  process.stderr.write(`guard fatal: ${e?.message || e}\n`);
});
