#!/usr/bin/env bash
# tmux-hook-e2e.sh — real-machine E2E: run a REAL `claude -p` inside a tmux
# pane with our PreToolUse hook injected via --settings, driven by a mock
# usage fixture. Asserts the hook actually DENIES (at hard line) / ALLOWS
# (below thresholds) a tool in a genuine Claude Code process.
#
# Detection is file-based and unambiguous: the agent is asked to `touch` a
# marker file via the Bash tool. If the hook denies the tool, the file is
# NOT created; if allowed, it is. No transcript parsing.
#
#   ./tmux-hook-e2e.sh
#
# Burns a small amount of real tokens (2 short headless turns). Requires:
# claude CLI logged in, tmux, node.
set -uo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
GUARD="$REPO/bin/guard.mjs"
HARD_FIX="$REPO/tests/e2e/fixture-hard.json"   # 95%
LOW_FIX="$REPO/tests/e2e/fixture-low.json"     # 20%
PASS=0; FAIL=0
note(){ printf '%s\n' "$*"; }
ok(){ PASS=$((PASS+1)); note "  ✓ $*"; }
bad(){ FAIL=$((FAIL+1)); note "  ✗ $*"; }

run_phase() { # <name> <fixture> <marker_file>
  local name="$1" fix="$2" marker="$3"
  local state out hooks sess prompt
  rm -f "$marker"
  state="$(mktemp -d)"; out="$(mktemp)"; sess="e2e_${name}_$$"
  prompt="Use the Bash tool to run this exact command and nothing else: touch ${marker}"
  hooks=$(GUARD="$GUARD" FIX="$fix" STATE="$state" node -e '
    const h={hooks:{PreToolUse:[{matcher:"Bash",hooks:[{type:"command",
      command:`BUDGET_USAGE_FIXTURE=${process.env.FIX} BUDGET_STATE_DIR=${process.env.STATE} node ${process.env.GUARD} claude pre`,
      timeout:30}]}]}};
    process.stdout.write(JSON.stringify(h));')
  tmux new-session -d -s "$sess" -x 200 -y 50
  tmux send-keys -t "$sess" \
    "cd $REPO && claude -p $(printf %q "$prompt") --allowedTools Bash --max-turns 4 --output-format json --settings $(printf %q "$hooks") > $out 2>&1; echo __E2E_DONE_\$?__ >> $out" Enter
  local i
  for i in $(seq 1 150); do grep -q "__E2E_DONE_" "$out" 2>/dev/null && break; sleep 1; done
  tmux kill-session -t "$sess" 2>/dev/null
  LAST_OUT="$out"
}

MARK_HARD="/tmp/e2e_hard_marker_$$"
MARK_LOW="/tmp/e2e_low_marker_$$"

note "== Phase 1: util=95% (hard line) — Bash touch must be DENIED (no marker file) =="
run_phase hard "$HARD_FIX" "$MARK_HARD"
if grep -q "__E2E_DONE_" "$LAST_OUT" 2>/dev/null; then
  if [ -e "$MARK_HARD" ]; then
    bad "hard: marker file WAS created — hook did NOT deny the Bash tool"
  else
    ok "hard: marker file NOT created — Bash denied by guard at hard line"
  fi
  # bonus: confirm the deny reason actually surfaced in the run
  grep -qiE "硬线|92%|只写|deny" "$LAST_OUT" && note "    (deny reason surfaced in transcript ✓)"
else
  bad "hard: claude did not finish within timeout"; sed -n '1,30p' "$LAST_OUT"
fi

note ""
note "== Phase 2: util=20% (below thresholds) — Bash touch must be ALLOWED (marker file created) =="
run_phase low "$LOW_FIX" "$MARK_LOW"
if grep -q "__E2E_DONE_" "$LAST_OUT" 2>/dev/null; then
  if [ -e "$MARK_LOW" ]; then
    ok "low: marker file created — Bash allowed below thresholds"
  else
    bad "low: marker file NOT created — Bash unexpectedly blocked (or agent didn't run it)"; sed -n '1,30p' "$LAST_OUT"
  fi
else
  bad "low: claude did not finish within timeout"; sed -n '1,30p' "$LAST_OUT"
fi

rm -f "$MARK_HARD" "$MARK_LOW"
note ""
note "== E2E result: PASS=$PASS FAIL=$FAIL =="
[ "$FAIL" -eq 0 ] && [ "$PASS" -ge 2 ]
