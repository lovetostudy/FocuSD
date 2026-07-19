# FocuSD Sync Protocol 设计方案

## Context

当前同步实现（`src/App.tsx` + `server/app.py`）的致命缺陷：

1. **全量覆盖，无冲突检测**：pull/push 都是整文件覆盖，两边同时编辑 → 数据丢失
2. **文件级同步粒度太粗**：`todos.md` 一个文件包含所有任务，改一个字就全量传输
3. **deviceId 只发不用**：push 传了但服务端只记日志，不做版本区分
4. **无增量同步**：每次全量拉取/推送
5. **无协议版本管理**：未来改格式直接断裂

目标：设计 FocuSD Sync Protocol v1，参考 OpenSubsonic 的协议规范方法论。

**涉及文件**：`src/App.tsx`（前端同步逻辑）、`server/app.py`（Flask 服务端）

---

## Part 1：协议怎么设计——方法论

以 OpenSubsonic 为解剖样本，一个好的协议规范包含以下要素：

### 1. 先定义数据模型和原子操作

不要上来画 API。先回答：
- 同步的**原子单位**是什么？（文件？单条 todo？）
- 数据之间什么**关系**？（独立？层级？引用？）
- 哪些操作**会产生冲突**？（同一条两边分别改了？一边完成一边编辑？）

FocuSD：原子单位 = **单条 Todo Item**（每条 UUID），而非整个文件。

### 2. 选冲突模型

| 方案 | 原理 | 适用 | FocuSD？ |
|------|------|------|---------|
| **LWW** | 每条记录带时间戳，最新的覆盖 | 单用户多设备 | ✅ |
| **Three-Way Merge** | 保留共同祖先 diff 合并 | 多人文档 | ❌ 过度 |
| **CRDT** | 操作保证可交换合并 | 实时协作 | ❌ 过度 |

**结论：LWW**。个人使用场景冲突极少，发生了也是「后改的覆盖先改的」，符合直觉。

### 3. 定协议骨架——OpenSubsonic 的做法

```
REST + JSON
├── 响应信封: 所有响应包裹在统一结构里 { status, version, data?, error? }
├── 版本化: 客户端发 v 参数声明实现的协议版本，服务端返回 serverVersion
├── 扩展模块: 独立可选的 Extension（如 API Key、Lyrics），各自有版本号
├── 标准化错误: 数字错误码 + 语义明确的消息，而非裸 HTTP 状态码
├── 能力广播: GET /status 返回服务端支持的 extensions 列表
└── 认证: 多种方式互斥（password / token+salt / apiKey），服务端返回特定错误码区分
```

FocuSD 同样用 **REST + JSON + 响应信封 + 版本化路径 + 扩展模块**。

### 4. 增量同步的核心——Revision Number + Gap Threshold

参考 IMAP 的 MODSEQ（单调递增序列号）和 Threshold 项目的 revision-gap 模式，**比纯时间戳更健壮**：

| 客户端 revision | 服务端 revision | Gap | 行为 |
|:-:|:-:|:-:|------|
| 50 | 50 | 0 | 无变更，返回空 |
| 48 | 50 | 2 | 增量：发送 rev 49-50 的变更 |
| 45 | 50 | 5 | 增量：发送 rev 46-50 的变更 |
| 10 | 150 | 140 | **回退全量**：差距太大，重放改动不如全量发送 |
| 52 | 50 | -2 | **客户端快于服务端**：冲突，全量重同步 |

阈值可配置（默认 100）。这比时间戳方案好在：
- **无时钟偏移问题**（不同设备时间可能有偏差）
- **单调计数器天然保证因果顺序**
- **Gap 阈值**在效率与实现复杂度之间取平衡

### 5. 写规范文档——OpenSubsonic 的风格

一份好的协议规范：
- **响应信封统一包裹**：客户端只需检查 `status` 字段就知成败
- **所有枚举可扩展**：未知值不回退到默认行为即可，不报错
- **扩展模块独立文档化**：每个 extension 有自己的 version、端点、字段
- **错误码加法规则**：新增错误码不改变已有错误码语义
- **OpenAPI 作为 machine-readable truth**：方便生成客户端 SDK 和验证工具

---

## Part 2：FocuSD Sync Protocol v1 规范

### 响应信封（Response Envelope）

所有端点统一包裹：

```json
// 成功
{
  "status": "ok",
  "protocolVersion": 1,
  "serverVersion": "1.0.0",
  "serverTime": "2026-07-18T14:30:00.000Z",
  "data": { ... }
}

// 失败
{
  "status": "failed",
  "protocolVersion": 1,
  "serverVersion": "1.0.0",
  "serverTime": "2026-07-18T14:30:00.000Z",
  "error": {
    "code": 10,
    "message": "Required parameter 'deviceId' missing"
  }
}
```

`status` 是二值判别器：`"ok"` | `"failed"`。客户端只需检查这一个字段。

### 错误码体系（参考 OpenSubsonic 的数字码风格）

| Code | 含义 |
|------|------|
| 0 | 未知错误 |
| 10 | 缺少必需参数 |
| 20 | 协议版本不兼容——客户端需升级 |
| 30 | 协议版本不兼容——服务端需升级 |
| 40 | 认证失败 |
| 50 | 数据未找到 |
| 60 | 请求格式错误（JSON 解析失败等） |
| 70 | 服务端内部错误 |

新增错误码不改变已有语义（加法规则）。

### 数据模型

```typescript
// 同步原子单位
interface SyncItem {
  id: string;            // UUID v4，客户端生成，全局唯一
  title: string;
  category: string;      // "TASKS" | "工作" | ...
  completed: boolean;
  completedAt?: string;  // ISO 8601 UTC，完成时才有
  updatedAt: string;     // ISO 8601 UTC，每次修改由客户端更新
  deleted: boolean;      // 软删除标记
  // x- 前缀字段为 vendor extension，客户端应忽略未知字段
}
```

时间戳全部 UTC ISO 8601，**由客户端生成**（LWW 的冲突判断依据）。

### 服务端存储模型

服务端维护一个单调递增的 `revision` 计数器（从 0 开始），每次存储变更 +1。每个 item 记录其对应的 revision。

```
服务端状态：
{
  revision: 152,         // 当前最新 revision（单调递增）
  items: {
    "uuid-abc": { ...item数据, revision: 150 },
    "uuid-def": { ...item数据, revision: 152 },
  }
}
```

### 端点

基路径：`{serverUrl}/api/v1/sync`

---

#### `GET /status` — 能力发现

客户端启动时首先调用，确认兼容性和服务端能力。

```
Request:
GET /api/v1/sync/status

Response:
{
  "status": "ok",
  "protocolVersion": 1,
  "serverVersion": "1.0.0",
  "serverTime": "2026-07-18T14:30:00.000Z",
  "data": {
    "currentRevision": 152,
    "itemCount": 42,
    "extensions": ["items-v1"],
    "gapThreshold": 100
  }
}
```

- `currentRevision`：服务端最新 revision，客户端用于判断是否需要同步
- `extensions`：服务端支持的扩展模块列表，客户端据此启用对应功能
- `gapThreshold`：增量/全量切换阈值

---

#### `GET /items?rev={revision}` — 增量拉取

```
Request:
GET /api/v1/sync/items?rev=148

Response (增量):
{
  "status": "ok",
  "protocolVersion": 1,
  "serverVersion": "1.0.0",
  "serverTime": "2026-07-18T14:30:00.000Z",
  "data": {
    "type": "incremental",
    "fromRevision": 148,
    "toRevision": 152,
    "currentRevision": 152,
    "items": [
      {
        "id": "abc-123",
        "title": "完成协议设计",
        "category": "TASKS",
        "completed": false,
        "updatedAt": "2026-07-18T12:00:00.000Z",
        "deleted": false
      }
    ]
  }
}

Response (全量，gap 超过阈值时):
{
  "status": "ok",
  ...
  "data": {
    "type": "full",
    "currentRevision": 152,
    "items": [ ...所有未软删除的 items... ]
  }
}
```

- `rev` 省略或为 0 → 首次同步，返回全量
- `gap = currentRevision - rev` ≤ 阈值 → 增量返回
- `gap > 阈值` 或 `rev > currentRevision`（客户端比服务端新）→ 返回全量
- 响应中 `items` 按 revision 升序排列
- `type` 字段告诉客户端本次是增量还是全量，客户端据此决定合并策略

---

#### `PUT /items` — 推送变更

```
Request:
PUT /api/v1/sync/items
Content-Type: application/json

{
  "deviceId": "dev-uuid-xxx",
  "baseRevision": 148,
  "items": [
    {
      "id": "abc-123",
      "title": "完成协议设计并写代码验证",
      "category": "TASKS",
      "completed": false,
      "updatedAt": "2026-07-18T13:00:00.000Z",
      "deleted": false
    }
  ]
}

Response:
{
  "status": "ok",
  ...
  "data": {
    "accepted": 2,
    "conflicts": [],
    "newRevision": 153
  }
}
```

- `baseRevision`：客户端上次同步时的 revision，用于冲突检测窗口
- **冲突检测**：服务端检查每个 item，如果 `item.id` 在服务端的 `revision > baseRevision`（说明该 item 在客户端上次同步后被其他设备改过），且服务端版本 `updatedAt` 比客户端新 → 服务端胜出，返回在 `conflicts` 里
- **无冲突**：服务端直接存储，revision +1
- `conflicts` 数组包含服务端的完整 item，客户端应用这些 item 覆盖本地
- 返回 `newRevision` 供客户端保存

### 同步流程

```
客户端（启动 / 手动触发 / 自动 debounce）:

1. GET /api/v1/sync/items?rev={lastRevision}
   ├── type: "incremental" → 拿到的 items 按 updatedAt 与本地对比，新的覆盖
   └── type: "full"        → 全量替换本地 todos

2. 收集本地脏数据:
   ├── 方式 A（简单）: 维护一个 Set<dirtyItemId>，每次修改标记
   └── 方式 B（健壮）: 对比每个 item 的本地 updatedAt > 上次 sync 时的 updatedAt

3. PUT /api/v1/sync/items
   → 服务端返回 { accepted, conflicts, newRevision }
   → 对每个 conflict，用服务端版本覆盖本地
   → 保存 newRevision

4. 本地持久化:
   → 将所有 item 写回 todos.md（保持现有文件格式兼容）
   → 保存 lastRevision 到 localStorage
```

编辑后自动 push：保持现有 1 秒 debounce，但只 push 脏 items（不是整个文件）。

### 扩展性设计——Extension 模块机制

参考 OpenSubsonic 的 Extensions 目录。协议核心（v1）只定义 items 同步。未来功能作为独立扩展模块叠加：

| Extension | 描述 | 新增端点 | 状态 |
|-----------|------|---------|------|
| `items-v1` | TodoItem CRUD 同步（核心） | `GET/PUT /items` | v1 |
| `presets-v1` | 设置预设同步 | `GET/PUT /presets` | 后续 |
| `auth-v1` | Pre-shared key 认证 | 请求头 `X-FocuSD-Key` | 后续 |
| `binary-v1` | 二进制附件同步（图片等） | `GET/PUT /blobs` | 后续 |

每个 extension 独立版本化，客户端通过 `GET /status` → `extensions` 字段发现可用扩展。未知扩展忽略不报错。

扩展性原则：
1. **只加不删**：已有端点/字段永不移除（v1 端点永久保留）
2. **响应加字段安全**：客户端忽略未知字段（Tolerant Reader 模式）
3. **枚举可扩展**：`type`、`error.code` 等枚举值，客户端对未知值回退默认行为
4. **版本化路径**：`/api/v1/` 允许 v2 并行运行
5. **`GET /status` 做能力协商**：启动时确定双方能力交集

---

## Part 3：实现计划

### Phase 1：协议核心（本次实现）

**`server/app.py`**：
- 新增 `GET /api/v1/sync/status`
- 新增 `GET /api/v1/sync/items?rev=`
- 新增 `PUT /api/v1/sync/items`
- 保留旧 `/sync` 端点兼容（等客户端全部迁移后废弃）
- 存储从「flat files」改为「单个 JSON 文件 + revision 计数器」：`data/todos.json` + `data/meta.json`
- LWW merge 逻辑：`if server_item.updatedAt > client_item.updatedAt → keep server`
- Gap 阈值判断：`if gap > GAP_THRESHOLD → return full`

**`src/App.tsx`**：
- 新增 `SyncItem` 类型 + 响应信封类型
- 新增 `lastRevision` localStorage key
- 改写 `pullFromServer` → `syncPull(rev)`：调 `GET /items?rev=`，解析响应信封
- 改写 `pushToServer` → `syncPush(items, baseRev)`：调 `PUT /items`，处理 conflicts
- 新增 `applyRemoteItems(remoteItems)`：合并远程 items 到本地 state + 文件
- 改 `scheduleSyncPush`：从「读全部文件」改为「收集上次 sync 后被修改的 items」
- 改启动 pull（`useEffect` line 2897）：增量拉取 + 状态合并
- 改手动 sync（`handleSyncNow`）：新流程
- 保持 `todos.md` 文件格式不变（本地持久化兼容）

**数据迁移**（自动）：
- 首次运行：`lastRevision = 0` → `GET /items`（无 rev 参数）→ 服务端返回全量
- 旧 `todos.md` 文件：首次 push 时服务端解析并创建 item

### Phase 2：后续增强

- conflicts 非空时 UI 提示用户
- 软删除垃圾回收（30 天）
- `presets-v1` extension
- HTTP 头版本协商（`Accept: application/vnd.focusd.v1+json`）
- 移动端

---

## 验证方式

1. `pnpm tauri build` 构建通过
2. 功能测试：
   - 设备 A 添加任务 → sync → 设备 B pull 能看到
   - 设备 A 和设备 B 同时编辑同一条任务 → sync → updatedAt 更新者胜出
   - 设备 A 完成任务 → sync → 设备 B 看到任务消失
3. 增量验证：两次 sync 间无变更，GET /items?rev=N 返回空 items 列表
4. Gap 阈值验证：制造 >100 条变更，服务端返回 type: "full"
5. 旧端点兼容：旧版客户端仍可调 `/sync` 正常工作
