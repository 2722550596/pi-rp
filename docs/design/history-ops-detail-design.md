# History Ops 详细设计

> 状态：v3 冻结需求的细化建议；不改写 `preset-history-kind-design.md` 的需求口径。本文是设计阶段产物，不代表接口已获批准或已实施。所有实现现状断言均附当前工作区 `file:line`；设计判断标注为 `[推断]`。

## 1. 需求对照与范围

本细化依据用户本任务中对设计范围的原文要求：

- “HistoryOp / HistoryOpContext 完整类型设计：诊断归属、异步声明方式、失败语义（单 op 失败隔离的具体行为）”
- “history-ops 执行器架构：基础流导出 → keep/reduce 窗口化 → insert 深度计算与排序的管道形状”
- “普适性探索（重点，讨论出更优解）”以及其中 RAG、跨会话记忆、审计重放、多池、边界全集和酒馆兼容性评估要求。
- “不实施、不跑 check、不 commit。”

权威层级：`docs/design/preset-history-kind-design.md` v3 是功能需求冻结点；本文只补接口、执行、集成及边界语义。凡下文建议与 v3 明文相冲突，列入 §13 供主代理/用户裁决，未裁决前不应实施为既成契约。

## 2. 现状接缝（代码事实）

- Prompt preset item 当前仅支持 `block | slot`，联合类型与基础字段见 `packages/coding-agent/src/core/prompt-preset/types.ts:48-84`；loader 对 `kind` 只接受这两种值，且不认识的 kind 会报错并丢弃该项，见 `packages/coding-agent/src/core/prompt-preset/loader.ts:365-445`。
- Async slot 由注册定义显式声明 `async?: boolean`，`compileMessages` 根据已启用 slot 的声明走 sync 或 async 路径，见 `packages/coding-agent/src/core/prompt-preset/types.ts:376-400`、`packages/coding-agent/src/core/prompt-preset/compiler.ts:91-96,301-303`。同步 compile 遇到 async slot 会空渲染并发 info，见 `packages/coding-agent/src/core/prompt-preset/slot-renderers.ts:478-517`。
- 编译器 `addChatHistory` 是唯一汇合历史的接缝；在此之前应用 roles、summary/thinking/tool 过滤、消息/字符上限、omitLatestUser、tool-pair repair、history regex，之后将历史与合成消息合并并运行 compiled regex，见 `packages/coding-agent/src/core/prompt-preset/compiler.ts:210-294,137-143,198-201`。tool repair 与 thinking 清理分别在 `compiler.ts:562-589,657-699`。
- 每轮真实注入调用 `compileMessages` 并带当前 `agent.state.messages`、trace 索引与 state，见 `packages/coding-agent/src/core/agent-session.ts:2693-2711`。静态 system prompt 重建使用 `compileMessagesSync`，并因 async slot 而跳过静态重建，见 `agent-session.ts:2313-2320,2359-2371`。扩展 `compilePreset` 路径另有一次编译调用，见 `agent-session.ts:4973-4976`。
- compaction 的触发只比较 token count 与 threshold 或 `contextWindow - reserveTokens`，见 `packages/coding-agent/src/core/compaction/compaction.ts:247-250`；`estimateTokens` 使用字符/4 启发式及图像固定估值，见 `compaction.ts:257-300`；`findCutPoint` 倒序累计 entry token，并按可用切点选择边界，见 `compaction.ts:400-470`。prepare 阶段把 settings 的 `keepRecentTokens` 传给它，见 `compaction.ts:789-815`。
- 当前 context 可见性是消息转换策略：bash 的 `excludeFromContext` 被跳过；custom message 的 `context: "exclude"` 也不入上下文，而 `compaction: "exclude"` 只在 summarization conversion 时排除，见 `packages/coding-agent/src/core/messages.ts:32-33,63-76,250-268`。这是既有消息级政策，不等价于 history 流重写。
- `buildContextEntries(leafId?)` 已能为指定分支导出 compaction-aware entries 而不移动活动 leaf，见 `packages/coding-agent/src/core/session-manager.ts:1334-1341`。
- Extensions 的 slot 注册在 extension load 阶段先暂存，绑定 runner 后成为 session-scoped registry；运行时注册要求 runtime active，见 `packages/coding-agent/src/core/extensions/api.ts:89-105,366-379`、`packages/coding-agent/src/core/extensions/runner.ts:359-385`。session API 选项位于 `CreateAgentSessionOptions`，见 `packages/coding-agent/src/core/sdk.ts:84-183`；browser harness 通过 `CreatePiHarnessOptions` 装配并调用 `createAgentSession`，见 `packages/browser-engine/src/assemble.ts:124-158,351-355,544`。
- 用户文档当前仍将 `chat-history` slot 描述为显式历史位置，缺省时隐式追加，且提供旧式 filtering options，见 `packages/coding-agent/docs/prompt-presets.md:111-120,269-283`。

## 3. 词汇和架构结论

### 3.1 “消息流 transform”作为内部通用形状，三原语作为公开能力

**结论建议：**执行器内部接受有明确输入/输出的流水线阶段（消息流 transform），但公开 preset / extension API 仍采用封闭的 `insert | keep | reduce` 判别联合，不采用可任意注册 callback 的开放 union。

- 好处：所有 op 都能用同一数据流描述；将来可增加受控的新操作而不把执行器核心变成散落的 `if (op.kind)`；诊断、来源和失败隔离也能统一。
- 代价：若把所有未知扩展变成任意 transform，执行次序、上下文可见性、token / traces 边界、工具配对、缓存依赖都由扩展任意改变，无法保障零声明兼容和重放确定性；若对每种 transform 增加开放注册协议，等于引入一套插件虚拟机，超出当前三原语价值。[推断]
- 三原语表达语义层能力：`keep` 选定保留窗口，`reduce` 处理窗口外内容，`insert` 插入非物理产物。内部执行器用一个规范化的 `WindowPlan` 及 `InsertionPlan` 消化这些声明。只有未来出现无法还原为三者组合、且经过具体场景验证的需求，才提出第四原语。
- 明确不把 `reduce` 设计成任意 summarize callback。摘要生成有异步 LLM side request、存储副作用、取消和失败/重试策略，不能伪装成纯消息 transform；它仍应由 compaction 系统流程负责，`reduce(as:"summary")` 表示窗口外由系统已有 summary 替代，preset op 只选择/声明裁剪语义。[推断]

### 3.2 两阶段数据管线

建议每次编译进入 history item 时构造不可变基础流并依序执行：

1. **BaseExport**：从当前 `PromptRuntime.messages`（正常实时路径）复制数组引用，不复制消息；保留现有 filter / tool-pair repair / history regex / strip-thinking 的既有规则、次序及兼容行为。零声明模式完全走现有 `addChatHistory` 等价路径，避免为重构而改变旧结果。
2. **WindowPlan**：执行 `keep` 约束，形成“窗口内”及“窗口外”分段。然后由恰好一个有效 `reduce` 决定窗口外策略；缺省保持既有完整流，绝不隐式截断或总结。preset `keep` 仅改变编译产物，不改变 session entries。
3. **InsertPlan**：所有 insert 渲染上下文看到同一份、只读的窗口化消息快照（不看到其它 insert 产物），再将产物按规范化深度和优先序插入。所有动态依赖都通过 hostData 取值；禁止直接改写输入消息及 SessionManager。
4. **Finalization**：将历史与 preset item 生成的其它消息组装；保持当前 regex / squash 的顺序合同。历史阶段 regex 仅针对导出的原始历史，insert 的来源应显式指定是否经过 history regex（建议不经过，以免用户历史规则意外改写外部知识；再经 compiled-stage regex 与全体 payload 一致）。

#### helper 的复用边界

- `roles`、`includeSummaries`、`stripAssistantThinking`、`toolMode`、`maxMessages` / `maxChars`、`omitLatestUser` 及 `repairToolPairs` 作为 BaseExport 中历史源清理步骤复用，不让各 op 分别实现一套。
- `keep` 的 traces 切分必须建立在 tool-pair 修复后的基础流上：先剔除无效 pair，再依据有效 `user` 消息定位 trace 起点；工具调用往返随所在 trace 归组。边界截断若因过滤导致 user trace 起点缺失，以第一个保留消息作为窗口边界，不伪造 user 消息。
- `history` regex 适用于基础用户历史，不作用于 host 注入 insert；`compiled` regex 继续在完整编译结果上执行。strip-thinking 是 BaseExport 的消息清理，不应该被 reduce 再实现。
- 既有 helper 当前散落在 compiler 私有函数中（`compiler.ts:549-589,603-699`）。最小实施应将它们置于 compiler 调用 history executor 的 BaseExport seam，避免把 preset 相关 filter 搬进通用执行器；只有 compaction traces 算法可复用一个独立纯函数，不反向依赖 compiler。

## 4. 建议接口：类型、诊断、异步、隔离

以下是设计形状（具体命名可在实现前统一）；所有类型都是普通 TypeScript 类型，禁止 `any`、类型擦除式运行时依赖或隐式 thenable 约定。

```ts
export type HistoryOpId = string;
export type HistoryOpOrigin =
  | { kind: "preset"; presetId: string; itemId: string; opIndex: number }
  | { kind: "extension"; extensionId: string; opId: HistoryOpId };

export interface HistoryOpDiagnostic {
  level: "error" | "warning" | "info";
  code: string;
  message: string;
  origin: HistoryOpOrigin;
}

export interface HistoryOpContext {
  readonly messages: readonly AgentMessage[]; // BaseExport 完成后的原始历史快照，不含 insert 产物
  readonly window: {
    readonly keptStart: number;
    readonly keptEnd: number;
    readonly turnCount: number;
  };
  readonly runtime: PromptRuntime;
  readonly hostData: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
}

export interface HistoryInsertOp {
  readonly op: "insert";
  readonly id: HistoryOpId;
  readonly depth: number;
  readonly async?: false;
  render(context: HistoryOpContext): readonly AgentMessage[];
}
export interface AsyncHistoryInsertOp {
  readonly op: "insert";
  readonly id: HistoryOpId;
  readonly depth: number;
  readonly async: true;
  render(context: HistoryOpContext): Promise<readonly AgentMessage[]>;
}
export type HistoryOp = HistoryInsertOp | AsyncHistoryInsertOp
  | { readonly op: "keep"; readonly tokens?: number; readonly traces?: number }
  | { readonly op: "reduce"; readonly as: "summary" | "hide" };
```

`hostData` 以项目内已定义接口替换 `Record<string, unknown>` 前，应有独立 HostData schema；此处使用 unknown 避免开放键值绕开运行时边界。运行期访问通过带类型的 provider accessor（见 §9），不得把不受信任 JSON 直接断言为具体服务对象。`readonly AgentMessage[]` 不足以深冻结消息对象，契约要求 op 不修改消息及 content；可以在开发断言或只读视图包装中发现直接数组操作，不能声称 TypeScript readonly 能保证深不可变。[推断]

### 声明与失败语义

- `async: true` 是声明，不从运行时 Promise 猜测；和 slot 保持一致：标明 true 才进入 async compile 判定。注册时检查 `render` 与声明类型（运行时 thenable 意外出现即视为声明违规）。
- `compileMessagesSync` 遇到有效 async history insert 时，不调用它，产生 `async-op-requires-async-compile` info；历史以除该 op 外的有效 ops 编译。不得静默空渲染而不诊断。实际 LLM / preview 每轮调用 `compileMessages`，确保 async op 生效；静态 system prompt rebuild 不含真实 messages，不执行 history ops，或仅采用不访问 history 的同步纯路径。由此不把动态 op 的 async 属性错误地当成静态 system prompt 内容。
- Async insert 可并发执行，但共享同一只读 ctx；多个 op 有副作用是不支持的。结果收集后按规范序插入，不能以 Promise 完成顺序决定消息顺序。如果将来 op 间依赖成为真实需求，改为串行 phase/dependency DAG 的新提案，不依赖偶然的顺序。
- 每个 insert 的异常（同步 throw、Promise reject、错误返回值）捕获在该 op 边界：记录一条 `history-op-render-failed` error（带 origin、op id），舍弃该 op 全部产物，继续执行其它独立 insert 和完成编译。保持失败原子性：禁止部分 append 后 throw。AbortSignal 取消视作整次编译取消，不应被吞成普通 op error；具体取消路径沿现有 compile 调用者处理。[推断]
- keep/reduce 声明非法或相互冲突是配置错误，不是可运行期跳过的 renderer 失败：loader 诊断为 error，裁定有效声明集合后才执行。为遵守 v3 “单位二选一”且避免 token/traces 边界组合口径不明，建议每个 HistoryItem 至多一个 keep 和一个 reduce；重复项报错并仅保留首个有效项。见 §13 决策项。
- 诊断来源统一 `HistoryOpDiagnostic` 再并入 `PromptPresetDiagnostic`，扩展来源也必须保留 `extensionId/opId`；预设文件错误归属 preset item；运行时 op 故障归属注册扩展。不能把扩展错误错误地挂在 preset 的 history item 上。
- 来源追踪应扩展 `CompileMessageSource`，为每条 insert 输出附 `kind:"history-op"`、`opId`、`origin`；当前 source 只有 preset-item/chat-history/implicit-history，见 `types.ts:336-349`。一条 insert 产出多条消息仍各自标同一 origin，便于 `/prompt` 检视和诊断。

## 5. `insert` 深度和排序

约定深度只作用于**窗口化历史流**，而不是完整 preset 编译消息；这是 v3 的既定语义。令窗口后历史长度为 `L`：`depth=0` 表示流末尾，`depth=d>0` 表示从末尾向前 d 条消息之前，故插入索引 `clamp(L-d, 0, L)`。窗口 summary replacement（如果系统 compaction summary 已作为历史消息出现）计入 L；通常情况下 preset `reduce(summary)` 不生成摘要消息，只隐藏窗口外段，避免虚构内容。

同深度声明在输出流中的顺序确定为：先动态 host op，再 preset 静态 op；同源依注册/数组声明序稳定排序。不要按 id 字典序（id 是身份而非优先级）。先将按深度降序的锚点分组，然后在从前向后插入时保持组内优先序；等价实现可一次性构建 gap buckets 后顺序展开。动态注册顺序即 extension 启动注册序；其注册序必须由 registry 记录，不以 Map 偶然迭代行为作为未文档化契约。

当前 v3 同时写了“同深度多条按声明序”（§3.2）和“注册的先于 preset 的，同深度按 id 序”（§3.5），相互冲突，详细见 §12。

`depth > L`：clamp 到索引 0，并针对 op 发 warning（`history-op-depth-clamped`），而不是失败；负数、非有限数、非整数是 loader/注册时配置错误、丢弃 op。`depth=0` 保证最新 history message 后插入；若 L=0，则插入唯一空流 gap，输出 insert 产物。多条消息产物顺序保留 render 返回顺序；空数组为成功但无输出，不报错、不占深度位置。

## 6. `keep` / `reduce` 窗口裁定

### 两种 keep 单位

- `tokens`：延续既有 compaction token estimator 和 trace 起点对齐思想，但 preset 装配的 token 估算不应默认为精确 provider tokenizer；当前 `estimateTokens` 明确是 chars/4 启发式，且 compaction `findCutPoint` 依赖 entries 切点，见 `compaction.ts:257-300,400-470`。必须定义 token 策略是同一启发式还是调用模型 tokenizer；建议最初明确仅兼容启发式，产品名“estimated tokens”，不得暗示精确预算。
- `traces`：从最新有效 trace 起点向前计数 N 个 trace；一个 trace = 一次 agent start→settle 的过程，含它的 user 消息及其后所有 assistant/tool 消息，直到下一 user 消息（与 pi 既有 `currentTraceStartIndex`/`isTurnStartMessage` 标记的边界同源）。未以 user 开始的开头片段属于前导段，不算 trace；keep 至少保留最后 N 个 trace 的起始边界和其后内容。tool result 以及其 assistant tool-call 所属 trace 保持不可拆分。
- history stream 是消息数组，compaction 是 SessionEntry 流；tokens 的估算可汇总同一条 entry 转换出的所有消息，traces 则按 entry-to-message 结果识别 trace 起点（user 消息）。session entries 中不会产出消息的 metadata 不计 trace 和 token，但切点两侧 metadata 应遵循现有 `findCutPoint` 的相邻 metadata 携带规则（`compaction.ts:454-462`）。两层边界不可用数组下标相互替代。
- `traces: 0` 是有效边界：保留零个完整历史 trace，窗口为空，所有历史落入窗口外；若配置 `reduce: hide`，历史输出为空；若 `reduce: summary`，只有系统已存在的 compaction summary 才可留存。该行为可能删除最新用户消息而让请求无输入，故建议 loader warning `keep-zero-traces`，不是硬性拒绝。系统级 compaction `keepTraces:0` 则应拒绝或 clamp 到一个 trace，避免摘要/下一请求断流；建议拒绝为无效 setting。

### reduce 的角色和优先级

`keep` 决定边界，`reduce` 决定边界外输出。`hide` 不产生任何替代消息；`summary` 只把已存在 summary 作为窗口外段的语义替身，不能由普通 preset op 凭空调用 LLM 生成。summary 的具体识别和位置必须以系统既有 summary role/entry 为准；preset 隐藏窗口外时不可把整个物理 compaction summary 误认为普通旧历史而重复注入。

优先级建议：settings `keepRecentTokens` 是**物理 compaction policy**，只控制何时/如何落盘裁剪；preset `keep` 是**本请求虚拟 payload policy**，settings 不覆盖 preset，preset 也不改写 settings。系统级可声明 traces 时，与 tokens 只能由一个设置选定单位，不能分别应用后悄悄产生取更紧还是更宽的边界。用户显式 preset keep 对实时编译生效；物理 compaction 仍依 settings。如果产品要求“preset keep traces 同步控制物理压缩”，那是独立 settings 解析决策，目前 v3 未定义。

已有 `compaction:"exclude"` / `excludeFromContext` 继续在 message→LLM 转换 seam 生效，不作为 HistoryOp 的隐式 reduce；它们分别控制 summarization 与 live context 的既有 policy，见 `messages.ts:32-33,63-76,250-268`。

## 7. Compiler 接入及旧位置三态迁移

### kind history 展开点

推荐将 `HistoryItem` 加入 `PromptPresetItem`，存 `ops` 与基础 item 的身份字段，但不提供 `role`、`heading`、`wrap` 等文本 item 属性。loader 负责对 op JSON 做封闭联合校验：整数 depth、非负 finite units、tokens/traces 二选一、op ids、单一 history item 与操作组合限制；未知 op 是 error 并丢弃该 op，不把未知结构透传执行。

compiler 在展开 enabled items 前先找首个 enabled `kind:"history"`；如果未找到，根据旧 position / implicit fallback 三态决定历史消费点。history executor 的 BaseExport 复用原 `addChatHistory` 的预处理，不应再次运行整个 preset compiler，也不应在 regex 编译后再改历史。sources/diagnostics 进入同一个 `CompileMessagesResult`。

### position:"chat-history" 的三态兼容

v3 §3.5 要求：

1. 显式 `kind:"history"` 存在：旧 position item 不再消费历史，产生迁移 warning；保留该 slot 作为普通 slot 渲染是否合理？建议它不执行 history insertion 语义，但保留其普通 renderer 语义会导致旧 `chat-history` renderer 可能输出空字符串，此处需明确。不应让第二个历史来源再次插同一份历史。
2. 没有 history item，有旧 position：保留原 position 插入点和 slot options 行为，历史仍由旧路径导入。
3. 二者都没有：保留 implicit fallback 行为（包括 stateless one-shot 使用 `lastUserMessage` 时不追加历史）。

当前 compiler 会找首个 registry `position:"chat-history"` slot，并只由它插入历史，见 `compiler.ts:112-119,210-294`；默认 preset 配置需迁移为零 ops 的 history item（当前 `default-stack.ts:18-111` 是 block/slot 列表）。history item 重复时 loader 错误诊断，首个有效项接管，后项不执行。disabled history 项不参与覆盖旧 position。

### async 判定和扩展 compile

`presetHasAsyncSlots` 应扩展为 `presetHasAsyncHistoryOps` 或统一 `presetHasAsyncRenderers`，扫描有效、启用、当前 session registry 已注册的 async insert；调用 `compileMessages` 时把 async op 纳入分流。任何内部 `compileMessagesSync` 的调用者须明确选择：静态系统 prompt 路径不跑 history ops；明确要求 history preview 的 sync API 则 async op 跳过并给 info 诊断。扩展 `compilePreset` 和 live `getPresetInjectMessages` 都必须使用同一 effective op registry/hostData 视图，不能一边执行静态 preset ops、一边丢弃宿主注入。

## 8. 扩展 API 注册、注销和生命周期

建议 `pi.registerHistoryOp(op): () => void`：

- Extension load 阶段：像 `registerSlot` 一样先暂存定义，保存 owner extension identity；runner 完成 session registry 绑定时统一装入，见 `extensions/api.ts:89-105`、`extensions/runner.ts:375-385`。
- 活跃阶段：调用 `runtime.assertActive()`，注册到 session-scoped `HistoryOpRegistry`；相同 extension 内相同 id 重复注册默认拒绝并 warning，不静默覆盖；不同 extension 使用 owner+id 形成完整 key，允许各自同名。
- 返回 disposer 一次性注销本注册项。扩展 unload / session shutdown 自动调用所有 disposer；单个扩展 reload 时先卸载其 ops，再加载新版本。会话结束 registry 清空，不允许串到下一个 session。
- 扩展 op 的注册修改 registry generation；编译前 snapshot registry，确保正在运行的 compile 不因中途 unregister 改变本轮集合，下一轮才生效。已注销 op 正在进行的 async render 可由其生命周期 AbortSignal 取消；不应等待不受控 Promise 永久阻塞 session shutdown。
- 静态与动态 op 用同一运行时 `ResolvedHistoryOp` 结构，保留 origin 字段并保留注册序；presets JSON 不能直接定义可执行 callback。合并序建议动态 ops 全部先于静态 ops；静态内部 preset 数组序，动态内部 registry 注册序。同 id 不跨来源全局冲突，因为命名空间 key 是 `(origin.kind, owner, id)`；日志和 source 展示需显示完整 origin。

这种注册返回 disposer 比目前 `registerSlot(): void` 更适合有状态、依赖宿主数据的长期动态操作。registry 生命周期挂 session scope，而不是进程全局 slots/macro registry，避免会话/扩展间泄漏。[推断]

## 9. hostData 注入缝与 browser harness

建议新增可选 session 工厂字段：

```ts
interface HistoryHostDataProvider {
  readonly namespace: string;
  readonly get: (key: string, context: HistoryHostDataContext) => unknown | Promise<unknown>;
  readonly version?: (key: string) => string | number | undefined;
}

// CreateAgentSessionOptions / CreatePiHarnessOptions
historyHostData?: readonly HistoryHostDataProvider[];
```

约束：命名空间反向域名式，例如 `org.example.pool`、`org.example.rag`，键采用各 namespace 自己的稳定 schema；op 声明依赖 `namespace + key`。同 namespace 多 provider 是配置错误；不允许后写覆盖。hostData 运行时是编译 snapshot 的只读映射，访问失败遵循所属 op 失败隔离。options 通道只传 provider 引用与能力，不传任意 session 私密对象；browser harness 只透传，不复制服务对象或添加 Node 专用默认值。

实际字段建议放 `CreateAgentSessionOptions`，由 SDK 传到 `AgentSession` / session-owned registry；`CreatePiHarnessOptions` 用同名字段并原样转发 `createAgentSession`。browser 入口现有配置到 session 的装配调用位置为 `packages/browser-engine/src/assemble.ts:124-158,351-355,544`，SDK options 定义在 `packages/coding-agent/src/core/sdk.ts:84-183`。扩展注册 API 只能在所属 session 可见；hostData provider 由宿主传入，不通过全局静态 singleton。

编译开始时按已声明 key 拉取 provider 值形成 snapshot。同一 provider 多次读取同 key 只取一次；key 未声明则不暴露，避免 op 随意扫描宿主信息。冲突由注册期拒绝，非“优先级覆盖”。

## 10. keyed 缓存设计

缓存是优化，不是语义来源。默认不缓存；仅 op 明确声明确定性依赖和 `cacheKey` 时启用。每个 cache entry key 至少包括：session id、有效 preset identity/revision、完整 origin、op implementation generation、op 参数（depth 不决定 renderer 输出但可并入）、声明依赖的 hostData version/key、依赖的 runtime fields（逐项声明，而非序列化整个 PromptRuntime）、输入 history/window fingerprint（仅当 op 声明读取它们）。

- hostData version 首选 provider 提供的单调 revision / ETag（`version(key)`）；不是隐含推测。没有 version 时可由 provider 提供稳定 `cacheKey(value)`；仍缺少可靠版本则禁用缓存，不用 `Date.now()`，不对任意对象 JSON.stringify/哈希来“猜”变更。
- version API 必须保证同内容或可观察变化的版本语义。版本没变却数据变了属于 provider 契约违例；下一轮无法可靠检测。[推断]
- 每请求重新 resolve `hostData`，但相同 key/version 可命中 render 结果。注册/注销、preset 修改、相关 runtime dependencies 改变即失效；session dispose 清缓存。缓存的消息必须不可变并在命中时视作 op 原子产物。
- 池场景可使用 `poolRevision` 在写入成功后递增；RAG 使用索引 snapshot/version；跨会话记忆按记忆快照 revision；如果上游数据没有可用版本，不缓存（接受较慢），不拿时间戳充当正确性依据。
- 缓存 key 与缓存容量/淘汰属于运行时实现细节，但必须有界；异步并发同 key 可 single-flight，错误结果不缓存。
实施状态（2026-10-03）：当前实现暴露 provider version，但 keyed cache 延后至出现实测性能需求时再实现；现阶段始终每请求重新读取 hostData 与渲染 insert，不缓存产物。

## 11. 场景演练和词汇覆盖

| 场景 | 三原语组合 | 覆盖判断 / 限制 |
|---|---|---|
| 酒馆式固定深度 lore/world book | `insert(depth)` | 固定注入已覆盖；world info “关键词触发”由宿主 provider 决定返回空/非空，仍是 insert，不需要第四原语。当前不支持酒馆脚本的任意 prompt hook 阶段、扫描顺序或优先级语法，属兼容差距。 |
| RAG 检索结果 | async `insert`，由 hostData 提供 query/result；可对结果使用独立 top-k | 覆盖注入，不覆盖向量检索、去重/rerank 算法，属于 provider职责。失败时该 insert 整体跳过并留诊断。 |
| 跨会话记忆块 | insert + provider读取共享 memory snapshot；可附源信息于消息文本 / metadata | 覆盖读注入；写记忆、合并冲突、记忆生命周期不是 history assembly 的操作。 |
| 多池并存 | 每个池一个动态 insert，namespace 分离，depth 同值稳定排序 | 覆盖；多池是否合并为单 XML block 是消息生成器职责，不要求 executor 特化。 |
| 审计重放 | 历史 export + 可记录每轮有效 op 清单、输入版本与输出来源 | 只读重放覆盖“重建装配结果”；若“审计重放”要求将虚拟结果物理写进 session 或回放副作用，是另一类持久化/事件 sourcing 需求，不应伪装为 insert。当前方案没有可持久化执行日志，故覆盖不了可证明、逐字节、跨版本的审计回放。 |
| 时间/消息事件触发插入 | hostData 依 runtime 决定产物 | 覆盖“是否插入”；若要对生成前后的不同编译阶段插入（system prompt / before tools / after latest user 等多个命名区），单一 chat-history 流深度不够，需未来多个 insertion anchor，不应加第四原语。 |
| 对历史任意重写/删除一段 | `keep + reduce(hide)` 可做窗口外隐藏 | 不能任意选择任意内区间；当前三原语仅窗口语义。若有真实需求再讨论 selector/replace 原语，不能用复杂 transform 插件偷渡。 |

没有现有普适场景足以要求第四原语。特别是 summary generation、物理写入、查询检索、任意消息编辑属于不同职责，而非 history operation 名称不足。

## 12. 边界情形逐项裁定

| 情形 | 建议行为 |
|---|---|
| 基础流为空 | keep/reduce 产物仍为空；insert 的 `depth=0` 可在唯一 gap 输出内容。 |
| 原流全由过滤隐藏 | 等同空流；不把已过滤消息传给 op ctx。 |
| keep 后流为空 | reduce hide 输出空；reduce summary 仅保留系统已有 summary 替身；insert 仍可插入。 |
| 深度越界 | depth 大于长度 clamp 到开头并 warning；非法负数/小数/NaN/Infinity 在 loader/注册校验时拒绝该 op。 |
| insert 返回空数组 | 合法 no-op，无诊断、无深度占位。 |
| insert 返回非数组 / 包含非 AgentMessage | 整个 op 失败原子丢弃，诊断，不影响其它 op；运行时校验不可完全依赖 TS。 |
| 单 insert 抛错/拒绝 | 仅该 op 所有产物丢弃，诊断归 origin，继续独立 ops。 |
| 没有可摘要内容 | 本模块不触发摘要 LLM；summary 模式无已有 summary 时仅输出 keep 窗口（不可生成空 summary 消息）。物理 compaction 如果 messagesToSummarize 为空，由既有系统 compaction 规则处理，不用 preset reduce 改写。 |
| keep `traces:0` | 虚拟窗口空；warning；是否保留 summary 由 reduce 确定。系统物理 keepTraces=0 建议拒绝。 |
| 同深度多个 insert | 动态先、静态后；各来源内注册/声明序稳定，render 数组顺序稳定。 |
| insert 依赖其它 insert 产物 | 不支持；ctx 对所有 op 是同一窗口快照，互不观察结果。要求依赖时应显式声明 provider 数据依赖或另提 DAG，不按 op 执行偶然顺序。 |
| 多个 keep | v3 没有定义；建议 loader 只接受一个 keep，避免 tokens 与 traces 相交逻辑无裁决；需主代理拍板。 |
| 多个 reduce | loader error；只采用首个有效 reduce，其余丢弃并诊断，避免 reduce 顺序改变语义。 |
| 重复 op id | preset 内 error；扩展通过 `(extensionId,id)` namespaced，不同扩展可同名；动态与静态不是冲突项。 |
| history item disabled | 不执行；旧 position 规则仍可接管。 |
| current trace 边界 | traces 以 agent start→settle 为单位，trace 起点 = user 消息（与 `currentTraceStartIndex` 标记的概念同源）；历史 trace 边界的定位复用 `isTurnStartMessage` 判定；thinking strip 仍遵循旧 trace 语义。 |
| 运行中注销 | 当前 compile 使用开始时 snapshot；注销只影响后续 compile，除 session/extension dispose 触发取消外不改本轮结果。 |
| abort | 整次编译取消，不写成“op failed”后继续发请求。 |
| JSON 中未知 op | preset item 其他有效 op 可保留执行，未知 op 单独 error 并剔除；若未来 op 影响窗口相位却不认识，必须禁止整组执行以免产生错误部分语义。 |

## 13. 发现的 v3 主文档问题（不能在本文静默更改）

1. **同深度排序矛盾。** §3.2 规定“同深度多条按声明序”；§3.5 又说动态 op 先于 preset，且“同深度按 id 序”。注册顺序、声明序、字典序不是同一个规则，直接影响稳定输出。建议 v3 选择唯一 total order；本文提议动态先、preset 后，各自注册/声明序，不以 id 排序。
2. **`reduce(as:"summary")` 缺少 summary 来源及生成主体。** v3 将窗口外替换为摘要，同时又说 compaction 保留存储行为、HistoryOp 只接入裁剪词汇；没有规定 summary 由哪个系统 entry/消息提供、无 summary 时的行为、是否对 preset 虚拟窗口触发 LLM。若让普通 reduce 自动摘要，将与“无副作用装配 op”及“物理存储不变”冲突。建议明确 summary 是“保留既有摘要消息”而不是请求 LLM，或把物理 compaction 的 reduce 路径单列为系统编排。
3. **多 keep / 多 reduce 未定义。** item ops 是数组，语法自然允许重复声明，但窗口计划只能有单一边界策略及单一归约策略；未规定首个优先、组合、错误还是按序覆盖。需冻结 cardinality/组合规则。
4. **两个 keep 单位的合法组合未定义。** v3 `tokens?: number; traces?: number` 加“单位二选一”意图互斥，但无 schema 验证、两者同时给出/皆未给出的行为；settings tokens 与 preset traces 是否可同时生效也未定义。
5. **失败隔离和取消语义不足。** “诊断 + 跳过该操作”没有区分配置错误、render rejection、宿主数据失败、取消、输出无效，也没有定义部分产物回滚、是否继续后续 op。需细化为原子失败边界。
6. **`HistoryOpContext.messages` 语义存在顺序循环可能。** v3 只说“当前流只读视图”，而 keep/reduce 先于 insert，却没说明是输入基础流、窗口化流、还是已含之前 insert 的输出；这影响 op 间依赖、深度及缓存键。建议统一窗口快照、不含任何 insert 产物。
7. **compaction keep traces 的实现输入和预算没有拆开。** v3 说 `findCutPoint` 补 traces 单位，但 trace 边界在消息语义上是 user 消息（trace 起点）；`findCutPoint` 输入是 SessionEntry index 范围并按 entry→message token 累积，且支持 split-turn metadata 处理（`compaction.ts:400-470,789-815`）。需明确 entry group→trace 边界的映射及 `traces:0` / 空摘要 / summary entry 的边界行为。
8. **触发预算与保留预算的配置接口未覆盖 traces。** `shouldCompact` 是 tokens 对 context window 的触发阈值（`compaction.ts:247-250`），`keepRecentTokens` 是裁剪预算（`compaction.ts:133-147,801`）；新增 traces 只定义边界选择，但未定义设置层 schema、兼容旧 keepRecentTokens、settings 与 preset 交互及配置迁移。不可把“编译 history keep”误写为“触发 compaction”。
9. **静态 sync compile 与 history async op 的边界未交代。** 当前静态重建是 `compileMessagesSync`，真实路径为 `compileMessages`（`agent-session.ts:2313-2320,2359-2371,2693-2711`）。注册 async op 的声明如何参与 sync skip、静态 prompt 是否执行零历史 history ops、扩展 compile 路径如何供 hostData 都需写入实现契约。
10. **hostData 的暴露与缓存一致性缺字段。** v3 仅列 `hostData` provider 且示例直接调用 `ctx.hostData.pool(ctx)`，没有 namespace/类型/权限边界、provider 版本协议、缓存默认安全策略或错误隔离。没有可靠版本时无法证明 keyed cache 正确；推荐默认不缓存。
11. **诊断和 source trace 现有类型不足。** `PromptPresetDiagnostic` 只有 itemId/message，`CompileMessageSource` 没 op 来源字段（`types.ts:323-349`）；扩展动态 op 错误无法可靠归属。需批准扩类型及 `/prompt` 可观察表现。
12. **“未声明 keep/reduce 时逐字节等价”与全局动态 insert 模型需精确限定。** 若任何 extension 可以无条件注册动态 op，preset 零声明却仍会改变消息，故应改成“零 history 声明且无注册 op 等价”，与 v3 §3.5、§3.6(1) 合并澄清。
13. **单一 history 展开点与 preset 位置表达力存在缺口。** 历史 item 如果可在任意 items 顺序插入，v3 又定义 insert 深度相对窗口化 chat-history 流，则该 item 在 preset 顺序里的位置和深度插入点关系不清；静态 block 在前/后 history 位置的行为需明确。推荐 `kind:history` 只是唯一占位符位置，操作结果在该位置展开，深度只在历史内部排序；无 kind history 时兼容 position/fallback。
14. **零 ops 的 default history 是否保留所有旧 options 未写迁移路径。** 当前 chat-history options 承载 roles、maxMessages、maxChars、toolMode 等行为（`compiler.ts:224-279`；用户文档 `prompt-presets.md:275-283`）。新 `HistoryItem` 是替代 options 还是保留 slot options 透传尚未定义；必须完整迁移选项而非只迁移占位点。

## 14. 开放问题清单（建议裁决顺序）

### 必须由主代理/用户裁决后才能冻结实现口径

1. 同深度序：是否接受“动态先、preset 后，各自注册/数组顺序”，取代 v3 同深度 id 排序？
2. summary reduce：是否明确限定为复用已存在的 compaction/branch summary，不在 history compiler 内发起摘要请求？如果不是，summary 生成责任与副作用如何归属？
3. cardinality：一个 preset history 是否最多一个 keep + 一个 reduce + 多个 insert？重复 keep/reduce 是否直接 loader error？
4. keep units：`tokens` 与 `traces` 是否严格互斥；settings 层物理 compaction 是否新增 traces setting，还是首期仅新增 preset 虚拟 traces？
5. `traces:0`：preset warning 后生效还是拒绝；物理 compaction traces=0 是拒绝还是允许全量摘要？
6. HistoryItem 对应 items 顺序：是否是唯一历史展开占位点；深度只相对 history 子流，不跨 system/user synthetic item？
7. 旧 chat-history slot 的 `options` 如何迁移到 HistoryItem，以保持既有 preset 无行为变化？是否接受新 kind 存同名旧 options 字段？
8. history op failure 是否对单个 op 原子跳过并继续；AbortSignal 是否取消整个 compile？
9. hostData provider / `HistoryOpContext` 对扩展开放的数据权限范围及具体类型是什么；是否接受显式 namespace/key/version provider？
10. keyed cache 是否应首期完全禁用，等 host provider revision contract 落地后再开启？
11. 动态注册与 preset 静态 ops 是否统一结构但保留不同来源优先级；`registerHistoryOp` 返回 disposer 的 API 是否可接受？
12. history messages 是否参与 history-stage regex；本文建议仅基础历史参加，而 insert 只参加 compiled regex。

### 可以先定原则、实施前补足的技术细节

- source 的 `/prompt` 呈现是否按 op id 分组显示，及诊断 code 命名。
- async insert 是 `Promise.all` 并发或全串行；本文推荐并发、结果稳定排序、op 不可互相依赖。
- hostData provider 版本号是 string 或 number；建议允许二者并要求单调/稳定约定，不允许隐式时间戳。
- 缓存容量、淘汰和相同 key single-flight 实现。
- 外部 extension unload 与 in-flight op AbortSignal 的精确关闭时限。

## 15. 兼容差距：酒馆行为评估（不扩范围）

v3 现有三原语覆盖酒馆实践中最核心的固定深度插入、保留 N 个 trace、摘要/隐藏旧窗口。本文不建议为“看起来像酒馆”而添加 trigger 原语、世界书扫描 DSL 或按聊天状态变更物理历史。world-info keyword/条件注入可作为宿主检索 provider，返回零或多条 insert 消息；动态触发逻辑留在 provider。

差距是可配置语法与阶段精度，不是基本流能力：酒馆深度是否在 system prompt 起始位置计算、不同角色/聊天状态/关键词优先级、世界书条目排序、递归触发、预算上限等细节不能仅由当前“从消息流末尾计数”的 depth 重现。若需兼容，应先用具体 fixture 确定其行为和目标等价级别，再考察多 anchor 或独立 trigger filter；不应在此设计暗加第四原语。
