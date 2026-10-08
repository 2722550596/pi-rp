# D3：浏览器 Web 客户端设计

> 本文遵守 `docs/design/remote-web-control/01-共同上下文.md` 冻结契约；仅描述设计，不修改 `src/` 实现。源码事实均附仓库相对路径与行号；设计选择属于本模块契约，未确认事项标为未知。

## 1. 需求对照（原文与效果项）

- 原话：“打开链接，无需安装任何东西，即可实时查看正在运行的会话：流式 assistant 文本、thinking、工具调用卡片、用户消息、排队消息。”（`docs/design/remote-web-control/00-需求原话.md:19-21`；E2）。客户端从 URL fragment 取 token，使用浏览器原生 WebSocket 和 PiClient 展示附着会话；实时活动使用 `session_progress`，排队消息使用 snapshot 的 `queuedSteer`。
- 原话：“浏览器端可以发送 prompt、turn 进行中 steer、中断（abort）”（同上 `00-需求原话.md:21`；E3）。输入提交通过附着的 session handle 调用 `prompt` 或 `steer`，中断调用 `abort`。
- 原话：“TUI 与浏览器同时操作同一会话：TUI 不中断、不降级；web 端与会话切换（/new、/resume）自动跟随。”（`00-需求原话.md:24`；E6）。客户端在 `session_removed` 后重新枚举并附着当前会话；不维护独立写入队列策略。
- 原话：“任意现代浏览器（明确目标：安卓 13 / MIUI 14 自带浏览器与 Chrome）”（`00-需求原话.md:20`；E2）。构建目标与兼容性约束见第 6、7 节。
- E1 / E4 / E5 / E7：Web 客户端消费分享链接并与宿主直连；分享启停、认证及服务生命周期由 D1/D2 实现，本模块只处理有效 fragment 和 WebSocket 断连呈现（`00-需求原话.md:19,22-25`）。

## 2. 一句话定位

`packages/coding-agent/web/remote/` 是无框架、无浏览器运行时依赖的 vanilla TypeScript 单页参与者：将 fragment token 转成 `/ws/<token>` WebSocket，再将其字节流交给 `PiClient`，呈现一份可交互的 session snapshot 与增量活动（C2/C4：`01-共同上下文.md:48-53,72-79`）。

## 3. 签名和行为契约（每步说明省略后果）

### 3.1 WebSocket 字节传输

Pi-client 的传输接口为 `ByteTransport.send(chunk: Uint8Array): Promise<void>`、`close(): void`，send 必须按调用顺序送达，close 重复调用安全；factory 接收 handlers 并返回已连接、已认证 transport，且只期望一个终止回调（`packages/client/src/transport.ts:1-18`）。

设计接口：

```ts
export function createWsByteTransportFactory(url: string): ByteTransportFactory;
// factory(handlers) => Promise<ByteTransport>
```

- 工厂每次调用新建 `new WebSocket(url)`，设置 `binaryType = "arraybuffer"`，在 `open` 才 resolve transport。打开前 `error`/`close` reject 创建过程；打开后，`message` 只接受 `ArrayBuffer`，转成 `Uint8Array` 调 `handlers.onData`。非二进制 payload 视为传输错误并调用 `onError` 后关闭，不能把文本当 CBOR 字节。
- WebSocket `error` 映射 `onError(new Error(...))`；`close` 映射 `onClose()`，错误与正常关闭竞态以单一 `terminal` 标志保证终止处理只执行一次。调用 transport `close()` 首次标记关闭并调用 socket.close()，后续无操作；本地请求关闭时仍由 `close` 事件通知 connection，不重复额外伪造 `onClose`。
- 为遵守 send 顺序且提供可观测背压：`send` 维护 promise 链（链尾 catch 后保留可继续排队的链），每次发送依序等到 `readyState === OPEN`，再调用 `socket.send(chunk)` 并等待 `bufferedAmount` 降到实现选定低水位后完成 promise；连接关闭/错误时挂起发送必须 reject。检查 `bufferedAmount` 采用定时轮询/事件驱动设计需验证浏览器行为；WebSocket 没有原生 drain 事件，避免无界微任务自旋。发送 buffer 不复制 chunk；PiClient 传入的每个 frame 在 send promise 结束前不得由 adapter 修改。
- URL 构造：`location.hash` 去除前导 `#` 后作为 token；缺失或空 token 显示“链接缺少访问 token”错误态，不发网络请求。页面只使用 `location.protocol === "https:" ? "wss:" : "ws:"` 与 `location.host`，目标 `${scheme}//${location.host}/ws/${encodeURIComponent(token)}`；C2 当前 token 是 base64url 43 字符，不需要额外 URL 转码，但编码可防未来路径破坏。token 不写 localStorage/sessionStorage、DOM 可见文本、日志或 query 参数。此实现不声称浏览器侧可隐藏 WS 请求路径 token（C2 已说明该暴露面：`01-共同上下文.md:48-53`）。

### 3.2 PiClient 生命周期与数据订阅

```ts
const client = await PiClient.connect({ transportFactory });
const sessions = await client.listSessions();
const handle = await client.attachSession(selectedId);
const stopSnapshot = handle.subscribe((snapshot: SessionSnapshot) => ...);
const stopEvents = handle.onEvent((event: ServerEvent) => ...);
// 恢复：await client.reconnect(); 再 listSessions / attachSession
```

- `PiClient.connect(options)` 内部建实例、连接失败时 dispose；`connect()` 仅断开态可连接并重置状态，`reconnect()` 等价 `connect()`（`packages/client/src/client.ts:96-115`）。transportFactory 必须能在每次调用新建新 socket。
- `attachSession(id)` 使用 shared lease；attach 请求结果及事件快照写入 ClientState，session handle 的 `subscribe` 回调参数确为 `SessionSnapshot`，`onEvent` 回调为 `ServerEvent`（`packages/client/src/client.ts:147-187,269-291`；`packages/client/src/session-handle.ts:19-33,47-74`）。**订阅回调不是 progress**：ClientState `applyEvent` 会独立分发 session event；客户端必须 `handle.onEvent` 读取 `session_progress`（`packages/client/src/state.ts:69-97,152-155`）。
- attach resolve 与 handle.snapshot 都基于协议 `SessionSnapshot`；连接断开会清除 attached 状态并使 lease 失效，因此恢复不得复用旧 handle（`packages/client/src/client.ts:321-328`）。detach/dispose 应在主动切换 UI/session 或卸载时调用；网络断开 lease 已失效时转入恢复分支。

### 3.3 渲染数据类型形状

订阅器收到的协议类型定义如下。全部字段以 `packages/protocol/src/schemas.ts` 为权威，不应在 renderer 复制/简化协议模型。

- `SessionSnapshot`（`schemas.ts:241-258`）：`{ id, name?, cwd, createdAt, updatedAt, phase, model, thinkingLevel, attached, locked, revision, transcript: TranscriptItem[], queuedSteer: UserTranscriptItem[], queuedSteerCount }`。
- `UserTranscriptItem`（`schemas.ts:120-125`）：`{ id, role: "user", content: UserContent[], timestamp }`。UserContent 为 text 或 image；TextContent `{type:"text", text}`，ImageContent 含 schema 定义的媒体数据字段（`schemas.ts:72-101`；renderer 必须按实际字段显示/安全处理，不生成远程 HTML）。
- `AssistantTranscriptItem`（`schemas.ts:126-161`）：基础 `{id, role:"assistant", content: AssistantContent[], model, responseModel?, usage?, timestamp}` 加状态联合：`streaming`；`complete + stopReason: "stop"|"length"|"toolUse"`；`error + stopReason:"error" + errorMessage?`；`aborted + stopReason:"aborted" + errorMessage?`。AssistantContent 是 text、thinking、toolCall 三类；toolCall `{type:"toolCall", toolCallId, toolName, input: JsonValue}`（`schemas.ts:81-101`）。thinking 折叠显示但正文仍保留；工具调用以卡片显示名称/参数，不执行工具。
- `ToolTranscriptItem`（`schemas.ts:162-192`）：基础 `{id, role:"tool", toolCallId, toolName, input: JsonValue, content: ToolContent[], details?: JsonValue, usage?, timestamp}`；`running|complete` 配 `isError:false`，或 `error` 配 `isError:true`。ToolContent 是 text 或 image。
- `TranscriptItem` 联合 user/assistant/tool（`schemas.ts:193-201`）。session 快照中的 transcript 是已归档的项目序列；summary 若由宿主转换为 transcript item 则按相应类型原样呈现，当前三类 schema 没有独立 summary role。扩展数据不得假设存在自定义 transcript 类型。
- `TranscriptProgress`（`schemas.ts:203-231`）：`item_started {item: TranscriptItem}`；`assistant_delta {messageId, contentIndex, kind:"text"|"thinking"|"toolCall", delta}`；`item_updated {item: AssistantTranscriptItem|ToolTranscriptItem}`；`item_finished {item: Complete/Error/AbortedAssistantTranscriptItem|Complete/ErrorToolTranscriptItem}`。其中 `toolCall` delta 内容如何编码/拼装与最终 ToolCallContent 的关系，需确认服务端转换器；客户端仅可按其对同 messageId/contentIndex 维护的片段追加，不能用字符串假设替代最终 item。
- `ServerEvent` 与结构（`schemas.ts:400-410`）：`server_snapshot {snapshot:ServerSnapshot}`、`session_snapshot {snapshot:SessionSnapshot}`、`session_progress {sessionId, progress}`、`session_removed {sessionId}`。服务端快照和 SessionSnapshot 通过 `PiClient.subscribe` / handle.subscribe 提供；进度与移除事件经 `onEvent` 提供，上述订阅语义由 `client.ts:121-129`、`state.ts:59-97` 证实。

### 3.4 渲染状态机和合并规则

状态表：

| 客户端状态 | 输入/条件 | 行为 / 下一个状态 |
|---|---|---|
| `no-token` | hash token 空 | 显示错误，禁止建连接 |
| `connecting` | 首次 connect / reconnect | 显示连接中；成功后 list+attach |
| `attached` | SessionSnapshot | 以 snapshot 全量重建条目、状态栏、队列，清空旧 live 映射；同 revision 的重复快照幂等覆盖 |
| `attached` | session_progress | 依事件种类更新临时 live 条目，不将部分活动伪装成已归档 transcript |
| `attached` | session_removed | 清除当前 UI 与 handle，重新 `listSessions` 并选择宿主当前会话再 attach |
| 任意连接态 | transport close/error | 标记断线、丢弃 handle/live cache；尝试 reconnect，成功后必须全量 attach snapshot |
| `terminal` | 明确的宿主终止 close 情况 | 展示可读结束态并停止自动重试；链接无效/拒绝显示独立说明 |

伪代码：

```text
applySnapshot(s):
  if currentSessionId != s.id: reset renderer
  session = s
  entries = Map(s.transcript.map(item => [item.id, item]))
  live = Map()                  // snapshot 是唯一权威；抛弃未完成的旧增量
  liveIdByMessageId = Map()
  queue = s.queuedSteer        // 逐项显示；count 是状态栏计数
  render()

applyProgress(p):
  switch p.type:
    item_started:
      // 不把 live 项的临时 id 当成归档 entry id
      liveKey = "live-" + uuid()
      live[liveKey] = p.item
      if p.item.role == "assistant": liveIdByMessageId[p.item.id] = liveKey
    assistant_delta:
      key = liveIdByMessageId[p.messageId]
      if key absent: create live assistant placeholder keyed "live-" + uuid()
      merge delta into content[p.contentIndex] according to kind
    item_updated:
      key = find live item by item.id, else create live key
      replace live[key] = p.item
    item_finished:
      key = find live item by item.id
      replace live[key] = p.item; mark finished
      // 不自行猜 snapshot entry id，也不将 live key 插入 entries
  render()

on newer snapshot:
  applySnapshot(snapshot)     // entry id 是 snapshot item.id；live-<uuid> 仅为 UI 临时 key
```

`session_snapshot` 可来自 prompt/steer/abort command result 及独立事件；handle.subscribe 报 revision 较旧的快照会由 ClientState 拦截（`packages/client/src/state.ts:77-112`）。renderer 对同 session 低 revision 快照不倒退；但如接入层已经交付，则仍应仅接受 `revision >= current.revision`。snapshot transcript 项 `id` 与 progress item id 如何映射最终 entry id，协议没有单独映射字段：按要求仅保留 live 项，后续 snapshot 全量替换，不推导 id 等价关系。`live-<uuid>` 是 renderer 自己生成的稳定 DOM/key 标识，绝不能发到协议。

状态栏仅渲染 `snapshot.phase`（枚举 `idle|turn|compaction|branch_summary|retry`，`packages/protocol/src/schemas.ts:37-45`）、`snapshot.model`（`{provider,id}`，同文件 `:47-51`）与 `snapshot.queuedSteerCount`；队列正文按 `queuedSteer` 用户项列出。锁定状态 `locked` 及未附着 `attached` 影响控件禁用状态。renderer 导入协议类型，不在 UI 再造枚举（字段定义见 `schemas.ts:241-255`）。

### 3.5 Composer / abort

- `phase` 为 idle 且 handle active/attached 时提交非空文本：调用 `handle.prompt(text)`；turn 进行中则调用 `handle.steer(text)`。由 snapshot phase 决定发送时的命令，执行前读取最新 snapshot，防止按过时 UI 状态选择命令。
- 不提供 web 自己的 follow-up 队列或静默缓存。协议 `prompt`、`steer` 是两个不同命令（`packages/protocol/src/schemas.ts:286-324`）；PiSessionHandle 直接映射到它们（`packages/client/src/session-handle.ts:88-98`）。AgentSession 的 `steer` 明确加入 steering 队列（`packages/coding-agent/src/core/agent-session.ts:3279-3282,3300-3316`），turn 进行时 `prompt` 要求明确 streamingBehavior 才可排入 steer/followUp（同文件 `:2996-3010`）。因此本 UI turn 时用 `steer`，与并发契约 C2 相符；不在本模块承诺与 `/03` 尚未落地文档的具体 server adapter 细节一致性。`03-remote-host.md` 当前不存在，需 D2 文档形成后核对其并发语义；在此期间以 `01-共同上下文.md:85-90` 的“不自设策略、遵循 AgentSession 既有队列”作为上位要求。
- Abort 按钮仅在 attached、handle active、连接正常且 snapshot.phase 显示非 idle 处理中可用；调用 `handle.abort()`。空输入不提交；提交期间可禁用重复提交并显示传输/命令错误，不把失败内容视为已接受。idle 不提供可点 abort。
- Android 软键盘：viewport 使用 `width=device-width, initial-scale=1, viewport-fit=cover`；布局 `100dvh` 不作为唯一方案，使用 `100vh` fallback + `visualViewport` resize/scroll（若目标 MIUI 实测支持）同步可视高度；composer 固定在可视区域底边并为安全区留 `env(safe-area-inset-bottom)`。发送后清空输入、blur 隐藏软键盘；textarea Enter 提交、Shift+Enter 换行，移动端显式发送按钮。页面容器 transcript 预留 composer 高度，避免最后一条被遮挡。

### 3.6 会话跟随、断线恢复、终止

- `session_removed` 仅说明对应 session 移除（`schemas.ts:408-409`），客户端 `ClientState` 同时删除该 session snapshot 与 attachment（`packages/client/src/state.ts:88-97`）。web 端监听后清理 handle，再调用 `client.listSessions()`，选择结果中的当前唯一 host session 并 `attachSession(id)`；若列表暂时为空/attach 报 not_found，显示“宿主会话切换中”，短暂退避后重新 list，不展示旧 transcript；不得调用 `createSession`。选择规则当前依据 D2 单会话视图契约（`01-共同上下文.md:61-65`）。
- 浏览器 `online` 事件可触发立即恢复尝试；`visibilitychange` 回到 visible 时若 `client.connected === false` 也尝试恢复。PiClient `reconnect()` 只重开传输与协议握手，不会自动恢复 session attachment，所以握手成功后必须 `listSessions` + attach 并用 snapshot 清空/重建 UI（`client.ts:107-115,321-328`）。重试采用有限指数间隔并提供手动重试；暂停后台不可见时密集轮询。[推断] reconnect 失败后保留只读断线提示，禁止缓存未发送消息。
- 终止态识别（已拍板，`01-共同上下文.md` C1/C4 修订后冻结）：WS close code `1001` 且 reason 为 `server shutdown`（listener.close() 服务关停专用，见 02-ws-transport.md close code 约定）→ 显示"宿主已停止分享"、停止自动重试；其他 close 原因按普通断线处理（进入 §3.6 可重试恢复流程），不将其断言为终止。认证失败仍由 upgrade 前 HTTP 401 表达，不产生 WS 连接。

每个 attach/list/reconnect 异步流程使用 generation token；切换后旧请求返回不得覆盖新会话 UI，旧 handle 及时 unsubscribe/detach。PiClient disconnected 后 handle lease 失效，不对旧 handle 调 prompt/steer。

## 4. 文件与副作用

- `packages/coding-agent/web/remote/index.html`：静态入口，移动端 meta、暗色基础色彩、引用单一构建 JS/CSS。
- `packages/coding-agent/web/remote/src/main.ts`：启动、fragment token 检查、URL/factory、PiClient 生命周期与恢复协调。
- `packages/coding-agent/web/remote/src/transport.ts`：WebSocket -> `ByteTransport` adapter，无业务协议代码。
- `packages/coding-agent/web/remote/src/app.ts`：生命周期状态机、订阅、composer、会话切换协调。
- `packages/coding-agent/web/remote/src/render/`：snapshot/progress reducer、transcript renderer、状态栏与安全 DOM 工具，使用 `textContent`/DOM API，禁止拼接不可信 HTML。
- `packages/coding-agent/web/remote/styles.css`：固定暗色主题、移动 viewport/composer 布局。
- 构建副作用：`packages/coding-agent/dist/server/remote-web/` 生成 `index.html`、单 bundle JS、CSS；项目分发复制步骤需同时使 npm dist 路径和 binary 平铺 `dist/remote-web/` 可取资源（契约 C4 `01-共同上下文.md:72-76`）。
- 运行时网络副作用：只连接当前页面 host 的 `/ws/<token>`；不引入第三方端点、持久化 token 或 browser storage。

## 5. 确切代码落点

新增源码目录与文件：

```text
packages/coding-agent/web/remote/
├── index.html
├── styles.css
└── src/
    ├── main.ts
    ├── app.ts
    ├── transport.ts
    └── render/
        ├── state.ts        # snapshot/progress reducer 与 live-id 映射
        ├── transcript.ts   # user/assistant/tool 内容渲染
        └── status.ts       # phase/model/queuedSteer 状态栏
```

构建落点：`packages/coding-agent/package.json` 新增 `build:remote-web`，调用 esbuild；输入 `web/remote/src/main.ts`，`bundle: true`、`format: "iife"`、`target: "es2020"`、`minify: true`，依赖的 `@earendil-works/pi-client`、`pi-protocol`、`pi-session-protocol` 标记 workspace bundle 所需并打入同一 JS，不允许 external runtime import。将 CSS/HTML 复制到静态产物目录。C4 已规定产物与复制点：`dist/server/remote-web/`、binary `dist/remote-web/`，并要求 `copy-assets`/`copy-binary-assets` 增加复制行（`01-共同上下文.md:72-76`）。目前 coding-agent scripts 只有通用 build/copy-assets/copy-binary-assets，没有 web build（`packages/coding-agent/package.json:51-59`），依其现有 `shx cp` 风格加静态资源复制（同文件 `:55-56`）。

建议先产出约 100 KiB gzip JS 预算（包含协议/client，不含浏览器原生 API）；HTML+CSS gzip 预算 15 KiB。超预算先检查依赖图/side effects 与 sourcemap，勿引框架或 runtime dependency。[推断] 具体压缩后尺寸依赖 esbuild tree-shaking 和 workspace export 入口，需首轮构建实测后冻结数值；设计阶段不伪称已有构建产物证据。

包配置不新增 runtime dependency；esbuild 只作为开发构建工具，需确认根 workspace 是否已有可执行 esbuild，若无则增加 coding-agent devDependency 并锁定版本。当前 package 的 devDependencies 列表未列 esbuild（`packages/coding-agent/package.json:99-109`），版本/依赖提升方式未知，实施前核实 workspace 锁定策略。

## 6. 与现状差异

- PiClient 已提供可插拔 `ByteTransportFactory`、自动握手、reconnect、server/session snapshot 与事件订阅；缺少浏览器 WebSocket adapter（`packages/client/src/transport.ts:1-18`、`packages/client/src/client.ts:68-135`）。
- `PiClient` session event callback 明确能提供 progress，snapshot listener 只传 snapshot；实现必须同时注册两个 listener，不能误把 progress 当订阅快照（`packages/client/src/session-handle.ts:19-33`、`packages/client/src/state.ts:69-97`）。
- session 具有可直接展示的 transcript / queued steer / phase / model 状态，以及完整内容联合类型（`packages/protocol/src/schemas.ts:120-258`）；没有独立 summary role 或 transcript id 映射字段（同文件 `:193-231`）。
- coding-agent 当前已有 pi-client/protocol/session-protocol workspace 依赖、通用资产复制脚本，没有 remote web source/build/asset 路径（`packages/coding-agent/package.json:61-71,51-56`）。
- 目标不新增框架、运行时依赖、协议 schema、模型切换控件或主题系统；固定暗色主题与 C4 一致（`01-共同上下文.md:77-79`）。

## 7. 兼容性清单（Android 13 / MIUI 14）

目标设备：Android 13 / MIUI 14 自带浏览器与 Chrome；同时支持最新版桌面 Chrome/Firefox/Safari（C4：`01-共同上下文.md:77-79`）。具体 MIUI browser build/version 未知，需要真机验证，不宣称未经测试兼容。

- [必须] WebSocket、ArrayBuffer、Promise、Map/Set、async/await、模块化源码由打包消除、ES2020 语法；WebSocket 二进制消息设 ArrayBuffer。
- [必须] 不用 WebCrypto、HTTPS-only API、Service Worker、Notification、Clipboard API 等依赖安全上下文的功能；HTTP 局域网链接必须能连通（C4 `01-共同上下文.md:77-78`）。不得使用 `crypto.randomUUID()`；临时 live key 可用 `Date.now()` + 模块内递增序号构造唯一 UI key，不涉及安全随机数。
- [禁止] ES2021+ API；不使用 `Array.prototype.at`、`structuredClone`（ES2021 / 较新环境支持度问题）、`replaceAll`、`Promise.any`、`WeakRef`。数组取末尾用 `arr[arr.length - 1]`，对象更新用结构化浅拷贝/明确 reducer。目标 ES2020 与 C4 一致。
- [必须] 页面包含 `charset=utf-8`、`viewport`（含 `viewport-fit=cover`）、`theme-color`、`color-scheme: dark`；固定暗色底色，文本/提示/错误保持对比度。viewport/软键盘布局按第 3.5 节处理，低高度时 transcript 可滚动，发送区不覆盖内容。
- [必须] 不把 tool input、transcript 内容当 HTML；渲染统一用 text node / `textContent`。不使用 ES2022 `Object.hasOwn`，改 `Object.prototype.hasOwnProperty.call`。
- [必须] 优雅处理长 transcript、连接关闭与错误，无页面崩溃；snapshot 上限受 16 MiB frame 限制，超过限制 attach 失败并给清晰错误，不截断（C4共同行为 `01-共同上下文.md:85-90`）。
- [验证待做] MIUI 14 原生浏览器具体是否支持 `visualViewport`、`100dvh`、`env(safe-area-inset-bottom)`、WebSocket drain 轮询策略未知；均需 fallback 与真机检查。`100dvh` 仅作增强，不作为初始布局前提。

## 8. 消费者可见验收

1. 通过 `/remote` 分享链接打开后，不安装应用；fragment token 未出现在 HTTP 页面请求/query/storage，成功建立二进制 WebSocket 并看到当前会话。
2. 首次 attach 的 transcript 里可读显示 user 文本、assistant text 与折叠 thinking、tool call/tool result、running/error 状态、queued steer；不执行工具；snapshot 中空列表与内容均可正常呈现。
3. stream progress 的 delta 按 message/content index 合并；item update/finish 更新对应 live 卡片；收到较新 snapshot 后旧 live 项被整体清掉，快照 entry 不重复。刷新/重连后以全量 snapshot 恢复，不承诺断线期间事件回放。
4. idle 提交 prompt；非 idle 提交 steer；非 idle 时 abort 可见且调用 abort；idle/断线/未附着时 abort 与 composer 禁用。TUI 与 web 同时输入按 AgentSession 的共享队列语义生效，不出现客户端私有排队。
5. session_removed 后自动 list + attach 新会话，旧 transcript 不短暂显示为新会话内容；网断/休眠恢复后重新 handshake、list、attach 和全量覆盖。
6. 认证拒绝、宿主关闭、一般网络断开分别给可理解提示；不将未定义的 WS close code 擅自解释为明确原因。
7. Android 13/MIUI 14 目标设备上软键盘出现时输入框仍可见、发送后键盘收起、滚动 transcript 底部不被输入区遮挡；不同 MIUI 浏览器版本必须记录实测结果。
8. 构建产物为单一 JS bundle（ES2020/minify）+ 静态 HTML/CSS，无框架/运行时依赖；体积满足预算或经评审调整预算。

## 9. 发现的冲突与需修订上位文档

- 与共同契约无已确认冲突。协议对进度事件没有 live item 与最终 transcript entry 的显式 ID 映射字段；本设计采用临时 UI key、snapshot 全量权威覆盖，不改 schema，符合 snapshot authoritative 与无事件回放契约（`schemas.ts:203-231`；`01-共同上下文.md:85-90`）。
- 与 D2（`03-remote-host.md`）交叉核对已完成（2026-10-08 评审门）：其 §3.6.7 约定"idle → prompt，turn → steer，retry/compaction/branch_summary 等非 idle phase 禁止提交，stale phase 失败显示错误并刷新、禁止自动改 steer 或重发"与本设计 §3.5 完全一致；D2 复用 `CodingAgentRuntime` 转换器，turn 中 prompt 不映射为 steer（无 streamingBehavior 时 AgentSession 抛错），与本节"按最新 phase 选择命令"的调用约定闭环。
- WS close code/reason 已由 C1 冻结（1001 + "server shutdown" = 宿主终止态），本设计 §3.6 已更新；不再未知。
- 构建当前 package scripts 未体现 esbuild。需要确认根 workspace 是否有可复用版本；如无则把它作为开发工具依赖登记。此项不是运行时依赖，也不改变 C4 构建方案。

## 10. 仍未知待拍板

1. ~~close code~~ 已拍板：C1 冻结 1001 + "server shutdown" = 终止态（见 §3.6 更新）；认证失败 = upgrade 前 HTTP 401。剩余未知仅错误页视觉细节，实施时定。
2. ~~D2 交叉核对~~ 已完成，结论见 §9（约定一致，无冲突）。
3. ~~toolCall delta 序列化~~ 已答（2026-10-08 评审门）：D2 复用 `CodingAgentRuntime` 转换器，`toolcall_delta` 事件转 `assistant_delta {kind:"toolCall", delta: string}`（`coding-agent-server.ts:508-521`），delta 为增量字符串；客户端按 messageId+contentIndex 追加即可，最终 item 以 `item_finished`/snapshot 为权威。
4. ~~summary 表达~~ 已答（2026-10-08 评审门）：D2 复用的 `CodingAgentRuntime.snapshot()` 将 compaction/branch_summary 条目经 `summaryToUserMessage` 转为 user transcript item（`coding-agent-server.ts:424-433`），web 端按 user 项渲染，无独立 summary 类型。
5. esbuild 根工作区是否已安装/版本、workspace 包对 browser ESM 的 export 条件、bundle 实际体积未知，实施时核实并实测。
6. MIUI 14 原生浏览器的具体版本、WebSocket bufferedAmount 行为、visualViewport/安全区支持与软键盘自动收起效果未知，需真机验收。
