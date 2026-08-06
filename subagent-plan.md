# pi-rp 原生 subagent 实现计划（修订骨架）

> 修订版。相对旧版（外部包约束清单反推）的核心变化：进程内执行、无指纹、无强制审批、
> 无 rpc backend、无 `--messages` 文件协议。设计从 pi-rp 自身架构推导：
> 子 agent = 用指定 preset + task，在一个干净（或可选播种）的会话里跑一轮有界 agentic loop，
> 不干扰父会话，结果有界地回到父上下文。

## 设计原则

- 不引入外部扩展包（pi-forge / pi-subagent-runtime）的机制：无指纹、无显式 backend、无契约版本。
- 进程内执行：复用父会话 `modelRuntime`（agent-session.ts:422），无子进程、无 spawn 参数矩阵、
  无 session 文件解析。崩溃/内存隔离是未来可选硬化，不是 v1 需求。
- 有界汇报 = 复用现有 `truncateTail`（core/tools/truncate.ts:168，bash-executor.ts:114 同款），
  不做 base64 掩码 / 文件级截断 / JSONL 容错。
- 审批是可选 UX 配置，不是安全机制（子 agent 只读 + 无扩展 + 同用户，无能力升级）。
  默认不强制；`hasUI === false` 时不得静默失败（print/json 模式必须可用）。
- shared-user 边界是工具描述里的一句话文档，不是代码机制。

## Phase 0 — 修复 system 通道双份回归

- 两处同源 bug（v0.83.0 合并引入，提交 `8009ab7358`，非 `f31386f77`）：
  1. `_applyDynamicSystemPrompt` else 分支（agent-session.ts:1385）→ `?? ""`
  2. `prepareNextTurnWithContext` 的 `sysPrompt`（agent-session.ts:590-592）→ `?? ""`
     （provider payload 通道来自此处，每轮覆盖；只修 1 不修 2 则 turn 2+ 仍双份）
- 验证：faux provider 记录 `context.systemPrompt`，跑两轮，断言两轮均为空；
  `/prompt` 与 `state.systemPrompt` 都不是真实通道，不能作为验证点。

## Phase 0.5 — 清理 preset schema 死字段（先于 Phase 1）

- 删除 `mode` 字段：types.ts:9、175；loader.ts:355-358（normalizeMode）+ 构造点；index.ts re-export；
  docs/prompt-presets.md:43。出生即死（2b5b742c6f 引入），零消费、零用户、零测试。
- 修正 docs 谎言：prompt-presets.md:168 声称无 chat-history slot 时"conversation appended at the end"，
  实际 compiler.ts:53-56/62 不注入任何历史。此语义直接决定 Phase 4 的继承约束。（修订：保持不注入任何历史，修订文档即可）
- 不动 `autoActivate`（loader.ts:73 有真实消费）。

## Phase 1 — 核心准备模块（packages/coding-agent/src/core/subagent/）

- `prepareSubagentConversation(options)`：
  - options：`{ cwd, profileId, task, modelRef?, thinkingLevel?, tools? }`，预留 `inheritHistory`（Phase 4，默认 none）
  - 流程：`createAgentSession`（inMemory + 复用父 modelRuntime + 最小 resource loader）→
    `setActivePreset(profileId, { persistSettings: false })` → 编译 `compilePromptMessages()`
    → 追加 task 为末条 user → 返回 `{ messages, model, thinkingLevel, effectiveTools, profile }`
  - thinkingLevel 解析：显式 → preset 字段（Phase 3 加入）→ "medium"
  - effectiveTools：只读集 ∩ preset tools 策略（applyResourcePolicy）
  - 失败：preset 不存在 / model 不可解析 / 编译 error 诊断 → reject，附 `getAllPresets()` 列表
  - 完成后 abort + dispose
- 无指纹、无 stableStringify、无密封类型——产物就是 `AgentMessage[]`。

## Phase 2 — 进程内执行

- `CreateAgentSessionOptions.initialMessages?: AgentMessage[]`（sdk.ts）+ `AgentSession.setInitialMessages()`
  （校验末条 user）+ `_sealedContext` 守卫（transformContext，sdk.ts:365 的注入前短路）+ `isSealedContext()`
- `runSubagent(preparation, { timeoutMs?, signal? })`：
  - 用 preparation 创建执行会话（复用父 modelRuntime、inMemory、只读工具、无扩展）
  - `session.prompt(task)` → `waitForIdle` → 提取末条 assistant 文本 + usage → `truncateTail`
  - 超时 / AbortSignal → `session.abort()`（无 TERM→KILL 升级链）
  - 终态：completed / failed / cancelled / timed-out
- 不需要 `--messages` CLI flag、不需要 `--preset none` 双保险之外的任何 spawn 参数。
- `--preset none` 语义已核实：走 isDisabledPromptPresetId（loader.ts:83）→ activePreset = pi-default，
  故 `_sealedContext` 守卫是必需的（不是冗余）。

## Phase 3 — 产品层（预设即子 agent）

- preset schema：`delegatable?: boolean`、`thinkingLevel?: string`（loader.ts 仿 model 字段模式，
  loader.ts:169-171）；`setActivePreset` 追加 thinkingLevel 应用（fail-soft）
- 工具 `subagent_profiles`：列 delegatable preset（id/name/description/model/thinkingLevel/tools 摘要/就绪诊断）
- 工具 `subagent`：`{ profileId, task }` → prepare → 执行 → 返回有界报告文本 + details。
  审批：不强制；若保留则仅在 TUI 下 `ctx.ui.confirm` 且可配置。
- 命令 `/subagent`（list/run）：工厂 `createSubagentExtension(getSession: () => AgentSession)`，
  装配到 main.ts 的 extensionFactories（main.ts:527，`[...builtInExtensions, ...]`，经 resourceLoaderOptions
  :731 进所有 mode）；`getSession` 闭包在 createRuntime（main.ts:671-798）赋值。
  ctx 不暴露 session（extensions/types.ts:308-348），闭包方案必要。
- 授权规则：`delegatable: true` 即授权；无独立 config 文件。

## Phase 4 — 历史继承（可选，v2，接口在 Phase 1 预留）

- `inheritHistory`：把父会话 `state.messages` 裁剪到"当前轮之前"（去掉尾部含 subagent toolCall 的
  assistant 消息与触发 user，防递归/防双 user）→ seed prep session → `compilePromptMessages()`
  → chat-history slot 自动定位、过滤、限长（compiler.ts:62-125 全现成）
- 硬约束：**preset 必须显式声明 chat-history slot 才有继承**（无 slot 时 compiler 不注入任何历史）——
  继承由 preset 声明 + 限界，调用方只决定 seed 什么。
- 已知小改：`{{lastUserMessage}}` 在 prep 编译恒空（agent-session.ts:1353 硬编码 undefined），
  继承场景如需支持，prep 时把 seed 历史末条 user 传入。（修订：无需支持，传空即可）
- 审批摘要显示"继承 N 条 / X KiB"而非全文。

## Verification（每阶段）

- `npm run check` 全量输出（repo 规则）；测试从 packages/coding-agent 包根跑
  `node ../../node_modules/vitest/dist/cli.js --run test/...`
- Phase 0：faux provider 两轮 `context.systemPrompt` 为空（test/suite/）
- Phase 1：prepare 单测——末条为 task、首条为 preset system 块、编译无 error 诊断
- Phase 2：run 单测——faux provider + 假 modelRuntime，断言终态映射、超时、AbortSignal 各一例
- Phase 3：`/subagent list` 只列 delegatable；`subagent` 工具对未授权 preset 失败；
  print 模式（无 UI）不静默失败
- Phase 4（若做）：seed 后编译数组含历史且受 slot 限长约束
