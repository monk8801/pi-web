# 任务列表（待办）设计

状态：已评审待实现 · 2026-11-02 · 目标分支 `dev`

## 1. 目标

在 Pi Web 里维护一份**人工记录**的待办清单：

- 每条待办归属一个项目（cwd）。
- 状态可标记，未开始 / 进行中 / 待确认 / 已完成，由数据与实时会话状态派生。
- **点击待办即开始执行**：在该项目下新建 pi 会话，把任务内容作为首条提示发出，直接开跑。
- 跑完后支持自动标记已完成（agent 显式宣告），判定不了时退回人工确认。

## 2. 非目标

- 不做 pi-tasks 那种「会话内 agent 执行契约」。`pi-tasks` 以 `appendEntry(TASK_EVENT_CUSTOM_TYPE, …)` 写入当前会话分支、靠 `ctx.sessionManager.getBranch()` 重放（`pi-tasks/dist/src/store.js:16`、`index.js:11`），跨会话不可见，不适合长期人工清单。
- 不做定时提醒、定时启动、优先级、标签、子任务、多用户协作。
- 不改 pi 本身的行为、不新增 `ctx.ui.*` 选项、不新增 `extension_ui_request` 字段。
- 不改侧栏 tab 结构（仍是 Sessions | Files）。

## 3. 已定决策

| 编号 | 决策 | 结论 |
|---|---|---|
| D1 | 定位 | 人工待办清单，关联项目，可开跑 |
| D2 | 自动完成判定 | 方案 D：agent 显式宣告 → 自动完成；否则退回「待确认」由人点确认 |
| D3 | 实现路线 | 方案 A：Pi Web 自有 JSON 存储 + 内置 `todo_complete` 扩展 |
| D4 | 点击行 | 点击即开始执行（已有会话正在跑时打开该会话，不重复启动） |
| D5 | 状态集 | 待开始 / 进行中 / 待确认 / 已完成；无「取消」，不要即删除 |
| D6 | 入口 | 侧栏 footer 新增一行「待办 · N」，与 `Open another project…` / `Archived` 并列 |

### 与 CONTRIBUTING 的偏离（本项目 fork 内接受）

`CONTRIBUTING.md` 第 17/18/20 行把「可做成 pi 扩展的功能」「Pi Web 独有的配置文件」「新子系统」列为 out of scope。方案 A 三项均触及，因此**上游 PR 不会接受**，本设计只在本 fork（`monk8801/pi-web`）内成立。若将来要提上游，需要改走方案 B（独立 `pi-todos` 扩展拥有数据、Pi Web 只渲染）。

## 4. 数据

文件：`~/.pi/agent/pi-web-todos.json`（`getAgentDir()` 拼接，与 mcp.json / settings.json 同级）。

```json
{
  "version": 1,
  "todos": [
    {
      "id": "a1b2c3d4",
      "title": "支持导出会话为 CSV",
      "note": "可选的多行描述",
      "project": "/abs/path/to/cwd",
      "sessionId": "01a19c04-…",
      "createdAt": "2026-11-02T03:12:00.000Z",
      "updatedAt": "2026-11-02T03:12:00.000Z",
      "doneAt": "2026-11-02T04:00:00.000Z",
      "doneBy": "agent"
    }
  ]
}
```

- `id`：8 位十六进制（与 `session-ui-state.json` 的 key 风格一致），由服务器生成，客户端只读。
- `project`：绝对路径，用 `/api/cwd/validate` 与 `lib/worktree.ts` 的既有口径解析，不存别名。
- `note`、`sessionId`、`doneAt`、`doneBy` 可选。

**只持久化 `open` / `done` 两态。** 展示态一律派生，避免陈旧状态被写回：

| 展示态 | 派生条件 |
|---|---|
| 待开始 | 无 `sessionId` |
| 进行中 | 有 `sessionId`，且该 id 在 `/api/agent/running` 的 running 集合里 |
| 待确认 | 有 `sessionId`，会话不在 running 集合，且 `status === "open"`（含会话已被删除的情况） |
| 已完成 | `status === "done"` |

**写入**：复用 `lib/session-ui-state.ts` 的机制 —— 跨进程锁（`key-serializer` / 文件锁）、原子写（临时文件 + rename）、`revision` 单调递增、坏文件自动备份为 `*.corrupt-<ts>` 后按空列表处理。客户端用 revision 做乐观并发（同 `useSessionUiState`）。

## 5. 接口

新建 `app/api/todos/route.ts`：

- `GET /api/todos` → `{ todos: Todo[], revision: number }`
- `POST /api/todos`，body `{ action, revision?, … }`：
  - `add`：`{ title, note?, project }`
  - `update`：`{ id, title?, note?, project? }`
  - `complete`：`{ id }` → `done`、`doneBy: "user"`、`doneAt`
  - `reopen`：`{ id }` → `open`，清 `doneAt` / `doneBy`
  - `delete`：`{ id }`
  - `start`：`{ id }` → 见第 6 节，返回 `{ sessionId }`

参数校验失败返回 400（与 `/api/mcp`、`/api/sessions/ui-state` 的既有风格一致）；`revision` 不匹配返回 409 并带上最新 revision。

## 6. 开跑与完成信号

### 6.1 开跑（服务端一步完成）

`POST /api/todos { action: "start", id }` 在服务端依次执行：

1. 读待办，校验 `project` 存在（不存在 → 复用 `lib/missing-cwd.ts` 的 `cwd-missing` 语义拒绝，前端把该行置灰）。
2. `startRpcSession(tempKey, "", todo.project, { todo: { id } })`（选项名示意，实现时以 `lib/rpc-manager.ts` 的既有参数风格为准），与 `app/api/agent/new/route.ts` 完全同一条路径（`allowFileRoot` / `invalidateSessionListCache` 一并执行）。
3. 发送首条 prompt：

   ```
   处理这个待办：

   <title>

   <note，若有>

   完成后调用 todo_complete。
   ```

4. 写回 `sessionId` 与 `updatedAt`，返回 `{ sessionId }`。
5. 客户端收到后直接以 `?session=<sessionId>` 打开该会话。

**已存在会话时**：若 `sessionId` 对应会话仍在 running 集合 → 直接返回该 id（打开它，不重复启动）；否则视为新一轮执行，新建会话并覆盖 `sessionId`。旧会话仍留在侧栏，可从会话列表回溯。

### 6.2 完成信号（方案 D）

- 新内置扩展 `createTodoCompleteExtension({ todoId })`，在 `lib/builtin-extensions.ts` 的 `createPiWebBuiltinExtensions` 增加可选参数并在任务会话里注入。它对**每个待办会话**单独构造，`todoId` 闭包带入，工具 `todo_complete` **无入参**，直接写 store：`done` / `doneBy: "agent"` / `doneAt`。
- 因为工具由该会话专属扩展注册，**不进入 `toolNames` 白名单**，不会把用户的工具预设钉死。
- 未调用工具：会话一轮结束（离开 running 集合）即派生为「待确认」，人点 ✓ → `action: "complete"`（`doneBy: "user"`）。

## 7. UI

- **入口**：侧栏 footer 新增一行「待办 · N」（`components/SessionSidebar.tsx` 的 footer 行组，`lib/session-tree.ts` 新增一种 row kind，例如 `footer-todos`，沿用 `SIDEBAR_ROW_HEIGHTS` 的统一行高）。
- **面板**：右栏 `TabBar` 新增第四类 kind `todo`（`components/TabBar.tsx` 现有 `terminal / agent / side`），组件 `components/TodoPanel.tsx`：按项目分组（组名取项目显示名），未完成在前、已完成沉到组底并折叠。
- **行**：状态圆点 + 标题 + 右端（进行中显示 spinner、待确认显示待确认点、已完成显示完成时间）+ `⋯` 菜单（编辑 / 标记完成 / 重开 / 删除）。**点击行 = 开跑**（D4）。
- **新建**：面板顶部输入框，回车即 `add`，`project` 取当前会话的 cwd，没有当前会话时取侧栏当前项目。
- **状态来源**：`GET /api/todos` + 既有 `GET /api/agent/running` 轮询（`AppShell` 已有），不新增轮询通道。
- 文案：新增 key 同时补 `en` / `zh-CN` / `zh-TW`（`docs/i18n.md`）。

## 8. 错误处理

| 情况 | 行为 |
|---|---|
| `pi-web-todos.json` 损坏 | 备份为 `*.corrupt-<ts>`，按空列表继续，面板顶部提示一次 |
| `project` 目录已不存在 | 行置灰、开跑禁用，hover 说明原因（`cwd-missing`） |
| 会话被删除 | `sessionId` 视为失效 → 回落「待确认」，点击可再次开跑 |
| 并发写 | 锁 + revision；409 时前端刷新后重试，不静默覆盖 |
| 开跑失败（启动报错） | 待办保持 `open`，用现有 `SidebarToast` 报错 |
| `todo_complete` 被调用但待办已删除/已完成 | 工具返回可读错误，不抛异常 |

## 9. 测试

- `lib/todos.test.mjs`：add/update/complete/reopen/delete、revision 单调、坏文件备份、四态派生（含会话已删、running 边界）。
- `app/api/todos/route.test.mjs`：参数校验、`start` 写回 sessionId、running 时返回既有 id、缺 cwd 拒绝、409 语义。
- `lib/builtin-extensions.test.mjs`（或新增 `todo-complete-extension.test.mjs`）：工具注册、落盘字段、重复调用幂等。
- `components/TodoPanel.test.mjs`：分组顺序、已完成折叠、点击行触发 start、置灰禁用。
- 收尾：`npm test`、`node_modules/.bin/tsc --noEmit`、`npm run lint`。

## 10. 文档

- 实现落地时新增 `docs/agents/todos.md`，并在 `AGENTS.md` 的 topic notes 列表与文件地图里登记（`lib/todos*.ts`、`app/api/todos/**`、`components/TodoPanel.tsx`、内置扩展条目）。
- 本文件是设计记录，落地后由 `docs/agents/todos.md` 取代长期维护。

## 11. 风险

| 风险 | 缓解 |
|---|---|
| 内置扩展与 chat-only / 子代理 / 工具预设的交互出错 | 扩展只在任务会话注入；单测覆盖 chat-only 与子代理不加载它的路径 |
| 一次点击发起多个会话 | `start` 服务端串行 + running 判重（6.1） |
| 数据文件成为 Pi Web 私有的第二份状态源 | 接受（fork 内决策），文档明确记录偏离 CONTRIBUTING 的哪几条 |
| 待确认态依赖 running 轮询，空档期内可能短暂显示错态 | 派生逻辑幂等、无写回，最多一次轮询间隔的不一致 |
