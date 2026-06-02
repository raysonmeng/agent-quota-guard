#!/usr/bin/env bash
# install.sh —— Codex 版「额度守卫」独立安装器
#   ./install.sh              安装(幂等)
#   ./install.sh --uninstall  卸载
#
# 装完即用、无需配置:平时静默,接近额度才提示,/goal 等长任务给预估,
# 硬线轮末干净暂停 + 写 checkpoint,新会话发「继续」自动续接。
#
# 运行期依赖 jq;安装时额外需要 python3。
# 注意:Codex 现版 PreToolUse 覆盖 Bash、apply_patch、MCP 和扩展工具。

set -euo pipefail
AGENT="codex"
HERE="$(cd "$(dirname "$0")" && pwd)"
BIN="$HOME/.budget-guard/bin"
MCP_DIR="$HOME/.budget-guard/mcp"
HOOKS="$HOME/.codex/hooks.json"
CONFIG="$HOME/.codex/config.toml"
MEMORY="$HOME/.codex/AGENTS.md"
MARK_START="<!-- budget-guard:start -->"; MARK_END="<!-- budget-guard:end -->"
MCP_TIMEOUT_SEC="${BUDGET_MCP_TOOL_TIMEOUT_SEC:-700000}"

uninstall() {
  command -v python3 >/dev/null || { echo "需要 python3"; exit 1; }
  [[ -f "$HOOKS" ]] && python3 - "$HOOKS" <<'PY'
import json,sys,time,shutil
p=sys.argv[1]
try: cfg=json.load(open(p))
except: sys.exit(0)
shutil.copy2(p,p+f".bak.{int(time.time())}")
roots = [cfg.get("hooks", {})]
if any(k in cfg for k in ("UserPromptSubmit","PreToolUse","PostToolUse","Stop","SessionStart")):
    roots.append(cfg)
for root in roots:
    for ev in list(root):
        if isinstance(root[ev],list):
            root[ev]=[e for e in root[ev] if "budget_guard.sh" not in json.dumps(e)]
            if not root[ev]: del root[ev]
if not cfg.get("hooks"): cfg.pop("hooks", None)
json.dump(cfg,open(p,"w"),ensure_ascii=False,indent=2); open(p,"a").write("\n")
print("✓ 已从 hooks.json 移除 hook")
PY
  [[ -f "$CONFIG" ]] && python3 - "$CONFIG" <<'PY'
import os, re, shutil, sys, time
p=sys.argv[1]
try:
    text=open(p,encoding="utf-8").read()
except OSError:
    sys.exit(0)
new=re.sub(r"(?ms)^\[mcp_servers\.budget-guard\]\n.*?(?=^\[|\Z)", "", text).rstrip() + "\n"
if new != text:
    shutil.copy2(p,p+f".bak.{int(time.time())}")
    open(p,"w",encoding="utf-8").write(new)
    print("✓ 已从 config.toml 移除 budget-guard MCP server")
PY
  if [[ -f "$MEMORY" ]]; then
    python3 - "$MEMORY" "$MARK_START" "$MARK_END" <<'PY'
import sys,re
p,a,b=sys.argv[1:4]; t=open(p,encoding="utf-8").read()
t=re.sub(re.escape(a)+r".*?"+re.escape(b)+r"\n?","",t,flags=re.S)
open(p,"w",encoding="utf-8").write(t.rstrip()+"\n"); print("✓ 已移除 AGENTS.md 协议块")
PY
  fi
  echo "卸载完成。脚本本体仍在 ${BIN}。"; exit 0
}
[[ "${1:-}" == "--uninstall" ]] && uninstall

command -v python3 >/dev/null || { echo "✗ 需要 python3(仅安装时)"; exit 1; }
command -v jq >/dev/null || echo "⚠ 未检测到 jq;guard 运行期需要 jq。"
command -v node >/dev/null || echo "⚠ 未检测到 node;budget MCP server 运行期需要 node。"
command -v npm >/dev/null || echo "⚠ 未检测到 npm;安装 MCP SDK 依赖需要 npm。"

# 1) 部署脚本
mkdir -p "$BIN"
cp "$HERE/budget_guard.sh" "$BIN/"
cp "$HERE/watchdog.sh" "$BIN/"
cp "$HERE/budget-probe" "$BIN/"
chmod +x "$BIN/budget_guard.sh" "$BIN/watchdog.sh" "$BIN/budget-probe"
echo "✓ 脚本 → $BIN"

# 1b) 部署 MCP server(官方 SDK,stdio)
if [[ -f "$HERE/mcp-server.mjs" ]]; then
  mkdir -p "$MCP_DIR"
  cp "$HERE/package.json" "$MCP_DIR/"
  [[ -f "$HERE/package-lock.json" ]] && cp "$HERE/package-lock.json" "$MCP_DIR/"
  cp "$HERE/mcp-server.mjs" "$MCP_DIR/"
  cp "$HERE/mcp-tools.mjs" "$MCP_DIR/"
  rm -f "$MCP_DIR/budget-probe"
  if command -v npm >/dev/null; then
    if (cd "$MCP_DIR" && npm install --omit=dev --silent); then
      echo "✓ MCP server → $MCP_DIR"
    else
      echo "⚠ MCP server 已复制,但依赖安装失败;稍后在 $MCP_DIR 运行 npm install --omit=dev。"
    fi
  else
    echo "⚠ 已复制 MCP server,但未安装依赖(npm 不存在)。"
  fi
fi

# 2) 合并 hook 进 hooks.json({"hooks":{...}};幂等、备份)
mkdir -p "$(dirname "$HOOKS")"
GUARD="$BIN/budget_guard.sh" python3 - "$HOOKS" "$AGENT" <<'PY'
import json,sys,os,time,shutil
path,agent=sys.argv[1],sys.argv[2]; guard=os.environ["GUARD"]
try: cfg=json.load(open(path)) if os.path.exists(path) and open(path).read().strip() else {}
except json.JSONDecodeError: sys.exit(f"✗ {path} 不是合法 JSON,先修复再装。")
if os.path.exists(path): shutil.copy2(path,path+f".bak.{int(time.time())}")
M=".*"
h=cfg.setdefault("hooks",{})
# 迁移旧安装器写过的顶层事件名,避免同一 hook 重复触发。
for ev in ("UserPromptSubmit","PreToolUse","PostToolUse","Stop","SessionStart"):
    old = cfg.pop(ev, None)
    if isinstance(old, list):
        kept = [e for e in old if "budget_guard.sh" not in json.dumps(e)]
        if kept:
            h.setdefault(ev, []).extend(kept)
plan=[("UserPromptSubmit","prompt",None),("PreToolUse","pre",M),("PostToolUse","post",M),
      ("Stop","stop",None),("SessionStart","resume",None)]
for ev,phase,matcher in plan:
    arr=h.setdefault(ev,[])
    arr[:]=[e for e in arr if "budget_guard.sh" not in json.dumps(e)]
    entry={"hooks":[{"type":"command","command":f"{guard} {agent} {phase}","timeout":15}]}
    if matcher: entry["matcher"]=matcher
    arr.append(entry)
json.dump(cfg,open(path,"w"),ensure_ascii=False,indent=2); open(path,"a").write("\n")
print(f"✓ hook → {path}")
PY

# 2b) 合并 MCP server 进 Codex config.toml(幂等、备份)
mkdir -p "$(dirname "$CONFIG")"
python3 - "$CONFIG" "$MCP_DIR/mcp-server.mjs" "$MCP_TIMEOUT_SEC" <<'PY'
import json, os, re, shutil, sys, time

path, server, timeout = sys.argv[1:4]
try:
    timeout_value = float(timeout)
except ValueError:
    sys.exit(f"✗ BUDGET_MCP_TOOL_TIMEOUT_SEC 非数字: {timeout}")
if timeout_value < 18000:
    sys.exit("✗ BUDGET_MCP_TOOL_TIMEOUT_SEC 太小,至少应覆盖 5h 窗口。")

text = ""
if os.path.exists(path):
    shutil.copy2(path, path + f".bak.{int(time.time())}")
    text = open(path, encoding="utf-8").read()

table_re = re.compile(r"(?ms)^\[mcp_servers\.budget-guard\]\n.*?(?=^\[|\Z)")
text = table_re.sub("", text).rstrip()
block = f"""

[mcp_servers.budget-guard]
command = "node"
args = [{json.dumps(server)}]
tool_timeout_sec = {timeout_value:.1f}
""".lstrip()
text = (text + "\n\n" + block).lstrip()
open(path, "w", encoding="utf-8").write(text.rstrip() + "\n")
print(f"✓ MCP config → {path} (tool_timeout_sec={timeout_value:.0f})")
PY

# 3) 写入行为协议到 AGENTS.md(幂等)
mkdir -p "$(dirname "$MEMORY")"
read -r -d '' RULES <<'BLOCK' || true
## 额度守卫协议(自动安装,无需手动配置)

你运行在一个会监控订阅额度的环境里:
- 平时无感,不要主动提额度。只在收到带「额度已用 X%」的提示时才理会。
- 软线提示(约 78%):收尾当前步,把进度写进 .agent/checkpoint.md。
- T1 提醒(约 80%):本窗口提醒一次,确认目标能收束。
- T2 提醒(约 90%):每次提醒时都收尾当前步,把进度写进 .agent/checkpoint.md。
- T3 硬线(约 92%,deny 或循环被停):立即停。不重试、不绕路。只做:① 写 .agent/checkpoint.md;② 若可用,调用 budget-guard MCP 的 wait_until_budget_refresh 原地等刷新;③ 若不能调用工具,用文字说清续接点并停下。
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
MCP server 已注册为 budget-guard;运行 codex mcp get budget-guard 确认 tool_timeout_sec 足够大。

要确认 / 可能要改:
  1. Codex usage 端点默认 https://chatgpt.com/backend-api/wham/usage。
     如有自定义 ChatGPT base,在 ~/.codex/config.toml 设置 chatgpt_base_url。
  2. hooks.json 外层:本器按当前 Codex 的 {"hooks": { … }} 结构写入;
     用 /hooks 验证是否加载。
  3. 阈值:export BUDGET_WARN_ONCE=80 BUDGET_WARN_REPEAT=90 BUDGET_HARD=92
     BUDGET_SOFT 仍作为 WARN_REPEAT 的 deprecated alias。
  4. MCP 长阻塞:Codex 默认 tool_timeout_sec=120s,本安装器只给 budget-guard server
     配长超时。可用 BUDGET_MCP_TOOL_TIMEOUT_SEC 覆盖(默认 $MCP_TIMEOUT_SEC 秒)。

自动续跑(托管,默认关闭、有风险):
  确认权限后 export BUDGET_WATCHDOG_ARM=1,加 cron(每 10 分钟):
    */10 * * * * BUDGET_WATCHDOG_ARM=1 $BIN/watchdog.sh codex >> ~/.budget-guard/watchdog.log 2>&1
  续跑用 codex exec --sandbox workspace-write resume;不设 ARM 时只 dry-run。

卸载:./install.sh --uninstall
EOF
