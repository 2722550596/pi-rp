# M4 · 状态恢复与 compaction

## 1. 一句话定位

`ToolSearchManager` 的 discovered 真相是 transcript：resume/checkout 从完整 `getBranch()` 恢复，compaction 在边界记录可恢复快照；当前 registry 只决定哪些恢复名可重新激活，不篡改历史事实。

## 2. 签名参数

建议 M1 暴露纯函数（`NEW`，具体类归属由 M1 裁决）：

```ts
export interface DiscoveredSnapshot {
  discoveredToolNames: ReadonlySet<string>;
  source: "branch" | "compaction" | "branch+compaction";
}
export interface RestoreInput {
  branch: readonly SessionEntry[];
  registryNames: ReadonlySet<string>;
  allowedNames: ReadonlySet<string> | undefined;
}
export function restoreDiscoveredTools(input: RestoreInput): DiscoveredSnapshot;
```

管理器侧：

```ts
// NEW; only mutates manager state, never session entries.
restoreFromSession(sessionManager: SessionManager): void;
```

会话侧（D4 冻结编排，AgentSession 持有；非 manager 方法）：

```ts
// NEW; called after registry/policy/model/MCP/extension refresh.
syncToolSearchState(): void;
```

compaction details 的稳定格式（版本化，便于未来演进）：

```ts
export interface ToolSearchCompactionDetails {
  toolSearch?: { version: 1; discoveredToolNames: string[] };
  // Shared deferred channel: extension-added names are included here too.
  deferred?: { version: 1; addedToolNames: string[] };
}
```

`deferred.addedToolNames` 是所有来源的并集（tool_search 与 extension），不是第二份状态真相；它只是被压掉 transcript 后的 checkpoint。

## 3. 行为契约逐步

### 3.1 恢复扫描

1. 取 `sessionManager.getBranch()`，即完整当前树路径，而不是 `buildSessionContext()` 投影（现状：前者 `session-manager.ts:1360-1384`，后者 compaction 后会丢压缩前消息，`session-manager.ts:443-500`）。漏掉这一步会在压缩后丢失 discovered。
2. 顺序扫描 branch；对 assistant/tool message 中 `toolCall.name === "tool_search"` 的调用，按 toolCallId 配对对应 toolResult，解析其成功产物中的名字；同时无条件收集每个 `ToolResultMessage.addedToolNames`。漏掉后者会使既有 extension deferred 通道在 resume 后失效（I2）。
3. 扫描 compaction entries 的 `details`；取**最近一个 compaction entry 的 details**（当前分支路径上）中的 `deferred.addedToolNames` 与 branch 结果并集。details 是快照，不覆盖后续 branch 记录；用最近 checkpoint 可避免旧分支名称污染。
4. 名称去重并保持首次出现顺序（集合语义）；恶意/损坏的非字符串、空名忽略。恢复不得因一条坏 result 使会话 resume 失败。
5. 将集合交给 active 计算：只激活仍在 registry 且通过 allow/deny 的名称。恢复出的 registry 外名称仍保留在 discovered（见 7），使以后热加载同名工具时可恢复；不应凭当前 registry 反向修改 transcript。

**扫描成本与缓存。** `getBranch()` 是 O(B)，B 为当前分支 entry 数；数千 entry 的一次 resume 扫描通常比请求构造便宜，但不应每轮重复。Manager 在 session leaf/checkout 变化时缓存 `{leafId, discoveredSet, latestCompactionId}`；新 entry 只增量扫描并集，checkout/branch 切换丢弃缓存并重新扫描目标 branch。compaction append 可直接把当前集合写入 details，并令缓存 checkpoint 对齐。不要将缓存作为持久化真相：进程重启必须可由 transcript 重建。

**漏了会怎样：** 依赖 messages 投影、仅扫描最近尾部或每请求完整重扫，分别会丢状态、遗漏旧分支工具或制造线性延迟。

### 3.2 resume 时序

`agent-session.ts:2570-2577` 直接写回 `agent.state.messages` 后，必须按以下顺序：

1. 完成 session load、注册扩展/MCP 工具和 allow/deny policy；此时 registry 是本次进程的实际集合。
2. 写回 messages 后立即调用 `ToolSearchManager.restoreFromSession(sessionManager)`；不要从 messages 投影推导。
3. 恢复完成后、首次 `syncToolSearchState()` 之前，以恢复后的 catalog 初始化 `lastAdvertisedCatalog`（D5）：resume 后模型已知晓这些工具，防止首次同步对它们误发全量 `Tools added` delta。
4. 调用 M5 的激活判定/重算，得到 eager + restored-and-available + `tool_search`（若仍有折叠未发现工具）。`setActiveToolsByName` 下一轮生效并触发 `_rebuildSystemPrompt`，现状位置 `agent-session.ts:1310-1345`。
5. 因恢复改变 active tools，必须重建 system prompt 一次；若集合与初始 registry 计算相同则跳过重复重建。[推断] 写回 messages 本身不应触发 prompt 重建。
6. 恢复完成前由 AgentSession 持有 gate：用户消息/steer 入队，工具执行不启动；恢复失败则以非激活模式继续并写诊断，随后按原序释放消息。恢复完成后只由 `syncToolSearchState()` 统一触发一次重算。

### 3.3 compaction 写入

在生成 compaction summary、调用 `appendCompaction`（现状签名及落盘 `session-manager.ts:1180-1203`）的同一临界区，统一调用 `manager.buildCompactionDetailsSnapshot()`；该 builder 扫描当前 branch 的全部 `addedToolNames` 并与 manager discovered 合并，两个 agent-session compaction 调用点（`:3277,3635`）必须共用 agent-session 辅助函数：

```ts
const details = manager.buildCompactionDetailsSnapshot();
sessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromHook, usage);
```

builder 是 details 唯一构造来源，append 前完成快照；不能在两个调用点各自拼字段。若无任何名称仍写稳定的空结构；旧 compaction/未知 details 版本按空 checkpoint 兼容。


### 3.4 动态工具集与通知

MCP server 连接/断开、扩展热加载完成、policy/preset 变化后统一走 `syncToolSearchState()`：

1. 计算 `available = registry ∩ allow/deny`；`discovered` 保持不变。
2. active 广告集 = eager ∪ (folded ∩ discovered ∩ available)，并仅在 `foldedNames` 非空时注入 `tool_search`；全部发现或无可折叠工具时不广告以保持零开销。可执行集始终保留 `tool_search`，幻觉重调时返回 `All folded tools are already loaded.`；热加载新折叠工具后 `syncToolSearchState()` 使其重新进入 active。
3. 若 active/schema 或 searchable catalog 变化，下一轮刷新 tools 和类别提示；若仅不可用名称消失，不发送虚假的“discovered”。
4. 对模型发增量通知：首选 steering 消息，备选 `custom_message`（该 entry 进入 LLM context，现状类型范围 `session-manager.ts:139-169`）；不得误写成不进 context 的 `custom` entry（`session-manager.ts:120-127`）。通知内容仅列 delta：`Tools added: ...` / `Tools removed: ...`; 名称必须经过 allow/deny 过滤，且不得伪装成 tool result。注入机制按 D4/D5 冻结口径陈述：`syncToolSearchState()` 内部先 `recompute`，再比较 `lastAdvertisedCatalog` 计算 catalog delta，delta 非空时调用 `queueToolCatalogDelta()`（首选 steering 通道），并在入队后立即更新比较基准；仅 steering 注入的底层 API 细节留待实现时核实，`queueToolCatalogDelta` 本身已冻结、不属推断。
5. 重算应合并 extension 的 addedToolNames 与 tool_search discovered；不得为 extension 另造恢复路径。

这对应外部参照中 Claude Code 的“每轮比较已告知工具集与实际集合并增量通知”（01 §3.3），但 pi-rp 仍由客户端 transcript 驱动。

**漏了会怎样：** 只刷新 active 不通知模型会让模型继续调用已卸载工具；通知全量目录会浪费上下文并造成重复搜索。

### 3.5 checkout / rollback

`getBranch()` 语义决定 checkout 回到旧分支即恢复该分支的集合：目标 branch 扫描结果 + 目标路径最近 compaction details；不得沿用被切出的兄弟分支 discovered。缓存必须按 leafId/branch identity 失效。若回滚后再切回原分支，原分支 transcript 中的名称自然恢复。[推断] 这是最符合 transcript 唯一真相及 TanStack 历史扫描语义的可预期行为。

## 4. 文件与副作用

- `packages/coding-agent/src/core/tool-search/`：恢复扫描、缓存、重算（新模块，纯逻辑可测）。
- `packages/coding-agent/src/core/agent-session.ts`：`syncToolSearchState()`（NEW，session-owned）统一承接 registry/preset/policy/model/MCP/extension 变化；内部调用 `recompute`、比较 `lastAdvertisedCatalog`、非空时 `queueToolCatalogDelta`，并在入队后立即更新比较基准。
- `manager.restore(names)` 是唯一恢复入口；`restoreFromSession()` 仅是 M4 编排函数：扫描 `getBranch()` 两类来源后调用 `manager.restore`，再调用 `syncToolSearchState()`。
- `packages/coding-agent/docs/session-format.md:93-102`：补 ToolResult 字段。

- registry 构建点归一化：`NEW normalizeDeferrable(definition: ToolDefinition, sourceInfo: SourceInfo): boolean` 将扩展/SDK customTool 的 `deferrable` 默认值与原生工具强制 eager 写入 registry；ToolSearchManager 只消费归一化后的布尔结果，不读取 `sourceInfo`。落点为 M5 的输入准备/`agent-session.ts` registry merge（`4084-4152`）及其 `wrapToolDefinition` 转发链；`reservedTools` 不作为此函数参数，而在 eager 并集逻辑处理。

## 5. 落账

落账载体是现有 compaction entry 的 `details`，而非 custom entry 或新增类型。完整 branch 仍是权威，details 只是压缩丢失历史后的 checkpoint。`manager.buildCompactionDetailsSnapshot()` 是唯一 details builder；agent-session 的两个 compaction 调用点（`agent-session.ts:3277,3635`）通过同一辅助函数写入。动态通知若采用 R10 备选 `custom_message`，它是模型可见的通知审计记录，不是状态来源；首选 steering 不落 session transcript。

## 6. 前端或 RPC 可见性

恢复/重算本身不新增 RPC。模型请求可见 active tools 与类别提示；动态变化通知可见于 steering/user message。UI 可显示 added/removed 摘要，但不得显示为工具执行结果。恢复出的 unavailable 名称不应暴露给模型搜索目录，避免诱导调用不存在工具。

## 7. 错误边界

- details 缺失、旧版本或 JSON 类型错误：按空 checkpoint，继续扫描 branch。
- toolCall 无配对 result、result 非 JSON 或名字未知：跳过该项，不阻断 resume。
- registry 卸载：保留 discovered 名称但不加入 active/catalog；若模型调用该名，走 R8 引导文案（M1 §3.5 冻结原文：`Tool 'X' is available but not yet loaded. Call tool_search with query "X" to load it.`），仅适用于仍注册但折叠的工具；已卸载名称应走真正的 `Tool X not found`，不得误导搜索。
- compaction 写失败：不得宣称恢复成功；沿用 session append 错误处理，下一次仍可从 branch 尝试恢复。
- 并发：`restoring` gate 下排队用户消息/steer 与工具执行；恢复完成后按原序释放。若工具 registry 在 gate 内变化，只保留最后一次 `syncToolSearchState()`，使用最终 registry 计算，避免中间状态请求。abort（D11 定稿）：恢复 gate 期间收到 abort → 取消恢复流程，会话以非激活模式继续并写诊断记录；已恢复的部分保留（`restore` 幂等，无需回滚）。

## 8. 代码落点（精确到文件与函数）

- `session-manager.ts:getBranch`（1360-1384）：扫描入口；`appendCompaction`（1180-1203）：传入 details。
- `agent-session.ts` resume 段（2570-2577）：写 messages 后 restore，再 `_syncActiveToolPolicy`/active refresh。
- `agent-session.ts:setActiveToolsByName`（1310-1345）：恢复后的生效点与 prompt rebuild。
- deferred 读取/传播：`packages/agent/src/agent-loop.ts:784-788`；extension 产生 diff：`packages/coding-agent/src/core/extensions/wrapper.ts:15-46`。
- `packages/coding-agent/docs/session-format.md:93-102`：接口文档 diff。

## 9. 与现状差异

1. 现状 ToolResult 文档漏 `addedToolNames`，虽然实际落盘并由 loop 传播（`agent-loop.ts:784-788`）。

2. 现状 compaction details 是泛型扩展字段，没有 tool-search/deferred 约定（`session-manager.ts:91-101,1180-1203`）。
3. 现状 resume 只写回 `agent.state.messages`（`agent-session.ts:2570-2577`），没有 ToolSearchManager 恢复步骤。
4. 现状没有 coding-agent 的 `active_tools_change` entry；该 entry 仅为新 harness 先例（`packages/agent/src/harness/session/types.ts:39-42`）。

## 10. 验收测试

- **恢复等价**：fixture 含早期 tool_search、extension `addedToolNames`、compaction 后尾部调用；resume 集合等于压缩前集合。
- **最近 checkpoint**：分支 A/B 各自 compaction details，checkout 后只恢复目标 branch 集合。
- **动态生命周期**：MCP add/remove 与 extension reload 后 active、catalog、delta notification 均正确；deny 名称不进入任一输出。
- **缺失 registry**：恢复名暂不可用不 active；同名重新注册后自动 active，不需重新搜索；真实卸载调用保持 `Tool X not found`。
- **并发**：restore gate 期间消息/工具不先执行；registry 多次变化最终只产生一次等价重算。
- **性能**：一次 O(B) 扫描；相同 leaf 不重复扫描；append-only 增量不重扫历史。
- **文档**：检查 session-format 代码块包含精确字段。

## 11. 发现的冲突

- 冻结 R6 要求“最近 compaction details 并集”；若实现把所有历史 compaction details 并集，会把兄弟/已回滚历史污染当前状态，故本文限定为当前 `getBranch()` 上最近一条。若主代理解释为全量 compaction 并集，需裁决后改文档。
- 冻结 R6 未规定 details 顶层 shape；本文提出版本化 `toolSearch` + 共享 `deferred`。若 M1 已冻结不同字段名，必须统一而不能双写两个真相字段。
- D2/D7 已裁决：`restore(names)` 是 manager 唯一恢复入口；`restoreFromSession()` 只负责扫描两类 transcript 来源并调用它，再由 `syncToolSearchState()` 重算。不得在本文或实现中写成 `discover` 与 `restore` 二选一。

## 12. 仍未知待拍板

1. append 前快照原子性：`buildCompactionDetailsSnapshot()`（D6 唯一 builder）产生的快照必须与 `appendCompaction` 在同一临界区完成，不被并发状态变化打断；builder 归属与两个调用点共用辅助函数已由 D6 裁决。
2. restore gate 的队列容量（建议无界逻辑队列改为单 pending flag，保留用户消息顺序）；abort 行为已按 D11 定稿为正文契约（见 §7「并发」）。
3. 恢复名字是否区分 source/version（当前契约只按字符串名；同名覆盖 registry 现状见 `agent-session.ts:4084-4152`）。

## 附录 · I1 精确文档 diff

文件：`packages/coding-agent/docs/session-format.md`，`ToolResultMessage` 接口（当前 `:93-102`）：

```diff
 interface ToolResultMessage {
   role: "toolResult";
   toolCallId: string;
   toolName: string;
   content: (TextContent | ImageContent)[];
   details?: any;      // Tool-specific metadata
+  addedToolNames?: string[]; // Deferred tools made available by this result
   usage?: Usage;      // Nested LLM work performed by the tool
   isError: boolean;
   timestamp: number;
 }
```

字段名、可选性、数组类型与实际 `ToolResultMessage`/落盘约定一致；不要改成 `details` 子字段，否则 provider deferred 通道不会读取。

## 附录 B · 与 M1/M2 接口仲裁的对齐

恢复完成后不要直接私写 manager 内部集合；统一经 D2/D7 冻结的唯一恢复入口 `manager.restore(names)` 建立 discovered（接受 transcript 超集，含当前 catalog 之外与已 deny 的名称），再调用：

```ts
const result = manager.recompute(input); // { activeToolNames, activated, changed }
```

M2 只在 `changed` 时调用 `setActiveToolsByName(result.activeToolNames)`；该函数逐名查 registry，未知恢复名静默忽略，随后重建 `_baseSystemPrompt` 并应用动态 prompt（`agent-session.ts:1310-1345`）。恢复输入不做 allow/deny 预过滤（超集语义，C1）；不变量是 discoveredNames 的任何下游使用（active 计算、catalog、搜索结果、R9 类别段）必须经过 `available = registry ∩ allow/deny` 过滤，被 deny/已卸载的名称因此零泄漏。

tool_search builtin 路径不会经过 extension wrapper；因此其 `addedToolNames` 由 M3 经 `manager.filterNewNames` 只读筛选后写入 execute 结果（D3：execute 不得调用 `discover`），真正的登记与 active 刷新统一由 D1 批次回调完成。extension wrapper 的自动 diff 仅适用于 extension 注册工具，并且当 execute 窗口内 active 集合有任何缩减时会抑制整次 addedToolNames（`extensions/wrapper.ts:15-46`，主代理核实）。动态刷新必须放在工具执行批次边界，且执行窗口内只允许增量、不允许缩减，否则 I2 的共享恢复标记会静默丢失。
