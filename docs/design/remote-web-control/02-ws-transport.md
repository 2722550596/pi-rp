# D1：WebSocket transport 设计

## 1. 需求对照（逐条引用原话与效果项编号）

| 效果 | 需求原话（`00-需求原话.md`） | 本模块责任 |
|---|---|---|
| E1 | "在 pi 交互式 TUI 内一条命令（`/remote`）开启远程分享，立即得到一个 web 链接（含局域网地址提示与二维码）。"（`00-需求原话.md:19`） | 提供可传入 host/port、可查询实际绑定地址的 listener/server；链接组装由 D2 做。 |
| E2 | "任意现代浏览器（明确目标：安卓 13 / MIUI 14 自带浏览器与 Chrome）打开链接，无需安装任何东西，即可实时查看正在运行的会话：流式 assistant 文本、thinking、工具调用卡片、用户消息、排队消息。"（`00-需求原话.md:20`） | 提供浏览器可用的 HTTP 静态文件服务及标准 WebSocket 二进制连接；会话呈现属于 D3。 |
| E3 | "浏览器端可以发送 prompt、turn 进行中 steer、中断（abort）——即用户原话'直接控制进程'。"（`00-需求原话.md:21`） | 双向传送有序字节，交由既有 PiServer 协议层处理；不在 transport 实现业务命令。 |
| E4 | "直连架构：无 relay、无第三方服务依赖；host 主动监听，浏览器直接连接。"（`00-需求原话.md:22`） | listener 直接使用本机 HTTP/TCP socket，不访问 relay/外部服务。 |
| E5 | "链接即权限：token 一次性生成、仅存内存，`/remote stop` 立即失效。"（`00-需求原话.md:23`） | 只验证调用方提供的 token；listener close 关闭 HTTP/WS 服务，使现存与新连接均失效。token 生成/撤销归 D2。 |
| E6 | "TUI 与浏览器同时操作同一会话：TUI 不中断、不降级；web 端与会话切换（/new、/resume）自动跟随。"（`00-需求原话.md:24`） | transport 不介入 session 生命周期；交给 PiServer/服务层。 |
| E7 | "服务关闭（stop / TUI 退出）后端口释放、token 失效、进程无残留。"（`00-需求原话.md:25`） | 幂等 close：停止接收、关闭连接、释放 HTTP server；调用方负责所有关闭路径调用。 |

## 2. 一句话定位

`packages/server` 的通用 HTTP + WebSocket listener：在 HTTP 层提供可选静态文件服务，在 upgrade 前校验路径 token，认证后把二进制 WebSocket 帧适配为 `ByteConnection` 并交给 PiServer；不依赖 `/remote` 业务、不改 Pi 协议。

## 3. 签名和行为契约（每步说明省略后果）

建议新增 `packages/server/src/transports/ws/{index.ts,listener.ts,preset.ts,types.ts}`，公开：

```ts
export interface WebSocketListenerOptions {
  host: string;
  port: number;
  token: string;
  staticDir?: string;
  maxPendingBytes?: number;
  gracefulCloseTimeoutMs?: number;
  maxFrameLength?: number;
  onError?: (error: Error) => void;
}
export interface WebSocketServerOptions extends Omit<PiServerOptions, "listeners">, WebSocketListenerOptions {}
export function createWebSocketListener(options: WebSocketListenerOptions): PiServerListener;
export function createWebSocketServer(service: PiServerService, options: WebSocketServerOptions): PiServer;
```

各选项仅在调用方明确传值或具有与 Unix transport 相同的缺省逻辑时生效；`host`/`port` 由调用方传入，允许 `port: 0`，地址取 start 后 `listener.address`。HTTP listener 的地址建议格式 `http://<host>:<actualPort>`（对 IPv6 host 加方括号）；WS URL 由调用方将 scheme 改为 `ws` 并附 `/ws/<token>`。不读环境变量或配置文件。[推断] 调用方通常使用 `127.0.0.1` 和 `0`；冻结契约明确 host/port 来自调用方（`01-共同上下文.md` C3）。

契约补充（`01-共同上下文.md` C1 修订后冻结）：listener 须暴露结构化 `boundPort?: number`——`start()` 完成后为实际绑定端口（`port:0` 时为 OS 分配值）；`address` 字符串仅人类可读展示，不做解析契约。调用方（D2）组装 URL 与 `/remote status` 必须使用 `boundPort`，不得从 `address` 字符串解析。

认证选项定为 `token: string`，而非 `tokenVerifier` 回调：D2 已负责生成唯一随机 token，transport 做恒时比较即可；单 token 值使 API 最小、行为可验证，也避免一般化回调让调用方误实现非恒时比较。将来若同一 listener 必须支持 token 轮换/多凭据，再另行设计 verifier API，不作为本次范围。要求 token 非空；实现可在构造时校验其 UTF-8 字节长度 > 0。token 格式为 D2 传入的 43 字符 base64url，transport 不自行生成或记录它（格式依据 `01-共同上下文.md` C2）。

1. **start(accept)**：内部创建 `http.createServer(requestHandler)` 与 `new WebSocketServer({ noServer: true })`，将 HTTP server 的 `upgrade` 事件接到 WS server。仅 GET `/ws/<token>` 可升级：解析 URL pathname、要求单一非空 token 路径段且无额外段，百分号解码失败则拒绝；其余 upgrade 请求均在 upgrade 前以 HTTP 404 结束。认证失败统一返回 HTTP 401，不泄露是路径格式还是 token 不匹配。`timingSafeEqual` 要求长度相同，故先将候选 token 和配置 token 转为 `Buffer`，长度不相同直接失败，相同长度才调用 `timingSafeEqual`；长度分支不是跨候选内容的比较，符合其 API 前置条件。成功才 `handleUpgrade` 并将 socket 建立的连接交给 `accept`。若省略 upgrade 前认证，未授权方即可进入 PiServer 协议层，违反 C1/C2。路径中 token 的暴露属于冻结契约明确接受的暴露面（`01-共同上下文.md` C2）。
2. **ByteConnection 收发**：WS 必须以 `binaryType`/接收配置保证二进制内容可转换为 `Uint8Array`；`message(data, isBinary)` 中 `isBinary === false` 一律以协议错误关闭连接，不调用 `handler.onData`；二进制 `Buffer`/ArrayBuffer/Buffer[] 规整为一个 `Uint8Array` 后调用 `handler.onData`，保持每条消息边界对字节流不可见、消息顺序不变。协议 decoder 本身负责 framing（`connection.ts:1-18`）；text frame 不能静默按 UTF-8 转二进制，否则违反"协议是 CBOR 二进制"（`01-共同上下文.md` C1）。无 handler 时立即关闭底层连接。error 交给 `handler.onError` 并终结连接；close 事件只调用一次 `handler.onClose`、设置 closed 并从 listener 活跃连接集合移除。Unix 当前在构造连接后先 `accept`，再绑定 data/error/close 监听器（`transports/unix/listener.ts:108-137`）；WS 版本应在接收消息前安装完生命周期监听，避免回调同步关闭造成事件漏接。[推断] `accept` 返回 handler 同步，参考 `ByteConnectionAcceptor`（`connection.ts:18`）。
3. **send(chunk)**：只接受 `Uint8Array`；closed/closing 时 reject。建议将发送串行排队并记账 `pendingBytes`；超过 `maxPendingBytes` reject（并按 Unix 做法由 PiServer 的发送错误路径断开慢 peer；默认建议 `maxFrameLength * 4`，与 Unix 参数关系相同，`transports/unix/listener.ts:225-241,405-417`）。调用 `ws.send(chunk, { binary: true }, callback)`，Promise 由 callback resolve/reject；callback 是发送完成/错误的可观察完成点，不以调用 `send()` 返回或 `bufferedAmount` 下降推断完成。`bufferedAmount` 只用于可选的发送前高水位拒绝/监控，不能代替 callback；设置 `maxPendingBytes` 是本 API 有界背压契约。[推断] `ws` callback 不表示对端应用确认，只表示本地发送已完成/失败。每次 send 保持输入内容稳定至发送完成：可在调用时复制 chunk，或明确保证调用者不修改；为与 Unix（会 `slice()`，`listener.ts:233-240`）一致应复制。省略队列/上限会允许慢客户端无限积累内存。
4. **close(finalChunk?)**：close 幂等并复用同一 Promise，立即停止接受新 send。先等已排队 send 完成，再发 `finalChunk`（若有，必须 binary），其发送 callback 完成后执行 `ws.close(1000)`；无 finalChunk 则直接 close。close Promise 在底层 close 事件 resolve；启动 `gracefulCloseTimeoutMs` 定时器，到时 `ws.terminate()` 并将连接标记 closed，避免永不关闭。既有 Unix 先等待 write tail、写 finalBytes 后 `socket.end()`、超时 destroy，并幂等 resolve（`transports/unix/listener.ts:243-281`）；WS 无 TCP half-close 等价物，故正常 close handshake 是语义最接近的映射。省略等待队列会丢失 finalChunk 前的协议数据；省略超时可能使 stop 永久挂起。`close` 要兑现 `ByteConnection.close(finalChunk?)`（`connection.ts:6-10`）。

close code 约定（`01-共同上下文.md` C1 修订后冻结）：单连接 `ByteConnection.close()`（协议层主动关单个连接）用 `ws.close(1000)`，如上；**listener.close()（服务关停，`/remote stop` / TUI 退出）对全部活跃连接必须用 `ws.close(1001, "server shutdown")`**——web 客户端据此组合识别宿主终止态、停止自动重试（C4 终止态识别）。两处场景不同，不得混用。
5. **keepalive**：不另加应用层 ping 定时器；`ws` 的 ping/pong 不是 Pi 协议数据，且本地直连/底层 TCP close 已能报告断连。为侦测网络黑洞可选配置 `pingIntervalMs` 并启用 ping/pong 心跳，但需求未规定且会引入计时器与移动端休眠误断风险，因此本设计 v1 不启用、不公开此参数。`close()` 超时只处理本地主动关闭，不能声称是远端失活检测。[推断] 若未来隧道场景证明需要心跳，应由上位契约补充间隔与容忍策略。
6. **HTTP 静态服务**：`staticDir` 可选。无 `staticDir` 时 `GET /` 返回 404（不伪造页面）；其余 HTTP 请求也 404。配置后 `GET /` 映射 `<staticDir>/index.html`，`GET /<file>` 仅服务普通文件，不列目录；只允许契约 MIME 白名单：`.html`=`text/html; charset=utf-8`、`.js`=`text/javascript; charset=utf-8`、`.css`=`text/css; charset=utf-8`、`.svg`=`image/svg+xml`、`.png`=`image/png`、`.ico`=`image/x-icon`、`.wasm`=`application/wasm`、`.map`=`application/json`；其他扩展名 404。
   - decode URL pathname 后拒绝 NUL、反斜线、非法编码及包含穿越段的输入；将候选相对路径 resolve 到 `staticDir`，再用 `relative(staticRoot, resolved)` 验证结果为空（根）或不是绝对路径、不是 `..`、不以 `../` 开头；并拒绝目录，只读普通文件。验证必须在 resolve 后进行，防止编码/分隔符绕过；任何异常路径均 404，不把绝对路径/文件系统错误发给客户端。`staticDir` 启动时 resolve 为绝对路径；建议对文件与根均取 `realpath` 后再作 relative 校验，拒绝越界 symlink，使"staticDir 内"不被链接目标绕过。[推断] realpath 策略需实现时验证性能与兼容性。
   - `ETag` 使用内容字节的 SHA-256 强校验值，成功文件 GET 返回 `ETag`；请求 `If-None-Match` 匹配时返回 304、空 body。静态产物固定内容哈希并非已知，故不设长期 `immutable`；返回 `Cache-Control: no-cache`，允许浏览器存储但每次使用前验证，兼顾部署更新与重复加载。HEAD 按 GET 同样验证/发 header、空 body；其他 method 404（减少 API 面）。不缓存 404。ETag 计算会读完整文件，静态资源规模有限是[推断]，若资源体量/并发变大再改为基于 stat 的弱验证器，需重新评估。
7. **listener.close()**：幂等；先阻止新 HTTP/upgrade 请求并关闭 WebSocketServer，再关闭全部存活 `ByteConnection`（并行等待），最后关闭 HTTP server，确保端口释放；HTTP Server close 可能等待连接，故对 keep-alive HTTP socket 也应销毁或设置关闭期限。启动失败时清理已创建的 HTTP/WS 资源后原样 reject。底层 error 以 `onError` 通知（观察者抛错不得影响状态），符合 Unix `reportError` 语义（`transports/unix/listener.ts:194-200`）；侦听器 close 不能吞掉清理失败。PiServer 统一调用 listener close（`listener.ts:4-10`）。
8. **PiServer 公开 API 扩展**（`01-共同上下文.md` C1 修订后划入 D1 范围；同属 `packages/server`，与 transport 一起交付；协议 schema 零改动）：
   - `PiServer.removeSession(id: string): Promise<void>`：经 `LiveSessionManager` 对该 id 的 live session 执行——向全部已 attach 连接发送既有 `session_removed` 事件变体（`protocol/src/schemas.ts:407-410`）→ 解除各连接的 attach（`connection.sessionIds` 删除）→ unsubscribe runtime → 等待 in-flight `operationCount` 收敛（复用 `maybeDispose` 的等待模式，`sessions.ts:387-408`）→ dispose runtime 并从 `liveSessions`/`openingSessions` 移除。id 不存在时幂等 no-op。宿主（D2 RemoteHostController）在 TUI 会话替换（rebind）时调用旧 id。现状依据：`LiveSessionManager` 无任何 removal 发射链（`sessions.ts:285-300` 只处理 progress/snapshot/error），且 `acquire()` 会优先复用 liveSessions 旧 runtime（`sessions.ts:217-227`）、`listMetadata()` 会把 live runtime 附加进列表（`sessions.ts:165-180`）——没有此 API，TUI 换会话后 web 端会命中已 dispose 的旧 session。实现落点：`sessions.ts` 新增 `remove()` 方法 + `server.ts` 公开转发 + types 更新。
   - `PiServer.sessionParticipantCount(id: string): number`：只读查询，返回当前已 attach 到该 session 的已握手连接数（遍历 `liveSessions.get(id)?.connections` 过滤非 terminal 连接）；id 不存在返回 0。语义：participants = 已完成协议握手且 attach 的连接，不含仅完成 HTTP upgrade 的 socket。`/remote status`（D2）消费。
   - 两方法为通用服务端能力（`browser-session-collaboration` 平台场景同样需要），不得耦合 `/remote` 业务字段。

## 4. 文件与副作用

- 新增 `packages/server/src/transports/ws/index.ts`：导出 listener/preset 与选项类型。
- 新增 `packages/server/src/transports/ws/types.ts`：定义 listener/server options。
- 新增 `packages/server/src/transports/ws/listener.ts`：HTTP server、upgrade/token 认证、静态资源、安全边界、WebSocket 适配及资源生命周期。
- 新增 `packages/server/src/transports/ws/preset.ts`：按 Unix preset 组合 `PiServer` 与单 listener。
- 修改 `packages/server/package.json`：dependencies 加 `"ws": "^8.21.0"`；exports 加 `"./ws"`，types/import 目标分别为 `./dist/transports/ws/index.d.ts` 与 `.js`，逐项对照 Unix export（`package.json:8-20`）；不加额外依赖。
- 新增 transport 测试文件（建议 `packages/server/src/transports/ws/listener.test.ts`）；是否新增 HTTP/WS 测试 helper 可按现有测试组织决定。不要改协议 schema，不改 Unix transport。

副作用：监听 TCP 端口；启动后允许带有效 token 的 WS 客户端及静态 HTTP 请求；关闭时释放所有 socket/计时器/文件读取活动。静态目录只读；不写 token、静态文件或认证日志。

## 5. 确切代码落点

- Unix 对照结构：`packages/server/src/transports/unix/index.ts:1-3`；options 结构及字段 `types.ts:1-15`；preset 参数传递和 PiServer 选项 `preset.ts:1-23`。新 ws 同样四文件、同样两层 API，不从根包 export 混入 transport 专用 API。
- Listener 实现类/状态：对照 `transports/unix/listener.ts:37-54`；地址 getter `:56-58`；启动与绑定错误清理 `:60-99`；幂等 close `:101-105`；连接建立/事件生命周期 `:108-148`；观察者错误隔离 `:194-200`。
- `WebSocketByteConnection`：对应 Unix `listener.ts:203-305`；send/背压 `:225-241`；close/final chunk `:243-281`；作为 transport 内部实现即可，不要求公共导出。
- PiServer 抽象必须保持不变：`packages/server/src/listener.ts:3-10`、`connection.ts:5-18`；preset 透传 `maxFrameLength`、`handshakeTimeoutMs`、`serverId`、`onError`，模式对照 `transports/unix/preset.ts:7-22`。
- 依赖及子路径出口：`packages/server/package.json:8-20,49-57`。
- 测试 harness：`packages/server/src/testing/server.ts:5-26` 构造未启动 PiServer 与确定性 service；`src/testing/client.ts:20-37` 的 `ProtocolTestClient` 接受 `WireChannel`；`client.ts:116-138` 展示 Unix 测试连接工厂如何适配 WireChannel。WS 测试可直接用 `createWebSocketServer`/`createWebSocketListener`，并以 `ProtocolTestClient` 配置基于 `ws` 客户端的 `WireChannel`，无需为 transport 引入另一套协议 client。

## 6. 与现状差异

现有 PiServer listener/connection API 已抽象成"认证后的有序字节连接"（`listener.ts:3-10`、`connection.ts:5-18`）；当前 Unix transport 提供 Unix socket listener 与 preset（`transports/unix/index.ts:1-3`），以 socket 事件实现 send 队列、pending byte 上限、final chunk 与优雅关闭超时（`transports/unix/listener.ts:203-305`）。本模块增加网络 HTTP/WebSocket 入口、token 前置认证和可选只读静态托管；与 Unix 不同，地址含 host/port 而非 socket 路径，授权凭据是 URL path token；WS close handshake 代替 TCP half-close；不提供 Unix socket mode/stale path 逻辑。

目前 package exports 只有根、testing、unix 三个子路径，无 ws export；runtime dependencies 未声明 ws（`packages/server/package.json:8-20,49-57`）。现有 testing client 使用 Node net Unix socket（`src/testing/client.ts:1-2,116-138`），需加 WS wire adapter 或在测试内构造 WireChannel；`ProtocolTestClient` 本身无需修改。

## 7. 消费者可见验收

1. `createWebSocketListener` 在指定 host/port 监听，port 0 时 `address` 给出实际端口；`close()` 后端口可立即重新绑定。
2. `GET /ws/<正确 token>` 完成 upgrade，PiServer 可通过既有 hello/version 握手；错误 token、错误长度、额外路径段、其他 upgrade path 均在 upgrade 前拒绝，错误凭据响应为 401，PiServer accept 不被调用。
3. WS 二进制帧双向往返完整编码协议字节，客户端消息按序到达；文本帧拒绝并触发连接清理；异常后 handler close/error 各最多一次。
4. `send()` Promise 等待 ws callback；并发发送按序，pending byte 超限 reject；close 等待排队发送，`finalChunk` 排在既有数据后发出，close timeout 可终止不响应 peer。
5. 多客户端可同时连接；单客户端断连后 PiServer 连接/会话订阅清理，其余客户端仍工作；listener close 后所有客户端结束且地址释放。
6. 有 staticDir 时 `/` 返回 index.html、白名单资源 MIME 正确、未知扩展/目录/不存在文件 404、匹配 ETag 返回 304；编码路径穿越及 resolve 后越界路径不读文件。无 staticDir 时 `/` 为 404。
7. 静态请求不需要 token，但 WS upgrade 必须认证；无无关认证状态或 token 输出到日志。[推断] "不输出日志"是安全实施要求，契约只明确 token 的暴露面为 upgrade path（`01-共同上下文.md` C2）。

### 测试设计（参照现有 harness）

- 创建 `const { server, service } = createTestServer({ listeners: [createWebSocketListener({...})] })`；启动 PiServer 后从 `listener.address` 提取实际端口。现成 server helper 直接传 listeners 并默认 `TestServerService`（`src/testing/server.ts:5-26`）。
- 基于 `ProtocolTestClient` 和 `WireChannel` 构造 `ws` client 适配器：`send` binary send 并 await callback；`sendFragmented` 按两个二进制 WS message 发送（验证 byte stream decoder 跨消息累积，不要求 TCP 分段语义）；`close` 等待 close event。复用 hello/request/message matcher，不复制协议编码逻辑（`src/testing/client.ts:20-37,57-85,116-138`）。
- 认证成功：有效 token upgrade 后执行 hello，确认协议响应；认证失败：错误 token、短/长 token、malformed path、非目标路径各验证 HTTP 状态与 accept/service 未被调用；至少成功/失败各覆盖一次。
- 帧往返：发 hello、协议请求并验证响应；发多条二进制帧及单条拆分协议 frame，验证 decoder 得到完整消息；发 text frame，确认服务端拒绝并断连。
- 断连清理：客户端正常 close 与异常 terminate 后 `waitForClose()`、PiServer 服务连接清理可观察；重复调用 listener/server close；close 在连接活跃时仍完成且端口可重绑；慢写/超时用可控 peer 验证发送拒绝/终止。
- 静态：临时 staticDir 写 index.html 与各白名单/非白名单文件，检查 status、内容、Content-Type、ETag/304、HEAD（若实现）；测试 `../`、编码 `%2e%2e`、反斜线、绝对路径与 symlink 越界（若 symlink 被支持创建），确认拒绝且未泄露文件内容。测试结束 finally 清理 temp dir 与 server。

## 8. 发现的冲突与需修订上位文档

- C1 已冻结 MIME 白名单，但条目写作"html/js/css/svg/png/png/ico/wasm/map"，`.png` 重复（`01-共同上下文.md` C1）。本文按 `.png` 一项实现，没有擅自添加扩展名；建议共同上下文去重文字。
- C1 要求 `GET /` 返回 `index.html`（`01-共同上下文.md` C1），但同时 `staticDir` 是可选、且未规定缺省时行为。本文提出未配置时 `/` 返回 404，属于需上位文档确认的默认行为；D2 必须提供静态目录才能满足浏览器页面效果 E2。
- C1 没规定 ETag/cache-control、HEAD/非 GET 行为、静态 symlink 策略、WebSocket close code、keepalive 间隔、pending bytes 默认值及地址字符串格式；本文上述取值均为设计建议，需评审接受后冻结。未以这些建议改写上位契约。
- package 依赖/exports 细节与 Unix pattern 一致；没有其他已发现契约冲突。

## 9. 仍未知待拍板

1. **静态目录缺省行为**：本文建议 `staticDir === undefined` 时所有 GET 404；是否必须令 `/` 返回内置页面（C1 未给内置页面来源）未知。D2/D3 需确认 `staticDir` 总会传入。
2. **静态缓存策略**：`Cache-Control: no-cache` + SHA-256 ETag 为建议，缓存期限/是否因产物内容 hash 命名改为 immutable 未知。
3. **路径 symlink**：应拒绝指向 staticDir 外的 symlink；性能/兼容性与真实路径检查方式需实现评审确认。
4. **慢消费者阈值与 graceful timeout**：建议沿用 Unix 的缺省关系/5 秒（`transports/unix/listener.ts:11-14,405-425`），C1 未冻结数值；最终是否完全共享 Unix 默认值未知。
5. **WebSocket keepalive**：v1 建议不发 ping；经隧道或移动设备休眠时的远端黑洞探测要求未定义。
6. **ws API 细节**：目标版本为 `^8.21.0`（`01-共同上下文.md` C1），其安装类型声明及平台支持需实现时用实际 lockfile/编译验证；本文设计不声称仓库当前已声明该依赖。
7. **连接计数公开方式**：D2 需要 participant count，当前 PiServer 不暴露该数据；本文只提出 transport 层 getter，实际 `/remote status` 如何访问需在 D2/D1 契约中共同定案。

## 10. 评审结论边界

本文完成 D1 的可实现设计提案，遵从冻结 C1/C2：新增 ws transport、认证先于 upgrade、二进制帧适配、静态服务和 token URL 行为；不更改 PiServer/PiClient/pi-protocol schema。涉及上位契约未定的细节均显式列为提案/未知，不代表已获拍板。
