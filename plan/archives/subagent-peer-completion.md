# Subagent 补全为 Peer 级会话（上下文 / 状态 / 历史）

> 状态：计划稿，未实施。
> 日期：2026-08-11
> 背景：subagent 目前是"一次性只读任务委派"的最小形态。首个 peer 级消费者是 WorldLines 的"裁判"（referee）——一个需要看到父会话全部剧情 + 全部状态（含暗线 secret 与各角色领地）+ 机制设定，然后按 need-to-know 回答作家提问的角色。
> 关联：[multi-agent-infrastructure.md](./multi-agent-infrastructure.md)（请求网关/生命周期/记账，与本计划正交互补——那边管"请求怎么跑"，这边管"上下文给什么"）。

## 1. 目标

把 subagent 从"编译 preset + task 的最小会话"升级为"**与父会话同等上下文的 peer 会话**"：

- 能发现并加载父会话所在 config-dir 的 **preset 与 schema**（当前不认 config-dir）；
- 能看到**父会话的实时状态快照**（含父会话已加载的全部命名空间）；
- 能继承**父会话的历史**（剧情节选，数量可配）；
- 能渲染**自定义 slot**（扩展注册的 slot 与内置 slot 一视同仁）；
- 全程**向后兼容**：不传新选项时行为与现状完全一致。

非目标（本轮不做，另行规划）：subagent 内运行扩展工具（G5）、usage 记账进父会话、子代理并行编排——这些归 multi-agent-infrastructure。

## 2. 现状盘点：五个缺口

| # | 缺口 | 源码位置 | 现状 |
|---|---|---|---|
| G1 | preset 发现与父会话不一致 | `core/subagent/prepare.ts` 内 `loadPromptPresets(cwd, getDefaultSessionDir(cwd))` | `loadPromptPresets` 本身感知 config-dir，但 `prepare.ts` 传的 agentDir 是 `getDefaultSessionDir(cwd)`（session 目录而非 agent 目录）；而 `session.getAllPresets()` 是全量包含的。这导致 `subagent_profiles`（读 session presets）列出的 IP 预设在 `prepare` 里按路径搜不到 |
| G2 | state / schema 全无 | `prepare.ts` 的 minimal `PromptRuntime` 无 `state` 字段；`run.ts` 的 `createAgentSession` 未传 `schemas` | state slot 渲染空；子代理会话零状态 |
| G3 | 自定义 slot 渲染依赖空 runtime | `prepare.ts` 的 runtime `options` 是手搓空壳（`toolSnippets: {}`、无 skills/contextFiles） | 自定义 slot 的 render 闭包在**模块级 registry**（`prompt-preset/slot-renderers.ts` 的 `customSlots`），同进程其实已注册；但 `state`/`tools` 等内置 slot 读 `runtime` 字段，全空 → 渲染不出 |
| G4 | 父会话历史未实现 | `PrepareSubagentOptions.inheritHistory` 是预留位（注释 "Reserved for Phase 4"） | 子代理看不到剧情 |
| G5 | 扩展工具被剥 | `run.ts` 的 resourceLoader `getExtensions` 返回空 + `createExtensionRuntime()` | 子代理无扩展工具。**本轮不做**：referee 需要的是 slot 不是工具（预设 tools deny all） |

**为什么现在是这形态**：`prepare.ts` 注释自述 "avoids extension/tool/loader overhead"——一次性任务委派场景（读代码、跑审查）不需要这些，且省成本、防泄漏。但 `inheritHistory` 的预留说明作者规划里就有 peer 形态（Phase 4）。本文档就是把 Phase 4 提前到可用的最小切片。

## 3. 关键约束：context sealing

`AgentSession.setInitialMessages()`（`core/agent-session.ts`）会把 `agent.state.messages` 置为给定消息并置 `_sealedContext = true`；seal 后 `transformContext`（`core/sdk.ts`）直接返回现有消息，**不再重编译 preset**。

推论：**子代理看到的一切（slot 渲染、状态、历史）必须在 prepare 期编译进 messages**，run 期没有第二次机会。因此 G2/G4 的实现全部落在 `prepare.ts`；`run.ts` 只补一个 `schemas` 透传（让子代理自己的 stateManager 也加载，future-proof——将来 state 有写入时子代理侧的 `get_state` 语义正确）。

> 补充说明：所有新依赖（`session.getAllPresets()`、`stateManager.snapshot()`、`agent.state.messages`、`getSystemPromptOptions()`）均为同步读取，`prepareSubagentConversation` 将保持为**同步函数**，无需改变函数调用签名。

## 4. 设计决策

### D1 预设发现：用父会话的 preset 列表

`prepareSubagentConversation` 增加可选参数 `session: AgentSession`（extension.ts 的 tool 闭包里已有 `session`，零成本传入）。preset 查找优先 `session.getAllPresets()`（返回父会话已加载的 `LoadedPromptPreset[]`），找不到再回退现有 `loadPromptPresets` 路径。`isDelegatable` 判定与 prepare 的查找源从此一致，消除"profiles 列表里有、一调就 not found"的错位。

> 注：`session.getAllPresets()` 返回内部数组引用，prepare 中消费 preset 时取其 `.preset` 副本或只读消费，避免修改对象污染父会话。

### D2 状态注入：`runtime.state = 父会话 stateManager.snapshot()`

不再手搓 throwaway StateManager。前提是**父会话已加载全部相关 schema**（含角色领地，见 §5 配套修复），快照即全集。
`session.stateManager` 已有公开 getter，`snapshot()` 返回 `structuredClone(this._data)`，天生深拷贝隔离。

```ts
// prepare.ts 内
const runtime: PromptRuntime = {
  options: buildOptions(session, effectiveTools), // D3
  messages: historyMessages,                      // D4
  state: session.stateManager.snapshot(),         // D2 —— getter 已公开
  ...
};
```

### D3 runtime.options：从父会话暴露拍平后的 prompt options 子集

`AgentSession._baseSystemPromptOptions` 内部存储结构为 `{ cwd, options, resourceLoader, customTools }`。
在 `AgentSession` 上增加公开 getter（例如 `getSystemPromptOptions(): BuildSystemPromptOptions`），返回拍平后的子集（`cwd`、`skills`、`contextFiles` 等），但不泄露 `resourceLoader`。

在 prepare.ts 中构建 runtime.options 时：
- 从父会话获取系统 prompt options 子集；
- **`toolSnippets` 按子代理 `effectiveTools` 进行过滤**：只保留子代理实际拥有的工具 snippet（避免 referee 等 deny all tools 的角色在 system prompt 中渲染父会话全部工具描述）。

### D4 历史继承：`runtime.messages = 父会话 agent.state.messages 尾 N 条`

- `inheritHistory?: number`（沿用预留字段）：取父会话 `agent.state.messages` 尾部 N 条作为 `runtime.messages`。
- 截断/清洗**全部交给 referee 预设的 `chat-history` slot**：现有编译器机制（`maxMessages`/`maxChars`/`roles`/`stripAssistantThinking`/`toolMode`/工具对修复）直接复用，一行新逻辑不写。
- 首轮咨询可传较大 N（如全量）；后续增量由 WorldLines 侧决定（可落 `consult_checkpoint` 记上次同步 leaf，参考 handoff.ts 的 checkpoint 模式）——pi-core 不管这个，只提供 `inheritHistory`。

### D5 运行时 schemas：`run.ts` 透传

`createAgentSession` 增加 `schemas: preparation.schemas`（可选）。schemas 来源：预设新字段 `schemas?: string[]`（referee.json 里声明，如 `["world","secret","lizeyan","baiqi","xumo","zhouqiluo"]`）或 prepare 显式传入。加载失败仅 warning（与现有 `loadSchema` 行为一致）。

### D6 扩展工具（G5）：明确不做

subagent 的 resourceLoader 保持剥离。自定义 **slot** 已通过模块级 registry 在进程内可用（父会话加载 ip-context.ts 后 `getSlot("worldview")` 即命中），不需要扩展运行时。需要扩展工具的 peer 角色（未来的门 agent 等）另立计划，与 multi-agent-infrastructure 的副循环治理一起做。

## 5. 配套修复：父会话加载全部 schema（含角色领地）

**事实核查（2026-08-11）**：
- schema 发现已覆盖 config-dir：`--config-dir` 设置 `PI_PROJECT_CONFIG_DIR` 环境变量（`main.ts`），`loadSchemaDefs` → `getProjectConfigDir(cwd, "schemas")` = `cwd/<config-dir>/schemas`（`config.ts:510`），`agent-session.ts:3293` 在构造期全量发现。
- 因此 WorldLines 的 writer 进程 `_loadedSchemaDefs` **已经包含全部 IP schema**（world/secret/每角色领地），只是 run.sh 只传 `--schema world,secret`，领地未 `loadSchema` 进 stateManager → `getState()`/父快照缺领地。

**结论**：不是发现路径的 bug，是启动参数遗漏。修法：

```bash
# run.sh（WorldLines 侧）
# --schema 追加 characters.json 的全部角色 id
--schema "world,secret,${CHARACTER_IDS}"
```

**安全性论证**（为什么 writer 加载领地 schema 不破坏门禁）：
- 渲染层：writer 预设 state slot `allowNamespace: ["world"]`，领地命名空间不进 writer context——加载与否对 LLM 可见内容零影响；
- 写入层：writer `tools.allow` 只有 handoff，无 `state_update`，strict 放行面变大也无写路径；扩展层 `pi.updateState` 仅 handoff.ts 使用且不写领地；
- 收益：`pi.getState()` 与 D2 的父快照天然含领地 → 裁判拿到全知状态，**throwaway StateManager 方案整体删除**。

> 若未来 writer 获得 state 写工具，需重新评估"父会话加载领地"的严格性——届时再考虑子代理侧独立加载。

## 6. API 形状（全部可选，向后兼容）

```ts
export interface PrepareSubagentOptions {
  // 现有字段不变
  cwd: string;
  profileId: string;
  task: string;
  modelRuntime: ModelRuntime;
  modelRef?: string;
  thinkingLevel?: ThinkingLevel;
  tools?: string[];
  // 新增（Phase 4 预留位落地）
  session?: AgentSession;        // D1：预设发现 + D2 状态 + D3 options + D4 历史的来源
  inheritHistory?: number;       // D4：继承父会话尾部 N 条消息
  schemas?: string[];            // D5：子代理会话加载的 schema id
}
```

不传 `session` 时：现状路径完全保留（minimal runtime、cwd 发现、无状态无历史）——现有调用方与测试零改动。

## 7. 实施顺序

1. **pi-core：G1-G4 + D1-D4**（`prepare.ts` 重构 runtime 构建 + `extension.ts` 传 session + `agent-session.ts` 加 getter）
2. **pi-core：D5**（`run.ts` 透传 schemas；preset `schemas` 字段解析）
3. **重建**：`packages/coding-agent` 内 `npm run build`（tsgo，dist 已提交，需一并入库）
4. **WorldLines 验证**（.pi 侧，纯配置）：
   - run.sh 追加角色 schema id（§5）
   - 每 IP 新增 `prompt-presets/referee.json`（`delegatable: true`、persona、state slot `allowNamespace: [world, secret, ...角色]`、chat-history slot、四个内容 slot）
   - `ip-context.ts` 注册 `mechanisms` slot（`mechanisms.md`）
   - writer.json `tools.allow` 追加 `subagent`/`subagent_profiles`
   - 端到端：作家调 `subagent(profileId="referee", task="这里的水有多深？")`，裁判回复进入作家 context
5. **回归**：不传新字段的既有 subagent 调用行为不变；pi 现有测试通过

## 8. 验证清单

- [ ] `prepareSubagentConversation` 无 `session` 时输出与现状逐字节一致（快照对比）
- [ ] 有 `session` + `inheritHistory` 时，编译消息含父会话历史（按 referee 预设 chat-history 规则截断）
- [ ] 有 `session` 时 state slot 渲染出 `world+secret+领地` 全量 YAML
- [ ] config-dir 内的 delegatable 预设可被 `subagent` 工具调用（G1 回归用例）
- [ ] WorldLines 端到端：作家 → subagent(referee) → 裁判回复进作家 context，玩家侧不可见
- [ ] `npm run build` 通过，dist 与 src 同步

## 9. 风险

| 风险 | 说明 | 缓解 |
|---|---|---|
| 泄露面转移 | 裁判回复作为工具结果进入作家 context，作家知识 = 裁判说了什么 | referee 预设硬规则：只输出作家此刻该知道的，连"存在被隐瞒信息"都不得提及（WorldLines 侧） |
| token 成本 | 全量历史 + 全量状态注入 | `inheritHistory` 限量 + chat-history slot 二次截断 + 增量同步（consult_checkpoint） |
| seal 语义 | 一切在 prepare 期固化，run 期状态变化不可见 | 本轮状态静态，无影响；将来 state 写入落地后，父快照在每次 prepare 时重新取，天然实时 |
| strict 语义变化 | 父会话加载领地后，strict 放行面变大 | writer 无写工具，无实际写路径；若未来加写工具需重评（§5） |
| 与 multi-agent-infrastructure 重叠 | 那边要重做 subagent 生命周期 | 本计划只动上下文组装，不改会话创建/请求路径；两者的 subagent 改动在同一文件，实施顺序上先合本计划（小）再合那边（大） |
