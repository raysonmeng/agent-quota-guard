#!/usr/bin/env bash
# watchdog.sh —— 额度刷新后自动续跑(托管的最后一环)
#
# 用法(给 cron / launchd 定时调,比如每 10 分钟):
#   watchdog.sh <agent>          # agent: claude | codex
#
# 逻辑:
#   1. 读 ~/.budget-guard/pending_<agent>.json(guard 在硬线暂停时写的待续状态)。
#   2. 没有待续任务 -> 退出。
#   3. 查当前用量;高于 RESUME_BELOW(默认 30%)说明还没刷新 -> 退出等下次。
#   4. 已刷新 -> headless 续跑,注入「继续」。完成后清除待续状态。
#
# ⚠️ 安全:这是无人值守跑 agent。默认 DRY-RUN(只打印不执行)。
#   确认权限白名单和续跑指令都妥当后,设 BUDGET_WATCHDOG_ARM=1 才真正执行。
#   续跑会消耗额度;务必用 --allowedTools / --full-auto 等限权,并限定项目目录。

set -uo pipefail
AGENT="${1:-}"
STATE_DIR="${BUDGET_STATE_DIR:-$HOME/.budget-guard}"
RESUME_BELOW="${BUDGET_RESUME_BELOW:-30}"     # 用量回落到此线下才算刷新
ARM="${BUDGET_WATCHDOG_ARM:-0}"               # 0=dry-run,1=真执行
CODEX_USAGE_URL="${BUDGET_CODEX_URL:-https://chatgpt.com/backend-api/codex/usage}"
RESUME_PROMPT="${BUDGET_RESUME_PROMPT:-继续上次未完成的任务,从 .agent/checkpoint.md 的「下一步」接着做;完成后停下并在 checkpoint 标记 DONE}"

# 续跑时给 agent 的权限(按需收紧!)
CLAUDE_ALLOWED="${BUDGET_CLAUDE_ALLOWED:-Read,Edit,Write,Bash}"
CLAUDE_PERMMODE="${BUDGET_CLAUDE_PERMMODE:-acceptEdits}"
CLAUDE_MAXTURNS="${BUDGET_CLAUDE_MAXTURNS:-40}"

command -v jq >/dev/null 2>&1 || { echo "需要 jq"; exit 1; }
P="$STATE_DIR/pending_${AGENT}.json"
[[ -f "$P" ]] || exit 0
[[ "$(jq -r '.status // empty' "$P" 2>/dev/null)" == "paused" ]] || exit 0

SID=$(jq -r '.session_id // empty' "$P"); CWD=$(jq -r '.cwd // empty' "$P")
[[ -d "$CWD" ]] || { echo "项目目录不存在: $CWD"; exit 1; }

# ── 查当前用量 ──
util=""
case "$AGENT" in
  claude)
    if [[ "$(uname)" == "Darwin" ]]; then
      creds=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null || true)
    else creds=$(cat "$HOME/.claude/.credentials.json" 2>/dev/null || true); fi
    tok=$(printf '%s' "$creds" | jq -r '.claudeAiOauth.accessToken // empty' 2>/dev/null || true)
    [[ -z "$tok" ]] && exit 0
    r=$(curl -s --max-time 5 "https://api.anthropic.com/api/oauth/usage" \
      -H "Authorization: Bearer $tok" -H "anthropic-beta: oauth-2025-04-20" -H "Content-Type: application/json" 2>/dev/null || true)
    util=$(printf '%s' "$r" | jq -r '[.five_hour.utilization,.seven_day.utilization]|map(select(.!=null))|max // empty' 2>/dev/null || true)
    ;;
  codex)
    tok=$(jq -r '.tokens.access_token // .access_token // empty' "$HOME/.codex/auth.json" 2>/dev/null || true)
    [[ -z "$tok" ]] && exit 0
    r=$(curl -s --max-time 5 "$CODEX_USAGE_URL" -H "Authorization: Bearer $tok" -H "Content-Type: application/json" 2>/dev/null || true)
    util=$(printf '%s' "$r" | jq -r '[.. | objects | (.used_percent? // .utilization?)]|map(select(.!=null))|max // empty' 2>/dev/null || true)
    ;;
  *) echo "未知 agent"; exit 1 ;;
esac
[[ -z "$util" ]] && exit 0
util=$(printf '%s' "$util" | awk '{v=$1; if(v<=1)v=v*100; printf "%d", v}')

# ── 还没刷新?等下次 ──
if (( util >= RESUME_BELOW )); then
  echo "$(date '+%F %T') [$AGENT] 用量 ${util}%,未达续跑线(<${RESUME_BELOW}%),跳过。"
  exit 0
fi

# ── 已刷新 -> 续跑 ──
if [[ "$AGENT" == "claude" ]]; then
  if [[ -n "$SID" ]]; then RES=(--resume "$SID"); else RES=(--continue); fi
  CMD=(claude -p "$RESUME_PROMPT" "${RES[@]}" --permission-mode "$CLAUDE_PERMMODE"
       --allowedTools "$CLAUDE_ALLOWED" --max-turns "$CLAUDE_MAXTURNS" --output-format json)
else
  if [[ -n "$SID" ]]; then RES=(resume "$SID"); else RES=(resume --last); fi
  CMD=(codex exec "${RES[@]}" "$RESUME_PROMPT" --full-auto)
fi

echo "$(date '+%F %T') [$AGENT] 用量 ${util}% 已刷新。准备在 $CWD 续跑:"
printf '   %q ' "${CMD[@]}"; echo
if [[ "$ARM" != "1" ]]; then
  echo "   (DRY-RUN:未执行。设 BUDGET_WATCHDOG_ARM=1 才真正续跑。)"
  exit 0
fi

cd "$CWD" || exit 1
"${CMD[@]}"
rc=$?
if (( rc == 0 )); then
  # 简单完成判定:checkpoint 标了 DONE 就清除待续;否则保留(可能又撞线,guard 会重写)
  if grep -qi 'DONE' .agent/checkpoint.md 2>/dev/null; then
    rm -f "$P"; echo "$(date '+%F %T') [$AGENT] 任务完成,清除待续。"
  else
    echo "$(date '+%F %T') [$AGENT] 本轮续跑结束,任务未标 DONE,保留待续。"
  fi
else
  echo "$(date '+%F %T') [$AGENT] 续跑退出码 $rc,保留待续下次重试。"
fi
