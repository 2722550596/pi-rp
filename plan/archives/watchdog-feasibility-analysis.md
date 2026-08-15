# Watchdog 系统可行性分析

> 状态：源码核对完成，方向认可、原语需修正
> 关联：[watchdog-system.md](./watchdog-system.md)（被分析的计划草案）、[compaction-summary-specifics.md](./compaction-summary-specifics.md)（§4 BUG 审计已过时，见本文 §2.1）、[multi-agent-infrastructure.md](./multi-agent-infrastructure.md) Step 5
> 创建：2026-08-11
> 核对基准：pi-rp 当前 working tree（`agent-session.ts` 51 分钟前、`branch-summarization.ts` 1 小时前刚改过）

## 0. 结论速览

watchdog-system.md 的方向成立——"复用预设系统 + 单次 completion + 可配置触发/送达"是合理的轻量方案。核心 API（`compileMessages` / `compileSystemPrompt` / `PromptRuntime` / `sendCustomMessage` / `applyFinalizeRegexRulesToMessage` / `retryAssistantCall`）全部存在且签名与计划描述一致。

但计划有三类问题，必须动工前修正：

1. **§10 的 BUG 审计已完全过时**——两个 BUG 在当前源码里都已修复（§2.1）。
2. **LLM 调用路径选错原语**——`modelRegistry.complete()` 绕过 `RequestGateway` 且重造了已存在的 `completeSummarization`（§3.1）。
3. **多处技术细节基于旧代码或想当然**——消息源、`options` 字段、限流现状、预设激活默认值等（§2.2–§2.3、§3.2–§3.3、§4）。

本文逐项给出源码证据与修订建议。§5 给出修订后的实施规划。

## 1. 已验证正确的断言（地基稳）

以下断言对照源码全部成立，watchdog 实现可放心依赖：

| 计划断言 | 证据 | 状态 |
|---|---|---|
| `compileMessages(preset, runtime)` / `compileSystemPrompt(preset, runtime, base)` | `compiler.ts:22,47`，导出于 `prompt-preset/index.ts:2` | ✓ |
| `PromptRuntime` 字段（options/messages/state/variables/skills/currentTraceStartIndex） | `types.ts:201-219` | ✓ |
| `applyFinalizeRegexRulesToMessage(preset, message, diags)` | `regex-engine.ts:123` | ✓ |
| compiler 内置 outgoing 正则（history + compiled stage） | `compiler.ts:121,137` | ✓ |
| `retryAssistantCall` import 自 `@earendil-works/pi-ai` | `compaction.ts:9` | ✓ |
| `modelRegistry.find(provider, modelId)` + `hasConfiguredAuth` 在 56-62 行 | `model-registry.ts:56,60` | ✓ |
| `ScopedModel` 支持独立 `thinkingLevel`；`resolveModelOverride` 不存在 | `model-resolver.ts:63-67`（grep 零匹配 resolveModelOverride） | ✓ |
| `sendCustomMessage(message, {deliverAs, triggerTurn})` + `_pendingNextTurnMessages` | `agent-session.ts:1907-1921, 1693-1696` | ✓ |
| 事件钩子位置：`_emitExtensionEvent` 的 turn_end / agent_end、`_emitAgentSettled` | `agent-session.ts:842-859, 696-704` | ✓ |
| `EventBus.emit/on` | `event-bus.ts:3-6` | ✓ |
| ExtensionAPI 有 `notify` / `updateState` / `events` / `register*` | `extensions/types.ts:143,1355,1466` | ✓ |
| 预设发现 `loadPromptPresets` 走 `.pi/prompt-presets/` | `loader.ts:34-37`，`getProjectConfigDir` `config.ts:510` | ✓ |
| `BuildSystemPromptOptions` 仅 `cwd` 必填 | `system-prompt.ts:21` | ✓（决策#12 成立） |
| `convertToLlm` 需手动调 | `messages.ts:148`，compaction / branch-summary 均显式调用 | ✓ |
| finalize 行号 887 → 实际在 892，且受 `preset !== defaultPreset && id !== "pi-default"` 门控 | `agent-session.ts:890-897` | ✓（行号小偏差） |

## 2. 失效的断言（必须改）

### 2.1 §10 的 BUG 审计已完全过时 ⚠️ 最严重

watchdog-system.md §10 与 compaction-summary-specifics.md §4 记录的两个"正则 BUG"，在当前 working tree 里**都已修复**。两个相关文件刚改过（`agent-session.ts` 51 分钟前、`branch-summarization.ts` 1 小时前）。

**BUG 1（compaction 无 finalize）已修：**

`agent-session.ts:2517-2522`（手动 compaction）：
```ts
// Pi-generated summaries are LLM output: apply the active preset's finalize
// regex rules before persisting, matching assistant-message post-processing.
// Extension-provided summaries are already in final form and are left as-is.
if (!fromExtension) {
    summary = this._applyFinalizeToSummaryText(summary);
}
```
`agent-session.ts:2867-2868`（auto-compaction）同样已修。`_applyFinalizeToSummaryText` 定义在 `agent-session.ts:2642`，注释明写 "matching assistant-message post-processing"，内部包成 assistant message 过 `applyFinalizeRegexRulesToMessage`。

**BUG 2（branch-summary 零正则）已修：**

- 输入侧 outgoing：`branch-summarization.ts:333-341` 已加 `applyRegexRulesToMessages`（history + compiled），注释明写 "mirroring compaction's `_applyPresetToCompactionPreparation`"。
- 输出侧 finalize：`branch-summarization.ts:384-403`，`contentText(response.content)` 后包成 assistant message 过 `applyFinalizeRegexRulesToMessage`，注释 "matching the main loop's post-processing of assistant messages"。

**处置**：
- watchdog-system.md §10 整节应删除——它描述的是旧状态，留着会误导后续工作。
- compaction-summary-specifics.md §4 的审计表、BUG 1、BUG 2 描述应标注"已修复（见 commit / 见下文行号）"或整节删除；§5 "修复优先级"随之作废。
- 审计表里 watchdog 行的"OK"结论不变（计划让 watchdog 过 finalize 是对的）。

### 2.2 "限流是未来工作"——`RequestGateway` 已存在且已接线

watchdog-system.md §4.5 称"短期不需要限流；未来走 multi-agent-infrastructure.md Phase 0 的 RequestGateway"。实际 `RequestGateway` **已存在、已接线、已可配置**：

- `request-gateway.ts:104` `RequestGateway` 类已实现（per-provider 信号量 + 优先级队列，`PerProviderGate` `request-gateway.ts:44`）。
- `sdk.ts:321-322` 创建：`new RequestGateway(modelRuntime, settingsManager.getRequestGatewayConfig())`。
- `sdk.ts:332-365` **`Agent.streamFunction` 就是 `gateway.streamSimple(..., {priority:2,label:"main"})`**——主循环、compaction、branch-summary 全走网关（注释 `sdk.ts:319-320` 明确："Wrapping the single streamFn below catches the main loop, compaction, and branch summarization"）。
- `agent-session.ts:240,415,458` config / 字段 / getter 都有；`subagent/run.ts:53` 子 agent 共享父网关。
- 配置入口 `settings-manager.ts:867 getRequestGatewayConfig()`，读 `settings.providers[].maxConcurrency`；`RequestIdentity.priority` 已定义 2=main / 1=compaction / 0=subagent（`request-gateway.ts:21`）。

watchdog 天然属于这个体系，应分配 priority（建议 0）、label `"watchdog:<slug>"`，**复用而非绕过**。这也意味着 §9 决策#4"短期不需要限流"的措辞应改为"复用现有 `RequestGateway`，priority=0"。

### 2.3 finalize 行号与门控条件

计划多处引用 `agent-session.ts:887`，实际 finalize 在 `agent-session.ts:890-897`，且受门控：

```ts
if (this._activePreset !== defaultPreset && this._activePreset.id !== "pi-default") {
    const finalizeResult = applyFinalizeRegexRulesToMessage(this._activePreset, normalized, finalizeDiags);
    ...
}
```

即 pi-default 预设**不过 finalize**。watchdog 引用的是独立预设（非默认），不受此门控影响，但实现时若复用主会话的 `_activePreset`（而非 watchdog 自己的 `instance.preset`）会踩坑——必须用 `instance.preset`。

## 3. 次优解法（方向对，原语选错）

### 3.1 LLM 调用路径：`modelRegistry.complete()` 是错的

watchdog-system.md §5.4 用：
```ts
const response = await retryAssistantCall(
    () => this.#modelRegistry.complete(model, context, options), ...);
```

问题有三层，都对照源码可验：

**1. 绕过 `RequestGateway`。** 调用链是 `modelRegistry.complete()`（`model-registry.ts:103-109`）→ `ModelRuntime.complete()`（`model-runtime.ts:628`）→ `this.stream()`（628-634，走**完整 `stream` API** 而非 `streamSimple`）→ `prepareRequest` + `provider.stream()`，**完全不经过网关**。而 compaction / branch-summary 通过 `completeSummarization` 的 `streamFn`（= `agent.streamFunction` = `gateway.streamSimple`）走网关。watchdog 走 `modelRegistry.complete` = 与主循环 / compaction 不同的、不受并发控制的旁路。

**2. 重造了 `completeSummarization`。** `compaction.ts:581-600` 已是"所有 side request 的共享咽喉"（注释 `compaction.ts:575-580` 原话："Shared choke point for every compaction/branch-summary summarization call"），它已经：走 `streamFn`（网关）+ `cacheRetention:"none"` + `sessionId:uuidv7()` + `retryAssistantCall`。计划自己包一层 `retryAssistantCall` 是重复劳动，且丢了网关路由。`completeSummarization` 已从 `compaction/index.ts:6` 导出，可直接 import。

**3. `thinkingLevel` → `reasoning` 的映射没体现。** compaction 用 `createSummarizationOptions`（`compaction.ts:558-572`）：
```ts
if (model.reasoning && thinkingLevel && thinkingLevel !== "off") {
    options.reasoning = thinkingLevel;
}
```
watchdog-system.md §3.4 列了 `thinkingLevel` 字段，但 §5.4 `#execute` 没说怎么塞进 options。

**正确做法**：复用 `completeSummarization`，传入走网关的 streamFn：
```ts
const streamFn: StreamFn = (m, ctx, opt) =>
    this.#requestGateway.streamSimple(m, ctx, opt, {
        sessionId: this.#sessionId,
        priority: 0,
        label: `watchdog:${instance.slug}`,
    });
const requestOptions: SimpleStreamOptions = {
    signal: abort.signal,
    maxTokens,
    ...(model.reasoning && thinkingLevel && thinkingLevel !== "off"
        ? { reasoning: thinkingLevel } : {}),
    // apiKey / headers / env 不传——由网关内 prepareRequest 解析
};
const response = await completeSummarization(
    model,
    { systemPrompt, messages: convertToLlm(compiled.messages) },
    requestOptions,
    streamFn,
    retryPolicy,
    retryCallbacks,
);
```

收益：走网关（并发受控）+ 复用 retry + 走 `streamSimple`（轻路径，与 compaction 一致）+ auth 由 `prepareRequest` 统一解析（与主循环一致）。这也让 §9 决策#7"抽 `sideRequestExecutor`"变得自然——`completeSummarization` 本质就是它，只差把 `RequestIdentity` 参数化。

**顺带**：`WatchdogRuntime` 构造函数应收 `modelRuntime: ModelRuntime` + `requestGateway: RequestGateway`，而非 `modelRegistry: ModelRegistry`。`ModelRegistry` 是给扩展的薄 facade（`model-registry.ts:32`，在 `agent-session.ts:3357` 才为扩展 runner 构造）；core runtime 直接用 `modelRuntime`（`getModel` / `hasConfiguredAuth` / `streamSimple` 都在 `model-runtime.ts`）。

### 3.2 消息源：`buildSessionContext()` 是过时快照

watchdog-system.md §5.4 step 2：`messages: this.#sessionManager.buildSessionContext().messages`。

**错。** 主 agent 用的是 `this.agent.state.messages`（`agent-session.ts:1459,1509`）。`buildSessionContext()`（`session-manager.ts:489`）从**已持久化的 entries** 重派生，而 `agent-session.ts:819-822` 注释明说："SessionManager persistence happens **later** in `_handleAgentEvent()`"。即在 `turn_end` / `agent_end` 触发时，刚完成的 turn 消息**尚未落 entry**——`buildSessionContext()` 会漏掉当前 turn。watchdog 会拿一份缺最新内容的过时历史去编译预设。

**改**：`messages: this.agent.state.messages`（与主 agent 的 `compilePromptMessages` 一致），`currentTraceStartIndex: this._currentTraceStartIndex`。构造函数需注入一个 `getMessages: () => AgentMessage[]` 回调，而非直接持 `sessionManager`。

### 3.3 `options` 字段自相矛盾

watchdog-system.md §5.4 step 2 写 `options: this.#baseSystemPromptOptions`（复用主会话），决策#12 又写"传空/最小"。应统一为最小 `{ cwd }`（`BuildSystemPromptOptions` 仅 `cwd` 必填，`system-prompt.ts:21`）——watchdog 预设按设计不引用 `tools` / `skills` / `tool-guidelines` slot，传主会话的 options 反而会把 tools 列表泄漏进 watchdog 提示词。

## 4. 计划遗漏的风险 / 缺口

### 4.1 watchdog 预设必须 `autoActivate: false`（计划未提）

`chooseDefaultPreset`（`loader.ts:72-77`）把 `autoActivate !== false` 的预设视为可激活默认。`autoActivate` 是 optional（`types.ts:176`），省略时为真。watchdog-system.md §6 的三个示例预设**都没设 `autoActivate:false`**——若项目无显式激活预设，某个 watchdog 预设可能被选成主预设。**必须**在文档 / loader 里强制 watchdog 预设 `autoActivate:false`，或在 config 解析时校验并 warn。

### 4.2 `persist:true` + `deliverAs:"nextTurn"` 不保证落盘

`sendCustomMessage` 的 `nextTurn` 分支（`agent-session.ts:1920-1921`）只 `push` 到 `_pendingNextTurnMessages`，**不调 `appendCustomMessageEntry`**。pending 消息要到下次 `prompt()`（`agent-session.ts:1693-1696`）才注入上下文。若用户触发后不再发 prompt 就关会话，watchdog 输出**丢失**（仅在内存）。

而 `else` 分支（`agent-session.ts:1930-1940`，无 deliverAs / 无 triggerTurn）才是"立即 `state.messages.push` + `appendCustomMessageEntry` 持久化"。所以 `persist` 和 `deliverAs:nextTurn` 语义冲突：要真正持久化应走 else 分支（落盘 + 进 state，下一轮天然可见）；要"作为 aside 随下次 prompt 注入"则接受"无下次 prompt 即丢失"。计划把 `persist` 当独立 bool 与 `deliverAs` 并列，掩盖了这个二选一。**需明确**：`persist:true` 落盘用 else 路径；`nextTurn` 是"软注入"非"硬落盘"。

### 4.3 `steer` / `followUp` 语义取决于送达时刻，非触发时刻

watchdog 的 `#execute` 是 fire-and-forget，hook 同步返回，真正 `sendCustomMessage` 在 LLM 调用完成后才发生。`isStreaming`（`agent-session.ts:998` = `_isAgentRunActive`）在**送达时**才求值：

- `turnEnd` / `agentEnd` 触发时 `isStreaming=true`（还在 run 内），但 watchdog LLM 若耗时数秒，送达时 run 可能已 settled → `isStreaming=false` → `steer` 落到 `triggerTurn` / `else` 分支。
- `idle` 触发时 `isStreaming=false`，`steer` / `followUp` 不可达，落到 `triggerTurn` / `else`。

所以 `steer` / `followUp` 对异步 watchdog 是**竞态依赖、非确定**的。只有 `nextTurn`（恒入 pending 队列）是确定的。计划把 `steer` / `followUp` / `nextTurn` 并列为 deliverAs 选项，没说这个时序问题。**建议**：文档标注 `steer` / `followUp` 语义受 LLM 延迟影响，确定性场景用 `nextTurn`。

### 4.4 usage 记账对 custom message 不可见

`getUsageCostBreakdown`（`usage-totals.ts:37-52`）只桶化 `assistant` 和 `toolResult` 角色的 `entry.message.usage`，以及 `branch_summary` / `compaction` entry。**custom 角色消息的 usage 不被读取**。watchdog 若以 `customType:"watchdog:*"` custom message 落盘并携带 usage，费用明细里看不到。

watchdog-system.md §9 决策#3 说"走 `addUsageToTotals` + details 携带 usage"——`addUsageToTotals`（`usage-totals.ts:22`）只是个累加器，它操作谁？watchdog 没有自己的 `SessionEntry` 类型。**这是个未闭合的设计点**，两个可选方案：

- 方案 A：扩展 `getUsageCostBreakdown`（`usage-totals.ts:43-52`）识别 `customType` 以 `"watchdog:"` 开头的 custom message，把 `details.usage` 归入 `"Watchdog"` 或 `"Tools/summaries"` 桶。
- 方案 B：watchdog 不走 custom message 落盘 usage，而是单独 append 一个 `toolResult` 角色条目携带 usage（复用现有桶化逻辑）。

Phase 3 闭合此点。

### 4.5 `triggerTurn:true` 会触发完整 agent run（带工具）

`triggerTurn` 非 streaming 时走 `_runAgentPrompt`（`agent-session.ts:1928-1929` → `1559`），那是**带全部工具的完整 agent 循环**，不是单次 completion。对 idle-recap 这种"提醒"场景过重，且会再触发 turnEnd / agentEnd watchdog → 级联。watchdog-system.md §6.3 idle 用例只用 `statusBar`，没踩到，但 `triggerTurn` 选项的语义需在文档里讲清：它启动一个**完整带工具回合**，不是轻量补充。

### 4.6 `dispose` 不在 `agent-session.ts`

`AgentSession.dispose()` 在 `agent-session-runtime.ts:398`，不在 watchdog-system.md §5.5 反复引用的 `agent-session.ts`。watchdog 的 `dispose()` 接线点要找对文件。同样 `reload`（`agent-session.ts:3379`）在 `agent-session.ts`，但 `dispose` 不在——两个生命周期钩子跨文件。

### 4.7 `pi.updateState` 的 op 不覆盖完整 JSON Patch

`pi.updateState(path, op, value)` 的 `op` 仅 `"add" | "remove" | "replace"`（`extensions/types.ts:1355`）。watchdog-system.md §6.2 用例说输出 JSON Patch（RFC 6902），但 `move` / `copy` / `test` 不支持。用例需限定 op 子集，或转译扩展自行实现剩余 op。

## 5. 修订后的实施规划

基于以上，给出修订计划。核心调整：**复用 `completeSummarization` + 走 `RequestGateway`**、**消息源用 `agent.state.messages`**、**删 §10**、**预设强制 `autoActivate:false`**、**澄清 delivery 语义**。

### Phase 0 — 对齐与修正（先做，0 代码）

1. 删除 watchdog-system.md §10 整节（BUG 已修，附证据：`agent-session.ts:2520-2522,2867-2868`、`branch-summarization.ts:333-341,384-403`）。
2. 同步修正 compaction-summary-specifics.md §4-§5（标注已修复或删除）。
3. 把"限流=未来"改为"复用现有 `RequestGateway`"，priority=0、label=`watchdog:<slug>`。
4. 把 §5.4 的 `modelRegistry.complete()` 改为 `completeSummarization` + 网关 streamFn（§3.1）。
5. 把消息源改为 `agent.state.messages`（§3.2）；构造函数改收 `modelRuntime` + `requestGateway` + `getMessages` 回调。
6. 把 `options` 统一为最小 `{ cwd }`（§3.3）。
7. 文档补充：预设 `autoActivate:false` 强制（§4.1）；`persist` / `nextTurn` / `steer` 语义与时序竞态说明（§4.2-4.3）；usage 记账方案待定（§4.4）；`triggerTurn` 语义（§4.5）；`pi.updateState` op 子集（§4.7）。

### Phase 1 — 核心 runtime（可独立验证）

- `core/watchdog/types.ts`：类型（基本照计划，`RetryPolicy` 复用 `@earendil-works/pi-ai`）。
- `core/watchdog/config.ts`：发现 `.pi/watchdog.json`（用 `getProjectConfigDir(cwd, "watchdog.json")`，与 settings.json 单文件风格一致）；解析 + 校验；slug 化。
- `core/watchdog/runtime.ts`：`WatchdogRuntime`，构造收 `modelRuntime` + `requestGateway` + `stateManager` + `eventBus` + `sendCustomMessage` + `getActiveModel` + `getCurrentTraceStartIndex` + `getMessages`（=`() => this.agent.state.messages`）+ `getCwd` + `notify` + `getUserName`。
  - `#execute`：构建 `PromptRuntime`（`messages: getMessages()`、`options:{cwd}`、`state: stateManager.snapshot()`、`variables:{user,turnIndex,traceCount}`）→ `compileMessages` + `compileSystemPrompt` → `convertToLlm` → `completeSummarization`（streamFn 走网关，identity=`{sessionId,priority:0,label:"watchdog:<slug>"}`，options 带 `reasoning` / `signal` / `maxTokens`）→ epoch guard → `applyFinalizeRegexRulesToMessage(instance.preset, ...)` → 提取 text → `#deliver`。
  - 触发：`onTurnEnd` / `onAgentEnd` / `onAgentSettled` / `onBeforeAgentStart`，同步返回，`void this.#execute()`。
  - 生命周期：`reset()`（epoch++、abort、清 idle timer、traceCount 归零）、`dispose()`、`reload(configs, presets)`。
- 接线 `agent-session.ts`：`_emitExtensionEvent` 的 turn_end（`agent-session.ts:851`）/ agent_end（`agent-session.ts:842`）后同步调 hook；`_emitAgentSettled`（`agent-session.ts:699` 后）调 `onAgentSettled`；`prompt()` 的 before_agent_start 处调 `onBeforeAgentStart`。session switch（`agent-session.ts:970` 附近）/ `reload`（`agent-session.ts:3379`）/ `dispose`（`agent-session-runtime.ts:398`）接 reset / dispose / reload。
- **手动验证**：everyNTraces=1 的 watchdog + 一个 `state` + `chat-history` slot 预设（`autoActivate:false`）→ 触发后确认：走网关（日志 / 断点）、`agent.state.messages` 含当前 turn、finalize 正则生效、custom message 落盘。

### Phase 2 — 完整送达 + 动态注册

- eventBus 广播（`pi.events.emit("watchdog:output", {name,slug,text,raw,usage})`）+ statusBar（`pi.notify`）。
- `deliver` 路由：
  - `nextTurn` → pending 队列（标注"无下次 prompt 即丢"）。
  - `persist` → else 分支（落盘 + 进 state）。
  - `steer` / `followUp` → 仅 isStreaming 时有效（标注竞态）。
- ExtensionAPI 加 `pi.watchdog.{register,unregister,list}`（`extensions/types.ts:~1466`），动态注册与 json 配置合并（同 slug 动态优先）。确认 `session_start` 在首个 `agent_start` 前完成（扩展在 sdk 装载期绑定，先于任何 prompt）。

### Phase 3 — 健壮性

- retry：复用 `completeSummarization` 自带；失败 drop + warn，不阻塞。
- usage 记账：**先定方案**（§4.4）——建议方案 A（扩展 `getUsageCostBreakdown` 识别 `customType:"watchdog:*"` 的 custom message usage）。
- epoch guard（已含）；多 watchdog 并发（各自 AbortController，网关负责限流）。

### Phase 4 — 测试

- 单元：config 解析（缺预设 ID → skip + warn）、触发计数（everyNTraces 计数器、turnEnd 每 turn）、delivery 路由（nextTurn / persist / steer 分支）、预设编译（state + history slot 截取）。
- 集成：turn_end 触发 → `compileMessages`（agent.state.messages）→ `completeSummarization`（走网关）→ finalize → custom message 落盘；session switch 中途 in-flight → epoch guard 丢弃 stale。

## 6. 与 watchdog-system.md 的差异汇总

| 计划原文 | 本文修订 | 依据 |
|---|---|---|
| §10 BUG 1、BUG 2 待修 | 已修复，删除整节 | §2.1 |
| §4.5 限流是未来工作 | 复用现有 `RequestGateway`，priority=0 | §2.2 |
| §5.4 `modelRegistry.complete()` + `retryAssistantCall` | `completeSummarization` + 网关 streamFn | §3.1 |
| §5.4 `sessionManager.buildSessionContext().messages` | `agent.state.messages`（经 `getMessages` 回调） | §3.2 |
| §5.4 `options: this.#baseSystemPromptOptions` | `options: { cwd }` | §3.3 |
| §5.5 构造收 `modelRegistry` | 收 `modelRuntime` + `requestGateway` | §3.1 |
| §6 示例预设无 `autoActivate` | 强制 `autoActivate:false` | §4.1 |
| §4.4 `persist` + `deliverAs` 并列 | 澄清二选一与时序竞态 | §4.2-4.3 |
| §9 #3 usage 走 `addUsageToTotals` | 待定方案 A/B | §4.4 |
| §5.5 dispose 在 `agent-session.ts` | 在 `agent-session-runtime.ts:398` | §4.6 |
| §6.2 JSON Patch 全 op | 限定 `add/remove/replace` 子集 | §4.7 |

## 7. 附：关键源码位置速查

| 符号 / 位置 | 文件:行 |
|---|---|
| `compileMessages` / `compileSystemPrompt` | `prompt-preset/compiler.ts:47,22` |
| `PromptRuntime` | `prompt-preset/types.ts:201-219` |
| `applyFinalizeRegexRulesToMessage` | `prompt-preset/regex-engine.ts:123` |
| `applyRegexRulesToMessages` | `prompt-preset/regex-engine.ts:107` |
| compiler outgoing 正则 | `prompt-preset/compiler.ts:121,137` |
| `completeSummarization`（可复用咽喉） | `compaction/compaction.ts:581-600` |
| `createSummarizationOptions`（reasoning 映射） | `compaction/compaction.ts:558-572` |
| `retryAssistantCall` import | `compaction/compaction.ts:9` |
| `ModelRuntime.complete` / `streamSimple` | `model-runtime.ts:628,636` |
| `ModelRuntime.prepareRequest`（auth 解析） | `model-runtime.ts:573-608` |
| `ModelRegistry`（扩展 facade，core 不用） | `model-registry.ts:32-157` |
| `RequestGateway` 类 | `request-gateway.ts:104` |
| 网关接线（`Agent.streamFunction`=网关） | `sdk.ts:321-365` |
| `RequestIdentity` priority 定义 | `request-gateway.ts:17-24` |
| `sendCustomMessage` 全分支 | `agent-session.ts:1907-1941` |
| `_pendingNextTurnMessages` 注入 | `agent-session.ts:1693-1696` |
| turn_end / agent_end 钩子 | `agent-session.ts:842-859` |
| `_emitAgentSettled` | `agent-session.ts:696-704` |
| 主 agent `compilePromptMessages`（消息源参照） | `agent-session.ts:1455-1469` |
| finalize 门控 | `agent-session.ts:890-897` |
| compaction finalize（已修） | `agent-session.ts:2520-2522,2867-2868` |
| `_applyFinalizeToSummaryText` | `agent-session.ts:2642` |
| branch-summary outgoing（已修） | `branch-summarization.ts:333-341` |
| branch-summary finalize（已修） | `branch-summarization.ts:384-403` |
| `loadPromptPresets` | `prompt-preset/loader.ts:34-59` |
| `chooseDefaultPreset`（`autoActivate` 默认真） | `prompt-preset/loader.ts:61-78` |
| `autoActivate` 字段 | `prompt-preset/types.ts:176` |
| `getProjectConfigDir` | `config.ts:510` |
| `BuildSystemPromptOptions`（仅 cwd 必填） | `system-prompt.ts:9-26` |
| `getUsageCostBreakdown`（不读 custom usage） | `usage-totals.ts:37-52` |
| `addUsageToTotals` | `usage-totals.ts:22-28` |
| `EventBus` | `event-bus.ts:3-6` |
| ExtensionAPI `notify` / `updateState` / `events` | `extensions/types.ts:143,1355,1466` |
| `isStreaming` / `isIdle` | `agent-session.ts:998,1003` |
| `AgentSession.dispose` | `agent-session-runtime.ts:398` |
| `AgentSession.reload` | `agent-session.ts:3379` |
| `convertToLlm` | `messages.ts:148` |
| `ScopedModel` / `thinkingLevel` | `model-resolver.ts:63-67` |
