# 评审 B：闭环性与可实施性

> 评审代理 ReviewerB（scout）产出；因 write 设备限制由主代理代为落盘，内容未改动。总体判定：**不通过**。

## 1. 闭环性

### blocker — M2 没有落到现有 loop 的批次完成调用点
- 位置：`20-agent-loop接线.md` §3 步骤 5、§8 项 3、§11；`10-ToolSearchManager核心状态机.md` §8。
- 证据：M2 写的是"coding-agent 消费本批 result 的 `addedToolNames`"，但 §11 明确"若没有现成批次完成回调……建议新增 `afterToolCallBatch` 或在 `prepareNextTurn` 消费……需核实"；M2 §12.2 仍把具体接线列为未知。源码可复现：`packages/agent/src/agent-loop.ts:450-510` 只有逐工具 `prepareToolCall`/执行路径，`:96-145` 是 loop 入口；设计没有给出哪个现有 callback/返回值承载整个 batch 的 `ToolResultMessage[]`。
- 后果：实现正确的接口可能无人调用，下一轮仍无真实 schema。
- 建议：冻结唯一 seam（优先 `runAgentLoop` 的 batch-end callback 或 coding-agent 明确的 turn-result 消费点），写出生产函数名、调用方向、输入/输出和异常/abort 语义。【已裁决 D1】

### blocker — M1 与 M3 的 tool_search 参数契约不一致【已裁决 B1，已修】

### major — M4 动态通知没有具体发送者、API 或生命周期调用点【已裁决 D4/D5】
- 证据（节选）：M4 只写"统一走 reconcileRegistry""首选 steering，备选 custom_message"，标注"具体注入 API 需实现时核实"。源码已有队列位置：`agent-session.ts:462-469,935-965`、扩展 API `extensions/types.ts:462-465`，但未规定调用者、通道选择、一次性保证。

### major — compaction details 的快照所有权和 extension added 集合无闭环【已裁决 D6】
- 证据（节选）：M4 未定义 extension added 集合由谁维护/从哪读；§12.1 将组装方列为未知。两个现存 compaction 调用点 `agent-session.ts:3277-3278,3635-3637`、append API `session-manager.ts:1181-1203`。

### major — discovered 恢复入口与 M1 的过滤语义仍有双轨【已裁决 D7】

### major — M5 的 normalizeDeferrable 虽统一签名，但唯一调用点未落地【已裁决 D8】

### minor — M1 定义了 getToolSearchDefinition，但没有唯一注册调用者【已裁决 D13】

### note — M1 active 输入与 M5 ownership 描述不够单一
- M5 只输出 activation decision；M1 只接收 decision 并维护状态，去掉同名 recompute 的歧义。

## 2. 代码落点精确性（抽查）

### major — 至少一处 §8 行号/结构断言已与源码不一致
- `50-配置与激活策略.md` §8 声称 `BuildSystemPromptOptions` 输入位于 `agent-session.ts:1545-1564`；源码当前 `:1524` 是 `_rebuildSystemPrompt(toolNames: string[])`，非 options 形态；`setActiveToolsByName` 真实落点 `:1331-1346`。【已裁决 D12】
- 复现：`grep -n "private _rebuildSystemPrompt\|setActiveToolsByName" packages/coding-agent/src/core/agent-session.ts`

### note — 其他抽查落点基本存在
`agent-session.ts:1331-1346`、`:1870-1871`、`:3277`、`:3635`；`session-manager.ts:1181`；`agent-loop.ts:598`；`extensions/types.ts:516`；`source-info.ts:6`；`tool-definition-wrapper.ts:5`；`estimate.ts:109`（仍未导出）；`session-manager.ts:1360` 附近 getBranch 存在。

## 3. 依赖方向

- note：M2 resolver 方向正确，无 packages/agent → coding-agent 反向依赖。callback 类型建议放 `AgentLoopConfig` 实际定义文件。
- note：estimate 导出方向正确，实现时仅改 export。

## 4. 时序完整性

### blocker — 完整生命周期在"发现→下一轮注入"处断链【即 D1，已裁决】
### major — 启动/模型切换/动态 registry 刷新的统一触发器缺失【已裁决 D4：syncToolSearchState】
- 源码 `agent-session.ts:3932-3935` 可见 `setActiveTools`/`refreshTools` 扩展接口，文档未说明如何触发 manager recompute。

## 5. "漏了会怎样"真实性抽查（8 条）

1. `30` §3.1 绕过 manager 泄露 deny —— **真实**。
2. `30` §3.3 非法 regex 阻断 loop —— **部分真实**；不能把结构拒绝称作硬保证，应标为风险。
3. `30` §3.6 AND/OR 颠倒 —— **真实**。
4. `30` §3.7 pattern+keywords 非 AND —— **真实**。
5. `30` §3.9 先截断再排序丢高相关 —— **真实**。
6. `20` §3.2 批次中途改 context.tools —— **真实**。
7. `40` §3.4 只刷新不通知 —— **部分真实**；后果应表述为"可能继续调用/无法获知 delta"，不是必然。
8. `50` §3.7 reservedTools 不计入 threshold 改变 auto 结果 —— **真实**。

## 6. 跨端/跨层契约两端同批

- note：M2 resolver 两端接口方向一致；缺口是 batch-end active refresh（D1）。
- major：R2 wire 断言"已发现未调用"前提依赖未定义的历史写入——M6 需构造完整 assistant toolCall + toolResult 历史，不能只改 manager 内存。【已裁决 D15】
- minor：M6 "other provider"与 Kimi 普通 schema 行为合并叙述，建议保留独立 wire 断言。

## 总体判定：不通过

理由：两个 blocker 直接阻止端到端实现；R10 通知、compaction details、恢复入口仍有 major 级闭环缺口。依赖方向本身通过，代码落点大多可核实，但不足以抵消生命周期断链。
