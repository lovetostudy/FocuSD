# FocuSD Island

> Windows 优先的 Tauri + React 桌面悬浮岛，把最重要任务、AI Agent 状态灯、剪贴板历史和媒体控制放在屏幕顶部。

## 核心功能

- **悬浮岛窗口**：透明、无边框、始终置顶，支持折叠、展开、边缘收起和托盘隐藏。
- **AI Agent 状态灯**：胶囊上方显示 per-session 红/绿指示灯。安装 hooks 后，多个 Claude Code 实例并发运行时各自独立亮灯。一键安装/修复 hooks，无需手动配置。
- **待办事项**：支持分类（Category）管理，默认 `TASKS` 分类。任务按分类分组显示，完成时自动归档。支持设专注任务。
- **完成日记书**：按日期查看已完成事项，卡片/时间线两种布局，数据直接读磁盘文件。
- **Markdown 保存**：未完成列表按分类分组保存为 `todos.md`（`## 分类名` 标题格式），已完成按日期追加到 `YYYY-MM-DD.md`。分类名持久化，只能手动编辑文件删除。默认保存目录为安装目录下 `todos/`，可在设置中自定义。
- **剪贴板历史**：记录文本和图片剪贴板，全局快捷键呼出，支持复制、删除和清空。
- **媒体控制**：系统音频活动检测，播放/暂停、上一首、下一首。
- **外观设置**：透明度、缩放、间距、主题颜色，支持自定义预设。
- **系统集成**：托盘菜单、开机自启动。

## 部署

### 安装包（推荐）

从 GitHub Releases 下载 `FocuSD Island_0.1.1_x64-setup.exe`，按提示安装。

### 源码构建

环境要求：Windows 10/11、Node.js、pnpm、Rust/Cargo、VS Build Tools（C++ 工作负载）、WebView2 Runtime

```powershell
git clone <repo-url>
cd FocuSD
pnpm install
pnpm tauri build
```

构建产物：
- `src-tauri/target/release/focusd-island.exe` — 便携 exe
- `src-tauri/target/release/bundle/nsis/` — NSIS 安装包
- `src-tauri/target/release/bundle/msi/` — MSI 安装包

## 常用命令

| 命令 | 说明 |
|------|------|
| `pnpm install` | 安装前端与 Tauri CLI 依赖 |
| `pnpm dev` | 启动 Vite 前端开发服务器 |
| `pnpm build` | TypeScript 检查并构建前端 |
| `pnpm tauri dev` | 启动 Tauri 桌面开发模式 |
| `pnpm tauri build` | 构建 Tauri 桌面应用（含安装包） |
| `pnpm tauri build --no-bundle` | 仅生成 release exe |

## 技术栈

- [Tauri 2](https://tauri.app/)：桌面应用外壳与原生能力
- [React 19](https://react.dev/)：前端界面
- [Vite 7](https://vite.dev/)：前端开发与构建
- [TypeScript](https://www.typescriptlang.org/)：类型约束
- [Rust](https://www.rust-lang.org/)：窗口定位、托盘、文件 I/O、媒体控制、Windows API
- [lucide-react](https://lucide.dev/)：图标

## 项目结构

```
├── src/                    # React 前端
│   ├── App.tsx             # 核心 UI、状态和 Tauri invoke 调用
│   ├── App.css             # 主要样式
│   └── main.tsx            # React 入口
├── src-tauri/              # Tauri / Rust 桌面端
│   ├── src/lib.rs          # 原生命令、窗口、托盘、Agent hooks、媒体、文件 I/O
│   ├── src/clipboard_history.rs  # 剪贴板历史（消息窗口 + 全局热键）
│   ├── src/main.rs         # Tauri 应用入口
│   ├── capabilities/       # Tauri 权限配置
│   └── tauri.conf.json     # Tauri 配置
├── scripts/                # AI Agent 状态灯 hook 脚本
│   ├── focusd-agent-running.ps1
│   ├── focusd-agent-status.ps1
│   └── focusd-agent-session-start.ps1
├── package.json
└── README.md
```

## 数据与存储

- 待办、外观设置等前端状态保存在 `localStorage`
- 待办文件默认保存到 `{安装目录}/todos/`，设置页可自定义目录
- 完成日记书直接读取磁盘文件，不经过 localStorage
- Agent 状态灯数据保存在 `%APPDATA%\com.focusd.island\`
- 开机自启动使用注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`

## AI Agent 状态灯

安装后在设置页点击「安装/修复」，自动配置 Claude Code hooks：
- `SessionStart`：捕获 session_id 写入环境变量
- `UserPromptSubmit` / `PreToolUse`：标记当前 session 运行中（红灯）
- `Stop` / `StopFailure`：标记任务完成/失败（绿灯）

多个 Claude Code 实例并发时，每个 session 独立亮灯，胶囊上方显示对应数量的指示灯。
