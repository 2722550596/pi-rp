# 30 — 既有 PiServer / PiClient 与 coding-agent 集成设计

> 状态：设计与当前代码接口同步稿；现有实现落点见下文，验证状态以主 agent 实际运行结果为准。本轮只同步本设计文件，不运行测试/build；不得据此宣称验证通过。遵循 [`00-共同上下文.md`](./00-共同上下文.md) 与 [`00-需求原话与效果清单.md`](./00-需求原话与效果清单.md)，消费边界已拍板，见共同上下文 §2。

## 一句话定位

复用现有 `PiServer`、versioned `pi-protocol` 和官方 `PiClient`，只为 coding-agent 增加一个将每个 server durable session 装配为独立 `AgentSession` 的 service/runtime adapter；协议与客户端维持现状，已证实的 coding-agent 能力缺口才另提最小增量。

## 需求对照

原话档中，用户明确提出不希望每个产品再次手搓同类 client/角色进程管理（`00-需求原话与效果清单.md:17-23`），并以 100-agent、多 Node 进程成本为优化动机（`:11-15`）。其效果要求包括：同一 Pi 后端承载多独立会话（`:31-32`）、产品复用 Pi 提供的 server/protocol/client 而非复制（`:33`）、共享 provider/runtime 同时隔离扩展和工具（`:34`）、产品保留领域状态/调度/API（`:35`）、支持并发控制和独立故障域（`:36-38`）。

本设计的裁决：通用网络/RPC/client 能力已在 `packages/server`、`packages/protocol`、`packages/client` 实现；coding-agent adapter、FileStore 与公开 `/server` package subpath 已在当前工作树出现源码落点，仍需按本设计验收其实际 consumer-visible 行为，不把源码存在等同于验证通过。本轮正式消费方是 Node/TypeScript `PiClient`；不交付 Python SDK，也不保证 NeonRP 可直接接入。

## 现有栈能力矩阵

| 能力 | 当前已实现 | 本设计判定 / 缺口 |
|---|---|---|
| Server/service 边界 | `PiServerService` 的 `listSessions/listModels/createSession/openSession`；runtime 的 `snapshot/getPhase/prompt/steer/abort/setModel/setThinking/subscribe/dispose`（`packages/server/src/types.ts:27-60`） | coding-agent 当前工作树已有首版 adapter 落点（`packages/coding-agent/src/server/coding-agent-server.ts`、`session-store.ts`、`server/index.ts`）；仍须按本文验收其 consumer-visible 行为，不把源码存在等同于测试通过。 |
| 持久 session 生命周期 | PiServer 为 create 分配 durable `id`，service 必须原样持久化；create/attach acquire runtime、检查 snapshot ID、维护单飞打开（`packages/server/src/types.ts:27-34`; `packages/server/src/sessions.ts:56-99,213-273`）。coding-agent `SessionManager` 创建/打开 JSONL（`packages/coding-agent/src/core/session-manager.ts:1492-1496,1576-1621`）；当前 adapter/FileStore 源码落点为 `packages/coding-agent/src/server/{coding-agent-server,session-store}.ts`。 | 以 durable ID 固定关联 `<sessionStorageDir>/<id>/manifest.json`、该目录内 JSONL 与 AgentSession；manifest status、commit/reopen/model restore、updatedAt 与 revision 规则见下文。`packages/session-backends/postgres` 和 `sqlite-node` 是 pi-agent-core `SessionRepo`，不是 JSONL `SessionManager` adapter，不能替代本契约。 |
| Route、request correlation、response | 现有命令使用 `sessionId`；request envelope 有独立 `id`，response 回显该 ID；失败 response 携带结构化 error（`packages/protocol/src/schemas.ts:291-324,391-435`） | 复用。不是新增 `hostSessionId`、JSONL command envelope 或第二套 client。 |
| Event demultiplex | 现有 server snapshot、session snapshot、session progress、session removed；session 事件自带/包含规范 session identity（`packages/protocol/src/schemas.ts:400-410`）。`LiveSessionManager` 从各 runtime 订阅并按其 live ID 发事件（`packages/server/src/sessions.ts:275-330`） | adapter 将该 AgentSession 的 transcript/progress/state 事件转换为当前 protocol 的 snapshot/progress；session-specific extension UI callback 若 consumer 证明必须支持且无法映射，才单独提最小 protocol delta。 |
| Client / subscriptions | TypeScript/JS 官方 `PiClient` transport-neutral，无 Node-only imports；一条连接管理多个 lease，支持 create/list/attach、request correlation、snapshot/event subscriptions（`packages/client/README.md:1-42`） | 复用现成 client；不同 lease/session 的产品端 event filtering 已有能力，不由产品复制。 |
| Transport / authentication | 协议以 4-byte big-endian length + definite CBOR framing；transport 提供有序 bytes，连接前完成鉴权（`packages/protocol/README.md:5-16,44-50`）。PiServer 由 listener 接入；Unix listener 可基于文件权限，网络 listener 须自身鉴权（`packages/server/README.md:30-38`） | Node SDK 可嵌入 PiServer/service；外部消费者使用现有 PiClient + transport。没有现成 PiServer standalone CLI 或 coding-agent host process entrypoint。 |
| 错误、连接与清理 | PiServer 错误码和错误序列化已定义；disconnect 不会必然停止 busy runtime，最后 connection 释放且 runtime idle 后可 dispose；PiServer close dispose 所有 live runtime（`packages/server/src/errors.ts:3-21,52-57`; `packages/server/src/sessions.ts:149-159,179-196,353-378`） | adapter 遵循并补充 coding-agent-specific 错误映射/资源所有权；不得另发自己的回收语义。 |

## 适配契约与步骤

### 1. 依赖装配与创建

首版公开入口为 `@earendil-works/pi-coding-agent/server` 的 `createCodingAgentPiServer(options): Promise<CodingAgentPiServerHandle>`（package export `packages/coding-agent/package.json:26-29`；`src/server/index.ts` re-export），直接复用 `@earendil-works/pi-server`，不另造 Host/Session API。Options 的关键公开形状：

```ts
interface CodingAgentPiServerOptionsBase {
  listeners: readonly PiServerListener[];
  maxActiveRuntimes: number; // positive safe integer
  requestGatewayConfig: RequestGatewayConfig; // default and each explicit override: positive finite
  modelRuntime?: ModelRuntime;
  agentDir?: string;
  sessionOptionsForSession?: (session: CreateSessionOptions) => SessionAgentOptions;
  serverOptions?: Omit<PiServerOptions, "listeners">;
}

type CodingAgentPiServerOptions = CodingAgentPiServerOptionsBase & (
  | { sessionStorageDir: string; sessionStore?: never }
  | { sessionStorageDir?: never; sessionStore: CodingAgentServerSessionStore }
);

interface CodingAgentPiServerHandle {
  readonly server: PiServer;
  start(): Promise<PiServer>;
  close(): Promise<void>;
}
```

`sessionStorageDir` 与注入的 `sessionStore` 是严格 XOR：必须且只能提供一个。`listeners` 为必填；`serverOptions` 不能另行覆盖 listeners。`maxActiveRuntimes` 必须为正安全整数；共享 Host `RequestGateway` 的 `defaultMaxConcurrency` 与每个显式 `providers[id].maxConcurrency` override 均须 positive finite，缺省 fallback、0、负数、`Infinity`、`NaN` 一律在开始监听/持久化前拒绝（`request-gateway.ts:33-60`）。每个 Host 注入/建立一个共享 `ModelRuntime` 与一个 gateway；SDK 未注入 gateway 时会逐 Session 创建独立 gateway，故不可依赖 SDK 默认值实现 Host-wide cap。

`SessionAgentOptions` 是 per-session callback 可返回的 SDK options 子集；callback 仅用于装配产品 curated、trusted、遵循 Session-scoped API 的资源，不是 sandbox。类型必须排除 host-owned `cwd`、`configDir`、`agentDir`、`modelRuntime`、`requestGateway`、`requestIdentity`、`sessionManager`、`settingsManager`、`scope`、`model`、`thinkingLevel`、`initialMessages`、`sessionStartEvent`。Host 在合并 callback 返回值后显式写入这些字段，callback 不得覆盖 Host 的身份、存储、共享 runtime/gateway 或首次模型状态；每次 session 应由 callback 返回新鲜的 session-bound loaders/tools/stores。未知或不可信扩展不进入 shared Host，不能声称有 JS sandbox 或自动副作用检测（共同契约 §1、§2、§4；实现接口形状见 `coding-agent-server.ts:16-30,82-104`）。

`CodingAgentServerSessionStore` 的公开接口必须包含并保持下列语义；注入 store 由调用方拥有，assembly 会调用 `acquire()`，但不负责关闭注入对象：

```ts
interface CodingAgentServerSessionStore {
  acquire(): Promise<void>;
  listSessions(): Promise<SessionMetadata[]>;
  create(options: CreateSessionOptions): Promise<{
    sessionManager: SessionManager;
    metadata: SessionMetadata;
    sessionOptions: CreateSessionOptions;
  }>;
  open(protocolSessionId: string): Promise<{
    sessionManager: SessionManager;
    metadata: SessionMetadata;
    sessionOptions: CreateSessionOptions;
  }>;
  release(protocolSessionId: string): Promise<void>;
  commitCreate(protocolSessionId: string, effectiveSessionOptions: CreateSessionOptions): Promise<void>;
  discardFailedCreate(protocolSessionId: string): Promise<void>;
}
```

`create/open` 返回的 `sessionOptions` 是首次创建或 reopen 的 durable 初始化选项，至少保留 PiServer durable ID、cwd、name、model、thinkingLevel；`commitCreate` 持久化成功初始化后的 effective name/model/thinking/cwd 并将 create 标记 committed；`discardFailedCreate` 只能移除本 owner 中尚未 commit 的新建会话；`release` 只释放当前 runtime/file-owner lease，不删除 committed manifest 或 JSONL。首版 default store 为 `FileCodingAgentServerSessionStore`，未注入时由 assembly 依据 `sessionStorageDir` 创建并拥有，文件实现位于 `packages/coding-agent/src/server/session-store.ts`。Postgres/SQLite `SessionRepo` 不是 coding-agent JSONL `SessionManager` 的替代物。

Assembly 在 `createSession/openSession` 触碰 store 前原子预留一个 active-runtime cap slot；并发中的 reservation 计入 cap。满额时返回现有 protocol `busy` + `details.reason:"active_runtime_limit"`，不排队、不驱逐、不写新 catalog/manifest/JSONL；构造失败退还 reservation，成功 runtime 的 dispose 释放 slot。`createSession` 使用 PiServer 原样分配的 `options.id`，`openSession(id)` 通过 durable store 精确恢复该 ID；`listSessions()` 只列 durable metadata、不启动所有 runtime；`listModels()` 从 Host registry 提供 `ModelMetadata`，产品仍负责授权和角色模型策略。

`createAgentSession()` 的可注入点包括 `modelRuntime`、`requestGateway`、`sessionManager` 等（`packages/coding-agent/src/core/sdk.ts:83-180,266-299`），但共享对象不等于可共享所有权。每个 live runtime 仍独立拥有 AgentSession、SessionManager、ExtensionRunner、scope、配置、事件订阅和清理句柄。

### 2. 身份映射和内部 session tree 操作

PiServer `sessionId` 是协议与官方 PiClient 使用的 durable route identity。V1 在通过 `assertValidSessionId()` 后，将 PiServer 分配的原值同时作为 SessionManager ID，固定映射到该 ID 专属目录/JSONL 文件；snapshot ID 始终返回同一个 durable ID，不能用“最近 session”猜测，也不能在 reopen 时生成替代 ID。任何 format/ID 校验或文件映射不一致都须失败关闭。

默认 `FileCodingAgentServerSessionStore` 在专用 `sessionStorageDir` 下为每个 ID 创建独立 `<root>/<id>/manifest.json` 与固定 SessionManager JSONL 文件。Manifest 至少持有 schema version、`pending|committed` status、SessionMetadata、cwd、固定 session-file path、model 与 thinkingLevel。创建状态按 `new directory → pending manifest + JSONL → AgentSession 初始化成功 → commitCreate 更新 effective options 并标 committed` 前进；只有 committed 记录可列出或 open。Root lock 获取后清理可识别的 pending crash orphan；初始化失败只丢弃尚未 commit 的新建目录，open/runtime 初始化失败不得删除既有 committed 历史。每个新建 root/session directory 与文件须 private；不得自动迁移旧 project sessions 或 legacy session-file mode。

`open()` 返回持久化的 `sessionOptions`，adapter 必须在恢复时用 manifest 中保存的初始/effective model 和 thinking level 重建 Session；模型不可用或 metadata 不一致时显式失败，不以 Host 默认模型静默替换历史会话状态。`listSessions()` 不创建 runtime；`updatedAt` 从对应 JSONL 文件的 mtime 计算，并不早于 `createdAt`，文件缺失时只可回退到 `createdAt`，不能把 manifest 更新时间冒充 transcript 更新时间。

`CodingAgentRuntime` snapshot 的 `revision` 以该 JSONL SessionManager 恢复后的当前 entries 数量初始化，并在持久 entry append 后更新为当前 durable entries 数量；close/reopen 同一 durable ID 时应从同一历史得到同一当前 revision，而不是重置为 0。snapshot 的 transcript、phase、model、thinking、timestamps 与 queued steer 均来自恢复后的该 session，不得串到其他 runtime。

协议首版只支持 list/create/attach/detach/prompt/steer/abort/set_model/set_thinking（`packages/protocol/src/schemas.ts:291-324`），没有同一 session 的 new/fork/switch/import replacement command；adapter 不得通过 runtime 或扩展 callback 暴露这些替换操作。若扩展入口仍可达，必须绑定明确拒绝 handler，不能继承 `ExtensionRunner` 未绑定 command callbacks 的 `{ cancelled: false }` 成功形状 no-op（`packages/coding-agent/src/core/extensions/runner.ts:342-345,484-502`）。若未来真实消费者要求 replacement，须另行实现 00 §4 claim-before-mutate preflight/reservation，失败时保留当前 Session 且目标无写入。

### 3. 命令映射和返回语义

当前 protocol command 集合只有 list/create/attach/detach/prompt/steer/abort/set_model/set_thinking（`packages/protocol/src/schemas.ts:291-324`）。这是本设计允许对外承诺的 command surface；并非 legacy JSONL RPC 的所有命令都已覆盖。

| 现有 protocol 行为 | coding-agent 映射要求 | 若漏掉/错误映射 |
|---|---|---|
| `prompt({sessionId,text})` | 调对应 AgentSession 的 `prompt(text)`；协议成功 response 表示已被 coding-agent 接受/命令调用成功，并返回 authoritative snapshot，不伪装成模型 turn 已完成。AgentSession.prompt 是 async void（`packages/coding-agent/src/core/agent-session.ts:2583-2595`）。 | 把 acceptance 当 turn completion 会使消费者误判；运行后异步失败需经 runtime error/event channel 处理，而非丢失。 |
| `steer({sessionId,text})` | 调同 session `steer(text)`；AgentSession 将输入加入当前 turn 后执行（`packages/coding-agent/src/core/agent-session.ts:2929-2941`）。 | 错用 prompt 会让并发输入与正在运行的 turn 语义改变；漏事件会让 client UI 无从知道后续进展。 |
| `abort({sessionId})` | 仅 abort 并等待对应 AgentSession idle；AgentSession.abort 会 abort 并 waitForIdle（`packages/coding-agent/src/core/agent-session.ts:3495-3511`）。 | 必须确保 A 的 abort 不触碰 B，完成 snapshot 反映 idle/最终 transcript。 |
| `set_model`, `set_thinking` | 更新目标 session 的模型/思考等级，snapshot 返回该 session 状态；无该 model 或非法等级按 protocol structured error 返回。 | 不能把角色选择写入共享的有状态 “current session” 或另一角色设置。 |
| `attach/detach` | 复用 PiServer lease/connection attach；adapter `dispose()` 仅在 PiServer 决定 runtime 无连接、idle 回收或 close 时执行，不应把任一 client lease dispose 当成关闭整个 service。 | detach 一个共享 client 不得影响其它连接/lease；busy detached session 保持运行语义按已有 server 生命周期，不额外杀进程。 |
| `list/create` | 调 service 元数据/创建路径，server 负责对外 session IDs、attached 状态和协议 response。 | 各产品若另建 ID 或手工分流，将重新引入重复 session registry。 |

`PiSessionRuntime` 没有显式 “turn complete” response；当前 PiClient 的 snapshot 是 authoritative、progress 是 transient UI hint（`packages/client/README.md:28,34`）。因此 client 行为应基于事件/snapshot，而不能依赖一个新造的结束回调。

### 4. 事件映射与订阅

1. adapter 在 AgentSession 创建后调用 `session.subscribe(listener)`，保存其独立 unsubscribe handle；该 API 每个订阅返回准确移除自身 listener 的函数（`packages/coding-agent/src/core/agent-session.ts:1369-1383`）。runtime `subscribe()` 向 PiServer 注册回调，`dispose()` 先阻止新事件、unsubscribe，再清理 AgentSession。
2. `snapshot()` 从同一 AgentSession 当前状态构造 protocol SessionSnapshot，但 `id` 固定用 durable PiServer ID；transcript/tool-call 字段经现有 protocol converter 规范化（`packages/server/src/protocol.ts:16-28`; `packages/session-protocol/src/transcript.ts:21-68`）。未知/不支持的内容不得静默伪造。
3. 可表达的中间 transcript/progress 转成 `PiSessionRuntimeEvent {type:"progress",progress}`，最终状态、queued input、模型/phase变化转成 `{type:"snapshot"}`；PiServer 会将 progress 按 live durable ID 广播，并在 snapshot event 时广播完整 snapshot（`packages/server/src/types.ts:36-50`; `packages/server/src/sessions.ts:275-289,320-330`）。progress 不代替最终 snapshot。
4. 独立 session 的 extension tool execution 只要能表现为现有 transcript/tool progress，走现有通路。Extension 希望 host 弹出交互、request approval、extension command discovery 或私有状态推送时，先列出实际 consumer 场景和协议不可表达证据；当前 server/protocol 未发现通用 extension callback RPC。不得把 legacy RPC 事件逐项照搬为新协议字段。
5. listener 异常须隔离，不可让一个 PiClient subscriber 抛错阻断共享 server state（PiClient 已隔离 subscriber exceptions，`packages/client/README.md:42`）；adapter 对自身 observer/callback 错误同样不得破坏其它 runtime。

## 所有权、副作用、错误与并发边界

### 所有权

- Assembly owner 创建并管理共享 ModelRuntime/RequestGateway；PiServer 拥有各 `PiSessionRuntime` 并在 close 时 dispose 所有 live runtime（`packages/server/src/sessions.ts:179-196`）。`createCodingAgentPiServer()` owner handle 是生命周期权威入口；不得因一个 runtime dispose 关闭共享 gateway/model runtime。
- 每个 session runtime 独占其 AgentSession、SessionManager/session-file writer、ResourceLoader/ExtensionRunner/context、scope、event subscriptions、运行/abort 与 side-request 生命周期。`AgentSession.dispose()` 清理其自己的 side requests、agent、监听与 session resources（`packages/coding-agent/src/core/agent-session.ts:1394-1429`）。
- 内置 FileStore/root lock 归 factory 返回的 owner handle；注入的 `sessionStore` 仍由调用方拥有。Factory 先 acquire store/root ownership，再将 owner handle 交给 caller；caller 调 `handle.start()` 才启动 PiServer/listeners，不能绕过 owner 直接把 `handle.server.close()` 当成完整 Host shutdown。
- `handle.close()` 幂等并等待 `PiServer.close()` 与所有 runtime disposals / session lease releases；确认 runtime reservation/lease 已清空后，才关闭 assembly-owned FileStore 并释放 SQLite root lock。若 server/runtime cleanup 失败，close fail-closed 并保留 root lock，不允许第二 owner 趁未完成写入进入。注入 store 不由 handle close。`RequestGateway`/`ModelRuntime` 无未公开的通用 dispose 保证；只能释放 assembly 所拥有的引用，不声称关闭不可见的底层 transport。

### 重要的跨 Session 进程级风险

这些是隔离实现前的源码风险，不能以“AgentSession 有独立 ExtensionRunner”为由忽略。当前 Host-backed Sessions 已用 per-session `PromptRegistryScope`隔离slot/macro、scope-local memory renderers，以及 `AgentSessionScope`协调的 ModelRuntime provider owners；scoped reload不调用 `resetApiProviders()`。pi-ai compat registry仍为process-global，但Host-supported Extension API不暴露其写入口；任意raw process-global mutation属于unsupported extension行为并需独立Host/进程（`20-shared-runtime-isolation-concurrency.md`）。因此 adapter 的受支持隔离路径已实现；不声称对任意JS globals提供sandbox。

#### 原始 baseline 风险（已由20定义实现边界）

最初源码依据：slot/macro 模块级Map、memory renderer捕获session store、pi-ai compat registry为process-global（`00-共同上下文.md:27-29,73-75`；`packages/coding-agent/src/core/prompt-preset/slot-registry.ts:10-24`, `core/prompt-preset/macro-engine.ts:8-24`, `packages/coding-agent/src/core/agent-session.ts:5012-5017,5036-5061`, `packages/ai/src/compat.ts:126-158,191-213`）。当前Host使用scoped替代路径；不受支持的raw compat操作不属跨Session隔离验收。

### 错误与并发

- protocol/server 已有结构化错误码，含 `busy`；`PiServerError` 可携带安全 JSON details，未知内部错误使用泛化 message，不跨线泄漏原始异常（`packages/protocol/src/schemas.ts:269-284`; `packages/server/src/errors.ts:3-27,52-57`; response mapping `packages/server/src/server.ts:261-290`）。**只对已启动 PiServer 收到的 create/open capacity拒绝**使用协议 `busy` + `details.reason:"active_runtime_limit"`；root ownership冲突发生在listener启动前，应由assembly返回本地 typed `busy` startup error（`reason:"root_owned"`），绝不是向不存在/未启动的client连接发送协议响应。两者均不得增加协议错误码。
- 还需复用 `not_found`、`session_locked`、`invalid_request`、`not_implemented`；文件缺失→not_found，durable ID/file冲突→session_locked，非法参数/snapshot→invalid_request，未支持操作→not_implemented；unexpected错误保留日志 cause，对client返回通用 internal。
- `createSession/openSession` 必须先原子预留一个 live-runtime capacity slot（总数不超过 positive finite `maxActiveRuntimes`），满额时抛协议 `busy/details.reason:"active_runtime_limit"` 并不创建/更新catalog或JSONL，不排队、不驱逐attached session；失败的构造/reopen须退还reservation，成功runtime dispose时释放slot。catalog条目数不是active数；server本身已负责同 ID acquire single-flight（`packages/server/src/sessions.ts:213-273`）。
- `FileCodingAgentServerSessionStore` 在监听器开始接收请求前，以 `sessionStorageDir` acquire root ownership；同root第二PiServer assembly在本地以typed busy startup error拒绝，不触碰记录也不启动listener。close顺序：PiServer close并等待所有runtime dispose → 关闭assembly-owned catalog/storage、释放root ownership和Host引用；注入store由调用方拥有。
Root ownership is REQUIRED for the built-in file store. The selected mechanism is a `node:sqlite` lock database in the dedicated `sessionStorageDir`: acquire ownership by holding a real write transaction (`BEGIN EXCLUSIVE` after an actual write) for the host process lifetime, not merely issuing `BEGIN`. The transaction must remain open until orderly close; process death releases it through SQLite. A competing assembly must fail locally with typed `busy` (`reason:"root_owned"`) before starting its listener or touching session records. `proper-lockfile` stale reclaim/`onCompromised` alone is insufficient and is not the selected mechanism.
Default FileStore/root lock只接受经平台识别的同机本地持久卷：Linux allowlist ext4/xfs/btrfs/zfs；macOS apfs/hfs/ufs；Windows fixed local volume且filesystem为exfat/fat/fat32/ntfs/refs。明确排除tmpfs、overlay、remote/shared/network、UNC、removable/unverified及unknown filesystem。Root ownership以`node:sqlite`真实未提交写事务持有至owner close/进程死亡。本地WSL工作区ext4 process-lock tests 2/2通过；CI定义了Ubuntu/macOS/Windows matrix但尚未运行，不能声称原生三平台已验证。
- 一个 session 的事件 callback、异常、abort、dispose 只能影响其 runtime。注意现有 fatal runtime error 会关闭所有 attach 了该 session 的 connections（`packages/server/src/sessions.ts:292-300`）；若这些 connections 同时 attach 了其它 sessions，其它 runtime 不会因此终止，但客户端连接及那些 session 的 attachments/events 也会断开，需按 PiClient reconnect/reattach 语义恢复。command-local validation/temporary errors应由 request response返回，不要误触 fatal terminate。
- Client disconnect 后，PiServer disconnect 释放 connection membership；runtime 仅无连接、operation 且 idle/terminal 时才回收。PiServer close 才是对所有 live sessions 的显式全量 dispose（`packages/server/src/sessions.ts:149-159,179-196,353-378`）。

## SDK 嵌入、child process、transport 取舍

| 选择 | 已有栈事实与收益 | 边界 / 建议 |
|---|---|---|
| 在 Node 应用进程内嵌入 coding-agent service + PiServer | coding-agent 包公开 `@earendil-works/pi-coding-agent/server` 的 `createCodingAgentPiServer()`；调用者提供 listeners/options，然后显式调用 owner handle `start()`/`close()`。外部 TypeScript/JavaScript 消费者使用既有官方 `@earendil-works/pi-client` `PiClient`、Pi protocol 和选定 transport；不另造 client。 | 推荐首个 adapter 接入方式；不是“同进程一定更快/更省”的测量结论。listener/auth 仍由部署方负责；Host shared-runtime / curated trusted-extension 限制仍生效。 |
| 独立 PiServer child process | 同一 adapter/factory 可由一个 Node 进程装配承载多个 Pi sessions，多个 PiServer 进程可作为独立故障域。 | 是部署/故障域选择，不是另一套协议或每角色一个 Pi 子进程。当前没有 standalone CLI/独立 server entrypoint；若消费者需要，另加标准入口并复用该 factory。 |
| 现有 Pi protocol + Unix/network ordered byte transport | Protocol 与官方 `PiClient` 都已 transport-neutral；复用已有 Node/TypeScript client SDK 与 PiServer listeners。 | UDS 依赖本机文件权限；网络 listener 必须在协议握手前完成鉴权。具体 transport/deployment 属于消费者。 |
| legacy coding-agent stdio JSONL RPC | `rpc-mode.ts` 仍是 legacy CLI 单 `AgentSessionRuntime` 入口，而非上述 PiServer adapter。 | 继续保留既有兼容路径；不把它升级成新 Host/server/client，不改为本轮前置条件。 |

首阶段消费入口是嵌入 Node 的 factory + 既有 PiServer listener + 官方 PiClient；无要求新造 client，也不以“可构造 server”的 demo 代替完整 durable mapping/隔离验收。Rivet 本轮保留 legacy path，不要求 full cutover 或功能等价。

## Python client 与 NeonRP

本轮正式消费方是 Node/TypeScript `PiClient`（既有 `@earendil-works/pi-client` SDK）；不交付第一方 Python SDK，也不承诺 NeonRP 直接接入。Protocol 跨语言不等于 Python SDK 已存在；未来如 Python/NeonRP 纳入正式支持，应另立范围、提供官方 client/conformance 与维护责任。

## 代码落点

以下是当前工作树源码落点与设计职责对照；coding-agent完整测试/build、Biome与lock checks结果记录于40文档§执行状态。原生macOS/Windows runner及性能benchmark尚未验证。

| 落点 | 职责 |
| `packages/coding-agent/src/server/index.ts` 与 `packages/coding-agent/package.json:14-29` | 当前工作树公开 `@earendil-works/pi-coding-agent/server`，re-export `createCodingAgentPiServer`、handle/options/session callback 与 FileStore/store error 类型；package 直接依赖 `@earendil-works/pi-server`（package.json dependencies）。消费方不得从 internal source path 导入。 |
| `packages/coding-agent/src/server/coding-agent-server.ts` | Adapter assembly 与公开 `CodingAgentPiServerOptions`、`CodingAgentPiServerHandle`、`SessionAgentOptions`；要求 listeners、cap、gateway config 与 sessionStorageDir/store XOR；创建 `PiServerService`、Host gateway、每-session runtime，cap admission、model restore、snapshot/revision 与 start/close lifecycle。`sessionOptionsForSession` 只返回非 Host-owned SDK options，且仅供 curated trusted per-session resources。 |
| `packages/coding-agent/src/server/session-store.ts` | `CodingAgentServerSessionStore` / `FileCodingAgentServerSessionStore`；专用 root 中 per-ID manifest + JSONL、pending/committed lifecycle、初始/有效 sessionOptions、`commitCreate`、`discardFailedCreate`、`updatedAt`、writer lease 与 SQLite root ownership。Old project sessions/legacy session file mode 不自动迁移。 |
| `packages/coding-agent/src/server/host-root-lock.ts` | 同机本地持久 filesystem 识别与 fail-closed root ownership；SQLite 写事务在 owner 生命周期保持。平台 allowlist 与 exclusions 见本设计 §“所有权、副作用、错误与并发边界”；Linux/macOS/Windows 验收状态必须按真实运行报告。 |
| `packages/server/src/types.ts:27-60` / `packages/server/src/sessions.ts:48-146,213-330` | 复用既有 `PiServerService`/`PiSessionRuntime`、协议 routing/event/lifecycle；除实现证明表达能力不足外不重画 protocol/server。 |
| `packages/coding-agent/README.md` / server integration docs | README已说明Node consumer subpath、listener、store XOR、owner start/close及durable root限制；当前验证结果见40文档，不据文档或源码存在宣称原生三平台通过。 |
| `packages/coding-agent/src/core/sdk.ts:83-180,266-299,422-427`; `packages/coding-agent/src/core/agent-session.ts:1369-1429,2583-2595,2929-2941,3495-3511`; `packages/coding-agent/src/core/request-gateway.ts:33-60,104-170` | 复用 SDK 注入点、per-session AgentSession 与 Host Gateway config validation；不复用 `AgentSessionRuntime` 单活跃 session facade 充当 PiServer session registry。 |
| `packages/coding-agent/README.md` / server integration docs | 文档需给 Node consumer 可复制的 subpath、listener、store XOR 与 owner start/close 用法；不得把本设计/源码落点描述成已经通过验证。 |

## 与当前状态的差异 / 建议阶段

1. **当前工作树形态**：PiServer/Protocol/Client为既有底座，coding-agent adapter、FileStore、package subpath与owner lifecycle已实现；完整coding-agent suite 301 files passed / 6 skipped（2733 tests passed / 52 skipped），package build/targeted Biome/shrinkwrap checks passed。Linux WSL ext4 process-lock test 2/2 passed；原生macOS/Windows runner未执行。`SessionRepo`不替代coding-agent JSONL。
2. **Stage C — 独立产品/协议范围**：未来若 Rivet 要 full cutover，另行评估 `context_request`、`orchestration_request`、`getTree`、`navigateTree` 等能力；它们不是本轮 Host adapter 的前置条件或验收。standalone Node process entrypoint、Python SDK/NeonRP 支持亦按明确消费者另立范围。

## 验收测试（用户可见行为）

以下是consumer-visible acceptance checklist；本轮已运行完整coding-agent suite、package build及本地Linux/Wsl ext4 lock tests，实际证据见40文档。覆盖不等于所有部署场景均验收：原生macOS/Windows runner、产品层listener授权与性能矩阵仍须单独验证。测试须面向真实adapter + PiServer + 官方PiClient，不测纯forwarding/mock echo：

1. 同一 PiClient connection 创建/attach Session A、B；A prompt 后只有 A transcript/progress变化、B session file/context/model保持原样；B command不会被 A 的 event subscription收到。
2. 断开最后一个 client connection、等待 session idle 后重新 attach 相同 PiServer ID；恢复的是相同持久化 conversation；snapshot ID 不变且与 file mapping对应。重启PiServer/service后同样成立。
3. V1 explicitly rejects same-session new/fork/switch/import and any indirect extension action; tests verify unsupported is observable, never `{ cancelled: false }` success. If future support is added, use PiClient-visible claim-conflict behavior to prove source remains usable and target file untouched before teardown/write.
4. A running时abort A，B同时继续生成/保持活动；A最终snapshot为idle，B不受cancellation/dispose影响。A runtime failure不得销毁B runtime；但共享PiClient connection若attach A/B会被A fatal error关闭，两边attachment/events都应可观测断开并可重新attach。Transient command errors仅对应request失败。
5. 两个并发 attach/open 同一 durable ID 只产生一个 AgentSession/file writer；不同 ID 不共享 `SessionManager`，文件owner冲突返回明确 `session_locked/busy`。
6. active runtime达到 `maxActiveRuntimes` 时，额外 create 与 open 都返回 `busy/details.reason=active_runtime_limit`，且拒绝 create不留下catalog条目或JSONL文件；attached session不中断、不被驱逐；detach/dispose释放slot后，同一 durable ID可open。
7. 两个 host process 争用同一 `sessionStorageDir`：live/paused owner持有 root ownership 期间，第二 assembly 在 session records/listener 启动前以 typed 本地 `busy/reason=root_owned` 失败、不发 protocol response；clean close/kill 后新 owner 可恢复。关闭遇到 runtime disposal/lease cleanup error 时必须保留 root lock，不能释放后允许第二写者。
8. Root ownership acceptance须在Linux/macOS/Windows支持的同机本地持久filesystem分别覆盖竞争、paused owner不被接管、进程死亡后SQLite锁释放与恢复；tmpfs/overlay/remote/shared/network/UNC/removable/unverified/unknown均fail closed。本地WSL工作区ext4 process-lock tests 2/2通过；macOS/Windows CI与原生平台测试尚未运行。仅stale mtime reclaim / `onCompromised` callback不满足要求。
9. `handle.start()` 才启动 PiServer listeners；`handle.close()` 等待 PiServer 与 owned runtimes/file leases 清理后关闭 built-in store 并释放 root lock。Caller-injected store remains caller-owned. create/open 与 close 竞态不得在 closing 后发布新的 live runtime；shutdown failure 保持 fail-closed root ownership。
10. 对不同角色不同preset、memory store和supported `ModelRuntime` provider registration：并行运行及A reload时B的slot/macro结果、memory数据、provider列表/请求能力不受串扰。pi-ai raw compat API-provider写接口不属于Host-supported extension contract，不声称跨scope协调；含此类mutation的扩展须放入独立Host/进程。
11. 支持现有 protocol 的模型/思考等级、steer、progress/final snapshot：客户端可通过 PiClient观察一致结果；API已支持的但 adapter不能正确实现者给可识别 structured error，不落回产品端私自生成 JSONL。
12. 现有官方 `PiClient` 可通过 network/custom transport 与 PiServer交互；网络 transport在握手前完成鉴权，错误 peer不能进入协议态。实际 listener security实现需由部署层验收。
13. 若发布 child-process entrypoint，验证一个进程承载多个 AgentSession、不按角色数启动独立 Pi child process；独立 PiServer仍可部署形成故障域。性能收益必须由 1/10/25/50/100 idle/active基准数据证实，不能仅凭进程模型宣称。
14. Assembly构造前验证 RequestGateway `defaultMaxConcurrency` fallback 与每个显式 `providers[id].maxConcurrency` override：缺失fallback、fallback或override为0/负数/`Infinity`/`NaN`均显式拒绝，不启动listener、不创建session/catalog；合法positive finite fallback用于无override provider，合法positive finite override仅限对应provider，不存在因`0`或省略配置而绕过Host provider并发上限的路径。`maxActiveRuntimes` 同时拒绝非正数、非整数与超出 safe integer 的值。
15. 对新建 session，验证 per-session manifest 从 `pending` 仅在 `commitCreate` 后变 `committed`；failed create 清理 pending，不影响既有 committed record。reopen 使用 manifest 保存的 model/thinking/cwd 与固定 JSONL 路径；model 不可用时显式失败，不回退到 Host default。`updatedAt` 与对应 JSONL mtime 一致且不早于 `createdAt`。
16. 正常 detach/reopen 与 server restart 后 snapshot revision 从 durable JSONL entries 恢复为同一当前值，而非重置为 0；追加 entry 后 revision 更新。`sessionOptionsForSession` 仅能提供 `SessionAgentOptions` 中允许的字段，试图用 callback 值替换 Host-owned identity/storage/model/gateway/scope 不得改变最终 AgentSession 配置；回调只接收产品 curated trusted per-session resources。

底层 `packages/server`/`protocol`/`client` 自有 conformance suites 只证明底层 contract，不替代上述 coding-agent adapter consumer-visible 测试（共同契约 `00-共同上下文.md:118-123`）。

## 已知冲突 / 需修订的上位文档

- `plan/high-concurrency-optimization.md:23-37` 旧提案要求在 legacy JSONL 新加 sessionId、registry、create/destroy/list命令、daemon/UDS/WebSocket；generic server/protocol/client 已落地，故这些应标为被现有 package 替代。保留单进程多 AgentSession 的性能目标和 child process 故障域，不复制协议/server/client。
- `plan/multi-agent-design-assessment.md:40-56,186-231` 旧 Phase 1b 的 `SessionRegistry`/RPC command扩展和“daemon transport以后再做”前提已由 `packages/server`/`protocol`/`client` 改变；评审后应回写为 adapter/ID mapping/共享风险仍缺。其关于 gateway starvation/per-session identity 的问题（`:58-64`）仍有效，应由20 owner展开，而非本模块自造调度实现。
- `plan/multi-agent-infrastructure.md:15-18,40-46,111-133` 的“无消费者不做”不再适用；Rivet是Node消费场景，但异构角色隔离价值仍成立（冻结契约 `00-共同上下文.md:109-110`）。
- `plan/affiliated-session.md` 的父子上下文继承/共享写回与通用独立 PiServer sessions 正交，本适配不把它设为必须功能；如 session mapping改变其已有假设，由该方案维护者另行评估。
- legacy `packages/coding-agent/src/modes/rpc/{rpc-types.ts,rpc-mode.ts,rpc-client.ts}` 继续服务既有单 session stdio CLI RPC；新 adapter不将其 `session`闭包升级为并行 host、不扩展它为新client。CLI兼容或迁移仍应另作决定。

## 产品 / 平台待验证边界

1. **Durable ID/storage**：v1固定protocol ID→同ID SessionManager tree/file；default store以dedicated `sessionStorageDir/<id>/manifest.json`与per-session JSONL目录保存`pending|committed`、cwd、sessionOptions和固定path；重启清除合法pending crash orphan。`commitCreate`持久化effective model/thinking/name；reopen恢复保存选项；`updatedAt`取JSONL mtime；旧project sessions/legacy session-file不迁移。Root ownership是node:sqlite真实未提交写后的`BEGIN EXCLUSIVE`进程生命周期事务；支持目标Linux/macOS/Windows本地持久FS，tmpfs/overlay/remote/shared/unknown fail closed。Linux WSL ext4 lock tests 2/2 passed；原生macOS/Windows未验证。caller-injected store由caller持有，built-in由handle于runtime清理后关闭。 |
2. **Session metadata与授权**：PiServer generic `listSessions()`是service持久metadata，产品负责按租户/角色授权list/create/open；listener认证须在进入协议态前完成。
3. **后续 Rivet 完整迁移（非本轮待拍板项）**：范围已拍板为不做 full cutover。Rivet 暂留 legacy；本轮不扩展 `context_request`、`orchestration_request`、`getTree`、`navigateTree`，不声称现有 PiServer/PiClient 已能表达这些能力或 Rivet 已功能等价。若将来需要 full cutover，须另立独立范围评估相应 callback correlation、tree/navigation 协议增量及迁移验收。
4. **Host边界与插件**：Host-supported path使用scoped prompt/memory/ModelRuntime provider机制；任意第三方直接改JS globals/module state或raw pi-ai compat API provider registry不受隔离/sandbox保证，超出支持边界的插件须拒绝或放入独立Host。
5. **PiServer release stability**：当前server README仍标Experimental（`packages/server/README.md:1-3`）；版本兼容与coding-agent adapter正式export/release边界由package owner决定。
6. **独立 PiServer进程入口**：目前无standalone CLI（`packages/server/README.md:38`）。首阶段推荐embedded Node assembly，若要成为语言无关平台服务，需要另加运行入口及部署/认证契约；Pi protocol可复用。
7. **Python/NeonRP 支持（非本轮交付）**：本轮不交付 Python SDK，不保证 NeonRP 可直接接入。若未来将其纳入支持消费者，需提供官方 client/conformance，而不是让其手写 CBOR/lease 逻辑。
8. **验收规模基准**：100 roles是负载动机非性能承诺；角色active比例、provider速率与环境由40的基准固定并报告。
