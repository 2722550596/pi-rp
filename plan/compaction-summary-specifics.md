# Compaction / Branch-Summary 的特殊性与正则审计

> 状态：审计记录，暂不优化
> 关联：[watchdog-system.md](./watchdog-system.md) §9 待推敲 #7
> 创建：2026-08-11

## 1. 背景

watchdog-system.md §9 #7 提出"compaction 本质是触发式 side request，未来可重新定义为内置 watchdog"。本文档记录 compaction 和 branch-summary 的架构特殊性，解释为什么**现在不合并**，以及审计中发现的两个正则 bug。

## 2. 架构现状

compaction 和 branch-summary 都**不走预设编译器**（`compileMessages`），而是硬编码 prompt + `hiddenOverrides` 覆盖：

| 维度 | compaction | branch-summary | watchdog（方案） |
|---|---|---|---|
| prompt 构建 | 硬编码 `SUMMARIZATION_PROMPT`（`compaction.ts:475`） + `hiddenOverrides.compaction`（`agent-session.ts:2502`） | 硬编码 `BRANCH_SUMMARY_PROMPT`（`branch-summarization.ts:260`） + `hiddenOverrides.compaction.branchSummaryPrompt`（`agent-session.ts:3740`） | `compileMessages(preset, runtime)` |
| 触发 | token 阈值（`shouldCompact`，`compaction.ts:246`） | 树导航（`collectEntriesForBranchSummary`，`branch-summarization.ts:110`） | turn / trace / idle |
| 输出语义 | **破坏性**：替换消息为 summary（`sessionManager.appendCompaction`） | 增量：变成 `branchSummary` role 消息 | 增量：custom message / event / status bar |
| 特有逻辑 | cut-point 检测 + token 预算 + turn-prefix summary + 文件操作追踪 + overflow 自动重试 | branch entry 收集 + token 预算 | 无 |

## 3. 为什么现在不套 watchdog 架构

能共享的层（prompt 构建 → LLM 调用 → retry → epoch guard → 返回 text）确实重叠，但 compaction 有三块 watchdog 架构不覆盖的逻辑：

1. **破坏性输出语义**：compaction 把消息替换成 summary，不是增量注入。watchdog 的 delivery 模型（nextTurn / steer / eventBus / statusBar）全是增量。
2. **cut-point 检测**：`findCutPoint`（`compaction.ts:411`）基于 token 预算和 turn 边界，决定保留哪些消息。watchdog 无此概念。
3. **overflow 自动重试**：compaction 在 context overflow 时移除 assistant 消息、compact、自动重试（`agent-session.ts:2647` `_checkCompaction`）。这是 compaction 独有的恢复语义。

合并会让 watchdog 的 ~300 行膨胀到 ~800+，且 Phase 1 验证目标（"watchdog 能跑"）会被拖慢。

**结论**：watchdog 先独立实现，从中抽 `sideRequestExecutor`（构建 PromptRuntime → compile → complete → retry → epoch guard → 返回 text）。后续 compaction refactor 成 side-request 消费者，但触发 / 裁剪 / 替换逻辑保留。维持 watchdog-system.md §9 #7 方向。

## 4. 正则审计：两个 BUG

预设正则有 4 个 effect：`outgoing`（prompt→LLM 过滤）、`display`（TUI 渲染）、`both`、`finalize`（LLM→输出后处理）。一个"用预设的系统"要完整支持正则，需要 **outgoing（构建 prompt 时）+ finalize（处理 LLM 输出时）**。

逐个审计：

| 系统 | outgoing | finalize | 状态 |
|---|---|---|---|
| 主 agent 循环 | ✓（compiler 内置，`compiler.ts:121,137`） | ✓（`agent-session.ts:887`） | OK |
| subagent | ✓（compiler 内置） | ✓（subagent 自有 session，同 line 887 路径） | OK |
| compaction | ✓（`agent-session.ts:2586-2601` `_applyPresetToCompactionPreparation`） | ✗ | **BUG 1** |
| branch-summary | ✗ | ✗ | **BUG 2** |
| watchdog（方案） | ✓（compiler 内置） | 待确认 → 必须支持 | 见下 |

### BUG 1：compaction summary 输出没有过 `finalize` 正则

**位置**：`agent-session.ts:2504`，`summary = result.summary` —— raw LLM 输出，直接落盘。

compaction summary 是 LLM 输出（`compact()` → `generateSummaryWithUsage()` 返回 text，`compaction.ts:639`），应过 `finalize`。现在用户在预设里写了 `finalize` 规则（如"提取 JSON"），compaction summary 不触发。

**修复方向**：拿到 `summary` 后，包成 assistant message → `applyFinalizeRegexRulesToMessage(preset, msg, diags)`（`regex-engine.ts:123`） → 取回 text。注意 `extensionCompaction` 分支（`agent-session.ts:2483`）的 extension-provided summary 是否也过 finalize，需确认。

### BUG 2：branch-summary 完全没有正则

**输入侧**：`branch-summarization.ts:329`，`convertToLlm(messages)` —— 没有 `applyRegexRulesToMessages`。compaction 有等价的 `_applyPresetToCompactionPreparation`（`agent-session.ts:2580`），branch-summary 没有。

**输出侧**：`branch-summarization.ts:368`，`summary = contentText(response.content)` —— raw，没有 `finalize`。

branch-summary 消费了 `hiddenOverrides.compaction.branchSummaryPrompt`（`agent-session.ts:3740`），是预设消费者，却零正则。

**修复方向**：
- 输入侧：`generateBranchSummary` 内或 `agent-session.ts:3728` 调用前，加 `applyRegexRulesToMessages(preset, messages, "history", "outgoing", diags)` + `applyRegexRulesToMessages(preset, messages, "compiled", "outgoing", diags)`。
- 输出侧：`contentText(response.content)` 后包成 assistant message → `applyFinalizeRegexRulesToMessage` → 取回 text。

### Watchdog：必须支持 finalize

watchdog 输出是预设编译的 prompt 的 LLM 回复，跟主 agent 的 assistant message 本质相同。`#execute` 里 LLM 调用后、delivery 前必须加 `finalize`：

```ts
const finalizeDiags: PromptPresetDiagnostic[] = [];
const finalized = applyFinalizeRegexRulesToMessage(instance.preset, response, finalizeDiags);
const sourceMsg = finalized ?? response;
const text = sourceMsg.content
    .filter((c): c is TextContent => c.type === "text")
    .map(c => c.text)
    .join("\n");
```

这样"提取 JSON"之类的后处理写在预设里，转译扩展不用手写。watchdog-system.md §9 #11 从"待推敲"移到"已确认：必须 apply finalize"。

## 5. 修复优先级

- BUG 1、BUG 2：**必须修**，不影响 watchdog 实现，可在 watchdog 之前或之后单独修。
- watchdog finalize：watchdog 实现时一并做，无额外工作量。

## 6. 未来优化方向（留待后续）

1. 抽 `sideRequestExecutor`，watchdog 先用。
2. compaction refactor 成 side-request 消费者，保留 cut-point / 破坏性替换 / overflow 重试。
3. branch-summary 同理，保留 branch entry 收集。
4. 届时 BUG 1、BUG 2 自然消除（统一走 `sideRequestExecutor` 的 outgoing + finalize）。
