# 阶段三：Web 前端 transcript 操作与树视图设计

> 本文只设计 `packages/coding-agent/web/remote/` 前端，不修改源码。阶段三行为以 `07-stage3-transcript-actions.md` C-* 为冻结契约；本文不得替代或修改协议/宿主契约。现状依据阶段二源码逐段核实，新增文件/代码落点为计划而非现状。

## 1. 需求对照

| 07 原话片段/效果项（逐条） | 本设计响应 |
|---|---|
| “`custom` 消息（`display:true`）渲染为独立卡片：`[customType]` 前缀标签 + 正文（markdown/图片，同 user 消息渲染管线）；`display:false` 的不渲染”——E1，`07-stage3-transcript-actions.md:36-38` | Reducer 接收 custom item 为归档项；卡片以安全 DOM 展示 `[customType]` 和正文；隐藏项由桥接过滤，本前端不补显。custom 文本走 markdown、image 走既有图片 helper。 |
| “会话 idle 时，最后一条 assistant（含 error/aborted）消息提供‘重新生成’操作；点击后 transcript 回退到分支点并流式新回复；busy 或无可用分支点时操作禁用/报错可读。”——E2，`:39` | 每次权威快照/phase 更新后重算候选；只在 idle 且存在最后 assistant 时启用该项 reroll。请求 pending 时单飞禁用；`ok:false` 使用结果快照恢复展示并显示通用可读失败提示，不伪造未定义的宿主错误细节或成功态。 |
| “transcript 中 user 与 custom 消息提供‘编辑’操作；编辑层预填原文本（文本块拼接）；提交后消息原更新、不触发生成”——E3，`:40` | user/custom 卡片有编辑入口；编辑层预填 text parts 按序拼接；textarea 复用 composer 的最多六行自适应、Enter/Shift+Enter 和软键盘语义。只发 `edit_message`，用返回 snapshot 回接，不自动 reroll。 |
| “web 端可打开树视图：精简投影的节点（kind/摘要/label/时间）按层级缩进展示，当前 leaf 高亮；点击节点跳转（`navigate_tree`，不带 summarize），transcript 全量切换到新路径；树节点提供编辑入口”——E4，`:41` | 新 `ui/tree-panel.ts` drawer 递归绘制投影；当前 leaf 高亮；点击导航并回接 session snapshot；user/custom 节点有编辑入口。编辑入口复用同一编辑层，不复制编辑协议逻辑。 |
| “阶段一/二全部验收项（prompt/steer/abort/终止态/会话跟随/markdown/流式/增量渲染/面板/水位/兼容约束）保持”——E5，`:42` | 保留阶段二 reducer、renderer keyed Map、rAF、generation 护栏及原错误重试/滚动行为；UI 控件不得重建 transcript 或破坏 composer/模型面板状态。 |
| reroll、编辑与 tree 的冻结 API 及行为，C-协议-reroll、C-协议-edit、C-协议-tree、C-协议-navigate、C-runtime、C-client，`07:55-63` | 前端仅使用 `PiSessionHandle` 对应公开方法及其 snapshot 返回值；具体签名遵从 07，不在 UI 侧构造私有协议请求。 |
| “custom 卡片复用既有 markdown/图片渲染管线；`[customType]` 标签视觉区分”及“reroll/编辑按钮为消息级 hover 动作（移动端常驻图标）”——C-前端渲染，`07:62` | custom 和操作动作放入既有 entry/article；桌面 hover reveal、触屏常驻，不因鼠标悬停状态影响功能可见性。 |
| “树视图为 drawer/modal（移动优先，同 06 §4.5 面板形态）；…树打开期间快照刷新不强制关闭/重建滚动位置”——C-tree-UI，`07:63` | TreePanel 实例生命周期由 app 持有；refresh 更新现存树 DOM/节点数据，保留开合与滚动位置；默认 navigate 后关闭，作为具体化 C-tree-UI 的默认选择。 |
| “阶段二既有验收项…全数复跑通过”——C-验收⑥，`07:65` | 验收覆盖 custom、reroll、edit、树获取/导航/刷新及阶段二回归；见 §9。 |

## 2. 定位

阶段三前端是在现有 vanilla TS 应用中增加 transcript 项操作、custom 呈现和 session tree drawer；服务端仍是权威状态来源。状态更新仍经过 `TranscriptState` 和 `RemoteApp.#acceptSnapshot`，消息列表仍由 `TranscriptRenderer` keyed Map 局部协调；操作组件只编排公开 handle 调用、加载/禁用/错误状态，不自造会话快照或并行协议状态。

## 3. 参数与数据形状

### 3.1 Transcript 状态与 custom

- `TranscriptState.entries`、`live` 均为 `Map<string, TranscriptItem>`；`applySnapshot` 以快照 transcript 重置 entries 并清掉 live 映射/fragment，`applyProgress` 对 item_started、assistant_delta、完整 progress item 分支处理，返回触及 key（`packages/coding-agent/web/remote/src/render/state.ts:9-25,36-83`）。
- 新增 `CustomTranscriptItem` 遵守 07 C-协议-item：`{id, role:"custom", customType, content:UserContent[], timestamp}`。阶段三前端不另存 display/details；display:false 应已由桥接过滤，详情不透传（`07:55`）。custom 只出现在 snapshot transcript，不假设它是 assistant delta 的 live 角色。[推断]
- `TranscriptRenderer` 接收完整 TranscriptItem 联合；增加角色分支与 `signatureOf` custom 分支。签名至少涵盖 customType 与所有 user content 的类型/文本/图片数据变化，避免相同 id 更新时 stale 节点。内容块 key 仍使用 contentIndex，遵守既有的局部更新模式。
- 编辑文本初始值 = item.content 中 `type:"text"` 的块按原顺序以换行拼接（07 评审裁定 4，对齐 TUI `interactive-mode.ts:5164-5170` 的 `join("\n")`）；图片块不转成伪造文本；提交后宿主将 content 替换为单个 text 块（`session-manager.ts:1341-1355`）。

### 3.2 操作服务

- 应用层操作依赖：当前 `PiSessionHandle`、当前 `SessionSnapshot`、`generation`、`#acceptSnapshot(snapshot)` callback；组件不持有另一份快照副本作为权威值。`RemoteApp` 当前持有这些状态并用 `#acceptSnapshot` 回接 snapshot（`app.ts:24-35,182-195`）。
- API 以 07 C-client 为准：`handle.reroll()`（无 sessionId 重载），`handle.editMessage(entryId,text)`，`handle.getTree()`，`handle.navigateTree(targetId)`；PiClient 对应 sessionId 版本。reroll 返回 `{ok,session}`；tree 读取返回 `{tree,leafId}`；导航返回 `{cancelled,editorText?,session}`；edit 成功结果含 session。运行时签名冻结见 `07:56-61`。
- 入口可用性以最新 snapshot 和连接状态判断：reroll 要求 attached、handle active、snapshot.phase=`idle`、最后一条 assistant 项存在；编辑入口只针对 user/custom。客户端状态之外的宿主竞态由服务端结果处理，不能以浏览器本地预检代替宿主门禁。

### 3.3 Tree 投影

- 树节点严格使用 `SessionTreeNodeProjection`：`id, kind, customType?, label?, summary, timestamp, children[]`；kind/可选字段语义遵守 07 C-协议-tree (`07:58`)。前端不解析 transcript 反推摘要，不复制树结构协议。
- TreePanel 服务接口由 app 提供读取/导航/编辑操作的函数、当前 generation 与 snapshot callback；组件保存 open/busy/当前树滚动状态。树数据与 leafId 是最近一次成功 getTree 返回的只读视图，不写入 TranscriptState。

## 4. 逐步行为契约

### 4.1 Custom reducer 与渲染

1. 收到快照时走现有 `#acceptSnapshot` → `TranscriptState.applySnapshot`；custom 与其他 TranscriptItem 一同按 id 收入 entries。过期 revision 仍拒绝。遗漏这一步会令 custom 快照项绕过已有 revision/会话权威边界，或者旧快照覆盖较新的编辑结果。
2. renderer reconcile 时为 custom 构建独立 `article.entry.custom`。label 以 text node 输出字面 `[${customType}]`，不能将 customType 插入 HTML/CSS；内容按 index 构建。遗漏独立角色样式/标签会使 custom 与 user 无法辨别。
3. custom text 复用 `renderMarkdown`，image 复用 `renderImage`（创建 data URL `<img>` 并处理失败占位）；其它 UserContent 类型按既有安全降级，不猜测类型。user 现状是 textContent 直出，image 仅图片 helper；C-前端渲染对 custom 明确要求 markdown/图片管线，因此不改变 user 的既有渲染语义。遗漏复用会造成内容显示与安全 DOM 能力不一致。
4. signature 变化只更新该条目/受影响内容块，entry Map 与邻居节点保留；rAF dirty queue 继续只用于 assistant_delta。customType 改变也必须使 entry 标签更新。遗漏签名字段会留下旧标签/旧内容，若整表重建则退化阶段二性能及滚动体验。

### 4.2 Reroll

1. 由 `#acceptSnapshot` 及 phase 刷新路径重新定位 snapshot.transcript 中按顺序最后一条 assistant；包含 `error`/`aborted` 状态同样可作为入口。仅该条提供 reroll 控件，其他 assistant 不显示。遗漏定位更新会对过期的 turn 显示可操作按钮。
2. enabled 条件为 attached + active handle + phase idle + 存在候选 + 无同类请求在途。当前 app 的 `#setControls` 以最新 handle snapshot phase 控制已有发送/abort 控件（`app.ts:331-340`）；阶段三把门禁扩展至 reroll，不能误用 composer 在 phase=turn 允许 steer 的规则。遗漏 phase 门禁会与冻结宿主契约不符并造成无效请求。
3. 点击后单飞置 busy、禁用按钮，调用 handle.reroll；异常恢复按钮状态并使用 app 既有错误区域呈现可读错误，禁止自动重试。若异常无法证明宿主未执行，不提示“未执行”或自动再发。遗漏单飞会使双击触发两次分支/生成。
4. result `ok:false` 时仍通过 result.session 调 `#acceptSnapshot`，还原当前服务端 transcript/status，再显示明确“无法重新生成”（可附错误原因若协议结果含有；冻结 result 未规定 error 字段，故不假定可读宿主细节），不显示成功态。遗漏 snapshot 回接会令 UI 停在本地忙态或乐观篡改历史。
5. result `ok:true` 时立即回接分支后 session snapshot，恢复控件；之后既有 progress/session_progress 路径驱动新回复的流式渲染。不能等新生成结束才回接；否则用户看不到分支已切换或流式项。生成仍在运行时 snapshot.phase 会重新禁用 reroll。
6. “最后一条”如存在非 assistant 项尾随时，仍按“最后一条 assistant”而不是简单 transcript 最后一项查找；具体宿主 transcript 是否以 assistant 封尾未知。[推断] 若无 assistant（例如仅 user/custom），不提供入口，点击路径不应构造空 target。

### 4.3 编辑消息层

1. renderer 仅为 user/custom entry 安装消息级编辑动作；桌面 hover 显示、触屏常驻；若操作不可用则 disabled/不展示由 app 控制。assistant/tool 不提供入口。遗漏角色过滤会违反 C-协议-edit 的可编辑边界。
2. 点击时从当前权威 item 生成预填文本，将编辑层显示在 viewport 内；焦点进入 textarea，保留光标可编辑。编辑层为移动优先 modal/drawer，具 close/cancel；开层不更改 transcript item。遗漏预填会导致用户无法基于原内容编辑。
3. textarea 复用 composer 现有 `#autoSize` 的 `scrollHeight`、lineHeight*6 上限（`app.ts:95-99`）和 `MAX_COMPOSER_ROWS=6`（`app.ts:11`），样式继承 `textarea` 样式（`styles.css:63-64`）；Enter 提交、Shift+Enter 换行、`event.isComposing` 时不提交（`app.ts:47-53`）；挂 `enterkeyhint="send"`。发送/取消后关闭层并 blur，软键盘行为遵循 06 §7（`06-web-frontend.md:207-213`）。遗漏自适应/IME 判定会导致小屏遮挡或中文输入法误提交。
4. 空白/仅空白文本不调用命令（协议要求非空 text，`07:57`）；提交期间单飞禁用保存/再次提交。提交仅调用 editMessage，不调用 prompt/reroll；编辑成功接收 result.session → `#acceptSnapshot`，之后关闭编辑层并展示最新快照。遗漏 snapshot 回接会使变更与 TUI 不同步；自动触发 reroll 则超出冻结语义。
5. 宿主 `invalid_request`、断连或其他异常以内联错误呈现，编辑文本保留在编辑层供用户决定修正/重试；不自动重发结果未知请求。错误后可用当前 snapshot 重新打开/刷新内容，但不得声称编辑已保存。遗漏错误边界会造成静默丢编辑或重复副作用。
6. 含 image 块的消息打开编辑时显示提示"保存后将丢失图片部分"（07 评审裁定 11）：编辑提交会将 content 替换为单 text 块（宿主/TUI 既有语义，`session-manager.ts:1341-1355`），前端不静默折损多模态内容；用户确认后才可提交。遗漏提示会让用户在不知情下丢失图片。

### 4.4 树 drawer 与导航

1. app 创建并长期持有 TreePanel；树触发器开合行为参照 `ModelPanel`：创建 overlay/sheet、backdrop close、Escape、触发按钮 `aria-expanded` 同步（`ui/panel.ts:44-107`）。drawer 移动优先（移动端底部抽屉；桌面侧边或居中抽屉——07 评审裁定 6：树是大内容视图，不受 06 §4.5 header 下拉形态约束）。缺少独立实例状态会导致 snapshot/progress 刷新关闭树。
2. 首次打开/显式刷新调用 getTree，按 generation 捕获当前 session；成功仅当 generation 仍匹配时更新 tree、leafId 并绘制，失败保留旧树并在 drawer 显示错误/重试。阶段二模型面板对异步读取采用 generation 护栏（`ui/panel.ts:133-153`），忽略护栏会使旧会话树覆盖新会话。
3. 节点递归按 children 原有顺序绘制，嵌套层级通过 `padding-inline-start` / class 缩进；用户输入 label/summary/customType 均作为文本节点。每项呈现 kind、摘要、label（有值时）、时间；custom 节点显示 `[customType]`。不使用 innerHTML。遗漏递归/层级会丢失分支结构，innerHTML 则破坏既有安全边界。
4. 与 leafId 相同 id 的节点添加当前 leaf class/可访问状态（例如 `aria-current="true"`）；快照或刷新后依据服务端返回 leafId 更新，不从当前可见 transcript 猜测。遗漏高亮更新会令用户误判当前所在分支。
5. 点击节点发 navigateTree(targetId)，不传 summarize/label。导航 pending 时防重复并保留 drawer；result `cancelled:true` 时回接 result.session（协议规定仍是当前快照），保持或恢复原 leaf；成功则回接新 session，按 07 默认关闭 drawer。若 `editorText` 存在，按 C-协议-navigate 语义回填 composer；不要在编辑层里替换会话正文。遗漏回接会令 transcript、leaf 与 TUI 路径分离；错误关闭/清除编辑器会丢失用户输入。
6. 导航/编辑树节点均只对 user/custom 类型显示编辑入口，复用 §4.3 的同一编辑层与 `edit_message`。树投影节点没有 content 文本，打开编辑时须以当前 transcript item id 查找当前 snapshot.transcript 并拼接 text blocks；找不到则显示“该消息不在当前路径/不可编辑”并刷新 tree，不得以 summary 冒充原文。[推断] 投影未指定消息角色 id 与当前路径关系，采用当前 snapshot 查找是最小可行映射；若服务器树包含非当前路径 user/custom 节点，编辑是否要允许尚待确认，见 §10。
7. 树刷新策略（07 评审裁定 9）：drawer 打开时拉取一次；本端 navigate/reroll 成功后自动刷新一次；提供手动刷新入口。**被动快照不自动重拉树**——流式期间 revision 频繁变化，自动重拉是请求风暴；其他客户端改树的场景由手动刷新覆盖。刷新期间不关闭/重建 drawer、不重置树容器 scrollTop；refresh 完成按 id diff/原地更新节点，保留同节点 DOM 与滚动位置；禁用全量 overlay 替换。遗漏会破坏 C-tree-UI 打开期间的阅读/选择位置，或令 leaf 高亮落后于实际路径。

### 4.5 页面交互与并存

- 现有错误展示支持可选重试 closure（`app.ts:309-329`）；reroll/edit/tree 错误均可调用统一 inline error 展示，但不能覆盖已有命令的明确重试意图或自动调用 prompt 重试。
- 操作按钮使用 `<button type="button">`，移动端常驻、桌面 hover 可显；transcript 不因触发编辑/导航而整体重建。调用后入口重新基于最新快照与 phase 刷新。
- 近底自动跟随 ≤80px、上翻保留位置、回底提示维持既有实现；新增 entry action/header/drawer 不应改变 transcript viewport 的 scroll ownership。06 §4.2 与 `TranscriptRenderer` 的 scroll/rAF 机制仍适用（`transcript.ts:12,242-279,376-430`）。

## 5. 文件与副作用

| 路径 | 计划变更 | 副作用/边界 |
|---|---|---|
| `packages/coding-agent/web/remote/src/render/state.ts` | 确认新 item 联合可由现有 Map/reducer 接收；如类型穷举需要，增加 custom 透传，不改 snapshot/live 清理和 delta 聚合行为。 | 纯内存 UI state；不改协议字段或 reducer 权威规则。当前代码仅 role-specific 逻辑在 assistant delta 识别，归档是通用 TranscriptItem Map（`state.ts:9-25,36-83`）。 |
| `.../src/render/transcript.ts` | 增 custom 的签名、卡片 label、custom text markdown/image block；注入操作 callback，并依角色/phase呈现消息按钮；保持条目 Map/contentIndex 更新/rAF。 | 创建纯 DOM；图片为现有 data URL 管线；按钮事件只调用 app 服务。当前 renderer 对 assistant/user/tool 分支显式穷举（`transcript.ts:38-50,152-184,281-317`）。 |
| `.../src/app.ts` | 连接 reroll/edit/tree 方法；提供 handle/snapshot/generation 与 snapshot/error callback；在快照/事件更新后同步按钮可用性与 leaf；组装 EditLayer/TreePanel。 | 仅现有 PiClient connection/session 命令请求；通过 `#acceptSnapshot` 回接。generation 是 `#recover/#attachCurrent` session 护栏（`app.ts:29-35,102-174`），必须复用。 |
| `.../src/ui/tree-panel.ts`（新增） | drawer UI、树递归渲染、refresh/navigate、leaf 高亮及树内编辑入口；维护自身 open/busy/scroll。 | 不自行监听 protocol 原始消息，不独立缓存 session authority，不生成摘要。依赖接口以 07 C-client 为准。 |
| `.../src/ui/edit-layer.ts`（建议新增） | 复用编辑逻辑：文本提取、textarea、提交/取消、错误与 pending。 | 轻量 DOM 组件，无依赖；多个入口共享避免 transcript 与树产生两种编辑语义。[推断] 若项目实现更适合 RemoteApp 内一个编辑实例，也可不单独成文件，但只允许一套实现。 |
| `packages/coding-agent/web/remote/index.html`、`styles.css` | 增 tree trigger/drawer mount 或由组件动态创建；新增 `.entry.custom`、customType 标签、操作按钮、编辑层、tree list/leaf/indent 样式。 | DOM 构建仍全程安全；不新增运行时依赖/innerHTML。现有页面骨架包括 header、error、transcript、queue、composer（`index.html:13-27`），CSS 已有 mobile panel overlay 形态（`styles.css:75-91`）。 |

## 6. 错误边界

- **busy/无 reroll 点**：按钮 disabled；如 snapshot 刚变导致请求端拒绝，按正常错误路径展示；`ok:false` 是业务拒绝而非异常，仍消费 session 快照。协议未规定失败原因字段，不推造错误消息字段。
- **edit_message 错误**：invalid_request 显示可读协议错误；编辑层保留文本；避免调用成功回调。网络错误不能断言服务端未提交，不自动 retry。
- **get_tree 失败**：树已有数据则保持旧数据显示并提示刷新失败；首次获取失败保持空态及重试入口。过期 generation 响应丢弃，不能关闭当前会话 drawer。
- **navigate_tree cancelled**：不把它当异常；以返回 session 为权威并同步 leaf/tree。navigate 异常保留当前 snapshot / tree / drawer，并显示错误。
- **snapshot 逆序**：`#acceptSnapshot` 当前拒绝同 session revision 倒退，`TranscriptState.applySnapshot` 亦拒绝（`app.ts:182-195`; `state.ts:17-25`）；每个操作结果仍必须走公共回接入口，而非绕开 revision 检查。
- **DOM 数据安全**：customType、label、summary、text、error 都只用 `textContent`/Text node；markdown 用既有 renderer；禁止 `innerHTML`、新依赖及自定义 HTML 解析。

## 7. 精确代码落点（现状事实已读核实）

| 位置 | 已核实现状 | 阶段三设计落点 |
|---|---|---|
| `packages/coding-agent/web/remote/src/render/state.ts:9-25,36-83` | snapshot transcript 通用加入 Map；progress 有 item_started/delta/完整 item 三路径。 | 保持状态流；保证 custom 以扩展联合类型进入 entries，新的 reducer 角色分支不得错误登记为 assistant messageId。 |
| `.../src/render/transcript.ts:38-50,92-109` | signature 对 assistant/user 特殊处理，else 视为 tool；plainTextOf 对非 assistant/user 使用 item.content/tool 形状。 | 为 custom 增显式签名/编辑文本投影分支，避免 fallthrough 将 custom 当 tool。 |
| `.../src/render/transcript.ts:152-184,281-317` | text 仅 assistant 经 Markdown，user 纯文本；image 统一调用 `renderImage`；article 标注 user/assistant/tool。 | 增 custom markdown/text + image 路径、`[customType]` label 和消息动作区域。 |
| `.../src/render/transcript.ts:242-269,272-279,376-430,433-457` | renderer 实例维护 `#cache Map`、dirty Set、rAF、near-bottom 80px、reconcile/key 移动、pending 清理。 | 只扩展 entry 内容与 action，不绕开 renderer；阶段三写操作完成后的快照 reconcile 继续采用这些缓存与滚动规则。 |
| `.../src/app.ts:13-35,36-71` | RemoteApp 当前有 `#state2/#view/#panel/#snapshot/#generation`；构造时挂 transcript/composer 与 ModelPanel。 | 实例化操作组件、把 callback 服务注入 renderer/tree/editor；生命周期与 session 状态同属 RemoteApp。 |
| `.../src/app.ts:102-174,182-223` | recovery/attach 检 generation；snapshot 统一 revision gate + state reducer + view reconcile；session_progress 进 reducer、stageItem/markDirty。 | edit/reroll/navigate 的 session result 统一 `#acceptSnapshot`；组件异步结果比对 generation；custom progress若有只透过 reducer/render现有路径。 |
| `.../src/app.ts:95-99,232-263,309-340` | textarea 按 `scrollHeight`、六行限高；Enter 处理 composition guard；错误区支持可选 retry；controls 随 active/phase 更新。 | 编辑层复用 autosize 与键盘约束；reroll 单独按 idle 门控；错误透过 app 回调呈现。 |
| `.../src/ui/panel.ts:44-117,133-160` | ModelPanel 动态创建 overlay、Escape/backdrop close、open/close/aria-expanded；snapshot sync 不关面板；加载校验 generation。 | TreePanel 复用同一 drawer 生命周期/异步护栏，但单独持有树数据与滚动容器。 |
| `.../index.html:13-27`; `.../styles.css:75-91` | 页面已有模型触发器、transcript 与 composer；已有移动 drawer / 桌面响应式面板规则。 | 新增树入口、操作按钮与 tree/edit 样式，不重置既有视口、viewport-fit、safe-area/软键盘行为。 |

## 8. 与现状差异

1. `TranscriptItem` 渲染还没有 custom：签名函数把非 assistant/user 视作 tool，卡片 label 同样把剩余项当 Tool result（`transcript.ts:38-50,281-310`）；新增 custom 分支并保持 user/tool 现有类型语义。
2. 当前 user 文本非 markdown，图片走统一 `renderImage`；custom 需按 C-前端渲染将 text 送 markdown、image 复用 helper（`transcript.ts:152-184`）。
3. 现有 entry 仅 assistant 有 copy button，无 edit/reroll action；新增两个消息级动作，reroll 只挂最后 assistant，edit 仅 user/custom（`transcript.ts:281-317`）。
4. 现有 RemoteApp 只有 model panel，操作都是 composer prompt/steer/abort；没有编辑层、tree panel 或相关 app 服务接口（`app.ts:13-35,232-273`; `ui/` 目录仅有 `panel.ts`，已读取目录树）。
5. renderer 已有增量 Map、rAF 和滚动跟随，app 已有 generation 护栏及统一快照回接；新功能不重写这些模块架构（`transcript.ts:242-457`; `app.ts:102-223`）。
6. 阶段二 CSS 只有模型 drawer；tree/edit需增加独立 class/结构，但依然遵守纯 DOM 和 ES2020 / 零运行时依赖约束（`styles.css:75-91`; `07:64`）。

## 9. 验收测试（对齐 07 C-验收）

| 07 C-验收 | 场景与断言 |
|---|---|
| ① custom display true/false | 真实 TUI 会话含可显示 custom 与隐藏 custom；浏览器只看到 display:true 独立卡片，标签精确为 `[customType]`，正文 markdown 与图片正确；隐藏项 DOM 中没有卡片；customType/text/image 更新只影响目标节点。 |
| ② reroll + TUI 分支同步 | idle 时最后 assistant 普通/error/aborted 状态分别显示可用操作；执行后 web transcript 回到分支点并展示流式新 assistant，TUI `/tree`/当前路径同步。分别在 phase busy、无 assistant 候选、服务端返回 `ok:false` 时确认 disabled/错误可读、result snapshot 被回接且无假成功。 |
| ③ user 编辑 | 编辑 user 文本块预填；保存后 web 与 TUI 同一原条目显示新文本、revision 更新、没有新的生成/assistant turn；取消不改变 transcript；invalid_request 保留编辑文本并显示错误。custom 编辑重复验证 text blocks 预填、customType 不变及无生成。 |
| ④ get_tree 一致与导航 | 打开 tree，比对节点数/层级/leaf 与 TUI `/tree`；验证缩进、摘要/label/time、自定义节点类型、leaf 高亮；点击不同节点后 transcript 全量路径切换、leaf 更新，取消导航时维持当前路径；树内 user/custom 编辑入口有效，assistant/tool 无入口。 |
| ⑤ snapshot/tree刷新状态 | Tree drawer 打开并滚动到中段时触发 session_progress、快照更新、tree refresh；drawer 保持开启，scrollTop 与可见节点位置不被重置，leaf 高亮按新 leaf 更新；切换 session 后旧 generation 的异步 get_tree/navigate 结果不得改新 session。 |
| ⑥ 阶段二回归 | 复跑 07 所列模型/思考切换、markdown、图片、500 条目水位/滚动、prompt/steer/abort、终止态、会话跟随真实 TUI + 无头浏览器验收；编辑弹层 Enter/Shift+Enter/IME guard、软键盘可见与 blur 在移动浏览器核查。 |

## 10. 冲突 / 未知 / 待决

1. **API/源码到达时间差**：07 冻结的 `CustomTranscriptItem` 与四个 client/runtime 方法是协议/桥接阶段交付目标；本次只核对前端阶段二源码，未据此宣称 client/协议实现已存在。前端实现前应以 08/源码核实最终导出签名，若与 07 C-* 不同需先修订契约，不可在本文件自行改口。
2. **编辑文本拼接边界（已裁定，07 评审裁定 4）**：换行拼接（`join("\n")`，TUI 对齐），已冻结进 07 E3；提交后宿主将 content 替换为单 text 块。
3. **custom Markdown 规则（已裁定，07 评审裁定 3）**：custom text 走 markdown 管线（与 assistant 同），user 保持纯文本不变；07 E1 措辞已修订，无残余语义冲突。
4. **tree 节点的编辑映射（已裁定，07 评审裁定 5）**：仅当前路径上的 user/custom 节点可编辑（按 id 匹配当前 snapshot.transcript，匹配不到则不显示编辑入口）；非当前路径节点先导航再编辑，不以 summary 冒充预填。
5. **reroll 候选与错误原因**：07 指定最后一条 assistant（含 error/aborted），没有定义无 assistant 场景的消息，也未冻结 `ok:false` 的 error 字段；本文在无候选时不提供按钮，在 ok:false 时使用通用可读提示并回接 session，具体措辞取决于 result schema。
6. **关闭编辑层的软键盘语义**：复用 06 §7 composer 的 enterkeyhint/autosize/IME 与发送后 blur；编辑提交后如何将焦点返回原始消息操作按钮未在冻结契约中明确。[推断] 移动端提交/取消关闭时 blur，避免弹层关闭后软键盘残留；具体焦点恢复待交互验收核实。
7. **新增 DOM 容器结构**：`tree-panel.ts` 可以像 `ModelPanel` 一样动态创建 overlay，也可在 HTML 放稳定 mount point；选择不改变 drawer 持久实例和无快照重建语义。具体选型属实现细节，不影响 C-tree-UI。
8. **06 面板视觉契约与阶段二实现差异（已裁定，07 评审裁定 6）**：TreePanel 采用抽屉形态（移动底部/桌面侧边或居中），不受 06 §4.5 header 下拉约束（该约束仅适用 ModelPanel 类小面板）；ModelPanel 与 06 的历史视觉差异本轮仅记录不修，是否回归 header 下拉留待后续独立裁定。
