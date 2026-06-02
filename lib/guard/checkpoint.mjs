#!/usr/bin/env node
// budget-guard — exact-match checkpoint allowlist for PreToolUse.
//
// When util >= hard, PreToolUse denies every tool except writes to the
// checkpoint file itself. isCheckpointWrite() decides whether the event
// targets the checkpoint.
//
// CRITICAL ANTI-BUG: the old bash version did `grep basename(checkpoint)`
// against the tool input, which let commands like `rm checkpoint.md` slip
// through. We require EXACT path equality after canonicalization:
//   1. tool_input.file_path / .path  (claude: Write/Edit/MultiEdit; codex: apply_patch field)
//   2. tool_input.patch / .input    (codex apply_patch text — scan for "*** Update/Add/Delete File: <p>")
// Then resolve each candidate and the configured checkpoint to an absolute
// path; canonicalize via realpath when the file exists, else via
// path.resolve. They must be byte-identical strings.
//
// Fail-open: any error in matching returns false (deny the tool). It's safer
// to over-deny (agent writes checkpoint via a different path) than to
// under-deny (agent bypasses the hard line).

import { lstatSync } from 'node:fs';
import { isAbsolute, resolve as resolvePath } from 'node:path';

// apply_patch header lines (codex-rs apply-patch grammar, lark notation):
//   *** Begin Patch
//   *** Update File: /path/to/file    (update_hunk — has "File:" suffix)
//   *** Add File: /path/to/file       (add_hunk    — has "File:" suffix)
//   *** Delete File: /path/to/file    (delete_hunk — has "File:" suffix)
//   *** Move to: /path/to/file        (change_move — NO "File:" suffix!)
//   *** End Patch
//
// Source: codex-rs/core/src/tools/handlers/apply_patch.lark
//   add_hunk:    "*** Add File: "    filename LF add_line+
//   delete_hunk: "*** Delete File: " filename LF
//   update_hunk: "*** Update File: " filename LF change_move? change?
//   change_move: "*** Move to: "     filename LF
//
// Source: codex-rs/apply-patch/src/parser.rs:41
//   pub(crate) const MOVE_TO_MARKER: &str = "*** Move to: ";
//
// Filename is the REST OF THE LINE, not a \S+ token: codex's apply_patch
// grammar treats everything after the marker (up to LF) as the filename, so
// paths may contain spaces. Capturing `\S+` would let
// `*** Update File: /tmp/checkpoint.md evil` match the checkpoint while codex
// actually targets `/tmp/checkpoint.md evil` → bypass. Capture `(.+)` and
// trim trailing whitespace/CR.
const APPLY_PATCH_WRITE_RE  = /^\*\*\* (?:Update|Add) File: (.+?)[ \t\r]*$/gm; // create/modify
const APPLY_PATCH_MOVE_RE   = /^\*\*\* Move to: (.+?)[ \t\r]*$/gm;            // move destination
const APPLY_PATCH_DELETE_RE = /^\*\*\* Delete File: (.+?)[ \t\r]*$/gm;        // removal

function matchAll(re, patch, out) {
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(patch)) !== null) out.push(m[1]);
}

// Returns { writes:[paths], deletes:[paths] }. Writes are create/modify/move
// destinations; deletes are removals. The hard line allows ONLY writes to the
// checkpoint — any delete (even of the checkpoint) is rejected because it
// erases the recovery artifact the hard line exists to preserve.
function extractFromPatch(patch) {
  const writes = [];
  const deletes = [];
  if (typeof patch !== 'string' || patch.length === 0) return { writes, deletes };
  matchAll(APPLY_PATCH_WRITE_RE, patch, writes);
  matchAll(APPLY_PATCH_MOVE_RE, patch, writes);
  matchAll(APPLY_PATCH_DELETE_RE, patch, deletes);
  return { writes, deletes };
}

function canonicalize(p) {
  if (typeof p !== 'string' || p.length === 0) return null;
  // Resolve the configured checkpoint to an absolute path string WITHOUT
  // following symlinks. We deliberately do not use realpath here:
  //
  //   - The bash version did `grep basename(checkpoint)` and let
  //     `rm checkpoint.md` and similar text matches slip through.
  //   - A first-pass Node version used realpath. That opens a symlink
  //     bypass: while util < hard, the agent runs
  //     `ln -s /etc/passwd .agent/checkpoint.md`; when util crosses hard,
  //     the candidate path resolves through the symlink to /etc/passwd and
  //     the configured checkpoint — once realpath'd — also resolves to
  //     /etc/passwd, so the comparison passes and an arbitrary file is
  //     overwritten. The whole point of this allowlist is to deny exactly
  //     that.
  //
  // Using plain resolve() avoids both bugs: the configured checkpoint is
  // never a symlink (set by installer), and write candidates are compared
  // as plain absolute paths.
  return isAbsolute(p) ? p : resolvePath(process.cwd(), p);
}

function resolveCheckpoint(checkpointPath) {
  if (typeof checkpointPath !== 'string' || checkpointPath.length === 0) return null;
  return canonicalize(checkpointPath);
}

// Returns { writes:[paths], deletes:[paths] } across all input shapes:
//   - claude Write/Edit/MultiEdit: tool_input.file_path / .path  → writes
//   - codex apply_patch:           tool_input.patch / .input     → writes+deletes
function collectCandidates(toolInput, agent) {
  const writes = [];
  const deletes = [];
  if (typeof toolInput.file_path === 'string' && toolInput.file_path.length > 0) {
    writes.push(toolInput.file_path);
  }
  if (typeof toolInput.path === 'string' && toolInput.path.length > 0) {
    writes.push(toolInput.path);
  }
  if (agent === 'codex') {
    for (const field of ['patch', 'input']) {
      if (typeof toolInput[field] === 'string') {
        const { writes: w, deletes: d } = extractFromPatch(toolInput[field]);
        writes.push(...w);
        deletes.push(...d);
      }
    }
  }
  return { writes, deletes };
}

/**
 * Returns true iff the hook event targets writing the configured checkpoint.
 *
 * @param {object} input           parsed stdin JSON
 * @param {string} agent           'claude' | 'codex'
 * @param {string} checkpointPath  configured checkpoint path (may be relative)
 */
export function isCheckpointWrite(input, agent, checkpointPath) {
  if (!input || typeof input !== 'object') return false;
  const toolInput = input.tool_input;
  if (!toolInput || typeof toolInput !== 'object') return false;

  // Operation guard: file_path/path are treated as WRITE candidates, but a
  // delete-capable tool (e.g. an MCP/extension tool whose tool_input is just
  // `{ path: <checkpoint> }`) would otherwise be allowed to ERASE the
  // checkpoint under the hard line — defeating its purpose. If the tool name
  // signals a destructive op, deny outright. apply_patch deletes are handled
  // separately via the patch text (deletes[] below).
  if (isDestructiveToolName(input.tool_name)) return false;

  const absCheckpoint = resolveCheckpoint(checkpointPath);
  if (!absCheckpoint) return false;
  // canonicalize the checkpoint ONCE so the comparison is apples-to-apples.
  // canonicalize() uses path.resolve (no symlink resolution) on both sides,
  // plus a lstat guard below to reject any write target that IS a symlink.
  const target = canonicalize(absCheckpoint);
  if (!target) return false;

  const { writes, deletes } = collectCandidates(toolInput, agent);

  // The hard line permits ONLY writing the recovery checkpoint. A delete —
  // even of the checkpoint itself — is rejected: it would erase the very
  // artifact the hard line exists to preserve, and any other delete is just
  // unrelated work that must wait. Any delete at all → deny.
  if (deletes.length > 0) return false;

  if (writes.length === 0) return false;

  // Symlink walk boundary: the project cwd. We police symlinks the agent
  // could have planted this session — cwd and below. Benign system symlinks
  // ABOVE cwd (macOS /var→/private/var, /tmp→/private/tmp) are not the threat
  // and walking into them would false-positive on every checkpoint write.
  //
  // Caveat (documented, low severity): if BUDGET_CHECKPOINT is configured as
  // an absolute path OUTSIDE cwd (non-default), only the final checkpoint
  // file's own symlink-ness is checked (see isSymlink(absPath) at the top of
  // hasSymlinkInPath), not its ancestor directories. That out-of-project
  // location is a user-chosen, trusted path; the agent cannot redirect it
  // without write access there, and a direct symlink ON the file is still
  // caught. We deliberately do NOT walk to the filesystem root for such paths
  // because that re-introduces false denials on benign system symlinks in the
  // ancestry. The default `.agent/checkpoint.md` is always inside cwd and
  // fully ancestor-protected.
  const boundary = (() => {
    try { return process.cwd(); } catch (_) { return null; }
  })();

  // ALL write candidates must equal the checkpoint. An apply_patch can touch
  // multiple paths in one event, e.g.
  //   *** Update File: .agent/checkpoint.md
  //   *** Move to: /etc/passwd
  // which extracts BOTH the checkpoint and /etc/passwd. An allow-if-ANY-match
  // rule would green-light that patch (because the checkpoint path matches),
  // letting the agent rename the checkpoint onto an arbitrary file under the
  // hard line. Require EVERY touched path to be the checkpoint: if any
  // candidate is something else, deny.
  let matchedCheckpoint = false;
  for (const c of writes) {
    const canon = canonicalize(c);
    if (!canon || canon !== target) return false; // a non-checkpoint path → deny
    // Symlink guard: deny if the target OR any ancestor directory (within the
    // project boundary) is a symlink — otherwise a write that string-matches
    // the checkpoint could be redirected (e.g. `.agent` symlinked to /etc) to
    // clobber an arbitrary file.
    if (hasSymlinkInPath(canon, boundary)) return false;
    matchedCheckpoint = true;
  }
  return matchedCheckpoint;
}

// Destructive verbs that, as a tool-name token, mean "this op removes a file".
const DESTRUCTIVE_TOKENS = new Set([
  'delete', 'del', 'remove', 'rm', 'rmdir', 'unlink', 'trash', 'destroy',
]);

// True iff the tool name contains a destructive verb as a discrete token.
// We tokenize on BOTH snake_case/punctuation AND camelCase humps so that
// `Delete`, `fs_remove`, `unlink_file`, `deleteFile`, `fsDelete`, and
// `mcp__fs__delete` all match, while benign names whose letters merely
// *contain* a verb substring (`format`, `confirm`, `transform`, `undelete`,
// `redmine`, `model`, `delta`) do NOT — they tokenize to non-verb tokens.
function isDestructiveToolName(name) {
  if (typeof name !== 'string' || name.length === 0) return false;
  const tokens = name
    // split camelCase / PascalCase humps: aB → a|B, ABc → A|Bc
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    // split on any non-alphanumeric run
    .split(/[^a-zA-Z0-9]+/)
    .map((t) => t.toLowerCase())
    .filter(Boolean);
  return tokens.some((t) => DESTRUCTIVE_TOKENS.has(t));
}

function isSymlink(absPath) {
  // lstatSync (NOT statSync) so we don't follow the link. Throws on ENOENT
  // (file doesn't exist yet — that's fine, the write creates it). Any other
  // error also means "treat as not a symlink".
  try {
    return lstatSync(absPath).isSymbolicLink();
  } catch (_) {
    return false;
  }
}

// Reject if the target file OR any ancestor directory WITHIN THE PROJECT
// (down to, but not above, the boundary dir) is a symlink. Checking only the
// final path leaves an ancestor-symlink bypass: e.g. while util < hard the
// agent runs `ln -s /etc .agent`, then a hard-line write to
// `.agent/checkpoint.md` string-matches the configured checkpoint and the
// final component isn't itself a symlink, but the write lands in /etc.
//
// The walk STOPS at `boundary` (the project cwd). Components at or above the
// boundary are not agent-controllable within a session and are commonly
// benign system symlinks (macOS `/var`→`/private/var`, `/tmp`→`/private/tmp`)
// — walking into them would false-positive on every write. We only police
// the agent-controllable region: boundary's descendants down to the target.
function hasSymlinkInPath(absPath, boundary) {
  if (isSymlink(absPath)) return true;
  const stop = boundary && isAbsolute(boundary) ? boundary : null;
  let dir = absPath;
  for (;;) {
    const parent = resolvePath(dir, '..');
    if (parent === dir) break;            // reached filesystem root
    if (stop && parent === stop) break;   // reached project boundary — stop
    if (stop && !dir.startsWith(stop + '/') && dir !== stop) break; // left project subtree
    if (isSymlink(parent)) return true;
    dir = parent;
  }
  return false;
}
