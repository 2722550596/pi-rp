# 20 · agent loop 接线

## 1. 一句话定位
本模块把 coding-agent 的 `ToolSearchManager` 状态变化接到通用 `packages/agent` loop：搜索结果只在当前批次完成后更新 active 工具，重建 system prompt，并由下一次 `streamAssistantResponse` 使用；agent 包通过通用回调识别“折叠但未发现”，不依赖 coding-agent。

## 2. 签名参数

扩展 `AgentLoopConfig`（`packages/agent/src/agent-loop.ts`）而不是让 agent import coding-agent：

```ts
// NEW
export type ToolAvailability =
  | { kind: "available" }
  | { kind: "deferred"; guidance: string };

// NEW, optional: 未注册工具仍返回 undefined；折叠状态由上层注入
export type ResolveToolAvailability = (
  toolName: string,
  context: AgentContext,
) => ToolAvailability | undefined | Promise<ToolAvailability | undefined>;

interface AgentLoopConfig {
  resolveToolAvailability?: ResolveToolAvailability;
  // NEW: exactly once after each complete tool batch is finalized and written
  onToolBatchCompleted?: (
    toolResults: ToolResultMessage[],
    context: AgentContext,
  ) => void | Promise<void>;
  // existing fields...
}
```

`coding-agent` 注入 resolver：对 registry 中存在且属于 folded、尚未 discovered 的名字返回 `{kind:"deferred", guidance}`；其它名字返回 undefined。精确文案及 query 建议由 M1 的 `ToolSearchManager` 提供，agent 只负责把 guidance 作为 tool result 文本返回。

ToolSearchManager 与 session 的最小调用面按 M1 仲裁接口为：

```ts
manager.getActiveToolNames(): readonly string[];
manager.recompute(input): {
  activeToolNames: string[];
  activated: boolean;
  changed: boolean;
  toolSearch?: ToolDefinition;
};
manager.filterNewNames(names: string[]): string[];
manager.restore(names: string[]): void;
manager.isFoldedAndUndiscovered(name: string): boolean;
manager.getGuidance(name: string): string;
```

`tool_search.execute` 只读调用 `filterNewNames`; 它不得调用 `discover`。唯一登记入口是 `onToolBatchCompleted` 回调：session 扫描 `addedToolNames`，调用 manager `discover`，若 changed 则以 active 名单调用 `setActiveToolsByName` 并重建 prompt。M3 负责检索与 result 内容，不在 agent loop 里复制搜索算法。deny 过滤必须先于目录生成。

## 3. 行为契约逐步（每步写“漏了会怎样”）

1. 回合开始由 `context.tools` 提供本轮快照；`streamAssistantResponse` 将它和 `context.systemPrompt` 一起发出（现状 `agent-loop.ts:279-300`）。**漏了会怎样：** active 集合变更若只改 manager，不改 AgentContext，下一请求仍发送旧工具。
2. assistant 返回一批 tool calls 后，loop 按批次执行（现状 `agent-loop.ts:221-243`），不得在批次中途改写 `context.tools`。**漏了会怎样：** 同一 assistant 消息的调用会出现顺序依赖、部分调用看到不同工具集，并破坏 provider 请求与 tool result 配对。
3. `prepareToolCall` 先按当前快照解析工具；真正 registry 不存在时保持现有 `Tool X not found`。若解析失败，调用注入的 `resolveToolAvailability`；若返回 deferred，生成普通 `isError` tool result，正文为 M1 精确引导文案，不抛异常。**漏了会怎样：** 折叠工具被误报为不存在，模型无法自纠；或把任意幻觉名字当成可用工具。
4. `tool_search` 执行只读调用 `filterNewNames` 并返回 `addedToolNames`（R3）；`createToolResultMessage` 已将该字段传播（`agent-loop.ts:775-788`）。**漏了会怎样：** provider 的既有 deferred 通道和恢复扫描看不到发现事件；若 execute 直接 discover，则会造成双刷新。
5. 唯一批次 seam 是 `onToolBatchCompleted`：一批所有工具 finalize 且 tool result 写入 context 后、下一次 `streamAssistantResponse` 前调用一次。coding-agent AgentSession 扫描本批 `addedToolNames`，调用 manager `discover`；changed 时以 manager active 名单调用 `setActiveToolsByName` 并重建 system prompt。**漏了会怎样：** 搜索虽有结果，下一请求仍没有真实 schema；若批内刷新则破坏快照和 wrapper diff。
6. tool_search definition 的唯一注册来源是本 seam 对应的 active 组装：仅当 `recompute` 返回 `activated=true` 且 `foldedNames` 非空时追加 `getToolSearchDefinition()`；不得由 M3 execute 或其它注册路径重复添加。**漏了会怎样：** 请求出现重复工具定义，或无折叠时违反零开销。
7. 刷新发生在下一次 `streamAssistantResponse` 之前，因此新增工具下一轮生效；steering/follow-up 继续沿用现有轮询（`agent-loop.ts:168-279`）。**漏了会怎样：** 新工具错误地在同一批执行，或消息丢在旧 prompt 后。

### 同轮命中后继续调用的裁定
严格采用 R8/TanStack 自纠错：tool_search 命中与其它 tool call 同属一个 assistant 批次时，新工具不在本轮 `context.tools`，调用返回引导性 error result；不允许执行。该错误是正常控制流，不终止 loop；该批完成后刷新，下一次 assistant 请求才能调用真实工具。理由是 active 集合是请求快照，允许批内动态注入会导致 provider payload、并发批处理和审计历史不一致；TanStack 同样在批次结束后刷新（01 §4 第 6、7 点）。

### `addedToolNames` 的同轮影响
同一批中其它调用不因某个 tool_search result 而获得新工具。`addedToolNames` 仅写入该 result 并在批次收束阶段消费；下一轮请求的 tools 才变化。重复发现不得触发刷新（M1 `changed=false`），但 result 仍可按 R3 只携带此前未发现名字，通常为空。

## 4. 文件与副作用

- `packages/agent/src/agent-loop.ts`：新增 availability callback；在 `prepareToolCall` 的未知工具分支接入；不持有 manager、不写 session。
- `packages/agent/src/types.ts`：如 `AgentLoopConfig`/相关 callback 类型实际定义于此，放公开类型；以实际导出位置为准，避免重复类型。
- `packages/coding-agent/src/core/agent-session.ts`：创建 manager；把 resolver 注入 loop；消费批次新增工具，更新 `agent.state.tools`，调用既有 prompt rebuild 路径（`agent-session.ts:1310-1345`）。
- `packages/coding-agent/src/core/tool-search/`：M1 状态机及合成工具；M3 execute 只读调用 `filterNewNames`，批次 seam 统一 discover。

副作用是 `agent.state.tools`、`context.tools` 与 system prompt 的下一轮快照变化；session transcript 追加正常 `toolResult.addedToolNames`，不新增 entry 类型（R6）。

## 5. 落账

发现结果随 `ToolResultMessage.addedToolNames` 落入 JSONL（字段传播现状 `packages/agent/src/agent-loop.ts:775-788`；session-format 文档欠账由 M4 修复）。manager 的 discovered 真相源仍是完整 branch 扫描和 compaction details（R6），不是 loop 内存。刷新不新增 `active_tools_change` entry：该 entry 仅是 agent 新 harness 的先例，coding-agent 当前没有，且 R6 禁止新增持久化类型。

## 6. 前端或 RPC 可见性
- 折叠未发现：resolver 返回 guidance；生成 error tool result，`isError=true`，不抛异常、不 terminate。
- 真未注册：resolver 返回 undefined，保留现状 `Tool X not found`（事实 `agent-loop.ts:650-659`）。
- resolver 自身抛错：按 `Tool X not found` 生成 error tool result，但必须把异常写入 session 诊断日志/可观测通道；不得把 resolver 异常静默伪装成“折叠状态”，也不得中断 loop。
- 搜索 execute 失败：按普通工具 execute 错误处理；不会更新 active 集合，下一轮仍使用旧快照。
- `onToolBatchCompleted` 抛错：记录 session 诊断，不中断 loop；本批结果已落账，下一轮继续旧 active 快照。
- `setActiveToolsByName` 遇未知名：沿用现状逐名查 registry、忽略未知名（`agent-session.ts:1310-1345`）。
- abort/terminate：沿用现有 batch 语义；刷新不得覆盖 terminate。

## 8. 代码落点（精确到文件与函数）
1. `packages/agent/src/agent-loop.ts:598-666` `prepareToolCall`：工具查找失败后调用 resolver；deferred 返回 guidance，resolver 异常按现状 not found 并交由 session 诊断。
2. `packages/agent/src/agent-loop.ts:221-243`：在工具批次结果写入 `currentContext.messages` 后、下一次 `streamAssistantResponse` 前，唯一调用 `onToolBatchCompleted(toolResults, currentContext)`；回调异常捕获并诊断，不中断 loop。
3. `packages/agent/src/agent-loop.ts:668-788`：保持 execute/finalize/result message 流程；`addedToolNames` 由 result 传播。
4. `packages/coding-agent/src/core/agent-session.ts:1310-1346`：AgentSession 唯一实现 seam，扫描 added names → manager.discover → changed 时 setActiveToolsByName/_rebuildSystemPrompt；active 组装处是 tool_search definition 唯一注册来源。
5. `packages/coding-agent/src/core/agent-session.ts:~1560-1625`：R9 类别段由 M5 接入；每次 active 变化只重建一次。
6. `packages/coding-agent/src/core/agent-session.ts:~4084-4157`：resolver 查询 allow/deny 过滤后的 registry，deny 工具不可搜、不可引导。

依赖方向：`packages/agent` 只依赖自身类型与 callback；`packages/coding-agent` 依赖 agent 公共 API，并注入闭包。绝不让 agent import `ToolSearchManager` 或 coding-agent 类型。

## 9. 与现状差异

现状 unknown tool 统一返回 `Tool X not found` 且不中断 loop（`packages/agent/src/agent-loop.ts:650-659`）；本方案增加可选 resolver，仅对折叠未发现名字返回引导，resolver 异常仍返回同样 not found 但写 session 诊断。现状 active 刷新由 `setActiveToolsByName` 触发 prompt 重建；本期固定唯一批次 seam，保证下一轮生效。

性能上：搜索命中批次最多触发一次 active 计算和一次 `_rebuildSystemPrompt`；不得为每个 added name 单独重建；无新名字时零刷新。未激活/无折叠时 active 组装不注册 tool_search，保持零开销。

## 10. 验收测试
- `onToolBatchCompleted` 恰好每工具批次调用一次，调用点在结果写入 context 后且下一次请求前；抛错只诊断、不终止 loop。
- assistant 同批调用 `tool_search(A)` 与 `A`，A 得到引导错误；批次结束后下一请求才含 A。
- execute 只读 `filterNewNames`，D1 seam 才调用 discover；重复名字不触发第二次 prompt rebuild。
- tool_search definition 仅在 activated 且 foldedNames 非空的 active 组装处出现；无折叠时不出现且不重复注册。
- steering/follow-up、deny 封闭性、abort/terminate 与零开销路径按现有清单验证。

## 11. 发现的冲突

无。D1 已冻结 `onToolBatchCompleted` 的公共 seam、唯一调用点和异常语义；D3 已冻结 execute 只读筛选、discover 仅由 seam 触发；D13 已冻结 definition 唯一注册来源；D18 已冻结 resolver 异常的 not-found + session 诊断语义。

## 12. 仍未知待拍板

无本模块阻塞项。`AgentLoopConfig` 与 `ToolResultMessage` 的实际公开导出文件位置需实现阶段按现有导出结构落点，但不改变契约。
