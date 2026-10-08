# Web 前端升级（阶段三）：tree 选择器、reroll、编辑消息、customType

> 本文件是 remote-web-control 第三阶段的需求与契约文档。第一、二阶段（`00`–`06`）仍然有效，本阶段在其上增量修订。阶段二交付记录见 `06-web-frontend.md` §"实现差异与验收记录"。

## 用户原话（2026-10-09，逐字）

> 你现在能不能再去看看那个web能加入什么，比如能不能加入tree选择器 reroll 编辑消息 以及显示customtype 这些

> （范围拍板，ask 应答）四个全做；流程按"设计文档评审后实现"。

## 注释（非原文）

### 背景裁定

- 用户列举四项能力（tree 选择器、reroll、编辑消息、显示 customType），"这些"指这四项；"再去看看能加入什么"授权对可行性做整体评估后再设计。评估结论（2026-10-09 主代理调研）：四项在宿主侧（`AgentSession`/`SessionManager`）API 全部现成，缺口全部在 remote 协议层与 web 前端。
- 范围经 ask 确认：四项全做，按性价比顺序推进（customType → reroll → 编辑 → tree），一轮设计覆盖。

### 宿主侧现状（证据）

| 能力 | 宿主 API | 证据 |
|---|---|---|
| reroll | `session.reroll(): Promise<boolean>`（分支到最后一条 user 消息或 `llmRole:"user"` 的 custom_message，恢复状态）+ `session.startRerollRun()`（重新生成，fire-and-forget） | `packages/coding-agent/src/core/agent-session.ts:3618-3668`、`3752-3754` |
| 编辑消息 | `session.editMessage(entryId, text): boolean`（原地改+重写会话文件+状态重同步+`entry_edited` 事件；仅支持 message 与 custom_message） | `agent-session.ts:3823-3839`、`session-manager.ts:1341-1355` |
| tree 数据 | `sessionManager.getTree(): SessionTreeNode[]`（嵌套 children+label，防御拷贝） | `packages/coding-agent/src/core/session-manager.ts:179-185`、`1463-1496` |
| tree 导航 | `session.navigateTree(targetId, {summarize,label,...}): Promise<{editorText?,cancelled,aborted?,summaryEntry?}>` | `agent-session.ts:6111-6114` |
| custom 消息存储 | `CustomMessageEntry`（`type:"custom_message"`、`customType`、`content`、`display`、`details`），参与 LLM 上下文 | `session-manager.ts:152-157`、`407-424` |
| RPC 方言先例 | `reroll`/`get_tree`/`navigate_tree` 命令在 rpc-mode 已实现，语义可直接参考 | `packages/coding-agent/src/modes/rpc/rpc-mode.ts:910-980` |

### 协议侧缺口（根因）

1. `TranscriptItemSchema` 只有 `user/assistant/tool` 三种角色（`packages/protocol/src/schemas.ts:193-197`）；桥接层 `CodingAgentRuntime.snapshot()` 的 entry 循环只处理 `message/compaction/branch_summary`，`custom_message` **被直接跳过**（`packages/coding-agent/src/server/coding-agent-server.ts:412-434`）——web 端看不到 custom 消息的根因。
2. `CommandSchema` 仅 10 个命令（`schemas.ts:315-326`），无 `reroll/edit_message/get_tree/navigate_tree`。
3. `PiSessionRuntime` 接口（`packages/server/src/types.ts:42-52`）无对应方法。
4. 桥接层事件→快照发布列表（`coding-agent-server.ts:599-612`）不含 `leaf_changed` 与 `entry_edited`：路径变更与编辑的结果**必须由命令 result 显式带回快照**（`set_model` 先例，`schemas.ts:353-357`）。

### 效果清单

1. **E1 customType 显示**：web 端 transcript 中 custom 消息（`display:true`）渲染为独立卡片：`[customType]` 前缀标签 + 正文（custom text 走 markdown 渲染管线（与 assistant 同管线）、image 走既有图片管线；user 消息保持纯文本现状不变）；`display:false` 的不渲染（对齐 TUI）。`llmRole:"user"` 的 custom 消息在 reroll 语义中作为分支点（宿主已支持，`agent-session.ts:3649-3665`）。
2. **E2 reroll**：会话 idle 时，最后一条 assistant（含 error/aborted）消息提供"重新生成"操作；点击后 transcript 回退到分支点并流式新回复；busy 或无可用分支点时操作禁用/报错可读。
3. **E3 编辑消息**：transcript 中 user 与 custom 消息提供"编辑"操作；编辑层预填原文本（content 中 text 块按序以换行拼接，对齐 TUI `interactive-mode.ts:5164-5170` 的 `join("\n")`；提交后宿主将该 entry 的 content 替换为单个 text 块，`session-manager.ts:1341-1355` 语义）；提交后消息原位更新、不触发重跑（对齐 TUI 语义，`interactive-mode.ts:5154-5196`）；不可编辑条目（assistant/tool）不提供入口。
4. **E4 tree 选择器**：web 端可打开树视图：精简投影的节点（kind/摘要/label/时间）按层级缩进展示，当前 leaf 高亮；点击节点跳转（`navigate_tree`，不带 summarize），transcript 全量切换到新路径；树节点提供编辑入口（对齐 TUI tree selector 的 onEdit）。
5. **E5 既有能力不回退**：阶段一/二全部验收项（prompt/steer/abort/终止态/会话跟随/markdown/流式/增量渲染/面板/水位/兼容约束）保持；协议扩展不破坏既有 10 命令。

### 解法清单（拍板）

1. **S1 协议四件套扩展**（`list_models` 先例的模式：protocol schema → server 分发 → client 封装 → runtime 实现）：
   - 新增 `CustomTranscriptItemSchema`（见 C-协议）。
   - 新增命令 `reroll` / `edit_message` / `get_tree` / `navigate_tree` 及 result（见 C-协议）。
2. **S2 树投影在宿主侧生成摘要**：`get_tree` result 的节点带宿主生成的 `summary` 字符串（语义对齐 TUI tree-selector 的节点摘要，`tree-selector.ts:834-924`），前端零解析、不重复实现摘要规则。不照抄 RPC 的全量 entry 序列化（带宽与前端无用字段）。
3. **S3 编辑语义与 TUI 对齐**：只改文本不重跑；"编辑并重发"不做独立协议命令（= 编辑 + reroll 两个既有命令的组合，且仅对"当前路径最后一条 user 消息"有意义，用户可手动两步完成；本轮不自动组合）。
4. **S4 不做**（非目标）：tree 的 summarize/label 编辑（`navigate_tree` 的 label 参数不进 web 命令）、树内节点删除/重排、custom 消息的 `details` 透传（web 无注册渲染器通道，体积不可控）、多选、导出。

### 契约（本阶段冻结）

- **C-协议-item**：`TranscriptItemSchema` 联合增加 `CustomTranscriptItemSchema`：`StrictObject({ id, role: "custom", customType: string(minLength 1), content: UserContentSchema 数组, timestamp })`。`display:false` 的 custom_message **不进 transcript**（桥接层过滤，对齐 TUI）；`details` 不透传。`UserTranscriptItemSchema` 等既有 schema 零改动。
- **C-协议-reroll**：命令 `{command:"reroll", sessionId}`；result `{command:"reroll", ok:boolean, session:SessionSnapshot}`。`ok:false` = 宿主 busy 或无分支点（此时 session 为当前快照）。成功语义：runtime 在 `session.reroll()` 完成分支后即 fire-and-forget 启动 `startRerollRun()`（不 await，`rpc-mode.ts:910-928` 先例），result 返回**分支完成后宿主的最新快照**——快照捕获时重生成可能已并发启动（phase 可能已为 turn），这是真实状态而非错误，客户端以既有 progress/快照事件流收敛（`prompt` 命令同语义先例）。不要求也不保证"run 启动前"的快照。phase 门禁：非 idle 时宿主返回 `ok:false`。
- **C-协议-edit**：命令 `{command:"edit_message", sessionId, entryId, text}`（text 非空字符串）；result `{command:"edit_message", session:SessionSnapshot}`。entryId 不存在或不可编辑（非 message/custom_message）时宿主抛 `invalid_request` 协议错误（走既有 error envelope）。编辑成功后宿主手动发布快照（`entry_edited` 不在桥接层自动发布列表）。
- **C-协议-tree**：命令 `{command:"get_tree", sessionId}`；result `{command:"get_tree", tree:SessionTreeNodeProjection[], leafId:string}`。投影节点 `StrictObject({ id, kind: "user"|"assistant"|"tool"|"custom"|"compaction"|"branch_summary"|"other", customType?:string(仅 kind=custom), label?:string, summary:string, timestamp:TimestampSchema, children:递归数组 })`。摘要生成在宿主 runtime（语义对齐 TUI tree-selector），截断上限由实现文档定。
- **C-协议-navigate**：命令 `{command:"navigate_tree", sessionId, targetId}`；result `{command:"navigate_tree", cancelled:boolean, editorText?:string, session:SessionSnapshot}`。宿主调 `session.navigateTree(targetId, {summarize:false})`；`cancelled:true` 时 session 仍为当前快照。`editorText` 语义对齐 RPC（目标为玩家输入条目时回填输入框，`rpc-mode.ts:968-980` 注释）。
- **C-runtime**：`PiSessionRuntime` 增加 `reroll(): Promise<boolean>`、`editMessage(entryId:string, text:string): Promise<void>`（失败 throw `PiServerError("invalid_request",…)`）、`getTree(): Promise<{tree:SessionTreeNodeProjection[]; leafId:string}>`、`navigateTree(targetId:string): Promise<{cancelled:boolean; editorText?:string}>`。投影类型定义在 protocol 包（Static 导出），server 包不依赖 coding-agent 类型。无对应底层能力的 runtime 实现（如 `executor-runtime.ts` façade）必须显式抛 `PiServerError("invalid_request", …)` 并附可读原因——显式拒绝是合法能力降级（先例：`TuiSessionService.createSession`，`remote-host.ts:122-124`），严禁 no-op 假成功。
- **C-client**：`PiClient` 暴露 `reroll(sessionId)` / `editMessage(sessionId, entryId, text)` / `getTree(sessionId)` / `navigateTree(sessionId, targetId)`；`PiSessionHandle` 提供同款无 sessionId 重载。返回类型裁定：`reroll` 返回完整 result（`{ok, session}`——ok 与快照都需消费）；`navigateTree` 返回 `{cancelled, editorText?, session}`；`editMessage` 返回 `SessionSnapshot`；`getTree` 返回 `{tree, leafId}`。result 中的 `session` 走既有 `#acceptSnapshot` 快照回接路径（`packages/client/src/client.ts:294-319` 先例）。
- **C-前端渲染**：custom 卡片复用既有 markdown/图片渲染管线；`[customType]` 标签视觉区分于 user/assistant（CSS class，无新依赖）。reroll/编辑按钮为消息级 hover 动作（移动端常驻图标）；编辑层复用 composer 的自适应 textarea 交互约束（ES2020/软键盘/enterkeyhint 语义按 06 §7）。
- **C-tree-UI**：树视图为 drawer 形态、移动优先（移动端底部抽屉；桌面侧边或居中抽屉——树是大内容视图，**不强制 06 §4.5 的 header 下拉形态**，该约束仅适用于 ModelPanel 类小面板；ModelPanel 与 06 的历史视觉差异本轮仅记录不修）；节点按 `children` 递归缩进，当前 `leafId` 高亮；点击节点 = navigate + 默认关闭树；树打开期间快照刷新不强制关闭/重建滚动位置（对齐 06 §4.1.5 面板语义）。树内编辑入口仅对**当前路径上**的 user/custom 节点显示（按 id 匹配当前 snapshot.transcript，匹配不到则不显示编辑入口；非当前路径节点先导航再编辑——树投影无 content 全文，不以 summary 冒充预填）。
- **C-预算/兼容**：延续 05 C-预算/C-兼容全部约束（bundle ≤260KB raw、零运行时依赖、ES2020、纯 DOM、无 innerHTML）。
- **C-验收**：真实 TUI + 无头浏览器 E2E：①含 custom 消息（display true/false 各一）的会话在 web 端分别可见/不可见且卡片带类型标签；②reroll 后 transcript 回退并流式新回复、TUI 侧同步在新分支；③编辑 user 消息后 web 与 TUI 显示新文本且不触发生成；④get_tree 返回的树与 TUI `/tree` 一致（节点数/层级/leaf）；⑤navigate 后 transcript 切换路径、leaf 高亮更新；⑥阶段二既有验收项（模型/思考切换、markdown、水位、终止态、会话跟随）全数复跑通过。

### 文档与实现

- 模块设计：`08-protocol-bridge.md`（协议/桥接/宿主/client 四包落点）+ `09-web-frontend-actions.md`（前端四功能交互与状态机）。两文档并行编写，均以本文件契约为准。
- 实现顺序（评审通过后）：协议四件套（主代理直改）→ 桥接实现 → 前端功能（customType → reroll → 编辑 → tree）→ E2E。

### 评审裁定（2026-10-09，契约 owner，设计期收口）

1. **reroll 时序**（收口 08 §10.2）：修订 C-协议-reroll——不追求"run 启动前"快照；runtime 在分支完成后即 fire-and-forget 启动 run，result 快照反映返回瞬间真实状态。理由：run 前快照无消费者（立即被 agent_start 快照覆盖），prompt 已是同语义，且避免把 reroll 拆成两段式 runtime 接口。
2. **executor façade**（收口 08 §10.1）：显式抛 `invalid_request` + 可读原因是合法降级（createSession 先例），禁止 no-op。接口保持必需方法。
3. **custom 渲染管线**（收口 09 §10.3）：custom text 走 markdown（同 assistant），user 保持纯文本。E1 措辞已修订。
4. **编辑拼接分隔符**（收口 09 §10.2）：换行拼接（TUI `join("\n")` 对齐），已写入 E3。
5. **树内编辑边界**（收口 09 §10.4）：仅当前路径节点可编辑；非当前路径先导航。避免为预填全文扩大树投影。
6. **TreePanel 形态**（收口 09 §10.8）：树为抽屉形态，不受 06 §4.5 header 下拉约束；ModelPanel 历史差异仅记录。
7. **display 字段**（收口 08 §10.4）：`CustomMessageEntry.display` 为必填 boolean（`session-manager.ts:158`），桥接按 `=== false` 过滤，无默认值歧义。
8. **edit 的 revision 自增**（采纳功能本质审计）：原位编辑不增 `getEntries().length`，同 revision 的迟到旧快照可能覆盖已编辑内容（`client/src/state.ts` 仅拒 `<`）。裁定：`CodingAgentRuntime` 的 revision 改为**独立单调计数器**——初始化为 entries 数，`entry_appended` 与编辑成功均自增（不再直接赋值 length）；reroll 分支若有新 entry 也自增。保证任何影响投影的写入都令 revision 可观察前进。
9. **树刷新策略**（采纳功能本质审计 + 主代理复核）：树不常驻事件流；drawer 打开时拉取一次 + 本端 navigate/reroll 成功后自动刷新 + 手动刷新入口；被动快照不自动重拉（流式期 revision 频变，自动重拉是请求风暴）。其他客户端改树的场景由手动刷新覆盖。
10. **树粒度**（采纳功能本质审计）：树节点与 navigate target 粒度 = **session entry id**（与 TUI `/tree`、RPC `get_tree`/`navigate_tree` 一致）；不引入"对话轮"聚合粒度。
11. **编辑含图消息的有意折损提示**（采纳功能本质审计）：编辑将 content 替换为单 text 块是宿主/TUI 既有语义（`session-manager.ts:1341-1355`）；前端编辑层对含 image 块的消息需提示"保存后将丢失图片部分"，不静默折损。

### 评审门结论（2026-10-09）

- **需求审计（一票否决）通过**：原话四项（tree 选择器/reroll/编辑消息/显示 customType）+ 范围拍板（四项全做）在 07 效果清单、08 命令集与桥接、09 前端交互中逐条闭环。
- **功能本质审计（一票否决）通过**：独立审计（EssenceAuditV3，仅效果清单、未见设计）的架构判断与 07/08/09 一致（四命令、result 带快照、snapshot/progress 分工、通用卡片、薄适配复用 AgentSession、不做 CRDT/新事件/远程 renderer 注册）；其指出的 edit revision 竞态、树刷新频率、entry 粒度三点以裁定 8/9/10 收口，编辑多模态提示以裁定 11 收口。审计"无道理复杂度"清单七项均非本设计所含。
- **其余项**：跨文档一致性（08/09 待决节已同步裁定）、契约遵守、行为闭环（file:line 落点）、可实施性、未知/推断诚实标注——主代理核对通过。剩余开放项（08 §10.3 revision 事件顺序、§10.5 摘要 helper 抽取范围、§10.6 递归 schema 烟测、§10.8 错误码映射；09 §10.6 焦点恢复）均为实现期待核实项，不阻断。
- 评审门通过，进入实现（顺序见上文"文档与实现"）。

### 实现期修订（2026-10-09）

1. **leafId 允许空串**（实现期发现）：`getLeafId()` 在空会话时返回 null（无活跃 leaf），协议 `GetTreeResultSchema.leafId` 放宽为 `Type.String()`——空串 = 无活跃 leaf，前端不做高亮；桥接以 `?? ""` 归一。
2. **navigate 的 cancelled 归一**：`AgentSession.navigateTree` 的 `cancelled` 理论上必返 boolean，桥接按 `?? false` 防御。

### 实现与验收记录（2026-10-09，交付）

1. **实现**：协议四件套全量落地——`CustomTranscriptItemSchema`/`SessionTreeNodeProjectionSchema`（TypeBox Cyclic 递归 + custom kind 判别 union）与四命令/result（protocol）；`PiSessionRuntime` 四方法 + `LiveSessionManager` 分发 + `TestSessionRuntime` fake + executor façade 显式 `invalid_request` 降级（server）；`PiClient`/`PiSessionHandle` 四封装（client）；桥接 custom_message 分支（display 过滤）、四方法、revision 单调计数器、`projectTreeNode` 树投影摘要（coding-agent + session-protocol `toProtocolCustomMessage`）。五包编译通过，263 既有测试全绿；递归 schema 烟测（4 层深树/custom 互斥/空串/额外字段拒绝）通过。
2. **前端**：custom 渲染（markdown/图片/[customType] 标签）、reroll/编辑消息级按钮、共享 EditLayer、TreePanel drawer 全部交付（子代理初版 + 主代理修 3 个集成 bug：label 未 append、EditLayer busy 挡 close、TreePanel #load 后按钮停留 disabled）。bundle 215,221 B ≤ 260KB。
3. **真实 E2E**（tmux TUI + 无头浏览器，zai/glm-5.3-flash）：① custom 卡片 `[e2e.visible]` 标签渲染、display:false 不出现；② reroll 回退→流式新回复、TUI 树出现双 assistant 分支、reroll 按钮 idle 门禁正确；③ 编辑预填 `join("\n")`/提交更新/TUI 同步/不触发重跑/成功后关闭；④ 树 8 节点（other×3/custom×2/user/assistant×2）层级缩进、leaf `aria-current` 高亮与 TUI `/tree` 一致；⑤ navigate 切换分支（thinking 变化佐证）、leaf 更新、树保持打开原位刷新；navigate 到 user 节点的 rollback 语义 + editorText 回填 composer 验证正确；⑥ prompt 往返、模型触发器、终止态门禁回归通过。独立 WS 客户端（PiClient 脚本）同步验证了协议层 navigate/get_tree 行为。
4. **未验证项（诚实标注）**：MIUI 真机软键盘行为未实测；编辑含图消息的"丢失图片"提示路径未用真实图片数据走通（代码路径存在）。
