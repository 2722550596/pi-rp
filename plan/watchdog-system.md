# Watchdog 系统：轻量级单次调用审查/自动化机制

> 状态：草案 v3，可行性已对照 pi-rp 源码核对
> 关联：[multi-agent-infrastructure.md](./multi-agent-infrastructure.md) Step 5（本方案是其触发条件）

## 1. 目标

在 pi-rp 中实现一个**轻量级 watchdog 子系统**：支持注册多个命名的后台 watchdog，每个 watchdog 在指定触发条件下执行一次单次 LLM 调用（无 agent 循环、无工具、无持久上下文），将输出以可配置的方式送回主会话。

核心定位：**recap 的灵活性 + advisor 的花名册 + 单次调用的轻量**。不是常驻 agent，是"触发式 side request"。

### 与现有系统的关系

| 维度 | Idle Recap（omp） | Advisor（omp） | **Watchdog（本方案）** |
|---|---|---|---|
| 本质 | 单次 completion | 完整 agent + 持久上下文 | 单次 completion |
| 花名册 | 无（单一） | 有（配置文件） | 有（`watchdog.json`） |
| 触发 | 空闲定时 | 每回合 onTurnEnd | 可配置：turnEnd / traceEnd / 每 N traceEnd / 空闲 |
| 工具 | 无 | 有（read/grep/glob+） | 无 |
| 持久上下文 | 无 | 有（append-only + 维护/压缩） | 无（一次性快照） |
| 落盘 | 无 | __advisor.jsonl | session.jsonl（custom message） |
| 主 agent 可见 | 否 | 是（`<advisory>` 注入） | 可配置 |
| 打断 | 无 | concern/blocker 可 steer | 可配置 |
| 提示词构建 | 硬编码 | 独立 system prompt + delta 渲染 | **复用预设系统** |
| 复杂度 | ~50 行 | ~2000 行 | 预估 ~300-500 行 |

## 2. 用户决策（已确认）

- **实现层**：Core runtime（`core/watchdog/`）+ ExtensionAPI 暴露注册接口
- **机器可读输出**（jsonpatch 等）：仅事件总线（`pi.events.emit`），不写 custom message
- **不打断语义**：等下次用户 prompt，消息进 `_pendingNextTurnMessages`，随用户消息注入上下文
- **触发频率**："每 N 轮" = 每 N 次 `agent_end` 事件触发一次
- **提示词构建**：完全委托给预设系统（`compileMessages` + `compileSystemPrompt`）
- **配置格式**：JSON（`watchdog.json`），与 pi-rp 全局风格一致——pi-rp 零 YAML 依赖，所有配置均为 JSON

## 3. 核心设计：预设系统复用

### 3.1 为什么用预设系统

pi-rp 已有完善的预设系统（`core/prompt-preset/`），watchdog 的提示词需求完全在其能力范围内：

| watchdog 需求 | 预设系统对应能力 |
|---|---|
| 控制历史消息数量 | `chat-history` slot 的 `maxMessages` / `maxChars` |
| 注入当前 state | `state` slot（`format: json/yaml/key-value`，`allowNamespace` 过滤） |
| system prompt | 预设的 `role: "system"` block items |
| user prompt | 预设的 `role: "user"` block items |
| 变量替换 | 预设的 `variables` + `{{macro}}` |
| 历史过滤（去掉 thinking 等） | `chat-history` slot 的 `stripAssistantThinking` / `toolMode` / `roles` |
| 输出后处理 | 预设的 `regex` 规则（`finalize` stage） |

watchdog 不再自己拼提示词，而是引用一个预设 ID，执行时用 `compileMessages(preset, runtime)` 编译出完整消息数组。

### 3.2 编译流程

```
watchdog 触发
  └─ 构建 PromptRuntime
       ├─ messages: agent.state.messages（主会话当前消息）
       ├─ state: stateManager.snapshot()
       ├─ variables: { user, turnIndex, ... }
       └─ currentTraceStartIndex: 当前 trace 起点索引
  └─ compileMessages(preset, runtime)
       ├─ system block → systemPrompt
       ├─ state slot → 注入 state 到消息
       ├─ chat-history slot → 截取 maxMessages 条历史
       └─ user block → watchdog 的指令
  └─ compileSystemPrompt(preset, runtime, "") → 独立 system prompt
  └─ modelRegistry.complete(model, { systemPrompt, messages })
  └─ applyFinalizeRegexRulesToMessage(preset, response) → 后处理 LLM 输出
```

关键：`PromptRuntime.messages` 传主会话的 `agent.state.messages`，预设编译器的 `chat-history` slot 的 `maxMessages` 负责截取——watchdog runtime 不碰消息筛选。

### 3.3 预设引用方式

`watchdog.json` 中的每个 watchdog 通过 `preset` 字段引用预设：

```json
{
  "watchdogs": [
    { "name": "state-updater", "preset": "state-updater" }
  ]
}
```

`preset` 字段引用 `.pi/prompt-presets/state-updater.json` 的 `id`。预设文件放在标准的 `.pi/prompt-presets/` 目录，与主 agent 的预设共享发现路径（`loadPromptPresets`）。watchdog 预设不需要特殊标记——它就是一个普通预设，只是被 watchdog 引用而非激活为主预设。

### 3.4 watchdog.json 配置格式

```json
{
  "defaults": {
    "retry": {
      "enabled": true,
      "maxRetries": 2,
      "baseDelayMs": 1000
    }
  },
  "watchdogs": [
    {
      "name": "story-summary",
      "enabled": true,
      "model": "openai/gpt-5.2",
      "thinkingLevel": "medium",
      "trigger": { "type": "everyNTraces", "n": 3 },
      "preset": "story-summary",
      "delivery": { "persist": true, "deliverAs": "nextTurn", "statusBar": true },
      "retry": { "maxRetries": 3 }
    },
    {
      "name": "state-updater",
      "model": "openai/gpt-5.2",
      "trigger": { "type": "turnEnd" },
      "preset": "state-updater",
      "delivery": { "persist": false, "eventBus": true }
    },
    {
      "name": "idle-recap",
      "enabled": false,
      "trigger": { "type": "idle", "idleSeconds": 120 },
      "preset": "idle-recap",
      "delivery": { "persist": false, "statusBar": true }
    }
  ]
}
```

### 3.5 字段定义

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | string | 是 | 唯一标识，slug 化用于 customType 和事件通道 |
| `enabled` | boolean | 否 | 默认 true |
| `model` | string | 否 | `provider/modelId`，省略用会话当前模型 |
| `thinkingLevel` | string | 否 | `low`/`medium`/`high`，省略用会话当前 |
| `trigger.type` | `turnEnd` / `traceEnd` / `everyNTraces` / `idle` | 是 | 触发类型 |
| `trigger.n` | number | `everyNTraces` 时必填 | 每 N 轮触发 |
| `trigger.idleSeconds` | number | `idle` 时必填 | 空闲秒数 |
| `preset` | string | 是 | 预设 ID，引用 `.pi/prompt-presets/<id>.json` |
| `delivery.persist` | boolean | 否 | 默认 true |
| `delivery.deliverAs` | `nextTurn` / `steer` / `followUp` | 否 | 默认 `nextTurn` |
| `delivery.triggerTurn` | boolean | 否 | 默认 false |
| `delivery.eventBus` | boolean | 否 | 默认 false |
| `delivery.statusBar` | boolean | 否 | 默认 false |
| `retry` | RetryPolicy | 否 | 省略用 `defaults.retry` 或 `settings.retry` |

## 4. 架构

### 4.1 数据流

```
触发事件（turn_end / agent_end / idle timer）
  └─ WatchdogRuntime.onTrigger(event)        [同步，不阻塞]
       ├─ 检查触发条件（计数器 / idle 定时器）
       ├─ busy? → 丢弃
       └─ fire-and-forget #execute()
            ├─ 构建 PromptRuntime（messages + state + variables）
            ├─ compileMessages(preset, runtime) → 消息数组
            ├─ compileSystemPrompt(preset, runtime, "") → system prompt
            ├─ modelRegistry.complete(model, { systemPrompt, messages })
            │   └─ 包裹 retryAssistantCall
            ├─ applyFinalizeRegexRulesToMessage(preset, response) → 后处理
            ├─ epoch guard（session switch 后的 stale 结果丢弃）
            └─ 送达
                 ├─ persist → sendCustomMessage({customType:"watchdog:<slug>"}, {deliverAs})
                 ├─ eventBus → pi.events.emit("watchdog:output", {name, slug, text, raw})
                 └─ statusBar → ui.notify()
```

### 4.2 关键约束：不阻塞主循环

扩展事件处理器是 `await` 逐个执行的（`ExtensionRunner.emit` → `await handler(event, ctx)`）。Watchdog 的事件钩子**必须同步返回**，LLM 调用 fire-and-forget：

```ts
// agent-session.ts _emitExtensionEvent 中（同步调用，不 await）
this._watchdogRuntime?.onTurnEnd();  // 内部 void this.#execute(...)
```

### 4.3 触发模型

| 触发类型 | 事件源 | 计数器 | 说明 |
|---|---|---|---|
| `turnEnd` | `turn_end` | 每 turn | 每个 turn 结束触发 |
| `traceEnd` | `agent_end` | 每 trace | 一个完整 user 轮结束触发 |
| `everyNTraces` | `agent_end` | 每 N trace | 累计 N 次 agent_end 后触发，计数器归零 |
| `idle` | `setTimeout` | — | `agent_settled` 后启动定时器，`before_agent_start` / `turn_start` 取消 |

### 4.4 输出与送达

| 通道 | 机制 | 效果 |
|---|---|---|
| `persist` | `sendCustomMessage({customType:"watchdog:<slug>", content, display:true}, {deliverAs})` | 落盘 + 注入主会话 |
| `deliverAs` | 同上 options | `nextTurn`（等下次 prompt）/ `steer`（打断）/ `followUp`（排队） |
| `triggerTurn` | 同上 options | idle 时触发新回合 |
| `eventBus` | `pi.events.emit("watchdog:output", {name, slug, text, raw})` | 转译扩展消费 |
| `statusBar` | `ui.notify(text, "info")` | 状态栏一行展示 |

典型组合：
- **自动总结**：`persist + nextTurn + statusBar`
- **jsonpatch 状态更新**：`eventBus only`
- **recap 式提醒**：`statusBar only`

### 4.5 生命周期与并发

每个 watchdog 实例：
- `AbortController` — 当前执行的 abort 句柄
- `busy: boolean` — 防重入（busy 时新触发**丢弃**，不排队）
- `traceCount` — everyNTraces 计数器
- `idleTimer` — idle 触发定时器

生命周期：
- **session switch / compaction / tree navigation**：abort 当前执行，重置 idle 定时器，epoch++
- **session dispose**：abort 所有，清理定时器
- **config reload**：abort 所有，重新解析配置和预设，重建实例

并发：不同 watchdog 可并发执行（各自独立 AbortController）；同一 watchdog busy 时丢弃新触发。

不需要 omp advisor 的 drain/coalesce/backlog/catchup 机制（无持久上下文、无积压）。

### 4.6 epoch guard

session switch 后，已 in-flight 的 watchdog 执行可能在新 session 上下文中完成。用一个递增 `#epoch` 数字防止 stale 结果写入新 session：

```ts
const epoch = this.#epoch;
// ... async LLM call ...
if (this.#epoch !== epoch || this.#disposed) return;  // stale，丢弃
```

`reset()` 时 `#epoch++`。这是 omp advisor epoch 机制的极简版——因为单次调用无需处理 backlog 重放，只需丢弃 stale 结果。

### 4.7 失败处理

复用 `retryAssistantCall`（**import 自 `@earendil-works/pi-ai`**，与 compaction 一致——`compaction.ts:9`）：

```ts
import { retryAssistantCall } from "@earendil-works/pi-ai";

const response = await retryAssistantCall(
    () => modelRegistry.complete(model, context, options),
    retryPolicy,
    abortSignal,
    { onRetryScheduled: (n, max, delay, err) => logger.warn(...) }
);
```

- 重试耗尽 → drop + log warn，不阻塞主会话
- abort → 静默丢弃
- 无需 quota 闩锁 / halted 状态机（下次触发自然重试）

## 5. 实现方案

### 5.1 文件结构

```
packages/coding-agent/src/core/watchdog/
├── config.ts              # watchdog.json 发现与解析
├── runtime.ts             # WatchdogRuntime：触发、执行、生命周期
├── types.ts               # WatchdogConfig, TriggerType, DeliveryConfig 等
└── index.ts               # 导出 + 注册到 AgentSession

packages/coding-agent/src/core/extensions/types.ts  # 扩展 API 新增 pi.watchdog
```

### 5.2 核心类型

```ts
// types.ts

export type TriggerType = "turnEnd" | "traceEnd" | "everyNTraces" | "idle";

export interface WatchdogTrigger {
    type: TriggerType;
    n?: number;
    idleSeconds?: number;
}

export interface WatchdogDelivery {
    persist?: boolean;
    deliverAs?: "nextTurn" | "steer" | "followUp";
    triggerTurn?: boolean;
    eventBus?: boolean;
    statusBar?: boolean;
}

export interface WatchdogConfig {
    name: string;
    enabled?: boolean;
    model?: string;
    thinkingLevel?: string;
    trigger: WatchdogTrigger;
    preset: string;             // 预设 ID
    delivery?: WatchdogDelivery;
    retry?: RetryPolicy;
}

export interface WatchdogOutput {
    name: string;
    slug: string;
    text: string;
    raw: AssistantMessage;
    timestamp: number;
}
```

### 5.3 WatchdogRuntime

```ts
// runtime.ts

interface WatchdogInstance {
    config: WatchdogConfig;
    slug: string;
    model: Model<Api> | undefined;
    preset: PromptPreset;            // 解析后的预设
    traceCount: number;
    idleTimer?: NodeJS.Timeout;
    abortController?: AbortController;
    busy: boolean;
}

export class WatchdogRuntime {
    #instances: WatchdogInstance[] = [];
    #disposed = false;
    #epoch = 0;

    constructor(
        private readonly sessionManager: SessionManager,
        private readonly modelRegistry: ModelRegistry,
        private readonly stateManager: StateManager,
        private readonly eventBus: EventBus,
        private readonly sendCustomMessage: AgentSession["sendCustomMessage"],
        private readonly uiNotify?: (text: string, level: string) => void,
        private readonly getActiveModel: () => Model<Api> | undefined,
        private readonly getCurrentTraceStartIndex: () => number | undefined,
    ) {}

    onTurnEnd(): void { ... }
    onAgentEnd(): void { ... }
    onAgentSettled(): void { ... }
    onBeforeAgentStart(): void { ... }

    async #execute(instance: WatchdogInstance): Promise<void> { ... }

    reset(): void { ... }
    dispose(): void { ... }
    reload(configs: WatchdogConfig[], presets: LoadedPromptPreset[]): void { ... }
}
```

### 5.4 单次请求执行

```ts
async #execute(instance: WatchdogInstance): Promise<void> {
    if (instance.busy || this.#disposed) return;
    instance.busy = true;
    const epoch = this.#epoch;
    const abort = new AbortController();
    instance.abortController = abort;

    try {
        // 1. 解析模型
        const model = instance.model ?? this.#getActiveModel();
        if (!model) { logger.warn("watchdog: no model"); return; }

        // 2. 构建 PromptRuntime（复用主会话的消息和状态）
        const runtime: PromptRuntime = {
            options: this.#baseSystemPromptOptions,  // 复用主会话的 system prompt 选项
            messages: this.#sessionManager.buildSessionContext().messages,
            currentTraceStartIndex: this.#getCurrentTraceStartIndex(),
            latestUserMessage: undefined,
            now: new Date(),
            variables: { user: this.#userName },
            skills: [],                               // watchdog 不注入 skills
            state: this.#stateManager.snapshot(),
        };

        // 3. 编译预设 → 消息数组 + system prompt
        const compiled = compileMessages(instance.preset, runtime);
        const systemResult = compileSystemPrompt(instance.preset, runtime, "");
        const llmMessages = convertToLlm(compiled.messages);

        // 4. 执行（retryAssistantCall import 自 @earendil-works/pi-ai）
        const context: Context = {
            systemPrompt: systemResult.systemPrompt,
            messages: llmMessages,
        };
        const options: SimpleStreamOptions = {
            cacheRetention: "none",
            sessionId: `${this.#sessionId}:watchdog:${instance.slug}`,
            signal: abort.signal,
        };
        const response = await retryAssistantCall(
            () => this.#modelRegistry.complete(model, context, options),
            instance.config.retry ?? this.#defaultRetry,
            abort.signal,
        );

        // 5. epoch guard
        if (this.#epoch !== epoch || this.#disposed) return;

        // 6. 应用 finalize 正则（与主 agent message_end 路径一致，见 agent-session.ts:887）
        let processed: AssistantMessage = response;
        const finalizeDiags: PromptPresetDiagnostic[] = [];
        const finalized = applyFinalizeRegexRulesToMessage(instance.preset, response, finalizeDiags);
        if (finalized) processed = finalized;

        // 7. 提取文本
        const text = processed.content
            .filter((c): c is TextContent => c.type === "text")
            .map(c => c.text)
            .join("\n");
        if (!text.trim()) return;

        // 8. 送达
        this.#deliver(instance, text, processed);
    } catch (err) {
        if (!abort.signal.aborted) {
            logger.warn(`watchdog "${instance.config.name}" failed`, { err: String(err) });
        }
    } finally {
        instance.busy = false;
        instance.abortController = undefined;
    }
}
```

### 5.5 AgentSession 接线

`turn_end` 和 `agent_end` 在 `_emitExtensionEvent` 中（`agent-session.ts:837-854`），在 `await extensionRunner.emit(...)` 之后同步调用：

```ts
// agent-session.ts _emitExtensionEvent 修改
} else if (event.type === "turn_end") {
    await this._extensionRunner.emit(extensionEvent);
    this._watchdogRuntime?.onTurnEnd();       // 同步
    this._turnIndex++;
} else if (event.type === "agent_end") {
    await this._extensionRunner.emit({ type: "agent_end", messages: event.messages });
    this._watchdogRuntime?.onAgentEnd();      // 同步
}
```

`agent_settled` **不在 `_emitExtensionEvent` 中**——它在独立的 `_emitAgentSettled()` 方法（`agent-session.ts:696-704`）。idle 触发器的启动钩子接在这里：

```ts
// agent-session.ts _emitAgentSettled 修改
private async _emitAgentSettled(): Promise<void> {
    this._isAgentRunActive = false;
    try {
        await this._extensionRunner.emit({ type: "agent_settled" });
        this._watchdogRuntime?.onAgentSettled();  // 同步：启动 idle 定时器
        this._emit({ type: "agent_settled" });
    } finally {
        this._resolveIdleWaitIfIdle();
    }
}
```

`prompt()` 方法中 `before_agent_start` 前取消 idle 定时器：

```ts
this._watchdogRuntime?.onBeforeAgentStart();
```

Session 生命周期：
- `switchSession()` / tree navigation / compaction → `watchdogRuntime.reset()`
- `dispose()` → `watchdogRuntime.dispose()`
- `reload()` → 重新发现 `watchdog.json` + 预设 → `watchdogRuntime.reload(configs, presets)`

### 5.6 ExtensionAPI 暴露

```ts
export interface ExtensionAPI {
    // ... 现有方法 ...

    /** Dynamic watchdog registration. */
    watchdog: {
        register(config: WatchdogConfig): void;
        unregister(name: string): void;
        list(): readonly WatchdogConfig[];
    };
}
```

动态注册的 watchdog 与 `watchdog.json` 配置合并：同 slug 时动态注册优先。

## 6. 用例

### 6.1 AIRP 自动总结（每 3 轮）

`.pi/watchdog.json`:
```json
{
  "watchdogs": [
    {
      "name": "story-summary",
      "model": "openai/gpt-5.2",
      "trigger": { "type": "everyNTraces", "n": 3 },
      "preset": "story-summary",
      "delivery": { "persist": true, "deliverAs": "nextTurn", "statusBar": true }
    }
  ]
}
```

`.pi/prompt-presets/story-summary.json`:
```json
{
  "schemaVersion": 1,
  "id": "story-summary",
  "items": [
    {
      "kind": "block", "id": "sys", "role": "system",
      "content": "You are a story progress summarizer. Output 2-3 sentences."
    },
    {
      "kind": "slot", "id": "state", "role": "user",
      "slot": "state", "options": { "format": "json" }
    },
    {
      "kind": "slot", "id": "history", "role": "user",
      "slot": "chat-history", "options": { "maxMessages": 50, "stripAssistantThinking": true }
    },
    {
      "kind": "block", "id": "instruction", "role": "user",
      "content": "Summarize plot beats, character arcs, and world state changes."
    }
  ]
}
```

效果：每 3 个 user 轮 → 后台编译预设（state + 最近 50 条历史 + 指令）→ LLM 调用 → finalize 正则 → 落盘 `watchdog:story-summary` custom message → 下次 prompt 注入 → 状态栏提示。

### 6.2 自动状态更新（每轮，jsonpatch）

`.pi/watchdog.json`:
```json
{
  "watchdogs": [
    {
      "name": "state-updater",
      "model": "openai/gpt-5.2",
      "trigger": { "type": "turnEnd" },
      "preset": "state-updater",
      "delivery": { "persist": false, "eventBus": true }
    }
  ]
}
```

`.pi/prompt-presets/state-updater.json`:
```json
{
  "schemaVersion": 1,
  "id": "state-updater",
  "items": [
    {
      "kind": "block", "id": "sys", "role": "system",
      "content": "You output JSON Patch (RFC 6902) arrays. Output ONLY the JSON array, no prose."
    },
    {
      "kind": "slot", "id": "state", "role": "user",
      "slot": "state", "options": { "format": "json" }
    },
    {
      "kind": "slot", "id": "history", "role": "user",
      "slot": "chat-history", "options": { "maxMessages": 20, "stripAssistantThinking": true }
    },
    {
      "kind": "block", "id": "instruction", "role": "user",
      "content": "Output a JSON Patch array for state changes from this turn."
    }
  ],
  "regex": {
    "rules": [
      {
        "id": "extract-json",
        "stage": "compiled",
        "effect": "finalize",
        "pattern": "```json\\n([\\s\\S]*?)```",
        "flags": "g",
        "replace": "$1"
      }
    ]
  }
}
```

finalize 正则在此剥离 markdown code fence，转译扩展拿到的就是纯 JSON。

转译扩展：
```ts
export default function (pi: ExtensionAPI) {
    pi.events.on("watchdog:output", (data) => {
        const { name, text } = data as WatchdogOutput;
        if (name !== "state-updater") return;
        try {
            const patches = JSON.parse(text) as JsonPatch[];
            for (const patch of patches) {
                pi.updateState(patch.path, patch.op, patch.value);
            }
        } catch (e) {
            console.error("Failed to apply state patches:", e);
        }
    });
}
```

### 6.3 Idle Recap

`.pi/watchdog.json`:
```json
{
  "watchdogs": [
    {
      "name": "idle-recap",
      "trigger": { "type": "idle", "idleSeconds": 120 },
      "preset": "idle-recap",
      "delivery": { "persist": false, "statusBar": true }
    }
  ]
}
```

`.pi/prompt-presets/idle-recap.json`:
```json
{
  "schemaVersion": 1,
  "id": "idle-recap",
  "items": [
    {
      "kind": "block", "id": "sys", "role": "system",
      "content": "Recap in under 40 words. Lead with current task, then next action. No markdown."
    },
    {
      "kind": "slot", "id": "history", "role": "user",
      "slot": "chat-history", "options": { "maxMessages": 30, "stripAssistantThinking": true }
    }
  ]
}
```

## 7. 与 multi-agent-infrastructure.md 的关系

本方案是 Step 5（BackgroundLoopRuntime）的**第一个消费者**，但不需要完整的 BackgroundLoopRuntime：

| BackgroundLoopRuntime 特性 | Watchdog 是否需要 |
|---|---|
| pending 队列 + drain 循环 | 不需要（busy 时丢弃） |
| coalesce 轮数 | 不需要 |
| epoch 失效 | 需要极简版（一个数字比较） |
| backlog / catchup waiter | 不需要 |
| 持久上下文维护 | 不需要 |

当未来出现需要持久上下文的常驻循环时，再抽 BackgroundLoopRuntime 骨架。

## 8. 实施计划

### Phase 1：核心 runtime

1. `core/watchdog/types.ts` — 类型定义
2. `core/watchdog/config.ts` — `watchdog.json` 发现与解析
3. `core/watchdog/runtime.ts` — WatchdogRuntime（触发、执行、生命周期）
4. `core/agent-session.ts` — 接线（事件钩子 + 构造 + 生命周期）
5. 手动测试：`everyNTraces` watchdog + 预设编译 + finalize 正则 + 落盘

### Phase 2：完整送达

6. eventBus 广播 + 状态栏展示
7. ExtensionAPI 暴露 `pi.watchdog.register()`

### Phase 3：健壮性

8. 失败处理 + retry
9. session switch / compaction / dispose 的 reset
10. 配置 reload（`/reload` 时重新发现 `watchdog.json` + 预设）

### Phase 4：测试

11. 单元测试：配置解析、触发计数、delivery 路由、预设编译
12. 集成测试：turn_end 触发 → compileMessages → complete → finalize → custom message 落盘

## 9. 已确认的决策

> 原"待推敲"问题，经对照 pi-rp 源码核实后确认如下结论。

1. **预设发现时机**：`reload()` 时预设和 `watchdog.json` 一起重新加载。watchdog 引用的预设 ID 找不到时 → **跳过 + warn**，不阻塞其他 watchdog。

2. **模型解析**：使用 `modelRegistry.find(provider, modelId)` + `hasConfiguredAuth`（两者均已存在于 `model-registry.ts:56-62`）。`config.model` 字段 `"provider/modelId"` 在首个 `/` 处拆分。`thinkingLevel` 作为独立字段，不合并进 model 字符串——更清晰，且 `ScopedModel`（`model-resolver.ts:63`）已支持独立的 `thinkingLevel`。`resolveModelOverride` 在 pi-rp 中**不存在**（全文搜索零匹配），不引用。

3. **usage 记账**：走 `usage-totals.ts` 的 `addUsageToTotals`（与 compaction 一致），同时在 custom message 的 `details` 中携带 usage。`getUsageCostBreakdown`（`usage-totals.ts:37`）已将 compaction/branch-summary 归入 `"Tools/summaries"` 桶，watchdog 用法同理归入此桶或单独桶。

4. **多 watchdog 同 trace 并发**：N 个 watchdog 同时在 `agent_end` 触发会并发 N 次 LLM 调用。短期不需要限流；未来走 multi-agent-infrastructure.md Phase 0 的 RequestGateway。

5. **`everyNTraces` 计数器持久化**：session switch 后计数器归零（trace 上下文已变）。

6. **watchdog custom message 的 TUI 渲染**：`customType: "watchdog:story-summary"` 需要默认 EntryRenderer，或回退到默认 custom message 渲染。

7. **与 compaction 的关系**：compaction 本质是"触发式 side request"。短期不做合并——compaction 的破坏性输出语义（替换消息为 summary）、cut-point 检测、token 预算、overflow 自动重试都是 watchdog 架构不覆盖的。架构留可能性：从 watchdog 的 `#execute` 抽 `sideRequestExecutor`（构建 PromptRuntime → compile → complete → retry → epoch guard → finalize → 返回 text），watchdog 和未来 refactor 的 compaction 共用。**已记账 compaction/branch-summary 的正则 BUG，见 §10。**

8. **RPC 模式**：watchdog 在 `-p` 一次性模式下不启用。仅在 interactive 和常驻 RPC daemon 模式下启用。

9. **动态注册时机**：扩展通过 `pi.watchdog.register()` 在 `session_start` 中注册。需确认 `session_start` 在第一个 `agent_start` 之前完成（注册的 watchdog 能收到首个 trace 的触发）。

10. **预设的 `variables`**：watchdog 通过 `PromptRuntime.variables` 注入额外变量（如 `{{turnIndex}}`、`{{traceCount}}`），watchdog runtime 构建 `PromptRuntime` 时填入。

11. **finalize 正则**（原待推敲，**已确认为必做**）：watchdog 的 LLM 输出**必须**过 `applyFinalizeRegexRulesToMessage`，与主 agent `message_end` 路径（`agent-session.ts:887`）一致。这样"提取 JSON"之类的后处理写在预设里，转译扩展不用手写。已在 §5.4 step 6 实现。

12. **`PromptRuntime.options`**：watchdog 编译预设时传一个空/最小 `BuildSystemPromptOptions`——不需要主 agent 的 tools/skills 信息，预设的 `tools`/`skills` slot 不会在 watchdog 预设中使用。

## 10. 已记账的 BUG（正则审计）

> 审计原则：一个"用预设的系统"要完整支持正则，需在**构建 prompt 时应用 `outgoing`**（`applyRegexRulesToMessages`，history + compiled stage）+ **处理 LLM 输出时应用 `finalize`**（`applyFinalizeRegexRulesToMessage`）。正则四个 effect：`outgoing` / `display` / `both` / `finalize`。

### 审计结果

| 系统 | 用预设？ | outgoing（输入侧） | finalize（输出侧） | 状态 |
|---|---|---|---|---|
| 主 agent 循环 | `compileMessages` | ✓（compiler 内置，`compiler.ts:121,137`） | ✓（`agent-session.ts:887`） | OK |
| subagent | `compileMessages` | ✓（compiler 内置） | ✓（subagent 自有 session，同 `agent-session.ts:887` 路径） | OK |
| **compaction** | `hiddenOverrides` + `applyRegexRulesToMessages` | ✓（`agent-session.ts:2586-2601`） | ✗ | **BUG 1** |
| **branch-summary** | `hiddenOverrides` only | ✗ | ✗ | **BUG 2** |
| watchdog（本方案） | `compileMessages` | ✓（compiler 内置） | ✓（§5.4 step 6） | OK |

### BUG 1：compaction summary 输出没有过 finalize 正则

- **位置**：`agent-session.ts:2504`，`summary = result.summary` —— raw LLM 输出，直接落盘。
- compaction summary 是 LLM 输出（`compact()` → `generateSummaryWithUsage()` 返回的 text），应当过 `finalize`。现在如果用户在预设里写了 `finalize` 规则（如"提取 JSON"），compaction summary 不触发。
- **修复**：拿到 `summary` 后，包成 assistant message → `applyFinalizeRegexRulesToMessage(preset, msg, diags)` → 取回 text。
- **影响范围**：`compact()`（`agent-session.ts:2490-2509`）和 auto-compaction 路径（`agent-session.ts:2825-2828`）。

### BUG 2：branch-summary 完全没有正则

- **输入侧**：`branch-summarization.ts:329`，`convertToLlm(messages)` —— 没有 `applyRegexRulesToMessages`。compaction 有等价的 `_applyPresetToCompactionPreparation`（`agent-session.ts:2580`），branch-summary 没有。
- **输出侧**：`branch-summarization.ts:368`，`summary = contentText(response.content)` —— raw，没有 `finalize`。
- branch-summary 消费了 `hiddenOverrides.compaction.branchSummaryPrompt`（`agent-session.ts:3740`），是预设消费者，却零正则。
- **修复**：输入侧加 `applyRegexRulesToMessages`（history + compiled outgoing）；输出侧加 `finalize`。
