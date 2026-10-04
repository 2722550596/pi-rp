# 21 · 模块 G：browser sqlite worker 承载与异步桥（13-D 缺口修复）

> 契约依据：`13-D-memory与sqlite.md` §4 步骤 4 / §10 / §11.2；需求源：sefirot 阶段 2 验收（Sefirot 仓 `docs/design/需求原话.md` S25–S26 及 2026-10-04 方案拍板）。
> **2026-10-04 明月拍板（方案 A）**：worker 承载 + 异步桥；`SqliteDatabase` 同步接口保留（Node 剖面与 worker 内部原样使用），不整体异步化。
> 本模块修复 13-D 的一个验证矩阵空白：oo1 同步语义与 FTS5 均在 **Node 侧**实测（13-D §11.2「Node 可加载，实测通过」），**浏览器主线程 + opfs-sahpool 的真实打开从未实测**。sefirot 阶段 2 验收（2026-10-04）实测暴露：主线程（含 cross-origin isolated，snap Chromium 153）`FileSystemFileHandle.prototype.createSyncAccessHandle` 不存在（worker-only API），`installOpfsSAHPoolVfs` 的 feature check 在主线程必然拒绝——13-D 步骤 4 引用官方文档时只采纳了「sahpool 无需 COOP/COEP 响应头」半句，漏掉「sahpool 须在 Worker 中初始化」的完整前提。

---

## 1. 需求对照

| 效果 | 本模块达成 | 依据 |
|---|---|---|
| 浏览器主线程可打开持久 SQLite（OPFS sahpool） | worker 承载 sqlite-wasm，主线程经 RPC 代理操作 | §3/§4 |
| `SqliteDatabase` 同步接口不废（方案 A 前提） | 接口原样保留：Node 剖面照旧；worker 内部直接消费同步接口跑 oo1 | §3.1 |
| sefirot pool/state 可消费 | 冻结 `AsyncSqliteDatabase` 形状（§3.2），消费方注入 `createWorkerSqliteDatabaseFactory` | §3.2/§5 |
| 写入跨刷新持久（sefirot E33） | sahpool 在 worker 内安装成功，OPFS 文件真实落盘 | §6 |

原话关联：sefirot 需求原话 2026-10-04「好，按照方案A」= 方案 A（worker 桥）而非方案 B（接口整体异步化）。

## 2. 一句话定位

给 browser 剖面补上 sqlite 的正确运行容器：sqlite-wasm 在专用 Worker 内以同步 oo1 直跑（worker 内 `createSyncAccessHandle` 存在，sahpool 可安装），主线程拿到同形异步代理 `AsyncSqliteDatabase`；13-D 的 `SqliteDatabase`（同步）与 `createBrowserSqliteDatabaseFactory` 原样保留（内存 VFS / Node 侧仍有效），新增 worker 版工厂作为 OPFS 持久化的唯一受支持路径。

## 3. 接口契约（冻结）

### 3.1 不变项

- `SqliteDatabase` / `SqliteStatement` / `SqliteDatabaseFactory`（13-D §3.1）：**逐字不动**。
- `createBrowserSqliteDatabaseFactory` / `OPFS_SAHPoolVfs` / `BrowserSqliteDatabaseFactoryOptions`：保留；文档口径改为「oo1 直跑工厂：适用于内存 VFS 与已具备同步 OPFS 句柄的上下文（即 Worker 内部）；**主线程 OPFS 持久化请用 worker 版工厂**」。

### 3.2 新增面（`packages/memory/src/driver-browser-async.ts`）

```ts
export interface AsyncSqliteRunResult { changes: number; lastInsertRowid?: number }

/** 语句执行面：params 支持位置数组或具名对象（与同步面同语义）。 */
export interface AsyncSqliteWork {
	exec(sql: string): Promise<void>;
	run(sql: string, params?: readonly unknown[] | Record<string, unknown>): Promise<AsyncSqliteRunResult>;
	all<TRow extends object = Record<string, SqlValue>>(sql: string, params?: readonly unknown[] | Record<string, unknown>): Promise<TRow[]>;
	get<TRow extends object = Record<string, SqlValue>>(sql: string, params?: readonly unknown[] | Record<string, unknown>): Promise<TRow | undefined>;
}

export interface AsyncSqliteDatabase extends AsyncSqliteWork {
	/** worker 侧 BEGIN；fn 经同一事务会话发语句；fn resolve → COMMIT，reject → ROLLBACK。fn 内不得再开事务（tx 面不暴露 transaction）。 */
	transaction<T>(fn: (tx: AsyncSqliteWork) => Promise<T>): Promise<T>;
	close(): Promise<void>;
}

export interface AsyncSqliteDatabaseFactory {
	open(path: string): Promise<AsyncSqliteDatabase>;
}

export function createWorkerSqliteDatabaseFactory(
	options?: BrowserSqliteDatabaseFactoryOptions & {
		/** 覆盖默认 worker 入口 URL（bundler 特殊处理时显式注入）。 */
		workerUrl?: URL;
	},
): AsyncSqliteDatabaseFactory;
```

决定与理由：

- **不做 prepare 句柄化**：oo1 statement 状态驻 worker 侧需句柄表 + 生命周期管理；pool/recall 用法均一次性语句，`run/all/get` 直执行足够。省一类泄漏面。
- **transaction 以「事务会话」实现**：fn 在主线程执行，fn 内每条语句走带 `txId` 的 RPC；worker 收 `begin` 后把该 txId 的语句记入事务，收 `commit`/`rollback` 收口。
- **事务独占调度（评审 2026-10-04 冻结，防死锁）**：worker 侧收到 `begin` 后进入**事务独占模式**——在收到匹配 `txId` 的 `commit`/`rollback` 之前，请求队列**只派发该 txId 的消息**，其余请求（含其他连接请求）一律留队延后；不存在「普通请求插队到事务语句前」的调度。主线程侧 `transaction()` 用 try/finally 保证 fn 无论 resolve/reject 必发 `commit`/`rollback`；连接 `close()` 在事务悬挂时先向 worker 发 `rollback` 再 close；worker 崩溃/终止时当前事务由 worker 侧对同一连接执行 ROLLBACK 兜底（sqlite 连接关闭本身回滚未决事务，语义兜底存在）。
- **启动与崩溃错误面（评审 2026-10-04 冻结）**：①`Worker` 构造同步抛错 → `open()` 返回 rejected Promise；②worker `error` 事件或初始化阶段退出 → `open()` reject（message 含 "worker bootstrap failed"）；③`open()` 成功后 worker 崩溃/终止 → **所有 pending RPC reject（"worker terminated"）**，不做自动重连——消费方须重新 `open()`（如实声明，无静默恢复）；④`close()` 幂等（重复 close resolve）。
- **worker 文件加载**：默认 `new Worker(new URL("./driver-browser-worker.js", import.meta.url), { type: "module" })`；`options.workerUrl` 允许消费方 bundler 特殊处理时显式注入（sefirot vite 为首个验证方）。
- **错误传递**：RPC 错误序列化为 `{ message, code? }`（oo1 错误的 `code` 字段透传，如 `SQLITE_BUSY`），主线程重建为 `Error` 对象。

## 4. 文件落点

| 文件 | 职责 |
|---|---|
| `packages/memory/src/driver-browser-async.ts` | 主线程代理：工厂、RPC 客户端、请求队列、事务会话、错误重建 |
| `packages/memory/src/driver-browser-worker.ts` | worker 入口：`import { createBrowserSqliteDatabaseFactory } from "./driver-browser.ts"`，onmessage 分发，同步 `SqliteDatabase` 直跑 |
| `packages/memory/src/driver-browser-async.test.ts` | 协议/队列/事务/错误传递测试（Node vitest，内核直驱） |
| `packages/memory/package.json` | exports 增加 `"./driver-browser-async"`、`"./driver-browser-worker"`（后者供 bundler 定位 worker 入口源） |

worker 内核**不另拆 core 文件**：worker 入口直接消费现有 `createBrowserSqliteDatabaseFactory`（同步面在 worker 内可用——worker 全局有 `createSyncAccessHandle`，sahpool feature check 可过）。与 image-resize 三文件模式同构但少一层（oo1 适配已存在于 driver-browser）。

## 5. sefirot 消费侧（记录待办，实现归 sefirot 仓）

- `apps/web` 注入 `createWorkerSqliteDatabaseFactory`（vite：`optimizeDeps.exclude` 与 COI 响应头已具备，见 sefirot `apps/web/vite.config.ts` 2026-10-04 注释）。
- sefirot `packages/engine` 的 pool 层从结构化同步 `Db` 面切换到同构 `AsyncSqliteDatabase`（类型在 sefirot 侧结构化定义，不 import pi-rp，保持 engine 零重依赖）；Node 测试以 `node:sqlite` 包异步壳。
- **消费工作量如实声明（评审 2026-10-04 校正，非「换注入参数」）**：pool-store 的 DDL/迁移、upsert/listActive/markActive、embedding manifest 重建事务、recall 查询、compact 应用，全部 SQL 面需 async 化改造并保持事务语义（迁移/重建/compact 的原子性断言逐项迁移）；错误传播链（`Result`/异常）随 async 重排。Node `node:sqlite` 同步实现包一层异步壳即可复用。
- 浏览器验收闭环（sefirot E33）：真实打开 OPFS → 建表 → 写入 → 刷新读回一致。

## 6. 验证边界（诚实声明）

| 层 | 验证方式 | 位置 |
|---|---|---|
| RPC 协议/请求队列/事务会话/错误传递 | Node vitest：不经真实 Worker，主线程代理直驱 worker 内核函数（进程内双端） | 本仓 `driver-browser-async.test.ts` |
| oo1 + sahpool 在 Worker 内安装 | 真实浏览器（Worker 全局 `createSyncAccessHandle` 存在） | sefirot 阶段 2 浏览器验收 |
| OPFS 跨刷新持久 | 真实浏览器 reload 后读回 | sefirot 阶段 2 浏览器验收 |
| Node 同步面回归 | 既有 `sqlite-node`/memory 测试不回归 | 本仓 CI |

## 7. 未决项

- 无阻断项。`workerUrl` 默认值在非 vite bundler 下的可用性未验证（13-D 分发裁决 15-F 范畴），消费方可用 `options.workerUrl` 显式绕开。
