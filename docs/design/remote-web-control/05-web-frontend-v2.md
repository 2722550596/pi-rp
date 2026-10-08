# Web 前端升级（阶段二）：需求原话与契约

> 本文件是 remote-web-control 第二阶段（前端认真做）的需求与契约文档；第一阶段的 `00-需求原话.md`、`01-共同上下文.md` 及 02/03/04 模块设计仍然有效，本阶段在其上增量修订。

## 用户原话（2026-10-08，逐字）

> /remote 现在是只支持普通输入吗，那些 slash命令是否生效？

> 那我觉得没必要传slash命令，web反正也无法正常渲染tui的东西，别搞那么复杂。我们直接在web中认真做那个前端，使得前端有这些功能并且足够好用。你去设计一下

## 注释（非原文）

### 背景裁定

- slash 命令**不做透传**（用户拍板"没必要传slash命令"）：TUI 本地命令与 web 渲染模型不匹配，透传需要新协议命令且收益低。
- "这些功能"指远程控制的常用能力**原生实现在 web UI**（模型切换、思考档切换等），而非复刻 TUI 命令层。
- "足够好用"是对话体验达标：markdown/图片渲染、流式平滑、长会话性能、工具卡片可读性、移动端操作舒适。

### 效果清单

1. **E1 控制面板**：web 端可查看并切换模型（列表来自宿主 `listModels()`）与思考档（off/minimal/low/medium/high/xhigh），切换后 UI 立即反映（`set_model`/`set_thinking` 已返回新快照）。
2. **E2 对话渲染达标**：
   - assistant 文本按受限 markdown 子集渲染：代码块（含语言标签）、行内代码、标题、无序/有序列表、粗体/斜体、链接、引用、水平线；纯 DOM 构建，无 innerHTML 拼接，无新运行时依赖。
   - user 与 tool 结果中的 image 块直接显示（`data:<mime>;base64,<data>`，数据已 base64）。
   - 工具卡片：名称 + 状态、输入 JSON 折叠展示、文本结果折叠展示、一键复制。
   - thinking 折叠块（保留）+ 消息级"复制原文"。
3. **E3 流式与性能**：
   - 流式 delta 只重渲染当前 streaming 消息（rAF 节流），不整表重建。
   - 长会话（≥500 条目）滚动与输入不卡顿：DOM 增量更新、滚动位置语义保持（近底部自动跟随、上翻不打扰）。
   - 上下文水位显示：以最后一条 assistant `usage.input` 估算当前上下文 tokens，与 `listModels` 返回的 contextSize（若有）换算百分比。
4. **E4 状态栏 live**：phase/model/thinking/queued 计数随时反映（快照与 set 命令结果驱动；无新增 live 事件，接受快照粒度）。
5. **E5 既有能力不回退**：prompt/steer/abort、断线重连与会话跟随、终止态识别、ES2020/无 WebCrypto/MIUI 兼容、安全 DOM 构建全部保持。
6. **E6 交互细节**：Enter 发送 / Shift+Enter 换行（移动端软键盘回车发送）、composer 自适应高度、发送中禁用重复提交、错误内联可重试。

### 解法清单（拍板）

1. **S1 模型列表经最小协议扩展**：新增 `list_models` 命令与 result（`ModelMetadataSchema` 已存在于 `protocol/src/schemas.ts:60`；`PiServerService.listModels()` 已是 service 接口必选项 `packages/server/src/types.ts:57`，`TuiSessionService` 已实现 `remote-host.ts:91-93`）。改动仅四处：protocol schema、server 命令分发、client 封装、（无需动 host）。这是对 01 契约"协议零改动"条款的**显式修订**，本文件即修订记录。
2. **S2 markdown 渲染器自研受限子集**（主代理裁定）：不引入 marked/markdown-it/DOMPurify——bundle 与安全模型（纯 DOM API）均不允许；子集覆盖以 E2 列表为准，未识别语法按纯文本呈现。
3. **S3 不做**（非目标，延续用户"别搞那么复杂"）：slash 透传、reroll、消息编辑重发、多会话管理、参与者名单、主题系统、导出、文件上传、语音、虚拟滚动库。

### 契约（本阶段冻结）

- **C-协议**：`CommandSchema` 增加 `ListModelsCommandSchema`（`{command:"list_models"}`），`CommandResultSchema` 增加 `ListModelsResultSchema`（`{command:"list_models", models: ModelMetadata[]}`）；server 在 hello 后任意时刻可执行、无会话参数；client 暴露 `listModels()`。协议其余 schema 零改动。
- **C-渲染**：`render/transcript.ts` 重写为增量渲染器：按 entry key 维护 DOM 节点映射，`applySnapshot`/`applyProgress` 产生的状态差异只触碰受影响节点；streaming 消息的 delta 更新走 rAF 合帧。
- **C-markdown**：新文件 `render/markdown.ts` 导出 `renderMarkdown(parent: HTMLElement, source: string): void`——受限子集、纯 DOM、无状态、可重复调用（重渲前清空 parent）；语言标签渲染但不做语法高亮。
- **C-面板**：新文件 `ui/panel.ts`：header 下拉/底部抽屉（移动优先）提供模型与思考档选择；数据源 `client.listModels()` + `snapshot.model/thinkingLevel`；写操作走 `handle.setModel/setThinking`（pi-client 若未封装则经 `PiClient.request` 直接发命令，result 快照走既有 `#acceptSnapshot` 路径）。
- **C-水位**：`render/status.ts` 扩展——`usage.input`（最后 assistant 项）为分子；分母取当前模型 contextSize（`ModelMetadataSchema` 若含；否则不显示百分比只显示 tokens）。
- **C-预算**：bundle 总体积 ≤ 260KB raw（当前 185KB + markdown 渲染器 + 面板；gzip 目标 ≤ 90KB）；仍零运行时依赖（workspace 协议包除外）。
- **C-兼容**：ES2020 语法目标、无 WebCrypto/Intl.Segmenter 等新 API；`Promise.withResolvers` 等按既有 ES2020 写法规避。
- **C-验收**：真实 TUI + 无头浏览器 E2E：①markdown 消息（含代码块）渲染正确且流式平滑；②模型切换后面板与状态栏即时更新且 TUI 侧同步；③思考档切换同；④贴图会话图片显示；⑤500 条目合成会话滚动流畅（主观帧率不卡）；⑥既有 E2E（prompt/steer/abort/终止态/会话跟随）全数复跑通过。

### 文档与实现

- 模块设计：`05`（本文件，含契约）+ `06-web-frontend.md`（前端设计，单模块）。
- 实现顺序：协议扩展（主代理直改，四处小编辑）→ 前端重写 → E2E。

### 评审裁定（2026-10-08，共同设计 owner）

1. **水位分母**：`ModelMetadataSchema` 实际字段为 `contextWindow`（`protocol/src/schemas.ts:60-73`），无 `contextSize`。裁定：C-水位中的 `contextSize` 一词修订为 `contextWindow`——语义即上下文窗口容量，百分比 = `usage.input / contextWindow`（不截断，允许 >100% 显示）；无该字段或字段非正时降级只显示 tokens。
2. **模型列表过滤**：面板可选列表仅显示 `authenticated: true` 的条目（选择未认证模型必然失败，无意义）；当前模型若未认证（不在可选列表）仍在状态栏显示其名称，面板内标注"当前模型未认证"。
3. **thinking `max` 档**：schema 七档（`schemas.ts:26-35`），UI 按效果清单提供六档；宿主快照返回 `max` 时按 06 §4.5 的方案显示当前值不降档。
4. **协议扩展状态**：`list_models` 命令/result、server 分发、`client.listModels()` 均已在源码落地（protocol/server/client 三包构建与 72+36 测试绿），06 §12.2 的时间点不一致按此收口。
