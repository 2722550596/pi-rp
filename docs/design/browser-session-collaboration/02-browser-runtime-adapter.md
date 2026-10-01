# Browser runtime adapter：浏览器执行端与跨进程 runtime proxy

## 1. 一句话定位

为 Pi-rp 定义一条**浏览器执行者出站通道**，并提供 browser-engine 执行端 driver 与服务端 runtime proxy：执行端把本地 `AgentSession` 的快照、进度和错误上行，proxy 把既有 Pi runtime 命令下行并实现进程内 `PiSessionRuntime`；平台 broker 负责认证、把执行者绑定到会话、路由和持久化。

## 2. 需求对照

| 效果 / 解法 | 设计回应 | 需求原文出处 |
|---|---|---|
| 浏览器本地运行 Pi，同时多人共同参与同一个会话 | browser executor driver 连接平台提供的出站 transport；服务端 proxy 将其转换为现有 `PiSessionRuntime`，让 PiServer 继续服务多个参与者连接。 | `00-需求原话.md:5-9,19-24`，效果 1、2。 |
| 不为每个活跃用户/会话在平台常驻 Pi Node 执行进程 | 执行计算和本地 session 仍在 browser harness；Pi-rp 提供可被平台部署/绑定的通道和 proxy 抽象，不运行浏览器端 PiServer。 | `00-需求原话.md:7,19-24,43-47`；补充决策明确选 Pi-rp 定义执行者出站通道。 |
| 复用参与者侧既有协议，而不是把 Client 当成执行者 | 参与者沿用 PiClient / pi-protocol；执行者有独立角色、方向与 runtime-host messages，可以复用现有 length-prefixed CBOR framing/codec 底层。 | `00-需求原话.md:11,28-34,43-47`；`01-共同上下文.md:12,38-45`。 |
| 只做 Pi-rp，不做下游平台服务、UI、认证或权限 | Pi-rp 定义通道、browser driver、server proxy 与接入契约；平台提供 authenticated transport 和 broker，实施会话/执行者绑定及路由。 | `00-需求原话.md:7,13,19-24,34-35,43-47`；效果 4、解法 4。 |

## 3. 现有契约与职责边界

- `createPiHarness()` 返回浏览器本地 `AgentSession`、`prompt`、`abort`、`dispose`；源码明示“v1 无 remote 入口面”，没有建立 PiServer 或 runtime 远程控制。`packages/browser-engine/src/assemble.ts:186-201,351-393,544-599`。
- `PiSessionRuntime`/`PiServerService` 是 server 内进程调用的接口。Server 直接向 runtime 调方法、订阅事件，不是序列化后的跨进程对象。`packages/server/src/types.ts:36-60`、`packages/server/src/sessions.ts:90-117,248-317`。因此单纯结构类型适配不能让浏览器执行者跨进程接入。
- PiServer 已有 participant 协议支持多客户端 attach 同一个 runtime，并广播 snapshot/progress。`packages/server/src/sessions.ts:248-263,276-317`。PiServer 的 `PiSessionRuntime` 适合成为执行者 proxy 的**server-side 对接端**，不承担浏览器 wire protocol。
- PiClient 的 `ByteTransportFactory` 提供一条出站、有序字节通道抽象；创建 transport 时接收 data/close/error handlers，且声明 transport authenticated。`packages/client/src/transport.ts:1-18`。Browser package 已把 `@earendil-works/pi-client` 列为 peer dependency，但该事实本身不提供 executor driver。`packages/browser-engine/package.json:41-50`。
- Pi protocol 的 framing/codec 是独立模块：`encodeFrame` 使用 4-byte big-endian 长度头，`FrameDecoder` 增量解 chunk；codec 对 CBOR 与协议值校验并提供 encode/decode。`packages/protocol/src/framing.ts:1-18,27-38,57-70`、`packages/protocol/src/codec.ts:1-16,41-80`，入口从 `packages/protocol/src/index.ts:1-4` 导出。
- 但现有 `ClientMessage` 仅 hello/request，`ServerMessage` 是 participant response/event；没有 executor register、服务端命令下发、executor snapshot/progress/error uplink。`packages/protocol/src/schemas.ts:384-410,422-435`。`PiClient` 连接逻辑只发送 client hello/request 并接收 server hello/response/event。`packages/client/src/connection.ts:101-117,134-160,162-204`。
- Browser 的本地事件/命令能力已有基础：AgentSession 支持 prompt/steer/abort、model/thinking 设置、事件订阅；其扩展事件比远程协议标准 transcript 丰富。`packages/coding-agent/src/core/agent-session.ts:276-323,1369-1384,2586-2592,2937-2941,3498-3504,3603-3627,3712-3736`。

## 4. 候选设计比较与推荐

### A. 只将 AgentSession 包装成 PiSessionRuntime

本地可完成命令/事件类型映射，但 PiSessionRuntime 仅是 PiServer 同进程对象。`packages/server/src/types.ts:42-52`、`packages/server/src/sessions.ts:90-117`。跨过 browser 与 platform server 边界仍缺命令下行与 snapshot/progress 上行通道，用户补充决策已确认必须有跨进程执行者协议。**拒绝其作为完整方案**；可把 browser executor driver 中的本地 command/event adapter 视为其组成部分。

### B. browser-engine 内启动 PiServer / 仿造 participant ByteTransport 端点

会在浏览器进程里实现监听或伪造 server 端点，再用 participant PiClient 反向访问。浏览器不适合监听公网 socket；角色方向也错误，且会重复 client/server protocol。`01-共同上下文.md:12,33,38,42` 明确区分 participant 与 executor。**拒绝**。

### C. 独立 Pi-rp executor 通道 + BrowserExecutorDriver + ServerExecutorProxy（推荐）

Browser通过宿主注入的outbound transport连接平台；Pi-rp server-side `ExecutorSessionBridge`接收平台完成认证/会话绑定后交付的raw `ByteConnection`，负责frame/CBOR decode、executor version/handshake/generation验证、下行命令、上行snapshot/progress/error，并实现`PiSessionRuntime`。握手方向唯一：平台只attach已认证raw连接，不生成、翻译或代理executor协议响应；收到有效`executor_hello`且校验协议/身份后，Bridge才发送`executor_ready`，后续`bootstrap_ack`亦由Bridge产生。平台只认证、绑定、路由与持久化。
复用`pi-protocol` framing/CBOR底层和独立executor schemas/codecs，绝不把executor messages塞进participant `ClientMessage/ServerMessage` union；参与者仍用PiClient既有protocol，PiServer支持多个client attach同一runtime (`packages/server/src/sessions.ts:7-15,264-309`)。`ByteConnection`已有raw ordered connection契约 (`packages/server/src/connection.ts:5-18`)；由Pi-rp bridge直接消费，避免下游复制协议适配。Participant `PROTOCOL_VERSION` 与该通道version/schema均独立；不修改PiClient/participant protocol。
### 必要闭环与非必要增强

| Mechanism | Why this closes a required gap (source evidence) | Explicitly optional / not claimed |
|---|---|---|
| Browser-safe `@earendil-works/pi-session-protocol` | Converter is in Node-only `pi-server` (`packages/server/package.json:8-26,46-52`; `packages/server/src/protocol.ts:231-382`), reducer in coding-agent client (`packages/coding-agent/src/client/transcript.ts:1-100`), summary wrapper in core messages (`packages/coding-agent/src/core/messages.ts:11-24,296-310`). Browser needs the same projection/prefix/reducer without importing server or duplicating behavior. | One shared implementation package, not a product service/UI package; transcript remains an explicit projection. |
| Progress reducer + runtime snapshot materialization | PiServer attach calls `runtime.snapshot()` (`packages/server/src/sessions.ts:66-73,276-281`), while progress is incremental (`packages/protocol/src/schemas.ts:203-231`). Proxy must retain live overlays so a late participant receives running/partial state. | Preserve `TranscriptState` API/semantics; select at attach/reconnect/command/state boundaries, not per token. No unsubstantiated scale claim. |
| Shared-entry arbiter + separate executor schema | `PiSessionRuntime` is in-process (`packages/server/src/types.ts:36-52`); PiServer awaits commands without a mutex (`packages/server/src/sessions.ts:90-117,171-183`); prompt has async preflight (`agent-session.ts:2592-2597`). Separate role/schema supplies executor directions without changing participant unions; one arbiter ensures local/remote shared writes follow the same conflict rules. | Only specified prompt/settings/steer/abort gates; no generic scheduler or AgentSession FIFO change. Raw local mutators remain callable but unsupported in shared mode. |
| Deadlines + generation fencing | PiServer handshake defaults to 5s (`packages/server/src/server.ts:35,387-395`); separate bootstrap waits could otherwise leave ready/acquire promises pending; reconnect must invalidate stale physical IDs while retaining the logical reducer. | Configurable hello 5s/bootstrap 30s; reject pending promises, close/fence that generation, clear timers, close late factory results. No retry/replay, platform lease, or dedupe ledger. |
| Error/byte bounds + attach preflight transaction | Frame decoder caps payload at 16MiB (`packages/protocol/src/framing.ts:5-10`); attach currently adds membership before snapshot (`packages/server/src/sessions.ts:300-307`) and broadcast (`:293-297`); complete request envelope uses actual requestId (`packages/server/src/server.ts:250-278`). | Existing safe `invalid_request`, bounded chunks and per-direction outbound bytes, listener-local exception handling, and atomic attach preflight suffice. No participant schema change, paging, durable command rollback, or generic transaction framework. |
| Remove uplink `sequence` | `ByteTransport` and `ByteConnection` specify ordered byte streams (`packages/client/src/transport.ts:1-18`; `packages/server/src/connection.ts:5-18`); a serial writer preserves frame order and close fences the whole physical generation. | Sequence detects no loss/reordering allowed by this contract. Remove field/counter; rely on stream order and generation fencing, without claiming replay. |
| Remove stable `executorId` | Platform routes authenticated transport by session/binding; generationId is fresh per physical connection. No Pi authorization/runtime contract consumes a stable browser-instance identity (`packages/server/src/connection.ts:5-18`). | BindingId + generationId express the required fencing. No identity invariant beyond that is needed; remove executorId from schemas and host state. |

协议与公共API/实现落点见§5及§9。

## 5. 推荐接口及最小 wire contract

公共 API 与 wire schema 的字段和名称在本设计中定稿，按下列契约实现；不允许实现期另行更名或改变语义。

### Versioning 与 executor handshake

executor 通道 version 独立于 participant `PROTOCOL_VERSION`：`EXECUTOR_PROTOCOL_VERSION = 1`（现有 participant version 为 `PROTOCOL_VERSION = 1`，`packages/protocol/src/schemas.ts:3`；相同整数不代表同协议）。participant 只识别 `ClientMessage/ServerMessage`，两类 peer 的版本兼容独立演进。Wire schemas/codec 位于 `@earendil-works/pi-protocol` 的独立 `executor-schemas.ts` / `executor-codec.ts`，participant message unions 保持不变。
**Participant compatibility:** schema, public `TranscriptState` shape/semantics, and `RemoteSession.subscribe` cadence stay unchanged. The design does not introduce a `session_snapshot_error` participant event or change participant frame cap; oversize uses existing safe `invalid_request`, existing participants continue progress.


```ts
type ExecutorHello = {
  type: "executor_hello"; version: number;
  sessionId: string; generationId: string; // executor schema: sessionId <=128 UTF-8 bytes; generationId is UUID
};
type ExecutorReady = {
  type: "executor_ready"; version: 1;
  sessionId: string; bindingId: string; generationId: string; // sessionId/bindingId <=128 UTF-8 bytes; generationId UUID
};
type ExecutorReject =
  | { type: "executor_reject"; version: 1; stage: "hello"; sessionId: string; generationId: string;
      code: "version" | "invalid_request" | "session_locked"; reason?: "timeout"; message: string }
  | { type: "executor_reject"; version: 1; stage: "bootstrap"; sessionId: string; bindingId: string; generationId: string;
      code: "invalid_request" | "session_locked"; reason: "invalid_snapshot" | "timeout"; message: string }
  | { type: "executor_reject"; version: 1; stage: "snapshot"; sessionId: string; bindingId: string; generationId: string;
      code: "invalid_request"; reason: "invalid_snapshot"; message: string };
Executor schema MUST bound sessionId and bindingId to at most 128 UTF-8 bytes and require UUID-form generationId and commandId (36 ASCII bytes). PiServer participant request IDs are never forwarded as executor commandIds: Bridge creates an independent UUID commandId and maps it internally to the originating facade promise. Thus abort/control frame size has a finite schema-derived maximum.
- `BrowserExecutorOptions.transportFactory` 直接采用 `ByteTransportFactory`；现有 `ByteTransport` 为有序 `send(Uint8Array):Promise<void>` + repeat-safe `close()`，factory 回调 onData/onClose/onError，factory 输出 authenticated channel 由宿主负责。`packages/client/src/transport.ts:1-18`。executor codec 对每个 frame 使用 `DEFAULT_MAX_FRAME_LENGTH = 16 * 1024 * 1024`，不自设第二上限；`packages/protocol/src/framing.ts:5-10,27-38`。

`generationId`标识每次transport generation。Bootstrap: driver hello→平台原样路由→Bridge核验hello后回executor_ready→browser runtime_snapshot→Bridge bootstrap_ack→commands active。平台绝不生成协议响应。若scope=bootstrap的executor_snapshot_rejected，bridge立刻reject该代所有pending `acquireRuntime()`为safe invalid_request，回`executor_reject(stage:"bootstrap",reason:"invalid_snapshot")`并关闭该physical connection；逻辑bridge保留，尚无PiSessionRuntime facade。`BrowserExecutor.ready`立即reject同一`ExecutorBootstrapError`，start函数本身仍同步返回；PiHarness不dispose、local harness remains usable。用户缩小active branch后显式调用`reconnect()`获新transport/generation，平台把raw connection接回同一bridge并重试service acquire；无自动retry、无hang。

### Runtime message schemas

Bootstrap前hello/ready/reject是handshake control；ready后server↔executor frame均含sessionId/bindingId/generationId，host commands有commandId。ByteTransport/ByteConnection为有序字节流，不增加progress sequence字段：frame字节顺序即message顺序；physical close/error丢弃整代，generationId拒绝旧帧。`executor_reject(stage:"bootstrap")`是Bridge明确响应；platform service可报告失败并重试，不留hang。Driver及Bridge分别设置有限deadline：transportFactory/connect默认5s、hello默认5s（依据PiServer现有handshake默认`packages/server/src/server.ts:35,387-395`，均可配置）；runtime bootstrap默认30s（可配置）。任何deadline都拒绝对应ready/acquireRuntime pending promise并映射为固定`reason:"timeout"`及对应stage（transport、hello或bootstrap），fence并关闭该physical generation、清理timer和其pending状态。版本/帧/schema错误使用固定code/reason，不暴露内部cause。若异步transportFactory在连接已超时/取消后才resolve，立即close该迟到transport，不安装为当前generation。超时不dispose逻辑bridge，显式reconnect使用新generation；禁止无界等待。

```ts
type ExecutorRuntimeCommand =
  | { command: "prompt"; text: string }
  | { command: "steer"; text: string }
  | { command: "abort" }
  | { command: "set_model"; model: ModelRef }
  | { command: "set_thinking"; thinkingLevel: ThinkingLevel };

type SnapshotData = Omit<SessionSnapshot, "attached" | "locked" | "revision">;
type ExecutorToHost =
  | { type: "executor_hello"; version: number; sessionId: string; generationId: string }
  | { type: "runtime_snapshot"; sessionId: string; bindingId: string; generationId: string; snapshot: SnapshotData }
  | { type: "runtime_progress"; sessionId: string; bindingId: string; generationId: string; progress: TranscriptProgress }
  | { type: "runtime_command_result"; sessionId: string; bindingId: string; generationId: string; commandId: string;
      ok: true; snapshot: SnapshotData }
  | { type: "runtime_command_result"; sessionId: string; bindingId: string; generationId: string; commandId: string;
      ok: false; error: { code: "busy" | "session_locked" | "not_found" | "invalid_request" | "not_implemented" | "internal_error"; message: string } }
  | { type: "runtime_error"; sessionId: string; bindingId: string; generationId: string;
      error: { code: "invalid_snapshot" | "internal_error"; message: string } }
  | { type: "executor_snapshot_rejected"; sessionId: string; bindingId: string; generationId: string;
      scope: "bootstrap" | "runtime_snapshot"; code: "invalid_snapshot"; encodedPayloadBytes: number; maxPayloadBytes: number; message: string }
  | { type: "executor_snapshot_rejected"; sessionId: string; bindingId: string; generationId: string;
      scope: "command_result"; commandId: string; code: "invalid_snapshot"; encodedPayloadBytes: number; maxPayloadBytes: number; message: string }
  | { type: "executor_close"; sessionId: string; bindingId: string; generationId: string; reason: "disposed" | "session_changed" };

type HostToExecutor =
  | ExecutorReady | ExecutorReject
  | { type: "bootstrap_ack"; sessionId: string; bindingId: string; generationId: string }
  | { type: "runtime_command"; sessionId: string; bindingId: string; generationId: string; commandId: string; command: ExecutorRuntimeCommand }
  | { type: "runtime_close"; sessionId: string; bindingId: string; generationId: string; reason: "replaced" | "disposed" };
```

`MIN_ABORT_CONTROL_BYTES` is exported by the pi-protocol executor codec and derived from the largest encoded abort, snapshot-rejection, or runtime-error control envelope under the identifier bounds above. Browser `maxAbortControlBytes` MUST reserve one full executor frame plus this control allowance so an executed abort can always return its current snapshot (or a small rejection); the bridge reserve MUST be at least this constant. Constructors reject smaller or invalid bounds before starting/attaching. Total minimum is one full frame plus that reserve.

Snapshot size is measured as the complete participant frame, not only inner `SnapshotData`. Browser sends discriminated `executor_snapshot_rejected`: bootstrap/runtime_snapshot variants omit commandId; command_result requires it and Bridge rejects only that matching pending command. If that ID is unknown/stale, ignore the result as late; the operation may already have executed, and neither side retries/replays it. Bridge marks snapshot unavailable only for bootstrap/runtime-wide rejection, not a single command result. It also preflights the normalized participant `session_snapshot` event using `maxParticipantFrameLength`; PiServer checks actual attach/command response envelope/request id. Oversized snapshot response returns existing `invalid_request` with `invalid_snapshot` message; async overlimit `session_snapshot` event is suppressed without closing participant connections. No new participant error event/schema/version is added. Platform `PiServerService` owns durable unavailable status; existing attached clients continue progress.
No snapshot paging/fragments: an active-branch projection above the effective maximum (16MiB by default) cannot attach/bootstrap/reconnect until branch selection/retention reduces it. A command already executed whose final snapshot no longer fits returns identifiable `invalid_snapshot`/invalid_request and may have completed; no rollback/exactly-once claim.
The `runtime_command` union intentionally reuses existing `ModelRef`, `ThinkingLevel`, `TranscriptProgress`, and `SessionSnapshot` data shapes while excluding participant-only list/create/attach/detach; current sources are `packages/protocol/src/schemas.ts:203-231,241-256,291-324`. Executor version, participant `PROTOCOL_VERSION`, and all message type tags remain distinct. Participant `ServerEventSchema` and `RemoteSessionState` remain unchanged; overlimit errors use existing PiServer command/attach invalid_request response.

### Construction APIs

```ts
export interface BrowserExecutorOptions {
  readonly transportFactory: ByteTransportFactory;
  readonly sessionId: string;
  readonly harness: PiHarness;
  readonly flowControl: {
    readonly maxPendingCommands: number; // positive safe integer >=2 ordinary request slots; one abort slot reserved
    readonly maxQueuedOutboundBytes: number; // >= MAX_EXECUTOR_INBOUND_CHUNK_BYTES + maxAbortControlBytes; total includes reserve
    readonly maxAbortControlBytes: number; // Browser >= MAX_EXECUTOR_INBOUND_CHUNK_BYTES + MIN_ABORT_CONTROL_BYTES
  };
  readonly timeouts?: ExecutorSessionTimeouts;
  readonly onError?: (error: Error) => void;
}
export interface ExecutorSessionTimeouts {
  readonly connectTimeoutMs?: number; // 5_000 default; ByteTransportFactory bound
  readonly helloTimeoutMs?: number; // 5_000 default; PiServer handshake reference
  readonly bootstrapTimeoutMs?: number; // 30_000 default; host may extend
}
export interface BrowserSessionCommands {
  prompt(text: string): Promise<void>;
  steer(text: string): Promise<void>;
  abort(): Promise<void>;
  setModel(model: ModelRef): Promise<void>;
  setThinking(level: ThinkingLevel): Promise<void>;
}
export interface ExecutorBootstrapError extends Error {
  readonly stage: "transport" | "hello" | "bootstrap" | "snapshot";
  readonly code: "version" | "invalid_request" | "session_locked";
  readonly reason?: "invalid_snapshot" | "timeout";
}
export interface BrowserExecutor {
  readonly commands: BrowserSessionCommands;
  readonly ready: Promise<void>;
  reconnect(): Promise<void>;
  dispose(): Promise<void>;
}
export function startBrowserExecutor(options: BrowserExecutorOptions): BrowserExecutor;

export interface ExecutorSessionBridgeOptions {
  readonly sessionId: string;
  readonly bindingId: string;
  readonly maxPendingCommands: number;
  readonly maxQueuedOutboundBytes: number; // >= MAX_EXECUTOR_INBOUND_CHUNK_BYTES + maxAbortControlBytes
  readonly maxParticipantFrameLength?: number;
  readonly timeouts?: Pick<ExecutorSessionTimeouts,"helloTimeoutMs"|"bootstrapTimeoutMs">;
  readonly onError?: (error: Error) => void;
  /** Finite control-byte reserve included in maxQueuedOutboundBytes, not additional to its cap. */
  readonly maxAbortControlBytes: number;
}
export interface ExecutorSessionBridge {
  acquireRuntime(): Promise<PiSessionRuntime>;
  attachTransport(connection: ByteConnection): ByteConnectionHandler;
  dispose(): Promise<void>;
}
export function createExecutorSessionBridge(options: ExecutorSessionBridgeOptions): ExecutorSessionBridge;
export { MAX_EXECUTOR_INBOUND_CHUNK_BYTES, MIN_ABORT_CONTROL_BYTES } from "@earendil-works/pi-protocol";
```

- Browser package root exports `startBrowserExecutor` and its public types; package currently has root-only exports and ByteTransportFactory is already surfaced (`packages/browser-engine/src/index.ts:37-49`; `packages/browser-engine/package.json:9-14`).
- Server root exports bridge factory/types and type-only `ByteConnection`/`ByteConnectionHandler`; platform imports via `@earendil-works/pi-server`. `ByteConnection` is established, authorized, ordered raw bytes (`packages/server/src/connection.ts:5-18`). Platform performs no executor decoding, framing, schema/version negotiation, handshake, response generation, or generation tracking.
- Platform auth precedes attach, retains bridge by `sessionId/bindingId`, and owns persistent session storage. Each PiServer create/open calls `bridge.acquireRuntime()` for a fresh facade. Reconnect preserves the same logical bridge/reducer but fences old IDs/facades.
- `SnapshotData.id`, browser session, bridge session and PiServer runtime ID MUST match; PiServer assigns `CreateSessionOptions.id` (`packages/server/src/types.ts:27-34`), so platform prepares matching browser SessionManager via harness storage (`packages/browser-engine/src/assemble.ts:173-177,521-524`; `NewSessionOptions.id` / `SessionManager.create`: `packages/coding-agent/src/core/session-manager.ts:26-29,1581-1588`).
- Shared-mode command contract: BrowserExecutor owner MUST route local prompt/steer/abort/setModel/setThinking through `executor.commands`, shared with remote downlink. Read-only state/subscriptions remain available. `PiHarness.prompt()`/`abort()` and direct `harness.session` mutators stay unchanged low-level local-only APIs; they are unsupported while shared mode is active because they bypass shared conflict gates. Driver does not monkeypatch/intercept them; owner migrates local controls. `packages/browser-engine/src/assemble.ts:189-201`.

## 6. 行为契约（每步及省略后果）

### Browser executor driver

1. Before awaiting, subscribe to AgentSession, then build state from journal and live agent state. Attach may occur idle/turn/compaction/retry. State transitions `created → connecting → helloSent → readyReceived → bootstrapping → active → generationLost → reconnecting → active → disposed|terminal`; an existing turn continues, never restarted. Each transport generation gets a fresh generationId; reconnect sends cached reducer bootstrap.
2. Verify handshake `sessionId` matches current `session.sessionId`, rechecking before each command/snapshot/progress send; replacement ID mismatch rejects and terminates rather than mixing sessions.
3. Track downlink commandIds in pending map and apply §8 conflict/capacity policy before invocation; progress/snapshot/result/error go through a bounded ordered writer. This prevents mismatched results and unbounded slow-peer backlog.
4. Use public AgentSession API; `set_model` uses `session.modelRuntime.getModel(ref.provider, ref.id)` then `session.setModel(model, false)` for auth checks/session-only update. `AgentSession.modelRuntime` and `ModelRuntime.getModel`: `packages/coding-agent/src/core/agent-session.ts:798-800`, `packages/coding-agent/src/core/model-runtime.ts:415-417`; setModel auth `agent-session.ts:3603-3627`. Unknown ref → `invalid_request`; auth failure is command error.
5. Downlink commands/results and uplinks use one ordered serial writer per direction with finite queue+in-flight encoded byte accounting: bytes are charged from enqueue until `send()` resolves, so a slow in-flight write still consumes budget. Never create an unbounded chain of queued send promises. A normal frame larger than the configured total budget fails before enqueue as explicit `busy` (or snapshot invalid_request where specified). `MIN_ABORT_CONTROL_BYTES` covers the largest schema-bounded abort, snapshot-rejection, or runtime-error control frame. The bridge total minimum is `MAX_EXECUTOR_INBOUND_CHUNK_BYTES + MIN_ABORT_CONTROL_BYTES`; Browser also reserves one result frame, so `maxAbortControlBytes` is at least `MAX_EXECUTOR_INBOUND_CHUNK_BYTES + MIN_ABORT_CONTROL_BYTES`.
6. Physical close marks generationLost while preserving harness, AgentSession, reducer, partial message and queue. Pending remote result is unknown; no automatic replay. Explicit reconnect opens outbound transport/new generation and sends full cached bootstrap; transient close never sends `runtime_error`. Permanent logical revoke is terminal.

### Server executor proxy

1. Platform service retains `ExecutorSessionBridge` per authorized session/binding and returns `await bridge.acquireRuntime()` from PiServer create/open; platform passes only authenticated raw `ByteConnection`. Pi-rp owns executor framing/version/handshake; platform owns auth/lookup/routing/persistence, never protocol responses.
2. Browser hello/binding/snapshot/session ID must match expected sessionId; mismatch rejects acquisition, never remaps AgentSession ID (`packages/server/src/types.ts:27-34`).
3. Bridge tracks pending promise per `(generationId,commandId)`, validates identity, honors host in-flight limit, rejects stale frames and does not dispatch before bootstrap. Ordered transport provides uplink order; no sequence field/counter.
4. Apply progress through reducer before notifying PiSessionRuntime subscribers; `snapshot()` returns baseline plus selected overlay so late PiServer attach sees partial output.
5. Facade `dispose()` releases only its PiServer lease; bridge `dispose()` permanently closes logical binding. Ordinary connection loss preserves same bridge/reducer.

Expose an internal `prepareCreateOrAttach(connection,command)` transaction returning candidate live/session snapshot, response payload, snapshot event payload and `wasAlreadyMember`, but does not mutate membership or broadcast. `server.handleRequest` supplies the actual requestId, encodes/preflights the complete success `ServerMessage.response` and `session_snapshot` event against the effective frame max, then calls `commit()` to add both `connection.sessionIds` and `live.connections` and sends the pre-encoded frames. On runtime snapshot/encoding/preflight failure, `abort()` releases only a newly acquired PiServer facade, invokes `maybeDispose` when eligible, commits no indexes/events, and returns a small existing invalid_request response. If `wasAlreadyMember`, abort preserves the prior membership. If raw transport send fails after commit, normal disconnect cleanup removes it. Create's already-persisted platform record is not deleted by this transaction. A normal command whose final response is too large after execution returns invalid_request/result unknown; operation side effects are never rolled back. Source before-change: `packages/server/src/sessions.ts:66-73,300-307`; requestId/response sender `packages/server/src/server.ts:250-278`.

The shared runtime preserves the public `TranscriptState` shape/semantics and `RemoteSession.subscribe` cadence (`packages/coding-agent/src/client/transcript.ts:3-8,28-40`; `packages/coding-agent/src/client/remote-session.ts:92-97,361-368`). No participant event/schema or protocol version changes.

## 7. Snapshot / progress / command 与扩展事件转换

- `SessionSnapshot` fields: id/name/cwd/createdAt/updatedAt/phase/model/thinkingLevel/attached/locked/revision/transcript/queuedSteer/count (`packages/protocol/src/schemas.ts:241-256`).
  1. `id=session.sessionId`; cwd/name from session manager; createdAt from header timestamp, updatedAt from last active branch entry (header if empty), both parsed as nonnegative integer Unix ms; invalid timestamp fails snapshot (no wall-clock fallback). Sources: `packages/coding-agent/src/core/session-manager.ts:17-24,986-1002,1188-1200,1317-1331,1353-1356`.
  2. Transcript entries MUST come from `session.sessionManager.buildContextEntries()`: active-branch, compaction-aware projection used both for LLM context and local initial transcript view (`packages/coding-agent/src/modes/interactive/interactive-mode.ts:3782-3786`). Do not flatten `getEntries()` append log or unfiltered branch. Actual prompt uses builder then `sessionEntryToContextMessages`/`convertToLlm` (`packages/coding-agent/src/core/agent-session.ts:1264-1267`; filtering `packages/coding-agent/src/core/session-manager.ts:424-465`). Branch/compaction summaries are mapped to standard user items with stable entry IDs and matching `convertToLlm` prefixes (`packages/coding-agent/src/core/session-manager.ts:398-423`; `packages/coding-agent/src/core/messages.ts:11-24,296-310`; shared implementation moves to `@earendil-works/pi-session-protocol`).
  3. For message user/assistant/toolResult, use stable entry.id, parsed entry timestamp, and the shared converters. toolResult must find the preceding active-context assistant toolCall matching toolCallId for name/arguments. Missing/mismatch/non-JSON args or unsupported deferred assistant conversion fails snapshot as `invalid_request`, never fabricates transcript (`packages/server/src/protocol.ts:313-318,354-365`; migrated shared converter preserves semantics).
  4. `attached=false, locked=true` placeholder; PiServer normalizes these (`packages/server/src/sessions.ts:276-291`). Proxy owns revision: starts 0, increments only when snapshot-visible state changes, retained across physical reconnect; revision is not replay cursor. Participant disconnect/reconnect does not imply progress replay (`01-共同上下文.md:22-24`).
  5. Model comes from `session.model` `{provider,id}`; missing model fails; thinking from `session.thinkingLevel`. Phase precedence: retry hint/attempt→retry, `isCompacting`→compaction, `isStreaming`→turn, else idle. `isCompacting` aggregates normal compaction and branch-summary operations; their phase maps to compaction without adding an AgentSession event/getter (`packages/coding-agent/src/core/agent-session.ts:1435-1457,1474-1477,1888-1895`; schema `packages/protocol/src/schemas.ts:37-45`).
  6. Bootstrap reads steering/follow-up queues; map only steering in original order. Queue items without protocol IDs/times receive synthetic driver-local values. `queue_update` strings are reconciled with linear FIFO prefix append/right-suffix drain/clear, otherwise replacement; duplicate strings cannot expose true identity (`packages/agent/src/agent.ts:129-162,290-313,378-390`; `packages/coding-agent/src/core/agent-session.ts:1071-1076`). No Pi-rp queue cap.
Projection limitations: metadata, custom_message, bashExecution and nonstandard roles are not protocol transcript items; custom messages may enter context under extension policy, but details/system prompt/prelude are not guaranteed in projection. Standard item roles remain user/assistant/tool.
- Unique converter source lives in new `packages/session-protocol/src/transcript.ts` package; migrate server user/assistant/tool-result/usage/JSON/details converters, server `src/protocol.ts` re-exports to preserve root API.
- AgentSession event union exceeds standard transcript (`packages/coding-agent/src/core/agent-session.ts:276-323`). Wire emits only protocol item_started/assistant_delta/item_updated/item_finished (`packages/protocol/src/schemas.ts:203-231`) and snapshot updates; no extension UI/custom/activity/bash/compaction event schema expansion.

### AgentEvent / AgentSessionEvent 到 wire progress 与 phase 的逐事件映射

Live item uses generation-local synthetic item ID because `message_end` listeners run before journal append (`packages/coding-agent/src/core/agent-session.ts:1142-1166`); final journal snapshot reconciles to stable entry IDs. `toolCallId` joins assistant call to tool result but is not item ID. Event sources: `packages/agent/src/types.ts:469-484`, `packages/ai/src/types.ts:529-545`.

Driver subscribes before reading journal. Late attach seeds current incomplete assistant from `session.state.streamingMessage`; if `AgentState.pendingToolCalls` matches preceding assistant toolCalls, seed exactly one running tool item for each in-flight call. This is only for a fresh driver; physical reconnect reuses existing reducer and MUST NOT seed duplicates. State sources `packages/agent/src/types.ts:374-398`, `packages/agent/src/agent.ts:554-567`; journal append ordering above. Pre-driver token deltas are not replayed, but cumulative partial content is available.

| Input event | TranscriptProgress / snapshot handling | ID and boundary |
|---|---|---|
| `message_start` user | `item_started`, content/timestamp from message. | transient ID; final journal snapshot uses stable entry id. |
| `message_start` assistant | streaming `item_started`. | Single active assistant id; loop update/end sequencing (`packages/agent/src/agent-loop.ts:328-355`). |
| `message_update` text/thinking/toolcall delta | `assistant_delta` of matching kind/index. | Reuse active id; reducer retains partial tool JSON. |
| `message_update` non-delta variants | `item_updated` with current assistant partial, still streaming. | Same assistant id/index (`packages/ai/src/types.ts:529-545`; `packages/agent/src/agent-loop.ts:337-355`). |
| `message_end` assistant | `item_finished` complete/error/aborted; deferred is invalid_snapshot, not fake complete. | tool execution follows without a second assistant item; final snapshot reconciles id. |
| `message_end` toolResult | Ignore duplicate if `tool_execution_end` already finished it; otherwise one fallback `item_finished`. | Match toolCallId; transient item id differs from call id (`packages/agent/src/agent-loop.ts:399-415,455-487,805-833`). |
| `message_start` toolResult | No duplicate start for known execution; this is LLM delivery, not a new execution. | Correlate by toolCallId; final journal snapshot makes stable id. |
| `tool_execution_start` | One running ToolTranscriptItem with args, empty content. | Distinct transient item id; require preceding matching assistant call. |
| `tool_execution_update` | No content update; running item remains running. | partialResult is cumulative `AgentToolResult` (`packages/agent/src/types.ts:402-424`); protocol has no tool text delta. |
| `tool_execution_end` | Shared converter yields one complete/error item_finished. | Correlate toolCallId; subsequent result message cannot duplicate; journal snapshot remaps item id. |
| turn start/end | Recompute phase only. | turn_end is not necessarily idle (`packages/agent/src/agent-loop.ts:191-217,221-256,265-285`). |
| agent start/end/settled | Recompute phase; on settled rebuild canonical journal snapshot and reconcile transient IDs. | Listener before journal append; run may retry/compact/continue before settled (`packages/coding-agent/src/core/agent-session.ts:1098-1105,1142-1166,1204-1215,2530-2580`). |
| retry events | Set retry hints/recompute phase. | Existing event sources `packages/coding-agent/src/core/agent-session.ts:302-317,1178-1187,5382-5403,5411-5455`. |
| compaction start/end | Recompute phase and snapshot; authoritative context projection includes wrapped summary. | `isCompacting` aggregate includes branch navigation (`agent-session.ts:1888-1895,5636-5644,5692-5695`). |
| abort result | No dedicated abort event; assistant aborted terminal item and agent_settled complete it. | `session.abort()` aborts retry/compaction/branch summary/agent (`agent-session.ts:3495-3504`). |
| queue_update | Refresh queuedSteer/count and snapshot only. | Follow-up not represented as protocol queue. |
| entry/name/model/thinking changes | Rebuild affected snapshot fields. | No message progress needed; custom/activity/bash updates remain outside protocol. |

**Phase fidelity limit:** `AgentSession.isCompacting` aggregates compaction and navigateTree controller; both map to existing `SessionPhase.compaction`, no public getter/event/RPC consumer added. Branch summary content remains transcript projection (`packages/coding-agent/src/core/agent-session.ts:1888-1895,5636-5644,5692-5695`).

**Snapshot overlay invariant:** shared `applyTranscriptSnapshot` resets progress overlay (`packages/coding-agent/src/client/transcript.ts:28-40`). Therefore responses/results/queue snapshots during streaming MUST materialize current shared TranscriptState overlay first; a bare canonical journal snapshot would erase earlier partial/tool updates. Once settled, apply canonical `buildContextEntries()` journal snapshot first to replace transient IDs. Shared reducer preserves existing public `TranscriptState` shape/semantics and `RemoteSession.subscribe` cadence (`remote-session.ts:92-97,361-368`).

## 8. 命令、并发、生命周期、断线和错误语义

### 命令与并发

- Executor host command union contains prompt/steer/abort/set_model/set_thinking only; participant commands stay unchanged (`packages/protocol/src/schemas.ts:291-324`).
- `maxPendingCommands>=2` ordinary request window; abort has a separate reserved control-count slot. `maxQueuedOutboundBytes` is finite per-direction total for queued plus in-flight encoded frames, charged until `send()` resolves. Bridge minimum: `MAX_EXECUTOR_INBOUND_CHUNK_BYTES + maxAbortControlBytes`, with `maxAbortControlBytes >= MIN_ABORT_CONTROL_BYTES` exported from executor codec. Browser additionally reserves a full command-result frame plus one bounded control envelope, so its `maxAbortControlBytes >= MAX_EXECUTOR_INBOUND_CHUNK_BYTES + MIN_ABORT_CONTROL_BYTES`. Executor schema bounds sessionId/bindingId to 128 UTF-8 bytes and uses UUID generationId/commandId; Bridge-generated commandId is independent of participant request IDs. Ordinary bytes may use total minus the reserved budget.
  - Abort during preflight returns busy and MUST NOT call session.abort; after accepted Agent run it may proceed concurrently. Extension command without general cancellation stays busy until settled (`packages/coding-agent/src/core/agent-session.ts:2600-2637,3495-3504`).
  - Steer appends FIFO during preflight/idle/active and resolves independently; no Pi-rp queue cap. PiServer has no operation mutex (`packages/server/src/sessions.ts:90-117,171-183`); AgentSession steer accepts idle/streaming (`packages/coding-agent/src/core/agent-session.ts:2929-2941,2959-2976`); Agent drains on prompt (`packages/agent/src/agent.ts:378-390`).
 - Shared-mode local inputs MUST use the returned `BrowserExecutor.commands`; direct `PiHarness.prompt/abort` and harness.session mutators bypass gate and are unsupported while shared mode active, but remain unmodified and callable in local-only use (`packages/browser-engine/src/assemble.ts:189-201`).

- Driver dispose idempotently stops commands, unsubscribes, clears pending; when online it best-effort queues terminal `executor_close`, then closes transport without waiting for a stalled write; offline the platform revokes the logical binding. It does not dispose the harness (`packages/browser-engine/src/assemble.ts:583-598`).
- PiServer may dispose idle facade after no-client cleanup (`packages/server/src/sessions.ts:320-345`); platform keeps bridge and reacquires a fresh facade from same reducer/revision. Only bridge.dispose is terminal.

### 断线、错误与恢复

- Physical disconnect fences generation, clears decoder/send queue/command IDs and rejects pending facade promises immediately as unknown result; PiServer operation finally releases (`packages/server/src/sessions.ts:171-183`). Late old-generation data is ignored; browser AgentSession may continue. Logical bridge/reducer preserved; no `runtime.error`.
- Explicit reconnect creates outbound transport and fresh generation; platform routes raw connection to same bridge. No pending/queued frame or ID crosses generations; no retry/replay.
- Fatal logical revoke/version/schema/binding/internal failure may terminate; raw transport loss never maps to runtime error (`packages/server/src/sessions.ts:248-273`).
- Protocol decoder uses `FrameDecoder.pushEach`; oversize raw chunk loses only that generation. `executor_snapshot_rejected` returns existing `invalid_request`; no new participant event/schema. Command result matching rules are in §5.
- **Listener isolation:** `AgentSession._emit` synchronously invokes listeners, and a thrown callback prevents subsequent message journal append (`packages/coding-agent/src/core/agent-session.ts:1053-1057,1142-1166`). BrowserExecutor callback MUST catch all mapping/schema/encoding/queue/send errors; `onError` callback errors are caught too. Nothing bubbles into `_emit`; report/fence locally.
- Snapshot cap: initial bootstrap/acquire overlimit rejects safe invalid_request but retains logical bridge for smaller retry; live snapshot throws invalid_request. New non-abort commands fail session_locked; active command may finish with result too large and may already have executed. Attached participants remain connected and progress continues; no wire snapshot/error event. Later fitting snapshot clears unavailable state.
- PiServer attach/create transaction details: §6. In particular prepare/preflight actual requestId response and snapshot event before membership commit; no event/membership on preflight error; maybeDispose; rollback only newly added member. Command side effect after execution is unknown, not rolled back. Post-commit send failure is disconnect, not size fallback.

## 9. 文件、副作用与包边界

建议代码落点（仅设计，不实施）：

 - `packages/protocol/src/executor-schemas.ts` / `executor-codec.ts` (new): independent `EXECUTOR_PROTOCOL_VERSION=1`, strict executor-only schemas, bounded IDs, UUID bridge-generated commandIds and sole canonical `MAX_EXECUTOR_INBOUND_CHUNK_BYTES=DEFAULT_MAX_FRAME_LENGTH+4`; export schema-derived `MIN_ABORT_CONTROL_BYTES` for the maximum encoded abort control envelope. Never add executor messages to participant unions. `framing.ts` adds pushEach, retains push.
- New browser-safe `packages/session-protocol` shared package holds transcript converters, shared summary prefix helper, and TranscriptState reducer. No server/browser duplicate converter/reducer/prefix.
- Keep model metadata converter in server; re-export migrated transcript converter to preserve root API. Do not put pi-ai converter in pi-protocol (would couple wire layer to AI runtime deps); do not import Node-only server into browser.
- Browser engine adds session-protocol and pi-protocol dependencies; source mapping must resolve browser bundle to source, not Node dist (`packages/browser-engine/build.mjs:23-38`). Coding-agent re-exports shared reducer; RemoteSession.subscribe remains unchanged.
- `packages/server/src/executor-runtime.ts` new bridge implementation; root exports factory and public raw connection types. Platform passes raw authenticated connection; does not implement protocol or proxy.
- No browser listener, platform auth/broker, websocket product helper, stable executor identity, uplink sequence counter, replay log, paging, or participant protocol/schema/version changes.

## 10. 与现状差异及具体代码落点

| 落点 | 源码现状 | 设计变化 |
|---|---|---|
| `packages/browser-engine/src/index.ts:37-49` | Root exports harness/ByteTransportFactory/type surfaces; package root-only exports (`package.json:9-14`). | Export `startBrowserExecutor` and public types from root. |
| `packages/protocol/src/executor-codec.ts`, `src/framing.ts:73-80,124-143` | FrameDecoder.push collects completed frames; no executor chunk cap. | Protocol owns canonical chunk cap; add pushEach and keep push compatible. |
| `packages/protocol/src/codec.ts:41-80`, `src/framing.ts:27-38,57-70` | Generic CBOR+length framing and participant-specific codecs. | Add executor-specific validation/codec, preserve participant role. |
| `packages/browser-engine/src/executor.ts` (new) | Absent. | AgentSession driver, transport lifecycle, command/event mapping. |
| `packages/server/src/types.ts:36-60` | PiSessionRuntime is in-process. | Keep contract; new proxy implements it via executor channel. |
| `packages/server/src/executor-runtime.ts` (new) | Absent. | Command/downlink, uplink, correlation, disconnect, dispose, deadline and stale-generation behavior. |
| `packages/session-protocol/src/transcript.ts`, `src/transcript-state.ts` (new) | Converter in server; reducer in coding-agent client; summary prefix in core messages. | One browser-safe converter/helper/reducer source. |
| `packages/server/src/sessions.ts:66-73,300-307`; `packages/server/src/server.ts:250-278` | Membership is added before snapshot; actual requestId known at response handling. | Prepare/preflight full response and event before commit; safe error on failure; rollback only new members; maybeDispose; transport failures remain disconnect. |
| `packages/coding-agent/src/core/agent-session.ts:1053-1057,1142-1166` | Listener callbacks synchronous before message journal append. | Browser adapter isolates all mapping/onError throws inside callback. |
| `packages/coding-agent/src/core/agent-session.ts:1888-1895,5636-5644,5692-5695` | isCompacting aggregates compaction and navigation summary controller. | Both map to compaction; no new getter/event/RPC consumer. |

## 11. Consumer acceptance（实现后验收场景）

1. Browser opens authenticated outbound ByteTransport only; no listener/PiServer/Node worker. ready resolves after bootstrap_ack; reject is observable.
2. Browser SessionManager, snapshot, bridge and PiServer IDs match.
3. Platform passes authenticated raw ordered ByteConnection; bridge decodes and returns fresh PiSessionRuntime facade; multiple participants attach same runtime.
4. Mid-stream attach shows committed active transcript plus current partial assistant/tool state; no snapshot-per-token.
5. Shared local and remote command paths use same arbiter; abort during preflight cannot race a future prompt start.
6. Disconnect leaves same logical bridge, fences pending IDs/facades; explicit new generation bootstraps same reducer; no auto replay.
7. Frame cap 16MiB and bounded per-direction queue+in-flight bytes; minimum is one maximum inbound frame plus finite abort/control reserve, independent of ordinary pending-command slots. Agent FIFO is uncapped.
8. Extension/custom/activity/UI events do not become transcript progress.
9. Dispose releases driver listeners but not harness; platform bridge dispose only terminal.
10. PiServer may dispose idle facade; service reacquires fresh facade from retained bridge.
11. Late fresh driver attach while tool in flight seeds one running tool item from pendingToolCalls; reconnect does not duplicate it.
12. Progress callback/encoder/onError errors cannot interrupt message journal append.
13. Snapshot/result/queue outputs during streaming preserve reducer overlay; settled canonical snapshot reconciles stable journal IDs.
14. Oversized bootstrap/acquire rejects within configured deadline and closes that generation; late factory resolution is closed; no promise hangs.
15. Attach/create preflight uses real requestId and both response/event frames before membership/event commit; failure leaves no ghost and maybeDispose runs; send failure after commit is disconnect.
16. `executor_snapshot_rejected` bootstrap/runtime variants lack commandId; command_result requires bridge-generated UUID commandId mapped internally to the facade promise, never participant requestId. Reject only matching request; unknown ID ignored, no retry/replay.
17. `PROTOCOL_VERSION`, participant `PiClient`, participant event schemas and `RemoteSession.subscribe` cadence stay unchanged.
18. Envelope keys are sessionId/bindingId/generationId and commandId: binding routes, generation fences stale physical connections, and commandId correlates requests. Ordered stream itself supplies message order; executorId and sequence are intentionally absent.

## 12. 冲突、未知与明确非目标

### 已由用户补充决策解决的旧冲突

User selected Pi-rp generic executor outbound channel (`00-需求原话.md:43-47`; `01-共同上下文.md:12,38-54`). Structural adapter alone is only the local half, not a cross-process solution.

### 已定稿的跨模块选择

1. Executor schema/version lives in separate pi-protocol schemas/codec; participant `PROTOCOL_VERSION` and unions unchanged.
2. Raw host adapter is `packages/server/src/executor-runtime.ts`; platform passes authenticated raw `ByteConnection`, Pi-rp implements `PiSessionRuntime` proxy.
3. Transcript converter/reducer lives in browser-safe `@pi-session-protocol`; no duplicate implementation.
4. Limits are fixed frame cap, inbound chunk cap and finite per-direction outbound byte bounds; no 48MiB per-session minimum. Ordered transport means no uplink sequence; binding plus generation means no stable executorId.
5. `isCompacting` maps to compaction; no public AgentSession API change.

### 明确限制（非未知）

- PiServer creates session id; platform prepares matching browser SessionManager.
- Transcript is active compaction-aware context; includes wrapped summary items, excludes pruned history and has explicit custom/details/system-prompt limitations.
- Physical transport loss is not logical termination; same bridge preserves reducer but no replay cursor/exactly-once. Explicit reconnect, no retry.
- No per-command cancellation/timeout; abort is session-wide. Bootstrap/connection waits are bounded as specified.

### 明确不做

- Pi-rp broker/service product, platform authentication/authorization/room/member/session binding/routing/persistence/UI.
- Browser inbound listener, PiServer, resident Node/Pi process, multi-browser execution/merge.
- Participant protocol changes, additional participant error schema, all extension/activity/UI event forwarding.
- Across-reconnect exactly-once, command dedupe ledger, progress replay/event log, snapshot paging/fragments.
- Production WebSocket helper absent multi-consumer evidence; transport remains injected.
