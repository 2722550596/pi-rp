# 01-memory侧：TidyRunner 与触发（TEMP 自动整理·设计文档）

> 上游：`00-需求原话.md`（明月原话）＞ `01-共同上下文.md`（冻结契约，2026-09-30 修订 v2）＞ 本文。
> 范围（契约 §6）：TidyRunner（agentLoop 消费、ToolDefinition→AgentTool adapter、简报提取、maxTurns/timeout）、触发接线改造（§2.8）、跨进程互斥锁（§2.7）、tidyCtx 工具实例（§2.5）、配置 schema 解析、失败兜底联动（D1）、滞后标志联动、包内测试计划、**TEMP 导航缺陷修复设计（§2.9 修订 v2 / §4.0）**。
> 所有事实带 file:line（契约 §3 引用或本文自行核查）；推断标 [推断]。

---

## 1. 一句话定位

在 memory 包内新增 `temp-tidy.ts`：以 pi-agent-core `agentLoop` 驱动一个 headless 整理 agent（全套 12 记忆工具 + 独立 tidyCtx），由 module.ts 现有 TEMP 阈值检查点触发（跨进程互斥锁防并发），产出简报经 `sendCustomMessage(triggerTurn:false)` 投递、失败降级为现有 rp-notify 手动通知；同时修复全库导航语义缺陷（域根遍历、stub 子树渲染、index 口径），使 `recall(uri="TEMP://")` 成为可信的域级底册入口。

---

## 2. 签名参数

### 2.1 TidyRunner 主入口（新文件 `packages/memory/src/temp-tidy.ts`）

```ts
export type TidyFailureReason =
  | "no-model"        // sideStreamFn 抛出（模型解析失败，契约 §2.3 错误面）
  | "timeout"         // timeoutMs 到时，本 runner 的 AbortController 触发
  | "aborted-dispose" // parentSignal（module dispose/reload）中止——不算 tidy 失败，不发兜底通知
  | "max-turns"       // shouldStopAfterTurn 轮数上限切断
  | "error-stop"      // 终态 assistant stopReason === "error"
  | "empty-briefing"  // 正常结束但简报文本为空（§2.6 细化：不回看）
  | "lock-lost"       // 持锁期间心跳刷新 changes===0：锁被僵死回收抢走（fencing 失败）
  | "loop-throw";     // agentLoop/工具层抛出未预期异常

export type TidyOutcome =
  | { status: "completed"; briefing: string; turnCount: number }
  | { status: "failed"; reason: TidyFailureReason; error?: string };

export interface TidyRunnerOptions {
  store: MemoryStore;
  host: MemoryModuleHost;          // 只用 sideStreamFn / sendCustomMessage 两个原语
  systemPrompt: string;            // 已解析（覆写或内置默认，见 §3.1 步骤 T3）
  taskTemplate: string;            // 已解析，含 {temp_list} 占位（可不含，见 §3.5）
  modelRef?: string;               // settings.memory.temp.autoTidy.model 原样透传
  maxTurns: number;                // 已解析（缺省 30，§2.4）
  timeoutMs: number;               // 已解析（缺省 600000，§2.4）
  parentSignal?: AbortSignal;      // module dispose 联动（module.ts dispose 先例 :778-781）
}

/** 永不 reject：一切失败都折算成 TidyOutcome；调用方 void + 防御性 .catch。 */
export function runTidy(opts: TidyRunnerOptions): Promise<TidyOutcome>;
```

约定（跨文档，02 实现侧 MUST 遵守；**[修订 2026-09-30 J7]** 采纳 R3 审计裁决，废除 TIDY_MODEL_STUB 占位模型）：`host.sideStreamFn()` 返回 **`{ streamFn, model }`**（契约 §2.3 修订 v2）——`model` 为 host 解析后的 `Model` 实例，runTidy 直接填 `config.model`（`AgentLoopConfig.model: Model<any>` 必填，agent/src/types.ts:168）；`streamFn` 的解析结果已 pin 死在 host 闭包内，**忽略其首参 `model`**（agentLoop 内部以 `streamFunction(config.model, …)` 调用，agent-loop.ts:319 实证——首参仅在 AgentEvent 快照中现形，无害）。模型解析仍由 host 侧完成（`_modelRuntime.getModels()`，agent-session.ts:~5026），memory 侧不再需要任何占位 stub。

### 2.2 跨进程互斥锁（契约 §2.7 形状，key/值不改形）

> [实现偏差备案 2026-09-30] 本文 §2 及契约 §2.3 引用的 `MemoryModuleHost.sideStreamFn` / `getTempTidyPromptOverrides` 在实现中声明为**可选成员**（`?`，module.ts:132/138）——02 §3.D 的"required + 运行时防御"落为"可选 + 运行时防御"：headless 结构化 host 的类型诚实反映"不是每个 host 都实现新原语"，运行时 `typeof !== "function"` 防御完整（module.ts:690），引擎侧 host 三成员全部实现（tsgo 零错误）。主代理裁决接受。

```ts
export interface TidyLockValue {           // 契约 §2.7 冻结形状，逐字
  startedAt: string;                       // 墙钟 ISO（抢锁时刻）
  heartbeatAt: string;                     // 墙钟 ISO（最后心跳）
  pid?: number;                            // 必写（owner 身份的一半）
  sessionHint?: string;                    // 触发会话 id，纯观测用
}

export interface TidyLockHandle { owner: { pid: number; startedAt: string } }
export function tryAcquireTidyLock(store: MemoryStore, sessionHint?: string): TidyLockHandle | null;
export function refreshTidyLock(store: MemoryStore, owner: TidyLockHandle["owner"]): boolean; // false = 锁已丢
export function releaseTidyLock(store: MemoryStore, owner: TidyLockHandle["owner"]): void;
export function readTidyLock(store: MemoryStore): TidyLockValue | null;
```

owner 身份 = `pid + startedAt` 二元组，**不新增字段**（同一进程先后两次抢锁靠 startedAt 区分；pid 为 null 的历史脏行永远抢不过也刷不了——我们写入时 pid 必填，契约里 `pid?` 的可缺省只容忍外部脏数据，见 §6 错误边界）。

### 2.3 配置解析（契约 §2.1 schema 的 memory 侧落点）

```ts
// config.ts 增补：
export interface AutoTidySettings { enabled?: boolean; model?: string; maxTurns?: number; timeoutMs?: number }
// MemorySettings.temp: { threshold?: number } → { threshold?: number; autoTidy?: AutoTidySettings }

// temp-tidy.ts：
export interface ParsedAutoTidy { enabled: boolean; modelRef?: string; maxTurns: number; timeoutMs: number }
export function parseAutoTidySettings(raw: AutoTidySettings | undefined): ParsedAutoTidy;
```

解析规则（字段级忽略 + 缺省，绝不 throw——契约 §2.1 容错倾向"整理是旁路功能，绝不因配置错误阻塞主会话"）：

| 字段 | 合法 | 非法/缺省 → |
|---|---|---|
| `enabled` | `boolean` | 缺省 **true**（D5）。非 boolean 忽略落 true——注意 `enabled: 0` 这类用户笔误会被当 true，属接受的容错代价（§12 待拍板 7） |
| `model` | 非空白 `string` | undefined → host 侧解析为会话主模型（D5，契约 §2.3） |
| `maxTurns` | 整数 1..200 | 缺省 **30**（§2.4 依据） |
| `timeoutMs` | 整数 ≥ 1000 | 缺省 **600000**（§2.4 依据）；<1000 视为非法（防"1ms 超时"自废武功的笔误） |

### 2.4 缺省值与常量依据（契约留白由本文定）

| 常量 | 值 | 依据 |
|---|---|---|
| `DEFAULT_TIDY_MAX_TURNS` | 30 | 阈值缺省 10 条草稿（temp-notify.ts:13）；每条草稿"读 1 次 + 写 1~2 次"≈ 20~25 轮工具回合，加索引/底册读取与收尾简报，30 留余量。同时是**绝对成本天花板**：一轮 = 一次 LLM 请求，30 轮封顶，preset 抬高阈值也不会放大单次 tidy 开销。[推断]（按工具粒度估算，非实测） |
| `DEFAULT_TIDY_TIMEOUT_MS` | 600000（10min） | 30 轮 × side 通道 LLM 每轮 15~20s ≈ 7.5~10min；心跳 30s × 20 拍仍在锁存活窗口内。与契约 §2.1 示例值一致。[推断] |
| `TIDY_HEARTBEAT_MS` | 30_000 | 契约 §2.7 建议；30s 一次 `UPDATE`，开销可忽略（对比 busy_timeout=5000ms，driver-node.ts:133——锁操作排队 5s ≪ 心跳周期，自己的心跳永远不会跟自己的锁写排队冲突） |
| `TIDY_LOCK_STALE_MS` | 300_000（5min） | 契约 §2.7 建议；= 10 个心跳周期，容忍持锁方 GC 停顿/网络抖动数分钟量级；进程死亡后最多 5min 全库恢复可整理 |
| `TIDY_RETRY_COOLDOWN_MS` | 300_000（5min） | 一次 tidy（含僵死回收窗口）结束后，抑制其他已武装会话立即重试的冷却窗；取值与锁僵死阈值同量级（一个"锁代际"时间）。[推断]（§12 待拍板 1） |
| `TIDY_BRIEFING_MAX_CHARS` | 500 | 契约 §2.4 建议；rp-notify `context: "include"`（module.ts:704-707）→ 简报是**角色上下文常驻负载**，500 字符 ≈ 数百 token，足够"逐条处置说明"（中文 ~10 条草稿 × 40 字），又防模型把全过程流水账当简报倾倒。全文落 audit（§5），会话条目持有截断版 |
| `TIDY_TEMP_LIST_MAX_ENTRIES` | 200 | {temp_list} 单页上限，超出截断加"…另有 N 条"尾行。防极端积压把任务模板撑爆。[推断] |
| 锁 key `"temp-tidy-lock"` / 值形状 | 契约 §2.7 逐字 | 不改形 |
| 附加 kv key `"temp-tidy-last-finish"` | 本文档新增（申报，见 §11 冲突 4） | 冷却判断依据，value = 墙钟 ISO |

---

## 3. 行为契约逐步

### 3.1 触发接线与状态机（改造 module.ts:638-648）

**现状**（契约 §2.8 锚点，行号已复核）：`handleAutoretainAndTemp()` 尾部——

```ts
// module.ts:638-648（现状）
const isVisibleLocal = (node) => !hiddenAutoNodeIds.has(node.node_id);
if (countActiveTempNodes(store, isVisibleLocal) < tempThreshold) {
  tempNotified = false;                       // 639-642：清零回旋（re-arm）——保留不动
  return;
}
if (tempNotified) return;                     // 643：滞后标志
const notify = checkTempThreshold(store, { threshold: tempThreshold, isVisible: isVisibleLocal }); // 644
if (notify) {
  tempNotified = true;                        // 646
  host?.sendCustomMessage(notify);            // 647
}
```

**改造后**（643-647 替换为分支树；639-642 一字不动）：

```
命中 notify（count ≥ threshold 且 !tempNotified）：
 T1. autoTidy.enabled === false
     → tempNotified = true；host.sendCustomMessage(notify)        【D1 禁用兜底 = 现状行为原样】
     漏了会怎样：禁用用户被强迫 tidy（违反 E9"关闭后与现状完全一致"）。

 T2. 冷却期内（kv "temp-tidy-last-finish" 距今 < TIDY_RETRY_COOLDOWN_MS）
     → tempNotified = true；静默 return，无通知
     漏了会怎样：刚结束一次 tidy（未清零的 D3 自定义使命）后，每个武装会话每轮都再抢锁再跑一次
     tidy——多会话下 tidy 以会话数 × 回合频率空转烧 token。
 T3. 组装提示词：const o = host?.getTempTidyPromptOverrides?.() ?? {}（02 冻结的 pull getter，每次触发新鲜拉取）；
     systemPrompt = o.systemPrompt 非空白 ? o.systemPrompt : DEFAULT_TIDY_SYSTEM_PROMPT；
     taskTemplate = o.taskPrompt 非空白 ? o.taskPrompt : DEFAULT_TIDY_TASK_TEMPLATE
     （02 loader 侧已做类型/空白校验，memory 侧防御性再兜一层，规则同款：trim 非空才采纳）
     漏了会怎样：preset 切换后（setActivePreset 同 dbPath 不触发 runtime rebuild，agent-session.ts:2292-2305）
     用旧覆写跑 tidy——正是 02 选 pull 模型要防的事。

 T4. tryAcquireTidyLock(store, sessionHint)
     → null（他人持锁且存活）：静默 return，tempNotified 保持 false，下轮重试
     【契约 §2.7：抢锁失败静默放弃，不发通知】
     漏了会怎样：若此处置 tempNotified = true，持锁方 tidy 失败后本会话永远沉默——
     E6 兜底对"非持锁会话"失效且无自愈；保持武装则持锁方失败/僵死后本会话下轮自然接管（自愈）。
     成本：每轮一次原子 UPSERT，可忽略。

 T5. 抢到锁：tempNotified = true（本会话接管此积压代——成败都有下文：简报或兜底通知）
     → void runTidy({ … }).catch(defensive audit)   【fire-and-forget，模式同 agent-session.ts:1191】
     漏了会怎样：不置位则 tidy 在跑的每轮都重复走 T2-T4（T4 会被锁挡住，但 T2 冷却未生效前
     每轮空转）；runTidy 不加 .catch 则任何漏网异常成为 unhandled rejection（进程级风险）。
```

**滞后标志 `tempNotified` 语义重定义**（必答 3）：由"已发手动通知"改为"**本积压代已有归属**"。回旋条件不变：仅当 `countActiveTempNodes(...) < tempThreshold` 才复位（module.ts:639-642 原样）。三分支裁决：

| # | 分支 | 走向 | 依据 |
|---|---|---|---|
| ① | **tidy 完成但 TEMP 未清零** | 简报照发（E4 达成）；`tempNotified` 维持 true → 本代不再触发，直到某次写入路径后检查发现 count < threshold 才 re-arm | D3 明文允许"甚至可以不清空"——若完成未清零就重触发，不清空型使命将陷入每代重复 tidy 死循环烧 token；hysteresis 是唯一的刹车 |
| ② | **tidy 在跑，新写入再超阈值** | 本会话：`tempNotified=true` 已挡住（643 早退）。他会话：本代首次检查若已在 T4 被锁挡 → 保持武装静默让路；若冷却/已接管 → 同 ①②。**在跑的 tidy 是否覆盖新草稿不作承诺**：它可能已读过底册快照——新草稿留给下一代（re-arm 后）处理，{temp_list} 快照陈旧由 03 的兜底指令对冲（契约 §2.9） | 双保险：标志挡同进程重复触发，锁挡跨进程并发 tidy。漏了锁 → 两个 tidy 并发 consolidate/forget 同一批节点（读-改-写交错，重复建节点/误删）；漏了标志 → 同会话每轮重复抢锁空转 |
| ③ | **tidy 失败后残留** | runTidy 内部：发兜底 rp-notify（`buildTidyFailureContent`，triggerTurn 默认 true——"你来看看"要求行动，与 D9 简报的 false 区分）→ finally 释放锁 + 写 last-finish → `tempNotified` 已在 T5 置 true → 本代不再自动重试；角色按通知手动整理，清零后 re-arm | D1"失败兜底"。漏了通知 → E6 违约（整理失败无人知晓）；漏了 finally 释放 → 锁悬空 5min，期间全库所有会话在 T4 静默让路（功能整代瘫痪） |

**消歧：跨会话失败告知的边界**。持锁方 tidy 失败时，兜底通知发往**持锁方自己的会话**（host 是它绑定的会话）。让路会话依契约 §2.7 静默，不补发。残留缺口：让路会话的角色在本代收不到任何告知（其 `tempNotified=false` 会在下轮重试接管，自愈点在"接管成功"或"持锁方 5min 僵死被回收"）。此为契约 §2.7 明文选择的语义，本文如实声明边界，不做超契约扩展（§12 待拍板 1 含可选的 tombstone 方案）。

**dispose 联动**：module.ts `dispose()`（:778-781 现状 abort recall/autoretain）追加 `tidyAbort.abort()`。runTidy 检测 `parentSignal.aborted` → 折算 `"aborted-dispose"`，**不发兜底通知、不再写 last-finish**（reload 后新 module 重新武装，自然重触发）。漏了：向正在销毁的 host 投递消息（host 已随旧 runtime 失效）要么抛错成为 unhandled rejection，要么 reload 后与重新触发产生重复通知。

### 3.2 TidyRunner 执行管线（runTidy 内部，逐步）

```
R1. 心跳定时器：setInterval(HEARTBEAT_MS) → refreshTidyLock；changes===0（锁被僵死回收抢走）
    → 置 lostLock，abort 自身 controller（折算 "lock-lost"）。unref() 防止定时器钉住进程退出。
    漏了会怎样：持锁方假死（网络挂起 10min）期间，他人 5min 后抢走锁开始第二个 tidy，
    假死方苏醒后继续写节点——双 tidy 并发，①分支防的交错写污染照样发生。

R2. sideStreamFn：await host.sideStreamFn({ modelRef, signal: combined }) → { streamFn, model }（契约 §2.3 修订 v2）；throw → outcome failed("no-model")。
    漏了会怎样：模型没配好时 agentLoop 拿不到 StreamFn 只能内部报 error-stopReason，
    失败原因不可辨（audit 无法区分"没模型"与"模型跑挂"）。

R3. 合并中止信号：combined = AbortController；parentSignal.aborted → 立即折算 "aborted-dispose"；
    timeout 计时 setTimeout(timeoutMs) → abort；finally 清理定时器与 interval。
    漏了会怎样：timeoutMs 形同虚设（tidy 永不返回，锁最终靠 5min 僵死回收兜住，
    期间心跳却一直刷——一个永不死的僵尸 tidy）。

R4. 变量渲染：listActiveTempRows(store) 直出（§3.5）→ **`renderTidyTaskPrompt(taskTemplate, vars)` 单点渲染**（实现在 tidy-prompts.ts，03 定稿；**函数式替换** `template.replace(/\{temp_list\}/g, () => listText)`——replace 回调形式，底册首行含 `$`/`$&` 序列不会被替换模式损坏；同 compaction.ts:713-717 plain replace 惯例但升级为回调形式）。**保留变量表 = `{temp_list}` `{max_turns}`** 两键（**[修订 2026-09-30 J2]** `{threshold}` 从 03 设计不采用——背景 trivia 进任务书诱导碎念入口），统一 replace-if-present（契约 §2.2 增补/§9-J2：出现即替换、缺失不报错不残留——覆写模板漏写变量是作者自由，不是错误）。同时记录 beforeCount = rows.length 进 outcome 供审计。
    漏了会怎样：字面串替换参会让草稿首行里的 `$&` 等序列被替换引擎展开损坏底册（R2-F5）；漏 {max_turns} 替换则模型收到字面占位符（R2-F2）。
    > [修订 2026-09-30 J2/J5] 函数式替换 + 变量表冻结 + 悬空 §3.6 更正 §3.5。

R5. 组装 tools：tidyCtx（§2.5 冻结四字段，原样）+ createMemoryTools(store, tidyCtx) → 12 个 MemoryToolDef
    → toAgentTool adapter（下表）。
    漏了会怎样：tidyCtx 若带 host.getSessionInfo 的活跃值 → 写节点盖会话锚、audit 记角色会话 turn、
    recall 吃 foreign 过滤——tidy 变成"某个会话的身份"在整理，跨库可见性（契约 §2.5 全库可见）被破坏。

    ToolDefinition（memory MemoryToolDef，tools.ts:72-82）→ pi-agent-core AgentTool（agent/src/types.ts:427）
    字段映射（必答 2）：
    | MemoryToolDef                                  | AgentTool                       | 转换 |
    | name/label/description                         | 同名直传                        | identity |
    | parameters (TSchema)                           | parameters                      | TypeBox 原样；loop 用 validateToolArguments 校验 |
    | execute(toolCallId, params) => MemoryToolResult | execute(toolCallId, params, signal?, onUpdate?) | 签名收窄：adapter 丢弃 signal/onUpdate（memory 工具是同步 SQLite 操作，无中止点、无部分产出）；返回值结构已满足 AgentToolResult（content: [{type:"text"}] ⊆ (TextContent|ImageContent)[]，details: object） |
    | promptGuidelines                               | 【剥离，不进 tool 也不进 systemPrompt】        | **[修订 2026-09-30 J5]** tidy adapter 剥离该字段（契约 §9-J5）：tidy 是系统代理，不需要"披露自触发"指引（那是给角色 agent 的沉浸约束）；剥离后覆写 systemPrompt = 完整生效（E5 覆写整体性，无引擎强制附录）。tidy 的"想起条件必须读"约束由 03 的 system 文案自身承载（经 R7 裁决改版） |
    | —                                              | prepareArguments? / executionMode? | 不设（config 层统一 toolExecution:"sequential"） |

    【对照声明】coding-agent 的 ToolDefinition（core/extensions/types.ts:530，execute 五参含 ctx:
    ExtensionContext、renderCall/requires 等引擎字段）不直接参与本 adapter——memory 工具在 module.ts:682-691
    注册时已退化为 registerTool 的结构子集；tidy 路径从 MemoryToolDef（更窄、无引擎依赖）出发，
    天然满足 §5 硬约束 5（不 import coding-agent）。

R6. agentLoop 调用（必答 1；真实签名 agent-loop.ts:29-46，runAgentLoop :118-133 为 canonical 先例）：

    const stream = agentLoop(
      // prompts: 首条 user 消息（timestamp 必填，Message 类型要求；completeSideRequest 同款 agent-session.ts:5008-5012）
      [{ role: "user", content: [{ type: "text", text: taskPrompt }], timestamp: Date.now() }],
      // AgentContext（agent/src/types.ts:453-458，三字段全填）
      { systemPrompt, messages: [], tools: tidyTools },
      // AgentLoopConfig（agent/src/types.ts:168，extends SimpleStreamOptions）
      {
        model,                       // **[修订 2026-09-30 J7]** 来自 R2 的 host.sideStreamFn 返回值 { streamFn, model }——host 解析后的真 Model 实例，无占位 stub
                                     // loop 对它的触碰 = 原样传给 streamFn 首参（agent-loop.ts:325）；
                                     // getApiKey 未提供 → 不读 .provider（agent-loop.ts:319 短路）。
                                     // 漏了会怎样：TS 编译不过（model 必填）。
        convertToLlm: (m) => m as Message[],  // 恒等：tidy 只产生 user/assistant/toolResult 标准角色，
                                              // 无 custom 消息需要转换（Agent 类的 convertToLlm 先例 agent.ts:478）
        shouldStopAfterTurn: () => ++turnCount >= maxTurns,
                                     // maxTurns 的唯一合法 seam——agentLoop 无原生轮数上限
                                     // （grep packages/agent/src "maxTurns" 零命中，已核查）；
                                     // 返回 true → loop 在 turn_end 后发 agent_end 优雅退出（agent-loop.ts:268-271），
                                     // 置 capped 标志供简报提取判定（§3.3）。
                                     // 漏了会怎样：模型陷入工具循环时 tidy 无上限烧 token，
                                     // 只能靠 timeoutMs 兜底（10min 顶格成本）。
        toolExecution: "sequential", // 默认 "parallel"（types.ts:349-356）——tidy 写共享节点
                                     //（consolidate/revise 先读后写），sequential 保证批内确定性、可测。
                                     // 漏了会怎样：并行批内两个 consolidate 读到同一节点旧态 → 重复归档。
      },
      combined.signal,
      streamFn,                      // R2 产物（pi-agent-core re-export，dist/index.d.ts:5 "export * from ./agent-loop.ts"）
    );
    const messages: AgentMessage[] = await stream.result();   // EventStream.result()（pi-ai event-stream.d.ts）

R7. systemPrompt 组装（一次性，R5 之后 R6 之前）：**即 T3 解析结果原样使用**（覆写或内置默认，不再追加任何引擎内容——promptGuidelines 已在 R6 adapter 剥离，契约 §9-J5）。tidy 所需的工具使用准则（"想起条件必须读"等 disclosure 纪律）由 03 的默认 system 文案自身承载，覆写作者的 systemPrompt 完整生效不被附加。
    漏了会怎样：若沿用旧版"拼接 12 工具 guidelines"，覆写作者的 systemPrompt 永不被逐字使用（E5 覆写整体性破坏，R2-F6/R3-C4 一票级矛盾）。
    > [修订 2026-09-30 J5] 由"03 文案 + 12 工具 promptGuidelines 拼接"改为"解析结果原样"。

R8. 收尾（finally，顺序固定）：
    a. 清 timeout/heartbeat 定时器；
    b. releaseTidyLock（owner 条件删，§2.2）——成功/失败都要走；lock-lost 时幂等无害；
    c. 写 kv "temp-tidy-last-finish" = 墙钟 ISO（aborted-dispose 除外，§3.1 dispose 联动）；
    d. audit（§5）。
    漏了 c → 冷却失效 → 多会话空转（同 T2 漏）；漏了 b → 锁悬空 5min（同 ③分支漏）。

R9. 交付：
    completed → host.sendCustomMessage(briefingMsg, { triggerTurn: false })   【D9；02 扩展后的签名】
    failed 且 reason !== "aborted-dispose" → host.sendCustomMessage(failureMsg)（默认 triggerTurn，
    引擎绑定现状硬编码 true，agent-session.ts:5055-5056；02 改造后透传不传即 true）
    漏了 D9 区分 → 简报唤醒角色新 turn——纯告知打断对话节奏，违反 D9 拍板。
```

**agentLoop 终态事实**（简报提取的事实底座，agent-loop.ts 实读）：循环自然终止的唯一路径是"assistant 无 toolCall 且无 follow-up"（:276-280）；`stopReason === "error" | "aborted"` 立即终止（:229-233）；`shouldStopAfterTurn` 返回 true 在 tool batch 完成后退出（:268-271）。**agentLoop 无内置 maxTurns**（grep 全包零命中）。

### 3.3 简报提取与截断（必答 6，契约 §2.6 细化）

```
E1. 终态校验：取 messages 中**从尾向头**第一条 role === "assistant" 的消息。
E2. 若 capped 标志（max-turns 切断）→ failed("max-turns")，无论该消息有无文本。
    为什么优先于文本判定：cutoff 发生在 tool batch 之后，末条 assistant 往往"文本 + toolCall"混排，
    其文本是执行中叙述（"现在合并这两条…"），不是简报。
E3. stopReason !== "stop" → failed 映射（"aborted"→ timeout/aborted-dispose 按 R3 信号源区分；
    "error"→ "error-stop"；"length"→ "error-stop"（截断的简报是半句话，投递即误导））。
E4. text = 该消息 content 中全部 type==="text" block 按 "\n" join，trim()。
E5. 非空 → 简报成立。空/缺失 → **failed("empty-briefing")，不回看**。
```

**回看规则的正式裁决：不回看**（契约 §2.6 点名要求细化此边界）。论证：
- 自然终止时末条 assistant 必然无 toolCall——文本为空说明模型违背了 03 提示词的简报约束（提示词缺陷，应由兜底通知暴露而非掩盖）；
- 异常终止（max-turns/abort/error）时，**任何**更早的 assistant 文本按循环语义必是执行中叙述（循环只在无 toolCall 时自然停）——回看捞到的必然是"我先看看 TEMP 里有什么"这类中间话，当简报投递既违反 D7 直接性、又对角色谎报"整理已完成"；
- 失败通知比错误简报便宜且诚实：audit 记录 `empty-briefing`/`max-turns` 可直接定位是提示词问题还是轮数上限问题。

**截断**（投递前）：`[...briefing].length > 500` → 按**码点**截前 500。R8 写 `temp_tidy_complete` 时取得 `logAudit()` 返回的 `lastInsertRowid`，尾注给出可直接调用的精确入口：`…（简报超长，已截断；全文：recall(uri="MEM://audit/id/<ID>")）`；驱动未返回行 ID 时才退化为 `MEM://audit/temp_tidy_complete/1`。码点截断防代理对（emoji/生僻字）劈半成乱码；精确 ID 防其他会话后续 tidy 把“最近一条”顶走。漏了入口 → “全文落 audit”对 agent 是死路；只有模糊最近条目 → 并发时可能取错简报。

**简报消息规格**（契约 §2.4）：

```ts
{
  customType: "rp-notify", display: false,
  details: { kind: "temp-tidy-report", model: modelRef ?? "session-default", turnCount, beforeCount, afterCount },
  content: 截断后的简报,
}
// afterCount = 交付前重数 countActiveTempRows（不滤可见性，与底册同口径）
```

**失败通知规格**：`buildTidyFailureContent(reason, count, threshold)`——头两行陈述"自动整理（temp-tidy）未能完成（原因：{reason 中文映射}），TEMP 现有 {count} 条草稿（阈值 {threshold}）"，后接与 `buildTempNotifyContent`（temp-notify.ts:40-54）共享的整理指引段（重构为共享常量 `TEMP_TIDY_GUIDE_LINES`，两处引用防漂移）。`details: { kind: "temp-tidy-failure", reason, count, threshold }`。

### 3.4 TEMP 导航缺陷修复设计（契约 §2.9 修订 v2 / §4.0，明月拍板必修；全库通用语义，非 TEMP 专属）

**缺陷清单**（实测复核）：
- 域根不存在：`store.put` 祖先补占位按 `split("://")` 后的路径段建 stub，循环上界 `segments.length - 1` 决定了**scheme 本身永远不是节点**（store.ts:470-485，`segments.length < 2 return` 使一级路径如 `TEMP://note-1` 连父链都不建）；`resolveUri("TEMP://")` 精确匹配失败返回 null（store.ts:271-278）→ `recall(uri="TEMP://")` → "未找到记忆"。
- stub 吞子树：executeRecall 在 resolveUri 后对 `node.is_stub` 直接早退（tools.ts:301，**契约 §3/§4.0 写 311 为旧行号，现为 301**，见 §11 冲突 2）→ `recall(uri="TEMP://self-reflection")` 只回"（占位节点，无正文）"，类目下的草稿不可见。
- index 只列顶层非 stub：`renderIndexView` 过滤 `!is_stub && parent_id === null`（memory-views.ts:176）→ 嵌于 stub 类目的草稿（autoretain 落 TEMP 的常态，autoretain.ts:83 `landing: { domain: "TEMP" }` + 落点带类目路径）从索引不可见。
- `MEM://recent/<N>` 混全域时间线：语义本如此，**不动**（TEMP 专属遍历由域根 recall 与 index 修复覆盖；{temp_list} 另保 tidy 起手效率，契约 §2.9"与修复不冲突"）。

**修复设计（三项，全部通用语义）**：

**N1. 域根 = 虚拟节点（等价机制，不建行）**。executeRecall 在 MEM:// 视图分支后、resolveUri 前插入域根分支（先例：视图 URI 本就先于 resolveUri 特判，tools.ts:247-283）：

```ts
const m = /^([A-Za-z][A-Za-z0-9_-]*):\/\/$/.exec(uri);   // 恰为 "scheme://"，多一段路径都不算
if (m) → renderDomainTree(store, m[1], depth, maxNodes, ctx.isVisible)
```

`renderDomainTree`（新 helper，tools.ts 内）：
- 子代集 = `store.listNodes({ domain }).filter(n => n.parent_id === null)`（含 stub 类目，含可见性过滤）——不新建 store 查询方法；
- 逐个渲染：非 stub 走既有 `renderChildSubtree`；stub 类目渲染为 `■ uri（类目）` 头 + 其子树；
- depth 语义与普通节点一致（recallParams tools.ts:211-214：0 = 直接子代 URI 列表、N = 递归 N 层、-1 = 整棵、max_nodes 预算 200）——域根 `depth:0` 即"域的顶层清单"，`depth:-1` 即全域完整底册；
- 审计记 view:"domain"，**不触 access time**（与"System views never touch access times"同类，tools.ts:246 注释口径：浏览域不是"想起"）。

为什么选虚拟而非物理建根行：物理 stub 根（把 scheme 纳入祖先循环）需要迁移存量库 + 处理"根是否计入 `countActiveTempNodes`（`is_stub=0` 口径，temp-notify.ts:33）/FTS/父指针语义（顶层节点 `parent_id===null` 若改挂根下，index 口径、children() 查询、既有数据全动）"三连爆炸；虚拟根零行零迁移，且 recall 对视图 URI 先行特判是既有惯例。代价：域根不可被 memorize/revise/forget 寻址（resolveUri 不认识它）——根是只读导航别名，语义合理。

漏了会怎样：不修此条，recall("TEMP://") 永远"未找到记忆"，任何依赖"先看全域再逐条处理"的提示词策略（03 的判断框架、手动整理路径、明月原话 E1 验收口径"全程无角色 turn 参与"下 tidy 的自主遍历）第一脚就踢空。

**N2. stub 节点渲染子树（替换早退）**。tools.ts:301 的 `if (node.is_stub) return text(...)` 改为类目渲染：

```
# [TEMP://self-reflection]（类目占位，无正文）
---
■ TEMP://self-reflection/2026-09-30-xxx: 草稿首行…
（depth/max_nodes 语义与普通节点一致；子孙遍历用 N4 的 stub-aware walker）
```

并补齐既有路径的记账：原早退发生在 auditRecall/collectSubtreeIds/touch 之前（recall 显式寻址不计账）；修复后 stub recall 走正常记账（显式寻址子树 = "想起"语义，与非 stub recall 一致）。`renderChildSubtree`/子代列表的 `!c.is_stub` 过滤（tools.ts:151、364）改为 walker 的 `includeStubs` 开关：**默认 false 保持既有渲染字节不变**（角色对非 stub 节点的 recall 输出不漂移，测试 diff-parity 不破），仅域根（N1）与 stub 类目（N2）两条路径开 true。

漏了会怎样：类目仍是黑洞，`TEMP://self-reflection/…` 下的 autoretain 草稿从任何 recall 路径都看不见——手动整理与角色自查照旧瘫痪，域根修了也只列到类目名一层。

**N3. `MEM://index/<domain>` 口径同步修**：stub 类目从"过滤掉"改为"列出并计子代"：`■ uri（类目，N 条）`，N = 直接非 stub 子代数（与 renderDiagnosticView 的 childCount 统计同法，memory-views.ts:197-200，单趟 listNodes 已在内存，无新查询）；N=0 的空类目仍显示（`（类目，空）`——空类目本身是"待回填占位"信号，diagnostic 视角 §"Placeholder" 已如此认定）。顶层非 stub 行为不变。

漏了会怎样：角色/tidy 用 index 做"库长什么样"的一屏总览时依旧看不到类目内部存量，域根深度遍历（depth:-1 代价高）与 index 轻量总览之间失去阶梯——修复只完成一半，"哪类目下压了多少草稿"仍不可知。

**N4.（支撑件）`renderChildSubtree` 增加 `includeStubs` 参数**（默认 false）：true 时子代过滤从 `!c.is_stub && …` 放宽为 `…`，stub 子代渲染为类目头 + 递归其子代。N1/N2 复用，既有调用点零改动。

**与导航修复的关系声明**：`{temp_list}` 直出**保留**（契约 §2.9 拍板）——修复保"库的基础导航能力"（手动整理、角色自查、任意 domain 通用），直出保"tidy 起手的确定性底册 + 覆写 taskPrompt 的 preset 作者在无修复语义引用下仍可用"。二者叠加：03 模板可引用 {temp_list} 直达，也可指示 tidy 用 `recall(uri="TEMP://", depth:-1)` 自主遍历验证快照陈旧部分。

### 3.5 {temp_list} 直出（§3.2 R4 细化，契约 §2.9）

```
L1. listActiveTempRows(store)：SQL `SELECT uri, source, content, world_ts FROM nodes
    WHERE uri LIKE 'TEMP://%' AND is_stub = 0 ORDER BY uri`
    —— 与 countActiveTempNodes 同一 WHERE（temp-notify.ts:32-33），重构为共享底层：
    countActiveTempNodes 改为 listActiveTempRows().filter(isVisible).length，计数口径永不漂移。
L2. 无可见性过滤（不传 isVisibleLocal）：tidyCtx 无会话（契约 §2.5），底册必须是全库口径；
    触发计数（会话视角）≤ 底册行数的刻意不对称在 §6 错误边界声明。
L3. 渲染：每行 `- {uri}（{source}）{首行 ≤80 字符}`；> 200 条截断加尾行。
    空清单 → 渲染 `（空）`（与 03 §2.1 措辞对齐；R2-F 中项消解）。
    渲染经 renderTidyTaskPrompt 函数式替换单点完成（§3.2 R4，J2）。
L4. 覆写 taskPrompt 不含 {temp_list} 时不强插（尊重 preset 作者意图，D3），audit 记
    temp_tidy_trigger.details.temp_list_in_task = false 留痕（§12 待拍板 8：是否升级为警告）。
```

---

## 4. 文件与副作用

| 文件 | 动作 | 副作用 |
|---|---|---|
| `packages/memory/src/temp-tidy.ts` | 新建 | 锁/解析/清单/runner/简报/失败通知；import pi-agent-core（依赖清单内，package.json:31 ^0.84.2） |
| `packages/memory/src/tidy-prompts.ts` | 新建 | **[修订 2026-09-30 J4]** 原 temp-tidy-prompts.ts 更名（03 定稿命名）；DEFAULT_TIDY_SYSTEM_PROMPT / DEFAULT_TIDY_TASK_TEMPLATE / renderTidyTaskPrompt（函数式变量渲染单点，J2）——文案归 03，本文只定常量壳与渲染函数 |
| `packages/memory/src/temp-notify.ts` | 修改 | 抽 `TEMP_TIDY_GUIDE_LINES` 共享常量；countActiveTempNodes 委托 listActiveTempRows |
| `packages/memory/src/module.ts` | 修改 | 638-648 触发分支树（639-642 re-arm 不动）；tidyAbort + dispose；host 接口 +getTempTidyPromptOverrides（02 实现引擎侧）；MemorySettings.temp.autoTidy 解析调用 |
| `packages/memory/src/config.ts` | 修改 | AutoTidySettings 类型（coding-agent settings-manager.ts:186 引用同型，自动透传） |
| `packages/memory/src/tools.ts` | 修改 | recall 域根分支（N1）、stub 渲染（N2）、renderChildSubtree includeStubs（N4）；新增只读 `MEM://audit[/<event>/<N>]` / `MEM://audit/id/<ID>` 系统视图入口并在工具说明公开语法 |
| `packages/memory/src/memory-views.ts` | 修改 | renderIndexView 类目计数（N3）；renderAuditView 完整渲染 details，读取不反写 audit |
| `packages/memory/src/store.ts` | 修改 | `logAudit` 返回可用的 `lastInsertRowid`；`listAudit` 支持 event / id 过滤 |
| `packages/memory/test/temp-tidy.test.ts` | 新建 | §9 |
| `packages/memory/test/module.test.ts` | 修改 | host mock 增 sideStreamFn/getTempTidyPromptOverrides/sendCustomMessage 捕获 |
| DB（运行时） | 写 | nodes/revisions/audit_log（tidy 工具经 store）、memory_kv 两 key、FTS 索引（节点写入自动）；**不写** raw_log、embeddings（tidyCtx 无 embeddings，语义检索降级 keyword——§12 待拍板 2）、web DTO、会话 transcript（简报条目除外，经引擎 sendMessage 落 custom_message） |

---

## 5. 落账与审计

| 事件（audit_log.event） | 时机 | 关键 details |
|---|---|---|
| `temp_tidy_trigger` | T5 抢到锁、runner 启动前 | `{ count, threshold, sessionId, temp_list_in_task }` |
| `temp_tidy_complete` | R8.d | `{ turns, briefingChars, beforeCount, afterCount, model: modelRef ?? "session-default", briefing: <全文> }` |
| `temp_tidy_failed` | R8.d | `{ reason, error?, beforeCount }` |
| `temp_tidy_crash` | void 管线防御性 .catch | `{ error }`（runTidy 理论上不 reject，此行是最后防线） |

- 整理动作本身经工具既有落账：节点 `model: "temp-tidy"`（tidyCtx.modelId，§2.5 冻结）→ audit `insert_node`/`update_node` 的 model 列与修订史 editor_model 天然可辨（契约 §2.5 拍板的审计标识）；`turn: undefined` → audit turn 列 null，与角色会话回合一目了然地区分。
- ~~已知观测噪声（02 实测指出，此处备案）：AgentEvent 快照里的 `model` 字段会显示 TIDY_MODEL_STUB 占位值~~ **[修订 2026-09-30 J7]** 该噪声已消除：sideStreamFn 返回 `{ streamFn, model }`，`config.model` 即 host 解析后的真模型，AgentEvent 快照 model 字段为真值；落账口径仍以 tidyCtx.modelId `"temp-tidy"` 为准（节点/audit/修订史），事件 model 字段仅供参考。
- 锁状态不逐次记 audit（持锁让路每轮一次会产生行洪水）；`readTidyLock` / last-finish kv 本身即观测面。
- 简报全文只在 audit；会话条目持截断版。截断尾注携带该次 `temp_tidy_complete` 的精确 `MEM://audit/id/<ID>`，角色 agent 可经公开 `recall` 工具取回全文；若 preset 覆写 tidy system prompt，能力仍由 recall 工具说明公开。

---

## 6. 错误边界

1. **`database is locked`**：锁操作经 busy_timeout=5000 排队（driver-node.ts:133）；仍抛出 = 瞬态冲突（web/routes.ts:139-146 先例）→ 锁操作内部重试 2 次 ×250ms [推断]，再失败按语义折算：acquire → 视同让路（静默 return，保持武装）；refresh → 本拍跳过（下拍再刷，僵死阈值 10 倍心跳，单拍失败无害）；release → 跳过（僵死回收兜底，§3.1 ③漏）。
2. **ISO 时间戳字典序比较**：锁的僵死判断 `heartbeatAt < cutoff` 依赖"全部写入方都是 `new Date().toISOString()`"（UTC 定宽毫秒）。外部脏数据（手工改 kv）可能导致永不僵死 → 永久让路。缓解：last-finish/冷却判断在读取时 `Number.isNaN(Date.parse(v))` 视为无标记；锁行脏数据靠 T4 让路 + 手工清理（audit 可见 trigger 从未成功）。已知接受。
3. **进程死亡**：锁悬空 → 5min 僵死回收（§2.4）；无孤儿定时器（timer 随进程亡）。
4. **runTidy 绝不 reject**：所有 throw 在内部分类为 outcome；void 管线再兜 .catch → audit `temp_tidy_crash`。
5. **触发计数与底册口径差**：触发计数带会话可见性过滤（module.ts:638 isVisibleLocal），{temp_list} 无过滤 → 底册可能多于计数（他库草稿/本会话隐藏草稿）。**刻意为之**（tidy 全库视角，契约 §2.5）：tidy 可能处置触发会话看不见的草稿，属功能（跨会话清洁工），不是 bug；03 文案的"清到零"以底册为准。
6. **stub 脏数据**：外部把 stub 行改出正文（绕过工具）→ N2 渲染按 `content 非空则附正文`容错（类目头 + 正文 + 子树）。
7. **浏览器构建安全**：temp-tidy.ts 不 import node: 专属模块；pid 读取 `typeof process !== "undefined" ? process.pid : 0`（同 driver 动态导入的加载边界纪律，driver-node.ts:15-21 注释）。
8. **onTurnEnd 内不得 await tidy**：T5 是 void——`handleAutoretainAndTemp` 被 `onTurnEnd` await（module.ts:773 `if (!disposed) await handleAutoretainAndTemp()`），await tidy 会阻塞回合收尾，违反 §5 硬约束 4。

---

## 7. 代码落点（精确到文件与函数）

| 落点 | 内容 |
|---|---|
| `temp-tidy.ts` 新文件 | §2 全部签名 + runTidy（R1-R9）+ parseAutoTidySettings + listActiveTempRows/renderTempList + extractBriefing（E1-E5 纯函数，便于单测）+ truncateBriefing + buildTidyFailureContent（**[修订 2026-09-30 J7]** TIDY_MODEL_STUB 已废除——model 由 host 返回） |
| `tidy-prompts.ts` 新文件 | 两默认常量 + renderTidyTaskPrompt（**[修订 2026-09-30 J4/J2]**，03 文案回填） |
| `module.ts:638-648` | `handleAutoretainAndTemp` 尾部分支树（T1-T5）；639-642 不动 |
| `module.ts:294` 附近 | `const autoTidy = parseAutoTidySettings(settings.temp?.autoTidy)` |
| `module.ts:317` 附近 | `let tempNotified` 注释更新为"本积压代已归属"语义 |
| `module.ts` dispose（:781-783，**[修订 2026-09-30 J10]** 原 :778-781） | + `tidyAbort.abort()`（const tidyAbort = new AbortController() 与 autoretainAbort 同型，:325 先例，**[J10]** 原 :336） |
| `module.ts` MemoryModuleHost（:97-135 区域） | + `getTempTidyPromptOverrides(): { systemPrompt?: string; taskPrompt?: string }`（02 冻结接口，01 只声明消费）；`sendCustomMessage` 二参由 02 扩展，01 按 `(msg, options?)` 调用 |
| `temp-notify.ts:31-37, 40-54` | listActiveTempRows 抽取 + GUIDE 常量共享 |
| `tools.ts:~240` 后 | 域根分支（N1；**[J10]** 原 :247）；`tools.ts:301` 早退替换（N2）；`tools.ts:151/364` walker 开关（N4） |
| `memory-views.ts:168-180` | renderIndexView 类目计数（N3） |
| `config.ts` MemorySettings | temp.autoTidy 类型 |

---

## 8. 与现状差异

| 维度 | 现状 | 之后 |
|---|---|---|
| 阈值命中行为 | 必发手动 rp-notify（module.ts:643-647） | 分支树：tidy 优先，通知降级为兜底（D1/E9） |
| `tempNotified` 含义 | "已发通知" | "本积压代已归属"（回旋条件不变） |
| MemoryModuleHost | 无 sideStreamFn / 单参 sendCustomMessage / 无 getTempTidyPromptOverrides | +三原语（02 实现；本文消费） |
| memory_kv | world clock + awaken_uris + 模式标记 | + `temp-tidy-lock`、`temp-tidy-last-finish` |
| 导航语义 | 域根不可寻址、stub 黑洞、index 跳过类目 | 域根虚拟视图、stub 类目渲染子树、index 计子代（全 domain 通用） |
| 不变项 | 阈值默认/口径（temp-notify.ts:13,58-72）、rp-notify policy（module.ts:704-707）、12 工具集、slots、web DTO（§4.3）、非 stub recall 的渲染字节（N4 默认 false 保证） | 同左 |

---

## 9. 验收测试（包内；vitest + node:sqlite `:memory:`/临时文件，沿 module.test.ts:22-32 惯例）

**9.1 LLM mock 方案（必答 5）——StreamFn 注入点即 seam**：
测试不经 host 真实 side 通道，直接构造 scriptable `StreamFn`（类型 = pi-agent-core re-export 的 `StreamFn`）：

```ts
import { createAssistantMessageEventStream, type StreamFn } from "@earendil-works/pi-agent-core";
function scriptedLLM(steps: AssistantMessage[], calls: CtxCapture[]): StreamFn {
  return (model, context, options) => {
    calls.push({ model, context, options });            // 断言面：systemPrompt / tools / 首参被忽略
    const s = createAssistantMessageEventStream();
    const msg = steps.shift();
    queueMicrotask(() => { s.push({ type: "start", partial: msg! }); s.push({ type: "done" }); s.end(msg); });
    return s;   // 事件协议精确实操自 agent-loop.ts:333-378 的消费端：start 用 event.partial，done 后 result()
  };
}
```

工具面两档：a) stub AgentTool 记录调用序列（管线逻辑测试）；b) 真 12 工具 + `:memory:` store（adapter/落账/锚语义集成测试）。

**9.2 用例清单**：

| 组 | 用例 | 断言核心 |
|---|---|---|
| 互斥 | 空库抢锁/重复抢锁/释放后再抢 | changes 语义：第二把 null |
| 互斥 | 僵死回收 | 直写 kv 把 heartbeatAt 回拨 6min → 抢锁成功 |
| 互斥 | owner 不匹配 | 他人 refresh/release 均 no-op（changes 0 / 行仍在） |
| 互斥 | 双连接文件库并发 | 两个 openDatabase(same file)（WAL）一胜一负 |
| runner | happy path（script: toolCall(memo​rize) → toolCall(forget) → 纯文本简报） | completed；briefing 精确；真工具落节点 model="temp-tidy"、audit 完整；锁释放；last-finish 写入；sendCustomMessage 收 `{triggerTurn:false}` |
| runner | maxTurns=1 + 首 turn 带工具 | failed("max-turns")；**capped 优先于文本判定**（script 末条带文本仍 failed）；兜底通知发出；锁释放 |
| runner | timeoutMs=50 + 永不完成的流 | failed("timeout")；定时器清理（无悬挂 handle）；通知发出 |
| runner | parentSignal 预先 abort / 中途 abort | failed("aborted-dispose")；**无通知**；锁释放；不写 last-finish |
| runner | 空简报（末条 text:""） | failed("empty-briefing")（**不回看**：前条 assistant 有叙述文本也不采纳）；通知含 empty-briefing |
| runner | sideStreamFn reject | failed("no-model")；通知发出；锁释放 |
| runner | 简报 600 字 + 含 emoji | 投递正文 ≤500 码点、emoji 不劈半；尾注含该次完成记录的精确 `MEM://audit/id/<ID>`，把 URI 交给公开 recall 后取回完整简报 |
| runner | lock-lost | 预置他人锁后强制 refresh 失败路径 → failed("lock-lost") |
| runner | {temp_list} | 捕获的 context.messages[0] 含渲染清单；模板无变量不 crash；>200 条截断尾行 |
| 触发 | 默认 enabled（seed 到阈值） | 走 tidy：锁 kv 出现、runner 启动、tempNotified=true；次轮 onTurnEnd 不重触发 |
| 触发 | enabled:false | 现状手动通知原样（回归锚） |
| 触发 | 锁被他人持（预置新鲜锁） | 静默、tempNotified 仍 false、下轮重试 |
| 触发 | last-finish 新鲜 | 静默 + tempNotified=true |
| 触发 | tidy 完成清零 / 未清零 | re-arm / 维持抑制（①分支双向） |
| 触发 | runner 失败 | 兜底通知（kind:"temp-tidy-failure"） |
| 触发 | 配置容错 | maxTurns:-5→30、model:42→undefined、enabled:0→true |
| 导航 N1 | recall("TEMP://") | 列顶层（含类目）；depth:-1 全底册；audit view:"domain"；**不触 access time** |
| 导航 N2 | recall("TEMP://self-reflection") | 类目头 + 子草稿渲染（替换早退）；记账恢复 |
| 导航 N3 | MEM://index/TEMP | 类目行 `（类目，N 条）`；非 stub 顶层行为不变 |
| 导航 N4 | 既有非 stub recall 输出 | **字节级不变**（includeStubs 默认 false 回归锚） |
| 落账 | audit 序列 | trigger→工具动作(model=temp-tidy,turn=null)→complete/failed 全链 |

---

## 10. 需求对照（00 §1 原话 + 效果/决策逐条）

| # | 原话/决策依据 | 本文落点 |
|---|---|---|
| E1 | 消息 1"加入自动整理的选项…另起一个 agent" | §3.1 T4/T5：阈值命中即后台起 tidy，角色零动作 |
| E2 | "最好是异步…不打断、不污染" | §3.1 T5 void fire-and-forget（同 agent-session.ts:1191 模式）；§6.8 不阻塞 onTurnEnd；E2 零污染 = tidy 对话只在 runner 内存 AgentContext，不落 transcript/raw_log（§4 副作用表"不写"列），角色侧唯一增量 = 简报条目（D9 不唤醒） |
| E3 | "角色 agent 无记忆工具（纯只读）的场景也能完成" | tidy 工具独立实例 `createMemoryTools(store, tidyCtx)`（§3.2 R5），不经 synthetic extension / host.getSessionInfo（契约 §2.5）；触发挂 module 写入路径而非工具存在性 |
| E4 | "tidy agent 自己写简报…作为简报"（消息 5） | §3.3 提取 = D4 最终 assistant 文本；投递 triggerTurn:false 下 turn 自然可见 |
| E5 | "preset 中给一个字段…允许改给 tidy agent 的提示词…甚至不清空"（消息 3） | §3.1 T3 消费 02 冻结的 getTempTidyPromptOverrides + 字段级默认合并；①分支保证不清空型使命不死循环 |
| E6 | "自动优先，失败兜底"（消息 2） | §3.1 T1（禁用）、§3.4 R9（失败通知）；③分支 + 锁 finally 释放 |
| E7 | "简报不要过渡性语言…保持直接"（消息 8） | 文案归 03（D6 外包）；本文保障机制侧：empty-briefing 判失败不姑息（§3.3 E5），风格违规可经 audit briefing 字段审计 |
| E8 | "不要想当然以为 TEMP 里只有 self-reflection…什么都有"（消息 8） | §3.5 底册无内容类型假设、全库口径；§3.4 导航修复保证任意类目/任意深度的草稿可见 |
| E9 | "加入自动整理的选项…可关"（消息 1） | §2.3 enabled 缺省 true 但可关；T1 关闭路径 = 现状行为逐字节保留 |
| D1 | 失败/禁用/未配置 → 手动通知 | T1/R9 + buildTidyFailureContent |
| D2 | 全套 12 工具 | §3.2 R5 全量 adapter，无白名单 |
| D3 | 类比 compaction 的覆写 + 自定义使命 | T3 消费 02 冻结字段切分；①分支语义配套 |
| D4 | 简报 = 最终回复文本，非引擎拼模板 | §3.3（引擎只做提取/截断，不生成内容） |
| D5 | 默认开 + 主模型 + 沿用 temp.threshold | §2.3/§2.4（enabled true、modelRef undefined → host 解析主模型、阈值不动） |
| D6 | 提示词外包 | 文案全部指向 03；本文只定常量壳与注入机制 |
| D7/D8 | 简报风格禁令 / 通用缓冲区 | 机制侧配套见 E7/E8 行；文案责任在 03 |
| D9 | triggerTurn:false | §3.2 R9、§3.1 ③（失败通知保留 true 的对照声明） |
| D10 | TidyRunner 载体 | 全文；否决依据（runSubagent 双重污染）引用契约 §1 D10 |
| §2.9 修订 v2 | 明月："肯定是想办法补，这个是严重 bug" | §3.4 N1-N4 全库通用修复 + {temp_list} 保留双轨 |

---

## 11. 发现的冲突（申报主代理裁决，未私自偏离）

1. **契约 §3 可见性证据行指向不存在的文件**：`visibility.ts:51-52 / :78` 在 memory 包内仅有 `src/web/visibility.ts`（web DTO 用），所述"无锚 auto hidden / foreign 过滤"的真实实现与行号是 **module.ts:358-372 `recomputeAnchorVisibility`**（无锚且 source==="auto" → hidden，:364-365；foreign 仅锚定且 anchor_session_id ≠ 当前会话时跳过不 hidden，:367-368）。内容正确，出处漂移，建议契约回写。
2. **契约 §3/§4.0 的 tools.ts:311 现为 tools.ts:301**（stub 早退；行号漂移，语义一致）。
3. **契约 §2.1 "maxTurns: agentLoop 轮数上限"易误读为引擎原生能力**：agentLoop 无内置 maxTurns（grep `packages/agent/src` 零命中，已核查）；本文以 `shouldStopAfterTurn` 计数实现（§3.2 R6）。schema 字段本身不动，仅澄清实现 seam。
4. **新增 kv key `temp-tidy-last-finish` 不在契约 §2.7 冻结形状内**：§2.7 只冻结锁 key/值。该 key 是冷却机制的实现细节（§2.4 表已申报），判定契约未禁止辅助 key，但按申报纪律列此备案。
5. **module.ts:643-647 锚点实际分支块为 638-648**（639-642 为 re-arm 子句，改造中显式保留不动），引用时以 638-648 为准。
6. > [修订 2026-09-30 J6] 本文 T4 从契约 §2.7（抢锁失败静默）；契约 §2.8 旧文"抢锁失败走手动通知"与 §2.7 矛盾，已由主代理裁决 §2.8 修订 v2 三分支（未启用→通知/抢锁失败→静默/执行失败→通知），本文原选择正确，备案结案。
7. > [修订 2026-09-30 J5] promptGuidelines 剥离后，tidy 的 disclosure 纪律由 03 默认 system 文案承载——若 03 覆盖不足，模型可能漏读"想起条件"（03 修订同步，见其 §3.3）。
8. > [修订 2026-09-30 J10/R1-V-6] E9 正交性申报：导航缺陷修复（N1-N4）作用于 enabled=false 时同样生效（修复是库能力，不挂 autoTidy 开关）——不违反 E9：该修复系明月亲拍必修 bug（契约 §2.9 v2），E9 口径为"autoTidy 行为"与现状一致，库导航修复属独立交付。

## 12. 仍未知待拍板

1. **跨会话失败告知缺口**（§3.1 消歧）：是否给锁行加 tombstone（finishedAt）让让路会话可感知"上一手失败了"并补发通知？现按契约 §2.7 静默 + 自愈（下轮接管）收尾；tombstone 会扩契约值形状，需主代理裁决。
2. **tidyCtx.embeddings**：现按契约 §2.5 四字段**不传**（语义检索降级 keyword）。若 tidy 的 consolidate 归位命中率实测偏低，可改传 module 的 EmbeddingClient 共享实例（一份缓存/熔断，module.ts:689-690 先例）——代价是 tidy 可能触发 embedding API 调用。
3. **TIDY_RETRY_COOLDOWN_MS=5min 与"锁代际"取值**（§2.4 [推断]）：可调；若多会话实测仍空转，升到与 heartbeat 整数倍对齐或改由 settings 暴露。
4. **抢锁让路是否留一行 audit**：现为零行（锁 kv 本身即观测面）；若运维需要"谁让路过"，加 `temp_tidy_yield` 低频采样行。
5. **域根 URI 语法边界**：`TEMP://`（尾斜杠）已覆盖；是否同时接受 `TEMP:`（无斜杠）等宽进写法——现只收 `scheme://` 精确形态，宽进会与普通寻址歧义。
6. **TIDY_TEMP_LIST_MAX_ENTRIES=200**（§2.4 [推断]）：极端积压场景的模板体积上限，可调。
7. **`enabled: 0` 类笔误落 true**（§2.3 表）：字段级忽略纪律的既定代价；如需更严（非 boolean 一律按 false 安全侧解释）需推翻"缺省 true"的字段级容错口径，请主代理裁决。
8. **覆写 taskPrompt 缺 {temp_list} 是否升级为显式警告**：现仅 audit 留痕（§3.5 L4）。
9. **§4.0 既有问题 1（consolidate 只盖 anchor_entry_id 不盖 anchor_session_id）**：tidyCtx 两者皆 null 不受影响（契约已判不在必需范围）；本文仅登记认领，不顺手修。
