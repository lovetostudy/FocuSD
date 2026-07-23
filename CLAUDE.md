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
- `IslandPage`: `"todo"` | `"music"` | `"layout"`
- `TodoPageMode`: `"today"` | `"archive"`（点1 待办列表 / 点3 完成日记书）
- `ArchiveLayout`: `"cards"` | `"timeline"`
- `AgentSessionInfo`: `{ sessionId, provider }` — per-session 状态灯
- `PluginManifest`: `{ id, name, version, description, author, icon, isLoad }` — 插件清单

**持久化**：全部用 `localStorage`，key 前缀 `focusd-island-`。包括：settings、presets、todos、active-todo、todos-directory。`pluginHtmlCache` 为运行时内存缓存（`Map<string, string>`）。

**Tauri 通信**：通过 `invoke()` 调用 Rust 命令，通过 `listen()` 监听 Rust 事件。

### Rust 后端：`src-tauri/src/lib.rs`

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
| `list_todos_files` / `read_todos_file` | 待办文件 I/O |
| `list_plugins` | 扫描 `<exe_dir>/plugs/` 下含 `plugin.json` 的子目录，返回 `Vec<PluginManifest>`。过滤 `isLoad: false` 的插件 |
| `read_plugin_html` | 读取插件 `index.html`，返回 HTML 字符串 |
| `get_app_version` | 返回 `CARGO_PKG_VERSION` |

### 多设备同步

通过 HTTP 服务器同步待办数据。设置页填入服务器地址（如 `http://192.168.1.100:3456`），点同步按钮执行 pull-then-push。协议：`GET /sync` 拉取 → `PUT /sync` 上传，body 为 `{ files: {...}, deviceId: "..." }`。编辑完成后 1 秒自动 push、启动时自动 pull。

### Agent 状态灯脚本：`scripts/`

同时支持 Claude Code 和 Codex (OpenAI)，分别安装到 `~/.claude/settings.json` 和 `~/.codex/config.toml`。

三色状态：**蓝灯**运行中、**红灯**等待确认、**绿灯**空闲。

| 脚本 | 触发时机 | 行为 |
|------|---------|------|
| `focusd-agent-session-start.ps1` | SessionStart hook（仅 Claude Code） | 从 stdin 读 `session_id`，写入 `CLAUDE_ENV_FILE` |
| `focusd-agent-running.ps1` | UserPromptSubmit / PreToolUse | 读 `FOCUSD_SESSION_ID` 环境变量，创建 `agent-{provider}-{session_id}-running.flag`（蓝灯） |
| `focusd-agent-confirming.bat` | PermissionRequest (*) | cmd.exe 创建 `agent-{provider}-{session_id}-confirming.flag`（红灯），不返回决策，由 Claude Code 自身处理权限 |
| `focusd-agent-status.ps1` | Stop / StopFailure | 删当前 session 的 `-running.flag` 和 `-confirming.flag`，写 `agent-status.json`（绿灯） |

`PreToolUse` 触发时 cmd.exe 快速清除 `-confirming.flag`（用户确认后恢复红灯）。PowerShell 脚本仅用于需要 JSON 解析/Mutex 的状态写入。

三个 PowerShell 脚本和一个 bat 文件编译进 exe（`include_str!`）。安装时写入 `%APPDATA%\com.focusd.island\`。

## 待办系统

- **分类**：任务按 category 分组，默认 `TASKS` 分类。分类 tab 显示在顶部，点 `+` 创建新分类。分类名持久化，只能手动编辑 `todos.md` 删除。
- **列表**：永久保留，不按日期拆分。完成时从列表移除 + 追加写 `{todos目录}/YYYY-MM-DD.md`
- **保存**：编辑后 500ms 自动覆盖写 `{todos目录}/todos.md`（按分类分组，`## 分类名` 标题 + `- [ ] item`）
- **完成日记书**（点3）：直接读磁盘 `YYYY-MM-DD.md`，卡片/时间线两种布局，点日期展开查看
- **目录**：默认 `{安装目录}/todos`，设置页可自定义
- **启动加载**：启动时从 `todos.md` 读取任务和分类，文件不存在则回退到 localStorage

## 文件存储

```
{安装目录}/
├── focusd-island.exe
├── plugs/             ← 插件目录（运行时扫描加载）
├── todos/             ← 待办目录（可自定义路径）
│   ├── todos.md       ← 未完成列表（覆盖写，按 ## 分类分组）
│   ├── 2026-07-11.md  ← 已完成归档（追加写，不带分类）
│   └── 2026-07-10.md
└── uninstall.exe
```

`todos.md` 格式：
```markdown
## TASKS
- [ ] 未完成任务
- [ ] 另一任务

## 工作
- [ ] 工作相关任务
```

## 插件系统

启动时 `list_plugins` 扫描 `<exe_dir>/plugs/` 目录，每个子目录代表一个插件。前端在展开态动态渲染插件 dot（最多 6 个），点击后通过 `<iframe srcDoc>` 渲染插件的 `index.html`。HTML 内容按需加载并缓存在 `pluginHtmlCache`（运行时 `Map`）。

### 插件开发标准

```
{安装目录}/plugs/
└── plugin-name/
    ├── plugin.json    — 清单文件（必须）
    └── index.html     — 入口页面（必须，单文件自包含）
```

**plugin.json 字段：**

| 字段 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `name` | 是 | — | 插件名称，显示在 dot tooltip |
| `version` | 是 | — | 语义化版本号 |
| `icon` | 否 | `#74d6ff` | dot 颜色（hex） |
| `isLoad` | 否 | `true` | `false` 时不加载 |
| `description` | 否 | `""` | 简短描述 |
| `author` | 否 | `""` | 作者 |

**index.html 规范：**
- 单文件自包含（CSS/JS 内联），宽度自适应 ~360px
- 可联网（iframe sandbox 含 `allow-scripts allow-same-origin`）
- 通信走 `window.parent.postMessage({ type, payload })`

**宿主 postMessage API：**

| 方向 | type | payload | 说明 |
|------|------|---------|------|
| host → plugin | `focusd:init` | `{ width, height }` | 宿主就绪 |
| plugin → host | `focusd:resize` | `{ height: number }` | 请求调整面板高度 |

### 插件存储

```
{安装目录}/plugs/
├── hello/              ← 示例插件
│   ├── plugin.json
│   └── index.html
└── github-info/        ← 联网查询插件
    ├── plugin.json
    └── index.html
```

## 开发注意事项

- App.tsx 极其庞大，新增逻辑前先搜索已有类型/状态/工具函数
- 常量在 App.tsx 顶部和 lib.rs 顶部
- 窗口有 collapsed/expanded/tucked/托盘隐藏四种状态
- Tauri 命令新增：Rust `#[tauri::command]` + `generate_handler!` → 前端 `invoke()` + 类型 → 必要时更新 `capabilities/default.json`
- 完成后验证：`pnpm tauri build`（直接构建安装包）
- 不要重构 App.tsx 结构、格式化整仓、删除无关代码
