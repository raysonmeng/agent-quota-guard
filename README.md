# Token Budget Guard —— Claude Code / Codex 额度守卫

让 Claude Code 和 Codex 在跑长任务时实时感知自己的订阅额度,接近上限时**干净地暂停并保存进度**,而不是执行到一半被硬切。刷新后发一句「继续」即可续上;可选的 watchdog 还能在额度恢复后自动续跑。

CC 和 Codex **分开安装、互不依赖**——只用其中一个就只装一个。

---

## 1. 解决的问题

长任务(尤其 `/goal` `/loop` `/batch` 这类自主循环)经常在跑到一半时撞上 5 小时 / 周限额,然后被粗暴中断:进度丢失、上下文断裂、要从头理。

本项目把「中断」从**随机的破坏性硬切**变成**可预测的干净暂停**:

- 平时无感,不打扰。
- 长任务启动时先估「按现在的额度够跑多久」,提醒你切块。
- 执行中实时重估,接近上限时在**轮末**停下、写好 checkpoint。
- 续接靠一句「继续」,或交给 watchdog 自动托管。

---

## 2. 核心理念

- **静默优先**:`util < 软线` 时一个字都不冒。唯一例外是长任务启动时的预估。
- **两段式阈值**:软线(默认 78%)提示收尾;硬线(默认 88%,留 ~12% 安全垫)在轮末强制停。
- **checkpoint 闭环**:预警 → 收尾 → 落盘 → 续接,跨额度窗口接力。
- **burn-rate 实时预测**:用最近的消耗速率外推撞线时间,而不是只看当前百分比。
- **fail-open**:查不到额度(网络 / token / 字段对不上)一律放行,绝不因为守卫自身的问题卡死 agent。
- **诚实边界**:这套**不能绕过限额**(见 §8)。它只能提前停在干净点 + 帮你续接。

---

## 3. 架构:它怎么工作

### 3.1 五个 hook 挂载点

守卫是一个脚本(`budget_guard.sh`),被挂在 CC / Codex 的五个生命周期事件上,靠第二个参数(phase)区分行为:

| 事件 | phase | 干什么 |
|---|---|---|
| `UserPromptSubmit` | `prompt` | 检测 `/goal` `/loop` `/batch` `/background`,给一段规划预估(**唯一**额度充足也会提示的情形) |
| `PreToolUse` | `pre` | 硬线时拦住新「干活」工具,但放行写 checkpoint |
| `PostToolUse` | `post` | 记录一条消耗速率历史点;软线时提示收尾 |
| `Stop` / SubagentStop | `stop` | `/goal` 循环的轮末:重估;硬线时 `continue:false` 强停在干净点,并写待续状态给 watchdog |
| `SessionStart` | `resume` | 若有上次 checkpoint,注入到上下文,实现续接 |

`/goal` 是 Anthropic 官方命令,本身就由 Stop hook 驱动 continuation——所以挂在 `Stop` 上正好卡在「要不要再来一轮」的决策点,比 PreToolUse 精准。

### 3.2 额度数据来源

不读日志、不估算,直接查官方 usage 端点(和 claude.ai / Codex 的用量面板同源):

**Claude Code**
```
GET https://api.anthropic.com/api/oauth/usage
  Authorization: Bearer <token>
  anthropic-beta: oauth-2025-04-20
```
- token:macOS 在 Keychain(`Claude Code-credentials`),Linux/WSL 在 `~/.claude/.credentials.json` 的 `.claudeAiOauth.accessToken`。
- 返回里取 `five_hour.utilization` 和 `seven_day.utilization` 的较大值(更保守)。利用率可能是 0–100 或 0–1,脚本会归一化到 0–100。

**Codex**
```
GET <BUDGET_CODEX_URL>     # 默认猜测 https://chatgpt.com/backend-api/codex/usage
  Authorization: Bearer <token>
```
- token:`~/.codex/auth.json`。
- ⚠ 这个 URL 和返回字段名**待确认**(见 §9)。

### 3.3 burn-rate 算法

- 每次 `post` / `stop` 往 `~/.budget-guard/hist_<agent>.jsonl` 追加 `{ts, util}`(只保留最近 60 条)。
- 估算时:在回看窗口(默认 15 分钟)内取最早点和最新点,两点法算速率 `rate = Δutil / Δt`(%/秒)。
- 还能跑多久 `≈ (HARD - util_now) / rate`。`rate ≤ 0`(没在涨或在降)视为「充足」。
- 每轮重算,所以预估会随实际消耗浮动——这就是「可能比预期早 / 晚用完」。

---

## 4. 目录结构

```
token-budget-guard/
├── README.md                 ← 本文件
├── claude-budget-guard/      ← CC 包(整个目录可独立拿走)
│   ├── install.sh            ← CC 安装器(配 hook + 写 CLAUDE.md + 部署脚本)
│   ├── budget_guard.sh       ← 核心守卫(claude 模式)
│   └── watchdog.sh           ← 可选:额度刷新后自动续跑
└── codex-budget-guard/       ← Codex 包(整个目录可独立拿走)
    ├── install.sh            ← Codex 安装器(配 hooks.json + 写 AGENTS.md + 部署脚本)
    ├── budget_guard.sh       ← 同一份核心(codex 模式)
    └── watchdog.sh           ← 同一份
```

`budget_guard.sh` 和 `watchdog.sh` 两个包共用同一份内容,靠运行时第一个参数(`claude` / `codex`)区分。安装器会把它们部署到 `~/.budget-guard/bin/`。

运行期依赖 `jq`;安装时额外需要 `python3`(只在装的时候用,做 JSON 安全合并)。

---

## 5. 安装

### Claude Code
```bash
cd claude-budget-guard
./install.sh
```
- 把 hook 幂等合并进 `~/.claude/settings.json`(不覆盖你已有的 hook,改动前自动 `.bak`)。
- 把一段「额度守卫协议」写进 `~/.claude/CLAUDE.md`(带 `<!-- budget-guard -->` 标记,可干净移除)。
- 重开会话后 `/hooks` 应能看到 `budget_guard`。
- 卸载:`./install.sh --uninstall`

### Codex
```bash
cd codex-budget-guard
./install.sh
```
- 把 hook 合并进 `~/.codex/hooks.json`(顶层事件名结构),协议写进 `~/.codex/AGENTS.md`。
- 重开会话 `/hooks` 验证。装完需确认 §9 的两个点。
- 卸载:`./install.sh --uninstall`

CC 侧基本开箱即用;Codex 侧装完要确认 usage URL 和 hooks.json 外层(§9)。

---

## 6. 配置项(环境变量)

| 变量 | 默认 | 说明 |
|---|---|---|
| `BUDGET_SOFT` | `78` | 软线:开始提示收尾 |
| `BUDGET_HARD` | `88` | 硬线:轮末强制停 |
| `BUDGET_CACHE_TTL` | `45` | 用量查询缓存秒数(PreToolUse 每次工具调用都会跑,必须缓存) |
| `BUDGET_HIST_WINDOW` | `900` | burn-rate 回看窗口(秒) |
| `BUDGET_CHECKPOINT` | `.agent/checkpoint.md` | checkpoint 路径(相对项目根,所以会落在各项目自己目录) |
| `BUDGET_CODEX_URL` | `https://chatgpt.com/backend-api/codex/usage` | Codex usage 端点(待确认) |
| `BUDGET_STATE_DIR` | `~/.budget-guard` | 缓存 / 历史 / 待续状态目录 |

watchdog 专用变量见 §7。

---

## 7. 自动续跑 watchdog(可选 · 高级 · 有风险)

托管的最后一环:系统 cron / launchd 定时跑 `watchdog.sh`,发现额度已刷新且有未完成任务,就用 headless 模式注入「继续」自动续跑。

**默认是 dry-run(只打印不执行)。** 确认权限白名单妥当后,才设 `BUDGET_WATCHDOG_ARM=1` 真正武装。

```bash
# 每 10 分钟检查一次(武装后)
*/10 * * * * BUDGET_WATCHDOG_ARM=1 ~/.budget-guard/bin/watchdog.sh claude >> ~/.budget-guard/watchdog.log 2>&1
```

续跑命令:
- CC:`claude --resume <sid> -p "继续…" --permission-mode acceptEdits --allowedTools … --max-turns N --output-format json`
- Codex:`codex exec resume <sid> "继续…" --full-auto`(或 `resume --last`)

watchdog 变量:

| 变量 | 默认 | 说明 |
|---|---|---|
| `BUDGET_WATCHDOG_ARM` | `0` | `1` 才真正执行续跑,否则只 dry-run |
| `BUDGET_RESUME_BELOW` | `30` | 用量回落到此线下才认为窗口已刷新 |
| `BUDGET_RESUME_PROMPT` | (见脚本) | 续跑时注入的「继续」指令 |
| `BUDGET_CLAUDE_ALLOWED` | `Read,Edit,Write,Bash` | CC 续跑的工具白名单(**按需收紧**) |
| `BUDGET_CLAUDE_PERMMODE` | `acceptEdits` | CC 续跑权限模式 |
| `BUDGET_CLAUDE_MAXTURNS` | `40` | CC 续跑最大轮数 |

⚠ 风险见 §8.2。

---

## 8. 诚实边界(务必先读)

### 8.1 不能绕过限额
额度耗尽后 API 会拒绝请求,**没有任何工具能让 agent「用完了还继续跑」**。本项目能保证的只是:在耗尽**之前**停在干净的轮末 + checkpoint,使中断不再发生在执行中途。这是「绝对杜绝中断」能达成的版本。

### 8.2 watchdog 的代价
- **无人值守跑 agent**:没人看着它改文件、跑命令。必须用 `--allowedTools` / `--full-auto`+sandbox / `--max-turns` 严格限权,并限定项目目录。
- **续跑吃额度**:每次 resume 是完整会话,刷新后会立刻开始消耗——可能你还想留额度干别的。
- **机器要开着**(除非改用 Anthropic 云端 Routines)。

---

## 9. 待确认 / 待办 / 路线图(继续开发看这里)

### 必须在真机确认
- [ ] **Anthropic usage 端点的 reset 字段名**。脚本里 `resets_at` / `reset_at` 是按惯例猜的。判断方法:装完第一次摸到软线时,如果预估里「刷新时间」显示「未知」,就是字段名要改——抓一次 `api/oauth/usage` 的真实返回对一下 `fetch_usage()` 里的 jq。
- [ ] **Codex usage 端点真实 URL + 返回字段名**。抓 `codex` 的 `/status` 包确认 host/path,用 `BUDGET_CODEX_URL` 覆盖;返回字段(`used_percent` 之类)照实改 `fetch_usage()` 的 codex 分支。
- [ ] **Codex `hooks.json` 外层结构**。安装器按「顶层事件名」写;若你的 Codex 版本不认,把 `~/.codex/hooks.json` 包一层 `{"hooks": { … }}`。`/hooks` 验证。
- [ ] **`/goal` 的 Stop hook 与官方 evaluator 的优先级**。我们用 `continue:false` 强停,但多个 Stop hook 与官方 goal evaluator 的交互没真机验证过,确认 `continue:false` 是否稳定压过 evaluator 让循环停。

### 已知局限(值得修)
- [ ] **多项目并发会互相覆盖**。待续状态 `pending_<agent>.json` 和历史 `hist_<agent>.jsonl` 都是按 agent 单文件——同时跑多个 CC 项目都撞线时,后写的覆盖先写的,watchdog 只会续最后一个;burn-rate 历史也会混。应改成按 `session_id` / 项目路径分文件。
- [ ] **burn-rate 用两点法**,对抖动敏感。可换成窗口内线性回归,更稳。
- [ ] **只看额度,没看 context window**。长任务也会撞 context 上限。可把 `/context` 占用纳入,做双约束。

### 增强方向
- [ ] **打包成 plugin**,一键分发 + 版本管理:
  - CC:`.claude-plugin/plugin.json` + `hooks/hooks.json` + 可选 `commands/`(比如加一个 `/budget` 命令手动查预估)。`/plugin marketplace add <git>` → `/plugin install`。
  - Codex:plugin manifest + 默认 `hooks/hooks.json`,走 Codex 的 marketplace 体系。
- [ ] **接通知**:任务暂停 / 自动续跑 / 完成时 push 或邮件(CC 有 Notification hook 可用)。
- [ ] **watchdog 完成判定**目前靠 checkpoint 里出现 `DONE` 字样,较弱;可改成结构化状态字段。
- [ ] **CC 也可用 plugin 的 Notification / PreCompact** 等事件做更细的体验。

### 测试状态
- ✅ 已验证(容器内逻辑层):bash 语法、burn-rate 数学(15min 40%→70% 估到硬线 540s,精确)、`/goal /loop /batch` 命令检测正则、各 phase 的 JSON 输出格式、两个安装器的合并 / 幂等 / 卸载完整生命周期(用户已有 hook 不受损)。
- ❌ 未验证(需真机 + 真 token):真实 usage 端点字段、hook 在真实 CC/Codex 会话里的触发、`/goal` Stop 交互、watchdog headless 续跑、Codex usage URL 是否正确。

---

## 10. 速查

**关键端点**
- CC 用量:`GET https://api.anthropic.com/api/oauth/usage`(`anthropic-beta: oauth-2025-04-20`)
- Codex 用量:`GET /api/codex/usage`(URL 待确认)

**续跑命令**
- `claude --resume <sid> -p "…" --permission-mode acceptEdits --output-format json`
- `claude --continue "…"`
- `codex exec resume <sid> "…" --full-auto` / `codex exec resume --last "…"`

**CC / Codex 关键差异**
- Codex 的 hook 只对 Bash 命令可靠触发,apply_patch / 多数 MCP 工具暂不触发(openai/codex#16732)——硬线主要拦命令,写 checkpoint(apply_patch)正好不被拦。
- Codex `PreToolUse` 不支持 `additionalContext`;所以软提示 / 预估对 Codex 走 `systemMessage`(给用户看),对 CC 走 `additionalContext`(给 agent 读)。
- CC 的 `/hooks` 能交互添加 command hook;Codex 的 `/hooks` 只能查看 + 开关,加 hook 得写文件。
- Codex `goals` 模式下 `exec resume` 仍需注入一个「继续」prompt(promptless 未实现,openai/codex#24016)。

**Hook 输出协议(两边一致的要点)**
- 阻断:`{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"…"}}`,且 `exit 0`。
- 强停整轮:`{"continue":false,"stopReason":"…"}`。
- 注入上下文(CC):`{"hookSpecificOutput":{"hookEventName":"<Event>","additionalContext":"…"}}`。
- 给用户看的提示:`{"systemMessage":"…"}`。
- 不要混用 `exit 2` 和 JSON——脚本统一走 `exit 0 + JSON`。
