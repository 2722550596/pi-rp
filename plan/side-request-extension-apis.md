# Side Request 原语与扩展 API 设计（发现 #1/#2/#3/#5/#6 + N1/N2）

> 状态：设计定稿，待实现
> 关联：[state-updater-extension-findings.md](./state-updater-extension-findings.md)（发现 #1-#6）、[watchdog-feasibility-analysis.md](./watchdog-feasibility-analysis.md) §3.1、[multi-agent-infrastructure.md](./multi-agent-infrastructure.md) Phase 1（LoopSpec / SideRequestSpec 雏形）、[shared-state-cross-process.md](./shared-state-cross-process.md)（独立并行）
> 核对基准：pi-rp 当前 working tree
> 决策（2026-08-12）：三批一起做（防御与文档 / side request 原语 / 预设编译）；只出设计，先不动手

## 0. 结论速览

三批改动，一个目标：**把"非主循环 LLM 调用"统一到一条路径**（`completeSummarization` + `RequestGateway`），并让扩展成为一等消费者。

| 批次 | 内容 | 状态 |
|---|---|---|
| A 防御与文档 | `model.api` 缺失同步抛守卫（P3）；`updateState` add 语义文档（#6）；ctx 后台任务契约（#5） | 独立 5 行 + 注释 |
| B side request 原语 | `ctx.completeSideRequest`（网关 + 重试 + reasoning 映射）；`completeSummarization` 公共导出（N2）；subagent priority 0（N1） | 核心改动 |
| C 预设编译 | `ctx.compilePreset`（P1） | 与 B 独立 |

不做：`ModelRegistry.complete` 行为改造（保留 + 守卫，state-updater 迁移后为兼容遗留）；发现 #4 维持 session 解析（方案见 shared-state-cross-process.md）。

## 1. 现状与问题（源码证据）

| 发现 | 证据 | 后果 |
|---|---|---|
| #1 扩展 LLM 调用绕网关、无重试 | `model-registry.ts:105-109` → `model-runtime.ts:628-634` `stream().result()`；网关只在 `Agent.streamFunction`（`sdk.ts:332-365`） | 高频 side request 无法限流 |
| #2 重建 `{provider,id}` 丢 `api` 静默失败 | `provider-composer.ts:469-470` 抛错被 `lazy.ts:46-63` 吞成 `stopReason:"error"` | 扩展作者踩坑无感知 |
| #3 扩展无预设编译 API | `compiler.ts:22,47` 仅包内导出；`ExtensionAPI`（`loader.ts:254-458`）无入口，只有 registerSlot/registerMacro | state-updater 手搓 ~25 行渲染子集，行为漂移 |
| #5 ctx 惰性 getter + assertActive | `runner.ts:678-707` 每访问 `assertActive()`；invalidate 在 `agent-session.ts:970`（switch）/`:3383`（reload） | 后台任务必须同步捕获 |
| #6 `add` 是数组追加/数值增量 | `state-manager.ts:84-100`、`schema-validator.ts:275-283` | 翻译层误当 replace 毁数组 |
| N1 网关 priority 定义从未接线 | `sdk.ts:363-365` 硬编码 `{priority:2,label:"main"}`；`request-gateway.ts:137-140` 只消费 priority | 2=main/1=compaction/0=subagent 是空转文档 |
| N2 `completeSummarization` 未公共导出 | `src/index.ts:40-54` 只导出 `generateSummary`/`generateSummaryWithUsage`，后者 streamFn 缺省 fallback `completeSimple`（绕网关） | 公共 API 消费方悄悄绕网关 |

## 2. Batch A：防御与文档

### 2.1 P3 `model.api` 同步抛守卫

- `ModelRuntime.stream` / `streamSimple` 入口（包 `lazyStream` 之前）加 `assertModelApi(model)`：`!model.api` → 同步 throw。
- **为什么放这里**：吞错发生在 `lazy.ts:46-63`，守卫必须在进入 lazy 之前；一处覆盖 `ModelRegistry.complete` 与所有 core 调用方。`provider-composer.ts:469-470` 的抛错本身没错，错在它被懒流吞了。
- **行为变化**：扩展 `complete()` 从"resolve `stopReason:"error"`"变"reject"——期望的 fail-loud。现有整传 `ctx.model` 的调用零影响。
- 文档：`extensions/types.ts` 的 `modelRegistry` / `model` 注释注明"整传 `ctx.model`，勿重建 `{provider,id}`"。

### 2.2 #6 `add` 语义文档

- `extensions/types.ts:1355` `updateState` docstring 写明：数组追加用 `add` + 单元素、数值增量用 `add`、设定用 `replace`（对齐 state-updater 预设已用的措辞）。
- `pi-sillytavern-bridge/extensions/state-patch.ts`（外部仓库）的"add 等价 replace"注释修正留给那边。

### 2.3 #5 ctx 后台任务契约（并入 Batch B 文档）

- 新 ctx 方法入口 `assertActive()`（与现有一致）。
- 文档契约："**handler 同步阶段调用发起请求，后台只 await 返回的 promise**；请求一旦发起，in-flight 不随 ctx invalidate 中断（gateway / modelRuntime 是会话对象，只有启动新工作受 assert 保护）。"

## 3. Batch B：side request 原语

### 3.1 `ctx.completeSideRequest`（ExtensionContext 新增）

```ts
completeSideRequest(options: {
  model?: Model<any>;              // 默认 ctx.model
  context: Context;                // { systemPrompt, messages }（@earendil-works/pi-ai/compat）
  maxTokens?: number;
  thinkingLevel?: ThinkingLevel;   // 默认 ctx.thinkingLevel；model.reasoning 时映射 options.reasoning（N4）
  signal?: AbortSignal;
  priority?: number;               // 默认 0
  label?: string;                  // 默认 "extension"
}): Promise<AssistantMessage>;
```

- **实现**（`runner.createContext`）：
  ```ts
  const streamFn: StreamFn = (m, c, o) =>
    gateway.streamSimple(m, c, o, { sessionId: "?", priority, label }, signal);
  const options: SimpleStreamOptions = {
    maxTokens,
    signal,
    ...(model.reasoning && thinkingLevel && thinkingLevel !== "off"
      ? { reasoning: thinkingLevel } : {}),       // N4：复用 createSummarizationOptions 的映射（compaction.ts:558-572）
  };
  return completeSummarization(model, context, options, streamFn, retrySettings);
  ```
- **错误契约**：retry 耗尽返回 `stopReason:"error"` 消息不抛（与 `completeSummarization` 一致）；调用方查 stopReason 自行处理。
- **接线**：
  - `ExtensionRunner` 构造加 `requestGateway`（`agent-session.ts:3352` 处 `this._requestGateway` 现成）。
  - `ExtensionContextActions`（`extensions/types.ts:1715`）加 `getRetrySettings: () => RetryPolicy`（`agent-session.ts:2506` `this.settingsManager.getRetrySettings()`），reload 后取新值。
  - **无网关降级**：不传 streamFn 走 `completeSimple` 路径（与 compaction 缺省一致），文档注明。
- **与 `ModelRegistry.complete` 关系**：新 API 是正道；旧 API 保留 + 守卫（2.1），state-updater 迁移到 `completeSideRequest` 后旧 API 为兼容遗留。

### 3.2 N2 公共导出

- `packages/coding-agent/src/index.ts` 显式导出 `completeSummarization`（现只有 `generateSummary` / `generateSummaryWithUsage`）。
- `generateSummary` docstring 注明：`streamFn` 缺省走 `completeSimple`（绕网关）；side request 请用 `ctx.completeSideRequest` 或显式传网关 streamFn。

### 3.3 N1 网关身份接线

- `CreateAgentSessionOptions` 加 `requestIdentity?: RequestIdentity`；`sdk.ts:363-365` 默认 `{sessionId:"?", priority:2, label:"main"}` 不变。
- `subagent/run.ts:57` 传 `{sessionId:"?", priority:0, label:"subagent"}`——priority 0 是 `RequestIdentity` 文档已定义的值（`request-gateway.ts:21`），这是它的**首个真实使用**。
- compaction / branch-summary 保持会话身份（它们是主 turn 的组成部分，无需区分）。
- 注：`label` / `sessionId` 目前仅文档价值（`request-gateway.ts:137-140` 只消费 priority）；priority 只在配置了 `maxConcurrency` 时生效。

## 4. Batch C：预设编译

### 4.1 `ctx.compilePreset`（ExtensionContext 新增）

```ts
compilePreset(
  presetId: string,
  runtime: PromptRuntime,          // 扩展自建：options/messages/state/variables
): { messages: AgentMessage[]; systemPrompt: string; diagnostics: PromptPresetDiagnostic[] }
```

- **实现**（`runner.createContext`）：`ExtensionContextActions` 加 `getAllPresets`（`agent-session.ts:1315` `getAllPresets(): LoadedPromptPreset[]` 已存在）→ 按 id 查找，未找到 throw 并列出可用 id → `compileMessages(preset, runtime)` + `compileSystemPrompt(preset, runtime, "")`。
- **纯编译、不激活**：天然避开 autoActivate 门控坑（watchdog-feasibility §4.1：编译用预设不应被选为主预设）。
- **参照实现**：`subagent/prepare.ts:77-179`（自建 PromptRuntime + `compileMessages` 的现成模式，含 parent session 的 peer runtime 构建）。
- `PromptRuntime` 类型已公共导出（`src/index.ts:222`）；扩展自建 runtime（`options:{cwd}` / `messages` / `state: pi.getState()`）。
- state-updater 的 ~25 行 `buildPrompt` 子集删除，改用此 API（渲染行为与主引擎对齐，消除漂移）。
- 补充（非本批次）：watchdog 建成后 core 直连 `completeSummarization` + 网关（watchdog-feasibility §3.1），不走扩展层。

## 5. 验收（对齐后实现时）

1. Batch A：现有扩展/state 测试保绿；新单测——`complete()` 传重建 model（`api` 缺失）→ 同步 reject。
2. Batch B：`completeSideRequest` 单测（faux provider）——网关 identity（priority/label 传递）、retry 生效（注入瞬时错误重试）、reasoning 映射、无网关降级。
3. Batch C：`compilePreset` 输出与 agent-session 内部 `compileMessages` 对同一 preset/runtime **输出一致**（防漂移回归）。
4. 全量：`npm run check` + `./test.sh` 相关测试。

## 6. 实现顺序（对齐后）

1. Batch A（独立 5 行 + 文档）
2. Batch B（gateway 接线 → ctx 方法 → 公共导出）
3. Batch C（compilePreset）
4. 更新 state-updater-extension-findings.md（发现 #1/#2/#3/#5/#6 标注"方案已定，见本文档"）
