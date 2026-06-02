#!/usr/bin/env bash
# P0-2 — real claude at hard line: writing the checkpoint is ALLOWED while
# writing any other file is DENIED. Proves pre-phase exact checkpoint allowlist
# in a genuine Claude Code process (not just unit-level isCheckpointWrite).
#
# Detection: two marker files via the Write tool —
#   - .agent/checkpoint.md  → MUST be created (allowed)
#   - notes-OTHER.md        → MUST NOT be created (denied)
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
GUARD="$REPO/bin/guard.mjs"
HARD_FIX="$REPO/tests/e2e/fixture-hard.json"
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); printf '  ✓ %s\n' "$*"; }
bad(){ FAIL=$((FAIL+1)); printf '  ✗ %s\n' "$*"; }

work="$(mktemp -d)"; state="$(mktemp -d)"; out="$(mktemp)"; sess="e2e_cp_$$"
mkdir -p "$work/.agent"
# inject pre hook for write-ish tools, fixture baked in
hooks=$(GUARD="$GUARD" FIX="$HARD_FIX" STATE="$state" node -e '
  const cmd=`BUDGET_USAGE_FIXTURE=${process.env.FIX} BUDGET_STATE_DIR=${process.env.STATE} node ${process.env.GUARD} claude pre`;
  process.stdout.write(JSON.stringify({hooks:{PreToolUse:[{matcher:"Write|Edit|MultiEdit",hooks:[{type:"command",command:cmd,timeout:30}]}]}}));')
prompt='You are at a hard budget limit. Do exactly two things with the Write tool, in order: (1) Write the file .agent/checkpoint.md with content "CP". (2) Write the file notes-OTHER.md with content "X". Attempt both even if one is blocked.'

tmux new-session -d -s "$sess" -x 200 -y 50
tmux send-keys -t "$sess" \
  "cd $work && claude -p $(printf %q "$prompt") --allowedTools 'Write' --max-turns 6 --output-format json --settings $(printf %q "$hooks") > $out 2>&1; echo __DONE_\$?__ >> $out" Enter
for i in $(seq 1 150); do grep -q "__DONE_" "$out" 2>/dev/null && break; sleep 1; done
tmux kill-session -t "$sess" 2>/dev/null

echo "== P0-2: checkpoint write ALLOWED, other write DENIED (real claude, util=95) =="
if grep -q "__DONE_" "$out" 2>/dev/null; then
  [ -e "$work/.agent/checkpoint.md" ] && ok "checkpoint .agent/checkpoint.md created (allowed)" || bad "checkpoint NOT created — pre wrongly denied the checkpoint write"
  if [ -e "$work/notes-OTHER.md" ]; then bad "notes-OTHER.md WAS created — pre failed to deny non-checkpoint write"; else
    grep -qiE "硬线|92%|只写|deny" "$out" && ok "non-checkpoint write denied (file absent AND deny surfaced)" || bad "notes-OTHER.md absent but no deny evidence — inconclusive"
  fi
else
  bad "claude did not finish within timeout"; sed -n '1,30p' "$out"
fi
rm -rf "$work" "$state"
echo "== result: PASS=$PASS FAIL=$FAIL =="
[ "$FAIL" -eq 0 ] && [ "$PASS" -ge 2 ]
