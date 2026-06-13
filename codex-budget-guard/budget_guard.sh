#!/usr/bin/env bash
# budget_guard.sh —— 额度守卫(Claude Code / Codex 通用核心)
#
# 用法:  budget_guard.sh <agent> <phase>
#   agent : claude | codex
#   phase : prompt | pre | post | stop | resume
#           prompt  = UserPromptSubmit  (检测 /goal /loop /batch,给规划预估)
#           pre     = PreToolUse        (硬线减速提醒,放行写 checkpoint)
#           post    = PostToolUse       (记录消耗速率,软线提示收尾)
#           stop    = Stop / SubagentStop (循环轮末:重估,硬线强制停在干净点)
#           resume  = SessionStart      (注入上次 checkpoint,续接)
#
# 设计原则:
#   · 静默优先:util < 软线 时,除「长任务启动预估」外一律不出声。
#   · fail-open:查不到用量(网络/token/字段)一律放行,绝不卡死 agent。
#   · 杜绝硬切:硬线只在「轮末」强制停,并放行写 checkpoint,从不在执行中途切。
#   · 这套不能绕过限额,只能提前停在干净点 + 续接。
#
# 依赖: bash curl jq awk  (macOS 还用 security 读 Keychain)

set -uo pipefail
AGENT="${1:-}"; PHASE="${2:-}"

# 载入全局 + 项目配置(可选;两份都不存在则纯默认。必须在读 BUDGET_* 之前、
# 且不能 cd —— 项目配置靠 $PWD 向上查找)
_BGC_SELF_DIR="$(dirname "$0")"
[ -f "$_BGC_SELF_DIR/budget-config.sh" ] && . "$_BGC_SELF_DIR/budget-config.sh" && load_budget_config

# ───────── 可调参数 ─────────
WARN_ONCE="${BUDGET_WARN_ONCE:-80}"        # T1:本窗口提醒一次
WARN_REPEAT="${BUDGET_WARN_REPEAT:-${BUDGET_SOFT:-90}}" # T2:每次提醒(BUDGET_SOFT 为旧 alias)
SOFT="$WARN_REPEAT"                        # 兼容旧变量名
HARD="${BUDGET_HARD:-92}"                  # T3:轮末强制停/park
CACHE_TTL="${BUDGET_CACHE_TTL:-45}"        # 用量缓存秒
HIST_WINDOW="${BUDGET_HIST_WINDOW:-900}"   # 速率估算回看窗口(秒,默认 15min)
CHECKPOINT="${BUDGET_CHECKPOINT:-.agent/checkpoint.md}"
CODEX_USAGE_URL="${BUDGET_CODEX_URL:-https://chatgpt.com/backend-api/wham/usage}"
STATE_DIR="${BUDGET_STATE_DIR:-$HOME/.budget-guard}"
TMUX_TARGET="${BUDGET_TMUX_TARGET:-}"        # Codex TUI 目标,如 session:window.pane
BUDGET_PROBE="${BUDGET_PROBE:-$HOME/.budget-guard/bin/budget-probe}"

_bqg_uint_or_default() {
  local value="$1" fallback="$2"
  if [[ "$value" =~ ^[0-9]+$ ]]; then
    printf '%s' "$((10#$value))"
  else
    printf '%s' "$fallback"
  fi
}

_bqg_validate_thresholds() {
  local wo="$WARN_ONCE" wr="$WARN_REPEAT" hd="$HARD" invalid=0
  [[ "$wo" =~ ^[0-9]+$ ]] || invalid=1
  [[ "$wr" =~ ^[0-9]+$ ]] || invalid=1
  [[ "$hd" =~ ^[0-9]+$ ]] || invalid=1
  if (( invalid == 0 )); then
    wo=$((10#$wo)); wr=$((10#$wr)); hd=$((10#$hd))
    (( wo < wr && wr < hd && hd <= 100 )) || invalid=1
  fi
  if (( invalid != 0 )); then
    WARN_ONCE=80; WARN_REPEAT=90; SOFT=90; HARD=92
  else
    WARN_ONCE="$wo"; WARN_REPEAT="$wr"; SOFT="$wr"; HARD="$hd"
  fi
}

_bqg_validate_thresholds
CACHE_TTL="$(_bqg_uint_or_default "$CACHE_TTL" 45)"
HIST_WINDOW="$(_bqg_uint_or_default "$HIST_WINDOW" 900)"
mkdir -p "$STATE_DIR" 2>/dev/null || true

command -v jq >/dev/null 2>&1 || exit 0    # 没 jq 就静默放行
INPUT="$(cat 2>/dev/null || true)"

# ───────── 项目作用域 + 手动跳过硬线(override)─────────
# 硬线默认仍拦;用户显式授权时(明确短语,绝不复用普通「继续」)记一个限时、
# 按项目作用域的 marker,pre/stop 在硬线时若 marker 有效则放行,到期自动恢复。
# Node 对应:lib/guard/hook.mjs 的 writeSkip / skipRemaining / OVERRIDE_RE。
scope_hash() {
  pwd -P 2>/dev/null | cksum | awk '{print $1}'
}
skip_ttl() {
  local t="${BUDGET_SKIP_TTL:-1800}"
  [[ "$t" =~ ^[0-9]+$ ]] || t=1800
  printf '%s' "$t"
}
skip_marker() {
  printf '%s/skip/%s_%s.json' "$STATE_DIR" "$AGENT" "$(scope_hash)"
}
write_skip() {
  local dir="$STATE_DIR/skip" m exp tmp
  mkdir -p "$dir" 2>/dev/null || true
  m="$(skip_marker)"
  exp=$(( $(date +%s) + $(skip_ttl) ))
  tmp="${m}.tmp.$$"
  # atomic write (tmp + rename), mirrors Node writeSkip / writePending so a
  # concurrent reader never sees a torn marker.
  printf '{"expires":%s}' "$exp" > "$tmp" 2>/dev/null && mv -f "$tmp" "$m" 2>/dev/null || true
}
# 回显剩余秒数(skip 有效)否则 0;过期则清理 marker。
skip_remaining() {
  local m exp now rem
  m="$(skip_marker)"
  [[ -f "$m" ]] || { echo 0; return; }
  exp=$(jq -r '.expires // 0' "$m" 2>/dev/null || echo 0)
  [[ "$exp" =~ ^[0-9]+$ ]] || exp=0
  now=$(date +%s)
  rem=$(( exp - now ))
  if (( rem > 0 )); then echo "$rem"; else rm -f "$m" 2>/dev/null || true; echo 0; fi
}

# 显式跳过授权在「查不到用量就退出」之前处理(只记录授权,不需要用量)。
if [[ "$PHASE" == "prompt" ]]; then
  _ovr_text=$(printf '%s' "$INPUT" | jq -r '.prompt // .user_prompt // .tool_input.prompt // empty' 2>/dev/null || true)
  if printf '%s' "$_ovr_text" | grep -Eiq '/budget-skip|force-continue|跳过硬线|强制继续'; then
    write_skip
    _ovr_mins=$(( ($(skip_ttl) + 59) / 60 ))
    _ovr_msg="[额度] 已记录硬线手动跳过授权:接下来约 ${_ovr_mins} 分钟内,即使到硬线也不强停(触发窗口仍会提示),到期自动恢复拦截。"
    if [[ "$AGENT" == "claude" ]]; then
      jq -n --arg c "$_ovr_msg" '{hookSpecificOutput:{hookEventName:"UserPromptSubmit", additionalContext:$c}}'
    else
      jq -n --arg m "$_ovr_msg" '{systemMessage:$m}'
    fi
    exit 0
  fi
fi

# ───────── 取用量:回显 "util reset_epoch"(带缓存)─────────
fetch_usage() {
  local cache="$STATE_DIR/usage_${AGENT}.json" now ts token creds resp util reset probed bucket buckets
  now=$(date +%s)
  if [[ -x "$BUDGET_PROBE" ]]; then
    probed=$("$BUDGET_PROBE" --agent "$AGENT" 2>/dev/null || true)
    # gate on warn_util (max across ALL windows, incl. non-resettable) to match
    # the Node hook — all phases agree on warn_util; fall back to .util for older
    # probes. reset stays the hard (resettable) winner's epoch below.
    util=$(printf '%s' "$probed" | jq -r 'select(.ok == true) | (.warn_util // .util) // empty' 2>/dev/null || true)
    reset=$(printf '%s' "$probed" | jq -r 'select(.ok == true) | .reset_epoch // 0' 2>/dev/null || true)
    bucket=$(printf '%s' "$probed" | jq -r 'select(.ok == true) | ((.warn_bucket_id // .bucket_id) // empty | tostring | gsub("[[:space:]]+";"_"))' 2>/dev/null || true)
    buckets=$(printf '%s' "$probed" | jq -r 'select(.ok == true) | [.buckets[]? | select(.util != null) | "\((.id // "unknown") | tostring | gsub("[[:space:]]+";"_"))=\((.util // 0) | floor)%"] | join(",")' 2>/dev/null || true)
    if [[ -n "$util" && "$util" =~ ^[0-9]+$ ]]; then
      [[ "$reset" =~ ^[0-9]+$ ]] || reset=0
      printf '%s %s %s %s' "$util" "$reset" "${bucket:-"-"}" "${buckets:-"-"}"
      return
    fi
  fi
  if [[ -f "$cache" ]]; then
    ts=$(jq -r '.ts // 0' "$cache" 2>/dev/null || echo 0)
    if (( now - ts < CACHE_TTL )); then
      jq -r '"\(.util) \(.reset // 0)"' "$cache" 2>/dev/null; return
    fi
  fi
  case "$AGENT" in
    claude)
      if [[ "$(uname)" == "Darwin" ]]; then
        creds=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null || true)
      else
        creds=$(cat "$HOME/.claude/.credentials.json" 2>/dev/null || true)
      fi
      token=$(printf '%s' "$creds" | jq -r '.claudeAiOauth.accessToken // empty' 2>/dev/null || true)
      [[ -z "$token" ]] && return
      resp=$(curl -s --max-time 4 "https://api.anthropic.com/api/oauth/usage" \
        -H "Authorization: Bearer $token" -H "anthropic-beta: oauth-2025-04-20" \
        -H "Content-Type: application/json" 2>/dev/null || true)
      util=$(printf '%s' "$resp" | jq -r \
        '[.five_hour.utilization, .seven_day.utilization]|map(select(.!=null))|max // empty' 2>/dev/null || true)
      # 取最近的一个 reset 时间(秒级 epoch);字段名按实际返回调整
      reset=$(printf '%s' "$resp" | jq -r \
        '[.five_hour.resets_at, .five_hour.reset_at, .seven_day.resets_at]|map(select(.!=null))|.[0] // empty' 2>/dev/null || true)
      ;;
    codex)
      token=$(jq -r '.tokens.access_token // .access_token // .OPENAI_API_KEY // empty' \
        "$HOME/.codex/auth.json" 2>/dev/null || true)
      [[ -z "$token" ]] && return
      resp=$(curl -s --max-time 4 "$CODEX_USAGE_URL" \
        -H "Authorization: Bearer $token" -H "Content-Type: application/json" 2>/dev/null || true)
      util=$(printf '%s' "$resp" | jq -r \
        '[.. | objects | (.used_percent? // .utilization? // .percent_used?)]|map(select(.!=null))|max // empty' 2>/dev/null || true)
      reset=$(printf '%s' "$resp" | jq -r \
        '[.. | objects | (.resets_at? // .reset_at?)]|map(select(.!=null))|.[0] // empty' 2>/dev/null || true)
      ;;
    *) return ;;
  esac
  [[ -z "$util" ]] && return
  util=$(printf '%s' "$util" | awk '{v=$1; if(v<=1)v=v*100; printf "%d", v}')
  # reset 可能是 ISO 字符串或 epoch;非数字就置 0(后面 fallback 估 5h 窗口)
  [[ ! "$reset" =~ ^[0-9]+$ ]] && reset=0
  printf '{"ts":%s,"util":%s,"reset":%s}' "$now" "$util" "$reset" > "$cache" 2>/dev/null || true
  printf '%s %s' "$util" "$reset"
}

# ───────── 记录一条速率历史点 ─────────
record_point() {
  local util="$1" now; now=$(date +%s)
  local h="$STATE_DIR/hist_${AGENT}.jsonl"
  printf '{"ts":%s,"util":%s}\n' "$now" "$util" >> "$h" 2>/dev/null || true
  tail -n 60 "$h" > "$h.tmp" 2>/dev/null && mv "$h.tmp" "$h" 2>/dev/null || true
}

# ───────── 估算:还能跑多少秒(到硬线)。回显秒数,-1 表示充足/无法估 ─────────
seconds_to_hard() {
  local util_now="$1" h="$STATE_DIR/hist_${AGENT}.jsonl" now; now=$(date +%s)
  [[ -f "$h" ]] || { echo -1; return; }
  # 在回看窗口内取最早点与当前点,两点法算速率(%/秒)
  awk -v now="$now" -v win="$HIST_WINDOW" -v cur="$util_now" -v hard="$HARD" '
    { ts[NR]=$0 }
    END{
      # 解析每行 ts/util
      n=0
      for(i=1;i<=NR;i++){
        line=ts[i]
        match(line, /"ts":[0-9]+/);   t=substr(line,RSTART+5,RLENGTH-5)+0
        match(line, /"util":[0-9]+/); u=substr(line,RSTART+7,RLENGTH-7)+0
        if(now-t<=win){ if(n==0){t0=t;u0=u} ; n++; tl=t; ul=u }
      }
      if(n<2){print -1; exit}
      dt=tl-t0; du=ul-u0
      if(dt<=0 || du<=0){print -1; exit}      # 没在涨 => 充足
      rate=du/dt                               # %/秒
      remain=(hard-cur)/rate
      if(remain<0)remain=0
      printf "%d", remain
    }' "$h"
}

fmt_clock() { # epoch -> HH:MM(本地);0 -> "未知"
  local e="$1"; [[ "$e" =~ ^[0-9]+$ ]] && (( e>0 )) || { echo "未知"; return; }
  date -d "@$e" +%H:%M 2>/dev/null || date -r "$e" +%H:%M 2>/dev/null || echo "未知"
}
fmt_dur() { # 秒 -> "约 N 分钟" / "约 N 小时"
  local s="$1"; (( s<0 )) && { echo "充足"; return; }
  if (( s<5400 )); then echo "约 $(( (s+59)/60 )) 分钟"; else echo "约 $(awk -v s="$s" 'BEGIN{printf "%.1f", s/3600}') 小时"; fi
}

usage_detail() {
  local bucket="${1:-}" buckets="${2:-}" detail=""
  [[ "$bucket" == "-" || "$bucket" == "null" ]] && bucket=""
  [[ "$buckets" == "-" || "$buckets" == "null" ]] && buckets=""
  [[ -n "$bucket" ]] && detail="触发窗口:${bucket}"
  if [[ -n "$buckets" ]]; then
    [[ -n "$detail" ]] && detail="${detail}; "
    detail="${detail}窗口:${buckets}"
  fi
  [[ -n "$detail" ]] && printf '（%s）' "$detail"
}

warn_once_should_fire() {
  local reset="$1" scope dir current
  [[ "$reset" =~ ^[0-9]+$ ]] || reset=0
  scope="$(scope_hash)"
  dir="$STATE_DIR/notified"
  mkdir -p "$dir" 2>/dev/null || true
  current="$dir/${AGENT}_${scope}_${reset}_warn_once"
  if [[ -f "$current" ]]; then
    return 1
  fi
  find "$dir" -type f -name "${AGENT}_${scope}_*_warn_once" ! -name "$(basename "$current")" -delete 2>/dev/null || true
  : > "$current" 2>/dev/null || true
  return 0
}

is_checkpoint_write() {
  local tool target cp_rel cp_abs target_abs
  tool=$(printf '%s' "$INPUT" | jq -r '.tool_name // .tool // .name // empty' 2>/dev/null || true)
  [[ "$tool" == "Bash" || "$tool" == "bash" ]] && return 1
  case "$tool" in
    Write|Edit|MultiEdit|NotebookEdit|apply_patch) ;;
    *) return 1 ;;
  esac
  target=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // .tool_input.path // .file_path // .path // empty' 2>/dev/null || true)
  [[ -n "$target" ]] || return 1
  cp_rel="${CHECKPOINT#./}"
  target="${target#./}"
  [[ "$target" == "$cp_rel" || "$target" == "$CHECKPOINT" ]] && return 0
  cp_abs="$PWD/$cp_rel"
  target_abs="$target"
  [[ "$target_abs" != /* ]] && target_abs="$PWD/$target_abs"
  [[ "$target_abs" == "$cp_abs" ]]
}

pause_codex_goal_if_possible() {
  [[ "$AGENT" == "codex" && -n "$TMUX_TARGET" ]] || return 0
  command -v tmux >/dev/null 2>&1 || return 0
  tmux send-keys -t "$TMUX_TARGET" "/goal pause" C-m >/dev/null 2>&1 || true
}

# 取用量
read -r UTIL RESET BUCKET_ID BUCKETS_SUMMARY <<<"$(fetch_usage)"
[[ -z "${UTIL:-}" || ! "$UTIL" =~ ^[0-9]+$ ]] && exit 0   # 查不到 -> 静默放行

# ───────── prompt:长任务启动预估(唯一「额度充足也提示」的情形)─────────
if [[ "$PHASE" == "prompt" ]]; then
  text=$(printf '%s' "$INPUT" | jq -r '.prompt // .user_prompt // .tool_input.prompt // empty' 2>/dev/null || true)
  if printf '%s' "$text" | grep -Eq '(^|[[:space:]])/(goal|loop|batch|background)([[:space:]]|$)'; then
    record_point "$UTIL"
    secs=$(seconds_to_hard "$UTIL")
    est="按当前剩余额度(已用 ${UTIL}%),"
    if (( secs >= 0 )); then est+="以最近的消耗速率估算大约还能自主跑 $(fmt_dur "$secs")"; else est+="额度宽裕"; fi
    est+="。额度刷新时间 $(fmt_clock "$RESET")。建议把目标切成能在该时长内完成的小块,每块结束写一次 ${CHECKPOINT};若可能超时,先做最关键的部分。"
    if [[ "$AGENT" == "claude" ]]; then
      jq -n --arg c "$est" '{hookSpecificOutput:{hookEventName:"UserPromptSubmit", additionalContext:$c}}'
    else
      # Codex:用 systemMessage 给用户看(其 UserPromptSubmit 注入 agent 的能力按版本而定)
      jq -n --arg m "[额度预估] $est" '{systemMessage:$m}'
    fi
  fi
  exit 0
fi

# ───────── resume:注入 checkpoint ─────────
if [[ "$PHASE" == "resume" ]]; then
  [[ -f "$CHECKPOINT" ]] || exit 0
  body="$(cat "$CHECKPOINT" 2>/dev/null || true)"; [[ -z "$body" ]] && exit 0
  msg="【续接】发现上次未完成任务的 checkpoint(当前已用 ${UTIL}%)。从「下一步」继续,「已完成」的不要重做:

${body}"
  jq -n --arg c "$msg" '{hookSpecificOutput:{hookEventName:"SessionStart", additionalContext:$c}}'
  exit 0
fi

# ───────── pre:硬线减速提醒,放行写 checkpoint ─────────
if [[ "$PHASE" == "pre" ]]; then
  if (( UTIL >= HARD )); then
    if is_checkpoint_write; then exit 0; fi
    if [[ "$(skip_remaining)" != "0" ]]; then exit 0; fi   # 手动跳过有效 → 静默放行
    r="额度已达硬线(${UTIL}% ≥ ${HARD}%)$(usage_detail "$BUCKET_ID" "$BUCKETS_SUMMARY")。请尽快把进度写进 ${CHECKPOINT} 并收尾到干净点;不会强制拦截新工具,但接近供应商限流时可能被外层硬切。刷新约 $(fmt_clock "$RESET")。"
    if [[ "$AGENT" == "claude" ]]; then
      jq -n --arg c "$r" '{hookSpecificOutput:{hookEventName:"PreToolUse", additionalContext:$c}}'
    else
      jq -n --arg m "$r" '{systemMessage:$m}'
    fi
  fi
  exit 0
fi

# ───────── post:记录速率;软线提示收尾 ─────────
if [[ "$PHASE" == "post" ]]; then
  record_point "$UTIL"
  if (( UTIL >= WARN_REPEAT && UTIL < HARD )); then
    secs=$(seconds_to_hard "$UTIL")
    note="额度已用 ${UTIL}%(T2 ${WARN_REPEAT}%),预计还能跑 $(fmt_dur "$secs")。收尾手头这步,把进度写进 ${CHECKPOINT} 准备暂停,别等硬线被打断。"
    if [[ "$AGENT" == "claude" ]]; then
      jq -n --arg c "$note" '{hookSpecificOutput:{hookEventName:"PostToolUse", additionalContext:$c}}'
    else
      jq -n --arg m "$note" '{systemMessage:$m}'
    fi
  elif (( UTIL >= WARN_ONCE && UTIL < WARN_REPEAT )) && warn_once_should_fire "$RESET"; then
    note="额度已用 ${UTIL}%(T1 ${WARN_ONCE}%),本窗口提醒一次。请确认当前目标能在剩余额度内收束,必要时写 ${CHECKPOINT}。"
    if [[ "$AGENT" == "claude" ]]; then
      jq -n --arg c "$note" '{hookSpecificOutput:{hookEventName:"PostToolUse", additionalContext:$c}}'
    else
      jq -n --arg m "$note" '{systemMessage:$m}'
    fi
  fi
  exit 0
fi

# ───────── stop:循环轮末重估;硬线则强制停在干净点 + 留待续状态给 watchdog ─────────
if [[ "$PHASE" == "stop" ]]; then
  record_point "$UTIL"
  if (( UTIL >= HARD )); then
    _stop_rem="$(skip_remaining)"
    if [[ "$_stop_rem" != "0" ]]; then
      # 手动跳过有效:不强停、不写 pending,让循环继续(到期自动恢复)。
      _stop_mins=$(( (_stop_rem + 59) / 60 ))
      _stop_note="额度 ${UTIL}%≥${HARD}% 硬线$(usage_detail "$BUCKET_ID" "$BUCKETS_SUMMARY"),但已手动跳过(约 ${_stop_mins} 分钟后恢复拦截)。继续推进,注意在刷新前完成收尾。"
      [[ "$AGENT" == "codex" ]] && jq -n --arg m "$_stop_note" '{systemMessage:$m}'
      exit 0
    fi
    pause_codex_goal_if_possible
    # 写待续状态(watchdog 用)
    sid=$(printf '%s' "$INPUT" | jq -r '.session_id // .thread_id // empty' 2>/dev/null || true)
    pending_dir="$STATE_DIR/pending"
    mkdir -p "$pending_dir" 2>/dev/null || true
    key=$(printf '%s\n%s\n' "$(pwd -P 2>/dev/null || pwd)" "$sid" | cksum | awk '{print $1}')
    pending_payload=$(jq -n --arg agent "$AGENT" --arg sid "$sid" --arg cwd "$(pwd)" --arg reset "$RESET" --arg util "$UTIL" \
      '{status:"paused", agent:$agent, session_id:$sid, cwd:$cwd, reset_epoch:($reset|tonumber? // 0), util:($util|tonumber), warn_util:($util|tonumber), at:(now|floor)}' 2>/dev/null || true)
    if [[ -n "$pending_payload" ]]; then
      printf '%s\n' "$pending_payload" > "$pending_dir/${AGENT}_${key}.json" 2>/dev/null || true
      printf '%s\n' "$pending_payload" > "$STATE_DIR/pending_${AGENT}.json" 2>/dev/null || true
    fi
    stop="额度达硬线(${UTIL}%)$(usage_detail "$BUCKET_ID" "$BUCKETS_SUMMARY"),已在本轮末尾干净停下并保存续接点。额度刷新约 $(fmt_clock "$RESET");之后发「继续」或由 watchdog 自动续跑。"
    jq -n --arg s "$stop" '{continue:false, stopReason:$s}'
  elif (( UTIL >= WARN_REPEAT )); then
    secs=$(seconds_to_hard "$UTIL")
    jq -n --arg m "额度 ${UTIL}%,预计还能跑 $(fmt_dur "$secs")。建议本轮收尾并写 ${CHECKPOINT}。" '{systemMessage:$m}'
  elif (( UTIL >= WARN_ONCE )) && warn_once_should_fire "$RESET"; then
    jq -n --arg m "额度 ${UTIL}%(T1 ${WARN_ONCE}%),本窗口提醒一次。请确认当前目标能收束,必要时写 ${CHECKPOINT}。" '{systemMessage:$m}'
  fi
  exit 0
fi

exit 0
