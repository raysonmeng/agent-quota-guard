# Agent Quota Guard

**Language: English (default) · [中文](#中文文档)**

> Stop letting subscription rate-limits hard-cut your coding agent mid-task.
> Agent Quota Guard watches your **Claude Code / Codex** subscription usage in real time, **pauses cleanly at a checkpoint** when you approach the cap, and helps you **resume after the quota refreshes** — instead of losing progress to a mid-execution interruption.

```bash
npx agent-quota-guard claude    # install for Claude Code
npx agent-quota-guard codex     # install for Codex
```

---

## Why this exists

Long, autonomous runs (`/goal`, `/loop`, `/batch`, background agents) routinely slam into a 5-hour or weekly subscription limit **halfway through a step**. The result is the worst kind of interruption: work lost, context broken, and you restart from scratch.

Agent Quota Guard turns that **random, destructive cut** into a **predictable, clean pause**:

- **Silent by default** — it says nothing while you have plenty of quota.
- **Plans ahead** — when you kick off a long task, it estimates how long your current quota will last and suggests chunking.
- **Pauses at the round boundary** — as you approach the limit, it stops at a clean point and writes a checkpoint, never in the middle of a tool call.
- **Helps you resume** — it can block in-place until the quota refreshes (interactive), or an optional watchdog can pick the task back up unattended.

> **Honest scope:** this **cannot bypass your limit** — when the API quota is exhausted, it's exhausted. What it guarantees is that you stop at a *clean* point *before* exhaustion, with a checkpoint, so the interruption never lands mid-execution. See [Honest limits](#supported-agents--honest-limits).

---

## What it does

| | Behavior |
|---|---|
| 🔇 **Silent-first** | Below the warning threshold, it never interrupts you. The only proactive message is the planning estimate when you start a long task. |
| 📊 **Three tiers** | **T1 (80%)** one heads-up per window · **T2 (90%)** wrap-up nudge every turn · **T3 (92%)** hard stop / park at the round boundary. |
| 💾 **Checkpoint loop** | warn → wrap up → write checkpoint → resume across the quota window. |
| 📈 **Burn-rate forecast** | extrapolates *time-to-limit* from your recent consumption rate, not just the current percentage. |
| 🛟 **Fail-open** | if it can't read your usage (network / token / schema), it stays silent and lets the agent run — the guard never blocks you because of its own problem. |
| 🎯 **Official numbers** | reads the same official usage endpoints as the claude.ai / Codex usage dashboards — no log scraping, no guessing. |

---

## Install

**Requirements:** `node >= 18`, `jq` (runtime), and `python3` (Codex install step only). Both agents install independently — install only the one you use.

### Option A — npx (recommended, no clone)

```bash
npx agent-quota-guard claude              # → ~/.claude
npx agent-quota-guard codex               # → ~/.codex
npx agent-quota-guard claude --uninstall  # remove
```

A zero-dependency launcher: `claude` runs the Node installer, `codex` runs the bundled shell installer. Installs are idempotent and back up any file they touch (`.bak`).

### Option B — clone the repo

```bash
git clone https://github.com/raysonmeng/agent-quota-guard.git
cd agent-quota-guard

./install.sh              # both agents in one go (Claude Code + Codex)
./install.sh claude       # just Claude Code
./install.sh codex        # just Codex
./install.sh --uninstall  # remove both
```

The root `install.sh` is a thin wrapper that runs both per-agent installers in sequence (each is idempotent and backs up files before changing them); one agent failing doesn't block the other.

**What the installer changes**

- **Claude Code** — merges a hook into `~/.claude/settings.json` (your existing hooks are preserved) and writes a short "quota guard protocol" block into `~/.claude/CLAUDE.md`, wrapped in removable `<!-- budget-guard:start -->` / `<!-- budget-guard:end -->` markers so it can be cleanly stripped.
- **Codex** — adds hooks to `~/.codex/config.toml` `[hooks]`, registers a `budget-guard` MCP server, and writes the protocol into `~/.codex/AGENTS.md`.

Re-open your agent session afterwards; `/hooks` should list `budget_guard`.

---

## How you'll use it

After install, **you don't run anything** — the guard rides along with your normal agent sessions:

1. **Start a long task** (e.g. `/goal "refactor the payment module"`). The guard prints a one-time estimate of how far your current quota will carry it.
2. **Work normally.** It stays quiet until ~80% usage.
3. **Near the cap** it nudges you to wrap up, then at the hard line it **stops at the end of the current round** and writes a checkpoint (default `.agent/checkpoint.md` in your project).
4. **Resume.** Either:
   - **Interactive (Claude & Codex):** the agent can call the `wait_until_budget_refresh` MCP tool to park in place and continue the same turn once the window refreshes; or
   - you simply send "continue" in a new session — the guard injects the checkpoint context so you don't lose your place; or
   - **Unattended:** arm the [watchdog](#auto-resume-watchdog) to resume the task automatically after the quota refreshes.

### Need just a little more? (manual hard-line skip)

Sometimes you're a few steps from done and would rather push through than stop and resume. You can **explicitly** authorize the guard to stop enforcing the hard line for a while. In your prompt, include one of these phrases:

- `/budget-skip` · `force-continue` · `跳过硬线` · `强制继续`

This records a **time-boxed** (default 30 min, `BUDGET_SKIP_TTL`), **per-project** grant: while it's valid the hard line won't emit PreToolUse slowdown reminders or force a round-end stop. It auto-expires and the guard then resumes normal reminders plus clean round-end stops. A plain "continue" never triggers it — the phrase must be explicit. This only delays a *clean* stop; it **cannot** create quota — once the API refuses requests, nothing keeps the agent running.

---

## Configuration

All settings are environment variables with sane defaults — you usually don't need to touch them.

| Variable | Default | Meaning |
|---|---|---|
| `BUDGET_WARN_ONCE` | `80` | T1 — warn once per quota window |
| `BUDGET_WARN_REPEAT` | `90` | T2 — wrap-up nudge every turn |
| `BUDGET_HARD` | `92` | T3 — hard stop / park at the round boundary |
| `BUDGET_SKIP_TTL` | `1800` | seconds a [manual hard-line skip](#need-just-a-little-more-manual-hard-line-skip) stays active |
| `BUDGET_CACHE_TTL` | `45` | seconds to cache the usage lookup |
| `BUDGET_CHECKPOINT` | `.agent/checkpoint.md` | checkpoint path (relative to project root) |
| `BUDGET_STATE_DIR` | `~/.budget-guard` | cache / history / pending-resume state |
| `BUDGET_MCP_TOOL_TIMEOUT_SEC` | `700000` | Codex MCP tool timeout (must exceed worst-case refresh wait) |

Full list, including watchdog and endpoint overrides, lives in the source and the [technical design doc](docs/budget-guard-tech-design.html).

### Config files (global + per-project)

Instead of exporting env vars, you can put safe quota-tuning settings in two optional `KEY=value` files.

- **Global** — `~/.budget-guard/config` (your defaults for every project)
- **Project** — `.budget-guard.conf` in your project root (found by walking up from the working dir; commit it to share with your team)

```ini
# ~/.budget-guard/config  or  ./.budget-guard.conf
BUDGET_WARN_ONCE=75
BUDGET_WARN_REPEAT=88
BUDGET_HARD=90
```

**Precedence (high → low):** environment variable **>** project config **>** global config **>** built-in default. Both files are optional; with neither present, behavior is exactly the built-in defaults.

For safety, config files only accept known safe tuning keys: `BUDGET_WARN_ONCE`, `BUDGET_WARN_REPEAT`, `BUDGET_SOFT`, `BUDGET_HARD`, `BUDGET_CACHE_TTL`, `BUDGET_HIST_WINDOW`, and `BUDGET_CLAUDE_UA`. Command, credential, endpoint, debug-fixture, dispatch, path, and automation keys such as `BUDGET_PROBE`, token variables, `BUDGET_CODEX_URL`, `BUDGET_USAGE_FIXTURE`, `BUDGET_AGENT`, `BUDGET_PHASE`, `BUDGET_STATE_DIR`, `BUDGET_CHECKPOINT`, `BUDGET_WATCHDOG_ARM`, `BUDGET_RESUME_BELOW`, `BUDGET_RESUME_PROMPT`, and `BUDGET_SKIP_TTL` (it governs how long the hard line can be skipped) must be set as explicit process environment variables.

---

## Supported agents & honest limits

| | Claude Code | Codex |
|---|---|---|
| Interactive (TUI) hooks | ✅ verified | ✅ verified |
| Pause + checkpoint + resume | ✅ | ✅ (interactive) |
| In-place park until refresh (MCP) | ✅ | ✅ (interactive) |
| Headless / autonomous (`codex exec`) | ✅ (watchdog) | ⚠️ **lifecycle hooks do not fire** — guard is interactive-TUI only; headless relies on the watchdog (`codex exec resume`) |

**What it cannot do:**

- **It cannot bypass your limit.** Once the API refuses requests, no tool can keep the agent running. The guarantee is a clean stop *before* that, not infinite quota.
- **Codex headless (`codex exec`, v0.135.0) does not fire lifecycle hooks**, so the in-session guard only works in the interactive TUI. Autonomous Codex runs are covered by the watchdog instead.

---

## Auto-resume watchdog

*Optional · advanced · use with care.*

A system `cron`/`launchd` job runs `watchdog.sh`; when it sees the quota has refreshed and a task is still pending, it resumes the task headlessly.

```bash
# every 10 minutes, once armed
*/10 * * * * BUDGET_WATCHDOG_ARM=1 ~/.budget-guard/bin/watchdog.sh claude >> ~/.budget-guard/watchdog.log 2>&1
```

- **Default is dry-run** (`BUDGET_WATCHDOG_ARM=0`) — it prints what it *would* do. Only set `ARM=1` after you've reviewed the tool allowlist.
- It runs an agent **unattended**, so it is locked down by default (`--allowedTools` / `--sandbox workspace-write` / `--max-turns`, scoped to the project dir). Keep those guards.
- Resuming **consumes quota** immediately after refresh, and your machine must stay on.

---

## Project status

Active development. Current state:

- **Core** — Node implementation (usage probe, three-tier guard, blocking-MCP continuation) plus a Bash fallback. ✅
- **Installers** — hardened through extensive cross-review against real-world configs (idempotency, byte-perfect uninstall, no user-config corruption). ✅
- **Distribution** — `npx agent-quota-guard …` ready; **not yet published to npm** (publish pending).
- **Tests** — 112 (core) + 38 (Codex MCP/installer) passing.
- **Verified on real machines** — Claude Code full loop (hooks, checkpoint, hard-stop, resume, watchdog) via tmux E2E; Codex interactive TUI; live usage endpoints for both. Codex headless hook-firing is a documented limitation, not a bug.

---

## Roadmap

- **Plugin packaging** — ship as a Claude Code / Codex plugin for one-command install + version management (and a `/budget` command to check the estimate on demand).
- **Notifications** — push / email on pause, auto-resume, and completion.
- **Context-window awareness** — also watch `/context` usage so long tasks don't blow the context limit, as a second constraint alongside quota.
- **Steadier burn-rate** — switch the two-point rate estimate to a windowed linear regression to smooth out jitter.
- **Per-project history** — split burn-rate history by session / project path so concurrent projects don't mix.
- **Stronger completion detection** — replace the `DONE`-string heuristic the watchdog uses with a structured status field.

---

## Uninstall

```bash
npx agent-quota-guard claude --uninstall
npx agent-quota-guard codex  --uninstall
# or, from a clone: ./install.sh --uninstall
```

Removes the hooks, the MCP registration, and the protocol block — leaving the rest of your config untouched. The deployed scripts under `~/.budget-guard/` are left in place.

---

## License

[MIT](LICENSE) © raysonmeng

---
---

# 中文文档

**语言:[English](#agent-quota-guard)(默认) · 中文**

> 别再让订阅限流在任务跑到一半时硬切你的编程 agent。
> Agent Quota Guard 实时监控你 **Claude Code / Codex** 的订阅用量,接近上限时**在干净点暂停并写好 checkpoint**,额度刷新后**帮你接着跑** —— 而不是执行中途被打断、进度丢失。

```bash
npx agent-quota-guard claude    # 装到 Claude Code
npx agent-quota-guard codex     # 装到 Codex
```

---

## 为什么需要它

长任务、自主循环(`/goal`、`/loop`、`/batch`、后台 agent)经常**跑到一半**就撞上 5 小时 / 每周订阅限额。结果是最糟的那种中断:工作丢失、上下文断裂,只能从头再来。

它把这种**随机的破坏性硬切**变成**可预测的干净暂停**:

- **默认静默** —— 额度充足时一个字都不冒。
- **提前规划** —— 启动长任务时,先估「按现在的额度够跑多久」,提醒你切块。
- **轮末暂停** —— 接近上限时停在干净点并写 checkpoint,绝不停在某次工具调用中途。
- **帮你续接** —— 可原地阻塞等到额度刷新再继续(交互场景),或由可选的 watchdog 无人值守自动接着跑。

> **诚实边界:** 它**不能绕过限额** —— API 额度耗尽就是耗尽。它保证的是在耗尽**之前**停在*干净点* + checkpoint,让中断不再落在执行中途。详见[支持范围与诚实边界](#支持范围与诚实边界)。

---

## 它做什么

| | 行为 |
|---|---|
| 🔇 **静默优先** | 低于提醒线时绝不打扰。唯一主动发声是启动长任务时的规划预估。 |
| 📊 **三档阈值** | **T1(80%)** 本窗口提醒一次 · **T2(90%)** 每轮提示收尾 · **T3(92%)** 轮末强制停 / park。 |
| 💾 **checkpoint 闭环** | 预警 → 收尾 → 落盘 → 跨额度窗口续接。 |
| 📈 **burn-rate 预测** | 用最近消耗速率外推「还能跑多久」,不只看当前百分比。 |
| 🛟 **fail-open** | 查不到用量(网络 / token / 字段对不上)就静默放行 —— 绝不因守卫自身问题卡死 agent。 |
| 🎯 **官方数据** | 直接查官方 usage 端点(和 claude.ai / Codex 用量面板同源),不读日志、不估算。 |

---

## 安装

**前置:** `node >= 18`、`jq`(运行期)、`python3`(仅 Codex 安装时用)。两个 agent 互不依赖,用哪个装哪个。

### 方式 A —— npx(推荐,无需 clone)

```bash
npx agent-quota-guard claude              # → ~/.claude
npx agent-quota-guard codex               # → ~/.codex
npx agent-quota-guard claude --uninstall  # 卸载
```

零依赖的薄启动器:`claude` 走 Node 安装器、`codex` 走随包 bash 安装器。安装幂等,改动任何文件前自动 `.bak`。

### 方式 B —— clone 仓库

```bash
git clone https://github.com/raysonmeng/agent-quota-guard.git
cd agent-quota-guard

./install.sh              # 一键装两个(Claude Code + Codex)
./install.sh claude       # 只装 Claude Code
./install.sh codex        # 只装 Codex
./install.sh --uninstall  # 卸载两个
```

根目录 `install.sh` 是薄包装:依次调用两个子安装器(各自幂等、改前自动 `.bak`);一个 agent 失败不阻断另一个。

**安装器会改什么**

- **Claude Code** —— 把 hook 幂等合并进 `~/.claude/settings.json`(保留你已有的 hook),并在 `~/.claude/CLAUDE.md` 写入一段带可移除标记的「额度守卫协议」。
- **Codex** —— 把 hook 加进 `~/.codex/config.toml` 的 `[hooks]`,注册 `budget-guard` MCP server,协议写进 `~/.codex/AGENTS.md`。

装完重开会话,`/hooks` 应能看到 `budget_guard`。

---

## 怎么用

装完**你什么都不用跑** —— 守卫随你正常的会话自动生效:

1. **启动长任务**(如 `/goal "重构支付模块"`)。守卫打印一次预估:按现在的额度大概能跑多远。
2. **正常干活。** 用量到 ~80% 前它保持安静。
3. **接近上限**时提示你收尾,到硬线时**在当前轮末停下**并写 checkpoint(默认项目里的 `.agent/checkpoint.md`)。
4. **续接**,任选:
   - **交互(Claude & Codex):** agent 可调用 `wait_until_budget_refresh` MCP 工具,原地 park 到窗口刷新后**同一轮继续**;或
   - 你在新会话里发一句「继续」 —— 守卫注入 checkpoint 上下文,不丢进度;或
   - **无人值守:** 武装 [watchdog](#自动续跑-watchdog),额度刷新后自动接着跑。

### 就差一点点?(手动跳过硬线)

有时你离收尾只差几步,与其停下来再续接,不如一口气干完。你可以**显式**授权守卫暂时不再强制硬线 —— 在 prompt 里带上下面任一短语即可:

- `/budget-skip` · `force-continue` · `跳过硬线` · `强制继续`

这会记录一个**限时**(默认 30 分钟,由 `BUDGET_SKIP_TTL` 控制)、**按项目作用域**的授权:有效期内硬线不再发 PreToolUse 减速提醒、也不在轮末强停;到期自动恢复正常提醒与轮末干净停。普通的「继续」**不会**触发 —— 短语必须显式。它只是延后一次*干净*的停止,**并不能**凭空变出额度 —— API 一旦拒绝请求,谁也没法让 agent 继续跑。

---

## 配置项

全是带默认值的环境变量,通常不用动。

| 变量 | 默认 | 含义 |
|---|---|---|
| `BUDGET_WARN_ONCE` | `80` | T1 —— 本额度窗口提醒一次 |
| `BUDGET_WARN_REPEAT` | `90` | T2 —— 每轮提示收尾 |
| `BUDGET_HARD` | `92` | T3 —— 轮末强制停 / park |
| `BUDGET_SKIP_TTL` | `1800` | [手动跳过硬线](#就差一点点手动跳过硬线)的有效秒数 |
| `BUDGET_CACHE_TTL` | `45` | 用量查询缓存秒数 |
| `BUDGET_CHECKPOINT` | `.agent/checkpoint.md` | checkpoint 路径(相对项目根) |
| `BUDGET_STATE_DIR` | `~/.budget-guard` | 缓存 / 历史 / 待续状态目录 |
| `BUDGET_MCP_TOOL_TIMEOUT_SEC` | `700000` | Codex MCP 工具超时(须大于最坏刷新等待) |

完整清单(含 watchdog、端点覆盖)见源码与[技术方案文档](docs/budget-guard-tech-design.html)。

### 配置文件(全局 + 项目两层)

除了设环境变量,也可以把安全的额度调参项写进两个可选的 `KEY=value` 文件:

- **全局** —— `~/.budget-guard/config`(你对所有项目的默认)
- **项目** —— 项目根目录的 `.budget-guard.conf`(从工作目录向上查找;提交进 git 即可团队共享)

```ini
# ~/.budget-guard/config  或  ./.budget-guard.conf
BUDGET_WARN_ONCE=75
BUDGET_WARN_REPEAT=88
BUDGET_HARD=90
```

**优先级(高 → 低):** 环境变量 **>** 项目配置 **>** 全局配置 **>** 内置默认。两份文件都可选;都不存在时行为与内置默认完全一致。

出于安全考虑,配置文件只接受明确安全的调参 key:`BUDGET_WARN_ONCE`、`BUDGET_WARN_REPEAT`、`BUDGET_SOFT`、`BUDGET_HARD`、`BUDGET_CACHE_TTL`、`BUDGET_HIST_WINDOW`、`BUDGET_CLAUDE_UA`。命令、凭据、端点、调试 fixture、调度身份、路径和自动化控制类 key,例如 `BUDGET_PROBE`、token 变量、`BUDGET_CODEX_URL`、`BUDGET_USAGE_FIXTURE`、`BUDGET_AGENT`、`BUDGET_PHASE`、`BUDGET_STATE_DIR`、`BUDGET_CHECKPOINT`、`BUDGET_WATCHDOG_ARM`、`BUDGET_RESUME_BELOW`、`BUDGET_RESUME_PROMPT`,以及 `BUDGET_SKIP_TTL`(它决定硬线能被跳过多久),仍需显式设置为进程环境变量。

---

## 支持范围与诚实边界

| | Claude Code | Codex |
|---|---|---|
| 交互 TUI hook | ✅ 已验证 | ✅ 已验证 |
| 暂停 + checkpoint + 续接 | ✅ | ✅(交互) |
| 原地 park 到刷新(MCP) | ✅ | ✅(交互) |
| Headless / 自主(`codex exec`) | ✅(watchdog) | ⚠️ **lifecycle hook 不触发** —— 守卫仅交互 TUI 生效;headless 靠 watchdog(`codex exec resume`) |

**它做不到的:**

- **不能绕过限额。** API 一旦拒绝请求,没有任何工具能让 agent 继续跑。它保证的是在那之前干净地停,不是无限额度。
- **Codex headless(`codex exec`,v0.135.0)不触发 lifecycle hook**,所以会话内守卫只在交互 TUI 生效;Codex 的自主任务改由 watchdog 兜底。

---

## 自动续跑 watchdog

*可选 · 高级 · 谨慎用。*

系统 `cron`/`launchd` 定时跑 `watchdog.sh`;发现额度已刷新且有未完成任务,就 headless 续跑。

```bash
# 武装后,每 10 分钟检查一次
*/10 * * * * BUDGET_WATCHDOG_ARM=1 ~/.budget-guard/bin/watchdog.sh claude >> ~/.budget-guard/watchdog.log 2>&1
```

- **默认 dry-run**(`BUDGET_WATCHDOG_ARM=0`)—— 只打印不执行。确认工具白名单妥当后再设 `ARM=1`。
- 它**无人值守**地跑 agent,所以默认严格限权(`--allowedTools` / `--sandbox workspace-write` / `--max-turns`,限定项目目录)。请保留这些限制。
- 续跑会在刷新后**立即消耗额度**,且机器需保持开机。

---

## 项目进展

活跃开发中。当前状态:

- **核心** —— Node 实现(用量探针、三档守卫、阻塞 MCP 续接)+ Bash 兜底。✅
- **安装器** —— 经大量交叉审针对真实配置加固(幂等、字节级完美卸载、不破坏用户已有配置)。✅
- **分发** —— `npx agent-quota-guard …` 已就绪;**尚未发布到 npm**(待发布)。
- **测试** —— 112(核心)+ 38(Codex MCP / 安装器)全通过。
- **真机已验证** —— Claude Code 全闭环(hook、checkpoint、硬停、续接、watchdog)tmux E2E;Codex 交互 TUI;两端真实 usage 端点。Codex headless 不触发 hook 是已记录的限制,非 bug。

---

## 路线图

- **打包成 plugin** —— 做成 Claude Code / Codex 插件,一键安装 + 版本管理(并加 `/budget` 命令随时查预估)。
- **接通知** —— 暂停 / 自动续跑 / 完成时 push 或邮件。
- **context window 感知** —— 同时监控 `/context` 占用,让长任务不撞 context 上限,与额度形成双约束。
- **更稳的 burn-rate** —— 把两点法换成窗口内线性回归,抚平抖动。
- **按项目分历史** —— burn-rate 历史按 session / 项目路径拆分,避免并发项目相互污染。
- **更强的完成判定** —— 把 watchdog 现用的 `DONE` 字符串启发式换成结构化状态字段。

---

## 卸载

```bash
npx agent-quota-guard claude --uninstall
npx agent-quota-guard codex  --uninstall
# 或 clone 后:./install.sh --uninstall
```

移除 hook、MCP 注册、协议块,其余配置原样保留;部署到 `~/.budget-guard/` 的脚本会留下。

---

## 许可证

[MIT](LICENSE) © raysonmeng
