#!/usr/bin/env bash
# budget-config.sh —— 共享配置加载器(被 budget_guard.sh / budget-probe / watchdog.sh source)
#
# 把全局 + 项目两层 `.conf` 里的 BUDGET_* 设置载入环境,供后续 ${BUDGET_X:-default}
# 读取。两份配置都可选;都不存在时行为与纯默认完全一致。
#
# 优先级(高 → 低):
#   进程环境变量  >  项目配置  >  全局配置  >  脚本内置默认
#
# 文件:
#   全局   ${BUDGET_STATE_DIR:-$HOME/.budget-guard}/config
#   项目   从 $PWD 向上查找的第一个 .budget-guard.conf
#
# 格式(与 Node 侧 lib/guard/config.mjs 必须一致):
#   · 一行一个 `BUDGET_KEY=VALUE`;只接受明确安全的 BUDGET_* 调参 key。
#   · 整行注释(首个非空字符为 #)和空行忽略;不支持行尾内联注释。
#   · VALUE = 第一个 = 之后到行尾,去首尾空白,再去掉一层成对的 " 或 ' 引号。
#   · 不做变量展开 / 命令替换(字面值)。

# 内部:去掉字符串首尾空白
_bgc_trim() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"   # ltrim
  s="${s%"${s##*[![:space:]]}"}"   # rtrim
  printf '%s' "$s"
}

# 内部:只有这些明确安全的调参 key 可从项目/全局配置文件载入。
# 其它 BUDGET_* key 仍可由进程环境显式提供,但不会被仓库配置注入。
_bgc_is_config_key() {
  case "$1" in
    BUDGET_WARN_ONCE|BUDGET_WARN_REPEAT|BUDGET_SOFT|BUDGET_HARD|\
BUDGET_CACHE_TTL|BUDGET_HIST_WINDOW|BUDGET_CLAUDE_UA)
      return 0 ;;
    *)
      return 1 ;;
  esac
}

_bgc_canonical_key() {
  case "$1" in
    BUDGET_SOFT) printf '%s' "BUDGET_WARN_REPEAT" ;;
    *) printf '%s' "$1" ;;
  esac
}

# 内部:对单个配置文件应用 BUDGET_* 赋值;$2 = 受保护(env 已设)的 key 列表(空格包裹)
_bgc_apply() {
  local file="$1" protected="$2" line key val
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    line="$(_bgc_trim "$line")"
    case "$line" in
      ''|'#'*) continue ;;       # 空行 / 整行注释
      BUDGET_*=*) ;;             # 只认 BUDGET_KEY=VALUE
      *) continue ;;
    esac
    key="$(_bgc_trim "${line%%=*}")"
    # key 必须是合法变量名且以 BUDGET_ 开头(再次校验,防 `BUDGET_X Y=...` 这类)
    case "$key" in
      BUDGET_[A-Za-z0-9_]*) ;;
      *) continue ;;
    esac
    case "$key" in *[!A-Za-z0-9_]*) continue ;; esac
    # 只允许明确安全的调参 key;敏感/执行/自动化类 key 均需显式 env。
    _bgc_is_config_key "$key" || continue
    key="$(_bgc_canonical_key "$key")"
    # env 已提供该 key → env 胜,跳过
    case "$protected" in *" $key "*) continue ;; esac
    val="$(_bgc_trim "${line#*=}")"
    # 去掉一层成对引号
    case "$val" in
      \"*\") val="${val#\"}"; val="${val%\"}" ;;
      \'*\') val="${val#\'}"; val="${val%\'}" ;;
    esac
    export "$key=$val"
  done < "$file"
}

# 内部:从 $PWD 向上查找第一个 .budget-guard.conf
_bgc_find_project() {
  local d="$PWD"
  while [ -n "$d" ] && [ "$d" != "/" ]; do
    [ -f "$d/.budget-guard.conf" ] && { printf '%s' "$d/.budget-guard.conf"; return 0; }
    d="$(dirname "$d")"
  done
  [ -f "/.budget-guard.conf" ] && printf '%s' "/.budget-guard.conf"
  return 0
}

# 主入口:载入全局 + 项目配置(env 始终胜)
load_budget_config() {
  # 1. 快照当前环境里已有的 BUDGET_* key(这些最高优先,不被配置覆盖)
  local protected
  protected=" $(env 2>/dev/null | sed -n 's/^\(BUDGET_[A-Za-z0-9_][A-Za-z0-9_]*\)=.*/\1/p' | tr '\n' ' ') "
  case "$protected" in *" BUDGET_SOFT "*) protected="${protected}BUDGET_WARN_REPEAT " ;; esac
  case "$protected" in *" BUDGET_WARN_REPEAT "*) protected="${protected}BUDGET_SOFT " ;; esac
  # 2. 全局 → 项目(项目覆盖全局;两者都跳过 env 已设的 key)
  local global project
  global="${BUDGET_STATE_DIR:-$HOME/.budget-guard}/config"
  project="$(_bgc_find_project)"
  _bgc_apply "$global" "$protected"
  [ -n "$project" ] && _bgc_apply "$project" "$protected"
  return 0
}
