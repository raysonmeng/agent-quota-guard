#!/usr/bin/env node
// bin/install-claude.mjs — CLI shim for the Claude Code installer.
//
//   node bin/install-claude.mjs              → install (idempotent)
//   node bin/install-claude.mjs --uninstall  → remove only what we added
//   node bin/install-claude.mjs --project    → write CLAUDE.md into ./CLAUDE.md
//   node bin/install-claude.mjs --skip-doctor→ skip the post-install doctor check
//   node bin/install-claude.mjs --src <path> → override source root (advanced)
//   node bin/install-claude.mjs --help       → this message
//
// All real work lives in lib/installer/claude.mjs. This shim is just argv
// parsing + exit-code wiring.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { install, uninstall } from '../lib/installer/claude.mjs';

const USAGE = `usage: node bin/install-claude.mjs [options]

  --uninstall         Remove hooks + CLAUDE.md protocol (leaves ~/.budget-guard/)
  --project           Write CLAUDE.md into ./CLAUDE.md (project-local) instead of
                      ~/.claude/CLAUDE.md (user-global, the default)
  --skip-doctor       Skip the post-install probe.mjs doctor self-check
  --src <path>        Source tree root (default: <bin>/.., the in-tree checkout)
  --help              Show this message

Exit codes:
  0  success (install completed; doctor warnings are non-fatal)
  1  hard error (settings.json unparseable, permission denied, etc.)
  2  invalid usage

All real work is in lib/installer/claude.mjs.
`;

function parseArgs(argv) {
  const opts = { mode: 'install' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--uninstall')   { opts.mode = 'uninstall'; continue; }
    if (a === '--project')     { opts.project = true; continue; }
    if (a === '--skip-doctor') { opts.skipDoctor = true; continue; }
    if (a === '--src')         { opts.srcRoot = argv[++i]; continue; }
    if (a === '--help' || a === '-h') { opts.help = true; continue; }
    throw new Error(`unknown_arg: ${a}`);
  }
  return opts;
}

function defaultSrcRoot() {
  // bin/install-claude.mjs → .. is the source root
  const here = dirname(fileURLToPath(import.meta.url));
  return dirname(here);
}

function resolveHome() {
  return process.env.HOME || process.env.USERPROFILE;
}

function main() {
  const homedir = resolveHome();
  if (!homedir) {
    process.stderr.write('✗  HOME not set (and USERPROFILE also absent)\n');
    process.exit(1);
  }

  let opts;
  try { opts = parseArgs(process.argv.slice(2)); }
  catch (e) { process.stderr.write(`✗  ${e.message}\n\n${USAGE}`); process.exit(2); }
  if (opts.help) { process.stdout.write(USAGE); process.exit(0); }

  const srcRoot = opts.srcRoot || defaultSrcRoot();
  const project = !!opts.project;
  const cwd = process.cwd();
  const budgetDir  = join(homedir, '.budget-guard');
  const claudeDir  = join(homedir, '.claude');
  const binDir     = join(budgetDir, 'bin');
  const settingsPath = join(claudeDir, 'settings.json');
  const memoryPath = project ? join(cwd, 'CLAUDE.md') : join(claudeDir, 'CLAUDE.md');

  try {
    if (opts.mode === 'uninstall') {
      uninstall({ settingsPath, memoryPath, binDir, claudeDir });
      process.exit(0);
    }
    install({
      srcRoot,
      home: homedir,
      cwd,
      project,
      skipDoctor: opts.skipDoctor,
    });
    process.exit(0);
  } catch (e) {
    process.stderr.write(`✗  ${e && e.message || e}\n`);
    if (e && e.stack) process.stderr.write(e.stack + '\n');
    process.exit(1);
  }
}

main();
