# guard-P2 设计稿：硬线退化为减速线（remind 模式）

> 状态：PR1 实现落定记录。基于 budget-strategy-v3 设计稿的 guard-P2 条目 + 用户 2026-06-14 决策 + PR1 对抗审修正。
> 作者：Claude；评审/实现：Codex。

## 1. 背景与宗旨

用户的最高宗旨（原话）：**「既要把周窗口额度尽可能用满，又不让任务被中途打断」**。

现行 guard hook 的 T3 硬线（`BUDGET_HARD=92`）做法是：`warn_util >= 92` → `PreToolUse` 返回 `permissionDecision: 'deny'`，拦掉除写 checkpoint 外的一切工具调用（`lib/guard/hook.mjs:347-366`，bash 版 `budget_guard.sh` pre 阶段同理）。

**矛盾**：deny 本身就是「中途打断」——正是宗旨要避免的。而且 92% 可能离窗口刷新还很远（如周窗口 92% 但 6.5h 后刷新），一刀切早停浪费额度。

## 2. 用户决策（2026-06-14）

**形态 = B「干净点停 + watchdog 自动续接」（不是纯 remind 完全不停）：**
1. **执行工具调用中途：绝不拦**（不被"中途"打断——这是宗旨核心）。把 phasePre 的硬线 deny 去掉。
2. **一轮自然结束时（轮末 phaseStop）：到硬线停在干净点**，写 checkpoint + pending 文件。这个"停"是必要的——没有"停"就没有 watchdog 可唤醒的对象。
3. **停了之后：watchdog 等窗口刷新自动从 checkpoint「下一步」续接 —— 全自动，不要手动**（用户 2026-06-14 强调「我要能自动续接，不要手动！」）。
4. **收尾保护线**：用 probe 的 runway 字段（`runway_seconds`/`burn_rate_pct_per_hour`），在 phasePre 用真实燃尽到满额时间预测"距打满 < 收尾时长"时强提醒，比静态 92% 更早触发。
5. **手动 skip（跳过硬线）退居备用**：自动续接是主路径；skip 只是用户想强推时的逃生门，不是常态。

**与原 v3 设计稿 guard-P2「remind 模式」的差异**：原稿倾向纯提醒不停；用户最终选 B——中途不停但轮末干净点停 + 自动续。这是更完整的「不被打断」形态。

## 3. 设计

### 3.1 核心改动：T3 deny → 收尾提醒（不 deny）

`phasePre`（hook.mjs:347-366）当前：`hardUtil >= hard` → return deny。
**改为**：`hardUtil >= hard` → return `additionalContext`（强提醒），**不再 deny**：
```
hookSpecificOutput: {
  hookEventName: 'PreToolUse',
  additionalContext: "额度 X%≥硬线。建议尽快把进度写进 checkpoint 收尾到干净点；不会强制拦截，但接近供应商限流时可能被外层硬切。刷新约 HH:MM。"
}
```
（claude 用 additionalContext；codex 用 systemMessage，与既有 T1/T2 提醒风格一致。）

### 3.2 新增：收尾保护线（runway 驱动的强提醒）

唯一护栏。当 probe 的燃尽字段可用且可信时（`runway_seconds` 存在 + `burn_confident` + `burn_rate_pct_per_hour > 0`）：
- 计算「距打满时间」= `(100 - util) / burn_rate_pct_per_hour`，即未被 reset 边界截断的真实 burn-to-full。
- 当真实 burn-to-full `< FINISHING_HORIZON_SEC`（默认 30min=1800s，可配 `BUDGET_FINISHING_HORIZON`）→ **强提醒写 checkpoint**（比 T3 静态线更早，因为它看的是"按当前燃尽率快撞线了"，不是静态百分比）。
- `runway_seconds` 仍作为 probe 信号存在性检查，但不能直接作为强收尾判据：它会被 reset 边界截断。若低 util/慢燃尽只是因为窗口即将 reset 导致 `runway_seconds < horizon`，降级为静态线，不输出"距打满"文案。
- 仍然**不 deny**。
- runway 不可用 / 不 confident / burn rate 非正 → 退回 T3 静态线提醒（3.1），不静默。
- bash 版 guard 没有 burn/runway 管道，pre 阶段只实现静态硬线提醒，不做 runway 早触发。

### 3.3 phaseStop 的处理

`phaseStop`（轮末）在 PR1 中保持：硬线 `continue:false` 强制停 + 写 pending（watchdog/bridge 续接）。
- **保留 watchdog 续接基建**（刷新后自动唤醒是宗旨「不被打断」的另一半——停了能自动接）。
- **保留 `continue:false`**：这是轮末干净停，不是工具调用中途 deny；pending 文件是后续自动续接的源头。

### 3.4 不变的部分

- T1（80）/ T2（90）提醒：不变（本来就是提醒不拦）。
- 手动 skip 机制（`/budget-skip` 等）：保留。active skip 下 `phasePre` 静默放行；`phaseStop` 在 skip 有效期内不强停，到期后恢复轮末干净停。
- probe / 数据源：不改。node hook 消费已有 burn/runway 字段；bash guard 因 `budget-probe` 无 runway 管道而保持静态线。

## 4. 影响面 + 测试要点

- `lib/guard/hook.mjs` phasePre（deny→remind）+ 收尾保护线；phaseStop 保持 `continue:false` + pending。
- `claude-budget-guard/budget_guard.sh` + `codex-budget-guard/budget_guard.sh`：bash 版同步改 pre 的 deny；stop 保持 `continue:false` + pending，并把 pending payload 归一到 node schema。
- 测试：① pre 在硬线返回 additionalContext/systemMessage 不返回 deny ② 真实 burn-to-full<horizon 可在 util<hard 时早触发收尾提醒 ③ reset-bound capped runway<horizon 不触发强收尾且不输出"距打满" ④ runway 不可用退 T3 静态提醒 ⑤ watchdog/phaseStop 续接源头仍工作 ⑥ T1/T2 不变 ⑦ 既有 deny 测试改为断言「不再 deny」。

## 5. 风险

- **腰斩风险**：不 deny → 真撞供应商限流会被硬切（更难看，无 checkpoint）。对冲：收尾保护线（runway 提前提醒）+ checkpoint 纪律。用户已知情接受。
- **reset-bound 误判风险**：`runway_seconds` 会被 reset 边界截断，不能直接等同"距打满"。实现已改为只有未被 reset 截断的 burn-to-full 才进入 runway 文案，避免窗口即将刷新时误报"即将打满"。
- **watchdog 依赖**：`continue:false` 已保留，轮末干净停 + pending 仍是自动续接前提。
- 双实现（bash + node）一致性：两套 hook 都要改，别只改一套。
