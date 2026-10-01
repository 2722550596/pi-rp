# Client transport and protocol design

## 1. 需求对照

| 效果 / 约束 | 需求来源与对应 | 对本模块的含义 |
|---|---|---|
| 多个参与者共同参与同一个 Pi 会话 | `00-需求原话.md` 原文第 9 行；效果清单第 21 行 | 参与者各自连接 PiServer 并 attach 同一 session；这只是参与者侧能力，不单独构成浏览器执行者接入闭环。 |
| 不要求平台为每个会话常驻 Pi Node 进程 | `00-需求原话.md` 效果清单第 22 行；用户补充决策第 43–47 行 | 参与者继续使用 PiClient；Pi-rp 还需定义浏览器执行者出站通道，平台负责绑定、路由及 broker，不由此文档设计执行端 driver。 |
| 限于 Pi-rp，不做下游平台服务、认证、UI、权限 | 原文第 13 行；效果清单第 24 行；共享契约 §1 第 8–12 行 | PiClient 消费宿主提供的已授权传输；本模块不规定平台身份、授权、房间、成员或 UI。 |
| 参与者复用既有 client/protocol；执行者是独立方向 | 解法清单第 28–35 行；用户补充决策第 43–47 行；共享契约 §3.1 | 不改造 PiClient 去承载执行者注册或服务端下行 runtime 命令；执行者 wire contract 由其专属设计定义，并与 participant 协议分工。 |
| 浏览器能作为 outbound client；不能假设浏览器监听公网 socket | 共享契约 §3.5 | 本文只讨论 participant 的 PiClient 出站 `ByteTransportFactory`；浏览器执行者也为出站连接，但其通道与 client transport 不等同。 |

## 2. 一句话定位

PiClient / `pi-protocol` 已能支撑**参与者到 PiServer**的 attach、命令及状态订阅；它们不是浏览器执行者通道。Pi-rp 需另行定义执行者出站通道及其与服务端 runtime proxy 的接口，但本设计仅负责 participant interoperability 和两侧共享 wire constraints，不提出执行者 driver/协议的具体方案。

## 3. 现状证据与效果适配判断

- Client 的网络边界已经是传输工厂：`ByteTransportFactory` 负责创建 fresh、connected、authenticated 的 byte transport，client 不持有网络/认证实现（`packages/client/src/transport.ts:1-18`）。`PiClientOptions` 仅要求该工厂并可配置 frame 长度和 listener 错误处理（`packages/client/src/types.ts:14-19`）。这是**参与者** transport factory，不是执行者通道（`01-共同上下文.md:32-34,38-45`）。
- `PiClient.attachSession(sessionId)` 明确以 `shared` lease 调用 `acquireSession`（`packages/client/src/client.ts:147-149`）；租约只在单个 PiClient 实例内跟踪，既非跨进程所有权锁，也不是服务端并发执行选举（`packages/client/src/client.ts:381-400`；共享契约 `01-共同上下文.md:23`）。
- 服务端已允许多个**参与者连接** attach 同一个 live runtime：每个 live session 持有 `connections: Set<ConnectionState>`（`packages/server/src/sessions.ts:7-16`）；attach 将连接加入该集合（`:300-307`）。已 attach 连接可调用 prompt/steer/abort/set_model/set_thinking；未 attach 时拒绝（`:90-117,309-317`）。
- 同一 live session 的 progress 向已 attach 参与者连接广播，runtime snapshot 变化广播完整 session snapshot（`packages/server/src/sessions.ts:248-263,293-307`）。attach 返回当前 session snapshot（`:66-74`）。Snapshot 含 transcript、phase、model、revision、queued steer 等（`packages/protocol/src/schemas.ts:241-256`）；progress 含 item_started、assistant_delta、item_updated、item_finished（`:203-230`）。该既有协议覆盖参与者共享观察/命令面，不代表执行者接入已闭环。
- hello 带当前 server snapshot（`packages/protocol/src/schemas.ts:384-389,412-417`；`packages/server/src/server.ts:221-249`）。重新 attach 可取当前 session snapshot，但不是 progress 历史回放（`packages/protocol/src/schemas.ts:203-230,400-410`）。
- 现有消息方向是 PiClient 向 server 发送 request、接收 response/event（`packages/client/src/connection.ts:101-117,162-204`）；participant schema 没有执行者注册、上行 runtime progress 或 server-to-executor runtime command（`packages/protocol/src/schemas.ts:291-324,391-410`；`01-共同上下文.md:32-34`）。`PiSessionRuntime` 是 server 对已获取 runtime 的进程内方法调用接口（`packages/server/src/types.ts:42-60`）；browser-engine 暴露本地 AgentSession 而非远程 runtime（`packages/browser-engine/src/assemble.ts:186-202`）。执行者通道和 proxy/runtime 由其他设计模块处理。

## 4. 推荐的 API 形状

**参与者侧保留现有签名，不新增 PiClient participant API：**

```ts
interface ByteTransport {
  send(chunk: Uint8Array): Promise<void>;
  close(): void;
}
interface ByteTransportHandlers {
  onData(chunk: Uint8Array): void;
  onClose(): void;
  onError(error: Error): void;
}
type ByteTransportFactory = (handlers: ByteTransportHandlers) => ByteTransport | Promise<ByteTransport>;

interface PiClientOptions {
  transportFactory: ByteTransportFactory;
  maxFrameLength?: number;
  onListenerError?: (error: Error) => void;
}
```

以上为现有 participant API 摘录（`packages/client/src/transport.ts:1-18`、`packages/client/src/types.ts:14-19`）。Browser participant 根据宿主 endpoint、凭据提供该 factory，再经 `PiClient.connect()` / `attachSession(sessionId)` 接入参与者协议（`packages/client/src/client.ts:96-115,147-149`）。这些 API 不是浏览器执行者接口；不可将它们复用描述为执行端注册/调用方式。

## 5. 行为契约（遗漏后果）

1. 宿主创建 transport 时必须保证连接已完成宿主要求的认证，并遵循有序 byte chunks；漏掉认证/顺序契约会使握手或 framing 失败，也会越过 Pi-rp 与平台认证的边界（`packages/client/src/transport.ts:1-18`）。
2. Client 首次发送协议版本 hello，收到服务器 hello 和全局 snapshot 后才进入 connected；不实现 hello/version 行为将不是有效 Pi protocol client（`packages/client/src/connection.ts:66-89,162-196`；`packages/protocol/src/schemas.ts:384-417`）。
3. 参与者以各自独立的 PiClient 实例连接，然后各自 `attachSession(id)`；漏掉 attach 会令会话操作因服务端连接未附着而被拒绝（`packages/client/src/client.ts:147-177`；`packages/server/src/sessions.ts:309-317`）。
4. 除 attach 外，不把同 session 的 PiClient lease 误认为全局互斥/所有权；每实例本地共享 lease 用于管理该实例下 handle 生命周期，不能替代 host 权限或跨连接协作控制（`packages/client/src/client.ts:381-400`）。
5. 操作须使用现有 prompt/steer/abort/set_model/set_thinking commands，成功响应返回对应 session snapshot；新增平行命令层会导致协议语义分叉（`packages/protocol/src/schemas.ts:291-375`）。
6. UI 消费 snapshot 作为当前权威状态、progress 作为实时增量；断线重连应重新 attach/取得新 snapshot，不得把未收到的 progress 当成有 replay 保证（`packages/protocol/src/schemas.ts:203-230,241-256`）。
7. WebSocket/其他宿主 transport 的关闭与错误必须分别调用正确的 terminal handler；重复 `close()` 对 transport 实现须无害（`packages/client/src/transport.ts:4-14,17-18`）。
8. Keep participant command/event direction separate from executor traffic; treating PiClient as the execution channel would fail because its protocol defines no executor registration or server-to-executor runtime commands (shown in §3; `packages/client/src/connection.ts:101-117,162-204`, `packages/protocol/src/schemas.ts:291-324,391-410`).
9. If a session snapshot exceeds the existing maximum frame size, do not add participant events/fields or change protocol version; use existing attach/command error handling with `invalid_request`, suppress an oversized snapshot event, and let already-attached participants continue receiving progress. This is the main design ruling, 2026-10-01; see protocol/frame/server evidence in §7.

## 6. 文件与副作用边界

- `packages/client/src/transport.ts` 和 `packages/client/src/types.ts` 是既有注入面；实现不应自行创建连接、保存 auth 或确定 server URL（`:1-18`；`packages/client/src/types.ts:14-19`）。
- `packages/protocol/src/schemas.ts` 的现有 command/snapshot/progress schema 是 participant 协议契约；共享 transcript wire shape 应被执行者契约复用或映射，不应由本模块复制一套（`packages/protocol/src/schemas.ts:203-230,241-256,291-324,400-410`；`01-共同上下文.md:38-45`）。
- `packages/server/src/listener.ts` 要求宿主在必要 transport authentication 后提供已建立连接；PiServer 通过 listener 接收参与者连接（`packages/server/src/listener.ts:1-10`；`packages/server/src/server.ts:85-99`）。执行者通道是独立 role/direction。
- 本模块不拥有浏览器 harness `AgentSession` 生命周期、执行者 driver、执行者通道或 runtime proxy；execution adapter 是独立文档边界（`packages/browser-engine/src/assemble.ts:189-202`；`packages/server/src/types.ts:41-60`）。
- 无推荐 participant client/protocol 代码改动；这不代表本需求无需任何 Pi-rp 新增能力。
**落账：**协议副作用由 PiServer 执行已有 session 命令，并经 `PiSessionRuntime` 回传 snapshot/progress；client-side transport factory 不落业务数据。会话持久化由宿主 `PiServerService` 负责（`packages/server/src/types.ts:54-60`），PiServer 的 server snapshot revision 由发布器递增（`packages/server/src/snapshots.ts:21-24,44-60`）。本模块不新增账本、事件日志或命令去重存储。

**Participant WebSocket transport：**浏览器参与者调用方可用宿主提供的 `ByteTransportFactory` 包装浏览器可用的 WebSocket；连接、认证材料与 endpoint 均由宿主确定。server listener 可以自行实现 WebSocket upgrade/auth（`packages/server/README.md:36`）。本节只评估 PiClient participant transport，不覆盖执行者通道；执行者通道是否复用相同字节 transport 由执行者设计裁定。


## 7. 命令、事件与错误语义

- Request envelope 仅携带 `id` 与 `request`；成功/失败 response 原样关联该 ID，错误码为 version/busy/session_locked/not_found/invalid_request/not_implemented/internal_error（`packages/protocol/src/schemas.ts:269-324,391-395,422-435`）。请求 ID 用于匹配响应，不是去重 key。
- attach 和每个可变命令的结果都含当前 session snapshot；事件是独立 envelope（`packages/protocol/src/schemas.ts:328-375,400-410,436-439`）。PiClient 先按 ID 取 pending request，再校验 response command 与请求 command 对应；未知 response ID 导致连接 protocol failure（`packages/client/src/client.ts:294-319`）。

Ordinary attach/command rejection remains an error response for the request ID: e.g. attach to a missing session may return `not_found`, a command from an unattached connection returns `invalid_request`, and a terminating runtime can return `session_locked` (`packages/server/src/sessions.ts:66-74,90-117,309-317`, `:186-195`). PiClient rejects the relevant promise with `PiServerError` retaining protocol `code`, message, and `details`; a transport disconnect instead rejects pending requests with a disconnect error and does not replay them (`packages/client/src/client.ts:294-307,321-340`; `packages/client/src/errors.ts:3-18`). No new participant event is needed for either case.

**Attach / command errors and oversized snapshots:** protocol already includes `invalid_request` (`packages/protocol/src/schemas.ts:269-282`), and `PiClient` turns an error response into `PiServerError` retaining code/details (`packages/client/src/client.ts:294-307`; `packages/client/src/errors.ts:3-12`). The frame cap defaults to 16 MiB (`packages/protocol/src/framing.ts:5-6`). The accepted design ruling is: an attach/command whose response snapshot exceeds that cap must produce the existing `invalid_request` response; an oversized `session_snapshot` event is suppressed, with no new event or field, and progress continues to already-attached connections; authoritative oversized-state handling belongs to the platform `PiServerService`. No `session_snapshot_error`/`snapshotError`, `RemoteSessionState`, or `PROTOCOL_VERSION` change is proposed. This is a design ruling, not a claim about current implementation behavior: today `handleRequest` sends an error response when execution throws, but `sendMessage` closes the connection if encoding the response/event itself fails (`packages/server/src/server.ts:252-269,293-301`); session snapshot broadcasts call `sendMessage` directly (`packages/server/src/sessions.ts:293-297`). The server path therefore needs to detect the oversized snapshot before attempting to encode an unbounded response/event to realize the ruling.
- 多个参与者的命令最终作用于一个 PiSessionRuntime；Runtime 契约要求 conflicting operations reject rather than queue（`packages/server/src/types.ts:41-52`）。并发参与意味着共同观察/提交同一会话操作，不意味着同时执行多个浏览器 runtime 或命令必然排队成功。
- Disconnect 会清空 server 对该连接的 attachments，再按是否仍有连接、操作或非 idle phase 判断 runtime dispose（`packages/server/src/sessions.ts:122-132,324-345`）。断开一个参与者不会因另一个连接仍 attached 而立即 dispose 同一 runtime。

## 8. 断线、重连、回放和幂等限制

- Client 暴露 `reconnect()`，但只是再次调用 `connect()`；不存在自动重连 loop、指数退避或自动 reattach（`packages/client/src/client.ts:107-119`）。每次成功握手只应用 server snapshot；client 的 session attachment handles 在 disconnect 时被清理/失效（`:321-327`）。调用方重连后应重新 `attachSession(sessionId)` 并以 attach snapshot 重建当前视图。
- 断线时 pending 请求被 reject，未对命令自动重发（`packages/client/src/client.ts:321-340`）。发送端可能在服务端执行前断线，也可能服务端已执行但 response 未到达；客户端无法仅凭异常区分两种情形。因此 prompt/steer/create 等产生副作用的命令结果可能不确定，用户/调用方必须核对新 snapshot，再自行决定下一步，不可盲目自动重试。
- Server 收到每个 request 后直接执行并回送 envelope ID；代码未维护已处理 ID 的去重表（`packages/server/src/server.ts:252-269`）。协议也没有操作 nonce/idempotency key 或命令结果查询接口（`packages/protocol/src/schemas.ts:391-395`）。故不承诺 exactly-once，也不承诺 at-least-once。
- Fresh handshake 的 server snapshot 是当前状态快照，不包含事件 offset；attach 返回 session snapshot；progress 是即时广播，未被协议定义为日志（`packages/server/src/server.ts:221-249`；`packages/server/src/sessions.ts:66-74,248-263`；`packages/protocol/src/schemas.ts:203-230,400-410`）。快照可恢复“当前 transcript 与状态”，不能恢复离线期间每个 delta 的时序、瞬时进度或事件。
- Snapshot `revision` 是 session snapshot 字段，server-level revision 为 server snapshot 变更修订号；它们不构成 progress 序列号或可请求的历史游标（`packages/protocol/src/schemas.ts:252-267`）。

## 9. Generic WebSocket ByteTransport 评估

**建议不将通用 WebSocket 实现加入 participant `pi-client` 或 `pi-browser`。**

- 现有 participant factory 要求新建 connected、authenticated transport（`packages/client/src/transport.ts:17-18`）；Browser host 可按自身认证方式包装原生 WebSocket，不需要 PiClient 知道 URL 或 credential。
- `PiServerListener` 消费宿主在 transport authentication 后交付的连接（`packages/server/src/listener.ts:3-9`）；server README 提到 WebSocket upgrade credential validation（`packages/server/README.md:36`）。某个 server WebSocket stack 不是 participant client API 的通用缺口。
- 执行者通道是用户明确选择由 Pi-rp 定义的独立出站通道（`00-需求原话.md:43-47`；`01-共同上下文.md:38-45`）。本模块不裁定它使用何种 transport，也不把“participant 无需 generic WebSocket helper”的结论扩展成“Pi-rp 无须新增执行者通道”。[推断]
- 一个不携带认证策略的 participant WebSocket adapter 只转发数据/关闭/错误，宿主仍负责 URI、授权材料及生命周期；当前无需因此扩充 participant API。[推断]

## 10. 精确代码落点与最小可复用变更

当前最小 participant 改动：**不改 PiClient participant API，不改现有 participant command/event protocol，不新增 participant WebSocket helper**。已有 PiClient / ByteTransportFactory / PiSessionHandle / participant schemas 可继续连接 PiServer（`packages/client/src/index.ts:1-17`；`packages/protocol/src/index.ts:1-4`）。

浏览器执行者通道及其服务端 proxy/runtime 适配是本项目新增的独立能力，由对应设计模块定义；此文档不设计其消息集合、driver 或生命周期。跨模块共享约束是：参与者仍通过 PiClient 发起标准命令并收到既有 response/snapshot/progress；执行者协议不得私改或复制这些 participant wire DTO/命令语义，且必须定义它如何使 PiServer 所需 `PiSessionRuntime` 方法与事件语义可用（`packages/server/src/types.ts:42-52`；`01-共同上下文.md:38-45,49-54`）。PiServer 的 service 实现仍由宿主提供，Pi-rp 不实现平台 broker（`packages/server/src/types.ts:54-60`；`packages/server/README.md:38-40`）。

### 与现状差异

现有 participant client/protocol 足以支撑多个参与者接入同一 runtime，但目前 Browser harness 没有 remote execution path，且 participant protocol 不表达执行者角色/反向命令方向（`packages/browser-engine/src/assemble.ts:186-202`；`packages/client/src/connection.ts:101-117,162-204`；`packages/protocol/src/schemas.ts:291-324,391-410`）。按用户补充决策，整体交付须另定义 Pi-rp execution channel；不应把该缺口归到 PiClient participant API，也不应称“整个效果已经闭环”。此文档建议 participant 部分保持现状。


## 11. 消费者可见验收建议

参与者互操作验收在独立执行者通道和 runtime proxy 可用后验证（执行者通道验收不在本文负责范围）：

1. 两个独立 PiClient 通过两个 ByteTransportFactory 连接同一个 PiServer，均能 attach 相同 session ID 并获得同一会话 snapshot。
2. 一端 prompt/steer 后，另一端能从既有 progress/snapshot 观察更新；participant 使用的命令、response 与 progress DTO 不需新造或改写。
3. 一个 participant 断开时，另一个仍能操作同一 runtime；断开端重新 connect、reattach 后取当前 snapshot，不声称补收离线 progress。
4. 命令附近断线后不自动重放，结果可能不确定；participant lease 不提供跨连接协调、鉴权或执行者选举。
5. An oversized snapshot must follow §7’s established `invalid_request`/event-suppression behavior without introducing a participant-facing error event, snapshot field, or protocol version change; already-attached participants continue receiving live progress.

以上为消费者行为验收建议，不是本设计代理执行的测试；按任务约束未运行测试或构建。

## 12. 发现的冲突 / 仍未知待拍板

### 发现的冲突 / 需要修订上位文档

- 新增用户决策允许并要求 Pi-rp 设计通用执行者出站通道（`00-需求原话.md:43-47`；`01-共同上下文.md:12,38-45`）。本文未发现 participant API/protocol 需要随之改造；participant 和执行者是不同角色/消息方向，不可据此声称整个 Pi-rp 能力已完整。
- `01-共同上下文.md:22-24` 的 participant 断线限制与此文一致；新执行者通道的 resume/ownership 能力仍由执行者专属设计明确，不从 PiClient request ID 或 snapshot revision 推导保证（`01-共同上下文.md:43,49-54`）。

### 仍未知待拍板

- 未知项仅限 participant host 最终选择何种有序字节承载；endpoint、凭据取得和 transport auth 属于 host 决策。执行者协议具体签名、消息方向、断线恢复及 proxy 映射不在本文范围，应由负责 execution-channel 的设计模块决定，不能由本 participant 文档预设。
