# D3 阶段二：Web 前端设计

> 本文是 `docs/design/remote-web-control/05-web-frontend-v2.md` 的前端模块设计，遵守其冻结契约及 `01-共同上下文.md` 的共同上下文。仅设计，不修改 `src/`。事实依据均附仓库相对路径与行号；推断标 `[推断]`，未决事项列于文末。

## 1. 需求对照

### 1.1 用户原话与效果项

| 原话（逐字摘录） | 效果项 | 本设计响应 |
|---|---|---|
| “那我觉得没必要传slash命令，web反正也无法正常渲染tui的东西，别搞那么复杂。我们直接在web中认真做那个前端，使得前端有这些功能并且足够好用。你去设计一下” （`docs/design/remote-web-control/05-web-frontend-v2.md:7-9`） | E1–E6 | 不透传 slash 命令；把远程操作做成 web 原生控件，并完成会话阅读、流式、长列表与移动操作设计。 |
| “web 端可查看并切换模型（列表来自宿主 `listModels()`）与思考档（off/minimal/low/medium/high/xhigh），切换后 UI 立即反映（`set_model`/`set_thinking` 已返回新快照）。”（`05-web-frontend-v2.md:19-21`） | E1 | 模型面板使用协议扩展假定的 `client.listModels()`；写入通过已有 handle 方法；快照结果立即回接。 |
| “assistant 文本按受限 markdown 子集渲染：代码块（含语言标签）、行内代码、标题、无序/有序列表、粗体/斜体、链接、引用、水平线；纯 DOM 构建，无 innerHTML 拼接，无新运行时依赖。”（同上 `:22-24`） | E2 | 新增自研扫描式 `render/markdown.ts`，覆盖范围与降级规则见 §5。 |
| “user 与 tool 结果中的 image 块直接显示（`data:<mime>;base64,<data>`，数据已 base64）；工具卡片：名称 + 状态、输入 JSON 折叠展示、文本结果折叠展示、一键复制；thinking 折叠块（保留）+ 消息级‘复制原文’。”（同上 `:23-26`） | E2 | user/tool image 使用 data URL；工具调用与结果成为可折叠卡片；assistant 消息提供纯文本复制。 |
| “流式 delta 只重渲染当前 streaming 消息（rAF 节流），不整表重建。”“长会话（≥500 条目）滚动与输入不卡顿：DOM 增量更新、滚动位置语义保持（近底部自动跟随、上翻不打扰）。”（同上 `:27-30`） | E3 | 按 entry key 维持节点缓存、只更新变更 entry / contentIndex；delta 在动画帧合并；禁止虚拟滚动。 |
| “上下文水位显示：以最后一条 assistant `usage.input` 估算当前上下文 tokens，与 `listModels` 返回的 contextSize（若有）换算百分比。”（同上 `:30`） | E3 | 显示 tokens；schema 无 `contextSize`，因此按 C-水位降级、不显示百分比（§8）。 |
| “phase/model/thinking/queued 计数随时反映（快照与 set 命令结果驱动；无新增 live 事件，接受快照粒度）。”（同上 `:31`） | E4 | 状态栏快照更新，模型/档位切换结果按返回快照刷新。 |
| “prompt/steer/abort、断线重连与会话跟随、终止态识别、ES2020/无 WebCrypto/MIUI 兼容、安全 DOM 构建全部保持。”（同上 `:32`） | E5 | 保持现有会话状态机、generation 防串、终止态以及浏览器约束；新增渲染不改变传输或恢复策略。 |
| “Enter 发送 / Shift+Enter 换行（移动端软键盘回车发送）、composer 自适应高度、发送中禁用重复提交、错误内联可重试。”（同上 `:33`） | E6 | composer 与内联重试行为见 §7。 |

### 1.2 冻结契约

- **C-协议**：增加 `list_models` 命令和含 `models: ModelMetadata[]` 的 result，`client.listModels()`；依赖协议扩展落地，不能在本模块捏造本地模型表。详见 `05-web-frontend-v2.md:41-46`。
- **C-渲染**：`render/transcript.ts` 改为按 entry key 增量更新；`applySnapshot` / `applyProgress` 只触碰改变项；assistant delta 以 rAF 合帧。详见 `05-web-frontend-v2.md:44`。
- **C-markdown**：新增无状态 `renderMarkdown(parent, source)`，受限语法、纯 DOM、重渲前清 parent；语言标签展示但无高亮。详见 `05-web-frontend-v2.md:45`。
- **C-面板**：`ui/panel.ts` 移动优先；模型列表取 `client.listModels()`，当前值取 snapshot；写入走 `handle.setModel/setThinking`，返回快照回接；UI 开合不能被快照刷新重置。详见 `05-web-frontend-v2.md:46`。
- **C-水位**：最后 assistant 的 `usage.input`；只有可用 contextSize 才能算百分比，否则只显示 tokens。详见 `05-web-frontend-v2.md:47`。
- 其他保持：ES2020、无 WebCrypto、无新运行时依赖、安全 DOM、prompt/steer/abort、断线重连、跟随切换、终止态。验收范围依据 `05-web-frontend-v2.md:48-50` 与 `01-共同上下文.md:78-97`。

## 2. 一句话定位

`packages/coding-agent/web/remote/` 是移动优先、无框架、vanilla TypeScript 的远程会话 UI；阶段二只把现有纯文本展示升级为可读 markdown、增量消息节点、清晰工具/图片、可操作模型面板和可恢复 composer，不另造协议状态、私有队列或运行时依赖。

## 3. 模块与文件结构

```text
packages/coding-agent/web/remote/
├── index.html                 # 增加模型按钮/面板锚点、水位/回底按钮、错误重试控件属性
├── styles.css                 # transcript/markdown、工具卡片、响应式面板与 composer 样式
├── build.mjs                  # 现有构建脚本；仍打包单一 ES2020 app.js 与 CSS/HTML
└── src/
    ├── app.ts                 # 组装协调；将 snapshot/progress 传入增量 renderer/status/panel
    ├── render/
    │   ├── state.ts           # 保持 snapshot/live 合并 reducer；delta 缓冲保持 contentIndex 粒度
    │   ├── transcript.ts      # 增量 entry Map、节点更新、rAF 队列、滚动跟随与回底提示
    │   ├── markdown.ts        # 新增：纯 DOM 行扫描与行内 token 渲染
    │   └── status.ts          # phase/model/thinking/queued + usage tokens/waterline
    └── ui/
        └── panel.ts           # 新增：模型/思考档面板状态、列表加载、写入与快照回接
```

现状已经有 `index.html` 的 header/status、error、transcript、queue、composer/abort 结构（`packages/coding-agent/web/remote/index.html:13-22`）；样式已有 flex 页面、transcript 滚动、暗色主题与安全区 padding（`styles.css:1-23`）；`app.ts` 负责订阅、状态合并调用、发送、恢复和 controls（`src/app.ts:10-29,80-113,115-152`）。因此保持单页面现有骨架，只在 header 放模型按钮/面板挂载点、transcript 外围挂回底部按钮、error 区增加重试动作；不引入新 app 根或前端框架。

## 4. 逐组件行为契约

### 4.1 应用协调：`src/app.ts`

1. 构造时初始化既有 DOM 节点、`TranscriptState`、状态栏与 transcript renderer；新增 `ModelPanel` 实例并传入现有 client/handle 提供器、snapshot 获取器、当前模型数据。省略 panel 引用会令 E1 无法从会话视图操作模型/档位。
2. `#acceptSnapshot(snapshot)` 继续先检查同会话 revision 不倒退，再调用 state 的 `applySnapshot`；将当前 entries/live、snapshot 和模型元数据送至 `renderTranscript`/`renderStatus`/panel。现状已在 `app.ts:97-103` 做 revision 护栏及渲染调用；新增 renderer 必须保留这一入口，不直接绕过 reducer。
3. `session_progress` 交给 `applyProgress`；`assistant_delta` 注册/更新 live item 后只安排对应 key 的 rAF 更新；item_started/updated/finished 继续从统一 `#onEvent` 路径进入。现有 progress 监听在 `app.ts:105-112`，PiClient progress 是独立事件而非 snapshot（`04-web-client.md:47,59-60`）。省略独立 progress 事件处理会漏掉流式文本。
4. `set_model` / `set_thinking` 完成后调用公共 `#acceptSnapshot(result)`；异常则在面板旁内联呈现并重新读取 handle.snapshot，禁止乐观保留一个未经服务端接受的值。不能仅修改本地选择状态，否则与 TUI 当前状态脱节。
5. snapshot 刷新不得重建 panel 实例/清除其 `open` 状态；只更新控件 value、disabled 状态和当前选项。否则每个 delta/快照都会使用户正在选择的菜单关闭。
6. 保持 generation 机制：异步列表/attach 或面板加载结束时需校验会话 generation，旧 session 的迟到结果不许改新 session。原恢复使用 `#generation` 并在 attach 返回后校验（`src/app.ts:24,55-94`）；不保留该保护会产生会话串屏。

### 4.2 增量 transcript：`src/render/transcript.ts`

**数据缓存**：renderer 实例维护 `Map<string, { el: HTMLElement; lastRevision: number | undefined; lastContent: string }>`；key 是 snapshot entry 的 `item.id`，live key 使用 reducer 已生成的 `live-<time>-<sequence>`。现有 reducer 按 item id 写 entries，live 使用临时 key（`src/render/state.ts:11-18,21-50`）；`04-web-client.md:109-112` 禁止把 live key 当协议 id。

**合并/差异步骤**：
1. 在一次 render 调用开始前，保存 `nearBottom = scrollHeight - scrollTop - clientHeight <= 80px`；80px 既有渲染器阈值（`src/render/transcript.ts:26-27`），升级后维持同一边界。
2. 按顺序合并 `entries` 与 `live` 为目标 key/item 集合。相同 key 有 live 与 entry 时以来源各自唯一、不覆盖的约束处理；空 key/重复 key 视为状态输入错误，不静默覆写。
3. 对目标 key：不存在缓存则创建一个 article 并完整渲染；存在缓存但 item 的 `revision` 或稳定内容快照变化则重建**该 key 的节点子树**（先在 detached element 构建成功后 `replaceWith`）；相同 revision 且内容未变不动 DOM。transcript item 本身无 revision 字段；snapshot revision 由 snapshot 提供，live item 用 `undefined`，其内容签名由角色/状态/内容块字段/工具元数据组成。不要把全 snapshot revision 机械赋给每项并因此全表重画。
4. 当前集合中已无的 key 从 DOM 移除并从 Map 删除；顺序改变时只移动对应现有 element 到目标次序，不能销毁并重建兄弟。除变化项外不得遍历式 rewrite / replaceChildren 全表。
5. 若更新来源是 assistant_delta，先按 messageId 找 live key，再把更新合并到该条目的 contentIndex，标记 key dirty；一个 animation frame 内同 key 多次变化仅保留最终状态、最多重绘该条一次。不同 streaming key 可同帧各更新一次；不调用整表 render。挂起 rAF 时 renderer dispose/clear 应取消帧/清空 dirty key，避免向已换会话节点写入。
6. item_updated/item_finished 和快照更新是完整 item 权威来源，撤销临时拼接结构，重绘对应 entry 一次；下一个 snapshot 以 transcript 为准并清除 live 映射，沿用 `TranscriptState.applySnapshot` 的行为（`src/render/state.ts:11-17`）。省略收敛会造成 delta 临时结构与服务端最终 item 重复或不一致。

**按 contentIndex 更新子块**：每个 entry 的内容容器另存 `Map<number, {el,lastContent}>`，对比 `item.content[index]` 后只重建/删该 index 子块；相邻 thinking、text、toolCall 不被碰触。assistant_delta reducer 已按 messageId/contentIndex 累积片段并改写一个 content 项（`src/render/state.ts:27-40`），实现层按其粒度更新 DOM；流式工具调用 JSON 尚未闭合时显示原始累积文本/输入占位，直到 item_updated/final 结构可解析，不执行 JSON.parse 假设有效。

**工具与消息组件**：
- entry 顶部标注 role/streaming/status；assistant 提供“复制原文”按钮，复制内容由纯文本收集器按原 content 次序抽取，不复制“Thinking”等 UI 标签。使用 `navigator.clipboard` 属于安全上下文依赖，C4 禁止依赖 Clipboard API（`04-web-client.md:179`），故复制走 textarea/select/`document.execCommand("copy")` 兼容路径；失败时显示可手动选中的文本并有内联反馈。[推断]
- assistant thinking 放 `<details><summary>Thinking…</summary>`；redacted 显示其提示但不伪造正文。现有 renderer 已以 details 折叠 thinking（`src/render/transcript.ts:10-15`），不得退化成普通文本。
- toolCall 卡片含工具名、状态色点（running/complete/error）、JSON input 用 `<details>` 折叠、`<pre><code>` 展示 `JSON.stringify(input,null,2)`，并提供复制输入按钮；tool transcript 结果卡含名称/状态、可折叠 text 结果和 image。现状仅渲染工具调用名称+常开的 pre、工具结果状态文字（`src/render/transcript.ts:15-22`），折叠与复制为本阶段增量。
- image content 的 `data` 是 base64，`mimeType` 字段来自 schema（`packages/protocol/src/schemas.ts:84-97`）。仅对协议 image 块创建 `<img src="data:${mimeType};base64,${data}">`；alt 文本标识 MIME。`onerror` 移除/隐藏失败图像并替换为“图片无法显示”占位，避免连续重试。不要把字符串当 HTML。

**性能边界**：≥500 条目的目标是不做虚拟滚动，而是增量 DOM；单条重绘不触碰兄弟。500 entry 节点及其内容渲染、滚动帧率尚无本仓库基准结果；任何此处关于可达到不卡的表述均为 `[推断]`，须由 C-验收⑤的真实浏览器合成会话测量，不宣称已实测。性能超出时先 profile 本路径，不私自加虚拟滚动库（05 非目标）。

**滚动语义**：near-bottom 阈值 80px（含等于）进入跟随态；只有捕捉到更新前在阈值内且该次确有新增 entry / 内容增加时，完成 DOM 更新后 `scrollTop = scrollHeight`。用户上翻超过 80px 后标记不跟随，不因内容变化移动其视口。此时若有新消息/内容到达，显示 transcript 底部浮动“回到底部”按钮；点击滚底并隐藏提示。用户再次滚动回阈值时自动恢复跟随并隐藏按钮。若不是 near-bottom 且无新内容，已有提示不闪烁/重复显示。当前 renderer 以 `<80` 判断并在重建后滚底（`src/render/transcript.ts:26-38`）；新逻辑在不跟随时保留 `scrollTop`，避免全量替换造成阅读位置丢失。

### 4.3 Markdown 解析器：`src/render/markdown.ts`

签名遵守 `renderMarkdown(parent: HTMLElement, source: string): void`（`05-web-frontend-v2.md:45`）。函数开头清空 parent，先分行扫描块结构，再由纯 DOM helper 构造节点。禁止 `innerHTML`、DOMParser、正则替换后插入 HTML、新运行时依赖；文本一律 Text node/`textContent`。HTML 实体如 `&lt;script&gt;` 保持文字字符，不主动 decode；浏览器 text node 自然转义。

**块解析规则**：扫描源字符串的行数组及块起止行。``` 开头识别 fence，可有紧邻的语言标签（仅 `[A-Za-z0-9_+.-]+` 接受为展示标签）；代码内容全部 text node，不解析 inline markdown，关闭 fence 行不进入代码。开放 fence 持续到下一条独立的 ``` fence（闭合标志）；未闭合时仍把已收到的整段 fence 内容作为 code 渲染。增量渲染期间一旦出现关闭 fence，下一次解析扫描整条消息：此前 fence 内容仍为 code，闭合 fence 后续行回到块解析，不能把整条消息锁在 code 模式或把围栏下内容解析成 html。空白分隔的段落合并连续普通行，段内换行显示为换行；标题 `#` 至 `######` 识别；列表支持 `-`/`*`/`+` 与 `1.`/`1)`，一级内可嵌套一层；引用 `>`；HR 只识别独立 `---`/`***`/`___` 行；语法未识别的行逐字 text node 原样呈现。

**行内扫描**：在段落、标题、列表项、引用内对字符串按左到右识别反引号 code span、`**bold**`、`*italic*`、`[label](url)`；用 delimiter 查找与文本节点拆分，不解析 HTML。code span 内容原样 text；bold/italic 内部按纯 text 处理，避免递归滥解析嵌套；link 仅接受 `http:` / `https:` 的绝对 URL（解析后检查 scheme，保留原 label 文本），输出 `<a target="_blank" rel="noopener">`；不合法/相对/其它 scheme 的整个 markdown link 原文作为 text node。未闭合 delimiter 与不支持语法均按原文 text node 呈现，不丢字符。[推断] 行扫描算法 O(n)（每行向前扫描一次；内联匹配索引不回退），需要用超长行压力验证。

### 4.4 状态栏：`src/render/status.ts`

`renderStatus(target,snapshot,models)` 更新 phase/model/thinking/queued 与水位；现有状态栏只写 phase、provider/id、queued count（`src/render/status.ts:1-5`）。模型名优先从 `listModels()` 的匹配 metadata `name`，匹配缺失时回退 `provider/id`；thinking 显示 snapshot.thinkingLevel，不从面板临时选择推断。排队计数使用 snapshot.queuedSteerCount，队列正文仍按原有内容展示（现状见 `src/render/status.ts:6-15`）。

在 `snapshot.transcript` 中从末尾查找最后 assistant item 的 `usage.input`，若没有 usage 则状态栏不显示误导的 0 tokens；找到则明确标“上下文约 N tokens”。`usage.input` 字段是非负整数（`packages/protocol/src/schemas.ts:103-118`）。百分比仅当当前 metadata 实际含 `contextSize` 且为正整数才显示 `round(usage.input/contextSize*100)%`；不得 clamp 遮掩超过 context 的情况，可以显示 `>100%`。当前模型 metadata 与 snapshot.model/provider,id 精确匹配。未有 contextSize 时只显示 tokens，见 §8。

### 4.5 模型与 thinking 面板：`src/ui/panel.ts`

**UI 选型**：移动端优先使用 header 模型按钮打开屏幕底部 modal drawer；桌面仍使用同一 drawer 容器，但 CSS 将其约束为 header 下方右对齐下拉层（宽度限于面板，不遮盖整个桌面 transcript）。这是“底部抽屉/桌面下拉”之一致交互：同一面板状态与语义，媒体查询改位置。增加 backdrop、关闭按钮、`Escape` 关闭；触发器 `aria-expanded` 与面板 open 状态同步。选择后关闭；刷新快照不关闭。省略响应式位置会使手机操作不便或桌面面板占据会话内容。

**数据与读取**：
1. UI 选择值唯一权威来源为当前 `SessionSnapshot.model` 与 `.thinkingLevel`；组件打开不重置快照，也不把用户未提交的 hover/聚焦选项视为当前值。
2. 首次打开或显式重试调用 `client.listModels()`；拿到 metadata 后只在 `this.open` 仍为真且会话 generation 相同时绘制列表。05 C-协议列出的 `list_models` command/result 与当前 protocol schema 已存在；当前 client 也已有 public `listModels()`（`packages/protocol/src/schemas.ts:291-292,363-365`; `packages/client/src/client.ts:141-144`），server 分发到 `service.listModels()`（`packages/server/src/sessions.ts:61-63`）。读取失败面板内提供重试，不清除当前 snapshot 选择。
3. 显示 `name`、provider/id 辅助文本；只有 `authenticated` 模型可选（协议字段存在于 `schemas.ts:60-73`）；能力筛选若受当前输入类型约束则只隐藏明确不兼容项，不将模型名解析成能力。[推断] 宿主 `listModels` 返回范围和未认证项可见性需主代理/host 确认。
4. Thinking 仅显示阶段契约六档：`off/minimal/low/medium/high/xhigh`；schema 额外允许 `max`（`packages/protocol/src/schemas.ts:26-35`），但阶段需求明确六档（`05-web-frontend-v2.md:21`），故 UI 不额外添加第七项；若当前 snapshot 为 `max`（未知宿主是否可返回），保留当前值为不可选状态并提示“当前档位 max”，不静默降档。[推断]

**写入与回接**：PiSessionHandle 已封装 `setModel(model: ModelRef): Promise<SessionSnapshot>` 与 `setThinking(thinkingLevel): Promise<SessionSnapshot>`（`packages/client/src/session-handle.ts:28-33,100-106`），因此本前端使用 `await handle.setModel({provider,id})` / `await handle.setThinking(level)`，不走 raw `PiClient.request`。每次操作检查 handle active、最新 snapshot 和 busy 标志；禁用重复写入。成功把返回 snapshot 交 `app.#acceptSnapshot(result)`（与 prompt/abort 的既有 result 回接方式一致，`src/app.ts:115-130`）；失败保留服务端 snapshot 当前值、显示可读错误并重新从 handle.snapshot 刷新。PiClient 对命令结果会先将 `result.session` 送入 ClientState，再 resolve（`packages/client/src/client.ts:294-319`；`packages/client/src/state.ts:77-86`），返回值依然显式回接 UI 以立即同步。

如实现依赖分支最终发现 handle 未封装（与当前源码事实冲突，须先回报并核对 client 更新），raw `PiClient.request` 是 private `#request`，外部不能合法调用（`packages/client/src/client.ts:189-207`）；不能建议调用私有方法。应先扩展公开 handle 封装，由它生成 `{command:"set_model", sessionId:handle.id, model}` / `{command:"set_thinking",sessionId:handle.id,thinkingLevel}`，使结果经 PiClient `#handleMessage` → `ClientState.applyResult` → `#applySessionSnapshot` / listener → app `#acceptSnapshot` 路径回接（`client.ts:269-291,294-319`; `state.ts:77-86,106-113`）。本分支仅作接口缺失时的代码级替代方案，不是当前方案。

### 4.6 Composer 与错误

1. 保持 idle→`handle.prompt`、turn→`handle.steer`，其他非 idle phase 禁止提交；按最新 `handle.snapshot.phase` 判断。既有逻辑已这样做，并发送后清空输入、blur 隐藏软键盘（`src/app.ts:115-123`；命令语义详见 `04-web-client.md:116-121`），阶段二只保持并补充软键盘属性。
2. textarea 设置 `enterkeyhint="send"`；Enter 发送，Shift+Enter 保留换行；发送按钮总可触发提交。现在已有 keydown 处理 Enter 与 Shift+Enter（`src/app.ts:41-43`），但 HTML 未设置 enterkeyhint（`index.html:18-21`）。提交过程中维持 busy 禁止重复提交（`app.ts:117-122,144-150`）。
3. 自适应高度：输入后读取 `scrollHeight`，高度设为 `min(scrollHeight, lineHeight*6 + verticalPadding)`，超出 6 行后 textarea 内部滚动；发送/清空后重算为最小高度。当前 textarea 可手动 resize 且 max-height 35vh（`styles.css:18-20`），改为 `resize:none; max-height` 以 6 行为准，确保小屏不被 35vh 限制到更少行或无限增高。
4. 提交发送后 `blur()` 保持现状；触发软键盘会回收，composer 固定在可视 viewport 底部并保留安全区 padding。现有 app 使用 visualViewport/resize 设置可视高（`app.ts:46-48,52`），CSS 已用 `100vh`+`100dvh` 与 safe-area（`styles.css:4,18`）；依 `04-web-client.md:121,184`，MIUI 真机行为未知，保留 fallback 并实测。
5. 操作错误使用原 `#error` 内联区域，增加“重试”按钮及重试动作闭包（如 retry 上一次发送时保存文本和目标操作）。原错误显示仅设置 textContent、隐藏/显示（`app.ts:142-143`）；不能把失败文本丢掉后重试空输入，也不能自动重发可能已被 host 接收的命令。对于命令返回明确失败，保存本次文本供用户显式点击重试；对于网络断开导致结果不确定的请求，先刷新/重新 attach snapshot，提示“结果未知，请确认会话后再次发送”，不提供可能重复副作用的一键重发。[推断] 区分“明确拒绝”与“连接中断”的结果不确定性，不改变既有协议 exactly-once 限制（`01-共同上下文.md:94-97`）。

## 5. Markdown 语法覆盖表

所有预期节点均通过 `createElement`、`createTextNode`、`textContent` 创建，不得使用 `innerHTML`。下表输出是结构契约；代码块语法 token 不做高亮。

| 输入 | 预期 DOM 结构 | 未闭合/未识别降级 |
|---|---|---|
| `````ts\nconst n = 1;\n``` ``（即三反引号 fence） | `<pre><code data-language="ts">const n = 1;\n</code></pre>`；语言标签以 `<span class="code-language">ts</span>` 显示；实际属性与显示标签不得拼入 HTML | 无语言标签时仍渲染 `<pre><code>`；fence 内容不解析 inline |
| `````\n<script>alert(1)</script>\n````` | code text node 原样显示 `<script>alert(1)</script>`，DOM 中无 script 元素 | 未闭合 fence：从开围栏至当前末尾全作代码；闭合后重新扫描消息，闭合后续行回普通语法 |
| `# 标题` / `###### 六级` | `<h1>标题</h1>` / `<h6>六级</h6>` | 七个以上 `#` 不匹配标题，原文段落文字 |
| `**重点**` / `*强调*` | `<strong>重点</strong>` / `<em>强调</em>` | 未闭合符号原文 text；仅识别成对、非空标记 |
| `` `x < y` `` | `<code>x &lt; y</code>`，内容以 text node | 未闭合反引号原文显示 |
| `[文档](https://example.com/a)` | `<a href="https://example.com/a" target="_blank" rel="noopener">文档</a>` | 相对 URL、`javascript:`、`data:`、其他 scheme 或不完整链接整体原样文本，不生成 anchor |
| `- 一个\n- 两个` | `<ul><li>一个</li><li>两个</li></ul>` | 未识别 marker 文本保留 |
| `1. 一个\n2. 两个`（以及 `1)`） | `<ol><li>一个</li><li>两个</li></ol>` | 编号文本不要求连续则保留为列表序号语义；不支持的列表 marker 原文显示 |
| `- 父项\n  - 子项` | `<ul><li>父项<ul><li>子项</li></ul></li></ul>`，嵌套仅一层 | 第三层及更深缩进作为父级列表项的纯文本，不创建第三层 list |
| `> 引用\n> 第二行` | `<blockquote><p>引用\n第二行</p></blockquote>` | 裸 `>` 渲染空引用段；`>>` 非重复引用语法，按行扫描规则保留内部 `>` 字符 |
| `---` / `***` / `___` | `<hr>` 独立块 | 夹带文字不视为水平线，作为段落原文 |
| `普通一行\n普通二行` | `<p>普通一行\n普通二行</p>` | 按源行保留换行，不合并丢空格 |
| `&lt;img src=x&gt;` | `<p>&lt;img src=x&gt;</p>` 的文本节点（视觉上显示实体字面文本） | 不解码实体、不创建 img |
| `~~删除~~`、表格、HTML、脚注、图片 markdown、嵌套强调等未支持语法 | 原文按文本显示；不创建危险/伪造 DOM | “未识别语法原文呈现”；换行仍按段落保留 |
| `x [bad](javascript:alert(1)) y` | 单一文本序列，链接语法字面呈现 | scheme allowlist 严格 http/https；不输出可点击链接 |

**行块顺序规则**：fence > 标题 > HR > 引用 > 列表 > 段落；围栏开行可有缩进最多 3 空格（超出则普通文本），代码块闭行独占 ```（最多尾部空白）。列表连续同类 marker 合并为一个 list；有序与无序切换即结束当前列表。嵌套只解析一个缩进层并作为上一级 `<li>` 子列表；空白行结束列表。所有块与 inline parser 接收字符串而非 HTML；实体原文不会被解码。上述严格语义是设计约束，具体缩进容忍与浏览器 DOM 属性表现须由实现测试按表冻结。

## 6. 增量渲染状态机

`TranscriptState` 目前以 `entries` / `live` 两张 Map 分别存归档与增量项、`liveIdByMessageId` 映射消息 id，delta 以 `messageId:contentIndex` 聚合（`src/render/state.ts:3-8,21-50`）；snapshot 清空旧 live 缓存并以 transcript 重建 entries（同上 `:11-18`）。阶段二沿用这套权威边界，改 DOM renderer 与 delta 调度，不把 live 项提前伪装成 snapshot entry。

| 当前态 | 输入 | reducer/UI 行为 | 忽略该步后果 |
|---|---|---|---|
| detached/clear | 清除或新 session | cancel rAF；清空 renderer node Map、live delta 缓冲；移除旧节点；清理回底提示 | 旧 session 内容可能残留，迟到帧串入新会话 |
| attached | 新 `SessionSnapshot`，revision ≥ 当前 | state 用 transcript 重建 entries、清空 live；diff key Map：创建/更新/移除受影响节点；status/panel 读快照 | 不按 snapshot 权威覆盖会保留已完成的 stale live 项 |
| attached | 同 session 较旧 revision | 拒绝整快照，UI 不回退 | 旧异步响应覆盖新内容/模型状态（现有 state 已拒绝 revision 倒退：`state.ts:11-17`） |
| attached | `item_started(item)` | 建 live key/item；建一个 entry DOM；assistant 建 messageId 映射 | 流式开始项不可见 |
| attached | `assistant_delta(messageId,index,kind,delta)` | 查 live key；对 `fragments[messageId:index]` 追加；只替换 `content[index]`；key 入 dirty set；请求唯一 rAF | 无法拼完整流、或全表重画导致输入/滚动抖动 |
| delta 已排队 | 同一 rAF 前又收到 delta | 仅聚合数据并重复标 dirty；rAF 回调每 key 最多调用一次 child-index diff | 一帧多次重复布局/绘制 |
| attached | `item_updated` / `item_finished` | 按 item id 查 live key，否则为 assistant messageId 查映射；替换完整 item；该 entry 与其受影响子块更新，最终类型/状态成为权威 | 临时 delta representation 与完成项不收敛 |
| attached | 新归档 key/更新/删除（snapshot diff） | add/rebuild/remove 对应节点；一致内容无需改 DOM；只移动真正顺序变化节点 | 重建 500+ 全列表损耗输入与滚动流畅性 |
| 上翻（不 near-bottom） | 新内容抵达 | 保持 scrollTop；出现“回到底部”按钮 | 用户阅读历史被抢滚 |
| 跟随态（距底≤80px） | 新内容抵达 | 更新后滚到底部并保持 follow | 用户必须手动反复追流 |

伪代码：

```text
applySnapshot(snapshot):
  if same session and snapshot.revision < current.revision: return
  current = snapshot
  entries = Map(snapshot.transcript.map(item => [item.id, item]))
  live.clear(); liveIdByMessageId.clear(); fragments.clear()
  reconcile(entries + live, snapshot.revision)

applyProgress(p):
  if item_started: addLive(newLiveKey(), p.item); reconcileOne(key); return
  if assistant_delta:
    key = liveIdByMessageId.get(p.messageId) ?? createStreamingAssistant(p.messageId)
    fragments[p.messageId, p.contentIndex] += p.delta
    live[key] = copyWithContentIndex(live[key], p.contentIndex, p.kind, fragments[...])
    dirty.add(key); scheduleOneRafIfAbsent()
    return
  key = findLiveKey(p.item.id) ?? (assistant ? liveIdByMessageId.get(p.item.id) : undefined) ?? newLiveKey()
  live[key] = p.item
  reconcileOne(key)                  // authoritative update/finish

rafCallback():
  framePending = false
  before = captureNearBottomAndScrollTop()
  for key of dirty: reconcileContentIndices(key) // no sibling writes
  dirty.clear()
  if before.nearBottom and contentAdded: scrollToBottom()
  else if contentAdded: showBackToBottom()

reconcile(target):
  for key/item of target:
    if no cached node: createAndAppend(key,item)
    else if revision/content changed: buildDetachedEntry(item); cached.el.replaceWith(newEl)
    else leave cached.el untouched
  for cached key absent target: remove el and delete cache
  move only nodes whose desired order differs
```

注：`lastRevision` 对归档条目记录生成该状态的 snapshot revision；同一 revision 时仍比较 item 内容签名以捕获协议 progress/live 更新；live 的 revision 为 undefined。DOM key 必须是 snapshot item.id 或本地 live key，不使用数组序号（插入前项不应使后项全量失效）。

## 7. 交互细节（键盘、软键盘、滚动）

- **键盘**：Enter 发送；Shift+Enter 换行；textarea 的移动端 `enterkeyhint="send"` 让软键盘提供发送语义。忽略 composing 状态下的 Enter，避免输入法确认字符被误提交。[推断] app 当前 keydown 仅判断 Enter/Shift（`src/app.ts:41-43`），需加 `event.isComposing` / keyCode 229 兼容中文输入法。
- **自适应 textarea**：输入时暂时将 height 置 auto 后按 scrollHeight 更新，最多 6 行；超过时内部滚动；不要改其内容值或光标位置。发送成功清空后立即收缩至最小高度。
- **发送软键盘**：send/prompt 成功后现有 `.blur()` 保持（`src/app.ts:120`）；失败不 blur，便于修改；重试按钮显式点击时不自动重新聚焦输入框。
- **移动布局**：沿用 viewport-fit=cover，100vh fallback，visualViewport resize/scroll 同步可视高，以及 safe-area inset（`index.html:4-7`; `app.ts:46-48,52`; `styles.css:4,18`）。MIUI 浏览器具体视觉 viewport 行为未知，按 `04-web-client.md:184` 真机核验。
- **滚动**：只对 transcript viewport 监听 scroll；距底部≤80px 自动标记 follow。跟随时新内容后滚到底；用户上翻时绝不动 scrollTop；新消息抵达显示浮动按钮，用户点击或自行回到底部关闭提示。鼠标滚轮、触屏惯性滚动和键盘 PageUp/Home 同一规则。

## 8. 水位、协议字段与接口依赖

`ModelMetadataSchema` 的字段是 `provider,id,name,api,reasoning,input,contextWindow,maxTokens,cost,supportedThinkingLevels,authenticated`；**没有 `contextSize`**，但有 `contextWindow`（`packages/protocol/src/schemas.ts:60-73`）。05 C-水位明确以 `contextSize` 为分母，缺失时只显示 tokens（`05-web-frontend-v2.md:47`）。因此设计按契约降级显示最后 assistant `usage.input`，不以字段名相近为由假设 `contextWindow === contextSize`，也不提供百分比；将来主代理若要以 `contextWindow` 替代需显式修订 C-水位，不能由前端默改。

`list_models` 的 Command/Result schema 当前存在（`packages/protocol/src/schemas.ts:291-292,315-325,363-382`），client `listModels()` 当前公开（`packages/client/src/client.ts:141-144`），server handler 转发到 `PiServerService.listModels()`（`packages/server/src/sessions.ts:61-63`）。因此本阶段前端接口可直接消费已有 API；05 写作“新增协议扩展”的历史过程与当前源码基线不一致，见 §12。`handle.setModel/setThinking` 已有封装，直接使用其返回快照，见 §4.5。

## 9. 确切代码落点

| 文件 | 改动落点 | 实现约束 |
|---|---|---|
| `packages/coding-agent/web/remote/index.html` | `header` 加模型名按钮与面板容器；transcript 区加回底按钮；error 加重试按钮；textarea 添加 `enterkeyhint="send"` | 保持 HTML 无内联脚本、不嵌入 transcript 内容；现有骨架见 `index.html:13-22` |
| `packages/coding-agent/web/remote/styles.css` | `.markdown` 标题/列表/blockquote/code/link；工具状态色点/details/pre/image/error；panel drawer/backdrop/桌面下拉；回底按钮；6 行 composer | 用 CSS class 组织视觉，避免用户内容通过 selector/HTML 生成；现状全量样式位于 `styles.css:1-23` |
| `packages/coding-agent/web/remote/src/app.ts` | `#acceptSnapshot` 更新 status/panel/renderer；`#onEvent` 调 incremental renderer；构造接 wire；错误重试状态/动作；保留 generation/blur/abort | 当前核心调用位置 `app.ts:32-53,80-113,115-152` |
| `packages/coding-agent/web/remote/src/render/state.ts` | 若 delta 缓冲接口需重构，确保按 messageId+contentIndex 聚合、每项仅复制当前 content array；保持 snapshot 清 live | 当前已有映射与片段聚合 `state.ts:3-19,21-50` |
| `packages/coding-agent/web/remote/src/render/transcript.ts` | 改 `renderTranscript(target,entries,live,revision)` 或 renderer class；Map node cache、entry/article/card/image/details、dirty rAF、滚动管理 | 当前每次创建全新 fragment 并 `replaceChildren` `transcript.ts:26-39`，这段为重写范围 |
| `packages/coding-agent/web/remote/src/render/markdown.ts`（新增） | `renderMarkdown(parent,source)` 块扫描、行内扫描、safe link allowlist | 按 C-markdown 和 §5；不改变协议 item 类型 |
| `packages/coding-agent/web/remote/src/render/status.ts` | renderStatus 增 models 参数和 thinking/usage；renderQueue 继续使用安全 DOM | 当前 status 仅 phase/model/queued，queue image 是占位文本 `status.ts:1-15` |
| `packages/coding-agent/web/remote/src/ui/panel.ts`（新增） | export `ModelPanel`；读取 `client.listModels`；基于 snapshot 控件；handle 方法写入并返回 snapshot callback；开合 state 存实例 | 不在 `app.ts` 复制菜单 DOM，也不由 status renderer 管理交互状态 |
| `packages/coding-agent/web/remote/build.mjs` | 保持入口 `src/main.ts`、`bundle/iife/es2020/minify` 与 HTML/CSS copy；确认新增 import 被 bundle | 现状 esbuild target/输出与 copy 见 `build.mjs:17-21`；无运行时依赖 |

## 10. 与现状差异

1. transcript 当前每次 render 创建所有 article 与 fragment 并 `target.replaceChildren`，距底部 `<80` 时滚底（`src/render/transcript.ts:26-39`）；新设计按 key diff、单消息/内容块更新、非跟随时不移动视口。
2. assistant 文本当前按纯文本块显示，user/tool 图片只显示 `[Image: mimeType]`，tool input 是常开 pre（`src/render/transcript.ts:7-22`）；新增 markdown、data URL image、折叠工具输入/结果、复制按钮和 image failure placeholder。
3. `renderStatus` 现状 phase/model provider/id/queued only，没 thinking/waterline（`src/render/status.ts:3-5`）；新增 thinking 与 last assistant usage tokens；当前 schema 没 contextSize，因此不显示百分比。
4. 现有页面没有面板或模型按钮，只有 Remote session header（`index.html:13-16`）；新增移动底抽屉/桌面下拉与六档选择。handle 的模型/思考写入方法在 client 当前已存在（`session-handle.ts:28-33,100-106`）。现有协议与 PiClient 已含 `list_models`/`listModels()`（`protocol/src/schemas.ts:291-292,363-365`; `client/src/client.ts:141-144`），与 05 中把它记作后续扩展的描述不同。
5. composer 当前 Enter 处理、发送后 blur、busy 控件、错误文本已存在（`app.ts:41-43,115-123,142-150`）；textarea 当前可手动 resize、35vh max 且没有 `enterkeyhint`（`styles.css:18-20`,`index.html:18-21`）。新增 6 行自适应、软键盘 hint、显式安全重试。
6. 现构建脚本已使用 esbuild bundle、IIFE、ES2020、minify 并复制 HTML/CSS（`build.mjs:17-21`）；新增文件会随入口依赖打入 app.js。raw 260KB/gzip 90KB 是 C-预算（`05-web-frontend-v2.md:48`）；本设计没有现有升级构建测量值，不声称达标，需实施构建测量。

## 11. 消费者可见验收（逐条对照 C-验收）

| C-验收项 | 验证步骤 | 消费者可见预期 |
|---|---|---|
| ① markdown + streaming | 启动真实 TUI 分享，浏览器附着；让 assistant 输出标题、行内代码、链接、列表、引用、语言 fence 与较长逐 token 文本；逐帧观察 transcript，另发未闭合 fence 再补闭合内容 | 所有支持语法按 §5 DOM 呈现；脚本/恶意链接只是文本；fence 内仅代码文本且语言标签可见；delta 只更新当前消息、流式连续平滑，完成后快照最终内容一致 |
| ② 模型切换 | 浏览器开模型面板，选另一个可用模型；观察面板选中项与 header/state bar，再在 TUI 检查当前模型；触发一次读取/写入失败 | 返回 snapshot 后 model/name 即时一致，TUI 同步变化；失败时显示错误且当前值回到真实 snapshot，面板仍可重试，开合不因快照丢失 |
| ③ thinking 切换 | 依次切换六档中的一档；观察面板当前选中档与状态栏，再在 TUI 检查 | 状态栏及面板跟随返回 snapshot；无静态本地假成功，写失败恢复当前值并内联提示 |
| ④ 图片会话 | 浏览器打开含 user image 与 tool result image 的既有会话，分别检查正常、损坏/不可载入 data URL | 正常 base64 data URL 渲染为图片；错误图替换为可读占位；页面无 HTML 注入，无将图片内容解释为脚本 |
| ⑤ 500 条目合成会话 | 通过真实 TUI/测试 fixture 准备 ≥500 transcript 条目；滚到底观察流式追加，再滚至中部观察新消息到达；继续输入、滚动、点回到底 | 500 项完整滚动且输入仍响应；仅变更 entry 更新，不整表闪烁；near-bottom 跟随、上翻保持位置并显示回底按钮；点击后抵达最新项。主观“不卡”需记录目标浏览器/设备与实际观察，现状无性能基准，不能仅凭单元测试断言 |
| ⑥ 既有 E2E 回归 | 复跑既有真实 TUI + 无头浏览器 E2E 的 prompt、turn 中 steer、abort、终止态（1001 + `server shutdown`）、TUI `/new`/`resume` 会话跟随；加测 MIUI 软键盘时 textarea 可见及发送后 blur | 旧路径全部不回退；会话切换不串屏，close 终止态不重试；Enter/Shift+Enter 行为与软键盘收起正确。E2E 套件路径和 MIUI 实机版本当前未知，实施时记录具体命令/设备结果。 |

## 12. 冲突、未知与待决

1. **水位字段名不一致**：05 C-水位写 `contextSize`，schema 字段是 `contextWindow` 而无 `contextSize`（`05-web-frontend-v2.md:47`; `protocol/src/schemas.ts:60-73`）。按 C 明确降级为 tokens-only。若产品要求百分比，必须由上位契约确认 `contextWindow` 语义等价后修订，不由模块暗改。
2. **协议扩展描述与现状时间点不同**：共同上下文旧 C4 写协议零改动（`01-共同上下文.md:94`）；05 明确裁定新增 `list_models`（`05-web-frontend-v2.md:37,43`）。当前源码基线已经包含该 command/result、server dispatch、client `listModels()`（`packages/protocol/src/schemas.ts:291-292,363-365`; `packages/server/src/sessions.ts:61-63`; `packages/client/src/client.ts:141-144`）。前端设计按可观察源码直接调用现有 API；实现前仍需确认主代理对协议扩展的工作状态，避免重复修改同一功能。
3. **PiClient public request**：当前 raw request 是类私有 `#request`（`client.ts:189-207`），不可由 UI 直接调用；当前 handle 的两个 set 方法已封装（`session-handle.ts:100-106`），直接调用。若未来源码基线变化为缺失，需要先增加公开 handle 方法后方可落地，不能从 UI 旁路或使用 private API。
4. **模型列表数据可见性**：metadata 有 `authenticated` 与 input/capabilities 字段（`schemas.ts:60-73`）；listModels 返回未认证模型是否应隐藏、具体排序规则未知。本设计建议展示 authenticated 模型，非认证条目只读/隐藏规则需要主代理确认，不得假装其实现已有定论。
5. **“错误重试”与 exactly-once**：明确命令拒绝可以保留原文本供显式重试；连接中断时结果可能未知，自动重发有重复执行风险。依共同契约不承诺 exactly-once（`01-共同上下文.md:94-97`），仅在用户确认 snapshot 后允许显式再次提交；UI 文案与错误分类对接需 E2E 验证。
6. **500 项性能与 MIUI 软键盘**：当前没有本设计范围内的测量结果；都标为未知/验收项，不将架构目标写成已经达成。现有设计文档已指出 MIUI `visualViewport`/安全区支持未知（`04-web-client.md:184`）。
7. **测试组织未知**：当前 remote web 源目录列有 render/status/state/transcript 与入口文件（目录快照见 `packages/coding-agent/web/remote/src/render/`；`04-web-client.md:144-160` 是既有结构），本次只读取源码未发现专项测试文件；新增测试的真实目录、runner 命令需实现期按仓库测试约定确认。

### 评审门补充裁定（2026-10-08，共同设计 owner，采纳独立审计 EssenceAuditV2）

1. **thinking 档按模型过滤**（审计 a 风险面采纳项）：面板 thinking 选项按当前所选模型的 `supportedThinkingLevels` 过滤（字段见 `protocol/src/schemas.ts:60-73`；存在且非空时生效）；当前 snapshot 档位不在支持列表时显示当前值并标注"当前模型不支持此档位"，不静默降档。
2. **live 完成项的过渡语义确认**：`item_finished` 的 live 项保留至下一 snapshot 收敛（`applySnapshot` 清 live 重建 entries），过渡期以 live 显示为权威，不提前删除（删除会在 snapshot 到达前丢内容）；不视为缺陷。
3. **滚动测量读写分离**：§6 伪代码 `rafCallback` 的 `captureNearBottomAndScrollTop()` 已体现"更新前读、更新后只写一次"；实现时禁止在 DOM 写入循环中穿插读 `scrollHeight`。
4. **流式工具 JSON**：streaming 中的 toolCall 输入按原始累积文本显示（§4.2 已冻结），完成后再 `JSON.stringify`——采纳审计"避免每帧重复 stringify"。
5. **写路径单飞**：§4.5 busy 标志即"仅一个写操作在途并禁用控件"，采纳为唯一策略，不加意图编号复杂度。

### 实现差异与验收记录（2026-10-08，交付）

1. **实现方式**：阶段二由主代理直接实现（首轮实现代理产出残次骨架且写入错误根目录，已从第一阶段代理 transcript 恢复基线后重写）。交付文件与 §9 落点一致，另增 `TranscriptRenderer` 的 `stageItem` 公开方法（delta-only 到达时兜底建节点）与 `ModelPanel.setModels`（app 预取列表注入，trigger 首次即显示模型名）。
2. **state reducer**：`applyProgress` 增加返回触达的 live key（§6 状态机的 reconcileOne 输入）；item_finished 保留 live 至快照收敛，按评审裁定 2 执行。
3. **真实 E2E 验收结果**（无头浏览器 × 真实 TUI）：① markdown DOM 全项通过（h2/li×2/行内代码/fence+ts 标签/链接 href/引用/script=0），水位显示 `ctx 4.0k (0%)`；③ thinking low→medium：面板/状态栏/TUI 三侧一致；② 模型 zai/glm-5.3-flash ↔ glm-5.3 往返切换：状态与 trigger 即时更新，切换后 thinking 按新模型 `supportedThinkingLevels` 自动收敛（flash 无 xhigh 档已在列表过滤验证）；⑥ 终止态（1001+server shutdown→"宿主已停止分享"不重试）、/new 会话跟随、prompt 往返（"Say OK"→"OK"）全部通过。最终 bundle：app.js 203,218 B（预算 260KB 内）+ app.css 7,456 B。
4. **未验证项（诚实标注）**：④ 图片渲染（无现成贴图会话，代码路径按 schema `data:<mime>;base64` 实现未经真实数据验证）；⑤ 500 条目性能（无合成会话基准，架构按增量渲染实现，06 §10.6 的 [推断] 维持）；MIUI 真机软键盘行为未实测（桌面无头浏览器验证 enterkeyhint 属性存在）。
