# Coding-agent PiServerService 与 Session 生命周期适配设计

## 一句话定位

为既有 `PiServerService` / `PiSessionRuntime` 提供 coding-agent 实现：将 PiServer 分配的 durable `sessionId`、SessionManager 当前持久化文件与 `AgentSessionRuntime` 的生命周期安全映射，并依赖现有 PiServer/PiClient 管理多 Session 路由，不另造 Host registry、transport 或 client。

## 需求对照

依据 `00-需求原话与效果清单.md` 及最新版 `00-共同上下文.md` §2：


- 原话第 8 段：“以后每个产品都得自己手动实现一遍”以及“不再每次都得手搓……client”：首轮由通用 coding-agent Host adapter 对接既有 Node/TypeScript `PiClient`，消费方复用官方客户端，不另造 client。对应效果 3。
- 原话第 7、9 段：用户确认“提供明确的多 Session 宿主”及“目标已经挺明确……都需要怎么做”。本轮交付通用 Host adapter；既有 PiServer 提供多会话路由，本模块实现它与 coding-agent 的连接。对应效果 1、5、6。
- 原话第 3、4、5、6 段：角色规模扩展是性能动机；Rivet 是 Node 多进程参考、Amio 仅用于 Agent 能力参考。本轮不做 Rivet 完整功能 cutover；`context_request`/`orchestration_request`、callback/tree protocol 扩展及切换均不在范围。规模基准只验证 Host adapter/topology，不构成 Rivet migration 承诺。对应效果 1、4、8。
- 效果 2、4、6：会话状态、配置、工具、事件、取消和持久化彼此隔离；共享资源边界由 Host/runtime service 装配给定；关闭需释放运行时。
- 效果 5、7：产品继续拥有业务状态、权限和调度；浏览器仍通过产品后端，Node/TypeScript 消费方复用 `PiClient`。
- 已拍板范围：本轮无 Python SDK，也不承诺 NeonRP 直接接入；默认 store 仅支持同机本地文件系统，网络/共享 FS 必须 fail closed。同一 Host 仅接受产品审核的 trusted extensions；不可信扩展须使用独立 Host/进程。


必须遵守最新版 `00-共同上下文.md` §2–§6：PiServer durable session ID 是既有 server/client route key；coding-agent SessionManager ID/file 可相同但必须证明操作语义兼容，否则保留映射；不新增公开 `hostSessionId`；现有 PiServer/Protocol/PiClient 为传输和客户端基础，本轮客户端消费面为 Node/TypeScript `PiClient`；不交付 Python SDK、不承诺 NeonRP 直接接入；每个 live runtime 独立拥有 Agent、SessionManager、ExtensionRunner、事件与取消；PiServer service adapter 负责同进程 session-file 独占 owner；共享 provider/runtime 注册语义不得被每次创建新 Session 污染。默认 store 只支持同机 local FS，网络/共享 FS 必须 fail closed。Rivet full cutover、callback/tree protocol 扩展不属于本轮。

### 现有能力与缺口

- `packages/server/src/types.ts:27-60` 定义 `CreateSessionOptions`、`PiSessionRuntime`（snapshot/phase、prompt/steer/abort/model、subscribe、dispose）与 `PiServerService`（listSessions/listModels/createSession/openSession）。
- `packages/server/src/sessions.ts:39-46,48-146` 已负责 create/list/attach/detach、每条命令路由；`:213-273` 有按 durable id 的 acquire single-flight 与 ID 校验；`:275-313` 订阅 session runtime 并向其 connection 路由 progress/snapshot；`:357-378` 管理 detach 后 live runtime idle disposal。
- `packages/protocol/src/schemas.ts:286-324,328-375,400-450` 定义既有 commands/results/events；`packages/client/README.md:26-34` 与 `client/src/client.ts:137-177` 已提供多 Session lease 与操作 surface。此模块不得重画它们。
- `packages/server/README.md:1-40` 说明 PiServer 为 experimental 通用 server，应用必须提供 service；coding-agent 尚无 production service 实现。
- `AgentSessionRuntime` 是 coding-agent 的单持有者 runtime，不满足 `PiSessionRuntime`：它拥有当前 AgentSession，并在 new/switch/fork/import 时 teardown 后重建，保留 services 与 factory（`agent-session-runtime.ts:67-95,171-186,204-231,234-268,270-360,369-408`）。
- `createAgentSession()` 可接受 ModelRuntime、RequestGateway、ResourceLoader、SessionManager 等注入（`sdk.ts:83-180,266-299,422-427`）；但这只构造 AgentSession，不含 PiServer lifecycle/snapshot adapter。
- `packages/session-protocol` 的 `converters.ts:56-88` 仅覆盖单条 user/assistant/tool transcript conversion；没有 AgentSession→完整 SessionSnapshot builder，也没有 phase / revision / queued steer / event mapping adapter。
- `packages/session-backends/postgres` and `sqlite-node` are `pi-agent-core` `SessionRepo` implementations, not backends for coding-agent's JSONL `SessionManager`; Postgres explicitly has no JSONL import/fallback/dual-write (`packages/session-backends/postgres/README.md:1-24`; `sqlite-node/README.md:1-22`). They do not satisfy this service's durable mapping/file-owner store contract. Replacing coding-agent JSONL persistence with either backend is a separate storage migration scope/cost, not an incidental adapter choice.

## 公共 API 与对象模型

### 结论：不新增第二个公开 Host/HostSession SDK

公共多会话生命周期已经是 `PiServer` + `PiClient` + protocol：PiServer `create` 分配 durable id 并通过 `PiServerService.createSession` 获取 runtime；`attach` 调 `openSession`；`list` 来自 service durable catalog；detach 释放连接租约，live runtime 在符合规则时 dispose、之后可 reopen。客户端有 `createSession()`、`acquireSession()`、`attachSession()`、`listSessions()`、lease `dispose()`/`detach()`（`packages/client/src/client.ts:137-177`; `client/src/session-handle.ts:19-35`）。再公开 `AgentSessionHost/HostSession` 会重复 route identity、get/list/close 与 lease 生命周期，且引入第二个 owner。

coding-agent 的 SDK 增量建议限定为一个 service factory / adapter：

```ts
export interface CodingAgentServerServiceCommonOptions {
  maxActiveRuntimes: number; // Required positive finite bound on in-memory live sessions, not durable records.
  requestGatewayConfig: RequestGatewayConfig; // Factory validates a finite positive default and every explicit override.
  createSharedRuntime(): Promise<CodingAgentSharedRuntime>;
  createRuntime: CreateAgentSessionRuntimeFactory;
  serverOptions: Omit<PiServerOptions, "service">;
}

export type CodingAgentServerServiceOptions = CodingAgentServerServiceCommonOptions & (
  | {
      // Default, assembly-owned JSONL/catalog store; its root is mandatory.
      sessionStore?: never;
      sessionStorageDir: string;
    }
  | {
      // Injected store/catalog remains caller-owned.
      sessionStore: CodingAgentServerSessionStore;
      sessionStorageDir?: never;
    }
);

export interface CodingAgentServerSessionStore {
  listSessions(): Promise<SessionMetadata[]>;
  create(options: CreateSessionOptions): Promise<{ sessionManager: SessionManager; metadata: SessionMetadata }>;
  open(protocolSessionId: string): Promise<{ sessionManager: SessionManager; metadata: SessionMetadata }>;
  // Release only the acquired runtime/file-owner lease; MUST NOT delete durable metadata or JSONL.
  // The store remains caller-owned when injected; the assembly closes its built-in store and root lock after PiServer/runtime shutdown.
  release(protocolSessionId: string): Promise<void>;
}

export interface CodingAgentPiServerHandle {
  readonly server: PiServer;
  start(): Promise<void>;
  close(): Promise<void>;
}

export function createCodingAgentPiServer(
  options: CodingAgentServerServiceOptions,
): Promise<CodingAgentPiServerHandle>;
```

`createCodingAgentPiServer` is an owner/composition handle, not a second session API or registry. It creates the shared runtime and service, owns one `PiServer`, and `close()` awaits `PiServer.close()` and all acquired-session disposals before releasing its own coordinator/provider registrations/gateway and closing the assembly-owned file catalog. Cleanup runs in `finally` after the server-close promise settles, including when shutdown reports an error; it does not promise to dispose a `ModelRuntime` without a public dispose API. An injected durable catalog/session store remains caller-owned and is never closed by this handle. Direct low-level users of `PiServer` + service must await `PiServer.close()` before releasing their caller-owned store/resources. `release()` only drops per-runtime claims and MUST NOT delete durable metadata/JSONL. If no store is injected, `sessionStorageDir` is required.

**默认 store 与 root lock：**未传 `sessionStore` 时 factory 创建 assembly-owned `FileCodingAgentServerSessionStore(sessionStorageDir)`；该参数指专用 session 根目录，旧 CLI/project sessions 和 legacy session-file mode 均不自动迁移。默认 store 使用 per-session manifest 保存 metadata 与同 ID 固定 JSONL 路由；不另建可变 current-file 映射。`start()` 在读取或触碰 catalog、以及启动 PiServer/listeners 之前，必须获取 root ownership lock。锁通过 `node:sqlite` 实际写事务持有 root ownership；同 root 竞争者以 typed busy `{ code: "busy", details: { reason: "root_owned" } }` 本地失败，不发 protocol response。

创建过程先写 `pending` manifest，再 `SessionManager.create()` 并完成 runtime 初始化；只有 `commitCreate` 将最终 `model` / `thinking` 等元数据写入并转为 `committed` 后才算成功。root lock acquire 时扫描并清理合法的 pending crash orphan；`discardFailedCreate` 仅适用于尚未 commit 的创建，不得删已提交记录。正常 `release` 只释放活跃 runtime/file-owner lease，不删除持久 manifest 或 JSONL。`close()` 遇到仍有 active leases 必须 fail closed；owner close 出错时保留 root lock，不得释放后允许另一 owner 进入。

`updatedAt` 从对应 JSONL 文件的 mtime 计算，而非仅取 manifest 时间。Root 与 session directory 必须使用 private modes/ACL；只对本次创建的目录设私有权限，不递归迁移或改写既有目录/文件权限。

**平台与验证状态：**默认 store 设计目标为 Linux、macOS、Windows 上同机 durable local FS；tmpfs、overlay、remote/shared、无法确认类型或其他 unknown FS 必须 fail closed，不降级到不安全锁或声称跨主机安全。`node:sqlite` 实际写事务持锁；尚无三平台运行验证证据，具体测试未运行，不得描述为已实现并验证。root 不提供共享目录/跨主机 session store 能力。

**范围边界：**Rivet 保留 legacy 路径，本轮不实施完整 cutover、`context_request`/`orchestration_request` callback 或 tree protocol 扩展。

### `createSession` behavior

1. `PiServer` assigns the protocol `sessionId` and calls service `createSession(options)`; service MUST use that exact ID as durable record key and in returned snapshot (`server/src/types.ts:27-34`; `server/src/sessions.ts:56-65,236-263`). Violating this causes PiServer to reject/tear down the runtime (`sessions.ts:244-249`).
2. Before creating metadata or a SessionManager, validate `options.id` with `assertValidSessionId(options.id)` (`packages/coding-agent/src/core/session-manager.ts:224-228`). PiServer currently supplies `randomUUID()` (`packages/server/src/sessions.ts:62-71`), which satisfies SessionManager's format. Then initialize with the original value exactly via `SessionManager.create(cwd, sessionDir, { id: options.id })`; never catch validation/create errors and retry with a generated fallback ID. Any invalid ID is rejected as `invalid_request`/failed create before catalog or JSONL writes, preventing protocol snapshot, catalog key, and SessionManager header from diverging.
3. Construct a fresh per-session `AgentSessionRuntime` and await complete AgentSession setup (`sdk.ts:571-595`). Bind extension command callbacks so same-session new/fork/switch/import reject explicitly instead of inheriting `ExtensionRunner`'s success-shaped no-op defaults (`extensions/runner.ts:342-345,484-502`). If the runtime cannot enforce this for a loaded extension set, do not expose that set in v1.
4. Install one runtime event subscription and adapt every event/snapshot to the PiServer runtime. In v1 both the durable protocol ID and internal ID/file remain fixed.
5. Return a `PiSessionRuntime` whose snapshot ID equals the PiServer-assigned ID. Conversion failure (unsupported transcript form, missing required model metadata, invalid timestamp) fails creation and disposes the runtime instead of emitting malformed data.

### `openSession` / reopen

1. Resolve durable `protocolSessionId` via the store to its fixed cwd/session directory/file. Missing ID returns existing PiServer `not_found`, not a synthetic empty session.
2. Claim the normalized file path before `SessionManager.open()`/runtime creation. PiServer single-flights same-ID acquisition; reject aliases where distinct IDs resolve to the same file.
3. Rebuild a fresh coding-agent runtime with stored cwd/config and the same file; return snapshot with the requested durable protocol ID.
4. On initialization failure, dispose partial runtime and release file claim; preserve durable record so later open may retry after correcting transient failure. Do not delete session history just because acquisition failed.

- `PiServerService.listSessions()` returns durable `SessionMetadata[]`; it is not an active-runtime map. Existing server merges currently live snapshots into metadata (`server/src/sessions.ts:161-177`). Adapter returns stored protocol IDs plus supported fields (cwd, timestamps/name); do not invent live phase/model for sessions which are not open.
- PiServer has no public `getSession(id)` service call: `attach`/`acquireSession` is the supported open/get-live behavior. The Node/TypeScript consumer uses the existing `PiClient.acquireSession(id, {mode})` lease; `attachSession` is shared acquisition convenience; `createSession` returns exclusive lease. Do not add duplicate SDK `get` API, Python SDK, or a NeonRP integration promise.
- There is no current durable delete command. Adapter `PiSessionRuntime.dispose()` means release acquired runtime resources and file lock; it MUST NOT delete durable metadata/file. Host-wide PiServer close invokes dispose on every acquired live runtime (`server/src/server.ts:338-349`; `sessions.ts:179-196`).

### Capacity admission (active runtimes, not durable sessions)

- `maxActiveRuntimes` is required and validated as positive and finite before startup. It bounds in-memory live coding-agent `AgentSession`/`PiSessionRuntime` instances; durable catalog rows, detached sessions, and sessions not currently acquired do not consume a live slot.
- The adapter atomically reserves an admission permit before calling store `create()` or `open()` and before allocating/opening/writing a SessionManager file. This prevents simultaneous opens from passing the cap; on success the permit belongs to the runtime, and every initialization failure/dispose path releases it. Pending permits count against available capacity to prevent over-admission, but are not durable records.
- At capacity, create/open fail immediately with existing protocol `busy` and structured reason `{ reason: "active_runtime_limit", limit }`, via `PiServerError("busy", ...)` (`packages/server/src/errors.ts:11-28`; `packages/protocol/src/schemas.ts:269-282`). Admission MUST happen before store operations, so rejected create/open leaves no manifest, catalog entry, session directory, or JSONL file. Do not queue acquisition or evict/abort attached sessions.
- Detach releases a slot only after PiServer's existing idle-disposal path disposes the runtime; active operations and attached sessions retain it (`packages/server/src/sessions.ts:357-378`). After disposal, an existing durable ID may reopen. Same-ID concurrent acquire uses PiServer single-flight and must not consume multiple slots.
- Validate provider concurrency config before any runtime creation, storage/catalog write, or listener startup: `defaultMaxConcurrency` MUST be present, finite, and > 0; every explicit `providers[name].maxConcurrency` override MUST also be present, finite, and > 0. Reject a missing default or override, an effective omitted/unbounded limit, `0`, negative values, `Infinity`, and `NaN` (`RequestGatewayConfig` defines `0` as no limit and no default/provider entry as ungated: `packages/coding-agent/src/core/request-gateway.ts:26-36`). If an override is absent for a provider, its finite default applies. These provider request limits are separate from `maxActiveRuntimes`; module 20 owns fairness/queue policy, not whether an unbounded provider is accepted.

## Session identity 与 session-file ownership

### ID mapping

1. `CreateSessionOptions.id` is the durable protocol ID and the service must persist it exactly (`packages/server/src/types.ts:27-34`). Do not conflate it with the coding-agent ID.
2. Before creating the initial SessionManager, call `assertValidSessionId(protocolSessionId)`; server currently allocates IDs with `randomUUID()` (`packages/server/src/sessions.ts:62-71`) and SessionManager accepts only its validated character set (`packages/coding-agent/src/core/session-manager.ts:224-228`). Use the exact `protocolSessionId` in `SessionManager.create(cwd, sessionDir, { id: protocolSessionId })` (`session-manager.ts:26-29,927-952,1576-1589`). Any validation failure is an explicit `invalid_request`/failed create; never fall back to an internally generated ID. V1 has no same-session replacement, so this ID/file stays fixed.
3. The service still needs durable catalog metadata to resolve `protocolSessionId -> cwd + sessionDir/session file` for `list/create/open`; use an isolated deterministic per-ID directory or explicit manifest, and never guess by “most recent session”. This is fixed-location lookup, not a mutable current-file mapping.
4. Replacement-capable coding-agent APIs may change the internal ID/file while the PiServer route ID remains fixed; such mapping is deferred with replacement support and must not leak into v1. Do not add `hostSessionId` or a public `HostSession` handle merely to implement this adapter.

### Exclusive file owner

- Before opening a JSONL file for writing, normalize its path and acquire an adapter-scoped path→protocol-ID/runtime owner claim; release it only after that runtime is disposed. PiServer already single-flights acquire for one ID; if two durable IDs resolve to one physical path, reject the second before either writer can mutate it.
- SessionManager `_persist()` appends entries, uses `wx` on first full flush, and rewrites with `w`; it does not provide a per-path owner lock (`session-manager.ts:976-1027`). Two managers writing the same path can race/corrupt or clobber.
- V1 must not expose same-session new/fork/switch/import through PiServer protocol, `PiSessionRuntime`, or extension callbacks. Its coding-agent assembly must omit or reject any indirect action that can replace the current manager/file; if that cannot be enforced for a loaded extension set, that set is not supported in the shared Host. Do not implement replacement preflight hooks in the v1 adapter.
- **Future replacement gate (not v1 acceptance):** before offering such operations, add a host/service-owned async target preflight before teardown and before file mutation. Current switch/import prepare targets before invalidation; new allocates its manager before teardown; fork may write its target inside `createBranchedSession()` before teardown (`agent-session-runtime.ts:204-231,234-267,270-339,369-403`; `session-manager.ts:1474-1552`). Claim failure must preserve the current session and leave target untouched; only after success may runtime and durable mapping be rebound.
- `CodingAgentServerSessionStore.release(protocolSessionId)` releases only the active runtime/file-owner lease; it MUST NOT delete durable metadata or JSONL. It must be safe after failed create/open and idempotent after disposal.
- The claim is adapter/service-process local. Cross-process or crash-stale lock recovery belongs to durable session store/OS storage and is not solved by PiClient lease. PiClient shared/exclusive lease checks are within one client instance only (`client/src/client.ts:381-400`; `client/README.md:28-32`).
## Snapshot, event and command adaptation

- `PiSessionRuntime` operations map to the existing `AgentSessionRuntime` / current `AgentSession`: prompt and steer pass user text; abort cancels only that Session; model/thinking changes use Session API. Any unsupported protocol operation must remain unsupported rather than silently no-op. Protocol is intentionally a generic snapshot/command subset; coding-agent extension-only APIs are not automatically exposed.
- Session snapshot builder owns mapping `AgentSession.state.messages` and SessionManager entries into protocol transcript items; include correct `id`, `cwd`, created/updated times, model, thinking, phase, revision, queued steering metadata and transcript. Existing `session-protocol` conversion helpers cover single messages but not snapshot aggregation (`converters.ts:56-88`).
- Progress events must be session-scoped via `PiSessionRuntimeEvent.progress`; snapshot updates must maintain monotonically increasing revision. The server routes progress with its durable ID and sends snapshots to attached clients only (`sessions.ts:275-289,320-330`).
- V1 does not replace the contained AgentSession after acquisition, because same-session new/fork/switch/import is rejected (see the v1 replacement gate below); the PiSessionRuntime adapter subscribes once and unsubscribes on dispose. If a later version exposes replacements, it must rebind to the new AgentSession after successful preflight before publishing its new snapshot (`agent-session-runtime.ts:101-103,188-202`).
- Extension callbacks/errors remain within their AgentSession. An adapter must not turn one session’s exception into service/server-wide close; translate runtime-fatal errors to `PiServerError` for that runtime and let PiServer terminate that live session (`sessions.ts:275-300`). Listener exceptions must not break session routing.

## 共享运行时/资源装配边界

This module consumes the shared-runtime assembly specified by `20-shared-runtime-isolation-concurrency.md`; it does not define pooling or performance claims. Host-backed `AgentSession`s each receive an `AgentSessionScope`; prompt slots/macros and ModelRuntime extension providers are scoped and coordinated. Extension runners, settings/resource loaders, tools, memory modules, session manager, abort state and event subscriptions stay per Session.

- The legacy module-level prompt slot/macro Maps remain for unscoped callers, while Host-scoped compilation resolves through that Session's `PromptRegistryScope`; one top-level Session cannot overwrite another's custom definitions.
- Each Host Session memory renderer captures its own module/store and is registered in its scope. A subagent has a fresh child scope; its selected prompt is compiled in parent scope before only the resulting messages are passed to the child, not the parent registry or closures.
- pi-ai compat API providers remain a process-global registry, but the supported Host Extension API does not expose raw registration/reset calls. Scoped reload does not call `resetApiProviders()`; unscoped legacy reload retains its prior reset behavior. Raw compat/global mutation is outside the trusted Host extension contract and requires a separate Host/process.
- `AgentSessionScope` coordinates supported ModelRuntime provider registrations by extension owner and stages scope updates. Each `AgentSession` still owns its tools, SessionManager, abort state, settings/resource loader and event subscriptions.

**Isolation gate status:** the scoped mechanisms above are implemented and covered by the focused/full coding-agent tests. This does not claim isolation for arbitrary JavaScript module state or direct process-global mutation; only product-curated trusted extensions conforming to the scoped API contract may share a Host.
- RequestGateway is shared only with meaningful identities; Host injects the stable protocol session ID as request identity instead of the legacy SDK fallback `{ sessionId: "?", priority: 2, label: "main" }` (`sdk.ts:422-427,469`).
- Adapter errors: unknown durable ID→`PiServerError("not_found", ...)`; duplicate session file→`session_locked`; active-runtime saturation→existing protocol `busy` with structured `{ reason: "active_runtime_limit", limit }` (`server/src/errors.ts:11-28`, `protocol/src/schemas.ts:269-282`); invalid configuration/conversion→validation/internal error. Root-owner conflict is different: return typed local startup error `{ code: "busy", details: { reason: "root_owned" } }` before PiServer listeners start; do not serialize it as a session command response. No new protocol error taxonomy is required.

## 所有权、副作用与错误/并发边界

- `PiServer` owns listener/connection lifecycle, protocol routing and active `PiSessionRuntime` acquisition lifecycle. `CodingAgentServerService` owns durable metadata, protocol-ID→fixed per-ID JSONL mapping, exclusive file/root claims, runtime construction/reopen, snapshot/event translation and shared-runtime service leases. Each `AgentSessionRuntime` owns one current AgentSession and its session-scoped services. The `CodingAgentPiServerHandle` owns the `PiServer` plus assembly-created shared coordinator/catalog resources, but not caller-injected catalog/store. Product owns domain scheduling/permissions/entity mapping.
- Create/open same durable ID: rely on PiServer single-flight, while service checks durable store ID and file identity. Distinct protocol IDs resolving to same normalized file are a conflict, not a second runtime.
- Close/dispose is idempotent per runtime; it awaits `AgentSessionRuntime.dispose()` which aborts, emits session shutdown, invalidates context and disposes current AgentSession (`agent-session-runtime.ts:171-186,406-408`). Always release owner claim even if dispose reports an error.
- Server close races with in-flight create/open: PiServer awaits openings and disposes acquired runtimes (`sessions.ts:179-196,236-271`); service must dispose runtime if construction finishes after server enters closing, and must never publish a partially-created runtime.
- AgentSession `dispose()` aborts its own retry/compaction/bash/side requests and clears its own event listeners/resources (`agent-session.ts:1394-1429`). This is the containment basis: failure/abort/dispose of A must not cancel B.
- Adapter errors: unknown durable ID→`PiServerError("not_found", ...)`; duplicate ID/path ownership→`session_locked`; malformed command/value→existing validation/invalid_request; setup or unsupported conversion errors are reported with cause and safely surfaced as existing server error class. No new protocol error taxonomy in this module.
- `PiServer.close()` closes server listeners and every acquired runtime (`server.ts:156-170,338-349`). The assembly handle must release session leases/file claims and its own closeable gateway/coordinator/provider registrations only after all runtimes are closed. It must not promise disposal of the shared `ModelRuntime`: current `ModelRuntime` has no public dispose API; drop owned references only, and never close a caller-owned store. Do not make one session dispose a shared service.
- PiServer's final detach auto-disposes only when idle/no operations; active sessions remain live until work settles (`sessions.ts:357-378`). Preserve this behavior. In-flight prompts cannot be lost just because the last client disconnects.

## 架构选项与推荐

| 候选 | 优点 | 风险 / 不适配点 | 结论 |
|---|---|---|---|
| coding-agent service keeps a second `Map<sessionId, AgentSessionRuntime>` | Could track acquired runtimes and path owners. | PiServer `LiveSessionManager` already owns the active ID→runtime registry and same-ID single-flight; a second live-session map duplicates lifecycle state and can diverge from server detach/reopen. Keep only the minimal path-owner claim set needed to reject aliases. | Reject as a second registry. |
| Add public `CodingAgentHost` / `HostSession` wrapper registry | Could offer another direct embedded lifecycle surface. | Duplicates PiServer create/list/attach/detach/session lease and adds an unneeded identity/owner. Revised contract defines no separate hostSessionId. | Reject for v1; `createCodingAgentPiServer()` is the single assembly-owner handle, not a per-session facade. |
| Direct `AgentSession` as `PiSessionRuntime` | Directly exposes prompt and event subscription. | `PiSessionRuntime` also requires phase/snapshot, async dispose, and scoped operation behavior; direct AgentSession does not itself assemble/provide the complete protocol projection or service ownership. Replacement-staleness is not a v1 concern because replacements are explicitly rejected. | Reject: it does not implement the server runtime contract. |
| Per-acquired-runtime adapter wrapping `AgentSessionRuntime` | Uses the existing coding-agent construction, abort, shutdown, and disposal lifecycle while retaining fixed protocol ID and one SessionManager/file. | Requires a durable file catalog, owner claims, snapshot/event projection and shared-runtime assembly; those are the adapter’s actual missing responsibilities. | **Recommend.** PiServer owns multi-session routing; service returns one `PiSessionRuntime` adapter per acquired durable ID. |

The `createCodingAgentPiServer()` owner handle is the supported convenience composition. Existing `PiClient` lifecycle belongs to consumers; `PiServerService` `list/create/open` and runtime `dispose` remain the session contract. Do not add another in-process SDK `get/list/close` API or wrap it in a second HostSession registry.

## 代码落点（设计建议）

- Current implementation lives under `packages/coding-agent/src/server/`: `host-root-lock.ts` owns the root lock, `session-store.ts` implements the durable catalog/store, and `coding-agent-server.ts` composes `PiServer`, service, store, and owner shutdown. Keep the public factory/types at the existing package export surface; do not introduce a parallel `src/server-service.ts` or second lifecycle facade.
- `sessionStorageDir` selects a dedicated session root; existing CLI/project session files are not migrated. Built-in store and root lock are assembly-owned and closed only after PiServer and acquired runtimes shut down; injected `sessionStore` remains caller-owned. Root lock acquisition precedes catalog access and listener startup.
- V1 does not change `agent-session-runtime.ts` replacement semantics: each durable PiServer ID owns one fixed SessionManager/file. During assembly, bind `AgentSession.bindExtensions({ commandContextActions: ... })` with explicit rejecting callbacks for `newSession`, `fork`, and `switchSession`, rather than inheriting `ExtensionRunner`'s success-shaped `{ cancelled: false }` defaults (`agent-session.ts:4386-4396,4479-4487`; `extensions/runner.ts:342-345,484-502`). Also ensure no separately exposed extension path can perform those replacements; otherwise reject that extension configuration. If a future consumer proves replacement is required, only then add the 00 §4 owner-preflight before teardown; fork additionally needs a reservation seam before target writes in `session-manager.ts:1474-1552`.
- Reuse `packages/coding-agent/src/core/agent-session-services.ts:37-92,147-205,216-239` and `core/sdk.ts:83-180,266-299,422-427,571-595` for Session construction and service injection; shared provider registration rules/slot resource isolation belong to module 20.
- Extend or add snapshot mapping near `packages/session-protocol/src/converters.ts:56-97` only if its current helpers are appropriate; full transcript/snapshot aggregation may belong in coding-agent adapter because it needs SessionManager and runtime state.
- `packages/coding-agent/src/core/session-manager.ts:863-925,927-952,976-1027,1576-1622` provides current JSONL create/open/persistence. The default file catalog owns only durable ID metadata and fixed file location; it must not substitute a new transcript repository or mutable replacement mapping.

## 与当前状态差异

- Generic `PiServer`, session protocol and `PiClient` already implement multi-session remote surface; leave their semantics intact.
- `createAgentSession()`与`AgentSessionRuntime`仍是单session构造与生命周期底层；coding-agent `PiServerService` adapter现位于`packages/coding-agent/src/server/coding-agent-server.ts`，负责PiSessionRuntime projection与service catalog。
- V1固定protocol ID、SessionManager ID与一个持久session tree/file；`FileCodingAgentServerSessionStore`恢复同一位置，并通过writer/root ownership拒绝path alias及跨Host并发写。
- SessionManager自身仍无per-path lock；adapter store/file ownership负责防止跨protocol IDs和跨进程并发写。
- Extension/provider资源政策已落地：AgentSessionScope隔离prompt registry与memory closures，并协调支持的ModelRuntime provider registration；每Session仍创建独立SettingsManager、ResourceLoader、ExtensionRunner、tools、SessionManager与abort/event state。
- package subpath、listener start/close owner、manifest create/reopen和active-runtime cap已实现；full coding-agent suite及build通过。Linux WSL ext4 process lock已通过2/2；原生macOS/Windows runner和性能基准未运行。

## 验收测试（消费者可见行为）

1. **Official client multi-session integration:** use existing `PiServer` with coding-agent service and existing `PiClient`; create two sessions, prompt concurrently, observe snapshots/progress and persisted files remain isolated. Assert protocol IDs match snapshots; do not re-test generic client envelope forwarding.
2. **V1 fixed identity:** create durable protocol ID P; assert P is identical in the returned snapshot, durable catalog key, SessionManager ID, and JSONL header. Prompt and close/reopen P; the resolved session file remains stable and the same transcript resumes.
3. **Same-file ownership:** two durable IDs resolving to one normalized JSONL path cannot both acquire; loser receives stable `session_locked` without writing. After owner disposal, the durable mapping remains intact and reopen is correct.
4. **Same-ID acquisition single-flight:** concurrent PiServer attach/open for one durable ID produces one acquired coding-agent runtime; its snapshot reports the requested ID and no duplicate extension startup/file writer occurs.
5. **Settle and detach:** prompt starts, final client detaches; runtime remains until operation settles, then idle disposal releases its file claim; subsequent attach reopens and sees completed output.
6. **Independent abort/error/dispose:** A abort/failing tool/runtime and A release do not alter B's active output, gateway identity, event subscription or disk state; B continues prompting successfully.
7. **Owner close ordering:** `createCodingAgentPiServer()` returns an owner handle. Its close waits for PiServer and all active runtime disposal before releasing assembly-owned gateway/coordinator/provider registrations and closing the built-in file catalog/root claim; caller-injected stores remain usable/open after handle close. A direct low-level PiServer caller must explicitly close PiServer before releasing its caller-owned resources.
8. **Snapshot adaptation boundary:** protocol snapshot reflects representative user/assistant/tool and queued-steer states, valid revision and phase, including explicitly specified unsupported-content behavior; conversion failure is surfaced rather than malformed/incorrect success.
9. **Scoped registry isolation:** two sessions use different same-named prompt slots/macros, memory databases and supported `ModelRuntime` provider registrations; each observes its own configured behavior without overwrite or cross-database reads. Raw pi-ai compat API-provider mutation remains process-global and outside the supported Host Extension API.
10. **Supported provider/prompt reload noninterference:** A、B使用不同preset/memory store及受支持的`ModelRuntime` provider registrations；A scoped reload/dispose不能改变B的slot/macro、memory或provider能力。Host-scoped reload不调用`resetApiProviders()`，unscoped legacy reload仍保留兼容reset。pi-ai raw compat global mutation超出Host-supported extension API，不列作跨scope coordinator行为。
11. **Replacement exclusion:** v1 exposes no same-session new/fork/switch/import route, and no supported extension path can trigger one indirectly; unsupported replacement-capable extension configuration is rejected rather than silently accepted.
12. **Root ownership split-brain and recovery:** start owner process A on a root and have it hold the process-lifetime OS lock; pause A (e.g. SIGSTOP) while lock remains held, then start B on the same root and assert local `busy`/`root_owned` before listener/catalog access. Resume A; only A may continue writing. Kill A (`SIGKILL`); after kernel releases the lock, C can start and reopen the durable record without corruption or waiting for any mtime-stale interval. Verify supported local filesystem/OS matrix; on unsupported or unverified targets assembly fails closed. This test must not simulate `onCompromised` as a substitute for fencing.
13. **Active-runtime admission:** configure `maxActiveRuntimes = 1`; create/detach B so its durable record exists, then open and attach A. While A remains attached, a second create C and open B both return protocol `busy` with `details.reason: "active_runtime_limit"` before C's catalog/manifest/JSONL exists or B's file changes. A remains attached and can prompt (no queue or eviction). After A detaches and idle disposal releases its slot, B can open and C can be created. The durable record count may exceed one although only one runtime can be live.

14. **Provider request limit validation:** reject service assembly before storage/catalog writes, runtime creation, or listeners when `defaultMaxConcurrency` is missing, `0`, negative, `Infinity`, or `NaN`; likewise reject an explicit provider override with a missing `maxConcurrency`, `0`, negative, `Infinity`, or `NaN`. Accept a finite positive default with finite positive overrides, and verify unconfigured providers inherit the default. No request may proceed without an effective finite limit.

现有 lifecycle 测试提供顺序基线：`packages/coding-agent/test/suite/agent-session-runtime.test.ts:166-213` 验证 replace 前 settle；`:215-258` 验证 shutdown/start event 次序；`test/agent-session-runtime-events.test.ts:115-181` 验证 lifecycle cancellation；`test/sdk-session-manager.test.ts:28-94` 验证 session path 与 manager injection。新增验收须验证真实 PiServer + coding-agent service 行为，不以 source/wiring 或 mock echoes 代替。

## 发现的冲突 / 需修订上位文档

- 旧计划 `plan/multi-agent-infrastructure.md:15-18,40-46,111-115` 偏好进程簇并称 daemon 暂不做；当前目标要求同一 PiServer 承载可共享的多 Session。保留异构会话故障隔离的多进程选项，但不照旧计划否决 coding-agent adapter。
- `plan/high-concurrency-optimization.md:25-30` 与 `plan/multi-agent-design-assessment.md:186-231` 的自建协议、`SessionRegistry<AgentSessionRuntime>`、sessionId RPC 参数化已被 `packages/server/protocol/client` 覆盖，应标成 superseded / adapter gap，不要继续实现第二套。
- `plan/affiliated-session.md:10-20,47-63` 是父子继承/读写治理，不应把 parent context、state inheritance、writeback 纳入普通 PiServer SessionService 需求。
- `packages/server/README.md:1-40` 仍将 PiServer 标 experimental 且要求应用提供 service；coding-agent adapter 的 package stability/release/export 边界需要 owner 拍板后，对外 README 才能描述成可复用正式能力。
- 当前 `packages/session-protocol` converters 仅是单 message adapters，不应被其他文档描述成已完成 coding-agent snapshot integration（`converters.ts:56-88`）。

## 未知 / 技术门与范围边界

- **已定设计 / 尚未完成运行验证：**root-lock mechanism is selected and implemented on Linux in `packages/coding-agent/src/server/host-root-lock.ts`: hold a real uncommitted `node:sqlite` write transaction opened with `BEGIN EXCLUSIVE` for the owner/process lifetime. This is not a bare BEGIN and not `proper-lockfile` stale reclaim; proper-lockfile has been ruled out because an mtime-based stale reclaim can steal a paused live owner's lock, allowing split-brain writes. The shared default store must support Linux/macOS/Windows on same-machine local filesystems; remote/shared filesystems and unknown FS types/platforms MUST fail closed. Linux implementation status does not imply completed macOS/Windows runtime verification. The Linux/macOS/Windows process-lock matrix, including contention, paused-owner fencing and kill/reopen recovery (acceptance item 12), remains a test and production-release gate; until each supported target passes, do not claim it is verified or enable an unverified target. Root locking does not provide cross-host/shared-directory session storage.
- protocol v1 snapshot 对 coding-agent 特有 extension/state/custom messages 的有损投影边界及 phase/revision/queued-steer准确映射；需由 adapter/protocol integration reviewer逐类裁定。
- `packages/server` Experimental 稳定性对 coding-agent 正式 export/release 的影响；是否先以实验性子路径导出。
- The built-in file store requires a dedicated `sessionStorageDir`; existing CLI/project session files are not migrated. Its root lock protects the built-in store on supported same-machine local filesystems only. A caller-injected `sessionStore` remains caller-owned and must supply its own durable ownership/recovery guarantees.
- 用户已拍板本轮正式消费客户端为 Node/TypeScript `PiClient`；没有 Python SDK 交付或 NeonRP 直接接入承诺。Rivet full cutover、callback/tree protocol 扩展与切换属于后续独立范围，不再列为用户待决定事项。