#!/usr/bin/env bash
# install.sh —— Claude Code 版「额度守卫」(DEPRECATED 入口,见下)
#   ./install.sh              安装(幂等,可重复跑)
#   ./install.sh --uninstall  卸载(脚本本体保留在 ~/.budget-guard)
#
# ⚠  优先用新版 Node installer:
#       node bin/install-claude.mjs                  # 安装
#       node bin/install-claude.mjs --uninstall      # 卸载
#   旧 bash install.sh 保留为 fallback + 不破坏现有用户的兜底;
#   内部直接 exec 上述 Node 入口。新功能(协议块的「使用方式」段落、
#   guard.mjs 而非 budget_guard.sh)只在 Node 版里。
#
# 装完即用、无需配置:平时静默,接近额度才提示,/goal/loop 启动给预估,
# 硬线在轮末干净暂停 + 写 checkpoint,新会话发「继续」自动续接。
# watchdog(额度刷新后自动续跑)默认不启用,见末尾说明。
#
# 运行期依赖 jq;本安装脚本额外需要 node >= 18(转发到 Node installer)。

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if command -v node >/dev/null 2>&1; then
  exec node "$REPO_ROOT/bin/install-claude.mjs" "$@"
fi

if [[ "${1:-}" != "--uninstall" ]]; then
  echo "✗  需要 node >= 18 来运行新版 installer(./install.sh 已转发到它)" >&2
  echo "   路径: $REPO_ROOT/bin/install-claude.mjs" >&2
  exit 1
fi
AGENT="claude"
HERE="$(cd "$(dirname "$0")" && pwd)"
BIN="$HOME/.budget-guard/bin"
SETTINGS="$HOME/.claude/settings.json"
MEMORY="$HOME/.claude/CLAUDE.md"
MARK_START="<!-- budget-guard:start -->"; MARK_END="<!-- budget-guard:end -->"

uninstall() {
  command -v python3 >/dev/null || { echo "需要 python3"; exit 1; }
  [[ -f "$SETTINGS" ]] && python3 - "$SETTINGS" <<'PY'
import json,re,sys,time,shutil,os
p=sys.argv[1]
try: cfg=json.load(open(p))
except: sys.exit(0)
shutil.copy2(p,p+f".bak.{int(time.time())}")
h=cfg.get("hooks",{})
PHASES = r"(prompt|pre|post|stop|resume)"
MANAGED_COMMAND_RE = re.compile(rf'^\s*(?:node\s+)?(?:/|~|\.{{1,2}}/|[A-Za-z]:[/\\]).*?[/\\]\.budget-guard[/\\]bin[/\\](?:budget_guard\.sh|guard\.mjs)\s+claude\s+{PHASES}(?:\s|$)')
def is_managed_command(cmd):
    return isinstance(cmd, str) and MANAGED_COMMAND_RE.search(cmd)
def clean_budget_entry(entry):
    if not isinstance(entry, dict):
        return entry
    changed = False
    new = dict(entry)
    if is_managed_command(new.get("command")):
        new.pop("command", None)
        changed = True
    hooks = new.get("hooks")
    if isinstance(hooks, list):
        kept = []
        for hook in hooks:
            if isinstance(hook, dict) and is_managed_command(hook.get("command")):
                changed = True
            else:
                kept.append(hook)
        if kept:
            new["hooks"] = kept
        else:
            new.pop("hooks", None)
    if not changed:
        return entry
    if "command" in new or new.get("hooks"):
        return new
    return None
for ev in list(h):
    if isinstance(h[ev],list):
        h[ev]=[e for e in (clean_budget_entry(e) for e in h[ev]) if e is not None]
        if not h[ev]: del h[ev]
if not h: cfg.pop("hooks",None)
json.dump(cfg,open(p,"w"),ensure_ascii=False,indent=2); open(p,"a").write("\n")
print("✓ 已从 settings.json 移除 hook")
PY
  if [[ -f "$MEMORY" ]]; then
    python3 - "$MEMORY" "$MARK_START" "$MARK_END" <<'PY'
import os,re,sys
p,a,b=sys.argv[1:4]; t=open(p,encoding="utf-8").read()
MANAGED_HEADER="## 额度守卫协议(自动安装,无需手动配置)"
def line_spans(text):
    pos = 0
    while pos < len(text):
        end = text.find("\n", pos)
        if end == -1:
            yield pos, len(text), text[pos:]
            return
        yield pos, end + 1, text[pos:end + 1]
        pos = end + 1
def fence_marker(line):
    m = re.match(r"\s*(`{3,}|~{3,})", line)
    return (m.group(1)[0], len(m.group(1))) if m else None
def managed_blocks(text):
    candidate = None
    fence = None
    for line_start, line_end, line in line_spans(text):
        content = line[:-1] if line.endswith("\n") else line
        marker = fence_marker(content)
        if marker:
            if fence is None:
                fence = marker
            elif marker[0] == fence[0] and marker[1] >= fence[1]:
                fence = None
            continue
        if fence is not None:
            continue
        if content == a:
            candidate = (line_start, line_end)
        elif content == b and candidate:
            start, body_start = candidate
            yield start, line_end, text[body_start:line_start]
            candidate = None
def is_managed_body(body):
    for line in body.splitlines():
        if line.strip():
            return line == MANAGED_HEADER
    return False
def strip_managed_blocks(text):
    pieces = []
    last = 0
    found = False
    for start, end, body in managed_blocks(text):
        if is_managed_body(body):
            pieces.append(text[last:start])
            last = end
            found = True
    if not found:
        return text
    pieces.append(text[last:])
    return "".join(pieces)
t=strip_managed_blocks(t)
out=t.rstrip()
if out:
    open(p,"w",encoding="utf-8").write(out+"\n")
else:
    os.remove(p)
print("✓ 已移除 CLAUDE.md 协议块")
PY
  fi
  echo "卸载完成。脚本本体仍在 $BIN(可手动删)。"; exit 0
}
[[ "${1:-}" == "--uninstall" ]] && uninstall

command -v python3 >/dev/null || { echo "✗ 需要 python3(仅安装时)"; exit 1; }
command -v jq >/dev/null || echo "⚠ 未检测到 jq;guard 运行期需要 jq,请确保已安装。"

# 1) 部署脚本
mkdir -p "$BIN"
cp "$HERE/budget_guard.sh" "$BIN/"
cp "$HERE/watchdog.sh" "$BIN/"
cp "$HERE/budget-probe" "$BIN/"
[[ -f "$HERE/budget-config.sh" ]] && cp "$HERE/budget-config.sh" "$BIN/"
chmod +x "$BIN/budget_guard.sh" "$BIN/watchdog.sh" "$BIN/budget-probe"
[[ -f "$BIN/budget-config.sh" ]] && chmod +x "$BIN/budget-config.sh"
echo "✓ 脚本 → $BIN"

# 2) 合并 hook 进 settings.json(幂等、备份)
mkdir -p "$(dirname "$SETTINGS")"
GUARD="$BIN/budget_guard.sh" python3 - "$SETTINGS" "$AGENT" <<'PY'
import json,re,sys,os,time,shutil
path,agent=sys.argv[1],sys.argv[2]
guard=os.environ["GUARD"]
try: cfg=json.load(open(path)) if os.path.exists(path) and open(path).read().strip() else {}
except json.JSONDecodeError: sys.exit(f"✗ {path} 不是合法 JSON,先修复再装。")
if os.path.exists(path): shutil.copy2(path,path+f".bak.{int(time.time())}")
h=cfg.setdefault("hooks",{})
M="Bash|Edit|Write|MultiEdit|NotebookEdit"
plan=[("UserPromptSubmit","prompt",None),("PreToolUse","pre",M),("PostToolUse","post",M),
      ("Stop","stop",None),("SessionStart","resume",None)]
PHASES = r"(prompt|pre|post|stop|resume)"
MANAGED_COMMAND_RE = re.compile(rf'^\s*(?:node\s+)?(?:{re.escape(guard)}|(?:/|~|\.{{1,2}}/|[A-Za-z]:[/\\]).*?[/\\]\.budget-guard[/\\]bin[/\\](?:budget_guard\.sh|guard\.mjs))\s+{re.escape(agent)}\s+{PHASES}(?:\s|$)')
def is_managed_command(cmd):
    return isinstance(cmd, str) and MANAGED_COMMAND_RE.search(cmd)
def clean_budget_entry(entry):
    if not isinstance(entry, dict):
        return entry
    changed = False
    new = dict(entry)
    if is_managed_command(new.get("command")):
        new.pop("command", None)
        changed = True
    hooks = new.get("hooks")
    if isinstance(hooks, list):
        kept = []
        for hook in hooks:
            if isinstance(hook, dict) and is_managed_command(hook.get("command")):
                changed = True
            else:
                kept.append(hook)
        if kept:
            new["hooks"] = kept
        else:
            new.pop("hooks", None)
    if not changed:
        return entry
    if "command" in new or new.get("hooks"):
        return new
    return None
for ev,phase,matcher in plan:
    arr=h.setdefault(ev,[])
    arr[:]=[e for e in (clean_budget_entry(e) for e in arr) if e is not None]  # 幂等
    entry={"hooks":[{"type":"command","command":f"{guard} {agent} {phase}","timeout":15}]}
    if matcher: entry["matcher"]=matcher
    arr.append(entry)
json.dump(cfg,open(path,"w"),ensure_ascii=False,indent=2); open(path,"a").write("\n")
print(f"✓ hook → {path}")
PY

# 3) 写入行为协议到 CLAUDE.md(幂等)
mkdir -p "$(dirname "$MEMORY")"
read -r -d '' RULES <<'BLOCK' || true
## 额度守卫协议(自动安装,无需手动配置)

你运行在一个会监控订阅额度的环境里:
- 平时无感,不要主动提额度。只在收到带「额度已用 X%」的提示时才理会。
- T1 提醒(约 80%):本窗口提醒一次,确认目标能收束。
- T2 提醒(约 90%):每次提醒时都收尾当前步,把进度写进 .agent/checkpoint.md。
- checkpoint 提醒线(约 95%):收到提醒就尽快把进度写进 .agent/checkpoint.md,给后续自动续接留足 lead。
- T3 硬线(约 99%,最后保险丝;轮末被停或 provider rate-limit):收到提醒就写 .agent/checkpoint.md 收尾;轮末停下后不重试、不绕路。只做:① 确认 checkpoint 已写;② 若环境已配置 budget-guard MCP,调用 wait_until_budget_refresh 原地等刷新;③ 若不能调用工具,用文字说清续接点并停下。
- 开始 /goal /loop /batch 等长任务时会先收到额度预估(还能跑多久、何时刷新)。据此把目标切成 checkpoint 化小块,先做最关键的部分。
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
import re,sys
p,a,b,rules=sys.argv[1:5]
block=f"{a}\n{rules.strip()}\n{b}\n"
import os
MANAGED_HEADER="## 额度守卫协议(自动安装,无需手动配置)"
def line_spans(text):
    pos = 0
    while pos < len(text):
        end = text.find("\n", pos)
        if end == -1:
            yield pos, len(text), text[pos:]
            return
        yield pos, end + 1, text[pos:end + 1]
        pos = end + 1
def fence_marker(line):
    m = re.match(r"\s*(`{3,}|~{3,})", line)
    return (m.group(1)[0], len(m.group(1))) if m else None
def managed_blocks(text):
    candidate = None
    fence = None
    for line_start, line_end, line in line_spans(text):
        content = line[:-1] if line.endswith("\n") else line
        marker = fence_marker(content)
        if marker:
            if fence is None:
                fence = marker
            elif marker[0] == fence[0] and marker[1] >= fence[1]:
                fence = None
            continue
        if fence is not None:
            continue
        if content == a:
            candidate = (line_start, line_end)
        elif content == b and candidate:
            start, body_start = candidate
            yield start, line_end, text[body_start:line_start]
            candidate = None
def is_managed_body(body):
    for line in body.splitlines():
        if line.strip():
            return line == MANAGED_HEADER
    return False
def append_block(text):
    if not text:
        return block
    if text.endswith("\n\n"):
        return text + block
    if text.endswith("\n"):
        return text + "\n" + block
    return text + "\n\n" + block
def upsert_managed_block(text):
    pieces = []
    last = 0
    replaced = False
    for start, end, body in managed_blocks(text):
        if not is_managed_body(body):
            continue
        pieces.append(text[last:start])
        if not replaced:
            pieces.append(block)
            replaced = True
        last = end
    if not replaced:
        return append_block(text)
    pieces.append(text[last:])
    return "".join(pieces)
if os.path.exists(p):
    t=open(p,encoding="utf-8").read()
    t=upsert_managed_block(t)
else: t=block
open(p,"w",encoding="utf-8").write(t); print(f"✓ 协议 → {p}")
PY

cat <<EOF

完成。Claude Code 重开一个会话,/hooks 里应能看到 budget_guard。
平时静默;接近额度才提示;/goal /loop 启动会给规划预估。

可选:阈值  export BUDGET_WARN_ONCE=80 BUDGET_WARN_REPEAT=90 BUDGET_CHECKPOINT_LEAD=95 BUDGET_HARD=99
可选:Codex usage 端点不涉及本包(纯 CC)。

自动续跑(托管,默认关闭、有风险,确认权限后再开):
  先 export BUDGET_WATCHDOG_ARM=1,再加一条 cron(每 10 分钟):
    */10 * * * * BUDGET_WATCHDOG_ARM=1 $BIN/watchdog.sh claude >> ~/.budget-guard/watchdog.log 2>&1
  不设 ARM 时它只 dry-run 打印不执行。先收紧 BUDGET_CLAUDE_ALLOWED 再武装。

卸载:./install.sh --uninstall
EOF
