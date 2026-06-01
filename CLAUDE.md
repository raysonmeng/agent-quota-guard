# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目本质 / What this is

纯 Bash 实现的「额度守卫」:让 Claude Code 和 Codex 在跑长任务时实时感知订阅额度,接近上限时在**轮末干净暂停 + 写 checkpoint**,而非执行中途被硬切。不读日志、不估算,直接查官方 usage 端点。

不能绕过限额(API 耗尽就是耗尽)。它只能提前停在干净点 + 帮你续接。改任何逻辑前先读 `README.md` §8(诚实边界)和 §9(待确认项)。

无 git、无 package manifest、无测试框架。运行期依赖 `jq` `curl` `awk`(macOS 还用 `security` 读 Keychain);安装期额外需要 `python3`(仅用于安全合并 JSON)。

## 架构关键(读多个文件才能拼出的全貌)

**一份核心,两个包,运行时参数区分 agent。** `claude-budget-guard/` 和 `codex-budget-guard/` 各含三个脚本:
- `budget_guard.sh` —— 两包**逐字节相同**。靠 `$1`(`claude`|`codex`)切换 token 来源和 usage 端点,靠 `$2`(phase)切换行为。
- `watchdog.sh` —— 两包**逐字节相同**。
- `install.sh` —— **唯一真正分叉的文件**:CC 版写 `~/.claude/settings.json`(hook 在 `.hooks` 下)+ `CLAUDE.md`;Codex 版写 `~/.codex/hooks.json`(**顶层事件名,无 `hooks` 外层**)+ `AGENTS.md`,matcher 也只 `^Bash$`。

  > 改任一脚本时,若改的是 `budget_guard.sh`/`watchdog.sh`,**必须同步两个目录的副本**(它们是复制而非软链)。`install.sh` 则需分别处理两个分叉版本。

**phase 调度模型** —— guard 挂在五个生命周期事件上,`budget_guard.sh` 末尾的一串 `if [[ "$PHASE" == ... ]]` 分派:

| phase | 挂载事件 | 行为 |
|---|---|---|
| `prompt` | UserPromptSubmit | 检测 `/goal /loop /batch /background`,给规划预估(**唯一**额度充足也出声的情形) |
| `pre` | PreToolUse | 硬线 deny 新工作工具,但放行写 checkpoint(按 basename 匹配) |
| `post` | PostToolUse | 追加一条 burn-rate 历史点;软线提示收尾 |
| `stop` | Stop/SubagentStop | 循环轮末重估;硬线 `continue:false` 强停 + 写 `pending_<agent>.json` 给 watchdog |
| `resume` | SessionStart | 有上次 checkpoint 就注入上下文续接 |

**核心不变量(改代码别破坏):**
- **fail-open**:查不到用量(网络/token/字段对不上/无 `jq`)一律 `exit 0` 静默放行。绝不因守卫自身问题卡死 agent。
- **统一走 `exit 0 + JSON`**,从不混用 `exit 2`。输出协议见 README §10。
- **静默优先**:`util < SOFT` 时除长任务预估外一个字不冒。
- **硬线只在轮末停**(`stop` phase),`pre` 只拦工具不停整轮——避免执行中途切。

**数据流 / 状态目录**(默认 `~/.budget-guard/`,`BUDGET_STATE_DIR` 可覆盖):
- `usage_<agent>.json` —— 用量缓存(`BUDGET_CACHE_TTL` 秒,默认 45;PreToolUse 每次工具调用都跑,必须缓存)。
- `hist_<agent>.jsonl` —— burn-rate 历史点,只留最近 60 条。
- `pending_<agent>.json` —— 硬线暂停时写的待续状态,watchdog 读它续跑。
  > **已知缺陷**:这些都是按 agent 单文件,多项目并发撞线会互相覆盖(README §9)。涉及并发的改动须考虑改成按 `session_id`/项目路径分文件。

**burn-rate 算法**(`seconds_to_hard()`,纯 awk):在 `BUDGET_HIST_WINDOW`(默认 900s)窗口内取最早点和最新点,两点法算 `rate = Δutil/Δt`,外推到 `HARD` 的剩余秒数。`rate ≤ 0` 视为充足(返回 -1)。util 归一化:`≤1` 视为 0–1 比例 ×100。

**CC vs Codex 的真实差异**(改 Codex 分支前必读 README §10):
- Codex hook 只对 Bash 命令可靠触发(apply_patch/MCP 暂不触发),所以硬线主要拦命令,而写 checkpoint 走 apply_patch 正好不被拦。
- CC 软提示走 `additionalContext`(给 agent 读);Codex 走 `systemMessage`(给用户看)——因 Codex PreToolUse 不支持 `additionalContext`。
- Codex usage URL(`BUDGET_CODEX_URL`)和返回字段名**未在真机确认**(README §9),默认猜测可能不对。

## 常用命令

```bash
# 安装 / 卸载(分别在各自目录;幂等,改动前自动 .bak)
cd claude-budget-guard && ./install.sh            # 或 codex-budget-guard
./install.sh --uninstall

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

无自动化测试文件。README §9 记录的「已验证」仅指容器内逻辑层(bash 语法、burn-rate 数学、命令检测正则、各 phase JSON 输出、安装器幂等/卸载生命周期)。**真实 usage 端点字段、真机 hook 触发、`/goal` Stop 交互、watchdog headless 续跑、Codex URL 均未验证**——涉及这些的改动需在真机带真 token 验证,不能只靠逻辑推断声称完成。

## 编码风格与命名

- 一律 `#!/usr/bin/env bash`。安装器用 `set -euo pipefail`(快速失败);运行期 guard 用 `set -uo pipefail`(去掉 `-e`,因为大量命令以 `|| true` 兜底实现 fail-open,绝不能因单条失败退出)。
- 配置变量全大写并统一 `BUDGET_` 前缀(`BUDGET_SOFT` `BUDGET_HARD` `BUDGET_STATE_DIR` …),全部可被环境变量覆盖、带默认值。
- 函数小而动词化:`fetch_usage` `record_point` `seconds_to_hard` `fmt_clock` `fmt_dur`。
- 面向用户的文案是**中文**——除非有意改产品语言,否则保持中文,别擅自英化。

## 提交约定

本 checkout **无 git 元数据**,没有可沿用的历史风格。用简洁的祈使式提交,可带 scope:`codex: harden hook install merge`、`claude: fix burn-rate window`。PR 描述行为变化、列出手动验证项、点名任何对用户配置路径(`~/.claude` `~/.codex` `~/.budget-guard`)的改动。

> 落库前遵守全局 cross code review 硬规则(见 `~/.claude/CLAUDE.md`):任何新代码须过两轮独立 subagent 交叉审,连续两个新 reviewer 报 0 真实 issue 才能 commit。纯文档/单行 typo 除外。

## 安全与配置

- **绝不**提交凭据、usage 接口返回、或来自 `~/.claude` `~/.codex` `~/.budget-guard` 的文件。
- 安装器会写入 `~/.budget-guard`、`~/.claude`/`~/.codex`;改安装/卸载流程时在一次性 `HOME` 下验证幂等,别对用户已有配置做破坏性假设(现实现已对已有 hook 做幂等过滤 + 改前 `.bak`,保持这条)。
- `watchdog.sh` 是无人值守跑 agent,默认 `BUDGET_WATCHDOG_ARM=0`(dry-run)。改它的续跑逻辑或权限白名单时,保持默认不武装、限权(`--allowedTools`/`--full-auto`+sandbox/`--max-turns`)、限定项目目录这几条底线。

## 文档关系

`CLAUDE.md`(本文件)是本仓库**唯一权威**的 agent 上手文档。同目录的 `AGENTS.md` 已收成一句指向本文件的指针(原英文内容已并入此处),不再单独维护——所有更新只改本文件。
