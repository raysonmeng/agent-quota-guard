#!/usr/bin/env bash
# install.sh —— 额度守卫一键安装(根入口):一次装好 Claude Code + Codex 两个 agent。
#
#   ./install.sh                     安装 Claude + Codex(幂等,可重复跑)
#   ./install.sh claude              只装 Claude
#   ./install.sh codex               只装 Codex
#   ./install.sh --uninstall         卸载两个
#   ./install.sh claude --uninstall  只卸 Claude(agent 与 --uninstall 顺序随意)
#
# 本脚本只是薄包装:依次调用 claude-budget-guard/install.sh 与
# codex-budget-guard/install.sh(各自幂等、改前自动 .bak)。其中 Claude 子安装器
# 在有 node 时转发到 bin/install-claude.mjs(Node 版 hook);Codex 子安装器为
# 纯 Bash。一个 agent 失败不阻断另一个,最终退出码反映是否全部成功。
#
# 依赖:同子安装器 —— 运行期 jq;Claude 端 node >= 18;Codex 端 python3。

set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

usage() {
  # 打印开头的连续注释块(跳过 shebang,遇到首个非注释行即停),
  # 不依赖硬编码行号,注释增删不会再截断 help 输出。
  awk 'NR>1 { if ($0 !~ /^#/) exit; sub(/^# ?/, ""); print }' "$0"
}

agents=()
flag=""
for arg in "$@"; do
  case "$arg" in
    claude|codex) agents+=("$arg") ;;
    --uninstall)  flag="--uninstall" ;;
    -h|--help)    usage; exit 0 ;;
    *) printf '✗ 未知参数: %s\n\n' "$arg" >&2; usage >&2; exit 2 ;;
  esac
done
if [[ ${#agents[@]} -eq 0 ]]; then
  agents=(claude codex)
fi

action="安装"
[[ -n "$flag" ]] && action="卸载"

fail=0
done_list=""
for a in "${agents[@]}"; do
  installer="$HERE/${a}-budget-guard/install.sh"
  if [[ ! -f "$installer" ]]; then
    printf '✗ 找不到子安装器: %s\n' "$installer" >&2
    fail=1
    continue
  fi
  printf '\n━━━ %s %s 守卫 ━━━\n' "$action" "$a"
  if bash "$installer" ${flag:+"$flag"}; then
    done_list="${done_list} ${a}"
  else
    printf '✗ %s 子安装器失败(退出码 %s),继续处理其余 agent\n' "$a" "$?" >&2
    fail=1
  fi
done

printf '\n━━━ 汇总 ━━━\n'
if [[ -n "$done_list" ]]; then
  printf '✓ %s完成:%s\n' "$action" "$done_list"
fi
if (( fail )); then
  printf '✗ 存在失败项,见上方输出\n' >&2
  exit 1
fi
if [[ -z "$flag" ]]; then
  printf '提示:重启 Claude Code / Codex 会话后新 hook 才会生效。\n'
fi
