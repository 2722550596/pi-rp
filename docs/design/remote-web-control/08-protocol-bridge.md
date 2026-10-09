# 阶段三：Protocol / Bridge / Client 设计

> 本文仅设计，不修改 `src/`。以 `07-stage3-transcript-actions.md` 的 C-* 为冻结契约，并继承 `01-共同上下文.md`、`05-web-frontend-v2.md` 与 `06-web-frontend.md`。现状事实均标仓库相对路径和行号；推断写 `[推断]`，未知单列。
> **阶段四修订**：本文 §3.2/§3.3/§4 中递归树投影与 `{tree,leafId}` 返回形状已由 `10-flat-tree-export-layout.md` 的扁平 `{entries,leafId}` 契约取代；其余命令、快照与错误语义仍有效。

## 1. 需求对照

| 07 原话 / 效果或契约 | 本设计响应 |
|---|---|
| “四个全做；流程按‘设计文档评审后实现’。”（`07-stage3-transcript-actions.md:7-9`） | 四项能力在协议、server 分发、runtime、client 端闭环；本篇只设计协议桥接侧，不修改 web 或 `src/`。 |
| “web 端 transcript 中 custom 消息（`display:true`）渲染为独立卡片”及“`display:false` 的不渲染”（07 E1，`07-stage3-transcript-actions.md:38`） | 新增 custom transcript item；宿主转换时跳过 `display:false` 项、不透传 `details`。 |
| “会话 idle 时，最后一条 assistant（含 error/aborted）消息提供‘重新生成’操作；点击后 transcript 回退到分支点并流式新回复”（E2，`07-stage3-transcript-actions.md:39`） | reroll 命令在宿主先完成分支、立即带回分支快照；重生成 fire-and-forget，后续使用既有 progress/snapshot。 |
| “编辑层预填原文本（文本块拼接）；提交后消息原更新、不触发重跑”（E3，`07-stage3-transcript-actions.md:40`） | `edit_message` 限定 `entryId/text`，runtime 委托宿主 edit API；无自动 reroll。 |
| “精简投影的节点（kind/摘要/label/时间）按层级缩进展示，当前 leaf 高亮；点击节点跳转”（E4，`07-stage3-transcript-actions.md:41`） | `get_tree` 返回递归投影与 leafId；`navigate_tree` 返回路径切换后的显式快照。 |
| C-协议-item 至 C-协议-navigate（`07-stage3-transcript-actions.md:55-59`） | 下文逐一遵守字段、错误与快照语义；不改变冻结口径。 |
| C-runtime / C-client（`07-stage3-transcript-actions.md:60-61`） | 扩展 server runtime 接口、所有 runtime 实现面与 PiClient/PiSessionHandle。 |
| C-验收①–⑤（`07-stage3-transcript-actions.md:65`） | §11 把协议/桥接可观测结果逐项对齐；真实 TUI + headless browser 由整体验收执行。 |

## 2. 定位

本模块把 `AgentSession` 的 transcript 分支、原位编辑和树导航能力转成 `pi-protocol` 严格 schema，经 `PiServer` 命令分发暴露给客户端；`PiClient`/`PiSessionHandle` 只负责类型安全请求及复用现有 snapshot 接收/状态更新路径，不复制会话状态机。

边界是四个新命令及 custom transcript 投影。web UI 的按钮、树 drawer、卡片排版归 `09-web-frontend-actions.md`；本模块不增加事件类型，也不以新事件替代 result 快照。

## 3. 参数与数据形状

### 3.1 Transcript item

新增 `CustomTranscriptItemSchema = StrictObject({ id: IdSchema, role: Literal("custom"), customType: String({ minLength: 1 }), content: Array(UserContentSchema), timestamp: TimestampSchema })`，并将它加入 `TranscriptItemSchema` 联合。导出 `CustomTranscriptItem` Static type。保持 User/Assistant/Tool 既有 schema 原样。

`UserContentSchema` 只含 text/image（`packages/protocol/src/schemas.ts:75-97`）；`details` 不属于此投影。custom item 在 snapshot transcript 中只代表 web 可见项：宿主遇 `display:false` 时完全不 push；display 为 true 时依契约投影。字符串型宿主内容应映成一个 text block；数组内容按用户内容块投影，具体遇到宿主不支持块的策略需与 session-protocol 转换实现核对，不得把 `details` 混入 item。[推断]

### 3.2 Tree projection（递归）

导出 `SessionTreeNodeProjectionSchema` 与 `SessionTreeNodeProjection`。以 `Type.Cyclic({ SessionTreeNodeProjection: Type.Object(... children: Type.Array(Type.Ref("SessionTreeNodeProjection")) ...) }, "SessionTreeNodeProjection")` 建立自引用，依照同文件 `JsonValueRecursiveSchema` 的 TypeBox 先例（`packages/protocol/src/schemas.ts:10-24`）。字段遵守 C-协议-tree：`id`、`kind`（user/assistant/tool/custom/compaction/branch_summary/other）、custom 专属可选 `customType`、可选 `label`、`summary: string`、`timestamp: TimestampSchema`、递归 `children`。通过 discriminated union 分支或等价 schema 约束 `customType` 仅出现在 kind=custom；字段不得扩展成原始 entry。

`get_tree` 命令 `{command:"get_tree", sessionId}`；result `{command:"get_tree", tree: SessionTreeNodeProjection[], leafId:string}`。

### 3.3 命令与 result

| 命令 | 参数 | Result |
|---|---|---|
| `reroll` | `{ command:"reroll", sessionId }` | `{ command:"reroll", ok:boolean, session:SessionSnapshot }`；`ok:false` 的 session 是当前快照。 |
| `edit_message` | `{ command:"edit_message", sessionId, entryId, text }`，text 非空 | `{ command:"edit_message", session:SessionSnapshot }`；目标不存在/不可编辑抛 `invalid_request`。 |
| `get_tree` | `{ command:"get_tree", sessionId }` | `{ command:"get_tree", tree:SessionTreeNodeProjection[], leafId:string }`。 |
| `navigate_tree` | `{ command:"navigate_tree", sessionId, targetId }` | `{ command:"navigate_tree", cancelled:boolean, editorText?:string, session:SessionSnapshot }`。 |

将四个 Command schema 纳入 `CommandSchema`，四个 result schema 纳入 `CommandResultSchema`，使 `ResultForCommand` 的 `Extract` 自动取到对应类型（现有 `Command` / `ResultForCommand` 结构：`packages/protocol/src/schemas.ts:315-327,371-389`）。Reroll/edit/navigate 的 result 明确含 session；不得依赖 `leaf_changed`/`entry_edited` 事件来更新 client。[C-协议]

### 3.4 Runtime 接口和 Client API

`PiSessionRuntime` 增加：`reroll(): Promise<boolean>`、`editMessage(entryId:string,text:string): Promise<void>`、`getTree(): Promise<{tree:SessionTreeNodeProjection[];leafId:string}>`、`navigateTree(targetId:string): Promise<{cancelled:boolean;editorText?:string}>`。投影类型只从 `@earendil-works/pi-protocol` 导入，server 不得依赖 coding-agent 类型。现有 runtime 共用 Promise/MaybePromise 约定见 `packages/server/src/types.ts:22-25,41-52`。

`PiClient` 增加带 sessionId 的四方法；`PiSessionHandle` 增加同名无 sessionId 版本。要求具体返回值遵照上表：reroll 返回 `{ok, session}` 或 handle 暴露 `Promise<{ok:boolean;session:SessionSnapshot}>`；edit/navigate 返回其 result（不是只丢弃字段的快照），tree 返回 `{tree,leafId}`。所有 `session` result 经既有 `#handleMessage → ClientState.applyResult → #applySessionSnapshot` 再 resolve（`packages/client/src/client.ts:299-324`；SessionHandle 的封装和回调 request 在 `packages/client/src/session-handle.ts:37-45,88-110`）。[推断] 精确 public return type 应以协议 `ResultForCommand` 类型为依据，保持与现有 set/prompt 包装“返回 SessionSnapshot”一致时，必须确保 reroll 的 `ok`、navigate 的 `cancelled/editorText` 没被吞掉；可用交互式返回 object 同时含 result 字段和 session。

## 4. 逐步行为契约

### 4.1 协议 schema

1. 用严格对象定义 custom item、tree projection、四命令与四结果；扩展现有 union，不改变其它已存在 schema。遗漏会使新字段被拒或既有 10 项命令兼容回归（旧 schema 有 `additionalProperties:false`，`packages/protocol/src/schemas.ts:7-8`）。
2. 树节点通过 `Type.Cyclic` + Ref 定义 children，与 `JsonValueSchema` 同构；导出的 Static 类型在协议包集中维护。遗漏 Cyclic/Ref 会令递归 schema 无法正确构建或验证深层节点。
3. Tree kind/customType 做互斥约束，timestamp 复用 TimestampSchema；摘要、label、子数组都保持纯投影。遗漏约束将允许违反冻结结构的数据或把宿主内部 entry 意外暴露出去。

### 4.2 Server command dispatch

`LiveSessionManager.executeCommand` 当前 switch 负责 list/attach/prompt/abort/set 等分发（`packages/server/src/sessions.ts:54-153`）；所有新命令均先 `requireAttached(connection, sessionId)`，不能仅凭任意 sessionId 访问 runtime（既有操作示例 `:123-150`）。

1. **reroll**：确认连接 attach，调用 runtime.reroll；之后取同一次操作完成后的 snapshot，并返回 `{command:"reroll",ok,session}`。`ok:false` 不启动额外动作且 session 为当前快照。此路径必须持有 operationCount，保证断连 dispose 不会与操作竞争；`runOperation` 现有 operationCount 生命周期和自动 broadcast 见 `sessions.ts:245-257`。07 评审裁定 1 已收口时序：runtime 在分支完成后即 fire-and-forget 启动 run，dispatch 在 `await runtime.reroll()` 返回 ok 后取快照——快照反映返回瞬间真实状态（run 可能已启动，phase 可能已为 turn），不要求"run 前"快照；因此可直接沿用 runOperation 形态，仅需把 ok 从 operation 闭包传出（如 dispatch 分支内先声明 `let ok` 再包入 operation）。
2. **edit_message**：attach 校验后以 `runOperation` 风格包住 runtime.editMessage；成功后读取并显式返回 SessionSnapshot。若 `entryId` 不存在或目标类型不支持，由 runtime 抛 `PiServerError("invalid_request",...)`，沿既有 error envelope 返回。遗漏结果 snapshot 会令仅靠 `entry_edited` 刷新的端点陈旧；现有桥接发布列表不含此事件（见 §4.4）。
3. **get_tree**：attach 校验后返回 runtime.getTree() 的投影；读取不改叶子/文本。遗漏 leafId 会让 UI 无法准确高亮 current path。
4. **navigate_tree**：attach 校验后调用 runtime.navigateTree(targetId)，读取路径结果之后的快照并一起返回；取消时仍返回当前快照，不伪造目标路径。遗漏显式快照会令客户端仍显示旧分支，因为路径变化事件不自动转成桥接快照。
5. 所有分支沿用 `executeCommand` 调用方既有错误映射；返回 shape 由 `CommandResultSchema` 验证。遗漏 schema-result 对齐会把有效 host 调用变成协议校验失败。

### 4.3 CodingAgentRuntime

1. **custom_message snapshot**：在 `snapshot()` 遍历 `buildContextEntries()` 时添加 custom_message 分支；先检查 `display`，false 则 continue；true 转换成独立 `role:"custom"` 项，content 符合 UserContentSchema，提供 entry id、customType、解析后的 timestamp；忽略 details。当前 entry loop 只处理 message/compaction/branch_summary（`coding-agent-server.ts:409-434`），因此遗漏此分支正是 web 不可见根因（07:31）。
2. **reroll**：先 `await session.reroll()`，它只在 idle 时成功，并在最后 user 或 `llmRole:"user"` custom_message 位置移动 leaf/恢复 state（`agent-session.ts:3618-3668`）。失败返回 false。成功时在分支完成后立即 `void session.startRerollRun().catch(...)` 启动重生成，不 await 其完成（`rpc-mode.ts:910-928` 先例）；result 快照按 07 评审裁定 1 取启动后的真实状态（phase 可能已为 turn），不追求也不保证"run 前"快照，客户端以既有事件流收敛。
3. **editMessage**：调用 `session.editMessage(entryId,text)`，false 转为 `PiServerError("invalid_request",...)`；返回成功后由命令 dispatch 显式读取 snapshot。AgentSession 原方法原位更新、同步当前路径 agent state、发 `entry_edited`，但不重跑（`agent-session.ts:3817-3838`）。
4. **getTree**：从 `session.sessionManager.getTree()` 与 getLeafId 生成新的纯投影树；不直接返回 SessionTreeNode 或 entry 原对象。`getTree()` 本身建节点、防御性树结构并按时间排序子节点（`session-manager.ts:1458-1500`）；投影仍应逐节点复制白名单字段，避免不受控字段及可变引用外泄。
5. **navigateTree**：调 `session.navigateTree(targetId,{summarize:false})`，返回 `cancelled` 和可选 `editorText`。RPC 注释明确 editorText 是目标为玩家输入项时回填文本（`rpc-mode.ts:968-980`）。随后命令 result 带 snapshot。不得传 label/summarize 参数，因为 web 命令冻结为 targetId 唯一参数。
6. **revision（已按 07 评审裁定 8 修订）**：revision 改为**独立单调计数器**：构造时初始化为 entries 数（`coding-agent-server.ts:395` 现状），此后 `entry_appended` 与 `editMessage` 成功均自增（`this.revision++`），不再直接赋值 `getEntries().length`（`coding-agent-server.ts:594-597` 现状需改）。理由：原位编辑不增 entry 数，同 revision 的迟到旧快照会覆盖已编辑内容（`client/src/state.ts:107-113` 仅拒 `<`；功能本质审计两次指出）。计数器保证任何影响投影的写入都令 revision 前进；navigate/reroll 只改 active leaf 不删 entry，计数器不回退；底层 `getEntries()` 仍返回完整 append log，`getTree()` 对全部 entries 建树（`session-manager.ts:1450-1500`）。
7. **发布事件**：保留现有自动 snapshot 名单；不要把 leaf_changed 或 entry_edited 纳入 `onSessionEvent` publish 列表。现有名单明确列队列、session info、thinking、agent 生命周期、compaction/retry（`coding-agent-server.ts:599-612`），不含两事件。若把它们未经协调加入 publish 可能重复广播、扩大既有事件语义；result snapshot 是本阶段契约的同步保障。

### 4.4 Tree summary 规则复用

TUI `TreeSelectorComponent` 当前摘要展示策略：普通 message 按 user/assistant/toolResult/bashExecution 分角色；custom_message 拼接 text 内容、带 `[customType]: `；compaction/branch_summary 带类型前缀；`extractContent` 只取文本块、截 200 字符，`normalize` 将换行/tab 变空格并 trim；error text 截 80（`tree-selector.ts:776-857,884-899`）。实际展示函数还依赖主题、ANSI、toolCallMap/路径处理与交互组件（imports `@earendil-works/pi-tui`、theme、其他 TUI 组件：`tree-selector.ts:1-18`），不适合从服务端 runtime import 整个 selector；那会把 server 展示/交互依赖拉入宿主 bridge。

建议把“每种 entry 变成纯文本摘要 + normalize + 截断”的无副作用部分提炼为 coding-agent 内部不依赖 pi-tui 的共享 helper，供 TreeSelector 和 CodingAgentRuntime 一起调用；在 tree-selector 中继续负责颜色/选中态/ANSI，与 helper 输出拼合。若暂时不能提炼，则宿主实现只复制纯摘要规则并加等价测试、明确将重复规则作为维护风险；优先共享 helper 避免双份规则漂移。摘要长度冻结项只规定由实现文档定；采用与 TUI `extractContent(...).slice(0,200)` 对齐的 200 字符上限可最大限度维持语义，但复用应先确认 Unicode slice 按 UTF-16 code unit 的既有结果可接受。[推断]

投影 `summary` 仅为节点预览，不携带 markdown/html。各类未在 TUI 摘要明确支持的 entry type 映射 kind=`other`；summary 用短类型提示，不将完整原始 entry JSON 送客户端。[推断]

### 4.5 Client snapshot 回接

PiClient 的响应处理先校验 pending command 名，再 `applyResult`，之后 resolve（`client.ts:305-324`）；SessionHandle 的 `#request` 已统一走 callbacks request（`session-handle.ts:88-110`）。扩展 Client 方法沿 `listModels` 与现有 request 模式（`client.ts:138-144`），handle 方法沿 `setModel/setThinking` 形状（`session-handle.ts:100-106`）。

1. 四个 PiClient 方法构造精确命令对象；handle 方法使用 `this.id` 注入 sessionId。拒绝额外参数/重复实现 raw transport。遗漏 handle 封装会迫使 web 使用内部 private request。
2. 收到含 session 的 result 后，ClientState 在 resolve 前接收快照；Promise 返回结果也保留 `ok/cancelled/editorText` 这些命令字段。遗漏状态先行应用会令同步订阅 UI 在 Promise resolve 时仍旧快照。
3. Tree result 无 session snapshot，不调用 snapshot 接收路径；调用者显式请求刷新 tree，不缓存一份绕过 revision 的隐式树状态。[推断]
4. edit 成功后 runtime 自增 revision（07 评审裁定 8），result snapshot 的 revision 严格大于编辑前；ClientState 的 `<` 拒绝规则天然接受新快照并挡住迟到的编辑前广播（`client/src/state.ts:107-113`）。不为此另造编辑冲突协议（功能本质审计"无道理复杂度"第 4 项）。

## 5. 文件与副作用

| 文件 | 设计改动 | 副作用 / 边界 |
|---|---|---|
| `packages/protocol/src/schemas.ts` | custom item、递归 tree projection、4 commands/4 results、union/type 导出 | protocol wire surface 增量；不增加事件与运行时依赖。现有 schema 集中在 Transcript 联合 `:120-201`、命令 `:291-327`、result `:330-389`。 |
| `packages/server/src/types.ts` | 导入 projection 类型；PiSessionRuntime 增4方法 | 接口变为所有 runtime/fake 必须满足；类型仍由 protocol 拥有。 |
| `packages/server/src/sessions.ts` | `executeCommand` 四分支，attach 授权、operation 生命周期、result 快照 | 对 reroll 不能盲用现有 runOperation 自动广播节奏；错误沿 PiServerError envelope。 |
| `packages/coding-agent/src/server/coding-agent-server.ts` | snapshot custom 分支、转换函数、display 过滤；reroll/edit/tree/navigate runtime 方法；摘要投影与revision护栏 | 不发布 leaf_changed/entry_edited；不删除旧树分支；reroll run 异步启动。当前 CodingAgentRuntime 的 snapshot、commands、event handler 在 `:368-487,488-637`。 |
| `packages/client/src/client.ts` | PiClient 四个按 sessionId 操作的 public wrappers | 同步复用 result state apply；不新建缓存/transport。client API 模式 `:138-144`，响应路径 `:299-324`。 |
| `packages/client/src/session-handle.ts` | PiSessionHandle/SessionLease 四方法与 wrappers | handle 保留 session lease 限制与现有 request 私有边界。 |
| `packages/server/src/testing/service.ts` | TestSessionRuntime 补四个接口方法及最小确定行为 | 测试假体只为满足 runtime 合约，不应仿造 coding-agent 分支策略。当前 fake 实现与更新方法在 `:52-171`。 |
| `packages/server/src/executor-runtime.ts` | executor runtime facade 补足四方法 | 它是结构化返回的 PiSessionRuntime（`executor-runtime.ts:468-545`）；executor 协议并无本阶段命令，是否支持这些操作不可假装为真实支持。需与协议契约核对，见 §12。 |
| `packages/server/test/sessions.test.ts` 及 client/protocol 测试 | 覆盖分发与 consumer-visible schema/client 行为 | 更新受影响 runtime fakes；测试路径/既有 assertions 需实施前查全。Server 内直接 `implements PiSessionRuntime` 目前查到 `TestSessionRuntime`、`CodingAgentRuntime`；executor facade 为匿名 structural object（`grep` 现状 inventory）。 |
| `packages/coding-agent/src/core/session-tree-summary.ts`（建议新增纯 helper） | 抽取无 TUI 依赖摘要规则，TreeSelector 与 bridge 共用 | 不新增 package/runtime 依赖；需纳入 coding-agent 内部模块收敛，依赖方向 core/helper → domain types，interactive/server → helper。 |

测试 fake 同步影响是必要的接口迁移：新增强制方法后，`TestSessionRuntime` 与 executor facade 必须编译满足接口；server tests 的自定义 runtime/fake 若有结构对象也需按 TypeScript 编译错误逐一补齐，不能用 optional methods/shim 规避。当前 grep 在 packages 范围内能确认显式 `implements` 仅两处，不能据此宣称所有 structural fakes 已穷尽。

## 6. 错误边界

- session 未 attach：复用 `requireAttached` 的拒绝，不调用 runtime；不会因四个新命令形成 session 授权旁路。
- reroll busy/无用户分支点：runtime 返回 false，result `ok:false` + 当前 snapshot；不能当协议 error，因为契约将这两类明确定义为可读失败结果。runtime phase 非 idle 直接 false（07 C-协议-reroll）。
- edit target 不存在/不可编辑：`PiServerError("invalid_request", message)`。AgentSession 当前 `editMessage` 返回 boolean，false 表示未更新（`agent-session.ts:3823-3825`）；需避免其被当成成功 no-op。
- navigate target 不存在、streaming、summary/cancel 失败：AgentSession 可以 throw（导航 busy/目标检查见 `agent-session.ts:6111-6142`）。冻结契约只指定 runtime 返回形状和取消语义，未明确将异常映射何种协议码；建议对明确不合法 target 映为 `invalid_request`，busy 按现有 busy 错误码；若映射与现有错误分类冲突，需在实现前按现有 PiServerError mapping 核实，不得静默抛成不透明 internal error。[推断]
- custom 转换：`display:false` 过滤；不发送 details。`display` 缺失时究竟默认显示与否须按宿主 CustomMessageEntry 定义验证，不能靠 falsy 猜测；07 只冻结 display false 过滤。[未知，实施前核实]
- Tree 投影对未知 entry kinds 映射 `other`，但 summary 不包括 entry JSON；深度 schema 验证采用 Cyclic 递归，长链序列化/最大帧长度仍继承共同上下文 16MB attach 边界（`01-共同上下文.md:96-97`）。

## 7. 精确代码落点（当前事实）

| 文件:行 | 现状证据 / 目标落点 |
|---|---|
| `packages/protocol/src/schemas.ts:10-24` | `JsonValueRecursiveSchema` 用 `Type.Cyclic`、`Type.Ref`、`Type.Unsafe<Static>`；作为递归树 schema 的同文件先例。 |
| `packages/protocol/src/schemas.ts:120-201` | 当前 Transcript 联合仅 user/assistant/tool；Custom item 在这里定义并入联合。 |
| `packages/protocol/src/schemas.ts:291-327` | 现有 10 个命令 schema 与 Command union；新增四个命令。 |
| `packages/protocol/src/schemas.ts:330-389` | 现有 command result schema/union 与 `ResultForCommand`；新增四个 result。set_model session result 在 `:350-357` 是显式带回快照先例。 |
| `packages/server/src/types.ts:1-12,41-52` | protocol type imports 与 PiSessionRuntime 接口；扩展四方法。 |
| `packages/server/src/sessions.ts:54-153` | `executeCommand` switch 分发；新分支置于同一 switch，复用 attach 检查/operation 生命周期。 |
| `packages/server/src/sessions.ts:245-257` | `runOperation` 负责 operationCount、执行、广播快照；reroll 需对照而非套用，以控制 branch snapshot 顺序。 |
| `packages/server/src/testing/service.ts:52-171` | 现存 fake runtime methods；新增接口必须同步更新。 |
| `packages/server/src/executor-runtime.ts:468-545` | 匿名 runtime facade 的方法对象；新增接口形成同步面，但 executor 侧是否支持具体功能未定。 |
| `packages/coding-agent/src/server/coding-agent-server.ts:368-487` | `CodingAgentRuntime`、snapshot entry loop、现有 prompt/setting 方法；custom 分支和四 runtime methods 落点。 |
| `packages/coding-agent/src/server/coding-agent-server.ts:488-637` | session events 与自动 publishSnapshot 列表；`leaf_changed`/`entry_edited` 保持不纳入。 |
| `packages/coding-agent/src/core/agent-session.ts:3618-3668,3747-3754` | reroll 分支点搜索/restore 与 `startRerollRun`。 |
| `packages/coding-agent/src/core/agent-session.ts:3817-3838` | 原位编辑、失败 bool、entry_edited event；不重跑。 |
| `packages/coding-agent/src/core/agent-session.ts:6111-6142` | navigate API、streaming 限制、target 检查；调用 `{summarize:false}`。 |
| `packages/coding-agent/src/core/session-manager.ts:1450-1500` | 全量 entries append log、完整树建构、排序；支持分支保留与时间树投影。 |
| `packages/coding-agent/src/modes/rpc/rpc-mode.ts:910-928,963-980` | reroll 返回前先 branch，之后启动 run；tree result / navigate editorText 语义先例。 |
| `packages/coding-agent/src/modes/interactive/components/tree-selector.ts:1-18,776-899` | selector 依赖 TUI/theme；摘要文本规则与 200 字符抽取上限。应共享纯规则而不是从 server import UI 类。 |
| `packages/client/src/client.ts:138-144,299-324` | list_models public wrapper 与响应校验→state apply→resolve 快照路径。 |
| `packages/client/src/session-handle.ts:37-45,88-110` | SessionHandle callbacks、请求与既有 session wrappers。 |
| `packages/client/src/state.ts:107-113` | session snapshot revision 只拒绝 `<`，同 revision 会应用。 |

## 8. 与现状差异

1. 协议目前 Transcript 没 custom role、命令 union 仅10项，result 没 reroll/edit/tree/navigate（`schemas.ts:193-197,315-326,371-382`）；阶段三将扩展协议，但不改现有成员。
2. `CodingAgentRuntime.snapshot()` 遍历 entry 只转换 message、compaction、branch_summary（`coding-agent-server.ts:409-434`），custom_message 当前被遗漏；新增 converter 与 display guard。
3. Runtime interface 目前只有 snapshot、phase、prompt/steer/abort、model/thinking、events、dispose（`server/src/types.ts:41-52`）；CodingAgentRuntime 缺少四方法。
4. PiServer command switch 当前处理到 set_thinking（`sessions.ts:54-153`）；新命令需统一鉴权及操作计数。
5. client 当前没有四个方法；但响应 result 已在 resolve 前写入 ClientState，已有快照回接可直接复用（`client.ts:299-324`）。
6. session tree 目前树 API 返回完整宿主 SessionTreeNode，含 entry/label/labelTimestamp（`session-manager.ts:179-187,1458-1500`）；新 wire projection 刻意收窄字段并生成摘要，避免 RPC 式全 entry serialization。
7. AgentSession 已提供 reroll/edit/navigate/getTree 相关原语，但 bridge 尚未暴露；`reroll` 已有同步 branch 与 fire-and-forget 的 RPC 先例，编辑发 `entry_edited`、导航发 leaf changes，而 coding-agent bridge 只发布既有显式事件名单（`rpc-mode.ts:910-928`; `coding-agent-server.ts:599-612`）。新结果需显式带 snapshot。
8. revision 是 entry 数而非 branch path 长度；树导航必须保留所有既有 entries 与 revision 下界，编辑为同 revision snapshot 用现有 `revision < current` 规则正常回接（`coding-agent-server.ts:395,594-597`; `client/src/state.ts:107-113`）。

## 9. 验收测试

| 对齐 07 C-验收 | 本模块观察点 |
|---|---|
| ① custom true/false | 构造包含 display true/false custom_message 的宿主会话；attach snapshot 中 true 变成合法 `CustomTranscriptItem`、带 customType/text/image/timestamp，false 不出现，details 无透传；client 能解码且 web 有类型标签（web 表现归 09 验收）。 |
| ② reroll | idle assistant complete/error/aborted 等分支请求；响应 `ok:true` 时其 session transcript/leaf 对应已回退 user/custom-user 分支且 run 未被 await；随后已有 progress/snapshot 流式新回复；TUI 与 web branch 同步。busy/no point 返回 `ok:false` + 当前快照。 |
| ③ edit | user/custom entry 编辑后 result snapshot 在同 revision 或不减 revision 的条件下替换内容；TUI/web 同步显示新文本；无 prompt/startRerollRun 触发。不存在 id/assistant/tool id 可观察为 invalid_request。 |
| ④ get_tree 与 TUI `/tree` 一致 | 对含分叉、多级节点、custom/compaction/branch summary 的会话核对节点数、层级、leafId、label/timestamp 与摘要规则；协议树只包含白名单投影，不带宿主 entry/details。 |
| ⑤ navigate | 点击目标后 result session 是目标路径、leaf 高亮采用新 leafId；`cancelled:true` 仍为原 snapshot；editorText 仅在宿主返回时保留；旧分支 entry 与 revision 不减少。 |
| ⑥ 阶段二回归 | 阶段二 E2E（模型/思考、markdown、水位、终止态、session follow）原样复跑；协议新增分支不影响旧10命令与结果验证。 |

另设定向协议断言：递归 schema 验证多层 children、非 custom 出现 customType 被拒、customType 空串被拒、additionalProperties 拒绝；各命令/result envelope 验证字段；runtime fakes 同步编译。测试不得只断言 helper 被调用或复制 DTO，而应覆盖消费者可见行为和分支/错误边界。

## 10. 冲突 / 未知 / 待决

1. **executor runtime 能力（已裁定，07 评审裁定 2）**：PiSessionRuntime 扩展为必需接口后，`executor-runtime.ts` 的匿名 facade（`:468-545`）必须实现四方法；底层协议 `packages/protocol/src/executor-schemas.ts:21-28` 只定义 prompt/steer/abort/set_model/set_thinking，没有树/编辑/reroll 命令。裁定：四方法统一显式抛 `PiServerError("invalid_request", "<operation> is not supported by this runtime")`——显式拒绝是合法能力降级（先例 `TuiSessionService.createSession`，`remote-host.ts:122-124`），严禁 no-op 假成功。
2. **reroll 方法职责与结果顺序（已裁定，07 评审裁定 1）**：原时序缝隙已收口：runtime.reroll 内部"分支完成后即 fire-and-forget 启动 run、返回 boolean"；server dispatch 在 await 返回后取快照，快照反映真实状态（run 可能已并发启动、phase 可能已为 turn）。不把 reroll 拆成两段式接口，不要求"run 前"快照。详见 07 C-协议-reroll 修订措辞与本文 §4.2.1/§4.3.2。
3. **revision 的单调具体策略（已裁定，07 评审裁定 8）**：独立单调计数器（初始 = entries 数，append/edit 自增，不直接赋值 length）；navigate/reroll 不删 entry、计数器不回退。原"summary entry 事件顺序"疑虑由计数器语义消除：任何 append 路径（含未来 summary）都自增。
4. **display 默认（已核实，07 评审裁定 7）**：`CustomMessageEntry.display` 在宿主类型中是必填 boolean（`packages/coding-agent/src/core/session-manager.ts:149-159`）；桥接按冻结契约过滤 `display:false`。历史/手工 session 文件违反类型时的容错在实现期按 `sessionEntryToContextMessages` 的 null-content 防御先例（`session-manager.ts:410-417`）对齐，不隐式过滤未知值。[推断]
5. **tree 摘要完整一致性**：TUI `getEntryDisplayText` 对 toolResult 使用 tool call formatter、路径 shorten 和主题颜色；纯 helper抽取范围及避免 TUI 表现变化未知。推荐抽取纯文本摘要核验后共享，服务器不得 import `TreeSelectorComponent` 或 pi-tui。
6. **递归 schema 对 customType 条件**：契约表述要求 customType 仅 kind=custom；实现选择 Type.Union/Cyclic 组合应先在当前 TypeBox 版本做 schema 验证烟测，不能退化成不受条件约束的可选字符串字段。
7. **result API 的客户端便利封装（已裁定，07 C-client）**：`reroll` 返回完整 result `{ok, session}`（ok 与快照都需消费）；`navigateTree` 返回 `{cancelled, editorText?, session}`；`editMessage` 返回 `SessionSnapshot`；`getTree` 返回 `{tree, leafId}`。协议数据不丢失。
8. **错误码映射**：edit 的 invalid_request 已冻结；navigate target/streaming 的现有 AgentSession 抛错到 PiServerError 的分类需要查看 server error mapping 后落定。非冻结错误不虚构成当前既定行为。
