# token-budget-guard E2E 测试范围(Claude × Codex 收敛版)

双方独立起草 → 合并收敛。优先级:**P0 = merge 前必须真机** / P1 = 应测(可较廉方法) / P2 = unit+推理兜底。
状态:☐ 待做 / ☑ 已覆盖 / ◐ 部分。归属:[C]laude / [X]Codex / [双].

---

## P0 — merge 前必须补(真机/集成)

| # | 行为 | 测什么 | 测法 | 归属 | 状态 |
|---|---|---|---|---|---|
| P0-1 | claude `pre` 硬线 deny | 95% 新工具(Bash)被 PreToolUse deny | tmux 真 claude -p + fixture + marker | C | ☑ tmux-hook-e2e.sh |
| P0-2 | claude `pre` 放行写 checkpoint | 95% 时写 .agent/checkpoint.md 放行、写其它文件拒 | tmux 真 claude + marker | C | ☑ tmux-checkpoint-allow-e2e.sh PASS |
| P0-3 | claude `stop` continue:false 真停 | 95% 时 phaseStop 硬停分支真执行(写 pending + continue:false) | tmux 真 claude(Stop hook)→ 验 pending 文件写入 | C | ☑ tmux-stop-e2e.sh PASS(主证据 pending;loop-cut 由源码兜底) |
| P0-4 | claude `resume` 注入 checkpoint | 预置 pending+checkpoint,--resume 后 agent 上下文含「续接」并从下一步继续 | tmux 真 claude --resume + marker | C | ☐ |
| P0-5 | claude C4 park | 真 agent 任务中途调 wait_until_budget_refresh,fixture 95→20,**断言 park 期间无后续动作 + flip 后同 turn 继续**(token-free 用 MCP log+marker 时序间接证) | (1) wait_until_budget_refresh 直接调 + flip:☑ park 6s→ready;(2) MCP server SDK E2E(Codex)☑;(3) 真 claude headless 调用:◐ headless MCP 集成未跑通(claude 域,真实用途是交互) | C | ◐ 机制✓,真-agent-headless 待交互验 |
| P0-6 | codex `pre`/`stop` 硬线 | 同 P0-1/3 但真 codex;**额外:apply_patch 纯 checkpoint 写放行、delete/multi-file/non-checkpoint 拒** | tmux 真 codex exec + fixture | X | ☐ |
| P0-7 | codex C4 park + tool_timeout 对照 | 高 tool_timeout_sec park 成功(同 P0-5 断言) / 低值阻塞被砍(保护有效) | tmux 真 codex + MCP + fixture flip | X | ☐ |
| P0-8 | codex 硬停 + /goal pause | goal active 撞 95,pause+deny 后不 idle 自续;省略 pause 的失败模式单独证 | tmux 真 codex TUI/exec + marker 序列 | X | ☐ |
| P0-9✓ | C3 claude watchdog 真 resume | 武装后真起 `claude --resume <sid>`,warn_util gate,scoped pending;**用 step counter/secret 证上下文连续(非仅进程重启)** | 真机 armed watchdog + 预置 pending + 低 fixture | C | ☐ |
| P0-10 | C3 codex watchdog 真 resume | 真 `codex exec resume <sid>`/`--last` 续 thread;**用 secret/step 证续的是同 thread 上下文,非新会话** | 真机 armed watchdog + 预置 pending | X | ☐ |
| P0-11 | live probe doctor 双家 | 真 token 跑 doctor,全 bucket/winner/reset 类型/codex account-id header/claude model buckets | 真 token integration(脱敏) | 双(各自家) | ◐ claude ☑(全 bucket+reset 验过);codex 待 X |
| P0-12 | **headline 全闭环** | 设 goal→80 once→90 repeat→95 stop+checkpoint→C4 或 C3 刷新→自动续完成 | tmux 端到端 + fixture 时间压缩;claude 版 C、codex 版 X | 双 | ☐ |

## P1 — 应测(单测/dry-run/集成,不必烧真 token)

| # | 行为 | 测法 | 归属 | 状态 |
|---|---|---|---|---|
| P1-1 | 5 phase × 2 agent JSON 输出契约(golden JSON) | node 单测 + hook stdin fixtures | C | ◐ phasePost/Stop 有,缺 prompt/pre/resume golden + codex 分支 |
| P1-2 | T1 once(reset 变 re-arm)/ T2 每次 / T3 pre+stop 统一 warn_util | 单测 | C | ◐ 大部分有 |
| P1-3 | pending 队列:scoped 优先/legacy fallback/session 去重/mtime 选最新/cwd 切换 | shell dry-run + node 单测 | X | ◐ watchdog.test 有部分 |
| P1-4 | watchdog gate:warn_util 高不续/回落续/stale/rate-limit 不误续 | watchdog dry-run | X | ◐ |
| P1-5 | MCP SDK:check_budget 正常/失败、wait retry/exec fail/timeout advice | SDK integration | X | ☑ budget-mcp.test + Codex SDK E2E |
| P1-6 | 429/cache:Retry-After/5min 闸、longest-wins、TTL、parse-fail 不写、CAS same-second | mocked HTTP + unit | C | ◐ CAS 有,429 缺 |
| P1-7 | installer claude:幂等/旧 bash hook 去重/.bak/marker block/uninstall 干净 | temp HOME 测试 | C | ◐ 手动验过,缺自动化 |
| P1-8 | installer codex:MCP 注册/canonical probe/tool_timeout_sec/保留用户 config/uninstall | temp HOME 测试 | X | ◐ |
| P1-9 | checkpoint 安全:symlink final/ancestor、Delete、Move-to、multi-hunk、spaces、破坏性名、良性子串 | unit + 1 真 hook smoke | C | ◐ unit 强(guard.test);真 hook checkpoint allow/delete/multi-path smoke 待 P0-2/P0-6 补 |
| P1-10 | fail-open:no token/bad schema/HTML/oversize/network → exit0 JSON 不误停 | mocked provider + unit | C | ◐ 部分 |

## P2 — unit + 推理兜底(不必每 PR 真机)

| # | 行为 | 测法 | 归属 |
|---|---|---|---|
| P2-1 | burn-rate 目标线 T3 / 抖动(Node 侧目前未实现,bash 专属)| unit / 文档标注 | C |
| P2-2 | docs drift:README/CLAUDE/AGENTS/HTML marker+threshold+C4/C3 措辞一致 | docs unit | C |
| P2-3 | 跨平台:macOS BSD、路径空格、HOME override、state dir 权限 | unit/temp dir | 双 |
| P2-4 | 多小时 C4 真实 park 稳定性 | nightly/manual soak(非每 PR) | X |
| P2-5 | live 429 真实行为 | mock 兜底 + 偶遇记录(不刻意打爆端点) | C |

---

## merge gate(双方共识)
merge 前至少补齐:**P0-3(claude stop 真停)、P0-5/P0-7(C4 双家 park)、P0-9/P0-10(C3 双家 resume)、P0-8(codex /goal pause)、P0-11(live doctor 双家)**。P0-2/4/6/12 尽量补;P1/P2 可分层自动化跟进,不阻塞但要在 PR 里登记为 follow-up。

## 成本/安全约束
真机 P0 在**隔离临时项目目录** + 限权(--allowedTools/--sandbox workspace-write/--max-turns)+ watchdog 仅在测试时显式 arm 跑;fixture 时间压缩避免真等数小时;每条 E2E 跑完清理 tmux session/marker/临时 HOME。
