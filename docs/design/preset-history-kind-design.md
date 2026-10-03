# 历史装配操作模型设计

> 状态：设计提案 v3.1，细化设计已产出（`history-ops-detail-design.md`，2026-10-03），待最终评审后实施。替代 sefirot 前置 P7 原方案（`session_compact` hook 增 `replaceContextSlots`）。
> v3.1 修订：采纳细化设计的 12 项裁决建议，修正排序矛盾、reduce summary 语义、cardinality、失败隔离、等价性限定。接口与边界细节以细化文档为准，本文持功能需求。
> 基线：pi-rp 本地工作区现状（含工具暴露统一、P4a 两阶段翻转后代码）。行号为现状行号，实施时以最新代码为准。
> v3 修订：明月 2026-10-03 以酒馆（SillyTavern）成熟实践为参照再次澄清问题本质——历史控制的操作就是具体的几件事：**按深度插入、控制保留数量、窗口外替换为摘要、compact 即移除/隐藏**。方案从"来源组合"（v2 segment）重构为"**消息流操作原语**"。

## 1. 问题定义

### 1.1 本质（v3 重述）

"控制历史消息序列"的操作词汇是有限的、具体的：

1. **插入**：在消息流中某深度放入内容——池的 load/state 更新标记、酒馆式世界书深度注入、固定文本注入；
2. **保留**：最近 N 个 trace 完整保留（一个 trace = 一次 agent start→settle 的过程：一条 user 消息及其后所有 assistant/tool 消息；工具消息不独立计）；
3. **归约**：保留窗口之外的历史替换为摘要（或隐藏）；
4. **压缩**：即"保留 + 归约"的系统内建执行——把窗口边界之前的消息从流中移除，换成摘要。

当前 pi 的问题：这四种行为都存在但**没有名字**——compaction 是物理黑盒（自动触发、边界内部决定），池投影没有插入原语可用（原 P7 只好发明 `replaceContextSlots` 特设通道），深度插入完全不存在。本设计把词汇表显式化为三个原语 **insert / keep / reduce**，让 compaction、池、深度注入成为同一套词汇的实例。

### 1.2 被否决的中间形态（留档）

- v1：kind history 单洞 + 邻接 slot——只考虑 sefirot，池快照是补丁不是历史成员；
- v2：segment 注册制——方向对（history 可组合）但抽象层级错了：按"来源"建模，而作者心智里的操作是"往第几条前面插一条""保留几轮""其余换摘要"，是**对流的操作**，不是来源声明。

## 2. 现状事实（调查核实）

| 事实 | 证据 |
|---|---|
| item kind 仅有 `block \| slot`；chat-history 是 `position: "chat-history"` 特殊 slot，识别首个并插入 `runtime.messages`，无则 implicit fallback | `prompt-preset/types.ts:48-82`、`loader.ts:378-386`、`slot-renderers.ts:20-28`、`compiler.ts:112-119,204-293,493-512` |
| 编译产物已是消息数组 `CompileMessagesResult = { messages, sources, diagnostics }` | `prompt-preset/types.ts:336-350` |
| live 每请求 fresh 编译（`getPresetInjectMessages()`） | `agent-session.ts:760-784,2649-2673` |
| compaction 物理：写 compaction entry（summary），恢复以最新 compaction entry 为界，界前旧 entries 不再进 payload | `session-manager.ts:419-455` |
| compaction 裁剪边界 = `keepRecentTokens`（默认 20000 tokens，settings 已可配），切点选 trace 起点（`isTurnStartMessage`）；**触发**才用 context window（`thresholdTokens = contextWindow − reserveTokens`）。tokens 单位可配，但不可按 trace 声明、不在 preset/history 词汇内 | `compaction.ts:145-146,shouldCompact,findCutPoint`、`settings-manager.ts:25-26,43-44` |
| slot renderer 产出 string；async 需声明 `async: true` | `prompt-preset/types.ts:361-400` |
| `compaction: "exclude"` / `excludeFromContext` 是消息级 policy | `messages.ts:32-42,66-78,221-271` |
| P4a 后 `buildContextEntries(leafId?)` 可不动叶子读任意分支 | `session-manager.ts:1334-1349` |

推论：装配层每请求虚拟操作无契约障碍（产物本就是数组）；物理 compaction 已有保留边界概念，词汇化只改边界选择策略，不动存储。

## 3. 设计

### 3.1 两层模型：声明行为，引擎执行

> 原则（明月 2026-10-03）：**定义行为就行了**——声明层只说"我要一个 compact / 我要在深度 1 插入 / 保留最近 N 轮"；引擎自己处理何时触发、摘要内容、如何落盘。新会话没有 compact 时就没事（无已有 summary 则窗口外自然空转，不生成空替身）。

- **物理层**：entry 流（JSONL）保持完整历史语义，compaction 照旧物理写 entry。本设计**不改变任何存储行为**。触发策略（context window 阈值）与执行策略（tokens/traces 切点）是引擎内部事务，其演化不改声明层。
- **装配层**：每请求从物理流导出基础消息序列（既有过滤、tool pair 修复、history regex、strip-thinking，逻辑原样保留），然后按声明序应用操作，得到 payload 历史。声明 = 行为意图；引擎 = 执行策略。

### 3.2 原语

```ts
type HistoryOp =
  /** 虚拟插入：产物进 payload，不写物理流。 */
  | {
      op: "insert";
      /** 深度：0 = 流末尾；N = 倒数第 N 条消息之前，clamp 到流首。物理压缩后深度按新末尾重算。 */
      depth: number;
      render(ctx: HistoryOpContext): AgentMessage[] | Promise<AgentMessage[]>;
      id: string;
    }
  /** 保留窗口：单位二选一（tokens/traces 严格互斥）。tokens = 现状机制（keepRecentTokens，切点对齐 trace 起点）；traces = 保留最近 N 个 trace（RP 普遍需求）。traces:0 合法（窗口为空）但 warning。 */
  | { op: "keep"; tokens?: number; traces?: number }
  /** 窗口外归约：summary = 复用系统已有 compaction/branch summary 消息作替身（**不在装配层发起 LLM 摘要**，无已有 summary 时窗口外仅丢弃）；hide = 不进 payload（物理流保留）。 */
  | { op: "reduce"; as: "summary" | "hide" };
```

- `HistoryOpContext`：hostData（宿主数据提供者，显式 namespace/key/version）、messages（**窗口化后的只读快照，不含任何 insert 产物**——op 互相不可见，禁止隐性依赖）、runtime（与 SlotRenderContext.runtime 对齐）、signal（AbortSignal）。
- **cardinality**：每个 history item 至多一个 keep、一个 reduce，insert 数量不限；重复 keep/reduce 是 loader error（保留首个有效项，其余诊断丢弃）。
- **执行语义**：keep/reduce 先于 insert（先定窗口，再插入——深度在窗口化后的流上计算）；同深度排序**动态 op 先、preset op 后，同源内按注册序/声明序稳定排序**（id 是身份不是优先级，不按字典序）。
- **失败隔离**：单 insert 异常/reject/非法产物 → 原子丢弃该 op 全部输出并按 origin 归属诊断，继续其它 op；禁止部分产物落流后中止。AbortSignal 取消 = 整次编译取消，不伪装成 op 失败。keep/reduce 配置错误是 loader error，不是运行期跳过。

### 3.3 compaction = keep + reduce(summary) 的系统内建实例

> 本质定义（明月 2026-10-03）：**compact = 触发一次 side request（摘要请求），插入一个标记（summary 消息），使标记之前的内容从 payload 隐藏（或说被标记替换）**。与池标记的两点差异：compact 标记物理落盘且是被隐藏内容的语义替身；池标记虚拟（每请求重插）且是独立内容。

- **触发**：`shouldCompact` 按 context window 算（`thresholdTokens = contextWindow − reserveTokens`，默认预留 16384）——只决定"何时触发"。
- **裁剪**：`findCutPoint(entries, …, keepRecentTokens)`——保留最近约 **keepRecentTokens（默认 20000 tokens）**完整，切点只选 trace 起点（`isTurnStartMessage`，tool 消息跟随其 trace，完整性有保证）。即现状本质就是 `keep: { tokens: 20000 }`，settings 层已可配（`settings-manager.ts:26,44`）。
- v3 对裁剪的接入：**补 traces 单位**——`findCutPoint` 支持按 trace 数切点，settings 层与 preset 虚拟窗口同时可用；按 trace 保留是 RP 普遍需求，不作为边缘功能延后。触发机制不动。

### 3.4 池（sefirot）映射

明月描述的池机制逐字对应：

> 每次 load 以及 state 更新时，往当前消息流中插入一个标记，这个标记就是那条消息；compact 后实际上就是把 compact 之前的消息从消息队列中移除（或隐藏）。

映射：池宿主注册一条 insert 操作，`render` 经 `hostData.pool` 拉当前有效记录产出 `<context update>` 消息序列：

```ts
pi.registerHistoryOp({
  op: "insert", id: "sefirot.pool", depth: 1,   // 紧跟最新消息之前，恒在安全区
  render: async (ctx) => (await ctx.hostData.pool(ctx)).updates.map(toContextUpdateMessage),
});
```

- **虚拟插入 + 深度按新末尾重算** ⇒ 物理压缩后标记自然还在（压缩只移除边界前消息，标记每请求重新插入）——P7 需求达成，无任何特设通道。
- **缓存**：默认不缓存；仅当 provider 提供可靠版本号（如池 revision 递增）且 op 显式声明缓存依赖时启用，无可靠版本则接受每请求重拉——正确性优先，不用时间戳猜变更。

### 3.5 装配点与声明

- preset item `{ kind: "history", ops: [...] }`：声明装配位置与静态操作序列（深度注入固定文本、keep 策略等）。**是唯一历史展开占位点**：至多一个，取首个，其余诊断；insert 深度只相对历史子流，不跨其它 preset item。
- 动态操作（池、检索注入）经扩展 API `pi.registerHistoryOp(op): disposer` 注册（session 作用域，unload/shutdown 自动清理），与 preset 静态 ops 合并执行：**动态先于静态，同源内按注册序/声明序稳定排序**。
- 旧 `position: "chat-history"` 写法**保留，仅在无显式 kind history 时生效**（2026-10-03 裁决，三态规则不变：有 kind history 则旧写法失效并诊断；仅旧写法旧行为；均无 implicit fallback）。旧 slot 的过滤 options（roles/maxMessages/maxChars/toolMode 等）**原样迁入 HistoryItem 字段**，存量 preset 零改动。
- **等价性限定**：零声明**且无注册动态 op** 时，装配产物与现状逐字节等价。

### 3.6 不变式

1. 零声明且无注册动态 op 时，装配产物与现状逐字节等价（过滤/修复/regex/strip-thinking/summary 位置全保留）。
2. insert 产物永不写 SessionEntry/JSONL；keep/reduce(summary) 的物理存储格式不变。
3. sefirot 六段顺序与语义兼容。
4. position 写法优先级三态各有行为断言。
5. P7 验收：池更新下一请求生效；连续 compaction 替换不重复；JSONL 无池条目追加。
6. context window 计量按装配产物总量。

## 4. 风险与对策

| 风险 | 对策 |
|---|---|
| keep trace 切分与 tool 配对冲突（窗口边界落在 tool 往返中间） | trace 边界定义在 user 消息上（= 现状 `isTurnStartMessage`），窗口边界永远落在 trace 起点；tool 消息跟随其 trace，不可分割 |
| insert 深度与 reduce(summary) 的相互作用（深度数进不进摘要消息） | 明确定义：深度在窗口化后的流上计算，summary 消息计入流；测试固定此语义 |
| "非 block 即 slot"假设散布 | 机械迁移，全链路清点（`loader.ts:378-444`、`compiler.ts:296-359,493-512`） |
| compaction keep 与自动触发的相互作用 | 边界机制沿用现状 findCutPoint；traces 是切点选择的新单位，触发时机不碰 |
| 动态注册 op 与 preset ops 冲突（同 id） | 诊断并忽略后者（首个为准） |
| insert 渲染拖慢每请求编译 | 默认不缓存；provider 提供可靠版本号且 op 声明依赖时才启用 keyed 缓存，无版本接受重拉 |

## 5. 改动清单（实施入口）

| 文件 | 改动 |
|---|---|
| `prompt-preset/types.ts` | `HistoryItem`（含 ops）、`HistoryOp`/`HistoryOpContext` 类型、sources 按 op id 标记 |
| `prompt-preset/history-ops.ts`（新） | 操作执行器：窗口化（keep/reduce）、insert 深度计算与排序、失败隔离 |
| `prompt-preset/loader.ts` | kind 校验与诊断 |
| `prompt-preset/compiler.ts` | history 展开点接入操作执行器、position 识别迁移、异步判定 |
| `prompt-preset/default-stack.ts` | 默认栈改用 kind history（零 ops） |
| `agent-session.ts`、`compaction/compaction.ts` | 编译调用点适配；`findCutPoint` 补 traces 单位切点选择；settings 补 traces 单位；`registerHistoryOp`/`hostData` 注入缝 |
| `extensions/types.ts` | `registerHistoryOp` 扩展 API |
| `browser-engine` | harness options 透传 `hostData` 与注册 |
| `docs/prompt-presets.md`、`docs/extensions.md`、`CHANGELOG.md` | 用户面文档 + Changed（优先级规则、ops 词汇、compaction keep 策略） |

## 6. 排队与依赖

- 不依赖 P3/P4（Merkle/state_root）；物理 compaction 语义不变，未来若做"纯虚拟压缩"（hide 模式规模化）再评估与 P3/P4b 的配合。
- 排队：ExposureUnification ✅、P4a ✅ 均已收工，无阻塞，可立即派工。
- 替代关系：实施后原 P7（`SessionCompactResult.replaceContextSlots`）、v1 邻接 slot、v2 segment 注册制均取消。

## 7. 调查依据

管线现状来自 2026-10-03 只读调查（scout PresetCompilerSurvey），证据见 §2；P4a 能力来自 RestoreTwoPhase 交付报告。上游（a276dabe5）无对应机制（prompt-preset 为 fork 特化，见 `fork-upstream-convergence.md` §4）。酒馆参照行为（深度插入、保留 N 轮、摘要替换）来自明月 2026-10-03 对 SillyTavern 实践的说明。

## 修订记录

- v1（2026-10-03）：kind history 单洞 + 邻接 slot。否决：只为 sefirot 特化。
- v2（2026-10-03）：segment 注册制。否决：按来源建模仍抽象，作者心智是对流的操作。
- v3（2026-10-03）：操作原语模型——insert/keep/reduce 三原语，compaction = keep+reduce 的内建实例，池 = 虚拟 insert 的宿主实例；新增 compaction keep 策略（保留 N 轮可声明）。
- v3.1（2026-10-03）：细化设计（`history-ops-detail-design.md`）裁决并入——同深度排序统一（动态先/preset 后/同源声明序，删 id 序）；reduce summary 限定复用已有 summary 不发 LLM；cardinality（≤1 keep + ≤1 reduce）；tokens/traces 互斥且物理 compaction 首期仅 tokens；失败隔离原子化 + abort 语义；ctx.messages 限定窗口化快照；等价性限定加"无注册动态 op"；旧 slot options 原样迁移；缓存默认禁用。
- v3.2（2026-10-03）：术语按领域纠正——"轮/turns"统一为 **trace**（一次 agent start→settle 的过程，pi 既有概念 `currentTraceStartIndex`/`isTurnStartMessage` 即 trace 边界）；keep 单位 `turns` 更名 `traces`。按明月澄清，按 trace 保留是 RP 普遍需求而非边缘功能：物理 compaction 的 traces 单位从"后续评估"提为随本次实施（settings 层同步支持）。
