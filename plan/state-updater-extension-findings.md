# State Updater：扩展优先实现的经验与源码缺口

> 状态：扩展已实现并实测通过（真实 LLM 调用），6 项源码发现记录在案
> 关联：[watchdog-system.md](./watchdog-system.md)（触发式 side request 计划的被分析对象）、[watchdog-feasibility-analysis.md](./watchdog-feasibility-analysis.md)（其中 §3.1 已预判本文发现 #1）、[multi-agent-infrastructure.md](./multi-agent-infrastructure.md) Step 5
> 创建：2026-08-11
> 核对基准：pi-rp 当前 working tree；实测环境 worldlines-rivet（`~/projects/worldlines-rivet/.pi/extensions/state-updater.ts` + `.pi/ips/lianyu/prompt-presets/state-updater.json`，真实 GG provider 调用）

## 0. 结论速览

**"扩展优先，缺什么再改源码"路线成立**——state updater 这个高度定制化的功能，用纯扩展（ExtensionAPI + `ctx.modelRegistry.complete()` + 磁盘解析 session 文件）完整实现并跑通，**不需要动 pi-rp 一行代码**。代价是几处"不够优雅"，其中两处值得改源码：

1. **扩展侧缺预设编译 API**（发现 #3）——扩展只能手搓预设渲染子集。**最值得加**：`pi.compilePreset(id, runtime)`，让扩展复用 `compileMessages`/`compileSystemPrompt` 全量能力（slot/macro/finalize）。
2. **`ctx.modelRegistry.complete()` 绕过 RequestGateway**（发现 #1）——与 watchdog-feasibility §3.1 的结论一致，是既有计划已覆盖的已知项。

其余为已绕过/需注意的行为差异（发现 #2/#4/#5/#6）。全文证据以 `文件:行` 标注，实测证据来自 worldlines-rivet 冒烟测试（§1）。

## 1. 实测验证摘要（证据）

实现：`.pi/extensions/state-updater.ts`——每个进程 `agent_end` 后 fire-and-forget 一次单次 LLM 调用，读「主进程」最近 2 轮游玩记录 + 主进程 state，按 IP 预设输出 `<UpdateVariable><JSONPatch>` 写回 state（`pi.updateState`，schema 校验 + strict 兜底）。writer 实例每 trace 一次；角色实例每 3 个 trace 一次，从 `<save-dir>/*.jsonl` 解析 writer session。

| 验证项 | 结果 |
|---|---|
| tsc 类型检查（扩展 + handoff + ip-context） | 0 错误 |
| 纯函数单元测试（trace 切分 / patch 解析 / 翻译 / session 解析 / 预设渲染） | 23 通过 |
| writer 实例实跑（GG/gemini-3-flash-preview） | `agent_end` → 真实 LLM 调用 → 4 ops 全 applied → session 落 5 条 state 快照；`world.phase→清晨`、`present→[lizeyan]`、`situation` 更新、`seen` 正确追加异象 |
| 角色实例实跑（预置含 handoff 的 writer session） | 读到 `traces:2` → 3 个领地 patch（location/mood/`delta affection +1` 15→16）全部本地 applied |
| 闭环（角色领地 → writer） | 由 handoff.ts 的 RPC `get_state`/`update_state` 双向同步承担（`rpc-types.ts:29-30,111`），扩展侧无需自造通道 |

## 2. 发现清单

### 2.1 发现 #1：`ctx.modelRegistry.complete()` 绕过 RequestGateway、无重试（已知项，复核确认）

- **现象**：扩展侧唯一可用的 LLM 调用入口是 `ctx.modelRegistry.complete()`（`extensions/types.ts:320` 注入 `ModelRegistry` facade）。
- **证据**：`model-registry.ts:103-109` `complete()` → `ModelRuntime.complete()`（`model-runtime.ts:628`）→ `this.stream()`（628-634，走完整 `stream` API）→ `prepareRequest` + `provider.stream()`——**完全不经过 `RequestGateway`**（网关只包在 `Agent.streamFunction` = `gateway.streamSimple`，`sdk.ts:321-365`）。无重试（`completeSummarization` 的 `retryAssistantCall` 包装不在此路径上）。
- **影响**：低频静默更新器可接受；高频 side request 会与主循环/compaction 争抢 provider 并发而无法限流。
- **建议**：与 watchdog-feasibility §3.1 一致——watchdog/更新器类 side request 应走 `completeSummarization` + 网关 streamFn（priority=0, label=`watchdog:<slug>`）。本次扩展未改，因为低频场景不值得为此动源码。

### 2.2 发现 #2：模型对象必须整传，重建 `{provider, id}` 会丢 `api` 字段（踩坑）

- **现象**：扩展实现初期把 `ctx.model` 重建为 `{ provider, id }` 传入 `complete()`，返回 `stopReason="error"`、`errorMessage="No API provider registered for api: undefined"`、`content=[]`——**静默失败**（不抛异常，看起来像模型返回空）。整传 `ctx.model` 即恢复。
- **证据**：`provider-composer.ts:470`：`if (!api) throw new Error(\`No API provider registered for api: ${model.api}\`)`——provider 注册表按 `model.api` 查，重建对象时该字段丢失。`complete()` 把错误封进 `AssistantMessage.stopReason="error"` 返回而非 reject（`model-runtime.ts` complete 路径），所以调用方无 try/catch 也"成功"了。
- **影响**：扩展作者极易踩中（顺手只取 provider/id 是自然写法）。静默失败尤其阴险。
- **建议**：`ModelRegistry.complete` 签名上 `model: Model<TApi>` 已约束类型，但运行时对象重建不受类型检查。文档层面在扩展 API 注释里强调"整传 `ctx.model`"即可；或 `complete()` 对 `model.api === undefined` 直接抛同步错误，别封进 stopReason。

### 2.3 发现 #3：扩展侧无预设编译 API（最值得改源码）

- **现象**：`compileMessages` / `compileSystemPrompt` 是 pi 内部 API（`prompt-preset/compiler.ts:22,47`，仅从 `prompt-preset/index.ts:2` 对包内导出），**ExtensionAPI 不暴露**。扩展要"按预设渲染提示词"只能自己读 `prompt-presets/<id>.json` 并实现渲染子集（system 块拼接 + state/历史注入 + allowed 约束）。
- **证据**：`extensions/types.ts` ExtensionAPI 有 `registerSlot`/`registerMacro`（供预设引用自定义 slot），但没有任何"编译一个预设"的入口。本扩展的 `buildPrompt`（`state-updater.ts:355-379` 附近）即为此手搓的 ~25 行子集。
- **影响**：预设系统的 slot/macro/正则 finalize 能力对扩展不可用；扩展预设与主预设的渲染行为可能漂移（本扩展的渲染与 pi 引擎的 slot 语义不完全一致）。
- **建议**：ExtensionAPI 加 `pi.compilePreset(presetId, runtime)`——内部调 `compileMessages` + `compileSystemPrompt`（复用 `PromptRuntime`：messages/state/variables/options）。收益：watchdog（其计划本来就"完全委托预设系统"）与 state-updater 都能用回全量预设引擎，扩展里那 25 行子集删除。注意 `autoActivate` 门控（watchdog-feasibility §4.1）：编译用预设不应被选为主预设。

### 2.4 发现 #4：跨进程 state/记录无专用 API，session 文件解析可接受

- **现象**：角色实例要读「主进程」的游玩记录与 state，但角色是独立 pi 进程（RpcClient），**只有 writer→character 单向通道**。扩展只能解析 writer 的 session 文件（`<save-dir>/*.jsonl`）。
- **证据**：`parseSessionEntries`（`session-manager.ts:324`）已从包导出，扩展可直接复用；state 快照在 `type:"state"` 条目（`session-manager.ts:1138-1146` appendState 全量快照）。本扩展的 `readWriterSession`（`state-updater.ts:215-235` 附近）基于它。
- **影响**：成本可控（一个函数 + 文件 IO）；但扩展耦合了 session 文件格式（`version:3` 的条目结构）。
- **建议**：若想让扩展免解析，可在 RPC 侧暴露 `get_state`/`update_state`（**已存在**：`rpc-types.ts:29-30`，handoff.ts 的双向同步已在用）之外的"读其他会话的游玩记录"能力——但优先级低，当前方案够用。
- **跟进（2026-08-12）**：共享 state 已有完整设计——[shared-state-cross-process.md](./shared-state-cross-process.md)（文件型共享 store + fs.watch + RPC `watch_state` 推送）。游玩记录仍走 session 解析，state 部分待实现后免解析。

### 2.5 发现 #5：`ctx.model` / `ctx.modelRegistry` 是惰性 getter，后台任务必须在 handler 内同步捕获

- **现象**：扩展事件 handler 需要 fire-and-forget 后台任务（不阻塞 `agent_end`），后台要用 `ctx.model` / `ctx.modelRegistry`。
- **证据**：`runner.ts:678-756` `createContext()`——`model`/`modelRegistry` 是 `get` 访问器，每次访问都 `assertActive()`（`runner.ts:561`）。handler 返回后 runner 若被 session switch / reload / shutdown 重建，后台再访问会抛/取到 stale 实例。
- **影响**：必须在 handler 同步阶段把 `model`/`modelRegistry` 捕获到闭包再给后台用；后台失败只能 try/catch + warn（无 epoch 机制可查）。
- **建议**：watchdog 计划里的 epoch guard 可缓解；扩展侧目前"同步捕获 + 吞错"已够用。若扩展 API 想支持后台任务，可在 ctx 上提供"无 assert 的快照引用"。

### 2.6 发现 #6：`pi.updateState` 的 `add` 是数组追加语义，参考实现 state-patch 的 add→replace 映射会毁掉数组字段

- **现象**：state 引擎里 `add` 对已有数组是**追加**（`schema-validator.ts` projectMutation：`Array.isArray(existing) && !Array.isArray(value)` → push），对数值是**增量**，其余才是无条件写入。而参考实现 `pi-sillytavern-bridge/extensions/state-patch.ts` 把 `add` 一律翻成 `replace`（其注释："JSON Patch `add` is an unconditional set"）——照搬会让 `/world/seen` 的追加变成整体替换（丢默认值），或数值被无条件覆盖。
- **证据**：`state-manager.ts` apply → `schema-validator.ts` projectMutation（add 分支）；实测：本扩展透传 `add` 后 `world.seen` 正确 append（2 默认 + 1 新异象，schema 校验通过）。
- **影响**：JSON Patch 翻译层必须知晓 state 引擎的 `add` 语义；"add 等价 replace"的注释在 pi 语境下是错的。
- **建议**：state-patch.ts 与未来 watchdog 的 patch 翻译都按此语义写；预设提示词里明确"数组追加用 `add` + 单个元素，数值增量用 `delta`，设定用 `replace`"（本扩展预设已如此）。

## 3. 建议的源码改动清单（按优先级）

> 跟进（2026-08-12）：本清单的完整设计已定稿——[side-request-extension-apis.md](./side-request-extension-apis.md)（P1/P2/P3 分批 + N1/N2 新发现）；P4 与跨进程 state 见 [shared-state-cross-process.md](./shared-state-cross-process.md)。待实现。

| 优先级 | 改动 | 位置 | 动机 |
|---|---|---|---|
| P1 | ExtensionAPI 加 `pi.compilePreset(presetId, runtime)` | `extensions/types.ts` + `runner.ts` | 扩展复用全量预设引擎；watchdog 与 state-updater 都受益（发现 #3） |
| P2 | side request 走 `completeSummarization` + 网关（watchdog-feasibility §3.1 既有结论） | `compaction.ts` / 新 `sideRequestExecutor` | 限流 + 重试（发现 #1） |
| P3 | `ModelRegistry.complete` 对 `model.api === undefined` 抛同步错误，或文档强调整传 | `model-registry.ts` | 消除静默失败（发现 #2） |
| P4 | 文档标注 `add` 的数组追加语义（state-patch.ts 注释修正） | `state-patch.ts` / 扩展文档 | 防止后续翻译层踩坑（发现 #6） |

P3/P4 为低成本文档/防御性改动，可随任何一次源码提交顺带做。

### 2.7 发现 #7：一次性运行模式（print/-p）退出时 dispose→invalidate，fire-and-forget 后台任务的 ctx 永久失效（实测复现）

- **现象**：`-p`（print 模式）一轮跑完进程即退：退出路径触发 `session_shutdown reason:"quit"` → `teardownCurrent`/`dispose()`（`agent-session.ts:970`）→ `invalidate()` → **扩展加载时捕获的 `pi` 永久 stale**（`state.staleMessage` 设置后不再清除）。进行中的更新器 LLM 调用（fire-and-forget，`agent_end` 后启动）返回后调用 `pi.updateState`/`pi.appendEntry` → `assertActive` 抛 "This extension ctx is stale..."——**LLM 花费白烧**（实测：LLM 跑完 ~30s 后 patch 应用失败）。
- **证据**：`agent-session.ts:970` dispose 内 invalidate；`loader.ts:179-181` assertActive 抛 staleMessage；`agent-session.ts:3139-3156` updateState 落盘依赖 `this.isIdle`——进程将退时 `isIdle` 亦不可靠。实测复现：`-p` 冒烟 stderr 出现完整 stale 堆栈，session 无 `state_updater` 审计条目；TUI 常驻无此问题（writer 更新器 3 ops 全 applied 并落盘）。
- **影响**：**所有 fire-and-forget 后台任务（side request 类）在一轮即退的运行模式下必然失败**，且失败形态是"白跑一次 LLM 后在结尾抛错"。低频场景可接受，但应该优雅。
- **建议**：side request 执行器（发现 #1 的 P2 计划）应内置 **AbortSignal 支持 + 退出静默**——`ApiStreamOptions` 已支持 `signal`（`ProviderRequestOptions.signal`），扩展可在 `session_shutdown` 事件里 `abort()` 进行中的调用（省花费）并用 shutdown 标志静默 catch（不刷堆栈）。扩展侧本次已按此实现：`session_shutdown` → `updaterAbort.abort()` + `shuttingDown` 静默。

### 2.8 发现 #8：扩展的 `pi` 无"当前有效实例"入口（与 #5/#7 同源）

- **现象**：`ExtensionAPI`（扩展工厂参数）在加载时创建并绑定单个 runtime；`ctx.newSession()/fork()/switchSession()/reload()` 替换 runner 后旧 `pi` 永久失效，**API 无任何"取当前 session 的有效 pi"入口**（`ExtensionContext` 只有模型/会话控制 action，无 state 读写；`session_start` 事件的 ctx 同样没有 state API）。
- **影响**：扩展要跨 session 替换存活只能自造通道（如 state-updater 角色实例解析 writer 的 session 文件），或接受"替换后旧后台任务全部失败"。
- **建议**：若要让扩展成为一等公民，ExtensionAPI 应提供"当前有效 runtime"的快照访问器（如 `getSessionContext()`），或在 `session_start` 事件的 ctx 上暴露 state 读写 action——这同时是发现 #3（compilePreset）的落点：编译/写 state 都应是"当前 session"操作。



## 4. 与 watchdog 计划的关系

- 本实测是对 watchdog 计划"触发式 side request"的一次**最小落地验证**：触发（`agent_end` 事件）、单次 completion（`modelRegistry.complete`）、预设驱动提示词（手搓子集）、输出送达（`updateState` / custom entry）全部在扩展层成立。
- 发现 #1/#3 直接喂给 watchdog 设计：watchdog 若建成，应内置"扩展可调用的 side request"与"预设编译"两个 API，而不是让每个扩展重造。
- 触发频率模型（turnEnd / everyNTraces）在扩展层用事件 + 计数器即可实现，无需 runtime 支持——watchdog 的 runtime 侧价值主要在 retry/epoch/送达编排，而非触发原语。

## 5. 升级方向：更新器 = loop agent（前因后果）

> 关联：[affiliated-session.md](./affiliated-session.md)（技术底座，本节的产物）、[side-request-extension-apis.md](./side-request-extension-apis.md)（并行路线 1）、[co-creation-canon-beliefs.md](./co-creation-canon-beliefs.md)（当前落地搭在路线 1 上）、[CO-CREATION.md](../../worldlines-rivet/CO-CREATION.md) §5.6（handoff context 构造）
> 状态：方向论证完成，未实现（依赖 pi-rp 的 spawnAgent API）

### 5.1 起因：手搓管线其实是重造 agent 循环

现状实现（§1）是 one-shot `modelRegistry.complete()` + 手搓全套：`parseJsonPatchBlocks`（文本契约解析）→ `translateJsonPatch`（op 翻译）→ `applyCalls`（应用 + 记账）→ `isFailedRun` 守卫 → 失败即丢（无重试）。这些全是 **agent 循环已经在做的事**：

| 现在手搓的 | agent 形态下变成 |
|---|---|
| `parseJsonPatchBlocks` + `<UpdateVariable>` 文本契约 | 结构化工具调用（`state_update` 参数就是 JSON Schema） |
| `translateJsonPatch`（add→replace、delta、test-skip、move/copy 读源） | 内建工具语义：`add`=数值增量/非数值替换/数组追加（`tools/state-update.ts`），agent 自己选对 op |
| `applyCalls` + rejected 记账 + 幂等跳过 | 工具结果 `state_update rejected: <reason>`（`state-update.ts:88-92`，schema 校验失败作为 tool error）→ **agent 看到错误自己改值重试** |
| `isFailedRun` 守卫 | 仍是触发门控（失败回合不 spawn），但只剩一行 |
| 重试/容错 | 循环内建：校验失败不会静默丢，而是自纠错收敛 |
| `buildPrompt` 手搓预设子集 | 子会话初始 prompt 由引擎按 profile 编译 |

调用次数判断（用户）：正常路径 = 1 次 LLM + 1 次工具调用，与 one-shot 等价；多花的只发生在需要自纠错时——那是特性不是浪费。

### 5.2 瓶颈：扩展无法程序化 spawn loop agent

两条现有路径都不行：

1. **LLM 的 `subagent` 工具**：在 turn 内同步跑（不是后台 side request）；且 subagent 是 **read-only 设计**（`core/subagent/extension.ts:83` 描述原文），写进 **throwaway in-memory StateManager**，永不落回父进程。
2. **RPC 子进程**（handoff 模式）：每个 trace spawn 一个进程，重。

而 **subagent 引擎其实 90% 就绪**：`prepare.ts:145-155`（inheritHistory + 父 state 快照播种）、`run.ts:38`（`SessionManager.inMemory`，无磁盘）、工具集、timeout、重试全有——**缺的是程序化入口 + 写回通道**。

### 5.3 方案与深化：spawnAgent → affiliated-session

**spawnAgent**（复用 `runSubagent` 引擎 + 显式工具集 `["state_update","get_state"]` + 写回）：子会话写 throwaway state（校验失败在子会话内自纠错），跑完后父进程 **diff-merge 回自己的 StateManager**——复用 handoff.ts `syncCharacterStateToWriter` 的 get/diff/update 模式，进程内版。校验失败重试发生在子会话内，最终只有合法状态合回。

用户深化（RPC 对比）：RPC 有 `--no-session` 轻量模式（`cli/args.ts:112`），但真正的需求是**"与父进程共生的子进程"**——共享 chat history + state，且能把消息以 addEntry 形式反向注入父 session。这催生了 **affiliated-session** 设计（三能力：A 出生继承 / B 活体读取 / C 写回可控；一个协议两个 transport——in-process subagent 引擎 + RPC 子进程），详见 [affiliated-session.md](./affiliated-session.md)。

**边界划分**（用户裁定）：addEntry 反向注入是**扩展**的事（`pi.appendEntry` 已有，子进程结果由父扩展注入）；共生原语本身（继承 / 反向读取 / 回滚）是 **pi-rp** 的事。

### 5.4 与 side-request 路径的关系（两条演进路线）

| | 路线 1：completeSideRequest | 路线 2：spawnAgent |
|---|---|---|
| 形态 | 保持 one-shot，**修路径**（网关 + 重试 + 预设编译） | **改形态**为 agent 循环，管线塌缩 |
| 落点 | [side-request-extension-apis.md](./side-request-extension-apis.md)（已定稿待实现） | affiliated-session 的 in-process transport |
| 当前依赖 | **co-creation-canon-beliefs.md 的 canon/beliefs 落地搭在这条上**（零扩展代码改动） | 依赖 pi-rp 新 API，未实现 |
| 关系 | 先落地（成本低、立即受益） | 长期形态：更新器扩展 ~600 行 → ~150 行，等 spawnAgent 实现后重写 |

findings 消化：P1（compilePreset）在路线 2 里被 spawnAgent **吸收为内部实现细节**（子会话初始 prompt 由引擎编译预设，无需单独暴露）；P2 的网关路径在路线 1 落地。

### 5.5 落地序列（= affiliated-session §8）

1. **in-process spawn + scratch** → writer 更新器重写（删 parse/translate/apply 管线）；
2. **RPC `init_context`** → 角色出生场景继承（配合 CO-CREATION §5.6 的 handoff context 构造）；
3. **RPC `context_request/response`** → 角色侧更新器去掉磁盘解析（发现 #4 的终态）；
4. 远期：steering/events（长驻 observer，watchdog 需要时再做）。


