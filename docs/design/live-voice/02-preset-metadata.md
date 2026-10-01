# Preset 扩展元数据与有效配置读取设计

## 一句话定位

在 preset loader 与 ExtensionContext 之间新增通用、只读的 `extensions` 元数据透传通道，使扩展按 namespace 读取当前 session 实际激活（包括 inline / 同 ID 覆盖后的最终对象）的配置，而不增加 voice 专属 preset core 字段，也不让扩展自行扫描 preset 文件或重实现优先级。

> 本设计仅负责 preset 元数据保留、通用读取 API、session 生命周期可见性及其测试/文档；语音配置具体字段的解释与语音功能不在本模块落地。共享字段遵循 `01-共同上下文.md` §6。

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
5. Getter 每次调用都从当时活动 preset 解析。逻辑 user turn 被接受时必须恰好确定该 turn 的 metadata snapshot：语音输入在 transcript pipeline 开始时读取；键入输入在 Pi input 分发/入队前读取（包括 `followUp`）。同一 turn 的 transcript、assistant reply 与所有 TTS speech tasks 复用该 snapshot；turn 中途 preset 切换只影响之后接受的 user turn。此时序遵循 `01-共同上下文.md:117-120`。
6. 对 `Readonly<Record<...>>` 是静态类型的只读承诺。为防扩展通过强制类型转换修改 session 核心配置，推荐实现返回副本并隔离其嵌套引用；具体复制/冻结策略为实现细节，但不得让 getter 返回值的修改反向改变 `_activePreset`。此条为 `[推断]`：现有 `ctx.settings` getter 使用独立 clone 并验证篡改不会泄漏，见 `extensions-runner.test.ts:142-163`；共享契约未规定 getter 的运行时深只读机制。
### 2.3 配置解析责任边界

loader/core 只验证通用容器形状并透传 payload。它不验证 `transcriptInstructions` 等字段的语义、不会判定 TTS profile 是否可用于某 provider，也不会把配置推断为有效模型能力。`live-voice` 扩展读取后负责校验自己识别的字段与适用默认；具体默认、无效值如何处理见 live voice 文档，不能由本模块替它定案。

根据 `01-共同上下文.md:100-112` 已冻结的规则：`extensions` 顶层值不是 object 时追加 warning 并忽略整个 `extensions`；某个 namespace value 不是 object 时追加 warning 并仅忽略该 namespace；其他有效 namespace 与其内部未知字段原样保留，均不使整个 preset 加载失败。校验边界是两个容器层级，不能把内部任意字段误当成 core schema。loader/core 不验证 `transcriptInstructions` 等字段语义，也不会判定 TTS profile 是否可用于某 provider；`live-voice` 扩展负责字段级解释与适用默认。

## 3. 逐步行为契约（遗漏后果）

1. **`normalizePreset` 在逐字段构造对象时识别 `extensions`。** 仅显式复制该字段，其余 unknown top-level key 仍丢弃。漏做：预设里的插件配置仍会像当前一样静默消失。
2. **验证 `extensions` map 和每个 namespace payload 的对象边界，并为非法层级追加 warning。** 顶层容器非法时仅忽略扩展区，单 namespace 非法时仅忽略该 namespace，其它合法 namespace 保留。漏做：数组/null/标量可能伪装成有效 namespace，扩展收到意外值或非法配置无诊断。
3. **对通过容器校验的 namespace payload 完整保留子树。** 不因 core 不认识其中某个字段而裁剪；不让 `live-voice` 结构绑进 core。漏做：未来插件字段和任意嵌套扩展字段丢失，形成第二种“已识别子字段”白名单。
4. **同一 loader normalization 路径处理磁盘与 inline preset。** inline 数据重新校验；loader 已有“inline 同 ID 胜扫描结果”规则不得绕过。漏做：来源不同导致扩展看到的配置和错误语义不同。
5. **按现有 preset 身份优先级选出有效 preset，再设置 `_activePreset`。** 全局先载入、项目后替换同 ID；inline 再覆盖扫描结果；会话恢复和激活继续使用既有 id 解析。漏做：getter 可能返回另一个同名 preset 的配置，跟屏幕上实际 prompt 不一致。
6. **ExtensionRunner getter 动态读取 active preset。** runner 在 `agent-session.ts:4851-4863` 创建/绑定，`_ensureActivePresetRestored()` 在 `:4874` 才恢复 active preset；所以 callback 必须在调用时读取 session 当前 `_activePreset`，不能在 runner 创建/绑定时 capture preset 对象。漏做：session 启动时 getter 可能固定读 built-in/default，而不是恢复后的 active preset；之后切换也不会更新。
7. **缺值 / 无效值返回 `undefined`，读取无副作用。** 扩展自行回退通用默认。漏做：没有配置时阻止 live，或 getter 隐式读文件/修改状态，扩大本次 core 改动范围。
8. **事件仍只通知 preset id，消费者通过 getter 取数据。** 不在事件中塞 voice-specific payload。漏做：通用数据面产生新的事件契约且与冻结 D13 冲突。
9. **按逻辑 user turn 固定配置快照。** 在语音 pipeline 开始 / 键入 input dispatch 或入队前（含 followUp）读取一次；同一 turn transcript、assistant 与 TTS 复用该快照。漏做会导致一个 user turn 前后阶段混用不同 preset；若只在 TTS task 开始时读取，也可能令 turn 中途的 preset 切换改写该 turn 回复风格。
10. **更新扩展 API 文档与 loader / context 测试。** 漏做：规范无法被 preset 作者与扩展开发者发现，或回归只有源码自洽而无人验证实际调用契约。

## 4. 文件与副作用

| 文件 | 变更职责 | 副作用 |
|---|---|---|
| `packages/coding-agent/src/core/prompt-preset/types.ts` | 给 `PromptPreset` 增加可选通用 `extensions` 类型 | 不增加 voice 专属 core 字段 |
| `packages/coding-agent/src/core/prompt-preset/loader.ts` | `normalizePreset` 保留并校验命名空间容器；在诊断中说明坏形状 | 不扫描新目录、不改变同 ID 优先级、不宽泛保留顶层字段 |
| `packages/coding-agent/src/core/agent-session.ts` | `_bindExtensionCore()` 将动态 namespace lookup 注入 context actions | 不新增 preset 激活事件 payload、不改变会话存储格式 |
| `packages/coding-agent/src/core/extensions/types.ts` | `ExtensionContext` 增加精确 API；内部 `ExtensionContextActions` 增加 session lookup callback | 扩展 API 类型面的向后兼容添加 |
| `packages/coding-agent/src/core/extensions/runner.ts` | `bindCore()` 保存 lookup callback；`createContext()` 以 stale-runner guard 调用该 callback | 不新增持久化或外部 I/O |
| `packages/coding-agent/src/core/extensions/index.ts`、`packages/coding-agent/src/core/index.ts` | 既有 `ExtensionContext` 类型 re-export 已覆盖新增成员，无额外 getter symbol export | 暴露面是 context 的成员签名 |
| `packages/coding-agent/test/prompt-preset-loader.test.ts` | JSON fixture -> loader 的 metadata 保留、容器非法诊断测试 | 隔离 tempdir，无持久副作用 |
| `packages/coding-agent/test/prompt-preset-loader-storage.test.ts` | global/project/inline 同 ID覆盖的 namespace 行为 | MemoryStorageBackend 测试 |
| `packages/coding-agent/test/extensions-runner.test.ts` 或专门 context API 测试 | getter 有效值、undefined、切换读取、无反向可变引用 | 复用 ExtensionRunner + in-memory active preset action |
| `packages/coding-agent/docs/prompt-presets.md`、`packages/coding-agent/docs/extensions.md` | 前者说明 `extensions` 字段，后者登记 getter 签名与返回语义 | 文档变更；不另建 API 体系 |

本模块没有任何预期文件、音频、网络或 settings 持久化副作用。preset JSON 已是配置持久化来源；live 设置和 API 调用分别由其他模块负责。

## 5. 状态与持久化

- Active preset 状态仍由 `AgentSession._activePreset` 持有；getter 是对此状态的只读投影。恢复时优先采用最近的 session `preset_change` ID，其次采用 settings 默认 ID；若 ID 可解析则激活对应 preset。仅当两者都没有给出 restore ID 时，才按 `autoActivate` 规则选择默认 preset；若 restore ID 存在但无法解析，则保持 built-in preset，不回退到 `autoActivate`。证据：`agent-session.ts:2176-2205`。
- `setActivePreset` 在成功切换后替换 `_activePreset` 并发出 `preset_activated(presetId)`；disabled id 会回到 built-in preset。preset identity 的持久化仍使用原有 session entry / settings，不把 `extensions` payload 另存一份（`agent-session.ts:2312-2345`）。
- 当前有效配置来自 `_activePreset` 对象，包含 loader 决出的磁盘 global/project 覆盖或 inline 覆盖；不能从 `presetId` 再自行选择文件。加载同 ID loser 的 namespace 不得与 winner 做字段级合并；优胜 preset 整体替代。`loader.ts:82-102,104-124`。
- 扩展自身设置 API 持久化独立的 per-extension settings，不适合作为 preset 配置第二份副本（`extensions/types.ts:346-352`）。
- `[推断]` 若 preset 文件在 session 运行中修改，现有 loader/reload 机制决定 active object何时更新；本 API 不额外监视文件，也不提供即时 hot reload 语义。

## 6. TUI / 扩展 API

- 调用形状：扩展生命周期/命令/event handler 收到的 `ExtensionContext` 上调用 `ctx.getActivePresetExtensionData("live-voice")`；返回通用只读对象或 `undefined`。新增接口不绑定特定扩展 ID，也不要求使用 TUI。
- `ExtensionContext` 当前由 `ExtensionRunner.createContext()` 创建，属性通过 runner 闭包在调用时解析；`createCommandContext()` 复制 getter descriptor 以保留延迟访问语义（`extensions/runner.ts:783-787,910-917`）。实现应延续该 pattern，并用 `assertActive()` 保持 extension reload / stale context 保护。
- 扩展可在 `session_start` 或 `preset_activated` 后获知后续 turn 可用配置；真正为 turn 固定快照必须发生在用户输入被接受时：语音 pipeline 启动前，键入消息 input dispatch / queue 前（含 followUp）。同一逻辑 user turn 的 transcript、assistant 回复及多个 speech tasks 共享该快照；turn 中途切换不变更它。事件 `preset_activated` 仍仅有 `{ type: "preset_activated"; presetId: string }`（`extensions/types.ts:764-768`）。
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
3. `packages/coding-agent/src/core/agent-session.ts::_bindExtensionCore`：在传给 `runner.bindCore(actions, contextActions, ...)` 的 `ExtensionContextActions` 对象中加入动态回调 `getActivePresetExtensionData: (namespace) => this._activePreset.extensions?.[namespace]`（实现需遵从 loader invalid namespace 已跳过的结果）；它在 runner 创建后绑定，但闭包每次调用时读取 `this._activePreset`。
4. `packages/coding-agent/src/core/extensions/types.ts::ExtensionContext`：声明 `getActivePresetExtensionData(namespace: string): Readonly<Record<string, unknown>> | undefined`；在内部 `ExtensionContextActions` 增加可选 callback（旧式嵌入 runner 未提供时 fallback 返回 `undefined`，session 核心绑定必须提供）。
5. `packages/coding-agent/src/core/extensions/runner.ts::bindCore` 与 `createContext()`：保存 context action callback，并在 context member 中调用 `assertActive()` 后动态执行；callback 缺失时返回 `undefined`，不可在 `createContext()` 或 runner 构造时缓存 preset 数据。
6. `packages/coding-agent/src/core/extensions/index.ts` 和 `packages/coding-agent/src/core/index.ts`：确认现有 `ExtensionContext` 类型导出已覆盖成员，不另造 public standalone getter type。
7. `packages/coding-agent/test/prompt-preset-loader.test.ts` 与 `prompt-preset-loader-storage.test.ts`：扩充相关 fixtures / assertions；`extensions-runner.test.ts`：按现有 `createContext()` 和 `bindCore()` 测试 pattern 验证读取语义。
8. `packages/coding-agent/docs/prompt-presets.md` 与 `packages/coding-agent/docs/extensions.md`：分别补充 preset JSON schema 和 context getter API 说明。

## 9. 与现状差异

### 已核实的现状事实

- `PromptPreset` 当前只列举 id、items、defaults、tools、skills、schemas、regex、hiddenOverrides、variables、memory 等已知字段，没有 `extensions`（`packages/coding-agent/src/core/prompt-preset/types.ts:251-280`）。
- `normalizePreset` 手工构造 `preset` 并逐字段复制，没有处理 `obj.extensions`；这是未知顶层字段丢失的直接原因（`packages/coding-agent/src/core/prompt-preset/loader.ts:219-283`）。
- preset loader 扫描 agent/global 目录后扫描 project dir；同 ID 新值替换原数组槽位。project 后于 global 加载，因此 project preset 整体覆盖 global preset（`loader.ts:82-102`）。仓库文档也记载项目 preset 同 id 覆盖 global（`packages/coding-agent/docs/prompt-presets.md:5-12`）。
- inline preset 最后合并并覆盖同 ID 扫描项，产生 warning；内联数组同 id 后项胜出（`loader.ts:104-128`，`test/prompt-preset-loader-storage.test.ts:109-158`）。
- session 将活动对象保存在 `_activePreset`；恢复先取最近 `preset_change`，否则取 settings 默认 ID；只有二者都未提供 ID 时才尝试 `autoActivate`。ID 能解析时激活对应 preset；未知 ID 不会触发 `autoActivate`，而保持 built-in preset（`agent-session.ts:2176-2205`）。`setActivePreset` 从已加载列表查找并替换 active object（`agent-session.ts:2312-2345`）。
- runner 在 `agent-session.ts:4851-4863` 创建并绑定；`_ensureActivePresetRestored()` 随后于 `agent-session.ts:4874` 恢复活动 preset。读取 callback 必须闭包引用当前 session，而在调用时查 `_activePreset`，不可 capture runner 创建时的 active preset snapshot。已有内部 `activePreset` getter 位于 `agent-session.ts:2215-2218`。
- `_bindExtensionCore()` 构造 `ExtensionContextActions` 并传给 runner 的 `bindCore()`（`agent-session.ts:4436,4572-4590`；`extensions/runner.ts:370-417`）；这是新增动态 lookup 的准确绑定落点。现有 runner `createContext()` 是延迟 context 构造（`extensions/runner.ts:783-789`）。

### 本设计拟实施的目标状态（尚未落地）

- loader 将保留 `PromptPreset.extensions` 通用映射，namespace payload 不再丢失。
- ExtensionContext 将提供 `getActivePresetExtensionData(namespace)`，读取当前 session 的 active preset；调用方不再依赖扩展端扫描 preset 路径或从事件 ID 猜测配置。
- loader 将为非法的顶层 `extensions` 容器或非法单一 namespace 追加 warning 并局部忽略；preset 本身保持可加载，其它有效 namespace 的未知字段完整保留，遵循 `01-共同上下文.md:100-112`。
- 公共 `preset_activated` event、preset 选择规则和 preset ID 持久化保持不变。

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

不运行 build/test/lint；以上为设计验收项，不声称已经执行测试。

## 11. 冲突与待拍板

### 11.1 已裁定的通用容器错误语义（遵循共享契约）

- `01-共同上下文.md:100-112` 已明确：只保留 `extensions` 顶层命名空间；`extensions` 顶层非法或 namespace 非 object 时追加 warning，并只忽略对应容器/namespace，不使整个 preset 失败；其余有效 namespace 与内部未知字段原样保留；扩展元数据不参与核心 prompt 渲染。
- 设计依据及复核：现有 loader 的 `normalizePreset` 逐字段构造对象，未复制 `obj.extensions`（`loader.ts:230-283`）；loader 现有 `isPlainObject` 定义拒绝 null、array、非对象（`loader.ts:541-543`）。实现应将该检查只用于上述两层容器，不能递归过滤 namespace payload 的未知字段。
- 本模块按照以上已冻结语义设计，不保留旧版“需要主代理裁定”的 blocker。

### 11.2 Getter 数据隔离深度未由共享契约规定

- **证据**：共享 getter 返回 `Readonly<Record<string, unknown>>`（`01-共同上下文.md:102-110`），TypeScript 的浅层 `Readonly` 不约束 nested object；现有 settings context 使用 clone 避免改写 manager 状态（`test/extensions-runner.test.ts:155-163`）。
- **设计约束**：getter 结果不得反向修改 active preset；验收测试验证外部写操作不泄漏。复制/冻结的具体实现方案仍属实现细节，不是共享契约冲突。

### 11.3 需同步的文档

- `packages/coding-agent/docs/prompt-presets.md`：补充通用 `extensions` 位置与 namespace getter 说明，明确同 ID 仍是 winner preset 整体替换，不是深 merge。
- `packages/coding-agent/docs/extensions.md`（ExtensionContext 章节，`docs/extensions.md:959`）：登记 getter 签名、undefined 语义、当前 active preset 解析及读取边界。
- 两份设计输入对本设计的容器策略已一致；`00` / `01` 不由本模块编辑。主代理已在 `01-共同上下文.md:101` 冻结非法容器 warning 与局部忽略规则，并在 `:110` 冻结 active namespace getter 的返回 / 读取时序。

### 11.4 未决项清单

1. getter 返回的嵌套对象是否要求运行时深冻结，或只保证无反向可变引用；按 §2.2 建议实现隔离，但共享契约未指定具体手段。
2. `[推断]` 当前 `getActivePresetExtensionData` 可在所有 ExtensionContext mode 下使用；音频扩展本身仍只允许 TUI 启动，本 API 不属于音频 API。
3. loader 只验证 namespace 容器，不验证 `live-voice` 内部属性类型；字段级错误应由 live voice 扩展提示并选择默认的细节需其文档自行写明。

## 12. 需求对照（00 效果 E1–E10 / 决策 D1–D18）

本节按所有效果逐条落点。此模块只直接实现涉及 preset 的数据传递，其余以明确边界交由 `/03-live-voice-extension.md`，不把无关效果声称已由 core 达成。

| 编号 | 原文消息依据（`00` §1） | 与冻结契约的对照 / 本模块落点 |
|---|---|---|
| E1 | 消息 1（全局 `/live` 扩展） | 非本模块行为；getter 是通用 ExtensionContext API，不决定扩展安装或 `/live` 启停。D1、D15：不保存 live 状态，本模块不增持久化字段。 |
| E2 | 消息 1、消息 3（状态持续） | 不涉及 preset metadata；遵循 D2、D3、D5，不在本模块扩展 preset schema。 |
| E3 | 消息 1；ask 原话“唤醒词用 ‘话说’” | 与 preset core 无关；KWS / cue 由 live voice module 处理，不能声称 metadata getter 验证模型效果。 |
| E4 | 消息 1、消息 4（user 语音结合上下文改写） | `extensions.live-voice.transcriptInstructions` 可由通用 API 读取；读取 API 不处理 ASR / transcript。满足 D8、D9 的“指令来源”数据面，处理行为不在本模块。D17 的 Pi busy 时 `followUp` 排队与送达顺序由 live voice 提交逻辑负责；与 preset metadata 无直接关系。 |
| E5 | 消息 1、消息 5（会话文本不被语音稿改写） | `extensions` 与 preset prompt items 分离，getter 不改 assistant 原文。D11/D18 的 qualifying assistant `turn_end` 触发、FIFO TTS queue 和 mic gate 均由 03 处理；该逻辑 user turn 的所有 assistant/TTS task 使用用户输入被接受时固定的同一有效 preset snapshot。 |
| E6 | 消息 4、消息 5、消息 6（后处理与结构口述） | `spokenReplyInstructions` 及 provider-neutral `ttsProfile` 作为扩展 namespace payload 保留，具体生成语义交 03；对应 D10、D13。 |
| E7 | 消息 3（live 待机仍持续） | 不属于 preset loader/context 范围；不以 preset 切换改写 live 状态。对应 D2、D6。 |
| E8 | 消息 1、消息 3 | 本模块不持有 live 状态，也不处理关闭取消；遵循 D12、D15，不把运行态放入 preset metadata。 |
| E9 | **消息 7**（preset 为扩展提供专用可读字段的建议）、**消息 8**（loader 不要丢字段）；消息 1 为全局扩展背景 | **直接落点**：用户反对 voice 专属 core 字段、批准通用 `extensions` 命名空间读取通道（`00` §3 S4、§4 D13）；实现 `PromptPreset.extensions` 通用映射与签名 `getActivePresetExtensionData(namespace: string): Readonly<Record<string, unknown>> \| undefined`，按 session 实际生效对象读取，项目同 id 覆盖 global、inline 覆盖 scanned 的最终 winner；切换后后续读取应用新值，缺配置 `undefined`/由扩展用默认。满足 E9、D13、D14，并完全服从 `01` §6.1。 |
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
| D10 | 保留 spoken reply instructions / TTS profile；不定义其内部 schema 和 provider mapping。 |
| D11 | metadata API 在逻辑 user turn 被接受时提供固定 snapshot；该 turn 中的 assistant speech tasks 复用它。是否入队由 03 按 `turn_end` 的 assistant role、`stopReason === "stop"`、可见文本且无 toolCall 判定；`length` 等待后续 continuation；最终 settled 仍无正常 stop 时不播。 |
| D12 | 不创建请求或取消策略；live 关闭不会写回 preset。 |
| D13 | `extensions` 是唯一扩展透传区；不保留其它任意 top-level 字段，不增加 voice-specific core 字段；暴露通用只读 getter。 |
| D14 | 新的逻辑 user turn 被接受时读取当前 active preset；该 turn 固定使用当时配置，turn 中途 preset 切换只影响后续 turn；无 preset/namespace 时扩展使用通用默认。 |
| D15 | 不存 live 状态/计时；原有 per-extension settings API 不变。 |
| D16 | 不指定或伪造 API provider、端点、凭证、request/response 格式。 |
| D17 | 语音消息在 Pi busy 时以 `deliverAs: "followUp"` 排队，按实际送达顺序；属于 03 的消息提交/时序边界，本模块不改变 getter、preset 覆盖或配置快照语义。 |
| D18 | qualifying assistant reply 原文按生成顺序串行进入 TTS queue；`agent_settled` 只清 `piBusy`，只有 Pi settled 且 output queue/worker 都空才重开麦克风。同一 user turn 的 speech tasks 复用 turn 接受时的 snapshot；getter 不决定队列和 mic gate。 |
