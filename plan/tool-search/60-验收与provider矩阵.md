# 60 · 验收与 provider 矩阵

## 1. 一句话定位

M6 把冻结契约变成可执行的验收口径：用 `coding-agent/test/suite/harness.ts` 与 faux provider 驱动端到端请求，用 AI 层既有 deferred wire 测试作 adapter 回归，证明六条不变量、R2 的 12 格、零开销和恢复链路，而不调用真实 API。

## 2. 签名参数

验收 fixture 的最小构造参数是：

```ts
// NEW test helpers（测试侧，不是生产 API）
type ProviderCase = "anthropic" | "openai-responses" | "kimi" | "other";
type ToolState = "undiscovered" | "discovered" | "used";
type WireCapture = { requests: unknown[]; messages: unknown[] };
function makeToolFixture(state: ToolState, provider: ProviderCase, mode?: "on" | "off" | "auto"): {
  harness: Harness;
  capture: WireCapture;
  expectedNames: string[];
};
// NEW（D17）: baseline/new 共用的最终 payload 捕获器。包装 streamFn（harness 以 `streamFn: streamSimple`
// 构造会话，`packages/coding-agent/test/suite/harness.ts:153`），深拷贝每次请求到达 stream 层的完整
// Context（tools/messages/systemPrompt）与 streamOptions；`canonicalize` 按固定规则替换非确定性字段后序列化。
function createPayloadCapture(): {
  captures: WireCapture[];
  streamFn: typeof streamSimple;
  canonicalize(capture: WireCapture): string;
};
```

实际 harness 已提供 `createHarness({ models, tools, settings })`、`harness.setResponses(...)`、`harness.faux`（`packages/coding-agent/test/suite/harness.ts:64-90,102-115,217-220`）；faux registration 通过 `registerFauxProvider`、请求由 `streamSimple` 驱动（同文件 `:11-17,151-156`）。上面的 helper 是测试计划中的命名，不要求生产导出。

## 3. 行为契约逐步（每步写漏了会怎样）

1. 注册 eager 工具、两个 `deferrable` 工具，再按模式计算 active 集；**漏掉未发现过滤会怎样**：第一轮仍发送折叠 schema，R2 与 token 节省失效。
2. 让 faux assistant 先调用 `tool_search`，结果必须带正文目录和 `addedToolNames`；发现状态必须经**完整 transcript** 建立：assistant 的 `toolCall(tool_search)` 与 execute 产生的 toolResult 顺序落账，再由 D1 批次回调（`onToolBatchCompleted`）触发 `discover` 与 active 刷新（M2 §8）；**不得**直接调用 `manager.discover`/改写 manager 内存来伪造发现状态（D15）。工具调用 id 与消息 timestamp 在 fixture 处显式固定（`fauxToolCall(name, args, { id })`、`fauxAssistantMessage(content, { timestamp })`，`packages/ai/src/providers/faux.ts:60-99`）。**漏掉配对会怎样**：下一轮无法知道哪些工具应恢复，R3 失守；绕过 transcript 则 wire 断言验证的是无人会生产的内存状态。
3. 捕获命中后的下一次 provider 请求，验证 provider-specific wire；**漏掉 wire 断言会怎样**：仅测 manager 状态，adapter 组合/缓存标记回归无法发现。
4. 重复发现和实际工具调用；**漏掉已调用状态会怎样**：已调用工具的通道保持断言（D20：deferred 通道持续是正确行为）与历史渲染正确性无法验证，重复注入或历史错配无法发现。
5. 用同一 session 做 compaction、resume，再比较 discovered；**漏掉完整 branch 扫描会怎样**：压缩投影丢 `addedToolNames` 后状态退化（现状依据 `session-manager.ts:443-500,1360-1384`）。
6. 用 deny 工具搜索和调用；**漏掉 deny 闭封断言会怎样**：被禁止工具可能从目录或结果泄漏。

## 4. 文件与副作用

验收测试建议新增 `packages/coding-agent/test/suite/tool-search-acceptance.test.ts`；provider wire 既有回归继续放 `packages/ai/test/deferred-tools.test.ts`。测试只写临时 session 目录（harness 自建并清理），不写真实用户配置、不访问网络。Anthropic 既有转换边界在 `packages/ai/src/api/anthropic-messages.ts:972-1048,1108-1120`，OpenAI 在 `openai-responses.ts:269-288` 与 shared `:326-359`，Kimi 在 `openai-completions.ts:96-113,728-737`。

## 5. 落账

每个测试失败时应保留：captured request、模型 compat flags、active tool names、discovered names。失败输出必须能区分“未进入 active”与“进入 active 但 wire 错”。compaction fixture 同时保存 JSONL entry，验证 `details` 的 discovered 清单及 `addedToolNames`；字段当前确实落盘但 session-format 文档漏列（`00 §3.3`，I1/I2 由 M4 处理）。

## 6. 前端或 RPC 可见性

本模块不增加前端/RPC。验收从 session 对外可观察行为检查：模型看到的 tools、tool_search 正文、tool result、下一轮工具调用及 resume 后可调用性。CLI smoke 只使用 faux provider 或本地已配置 provider；集成测试禁止真实 API（suite README 约束）。

## 7. 错误边界

- 折叠但未发现工具调用：断言返回引导性 tool result，loop 继续；不得把它当异常终止（R8，现状 unknown tool 控制流见 `packages/agent/src/agent-loop.ts:650-659`）。
- 真正未注册工具：仍是原有 `Tool X not found`。
- deny 工具：对搜索目录、匹配结果、active 集合都不可见，不以“搜索无结果”泄漏完整名称。
- provider compat 缺失：走普通 schema；不得假设 server-side tool search 成功。

## 8. 代码落点（精确到文件与函数）

Harness 可行性已经确认：`createHarness` 注册 faux model、注入 auth、构造 Agent/AgentSession（`packages/coding-agent/test/suite/harness.ts:102-156`），`setResponses` 可按 context 动态返回消息（`:80-90,217-220`）。因此能测 coding-agent 层 active/下一轮时序；若要直接断言 Anthropic JSON，应在 AI 层调用既有 `streamAnthropic`/转换测试 fixture，而不是指望 coding-agent faux provider 产生真实 Anthropic wire。

`packages/ai/test/deferred-tools.test.ts` 已是现成模板：定义 payload 类型和抽取 helper（`:1-55`），已有 Anthropic `defer_loading` 与 `tool_reference` 断言（`:192-193,240-250,287-292,327-342`），Kimi 断言（`:345-...`），OpenAI Responses 的 `additional_tools`/search call-output 断言（`:414-418,463-466`）。故 `convertTools` 输出并非未覆盖；新测试应补“客户端未发现工具根本不进入 Context.tools”，而不是复制 adapter 单测。

## 9. 与现状差异

现状是 registry 合并和 allow/deny 过滤后直接形成 active 工具（`agent-session.ts:4084-4157`），`setActiveToolsByName` 下一轮生效并重建 prompt（`:1310-1345`）；现状没有 deferrable 字段（`extensions/types.ts:516-562`）且 wrapper 是白名单转发（`tool-definition-wrapper.ts:5-20`）。新验收因此必须检查字段透传、下一轮而非当前轮生效。现状 extension 工具变化在执行前后产生 `addedToolNames`（`extensions/wrapper.ts:15-46`），但这只适用于 extension wrapper 路径；builtin 的 `tool_search` 没有自动 diff，必须由搜索 execute 手动生成。wrapper 还会在 execute 窗口内 active 集合发生缩减时抑制整批 `addedToolNames`（`wrapper.ts:15-46`），所以验收必须安排 tool_search 刷新在工具批次边界，并断言同批其他 extension 工具的 marker 未被吞掉。本设计必须与既有 marker 共用恢复/adapter 路径，不能创建第二套 marker。

## 10. 验收测试

### 10.1 六条不变量具名清单

定位标注遵循 D19：「现状回归（保持）」= 保护本设计落地后不得退化的既有行为；「新设计目标（新增）」= 本设计引入、现状没有的验收目标。

| 不变量 | 定位 | 测试名 | 关键断言 | 没有该修复时为何必红 |
|---|---|---|---|---|
| R2 12 格映射 | 新设计目标（新增） | `provider matrix: ...`（见 10.2） | 每格 active 与 wire 符合表 | 未实现折叠/provider 分支必出现错误名称或字段 |
| 零开销 | 新设计目标（新增） | `mode off preserves tools request byte-for-byte`、`activated with zero folded tools preserves request byte-for-byte`（两个 case，见 10.3） | 同一输入、新旧序列化 bytes 完全相等（含顺序/缺省字段） | 新增合成工具、类别段或重排 tools 即红 |
| deny 封闭 | 新设计目标（新增）；allow/deny 过滤本身为现状回归（保持，`agent-session.ts:4084-4157`） | `denied tools never enter search catalog or results` | deny 名不在目录、正文、added、下一轮 active | 只在 active 过滤而未过滤搜索目录即红 |
| R3 配对 | 新设计目标（新增） | `search result added names equal new active increment` | `added ⊆ returned ∩ folded`，且增量精确相等 | 只返回正文/只刷新 active 任一半即红 |
| R6 恢复等价 | 新设计目标（新增）；其中 extension `addedToolNames` 通道压缩后退化是现状缺陷 I2，修复属本设计目标 | `resume and post-compaction restore identical discovered set` | branch+details 并集与断开前集合相等 | 仅扫描 context 投影会丢压缩前工具即红 |
| array-first (a) | 新设计目标（新增） | `tool_search schema has no string-array union` | tool_search parameters 中**不存在任何** string\|array Union（`keywords` 是纯 `Type.Array(Type.String())`，设计上没有 Union；见 M1 §3.4） | 旧断言「所有含 array Union 的 `anyOf[0]` 是 array」对本 schema 是恒真空转（vacuous pass），防不住任何回归 |
| array-first (b) | 现状回归（保持） | `native tool schema array union keeps array first` | 既有原生工具（`read.ts:22-25` path）含 array 的 Union 分支首位断言继续通过 | 原生工具 schema 的 array-first 惯例被顺手破坏即红 |

判别性 fixture 要求（收尾补充，各对应一条具名测试；fixture 无判别力则断言空转）：

- R3 配对（`search result added names equal new active increment`）：`limit=1` 截断 fixture——目录 `alpha`、`beta` 同查询双双命中，但 execute 正文与 `addedToolNames` 仅含 `alpha`。
- R6 恢复等价（`resume and post-compaction restore identical discovered set`）：双来源 fixture——压缩前 branch `addedToolNames:["early"]` 与最近 compaction `details` 中的 `["checkpoint"]` 各含独有名称，恢复集合必须为二者并集。
- deny 封闭（`denied tools never enter search catalog or results`）：唯一 token fixture——被 deny 工具的 description/参数描述含唯一 token `credential`，搜索 `credential` 断言目录/结果/added/active 零泄漏。

### 10.2 R2 4×3 矩阵（12 格）

每格都以同一 fixture：`eager_core`、`folded_a`（`deferrable`）、`folded_b`。三状态一律由真实 loop 驱动完整 transcript 建立（D15）：**未发现** = 新会话首个请求，transcript 仅含用户消息；**已发现未调用** = faux assistant response 实际调用 `tool_search`（`fauxToolCall("tool_search", {...}, { id: "call_ts_1" })`），execute 返回带 `addedToolNames:["folded_a"]` 的 result，toolCall/toolResult 顺序落账后由 D1 回调（`onToolBatchCompleted`）完成 discover + active 刷新，捕获**下一次**请求；**已调用** = 后续 faux response 实际调用 `folded_a`，落账后再次捕获请求。禁止任何 `manager.discover` 直调或内存注入捷径。compat flags 在 faux model definition 的 `compat` 上设置（依据 `Model.compat`，`packages/ai/src/types.ts:604-606,626-628,681-686`），不是 settings。编码上合并为 5 个参数化测试（4 provider + OpenAI 双 wire 变体），15 个 `it.each` 行（不是 15 个重复 harness）。广告集只在 foldedNames 非空时包含 tool_search（D13）。

**三组断言约定**：每格验证 active 集合（请求 tools 名单）、历史消息（toolCall/toolResult 经 adapter 转换后的 input/messages 形态）、provider wire（工具定义字段/通道条目）三组。「called」格按 D20 修正后的 R2 表断言**通道保持**：已调用工具继续留在原 deferred 通道（Anthropic `defer_loading`+`tool_reference` 保持、OpenAI 双通道持续、Kimi/Other 普通 schema），这是 #6474 有意的 cache-friendly 设计，pi-rp 此处有意不同于 TanStack（已调用工具的 schema 继续折叠），实现者不得按 TanStack 直觉“修正”为 immediate。

| 格 ID | 具名测试（it.each 行） | active 断言 | 历史消息断言 | provider wire 断言 |
|---|---|---|---|---|
| `R2-ANT-U` | `anthropic matrix: undiscovered folded tool is absent` | 请求 tools 仅 `eager_core`+`tool_search`；`folded_a/b` 不在 | transcript 仅用户消息，无折叠工具条目 | 序列化 tools 中无 `folded_a/b` 的任何字段 |
| `R2-ANT-D` | `anthropic matrix: discovered unused tool is deferred and referenced` | `folded_a` 进入 active（`folded_b` 仍未发现不在）；`foldedNames` 非空故 `tool_search` 仍在（D13） | `tool_search` 的 toolUse/toolResult 正常渲染；marker 后出现 `folded_a` 的 `tool_reference` 展开 | `folded_a` 标 `defer_loading: true` 且不打 cache marker（样板 `deferred-tools.test.ts:188-193`） |
| `R2-ANT-C` | `anthropic matrix: called folded tool stays deferred and referenced` | `folded_a` 在 active 且可执行 | 其调用输出作为 `tool_reference` 的兄弟内容保留（样板 `:196-229`） | 通道保持（D20）：`defer_loading: true` 保持、不打 cache marker、历史 `tool_reference` 存在 |
| `R2-OAI-AT-U` | `openai additional-tools matrix: undiscovered folded tool is absent` | 同 U 型 | 无折叠条目 | 无 `additional_tools` 条目 |
| `R2-OAI-AT-D` | `openai additional-tools matrix: discovered unused tool uses additional_tools` | `folded_a` 进入 active；`tool_search` 仍在 | `tool_search` 调用渲染为普通 function_call/function_call_output | 请求级 `additional_tools`（developer 角色）含 `folded_a`（样板 `:405-420`） |
| `R2-OAI-AT-C` | `openai additional-tools matrix: called folded tool keeps additional_tools channel` | `folded_a` 在 active 且可执行 | 普通 function_call/function_call_output | 通道保持（D20）：`additional_tools` 持续含 `folded_a`，条目先于其首次 function_call（样板 `:420-446`，即 preserves an additional_tools marker after the loaded tool is used） |
| `R2-OAI-TSC-U` | `openai tool-search-call matrix: undiscovered folded tool is absent` | 同 U 型 | 无折叠条目 | input 无 `tool_search_call`/`tool_search_output` |
| `R2-OAI-TSC-D` | `openai tool-search-call matrix: discovered unused tool emits search call/output` | `folded_a` 进入 active | 合成 `tool_search_call`（`execution:"client"`、`completed`）+ `tool_search_output`，`call_id` 配对 | `tool_search_output.tools` 含 `folded_a` 且标 `defer_loading: true`（样板 `:455-469`） |
| `R2-OAI-TSC-C` | `openai tool-search-call matrix: called folded tool keeps search channel` | `folded_a` 在 active 且可执行 | 原有 `tool_search_call`/`tool_search_output` 条目保留，该工具后续调用渲染为普通 function_call | 通道保持（D20）：`folded_a` 不进普通 tools 字段，继续经 search 通道折叠 |
| `R2-KIM-U` | `kimi matrix: undiscovered folded tool is absent` | 同 U 型 | 无折叠条目 | `folded_a/b` 不进 `params.tools` |
| `R2-KIM-D` | `kimi matrix: discovered unused tool returns in params.tools` | `folded_a` 进入 active | 消息正常渲染 | `deferredToolsMode:"kimi"` 下按 addedToolNames 恢复进 `params.tools`（样板 `:345-396`） |
| `R2-KIM-C` | `kimi matrix: called folded tool stays in params.tools` | 在 active 且可执行 | 普通块 | 通道保持（D20）：`folded_a` 以普通 schema 留在 `params.tools`（Kimi 通道即普通 schema） |
| `R2-OTH-U` | `other-provider matrix: undiscovered folded tool is absent` | 同 U 型 | 无折叠条目 | 无该工具任何字段 |
| `R2-OTH-D` | `other-provider matrix: discovered unused tool is ordinary schema` | `folded_a` 进入 active | 普通块 | 普通 schema，无任何 provider deferred 字段 |
| `R2-OTH-C` | `other-provider matrix: called folded tool is ordinary` | 在 active 且可执行 | 普通块 | 普通 schema |

配套测试 `R2-EXE`（`tool_search stays executable after all folded tools are discovered`）：fixture 的 `folded_a`、`folded_b` 全部经真实 transcript 发现后，`tool_search` 离开广告集但保持可执行；幻觉重调返回 `All folded tools are already loaded.`（**含句号**，M1 §3.5 冻结文案，D15），而非 Unknown tool。

### 10.3 零开销 fixture（D17）

**状态：设计草案，未验证。** 当前 checkout 无实现，本节是验收方案而非测量结论；实现落地并跑通前不得声称已验证。

**同一捕获 helper**：baseline（现状代码路径）与 new（tool_search 代码路径）必须用 §2 的 `createPayloadCapture()` 同一 helper 构造——包装 harness 的 `streamFn`（`packages/coding-agent/test/suite/harness.ts:153` 传入 `streamSimple`），在 stream 层深拷贝每次请求的完整 Context（tools/messages/systemPrompt）与 streamOptions，不改生产 provider。字节比较对象是该层序列化结果；真实 Anthropic/OpenAI JSON 的 adapter 层回归由 §10.5 既有测试保护（分层理由见 §11.1）。

**固定全部非确定性输入**：比较前两组 capture 经过同一 `canonicalize` 规则——(1) fixture 可控处显式固定：`fauxToolCall` 传 `{ id }`、`fauxAssistantMessage` 传 `{ timestamp, responseId }`（`packages/ai/src/providers/faux.ts:60-99`）；(2) loop 运行期生成的消息（user prompt、toolResult）timestamp 与其他随机 key（如 faux `randomId`、OpenAI `prompt_cache_key` 输入）由 canonicalize 按「字段名 + 出现序」映射为稳定占位值。两组走同一映射，字节差异即真实结构差异；不做字段剔除（剔除会掩盖真实回归）。

**两个 case 分别断言与现状 baseline 逐字节一致**（`JSON.stringify(canonicalized)` 后 `Buffer.from(a).equals(Buffer.from(b))`）：

1. `mode="off"`（显式关闭；另测缺省 `auto` 且 token 未超阈值）：注册顺序固定 `[read, bash, folded_a, folded_b]`。
2. **激活但零折叠**：`mode="on"` 强制激活，但目录无任何可折叠工具（全 eager / 全部已发现）。断言合成 `tool_search` 不出现、R9 类别段不出现、工具顺序/schema/description/system prompt/cache marker 与 baseline 完全一致。

两 case 都不得只比较名称数组：字段重排、`undefined` 字段清理、空数组/空对象差异正是回归风险，必须逐字节。

### 10.4 集成场景

定位标注遵循 §10.1 的 D19 约定。

1. 「新设计目标（新增）」搜索→发现→调用：faux response 调 `tool_search`，下一 response 调发现工具；断言首次调用前不可执行、下一轮可执行。
2. 「新设计目标（新增）」跨轮保持：新 user prompt 不再搜索仍可调用已发现工具。
3. 「新设计目标（新增）·内含现状回归成分（extension marker 通道）」compaction→resume：压缩前发现，compact，reload/resume，下一轮仍 active；同时验证 extension deferred `addedToolNames` 不回归。**依赖 M4 恢复 gate 契约（D11）**：resume 写回 messages 后、`syncToolSearchState()` 完成前由 AgentSession 持有 gate（M4 §3.2 步骤 6），本场景须在 gate 生效路径上跑通。
4. 「新设计目标（新增）·内含现状回归成分（wrapper 自动 diff）」extension 工具与 tool_search 共存：extension 注册工具、执行引起 active 变化；tool_search 结果与 extension marker 合并而非覆盖。另安排同一批次中 extension execute 窗口不缩减 active，验证 wrapper 自动 diff；tool_search 命中只在批次边界调用 `setActiveToolsByName`，验证不会触发 wrapper 的“active 缩减即抑制整批 marker” guard。
5. 「新设计目标（新增）·内含现状回归成分（allow/deny 过滤）」allow/deny：deny folded_a 后搜索不得看见；allow 仅 folded_b 时目录和 active 只含 folded_b；preset/CLI policy 变化触发重算。
6. 「新设计目标（新增）」激活退回：切换小上下文/模式使其不再激活，已发现工具保持，只有合成 tool_search 卸载。
7. 「新设计目标（新增）」动态工具集通知（R10）：先发现 `folded_a`，再模拟 MCP 断连/热加载；下一轮只产生 registry delta 通知，通知内容经过 allow/deny 过滤，且 entry 类型是 steering（无 steering 时 custom_message），不得伪装成 tool result，也不得泄漏已 deny/卸载名称。
8. 「新设计目标（新增）」transcript 超集恢复（C1）：fixture 的 discovered 含已卸载名与 deny 名；恢复后内部快照可保留事实，但 active、catalog、搜索结果、类别段均只使用 `available = registry ∩ allow/deny`，零泄漏。
9. 「新设计目标（新增）」deferrable 归一化（C3）：在 registry 构建点分别输入原生工具、扩展工具、SDK customTool 与显式声明，断言输出统一 `deferrable`；manager 只消费归一化结果，不再读取 sourceInfo。
10. 「新设计目标（新增）·依赖 M4 恢复 gate 契约（D11）」恢复 gate 端到端：resume 恢复期间到达的用户消息/steer 入队不执行、完成后按原序释放；模拟恢复失败（损坏的 compaction details / 扫描异常）时会话以**非激活模式**继续且诊断落到可观测通道，不阻断 resume。gate 的入队对象、abort 行为、失败语义以 M4 定稿契约为准（D11），M6 只验证端到端可观察行为。

### 10.5 回归保护

「现状回归（保持）」——以下两个既有测试均已在本 checkout 核实存在（D19：只有确认存在的测试才列为现状断言）：

- `packages/ai/test/deferred-tools.test.ts`（存在已核实，550 行）必须继续保护：历史 `addedToolNames` 触发 Anthropic `defer_loading`/`tool_reference`（`:188-193`），used-before-marker 保持 immediate（`:253-261`），OAuth 名规范化（`:263-307`），Kimi system definitions（`:345-396`），以及 OpenAI additional-tools 与 tool-search call/output 配对（`:405-420,455-469`，断言位置见 §8）。
- `packages/coding-agent/test/suite/regressions/6162-extension-active-tools-next-turn.test.ts`（issue #6162，变更记录 `packages/coding-agent/CHANGELOG.md:616`；路径已按 issue 号检索确认）保护 extension 工具变更在同一次 agent run 的下一 provider request 前生效，且不丢 `before_agent_start` system-prompt override（测试经 `createHarness` + `setResponses` 回调捕获逐请求 `context.tools` 断言）。tool_search 接线不得抢先在当前请求变更 active，也不得覆盖该 prompt override。

### 10.6 性能预算（D10：口径与 M3 §9 统一）

- 激活重算：按 registry 一次线性扫描，预算 `O(N + S)`，N=注册工具数、S=allow/deny 集合；目标单次 ≤1 ms（N≤1000 的常规目录），不得在每次 provider 请求重复估算 schema。
- 搜索：名称/description/promptSnippet/参数描述的正则+关键词扫描为 `O(N·L)`；口径与 M3 §9 一致——固定数据集（200 折叠工具）目标 **p95 ≤ 5 ms，硬上限 20 ms**（原 ≤10 ms 单次口径作废）；非语义检索，不引入 embedding。
- 任何预算失败只报性能回归，不改变 R2 正确性。

**Benchmark harness 方法**（新建测试侧脚本 `packages/coding-agent/test/suite/tool-search-bench.ts`，NEW；不属于常规 test suite，手动/CI 单独触发）：

1. **固定数据集**：一次性构建 200 个折叠工具的确定性目录——每工具 1 条 description + 1 条 promptSnippet + 8 个参数，总文本约 200k UTF-16 字符（与 M3 §9 数据集一致）；内容程序化生成但无随机成分（同输入同字节），查询集固定（合法 pattern、关键词组合、混合查询各若干条）。
2. **warm-up**：每条查询先执行 ≥50 次不计时热身（JIT/内联缓存稳定），并断言热身期间结果与首次一致（正确性先于计时）。
3. **采样与统计**：每条查询计时 ≥1000 次单次执行（`performance.now()`，不剔除任何样本），汇总全部样本排序取 p95 与 max；判定 **p95 ≤ 5 ms 且 max ≤ 20 ms**。多查询取最坏查询的统计值作为结论。
4. **环境落账**：结果记录运行时（Node/Bun 版本）与机器说明；激活重算预算（≤1 ms）用同一 harness 方法（warm-up + 采样）验证，数据集为 N=1000 目录。

### 10.7 手工 smoke（真跑一次）

1. 准备 2 个扩展工具，其中一个声明 `deferrable:true`，另一个默认扩展工具；准备含足够长 schema 的目录使 auto 超过阈值。
2. 用项目 CLI 启动 faux/local model（不填真实 key）：`pnpm pi --provider faux --model faux-1 --tools read,bash`（若本 checkout 的 CLI 不注册 faux，则先用 suite harness 等价 smoke；不得改用真实 API）。
3. 输入“搜索能处理 X 的工具”，观察模型调用 `tool_search`，确认结果正文只有一句用途，且下一轮工具列表出现命中工具。
4. 让模型调用命中工具，再输入第二个问题，确认不重复搜索仍可调用；执行 compact/resume 后再调用一次。
5. 对 deny 工具重复搜索，确认无目录条目；用 `mode=off` 运行同一 prompt，保存请求 JSON 并与 baseline 做字节比较；再以 `mode=on` 且无可折叠工具的目录重复一次（「激活但零折叠」case，见 §10.3 两个 case）。

## 11. 发现的冲突

1. coding-agent faux harness 本身抽象在 `streamSimple`，不能证明真实 Anthropic JSON；因此 R2 的 provider wire 必须分层：coding-agent 测 active/时序，`packages/ai/test/deferred-tools.test.ts` 测 adapter payload。若要求单一 harness 同时产出四 provider 原始 wire，则与现有 harness 能力冲突，需主代理裁决。（D17 零开销字节比较落在 stream 层 Context 序列化上，与本条分层一致，见 §10.3。）
2. R2 表把 OpenAI Responses 归一 provider，但其实现有 `supportsAdditionalTools` 优先与 `supportsToolSearch` fallback 两条 wire；本方案增加一个 fallback variant（共 5 个参数化测试、15 个 `it.each` 行）而不把它误报为第五 provider。
3. ~~`6162-extension-active-tools-next-turn.test.ts` 的精确路径当前未由检索确认~~ **已解决（2026-09-25 复核）**：文件存在于 `packages/coding-agent/test/suite/regressions/6162-extension-active-tools-next-turn.test.ts`，内容与 issue #6162 对应（`CHANGELOG.md:616`）；§10.5 已按确认路径列为现状断言。
4. ~~R2「折叠·已调用过 → 普通工具」格与现状 adapter 顺序语义的缺口（需主代理裁决）~~ **已由 D20 裁决（2026-09-25）：契约错、代码对，取方案 (c)**。事实确认：`splitDeferredTools` 的 usedNames 是加入时刻的一次性守卫（`packages/ai/src/utils/deferred-tools.ts:27`），进 deferredNames 后永久保留；`deferred-tools.test.ts:420-446`（preserves an additional_tools marker after the loaded tool is used）锁定的「已调用工具保持 deferred」是 #6474 有意的 cache-friendly 设计。裁决：修正契约 R2 第 3 列断言（主代理已回写 00），不改 adapter（违反 R1 零改动）、不在 coding-agent 层提升（无收益有风险）；四类 provider 下模型都能继续调用已用过的工具，功能正确性零影响；pi-rp 有意不同于 TanStack（已调用工具的 schema 继续折叠），实现者不得按 TanStack 直觉「修正」。§10.2 四个「called」格断言与测试名已按修正后 R2 表改写为通道保持语义。

## 12. 仍未知待拍板

- ~~faux provider 是否暴露最终 request payload 的稳定 capture hook~~ **已由 D17 定稿设计解决**：faux provider 的 `FauxResponseFactory` 本身可读请求 Context（`packages/ai/src/providers/faux.ts:107-112`），但统一捕获点采用 streamFn 包装（§2 `createPayloadCapture()`，harness `:153` 传入点），provider 无关且不改生产代码。
- smoke 命令中的 faux provider CLI 注册方式是否存在于当前 checkout；若不存在，必须把“真跑”改为本地 harness runner，并记录不可用原因。
- OpenAI Responses 两 compat flag 是否允许同一模型同时为 true；测试需明确优先级（契约已规定 `supportsAdditionalTools` 优先）。
