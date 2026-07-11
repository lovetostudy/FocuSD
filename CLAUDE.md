# CLAUDE.md

本文件为 Claude Code (claude.ai/code) 在本仓库工作提供指导。

## 构建命令

```powershell
pnpm install                  # 安装依赖
pnpm dev                      # 启动 Vite 前端开发服务器 (port 1420)
pnpm build                    # TypeScript 检查 + Vite 构建
pnpm tauri dev                # Tauri 桌面开发模式
pnpm tauri build              # 完整构建（生成安装包 + exe）
pnpm tauri build --no-bundle  # 仅生成 exe
```

无 lint/test/format 命令。验证靠 `pnpm build` 和手动 `pnpm tauri dev`。

## 架构概览

### 前端：`src/App.tsx`（约 100KB 单一组件）+ `src/App.css`（约 38KB）

没有组件拆分。所有类型、状态、渲染都在 App.tsx 里。新增功能直接在 App.tsx 中加，不创建新文件。

**关键类型**（App.tsx 顶部）：
- `IslandMode`: `"collapsed"` | `"expanded"`
- `IslandPage`: `"todo"` | `"music"` | `"clipboard"` | `"layout"`
- `TodoPageMode`: `"today"` | `"archive"`（点1 待办列表 / 点3 完成日记书）
- `ArchiveLayout`: `"cards"` | `"timeline"`
- `AgentSessionInfo`: `{ sessionId, provider }` — per-session 状态灯

**持久化**：全部用 `localStorage`，key 前缀 `focusd-island-`。包括：settings、presets、todos、active-todo、todos-directory。

**Tauri 通信**：通过 `invoke()` 调用 Rust 命令，通过 `listen()` 监听 Rust 事件。

### Rust 后端：`src-tauri/src/lib.rs` + `src-tauri/src/clipboard_history.rs`

**Tauri 命令**：
| 命令 | 用途 |
|------|------|
| `set_island_layout` / `set_island_interaction` | 窗口位置/大小/模式 |
| `show_ready_island` / `minimize_island` | 显示/隐藏 |
| `get_launch_at_startup` / `set_launch_at_startup` | 开机自启（注册表） |
| `get_exe_dir` | 获取 exe 所在目录 |
| `save_todos` | 覆盖写 `todos.md` |
| `append_completed_todo` | 追加写 `YYYY-MM-DD.md` |
| `list_completed_archives` | 扫描日期的已完成项 |
| `get_agent_status` / `install_agent_status_hooks` | AI Agent 状态灯 |
| `get_media_state` / `get_audio_level` | Windows 音频 |
| `media_play_pause` / `media_next` / `media_previous` | 媒体控制 |
| `get_clipboard_history` / `set_clipboard_history_settings` 等 | 剪贴板历史 |

### Agent 状态灯脚本：`scripts/`

| 脚本 | 触发时机 | 行为 |
|------|---------|------|
| `focusd-agent-session-start.ps1` | Claude Code SessionStart hook | 从 stdin 读 `session_id`，写入 `CLAUDE_ENV_FILE` |
| `focusd-agent-running.ps1` | UserPromptSubmit / PreToolUse | 读 `FOCUSD_SESSION_ID` 环境变量，创建 `agent-{provider}-{session_id}-running.flag` |
| `focusd-agent-status.ps1` | Stop / StopFailure | 删当前 session 的 flag，写 `agent-status.json` |

三个脚本编译进 exe（`include_str!`）。安装时写入 `%APPDATA%\com.focusd.island\`。

## 待办系统

- **列表**：永久保留，不按日期拆分。完成时从列表移除 + 追加写 `{todos目录}/YYYY-MM-DD.md`
- **保存**：编辑后 500ms 自动覆盖写 `{todos目录}/todos.md`（只有未完成项）
- **完成日记书**（点3）：直接读磁盘 `YYYY-MM-DD.md`，卡片/时间线两种布局，点日期展开查看
- **目录**：默认 `{安装目录}/todos`，设置页可自定义

## 文件存储

```
{todos目录}/
├── todos.md           ← 未完成列表（覆盖写）
├── 2026-07-11.md      ← 已完成归档（追加写）
└── 2026-07-10.md
```

## 开发注意事项

- App.tsx 极其庞大，新增逻辑前先搜索已有类型/状态/工具函数
- 常量在 App.tsx 顶部和 lib.rs 顶部
- 窗口有 collapsed/expanded/tucked/托盘隐藏四种状态
- Tauri 命令新增：Rust `#[tauri::command]` + `generate_handler!` → 前端 `invoke()` + 类型 → 必要时更新 `capabilities/default.json`
- 完成后验证：`pnpm tauri build --no-bundle`
- 不要重构 App.tsx 结构、格式化整仓、删除无关代码
