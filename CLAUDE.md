# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 沟通语言 / Communication language

**永远用中文回复用户。** 无论用户用什么语言提问,所有面向用户的回复一律用中文(代码、命令、标识符、引用的英文术语保持原文)。同样适用于 `AGENTS.md`(Codex 入口),两份文档保持一致。

## 项目本质 / What this is

纯 Bash 实现的「额度守卫」:让 Claude Code 和 Codex 在跑长任务时实时感知订阅额度,接近上限时在**轮末干净暂停 + 写 checkpoint**,而非执行中途被硬切。不读日志、不估算,直接查官方 usage 端点。

不能绕过限额(API 耗尽就是耗尽)。它只能提前停在干净点 + 帮你续接。改任何逻辑前先读 `README.md` §8(诚实边界)和 §9(待确认项)。

无 git、无 package manifest、无测试框架。运行期依赖 `jq` `curl` `awk`(macOS 还用 `security` 读 Keychain);安装期额外需要 `python3`(仅用于安全合并 JSON)。

## 架构关键(读多个文件才能拼出的全貌)

**一份核心,两个包,运行时参数区分 agent。** `claude-budget-guard/` 和 `codex-budget-guard/` 各含三个脚本:
- `budget_guard.sh` —— 两包**逐字节相同**。靠 `$1`(`claude`|`codex`)切换 token 来源和 usage 端点,靠 `$2`(phase)切换行为。
- `watchdog.sh` —— 两包**逐字节相同**。
- `budget-probe` —— 两包**逐字节相同**。统一取数/解析入口,供 hook、watchdog、MCP 共用。
- `install.sh` —— **唯一真正分叉的文件**:CC 版写 `~/.claude/settings.json`(hook 在 `.hooks` 下)+ `CLAUDE.md`;Codex 版写 `~/.codex/config.toml` 的 `[hooks]`(TOML 数组表 `[[hooks.PreToolUse]]` 等)、注册 `budget-guard` MCP server 并写 `tool_timeout_sec`、写 `AGENTS.md`(并清理旧 `hooks.json`——Codex 不读它)。

  > 改任一脚本时,若改的是 `budget_guard.sh`/`watchdog.sh`/`budget-probe`,**必须同步两个目录的副本**(它们是复制而非软链)。`install.sh` 则需分别处理两个分叉版本。

**phase 调度模型** —— guard 挂在五个生命周期事件上,`budget_guard.sh` 末尾的一串 `if [[ "$PHASE" == ... ]]` 分派:

| phase | 挂载事件 | 行为 |
|---|---|---|
| `prompt` | UserPromptSubmit | 检测 `/goal /loop /batch /background`,给规划预估(额度充足时出声的主要情形);另外检测**显式跳过短语**(`/budget-skip`/`force-continue`/`跳过硬线`/`强制继续`),命中则写限时 skip marker(不查用量) |
| `pre` | PreToolUse | checkpoint 提醒线/硬线/可信 runway 收尾保护线只发减速提醒,不 deny;checkpoint 写入与 **skip marker 有效** 时静默放行 |
| `post` | PostToolUse | 追加一条 burn-rate 历史点;软线/提前 checkpoint 提示收尾(skip 有效时 T3 提示改为「不强停」措辞,且不消耗真实 T3 fingerprint) |
| `stop` | Stop/SubagentStop | 循环轮末重估;**util 硬线** `continue:false` 强停 + 写 `pending/<agent>_<scope>.json` 给 watchdog;**skip marker 有效则不强停、不写 pending**。provider 429/rate-limit **只限流探针刷新(改用 stale 缓存 util 判阈值),绝不单独强停/写 pending** —— 它不是额度耗尽 |
| `resume` | SessionStart | 有上次 checkpoint 就注入上下文续接 |

**核心不变量(改代码别破坏):**
- **fail-open**:查不到用量(网络/token/字段对不上/无 `jq`)一律 `exit 0` 静默放行。绝不因守卫自身问题卡死 agent。
- **统一走 `exit 0 + JSON`**,从不混用 `exit 2`。输出协议见 README §10。
- **静默优先**:`util < WARN_ONCE` 时除长任务预估和可信 runway 收尾保护线外一个字不冒。
- **硬线只在轮末停**(`stop` phase),`pre` 只提醒不拦工具——避免执行中途切。默认硬线是 99%,作为外层超限保险丝;默认 checkpoint 提醒线约 95%,用于给 agent 留足写 checkpoint 的 lead。
- **手动跳过(override)只能延后干净停止,绝不绕过限额**:仅显式短语在 `prompt` phase 触发,写限时(`BUDGET_SKIP_TTL`,默认 1800s)、按项目作用域的 marker;`pre`/`stop` 在硬线时若 marker 有效则放行/不强停,到期自动恢复。所有错误路径 fail-safe 朝「无 skip → 继续提醒并在轮末干净停」(坏 marker = 当作过期)。`BUDGET_SKIP_TTL` 是 env-only(**不**在配置文件 ALLOWLIST 内),防止仓库内 `.budget-guard.conf` 偷偷拉长跳过时长。Bash 双包行为保持逐字节一致;Node hook 额外消费 probe v2 的可信 runway 字段,Bash guard 暂只走静态硬线提醒。

**数据流 / 状态目录**(默认 `~/.budget-guard/`,`BUDGET_STATE_DIR` 可覆盖):
- `usage_<agent>.json` —— 用量缓存(`BUDGET_CACHE_TTL` 秒,默认 45;PreToolUse 每次工具调用都跑,必须缓存)。
- `pending/<agent>_<scope>.json` —— **util 硬线**暂停时写的待续队列(provider 429/rate-limit 不写),watchdog/bridge 逐个读它续跑;旧 `pending_<agent>.json` 仅 watchdog 兼容读取。
- `skip/<agent>_<scope>.json` —— 手动跳过硬线的限时授权 marker(`{"expires":<epoch>}`);`pre`/`stop` 读它判断是否放行,过期自动清理。

> `hist_<agent>.jsonl`(burn-rate 历史点)仅 Bash 实现(`budget_guard.sh`)写入。Node lib 不写,watchdog 不读。burn-rate 算法是 Bash 专属(`seconds_to_hard()`,纯 awk);Node lib 不实现(P2 待办)。

**burn-rate 算法**(`seconds_to_hard()`,纯 awk):在 `BUDGET_HIST_WINDOW`(默认 900s)窗口内取最早点和最新点,两点法算 `rate = Δutil/Δt`,外推到 `HARD` 的剩余秒数。`rate ≤ 0` 视为充足(返回 -1)。util 归一化:`≤1` 视为 0–1 比例 ×100。

**CC vs Codex 的真实差异**(改 Codex 分支前必读 README §10):
- Codex 现版 PreToolUse 覆盖 Bash、apply_patch、MCP 和扩展工具;硬线放行 checkpoint 必须精确匹配路径,不能 basename/近似匹配。
- CC 软提示走 `additionalContext`(给 agent 读);Codex 走 `systemMessage`(给用户看)——因 Codex PreToolUse 不支持 `additionalContext`。
- Codex usage 端点已实证为 `https://chatgpt.com/backend-api/wham/usage`;需要 `ChatGPT-Account-Id` header,字段是 `rate_limit.primary_window/secondary_window` 和 `additional_rate_limits[]` 的 `used_percent/reset_at/reset_after_seconds`。

## 常用命令

```bash
# 安装 / 卸载(根目录一键;幂等,改动前自动 .bak)
./install.sh                  # 一次装 Claude + Codex;可加 claude|codex 只装一个
./install.sh --uninstall      # 卸载两个(也可 ./install.sh claude --uninstall)
# 子安装器仍可单独跑:cd claude-budget-guard && ./install.sh(codex 同理)

# 语法检查(无 CI,提交前手动跑)
bash -n claude-budget-guard/budget_guard.sh
shellcheck claude-budget-guard/*.sh codex-budget-guard/*.sh   # 若已装 shellcheck

# 手动触发某个 phase 测试(stdin 喂 hook JSON)
echo '{"prompt":"/goal 重构模块"}' | bash claude-budget-guard/budget_guard.sh claude prompt
echo '{"tool_input":{"command":"ls"}}' | bash claude-budget-guard/budget_guard.sh claude pre

# watchdog 默认 dry-run(只打印不执行),验证续跑命令拼装
bash claude-budget-guard/watchdog.sh claude

# 验证两包核心脚本仍同步(应无输出)
diff claude-budget-guard/budget_guard.sh codex-budget-guard/budget_guard.sh
diff claude-budget-guard/watchdog.sh    codex-budget-guard/watchdog.sh
```

## 测试状态

已有 `codex-budget-guard/test/budget-mcp.test.mjs` 覆盖 Codex fixture parser 和 MCP wait loop;仍需真机验证真实 usage 端点、真机 hook 触发、`/goal` Stop/idle 交互、watchdog headless 续跑。涉及这些的改动需在真机带真 token 验证,不能只靠逻辑推断声称完成。

## 编码风格与命名

- 一律 `#!/usr/bin/env bash`。安装器用 `set -euo pipefail`(快速失败);运行期 guard 用 `set -uo pipefail`(去掉 `-e`,因为大量命令以 `|| true` 兜底实现 fail-open,绝不能因单条失败退出)。
- 配置变量全大写并统一 `BUDGET_` 前缀(`BUDGET_WARN_ONCE` `BUDGET_WARN_REPEAT` `BUDGET_CHECKPOINT_LEAD` `BUDGET_HARD` `BUDGET_STATE_DIR` …),全部可被环境变量覆盖、带默认值。`BUDGET_SOFT` 仅作为 `WARN_REPEAT` 的 deprecated alias。
- 函数小而动词化:`fetch_usage` `record_point` `seconds_to_hard` `fmt_clock` `fmt_dur`。
- 面向用户的文案是**中文**——除非有意改产品语言,否则保持中文,别擅自英化。

## 提交约定

本 checkout **无 git 元数据**,没有可沿用的历史风格。用简洁的祈使式提交,可带 scope:`codex: harden hook install merge`、`claude: fix burn-rate window`。PR 描述行为变化、列出手动验证项、点名任何对用户配置路径(`~/.claude` `~/.codex` `~/.budget-guard`)的改动。

> 落库前遵守全局 cross code review 硬规则(见 `~/.claude/CLAUDE.md`):任何新代码须过两轮独立 subagent 交叉审,连续两个新 reviewer 报 0 真实 issue 才能 commit。纯文档/单行 typo 除外。

## 安全与配置

- **绝不**提交凭据、usage 接口返回、或来自 `~/.claude` `~/.codex` `~/.budget-guard` 的文件。
- 安装器会写入 `~/.budget-guard`、`~/.claude`/`~/.codex`;改安装/卸载流程时在一次性 `HOME` 下验证幂等,别对用户已有配置做破坏性假设(现实现已对已有 hook 做幂等过滤 + 改前 `.bak`,保持这条)。
- `watchdog.sh` 是无人值守跑 agent,默认 `BUDGET_WATCHDOG_ARM=0`(dry-run)。改它的续跑逻辑或权限白名单时,保持默认不武装、限权(`--allowedTools`/`--sandbox workspace-write`/`--max-turns`)、限定项目目录这几条底线。

## 文档关系

`CLAUDE.md`(本文件)是本仓库**唯一权威**的 agent 上手文档。同目录的 `AGENTS.md` 已收成一句指向本文件的指针(原英文内容已并入此处),不再单独维护——所有更新只改本文件。

<!-- AgentBridge:start -->
## AgentBridge — Multi-Agent Collaboration

You are working in a **multi-agent environment** powered by AgentBridge.
Another AI agent (Codex, by OpenAI) is available in a parallel session on this machine.

### Communication mechanism
- **Claude → Codex**: Use the AgentBridge MCP tools (`reply` / `get_messages`) — these are yours only.
- **Codex → Claude**: Codex has no symmetric tool. The bridge transparently intercepts Codex's normal output and forwards it to you. Messages arrive as push notifications (or via `get_messages` in pull mode).
- If Codex ever complains it can't find a "send-to-Claude" API, remind it that its side is transparent — it just writes a reply and you'll see it.

### When to collaborate vs. work solo
- **Collaborate** when the task benefits from a second perspective, parallel execution, or capabilities you lack (e.g., sandboxed code execution, independent verification).
- **Work solo** for simple, self-contained tasks where the coordination overhead isn't worth it.
- When in doubt, **propose a task split** to Codex rather than doing everything yourself.

### Capability comparison
| Capability | Claude (you) | Codex |
|---|---|---|
| Architecture & planning | Strong | Moderate |
| Code review & analysis | Strong | Strong |
| Sandboxed code execution | No | Yes |
| File editing & refactoring | Yes (via tools) | Yes (via sandbox) |
| Web search & docs | Yes | Limited |
| Independent verification | Cross-review | Reproduce & test |

### How to start collaborating
1. When you receive a complex task, **proactively propose a division of labor** to Codex via the reply tool.
2. State what you'll handle and what you'd like Codex to take on.
3. Ask for Codex's agreement or counter-proposal before proceeding.
4. After task completion, **cross-review** each other's work.
<!-- AgentBridge:end -->
