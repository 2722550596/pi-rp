# Preset 扩展元数据与有效配置读取设计

## 一句话定位

在 preset loader 与 ExtensionContext 之间新增通用、只读的 `extensions` 元数据透传通道，使扩展按 namespace 读取当前 session 实际激活（包括 inline / 同 ID 覆盖后的最终对象）的配置，而不增加 voice 专属 preset core 字段，也不让扩展自行扫描 preset 文件或重实现优先级。

> 本设计负责 preset 元数据保留、通用只读 getter、session 生命周期可见性及其测试/文档；为了兑现同一 turn snapshot，另列出依赖的通用 correlation API/core event 变更落点（不增加 preset/voice 专属字段）。语音配置语义与消息/TTS 编排归 `03-live-voice-extension.md`；共享字段遵循 `01-共同上下文.md`。

## 1. 需求原话依据与裁定

直接依据 `00-需求原话.md` §1：

- **消息 7（preset 元数据建议）**：用户希望在 preset 中“单独开一个字段给扩展读”，且扩展只需知道“当前生效的 preset”。
- **消息 8（loader 和模型方案）**：用户要求 loader 不要丢弃字段，并提出“用本地模型”。
- **消息 1（功能提出）**：整体希望构建 `/live` 语音交互扩展并先完成扩展自身逻辑；仅作为本模块背景，不据此设计 API provider/request。
- **消息 2–6、9**：分别涉及访谈方式、live 待机裁定、后处理语气/内容、语音稿与原会话分离、结构化内容口述、工具活动上下文；本模块不定义这些运行期行为，只保证通用 preset namespace 可被扩展读取。
- **ask 工具原话**：“唤醒词用 ‘话说’ 吧，相对更自然”，以及关于 live 状态持续和“用本地模型”的补充，属于语音运行模块，本模块不解释模型表现。

**反对专属 core 字段、批准通用 namespace 的明确依据**：`00-需求原话.md` §3 S4 核查裁定：用户建议能力依赖当前 preset 可读，但既有 `PromptPreset` 未声明扩展元数据且 loader 会丢未知顶层字段；裁定是“通用保留 `extensions` 命名空间，并加通用只读读取通道；不加 live-voice 专属核心字段”。这与访谈裁定 D13 一致：`extensions` 是唯一通用扩展元数据透传区，不宽泛保留任意未知顶层字段。**因此 MUST NOT 在 `PromptPreset` 上添加 `liveVoice` / `voice` 等 voice 专属字段。**

## 2. 范围、字段形状与精确 API

### 2.1 Preset JSON 与类型

遵守 `01-共同上下文.md` §6.1 冻结形状：

```jsonc
{
  "schemaVersion": 1,
  "id": "role-a",
  "items": [],
  "extensions": {
    "live-voice": {
      "transcriptInstructions": "…",
      "spokenReplyInstructions": "…",
      "ttsProfile": "…"
    }
  }
}
```

目标类型（字段为可选，以兼容所有现有 preset）：

```ts
export interface PromptPreset {
  // 既有字段不变
  extensions?: Record<string, Record<string, unknown>>;
}
```

- `extensions` 是唯一被 loader 特别保留的未知扩展区；其他未声明顶层字段仍按当前行为丢弃，避免拼写错误被静默接受为有效配置。
- 一级 key 是 namespace；namespace value 是 object。对象内的具体 key 与结构由对应插件解释，core 不硬编码 `live-voice` schema。`live-voice` 约定见 `01-共同上下文.md` §6.1；preset 至少可分别配置 `transcriptInstructions`、`spokenReplyInstructions`、provider-neutral `ttsProfile`。
- 内部未知字段必须原样保留（包括嵌套 object / array、空值、数字、布尔值以及扩展未来字段）；core 不递归挑选或重建扩展子对象。JSON 文件的值天然属于 JSON 值域；inline preset 也必须经 loader normalize 路径重新校验（现有 inline 入口如此，见 `loader.ts:59-72,104-124`）。
- TypeScript `Record<string, unknown>` 用于 namespace payload 是开放结构，避免声明 core 并不能验证的插件 schema。`Readonly` 只施加在 getter 的 API 边界，不影响 loader 内部值类型。

### 2.2 通用读取 API（精确签名）

在 `packages/coding-agent/src/core/extensions/types.ts` 的 `ExtensionContext` 增加：

```ts
getActivePresetExtensionData(
  namespace: string,
): Readonly<Record<string, unknown>> | undefined;
```

返回语义：

1. 读取**当前 session 当前 active preset** 中 `extensions[namespace]` 的 namespace payload；有效对象存在则返回该对象，否则 `undefined`。
2. 数据来自 session 已解析的 `_activePreset`，不是磁盘扫描；因此自然服从全局/项目/inline 的同 ID 覆盖结果、恢复的 preset id、`/preset` 激活以及停用回退到 built-in preset 的实际生效值。
3. 没有活动 preset、当前 preset 未声明 `extensions`、namespace 不存在或对应 namespace 在 loader 阶段因形状非法而被忽略时返回 `undefined`。函数不抛“未配置”错误，不触发目录读取、reload 或写入。
4. Getter 是通用只读读取通道，不返回 `LoadedPromptPreset` / 完整 preset，也不泄露 filePath、诊断数组或 core 私有数据；事件 `preset_activated` 继续只含 `presetId`。
5. Getter 每次调用都从当时活动 preset 解析。逻辑 user turn snapshot 与精确 ID 关联遵循 `01-共同上下文.md:81-87,117-118`：语音 pipeline 开始时读取配置并生成 `correlationToken`；键入输入在 input dispatch / queue acceptance 前读取。`InputEvent.inputId` / token 绑定 snapshot；同一 turn 的 transcript、assistant reply 与所有 TTS 使用该 snapshot，assistant turn 按 `userInputId` 查回。turn 中途 preset 切换只影响下一次 accepted user turn；不从 source、文本或 FIFO 推断归属。
6. `Readonly<Record<...>>` 是静态只读签名；getter 同时返回与 `_activePreset` 脱离的 JSON-compatible deep clone，运行时 mutation 不得反向改变核心 preset。live extension 将用户输入接受时的 clone 作为该 user turn 的固定 snapshot，之后不再从 active preset 重新读取同一 turn。
### 2.3 配置解析责任边界

loader/core 只验证通用容器形状并透传 payload。它不验证 `transcriptInstructions` 等字段的语义，也不把配置推断为有效模型能力。`ttsProfile` 只冻结为 provider-neutral 配置值；provider 尚未指定，因此 profile 到实际 voice/profile ID 的映射及服务支持能力均为 `[未知]`。实现期必须在选定 provider 后验证 profile 支持及 preset 间实际声音差异；若 provider 不支持，按 `01-共同上下文.md:157` 回到用户裁定，不得默默忽略字段或以 mock 声称 E9 已通过。扩展字段语义由消费它的扩展解释。

根据 `01-共同上下文.md:100-112` 已冻结的规则：`extensions` 顶层值不是 object 时追加 warning 并忽略整个 `extensions`；某个 namespace value 不是 object 时追加 warning 并仅忽略该 namespace；其他有效 namespace 与其内部未知字段原样保留，均不使整个 preset 加载失败。校验边界是两个容器层级，不能把内部任意字段误当成 core schema。

### 2.4 通用 user-turn correlation 与 preset snapshot

Preset snapshot 仍由 `getActivePresetExtensionData("live-voice")` 提供，但快照的确定时机和后续 assistant 归属必须通过通用 correlation IDs，而非 `source`、文本或顺序猜测。以下是与 preset getter 同时需要的**通用 core API 契约**，不增加 voice-specific preset 字段：

```ts
// ExtensionAPI.sendUserMessage and its SendUserMessageHandler /
// ReplacedSessionContext forwarding use this same options shape.
sendUserMessage(
  content: string | (TextContent | ImageContent)[],
  options?: {
    deliverAs?: "steer" | "followUp";
    expandPromptTemplates?: boolean;
    correlationToken?: string;
  },
): void;

interface InputEvent {
  // existing fields...
  inputId: string;                 // unique for each input dispatch; process-local
  correlationToken?: string;      // echoed only when caller opted in
}

interface TurnEndEvent {
  // existing fields...
  userInputId?: string;            // accepted user input that owns this assistant turn
}
```
- Options 中的 token 同时透传 `ExtensionAPI.sendUserMessage`、`SendUserMessageHandler`、`ReplacedSessionContext.sendUserMessage` 与 AgentSession 输入路径；上述既有各 API 返回类型不变，只有 `ExtensionAPI.sendUserMessage` 是 `void` dispatch，context forwarding 仍沿既有 async result 语义。

- `correlationToken` 为 opt-in。语音扩展在语音 pipeline 开始时创建唯一 token 并保存当前 preset snapshot，再随对应 `pi.sendUserMessage(content, options)` 发送；token 不修改 user 内容。既有调用不传 token 时 message、input dispatch、队列和持久化语义不变。
- Pi 在 input-handler chain 前为每次 input dispatch 分配唯一进程内 `inputId`，所有 input handlers（包含 transform chain）收到同一 ID；如传入 token，`InputEvent` 回显它。对 accepted user input，`TurnEndEvent.userInputId` 标识产生 assistant turn 的 input；工具 turn/continuation 保留该 ID。queued followUp 延迟交付也必须保留自己的来源 ID；`followUpMode === "all"` 批量注入多条 user messages 时，assistant turn 按 `01-共同上下文.md:100` 归属本批注入的最后一条 user input ID。
- AgentSession 不扩 `packages/agent`、不把 ID 加到 `AgentMessage`。逻辑来源 sidecar `WeakMap<AgentMessage, inputId>` 仅为真实 accepted user input message 登记；其 `message_start` 才更新 current logical userInputId。user `message_end` 持久化后取 `appendMessage()` 返回 entryId，以 `getEntry()` 返回的同一 `SessionEntry` 对象建立 `WeakMap<SessionEntry, inputId>`。tool/retry/compaction/continuation/followUp 同 turn 保留 ID，不因 agent lifecycle events 清除。
- queue identity 与 user correlation 分离：每个进入 `_steeringMessages` / `_followUpMessages` 可见 string arrays 的 producer都为该 queue item分配独立唯一 `queueItemId`，包括无 InputEvent/inputId 的 `_queueToolCatalogDelta -> _queueSteer`。以 `WeakMap<AgentMessage, queueItemId>` 关联将来交付的对应 queue message；`message_start` 只按 queueItemId 删除 UI item。内部 steer/custom message没 inputId时不伪造并且不覆盖 current userInputId。
- 可见 queue arrays 仍是既有 strings；另用平行 private `steeringQueueItemIds` / `followUpQueueItemIds` 同步 push/splice/clear。不能再根据 message text `indexOf` 定位，不能把 queueItemId 当 userInputId。
- Standalone `sendCustomMessage(..., { triggerTurn: true })` 若未由 accepted user input 触发而直接启动新 assistant run，run 前 clear current userInputId；该 turn_end 无 D20-eligible source input，不能继承前一个 user snapshot。当前 user turn 内的内部 tool-catalog steer 或 custom steer/followUp 不重置 current ID。
- Otherwise eligible `turn_end` 只有在 `userInputId` 可解析到 `acceptedLiveGeneration === currentLiveGeneration` 的已接受输入时才有 TTS 资格。缺失/未知 `userInputId`、未观察到的历史 branch input、`acceptedLiveGeneration === null` 或已关闭旧非空 generation 均不播；不能因此改读当前/相邻 preset或按文本/source 猜配置。只有映射到当前代的输入、但其 preset namespace/config 缺失或无效时，才以扩展 generic default 填充 snapshot 后入 TTS。`turn_end` live off 不排队/不补播；由 03 管 generation gate。
- Preset snapshot capture is **independent of the live toggle**: live-voice snapshots the effective preset on every keyboard/extension InputEvent dispatch. The extension stores `(snapshot, acceptedLiveGeneration)` beside each input ID: current generation when accepted live-on, `null` when accepted live-off. Only an input mapped to the non-null current generation is TTS-eligible; mapped null, stale non-null, and unknown/unmapped IDs never speak. A missing/invalid namespace uses generic defaults only inside a confirmed current-generation input mapping. A `turn_end` delivered while live-off is not queued/backfilled. These playback decisions are 03's responsibility; core only transports IDs.
- `inputId`、`correlationToken`、`userInputId`、`queueItemId` 只存在于运行时事件/AgentSession sidecar/private queue-id arrays 和 live-voice snapshot map；不写入 `AgentMessage`、session entries、Pi transcript、prompt/context、tool result 或磁盘。`queueItemId` 不等于 `inputId`，不进入 userInputId。关联字段是通用 optional additive API（InputEvent.inputId 对每次真实 accepted user dispatch 必需），不加 voice-specific core field。契约见 `01-共同上下文.md:85,87,89-103`。

## 3. 逐步行为契约（遗漏后果）

1. **`normalizePreset` 在逐字段构造对象时识别 `extensions`。** 仅显式复制该字段，其余 unknown top-level key 仍丢弃。漏做：预设里的插件配置仍会像当前一样静默消失。
2. **验证 `extensions` map 和每个 namespace payload 的对象边界，并为非法层级追加 warning。** 顶层容器非法时仅忽略扩展区，单 namespace 非法时仅忽略该 namespace，其它合法 namespace 保留。漏做：数组/null/标量可能伪装成有效 namespace，扩展收到意外值或非法配置无诊断。
3. **对通过容器校验的 namespace payload 完整保留子树。** 不因 core 不认识其中某个字段而裁剪；不让 `live-voice` 结构绑进 core。漏做：未来插件字段和任意嵌套扩展字段丢失，形成第二种“已识别子字段”白名单。
4. **同一 loader normalization 路径处理磁盘与 inline preset。** inline 数据重新校验；loader 已有“inline 同 ID 胜扫描结果”规则不得绕过。漏做：来源不同导致扩展看到的配置和错误语义不同。
5. **按现有 preset 身份优先级选出有效 preset，再设置 `_activePreset`。** 全局先载入、项目后替换同 ID；inline 再覆盖扫描结果；会话恢复和激活继续使用既有 id 解析。漏做：getter 可能返回另一个同名 preset 的配置，跟屏幕上实际 prompt 不一致。
6. **ExtensionRunner getter 动态读取 active preset。** runner 在 `agent-session.ts:4851-4863` 创建/绑定，`_ensureActivePresetRestored()` 在 `:4874` 才恢复 active preset；所以 callback 必须在调用时读取 session 当前 `_activePreset`，不能在 runner 创建/绑定时 capture preset 对象。漏做：session 启动时 getter 可能固定读 built-in/default，而不是恢复后的 active preset；之后切换也不会更新。
7. **缺值 / 无效值返回 `undefined`，读取无副作用。** 扩展自行回退通用默认。漏做：没有配置时阻止 live，或 getter 隐式读文件/修改状态，扩大本次 core 改动范围。
8. **事件仍只通知 preset id，消费者通过 getter 取数据。** 不在事件中塞 voice-specific payload。漏做：通用数据面产生新的事件契约且与冻结 D13 冲突。
9. **user turn ID 与内部消息分离。** 只有真实 accepted user AgentMessage 带 `inputId` sidecar，并在其 message_start 更新 current logical userInputId；无 inputId 的内部消息不伪造/覆盖它。Standalone `sendCustomMessage(...,{triggerTurn:true})` 若直接启动新 run 则先清 current ID，使 turn_end 无源 ID。漏做会让内部消息冒充用户，或 standalone custom reply 错借上一输入的 preset snapshot。
10. **queue UI 使用独立唯一 queueItemId。** 所有进入可见 `_steeringMessages/_followUpMessages` strings 的 producer—including 不经过 input handler 的 `_queueToolCatalogDelta -> _queueSteer`—均为本 queue item 分配唯一 queueItemId；message_start 按队列 sidecar ID 删除对应 string，`clearQueue()` 同步清 ID。漏做会使重复文本误删，或内部 catalog string 永留在 TUI。
11. **更新扩展 API、loader/context/queue tests 与文档。** 漏做：preset namespace/关联 API不可验证或队列/custom event的来源归属回归。

## 4. 文件与副作用

| 文件 | 变更职责 | 副作用 |
|---|---|---|
| `packages/coding-agent/src/core/prompt-preset/types.ts` | 给 `PromptPreset` 增加可选通用 `extensions` 类型 | 不增加 voice 专属 core 字段 |
| `packages/coding-agent/src/core/prompt-preset/loader.ts` | `normalizePreset` 保留并校验命名空间容器；在诊断中说明坏形状 | 不扫描新目录、不改变同 ID 优先级、不宽泛保留顶层字段 |
| `packages/coding-agent/src/core/agent-session.ts` | `_bindExtensionCore()` 提供 preset lookup；accepted input ID/current user turn sidecar；独立 queueItemId sidecar支持所有 UI-visible 队列 producer；standalone custom trigger-run清 current user ID | 只传内存元数据，不改 transcript / session 持久化；UI 仍暴露 strings，现有 preset setter/default tests unchanged |
| `packages/coding-agent/src/core/session-manager.ts` | 复用 `appendMessage()` 返回的 entry ID 和 `getEntry()` 对象身份，支撑内存 `WeakMap<SessionEntry, inputId>` 分支恢复 | 不给 SessionEntry 增加字段、不写盘 |
| `packages/coding-agent/src/core/extensions/runner.ts` | `bindCore()` 保存 getter callback；`emitInput()` 向 handler chain 传同一 inputId/token | 不新增持久化或外部 I/O |
| `packages/coding-agent/src/core/extensions/index.ts`、`packages/coding-agent/src/core/index.ts` | 现有 ExtensionContext / ExtensionAPI 类型出口暴露新增成员 | 不创建 voice-specific export |
| `packages/coding-agent/test/prompt-preset-loader.test.ts` | JSON fixture -> loader 的 metadata 保留与容器诊断测试 | 隔离 tempdir，无持久副作用 |
| `packages/coding-agent/test/prompt-preset-loader-storage.test.ts` | global/project/inline 同 ID 覆盖的 namespace 行为 | MemoryStorageBackend 测试 |
| `packages/coding-agent/test/extensions-runner.test.ts` | getter 与 `emitInput` ID/token 对 handler chain 的稳定分发测试 | 复用 runner 测试结构 |
| `packages/coding-agent/test/suite/agent-session-prompt.test.ts` | send API/token 兼容、重复文本并发、input ID 分配及非持久化 | 运行时集成行为 |
| `packages/coding-agent/test/suite/agent-session-queue.test.ts` | followUp/delivery IDs、tool catalog direct steer queue cleanup、duplicate text queue identity、clearQueue同步、standalone custom trigger ID isolation | runtime behavior |
| `packages/coding-agent/docs/prompt-presets.md`、`packages/coding-agent/docs/extensions.md` | 前者说明 `extensions` 字段，后者登记 getter 与通用 correlation API | 文档变更；不另建 API 体系 |

本模块无预期文件、音频、网络或配置持久化副作用。跨模块 correlation IDs 仅为当前进程内的 input/event/queue 元数据，不进入 preset JSON、session branch、Pi transcript 或后处理上下文。真实 TTS profile/provider smoke 属后续 external integration gate，见 §2.3 / §12。

## 5. 状态与持久化

- Active preset 状态仍由 `AgentSession._activePreset` 持有；getter 是对此状态的只读投影。恢复时优先采用最近的 session `preset_change` ID，其次采用 settings 默认 ID；若 ID 可解析则激活对应 preset。仅当两者都没有给出 restore ID 时，才按 `autoActivate` 规则选择默认 preset；若 restore ID 存在但无法解析，则保持 built-in preset，不回退到 `autoActivate`。证据：`agent-session.ts:2176-2205`。
- `setActivePreset` 在成功切换后替换 `_activePreset` 并发出 `preset_activated(presetId)`；disabled id 会回到 built-in preset。preset identity 的持久化仍使用原有 session entry / settings，不把 `extensions` payload 另存一份（`agent-session.ts:2312-2345`）。
- 当前有效配置来自 `_activePreset` 对象，包含 loader 决出的磁盘 global/project 覆盖或 inline 覆盖；不能从 `presetId` 再自行选择文件。加载同 ID loser 的 namespace 不得与 winner 做字段级合并；优胜 preset 整体替代。`loader.ts:82-102,104-124`。
- Correlation 只存在于该 session 的 AgentMessage / SessionEntry WeakMap、current turn ID、queueItemId 平行内存数组与 live-voice snapshot map；不往 message/entry field、branch file 或 settings 写 IDs/tokens。仅带真实 inputId sidecar 的 user `message_start` 更新 current userInputId；queueItemId-only 内部消息不覆盖它；standalone custom trigger 独立起 run 前清 ID。Agent lifecycle、retry、compaction、continuation 不重置 ID；path restore 未映射时该 turn 不具 TTS 资格。遵循 `01-共同上下文.md:86-90,102-103`。
- 扩展自身设置 API 持久化独立的 per-extension settings，不适合作为 preset 配置第二份副本（`extensions/types.ts:346-352`）。
- `[推断]` 若 preset 文件在 session 运行中修改，现有 loader/reload 机制决定 active object何时更新；本 API 不额外监视文件，也不提供即时 hot reload 语义。

## 6. TUI / 扩展 API

- 调用形状：扩展生命周期/命令/event handler 收到的 `ExtensionContext` 上调用 `ctx.getActivePresetExtensionData("live-voice")`；返回通用只读对象或 `undefined`。新增接口不绑定特定扩展 ID，也不要求使用 TUI。
- `ExtensionContext` 当前由 `ExtensionRunner.createContext()` 创建，属性通过 runner 闭包在调用时解析；`createCommandContext()` 复制 getter descriptor 以保留延迟访问语义（`extensions/runner.ts:783-787,910-917`）。实现应延续该 pattern，并用 `assertActive()` 保持 extension reload / stale context 保护。
- 用户 turn 的 transcript、assistant/tool/retry/compaction/followUp turns 及多个 TTS job 共用同一快照。新 user message 只有实际带 inputId sidecar 才更新 current ID；队列内部消息即使有 queueItemId 也不覆盖。agent run lifecycle events 不重置 ID；standalone custom trigger直接开新run会在run前清ID。branch/path navigation、reroll、rewind、tree switch 后按 active path 恢复同一内存 user-entry sidecar；无法恢复的旧 entry清ID且该历史turn不播。`preset_activated` 仍仅携带 `{ type: "preset_activated"; presetId: string }`（`extensions/types.ts:764-768`）。
- 不要求 TUI 增加 UI 控件；preset 管理继续使用既有 `/preset` 命令或 API；本模块不变更 footer / `/live` 行为。

## 7. 错误边界与诊断

- JSON 语法错误、基础 preset 错误继续由现有 loader 处理；本次只增加 `extensions` 通用容器形状校验，不借机重做 preset 全量 schema 校验。
- 结构正确但 namespace 内部未知字段不视为错误，不丢字段、不报警；core 不知道具体扩展将消费哪些 key。
- 缺失 `extensions` 或缺少目标 namespace 是正常可选配置，getter 返回 `undefined`，让扩展使用通用默认；不得当作 loader error。
- 非 object 顶层 `extensions` 容器产生 warning 并仅忽略整个 extensions；单个非 object namespace 产生 warning 并仅忽略该 namespace。现有 `PromptPresetDiagnostic` 只有 `level`, `message`, `itemId?`（`prompt-preset/types.ts:318-324`），没有路径字段；因此 warning message 应指明 `extensions` 或 `extensions.<namespace>` 与被忽略范围，不新增专属 diagnostic schema。
- 扩展调用 getter 时，如果其 ExtensionRunner 已失效，遵循现有 stale context API 的报错约定；除此之外缺值不得抛异常。
- 不允许用默认 voice 配置伪装成 preset 中读取到的值；getter 只返回配置中真实声明的 namespace object。通用默认由扩展执行。

## 8. 实现代码落点（到文件 / 函数）

1. `packages/coding-agent/src/core/prompt-preset/types.ts::PromptPreset`：声明可选 `extensions` 通用映射；通过 `core/prompt-preset/index.ts` 的现有类型 re-export 与 core index 的现有 `PromptPreset` export 对外可见。
2. `packages/coding-agent/src/core/prompt-preset/loader.ts::normalizePreset`：读 `obj.extensions`、校验通用 object 边界、拷贝完整 namespace payload 到 normalized preset；不要改其他 known-field parsing 策略。
3. `packages/coding-agent/src/core/agent-session.ts::_bindExtensionCore`：传给 runner 的 callback 每次调用读取当前 `_activePreset` 的 namespace；命中时返回与 active preset 脱离的 JSON-compatible deep clone，miss 返回 `undefined`。不能在 runner 创建时 capture preset。
4. `packages/coding-agent/src/core/extensions/types.ts::ExtensionContext`：声明 `getActivePresetExtensionData(namespace: string): Readonly<Record<string, unknown>> | undefined`；在内部 `ExtensionContextActions` 增加可选 callback（旧式嵌入 runner 未提供时 fallback 返回 `undefined`，session 核心绑定必须提供）。
5. `packages/coding-agent/src/core/extensions/runner.ts::bindCore` 与 `createContext()`：保存 context action callback，并在 context member 中调用 `assertActive()` 后动态执行；callback 缺失时返回 `undefined`，不可在 `createContext()` 或 runner 构造时缓存 preset 数据。
6. `packages/coding-agent/src/core/extensions/index.ts` 和 `packages/coding-agent/src/core/index.ts`：确认现有 `ExtensionContext` 类型导出已覆盖成员，不另造 public standalone getter type。
7. `packages/coding-agent/src/core/agent-session.ts::prompt` / `::_runInputHandlers`：input-handler chain 前生成稳定 `inputId`，将 token 与 ID 传入 `_runInputHandlers` / `ExtensionRunner.emitInput`；每个 transform handler 看见同一 ID；`sendUserMessage` token 从 ExtensionAPI / Handler 透传至同一次输入。
8. `packages/coding-agent/src/core/agent-session.ts::_handleAgentEvent`：仅当 user `message_start` 找到 `AgentMessage -> inputId` sidecar 才更新 current userInputId；另用独立 `AgentMessage -> queueItemId` sidecar 删除精确 UI queue row；user `message_end` 持久化后建立 SessionEntry sidecar；assistant `turn_end` 附 current ID。没有 inputId 的内部 steer/custom message不清不改 current ID。
9. `packages/coding-agent/src/core/agent-session.ts::_queueSteer` / `::_queueFollowUp` / `::_queueToolCatalogDelta` / `::_emitQueueUpdate` / `::clearQueue`：所有 UI string producer 都配独立 queueItemId（含 catalog delta direct steer）；平行 queueItemId arrays 跟 strings 同步 push/splice/clear；queue_update/getters/clearQueue return 保持 string[]，按 queueItemId 不按 text 删除。
10. `packages/coding-agent/src/core/agent-session.ts::sendCustomMessage`：独立 `{triggerTurn:true}` 且直接启动 run 前清 current userInputId；同一 user turn 中 queued internal custom/steer 保留 current userInputId。
11. `packages/coding-agent/src/core/agent-session.ts::_moveLeafAndRestoreState`、`navigateTree`、session disposal：路径改变后从 `SessionManager.getBranch()` 最新 user entry 恢复弱映射 ID；entry 未在当前进程关联时清 current ID，不能以消息文本推断。
12. `packages/coding-agent/src/core/session-manager.ts::appendMessage` / `getEntry` / `getBranch`：append 后以返回 entryId 调 `getEntry()` 并用同一对象建弱映射；branch traversal复用 same-process entry objects，不向 SessionEntry schema写 ID。
13. `packages/coding-agent/test/suite/agent-session-prompt.test.ts`、`agent-session-queue.test.ts`、`extensions-runner.test.ts`：覆盖 IDs/token/branch、tool catalog UI cleanup、same-text queueItemId、custom trigger isolation、同步 clear、getter与stale-context。
14. `packages/coding-agent/test/prompt-preset-loader.test.ts`、`prompt-preset-loader-storage.test.ts` 与相关 docs：metadata loader、precedence、errors tests；更新公开用法。

## 9. 与现状差异

### 已核实的现状事实

- `PromptPreset` 当前只列举 id、items、defaults、tools、skills、schemas、regex、hiddenOverrides、variables、memory 等已知字段，没有 `extensions`（`packages/coding-agent/src/core/prompt-preset/types.ts:251-280`）。
- `normalizePreset` 手工构造 `preset` 并逐字段复制，没有处理 `obj.extensions`；这是未知顶层字段丢失的直接原因（`packages/coding-agent/src/core/prompt-preset/loader.ts:219-283`）。
- preset loader 扫描 agent/global 目录后扫描 project dir；同 ID 新值替换原数组槽位。project 后于 global 加载，因此 project preset 整体覆盖 global preset（`loader.ts:82-102`）。仓库文档也记载项目 preset 同 id 覆盖 global（`packages/coding-agent/docs/prompt-presets.md:5-12`）。
- inline preset 最后合并并覆盖同 ID 扫描项，产生 warning；内联数组同 id 后项胜出（`loader.ts:104-128`，`test/prompt-preset-loader-storage.test.ts:109-158`）。
- session 将活动对象保存在 `_activePreset`；恢复先取最近 `preset_change`，否则取 settings 默认 ID；只有二者都未提供 ID 时才尝试 `autoActivate`。ID 能解析时激活对应 preset；未知 ID 不会触发 `autoActivate`，而保持 built-in preset（`agent-session.ts:2176-2205`）。`setActivePreset` 从已加载列表查找并替换 active object（`agent-session.ts:2312-2345`）。
- runner 在 `agent-session.ts:4851-4863` 创建并绑定；`_ensureActivePresetRestored()` 随后于 `agent-session.ts:4874` 恢复活动 preset。读取 callback 必须闭包引用当前 session，而在调用时查 `_activePreset`，不可 capture runner 创建时的 active preset snapshot。已有内部 `activePreset` getter 位于 `agent-session.ts:2215-2218`。
- `_bindExtensionCore()` 构造 `ExtensionContextActions` 并传给 runner 的 `bindCore()`（`agent-session.ts:4436,4572-4590`；`extensions/runner.ts:370-417`）；这是新增动态 lookup 的准确绑定落点。现有 runner `createContext()` 是延迟 context 构造（`extensions/runner.ts:783-789`）。
- `packages/coding-agent/src/core/agent-session.ts::_runInputHandlers` 在 `prompt` dispatch 中发 InputEvent；当前不生成/透传 inputId/token（`agent-session.ts:2613-2619,2842-2854`），runner 每个 handler 构造新 event 对象但内容来自当前 transform 值（`extensions/runner.ts:1357-1380`）；`_handleAgentEvent` 当前只发 turn_end 的 `turnIndex/message/toolResults`（`:1262-1269`）。
- Agent 对 `AgentMessage` 不复制 message input: `normalizePromptInput()` 的 object 或数组分支原样返回（`packages/agent/src/agent.ts:398-415`）；Agent loop 将同一 user object 发 `message_start`（`packages/agent/src/agent-loop.ts:112-115,201-208`），followUp queue drain 继续使用 queued object（`:256-279`）。因此 Session-local WeakMap sidecar 可跨 Agent API/event 精确关联，无须修改 `packages/agent` 或 `AgentMessage`。
- `message_end` 当前先由 session 处理并调用 `SessionManager.appendMessage(event.message)`，但不保留返回 ID（`agent-session.ts:1128-1149`）；`appendMessage()` 创建并保存 SessionEntry 返回 id（`session-manager.ts:1030-1045`），`getEntry(id)` 从同一 `byId` map 返回对象（`:1240-1242`），`getBranch()` 同样沿该 map 返回 branch entries（`:1316-1325`）。这些对象身份支持同进程 branch recovery sidecar。
- `_handleAgentEvent()` 当前在 `message_start` 对 `_steeringMessages` / `_followUpMessages` 按 `contentText()` 调 `indexOf(messageText)` 并移除第一个同文条目（`agent-session.ts:1103-1120`）；`_queueSteer` / `_queueFollowUp` 只保存 strings（`:2924-2952`）。`_queueToolCatalogDelta` 在无 InputEvent/inputId 的路径直达 `_queueSteer`（`:1694-1713`），故 queueItemId 与 inputId 必须是独立 identity；`sendCustomMessage(...,{triggerTurn:true})` 直接 `_runAgentPrompt(appMessage)`（`agent-session.ts:2996-3018`）目前亦无 reset current ID。
- reroll/tree move 经 `_moveLeafAndRestoreState()` 恢复 agent state（`agent-session.ts:3243-3290`）；`navigateTree()` 的 same-leaf path 会显式 `_syncAgentStateFromSession()`（`:5557-5576`）；`clearQueue()` 清 UI queue 并调用 `agent.clearAllQueues()`（`:3391-3398`）。generic `_syncAgentStateFromSession()` 也用于 auto-compaction（`:3865-3868,4230-4233`），因此不能在那里无条件 reset current ID。

### 本设计拟实施的目标状态（尚未落地）

- loader 将保留 `PromptPreset.extensions` 通用映射，namespace payload 不再丢失。
- ExtensionContext 将提供 `getActivePresetExtensionData(namespace)`，读取当前 session 的 active preset；调用方不再依赖扩展端扫描 preset 路径或从事件 ID 猜测配置。
- loader 将为非法的顶层 `extensions` 容器或非法单一 namespace 追加 warning 并局部忽略；preset 本身保持可加载，其它有效 namespace 的未知字段完整保留，遵循 `01-共同上下文.md:100-112`。
- 公共 `preset_activated` event、preset 选择规则和 preset ID 持久化保持不变。
- 通用 core correlation API 将增加可选 `sendUserMessage` token 与 input/turn event IDs；AgentSession 用 message / entry sidecar 维护 current userInputId，不把标识写进消息或 SessionEntry。工具、retry、compaction、continuation、followUp期间保留 ID；`followUpMode=all` 归属最后注入 user ID。
- `_steeringMessages` / `_followUpMessages` 由独立 `queueItemId` 并行 sidecar定位：每个可见 queue string 的 producer（含 tool catalog direct steer）分配，不论有无 InputEvent；匹配 message_start 后按 item ID 删除。只有实际 accepted user message 关联 `inputId`；内部 queued message 不覆盖 current ID。standalone custom-trigger run 清 current ID 后，其 turn_end 无源 ID，不继承前一 snapshot。
- 当前实际 provider 未选定，`ttsProfile` mapping/设备能力仍 `[未知]`；只有选定真实 provider、验证 profile 支持及可听差异并通过真实路径 smoke，才可报告 E9 通过。unsupported provider/profile 必须回到用户裁定；不会用 mock 支持冒充完成。

## 10. 验收测试（行为 / 边界 / 错误）

在现有 test 文件中增补永久测试；不以 mock 复述 getter 的返回、不测试“能调用”或对象非空，断言真实输入数据经过 loader / session / context 后的消费者可见行为：

1. **已知结构保留**：由 JSON 文件加载一份 `extensions.live-voice`，断言 `transcriptInstructions`、`spokenReplyInstructions`、`ttsProfile` 与原输入一致。
2. **任意嵌套 payload 保留**：namespace 中放数组、数字、布尔、null、嵌套对象及未来未知 key；断言深层结构和每个值未丢失/未改写，loader 对内容本身不发错误诊断。
3. **core 顶层未知字段仍丢弃**：同一 preset 放 `voiceInstructions` 等未声明顶层字段并另放 `extensions`；断言只保留 namespace 数据，不把白名单方案退化为“保留所有顶层”。
4. **容器错误边界**：分别输入顶层 `extensions` 为 array/null/scalar，及 namespace value 为 array/null/scalar；前者产生 warning 且仅忽略整个 `extensions`，后者产生 warning 且仅忽略对应 namespace。断言整个 preset 仍有效、其它合法 namespace 与 payload 内未知字段完整保留。
5. **global/project 同 ID**：同 ID global 与 project 分别具有不同 namespace 内容；加载结果只有 project winner 的数据，绝不按字段合并；不同 id 全保留。现有测试已证 precedence，但新增断言应直接针对 extensions 值（`test/prompt-preset-loader-storage.test.ts:85-96`）。
6. **inline 对 scanned 同 ID**：inline winner payload 取代 global/project loser；诊断保持既有覆盖告警，且 getter 最终只见 inline winner 的完整 namespace（`test/prompt-preset-loader-storage.test.ts:109-128`）。
7. **启动 / 恢复**：分别覆盖已保存且可解析的 preset ID、settings 默认 ID、两者均缺失、未知/无法解析 ID、disabled/default ID。仅存在有效恢复 ID 时 getter 返回该 active preset 的 namespace；两种 ID 都缺失时才按 `autoActivate` 选择；有未知恢复 ID 时保持 built-in preset，不回退到 `autoActivate`。无 namespace 时返回 `undefined`。
8. **切换与 turn 快照**：两个 loaded preset 有不同同名 namespace。用户 turn 接受时读取 preset A；同一 turn 的 transcript 与 assistant/TTS 任务均使用 A 的快照，即使中途激活 B；下一个新 user turn 使用 B。覆盖 voice 输入 pipeline 开始和键入消息 dispatch/enqueue（包括 followUp）两个 snapshot 边界。
9. **读取只读隔离**：将 getter 结果强转后尝试修改顶层及嵌套值，再读取一次；活动 preset 的配置仍未改变。此测试锁定无反向修改，不锁定具体 clone/freeze 手段。
10. **上下文 API stale guard**：`runner.invalidate()` 后调用过期 context getter，与现有被保护 API 一样拒绝；目标扩展只对有效 context 的缺 namespace 收到 `undefined`。
11. **没有磁盘重扫 / 副作用**：在激活后改动测试存储但不触发既有 reload；getter 仍读 active object。触发 reload / session preset 更新后才读到新有效对象。证明读取通道依赖 session 有效对象，而不是 getter 自己扫描并复刻优先级。
12. **事件 shape 不变**：切换 preset 后事件仍只有 `type`、`presetId`，metadata 必须通过 getter 获取；不新增扩展专属 event 属性。
13. **Correlation API 精确关联**：并发发出相同文本的两条 input（不同 source/token），各有不同 `inputId`；voice token 映射其实际 InputEvent ID，assistant `turn_end.userInputId` 只指向对应 input；通过字段断言而非文本顺序。
14. **Follow-up / 多 user / continuation**：延迟送达的 followUp 保持自己的 ID；多个待处理 user message 在 `followUpMode=all` 同批注入时，assistant turn 使用实际最后注入 user 的 ID；tool/retry/continuation/compaction turns 保留该 user ID。`agent_start/end/settled` 不重置 current ID。
15. **handled / rejected / failed 输入**：input handler `handled`、preflight rejection、dispatch/queue failure 不产生可消费的 assistant `userInputId` mapping；下一个 turn 的唯一 ID 不得命中候选 snapshot；voice 提交失败须撤销自身 token 关联，不要求在 handled 分支改造额外事件 API。
16. **branch 与 session lifecycle**：same-process branch/reroll/rewind 返回同一 user SessionEntry object 时恢复 ID 并复用原 snapshot；切换到没有 session-local sidecar 的旧/跨进程 entry 时清 ID，该 turn 不播，不读当前 preset / generic default。已映射为 current live generation 的 input 若 namespace/config 缺失则仍以 generic default 入 TTS；null/旧 generation 不播。绝不按相同文本继承。session replacement 以空 association 开始。
17. **旧调用与零持久化**：省略 correlationToken 的 `sendUserMessage` 保持原 input/message/queue/persist 内容不变；token/inputId/userInputId/queueItemId 不出现在 serialized SessionEntry、branch、prompt/context 或 transcript。clearQueue/drop queued object 后不会产生陈旧 mapping。
18. **重复文本队列移除与 clearQueue**：相同文本以两个不同 queueItemId 先后排入队列；实际交付的 AgentMessage sidecar queueItemId 只移除其自己的 UI string 和同索引 ID，另一同文项仍保留；`queue_update` 只显示剩余 strings。调用 `clearQueue()` 时 queueItemIds 与 Agent queue 一起清空，UI 仍只暴露 strings。
19. **`ttsProfile` 实际能力验收（外部集成，不由本模块 mock）**：provider 选定后以真实凭证/设备走有效 preset -> extension getter -> profile map -> TTS output；至少验证两个实际不同 profile 能产生用户可辨识的声音差异并记录真实 smoke。provider/profile 不支持则按 01 §7 返回用户拍板，不可宣称 E9 完成。
20. **input snapshot 与 live-generation 边界**：live off 时接受的键入/extension input 仍读取 preset 并记 `acceptedLiveGeneration=null`；其 assistant `turn_end` 即使在之后 live on 才完成也不播。live on 时接受的 input 记当代 ID；该代关闭后 late turn 不可在新代复活。缺失/无法关联的 historical `userInputId` 不播；只有映射到当前 non-null generation 的输入才 eligible，若该映射的 namespace/config 缺失则使用 generic default。`turn_end` 在 live off 到达时不排队/不 backfill。
21. **tool catalog internal direct-steer**：`_queueToolCatalogDelta -> _queueSteer` 虽无 accepted user `inputId`，仍有独立 `queueItemId`；它的 AgentMessage `message_start` 按 queueItemId 清对应 `_steeringMessages` string，不残留 UI item，也不重置/覆盖正在继承的 current userInputId。
22. **standalone custom trigger isolation**：先有已接受 user input/current snapshot，再调用 `sendCustomMessage(...,{triggerTurn:true})` 独立启动 assistant run；core 在 run 前清 current userInputId，该 run `turn_end.userInputId` 为空、不借用前 input snapshot、不具 TTS 资格。反之同 user turn 内的 queued custom/steer 不清 current input ID。已有 setter/default tests不变。

不运行 build/test/lint；以上为设计验收项，不声称已经执行测试。

## 11. 冲突与待拍板

### 11.1 已裁定的通用容器错误语义（遵循共享契约）

- `01-共同上下文.md:100-112` 已明确：只保留 `extensions` 顶层命名空间；`extensions` 顶层非法或 namespace 非 object 时追加 warning，并只忽略对应容器/namespace，不使整个 preset 失败；其余有效 namespace 与内部未知字段原样保留；扩展元数据不参与核心 prompt 渲染。
- 设计依据及复核：现有 loader 的 `normalizePreset` 逐字段构造对象，未复制 `obj.extensions`（`loader.ts:230-283`）；loader 现有 `isPlainObject` 定义拒绝 null、array、非对象（`loader.ts:541-543`）。实现应将该检查只用于上述两层容器，不能递归过滤 namespace payload 的未知字段。
- 本模块按照以上已冻结语义设计，不保留旧版“需要主代理裁定”的 blocker。

### 11.2 已作出的数据隔离决定

- getter public signature 保持 `Readonly<Record<string, unknown>>`；core 每次命中 namespace 时返回 JSON-compatible deep clone。extension 即使强转后改写本地副本，也不影响 active preset；voice extension 捕获 turn snapshot 后自己保持该副本的稳定使用。
- 这避免 extension mutation 污染 session preset，又不把 run-time freeze 政策扩为共享契约。实现可以用结构等价 deep clone，不能返回可反向修改 `_activePreset` 的原引用。

### 11.3 同进程 branch recovery 与未知历史边界

- `SessionManager.appendMessage()`、`getEntry()`、`getBranch()` 的 identity 支持见 §9 事实：same-process branch 可按最近 user `SessionEntry` 弱映射恢复原 ID/snapshot；新进程加载的 entry 没有 sidecar，明确清 ID，该 historical turn 不播，也不回退 generic default。
- `AgentMessage` sidecar 则覆盖 input acceptance 到 `message_start` 的临时阶段；Entry sidecar 只支持已有内存 session tree；两者都不向持久消息 schema 加字段。compaction 当前 turn 不复原，而是直接保留 current ID。
- 本方案按最新 `01-共同上下文.md:81-103` 处理 retry/continuation/compaction、branch/reroll/path变更、queue identity与standalone custom trigger，不存在需要上位文档更改的冲突。

### 11.4 文档同步与外部未知

- `packages/coding-agent/docs/prompt-presets.md`：补充通用 `extensions` 位置与 namespace getter 说明，明确同 ID 仍是 winner preset 整体替换，不是深 merge。
- `packages/coding-agent/docs/extensions.md`（ExtensionContext 章节，`docs/extensions.md:959`）：登记 getter 与 sendUserMessage correlation options / input/turn event IDs 的通用 API。
- 本设计范围内没有遗留冲突或待拍板项。唯一未确认项是外部 E9 provider/profile mapping：provider 未被选定，`ttsProfile` 到真实 voice/profile ID 的能力仍 `[未知]`；按 `01` §7 用户裁定及 §8 真实 smoke 门，在拿到实际 provider 配置并跑通前不宣称达成。该未知不阻止 generic metadata/correlation API 设计。

## 12. 需求对照（00 效果 E1–E10 / 决策 D1–D20）

本节按所有效果逐条落点。此模块只直接实现涉及 preset 的数据传递，其余以明确边界交由 `/03-live-voice-extension.md`，不把无关效果声称已由 core 达成。

| 编号 | 原文消息依据（`00` §1） | 与冻结契约的对照 / 本模块落点 |
|---|---|---|
| E1 | 消息 1（全局 `/live` 扩展） | 非本模块行为；getter 是通用 ExtensionContext API，不决定扩展安装或 `/live` 启停。D1、D15：不保存 live 状态，本模块不增持久化字段。 |
| E2 | 消息 1、消息 3（状态持续） | 不涉及 preset metadata；遵循 D2、D3、D5，不在本模块扩展 preset schema。 |
| E3 | 消息 1；ask 原话“唤醒词用 ‘话说’” | 与 preset core 无关；KWS / cue 由 live voice module 处理，不能声称 metadata getter 验证模型效果。 |
| E4 | 消息 1、消息 4（user 语音结合上下文改写） | `extensions.live-voice.transcriptInstructions` 可由通用 API 读取；读取 API 不处理 ASR / transcript。D8、D9 的数据来源要求落在 metadata；typed/voice submission 用 correlation IDs 关联同一 user turn，handler lifecycle 和输入消息处理归 03。 |
| E5 | 消息 1、消息 5（会话文本不被语音稿改写） | `extensions` 与 preset prompt items 分离，getter 不改 assistant 原文。D11/D18 的 qualifying assistant `turn_end` 触发、FIFO TTS queue 和 mic gate 均由 03 处理；该逻辑 user turn 的所有 assistant/TTS task 使用用户输入被接受时固定的同一有效 preset snapshot。 |
| E6 | 消息 4、消息 5、消息 6（后处理与结构口述） | `spokenReplyInstructions` 及 provider-neutral `ttsProfile` 作为扩展 namespace payload 保留，具体生成语义交 03；对应 D10、D13。 |
| E7 | 消息 3（live 待机仍持续） | 不属于 preset loader/context 范围；不以 preset 切换改写 live 状态。对应 D2、D6。 |
| E8 | 消息 1、消息 3 | 本模块不持有 live 状态，也不处理关闭取消；遵循 D12、D15，不把运行态放入 preset metadata。 |
| E9 | **消息 7**（preset 为扩展提供专用可读字段的建议）、**消息 8**（loader 不要丢字段）；消息 1 为全局扩展背景 | **直接落点**：用户反对 voice 专属 core 字段、批准通用 `extensions` 命名空间读取通道（`00` §3 S4、§4 D13）；实现 `PromptPreset.extensions` 和 `getActivePresetExtensionData(namespace: string): Readonly<Record<string, unknown>> | undefined`，按有效 preset winner 读取且兼容输入 correlation/snapshot。`ttsProfile` provider-neutral 值可传递，但其映射到真实 voice/profile ID、支持能力和用户可听 preset 差异仍 `[未知]`；provider 选择后必须真实 smoke，故目前只关闭 metadata plumbing，不声称完整 E9 输出效果通过。 |
| E10 | 消息 1（API 接线顺序）与消息 8（本地模型建议） | 不提供 endpoint/provider/request schema，也不将模型识别效果写作事实；`extensions` 可被未来扩展读取不代表语音 API 已连通。对应 D16。 |

| 决策 | 本模块遵守方式 |
|---|---|
| D1 | 通用 getter 不启停 `/live`，启动时扩展关闭由 03 实现。 |
| D2 | 不改变状态机时序。 |
| D3 | 不存说话人 / VAD 配置于 preset core。 |
| D4 | transcript instructions 数据入口由 namespace 提供；转写行为归 03。 |
| D5 | 不处理唤醒模型，不对 Sherpa 性能作断言。 |
| D6 | preset getter 不控制采样暂停。 |
| D7 | 空文本行为归 03，配置缺失只表示扩展应选通用默认。 |
| D8 | namespace 可分别承载输入与输出后处理指令；不合并这两个 task。 |
| D9 | 不读取 system prompt 或上下文历史，不通过 getter 暴露任何 message。 |
| D10 | 保留 spoken reply instructions / TTS profile；不定义内部 schema 或伪造 provider mapping；实际映射能力 `[未知]`，依 §12 真实 smoke。 |
| D11 | 每个 keyboard/extension InputEvent dispatch 都捕获 snapshot，不论 live on/off，并记 `acceptedLiveGeneration` 当前代或 `null`。只有 userInputId 映射到 `acceptedLiveGeneration === currentLiveGeneration` 的输入才具 TTS 资格；null、旧代、missing/unknown/historical input ID 均不播。只有确认当前代 input mapping 后，若该 snapshot 的 preset namespace/config 缺失才用 fixed generic default。turn_end live off 不排队/不补播。其余 stopReason/visible text/no toolCall/`event.toolResults.length === 0` 过滤和 TTS 排队均由 03 处理。 |
| D12 | 不创建请求或取消策略；live 关闭不会写回 preset。 |
| D13 | `extensions` 是唯一扩展透传区；不保留其它任意 top-level 字段，不增加 voice-specific core 字段；暴露通用只读 getter。 |
| D14 | 每个 logical user input dispatch 都读取 active preset、冻结该 input snapshot，不因 live off 跳过；扩展记 current `acceptedLiveGeneration` 或 null。TTS 仅接受映射到 current non-null generation 的 input；off/null、旧代、无/未知 userInputId/history turn 均不播。same-process path restore 若 Entry sidecar 可恢复则复用 snapshot+tag；不能恢复时 suppress，不用 generic default。仅已确认 current input mapping 但 namespace/config 缺失才由扩展填 generic default。 |
| D15 | 不存 live 状态/计时；原有 per-extension settings API 不变。 |
| D16 | 不指定或伪造 API provider、端点、凭证、request/response 格式。 |
| D17 | 语音消息在 Pi busy 时以 `deliverAs: "followUp"` 排队，按实际送达顺序；属于 03 的消息提交/时序边界，本模块不改变 getter、preset 覆盖或配置快照语义。 |
| D18 | 只有按 `userInputId` 映射到当前 non-null live generation 所接受 input 的 assistant reply 才可入 FIFO TTS queue；null acceptedLiveGeneration、已关闭旧代、missing/unknown/history ID 均不播。仅该 current input snapshot 的 namespace/config 缺失才用 generic default。符合资格的 TTS 按原文生成顺序串行；`agent_settled` 只清 `piBusy`，仅 Pi settled 且 output queue/worker 都空才恢复麦克风。 |
| D19 | 用户选择 opt-in 通用关联 token（`00 §4 D19`）：`pi.sendUserMessage` 可选 `correlationToken?: string`；每次真实 accepted user dispatch 的 `InputEvent.inputId` 在 handler chain 前分配且 transform 稳定，`TurnEndEvent.userInputId` 按实际 user message object 关联。所有进入 visible queue arrays 的 producer另用独立 queueItemId（含无 inputId 的 tool catalog internal steer）；queueItemId只删除 UI row，不更新 current logical user ID。Standalone custom-trigger新run清 current user ID。IDs/tokens不落 transcript/session/prompt，也不增加 voice-specific core field（`01-共同上下文.md:85,89-90,102-103`）。D20 eligibility follows. |
| D20 | 只有 live-on accepted user input可有 TTS source ID；standalone custom-trigger没有 inputId，须 run 前清 current userInputId 而不借用前一 snapshot。内部 queued custom/steer及catalog message无 inputId但有 queueItemId，不覆盖该用户turn ID。缺少有效 current-generation userInputId的不播；仅已确认 current-generation input 的 preset namespace/config 缺失才用 generic default（`00 §4 D20`；`01-共同上下文.md:80,86,89-90,99-103`）。 |
