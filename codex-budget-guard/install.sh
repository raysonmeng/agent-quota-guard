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
LEGACY_HOOKS="$HOME/.codex/hooks.json"
CONFIG="$HOME/.codex/config.toml"
MEMORY="$HOME/.codex/AGENTS.md"
MARK_START="<!-- budget-guard:start -->"; MARK_END="<!-- budget-guard:end -->"
MCP_TIMEOUT_SEC="${BUDGET_MCP_TOOL_TIMEOUT_SEC:-700000}"

uninstall() {
  command -v python3 >/dev/null || { echo "需要 python3"; exit 1; }
  [[ -f "$LEGACY_HOOKS" ]] && python3 - "$LEGACY_HOOKS" "$BIN/budget_guard.sh" "$AGENT" <<'PY'
import json,re,sys,time,shutil
p,guard,agent=sys.argv[1:4]
try: cfg=json.load(open(p))
except: sys.exit(0)
if not isinstance(cfg, dict):
    sys.exit(0)
old=json.dumps(cfg,ensure_ascii=False,sort_keys=True)
changed_any = False
roots = []
if isinstance(cfg.get("hooks"), dict):
    roots.append(cfg["hooks"])
if any(k in cfg for k in ("UserPromptSubmit","PreToolUse","PostToolUse","Stop","SessionStart")):
    roots.append(cfg)
PHASES = r"(prompt|pre|post|stop|resume)"
MANAGED_BIN_RE = r"(?:budget_guard\.sh|guard\.mjs)"
MANAGED_PATH_RE = re.compile(rf"^\s*(?:node\s+)?(?:(?:\"[^\"]*[/\\]\.budget-guard[/\\]bin[/\\]{MANAGED_BIN_RE}\")|(?:'[^']*[/\\]\.budget-guard[/\\]bin[/\\]{MANAGED_BIN_RE}')|(?:(?:/|~|\.{{1,2}}/|[A-Za-z]:[/\\]).*?[/\\]\.budget-guard[/\\]bin[/\\]{MANAGED_BIN_RE}))\s+{re.escape(agent)}\s+{PHASES}(?:\s|$)")
EXACT_GUARD_RE = re.compile(rf"^\s*(?:\"{re.escape(guard)}\"|'{re.escape(guard)}'|{re.escape(guard)})\s+{re.escape(agent)}\s+{PHASES}(?:\s|$)")
def is_managed_command(cmd):
    return isinstance(cmd,str) and (EXACT_GUARD_RE.search(cmd) or MANAGED_PATH_RE.search(cmd))
def clean_budget_entry(entry):
    if not isinstance(entry,dict):
        return entry, False
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
        if changed:
            if kept:
                new["hooks"] = kept
            else:
                new.pop("hooks", None)
    if not changed:
        return entry, False
    if "command" in new or new.get("hooks"):
        return new, True
    return None, True
for root in roots:
    if not isinstance(root, dict):
        continue
    for ev in list(root):
        if isinstance(root[ev],list):
            kept = []
            event_changed = False
            for entry in root[ev]:
                cleaned, changed = clean_budget_entry(entry)
                event_changed = event_changed or changed
                if cleaned is not None:
                    kept.append(cleaned)
            if event_changed:
                changed_any = True
                root[ev]=kept
                if not root[ev]: del root[ev]
if changed_any and isinstance(cfg.get("hooks"), dict) and not cfg["hooks"]:
    cfg.pop("hooks", None)
new=json.dumps(cfg,ensure_ascii=False,sort_keys=True)
if new != old:
    shutil.copy2(p,p+f".bak.{int(time.time() * 1000)}")
    json.dump(cfg,open(p,"w"),ensure_ascii=False,indent=2); open(p,"a").write("\n")
    print("✓ 已从 hooks.json 移除 hook")
PY
  [[ -f "$CONFIG" ]] && python3 - "$CONFIG" "$BIN/budget_guard.sh" "$AGENT" <<'PY'
import json, os, re, shutil, sys, time
p,guard,agent=sys.argv[1:4]
EVENTS = ("UserPromptSubmit","PreToolUse","PostToolUse","Stop","SessionStart")
COMMAND_KEY_RE = re.compile(r"(?m)^\s*command\s*=")
INLINE_COMMAND_KEY_RE = re.compile(r"command\s*=")
COMMAND_RE = re.compile(
    r"\s*command\s*=\s*(?:"
    r'"""(?P<triple>.*?)"""'
    r'|"(?P<double>(?:\\.|[^"\\])*)"'
    r"|'''(?P<ltriple>.*?)'''"
    r"|'(?P<lsingle>[^']*)'"
    r")",
    re.S,
)
PHASES = r"(prompt|pre|post|stop|resume)"
MANAGED_BIN_RE = r"(?:budget_guard\.sh|guard\.mjs)"
MANAGED_PATH_RE = re.compile(rf"^\s*(?:node\s+)?(?:(?:\"[^\"]*[/\\]\.budget-guard[/\\]bin[/\\]{MANAGED_BIN_RE}\")|(?:'[^']*[/\\]\.budget-guard[/\\]bin[/\\]{MANAGED_BIN_RE}')|(?:(?:/|~|\.{{1,2}}/|[A-Za-z]:[/\\]).*?[/\\]\.budget-guard[/\\]bin[/\\]{MANAGED_BIN_RE}))\s+{re.escape(agent)}\s+{PHASES}(?:\s|$)")
EXACT_GUARD_RE = re.compile(rf"^\s*(?:\"{re.escape(guard)}\"|'{re.escape(guard)}'|{re.escape(guard)})\s+{re.escape(agent)}\s+{PHASES}(?:\s|$)")

def mask_toml_strings(text):
    out = list(text)
    i = 0
    n = len(text)
    while i < n:
        if text[i] == "#":
            j = text.find("\n", i)
            i = n if j == -1 else j + 1
            continue
        if text.startswith('"""', i) or text.startswith("'''", i):
            delim = text[i:i+3]
            j = i + 3
            while j < n and not text.startswith(delim, j):
                j += 1
            end = min(n, j + 3 if j < n else n)
        elif text[i] == '"':
            j = i + 1
            escaped = False
            while j < n:
                c = text[j]
                if escaped:
                    escaped = False
                elif c == "\\":
                    escaped = True
                elif c == '"':
                    j += 1
                    break
                j += 1
            end = j
        elif text[i] == "'":
            j = text.find("'", i + 1)
            end = n if j == -1 else j + 1
        else:
            i += 1
            continue
        for k in range(i, end):
            out[k] = "x"
        i = end
    return "".join(out)

def hook_group_body_end(masked, start, end):
    body_end = start
    pos = start
    while pos < end:
        line_end = masked.find("\n", pos, end)
        if line_end == -1:
            line_end = end
        else:
            line_end += 1
        line = masked[pos:line_end]
        stripped = line.strip()
        if stripped and not stripped.startswith("#"):
            body_end = line_end
        pos = line_end
    return body_end

def hook_group_removal_end(masked, start, end):
    body_end = hook_group_body_end(masked, start, end)
    m = re.match(r"\s*", masked[body_end:end])
    return body_end + (len(m.group(0)) if m else 0)

def line_spans(text):
    pos = 0
    while pos < len(text):
        end = text.find("\n", pos)
        if end == -1:
            yield pos, len(text), text[pos:]
            return
        yield pos, end + 1, text[pos:end + 1]
        pos = end + 1

def parse_key_part(s, i):
    while i < len(s) and s[i].isspace():
        i += 1
    if i >= len(s):
        return None, i
    if s[i] == '"':
        j = i + 1
        escaped = False
        while j < len(s):
            c = s[j]
            if escaped:
                escaped = False
            elif c == "\\":
                escaped = True
            elif c == '"':
                try:
                    return json.loads(s[i:j + 1]), j + 1
                except Exception:
                    return None, j + 1
            j += 1
        return None, len(s)
    if s[i] == "'":
        j = s.find("'", i + 1)
        if j == -1:
            return None, len(s)
        return s[i + 1:j], j + 1
    j = i
    while j < len(s) and s[j] not in ". \t\r\n":
        j += 1
    if j == i:
        return None, j
    return s[i:j], j

def parse_dotted_key(s):
    parts = []
    i = 0
    while True:
        part, i = parse_key_part(s, i)
        if part is None:
            return None
        parts.append(part)
        while i < len(s) and s[i].isspace():
            i += 1
        if i == len(s):
            return parts
        if s[i] != ".":
            return None
        i += 1

def table_header_from_line(line):
    s = line.strip()
    if s.startswith("[[") and s.endswith("]]"):
        parts = parse_dotted_key(s[2:-2])
        return ("array", parts) if parts else None
    if s.startswith("[") and s.endswith("]") and not s.startswith("[["):
        parts = parse_dotted_key(s[1:-1])
        return ("table", parts) if parts else None
    return None

def iter_table_headers(text):
    masked = mask_toml_strings(text)
    for start, end, masked_line in line_spans(masked):
        if not masked_line.lstrip().startswith("["):
            continue
        raw_line = text[start:end].rstrip("\n")
        masked_content = masked_line.rstrip("\n")
        comment = masked_content.find("#")
        if comment != -1:
            raw_line = raw_line[:comment]
        header = table_header_from_line(raw_line)
        if header:
            kind, parts = header
            yield start, end, kind, parts

def hook_groups(text, event_filter=None):
    masked = mask_toml_strings(text)
    headers = list(iter_table_headers(text))
    for idx, (start, _line_end, kind, parts) in enumerate(headers):
        if kind != "array" or len(parts) != 2 or parts[0] != "hooks":
            continue
        event = parts[1]
        if event_filter is not None and event not in event_filter:
            continue
        end = len(text)
        for next_start, _next_line_end, next_kind, next_parts in headers[idx + 1:]:
            if (
                next_kind == "array"
                and len(next_parts) >= 3
                and next_parts[0] == "hooks"
                and next_parts[1] == event
            ):
                continue
            end = next_start
            break
        yield start, end, hook_group_body_end(masked, start, end), event

def nested_hook_spans(group, event):
    masked = mask_toml_strings(group)
    headers = list(iter_table_headers(group))
    for idx, (start, _line_end, kind, parts) in enumerate(headers):
        if kind != "array" or len(parts) != 3 or parts != ["hooks", event, "hooks"]:
            continue
        end = headers[idx + 1][0] if idx + 1 < len(headers) else len(group)
        yield start, end, hook_group_body_end(masked, start, end)

def command_values(group):
    return command_values_from_keys(group, COMMAND_KEY_RE)

def command_values_anywhere(group):
    return command_values_from_keys(group, INLINE_COMMAND_KEY_RE)

def command_values_from_keys(group, key_re):
    values = []
    masked_group = mask_toml_strings(group)
    for key in key_re.finditer(masked_group):
        m = COMMAND_RE.match(group, key.start())
        if not m:
            continue
        if m.group("triple") is not None:
            values.append(m.group("triple"))
        elif m.group("double") is not None:
            try:
                values.append(json.loads('"' + m.group("double") + '"'))
            except Exception:
                values.append(m.group("double"))
        elif m.group("ltriple") is not None:
            values.append(m.group("ltriple"))
        else:
            values.append(m.group("lsingle"))
    return values

def is_managed_command(cmd):
    return isinstance(cmd,str) and (EXACT_GUARD_RE.search(cmd) or MANAGED_PATH_RE.search(cmd))

def shell_double_quote(value):
    return '"' + re.sub(r'(["\\$`])', r'\\\1', str(value)) + '"'

def managed_hook_command(phase):
    return f"{shell_double_quote(guard)} {agent} {phase}"

def is_budget_group(group):
    return any(is_managed_command(cmd) for cmd in command_values(group))

def is_budget_inline_item(item):
    return any(is_managed_command(cmd) for cmd in command_values_anywhere(item))

def clean_hook_group(group, event):
    spans = list(nested_hook_spans(group, event))
    if not spans:
        return ("", True) if is_budget_group(group) else (group, False)
    masked = mask_toml_strings(group)
    pieces = []
    last = 0
    changed = False
    for start, end, body_end in spans:
        nested = group[start:body_end]
        if is_budget_group(nested):
            pieces.append(group[last:start])
            last = hook_group_removal_end(masked, start, end)
            changed = True
    if not changed:
        return group, False
    pieces.append(group[last:])
    cleaned = "".join(pieces)
    has_user_command = any(not is_managed_command(cmd) for cmd in command_values(cleaned))
    return (cleaned, True) if has_user_command else ("", True)

def strip_budget_hooks(text):
    masked = mask_toml_strings(text)
    pieces = []
    last = 0
    for start, end, body_end, event in hook_groups(text, set(EVENTS)):
        group = text[start:body_end]
        cleaned, changed = clean_hook_group(group, event)
        if changed:
            pieces.append(text[last:start])
            if cleaned.strip():
                pieces.append(cleaned)
                last = body_end
            else:
                last = hook_group_removal_end(masked, start, end)
    pieces.append(text[last:])
    text = "".join(pieces)
    masked = mask_toml_strings(text)
    m = re.search(r"(?m)^(\[hooks\]\n)(\n{2,})", masked)
    if m:
        text = text[:m.start(2)] + "\n" + text[m.end(2):]
    masked = mask_toml_strings(text)
    m = re.search(r"(?ms)^\[hooks\]\n\s*(?=^(?!\[\[hooks\.)\[|\Z)", masked)
    text = text[:m.start()] + text[m.end():] if m else text
    text, _ = rewrite_inline_hook_arrays(text)
    return text

def find_matching_bracket(masked, start):
    pairs = {"[": "]", "{": "}"}
    closers = {"]", "}"}
    stack = []
    for i in range(start, len(masked)):
        c = masked[i]
        if c in pairs:
            stack.append(pairs[c])
        elif c in closers:
            if not stack or c != stack[-1]:
                return None
            stack.pop()
            if not stack:
                return i
    return None

def array_item_spans(masked, start, end):
    item_start = start + 1
    depth = 0
    for i in range(start + 1, end):
        c = masked[i]
        if c in "[{":
            depth += 1
        elif c in "]}":
            depth -= 1
        elif c == "," and depth == 0:
            yield item_start, i
            item_start = i + 1
    yield item_start, end

def rewrite_inline_hook_arrays(text, append_plan=None):
    append_plan = append_plan or {}
    masked = mask_toml_strings(text)
    headers = list(iter_table_headers(text))
    replacements = []
    handled = set()
    for idx, (_start, line_end, kind, parts) in enumerate(headers):
        if kind != "table" or parts != ["hooks"]:
            continue
        section_end = headers[idx + 1][0] if idx + 1 < len(headers) else len(text)
        section_masked = masked[line_end:section_end]
        for event in EVENTS:
            m = re.search(rf"(?m)^\s*{re.escape(event)}\s*=", section_masked)
            if not m:
                continue
            value_start = line_end + m.end()
            while value_start < section_end and masked[value_start].isspace():
                value_start += 1
            if value_start >= section_end or masked[value_start] != "[":
                continue
            value_end = find_matching_bracket(masked, value_start)
            if value_end is None or value_end >= section_end:
                continue
            handled.add(event)
            kept = []
            changed = False
            for item_start, item_end in array_item_spans(masked, value_start, value_end):
                item = text[item_start:item_end].strip()
                if not item:
                    continue
                if is_budget_inline_item(item):
                    changed = True
                else:
                    kept.append(item)
            if event in append_plan:
                phase, matcher = append_plan[event]
                kept.append(inline_hook_entry(event, phase, matcher))
                changed = True
            if changed:
                replacements.append((value_start, value_end + 1, "[" + ", ".join(kept) + "]"))
    if not replacements:
        return text, handled
    pieces = []
    last = 0
    for start, end, replacement in sorted(replacements):
        pieces.append(text[last:start])
        pieces.append(replacement)
        last = end
    pieces.append(text[last:])
    return "".join(pieces), handled

def strip_mcp_budget_table(text):
    masked = mask_toml_strings(text)
    headers = list(iter_table_headers(text))
    pieces = []
    last = 0
    changed = False
    for idx, (start, _line_end, kind, parts) in enumerate(headers):
        if kind != "table" or parts != ["mcp_servers", "budget-guard"]:
            continue
        end = headers[idx + 1][0] if idx + 1 < len(headers) else len(text)
        pieces.append(text[last:start])
        last = hook_group_removal_end(masked, start, end)
        changed = True
    if not changed:
        return text
    pieces.append(text[last:])
    return "".join(pieces)

def restore_line_endings(text, use_crlf):
    return text.replace("\n", "\r\n") if use_crlf else text

try:
    raw=open(p,encoding="utf-8",newline="").read()
except OSError:
    sys.exit(0)
created_marker = p + ".budget-guard-created"
had_preexisting_backup = any(
    name.startswith(os.path.basename(p) + ".bak.")
    for name in os.listdir(os.path.dirname(p) or ".")
)
created_by_installer = os.path.exists(created_marker) or not had_preexisting_backup
use_crlf = raw.count("\r\n") > raw.count("\n") - raw.count("\r\n")
text = raw.replace("\r\n", "\n")
new=strip_budget_hooks(text)
new=strip_mcp_budget_table(new)
out=restore_line_endings(new, use_crlf)
if out != raw:
    shutil.copy2(p,p+f".bak.{int(time.time() * 1000)}")
    if not new.strip() and created_by_installer:
        os.remove(p)
    else:
        open(p,"w",encoding="utf-8",newline="").write(out)
    print("✓ 已从 config.toml 移除 budget-guard hooks/MCP server")
if os.path.exists(created_marker):
    try:
        os.remove(created_marker)
    except OSError:
        pass
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
print("✓ 已移除 AGENTS.md 协议块")
PY
  fi
  echo "卸载完成。脚本本体仍在 ${BIN}。"; exit 0
}
[[ "${1:-}" == "--uninstall" ]] && uninstall

command -v python3 >/dev/null || { echo "✗ 需要 python3(仅安装时)"; exit 1; }
python3 - "$MCP_TIMEOUT_SEC" <<'PY'
import sys
timeout=sys.argv[1]
try:
    timeout_value = float(timeout)
except ValueError:
    sys.exit(f"✗ BUDGET_MCP_TOOL_TIMEOUT_SEC 非数字: {timeout}")
if timeout_value < 18000:
    sys.exit("✗ BUDGET_MCP_TOOL_TIMEOUT_SEC 太小,至少应覆盖 5h 窗口。")
PY
command -v jq >/dev/null || echo "⚠ 未检测到 jq;guard 运行期需要 jq。"
command -v node >/dev/null || echo "⚠ 未检测到 node;budget MCP server 运行期需要 node。"
command -v npm >/dev/null || echo "⚠ 未检测到 npm;安装 MCP SDK 依赖需要 npm。"

# 1) 部署脚本
mkdir -p "$BIN"
cp "$HERE/budget_guard.sh" "$BIN/"
cp "$HERE/watchdog.sh" "$BIN/"
cp "$HERE/budget-probe" "$BIN/"
[[ -f "$HERE/budget-config.sh" ]] && cp "$HERE/budget-config.sh" "$BIN/"
chmod +x "$BIN/budget_guard.sh" "$BIN/watchdog.sh" "$BIN/budget-probe"
[[ -f "$BIN/budget-config.sh" ]] && chmod +x "$BIN/budget-config.sh"
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

# 2) 合并 hooks + MCP server 进 Codex config.toml(幂等、备份)
mkdir -p "$(dirname "$CONFIG")"
python3 - "$CONFIG" "$MCP_DIR/mcp-server.mjs" "$MCP_TIMEOUT_SEC" "$BIN/budget_guard.sh" "$AGENT" <<'PY'
import json, os, re, shutil, sys, time

path, server, timeout, guard, agent = sys.argv[1:6]
EVENTS = ("UserPromptSubmit","PreToolUse","PostToolUse","Stop","SessionStart")
COMMAND_KEY_RE = re.compile(r"(?m)^\s*command\s*=")
INLINE_COMMAND_KEY_RE = re.compile(r"command\s*=")
COMMAND_RE = re.compile(
    r"\s*command\s*=\s*(?:"
    r'"""(?P<triple>.*?)"""'
    r'|"(?P<double>(?:\\.|[^"\\])*)"'
    r"|'''(?P<ltriple>.*?)'''"
    r"|'(?P<lsingle>[^']*)'"
    r")",
    re.S,
)
PHASES = r"(prompt|pre|post|stop|resume)"
MANAGED_BIN_RE = r"(?:budget_guard\.sh|guard\.mjs)"
MANAGED_PATH_RE = re.compile(rf"^\s*(?:node\s+)?(?:(?:\"[^\"]*[/\\]\.budget-guard[/\\]bin[/\\]{MANAGED_BIN_RE}\")|(?:'[^']*[/\\]\.budget-guard[/\\]bin[/\\]{MANAGED_BIN_RE}')|(?:(?:/|~|\.{{1,2}}/|[A-Za-z]:[/\\]).*?[/\\]\.budget-guard[/\\]bin[/\\]{MANAGED_BIN_RE}))\s+{re.escape(agent)}\s+{PHASES}(?:\s|$)")
EXACT_GUARD_RE = re.compile(rf"^\s*(?:\"{re.escape(guard)}\"|'{re.escape(guard)}'|{re.escape(guard)})\s+{re.escape(agent)}\s+{PHASES}(?:\s|$)")

def mask_toml_strings(text):
    out = list(text)
    i = 0
    n = len(text)
    while i < n:
        if text[i] == "#":
            j = text.find("\n", i)
            i = n if j == -1 else j + 1
            continue
        if text.startswith('"""', i) or text.startswith("'''", i):
            delim = text[i:i+3]
            j = i + 3
            while j < n and not text.startswith(delim, j):
                j += 1
            end = min(n, j + 3 if j < n else n)
        elif text[i] == '"':
            j = i + 1
            escaped = False
            while j < n:
                c = text[j]
                if escaped:
                    escaped = False
                elif c == "\\":
                    escaped = True
                elif c == '"':
                    j += 1
                    break
                j += 1
            end = j
        elif text[i] == "'":
            j = text.find("'", i + 1)
            end = n if j == -1 else j + 1
        else:
            i += 1
            continue
        for k in range(i, end):
            out[k] = "x"
        i = end
    return "".join(out)

def hook_group_body_end(masked, start, end):
    body_end = start
    pos = start
    while pos < end:
        line_end = masked.find("\n", pos, end)
        if line_end == -1:
            line_end = end
        else:
            line_end += 1
        line = masked[pos:line_end]
        stripped = line.strip()
        if stripped and not stripped.startswith("#"):
            body_end = line_end
        pos = line_end
    return body_end

def hook_group_removal_end(masked, start, end):
    body_end = hook_group_body_end(masked, start, end)
    m = re.match(r"\s*", masked[body_end:end])
    return body_end + (len(m.group(0)) if m else 0)

def line_spans(text):
    pos = 0
    while pos < len(text):
        end = text.find("\n", pos)
        if end == -1:
            yield pos, len(text), text[pos:]
            return
        yield pos, end + 1, text[pos:end + 1]
        pos = end + 1

def parse_key_part(s, i):
    while i < len(s) and s[i].isspace():
        i += 1
    if i >= len(s):
        return None, i
    if s[i] == '"':
        j = i + 1
        escaped = False
        while j < len(s):
            c = s[j]
            if escaped:
                escaped = False
            elif c == "\\":
                escaped = True
            elif c == '"':
                try:
                    return json.loads(s[i:j + 1]), j + 1
                except Exception:
                    return None, j + 1
            j += 1
        return None, len(s)
    if s[i] == "'":
        j = s.find("'", i + 1)
        if j == -1:
            return None, len(s)
        return s[i + 1:j], j + 1
    j = i
    while j < len(s) and s[j] not in ". \t\r\n":
        j += 1
    if j == i:
        return None, j
    return s[i:j], j

def parse_dotted_key(s):
    parts = []
    i = 0
    while True:
        part, i = parse_key_part(s, i)
        if part is None:
            return None
        parts.append(part)
        while i < len(s) and s[i].isspace():
            i += 1
        if i == len(s):
            return parts
        if s[i] != ".":
            return None
        i += 1

def table_header_from_line(line):
    s = line.strip()
    if s.startswith("[[") and s.endswith("]]"):
        parts = parse_dotted_key(s[2:-2])
        return ("array", parts) if parts else None
    if s.startswith("[") and s.endswith("]") and not s.startswith("[["):
        parts = parse_dotted_key(s[1:-1])
        return ("table", parts) if parts else None
    return None

def iter_table_headers(text):
    masked = mask_toml_strings(text)
    for start, end, masked_line in line_spans(masked):
        if not masked_line.lstrip().startswith("["):
            continue
        raw_line = text[start:end].rstrip("\n")
        masked_content = masked_line.rstrip("\n")
        comment = masked_content.find("#")
        if comment != -1:
            raw_line = raw_line[:comment]
        header = table_header_from_line(raw_line)
        if header:
            kind, parts = header
            yield start, end, kind, parts

def hook_groups(text, event_filter=None):
    masked = mask_toml_strings(text)
    headers = list(iter_table_headers(text))
    for idx, (start, _line_end, kind, parts) in enumerate(headers):
        if kind != "array" or len(parts) != 2 or parts[0] != "hooks":
            continue
        event = parts[1]
        if event_filter is not None and event not in event_filter:
            continue
        end = len(text)
        for next_start, _next_line_end, next_kind, next_parts in headers[idx + 1:]:
            if (
                next_kind == "array"
                and len(next_parts) >= 3
                and next_parts[0] == "hooks"
                and next_parts[1] == event
            ):
                continue
            end = next_start
            break
        yield start, end, hook_group_body_end(masked, start, end), event

def nested_hook_spans(group, event):
    masked = mask_toml_strings(group)
    headers = list(iter_table_headers(group))
    for idx, (start, _line_end, kind, parts) in enumerate(headers):
        if kind != "array" or len(parts) != 3 or parts != ["hooks", event, "hooks"]:
            continue
        end = headers[idx + 1][0] if idx + 1 < len(headers) else len(group)
        yield start, end, hook_group_body_end(masked, start, end)

def command_values(group):
    return command_values_from_keys(group, COMMAND_KEY_RE)

def command_values_anywhere(group):
    return command_values_from_keys(group, INLINE_COMMAND_KEY_RE)

def command_values_from_keys(group, key_re):
    values = []
    masked_group = mask_toml_strings(group)
    for key in key_re.finditer(masked_group):
        m = COMMAND_RE.match(group, key.start())
        if not m:
            continue
        if m.group("triple") is not None:
            values.append(m.group("triple"))
        elif m.group("double") is not None:
            try:
                values.append(json.loads('"' + m.group("double") + '"'))
            except Exception:
                values.append(m.group("double"))
        elif m.group("ltriple") is not None:
            values.append(m.group("ltriple"))
        else:
            values.append(m.group("lsingle"))
    return values

def is_managed_command(cmd):
    return isinstance(cmd,str) and (EXACT_GUARD_RE.search(cmd) or MANAGED_PATH_RE.search(cmd))

def shell_double_quote(value):
    return '"' + re.sub(r'(["\\$`])', r'\\\1', str(value)) + '"'

def managed_hook_command(phase):
    return f"{shell_double_quote(guard)} {agent} {phase}"

def is_budget_group(group):
    return any(is_managed_command(cmd) for cmd in command_values(group))

def is_budget_inline_item(item):
    return any(is_managed_command(cmd) for cmd in command_values_anywhere(item))

def clean_hook_group(group, event):
    spans = list(nested_hook_spans(group, event))
    if not spans:
        return ("", True) if is_budget_group(group) else (group, False)
    masked = mask_toml_strings(group)
    pieces = []
    last = 0
    changed = False
    for start, end, body_end in spans:
        nested = group[start:body_end]
        if is_budget_group(nested):
            pieces.append(group[last:start])
            last = hook_group_removal_end(masked, start, end)
            changed = True
    if not changed:
        return group, False
    pieces.append(group[last:])
    cleaned = "".join(pieces)
    has_user_command = any(not is_managed_command(cmd) for cmd in command_values(cleaned))
    return (cleaned, True) if has_user_command else ("", True)

def strip_budget_hooks(text):
    masked = mask_toml_strings(text)
    pieces = []
    last = 0
    for start, end, body_end, event in hook_groups(text, set(EVENTS)):
        group = text[start:body_end]
        cleaned, changed = clean_hook_group(group, event)
        if changed:
            pieces.append(text[last:start])
            if cleaned.strip():
                pieces.append(cleaned)
                last = body_end
            else:
                last = hook_group_removal_end(masked, start, end)
    pieces.append(text[last:])
    text = "".join(pieces)
    masked = mask_toml_strings(text)
    m = re.search(r"(?m)^(\[hooks\]\n)(\n{2,})", masked)
    if m:
        text = text[:m.start(2)] + "\n" + text[m.end(2):]
    masked = mask_toml_strings(text)
    m = re.search(r"(?ms)^\[hooks\]\n\s*(?=^(?!\[\[hooks\.)\[|\Z)", masked)
    text = text[:m.start()] + text[m.end():] if m else text
    text, _ = rewrite_inline_hook_arrays(text)
    return text

def find_matching_bracket(masked, start):
    pairs = {"[": "]", "{": "}"}
    closers = {"]", "}"}
    stack = []
    for i in range(start, len(masked)):
        c = masked[i]
        if c in pairs:
            stack.append(pairs[c])
        elif c in closers:
            if not stack or c != stack[-1]:
                return None
            stack.pop()
            if not stack:
                return i
    return None

def array_item_spans(masked, start, end):
    item_start = start + 1
    depth = 0
    for i in range(start + 1, end):
        c = masked[i]
        if c in "[{":
            depth += 1
        elif c in "]}":
            depth -= 1
        elif c == "," and depth == 0:
            yield item_start, i
            item_start = i + 1
    yield item_start, end

def inline_hook_entry(event, phase, matcher=None):
    fields = []
    if matcher:
        fields.append(f"matcher = {json.dumps(matcher)}")
    fields.append(
        'hooks = [{ type = "command", '
        f"command = {json.dumps(managed_hook_command(phase))}, "
        "timeout = 15 }]"
    )
    return "{ " + ", ".join(fields) + " }"

def rewrite_inline_hook_arrays(text, append_plan=None):
    append_plan = append_plan or {}
    masked = mask_toml_strings(text)
    headers = list(iter_table_headers(text))
    replacements = []
    handled = set()
    for idx, (_start, line_end, kind, parts) in enumerate(headers):
        if kind != "table" or parts != ["hooks"]:
            continue
        section_end = headers[idx + 1][0] if idx + 1 < len(headers) else len(text)
        section_masked = masked[line_end:section_end]
        for event in EVENTS:
            m = re.search(rf"(?m)^\s*{re.escape(event)}\s*=", section_masked)
            if not m:
                continue
            value_start = line_end + m.end()
            while value_start < section_end and masked[value_start].isspace():
                value_start += 1
            if value_start >= section_end or masked[value_start] != "[":
                continue
            value_end = find_matching_bracket(masked, value_start)
            if value_end is None or value_end >= section_end:
                continue
            handled.add(event)
            kept = []
            changed = False
            for item_start, item_end in array_item_spans(masked, value_start, value_end):
                item = text[item_start:item_end].strip()
                if not item:
                    continue
                if is_budget_inline_item(item):
                    changed = True
                else:
                    kept.append(item)
            if event in append_plan:
                phase, matcher = append_plan[event]
                kept.append(inline_hook_entry(event, phase, matcher))
                changed = True
            if changed:
                replacements.append((value_start, value_end + 1, "[" + ", ".join(kept) + "]"))
    if not replacements:
        return text, handled
    pieces = []
    last = 0
    for start, end, replacement in sorted(replacements):
        pieces.append(text[last:start])
        pieces.append(replacement)
        last = end
    pieces.append(text[last:])
    return "".join(pieces), handled

def strip_mcp_budget_table(text):
    masked = mask_toml_strings(text)
    headers = list(iter_table_headers(text))
    pieces = []
    last = 0
    changed = False
    for idx, (start, _line_end, kind, parts) in enumerate(headers):
        if kind != "table" or parts != ["mcp_servers", "budget-guard"]:
            continue
        end = headers[idx + 1][0] if idx + 1 < len(headers) else len(text)
        pieces.append(text[last:start])
        last = hook_group_removal_end(masked, start, end)
        changed = True
    if not changed:
        return text
    pieces.append(text[last:])
    return "".join(pieces)

def hook_group(event, phase, matcher=None):
    lines = [f"[[hooks.{event}]]"]
    if matcher:
        lines.append(f"matcher = {json.dumps(matcher)}")
    lines.extend([
        "",
        f"[[hooks.{event}.hooks]]",
        'type = "command"',
        f"command = {json.dumps(managed_hook_command(phase))}",
        "timeout = 15",
    ])
    return "\n".join(lines)

def insert_block_at(text, end, block):
    m = re.match(r"\n*", text[end:])
    leading_newlines = m.group(0) if m else ""
    suffix = text[end + len(leading_newlines):]
    return text[:end] + leading_newlines + block.rstrip() + "\n" + suffix

def insert_hooks(text, block):
    block = block.rstrip()
    if not block:
        return text
    groups = list(hook_groups(text))
    if groups:
        end = groups[-1][2]
        return insert_block_at(text, end, block)
    headers = list(iter_table_headers(text))
    for idx, (_start, line_end, kind, parts) in enumerate(headers):
        if kind == "table" and parts == ["hooks"]:
            end = headers[idx + 1][0] if idx + 1 < len(headers) else len(text)
            return insert_block_at(text, end, block)
    section = "[hooks]\n\n" + block + "\n"
    if not text:
        return section
    if text.endswith("\n\n"):
        return text + section
    if text.endswith("\n"):
        return text + section
    return text + "\n" + section

def append_block(text, block):
    block = block.rstrip() + "\n"
    if not text:
        return block
    if text.endswith("\n"):
        return text + block
    return text + "\n" + block

def restore_line_endings(text, use_crlf):
    return text.replace("\n", "\r\n") if use_crlf else text

try:
    timeout_value = float(timeout)
except ValueError:
    sys.exit(f"✗ BUDGET_MCP_TOOL_TIMEOUT_SEC 非数字: {timeout}")
if timeout_value < 18000:
    sys.exit("✗ BUDGET_MCP_TOOL_TIMEOUT_SEC 太小,至少应覆盖 5h 窗口。")

text = ""
raw = ""
use_crlf = False
created_marker = path + ".budget-guard-created"
path_existed = os.path.exists(path)
keep_created_marker = not path_existed
if path_existed:
    shutil.copy2(path, path + f".bak.{int(time.time() * 1000)}")
    raw = open(path, encoding="utf-8", newline="").read()
    use_crlf = raw.count("\r\n") > raw.count("\n") - raw.count("\r\n")
    text = raw.replace("\r\n", "\n")
    existing_unmanaged = strip_mcp_budget_table(strip_budget_hooks(text))
    keep_created_marker = os.path.exists(created_marker) and raw.strip() and not existing_unmanaged.strip()

text = strip_budget_hooks(text)
hook_plan = [
    ("UserPromptSubmit", "prompt", None),
    ("PreToolUse", "pre", "*"),
    ("PostToolUse", "post", "*"),
    ("Stop", "stop", None),
    ("SessionStart", "resume", None),
]
text, inline_events = rewrite_inline_hook_arrays(
    text,
    {event: (phase, matcher) for event, phase, matcher in hook_plan}
)
hook_block = "\n\n".join(
    hook_group(event, phase, matcher)
    for event, phase, matcher in hook_plan
    if event not in inline_events
)
text = insert_hooks(text, hook_block)

text = strip_mcp_budget_table(text)
mcp_block = f"""

[mcp_servers.budget-guard]
command = "node"
args = [{json.dumps(server)}]
tool_timeout_sec = {timeout_value:.1f}
""".lstrip()
text = append_block(text, mcp_block)
out = restore_line_endings(text, use_crlf)
open(path, "w", encoding="utf-8", newline="").write(out)
if keep_created_marker:
    try:
        open(created_marker, "w", encoding="utf-8").write("created by budget-guard\n")
    except OSError:
        pass
elif os.path.exists(created_marker):
    try:
        os.remove(created_marker)
    except OSError:
        pass
print(f"✓ hooks/MCP config → {path} (tool_timeout_sec={timeout_value:.0f})")
PY

# 2b) config.toml 写入成功后,再清理旧版 hooks.json 中的 budget-guard hook,避免升级后双注册。
if [[ -f "$LEGACY_HOOKS" ]]; then
  python3 - "$LEGACY_HOOKS" "$BIN/budget_guard.sh" "$AGENT" <<'PY'
import json,re,sys,time,shutil
p,guard,agent=sys.argv[1:4]
try: cfg=json.load(open(p))
except: sys.exit(0)
if not isinstance(cfg, dict):
    sys.exit(0)
old=json.dumps(cfg,ensure_ascii=False,sort_keys=True)
changed_any = False
roots = []
if isinstance(cfg.get("hooks"), dict):
    roots.append(cfg["hooks"])
if any(k in cfg for k in ("UserPromptSubmit","PreToolUse","PostToolUse","Stop","SessionStart")):
    roots.append(cfg)
PHASES = r"(prompt|pre|post|stop|resume)"
MANAGED_BIN_RE = r"(?:budget_guard\.sh|guard\.mjs)"
MANAGED_PATH_RE = re.compile(rf"^\s*(?:node\s+)?(?:(?:\"[^\"]*[/\\]\.budget-guard[/\\]bin[/\\]{MANAGED_BIN_RE}\")|(?:'[^']*[/\\]\.budget-guard[/\\]bin[/\\]{MANAGED_BIN_RE}')|(?:(?:/|~|\.{{1,2}}/|[A-Za-z]:[/\\]).*?[/\\]\.budget-guard[/\\]bin[/\\]{MANAGED_BIN_RE}))\s+{re.escape(agent)}\s+{PHASES}(?:\s|$)")
EXACT_GUARD_RE = re.compile(rf"^\s*(?:\"{re.escape(guard)}\"|'{re.escape(guard)}'|{re.escape(guard)})\s+{re.escape(agent)}\s+{PHASES}(?:\s|$)")
def is_managed_command(cmd):
    return isinstance(cmd,str) and (EXACT_GUARD_RE.search(cmd) or MANAGED_PATH_RE.search(cmd))
def clean_budget_entry(entry):
    if not isinstance(entry,dict):
        return entry, False
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
        if changed:
            if kept:
                new["hooks"] = kept
            else:
                new.pop("hooks", None)
    if not changed:
        return entry, False
    if "command" in new or new.get("hooks"):
        return new, True
    return None, True
for root in roots:
    if not isinstance(root, dict):
        continue
    for ev in list(root):
        if isinstance(root[ev],list):
            kept = []
            event_changed = False
            for entry in root[ev]:
                cleaned, changed = clean_budget_entry(entry)
                event_changed = event_changed or changed
                if cleaned is not None:
                    kept.append(cleaned)
            if event_changed:
                changed_any = True
                root[ev]=kept
                if not root[ev]: del root[ev]
if changed_any and isinstance(cfg.get("hooks"), dict) and not cfg["hooks"]:
    cfg.pop("hooks", None)
new=json.dumps(cfg,ensure_ascii=False,sort_keys=True)
if new != old:
    shutil.copy2(p,p+f".bak.{int(time.time() * 1000)}")
    json.dump(cfg,open(p,"w"),ensure_ascii=False,indent=2); open(p,"a").write("\n")
    print("✓ 已清理旧 hooks.json 中的 budget-guard hook")
PY
fi

# 3) 写入行为协议到 AGENTS.md(幂等)
mkdir -p "$(dirname "$MEMORY")"
read -r -d '' RULES <<'BLOCK' || true
## 额度守卫协议(自动安装,无需手动配置)

你运行在一个会监控订阅额度的环境里:
- 平时无感,不要主动提额度。只在收到带「额度已用 X%」的提示时才理会。
- 软线提示(约 78%):收尾当前步,把进度写进 .agent/checkpoint.md。
- T1 提醒(约 80%):本窗口提醒一次,确认目标能收束。
- T2 提醒(约 90%):每次提醒时都收尾当前步,把进度写进 .agent/checkpoint.md。
- T3 硬线(约 92%,减速提醒或循环轮末被停):收到提醒就写 .agent/checkpoint.md 收尾;轮末停下后不重试、不绕路。只做:① 确认 checkpoint 已写;② 若可用,调用 budget-guard MCP 的 wait_until_budget_refresh 原地等刷新;③ 若不能调用工具,用文字说清续接点并停下。
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
import os,re,sys
p,a,b,rules=sys.argv[1:5]
block=f"{a}\n{rules.strip()}\n{b}\n"
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

完成。Codex 重开会话,输入 /hooks 确认已加载 budget_guard。
MCP server 已注册为 budget-guard;运行 codex mcp get budget-guard 确认 tool_timeout_sec 足够大。

要确认 / 可能要改:
  1. Codex usage 端点默认 https://chatgpt.com/backend-api/wham/usage。
     如有自定义 ChatGPT base,在 ~/.codex/config.toml 设置 chatgpt_base_url。
  2. Codex hooks 写入 ~/.codex/config.toml 的 [hooks]/[[hooks.*]] TOML 结构;
     已知 codex exec 0.135.0 不触发 lifecycle hooks,交互 TUI 用 /hooks 验证。
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
