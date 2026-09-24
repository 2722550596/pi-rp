# 10 · ToolSearchManager 核心状态机

## 1. 一句话定位

`ToolSearchManager` 是 coding-agent 层的纯逻辑状态机：在 allow/deny 已过滤的注册表快照上维护“可折叠但尚未发现”的工具、已发现工具，并计算下一轮应暴露给模型的 active 工具集合；它不持有 session、不读取 transcript、不执行搜索匹配，也不直接调用 `setActiveToolsByName`。

本设计遵守 `00-共同上下文.md` 的 R1–R9。外部实现参照是 TanStack 的 `LazyToolManager`（`01-外部参照.md:53-65`），但 pi-rp 的合成工具只返回摘要，完整 schema 在下一轮作为真实工具注入（R3）。

## 2. 签名参数

### 2.1 目录与输入类型（`packages/coding-agent/src/core/tool-search/manager.ts`，NEW）

```ts
import type { TSchema } from "@sinclair/typebox";
import type { ToolDefinition } from "../extensions/types.ts";

export interface ToolSearchEntry {
  name: string;
  description: string;
  promptSnippet?: string;
  parameters: TSchema;
  deferrable: boolean;
}

export interface ToolSearchManagerInput {
  /** allow/deny 后仍可见的注册工具；不得传入 deny 工具。 */
  tools: readonly ToolSearchEntry[];
  /** R5 已由 M5 判定的激活结果；manager 不重复实现 token 估算。 */
  active: boolean;
  reservedTools?: readonly string[];
}

export interface DiscoverResult {
  newNames: readonly string[];
  alreadyDiscovered: readonly string[];
  changed: boolean;
}

export interface ActiveToolsResult {
  activeToolNames: readonly string[];
  activated: boolean;
  changed: boolean;
}

export interface ToolSearchManager {
  recompute(input: ToolSearchManagerInput): ActiveToolsResult;
  discover(names: readonly string[]): DiscoverResult;
  restore(names: readonly string[]): void;
  discoveredSnapshot(): readonly string[];
  hasDiscovered(name: string): boolean;
  getActiveToolNames(): readonly string[];
  getSearchableTools(): readonly ToolSearchEntry[];
  isFoldedAndUndiscovered(name: string): boolean;
  getGuidance(name: string): string | undefined;
  filterNewNames(names: readonly string[]): readonly string[];
  getToolSearchDefinition(): ToolDefinition;
}
```

上面类和接口均标记 `NEW`；实际实现可以把接口写成 `export class ToolSearchManager` 的公开方法，不得以 session callback 替代纯状态输入。返回的数组必须是稳定快照（或不可变副本），调用者不能通过 `push` 改写内部状态。

### 2.2 状态

- `catalog`: 当前 allow/deny 后工具的 `Map<string, ToolSearchEntry>`。
- `foldedNames`: 当前激活策略下可折叠工具名集合。
- `discoveredNames`: transcript 事实超集，可包含当前 catalog 外名称（热加载恢复）；所有 active/search/catalog 使用前必须与当前 allow/deny 后 registry 求交集。
- `activeNames`: 最近一次计算的实际工具名集合。
- `activated`: 当前是否启用 tool search。

构造函数只初始化空状态；首次 `recompute` 建立目录。实例由 AgentSession **per-session 持有**，在 session 创建/恢复完成后构造，不能做模块级 singleton，避免两个 session 互相污染。[推断] 具体构造行由 M2 接到 AgentSession 初始化路径。

## 3. 行为契约逐步

### 3.1 重算注册快照

1. M2/M5 先生成 registry，并完成 allow/deny；将结果和 M5 判定的 `active` 传给 `recompute`。R7 顺序是 registry → allow/deny → 折叠过滤 → active（`00:94-103`）。漏掉 allow/deny 前置会让 deny 工具进入搜索目录，违反 deny 封闭性。
2. 对每个工具计算 deferrable：原生 `read/bash/edit/write/grep/find/ls` 强制 `false`，即使其声明 `deferrable: true` 也不得折叠；其他工具遵守显式 `deferrable`，缺省扩展/SDK customTools 按 R5 默认可折叠处理，原生工具仍优先兜底。漏掉代码层兜底会使原生工具在大目录中消失。
3. 若策略判定 `active=false`，`foldedNames` 为空，`activeNames` 等于 catalog 全部名称，且不注入 `tool_search`。漏掉该分支会破坏 `mode=off` 零开销。
4. 若策略判定 `active=true`，`foldedNames` 为可折叠且未发现的工具；`activeNames` = 非 folded 工具 + 已发现工具。仅当 `foldedNames` 非空时追加 `tool_search` 广告工具；无可折叠工具（包括全部已发现）时不进入 active。漏掉该条件会让会话全程承担合成工具开销。
5. 从激活变为不激活时保留 `discoveredNames`，并从 active 移除 `tool_search`；不得把已发现工具抽走。热加载新折叠工具后经 `syncToolSearchState` 重算，`foldedNames` 非空时 `tool_search` 自动重新进入 active。
6. 注册刷新、preset allow/deny 变化、模型切换均触发重算。preset 切换的现状接线为 `_syncActiveToolPolicy`（`agent-session.ts:1860-1872`）；模型阈值判定由 M5 提供。

### 3.2 发现与幂等

`discover(names)` 只处理当前 `foldedNames` 中的名称：

- 首次命中加入 `discoveredNames`，返回 `newNames`；重复命中返回 `alreadyDiscovered`，不得重复 `addedToolNames`，也不得制造 active 刷新。
- 非折叠、deny 不可见、未知名称不加入状态；搜索实现（M3）负责不把它们作为可命中结果返回。
- 发现后立即重算内存中的 `activeNames`：折叠工具进入 active；若仍有未发现 folded 工具则保留 `tool_search`，否则移除其广告。M2 在下一轮把 active 名称应用到 session。
- `changed` 仅在 `newNames.length > 0` 时为 true。该规则对应 TanStack 的 `hasNewlyDiscoveredTools`（`01:61-64`）。

### 3.3 active 集合

纯计算等价于：

```ts
const eager = all.filter((t) => !foldedNames.has(t.name));
const discovered = all.filter((t) => foldedNames.has(t.name) && discoveredNames.has(t.name));
const active = activated && foldedNames.size > 0
  ? [...eager, ...discovered, toolSearchName]
  : [...eager, ...discovered];
```

实现必须去重并保持 registry 的稳定顺序；合成工具放在末尾。`getActiveToolNames()` 不得在 execute 内部改变任何“新发现”标志；M2 应在 `discover` 返回后读取结果，避免 TanStack 所述执行期重取 active 的刷新信号丢失（`01:59-60`）。

### 3.4 合成工具定义

合成工具名和文案冻结为 `tool_search`（R4）。定义应是 `ToolDefinition`，其唯一参数 schema 定义为：

```ts
const toolSearchParameters = Type.Object({
  pattern: Type.Optional(Type.String({ description: "Regular-expression pattern for tool name or description matching." })),
  keywords: Type.Optional(Type.Array(Type.String(), { description: "Keywords matched against tool names and descriptions." })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});
```

`keywords` 严格是 `Type.Array(Type.String())`，不是 string/array Union；错误输入交给参数校验自纠。若未来任何字段真的引入含 array 的 Union，array 分支必须在首位，并复制 `read.ts:22-25` 的注释惯例；当前 schema 没有 Union。M3 必须引用本 schema，不得定义第二份。M3 对不可变 searchable snapshot 做匹配后调用 `filterNewNames`，不执行 `discover`；结果正文只列工具名和 description 首句。新增登记与 active 刷新只能由 D1 的批次完成回调执行，完整 schema 留给下一轮，符合 R3。M1 只定义工具及状态接口，不实现匹配算法。

### 3.5 R8 引导性报错

`getGuidance(name)` 仅在 `isFoldedAndUndiscovered(name)` 时返回精确文案：

```text
Tool 'X' is available but not yet loaded. Call tool_search with query "X" to load it.
```

其中 `X` 使用调用方原始工具名，查询建议为该名称本身，并对双引号和反斜杠做 JSON/文本安全转义。真正未注册名返回 `undefined`，保留现状 `"Tool X not found."`（`packages/agent/src/agent-loop.ts:650-659`）。R8 文案由 M2 负责放入正常 tool result，不抛异常、不终止 loop。名称若需展示转义，建议使用单引号包围并将 `'` 替换为 `\'`；查询参数仍使用安全 JSON 字符串。
当 `foldedNames` 为空但模型仍幻觉调用 `tool_search` 时，合成工具保持可执行（执行集与广告集分离），返回：`All folded tools are already loaded.`，不得报 Unknown tool。热加载重新产生 folded 工具后，recompute 使其重新进入广告集。

### 3.6 恢复入口

M4 扫描 `getBranch()` 与 compaction `details` 后，将收集出的名称批量传入 `restore(names)`；该入口接受 transcript 超集并保留 catalog 外名称。运行时搜索命中仍只能调用 `discover(names)`，它只接受当前 catalog 内的折叠名称。恢复顺序以 M4 §3.2 为准：先调用 `restore`（恢复 discovered 事实），之后才 `recompute`（此时 discovered 输入已含恢复集，激活判定基于完整事实）；恢复后 active/catalog/search 均只使用 `discoveredNames ∩ availableCatalog`。M4 负责 transcript 真相源（`00:87-92`），M1 只保证两个入口均为纯内存操作。

## 4. 文件与副作用

新增目录 `packages/coding-agent/src/core/tool-search/`，建议文件：

- `manager.ts`：`ToolSearchManager`、`ToolSearchEntry`、结果类型及集合状态；
- `tool-search-definition.ts`：TypeBox 参数 schema 和 `ToolDefinition` 工厂（或由 manager 内部工厂实现）。

按 I4 修改 `packages/coding-agent/src/core/extensions/types.ts:516-562`：

```ts
/** Whether this tool may be omitted until discovered. Defaults to false at this type boundary. */
deferrable?: boolean;
```

注：R5 对扩展/SDK 工具的缺省策略由分类层应用；该字段本身缺省为 false，不能把类型缺省误当作最终分类结果。deferrable 归一化在 M5 输入准备的 registry 构建点完成，由 `normalizeDeferrable(definition: ToolDefinition, sourceInfo: SourceInfo): boolean`（NEW）把原生七工具强制 false、扩展/SDK 缺省 true、显式值优先，并把 boolean 写入 `ToolSearchEntry`；reservedTools 不传入该函数，而在 eager 并集逻辑中处理；manager 不读取 `SourceInfo`。修改 `packages/coding-agent/src/core/tools/tool-definition-wrapper.ts:5-20`，返回对象增加 `deferrable: definition.deferrable`，否则白名单包装会丢失作者声明（I4）。`AgentTool` 不需要接收该字段；它是 coding-agent definition/registry 层 metadata。

manager 不产生 transcript、custom entry、网络请求或 session 副作用。唯一外部可见效果是 M2 读取 active 名称并调用现有 `setActiveToolsByName`（现状 `agent-session.ts:1310-1345`），以及 M3 执行结果中的 `addedToolNames`。

## 5. 落账

状态真相源仍是 transcript（R6），不是 manager 内存。manager 内存只覆盖当前 session 生命周期，用于当前轮快速计算；resume/compaction 后由 M4 从完整 branch 和 compaction details 恢复，经唯一 `restore` 入口重建。搜索结果的新增候选先由 `filterNewNames` 筛选；`addedToolNames` 登记与刷新由 D1 批次回调完成。

## 6. 前端或 RPC 可见性

本模块无前端、RPC 或独立事件。`tool_search` 是模型可见的合成工具；它的 description 应明确“按名称/描述搜索尚未加载工具”，但不得在 description 中声称 provider 原生搜索或返回完整 schema。类别摘要由 M5/R9 接入 system prompt；M1 只提供 `getSearchableTools()` 的只读目录和 description 首句来源。UI 的工具执行渲染沿现有 `ToolDefinition`/`AgentTool` 路径，不新增 UI 状态。

## 7. 错误边界

- `discover` 对重复、未知、非折叠名必须安全幂等，不抛异常。
- `getSearchableTools` 不得暴露 deny 工具；这属于安全边界而非显示偏好。
- `recompute` 遇同名注册工具按上游 registry 的覆盖结果处理；manager 不自行合并冲突。
- 空目录或没有 folded 工具时不应激活/注入 `tool_search`，保持零开销；若 M5 传入 `active=true` 但无可折叠工具，manager 应将 `activated=false` 归一化并报告 `changed`。
- tool_search execute 的匹配/参数错误由 M3 定义；manager 只负责集合契约。原生 7 工具误声明 `deferrable` 必须在 manager 分类层再次拒绝折叠，不能只依赖作者类型。
- 任何状态变化不能抛出中断 agent loop 的异常；R8 是模型可见的正常控制流。

## 8. 代码落点与跨模块边界

| 调用者 | 调用 M1 | M1 返回/保证 |
|---|---|---|
| M2 AgentSession/loop | `recompute`, `getActiveToolNames`, `isFoldedAndUndiscovered`, `getGuidance` | active 名单、是否需要刷新、R8 文案；M2 调现有 `setActiveToolsByName` |
| M3 search execute | `getSearchableTools`, `filterNewNames` | 不可变目录；仅返回尚未发现的合法名称；不得调用 `discover` |
| M4 recovery | 先 `restore(recoveredNames)`，后 `recompute`（顺序以 M4 §3.2 为准） | transcript 超集恢复，唯一写入 discovered 的入口 |
| M5 activation | 计算 `active` 后传入 `recompute` | M1 不重复估算 token/context，也不读取 Model.compat |

`tool_search` 若注册为 builtin，不经过 extension wrapper，因此不得依赖 wrapper 自动 diff；M3 必须手动设置 `addedToolNames`。M2 的 active 刷新放在一批工具执行边界，避免 wrapper 的缩减 guard 抑制 addedToolNames（主代理已核实 `extensions/wrapper.ts:15-46`）。

## 9. 与现状差异

现状 `ToolDefinition` 没有 deferred 标志，且 wrapper 是白名单转发（`extensions/types.ts:516-562`、`tools/tool-definition-wrapper.ts:5-20`）；本设计新增 `deferrable` 并显式透传。现状 `setActiveToolsByName` 逐名从 registry 查找、未知名静默忽略并触发 prompt 重建（`agent-session.ts:1310-1345`）；本设计只输出合法 active 名称，调用仍归 M2。现状未知工具返回 `"Tool X not found"` 且不打断 loop（`packages/agent/src/agent-loop.ts:650-659`）；本设计为“已注册但折叠未发现”分支提供 R8 引导文案。现状没有 ToolSearchManager、folded/discovered 内存状态或合成 `tool_search` 工具，均为 NEW。

既有 deferred 的 `addedToolNames` 由 extension wrapper 的执行前后 diff 产生（`00:136-140`），但 builtin tool_search 不享受这一机制；这不是重复通道，而是按 R3 手动产生同一字段。

## 10. 验收测试

M1 的测试应是脱离 AgentSession 的纯单元测试（建议 `packages/coding-agent/src/core/tool-search/manager.test.ts`，NEW），至少覆盖：

1. eager 集合：原生七工具即使 `deferrable:true` 也不折叠；扩展显式 `false` 不折叠；扩展缺省按 R5 分类结果折叠。
2. active 公式：激活时 eager + discovered +（仅 foldedNames 非空时的）`tool_search`；未激活/无 folded 时没有 `tool_search`。
3. 激活退化：active true → false 后 discovered 工具保留，仅移除 `tool_search`。
4. 幂等过滤：`filterNewNames` 对重复/已发现名称只返回一次，且不修改 discovered。
5. 恢复：`restore(recoveredNames)` 是唯一恢复入口，catalog 外名称保留在事实集合但不进入 active/search。
6. 不可变快照：修改返回数组不会改变 manager 内部集合。
7. R8：折叠未发现名得到带句号引导文案；未知名得到 `undefined`。
8. schema：TypeBox parameters 能通过 schema 编译；keywords 必须为数组。
9. deny 封闭性：deny 名不出现在 catalog、searchable snapshot、active 或搜索摘要。

跨模块测试由 M2/M3/M6 负责；M1 测试不 mock session loop 来验证转发细节。

## 11. 发现的冲突

1. 已裁决，见 R5：allow 白名单工具强制 eager；manager 接收的 catalog 已体现该结果。
2. `active` 是否可在无 folded 工具时由 M5 保证为 false，或由 manager 归一化，R5 未逐字规定。本文采取安全归一化（无可折叠工具不注入合成工具），并将其作为错误边界；若 M5 需要观察原始激活判定，应另加 `requestedActive` 字段，不改变模型可见行为。
3. R3 要求“调用 manager 刷新 active”，而纯逻辑边界禁止 session callback。本文把刷新拆成 manager 立即更新内存 `activeNames`、M2 在下一轮调用 `setActiveToolsByName`；这保持纯逻辑且满足下一轮生效。若评审认为“刷新”必须同步 session，应由 M2 承担，不把 callback 塞回 M1。

## 12. 仍未知待拍板

- AgentSession 中 manager 的精确字段名与构造位置（M2 接线时确定）；必须坚持 per-session。
- M5 传入的 `ToolSearchEntry.deferrable` 已在 registry 构建点由 `normalizeDeferrable(definition: ToolDefinition, sourceInfo: SourceInfo): boolean`（NEW）归一化；manager 不读 sourceInfo。
- `limit` 上限（本文示例 100）最终由 M3 按搜索契约拍板；它不影响集合状态机。
- compaction details 的具体 JSON 形状由 M4 定义；M1 只要求恢复名称数组经 `restore` 入口进入。

除上述交界细节外，本文件未改变冻结裁定。任何偏离必须先回写 `00-共同上下文.md` 并广播。