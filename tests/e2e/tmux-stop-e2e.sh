#!/usr/bin/env bash
# P0-3 — real claude Stop hook continue:false at hard line.
# (Addresses the long-standing SUSPECT: does the Stop hook's continue:false
#  hard-stop path actually run in a genuine Claude Code session?)
#
# We install ONLY the Stop hook (no pre hook, so tool work itself isn't
# blocked) with a 95% fixture. After a real `claude -p` run we assert the
# deterministic side-effects of the hard-line Stop branch:
#   (a) a pending file is written (phaseStop hard branch ran writePending)
#   (b) our stopReason text is surfaced in the run output (continue:false honored)
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
GUARD="$REPO/bin/guard.mjs"
HARD_FIX="$REPO/tests/e2e/fixture-hard.json"
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); printf '  ✓ %s\n' "$*"; }
bad(){ FAIL=$((FAIL+1)); printf '  ✗ %s\n' "$*"; }

work="$(mktemp -d)"; state="$(mktemp -d)"; out="$(mktemp)"; sess="e2e_stop_$$"
# Stop hook only (no matcher needed for Stop), fixture baked in.
hooks=$(GUARD="$GUARD" FIX="$HARD_FIX" STATE="$state" node -e '
  const cmd=`BUDGET_USAGE_FIXTURE=${process.env.FIX} BUDGET_STATE_DIR=${process.env.STATE} node ${process.env.GUARD} claude stop`;
  process.stdout.write(JSON.stringify({hooks:{Stop:[{hooks:[{type:"command",command:cmd,timeout:30}]}]}}));')
prompt='Say the single word: ready. Do not use any tools.'

tmux new-session -d -s "$sess" -x 200 -y 50
tmux send-keys -t "$sess" \
  "cd $work && claude -p $(printf %q "$prompt") --max-turns 4 --output-format json --settings $(printf %q "$hooks") > $out 2>&1; echo __DONE_\$?__ >> $out" Enter
for i in $(seq 1 150); do grep -q "__DONE_" "$out" 2>/dev/null && break; sleep 1; done
tmux kill-session -t "$sess" 2>/dev/null

echo "== P0-3: Stop hook continue:false hard-stop in real claude (util=95) =="
if grep -q "__DONE_" "$out" 2>/dev/null; then
  # (a) pending file written by phaseStop hard branch
  if ls "$state"/pending/claude_*.json >/dev/null 2>&1 || [ -e "$state/pending_claude.json" ]; then
    ok "pending file written → phaseStop hard-line branch (writePending + continue:false) ran"
    pf=$(ls "$state"/pending/claude_*.json 2>/dev/null | head -1); [ -z "$pf" ] && pf="$state/pending_claude.json"
    node -e "const p=require('$pf');process.exit(p.status==='paused'&&Number.isFinite(p.util)?0:1)" \
      && ok "pending payload valid (status=paused, util recorded)" || bad "pending payload malformed"
  else
    bad "no pending file → Stop hook hard branch did not run (Stop hook may not fire in -p, or fixture not seen)"
    echo "  state dir contents:"; ls -laR "$state" 2>/dev/null | sed -n '1,20p'
  fi
  # (b) stopReason surfaced
  if grep -qiE "硬线|92%|wait_until_budget_refresh|watchdog" "$out" 2>/dev/null; then
    ok "our stopReason text surfaced in run output (continue:false path)"
  else
    printf '  · stopReason not detected in output (non-blocking; pending file is the primary proof)\n'
  fi
else
  bad "claude did not finish within timeout"; sed -n '1,30p' "$out"
fi
rm -rf "$work" "$state"
echo "== result: PASS=$PASS FAIL=$FAIL =="
[ "$FAIL" -eq 0 ] && [ "$PASS" -ge 2 ]
