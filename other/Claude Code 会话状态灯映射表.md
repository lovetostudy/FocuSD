# Claude Code 会话生命周期 + 状态灯映射全景表

> 版本: 0.2.5 | 更新: 2026-07-18

## 颜色语义

- 🟡 **金黄** `#e8a400` — 运行中（automode）
- 🔴 **红** `#ff5e4d` — 等待确认
- 🟢 **绿** `#35e985` — 空闲

## A. 正常流程

| # | 场景 | Hook 事件 | 灯状态 | 正确? | 备注 |
|---|------|----------|--------|------|------|
| A1 | 启动 Claude Code | `SessionStart` | 🟢 空闲 | ✅ | 无 flag |
| A2 | 用户输入 prompt | `UserPromptSubmit` | 🟡 运行中 | ✅ | 创建 running flag |
| A3 | Claude 执行工具（读文件/编辑等） | `PreToolUse` | 🟡 运行中 | ✅ | 刷新 running flag，清除 confirming flag |
| A4 | Claude 完成响应，等待下一轮输入 | — 无 — | 🟡 运行中 | ⚠️ | 同一 session 内无"回合结束"hook，灯持续金黄；但 session 活跃即金黄是合理的 |
| A5 | Claude 完成任务，正常退出 | `Stop` | 🟢 空闲 | ✅ | 清除所有 flag |
| A6 | Claude 异常退出/崩溃 | `StopFailure` | 🟢 空闲 | ✅ | 同上 |
| A7 | 用户关闭终端窗口 | ❓ | 🔴→🟡→🟢（超时恢复） | ✅ | running flag 超时覆盖 |

## B. 权限确认流程

| # | 场景 | Hook 事件 | 灯状态 | 正确? | 备注 |
|---|------|----------|--------|------|------|
| B1 | 权限弹窗出现 | `PermissionRequest` | 🔴 等待确认 | ✅ | confirming flag 创建 |
| B2 | 用户点 Yes | `PreToolUse` | 🟡 运行中 | ✅ | running.ps1 清除 confirming flag |
| B3 | 用户点 No | — 无 — | 🔴→🟡（30s 后恢复） | ✅ | 30s 超时 Rust 端自动忽略 confirming flag |

## C. 手动中断流程

| # | 场景 | Hook 事件 | 灯状态 | 正确? | 备注 |
|---|------|----------|--------|------|------|
| C1 | 用户按 Esc 中断执行 | ❓ | 🔴→🟡→🟢（超时恢复） | ✅ | running flag 5min 超时 Rust 端自动忽略 |
| C2 | 用户 Ctrl+C 中断 | ❓ | 🔴→🟡→🟢（超时恢复） | ✅ | 同上 |
| C3 | 用户输入新 prompt 覆盖 | `UserPromptSubmit` | 🟡 运行中 | ✅ | 如有残留 confirming flag 会被清除 |

## D. Plan Mode 相关

| # | 场景 | Hook 事件 | 灯状态 | 正确? | 备注 |
|---|------|----------|--------|------|------|
| D1 | 进入 Plan Mode | — 无特殊 hook — | 🟡 运行中 | ⚠️ | 与普通运行无区别 |
| D2 | Plan Mode：Claude 读文件调研 | `PreToolUse` | 🟡 运行中 | ✅ | |
| D3 | Plan Mode：Claude 通过 AskUserQuestion 提问 | `PreToolUse` | 🟡 运行中 | ⚠️ | AskUserQuestion 不走 PermissionRequest，难以与普通工具调用区分 |
| D4 | ExitPlanMode → 代码实现 | `PreToolUse` | 🟡 运行中 | ✅ | 如有权限弹窗则走 B1/B2 |
| D5 | 用户确认/拒绝方案 | — 纯 UI — | 🔴→🟡 或 🟡 | ⚠️ | 确认后继续；拒绝则可能 Stop |

## E. 特殊场景

| # | 场景 | Hook 事件 | 灯状态 | 正确? | 备注 |
|---|------|----------|--------|------|------|
| E1 | Claude 长时间思考（无工具调用） | — 无 — | 🟡 运行中 | ✅ | UserPromptSubmit 已设 running |
| E2 | 多 session 并发（多个终端窗口） | 各自独立 | 多个点 | ✅ | per-session 设计 |
| E3 | 关闭 FocuSD 重开 | 启动清理 | 🟢 空闲 | ✅ | clear_stale_agent_flags |
| E4 | 确认后立即回到运行 | `PreToolUse` | 🔴→🟡 瞬闪 | ⚠️ | 因为 hook 返回 auto-allow，confirming 几乎闪现就消失 |

---

## 当前 Hook 矩阵

| Hook 事件 | 脚本 | 参数 | 超时 |
|-----------|------|------|------|
| SessionStart | focusd-agent-session-start.ps1 | — | 5s |
| UserPromptSubmit | focusd-agent-running.ps1 | claudeCode | 5s |
| PreToolUse (*) | focusd-agent-running.ps1 | claudeCode | 5s |
| PermissionRequest (*) | focusd-agent-running.ps1 | claudeCode confirming | 5s |
| Stop | focusd-agent-status.ps1 | claudeCode completed | 5s |
| StopFailure | focusd-agent-status.ps1 | claudeCode failed | 5s |

---

## 状态机

```
                    FocuSD 启动
                    (clear_stale_agent_flags)
                            │
                            ▼
                    ┌──────────────┐
                    │    空闲 🟢    │
                    └──────────────┘
                     ▲            │
                     │   UserPromptSubmit
           Stop /   │   PreToolUse
      StopFailure   │   (5min 无刷新→超时)  │
                     │            ▼
                     │    ┌──────────────┐
                     ├────│  运行中 🟡   │
                     │    │(5min超时→🟢)  │
                     │    └──────────────┘
                     │            │
                     │   PermissionRequest
                     │            │
                     │            ▼
                     │    ┌──────────────────┐
                     │    │ 等待确认 🔴      │
                     │    │ (30s 超时自动忽略)│
                     │    └──────────────────┘
                     │            │
                     │   用户 Yes → PreToolUse
                     │            │
                     └────────────┘
```
