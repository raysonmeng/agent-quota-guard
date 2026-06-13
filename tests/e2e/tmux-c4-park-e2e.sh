#!/usr/bin/env bash
# P0-5 — claude C4 park: a REAL claude agent calls the budget-guard MCP tool
# wait_until_budget_refresh, which BLOCKS while usage is high, then returns
# once a background flip drops the fixture from 95% → 20%. The agent then
# continues IN THE SAME TURN and creates a post-wait marker.
#
# Asserts:
#   - post-wait marker created (agent resumed work after the tool returned)
#   - marker mtime is AFTER the flip (proves it actually parked/blocked,
#     i.e. it did not skip straight through)
#
# Requires: codex-budget-guard/node_modules (MCP SDK) installed.
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
MCP="$REPO/codex-budget-guard/mcp-server.mjs"
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); printf '  ✓ %s\n' "$*"; }
bad(){ FAIL=$((FAIL+1)); printf '  ✗ %s\n' "$*"; }

[ -d "$REPO/codex-budget-guard/node_modules/@modelcontextprotocol" ] || { echo "SKIP: MCP SDK not installed (run: npm install --prefix codex-budget-guard)"; exit 2; }

work="$(mktemp -d)"; state="$(mktemp -d)"; out="$(mktemp)"; sess="e2e_c4_$$"
FIXFILE="$state/live-fixture.json"
cp "$REPO/tests/e2e/fixture-hard.json" "$FIXFILE"   # start at 95%
MARK="$work/DONE_AFTER_WAIT.txt"

# probe wrapper the MCP server will call (reads the controllable FIXFILE)
probe="$state/probe-wrap.sh"
cat > "$probe" <<WRAP
#!/usr/bin/env bash
# CACHE_TTL=0: each poll must re-read the (flipping) fixture, otherwise the
# 45s usage cache masks the 95→20 flip and the wait never sees the refresh.
BUDGET_CACHE_TTL=0 BUDGET_STATE_DIR="$state/probe-cache" BUDGET_USAGE_FIXTURE="$FIXFILE" node "$REPO/bin/probe.mjs" claude probe
WRAP
chmod +x "$probe"

# claude MCP config (loaded via --mcp-config, NOT --settings): register our
# stdio MCP server with fast poll, low resume threshold, capped wait.
mcpcfg=$(MCP="$MCP" PROBE="$probe" node -e '
  const s={mcpServers:{"budget-guard":{command:"node",args:[process.env.MCP],
    env:{BUDGET_PROBE:process.env.PROBE,BUDGET_MCP_POLL_SECONDS:"2",
         BUDGET_RESUME_BELOW:"30",BUDGET_MCP_MAX_WAIT_SECONDS:"60"}}}};
  process.stdout.write(JSON.stringify(s));')

prompt='Step 1: call the budget-guard MCP tool wait_until_budget_refresh (with agent="claude") and wait for it to return. Step 2: only AFTER it returns, use the Write tool to create the file DONE_AFTER_WAIT.txt with content ok. Do not create the file before the tool returns.'

FLIP_DELAY=7
( sleep "$FLIP_DELAY"; cp "$REPO/tests/e2e/fixture-low.json" "$FIXFILE"; date +%s > "$state/flip_ts" ) &
FLIP_PID=$!
START_TS=$(date +%s)

tmux new-session -d -s "$sess" -x 200 -y 50
tmux send-keys -t "$sess" \
  "cd $work && claude -p $(printf %q "$prompt") --allowedTools 'mcp__budget-guard__wait_until_budget_refresh Write' --max-turns 6 --output-format json --mcp-config $(printf %q "$mcpcfg") --strict-mcp-config > $out 2>&1; echo __DONE_\$?__ >> $out" Enter
for i in $(seq 1 150); do grep -q "__DONE_" "$out" 2>/dev/null && break; sleep 1; done
tmux kill-session -t "$sess" 2>/dev/null
wait "$FLIP_PID" 2>/dev/null

echo "== P0-5: claude C4 park via wait_until_budget_refresh (95%→20% flip) =="
if grep -q "__DONE_" "$out" 2>/dev/null; then
  if [ -e "$MARK" ]; then
    ok "post-wait marker created — agent continued same turn after the tool returned"
    mark_ts=$(stat -f %m "$MARK" 2>/dev/null || stat -c %Y "$MARK" 2>/dev/null)
    flip_ts=$(cat "$state/flip_ts" 2>/dev/null || echo 0)
    if [ -n "$mark_ts" ] && [ "$mark_ts" -ge "$flip_ts" ] && [ "$flip_ts" -gt 0 ]; then
      ok "marker mtime ($mark_ts) >= flip time ($flip_ts) — tool actually PARKED until refresh (not skipped)"
    else
      bad "timing inconclusive: mark_ts=$mark_ts flip_ts=$flip_ts (marker may predate the flip)"
    fi
    # the wait tool should report ready/refreshed
    grep -qiE "ready|refresh|budget" "$out" 2>/dev/null && printf '    · wait tool returned a refresh/ready result ✓\n'
  else
    bad "no post-wait marker — agent did not call the tool or did not continue"; sed -n '1,40p' "$out"
  fi
else
  bad "claude did not finish within timeout"; sed -n '1,40p' "$out"
fi
rm -rf "$work" "$state"
echo "== result: PASS=$PASS FAIL=$FAIL =="
[ "$FAIL" -eq 0 ] && [ "$PASS" -ge 2 ]
