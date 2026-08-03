# Upstream changes: packages/protocol + packages/storage

- Commits: ~25 substantive (filtering merge/chore/release) / Files: 37 new files (+4315 lines)
- All files are **net-new additions** — neither `packages/protocol` nor `packages/storage` exist in the fork.

## 核心变化

### 1. Remote Session Wire Protocol (protocol)
新增一个 **CBOR-based 二进制协议** (`PROTOCOL_VERSION = 2`)，用于远程 pi session 通信。Wire format: `[4-byte BE uint32 payload length][CBOR payload]`。协议层不绑定任何具体 transport —— 消费者只需提供一个保序字节流。支持任意帧分片和合并。

### 2. 拒绝循环值 (protocol)
CBOR 编码器通过 `ancestors: Set<object>` 在序列化时追踪祖先对象,遇到循环引用立即抛出 `CborError("CBOR values must not contain cycles")`。这是防御性安全措施——防止远程客户端发送的恶意 payload 导致无限递归。

### 3. 严格的 CBOR 子集 (protocol)
仅支持 RFC 8949 definite-length 子集。拒绝: holes/undefined 数组项、Symbol 键、非有限数、unsafe integer、tags、indefinite-length items、畸形 UTF-8、尾部数据、过深嵌套。默认限制: 16 MiB/payload、1M 容器元素、64 层深度。

### 4. SQLite Session Storage 准备发布 (storage)
`@earendil-works/pi-storage-sqlite-node` 是基于 `node:sqlite` (Node ≥22.19.0) 的完整 session 持久化后端。包含: append-only journal 式存储、materialized views、FTS5 全文搜索、branch cache、增量迁移。对外暴露 `SqliteSessionRepository` (实现 `SessionRepository` 接口) 和 `SqliteSessionSearch` (实现 `SessionSearch` 接口)。

### 5. 可组合的 Protocol Server (protocol changelog)
`feat(server): add composable protocol server` — 在 agent 包中引用 protocol schemas 构建可组合的服务端,但核心协议定义都在 protocol 包里。

## 关键文件与符号改动

### packages/protocol/ (16 源文件)

| 文件 | 关键导出 |
|---|---|
| `src/schemas.ts` (447行) | `CommandSchema` (9 种命令), `ClientMessageSchema`, `ServerMessageSchema`, `ServerEventSchema` (4 种事件), `TranscriptProgressSchema` (增量进度), `PROTOCOL_VERSION`, `SessionSnapshotSchema`, `ServerSnapshotSchema`, `ProtocolErrorSchema` (6 种错误码), `RequestEnvelopeSchema`, `ResponseEnvelopeSchema` |
| `src/codec.ts` (172行) | `encodeClientMessage()`, `encodeServerMessage()`, `ClientMessageDecoder`, `ServerMessageDecoder`, `parseClientMessage()`, `parseServerMessage()`, `isSupportedProtocolVersion()` |
| `src/framing.ts` (165行) | `FrameDecoder` (状态机: open→ended/failed), `encodeFrame()`, `FrameError` |
| `src/cbor/encoder.ts` (216行) | `encodeCbor()` — 递归编码, 含 `ancestors: Set<object>` 循环检测 |
| `src/cbor/decoder.ts` (168行) | `decodeCbor()` — `CborReader` 基于 offset 的一次性解码器 |
| `src/cbor/options.ts` (52行) | `CborOptions`, 默认限制常量, `CborError` |
| `src/cbor/index.ts` | re-export |
| `src/index.ts` | 顶层 barrel export (仅 CBOR/codec/framing/schemas 4 行) |
| `test/` | `protocol.test.ts` (368行), `framing.test.ts` (117行), `cbor/cbor.test.ts` (175行) |
| `CHANGELOG.md` | Breaking: 收紧 transcript lifecycle schemas; Added: CBOR 协议及 framing |

### 9 种命令
`list`, `create` (cwd/name/model/thinkingLevel), `attach`, `detach`, `prompt`, `steer`, `abort`, `set_model`, `set_thinking`

### 4 种 Server Events
`server_snapshot`, `session_snapshot`, `session_progress` (含 TranscriptProgress 增量), `session_removed`

### 6 种错误码
`auth`, `version`, `busy`, `session_locked`, `not_found`, `invalid_request`

### 协议消息流
```
Client → Server: ClientHello { type:"hello", version, token }
Server → Client: ServerHello { version, connectionId, snapshot: ServerSnapshotSchema }
               或 ServerHelloError { error: ProtocolErrorSchema }

Client → Server: RequestEnvelope { type:"request", id, request: CommandSchema }
Server → Client: ResponseEnvelope { type:"response", id, ok: true/false, result/error }
               EventEnvelope  { type:"event", event: ServerEventSchema }
```

### packages/storage/sqlite-node/ (7 源文件 + 迁移)

| 文件 | 关键导出 |
|---|---|
| `src/index.ts` (97行) | `wrapNodeSqliteDatabase()`, `createNodeSqliteFactory()`, re-export `./sqlite/index.ts` |
| `src/sqlite/types.ts` (47行) | `SqliteRunResult`, `SqliteStatement`, `SqliteDatabase`, `SqliteDatabaseFactory`, `SqliteSessionMetadata`, `SqliteSessionCreateOptions`, `SqliteSessionListOptions` |
| `src/sqlite/repo.ts` (327行) | `SqliteSessionRepository` 类 — `create`, `open`, `list`, `delete`, `fork`, `[Symbol.asyncDispose]` |
| `src/sqlite/storage/index.ts` (459行) | `SqliteSessionBackend` 类 — 核心存储: `create`, `open`, `list`, `delete`, `fork`; `SqliteSessionConnection` — `readEntry`, `readEntries`, `appendEntry`, `getLabel`, `getName`, `getStats`, `getLeafId`, `getActiveLeafId`; `createSessionStorageBackend()` |
| `src/sqlite/storage/sessions.ts` (40行) | `rowToMetadata()` — SQLite row → `SqliteSessionMetadata` |
| `src/sqlite/storage/session-entries.ts` (217行) | entry encode/decode, `SessionTreeEntry` 类型 |
| `src/sqlite/storage/session-materialized.ts` (355行) | materialized state 管理 |
| `src/sqlite/storage/branch-cache.ts` (326行) | `appendEntryToBranchCache()`, `repairBranchCache()`, branch 分裂逻辑 |
| `src/sqlite/storage/session-sequences.ts` (16行) | sequence 管理 |
| `src/sqlite/storage/shared.ts` (17行) | shared utilities |
| `src/sqlite/search-backend.ts` (129行) | `SqliteSessionSearch` — FTS5 trigram tokenizer, `search()` |
| `src/sqlite/migrations.ts` (55行) | migration runner |
| `src/sqlite/migrations/001_initial.sql` (59行) | sessions, session_entries, session_materialized, entry_materialized 表 |
| `src/sqlite/migrations/002_branch_tips.sql` (12行) | branch_entries, branch_tips 表 |
| `scripts/prepare-dist.mjs` (35行) | 构建后复制 SQL 迁移文件 |

### 对外 API 摘要

```ts
// 创建 SQLite session repository
import { SqliteSessionRepository } from "@earendil-works/pi-storage-sqlite-node";

const repo = new SqliteSessionRepository({
  databasePath: "./sessions.db",
  sqlite: createNodeSqliteFactory(),  // 或自定义 SqliteDatabaseFactory
  env: nodeFileSystem,                 // 实现 FileSystem 接口
  contextBuildOptions: {},
});

const session = await repo.create({ cwd: "/project", name: "my session" });
const results = await repo.list({ cwd: "/project" });
await session.appendEntry(...);
await repo.delete(metadata);
```

```ts
// 全文搜索
import { createSqliteSessionSearch } from "@earendil-works/pi-storage-sqlite-node";
const search = createSqliteSessionSearch({ databasePath, sqlite, env });
const hits = await search.search({ text: "keyword", cwd: "/project" });
```

## 新功能 / 删除的功能

- **新增**: 完整的二进制远程 session 协议栈 (schemas + CBOR + framing + codecs)
- **新增**: 基于 node:sqlite 的持久化 session storage, 含 FTS5 全文搜索
- **新增**: Branch cache (支持树形 session 分支的高效查询)
- **新增**: Materialized session views (加速 session 摘要查询)
- **无删除** — 所有文件均为新增

## Breaking / API 变化

- Protocol: `[Unreleased]` 中标记了 **Breaking Change**: 收紧 assistant/tool transcript lifecycle schemas 的状态组合和 terminal items
- Storage: 首次发布, 无向后兼容负担
- 所有 TypeBox schemas 使用 `StrictObject`, 拒绝未知属性

## 与本 fork 的重叠

**无重叠**。`packages/protocol/` 和 `packages/storage/` 在本 fork 中完全不存在。`git log --oneline 9e7fce70a..main -- packages/protocol packages/storage` 返回空。

## 合入注意点

1. **直接 cherry-pick 可行**: 两包均为新增,无冲突风险。推荐直接合入整个目录树。
2. **依赖关系**: `storage/sqlite-node` 依赖 `@earendil-works/pi-ai` 和 `@earendil-works/pi-agent-core`。合入前确保这些依赖版本匹配 (上游当前 v0.83.0)。
3. **Node 版本要求**: `storage/sqlite-node` 要求 `node >= 22.19.0`, 使用 `node:sqlite` 内置模块 (`DatabaseSync`)。如果 fork 的 Node 版本较低,需评估。
4. **TypeBox 依赖**: `protocol` 使用 `@sinclair/typebox` 做运行时 schema 校验。确认已在 dependencies 中。
5. **Protocol 是底层库**: 合入后 agent/orchestrator/tui 等包会引用 `@earendil-works/pi-protocol`。需更新这些包的类型引用 (如果有调用方已基于旧 session 接口)。
6. **存储接口对齐**: storage 实现了 `SessionRepository<SqliteSessionMetadata, ...>` 接口,该接口来自 `@earendil-works/pi-agent-core`。确保 core 包中的接口定义与 storage 实现一致。
