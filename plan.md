# pi-rp 改造计划

## 定位

pi-rp 是 [pi-coding-agent](https://github.com/earendil-works/pi) 的一个深度魔改分支。目标不是保持核心最小化，而是将 pi 改造成适合 RP 场景的基础设施，所有核心功能直接内建，不依赖扩展系统。

## 原则

- **不区分核心与扩展**。新功能直接作为 monorepo 内的源码模块加入，参考 [oh-my-pi](https://github.com/can1357/oh-my-pi) 的做法（已clone到本地~/yoshi/project/oh-my-pi/）。
- **扩展系统保留**，给下游开发者用。但 pi-rp 的内置功能不走扩展。
- **能用的现成代码直接用**，fork 或 vendor 到 monorepo 内，而不是当作外部依赖。

## 功能规划

### 基础交互

- ✅ `/reroll` — 重新生成上一条 assistant 回复
- ✅ `/continue` — 无论最后消息状态如何，强制 agent 继续生成
- ❌ `/rewind` - `/tree` 选择器已足以覆盖 rewind/swipe 需求，不再单独实现
- ✅ `/tree` 「e」键 — 直接在 tree 选择器中编辑消息内容

### 模块化预设提示词

- ✅ **PromptPreset 核心类型** — `PromptPreset`, `PromptPresetItem` (block/slot), `PromptRuntime`
- ✅ **编译器** — `compileSystemPrompt()` (replace/append/prepend) + `compileMessages()` (chat-history 定位)
- ✅ **13 个内置 slot** — tools, tool-guidelines, pi-docs, append-system-prompt, project-context, skills, date-cwd, date, cwd, active-model, variables, chat-history, state
- ✅ **宏引擎** — `{{date}}`/`{{time}}`/`{{cwd}}`/`{{lastUserMessage}}`/`{{tools}}`/`{{selectedTools}}`/`{{activeModel}}` + 自定义宏注册
- ✅ **内置默认 preset** — 完全复现 `buildSystemPrompt()` 行为，零兼容成本
- ✅ **加载器** — 读 `.pi/prompt-presets/*.json`，验证，ID 去重，autoActivate 支持
- ✅ **`buildSystemPrompt` 回退** — 非 customPrompt 路径走编译器；customPrompt 保留旧行为
- ✅ **`/preset [id|none]`** — 切换或停用 prompt preset；`/reload` 重新读取 preset 文件
- ✅ **`/prompt`** — 显示编译后的完整 provider 负载（system prompt + messages），过滤空消息
- ✅ **ExtensionAPI 集成** — `registerSlot()` / `registerMacro()` 可自定义 slot 和宏
- ✅ **正则规则** — `PromptPreset.regex.rules`，支持 outgoing/display/both/finalize 效果，history/compiled 阶段，system/messages 目标，以及 scope 过滤（roles/maxMessages/深度等）
- ✅ **隐形提示词覆盖** — `PromptPreset.hiddenOverrides`，支持覆盖 continueText（/continue 的提示词）和 compaction 的四个提示词（systemPrompt/initialPrompt/updatePrompt/turnPrefixPrompt）及 branchSummaryPrompt，所有 compaction 提示词支持 `{conversation}` 和 `{previous_summary}` 占位符

### 知识库 (`.knowledge/`)

- 项目内 `.knowledge/` 目录，一个子目录一个知识库
- Markdown + frontmatter 格式
- `lookup` 工具供 LLM 搜索
- `/knowledge` 命令切换当前知识库

### 变量与状态管理

- ✅ `state_update` 工具（path, op, val）供 LLM 读写状态
- ✅ `get_state` 工具（无参数，返回完整状态快照）供 LLM 只读查看
- ✅ `/state` 命令查看当前状态
- ✅ 存储挂载到会话 jsonl 中，随 session 持久化
- ✅ 跨进程共享状态存储（`state.store: "file"`，按 namespace 一个文件，CAS revision）

### 状态校验 (Schema)

- ✅ 基于 TypeBox/JSON Schema 的结构约束，按 namespace 加载/卸载/替换，`/schema list/load/unload/strict` 命令
- ✅ 自定义校验器（`.ts` 文件），在 schema 校验后运行，可修正或拒绝写入
- ✅ 严格模式：未加载 schema 的路径写入被拒绝
- ✅ `schema_change` / `strict_change` session 条目，恢复与 `/reload` 时重放

### Compact + Recall

- compact 保留 pi 原生的上下文压缩功能
- compact 后的内容需要可检索，不能真的丢掉
- `recall` 工具检索已 compact 的内容

### Provider 改进

- `/login` 支持自定义 provider 选项
- 现有的 provider 系统（二十多种预设 + models.json）需要梳理，不急于动

### 其他集成

- ✅ **原生 Subagent** — 基于可委派 preset（`delegatable: true`）的进程内子代理：`subagent` / `subagent_profiles` 工具、`/subagent` 命令，扩展 API 的 `spawnAgent()`
- **记忆系统** — 一套完整的记忆工具，agent 可主动记忆和检索

### 工具历史细粒度控制（backlog，2026-08-28 记账）

现状：chat-history 的 `toolMode: "drop"` + `dropToolNames` 只有「整对删」一种粒度——`dropToolHistory()`（`core/prompt-preset/compiler.ts`）把 assistant 消息里名单内工具的 toolCall part 和对应 toolResult 消息一起删掉。缺「只处理 result」「截断 args」等细粒度操作。

触发场景（来自 worldlines-rivet 的 show_html 外包化设计讨论）：工具 result 冗长（大 JSON / 检索结果）但 toolCall 入参有保留价值时，整对删丢信息、全保留又烧 token。omp 的 shake 机制（只 drop tool result、保留 call）是参照语义。

硬约束：**provider 消息配对**。Anthropic 要求 `tool_use` 后必须跟匹配 `tool_use_id` 的 `tool_result`，OpenAI tool message 同理——所以 result 侧操作只能是「替换内容为占位符」或「截断」，**不能纯删消息**（会留悬空 toolCall，API 400）；call 侧同理不能纯删留孤儿 result。整对删之所以安全正是因为配对一起消失。

安全操作矩阵：整对删（现状）✅；result 替换占位符保留 call ✅（= shake 语义）；result 截断保留 call ✅；args 截断保留 result ✅；纯删 result 或纯删 call ❌。

若实现，最小形态（不动现有 `dropToolNames`）：

```ts
// chat-history slot options 新增
toolResultPolicy?: {
	[toolName: string]: { placeholder?: string } | { truncateChars?: number };
};
```

实现要点：result 消息命中即替换 `content`，不删消息，配对天然完整，不触发 `repairToolPairs` 误删。

缓做理由：记账时 worldlines-rivet 没有任何 result 冗长的写手工具消费方（show_html 外包化后 args/result 都是百 token 级语义），纯为「也许将来用得上」动共享子模块不划算。等真出现返回大结果的写手工具再做。

## 代码结构

参考 omp，所有新功能直接以子目录形式加入 `packages/coding-agent/src/`：

```
packages/coding-agent/src/
├── commands/       # /reroll, /rollback, /state, /knowledge 等
├── prompts/        # 预设提示词系统
├── knowledge/      # 知识库 + lookup 工具
├── state/          # 状态管理 + state_update 工具
├── memories/       # 记忆系统
└── ...             # 原生代码保留
```

## 开发顺序
1. ✅ 基础命令与实用扩展小功能（`/reroll`, `/continue`, 实时消息编辑）
2. ✅ 预设提示词系统（PromptPreset 核心类型 + 编译器 + slot 渲染 + 宏引擎 + loader + /preset + /prompt + ExtensionAPI 集成）
3. 知识库 + lookup
4. ✅ 状态管理（state_update / get_state / /state + schema 校验 + 跨进程共享状态存储）
5. Compact + recall
6. 记忆系统
7. Provider 改进
8. ✅ 原生 Subagent（基于可委派 preset 的进程内子代理）

## 已实现的教训总结

### 教训 1：动手前必须深入理解运行时链路

`/reroll` 开发中遇到的大部分问题（消息粒度、prompt/continue 选择、abort 失效、post-agent-run 循环缺失）都是因为只看了 session-manager.ts 的存储层，没完整读 agent-loop.ts 和 agent.ts 的运行时事件循环。以后任何涉及 agent 运行流程的功能，必须先读：

- `agent.ts` — `prompt()` / `continue()` / `runWithLifecycle()` / `abort()` 的调用链
- `agent-loop.ts` — `runAgentLoop` vs `runAgentLoopContinue` 的事件 emit 区别

### 教训 2：改了数据层就要改 UI 层

`reroll()` 第一版把 branch 和 agent run 捆绑在一个方法里，InteractiveMode 没有机会在中间刷新 chat container，导致旧 trace 残留。解决方式是拆成两阶段：（1）只改 session state；（2）启动 agent run。中间留给 UI 层同步。这是所有"改变当前路径"操作的标准模式。

### 教训 3：识别可提取的辅助方法

`_syncAgentStateFromSession()` 和 `_runAgentContinue()` 都是从多个调用点中提取出的共享逻辑。提取条件不是"行数太少"，而是"编码了不明显的契约，忘记了就是 bug"。

### 教训 4：新增功能以非破坏性方式接入

优先提取公共逻辑，不要在原有接口上动刀。

- **不改现有方法签名** — TreeSelector 的 edit 回调走 `onCopy` 的 public property 模式，不破坏构造器签名。
- **不改导入结构** — 需要的小工具函数 inline 而非加 import；新增文件时注意不改变已有模块的依赖图。
- **不改核心类型** — 用 cast 或 type guard 适配，不改 package 间共享的类型定义。
- **原有方法保留** — `showExtensionEditor` 不变，抽 `showEditorDialog` 出来让前者委托。下游扩展零改动。

### 教训 5：Session State Entry 必须对齐初始化流程

每个新增的 entry type（`model_change`、`preset_change` 等）必须走统一的三步流程，缺一不可：

1. **init 写入** — `sdk.ts` 中，在新会话路径下同步调用 `append*Change(defaultValue)`
2. **分支恢复** — `getSessionContextSettings()` 或等效位置，扫描 path 中的对应 type 恢复状态
3. **切换持久化** — 状态变更时同时写入 entry + 更新 settings.json（`setDefault*`）

这三步必须一起实现。只写了 entry 类型和 append 方法但没有 init 写入，分支恢复就会丢失上下文；只写了 init 但没有切换持久化，跨会话就无法保持选择。

## 与上游的关系

- 上游 pi 持续关注，但不主动合入
- 其他功能不 fork 上游，直接在 pi-rp monorepo 内开发