# 02-codingagent侧：host 原语与 preset 覆写

> 归属：`docs/design/temp-autotidy/` 文档集，遵守 `01-共同上下文.md`（下称"契约"）冻结形状与 `00-需求原话.md`（下称"00"）裁决基准。
> 本文证据行号均为 2026-09-30 实测；与契约 §3 行号的漂移在 §11 逐条申报。
> 字段切分定稿已经主代理确认冻结并回写契约 §2.2；TEMP 枚举缺口裁决见契约 §2.9 修订 v2（导航缺陷必修归 01，`{temp_list}` 直出保留）。

---

## 1. 一句话定位

coding-agent 侧为 autoTidy 提供三件事：**一个流式 side 通道原语**（`sideStreamFn`，走 requestGateway、priority 0、label `"temp-tidy"`）、**一个可控简报投递口**（`sendCustomMessage` 增加 `triggerTurn` options）、**一条 preset 覆写值的解析与传递通路**（`hiddenOverrides.tempTidy` 两字段切分 + loader 解析 + host getter 活读取）；memory 包全程只依赖 `MemoryModuleHost` 结构化接口，零 import 依赖。

---

## 2. 签名参数

### 2.1 新增 host 原语 `sideStreamFn`（契约 §2.3 冻结形状，逐字照抄）

```ts
/** LLM 流原语：走 side 通道（requestGateway，priority 0，label "temp-tidy"）。 */
sideStreamFn(options: {
  /** settings.memory.temp.autoTidy.model 原样字符串；undefined → 会话主模型（D5）。解析失败 throw。 */
  modelRef?: string;
  signal?: AbortSignal;
}): Promise<StreamFn>;   // StreamFn = pi-agent-core 类型（packages/agent/src/types.ts:19-33）
```

职责切分（契约语义的澄清，非改动）：**调用方**（01 的 TidyRunner）读 `settings.memory.temp.autoTidy.model` 并原样传入 `modelRef`；**host** 只做"ref 字符串 → Model 对象"的解析（契约 §2.1："解析在 host 侧"）。host 不自行读 settings，保证 headless 结构化 host 可伪造、模型来源可测。

### 2.2 `sendCustomMessage` 扩展

memory 侧接口（`packages/memory/src/module.ts:107` 现单参）扩为：

```ts
sendCustomMessage(
  message: { customType: string; content: string; display: false; details?: unknown },
  options?: { triggerTurn?: boolean },
): void;
```

host 侧绑定（`packages/coding-agent/src/core/agent-session.ts:5055-5057` 现硬编码 `{ triggerTurn: true }`）改为：

```ts
sendCustomMessage(message, options?: { triggerTurn?: boolean }) {
  runner.getExtensionRuntime().sendMessage(message, options ?? { triggerTurn: true });
}
```

`options ?? { triggerTurn: true }` 中的缺省补全是**兼容性关键**，理由见 §3.B。

### 2.3 新增 host getter（覆写值传递通路，见 §3.D）

```ts
/** TEMP 整理提示词覆写（preset hiddenOverrides.tempTidy 的活读取）。undefined = 无覆写，用内置默认。 */
getTempTidyPromptOverrides(): { systemPrompt?: string; taskPrompt?: string } | undefined;
```

返回类型是 memory 包**内联定义的结构等价类型**（同 `slots.ts:17-19` "Structural mirror" 惯例），不 import coding-agent 的 `PromptPresetHiddenOverrides`。

### 2.4 preset 类型与 loader 解析

```ts
// packages/coding-agent/src/core/prompt-preset/types.ts:193-201 扩展
export interface PromptPresetHiddenOverrides {
  continueText?: string;
  compaction?: { systemPrompt?: string; initialPrompt?: string; updatePrompt?: string; turnPrefixPrompt?: string; branchSummaryPrompt?: string };
  /** TEMP 自动整理（autoTidy）提示词覆写。字段语义见 docs/design/temp-autotidy/02/03。 */
  tempTidy?: {
    systemPrompt?: string;  // tidy agent 持久规则（人格、简报风格禁令、任意内容判断框架）
    taskPrompt?: string;    // 一次性任务模板（使命表述 + {temp_list} 保留变量）
  };
}
```

**字段切分定稿已 hub 广播冻结**（2026-09-30，DesignPromptSide/DesignMemorySide/Main 均已送达）。03 按此两字段产出默认文案；01 按此消费。

---

## 3. 行为契约逐步

### A. `sideStreamFn` —— 本文最高风险点，先给结论

**关键题答案：不需要补任何流式入口，`RequestGateway.streamSimple` 就是现成的流式入口。**

现状 `completeSideRequest` 之所以是"单发非流式"，不在通道，在消费端。通道分两层：

| 层 | 实现 | 性质 |
|---|---|---|
| 传输层 | `RequestGateway.streamSimple(model, context, options?, identity?, signal?)` → `AssistantMessageEventStream`（声明 `request-gateway.ts:130-149`，实现体委托 `model-runtime.ts:654-661`——**[修订 2026-09-30 J10]** 原引 request-gateway.ts:653-661） | **真流式**：lazyStream 惰性占坑，逐事件产出 |
| 消费层 | `completeSummarization(model, context, options, streamFn, retry)`（`agent-session.ts:4534-4540`） | 把流**聚合**成单条最终 AssistantMessage 返回 |

`completeSideRequest` = 传输层 + 聚合消费层。`sideStreamFn` = **只换消费层**：把同一传输层闭包作为 `StreamFn` 交给 01 的 TidyRunner，由 pi-agent-core `agentLoop`（`packages/agent/src/agent-loop.ts:33-46`）驱动多轮工具循环消费流。

这个闭包形态有现成先例：ExtensionAPI 的 `completeSideRequest` 内部就构造了结构上等价于 `StreamFn` 的闭包（`agent-session.ts:4520-4526`）：

```ts
const streamFn: StreamFn | undefined = this._requestGateway
  ? (mm, cc, oo) =>
      this._requestGateway!.streamSimple(mm, cc, oo, { sessionId: "?", priority, label }, ctrl.signal)
  : undefined;
```

agent 包 CHANGELOG 明确 "`Models.streamSimple` satisfies [`StreamFn`]"（`packages/agent/CHANGELOG.md:155`；`packages/agent/src/types.ts:19-20` 同义注释）。**唯一的新造物是"把闭包返回给调用方"而不是"当场聚合消费"——零新传输机制。**

#### A.1 闭包构造逐步

host 实现落在 `_createMemoryModuleHost` 返回对象内（`agent-session.ts:4868` 起，`const session = this` 于 :4869）：

**第 1 步：模型解析（D5 链）。** `sideStreamFn` 被调用时同步解析：

```ts
const ref = options.modelRef;
let model: Model<Api> | undefined;
if (ref && ref.trim().length > 0) {
  const available = [...session._modelRuntime.getModels()];
  model = findExactModelReferenceMatch(ref, available);
  if (!model) throw new Error(`Tidy model "${ref}" not found.`);
} else {
  model = session.model;
}
if (!model) throw new Error("sideStreamFn: no model available");
```

与 `completeSideRequest` 现实现的 fallback 链逐构同（`agent-session.ts:5019-5033`：`models[role]` → `session.model` → throw "no model available"；bad reference 是硬错误，autoretain 注释 :5017-5018 "a bad reference is a hard error"）。
**漏了会怎样**：没有"未命中即 throw"，modelRef 拼错的 preset 会静默退化到主模型，作者以为在用廉价模型实际烧主模型——配置错误必须显性失败（走 D1 兜底让角色知道 tidy 没跑成）。

抽公共 helper 的重构建议（零行为漂移）：`completeSideRequest`（:5019-5033）与新链几乎同构，抽 `_resolveModelReference(ref: string | undefined, notFoundLabel: string): Model`，错误消息逐字保留（`Autoretain model "${ref}" not found.` / `Tidy model "${ref}" not found.`）。是否顺带迁移旧调用点，交主代理裁决（§12.2）。

**第 2 步：会话级 abort 登记。** `const ctrl = session.registerSideRequest(options.signal)`（先例 `agent-session.ts:560-577`：dispose 级联 abort 所有在飞 side 请求，调用方 signal 被 forward）。
**漏了会怎样**：会话关闭时 tidy 的 LLM 流不会中止，provider 计费与网关占坑在会话死后继续——side 工作必须死于会话。

**第 3 步：返回 pin 死模型的 StreamFn 闭包。** 每次闭包被 agentLoop 调用（每 LLM 轮一次）：

```ts
return (mm, cc, oo) => {
  const roundCtrl = session.registerSideRequest(options.signal);
  const inner = session.requestGateway!.streamSimple(
    model,                              // ← pin：忽略 agentLoop 传入的 mm
    cc, oo,
    { sessionId: "?", priority: 0, label: "temp-tidy" },
    roundCtrl.signal,
  );
  return {
    [Symbol.asyncIterator]: async function* () {
      try { yield* inner; } finally { session.unregisterSideRequest(roundCtrl); }
    }(),
    result: () => inner.result(),
  } as AssistantMessageEventStream;
};
```

设计要点与理由：

- **模型随返回值回传（`{ streamFn, model }`）——契约 §2.3 修订 v2（[修订 2026-09-30 J7]，采纳 R3 审计）**：`AgentLoopConfig.model` 是必填字段（`packages/agent/src/types.ts:168`），host 闭包内解析出的 `Model` 实例随 `{ streamFn, model }` 一并返回给 01，01 直接填 `config.model`——**废除旧方案的占位 stub**（旧案：memory 侧传占位模型、StreamFn 忽略首参。R3 判定为类型谎言 + 事件快照假值，且更简替代确定存在）。闭包内仍 pin 死已解析模型（传输层正确性保证不变）；agentLoop 把 `config.model` 原样作为 StreamFn 首参传出（`packages/agent/src/agent-loop.ts:319` `streamFunction(config.model, …)`），首参值 = 已解析模型本身，AgentEvent 快照 model 字段即为真值。
- **identity 冻结 `{ sessionId: "?", priority: 0, label: "temp-tidy" }`**：契约 §2.3 冻结值。`sessionId: "?"` 是全仓现状占位（`request-gateway.ts:22-24` "Placeholder ?; real value from Phase 1b"；先例 :4523 同值）。`priority` 语义：**大值高优先，2=main loop、1=compaction、0=subagent**（`request-gateway.ts:19-22`）——0 即最低档，provider 并发饱和时 tidy 最先让路，是 E2（不阻塞角色）在传输层的落实。
- **per-invocation 登记/注销**（每 LLM 轮一个 controller，流终局 finally 注销），而非 per-tidy-run 一个：避免 tidy 结束后死 controller 永留 `_sideRequestAbortControllers`（:557）直至 dispose；与 `completeSideRequest` 的 try/finally 逐请求对称（:4544-4547）。
- **包装形态与 gateway 自身同构**：`request-gateway.ts:141-150` 的 lazyStream 就是 `{ asyncIterator 包一层 finally release, result 直通 }` 的包裹（**[修订 2026-09-30 J10]** 原引 :657-660）——本闭包只是把 `release()` 换成 `unregisterSideRequest()`。实现时以 `lazyStream` 实际返回类型为准对齐，`as AssistantMessageEventStream` 是与 gateway 同款的收窄。
- **漏了会怎样**：不 pin 模型 → tidy 中途模型随会话漂移，审计列 `temp-tidy` 却混入多个模型；不 unregister → 登记集只增不减；不 finally → 流中途 abort 时 controller 泄漏。

#### A.2 requestGateway 并发语义（side 通道的真实行为）

- **门是否生效取决于配置**：仅当 settings 配了 `providers.<id>.maxConcurrency` 或 `requestGateway.defaultMaxConcurrency` 时门才存在；未配置/配置 0 = 该 provider 不门控（`request-gateway.ts:95-99`；`CompleteSideRequestOptions` 注释 `extensions/types.ts:2039` "Only enforced when the gateway has maxConcurrency configured"）。未配门时 tidy 请求直通，与主 turn 并发无阻。
- **排队序**：门饱和时按 priority 降序插队（`PerProviderGate.acquire`，`request-gateway.ts:51-86`）；排队中 abort 信号把请求移出队列（:54-62）。
- **占坑期 = 整个流消费期**：`yield* inner` 期间持坑，`finally release()`（:659）。tidy 多轮循环每轮一次 `streamSimple` 调用、轮间还坑——不会整个 tidy run 霸占一个槽。
- **惰性占坑**：`lazyStream` 首次迭代才 `acquire`——排队等待期不占并发名额，只占队列位置。
- **gateway 缺省存在性**：sdk 路径恒有 gateway（`sdk.ts:387-388` "When omitted, a new one is created"，:538 总是传入）。`session.requestGateway` 为 undefined 仅在绕过 sdk 直接构造 AgentSession 的路径理论可达（`agent-session.ts:380` optional 字段）。**设计决定：undefined → throw**（配置面错误，走 D1 兜底），不走直连 `modelRuntime` 的静默退化——绕过 gateway 即绕过并发治理，宁可 tidy 降级。[推断：现实中该分支不可达；防御性保留。]

#### A.3 错误面（三层，与 01 的兜底接线）

| 层 | 触发 | 表现 | 谁兜底 |
|---|---|---|---|
| 配置面 | modelRef 未命中 / 无可用模型 / gateway undefined | `sideStreamFn()` 返回 rejected Promise（同步 throw 语义） | 01 catch → D1 兜底 rp-notify |
| 传输面 | provider/网络错误、上下文超限 | StreamFn 契约：**不 throw**，失败编码为 protocol events + 终态 AssistantMessage `stopReason: "error"`（`packages/agent/src/types.ts:22-26`） | 01 按 §2.6 简报提取规则判失败 → D1 兜底 |
| 中止面 | session dispose（级联 abort）、TidyRunner 超时 signal、门控排队中 abort | 终态 `stopReason: "aborted"`；排队请求被移出队列（:54-62） | 01 区分"会话尚在的超时"（可兜底）与"会话已死"（无从兜底） |

中止面闭环依赖一条 **01 的接线义务**：TidyRunner 必须把同一个 `AbortSignal` 链同时传给 `sideStreamFn(options.signal)` 和 `agentLoop(…, signal, streamFn)`——这样 dispose/超时后 agentLoop 不再发起下一轮，"dispose 后闭包再调用"的缺口不存在。此义务写入 §2.1 接口注释，01 文档承接。
**漏了会怎样**：signal 只传一边 → 流中止但循环继续（或反之），出现僵尸轮次或重复计费。

[推断] lazyStream 工厂 promise 在排队期被 abort 时向消费端呈现为流终态 aborted（而非 reject 穿透）——依据是 ExtensionAPI 同构用法已是成熟路径；实现期以 pi-ai 实际行为为准，验收测试 T3 补断言（§12.3）。

### B. `sendCustomMessage` options 扩展

**第 1 步**：memory 接口加第二参（§2.2）。**漏了会怎样**：01 无法表达 D9 的"不唤醒"，简报会打断角色——E2 的"角色无感"被简报自己破坏。

**第 2 步**：host 绑定改 `(message, options) => runner.getExtensionRuntime().sendMessage(message, options ?? { triggerTurn: true })`。扩展运行时核心绑定已透传 options（`agent-session.ts:4362-4370` `bindCore({ sendMessage: (message, options) => this.sendCustomMessage(message, options) … })`；`extensions/runner.ts:380` `runtime.sendMessage = actions.sendMessage`），host 层一行改动即通。
**漏了会怎样（缺省补全）**：若绑定直传 `options`（undefined 透传），引擎在会话空闲时对 `triggerTurn` undefined 的行为是**不起新 turn**（:2908-2910 falsy 分支）——而现状硬编码 `{ triggerTurn: true }`。直传会把现有阈值通知从"唤醒角色来处理"静默降级为"只落盘"，破坏 D1 的手动通知语义（rp-notify = 要求角色行动，D9 决策原文明确二者必须区分）。**所以缺省 `{ triggerTurn: true }` 必须补在 host 层**，不是模块层。

**第 3 步：现有调用方兼容性（必答 4）。** 唯一调用方 `module.ts:647` `host?.sendCustomMessage(notify)` 单参 → `options === undefined` → 补全为 `{ triggerTurn: true }` → 引擎四象限（`agent-session.ts:2883-2886` JSDoc）逐分支与现状一致：空闲 → `_runAgentPrompt` 起新 turn（:2905-2907）；流式中 → steer（:2901-2904）。**语义零漂移，无需改 module.ts:647。**

**第 4 步：简报路径（01 消费）。** `sendCustomMessage(report, { triggerTurn: false })` → 引擎 ：2901-2910：流式中 → `_pendingCustomMessages` 排队，turn 结束由 `_flushPendingCustomMessages`（:2936-2947）落盘（消息不出现在 assistant toolCall 与 result 之间，:2906-2909 注释说明的 provider 校验原因）；空闲 → `_appendCustomMessage`（:2927-2934）直接落盘、发 message_start/end、不起新 turn。两条路都满足 D9"流式中排队、空闲只落盘、不唤醒新 turn"。
`deliverAs` 不暴露给 memory 接口：模块无需干预排队语义，引擎对 `triggerTurn: false` 的内建行为已覆盖。

### C. `hiddenOverrides.tempTidy` 字段切分与 loader 解析

**定稿（已广播冻结）：两字段 `{ systemPrompt?, taskPrompt? }`。**

对照 compaction 五字段惯例的理由（惯例的本质是"字段数 = LLM 调用面数"，不是数字五）：

1. compaction 的五个字段对应五个结构独立的 LLM 调用面：`systemPrompt`（总结者人格，`compaction.ts:732`）+ `initialPrompt`（首次全量）+ `updatePrompt`（增量，:515 模板）+ `turnPrefixPrompt`（:1008）+ `branchSummaryPrompt`（分支摘要）——四个业务时机各有独立模板，加一个 system。
2. tidy 的调用面拓扑：一次 tidy 运行 = 一次 `agentLoop` = 一个 system prompt（`AgentContext.systemPrompt`，`packages/agent/src/types.ts:451-453`）+ 一条任务 user 消息（`agentLoop` 的 `prompts[0]`）。**恰好两面 → 两字段。**
3. **正交性切出最大收益**：E5/D3 的自定义对象是"使命"（清不清 TEMP、清成什么样）→ `taskPrompt`；E7/D7/D8 的持久规则（简报风格禁令、任意内容判断框架）→ `systemPrompt`。作者换使命不丢规则、换规则不动使命。
4. **否决单字段整体覆写**：作者只想改使命就得连风格禁令一起重抄，抄漏即 E7 碎碎念回归——机制不能诱导作者弄丢硬约束。
5. **否决三字段以上**（如拆独立 `briefingPrompt`）：tidy 没有第三个调用面；强拆制造"引擎强制拼接 vs 作者整体自由"的冲突，compaction 惯例中亦无"引擎强制追加"机制。**[修订 2026-09-30 J5]** 配套落地：tidy 的 ToolDefinition→AgentTool adapter **剥离 `promptGuidelines`**（01 §3.2 R6/R7 已同步修订）——旧设计"引擎把 12 工具 guidelines 拼进 systemPrompt"与本否决理由正面冲突（覆写值同被追加，作者 systemPrompt 永不逐字生效）；剥离后两字段覆写 = 完整生效，E5 覆写整体性闭合。
6. 实例佐证：`~/.pi/agent/prompt-presets/exp-elias.json` 的 `hiddenOverrides.compaction` 五字段全量实例（第一人称"记忆记录员"systemPrompt + 带 `{conversation}`/`{previous_summary}` 插值的四个时机模板）证明"每调用面一模板 + 变量插值"就是既有作者心智模型。

**保留变量登记（引擎替换义务，01 实现；语义表归 03）**：

| 变量 | 归属字段 | 注入内容 |
|---|---|---|
| `{temp_list}` | 仅 `taskPrompt` | TEMP 活跃草稿完整清单（01 在组装任务消息前 SQL 直出，**全库口径**：`uri LIKE 'TEMP://%' AND is_stub=0`，**无 isVisible 过滤**——visibility 谓词是角色视角，tidy 经 tidyCtx.sessionId=undefined 即全库整理者视角（契约 §2.5 同语义）；`countActiveTempNodes` 的可见性口径属阈值触发判定，与直出口径分属两用，不混用）。契约 §2.9 修订 v2：直出保留，与导航缺陷修复（01 承担）不冲突。空清单渲染 `（空）`（03 措辞，01 的 renderTidyTaskPrompt 落地） |
| `{max_turns}` | `taskPrompt` | 工具轮数上限（**[修订 2026-09-30 J2]** 保留变量表冻结为 `{temp_list}` `{max_turns}` 两键——`{threshold}` 从 03 设计不采用，replace-if-present——契约 §2.2 增补/§9-J2；03 默认模板已用 `{max_turns}`，替换义务归 01 的 renderTidyTaskPrompt 单点） |

- 变量替换机制与 compaction `{conversation}` 完全同惯例：**运行时 plain regex replace**（`compaction.ts:713-717` `.replace(/\{conversation\}/g, …)`、:1008 同；exp-elias 模板内的 `{conversation}` 即此机制），**不经 preset 宏引擎**、不进 `variables` 命名空间。
- 缺数据兜底（DesignPromptSide 的 TEMP 枚举缺口发现，§11.2）：`{temp_list}` 注入空清单时替换为明确的“（当前 TEMP 为空）”类文案，具体措辞归 03，替换义务归 01。[推断]空清单在触发路径上理论不可达（阈值判定用本会话可见口径 ≥ 阈值，全库直出口径 ⊇ 本会话可见 → 清单非空），兜底为防御性保留；并发删改造成的窗口期缩小但不消除该防御价值。
- 登记表可扩展（03 若需 `{temp_count}` 等向 02/主代理申请），替换机制不变。

**缺省行为定稿**：

| 输入 | 行为 | 与 compaction 的关系 |
|---|---|---|
| 字段缺省 | 逐字段独立落内置默认（03 文案） | 同惯例（逐字段可选，:234-238） |
| 非字符串（数字/对象/数组） | 该字段静默丢弃，落默认 | 同惯例（`typeof === "string"` 门，:234-238） |
| **空白串（含空串）** | **丢弃落默认** | **唯一刻意偏离**：compaction 接受空串。理由：compaction 有用户在场可察觉；tidy 是无人在环的后台 agent，空 systemPrompt = 无规则的工具持有者，事故不可见。收紧成本 = 一处 `trim().length > 0` |
| 未知键 | 静默忽略 | 同惯例（:225-247 只拷已知键，无 diagnostic） |
| `tempTidy` 非对象 | 整体忽略 | 同 `:231 isPlainObject` 惯例 |
| 两字段全丢后为空对象 | 不落 `preset.hiddenOverrides.tempTidy` | 同 `:243-245` compaction 空对象不落 |

静默降级是特性而非缺陷：配置错误绝不阻塞主会话（契约 §2.1 解析容错精神）。是否补 diagnostic 见 §12.1。

**loader 解析新增**（`loader.ts:241` compaction 块之后、:246-248 收尾之前插入）：

```ts
if (isPlainObject(ho.tempTidy)) {
  const t = ho.tempTidy as Record<string, unknown>;
  const tempTidy: NonNullable<typeof overrides.tempTidy> = {};
  if (typeof t.systemPrompt === "string" && t.systemPrompt.trim().length > 0) tempTidy.systemPrompt = t.systemPrompt;
  if (typeof t.taskPrompt === "string" && t.taskPrompt.trim().length > 0) tempTidy.taskPrompt = t.taskPrompt;
  if (Object.keys(tempTidy).length > 0) overrides.tempTidy = tempTidy;
}
```

### D. 覆写值传递通路（preset 加载 → memory module 消费，必答 3）

```
preset JSON（hiddenOverrides.tempTidy）
  → loadPromptPresets/normalizePreset（loader.ts 新分支，§3.C）
  → PromptPreset.hiddenOverrides.tempTidy（types.ts:193-201 扩展）
  → LoadedPromptPreset（_loadedPresets）
  → setActivePreset / _ensureActivePresetRestored → this._activePreset（agent-session.ts:2220 / :2112 活替换）
  → [新增] MemoryModuleHost.getTempTidyPromptOverrides()        ← 通路终点 = 接口新成员
      实现：() => session._activePreset.hiddenOverrides?.tempTidy   ← 活读取
  → [01 消费] TidyRunner 触发时 pull 一次 → 逐字段与内置默认合并
      → systemPrompt → AgentContext.systemPrompt
      → taskPrompt → {temp_list} 替换后 → agentLoop prompts[0]
```

**为什么是 pull 模型（host getter），不是 push——热切换场景的决定性论证**：

- `setActivePreset` 对 `_activePreset` 是**活替换**（:2220），且仅在解析出的 memory dbPath **变化**时才 `requestReload` 重建 runtime（`_maybeReloadForMemoryDbPathChange`，:2292-2305）。同 dbPath 的 preset 热切换（RP 场景常态：同一角色库下换人格 preset）**不触发** module 重建、**不重调** `registerSession`、**不重跑** `createMemoryModule`。
- 因此任何 push 通路——`createMemoryModule` options（现状 ：4822 只传 settings）、`registerSession` 第二参、host 创建时闭包捕获——都会在该场景送**旧值**：作者改完 preset、切回来，tidy 还在用旧文案，且无任何报错。
- pull 模型：host getter 每次被调用时活读 `session._activePreset`，永远当前值。活读取有直接先例：同 host 内 `getActiveBranchMessages` 每次调用活读 `session.settingsManager.getSettings()`（:4978-4982）；compaction 覆写本身就是运行时活读取（:3734、:4092、:5496 三处 `this._activePreset.hiddenOverrides?.compaction`）。
- `reloadPresets`（:2140-2158，盘上编辑后按 id 重解析）同样活替换——pull 同样覆盖。
- **硬边界合规**：getter 是 `MemoryModuleHost` 接口新成员 → 通路 = "经 `MemoryModuleHost` 接口"（契约 §2.2 允许的两条路之一）；memory 包不 import coding-agent（`module.ts:20-22` 头注释契约、`diff.ts:5-7`）。

**快照语义**：TidyRunner 在 tidy 启动时 pull 一次并用毕；运行中 preset 切换不回溯改在飞 tidy 的提示词。[推断]此为合理语义（运行中规则漂移比短暂旧规则更糟），01 文档对齐。

**接口成员 required + 运行时防御**（沿用 `module.ts:607` `if (!host?.completeSideRequest) continue` 对 required 成员防御的既有惯例（**[修订 2026-09-30 J10]** 原引 agent-session.ts:615））：`getTempTidyPromptOverrides` 与 `sideStreamFn` 在接口中均为 required（编译期强制 coding-agent host 实现），模块侧调用时仍 `host?.getTempTidyPromptOverrides?.()` 防御——headless 结构化 host 未实现时回退内置默认文案，autoTidy 优雅降级，不 crash（硬约束 §5 headless）。

---

## 4. 文件与副作用

| 文件 | 改动 | 副作用 |
|---|---|---|
| `packages/coding-agent/src/core/prompt-preset/types.ts` | `PromptPresetHiddenOverrides` 加 `tempTidy?: { systemPrompt?: string; taskPrompt?: string }`（:193-201） | 纯类型扩展，向后兼容（可选字段） |
| `packages/coding-agent/src/core/prompt-preset/loader.ts` | `normalizePreset` 加 tempTidy 解析分支（:241 后） | 只增不改；既有 preset 解析结果不变 |
| `packages/coding-agent/src/core/agent-session.ts` | `_createMemoryModuleHost` 返回对象：加 `sideStreamFn`、`getTempTidyPromptOverrides`，`sendCustomMessage` 改签名（:5055-5057） | host 对象增大；`completeSideRequest` 若采纳 helper 重构则 :5019-5033 内部改写（消息逐字保留，零行为漂移） |
| `packages/memory/src/module.ts` | `MemoryModuleHost` 加 `sideStreamFn`、`getTempTidyPromptOverrides`，`sendCustomMessage` 加 options 参数（:70-118） | 接口 required 成员增加 → 伪造 host 的测试件需补 stub（见 §9.T7） |
| `packages/memory/package.json` | **零改动**：`StreamFn` 类型从既有依赖 `@earendil-works/pi-agent-core`（package.json:31，^0.84.2）import type | 硬约束 §5.5 合规：新依赖零新增 |
| `packages/coding-agent/src/core/settings-manager.ts` | **零改动**：`Settings.memory` 直接复用 memory 包类型（:3 `import type { MemorySettings } from "@earendil-works/pi-memory"`、:186）；settings 运行时无 schema 校验（宽松透传）——01 在 `MemorySettings.temp.autoTidy` 落类型后 coding-agent 侧自动跟随，字段零登记可用 | 类型单一来源，无双写漂移面 |
| 测试件 | coding-agent 侧新增/扩展 loader 与 host 测试；memory 侧伪造 host 补 stub | 见 §9 |

不触碰：web DTO（契约 §4.3）、触发接线与 TidyRunner（01）、提示词文案（03）、`module.ts:647` 调用点（兼容性零漂移，§3.B.3）。

---

## 5. 落账与审计

1. **简报落账 = 会话树**：简报经 `sendCustomMessage` → `_appendCustomMessage`（:2927-2934）→ `sessionManager.appendCustomMessageEntry` 天然落 session 树，`display: false` + rp-notify 既有 policy `{ context: "include", llmRole: "user", compaction: "exclude" }`（`module.ts:704-707`）——E4 的落账无需新表新机制。`details.kind = "temp-tidy-report"` 由 01 填（契约 §2.4）。
2. **LLM 请求可辨性**：每个 tidy LLM 请求经 gateway identity `label: "temp-tidy"`（观测口径）；产物级审计标识 `tidyCtx.modelId: "temp-tidy"`（契约 §2.5，落 audit 与修订史）归 01。
3. **loader 层无诊断落账**：tempTidy 解析失败静默字段级丢弃，同 compaction（:225-247 无 diagnostic push）。是否增补诊断 → §12.1。
4. **`sideStreamFn` 的 throw 不落账**：异常即信号，由 01 catch 后落 audit（01 范围）。host 不吞不记——吞了 01 就失去兜底触发条件。

---

## 6. 错误边界

| # | 错误 | 边界行为 | 依据 |
|---|---|---|---|
| 1 | `modelRef` 未命中模型目录 | `sideStreamFn` reject `Tidy model "${ref}" not found.` | 先例 ：5023-5024 硬错误注释 |
| 2 | `modelRef` 空白/缺省 且 `session.model` 为空 | reject `sideStreamFn: no model available` | 先例 ：5033 |
| 3 | `session.requestGateway` undefined | reject（不直连退化） | §3.A.2 设计决定 [推断：不可达分支] |
| 4 | 流中 provider 错误 | 按 StreamFn 契约编码为 `stopReason: "error"`，**host 不 throw** | `packages/agent/src/types.ts:22-26` |
| 5 | dispose/超时 abort | `stopReason: "aborted"`；排队请求移出队列 | :560-577 级联；request-gateway.ts:54-62 |
| 6 | preset tempTidy 非法值 | loader 字段级静默丢弃落默认；**绝不 fatal** | §3.C 缺省表；契约 §2.1 容错精神 |
| 7 | host 未实现新原语（headless 伪造） | 模块防御回退：无覆写→默认文案；无 sideStreamFn→tidy 不启动→D1 兜底手动通知 | `module.ts:607` 防御先例（[J10]）；契约 §2.8 |
| 8 | `sendCustomMessage` 第二参被旧调用方省略 | 引擎收到 `{ triggerTurn: true }`，行为与现状逐分支一致 | §3.B.3 |

错误面总原则：**配置面显性 throw（调用方兜底），传输面契约内编码（提取规则判败），解析面静默降级（配置错误不阻塞主会话）**。三条路最终都汇入 D1"失败兜底"语义，tidy 永远不可能因自身错误拖死主会话。

---

## 7. 代码落点

| 改动 | 文件:行 | 函数/对象 |
|---|---|---|
| tempTidy 类型 | `packages/coding-agent/src/core/prompt-preset/types.ts:193-201` | `PromptPresetHiddenOverrides` |
| tempTidy 解析 | `packages/coding-agent/src/core/prompt-preset/loader.ts:241-245`（插入） | `normalizePreset` |
| `sideStreamFn` 实现 | `packages/coding-agent/src/core/agent-session.ts:5054` 前（host 返回对象内新增成员） | `_createMemoryModuleHost` |
| `getTempTidyPromptOverrides` 实现 | 同上 | `_createMemoryModuleHost`，impl 一行活读取 |
| `sendCustomMessage` 改绑 | `packages/coding-agent/src/core/agent-session.ts:5055-5057` | `_createMemoryModuleHost` |
| （可选，§12.2）模型解析 helper | `agent-session.ts:5019-5033` 改写为调用新私有方法 | `_resolveModelReference` |
| memory 侧接口 | `packages/memory/src/module.ts:70-118` | `MemoryModuleHost` 三处扩展（形状 = 契约 §2.3/§2.4 + §2.2 getter） |
| 消费侧 | （01 文档范围，此处仅锚点）`module.ts:638-648` 阈值命中后的 tidy 触发分支（[J10]） | `handleAutoretainAndTemp` |

---

## 8. 与现状差异

| 维度 | 现状 | 改后 |
|---|---|---|
| memory host 的 LLM 能力 | 仅 `completeSideRequest`（单发聚合，`agent-session.ts:5015-5053`） | 增加流式多轮能力 `sideStreamFn`（agentLoop 可驱动）；`completeSideRequest` 原样保留（autoretain 继续用） |
| memory host 的消息投递 | 固定 `triggerTurn: true`（:5055-5057） | 可控；缺省仍 `true`（module.ts:647 零漂移） |
| preset 覆写面 | `continueText` + `compaction` 五字段（types.ts:193-201） | 增加 `tempTidy` 两字段 |
| preset → memory 数据流 | 只有 dbPath（`resolveMemoryDbPath` 第三参，:4813-4816） | 增加提示词覆写（host getter 活读取） |
| gateway identity label 全集 | main / compaction / branch-summary / subagent / extension / autoretain（各自调用点） | 增加 `temp-tidy`（priority 0 档） |
| 行为不变项 | `module.ts:647` 手动通知语义、compaction 五字段解析、`completeSideRequest` 链路、web DTO | — |

---

## 9. 验收测试（跨包测试计划）

### coding-agent 包

- **T1 loader 解析**（扩展既有 preset 加载测试，`packages/coding-agent/test/`）：两字段正常解析；非字符串丢弃；**空白串丢弃（与 compaction 空串行为的刻意分叉，防回归锚）**；空对象不落 `hiddenOverrides`；未知键忽略；`tempTidy` 非对象整体忽略；既有 compaction/continueText 解析不回归。
- **T2 模型解析链**（faux provider 注册已知模型）：`modelRef` 命中 → 返回的 StreamFn 发该模型；未命中 → reject 且消息逐字匹配；`modelRef` 缺省 → 解析到 `session.model`；两者皆空 → reject `sideStreamFn: no model available`。
- **T3 闭包与生命周期**：捕获 StreamFn 调用断言 identity `{ sessionId: "?", priority: 0, label: "temp-tidy" }`（spy `requestGateway.streamSimple` 或以 `RequestGateway` 真实例 + faux provider 观测）；流终局后 `_sideRequestAbortControllers.size` 回落（per-invocation 注销）；tidy 在飞 + `session.dispose()` → 流终态 aborted；[推断验证]门控排队中 abort 不 reject 穿透。
- **T4 门控让路**：`defaultMaxConcurrency: 1` + 主 turn 占坑时 tidy 请求排队，priority 0 殿后于 priority 1/2（完成顺序断言）。
- **T5 `sendCustomMessage` 兼容回归**：host 单参调用 + 空闲 → 新 turn 启动（现状语义）；单参 + 流式中 → steer 路径；显式 `{ triggerTurn: false }` + 空闲 → 落盘无 turn；+ 流式中 → 消息落在 turn 末（`_flushPendingCustomMessages` 后），不出现在 toolCall 与 result 之间。
- **T6 热切换活读取（push 模型致死场景的回归锚）**：激活无覆写 preset A → `setActivePreset(B)`（B 带覆写、**同 dbPath**）→ 断言 `getTempTidyPromptOverrides()` 返回 B 的值，且 `requestReload` **未被**触发（spy）。

### memory 包（01 主责，此处列接口契约项）

- **T7 结构合规**：伪造 host 补 `sideStreamFn`/`getTempTidyPromptOverrides` stub 后既有测试全绿；缺 getter 的伪造 host → 触发 tidy 时回退内置默认文案不 crash。
- **T8 headless 红线固化建议**：现状"memory 不 import coding-agent"仅注释契约（`module.ts:20-22`、`diff.ts:5-7`），无自动断言——建议 01 顺带落一条 CI 可执行断言（源码 grep 零命中），成本一行。

### 跨包集成

- **T9 preset→module 通路端到端**：真实 AgentSession（sdk 路径）+ faux provider + 带 `tempTidy` 覆写与 `autoTidy.model` 的 preset + TEMP 写入至阈值 → 断言 faux provider 收到的请求：system = 覆写 systemPrompt、首条 user 含 `{temp_list}` 替换产物、identity label `temp-tidy`、模型 = `autoTidy.model` 指向的模型。02 范围的通路在此闭合；TidyRunner 循环行为本身归 01 的测试。
- **T10 简报回程**：T5 的 `{ triggerTurn: false }` 分支即简报回程回归，引用不重复建。

---

## 10. 需求对照（逐条标注 00 §1 原话依据）

| 效果 | 本文落实面 | 原话依据（00 §1） |
|---|---|---|
| E1 自动触发 | 触发接线归 01（契约 §2.8）；本文供给 `sideStreamFn`，使"自动起一个 agent"有低优先级 LLM 通道 | 消息 1"另起一个agent拿着全套记忆工具去帮忙整理" |
| E2 异步零污染 | `sideStreamFn` 走 side 通道：模型解析与工具面解耦、gateway priority 0 让路、流上下文由 01 构造不经 sessionManager（角色 transcript/raw_log 零接触，硬约束 §5.3）；fire-and-forget 接线归 01 | 消息 1"最好是异步""需要确保上下文干净" |
| E3 纯只读 preset 也能整理 | `sideStreamFn` 与 `tools.allow` 完全解耦：模型解析走 `_modelRuntime`/settings，不经 `_syncActiveToolPolicy` 过滤面（:2306-2321 只作用于 registry 暴露） | 消息 1"角色agent自身无记忆工具（纯只读）" |
| E4 角色可感知简报 | `sendCustomMessage` options 扩展 + `triggerTurn: false` 投递语义（§3.B.4，D9） | 消息 5"让tidy agent自己写简报……作为简报就行" |
| E5 preset 自定义使命 | `hiddenOverrides.tempTidy` 两字段切分 + loader 解析 + host getter 通路（§3.C/D）；使命整体可换（含"不清空 TEMP"）落在 `taskPrompt` | 消息 3"在preset中给一个字段……留位置支持自定义" |
| E6 失败兜底 | 错误面三层全部汇入 D1 兜底（§6）；兼容性保住手动通知路径（§3.B.3） | 消息 2"自动优先，失败兜底" |
| E7 简报直接 | 本文机制层：风格规则隔离在 `systemPrompt` 字段，作者不改即不丢（§3.C.3）；默认文案禁令归 03（硬约束 §5.1） | 消息 8"简报不要有'好了，完成了''这是简报'这种过渡性语言" |
| E8 通用缓冲区 | `{temp_list}` 保留变量机制：全量底册注入，模型所见 = 任意内容全集，机制上排除内容类型假设（§3.C 保留变量表；采纳 DesignPromptSide 枚举缺口方案） | 消息 8"不要想当然以为TEMP里面只有那些self-reflection，它是通用的" |
| E9 可配置选项 | `enabled=false` 时 01 不调 `sideStreamFn`（原语自身零副作用）；preset 无 tempTidy 时全默认行为 | 消息 1"加入自动整理的选项" |

补充对照（D 系决策在本文的落点）：D5 模型链 = §3.A.1；D9 triggerTurn:false = §3.B.4；D2 全套 12 工具与 D10 TidyRunner 载体 = 01 文档范围，本文仅保证 host 原语不设工具白名单、不做作用域限制（原语层面无收权点）。

---

## 11. 发现的冲突

1. **契约 §3 行号漂移（四处，均已实测更正，不动摇任何决策）**：
   - "completeSideRequest 模型 fallback 链 agent-session.ts:4988-4996" → 实测 ：5019-5033；
   - "sendCustomMessage 绑定硬编码 agent-session.ts:5033-5035" → 实测 ：5055-5057；
   - "hiddenOverrides.compaction 五字段解析 loader.ts:233-239" → 实测五字段拷贝 ：234-238（块 :231-240）；
   - "引擎 custom message 语义 agent-session.ts:2865-2898" → 实测 JSDoc+方法体 ：2881-2919。
   另契约 §2.8 所引 "module.ts:778-781 dispose" 实测 ：778-783（微漂）。
2. **重大发现（DesignPromptSide 于 2026-09-30 hub 广播，本文已采纳）**：TEMP 存在枚举缺口——`recall("TEMP://")` 因域根节点永不创建而失败（`store.ts:477-481` 祖先补占位只建到第一级）、stub 类目 recall 早退不渲染子树（`tools.ts:301`，[J10] 原 311）、`MEM://index/TEMP` 只列顶层非 stub 节点——现有工具面拿不到 TEMP 完整底册，E8/清到零在"模型看不到全集"层面撑不住。**本文处置**：任务模板冻结保留变量 `{temp_list}`，由 01 TidyRunner 注入前 SQL 直出（**[修订 2026-09-30 J1]** 口径更正：全库无 isVisible 过滤——`countActiveTempNodes` 实带可见性谓词（temp-notify.ts:28-31），旧表述"口径同 countActiveTempNodes"有误；可见性谓词仅属阈值触发判定，与直出分属两用）。**裁决已下（契约 §2.9 修订 v2，2026-09-30 明月拍板）**：导航缺陷属严重 bug，**本功能范围内必修**——修复设计（recall 域级遍历、stub 子树渲染顺序、域根创建/等价机制、index 口径）由 **01 文档承担**；`{temp_list}` 直出保留（修复后仍是 tidy 的确定性底册，且服务自定义 taskPrompt 的 preset 作者）。02 侧无新增改动，仅本文变量表与消缺登记对齐该裁决。
3. **澄清（非冲突）**：契约 §2.3 `modelRef` 语义"settings.memory.temp.autoTidy.model 原样字符串"隐含调用方（01）读 settings、host 只解析——本文 §2.1 已写明该职责切分。若主代理裁决改为 host 自读 settings，需改冻结签名（去掉 modelRef 参数），本文按现契约执行。

---

## 12. 仍未知待拍板

1. **loader 是否给 tempTidy 加 diagnostic**：现状 compaction 解析失败静默（:225-247 无 diagnostic push），本文跟随惯例静默 + 文档化。若要"字段被丢弃"可见性，需偏离 compaction 惯例，请主代理裁决。
2. **`_resolveModelReference` helper 重构范围**：抽公共 helper 并让 `completeSideRequest`（:5019-5033）一并迁移 = 零行为漂移的等价重构；或只加不改、容忍两处同构。倾向前者，因"六个月可维护性"，但改既有 autoretain 路径超出本功能必需范围，交主代理裁决。
3. **lazyStream 排队期 abort 的呈现形态**：[推断] 编码为流终态 aborted 而非 reject 穿透——实现期以 pi-ai 实际行为为准，T3 落断言后回写本文。
4. **gateway undefined 防御分支**：本文选 throw（§3.A.2）。[推断] sdk 路径恒有 gateway，该分支理论不可达；若主代理倾向直连退化亦可，差异仅在绕过治理的容忍度。
5. **保留变量表扩充申请通道**：03 写默认文案时若需第二变量（如 `{temp_count}`），向本文登记表追加即可（替换机制不变）；是否预置由 03 提出后主代理裁决。
