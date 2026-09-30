# PostgreSQL SessionRepo backend — 实施设计

## 需求原文

> 你去整理一下文档写了这么多，设计想了这么多，至今有哪些基建是pi-rp目前还没做到但理论上应该归于它，给它补上的

## 效果与范围

- 为 pi-rp 已有的 `SessionRepo` 契约提供可直接复用的 PostgreSQL 实现；session 的 entry、record、lane、facts、branch projection 和 writer lease 都可由 PostgreSQL 权威保存。
- 不把 ludenia 的 `tenant_id`、角色 profile、diary、footprint、life jobs、HTTP/gateway API 纳入 pi-rp backend。身份授权由调用应用负责；本 backend 只以 session id 做隔离，不能冒称多租户授权层。
- 不改 legacy `coding-agent` 的 JSONL `SessionManager`，不导入历史 JSONL、不双写、不加 JSONL fallback。其 SessionManager 与 `packages/agent` 的新 `SessionRepo` 是两套不同 API；不应为了让 PostgreSQL package “看起来接通”而做全仓会话架构重写。
- 复用 `@earendil-works/pi-agent-core` 的 `SessionRepo`、SQLite 实现已经验证的 repository 语义及 agent-core 导出的 backend conformance cases。

## 代码落点

新增 `packages/session-backends/postgres/`，沿用 `sqlite-node` 包的 workspace 结构：`src/index.ts`、`src/postgres/{repo.ts,types.ts,migrations/001_initial.sql}`、`test/{conformance.test.ts,repository.test.ts,writer-leases.test.ts,lifecycle-concurrency.test.ts,test-utils.ts}`、README、CHANGELOG、package metadata、build config。包公开 `PostgresSessionRepository`、metadata/options 类型及关闭资源的方法；不暴露业务 SQL。

连接通过调用方已配置的 `pg` `Pool` 注入：`new PostgresSessionRepository({ pool })`。repository 使用 Pool，但不拥有/关闭外部 Pool；调用方负责整个 Pool 生命周期。该边界复用应用共享连接池，不复制凭据配置、连接策略或 pool 管理。

## 关系模型

所有表必须位于固定独立 PostgreSQL schema `pi_session`，不得使用 `public`；初始化按需创建 schema。这样避免 `sessions`、`entries` 等通用表名与平台业务表冲突。SQL 对 schema/table 标识符采用固定常量并正确 quote，不接受调用方提供的任意 schema 名。调用方 Pool 用户须有该 schema 的建表/读写权限。

以 `session_id` 隔离数据，使用 relational columns 保存排序与关系；任意 entry/record 内容按既有 SQLite backend 规则序列化成 JSONB payload。表模型对应 SQLite 的 canonical data 与 projections：

- `sessions`：id、created_at、cwd、parent_session_id、metadata、project_id。
- `session_sequences`：每个 session 一个 `next_seq`，所有 entry/record/lane/fact mutation 共享严格递增序列。
- `entries`：session/id 主键，session/seq 唯一，parent/type/time/payload。
- `session_stats`：`SessionStats` 当前投影；与 SQLite 的更新语义一致。
- `lanes`、`records`、`lane_moves`、`facts`、`branch_entries`、`branch_tips`：字段及唯一/普通索引与 SQLite 001 schema 对应。entries 的父子关系为 canonical；`branch_entries`、`branch_tips` 是可由 canonical log 恢复的优化投影。
- `writer_leases`：session 唯一 writer claim，owner、单调 fence、expires_at。失效 owner 每次写操作均须被数据库拒绝，不能只在进程内检查。

外键使用 session_id 引用 sessions；一般单次写入使用短事务。fork 是例外：必须以一个原子数据库事务完成，但通过 PostgreSQL 内部 INSERT…SELECT/CTE 做集合复制，避免将全量 entry/payload 搬进 Node；它的数据库执行时长仍可能随被 fork 的 session 大小增长。共享 sequence 由锁定该 session 的 sequence 行分配，禁止进程内计数器、`MAX(seq)+1` 或仅靠客户端时钟。

## 行为与事务不变量

1. `create/open/list/delete/fork` 与 `SessionRepo`/SQLite 行为一致；metadata 序列化、错误码、返回顺序一致。
2. append entry/record、lane create/move、fact set、branch projection 更新在同事务里完成；失败时没有 sequence 缺口对应的部分副作用，也没有 projection/canonical state 分叉。
3. ID 冲突返回相同 `SessionError` code；无效查询在空结果集上也拒绝；payload 解码错误按既有 backend 契约映射。
4. `findEntries`、`findRecords`、`getLog`、branch reads 和 list 使用稳定排序、数据库端过滤与 limit/cursor，不把全 session 拉入 Node heap。branch path 查询在 SQL 侧沿 parent 关系完成，并严格遵守起止、顺序、limit 语义。
5. `fork` 复制/引用策略与共享 conformance cases 对齐：正确分支 parent、facts/metadata、lane/leaf 语义，不得因 SQL 查询顺序产生不确定结果。
6. Writer lease 竞争通过事务锁和 fencing token 原子协调。租约过期时才允许新 owner 接管并增加 fence；旧 owner append/fact/lane 写入均拒绝。lease 的 wall clock 仅用于 expiry，不用于顺序分配。
7. 事务提交错误可能结果未知；repo 不伪造成功。相同 ID 重试最多保证不会重复写入，若原提交已成功则返回 `already_exists`，不代表可恢复原操作结果；当前契约没有通用 ID 对账 API。上层必须把此类情况视为待对账错误，不得把 ID 冲突当作成功确认。若要支持透明重试，应先扩展契约并设计相同 ID、不同 payload 的冲突判定，不在本 backend 暗中实现。

## 驱动、schema 与迁移

- 依赖 `pg`，作为 Node-only package，engines 与当前 workspace 基线一致（`>=22.19.0`）；不要求 SQLite node binding。
- migrations 按版本表记录并在事务中串行执行；同一数据库可多 repository 并发启动，迁移锁须用 PostgreSQL advisory lock 或等价原子机制；不得将已应用 migration 静默重跑。
- schema migration 是程序 schema 建立/升级，不是 JSONL session 数据迁移。初次安装从空数据库开始；没有 JSONL reader/importer/dual-write。
- 生产测试通过 `PI_TEST_DATABASE_URL` 连接真实 PostgreSQL；未配置时不得把 mock 当成 DB 集成验证。unit-level SQL/codec tests 可纯进程运行，backend conformance 与并发/fencing tests 必须在真实 PostgreSQL 执行。

## 设计验证清单

- 全量 `createSessionBackendConformance` 通过。
- PostgreSQL 专项测试覆盖跨 repository reopen、并发 sequence/duplicate ID、共享 facts/tombstone fork、metadata invalid_payload、真实 `public.sessions` 哨兵隔离、writer fencing、fork snapshot 与 close/drain 生命周期，并清理测试会话。
- 有界查询回归测试将较早 entry payload 损坏，再通过限量 findEntries/getLog/branch reads 读取较新数据，证明被 SQL 边界排除的行不会在 Node 侧解码；unbounded read 明确报 invalid_entry。
- 本地真实 PostgreSQL smoke：建空库 → migrate → create/append/reopen/read/fork/delete → 关闭 repository 后连接池仍由调用方管理；关闭 Pool 后进程可退出。

## 不属于本次实现

- coding-agent legacy SessionManager 改造；其大量现有 consumer 直接依赖同步 `SessionManager` API，不是添加 PostgreSQL repository 就能替换。
- SaaS tenant authorization/RLS、角色业务数据、diary/footprint/life-state、对象存储、平台备份/导出策略。
- JSONL 历史导入、旧档兼容与性能承诺。PostgreSQL 不自动保证长会话快速；只保证实现数据库端有界读取，实际 heap/latency 门槛需产品真实 workload 测量。
