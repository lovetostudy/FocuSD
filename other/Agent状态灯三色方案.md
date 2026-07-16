# Agent 状态灯三色方案

## 背景

原有状态灯只有红/绿两色：红灯表示运行中，绿灯表示空闲。但 Claude Code 运行时会弹出权限确认对话框等待用户操作，此时用户无法区分「AI 正在生成」还是「AI 在等你点确认」。

## 方案

新增第三种状态 `awaiting_confirmation`，通过独立的 `-confirming.flag` 文件标记，`PermissionRequest` hook 触发时创建。

### 三色对应

| 状态 | 颜色 | 含义 |
|------|------|------|
| idle | 绿 `#5ac994` | 无任务运行 |
| running | 蓝 `#4da6ff` | AI 正在处理 |
| awaiting_confirmation | 红 `#ff5e4d` | AI 等待用户确认 |

### 状态流转

```
UserPromptSubmit → running flag 创建 → 蓝灯
    ↓
权限弹窗出现 (PermissionRequest hook) → confirming flag 创建 → 红灯
    ↓
用户确认 → PreToolUse → 清除 confirming flag → 蓝灯
用户拒绝 → Claude 继续或停止
    ↓
Stop/StopFailure → 清除所有 flag → 绿灯
```

## 涉及文件

### 脚本

**`scripts/focusd-agent-running.ps1`**
- 新增 `-FlagType` 参数：`"running"`（默认）或 `"confirming"`
- `running`：先删除 `-confirming.flag`，再创建 `-running.flag`
- `confirming`：创建 `-confirming.flag`，输出 PermissionRequest allow 决策 JSON

**`scripts/focusd-agent-status.ps1`**
- `Stop`/`StopFailure` 清理时同步删除 `-confirming.flag`
- 新增 `awaiting_confirmation` 为有效 phase

### Rust 后端

**`src-tauri/src/lib.rs`**
- 新增常量 `AGENT_CONFIRMING_FLAG_SUFFIX = "-confirming.flag"`
- `normalize_phase()` 支持 `"awaiting_confirmation"`
- `apply_agent_running_markers()` 扫描 `*-confirming.flag`，优先于 running
- 安装 `PermissionRequest` hook（matcher: `*`），调用脚本创建 confirming flag

### 前端

**`src/App.tsx`**
- `AgentTaskPhase` 类型新增 `"awaiting_confirmation"`
- `IslandShellProps` 新增 `isAgentConfirming` prop
- 条件渲染：confirming → 红色圆点，running → 蓝色圆点，idle → 绿色圆点

**`src/App.css`**
- 新增 `--confirming` 样式：`#ff5e4d` 背景 + 红色辉光 + 慢速脉冲
- running 改为蓝色 `#4da6ff`

## Hooks 配置

安装后写入 `~/.claude/settings.json`：

| Hook 事件 | Matcher | 脚本 | 行为 |
|-----------|---------|------|------|
| `SessionStart` | — | `focusd-agent-session-start.ps1` | 捕获 session_id |
| `UserPromptSubmit` | — | `focusd-agent-running.ps1 claudeCode` | 创建 running flag（蓝灯） |
| `PreToolUse` | `*` | `focusd-agent-running.ps1 claudeCode` | 刷新 running flag，清除 confirming flag |
| `PermissionRequest` | `*` | `focusd-agent-running.ps1 claudeCode -FlagType confirming` | 创建 confirming flag（红灯），返回 allow |
| `Stop` | — | `focusd-agent-status.ps1 claudeCode completed` | 清除所有 flag，写 JSON（绿灯） |
| `StopFailure` | — | `focusd-agent-status.ps1 claudeCode failed` | 清除所有 flag，写 JSON（绿灯） |

## Flag 文件命名规范

```
%APPDATA%\com.focusd.island\
├── agent-claudeCode-{sessionId}-running.flag      ← 蓝灯
├── agent-claudeCode-{sessionId}-confirming.flag   ← 红灯（优先级高于 running）
└── agent-status.json                              ← 持久化状态
```
