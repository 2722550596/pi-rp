# 消费路径与验证设计

## 一句话定位

以既有 `PiServer`、`pi-protocol`、Node/TypeScript `PiClient` 为唯一远程多 Session transport/client，验证新增 coding-agent `PiServerService` 通用 Host adapter 的隔离、容量与拓扑；明确 Rivet 的 callback/tree full cutover 为独立未来范围，不重画通用协议、不实现代码。

## 需求对照

依据 [`00-需求原话与效果清单.md`](./00-需求原话与效果清单.md)：

- 原话第 1、7、9 段：用户提及 NeonRP（Python）并希望比较、确认 Pi 多 Session 宿主；本设计把 NeonRP 当作候选对照，不把“改写 NeonRP”当成本次交付。对应效果 1、6、8。
- 原话第 3 段：100-agent AI Town 是开销动机，不是给定的 RSS / 时延承诺；验收要求把角色数与活跃度分开，并真实记录指标。对应效果 8。
- 原话第 4、5 段：Amio 用浏览器 harness，仅用于了解角色能力和调用频率；Rivet 可作为现有 Node 子进程拓扑/资源对照来源，但不要求本轮迁移 Rivet。对应效果 4。
- 原话第 8 段：“以后每个产品都得自己手动实现一遍”以及“不再每次都得手搓……client”：现有 PiServer/Protocol/PiClient 必须先收敛复用；验证不能把自己重写的 transport/client 当成方案。对应效果 3。
- 冻结契约已拍板：本轮 Node/TypeScript `PiClient` only（无 Python SDK、无 NeonRP 直接接入承诺）；默认文件 store 仅同机 local FS，网络/共享 FS fail closed；同 Host 仅产品审核的 trusted extensions，未知/不可信扩展用独立 Host/进程。以上是范围约束，不是待用户决策。
- Rivet callbacks/tree full cutover 为独立未来范围；Rivet 本轮保留 legacy。1/10/25/50/100 角色点只验证通用 Host adapter/topology 规模，不是 Rivet 迁移验收。
- 效果 2、4、5、7：验收 writer 与角色会话隔离、共享边界明确，业务状态及路由留在产品，保留多个 Server/进程的故障隔离拓扑。

本设计依据的是原话档效果清单与最新 `00-共同上下文.md`，不把原来“多 Session RPC”的字样解释成必须复用 legacy JSONL RPC mode。

## 消费者与职责边界

| 消费者 | 复用/验证什么 | 产品仍然拥有 | 证据与边界 |
|---|---|---|---|
| **Rivet（消费场景参照；本轮保留 legacy）** | 作为通用 Host adapter/topology 的消费者参照与未来迁移候选；本轮不要求接入、切换或证明完整 Rivet 功能迁移。 | 角色 ID 到 durable PiServer session ID 的映射、world/IP/save 与 `characters.json` 领域配置、角色选择和调度、角色文件路径/上下文权限、writer 侧业务逻辑、pass-mic 许可判断、context 选择、对玩家的 API 与授权。Pi Host 只运行通用 coding-agent Session。 | `handoff.ts:341-342` 以 `Map<string, RpcClient>` 按角色缓存进程 client；`:464-527` 每个角色建 `characterSessionFile`、独立 launch 参数并启动 RpcClient；Rivet gateway 通过 `server.mjs:1026-1031` 在进程内 host / 远端 runtime client 间选择。本轮基准不得要求改造该产品路径。 |
| **Amio（能力/调度频率参照；非 Node 成本基线）** | 盘点 writer + role Session 与偶发 side request 的边界；本轮不要求迁移到后端 Node。 | party 编排/链 A/B、输入拦截、ACK 水位、玩家和角色的 `party_msg`、@writer 的 side-request 策略及单飞/排队、角色记忆库种子与 OPFS 布局、writer 与角色关联。浏览器 UI 和 OPFS 本地引擎继续由 Amio 管。 | `writer-session.js:83-90,106-127,216-245` 装配 browser writer 和 per-save SessionManager；`:270-321` 装配独立 companion Session 与角色持久文件。`party-orchestrator.js:169-185,237-275,462-473` 管理 role runtime、side request 单飞和两层 dispose。`party-shell.ts:181-185,258-285` 的 `completeSideRequest` 是**当前 writer Session 内部**的 side request，不应误算成又一个角色 Session。浏览器 harness 单进程不能作为 Node/RSS 进程数对照。 |
| **NeonRP（Python 候选产品，不是首轮受支持消费者）** | 作为多角色 Host 价值的背景参照；不承诺直接接入。 | 游戏的 file-first 数据库/事件日志、世界与角色决策/调度、Plan→Diff→Validate→Apply、权限/审计/branch/sandbox 和它自己的 Python 产品运行时。PiServer 不是对 NeonRP 世界逻辑的替换。 | `docs/ARCHITECTURE.md:3-21,90-125,130-160`；`core/engage.py:1-13,57-69,126-145` 说明 leader 决定是否点名，engine 调度 soul backend，未点名的 soul 不思考。`pyproject.toml:1-28,32-47` 有 click、Anthropic/OpenAI、MCP、jsonschema、Pydantic、Textual 等依赖。此架构与多 Node 子进程成本不是同一测量对象；不能由 Python 语言推断无进程成本或直接宣称性能优于 Pi。 |

### Rivet 能力缺口与本轮范围

`PiServer` 已做通用 session 创建/附接/命令路由，PiClient 单连接可附接多个 session；但现有 `PiSessionRuntime` 与 protocol **不等价于** legacy coding-agent JSONL RPC。`packages/server/src/types.ts:27-60` 只定义通用 service/runtime surface；`packages/protocol/src/schemas.ts:286-324` 的命令为 list/create/attach/detach/prompt/steer/abort/set_model/set_thinking；`:400-410` 的事件是 server/session snapshot、session progress、session removal。

Rivet 角色功能中，`handoff.ts:394-435` 处理 `context_request` 并按角色白名单回作家上下文/state；`:521-525` 处理 `orchestration_request`（pass-mic）；`:661-675` 通过 `getTree()` 读取角色 leaf 并在角色回应后执行传递。Protocol v1 没有 `context_request/response`、`orchestration_request/response`、`getTree/navigateTree` 命令或等价 extension callback envelope。**这些 Rivet callbacks/tree 能力及其 full cutover 是独立未来范围，本轮明确不做**；通用 Host adapter/topology 基准不要求实现、迁移或验收它们，也不构成 Rivet 全量切换的隐性前置条件。

本轮消费路径只验证通用 coding-agent adapter 的多 Session、历史续接、普通 prompt、事件、取消、隔离和容量/拓扑。Rivet 保留 legacy JSONL RPC 路径；未来若另行启动完整 Rivet cutover，才需单独设计最小 protocol delta 与兼容策略，并验收 `context_request`、`orchestration_request`、tree navigation / branch 操作及关联 callbacks。不得将 Host 基准的通过/失败描述为 Rivet 迁移验收结论。


## 通用 Host adapter/topology 规模基准（Rivet 保留 legacy）

本轮以消费者可观察行为验证通用 Host adapter 的单/多 Session 纵切片，不复制整套 Rivet 编排，也不要求 Rivet 产品接入：

1. **拓扑**：以既有 PiServer/PiClient 栈与 coding-agent integration factory 验证一个 PiServer 承载多个独立 sessions 的能力。可验证同进程装配或经审核的 listener/transport 拓扑；不得为验证切片另建 wire protocol。此为 Host adapter/topology 场景，不是 Rivet 产品迁移任务。
2. **角色/持久化语义**：用 writer 与 N 个 characters 的通用 session fixtures 验证 durable sessions 的创建、历史恢复及隔离；产品实体映射属于消费方职责，不要求迁移 Rivet 的 `characters.json`、handoff 或存档。
3. **行为**：在真实 PiServer+PiClient+adapter 路径证明指定 Session 的 prompt、事件、取消与 reopen 行为；不包含 Rivet 专属 context/orchestration callbacks、tree 或 branch 能力。
4. **规模点**：按 §性能基准运行 1/10/25/50/100 durable characters，每点另有 1 durable writer，报告总 session 数 N+1。这是**通用 Host adapter/topology 规模基准**，不要求以 Rivet 作为被迁移消费者或完成 Rivet 全功能切换；基础切片结果不构成 Rivet 迁移结论。
5. **对照**：可以将当前 Rivet per-character RpcClient/Pi CLI 生产形态作为外部 process-topology 对照数据来源；只作拓扑/资源构型参照，不把改造旧路径、移除其 extensions 或实现产品侧 cutover 列为本轮验收。对需异构配置/高故障隔离的角色，Host 仍允许独立 PiServer 进程/组。

## 身份、存储和所有权对消费方的可见结果
- PiServer durable `sessionId` 是 client lease、route、response/snapshot 的 ID；v1 在创建时以该 ID 种入 coding-agent SessionManager，之后固定对应同一 session tree/file。缺省情况下 `createCodingAgentPiServer({ sessionStorageDir })` 的 built-in `FileCodingAgentServerSessionStore` 管理 durable ID catalog→固定 file/config，catalog root 只由这一 PiServer 进程拥有；产品存储负责角色 ID→durable ID 业务映射。产品注入 catalog 时由注入方持有/关闭该 store。内部 SessionManager ID 仅作引擎行为，不能冒充产品角色 ID。
- `PiClient` 的 shared/exclusive lease 是客户端实例内的消费所有权语义，不代替服务端持久化文件锁，也不跨多个 PiClient/进程协调。重复打开同一路径的冲突、release 和 stale owner 恢复按 lifecycle / runtime 模块设计验证。
- `PiServerService.listSessions()` 返回 durable metadata，不是产品 world/role 名册；产品仍须查询自己的角色配置。产品域的 session policy、业务权限和实体创建/删除不能被 PiServer 的 attach/detach 代管。

## 首轮 Node client / Python SDK 范围（已拍板）

**结论：本轮正式支持并验证 Node/TypeScript `PiClient` 消费路径；不交付第一方 Python SDK，也不保证 NeonRP 直接接入。** Python SDK 不作为通用 Host adapter、本轮消费证明或 1/10/25/50/100 基准的阻断项。未来若将 NeonRP 或其他 Python 产品纳入正式受支持迁移范围，应另行规划第一方 Python client/SDK 与相应 conformance 验收；不能把 protocol-only 宣称为官方 Python client 已存在。

此范围已由 `00-共同上下文.md` §2、§5 明确拍板，不再列作待用户决策。`PiClient` 是 TypeScript/JavaScript API（`client/package.json:1-5,47-50`），transport-neutral；Node/Bun Unix transport 单列在 README `:44-63`；仓库未见第一方 Python SDK。语言无关协议不等于 Python SDK。

## 所有权、副作用、错误与故障域

- **PiServer**：listener、连接、既有 protocol command routing、session runtime 获取与销毁。**coding-agent service/adapter**：每个 PiServer session 的独立 AgentSessionRuntime、snapshot/progress projection、ID→file mapping、文件 owner 和 shared-runtime lease。**PiClient**：客户端 request correlation 与 lease；客户端 disconnect/reconnect 不应直接删除 session 文件。**产品**：角色/世界调度、实体映射、业务权限、API、是否分 host / server group。
- 对一 session 的取消只作用于该 runtime；同 PiServer 内其他角色故障不得被顺带 abort。PiServer/服务进程关闭需清理本 Server 拥有的 live runtimes；shared ModelRuntime/RequestGateway 只在全部 session runtime 释放后关闭，不能被一个 Session.dispose 关闭。共享的 extension/preset/provider/global registry 风险由 runtime 文档给出具体隔离实现，本文件不假设安全（00 §4、20 owner）。
- detach/dispose 与 delete 是不同动作。当前 protocol 有 detach，没有 durable delete 命令；不能把离线 runtime disposal 解释成删除会话/角色。要删角色由产品自己的授权路径删除业务绑定/存档，后续是否要引擎 durable-delete 属于另案。
- server `PiSessionRuntime` 冲突操作按类型契约要 reject 而非 queue（`server/src/types.ts:41-52`）；AgentSession 可能有自身 queue/steer 语义。验证需确认适配层将同一 Session 并发 prompt/abort、prompt/steer映射到当前引擎行为，不得静默吞掉冲突或让客户端误以为接收成功。队列策略和 provider gate 由 20 owner 定义。
- 全 PiServer 进程是故障边界。若一组角色不能共享进程级 registry、provider、环境变量或风险域，产品应将其分组在独立 PiServer 进程；不是为所有角色分别 fork，也不是强迫所有角色进同一进程。

既有 server/client tests 证明通用协议路由，不证明 coding-agent adapter、注册隔离或特定产品迁移。不可将 `packages/server/test/sessions.test.ts:185-255` 或 `packages/client/test/sessions.test.ts:5-78` 当作本功能全部完成；也不得重复测试 generic wiring/echo。

### 1. 语义测试（adapter/runtime 级）

使用真实 coding-agent `AgentSessionRuntime` + 可控模型/provider（不依赖外网），由 PiServer 的服务 adapter 直接创建 runtime，测试下列消费者能观察到的语义：

- Writer、角色 A、角色 B 分别经既有 `PiClient` prompt，并在各自配置下解析 prompt/preset、调用可区分的工具；验证 transcript、工具调用/结果、工具权限、模型、文件、prompt slot/extension context、snapshot/progress/event 订阅都只属于目标 Session，不能只断言构造参数不同。另验证一个 Session 的工具错误、abort、dispose 不影响另一个 Session。
- A abort、发生 tool/provider error 或 dispose，B 与 writer 后续请求仍完成；A 的事件不流到 B 的 session subscribers，存储只改变 A 路径。
- v1 durable server ID 从创建到 detach/reopen 始终映射到同一 SessionManager file；同 session replacement 不在首发支持。每条可达的 `new/fork/switch/import` 扩展入口必须明确拒绝，或证明该入口不可达；语义断言验证调用可观察到拒绝、current session 仍可用且目标文件未创建/修改，避免扩展 handler 静默返回成功形状的 no-op。若未来开放 replacement，目标 claim 失败须在 source teardown/target write 前保留 source 与 target 不变，按 10 所列 preflight/reservation contract。
- detach/close runtime 后 reopen 同一 durable ID，续接预期 transcript 与固定文件，`snapshot.id` 不变；reopen 的 `snapshot.revision` 不得低于 close 前最后观察到的 revision，恢复后继续产生新 transcript 时 revision 继续前进。PiClient lease 释放不删除 history。
- 同 ID 同时 create/open 的调用收敛成 PiServer 的一个 live owner；不同 ID 但路径相同则显式 ownership conflict。验证 runtime snapshot.id 始终为 durable protocol ID，不是当前内部 SessionManager ID。
- 默认 store 的完整状态转移：root lock 获得后清理合法的 crash-left `pending` manifest/孤儿，不展示为已提交 session；`commitCreate` 将最终 model/thinking 等创建选项和 metadata 落入 `committed`，之后失败清理不得删除已提交记录或 JSONL。清理/回滚仅能作用于尚未 commit 的本次创建；损坏/无法识别的 manifest 必须 fail closed，不能猜测或删除有效记录。
- `sessionStorageDir` 是专用 root；旧 project/CLI sessions 与 legacy session-file mode 不自动迁移或导入。`updatedAt` 应从目标 JSONL 文件 mtime 计算（受文件系统时间精度约束），不能只用 manifest 写入时刻。新建 root/session directories 与其私有文件使用平台合适的 private mode/ACL；只设置本次创建的路径权限，不递归改写既有目录/文件权限。
- 每个主 prompt、side/tool request 及 nested subagent request 都保留所属 durable PiServer `sessionId` scope；各次 protocol/extension/request correlation `requestId` 按请求独立相关，不能当成 Session ID 或被错误复用。Nested subagent/tool 工作只能访问父 AgentSession 的 context、tools、abort/event scope；运行时观测到的 Gateway identity 不得仍为 `"?"`，也不能跨 Session 路由。
- 验证 command surface：支持的 prompt/steer/abort/model/thinking 命令映射行为正确；协议不支持的操作不会以 success/no-op 伪装成功。若 Rivet `navigateTree` 与 extension callbacks 要纳入迁移，等 30 doc 明确最小增量后补行为断言。
- `maxActiveRuntimes` 是正有限的内存 live runtime 上限，不是 durable role/session 总数；容量 admission 需在 `createSession` 的 catalog/JSONL 持久写之前、在 `openSession` 初始化 SessionManager 之前判定。达到 M 时 create/open 返回既有 protocol `code="busy"`、`details.reason="active_runtime_limit"`，不静默排队、不 eviction/abort 已 attached Session；已 live durable ID 的另一个 client attach 应复用现 runtime而不再占一个 slot。detach 后待 runtime dispose 实际释放 slot，已存在 durable ID 才可 reopen。语义测试同时观测 durable catalog count、live runtime count 和文件内容，证明满员拒绝无新 metadata/file 且已有 Session 可继续工作。
- assembly 初始化必须拒绝缺省、0、负数和非有限的 `maxActiveRuntimes`（provider request 上限也必须有限），且不能先启动 listener、持 store 或写 catalog；传有效正有限配置后创建 owner handle。
- Effective provider concurrency-limit acceptance (mechanism owned by 10/20) must exercise both the configured default and an explicit per-provider override using concurrent requests from separate Sessions: providers without overrides obey the default, the override applies only to its provider, and each effective cap is observed across the shared Host. Verify invalid/missing effective defaults and invalid overrides fail during assembly rather than silently becoming unbounded; testing only option forwarding is insufficient.

这些是外部可观察历史、隔离、错误和生命周期，不是注入值回显或“创建了 N 个对象”的 wiring test。

### 2. 集成测试（正式 PiServer + PiClient + adapter）

启动真实 `PiServer`（测试 listener/Unix transport）和 coding-agent service，使用**仓库现有 `PiClient`**，禁止 mock PiClient/PiServer 回显：

1. 一条现有 `PiClient` connection create writer + 2 persistent characters，分别用不同 prompt/model/tool 权限 prompt 并实际调用各自工具；通过各自 snapshot/progress、transcript/tool result、固定 session file 和 reopen 证明路由及 prompt/tool/context 隔离正确。包含 nested subagent：子请求保留父 durable session `sessionId`、独立 request correlation ID 和父 session 的工具/取消/事件 scope；另一个未 attach client 不接收该角色 progress。
2. 两个 client attach 不同 Session；关闭角色 A lease/client 时 writer 和角色 B 仍能 prompt，事件仍到正确订阅者。`createCodingAgentPiServer` 返回的 owner handle `close()` 等待 `PiServer.close()` 与全部 owned runtime/file-owner release 完成，再释放 Host coordinator、registrations、gateway 与 built-in store/storage root；若 shutdown/runtime/store close 抛错或只部分完成，不得提前释放 root lock 让第二 owner 写入，第二 assembly 仍应在 listener/catalog access 前 typed `busy/root_owned`。显式注入的 catalog/store 归调用方所有，不由 assembly 擅自关闭。
3. 建立 N 个角色 mapping 后重启 service/server，再 attach/open 相同 durable IDs；每个恢复相应历史及固定 file。对同一 Session 在 close 前后比较 protocol ID 与 snapshot revision，ID 保持相同、revision 不回退，后续追加消息的 revision 前进。损坏 catalog mapping不能误 attach 另一角色或悄悄创建空会话。
4. 验证 PiServer 服务级认证由 listener/产品 backend 拦截，PiClient connection 不能绕过产品权限读取另一 world 的 role；复用现有安全 transport/listener，不新增无认证外露端口。
5. **容量 busy 与 root lock busy 分离**：在 `maxActiveRuntimes=M` 已满时，对新 durable ID 发真实 `PiClient.createSession`，对已存在但未打开的 ID发 attach/open；两者应收到protocol `busy` + `details.reason=active_runtime_limit`，durable catalog/JSONL不变、已有附接session不受影响；对已live ID的第二个client attach仍复用其runtime。detach/dispose一个空闲Session后，对被拒ID retry成功。再让两个独立PiServer assembly/进程同时争抢同一`sessionStorageDir`，恰有一个取得root lease并接受连接，另一个启动期本地typed `busy/details.reason=root_owned`、listener未对外接受连接、catalog/file未触碰；此是local startup error，不是PiClient protocol response。用不同root的第二Host启动成功以保留多故障域部署路径。
6. **Root lock contract and OS/FS matrix**：默认 store 只接受 dedicated `sessionStorageDir` 上 Linux/macOS/Windows 的同机 durable local FS；tmpfs、overlay、remote/shared 与 unknown/unrecognized FS 均须 fail closed。锁必须是 `node:sqlite` 持有实际未提交写的 `BEGIN EXCLUSIVE` transaction，保持至正常 close 或进程死亡；空 BEGIN、stale-mtime reclaim/`proper-lockfile` 不满足契约。竞争 Host 中仅一个成功，第二个必须在 listener accept/catalog access 前 typed `busy/root_owned`；旧 owner 仍存活（含暂停/超过 stale 参考时长）不能被接管，kill 后新 Host 可恢复同 ID transcript。每个平台还必须用 OS volume/mount 类型识别证明不支持的 FS 被拒绝；路径存在/可写或 SQLite 竞争成功不能代替 FS 类型识别。当前 `.github/workflows/host-lock-platform.yml` 配置 `ubuntu-latest`、`macos-latest`、`windows-latest`，使用 Node `22.19.0` 执行 `node --experimental-strip-types --test packages/coding-agent/test/host-lock-platform.mjs`；此 focused job 不运行项目 test suite/build 或 coding-agent store integration。脚本在非 Windows runner 用 `SIGSTOP` 暂停 owner；Windows runner 只验证 owner 存活持锁、不执行进程 suspend，因此 Windows 的 paused-owner 覆盖仍缺，matrix 配置或将来跑绿都不能替代等效暂停场景及集成证明。按 OS、FS 与场景记录 runner 证据，任一平台缺项即未验收。

   **当前执行状态**：coding-agent完整测试套件301 files passed / 6 skipped（2733 tests passed / 52 skipped）；coding-agent package build、13个实现/测试文件Biome检查、shrinkwrap与install-lock一致性检查均通过。Linux WSL工作区ext4上独立root-lock process tests 2/2通过。`.github/workflows/host-lock-platform.yml` 的原生macOS/Windows runner尚未执行；Linux WSL结果不能替代原生runner证据。1/10/25/50/100 session性能基准未运行；无RSS、event-loop或拓扑收益数据。测试落点包括 `packages/coding-agent/test/server/session-store.test.ts`、`test/server/coding-agent-server.test.ts` 与 `test/host-lock-platform.mjs`。
7. **Rivet callbacks/tree full cutover**：明确不属于本轮验证或交付。只有另立未来范围时，才要求设计最小 protocol delta 并通过 `context_request`、`orchestration_request`、tree navigation及相关callbacks的端到端迁移验收。基础 Host adapter、多 Session、拓扑或容量基准的通过/失败均不代表 Rivet 功能等价或迁移完成；本轮不要求 Rivet full cutover。

整合 test 的成功断言是消费者观察到的正确 transcript、状态和恢复，不是只断言 Client 调用过 attach / service `createSession` 被调用。

### 3. 性能 / 容量基准（分开测 resident-idle 与 concurrent-active）

#### 工作负载矩阵

角色规模：**1 / 10 / 25 / 50 / 100 durable characters**；每个点另有 1 durable writer，durable catalog 总数 D=N+1。此矩阵是**通用 Host adapter/topology 规模基准**，用于验证容量及进程拓扑；不是 Rivet 迁移验收，也不要求或暗示 Rivet full cutover。每轮必须额外记录有限正数 `maxActiveRuntimes=M` 和实测内存 live runtime 数 L，且 `L ≤ M`；D 是可恢复的持久角色数，L 才是当前驻留的 AgentSession/PiSessionRuntime 数。二者不得统称“active agents”。

- **Resident-idle**：先顺序创建 D 个 durable session/file，并在每次 create 后 detach/dispose、确认 live slot 已释放，再创建下一个；如此持久化记录数可大于 M 而不会同时装载 D 个 runtime。随后在 idle 窗口内没有 prompt、LLM request 或 side request，只 attach/open 至 M 许可的 L 个 runtime，让其处于 idle；其余 D−L（若为正）仍是 durable catalog/file，但不在 memory。若要测 D 个同时 resident，测试配置明确设置有限 M≥D，并报告该值；不能因为存在 100 个 JSONL 就说 100 个 runtime 常驻。记录 idle disposal 后 L 下降、相同 ID reopen 和资源释放。
- **Concurrently-active**：对 N 个角色提交同一受控任务并单列 writer 流量；全角色并发场景的配置需 M≥D（M 仍有限、逐次记录），保证所有目标角色确实 resident 并在途。另测 cap-bound 子场景 M<D：只对已有 L≤M runtime 提交任务，额外 open/create 请求应 busy 而非后台无限排队；记提交、被 admission 拒绝、provider in-flight 与排队的不同数值。需要 K<N 活跃角色时明确 K 与 D，不从 resident-idle 推导并发结果。

#### 对照和采样条件

每个负载点可报告当前 Rivet per-character RpcClient/Pi CLI 作为外部拓扑/资源对照，但对照不构成 Rivet 迁移或切换验收，也不要求本轮改造 Rivet 产品。
Provider/API 网络波动不作为 Node 内存/调度指标。主要可重复基准用 deterministic local/fake provider（延迟和 token 数固定/报告），记录 queue 与 fake service time；另可在配额/风险允许时跑真实 provider，标明网络、provider 限流与价格，不与 synthetic 数据混平均。
冷测/热测分开；预先写明 warmup 次数、重复次数、样本数、环境、Node 版本、启动命令、角色资源版本与数据路径；给出原始观测点、分布（至少 median 与尾部分位数）和误差/失败，而不是单个最佳值。
通用单 Host 证明拓扑要求 engine Pi OS process 数不随 N 线性增加，期望是固定一个 PiServer hosting process；隔离对照允许按消费方选择多 PiServer process。性能指标不设置未测的“<10ms”“降 60%”目标。

#### 必须报告的指标

| 分类 | 记录指标 |
|---|---|
| 进程/启动 | Pi engine OS process count（与 gateway 分列）；host/server 冷启动时延；单 Session create、open/reopen、dispose 时延；角色 N 扩大后的新增启动成本。 |
| 内存/CPU | 全进程 RSS 与 heap（idle/active 分开、总量及每 Session 派生量）；CPU 使用/峰值；如可用记录 GC pause/count；报告计算口径，不能将 heap 单独冒充总内存。 |
| Event loop | Node event loop lag/delay 的分位数与最大观察值；采样窗口、活动流压力和测量工具。 |
| Scheduler/provider | 入队时间、provider permit 等待、in-flight 数、排队长度、饥饿/拒绝/超时数、prompt 到首输出与总回合时延；共享 RequestGateway 的跨 session identity 与限流有效性。 |
| Capacity/root ownership | durable catalog D、active runtime 数 L、配置上限 M、create/open busy 次数与 reason、拒绝前后 JSONL/catalog hash、detach/dispose 释放 slot 时延；PiServer assembly root lease owner/拒绝、stale recovery 时间、compromised fail-closed 和 listener 是否接受连接。 |
| 正确性 | 完成/失败/取消总数、跨 Session 串路由/串文件计数、server restart 后 resume 成功数、extension/tool error、progress/event 丢失数。错误不能从性能聚合里被剔除。 |
| RPC/连接 | PiClient 连接数、attach Session 数、socket/transport bytes、事件队列/backpressure；若自定义 listener，记录排队上限/溢出和 close 状态。 |

#### 可证伪的基准验收

- 在 N=1/10/25/50/100 每个点分别记录 durable `D=N+1`、正有限 configured `M=maxActiveRuntimes` 和实测 live runtime `L`，验 `L≤M`。Resident-idle 报 `D` 与 `L` 两个数；全角色 concurrent-active 仅在 M≥D 的明确配置下可宣称，M<D 则须展示超额 open/create 的 busy admission，不能声称所有角色同时运行。
- 达到M后，新durable create和现存durable reopen都以`busy/details.reason=active_runtime_limit`在catalog/JSONL持久写之前失败；attached Session不被eviction或abort；拒绝不造orphan entry/file。detach+dispose释放的slot允许原durable ID reopen。任一断言不成立即失败。
- 同一 storage root 上任意两个 PiServer assembly / 进程最多一个 writer owner；第二个 host 必须在 listener 接收请求前本地返回 typed `code="busy"`、`details.reason="root_owned"`，且不触碰记录。独立 root 可以同时运行，保留故障隔离 escape hatch。
- 强杀 root owner 后能否安全恢复并未由proper-lockfile旧state-lock行为证明。源码事实仅是直接依赖 `packages/coding-agent/package.json:64`；既有状态锁在 `packages/agent/src/harness/env/nodejs-storage.ts:16-22,173-194` 用 stale=30s并提供 `onCompromised`，proper-lockfile 以 lock mtime stale reclaim 的实现路径见 `proper-lockfile/lib/lockfile.js:30-67`。这只能作为state-lock现状/机制研究参考，30s不是session root lease recovery SLA，有限mtime stale reclaim和事后 `onCompromised` 都不是原子fencing；paused旧owner恢复后可能继续写。Root crash recovery在选定并验证进程生命周期OS级不可窃取锁，或每次catalog及SessionManager JSONL写都强制fencing token之前，一律标为实现 blocker；必须列明OS/filesystem支持边界与不支持时fail-closed，不能默默假定root lock安全。
- 在 N=1/10/25/50/100 的固定拓扑记录下，PiServer hosted configuration 中 engine Pi OS process 数保持一个，不因每个角色启动一个 Pi CLI；每一轮都校验进程数，不满足即失败。基线记录原有 per-character process count。此为设计拓扑可观察验收，不是内存改善结论。
- 同一 matrix 下若 Session A prompt/abort/failure/dispose 导致 B history/event/active state 改变，容量测试直接判失败，不允许把串线作为“压力下偶发”。
- 每种负载结果均须附原始指标。若单 server 增加 event-loop lag、超时、内存或请求等待，不得只凭进程少宣称优化成功；也不得在没有测量前设数值目标或宣称一定更快/省内存。
- Resident-idle 与 concurrent-active 均报告 1/10/25/50/100 durable role 五点、D/L/M、process-isolated 对照。缺任一点、漏报 live cap、把 durable count 当 resident runtime、将 idle 100 外推为 active 100，基准不完整。
- provider concurrency 与 admission cap 分别配置/报告；provider gate 排队不是 runtime admission 队列。若因 provider limit 排队，admitted 请求最终完成/按明确定义超时；runtime cap 外的新 open/create 不进等待队列。

#### 当前基准/测试基础的限制

- `scripts/profile-coding-agent-node.mjs:18-47` 当前 profiling CLI 是单 coding-agent TUI/RPC startup；RPC 测到首个真实 `get_state` response 即退出，不包含多 Session residency/并发/进程数比较，不能当本基准结果。
- 当前 `packages/server/test/sessions.test.ts:185-255` 验证同连接独立 attach 与 event fan-out；`packages/client/test/sessions.test.ts:5-78` 验证多 handle lease/detach。这些证明 generic stack，不包含 coding-agent runtime，也不是 1–100 role performance benchmark。
- Rivet `services/gateway/session-host.mjs:28-40` 当前 `maxSessions` 缺省 16 并带 idle timeout；每角色 Pi 子进程规模基线来自 `handoff.ts:464-515`。新 adapter 的 active-session 配额不能沿用“单个 child per role”计数而不区分一个 server 内的角色 Session；容量配置由 Host/adapter 负责，不改变 Rivet 产品业务配额。
- 跨平台 root-lock runner 结果属于安全/存储验收证据，不是性能 benchmark；应分开报告各OS/FS上的SQLite实际写事务竞争、paused-owner、kill/recovery及fail-closed rejection状态，不能用锁测试代替benchmark原始数据。

## 已落地实现与消费路径验证

- **Pi coding-agent Host adapter/service**：`packages/coding-agent/src/server/coding-agent-server.ts` 已用既有 `PiServerService` / `PiSessionRuntime` 装配 `ModelRuntime`、共享有限 `RequestGateway`、per-session `AgentSessionScope` 与 active runtime admission；Node/TypeScript `PiClient` 的真实 create/prompt/detach/reopen路径由 adapter integration test覆盖。
- **Durable ID/file owner**：`FileCodingAgentServerSessionStore` 与 host-root SQLite process lock、FS fail-closed识别、权限隔离和pending-create lifecycle已在 `packages/coding-agent/src/server/` 实现；实际验证状态与OS限制见本节当前执行状态。旧 project sessions/legacy session-file不迁移。
- **Scope / subagent**：每个顶层 Session独立prompt/provider scope；subagent用fresh child scope，parent selected prompt先在parent scope编译，再传递messages，不共享parent registry或renderer closure。Raw pi-ai compat global mutation不是supported extension contract。
- **性能基准**：N=1/10/25/50/100与D/L/M计划仍待执行；不新增通用session registry或`HostSession` public client，也不据源码实现宣称性能提升。
- **PiServer protocol/client gap**：由 `30-existing-server-client-integration.md` 建 capability matrix 并提最小差异。本模块记录未来 Rivet callbacks/tree full cutover 所需能力，不复制其 wire schema；该 cutover 不属于本轮。
- **Rivet 入口（未来 consumer/cutover 范围）**：`worldlines-rivet/.pi/extensions/handoff.ts:464-527` 当前 getCharacter 的进程创建和池；Gateway `services/gateway/server.mjs:1018-1031` 选择 host，`services/gateway/runtime-client.mjs:1-21` 定义远端 client 语义。仅作消费场景与可能对照；本轮不改该路径，不要求角色 ID→PiClient lease 切换。
- **Amio 对照**：`amio/apps/web/src/local/writer-session.js:216-245,270-321` 和 `apps/web/src/orchestrator/party-orchestrator.js:169-185,237-275,462-473` 是角色装配/编排观察位置；不将 browser OPFS backend 作为 Node service adapter。
- **NeonRP 对照**：`NeonRP/docs/ARCHITECTURE.md:90-160`、`src/neonrp/core/engage.py:1-13,57-69` 与 `pyproject.toml:1-47` 支持产品边界/依赖分析；无当前 NeonRP→Pi client 接线，本轮不交付 Python SDK、不承诺受支持的直接接入。

## 与当前状态差异

- Generic PiServer/Protocol/PiClient、多 Session lease、session 路由和 progress/snapshot 已存在；这不是待实现任务，且不应再设计重复 client/RPC。
- Rivet 的传统 JSONL RPC extension callbacks/tree commands 不在 protocol v1 的通用 commands/events 内；这些 callbacks/tree full cutover 为本轮不做的独立未来范围，不能成为本轮 Host adapter/topology 基准或交付的隐性必须项。
- PiClient 是可复用的 TypeScript/JavaScript 客户端且 transport-neutral；本轮首个消费路径为 Node/TypeScript，不交付 Python SDK、不保证 NeonRP 直接接入。这是已拍板范围，不是待决项。
- 默认store使用独立dedicated `sessionStorageDir` root；仅支持同机 durable local FS。tmpfs/overlay/remote/shared/unknown FS fail closed。锁契约为 `node:sqlite` 进程生命周期 `BEGIN EXCLUSIVE` 实际未提交写，正常close/进程死亡才释放，不得stale-mtime reclaim。CI已定义Ubuntu/macOS/Windows matrix；本地WSL工作区ext4 process-lock tests 2/2通过，但三平台CI均未执行、没有native macOS/Windows evidence。
- Store/security测试覆盖private root及session paths、真实SQLite未提交写、单root第二owner拒绝、paused live owner不可接管、kill/reopen恢复及unsupported filesystem fail-closed；Linux WSL工作区ext4运行`test/host-lock-platform.mjs`通过2/2。`.github/workflows/host-lock-platform.yml`已有Ubuntu/macOS/Windows matrix但未触发，本机无native macOS/Windows结果。仍需CI执行三平台后，才能宣称跨平台lock验收闭环；`packages/coding-agent/test/server/session-store.test.ts`、`test/server/coding-agent-server.test.ts`和`test/host-lock-platform.mjs`为相关实际测试。
- 当前Pi-rp profile script作用是single-process startup profile；完整coding-agent tests/build已通过，但无本feature可引用的1–100 Session性能数据，不能推导任何measured performance target。
- `packages/server` README 标为 experimental 且当前无 coding-agent service；具体稳定性与兼容版本仍由 package owner 确认。本轮不以宣称 Rivet 已可复用/已迁移为验收目标。

## 已拍板边界（不再列为待用户决策）

- 本轮首个正式消费路径是 Node/TypeScript `PiClient`；不交付 Python SDK、不保证 NeonRP 直接接入。未来 Python 消费者范围另行决定并需相应官方 client。
- 默认文件 store 仅支持同机 local FS；共享/网络 FS 不支持并必须 fail closed。
- 同一 Host 只加载产品审核的 trusted extension set；未知/不可信扩展必须使用独立 Host/进程。
- Rivet callbacks/tree full cutover（`context_request`、`orchestration_request`、tree navigation / branch 与相关 callbacks）为独立未来范围，本轮不做；Rivet 保留 legacy 路径。1/10/25/50/100 是通用 Host adapter/topology 规模基准，不是 Rivet 迁移验收或隐含切换要求。

## 仍未知 / 待拍板

- Rivet 未来若启动 callbacks/tree full cutover，需另行确定最小 protocol delta、兼容策略及端到端验收范围。
- Rivet 最小 proof 的交付环境不适用于本轮验收；未来若启动产品迁移，Gateway 与 PiServer 同进程装配、同机 Unix socket 或独立 PiServer 进程由该范围的部署设计决定。
- 性能阈值暂无用户给出的数值。先采集相同机器与负载的双拓扑基线，再由需求/运营方根据实测 SLA 拍板；本设计不把旧 high-concurrency plan 的 `<10ms` 或 `60%` 内存收益继承为目标。
- `packages/server` experimental 状态、PiClient/Protocol 发布稳定性与兼容版本策略需由 package owner 定；不应 pin 未发布/无兼容承诺的实验接口作为生产合同。
