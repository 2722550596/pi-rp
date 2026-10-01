# 20 — Shared Runtime、Session 隔离与并发设计

> 本文遵循 [`00-共同上下文.md`](./00-共同上下文.md)（本次校订重读版本 `E11A`）与 [`00-需求原话与效果清单.md`](./00-需求原话与效果清单.md)。它只设计 coding-agent adapter 的共享运行时与隔离缺口；不重画既有 PiServer/Protocol/PiClient，不定义第二个 RPC/client，也不实现源码。

## 一句话定位

在每个 coding-agent Host 内只共享一个明确配置的 `ModelRuntime`、一个 host-scoped `RequestGateway` 及经 owner 治理的不可变资源；AgentSession、settings、扩展执行上下文、prompt registry、memory closures、工具、持久化和取消逐 Session 所有。只有受支持的 scoped registry ownership 与 trusted-extension 边界落实后才可声称隔离成立；raw pi-ai/process-global mutation 不在该边界内。

## 需求对照

依据 `00-需求原话与效果清单.md`：

- 原话第 3–5 段提出 100-agent 扩展动机，并指出 Rivet 是 Node 进程基线、Amio 仅作 Agent/side-request 参考（原话档 `:11-15`）。本设计区分 idle/active 负载与运行时所有权，不把 Amio 浏览器实例当成本参照，也不承诺未经测量的内存/延迟收益。对应效果 1、6、8（`:31-38`）。
- 原话第 6–9 段确认需要明确多 Session 宿主且产品不应重复手搓 client（`:17-23`）。既有 `PiServer`/`PiClient` 已覆盖通用多 Session 路由，本文仅补 coding-agent 共享服务和逐 Session 隔离，不新增协议或客户端。对应效果 3（`:33`）。
- 效果 2、4、6（`:32-36`）要求消息/持久化、模型与工具配置、事件、取消、provider 共享和有限并发。本设计逐项划定共享资源、Session 所有权、注册冲突、请求优先级/FIFO和清理边界。
- 效果 5、7（`:35-37`）规定产品领域状态归产品且保留独立故障域。本文不接管角色调度/权限；对确需独立 provider、扩展信任域或隔离状态的角色，建议使用不同 PiServer/进程而非隐式跨租户共享。

## 现状与设计边界

### 已有底座与本模块缺口

- `PiServer` 已以 `PiServerService`/`PiSessionRuntime` 抽象管理 session acquisition、路由、事件和 dispose；应用提供 service（`packages/server/src/types.ts:27-60`；`packages/server/src/sessions.ts:39-46,48-146,179-196,213-273`）。官方 `PiClient` 一条连接可 attach 多个 Session（`packages/client/README.md:26-34`）。coding-agent 当前已有 adapter（`packages/coding-agent/src/server/coding-agent-server.ts`），本文设计其共享运行时/隔离与尚缺的 owner policy，不重复实现 server 或 client。
- `createAgentSession()` 可注入 `modelRuntime`、`requestGateway`、`resourceLoader`、`sessionManager`、`settingsManager` 与 `scope` 等（`packages/coding-agent/src/core/sdk.ts`）。`AgentSessionRuntime` 本身只拥有一个当前 AgentSession；多 Session Host 是外层 coding-agent PiServer adapter（`core/agent-session-runtime.ts:67-95,171-186,204-231`; `packages/coding-agent/src/server/coding-agent-server.ts:45-100`）。
- `AgentSessionServices` 有意把服务组合到有效 cwd：其中 ModelRuntime 可注入，但 `SettingsManager` 与 `ResourceLoader` 并非可任意共享的 readonly value（`packages/coding-agent/src/core/agent-session-services.ts:37-92,147-207`）。`ResourceLoader.getExtensions()` 返回 loader 自己持有的可变 `LoadExtensionsResult`（`core/resource-loader.ts:251-258,323-345`）。
- `packages/session-backends/postgres` / `sqlite-node` 是 `pi-agent-core` 的 `SessionRepo`，不是 coding-agent JSONL `SessionManager` 的替代物；Postgres README 明确无 JSONL import/fallback/dual-write（共同契约 `00-共同上下文.md:27`；`packages/session-backends/postgres/README.md:1-24`、`packages/session-backends/sqlite-node/README.md:1-22`）。本设计不把它们当现成的 coding-agent 持久层；换掉 SessionManager/迁移历史必须另列成本与范围。

### 共享/隔离分类表

| 分类 | 对象 | 语义与限制 | 依据 |
|---|---|---|---|
| Host-scoped、共享一个实例 | `ModelRuntime` | 仅在同一 Host 的 `agentDir`、models/auth 文件、credential store、存储 backend 与 provider 信任域一致时共享。它持有 mutable providers、auth/availability snapshot、credentials 操作队列和 host model config；不是无状态 catalog。不同账户/tenant、独立 auth、需要冲突 provider overlay 的角色必须用不同 adapter/Host（或独立进程）。 | `model-runtime.ts:143-183,186-235,264-293,754-807` |
| Host-scoped、共享一个实例 | `RequestGateway` | 绑定上面的同一个 `ModelRuntime`，每个 provider 的 active/queued 请求状态跨所有 Host Session 汇总；限流须由 Host 统一配置，不能各 Session 默认新建 gateway。它不替代每 Session abort signal。 | `request-gateway.ts:98-128,130-170`; `sdk.ts:422-427` |
| Host-scoped、有 owner 管理 | Model provider registrations / compat API providers | `ModelRuntime` provider registrations 由 `AgentSessionScope` owner coordinator 按 scope 管理。pi-ai compat API provider registry 仍是 process-global；Host-supported Extension API 不暴露此 registry 的写接口，Host-scoped reload 不 reset 它。扩展直接调用 raw `pi-ai` 全局注册 API 属于不受支持的越界行为，不作隔离保证，也不伪称由 Host 自动拦截。 | `core/session-scope.ts:68-177`; `agent-session.ts:4808-4823,5420-5422`; `packages/ai/src/compat.ts:95-213` |
| Host/assembly-scoped durable catalog + root ownership; caller-owned catalog if injected | Default `FileCodingAgentServerSessionStore(sessionStorageDir)` | `sessionStorageDir` 是专用 durable root，映射 durable ID→固定 JSONL path；root/session 目录及文件私有。Node SQLite 在 `BEGIN EXCLUSIVE` 后执行真实写事务并持有未提交写至 close/进程死亡；root lock 必须在 list/create/open 与 listener 启动前取得。仅支持 Linux/macOS/Windows 上识别出的 durable local filesystem；tmpfs、overlay、remote/shared、unknown 必须 fail closed。旧 project sessions 与 legacy session-file mode 均不自动迁移。 | `server/host-root-lock.ts:17-53,139-189,191-215`; `server/session-store.ts:63-106,108-136,206-245`; `server/coding-agent-server.ts:62-66,179-180`; 共同契约 `00-共同上下文.md:47,89` |
| Host assembly admission policy | `maxActiveRuntimes` | Required positive finite bound on in-memory live AgentSession/PiSessionRuntime count, not durable catalog size. Distinct from finite provider-request concurrency; full capacity returns protocol `busy` before persistence for an operation that would allocate a new runtime, not for reusing an already-live runtime. Never evicts attached sessions. | 共同契约 `00-共同上下文.md:86`; `packages/server/src/sessions.ts:45-50,209-234` |
| 每 Session 独立 | Agent、`AgentSession`、外层 `AgentSessionRuntime`、SessionManager/current file、agent queue、abort/side-request controllers、event subscription | 每个 PiServer runtime 拥有自身；操作异常、abort、dispose 不得触及另一个 runtime。PiServer durable `sessionId` 到内部 SessionManager/file 的映射固定，不把内部 current ID 当请求 identity。 | `agent-session.ts:566-614,661-711,1387-1429`; `agent-session-runtime.ts:67-95,171-186` |
| 每 Session 独立 | `AgentSessionScope` / `PromptRegistryScope` | 每个受管 `AgentSession` 有自己的 scope；scope 管理 prompt registry、该 Session 的 ModelRuntime provider owner 与 replacement policy。`_buildRuntime()` 对 scoped prompt/provider 更新先 stage，成功后 commit，失败 rollback。Subagent 使用 fresh child scope；准备阶段由 parent scope 编译已选 prompt preset，并只把编译后的 messages 交给 child，不把 registry 或 renderer closures 交给 child。 | `core/session-scope.ts:68-80,179-249,274-283`; `core/prompt-preset/registry-scope.ts:10-85`; `core/agent-session.ts:825-828,4934-4948`; `core/subagent/prepare.ts:204-225,250-286`; `core/subagent/run.ts:153-163` |
| 每 Session 独立 | `SettingsManager`、`ResourceLoader`、`LoadExtensionsResult`/`ExtensionRuntime`、`ExtensionRunner`、tool definitions/active tool set、custom tools、schema/preset context | cwd、agentDir、flags、trust、tools、preset、prompt、memory config 都可能不同或可变；ExtensionRunner 是 session context，不是共享扩展容器。可共享基础目录或 host 默认值，但解析出的运行时对象不能共享。 | `agent-session-services.ts:83-92,147-207`; `resource-loader.ts:251-258,323-345`; `agent-session.ts:369-434,660-717,821-857,4767-4844,4930-4954` |
| 每 Session 独立 | `StateManager`、state schema 与状态权限 | 每 AgentSession 创建独立 StateManager/schema。默认不得把同一可写 `storeDir` 当成每角色隔离；如产品明确要共享跨进程命名空间，必须作为显式 domain policy，并保留 CAS/权限/namespace 约束。 | `agent-session.ts:671-687,829-846,1997-2021`; `state/state-store.ts:19-25,59-87` |
| 每 Session 独立、可有共享底层 | `MemoryModule`、`MemoryModuleHost`、memory tools/renderers 与活动取消 | 每 Session 创建/销毁 module/host/工具闭包；同一 canonical DB path 在同一 storage/sqlite backend 下可复用一个 `MemoryStore`，但不共享 module/session callback、memory slot renderer closure、host callback、seen-entry set，亦不把 parent renderer closure交给 subagent。 | `agent-session.ts:241-274,4982-5034,5050-5074,5113-5125` |
| 可安全缓存的 immutable data（须保持只读） | built-in provider catalog、规范化静态模型/schema/tool 定义、扩展源文件摘要/解析结果 | 仅在值不捕获 Session、cwd、credential、mutable registry 且缓存 key 含真实配置版本时缓存。先证明 correctness；缓存收益未经基准测量不得宣称。 | `model-runtime.ts:201-208`; `agent-session.ts:4881-4909` |
| 不可跨 Session 共享可变上下文 | `ResourceLoader`、`LoadExtensionsResult`、`Extension`/`ExtensionRuntime`、`ExtensionRunner`、session-bound tools/closures | Node may cache immutable source/parse data, but each Session must build independent runtime/context/runner/tool state. Module top-level mutable state remains process-global despite a new Runner and is outside the scoped Extension API contract; extensions relying on it require a separate Host process or are unsupported in shared mode. | `extensions/loader.ts:148-169,188-212,218-247`; `resource-loader.ts:581-599,606-656`; `extensions/api.ts:60-140` |

### Provider registration：不可依赖当前隐式覆盖

当前 `AgentSessionScope` 是每 Session 的隔离边界；它持有 `PromptRegistryScope`，并通过按 `ModelRuntime` 建立的 coordinator 管理 scoped provider registrations（`core/session-scope.ts:68-177,184-208`）。这与 `packages/ai/src/compat.ts` 的 process-global API provider Map 是两套 registry，不能混为一谈。

1. Host 创建的 Session 把初始及动态 `ModelRuntime` provider registration 按 `extensionPath` 交给 `AgentSessionScope`；unscoped legacy Session 才直接 mutate `ModelRuntime`（`agent-session.ts:4808-4823`）。同一 scope 内重复 config 会合并；不同 extension owner 占用同一 provider ID 时明确 conflict。跨 scope 只有同 owner、可证明相同的 registration 才能共用引用；不透明 native provider 以对象 identity 判等，不能靠 JSON stringify 猜等价。
2. `ProviderRegistrationCoordinator` 以 `ModelRuntime` 为协调域、以 scope token 为引用 owner；先检查冲突，再差异 apply/unregister，并在 apply 失败时回滚已改项。scope dispose 只释放自己的引用，最后一个引用离开后才可移除 registration；不得让一个 Session 的 reload/dispose 取消另一个 Session 仍使用的 provider。
3. `AgentSession._buildRuntime()` 使用 `scope.beginUpdate()` stage prompt definitions 与 scoped ModelRuntime registrations，runtime build 成功才 commit，失败 rollback（`agent-session.ts:4934-4948`; `session-scope.ts:220-249`）。这是注册表更新的事务边界，不代表整个 `_reloadCore()`（其中旧 runner/memory 会先 teardown）对外完全原子。
4. `ExtensionRunner` 动态 provider actions 保留 `extensionPath` 并由 scoped Session callback 路由到 scope owner；unscoped legacy callback仍走原先 ModelRuntime API（`agent-session.ts:4808-4823`）。native Provider 的不同函数不可证明等价时 fail closed。
5. pi-ai API provider registry 仍为 process-global Map（`packages/ai/src/compat.ts:95-158,191-213`），但 Host-supported Extension API 不暴露此 registry 的注册入口；scoped `_reloadCore()` 不调用全局 reset，unscoped legacy reload 保留既有 `resetApiProviders()`。扩展直接调用 raw compat register/unregister/reset 是越出受支持的 Session-scoped API contract；Host 不提供扫描、拦截或跨 Session 隔离保证，需将这种扩展放入独立 Host/进程。

## 扩展/prompt 全局状态与 Host 信任边界

独立 ExtensionRunner 是必要条件，但还需明确支持边界：
**V1 extension trust boundary (已由用户拍板)：**同一 Host 只承载产品 curated、trusted 且遵循受支持 Session-scoped Extension API 契约的扩展集合。产品通过 `sessionOptionsForSession` 提供该配置；Host 不提供 JavaScript mutation scanner，也不自动检测任意 JS module/process-global 读写。未知或不可信扩展不得进入多 Session 同进程 Host，需使用独立 Host/进程。无法确认某扩展属于受支持集合时，不得宣称其隔离成立。

1. `createExtensionRuntime()` 为每个 runtime 创建独立 custom type policy map、flags、pending provider registration、invalidate callback（`extensions/api.ts:60-140`）；`DefaultResourceLoader` constructor 创建新的 extensions result/runtime（`resource-loader.ts:272-344`），Host 创建的 Session 也持有独立 `AgentSessionScope` 与 `ExtensionRunner`（`server/coding-agent-server.ts:74-100`; `agent-session.ts:4934-4954`）。
2. prompt slot 与 macro 模块保留 unscoped legacy Map；scoped `AgentSession` 通过自己的 `PromptRegistryScope` register/resolve extension slots/macros，compiler、async slot check、slot renderer 与 macro expansion读取当前 Session registry，不解析到另一个顶层 Session 的 custom Map。Resolver precedence固定：slot先看scope built-in，再看process built-in，再看scope custom；macro先看process built-in，再看scope custom。Unscoped API行为保留兼容（`prompt-preset/slot-registry.ts:11-31`; `macro-engine.ts:9-30`; `registry-scope.ts:10-85`; `agent-session.ts:2153,2203,2544,2564`）。
3. Memory setup 为每个 Session 创建独立 module/host；Host-scoped Session 把 memory slot 注册进自己的 `PromptRegistryScope`，renderer 只捕获该 Session 的 memory module/store。Subagent 获得 fresh child scope，不接收 parent renderer closure；准备阶段的 selected preset 在 parent scope 中编译，只有编译后的 messages 被传递给 child（`core/subagent/prepare.ts:204-225,250-286`; `core/subagent/run.ts:153-163`）。
4. `packages/ai/src/compat.ts` 的 API provider registry 仍是 process-global Map；Host-scoped `_reloadCore()` 不调用全局 reset，**unscoped legacy AgentSession reload 继续保留原 `resetApiProviders()` 行为**（`agent-session.ts:5407-5423`; `compat.ts:126-158,191-213`）。Host-supported Extension API 不暴露 compat provider 注册入口；直接调用 raw compat mutation 属于不支持的扩展行为。
5. 任意 extension 直接 import/call raw `pi-ai` process-global registration/reset API，不属于受支持的 Session-scoped Extension API contract；系统不承诺拦截、自动发现或隔离此类 mutation。此类扩展须置于独立 Host/进程；不得把信任名单描述成自动扫描或 sandbox 保证。
6. Node loader 的 extension cache 当前按 path 保存并重用 `ExtensionFactory` 对象；跨 cwd 会整体清空缓存（`extensions/loader.ts:148-169,188-212`）。即使每次创建新的 `Extension` 与 API 并执行 factory，复用函数仍可能带 module closure；Host mode 不得把 mutable factory/module state 当跨 Session immutable data。

### 必须的隔离机制

- **Scoped prompt registry：**每个顶层 Session 有独立 prompt scope；compiler、`presetHasAsyncSlots`、slot renderer、macro expansion 显式读取当前 scope，custom slot/macro 不 fallback 到其他 Session 的 Map。Scoped reload 对本 Session registry 按 build 成败 commit/rollback；Subagent 使用 fresh child scope，准备阶段只通过 parent scope 编译 prompt，传递编译结果而不共享 registry或renderer closures。Resolver precedence固定为 scoped builtin / process builtin / scoped custom slot，以及 process builtin / scoped custom macro。
- **ModelRuntime provider ownership：**ModelRuntime-backed extension registrations 按 extension owner 和 AgentSessionScope 协调，异 owner冲突在mutation前拒绝；scope reload stage/commit，dispose只释放自己的引用（`session-scope.ts:108-209,220-249`; `agent-session.ts:4808-4823,4934-4948`）。
**Factory/module isolation and trust：**Host-backed multi-session不得共享可变`ExtensionFactory`函数实例/closure；每Session独立factory/module context、ExtensionRuntime、runner与tools。只缓存纯静态源码/AST等无closure数据。V1同Host仅运行产品curated trusted且符合Session-scoped Extension API契约的扩展；任意raw `pi-ai` process-global mutation与其他未支持的JS globals不在该边界内，也不做自动检测。产品经`sessionOptionsForSession`提供允许资源；未知/不可信来源须在独立Host/进程运行。

Host 已接入 scoped prompt 与 ModelRuntime provider ownership，Subagent child scope 与 parent prompt 预编译路径也已落实。pi-ai compat registry仍为进程全局状态，但其 raw mutation不属于Host支持的 Extension API；不能声称Host对其隔离或自动检测。对于受支持的 scope，provider冲突必须确定性拒绝且不改变其他 Session。

## 请求并发、identity、优先级与取消

### Host gateway 配置与 route identity

- Host assembly创建一个绑定共享`ModelRuntime`的`RequestGateway`，并在开始accept requests前验证完整effective provider-limit config。每个Host必须提供正有限`defaultMaxConcurrency`；显式`providers[id].maxConcurrency` override也必须逐项正有限。provider没有override时只回落到有效finite default，不能出现既无override又无default的provider。拒绝缺失default、0、负值、`Infinity`、`NaN`以及任何其他非有限值。当前 gateway 的 undefined/`<=0`映射到`Infinity`，`NaN`也绕过`<=0`比较（`request-gateway.ts:27-35,123-127`），所以仅依赖现有构造函数不能保证有界并发；validate完后再注入SDK（`sdk.ts:156-159,422-471`）。
- Host assembly 为每个 AgentSession 注入稳定 PiServer durable `sessionId`、同一个 Host `RequestGateway` 与对应 `RequestIdentity`。Subagent 必须由 parent 创建 fresh child `AgentSessionScope`；child 从 parent `RequestIdentity` 继承 owner/session identity 与同一个 Host `RequestGateway`，再派生较低 priority / `label="subagent"`，而不是 `"?"` 或另建 gateway。Child 的 prompt registry 可有 parent 的只读 lookup view，但绝不共享 parent scope；parent memory slot closures 不向 child 暴露。V1 的 parent lookup/filter wiring 属于验收契约，fresh child scope 本身不代表已满足只读 prompt inheritance（`server/coding-agent-server.ts:89-100`; `agent-session.ts:813-828`; `subagent/run.ts:152-165,186-209`; `session-scope.ts:184-208`）。
- Host config是唯一effective gateway policy；SDK未注入gateway时当前会每Session各自建一个（`sdk.ts:422-427`），per-session SettingsManager的limit不能覆盖/放大Host gate。若Host在组装过程中合并产品/provider override，必须对fallback和每个effective override执行同一positive-finite校验；共享Gateway不接受值为0的“无限”override。

### 优先级、FIFO与取消

- 当前 per-provider semaphore 已提供 Host 可复用的调度基线：较高 priority 排在较低 priority 前，同 priority 按到达 FIFO；queued signal abort 会移出对应 queue entry（`request-gateway.ts:49-96`）。SDK 标注 main=2，compaction=1，subagent/side work=0（`request-gateway.ts:17-23`; `sdk.ts:469`; `subagent/run.ts:159`; `agent-session.ts:4708,5236-5242`）。
- V1 复用这套已实现的 strict priority/FIFO，不增设 per-session round-robin queues 或 priority-aging policy。给主会话稳定 priority=2、低于它的 side/subagent 任务使用较低 priority，保证 main 不排在低优先级队列之后；同级请求 FIFO。它不提供低优先级请求无限到达高优先级工作下的 starvation-free SLA，也不提供按 Session 的最大并发份额。效果清单只要求受控并发；如后续消费者明确要求跨 Session 权重/低优先级反饥饿，再依据负载证据另行设计。
- `RequestIdentity.sessionId` 当前传入 gateway 但 gate 仅读取 `priority`（`request-gateway.ts:137-140,162-164`）；稳定 PiServer identity首版用于请求归属/诊断及后续可观测能力，不假称现有 scheduler会按该字段公平分配。所有 provider仍共享一个显式 finite Host cap；没有上限时当前 gateway 实际无限制（`request-gateway.ts:123-127`）。
- Gateway stream等待时把本次 `signal` 交给 `gate.acquire()`；SDK另将对应Session Agent signal放进provider options（`request-gateway.ts:130-152`; `sdk.ts:448-470`）。A abort只停止A的Agent/side controllers：`AgentSession.dispose()` abort自身retry/compaction/bash/side requests和agent（`agent-session.ts:1394-1429`）；不能清共享queue或abort B。slot仅在已占用provider stream结束/abort后释放，Host close逐一dispose拥有的runtime。

## PiClient snapshot revision 与 reopen

`SessionSnapshot.revision` 以持久 `SessionManager.getEntries().length` 表示 session transcript entry 数：runtime 创建时读取该值，每个 `entry_appended` 后重读并更新；phase、queue、model/thinking 等只投影状态变化的 snapshot 可以保持相同 revision，不得为它们递增 revision。如此 PiClient 在 idle dispose 后 reopen 时，revision 回到同一 durable entry count，而不会比先前 phase/queue snapshot 更小并被客户端误判为回退。Fixed ID/file v1 不支持 session-tree replacement；若将来引入能减少持久 entries 的分支替换，必须另定义 revision epoch，不能直接沿用 count（`server/coding-agent-server.ts:220-232,241-283,385-403`；`packages/protocol` 的 `SessionSnapshot.revision`）。

## Memory、state、settings 与工具

### Memory

- Memory DB 路径优先级是环境变量 `PI_MEMORY_DB`、settings `memory.dbPath`、active preset `memory.dbPath`、默认 `<cwd>/.pi/memory.db`；Store singleton 的 map key 当前只有 resolved `dbPath`，同路径同一个底层 store，失败时清除 cache（`agent-session.ts:241-274,4982-5009`）。因环境变量是进程级，不可用它分别配置同进程不同角色；差异应放在 Session settings/preset。
- **可共享的仅是同物理 DB + 同 StorageBackend/SQLite factory 的 `MemoryStore` handle**，它的当前实现本就按 path singleton；不同路径需不同 store。实现中该 key 没含 backend/factory 身份，所以 Host 不得让同 path 的两个 AgentSession 传不同 store backend 或 sqliteFactory；若必须支持，应扩大 store identity key 或隔离 Host。[推断]
- 每 Session 独立创建 `MemoryModule`、synthetic extension/tool wrappers、`MemoryModuleHost` 和 lifecycle；reload/dispose 停 module/side work 而不关闭其他 Session 使用的底层 store（`agent-session.ts:1408-1413,4982-5034,5050-5074`）。不共享 memory tool renderers、host callback、seen-entry set。
- Memory slots 已能绑定 scoped Session 的本地 prompt registry；在未注入 `AgentSessionScope` 的 legacy path 仍可走 module-global registry。验收要分别覆盖 Host scope 与 legacy scope，并确认 A/B 不同 DB 的同名 memory slots 只访问各自 store；subagent 不读取 parent memory renderer closure（`agent-session.ts:5113-5125`; `prompt-preset/slot-registry.ts:14-31`）。

### State、settings、tools

- 每个 AgentSession 有自己的 `StateManager`/`SchemaValidator`、tool search manager、tool registry/definitions/snippets/guidelines（`agent-session.ts:671-717,829-846,1502-1513,1570-1677,4767-4844`）。工具对象通常捕获对应 cwd/settings/runner/state；只读 schema 文档可以缓存，AgentTool、ExtensionRunner wrapper、活动权限列表都不能跨 Session 复用。
- `StateStore` 本身明确是 cross-process shared file store，按 namespace CAS 写（`state/state-store.ts:19-25,59-87`），而 `_initStateStore()` 会从 project config/shared `storeDir` 载入 namespace（`agent-session.ts:1997-2021`）。这是显式共享状态机制，不是 Session 私有会话树。满足“独立 Session state”时 Host 默认给每角色隔离 root/关闭 attach；需要共享角色/world state 时必须由产品显式授权及设计 namespace/policy，不因 cwd相同自动共享。
- `SettingsManager` 在服务组合中按 cwd/agentDir 创建（`agent-session-services.ts:150-166`），且 settings 中可储存 model/default preset、memory、extensions、tool search/provider retry等。实例按 Session 独立，但多个实例若指向同一文件仍可共享持久化副作用；模型切换须调用 `setModel(model, persistSettings:false)`，其注释专为共享 agentDir 的多会话写了此 opt-out（`agent-session.ts:3603-3621`）；thinking/preset也需相同 non-persistent policy（`3712-3727,2342-2363`）。Session 级 model/preset选择持久入自身 SessionManager；不得串写 Host default。
- Host 的 `agentDir` 可作共享 provider/auth 根，但每 Session 的 settings overlay/preset/cwd/extension trust/tool selection应独立解析。若允许两个 Session共享同一 `SettingsManager` 对象，`setDefaultModelAndProvider()` 等热写会污染对方；若两个独立 manager仍写同一 settings path，persist=true也有同样外部副作用。首版不以复制 manager 就当设置隔离完成。

## 取消、错误、文件替换与生命周期并发边界

- Host provider coordinator、scoped API coordinator（待实现）与 per-provider gateway 是共享并发状态；Session runtime 持有自己的 scope、abort controller set、Agent signal、runner订阅。一个 scoped Session error/abort/dispose 不能撤销其他 owner 的 provider/API refs、调用全局 `resetApiProviders()`、close shared gateway、或 dispose另一个 memory store；只有未绑定 Host scope 的 legacy reload 保留其 reset 路径。
- `PiServer` 的 `LiveSessionManager` 对同一 server durable ID acquire single-flight，但 adapter仍需同一 SessionManager file 唯一 writer，并识别不同 PiServer IDs映射同一文件（共同契约 `00-共同上下文.md:79`；`server/src/sessions.ts:213-273`）。V1固定 protocol ID 到一个session tree/file，不开放new/fork/switch/import；对 extension callback 必须明确拒绝这些替换，不能沿用 `{ cancelled: false }` 静默默认值（`extensions/runner.ts:342-345,484-502`）。未来如果消费需求要求 replacement，再实现 00 §4 的 claim-before-mutate 与fork目标 reservation gate。
- `AgentSession._buildRuntime()` 等待 scope prompt/ModelRuntime provider registration commit 后，才让新 registry state 对当前 runtime 生效；失败 rollback 本次 staged scope update。未来接入的 pi-ai API owner registrations 必须加入同一 commit/rollback 边界。此注册表事务不把整个 `_reloadCore()` 变成 atomic runtime swap；构建/冲突失败不得泄漏新 owner 引用或触发 Host shutdown（`agent-session.ts:4934-4948`; `session-scope.ts:220-249`）。
- `PiServer.close()` 会清理 acquired runtime（`server/src/server.ts:156-170,338-349`），但 `PiServerService` 没有 shared-service dispose hook（`server/src/types.ts:54-60`）。遵循共同契约§4，`createCodingAgentPiServer()` owner handle `close()` 必须先 await `PiServer.close()` 和所有 session runtime disposal，再关闭 assembly-owned default file catalog/释放Host coordinator/provider registrations/gateway，最后 release root lease。caller注入 catalog/store remains caller-owned；单个 `PiSessionRuntime.dispose()` 不能关闭 Host 共享对象或删除 durable catalog/transcript。
- `maxActiveRuntimes` 必须在 assembly configuration validation 时验证为正有限数，且与 provider `maxConcurrency` 分开记账。adapter在每个会创建新live runtime的create/open开始前原子reserve一个slot；同ID LiveSessionManager acquire单飞复用已有runtime时不重复reserve。达到上限时以现有协议 `busy` + `details.reason = "active_runtime_limit"` 拒绝，不能排队、驱逐/打断attached Session，且必须在创建/打开 AgentSession与任何新 catalog/JSONL写入前拒绝。PiServer的同ID acquire single-flight不覆盖不同ID的active-count竞争（`server/src/sessions.ts:45-50,209-234,237-273`）；构建失败回滚reservation。slot只在该live AgentSession/PiSessionRuntime真实dispose后释放，连接detach但server仍保留runtime时继续占用；持久catalog记录不占slot。现有wire code为`busy`且可带JSON details（`protocol/src/schemas.ts:269-282`; `server/src/errors.ts:11-27`）。
- 默认 `sessionStorageDir` 必须是独立 durable storage root：Host assembly 调 `FileCodingAgentServerSessionStore.acquire()`，完成 canonical root 定位、local filesystem 识别与进程级 root lock 后，才允许 list/create/open、清理 pending create 或启动 listener；未 acquire 的 store 所有读写 API 都拒绝。Node SQLite lock 在 `BEGIN EXCLUSIVE` 后真实写入并让事务保持未提交至 close/进程死亡；SessionStore 对相同 session ID另做 writer claim。root 与 session dirs/files 按平台私有化（`server/host-root-lock.ts:31-63,139-215`; `server/session-store.ts:63-106,108-136,206-245,302-315`; `server/coding-agent-server.ts:62-66,179-180`）。
- Root filesystem 只接受 Linux、macOS、Windows 上按各平台 mount/volume 信息识别出的 durable local filesystem；tmpfs、overlay、remote/shared、unknown 与无法检查的 OS 均 fail closed。`proper-lockfile` stale mtime reclaim不是此机制，也不得作为替代。正常 close 在全部 Session runtime/storage 关闭后释放；进程被暂停仍须阻止竞争者接管，SIGKILL 后 SQLite 自动释放。仅使用专用 `sessionStorageDir`；旧 project sessions 和 legacy session-file mode 不自动导入、搬移或双写（`server/host-root-lock.ts:31-53,103-189`; `server/session-store.ts:63-106`; 共同契约 `00-共同上下文.md:47,89`）。
- 三平台的互斥竞争、暂停 owner 拒绝接管、SIGKILL 后释放/重开、tmpfs/overlay/remote/unknown filesystem 拒绝、private ACL/mode 与 listener/open gate 顺序仍必须实测；源文件已存在不等于这些验收已通过（`test/host-lock-platform.mjs`; `test/server/session-store.test.ts`; `test/server/coding-agent-server.test.ts`）。
- 当前 `ModelRuntime` 没有公开 dispose API（`model-runtime.ts:144-166,186-235`）；owner handle只能释放本层注册/queue/reference，不得承诺关闭未经证实的底层连接池。

## 最小安全首版

这里的“最小”是最少共享边界，不是省略用户要求的隔离：

1. 复用PiServer/PiClient，不加第二套Host registry。10文档service factory持有一个Host `ModelRuntime` + `RequestGateway`；明确positive-finite default provider limit及所有per-provider overrides，并把稳定PiServer sessionId identity注入每Session。
2. 每 durable session独立 `AgentSessionRuntime`、SessionManager/file claim、`SettingsManager`、`ResourceLoader`/`ExtensionRuntime`/`ExtensionRunner`、`AgentSessionScope`/`PromptRegistryScope`、StateManager/tools/abort/events和memory module；store仅在完全相同 DB/backend/factory条件下按path共享。Subagent另建 fresh child scope，只能 lookup parent 的允许 prompt definitions，不共享 parent memory closures。
3. v1 的 session set共享一个Host provider/auth/model namespace；session各自选model/preset/tools。`AgentSessionScope` coordinator按ModelRuntime与extension owner/refcount处理 supported provider registrations；异源或不等价 ID冲突失败。pi-ai API providers另由跨 Host process singleton owner/refcount coordinator 管理，并随 scoped reload事务提交；unscoped legacy reset保持兼容。
4. 每 Session 的 prompt slot/macro与Memory slots绑定自己的scope；shared Host只加载产品curated trusted allowlist中符合Session-scoped Extension API契约的扩展。raw `pi-ai` process-global registry调用及任意JS global mutation在该信任边界外，不声称有自动检测/隔离；无法遵守者用独立Host/进程。
5. Default `FileCodingAgentServerSessionStore` 使用专用 durable `sessionStorageDir`。Node SQLite `BEGIN EXCLUSIVE` 后的真实写事务持有root lock；仅接受Linux/macOS/Windows已识别 durable local filesystem，tmpfs、overlay、remote/shared、unknown fail closed。Root lock 是 list/create/open 与 listener 的 admission gate；root/session dirs私有。旧project sessions与legacy session-file mode均不自动迁移，SessionManager继续负责JSONL，v1不开SessionRepo存储迁移。
6. V1复用现有gateway优先级插队、同级FIFO与queued abort移除；给main高于side/subagent的明确优先级，所有Session共享Host finite provider cap。不增round-robin/aging scheduler，也不承诺低priority starvation-free SLA。
7. V1另需正有限 `maxActiveRuntimes` admission cap（计内存live runtimes，不计durable IDs），独立于provider request cap；full create/open以protocol `busy` + `details.reason = "active_runtime_limit"` 在任何新catalog/JSONL写前拒绝，不排队/不驱逐attached sessions，真正dispose后释放slot。

## 设计评审与安全实现/生产发布阶段门

当前源码选择并实现了 root ownership mechanism：Node SQLite `BEGIN EXCLUSIVE` 后创建/写入 lock row，并持有未提交事务至正常 close；进程死亡释放 SQLite lock。FS 边界按 Linux mountinfo、macOS mount 信息、Windows volume/drive info 识别，只接受支持的 durable local filesystem；tmpfs、overlay、remote/shared、unknown fail closed。`FileCodingAgentServerSessionStore.acquire()` 在处理 pending records 与 list/create/open 之前执行，`createCodingAgentPiServer()` 在构造/启动 listener 前 acquire。Root 与 session storage 权限私有，store 仅用专用 `sessionStorageDir` 且不自动迁移旧 project sessions 或 legacy session-file mode。该设计已由当前 source 落地，但 Linux/macOS/Windows 竞争、暂停旧 owner、SIGKILL 释放/接管、FS 拒绝及 close/open 顺序尚无通过的 tests/build 证据，仍是实现验证与 production release gate；不得把机制已选或源码存在写成 OS/FS 行为已经证明（`server/host-root-lock.ts:17-63,139-215`; `server/session-store.ts:63-106`; `server/coding-agent-server.ts:62-66,179-180`）。

## 不安全优化（v1 禁止据此宣称安全/更快）

- 把一份 `AgentSessionServices`、`DefaultResourceLoader`、`LoadExtensionsResult`、`ExtensionRuntime`、`ExtensionRunner` 或它生成的 `AgentTool` wrapper放进共享 Map，节省若干创建成本。
- 将 `ExtensionFactory` 函数或完整 `Extension`对象当不可变缓存；Node loader已有path-keyed factory函数缓存，factory可能带 module closure。
- 假定 provider 同名等价、每 Session重复 `registerProvider()` 无副作用，或让某 Session `unregisterProvider()`/reload重置影响全 Host registry。
- 在 scoped Host reload 中调用 process-global `resetApiProviders()`，或把 unscoped legacy reset 行为扩展到所有 scoped Session；**未绑定 `AgentSessionScope` 的 legacy `_reloadCore()` 必须保留原 reset 调用**。Raw compat registry mutation不属于Host-supported Extension API；不得声称Host为其提供scope ownership。
- 让 Memory slot closure从“最近初始化的 store”取库、共享 MemoryModuleHost，或让环境变量 `PI_MEMORY_DB` 承担每角色不同路径。
- 共享 SettingsManager/agent settings文件并允许各 Session `persistSettings=true`；共享 `StateStore`却声称状态独立；共享 side-request/abort controllers。
- 每Session新建RequestGateway（跨Session总并发失控），或未提供positive-finite fallback / 任一explicit provider override为缺省、0、负、Infinity、NaN等无效值后仍启动并声称并发有界。
- 用durable catalog记录数代替live runtime容量计数、在满载时排队open/驱逐已attached Session，或只在AgentSession创建后再检查active cap（会留下半写catalog/JSONL）。
- 让同root的两个PiServer靠独立进程内Map并发写，或在root lease被compromised后继续提供服务；两者会破坏文件唯一writer约束。
- 直接将 pi-agent-core `SessionRepo` package当JSONL SessionManager的替代层，或未经数据迁移计划改存储格式。
- 开 worker/thread、做 VM sandbox、Connection pool、静态资源预热或模型cache来宣称“100-agent更快/内存下降”；当前没有设计/基准证据支持这些收益。

## 代码落点（当前实现与剩余差距）

| 落点 | 当前实现 / 仍需补齐 |
|---|---|
| `packages/coding-agent/src/server/host-root-lock.ts`, `session-store.ts` | 已有durable local filesystem检查、Node SQLite实际未提交写锁、私有路径、root acquisition gate与session writer claim。Linux WSL workspace ext4 process-lock tests 2/2通过；Ubuntu/macOS/Windows CI matrix已配置但尚未运行，原生macOS/Windows竞态/paused-owner/SIGKILL/FS拒绝无本机证据。 |
| `packages/coding-agent/src/server/coding-agent-server.ts` | 已装配 `ModelRuntime`、Host `RequestGateway`、per-session `AgentSessionScope`、`sessionStorageDir` store 与 active runtime admission；`CodingAgentRuntime` revision 从 persistent SessionManager entry count 来。不要再把这些文件称为 NEW。 |
| `packages/coding-agent/src/core/session-scope.ts`, `prompt-preset/registry-scope.ts` | 已有 scoped prompt registry、ModelRuntime provider owner/refcount coordinator、provider conflict 与 scope build transaction；parent 选择的 prompt 由 `prepareSubagentConversation` 在 parent scope 中编译，child 获得 fresh scope 与编译后的 messages，不共享 registry/renderers。pi-ai compat global registry不由Host支持的Extension API管理；直接 mutation在contract外。 |
| `packages/coding-agent/src/core/agent-session.ts`, `sdk.ts`, `subagent/run.ts` | 已注入 session scope/request identity/gateway；memory slots能写入scoped registry；subagent fresh child scope并从 parent RequestIdentity继承session identity/Host gateway，派生priority/label；parent renderer closures不传给child。 |
| `packages/coding-agent/src/core/prompt-preset/{slot-registry,macro-engine,compiler,slot-renderers}.ts` | scoped `PromptRegistryReader` 已被 slot/macro resolution与编译流程消费；维持 builtin+current-session resolution，不允许跨顶层 Session lookup。 |
| `packages/ai/src/compat.ts` + `agent-session.ts:_reloadCore` | compat API Map仍为进程级直接表；Host-scoped reload不做 global reset，unscoped legacy `_reloadCore()`仍调用 `resetApiProviders()`。Raw API-provider mutation不属于受支持的Host extension contract，Host不声称为它提供scope/refcount。 |
| `packages/coding-agent/test/{host-lock-platform.mjs,server/session-store.test.ts,server/coding-agent-server.test.ts}` | 已运行：focused Host/core回归 26 passed / 10 skipped；完整 coding-agent suite 301 passed / 6 skipped（2733 tests passed / 52 skipped）；package build、Biome与shrinkwrap/install-lock checks通过。Linux本机持久 ext4 上的独立root-lock process tests 2/2通过；原生macOS/Windows runner及性能基准仍未验证。 |

## 与当前状态的差异

1. **已有源码实现：**PiServer/Protocol/PiClient通用multi-session面；coding-agent `createCodingAgentPiServer()` adapter、`FileCodingAgentServerSessionStore`、SQLite root lock、active runtime admission、Host `ModelRuntime`/`RequestGateway`装配均已在当前工作树，不再是设计中的 NEW。
2. **已有Session scope：**Host 每个 AgentSession 建 `AgentSessionScope`；slot/macro和memory slot可走 per-session `PromptRegistryScope`；ModelRuntime provider registrations 经 scope owner/refcount coordinator，并在 `_buildRuntime()` staged update 成功后 commit、失败 rollback。
3. **Compat registry边界：**pi-ai compat registry仍是进程级 Map；Host-supported Extension API不暴露其注册入口，scoped `_reloadCore()`不做global reset，未注入scope的legacy reload仍保留`resetApiProviders()`。Raw compat mutation属于unsupported extension行为，Host不承诺拦截或隔离。
4. **Subagent contract：**源码已创建fresh child scope、从parent `RequestIdentity`继承稳定session identity/Host gateway并派生priority/label；selected prompt在prepare阶段通过parent scope编译，child只接收编译后的messages，不共享parent registry或renderer closures。
5. **Snapshot contract：**当前runtime使用persistent `SessionManager.getEntries().length`设置并更新revision；phase/queue等非持久变化发出的snapshots可以复用同一revision，保证PiClient reopen不倒退。
6. **仍用JSONL SessionManager：**`session-backends` Postgres/SQLite不是该持久化树的既有adapter；旧 project sessions和legacy session-file mode不自动迁移，也不隐式改用SessionRepo。
7. **验证边界：**coding-agent完整suite、build、Biome和lock-file checks已通过；Linux本机ext4进程锁测试已通过。CI的macOS/Windows runner尚未执行，当前没有这些OS的实际证据；1/10/25/50/100规模/RSS/event-loop benchmark也未运行。

## 验收测试（消费者可见行为；设计清单，执行结果由40文档记录）

1. 使用既有PiServer + PiClient同一connection创建两个 coding-agent sessions；A/B用不同preset/工具权限并同时运行，各自transcript/tool执行/事件只作用于目标Session，工具权限和Session model选择互不串改。
2. 两个Session从产品提供的curated trusted extension allowlist中加载符合Session-scoped API契约的扩展，分别调用同名工具时context/tool状态互不串扰；未获allowlist信任的extension在进入shared Host前明确拒绝或由产品放到独立Host。此验收不声称adapter可自动扫描/检测任意JavaScript global mutation。
3. 两个不同扩展注册同名 slot/macro但内容不同，两个 Session prompt分别解析自己的实现；一方 reload/disable后另一方结果不变。Session A/B memory DB不同且都有同名memory slots时，各自只访问自己的DB；subagent取得fresh child scope，parent侧先编译所选preset并仅传编译messages，不向child共享registry或memory renderer closure。
4. A/B扩展都注册同一个 `ModelRuntime` provider ID：同一owner同定义重复加载只形成一个Host registration；异owner冲突可观测失败且原ModelRuntime/B请求未变化；A reload/dispose只移除A引用，B仍可查模型和发请求。
5. Host-supported Extension API不暴露pi-ai compat API-provider registry写入口；scoped reload不调用global reset，unscoped legacy reload仍执行兼容reset。扩展直接操作raw compat global registry属于unsupported行为，必须另置Host/进程，本测试不声称跨scope协调。
6. 两Session同一Provider并发时active请求不超过Host max；较低priority的queued request不能越过main priority请求，同priority按FIFO，queued abort只移除对应请求；不把低priority请求永久等待视作已提供SLA。
7. A在gateway queue等待时abort，仅A queued request被移除/拒绝；B队列继续；A活动请求dispose不取消B活动provider调用，A Runtime释放后重开不留下僵尸排队项。
8. gateway记录/诊断每个请求的稳定PiServer sessionId和priority/label；main、compaction、extension side request、subagent均无`"?"`。Subagent继承parent sessionId与同一个Host RequestGateway，并按子工作派生priority/label；V1没有同-session内部file/ID切换，identity在整个durable session内保持固定。
9. Host启动时要求正有限`defaultMaxConcurrency`，且逐一校验每个显式`providers[id].maxConcurrency` override；缺省fallback、0、负数、`Infinity`、`NaN`任一出现均拒绝启动，有限fallback覆盖未显式override的provider。并发请求实测不超过effective limit。
10. 配置 `maxActiveRuntimes=N`，N个live AgentSession保持attached时，N+1个不同ID的create/open返回protocol `busy` 且 `details.reason="active_runtime_limit"`；attached sessions仍可prompt、无drive-out；rejected create没有catalog记录/JSONL空文件。重复attach/open已live ID复用原runtime、不新增slot。dispose一个runtime后同ID reopen能成功；durable records数不影响active计数。
11. 已有runtime A active时detach connection但runtime尚未dispose，slot仍占；PiServer idle dispose后slot释放。并发创建不同ID时最多N个live runtime，无reservation race超卖或失败后泄漏slot。
12. 启动第二个PiServer assembly使用相同canonical `sessionStorageDir`时，在listener启动、pending-record扫除、list/create/open触碰records前以local typed startup `busy` + `details.reason="root_owned"`失败；第一个owner继续工作。未 acquire root的list/create/open均fail closed。root lease释放后第二个owner可启动。
13. Linux、macOS、Windows分别验证SQLite真实写事务互斥：第二 owner竞争及暂停超过任意mtime interval期间都必须被拒；持有 owner恢复时仍只有它能写，SIGKILL后新 owner才可接管并打开原Session。tmpfs、overlay、remote/shared、unknown/unrecognized filesystem均须在触碰catalog/打开listener前拒绝。验证专用root与session路径权限；不以 `proper-lockfile` stale reclaim或 `onCompromised` callback替代fencing。
14. SIGKILL root owner后，新 owner安全取得lock并重开原JSONL session，mapping一致且无交叠/损坏；正常close在全部runtime/storage退出后释放锁。由于采用不可被mtime偷取的SQLite进程锁，旧owner存活时不得让第二owner接管。
15. A model/preset设置更改后B的model/default preset和agent settings不变；stateStore启用共享namespace必须显式配置，否则写入/状态快照不串。
16. PiServer idle detach/dispose后重新attach/reopen期间，仅Session runtime/extension owner清理并重建，Host ModelRuntime/Gateway仍活着；owner handle close先完成所有session disposal，再关闭内建catalog、释放Host coordinator/provider state，root lease最后释放。Caller-injected catalog/store未被close/delete。
17. V1 replacement exclusion: extension试图new/fork/switch/import时收到明确unsupported/rejected结果，现有session tree/file与后续prompt不变。
18. 默认 `FileCodingAgentServerSessionStore(sessionStorageDir)` 在PiServer close/reopen及进程重启后仍能list/create/open并恢复原Session mapping与JSONL transcript；第二个PiServer进程不能同时接管相同root。若调用方注入catalog/store，assembly close释放运行时lease但不关闭该caller-owned store。验收不假定 `SessionRepo` 已替换或Postgres自动兼容。

19. 进程规模和RSS/event-loop指标由40文档的基准规划量化；本设计不声称线程/共享缓存已降低成本。
20. PiClient先接收较高 `revision` 的phase/queue-only snapshot后，重复同 durable session并reopen；revision仍为 persistent `SessionManager.getEntries().length`，不下降。phase/queue变化可与前一snapshot同revision；追加一个持久entry才使revision增加。

## 发现的冲突 / 需修订上位文档

- `plan/multi-agent-infrastructure.md:15-18,40-46,111-133` 旧判断“没有消费者，daemon/单Host不做”，并把Rivet进程簇视作方向；本次已确认PiServer多Session与coding-agent adapter需求，需保留进程簇作异构故障隔离选项，不可据旧前提否决。
- `plan/high-concurrency-optimization.md:23-43` 和 `plan/multi-agent-design-assessment.md:186-231,255-279` 曾建议新增multi-session协议/SessionRegistry/daemon和共享模型runtime。前3项现由 `packages/server`/`protocol`/`client`覆盖；coding-agent adapter现已存在，余下重点是共享运行时隔离与消费者集成。旧“provider共享天然安全”或按角色共享ModelRuntime无所有权语义的论断需重审。
- `plan/affiliated-session.md:10-20,32-46` 描述亲子上下文继承/活体读取/写回，与顶层互不相关的PiServer Sessions正交；不得为适配共享ModelRuntime把parent state/messages/tool继承给另一个产品Session。
- `packages/session-backends/postgres/README.md:1-24` / `sqlite-node/README.md:1-22` 是pi-agent-core `SessionRepo`，非coding-agent JSONL SessionManager backend。若后续要替换JSONL/导入session trees，应在store/lifecycle上位设计独立列范围，不能由“Postgres package已存在”隐式裁决。
- `ExtensionRuntime` provider registration API与 `ExtensionRunner` 动态 provider action当前保留并转发 `extensionPath`，Host `AgentSession` callback交给 `AgentSessionScope` 按 owner 路由（`extensions/types.ts:1946-1968`; `extensions/api.ts:373-385`; `extensions/runner.ts:373-380,459-480`; `agent-session.ts:4808-4823`）。pi-ai compat API-provider coordinator不在受支持的Host Extension API contract内；raw global mutation须由独立Host隔离，不需要改Pi protocol。

## 剩余验证与产品层边界

1. v1 store使用 `FileCodingAgentServerSessionStore(sessionStorageDir)`固定protocol ID→SessionManager JSONL file；默认root由assembly持有，root lock是list/create/open与listener admission gate。当前实现使用Node SQLite真实未提交写事务并按OS识别durable local filesystem；tmpfs、overlay、remote/shared、unknown fail closed，root/session dirs私有。Linux本机持久ext4进程锁测试已通过；原生macOS/Windows竞争、暂停owner、SIGKILL释放/接管与FS拒绝仍为CI/release gate。Injected catalog caller-owned；旧project sessions与legacy session-file mode不自动迁移到新root，也不迁移到pi-agent-core `SessionRepo`。
2. Default Host `RequestGatewayConfig`必须含positive-finite fallback default；所有explicit provider overrides同样positive finite，invalid config启动前拒绝。产品是否可按角色提供request overrides及其conflict合并策略，尚无现存Host API；若可配置，仍必须先合并并对每个effective value校验后才启动。
3. V1同Host extension集合限产品已curated trusted且符合supported scoped API contract的扩展；用户已拍板此信任范围。不能自动审计任意JS全局变更；任意raw `pi-ai` global registration/reset均在受支持的trust boundary之外。未知/不可信扩展不进入多Session同进程Host，须使用独立Host/进程。
4. `AgentSessionScope`按 `ModelRuntime`协调 scoped ModelRuntime provider owners/refcounts；pi-ai API compat registry仍为process-global，但Host-supported Extension API不暴露其写入口。Raw compat mutation在contract外；scoped reload不调用全局reset，unscoped legacy reload保留既有 `resetApiProviders()`。
5. `ModelRuntime` has no public close/dispose contract; owner lifecycle handle releases adapter-owned registrations, queues and references but makes no HTTP-pool close guarantee.
6. `maxActiveRuntimes`与RequestGateway max均须正有限，二者是独立capacity边界；server deployment选择具体runtime数/provider并发数。
7. Session state is isolated by default; shared StateStore namespace is an explicit product configuration and must never be inferred from equal path/env defaults.
8. Subagent fresh child scope与parent stable request identity/gateway已由当前路径体现；selected preset在prepare阶段通过parent registry编译，child只取得编译messages，既不共享parent registry也不取得memory-bound renderer closures。
9. `SessionSnapshot.revision`保持为persistent SessionManager entry count；phase/queue-only snapshots可同revision，PiClient reopen不产生revision回退。Branch/replacement可能改变entry count时须另定epoch；V1不开放replacement。
10. coding-agent完整suite、build、Biome与lock-file checks已通过；Linux本机ext4 process-lock test通过。macOS/Windows CI尚未执行，性能benchmark未运行；这些均不得据源码存在宣称已验收。

11. Rivet 本轮保留 legacy path；不在本轮完整迁移或全功能切换范围内。1/10/25/50/100-role 基准验证 Host adapter/topology，不构成完整 Rivet migration 验收。首轮不交付 Python SDK，不承诺 NeonRP 直接接入（共同契约§2、§5）。

## 旧方案的收敛结论

`multi-agent-infrastructure.md`的角色进程簇保留为独立故障域策略；不能覆盖当前“同一PiServer按条件承载同构多Session”的用户目标。早期 `high-concurrency-optimization` 与 `multi-agent-design-assessment` 的通用协议、daemon、SessionRegistry方案由既有PiServer/Protocol/PiClient取代，不复制；host-shared ModelRuntime/RequestGateway现由本Host adapter统一装配，并为supported ModelRuntime provider registrations补齐scope owner；pi-ai raw process-global registry mutation明确不属于受支持的Host Extension API。`affiliated-session`仍只用于有真实父子继承需求的subagent，不构成顶层多Session的默认上下文共享策略。
