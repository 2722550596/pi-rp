# D2：RemoteHostController（coding-agent TUI 宿主集成）设计

> 范围：把交互式 coding-agent TUI 当前的 `AgentSession` 暴露给直连 WebSocket 参与者；覆盖共同契约 C2/C3/C5。共享契约不可由本文自行改写（`docs/design/remote-web-control/01-共同上下文.md:3-4,48-84`）。下文“现状”均附源码行号；方案推断标 `[推断]`；未决项列于第 10 节。

## 1. 需求对照（原话与效果项）

| 原话 / 效果 | 本模块兑现方式 |
|---|---|
| “好，那你就做直连模式吧。你打算加什么功能？给它什么命令？/share已经被占用了，/collab不太符合语境，因为一般来说用这个功能的都是remote，/remote可能合适” （`docs/design/remote-web-control/00-需求原话.md:7`） | 新增 `/remote [start|stop|status]`，不占用 `/share`；不引入 relay，直连定位遵循共享契约（`docs/design/remote-web-control/01-共同上下文.md:8-14,55-66`）。 |
| E1：TUI 一条 `/remote` 命令开启分享，立即得到 web 链接、局域网地址提示与二维码（`docs/design/remote-web-control/00-需求原话.md:19`） | `/remote` 与 `/remote start` 幂等启动/重显同一分享链接；启动返回实际端口、可访问地址和 token fragment URL，并在当前 TUI 输出链接与终端 QR（`01-共同上下文.md:57-59,81-84`）。 |
| “支持分享的web链接直接控制进程” （`00-需求原话.md:5`）；E3：浏览器可 prompt、turn 中 steer、abort（`00-需求原话.md:21`） | PiServer 的 `TuiSessionService` 将协议命令委托给同一个 `AgentSession`；并发遵循 AgentSession 既有语义，不在 web 层另设队列（`01-共同上下文.md:61-65,87-90`）。 |
| E4：无 relay、host 主动监听、浏览器直连（`00-需求原话.md:22`） | Controller 只创建本进程 listener；默认仅绑定 loopback，外网穿透不属于本模块（`01-共同上下文.md:8-14,68-70,91,95-96`）。 |
| E5：token 每次生成、只在内存、`/remote stop` 立即失效（`00-需求原话.md:23`） | Controller 在 start 生成 32 字节随机 token，停止时先撤销 token 再关闭服务；token 不写设置/会话/日志（token 口径见 `01-共同上下文.md:48-53`）。 |
| E6：TUI 与浏览器同时操作；web 跟随 `/new`、`/resume`（`00-需求原话.md:25`） | 在 `InteractiveMode` 已有的 session-rebind 回调中显式通知 Controller；旧 runtime detach，新 session 成为 list/open 唯一目标。现有 PiServer 未提供 `session_removed` 发射路径，必须按第 9 节处理后才算闭环。 |
| E7：stop / TUI 退出后端口释放、token 失效、进程无残留（`00-需求原话.md:25`） | 所有正常退出路径 await Controller.close()，再 dispose `AgentSessionRuntime` 并退出；Signal、Ctrl-C 与正常退出落点见第 3 节。 |

## 2. 一句话定位

`RemoteHostController` 是 `InteractiveMode` 持有的、按需启动的单会话 PiServer 宿主：它把当前 `AgentSession` 包装为 detach-only `PiSessionRuntime`，经 WebSocket listener 服务静态页面与协议，并随着 TUI session replacement 更新目标；TUI 会话本体仍归 `AgentSessionRuntime` 所有（`packages/coding-agent/src/core/agent-session-runtime.ts:67-80,171-202`）。

## 3. 签名和行为契约（每步说明省略后果）

### 3.1 最小接口

```ts
interface RemoteHostCommandApi {
  start(): Promise<RemoteShareInfo>;
  stop(): Promise<void>;
  status(): Promise<RemoteHostStatus>;
}

interface RemoteShareInfo {
  port: number;                 // 实际绑定端口，包括配置 port=0 时的 OS 分配端口
  urls: string[];               // 同 token 的完整页面 URL，token 在 #fragment
  qrUrl?: string;               // 供 QR 编码的一个可达 URL
}

interface RemoteHostStatus {
  running: boolean;
  bindHost: string;
  port?: number;
  sessionId?: string;
  participantCount: number;
}

class RemoteHostController implements RemoteHostCommandApi {
  constructor(options: { getSession: () => AgentSession; getModelRuntime: () => ModelRuntime; settings: SettingsManager });
  start(): Promise<RemoteShareInfo>;
  stop(): Promise<void>;
  status(): Promise<RemoteHostStatus>;
  rebindSession(session: AgentSession, modelRuntime: ModelRuntime): Promise<void>;
  dispose(): Promise<void>; // 幂等 stop
}
```

以上是建议的 D2 内部签名，不是现有 API。ModelRuntime 由当前 `AgentSessionRuntime.services` 提供：`services` getter 返回当前服务对象（`agent-session-runtime.ts:97-103`），`AgentSessionServices` 含 `modelRuntime`（`agent-session-services.ts:87-95`）；避免读取 `AgentSession` 的私有 `_modelRuntime`（`agent-session.ts:758-760`）。`RemoteShareInfo.port` 需要 D1 listener 给出真实绑定端口；当前 `PiServerListener.address` 仅声明可选的人类可读地址（`packages/server/src/listener.ts:3-9`），port=0 的结构化提取契约待定（第 10 节）。

### 3.2 命令上下文、输出与解析

现有 `CommandContext` 只有 `args/session/view`，没有 SettingsManager 或 Controller（`packages/coding-agent/src/core/slash-commands.ts:92-97`）。`CommandView` 提供 `renderMessage`、`showStatus` 等窄输出能力（同文件 `:70-90`）；InteractiveMode 的 `renderMessage` 以 `Text` 或 `Markdown` 写入聊天区（`packages/coding-agent/src/modes/interactive/interactive-mode.ts:2957-2978`）。`Text` 支持多行且 ANSI 感知换行（`packages/tui/src/components/text.ts:4-7,60-67`）；Markdown link 在终端支持 hyperlinks 时输出 OSC 8，不支持时显示链接地址（`packages/tui/src/components/markdown.ts:727-745`）。因此 `/remote` 可以显示可点击链接和多行 QR 块，但不能从现有 CommandContext 取得 TUI 实例、尺寸或远程宿主。

**设计决定：**给 `CommandContext` 增加可选窄接口 `remoteHost?: RemoteHostCommandApi`；给 `dispatchCommand` 增加可选 capability 参数，由 `InteractiveMode.tryDispatchRegistryCommand()` 传当前 Controller。不要让 `remote.ts` 导入整个 InteractiveMode，也不要用隐式进程级单例；headless/RPC 没有注入时 `/remote` 显示“仅交互式 TUI host 可用”并不启动服务。现有 dispatch 正是构造 `{ args, session, view }`（`packages/coding-agent/src/commands/index.ts:24-33`），所以漏传该 capability 会导致 `/remote` 无法取到 listener / settings / lifecycle。

命令解析只认 `ctx.args`：无参与 `start` → start；`lan` → lan（契约 C3 修订后新增：以 `0.0.0.0` 重启监听——先按 stop 语义关闭当前 server 并旋转 token，再以 `0.0.0.0` + 同一 `remote.port` 设置重新 start，随后按 §3.3.3 的 `0.0.0.0` 分支枚举 LAN 地址并显示 QR；未启动时直接以 `0.0.0.0` 启动）；`stop` → stop；`status` → status；其它值或多余参数 → 展示 `Usage: /remote [start|lan|stop|status]`，不进行部分匹配。`CommandEntry` 支持 `usage`、`argHint`、`autocomplete`（`slash-commands.ts:118-131`）；提供四个子命令的前缀补全。元数据需同时加入 `BUILTIN_SLASH_COMMANDS`（它驱动交互式命令提示与 completion，`slash-commands.ts:14-20`；`interactive-mode.ts:604-630`）和 `builtins.ts` 的注册清单（`commands/builtins.ts:722-760,783-788`），否则 dispatch 与 TUI 命令发现会不一致。

### 3.3 `RemoteHostController` 生命周期与分享链接

1. **构造但不监听。**`InteractiveMode` 创建一个 Controller，初始 session/modelRuntime 取 `runtimeHost.session` 与 `runtimeHost.services.modelRuntime`。不在 TUI 启动时开端口；省略懒启动会造成用户未请求分享时也暴露监听端口，违反安全默认（`01-共同上下文.md:66,91`）。
2. **start 幂等。**若已 running 或 start 正在进行，复用同一个 Promise/已生成链接，不重启 listener、不旋转 token；否则读取有效 remote 设置，先生成 `crypto.randomBytes(32).toString("base64url")` token，创建静态资源目录、`TuiSessionService`、PiServer、WebSocket listener 并 await `server.start()`。失败时关闭部分创建的 server/listener、清空 token 和状态后原样报告失败；省略回滚会留下占用端口或可被复用的半启动状态。token 格式与生命周期遵循 `01-共同上下文.md:48-53`。
3. **端口与地址。**配置 port=0 时必须从 listener 的实际绑定信息取得实际端口，不能把 `0` 填入 URL；PiServer 聚合 listener `address`（`packages/server/src/server.ts:90-92`），但当前 listener 只承诺 `address?: string`（`packages/server/src/listener.ts:4-9`），实际端口的强类型字段/格式需要 D1 明确。`remote.host=127.0.0.1` 时只给本机链接并明确“仅本机可连”；可将本机发现的 RFC1918 地址作为“未监听，仅供配置参考”的提示，并提示用户配置 `remote.host=0.0.0.0` 后重启以供 LAN 访问；loopback bind 没有可供手机访问的 C5 LAN QR。其它具体非 wildcard host 用配置值作为页面 URL 的 host（loopback 仍标为本机链接）；配置 `0.0.0.0` 时从 `os.networkInterfaces()` 中排除 `internal`、非 IPv4、loopback/link-local，筛选 RFC1918 IPv4（10/8、172.16/12、192.168/16），每个候选生成 `http://<ip>:<actualPort>/#<token>`，并输出 LAN 地址提示。若没有 RFC1918 地址，不伪造 LAN URL；仅显示 loopback 诊断且 `qrUrl` 不提供。若有多个候选，全部列出，QR 取枚举到的首个候选地址；该优先级是 `[推断]`，OS 接口枚举顺序未保证“首个”即手机可达接口（第 10 节）。页面/WS URL 格式严格遵循 `01-共同上下文.md:50-52`。
4. **start 输出。**返回 `RemoteShareInfo` 后由 `/remote` entry 把所有候选页面 URL 作为 Markdown link 块渲染，并显示 bind-host / LAN 提示；OSC 8 可点击，不支持 OSC 8 时仍可复制/手工输入 URL。QR 使用 `qrcode` 的 `QRCode.toString(qrUrl, { type: "terminal" })`（C5：`01-共同上下文.md:81-84`），以非 Markdown `renderMessage(qrText)` 渲染，保留终端 QR 字符与 ANSI。CommandView 不暴露列宽；用 `process.stdout.columns` 与 `visibleWidth(qrText 每行)` 检查内容宽度（扣除 `Text` 两侧各 1 列 padding；`visibleWidth` 已由 TUI package export，`packages/tui/src/index.ts:144-146`）；宽度未知或 QR 超宽时只显示链接文本，不输出会被换行破坏的 QR。省略检测会让窄终端把二维码折行而无法扫码。多行输出能力依据 `Text` 当前实现（`packages/tui/src/components/text.ts:60-67,74-97`）。
5. **stop。**先将 controller 的有效 token 置空/标记 stopped，再 await `PiServer.close()`；PiServer 的 close 先关闭 listeners，随后关闭连接并 dispose live runtimes（`packages/server/src/server.ts:161-175,357-368`），Controller 清除 URL/端口缓存。关闭失败也不能重新接受旧 token；返回聚合错误供 TUI 报告。省略先失效 token 会在关闭窗口内继续授权旧链接。`/remote stop` 不调用 `AgentSession.dispose()`，不 abort 当前 turn。
6. **status。**不展示 token / 分享 URL；显示 running、bind host、实际端口、当前 session id 与连接参与者数。连接数需按已 attach 到当前 session 的参与者定义；当前 PiServer 未暴露该数量（冲突见第 9 节），在上游接口落地前 status 的该字段不能伪造。
7. **dispose/退出。**Controller.close 必须幂等并 await stop。正常 `shutdown()` 的 Ctrl+D、双 Ctrl+C、`/quit` 与 extension shutdown 均走同一个退出逻辑（`interactive-mode.ts:3842-3855,3864-3902`）；SIGTERM/SIGHUP 走 `shutdown({fromSignal:true})`，其信号列表目前是 SIGTERM 和非 Windows 的 SIGHUP（同文件 `:3952-3970`）。在两条 `shutdown()` 分支中都先 await `remoteHostController.dispose()`、再 `runtimeHost.dispose()`，最后恢复 terminal/退出；这样 Web runtime 先 detach，随后 `AgentSessionRuntime` 再拥有并销毁真实会话。真实 OS SIGINT 目前不在该 signal 列表，Ctrl+C 是 TUI key handler；为满足 SIGINT 退出同样优雅关闭，设计上将 SIGINT 加入 graceful signal handler（raw TUI Ctrl+C 仍由 `handleCtrlC()` 处理），或明确只承诺 Ctrl+C 键路径。不能依赖 `process.on("exit")` 做异步 close；直接 `process.exit` 会跳过异步等待。省略 graceful hook 会使服务关闭时序不可证明；进程直接退出时 OS 最终回收 fd，但不等价于 await `PiServer.close()`。

   **紧急退出路径的诚实边界（评审门补充）**：`emergencyTerminalExit()` 与 `uncaughtCrash()` 走同步 `process.exit()`（`interactive-mode.ts:3905-3941`，后者先移除 signal handlers），不等待异步 `PiServer.close()`。这两条路径不做异步清理，依赖 OS 兜底：进程死亡即释放 listener fd 与全部 socket，token 随进程内存消失。设计不为它们添加异步 close 尝试（会破坏紧急退出语义），但 Controller 的端口/token 状态只在进程内存中，因此无残留风险面。

### 3.4 `TuiSessionService` 与 runtime 复用

```ts
interface TuiSessionService extends PiServerService {
  listSessions(): Promise<SessionMetadata[]>;             // 只返回当前 AgentSession
  openSession(id: string): Promise<TuiSessionRuntime>;    // id 不等于当前 id 时 SessionNotFoundError
  createSession(options: CreateSessionOptions): Promise<never>; // invalid_request
}
```

`TuiSessionRuntime` 实现 `PiSessionRuntime`：snapshot、prompt、steer、abort、setModel、setThinking、getPhase、subscribe 均委托共享 adapter；dispose 只取消 AgentSession 订阅并清本地 listener，绝不 dispose/abort AgentSession。PiServer 在无连接且 idle 时可以 dispose runtime（`packages/server/src/sessions.ts:383-408`），TUI 会话却归 `AgentSessionRuntime` 所有（`agent-session-runtime.ts:67-80,438-440`），所以把 runtime dispose 绑定到真实 session disposal 会让浏览器断开后误杀 TUI 会话。

**复用选型：**把 `packages/coding-agent/src/server/coding-agent-server.ts:368-668` 中当前未导出的 `CodingAgentRuntime` 仅改为导出；它已经把 snapshot、AgentSession 事件到 PiServer progress/snapshot 的转换集中在一个类中（`:405-458,488-613`），并且 constructor 已通过 `onDispose` 参数化资源释放、`dispose()` 先取消订阅再回调（`:383-397,477-487`）。CodingAgentPiServer 保持原构造参数与原 `onDispose` callback，不改其持久化清理语义（`:179-205`）；TUI 传 `async () => {}` 作为 dispose callback，因而复用转换逻辑而只 detach。复制一份转换器会造成两套消息映射；提取公共基类会扩大改造面，均无必要。TUI wrapper 要求能取得 session id/metadata、model runtime；id/header 与 transcript 当前由 adapter `snapshot()` 读取并校验（`:405-458`），`modelRuntime` 从当前 `AgentSessionRuntime.services` 注入（`agent-session-services.ts:87-95`）。

### 3.5 会话跟随：选 B（InteractiveMode 显式通知）

`AgentSessionRuntime.setRebindSession()` 只保存一个回调（`agent-session-runtime.ts:117-119`）；InteractiveMode 构造时已经注册回调，执行 `rebindCurrentSession({renderBeforeBind:true})` 再应用主题（`interactive-mode.ts:494-505`）。因此选 **B：在这个既有 InteractiveMode callback 中、UI rebind 完成后显式调用 `remoteHostController.rebindSession(this.session, this.runtimeHost.services.modelRuntime)`**。避免 Controller 再包装/覆盖同一个单槽 callback；漏调用会让 web `listSessions/openSession` 保持旧 AgentSession。

会话 replacement 的时序必须保持如下：

1. `/new`、`/resume`、`/fork` 的 InteractiveMode/extension action 调用 `runtimeHost.newSession/switchSession/fork`（`interactive-mode.ts:1791-1812,1834-1836`）。
2. `AgentSessionRuntime` 先做 replacement policy 检查、发 `session_before_switch` 或 `session_before_fork`；取消时原 session 保持不动（`agent-session-runtime.ts:204-216,241-250,279-288`）。
3. `switchSession` 先打开目标 SessionManager 并检查 cwd，`newSession` 创建新 SessionManager，`fork` 计算/创建 branch；这些操作在旧 session teardown 前完成（同文件 `:218-227,252-263,292-325,337-354,367-374`）。
4. `teardownCurrent()` await 旧 session.abort()，发 `session_shutdown`，同步调用 `beforeSessionInvalidate`，再 dispose 旧 AgentSession（同文件 `:171-186`）。因此远程 `prompt` 若正在流式运行，也会共享这次 abort；切换不是并行地把 web 留在旧 AgentSession。
5. 创建新 `AgentSession` 并 `apply()` 更新 runtime 当前引用；`newSession` 可在 rebind 前做 setup（同文件 `:188-202,262-276`）。
6. `finishSessionReplacement()` 调用注册的 rebind callback，随后才执行 `withSession` extension hook（同文件 `:195-202`）；InteractiveMode 先绑定 UI 到新 session，再通知 RemoteHostController 更新 `listSessions/openSession` 目标。`resume`、所有 fork 分支与 import 同样走 teardown → apply → finish/rebind（`agent-session-runtime.ts:227-238,324-334,354-364,373-384,425-435`）。
7. Controller 记录旧 session id；在 PiServer 支持显式移除后，令其对旧 id 的 live runtime 发既有 `session_removed`、断开旧 attach 并 detach runtime，再让新 service 对 list 返回新 session。浏览器按 C4 在收到此事件后重新 list+attach（`01-共同上下文.md:77`）。当前第 7 步**不能仅凭现有 PiServer 完成**，见第 9 节；不得假称 dispose runtime 会自动产生 `session_removed`。
### 3.6 AgentSession 并发操作的精确语义与 web 调用约定

1. PiServer 收到 `prompt`/`steer`/`abort` 后分别调用 runtime 对应方法（`packages/server/src/sessions.ts:121-136`）；`runOperation()` 只增减 `operationCount` 并在成功后广播 snapshot，不提供 per-session 操作互斥（同文件 `:202-214`）。PiSessionRuntime 接口注释要求冲突操作 reject 而不是 queue（`packages/server/src/types.ts:41-52`），不能将 PiServer 当作输入 FIFO。
2. **Idle prompt：**`CodingAgentRuntime.prompt()` 原样调用 `session.prompt(input.text)`，不传 `streamingBehavior`（`coding-agent-server.ts:460-462`）。对普通文本，AgentSession 经输入处理后若未 streaming，会校验并进入 `_runAgentPrompt`，启动真实共享 turn（`agent-session.ts:2933-3010,3017-3104`）。但 `AgentSession.prompt()` 默认启用 prompt/extension command expansion，且先于 streaming 检查识别已注册 extension slash command；命中时立即运行该 extension command 并返回，不产生普通 prompt turn（`agent-session.ts:2924-2960,2933-2935`）。web 调用此路径不会经过 TUI 的 builtin `dispatchCommand`（`commands/index.ts:24-33`；TUI builtin route 在 `interactive-mode.ts:2943-2954`）。若两个普通 prompt 抢在 turn 开始前进入，两者可能都通过 AgentSession 早期异步检查；底层 Agent `runWithLifecycle()` 对 `activeRun` 做同步 guard，先进入者启动，另一个 reject（`packages/agent/src/agent.ts:531-540`）。若第二个请求已经观察到 `isStreaming`，它会更早因缺少 `streamingBehavior` reject（`agent-session.ts:1585-1593,2996-3010`）。谁先赢由实际调度决定，没有跨 TUI/网络的优先权；失败后刷新 snapshot，不自动重试。
3. **Turn 中 prompt：**对普通文本，web 的 PiServer `prompt` 委托仍无 `streamingBehavior`，所以 AgentSession 发现 streaming 后抛“Agent is already processing… Specify streamingBehavior”错误，不会静默转成 steer（`coding-agent-server.ts:460-462`；`agent-session.ts:2996-3010`）。前一步的已注册 extension slash command 例外：它在 streaming 检查之前被运行（`agent-session.ts:2941-2960`）。TUI 普通 Enter 在 streaming 时则明确调用 `session.prompt(text, { streamingBehavior: "steer" })`；Alt+Enter 明确传 `followUp`（`interactive-mode.ts:2900-2913,4036-4059`）。`/remote` builtin slash command 在 streaming 时由 TUI registry 立即执行，但 web `PiSessionRuntime.prompt` 不走该 registry（`interactive-mode.ts:2900-2913,2943-2954`）。
4. **Turn 中 steer：**web runtime 调用 `session.steer()`；AgentSession 将文本送过 input handlers，然后 `_queueSteer()` 先更新 steering 队列并发 `queue_update`，再调用 `Agent.steer()` 入队（`agent-session.ts:3270-3281,3300-3317`；`agent.ts:320-328`）。它在当前 assistant/tool 轮结束后、下一次 LLM 请求前送入 Agent loop（`agent-session.ts:3270-3274`）；队列一次取一条或一起取由 session 的 steering mode 决定（`agent.ts:148-177,520-527`）。TUI 与浏览器都写同一个队列；并行调用的先后以各自异步 input handling 实际完成并调用 `_queueSteer()` 的顺序为准，不承诺等于网络包或按键物理先后。
5. **Idle steer：**`AgentSession.steer()` 没有 idle 检查，也不触发一个 turn；它仍会 `_queueSteer()`。随后每个新 `runAgentLoop` 在开始时会先 poll `getSteeringMessages()`，所以闲置时提前入队的 steer 可能在之后某次 prompt/continue 开始时才被消费（`agent-session.ts:3279-3281,3300-3317`；`agent.ts:320-328,520-527`；`agent-loop.ts:283-285`）。所以 web **MUST** 只在最新 snapshot phase 为 `turn` 时调用 steer；idle 时必须 prompt，否则用户会看到一条待处理消息却没有新 turn 处理它。
6. **Abort：**runtime `abort()` 委托 `AgentSession.abort()`；它 abort retry/compaction/branch-summary controller、调用 `agent.abort()` 并等待 idle（`agent-session.ts:3877-3893`）。它本身不调用 `clearQueue()`（同文件 `:3845-3855,3880-3886`），而 post-run loop 会在 `_handlePostAgentRun()` 返回仍有 queued messages 时继续（同文件 `:2871-2897,2900-2920`）。因此接口承诺是中止当前共享操作并等待 idle，不应宣称会清空已经排队的 steer/follow-up；浏览器 abort 后重新 snapshot 并呈现剩余 queue。若需求要“一并清空队列”，须另行改协议/契约，不在本模块自行扩展。
7. **web 端调用约定：**用最新 phase：`idle → prompt`，`turn → steer`；`retry`、`compaction`、`branch_summary` 等其它非 idle phase 禁止提交新 prompt，等待 phase 变化（phase 映射见 `coding-agent-server.ts:398-403`；web UI 口径见 `01-共同上下文.md:77`）。abort 可用于当前共享 operation。对一个用户输入只发一次协议命令；同一浏览器自己的命令按用户顺序等待前一条响应后再发，避免客户端主动并发造成自身顺序不确定；TUI 与 web 的总序仍不保证。若 stale phase 导致 prompt 被 reject，显示错误、刷新 snapshot，交由用户决定下一次操作；禁止自动把失败 prompt 改为 steer 或盲目重发（不承诺 exactly-once：`01-共同上下文.md:87-90`）。

### 3.7 remote.host / remote.port settings 全链路

当前 `Settings` 有 `toolSearch?: ToolSearchSettings` 等分组字段但没有 `remote`（`settings-manager.ts:133-147`）；ToolSearch 的类型、Required defaults、读取/校验、setter、一次性错误报告链分别在 `:30-59,1139-1230`。新增：

```ts
export interface RemoteSettings {
  host?: string; // default: "127.0.0.1"
  port?: number; // default: 0, OS-assigned
}
// Settings: remote?: RemoteSettings
const DEFAULT_REMOTE_SETTINGS: Required<RemoteSettings> = {
  host: "127.0.0.1",
  port: 0,
};
```

`getRemoteSettings()` 从合并后的 `this.settings.remote` 读取；缺省逐字段回退上述默认值。`host` 不是字符串或空/全空白时，通过与 ToolSearch 同样的按 key 一次性 `reportInvalidRemoteSetting` 记录并回退；其它非空字符串原样作为 bind host，v1 不在 SettingsManager 中解析 DNS/IP。`port` 必须是 safe integer 且位于 `0..65535`（0 有意表示临时端口），否则报告一次并回退 0。`setRemoteHost()` / `setRemotePort()` 对相同条件做写入前校验；非法 setter 值 `recordError` 并拒绝写入。合法 setter 初始化 `globalSettings.remote`，更新单个 nested key，`markModified("remote", key)` 后 `save()`，沿用 `setToolSearchSetting()` 的全局持久化模式（`settings-manager.ts:1212-1219`）。SettingsManager 构造时已经将 global → project → process overlay 合并（`:394-397`），getter 必须读取有效合并值，不能绕过 project/overlay。

`/settings` 目前由静态 `SettingsConfig`、`SettingsCallbacks` 与固定 SettingItem 列表组成（`modes/interactive/components/settings-selector.ts:59-129,497-612,777-884`）；其中没有 ToolSearch。remote.host 是自由文本、remote.port 是数字，不适合塞入当前枚举选择项。本版只支持 settings 文件/现有 config layering，不新增 `/settings` UI；若要求 UI 编辑，列为第 10 节待拍板。

---


## 4. 文件

- **新增** `packages/coding-agent/src/server/remote-host.ts`：RemoteHostController、TuiSessionService、TuiSessionRuntime 与链接/状态类型（接口归属遵循 `01-共同上下文.md:55-66`）。
- **新增** `packages/coding-agent/src/commands/remote.ts`：`CommandEntry`；仅消费 `CommandContext.remoteHost` 与 `CommandView`，格式化 link、二维码、错误/状态输出。
- **修改** `packages/coding-agent/src/modes/interactive/interactive-mode.ts`：持有 Controller；注入 command capability；session rebind 通知；graceful shutdown 清理（当前入口/回调/退出位置分别见 `:494-505,1886-1912,2943-2954,3864-3902,3952-3970`）。
- **修改** `packages/coding-agent/src/core/slash-commands.ts`、`src/commands/builtins.ts`：在 `slash-commands.ts` 定义窄 `RemoteHostCommandApi` 并加可选 `CommandContext.remoteHost`，`dispatchCommand` 增加可选 capability 参数；加入 `/remote` 的 metadata 与 builtin entry（现状模式见 `slash-commands.ts:70-97,118-131`、`builtins.ts:722-788`）。
- **修改** `packages/coding-agent/src/server/coding-agent-server.ts`：导出 `CodingAgentRuntime`，保留原 server 构造/清理 callback（现状类范围 `:368-668`）。
- **修改** `packages/coding-agent/src/core/settings-manager.ts`：新增 RemoteSettings 类型、defaults、validated getters/setters 与错误报告（现有 ToolSearch chain 见 `:30-59,133-147,1139-1230`）。
- **修改** `packages/coding-agent/src/config.ts`、`package.json`、lock/shrinkwrap：增加 remote web static dir resolver、bundle/copy 资产与 runtime `qrcode` dependency（现有资产路径/脚本见 `config.ts:361-419`、`package.json:51-59,61-87`）。web 源资产由 D3 管理，不在本 D2 设计中重复规定（`01-共同上下文.md:72-79`）。
- **需上位协调** `packages/server/src/sessions.ts` 与 `src/server.ts`：实现可观察的 attached participant count 及按 id 发出 `session_removed` 的服务端 API；不能由 D2 伪造调用现存私有字段（现状证据见第 9 节）。

## 5. 副作用与资源边界

- start：只监听配置地址/端口、内存中保留 token、由 listener 读取打包后的静态资源；不启动 relay、不创建/持久化会话；`TuiSessionService.createSession` 一律拒绝（直连/单会话契约：`01-共同上下文.md:8-14,61-66,95-100`）。
- Web prompt/steer/abort 写入同一个 AgentSession transcript/queue；这不是只读快照，也不新建 AgentSession（操作委托实现先例 `coding-agent-server.ts:460-468`）。
- stop/host dispose：关闭 PiServer/listener/WS 客户端并撤销 token；adapter dispose 只 detach；不影响当前 AgentSession。本地 TUI 退出时另由 `AgentSessionRuntime.dispose()` 执行真实 session teardown（`agent-session-runtime.ts:438-440`）。
- settings setter 按 ToolSearch 模式持久化到 settings 文件；start/stop/status 不隐式改 settings。settings 保存会重新合并 global/project/overlay 并写 global scope（`settings-manager.ts:394-397,745-762,1212-1219`）。
- QR 与 link 只写入 TUI 聊天输出；不写 clipboard、session transcript 或文件。[推断] 需避免把 token-bearing URL 传到日志/错误报告。

## 6. 确切代码落点

1. `interactive-mode.ts` constructor：在初始化时创建 Controller（不启动）；当前 `runtimeHost.setRebindSession` callback 增加 rebind 通知；`setupEditorSubmitHandler` 的 `dispatchCommand` 路径传 capability。现有 callback 注册点 `:494-505`，dispatch `:2943-2954`。
2. `interactive-mode.ts` `shutdown()`：fromSignal 分支在 `runtimeHost.dispose()` 前 await Controller.dispose；正常退出分支在 `stop()` 后、`runtimeHost.dispose()` 前 await；`registerSignalHandlers()` 增加 SIGINT graceful 路径或明确 Ctrl+C key-only 保证。现有分支位置 `:3864-3902`，signal handlers `:3952-3970`，Ctrl+C key 路径 `:3842-3855`。
3. `commands/remote.ts`：导出 entry `remoteCommand`；实现 subcommand 解析和 autocomplete；start 成功用 Markdown link，二维码单独用 raw `renderMessage`，status 不显示 secret。builtin 清单增加 `{ name: "remote", entry: remoteCommand }`，slash metadata 增加描述与 argumentHint。
4. `coding-agent-server.ts`：`class CodingAgentRuntime` 改 `export class CodingAgentRuntime`，server 原 `new CodingAgentRuntime(..., existingDispose)` 保持字面行为；TUI 调用同类时传 no-op dispose callback。
5. `remote-host.ts`：服务 list/open/create、当前 session/model runtime 的 rebind、token、listener/PiServer 启停。start 完成后以实际绑定端口创建 URL；stop 先清 token，再关闭 PiServer；运行状态不得从 session manager 的历史会话推断。
6. `settings-manager.ts`：`RemoteSettings` 与 `DEFAULT_REMOTE_SETTINGS` 放 ToolSearch 类型/defaults 附近；`Settings.remote?` 放相邻字段；`getRemoteHost/getRemotePort/getRemoteSettings` 与 setter/error reporter 放 ToolSearch getters 附近。`/settings` UI 暂不添加 host/port 编辑项，见第 9 节。
7. `config.ts`：新增 `getRemoteWebDir()`，沿用 `isBunBinary/getPackageDir()`：Bun binary → `join(getPackageDir(), "remote-web")`；npm dist → `join(getPackageDir(), "dist/server/remote-web")`。需要 source checkout 支持时可另外指向 `web/remote`，但不可改变两个产物布局。`export-html` 当前通过 `getExportTemplateDir()` 与 `readFileSync(join(...))` 加载模板，不直接用 `import.meta.dirname`（`config.ts:406-419`；`core/export-html/index.ts:165-181`）。
8. `package.json`：`build` 先调用 `build:remote-web` 再 `copy-assets`；`copy-assets` 将 web 入口 html 等非 bundle 静态文件放入 `dist/server/remote-web/`；`copy-binary-assets` 将完整目录复制到 `dist/remote-web/`。加入 `qrcode` runtime dependency 与 shrinkwrap 更新。当前 `copy-assets`、`copy-binary-assets` 及 build 入口见 `package.json:51-56`。
9. 上位 server API（待确认）：在 `LiveSessionManager` / `PiServer` 提供 remove-by-id 发事件和 attached participant count；保持 protocol schema 不变，只使用已有 `session_removed` variant（`packages/protocol/src/schemas.ts:407-410`）。

## 7. 与现状差异

- 当前 `/remote` 不在 builtin metadata 或注册表；现有 `/share` 是 gist 分享，且 builtin entries 有独立 usage/argHint/autocomplete 结构（`packages/coding-agent/src/commands/builtins.ts:73-139,722-760`；`core/slash-commands.ts:20-50,118-131`）。
- `CommandContext` 不能访问 Controller/SettingsManager；`dispatchCommand` 只传 args/session/view（`commands/index.ts:24-33`）。需加显式可选 capability 注入。
- `AgentSessionRuntime.setRebindSession` 已由 InteractiveMode 使用，callback 在 new runtime 应用后运行；无第二个 callback 合并机制（`agent-session-runtime.ts:117-119,188-202`；`interactive-mode.ts:502-505`）。D2 应在既有 callback 中通知，而不是重设 slot。
- `CodingAgentRuntime` 当前未导出；它的 dispose 会执行传入的 `onDispose`，该参数当前承载 CodingAgentPiServer 释放 session store/model/runtime 资源（`coding-agent-server.ts:368-397,477-487,179-205`）。TUI 不能复用原 cleanup callback。
- AgentSession 的并发语义不是“任何 prompt 自动变 steer”：`prompt()` turn 中要求显式 `streamingBehavior`，缺少时抛错；PiServer `CodingAgentRuntime.prompt` 现在只传文本，`CodingAgentRuntime.steer` 才调用 session.steer（`agent-session.ts:2924-2931,2996-3010`；`coding-agent-server.ts:460-468`）。
- `remote.host/port` 不存在于 `Settings`；ToolSearch 已有完整 defaults/getter/setter/validation pattern（`settings-manager.ts:30-59,133-147,1139-1230`）。当前 `/settings` 是静态 SettingItem 列表，也没有 ToolSearch 或 remote host/port（`settings-selector.ts:59-94,497-612,777-884`）。
- package 目前没有 `qrcode` 直接 runtime dependency，资产脚本只复制 TUI theme/assets 与 export-html 模板（`package.json:51-56,61-87`）。
- export-html 模板解析已通过 `config.ts` 的 package-dir / binary-layout helper，不是以 `import.meta.dirname` 硬编码；npm dist 和 Bun binary 有不同静态资源布局（`config.ts:361-419`；`core/export-html/index.ts:165-181`）。
- server 协议 schema 中确有 `session_removed` event variant，但 server runtime event type 只有 snapshot/progress/error，server event bridge 只发送 progress 或 snapshot；目前不存在从 TUI session replacement 到 `session_removed` 的发射链（`packages/protocol/src/schemas.ts:407-410`；`packages/server/src/types.ts:36-52`；`packages/server/src/sessions.ts:285-300`）。

## 8. 消费者可见验收

1. 默认设置下 `/remote` 启动于 `127.0.0.1`；显示本机完整 URL、安全提示与"`/remote lan` 开启局域网访问"提示（契约 C3 修订裁定：默认 loopback 不显示 QR），端口 0 显示实际端口。`/remote` 第二次执行仍是同一 URL/token/端口；`/remote lan` 后绑定 `0.0.0.0`、token 旋转、旧链接失效，显示全部 RFC1918 链接与 QR；`/remote status` 不暴露 token。
2. 配置 `remote.host: "0.0.0.0"`、`remote.port: 0` 时 listener 绑定全部网卡；存在 RFC1918 地址时输出可供同 LAN 浏览器访问的 `http://<lan-ip>:<port>/#<token>`，并以该 URL 生成 QR；不存在时明确提示，不生成假的 LAN QR。WS URL token 只通过页面 fragment 进入，启动静态页面后其 JS 再构造 `/ws/<token>`（`01-共同上下文.md:50-52`）。
3. 支持 OSC 8 的终端中链接可点击；无 OSC 8 时链接文本仍包含原始 URL。终端宽度足够时二维码完整、不折行；不足/宽度未知时只降级为纯链接文字（`CommandView` markdown/link 与 Text 多行依据 `markdown.ts:727-745`、`text.ts:60-67`）。
4. `/remote stop` 后旧 URL 的 token 认证失败，端口释放；再次 start 得到新 token，旧 token 永不恢复。并行中的 AgentSession turn 不因 stop 被 abort。
5. web idle 状态发 prompt；turn 状态发 steer；retry/compaction/branch_summary 等阶段不提交新 prompt。任意一侧 abort 会中止共享 AgentSession 当前操作，但已经排队的 steer/follow-up 不保证被清空，浏览器应重新 snapshot 并保留 queue 状态（`agent-session.ts:2871-2897,3877-3893`）。TUI Enter 在 turn 中的行为仍为 steer，Alt+Enter 仍为 follow-up（`interactive-mode.ts:2900-2913,4036-4065`）。并发 idle prompt 由 AgentSession 的原子 active-run guard 决胜，失败的一方收到现有错误并刷新 snapshot，而不是自动重发/改成 steer（`packages/agent/src/agent.ts:385-396,531-540`；`01-共同上下文.md:87-90`）。
6. `/new`、`/resume`、`/fork` 完成后 TUI 绑定新 session，PiServer 的当前 list 只含新 session；旧 attach 收到 `session_removed` 后浏览器重新 list+attach 新 session。此验收依赖第 9 节 server API 冲突解决。
7. Ctrl+D、双 Ctrl+C、`/quit`、SIGTERM（以及设计增加的直接 SIGINT graceful handler）关闭 server/listener 后退出；端口不留在进程后台，token 失效（`interactive-mode.ts:3842-3855,3864-3902,3952-3970`）。
8. npm dist 运行时解析 `dist/server/remote-web`；Bun binary 运行时解析 executable 邻接的 `remote-web`；两布局 `index.html` 和 bundle 都存在（`package.json:53-56`、`config.ts:361-419`）。

## 9. 发现的冲突与需修订上位文档

> **共同设计 owner 裁定（2026-10-08，评审门）**：冲突 1/2/3/5 已裁定并回写 `01-共同上下文.md`（C1 增加 `PiServer.removeSession`/`sessionParticipantCount`/`boundPort`/close code 1001，C3 增加 `/remote lan` 子命令与默认 loopback 无 QR）；详见 00-需求原话.md 拍板记录新增三行与 02-ws-transport.md §3 契约补充。以下原始冲突陈述保留作审计痕迹。

1. **C3 假设 session replacement 可通过既有 `session_removed` 事件自动跟随，但 server 目前没有发射器。**协议只定义 variant（`packages/protocol/src/schemas.ts:407-410`）；`PiSessionRuntimeEvent` 不包含 removal（`packages/server/src/types.ts:36-39`）；`LiveSessionManager.handleRuntimeEvent()` 对 error 做 terminate、对 progress 发 `session_progress`、其它只 broadcast snapshot（`packages/server/src/sessions.ts:285-300`）。`maybeDispose()` 仅在 idle 且无连接时 dispose/delete live runtime，不会广播 `session_removed`（同文件 `:383-408`）。已连接浏览器会阻止 maybeDispose。更关键的是 `listMetadata()` 会把 live runtime snapshot 合并/附加到 service 的 stored list（同文件 `:165-180`），`acquire()` 会优先复用 `liveSessions` 中的旧 runtime 而不调用 service.openSession（同文件 `:217-227`）；所以仅更新 TuiSessionService 的“当前 session”既不能让旧 session 从 list 消失，也不能阻止旧 id attach。AgentSessionRuntime rebind/dispose 本身不能让浏览器收到 removal。

> **实现差异记录（2026-10-08，交付验收）**：① `getRemoteWebDir()` 实现为 dist 产物优先探测（`dist/server/remote-web/index.html` 存在即用），仅产物缺失时回退 `web/remote/`——§3.7.7 的 `existsSync(src)` 判定在源码库与发布包场景会误指无产物的源码目录，已修正；`startInternal` 在目录无 `app.js` 时直接报错并提示 `npm run build:remote-web`。② WS close 时序修复：listener 需在 upgrade 成功后把 socket 移出 `httpSockets`（否则 `close()` 的 `socket.destroy()` 抢先于 1001 关闭握手，客户端见 1006）；且须 await 全部 `closeWithCode(1001)` 握手后再 `wss.close()`（02 §3.7 修订，已同步实现）。③ web 客户端：`onConnectionStateChange` 订阅移至 client 建立后立即注册（原首连路径漏订阅，宿主 stop 无法到达终止态）；约定关闭（1001+"server shutdown"）经 transport `onError` 携带语义（`ByteTransportHandlers.onClose` 无载荷通道）；`snapshot.locked` 不再作为 composer 禁用条件（`CodingAgentRuntime` 恒报 `locked: true`，属服务端 durable 锁标志，不适用于共享 attach 场景）。④ `/share` 注册项在集成期被误替换为 `/remote`，已恢复并存。上述修复均经真实 TUI+浏览器 E2E 验证（见 00 拍板记录同日的交付记录）。
   - **需拍板/修订：**在 `packages/server/src/sessions.ts` 增加显式按 id remove/replace 能力，由 `PiServer` 暴露给 host；对该 id 的已 attach connection 发送既有 `session_removed`，解除 attach、unsubscribe，并在 in-flight `operationCount` 收敛后 dispose runtime。协议 schema 不改。或者修订 C3/C4，明确由其他事件/重连策略实现跟随；不可仅在 D2 写“server 会发”。这同时跨出 D2 coding-agent 归属，须由共同设计 owner 确认。
2. **C3 要求 status participant 数，但 PiServer 没有公开计数 API。**PiServer 的 connection set、LiveSessionManager 与每 session connection set 都是 private（`packages/server/src/server.ts:39-48`；`packages/server/src/sessions.ts:45-50,364-370`）；`PiServer` 没有公开该状态的接口（当前接口列于 `server.ts:90-115`）。
   - **需拍板/修订：**server 增加按 session id 查询 attached connection count 的只读方法，D2 status 再显示它。participant 建议定义为“已 attach 到当前 TUI session 的已连接 PiClient 数”，不把未完成协议握手/仅完成 HTTP upgrade 的 socket 算参与者；如果 D1 选择在 WS listener 统计，也须保证其数值语义与 attached participant 一致。
3. **C1 当前 listener address 是可选字符串，C3 又需要实际随机端口。**`PiServerListener.address?: string` 仅定义为人类可读地址，`PiServer.addresses` 只聚合该字符串（`packages/server/src/listener.ts:3-9`；`packages/server/src/server.ts:90-92`）。不能可靠地从未冻结的格式推断 host/port，尤其 IPv6。
   - **需 D1 明确：**WS listener 应暴露结构化 `boundPort`（并可选 `boundHost`）或冻结可解析的 address 格式，确保 `port:0` 生成有效 URL 和 `/remote status`。
4. `AgentSessionRuntime` 替换链不发 PiServer removal；当前 `session_removed` C3 描述不是现状事实。建议把 01 C3 的“已连接 web 端会收到既有协议事件”修订为“需 server remove API 后才成立”，并记录 API owner/接口/operationCount 边界；本文不自行改冻结文档（`01-共同上下文.md:3-4,61-66`）。
5. **E1/C3/C5 的默认绑定与 QR 冲突。**E1 要求 `/remote` 立即给“局域网地址提示与二维码”（`00-需求原话.md:19`）；C3 默认 host 是 `127.0.0.1` 并要求绑定全部网卡须用户显式配置（`01-共同上下文.md:67-70,91`）；C5 又把 QR 内容规定为 LAN 页面 URL（`01-共同上下文.md:81-84`）。在 loopback 默认下不存在正确的手机可达 LAN QR；展示 `127.0.0.1` QR 会误导用户，自动改绑 `0.0.0.0` 则违反安全默认。本文推荐保留 loopback 安全默认、要求用户配置后才给 LAN QR，但这意味着默认 `/remote` 尚不完全满足 E1。需共同 owner 决定：E1/C5 是否允许“未显式启用 LAN 时不显示 QR、仅显示安全提示”，或设计明确 opt-in 的 bind 流程；D2 不得自行改 01 契约。
⑤ 网络地址实现差异：`/remote lan` 除 RFC1918 地址外还列出活动的 Tailscale IPv4（`100.64.0.0/10`），并优先使用 Tailscale 地址生成终端二维码；这是为了避免 WSL2 的 `172.31.x.x` 地址被误选为手机远程入口。

## 10. 仍未知待拍板

- `session_removed` 上述 server API 是否纳入 D1 / 另设 server 子模块；remove 期间在途 prompt/steer response 的先后关系及如何等待 `operationCount` 清零。已有 TUI `teardownCurrent()` 会 abort 并 wait idle（`agent-session-runtime.ts:171-186`），PiServer operationCount 只用于防止 dispose，不是互斥锁（`packages/server/src/sessions.ts:202-214,387-408`）。
- participant 数按“已 attach”定义是否获共同 owner 接受；PiServer 目前无读取接口（`packages/server/src/sessions.ts:364-370`）。
- D1 listener 的 `address`/`boundPort` 返回形状、`port=0` 实际端口来源和 IPv6 URL bracket 规则（`packages/server/src/listener.ts:4-9`）。
- `remote.host` 只对 `0.0.0.0` 列 LAN IPv4，还是同样支持 IPv6 wildcard `::`；共同契约只明确 `0.0.0.0`（`01-共同上下文.md:67-70`）。本设计不扩大绑定语义。
- 多网卡/虚拟网卡时 QR 选第一个 RFC1918 地址可能不可由手机路由；本设计同时显示全部候选 URL，但 QR 主地址优先级仍 `[推断]`。需实机网络验收。
- QR 超宽阈值的可用 TUI 内容宽度：CommandView 没有 dimensions API（`slash-commands.ts:70-90`），当前建议使用 `process.stdout.columns - 2`；若 fullscreen renderer 与 stdout 尺寸不同，需由 InteractiveMode 提供可靠 width。
- `qrcode` 具体版本与 Node 22 ESM/type 声明兼容性尚未在当前依赖中确定；coding-agent 当前依赖表没有它（`packages/coding-agent/package.json:61-87`）。锁定直接 runtime dependency 并生成 shrinkwrap 后才算落实 C5。
- `/settings` UI 是否要编辑 remote host/port：当前 selector 是枚举项列表，没有 freeform host/port 编辑接口，且 ToolSearch 也不在该 UI（`settings-selector.ts:59-94,497-612,777-884`）。本版建议 settings.json 配置即可；如果要求 UI 编辑，需单独设计文本输入与绑定地址安全确认，不在本模块静默添加。
- 直接 OS SIGINT 是否必须纳入 graceful signal handler，还是 E7 只承诺 TUI 的 Ctrl+C key path。现状实际注册 SIGTERM/SIGHUP，而 Ctrl+C 由 TUI 双击退出（`interactive-mode.ts:3842-3855,3952-3970`）；设计推荐加 OS SIGINT handler。
- settings 的写入 scope 采用现有 ToolSearch 全局 setter 模式；有效值仍由 global → project → process overlay 合并（`settings-manager.ts:394-397,1212-1219`）。若 `remote.host=0.0.0.0` 应仅允许 global scope 而不接受可信 project override，需安全 owner 另行拍板，不能通过改变 getter 层级隐式处理。
- 自定义 `remote.host` 是 DNS hostname、IPv6 literal 或指定 interface IP 时，QR 是否必须只接受 RFC1918 IPv4（C5 的 `<lan-ip>`）以及 IPv6 URL bracket/可达性规则；本文只定义 `0.0.0.0` 的 LAN IPv4 列表。
