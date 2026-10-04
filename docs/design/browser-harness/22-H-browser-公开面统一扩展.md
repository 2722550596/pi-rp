# 22-H · Browser 公开面统一扩展设计

> 状态：设计提案；只冻结 Browser/hosted harness 的公开契约，不实现源码。
> 编号依据：`docs/design/browser-harness/21-G-browser-sqlite-worker承载.md` 是当前最新阶段模块号；本稿续为 22-H。
> 权威依据：本仓 `docs/design/browser-harness/01-共同上下文.md`（Browser 剖面、打包扩展通道、无 Node API），以及 Sefirot 仓 `docs/design/需求原话.md`、`06-提示词系统.md`、`09-工具面.md`、`01-回合编排.md`、`02-context池.md`。Sefirot 阶段 3 裁决要求五项 Browser 缺口统一设计一次（`需求原话.md:472-478`）；消费方文档中的业务语义高于本稿的 API 便利性建议。
> 标注：带 `file:line` 的内容为源码/既有设计事实；`[推断]` 为推荐方案；未确定内容列入 §12。

## 1. 共享契约（五项统一冻结）

### 1.1 Browser-safe 会话与多会话所有权

- `createPiHarness(options)` 是单会话低层工厂，当前返回一份 `AgentSession` 并提供 `prompt/abort/dispose`，没有 host registry（`packages/browser-engine/src/assemble.ts:353,547-602`）。新增 `createPiHarnessHost(options)` 是组合/生命周期所有者，不是第二套 Agent、session protocol 或 executor。
- 每个 session 独立拥有 `AgentSession`、`SessionManager`/会话树、`ExtensionRunner`、工具注册、订阅、队列/abort 状态及 side-request 生命周期。不得在 session 间共享可变会话状态。[推断] 遵循 Node multi-session Host 的隔离原则（`plan/multi-session-host/00-共同上下文.md:67-82`）。
- Browser 公开面不得依赖 `node:*`、`process`、Node 文件系统或 Node 锁；经现有 `HarnessEnv`、StorageBackend、静态打包资源及浏览器 API 执行。v1 不承诺跨 tab coordination。

### 1.2 事件与订阅者调度

```ts
export interface HarnessEventEnvelope {
  readonly sessionId: string;
  readonly sequence: number; // session-local 分发序号，不跨刷新持久
  readonly timestamp: number;
  readonly event: AgentSessionEvent;
}
export type HarnessEventListener = (event: HarnessEventEnvelope) => void;
```

- `PiHarness.subscribe(listener): () => void` 提供 session-scoped 原生事件流；host subscription 汇聚成员事件并附 sessionId。取消订阅幂等。
- AgentSession `_emit` 同步遍历 listener（`packages/coding-agent/src/core/agent-session.ts:1142-1146`），因此 browser adapter 不得在 `_emit` 调用栈直接执行用户 callback。每个 listener 使用独立异步 FIFO 队列；同步 emit 阶段仅做有界入队，队列容量 1024。callback throw 时停用该 subscriber 并调用 `onError`；队列满时停用订阅并上报 `{code:"subscriber_overflow",dropped:true}`，不阻塞模型且不静默丢事件后继续声称订阅完整。收到 overflow 的消费方必须读取 session snapshot/journal 补齐后重新订阅。明确不承诺慢订阅者零丢失。
- 原事件联合是唯一流协议：文本 delta、工具执行进度、消息结束、失败等复用 AgentSession 事件；`sequence` 不替代 session entry ID、Room TurnId 或 Sefirot event seq。
- `BrowserExecutor` 已有私有 `session.subscribe(emitAgentEvent)` 并维护 transcript/progress（`packages/browser-engine/src/executor.ts:37-39,724-728,1322-1323`）；新增 callback 不改变 Pi protocol 帧、不重复发送 wire event。

### 1.3 注册及消息政策

- Browser 仅使用静态打包 `ExtensionFactory`，不支持磁盘扩展发现和任意 Node module（Browser harness 共同契约 `docs/design/browser-harness/01-共同上下文.md:163-168`）；现有入口 `extensions.factories` 见 `assemble.ts:182-184,476-500`。
- 工具与 prompt slot renderer 注册限定到单 harness/session scope；不得把模块级 Map 的 last-write-wins 当成隔离。
- custom message policy 由 `customType` registry 决定，不属于消息本体字段。`CustomTypePolicy` 及默认策略见 `packages/coding-agent/src/core/messages.ts:36-85`；扩展入口 `registerCustomType(customType, policy)`、first declaration wins 见 `packages/coding-agent/src/core/extensions/types.ts:1573-1608`。

## 2. 一句话定位

统一扩展 Browser harness 公开能力，让产品可以注入自定义工具、按类型登记 custom message policy、订阅 session 流、管理多个隔离 session、注册 prompt slots 并在 compact 后替换 ephemeral context slots，且可调用原生 subagent 和 side request 路径；不新增 Node API、平行工具/事件/Agent 协议。

## 3. 工具注入与 custom message policies

### 3.1 API 提案

```ts
import type { ToolDefinition, ExtensionToolContext, CustomTypePolicy } from "@earendil-works/pi-browser";
export type MaybePromise<T> = T | Promise<T>;

export interface BrowserToolHandlerContext {
  readonly sessionId: string;
  readonly signal?: AbortSignal;
  /** policy 必须已注册；实现调用原生 sendMessage 且不触发额外 turn。 */
  appendMessage(message: {
    readonly customType: string;
    readonly content: string;
    readonly display: false;
    readonly details?: unknown;
  }): void;
  /** await 会保持当前工具执行 pending，host answer 恢复它。 */
  askHost(question: string, options?: { readonly signal?: AbortSignal }): Promise<string>;
  readonly extension: ExtensionToolContext;
}
export interface BrowserCustomTool {
  readonly definition: Omit<ToolDefinition, "execute">;
  readonly handler: (
    toolCallId: string,
    params: unknown,
    context: BrowserToolHandlerContext,
    onUpdate?: (progress: unknown) => void,
  ) => MaybePromise<{ content: readonly unknown[]; details?: unknown }>;
}
export interface PiHarnessToolsOptions {
  readonly enabled?: readonly ToolName[];
  readonly disabled?: readonly ToolName[];
  readonly operations?: Partial<Record<ToolName, unknown>>;
  readonly custom?: readonly BrowserCustomTool[];
  readonly customTypes?: readonly { readonly customType: string; readonly policy: Partial<CustomTypePolicy> }[];
}
```

原生 Extension API 的 `sendMessage` 接受 `{customType,content,display,details}` 并返回 void（`extensions/types.ts:1627-1631`）；adapter 对齐该消息形状，不添加 compaction 字段，policy 由 customType 查表。adapter 在工具循环内追加消息且不触发额外 turn；具体确保消息对紧接着的下一次 provider request 可见的 session-safe seam 见 §12。

### 3.2 Sefirot customType 映射

以下为建议的每 session `registerCustomType` 声明；policy 由 runtime 按类型应用。未声明时使用 pi-rp 默认 `{context:"include",llmRole:"user",compaction:"include"}`。

| customType | 内容/用途 | context | llmRole | compaction | 依据 |
|---|---|---|---|---|---|
| `sefirot.context-update` | load 设定/摘要/池上下文；`<context update>` | include | user | exclude | `02-context池.md:92-96,118`; `06-提示词系统.md:230-238` |
| `sefirot.state-update` | state 净变化；独立注入类型 | include | user | exclude | `06-提示词系统.md:240-242`; `需求原话.md:87-101` |
| `sefirot.user-input` | 编剧/作家本轮玩家输入 | include | user | exclude | `06-提示词系统.md:244-247,140-146` |
| `sefirot.outline` | 作家收到的大纲 | include | user | exclude | `06-提示词系统.md:249-252,140-146` |
| `sefirot.relay` | chat agent 给编剧/作家的 relay | include | user | exclude | `02-context池.md:98-100,118` |

`compaction:"exclude"` 规定 message history summarization 输入；不能代替 ephemeral slot 保活。pool entry durability/activity、custom message 的 compaction policy 与 prompt slot 生命周期彼此独立。

### 3.3 行为及错误

- `tools.custom` 由 `createPiHarness` 转成内联 ExtensionFactory，通过既有 ExtensionRunner 注册；schema、权限、工具激活仍由 ExtensionRunner 决定。当前入口只有内建开关和 Operations 覆盖（`assemble.ts:114-123`），这是新增接线，不另造工具执行器。
- 同步/异步 handler 统一 await；onUpdate 复用原生 tool progress。工具名冲突、policy 重复声明且内容不一致、未知 policy 键应在组装时报告；handler throw/reject、schema 错误、signal abort 按标准 tool error/cancellation 处理。
- custom message 必须先注册 type policy 再 append；首条声明生效，不能对同一 customType 期望后续覆写（`extensions/types.ts:1594-1608`）。`display:false` 不决定 LLM 可见性，context/role/compaction 均按上表政策处理。
- 工具 handler 静态随应用 bundle 导入，不接收 Node module/path/热加载。[推断] Browser v1 更新扩展通过新 bundle/harness 实例。

### 3.4 ask 工具挂起/恢复

`ask(question)` 通过 custom tool handler 返回一个尚未 resolve 的 Promise 挂起当前 `execute`；AgentSession tool loop 等待该调用，不继续生成。host broker 生成唯一 questionId、广播 host_question，再等待 host answer。`host.answerQuestion(sessionId,questionId,answer)` resolve 同一 Promise，answer 成为该 ask 的 tool result 并恢复同一 session/tool loop；不新建 turn、不触发 writer。host-only/guest 限制由 Sefirot host 的身份层 enforce，pi-rp 负责 session 与 questionId 精确路由。

```ts
export interface HostQuestionRequested {
  readonly type: "host_question";
  readonly sessionId: string;
  readonly questionId: string;
  readonly question: string;
}
export interface PiHarnessHost {
  subscribe(listener: (event: HarnessEventEnvelope | HostQuestionRequested) => void): () => void;
  answerQuestion(sessionId: string, questionId: string, answer: string): boolean;
}
```

Ask 等待必须绑定工具 `AbortSignal`。signal abort、session/host dispose 或取消问题时移除 pending broker 项并以 cancellation/error 终止该工具调用，不自动填空。重复/过期 questionId 返回 false；错误 sessionId 返回 false。闭环即 pending execute → host_question → answer route → resolve pending execute → tool result → 原生 loop resume，不需要另造 resume command。契约依据 `09-工具面.md:73-80`。

### 3.5 Sefirot 消费路径

Screenwriter 注册 `lookup/load/save_setting/submit/ask/roll_dice`，preset 白名单决定工具可见性；`load` 先注册 `sefirot.context-update` type policy，再 append none-display message。state_update 继续用内建 pi-rp 工具。工具业务、save overlay 与 submit gate 归 Sefirot（`09-工具面.md:13-21,39-48,73-96`）。

## 4. Session 事件订阅

```ts
export interface PiHarness { subscribe(listener: HarnessEventListener): () => void; }
export interface PiHarnessHost {
  subscribe(listener: (event: HarnessEventEnvelope | HostQuestionRequested) => void): () => void;
}
```

持续订阅至 unsubscribe/dispose，与 `prompt()` 内只监听 agent_end 并在调用完成后解绑不同（`assemble.ts:564-581`）。Sefirot 监听 screenwriter 流/工具进度并将 writer message delta 映射为 ProseDelta；产品自行完成事件落账和 turn/attempt 关联（`01-回合编排.md:14-22,46-60`）。pi-rp sequence 不替代 Room TurnId、attemptId 或 EngineEvent seq。

## 5. 自定义 prompt slots 与 ephemeral slots

### 5.1 API 提案

```ts
export interface PiHarness {
  /** per AgentSession PromptRegistryScope 注册 renderer */
  registerPromptSlot(definition: SlotDefinition): void;
}
export interface SessionCompactResult {
  readonly replaceContextSlots?: readonly { slotId: string; content: string }[];
}
```

`SlotDefinition` 及 renderer context 沿用 coding-agent 类型，不另造字段。prompt slot 注册、lookup、位置判定、render 均使用同一 AgentSession `PromptRegistryScope`；AgentSession 已有 scope getter，subagent prepare 也传入 parent session prompt scope（`agent-session.ts:867-869`；`subagent/prepare.ts:223-224`）。

### 5.2 Identity slots 与 compact replacement

- preset 可由 `options.presets` inline 输入（`assemble.ts:165-173,398-417`）；当前 browser renderer 对 chat-history 以外 slot 诊断后空渲染（`browser-slot-renderers.ts:35-65`），必须打通 session-scoped renderer dispatch。
- `writer|screenwriter|char|consultant-instructions`、常驻/勾选设定与 state hint renderer 由 Sefirot 注册；六段顺序、用户可写 block 与 state hint 归编剧由消费方冻结（`06-提示词系统.md:60-80`），pi-rp 不写死这些业务 slot。
- `sefirot.pool` 是 ephemeral prompt context slot，不是 custom message。新增 `SessionCompactResult.replaceContextSlots` seam：在 awaited `session_compact` hook 成功返回后，AgentSession 完成 history rebuild，再将同名 slot 的 content 替换进内存态 prompt context，必须在下一次 provider request 前生效；同 slotId replacement 不追加 SessionEntry/JSONL。Pool host 在 compact review 与 PoolActivity transaction 成功后生成该数组，按当前 Room/session ancestry 计算快照；失败时不替换旧 slot。这个新 seam 与 Sefirot `02-context池.md:108-114`、`06-提示词系统.md:79` 对齐，当前不是 pi-rp Browser 已有能力。
- slot definition scope 和 context slot value 均按 session 隔离；不能用 custom message 的 compaction exclusion 代替 slot replacement。

### 5.3 错误与验证

内建 slot 冲突、重复 slot definition、缺必需 renderer、错误 scope 或 renderer reject 均给出可定位错误，不静默空渲染。验收包含并发同名 slot 无串扰；compact 后 pool slot 替换、连续 compact 不叠加、不写 journal、下一 provider request 收到新快照。

## 6. Browser multi-session host

### 6.1 API 提案

```ts
export interface CreatePiHarnessHostOptions {
  readonly createHarnessOptions: (sessionId: string) => CreatePiHarnessOptions | Promise<CreatePiHarnessOptions>;
  readonly onError?: (error: { sessionId?: string; code: string; message: string }) => void;
}
export interface PiHarnessHost {
  createSession(sessionId: string): Promise<PiHarness>;
  getSession(sessionId: string): PiHarness | undefined;
  listSessions(): readonly string[];
  disposeSession(sessionId: string): Promise<boolean>;
  answerQuestion(sessionId: string, questionId: string, answer: string): boolean;
  subscribe(listener: (event: HarnessEventEnvelope | HostQuestionRequested) => void): () => void;
  dispose(): Promise<void>;
}
export function createPiHarnessHost(options: CreatePiHarnessHostOptions): PiHarnessHost;
```

### 6.2 生命周期与复用评估

- 本 API 是单 tab 内存 registry，sessionId 由产品 room/role 层分配；不是远程 PiServer、多标签页 host 或 durable catalog。角色各自传独立 `storage.sessionManager`/session-scoped store（注入点 `assemble.ts:100-112`）。
- Node `PiServer/PiClient` 提供 durable route ID、create/list/attach/detach、lease/acquire 生命周期（`plan/multi-session-host/10-host-api-session-lifecycle.md:22-37,95-112`）；Browser 复用隔离/创建/销毁语义，不复制 PiServer/PiClient/wire protocol/Node 文件锁。[推断] 跨刷新恢复由消费方 storage 决定，host registry 不持久化。
- 同 ID create 拒绝；不同 ID 可并发组装；失败不入 registry。disposeSession abort→dispose 成员；host dispose 停止新创建、abort 全员、await dispose 后清空 map。局部错误通过 onError 上报且不阻止其他 session 清理。
- 每个成员独立拥有 ExtensionRunner、SessionManager、customType/PromptRegistryScope、ask broker、事件序号和 listeners。Node Host 冻结契约警示模块级 slot/provider registry 隔离（`plan/multi-session-host/00-共同上下文.md:29-30,80-82`）；provider compat 全局注册策略需审计，不能声称 ExtensionRunner 独立就等于全隔离。

### 6.3 Sefirot 消费路径

创建 screenwriter、writer、chat 三个长期 harness，各自有独立 SessionManager/preset；RoundClosed 进入 screenwriter，outline 后 writer 生成，chat 的互斥调度遵从 `01-回合编排.md:31-60`。Pool host 管共享数据与跨会话 fan-out，不共享 AgentSession transcript/tree。

## 7. Native subagent 与 side request Browser 路径

### 7.1 Subagent 不增加 host wrapper

不公开 `PiHarness.spawnSubagent()`，不造 `spawn_consultant`。screenwriter 继续用原生 `subagent_profiles` + `subagent(profileId,task)`；core tools 在 AgentSession 内注册（`agent-session.ts:5270-5272`），subagent_profiles 是唯一模型可见的 profile discovery/授权路径。Browser 前置仅保证 bundled profiles 能被 loader 实例化，session PromptRegistryScope 和工具能力完整透传到原生 prepare/run；不得另造 profile lookup、权限规则或并行 spawn API（`09-工具面.md:27-31`）。

`spawnAgent` 是原生 subagent tool/Extension API 的内部实现机制，parent signal/dispose 会取消调用（`subagent/spawn.ts:87-128`），不是产品新增调用路径。Browser bundle 验收 profile 枚举和 tool 调用；缺 profile、disabled、能力不符、启动失败须显式失败，不降级为 side request 或静默空列表。

### 7.2 Side request seam

Side request 有明确 prompt/context、无 session/history、无自动 transcript append：

```ts
export interface PiHarness {
  completeSideRequest(
    prompt: string,
    options: { modelRole?: "smol" | "default"; maxTokens?: number; signal?: AbortSignal; label: string },
  ): Promise<string>;
}
```

这是现有 primitive 的 Browser-safe session-scoped adapter，不是 subagent wrapper。Extension API 当前有 `completeSideRequest` context primitive（`agent-session.ts:5005-5071`；`extensions/types.ts:391-403`），另有内存宿主完整 prompt→文本路径（`agent-session.ts:5555-5587`）。Browser adapter 应选定并复用其中一个，明确 model resolver、signal/dispose abort、字符串提取；不直接泄露未审查的 ExtensionToolContext。失败 reject 传递，不吞鉴权/网络/取消错误。

Sefirot 预先编译完整文本：choice/compact-review 用 screenwriter session 的 side request；summary 输入已完成 writer 正文。结果由 Sefirot 决定入池/落账；不改变任何 session history（`06-提示词系统.md:177-224`；`02-context池.md:116-121`）。

## 8. 生命周期、隔离与副作用

- create：校验 ID/options；建立独立 harness、message policies、PromptRegistryScope、ask broker、event adapter；完整创建后才写入 host map。失败 dispose partial resources。
- ask：挂起 execute Promise，直到 host answer 或 signal/dispose 取消；错误 session/过期 ID 不 resolve。
- disposeSession：abort main run/side request/ask → unsubscribe → await harness.dispose → 清 host entry，不影响其他成员。
- host.dispose：拒绝新建 → abort 全部 → await all dispose → 清 map/listeners；逐项报错，继续清理其他成员。
- 浏览器 tab 强制退出时不保证 async dispose；StorageBackend/SessionManager 决定持久性，内存 map 不是 catalog。

## 9. pi-rp 落点与前置工作量

| 工作 | 建议落点 | 前置分级与 sefirot 消费 |
|---|---|---|
| 自定义 ToolDefinition+handler、customType policy 与安全 message append | `packages/browser-engine/src/assemble.ts`、`reexports.ts`、`index.ts`；`packages/coding-agent/src/core/extensions/runner.ts` 与 session-safe append seam | **P0**：lookup/load/save_setting/submit/ask/roll_dice；message policies 必须在首条 message 前注册 |
| ask pending execute / host answer route / cancellation | browser tool adapter、新 `packages/browser-engine/src/host.ts` broker | **P0**：ask 必须恢复同一个 tool loop 并 host-only |
| AgentSession event subscription + bounded async fan-out | `packages/browser-engine/src/assemble.ts` / 新 `harness-events.ts`、`executor.ts` | **P0**：流文本/工具进度/落账；overflow 后消费方恢复 snapshot/journal |
| Session-scoped slots + compact replaceContextSlots | `packages/coding-agent/src/core/prompt-preset/registry-scope.ts`、`slot-registry.ts`、`browser-slot-renderers.ts`、session compact result handling、browser exports | **P0**：提示词六段 slot 和 `sefirot.pool` compact 更新；确认不写 JSONL |
| Browser multi-session registry/lifecycle | 新 `packages/browser-engine/src/host.ts`、`index.ts`；`assemble.ts` 继续单 harness | **P0**：三常驻 session 隔离 |
| Browser subagent profile 闭环 + side request forwarding | `packages/browser-engine/src/assemble.ts`/`index.ts`、preset loader/subagent resource/capability path | **P0**：consultant/char 裁决和 summary/choice/review 完整消费依赖；原生 subagent tool 不新增 wrapper |
| 多 session provider/API registry 隔离 | `packages/ai/src/compat.ts`、AgentSession provider registration/reload | **P0 审计前置**：有差异化角色 provider 时须实现，不能跨会话覆写 |

所有阶段 3 五项均为目标产品完整验收前置；P0 表示范围必需，不代表串行实现顺序。先冻结契约、后分别实现并以真实 Browser bundle/Chromium 验收。Browser 与 Node PiServer 共享隔离原则，不共享 transport/durable catalog/file ownership。

## 10. 验收方式

1. **工具/policy**：sync/async handlers 返回原生结果及进度；逐类型检验 `display:false` 消息在 live context 的 role 与 summarization compaction policy；消息本体无 compaction 字段；未声明 policy 用默认值并产生可定位诊断。
2. **ask**：ask 生成 host_question、agent 等待；host answer 成为原 tool result 并恢复同 loop；错误 session/guest/过期 ID 不恢复；abort/dispose 清 pending 并返回明确错误。
3. **event**：检查消息/工具流顺序，用户 callback 不在 `_emit` 栈中同步执行；listener throw/1024 队列溢出均隔离、不阻断 session；overflow 消费方按 snapshot/journal 恢复。
4. **slots/compact**：并发 harness 同名 slot 隔离；compact 后 `sefirot.pool` 同 slotId 替换，连续 compact 不叠加、不落 SessionEntry/JSONL，下一 provider request 收到新值。
5. **multi-session**：三 session history/tools/events/abort 隔离；重复 ID 冲突；dispose 一个不影响其余；host dispose 后全关闭且不可再 create。
6. **subagent/side request**：只有原生 `subagent_profiles`/`subagent` 路径；profile/task 错误可见、parent dispose 取消；side request 显式 prompt→文本，不产生 transcript/session entry。
7. Browser bundle 不引入 Node API；真实 Chromium 验证新路径，不以 Node-only tests 替代。Sefirot 集成另按 `06` 六段顺序、`09` ask/tool 权限、`01` writer delta/abort、`02` pool/subagent/side-request 语义验收。

## 11. 已知冲突

1. `browser-slot-renderers.ts:39-65` 当前除 chat-history 外空渲染，但 Sefirot 六段 preset 依赖自定义 slots（`06-提示词系统.md:62-80`）；必须补 scoped dispatch。
2. BrowserExecutor 有私有 transcript subscription，PiHarness 没公开 subscription；新增公开面须避免复制 wire protocol。
3. Node Host 契约提示模块级 slot/provider registry 有跨会话风险（`plan/multi-session-host/00-共同上下文.md:29-30,80-82`）；本稿将 slot scope 列为硬前置，provider registry 仍需审计。
4. custom message policy 按 customType 查表、append 不携带 compaction（`messages.ts:36-85`；`extensions/types.ts:1605,1627-1631`）；本稿 per-type policy map 对齐原生行为。
5. pool slot refresh 和 custom message compaction exclusion 是不同机制；本文明确 `SessionCompactResult.replaceContextSlots` 新增 seam。
6. ask 必须维持 pending tool execution 并经 host answer 恢复同一个 loop，不是普通 append/新 prompt（`09-工具面.md:73-80`）。
7. Subagent wrapper 会与 `09-工具面.md:27-31` 冲突，故明确不公开。
8. Node PiServer durable session host 与 Browser 单 tab host 拓扑不同；跨 tab/远程 transport/durable catalog 另立设计。

## 12. 仍未知待拍板

1. custom message 安全追加 seam 必须确保 tool handler 内 append 后紧接的 provider request 可见；当前 `sendMessage` 为 void（`extensions/types.ts:1627-1631`），需核实 `triggerTurn:false` 下的具体时序与落账保证。
2. 事件队列 1024 为契约建议值；真实 Browser writer delta 测量后如需 coalescing/调容，须保留满队列时显式 unsubscribe + recovery 规则，不能同步回调。
3. `SessionCompactResult.replaceContextSlots` 的 session compact return 类型、slot replace 原子性、history rebuild 失败处理和 await 顺序需 pi-rp 实现设计确认；Sefirot 语义已冻结，pi-rp seam 尚未实现/验证。
4. multi-session 是否共享 ModelRuntime/RequestGateway 未定；当前 `createPiHarness` 每次创建 ModelRuntime（`assemble.ts:450-456`），共享前需审查 provider reset/credentials 隔离。
5. Browser host 是否跨刷新恢复以及最大并发 session 数由消费方持有/配置；本设计不持久化 host registry。
6. Subagent preset Browser 全链（`getDelegatablePresets`、scope、tool capability filtering）需真实 bundle 验收；失败不能静默返回空 profile list。
7. Tool result helper 需对齐 `AgentToolResult` 内容/details；browser package 应 re-export 必要的 ToolDefinition、AgentSessionEvent、SlotDefinition、CustomTypePolicy 类型。

## 13. 需求对照

| Sefirot 冻结需求 | 设计兑现 | 原话 / 冻结文档依据 |
|---|---|---|
| 自定义工具、同步/异步 handler、none-display append、流式进度 | §3 接 ToolDefinition/ExtensionRunner；message type policy 独立注册；onUpdate 复用原生进度 | `需求原话.md:271-275,51-63`；`06-提示词系统.md:254-260`；`09-工具面.md:13-21,39-48` |
| session 事件订阅：文本、工具调用、消息落账 | §1.2/§4 复用 AgentSession event；bounded async fan-out，业务自行关联落账 | `需求原话.md:27-41`；`01-回合编排.md:46-60,114-123` |
| 自定义身份/pool/state slots，compact 后动态替换 | §5 session scoped slot renderer + awaited compact `replaceContextSlots`，不 append JSONL | `需求原话.md:209-227`；`06-提示词系统.md:60-80`；`02-context池.md:108-114` |
| screenwriter/writer/chat 三常驻 session 与生命周期隔离 | §1/§6 host 管多 session；复用 Node host 生命周期语义，不复制 PiServer transport | `需求原话.md:27-41,177-179,478`；`01-回合编排.md:31-60`；pi-rp `plan/multi-session-host/10-host-api-session-lifecycle.md:33-37,95-112` |
| consultant 原生 subagent；choice/summary/review side request | §7 不增加 spawn wrapper，原生 profiles/subagent；side request 显式 prompt，无 session/history | `需求原话.md:37-41,103-112,177-179,478`；`06-提示词系统.md:153-175,177-224`；`09-工具面.md:27-31`；`02-context池.md:116-121` |
| ask 挂起并由 host 回答恢复同一工具循环 | §3.4 pending execute Promise + questionId host route/abort | `需求原话.md:245-247`；`09-工具面.md:73-80` |
| 纯浏览器，不依赖 Node API | 静态打包注册；无 Node 扩展/API；跨 tab 未纳入 | `需求原话.md:23,27`；本仓 `docs/design/browser-harness/01-共同上下文.md:57-66,163-168` |

Sefirot 的 message 标签内容/权限/门禁、prompt 六段顺序、回合调度与 pool 持久性均由消费方设计负责；pi-rp 仅提供可复用通用执行原语。
