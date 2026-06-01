#!/usr/bin/env bash
# install.sh —— Codex 版「额度守卫」独立安装器
#   ./install.sh              安装(幂等)
#   ./install.sh --uninstall  卸载
#
# 装完即用、无需配置:平时静默,接近额度才提示,/goal 等长任务给预估,
# 硬线轮末干净暂停 + 写 checkpoint,新会话发「继续」自动续接。
#
# 运行期依赖 jq;安装时额外需要 python3。
# 注意:Codex 的 hook 只对 Bash 命令可靠触发(apply_patch/MCP 暂不触发),
#       所以硬线主要刹住「跑命令」,而 agent 用 apply_patch 写 checkpoint 正好不被拦。

set -euo pipefail
AGENT="codex"
HERE="$(cd "$(dirname "$0")" && pwd)"
BIN="$HOME/.budget-guard/bin"
HOOKS="$HOME/.codex/hooks.json"
MEMORY="$HOME/.codex/AGENTS.md"
MARK_START="<!-- budget-guard:start -->"; MARK_END="<!-- budget-guard:end -->"

uninstall() {
  command -v python3 >/dev/null || { echo "需要 python3"; exit 1; }
  [[ -f "$HOOKS" ]] && python3 - "$HOOKS" <<'PY'
import json,sys,time,shutil
p=sys.argv[1]
try: cfg=json.load(open(p))
except: sys.exit(0)
shutil.copy2(p,p+f".bak.{int(time.time())}")
for ev in list(cfg):
    if isinstance(cfg[ev],list):
        cfg[ev]=[e for e in cfg[ev] if "budget_guard.sh" not in json.dumps(e)]
        if not cfg[ev]: del cfg[ev]
json.dump(cfg,open(p,"w"),ensure_ascii=False,indent=2); open(p,"a").write("\n")
print("✓ 已从 hooks.json 移除 hook")
PY
  if [[ -f "$MEMORY" ]]; then
    python3 - "$MEMORY" "$MARK_START" "$MARK_END" <<'PY'
import sys,re
p,a,b=sys.argv[1:4]; t=open(p,encoding="utf-8").read()
t=re.sub(re.escape(a)+r".*?"+re.escape(b)+r"\n?","",t,flags=re.S)
open(p,"w",encoding="utf-8").write(t.rstrip()+"\n"); print("✓ 已移除 AGENTS.md 协议块")
PY
  fi
  echo "卸载完成。脚本本体仍在 $BIN。"; exit 0
}
[[ "${1:-}" == "--uninstall" ]] && uninstall

command -v python3 >/dev/null || { echo "✗ 需要 python3(仅安装时)"; exit 1; }
command -v jq >/dev/null || echo "⚠ 未检测到 jq;guard 运行期需要 jq。"

# 1) 部署脚本
mkdir -p "$BIN"
cp "$HERE/budget_guard.sh" "$BIN/"; cp "$HERE/watchdog.sh" "$BIN/"
chmod +x "$BIN/budget_guard.sh" "$BIN/watchdog.sh"
echo "✓ 脚本 → $BIN"

# 2) 合并 hook 进 hooks.json(顶层事件名;幂等、备份)
mkdir -p "$(dirname "$HOOKS")"
GUARD="$BIN/budget_guard.sh" python3 - "$HOOKS" "$AGENT" <<'PY'
import json,sys,os,time,shutil
path,agent=sys.argv[1],sys.argv[2]; guard=os.environ["GUARD"]
try: cfg=json.load(open(path)) if os.path.exists(path) and open(path).read().strip() else {}
except json.JSONDecodeError: sys.exit(f"✗ {path} 不是合法 JSON,先修复再装。")
if os.path.exists(path): shutil.copy2(path,path+f".bak.{int(time.time())}")
M="^Bash$"
plan=[("UserPromptSubmit","prompt",None),("PreToolUse","pre",M),("PostToolUse","post",M),
      ("Stop","stop",None),("SessionStart","resume",None)]
for ev,phase,matcher in plan:
    arr=cfg.setdefault(ev,[])            # Codex: 顶层事件名,无 hooks 外层
    arr[:]=[e for e in arr if "budget_guard.sh" not in json.dumps(e)]
    entry={"hooks":[{"type":"command","command":f"{guard} {agent} {phase}","timeout":15}]}
    if matcher: entry["matcher"]=matcher
    arr.append(entry)
json.dump(cfg,open(path,"w"),ensure_ascii=False,indent=2); open(path,"a").write("\n")
print(f"✓ hook → {path}")
PY

# 3) 写入行为协议到 AGENTS.md(幂等)
mkdir -p "$(dirname "$MEMORY")"
read -r -d '' RULES <<'BLOCK' || true
## 额度守卫协议(自动安装,无需手动配置)

你运行在一个会监控订阅额度的环境里:
- 平时无感,不要主动提额度。只在收到带「额度已用 X%」的提示时才理会。
- 软线提示(约 78%):收尾当前步,把进度写进 .agent/checkpoint.md。
- 硬线(约 88%,deny 或循环被停):立即停。不重试、不绕路。只做:① 写 .agent/checkpoint.md(写文件不被拦);② 用文字说清续接点;③ 停下。
- 开始 /goal 等长任务时会先收到额度预估(还能跑多久、何时刷新)。据此把目标切成 checkpoint 化小块,先做最关键的部分。
- 新会话带「续接」提示时,从 checkpoint 的「下一步」继续,跳过「已完成」。

.agent/checkpoint.md 格式:
# Checkpoint <时间>
## 任务: <一句话>
## 已完成: ...
## 进行中(中断点): <文件/函数/步骤>
## 下一步: 1) ... 2) ...
## 关键决策/约束: ...
## 别再做: <已完成项>
BLOCK
python3 - "$MEMORY" "$MARK_START" "$MARK_END" "$RULES" <<'PY'
import sys,re,os
p,a,b,rules=sys.argv[1:5]
block=f"{a}\n{rules.strip()}\n{b}\n"
if os.path.exists(p):
    t=open(p,encoding="utf-8").read()
    t=re.sub(re.escape(a)+r".*?"+re.escape(b)+r"\n?","",t,flags=re.S).rstrip()+"\n\n"+block
else: t=block
open(p,"w",encoding="utf-8").write(t); print(f"✓ 协议 → {p}")
PY

cat <<EOF

完成。Codex 重开会话,输入 /hooks 确认已加载 budget_guard。

要确认 / 可能要改:
  1. Codex usage 端点 URL:抓 codex 的 /status 包确认真实地址,然后
       export BUDGET_CODEX_URL=…   (默认猜测可能不对,不对时 guard 会 fail-open 静默)
  2. hooks.json 外层:本器按「顶层事件名」写;若你的版本不认,把 $HOOKS
     包一层 {"hooks": { … }} 再试(/hooks 验证)。
  3. 阈值:export BUDGET_SOFT=78 BUDGET_HARD=88

自动续跑(托管,默认关闭、有风险):
  确认权限后 export BUDGET_WATCHDOG_ARM=1,加 cron(每 10 分钟):
    */10 * * * * BUDGET_WATCHDOG_ARM=1 $BIN/watchdog.sh codex >> ~/.budget-guard/watchdog.log 2>&1
  续跑用 codex exec resume --full-auto;不设 ARM 时只 dry-run。

卸载:./install.sh --uninstall
EOF
