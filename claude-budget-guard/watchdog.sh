#!/usr/bin/env bash
# watchdog.sh —— 额度刷新后自动续跑(托管的最后一环)
#
# 用法(给 cron / launchd 定时调,比如每 10 分钟):
#   watchdog.sh <agent>          # agent: claude | codex
#
# 逻辑:
#   1. 读 ~/.budget-guard/pending/<agent>_*.json(兼容旧 pending_<agent>.json)。
#   2. 没有待续任务 -> 退出。
#   3. 查当前用量;高于 RESUME_BELOW(默认 30%)说明还没刷新 -> 退出等下次。
#   4. 已刷新 -> headless 续跑,注入「继续」。完成后清除待续状态。
#
# ⚠️ 安全:这是无人值守跑 agent。默认 DRY-RUN(只打印不执行)。
#   确认权限白名单和续跑指令都妥当后,设 BUDGET_WATCHDOG_ARM=1 才真正执行。
#   续跑会消耗额度;务必用 --allowedTools / --sandbox workspace-write 等限权,并限定项目目录。

set -uo pipefail
AGENT="${1:-}"
# 载入全局 + 项目配置(可选;不能 cd —— 项目配置靠 $PWD 向上查找)
_BGC_SELF_DIR="$(dirname "$0")"
[ -f "$_BGC_SELF_DIR/budget-config.sh" ] && . "$_BGC_SELF_DIR/budget-config.sh" && load_budget_config
STATE_DIR="${BUDGET_STATE_DIR:-$HOME/.budget-guard}"
RESUME_BELOW="${BUDGET_RESUME_BELOW:-30}"     # 用量回落到此线下才算刷新
ARM="${BUDGET_WATCHDOG_ARM:-0}"               # 0=dry-run,1=真执行
CODEX_USAGE_URL="${BUDGET_CODEX_URL:-https://chatgpt.com/backend-api/wham/usage}"
RESUME_PROMPT="${BUDGET_RESUME_PROMPT:-继续上次未完成的任务,从 .agent/checkpoint.md 的「下一步」接着做;完成后停下并在 checkpoint 标记 DONE}"
PROBE="${BUDGET_PROBE:-$HOME/.budget-guard/bin/budget-probe}"
TMUX_TARGET="${BUDGET_TMUX_TARGET:-}"          # 设为 session:window.pane 时优先注入活 TUI
CODEX_SANDBOX="${BUDGET_CODEX_SANDBOX:-workspace-write}"

# 续跑时给 agent 的权限(按需收紧!)
CLAUDE_ALLOWED="${BUDGET_CLAUDE_ALLOWED:-Read,Edit,Write,Bash}"
CLAUDE_PERMMODE="${BUDGET_CLAUDE_PERMMODE:-acceptEdits}"
CLAUDE_MAXTURNS="${BUDGET_CLAUDE_MAXTURNS:-40}"

command -v jq >/dev/null 2>&1 || { echo "需要 jq"; exit 1; }

pending_files() {
  local scoped legacy sid seen="|"
  while IFS= read -r scoped; do
    [[ -n "$scoped" ]] || continue
    printf '%s\n' "$scoped"
    sid=$(jq -r '.session_id // .thread_id // empty' "$scoped" 2>/dev/null || true)
    [[ -n "$sid" ]] && seen="${seen}${sid}|"
  done < <(find "$STATE_DIR/pending" -type f -name "${AGENT}_*.json" 2>/dev/null | sort)

  legacy="$STATE_DIR/pending_${AGENT}.json"
  if [[ -f "$legacy" ]]; then
    sid=$(jq -r '.session_id // .thread_id // empty' "$legacy" 2>/dev/null || true)
    if [[ -z "$sid" || "$seen" != *"|$sid|"* ]]; then
      printf '%s\n' "$legacy"
    fi
  fi
}

pause_codex_goal() {
  [[ "$AGENT" == "codex" && -n "$TMUX_TARGET" ]] || return 0
  command -v tmux >/dev/null 2>&1 || return 0
  tmux send-keys -t "$TMUX_TARGET" "/goal pause" C-m 2>/dev/null || true
}

resume_one() {
  local P="$1" SID CWD util usage rc
  [[ "$(jq -r '.status // empty' "$P" 2>/dev/null)" == "paused" ]] || return 0
  SID=$(jq -r '.session_id // .thread_id // empty' "$P")
  CWD=$(jq -r '.cwd // empty' "$P")
  [[ -d "$CWD" ]] || { echo "项目目录不存在: $CWD"; return 1; }

  if [[ -x "$PROBE" ]]; then
    usage=$("$PROBE" "$AGENT" 2>/dev/null || true)
    util=$(printf '%s' "$usage" | jq -r '.warn_util // .util // empty' 2>/dev/null || true)
  else
    util=""
  fi
  [[ -z "$util" || ! "$util" =~ ^[0-9]+$ ]] && return 0

  if (( util >= RESUME_BELOW )); then
    echo "$(date '+%F %T') [$AGENT] $P 用量 ${util}%,未达续跑线(<${RESUME_BELOW}%),跳过。"
    return 0
  fi

  if [[ "$AGENT" == "claude" ]]; then
    if [[ -n "$SID" ]]; then RES=(--resume "$SID"); else RES=(--continue); fi
    CMD=(claude -p "$RESUME_PROMPT" "${RES[@]}" --permission-mode "$CLAUDE_PERMMODE"
         --allowedTools "$CLAUDE_ALLOWED" --max-turns "$CLAUDE_MAXTURNS" --output-format json)
  else
    if [[ -n "$TMUX_TARGET" ]]; then
      CMD=(tmux send-keys -t "$TMUX_TARGET" "$RESUME_PROMPT" C-m)
    elif [[ -n "$SID" ]]; then
      CMD=(codex exec --sandbox "$CODEX_SANDBOX" resume "$SID" "$RESUME_PROMPT")
    else
      CMD=(codex exec --sandbox "$CODEX_SANDBOX" resume --last "$RESUME_PROMPT")
    fi
  fi

  echo "$(date '+%F %T') [$AGENT] 用量 ${util}% 已刷新。准备在 $CWD 续跑:"
  printf '   %s ' "${CMD[@]}"; echo
  if [[ "$ARM" != "1" ]]; then
    echo "   (DRY-RUN:未执行。设 BUDGET_WATCHDOG_ARM=1 才真正续跑。)"
    return 0
  fi

  cd "$CWD" || return 1
  pause_codex_goal
  "${CMD[@]}"
  rc=$?
  if (( rc == 0 )); then
    if grep -qi 'DONE' .agent/checkpoint.md 2>/dev/null; then
      rm -f "$P"; echo "$(date '+%F %T') [$AGENT] 任务完成,清除待续。"
    else
      echo "$(date '+%F %T') [$AGENT] 本轮续跑结束,任务未标 DONE,保留待续。"
    fi
  else
    echo "$(date '+%F %T') [$AGENT] 续跑退出码 $rc,保留待续下次重试。"
  fi
}

found=0
while IFS= read -r p; do
  found=1
  resume_one "$p"
done < <(pending_files)

(( found == 0 )) && exit 0
exit 0
