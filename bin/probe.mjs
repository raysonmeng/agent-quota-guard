#!/usr/bin/env node
// budget-probe CLI.
//
//   node bin/probe.mjs <agent> probe                     → normalized JSON on stdout
//   node bin/probe.mjs <agent> probe --fixture <path>    → parse fixture, no network
//   node bin/probe.mjs <agent> doctor                    → human-readable diagnostics
//
// Exit codes (probe & doctor share the same scale):
//   0 ok            1 warning (e.g. 429 gate active)
//   2 partial info  3 schema empty (unrecognized response shape)
//   4 config invalid (doctor only; probe continues with built-in defaults)
//
// Env: BUDGET_USAGE_FIXTURE, BUDGET_NOW_EPOCH, BUDGET_CACHE_TTL,
//      BUDGET_STATE_DIR, BUDGET_SOFT/WARN_ONCE/WARN_REPEAT/HARD.

import { fetchUsage, doctor } from '../lib/probe/index.mjs';

async function loadBudgetConfigFailOpen() {
  try {
    const mod = await import('../lib/guard/config.mjs');
    mod.loadBudgetConfig();
  } catch (_) {
    // Older or partial deployments may not have the optional config loader yet.
  }
}

function parseArgs(argv) {
  const [agent, cmd, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--fixture' && rest[i + 1]) { opts.fixture = rest[++i]; continue; }
    if (a === '--help' || a === '-h')     { opts.help = true; continue; }
  }
  return { agent, cmd, opts };
}

function usage() {
  process.stdout.write(
    'usage: probe.mjs <agent> <probe|doctor> [--fixture <path>]\n' +
    '  agent: claude | codex\n' +
    '  env:   BUDGET_USAGE_FIXTURE BUDGET_NOW_EPOCH BUDGET_CACHE_TTL\n' +
    '         BUDGET_STATE_DIR BUDGET_WARN_ONCE BUDGET_WARN_REPEAT BUDGET_HARD\n');
}

async function main() {
  const { agent, cmd, opts } = parseArgs(process.argv.slice(2));
  if (opts.help || !agent || !cmd) { usage(); process.exit(agent ? 0 : 2); }

  await loadBudgetConfigFailOpen(); // global + project .conf → process.env (env still wins)

  if (cmd === 'probe') {
    const result = await fetchUsage(agent, { fixture: opts.fixture });
    process.stdout.write(JSON.stringify(result) + '\n');
    // probe exit codes: best-effort signal. Source consumers should read JSON.
    if (!result.ok) {
      if (result.rate_limited_until) process.exit(1);
      if (Array.isArray(result.buckets) && result.buckets.length === 0) process.exit(3);
      process.exit(2);
    }
    process.exit(0);
  }

  if (cmd === 'doctor') {
    const d = await doctor(agent);
    process.stdout.write(`doctor[${agent}]: ${d.code === 0 ? 'OK' : `EXIT=${d.code}`}\n`);
    process.stdout.write(`  thresholds: warnOnce=${d.thresholds.warnOnce} warnRepeat=${d.thresholds.warnRepeat} hard=${d.thresholds.hard}\n`);
    for (const c of d.checks) {
      process.stdout.write(`  [${c.ok ? '+' : '-'}] ${c.name}: ${c.detail}\n`);
    }
    if (d.probe && Array.isArray(d.probe.buckets)) {
      for (const b of d.probe.buckets) {
        const tag = b.id === d.probe.bucket_id ? '*' : ' ';
        const r = b.reset_epoch > 0 ? new Date(b.reset_epoch * 1000).toISOString() : '<no reset>';
        process.stdout.write(`    ${tag} ${b.id}: util=${b.util} resettable=${b.resettable} resets_at=${r}\n`);
      }
      if (d.probe.extra_usage) {
        process.stdout.write(`      extra_usage: util=${d.probe.extra_usage.util} enabled=${d.probe.extra_usage.is_enabled}\n`);
      }
    }
    process.exit(d.code);
  }

  usage();
  process.exit(2);
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ ok: false, error: `cli_threw:${e && e.message || e}` }) + '\n');
  process.exit(2);
});
