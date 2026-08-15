# Affiliated Session（共生会话）设计

> 状态：设计草案，待审（未动源码）
> 关联：[state-updater-extension-findings.md](./state-updater-extension-findings.md)（扩展优先实测的 6 项发现）、[watchdog-system.md](./watchdog-system.md)（背景 side-request 计划）、[watchdog-feasibility-analysis.md](./watchdog-feasibility-analysis.md)（§3.1 网关路径、§4.1 autoActivate）、[multi-agent-infrastructure.md](./multi-agent-infrastructure.md) Step 5
> 创建：2026-08-11
> 核对基准：pi-rp 当前 working tree（`prepare.ts` / `run.ts` / `rpc-types.ts` / `agent-session.ts` 均已核对）

## 0. 结论速览

三个消费者（state-updater、角色进程、未来的 watchdog）缺的是同一个原语：**与父会话共生的子会话**。把它定义为一等概念，三个能力正交：

1. **A 出生继承**：出生时继承父会话上下文（历史切片 / state 快照 / 工具 / 模型 / **边界声明**）。
2. **B 活体读取**：运行中能读父会话**当前**的历史和 state（不是出生快照）。
3. **C 写回可控**：子会话的写入是"提议"（scratch），父进程 commit 或回滚。

**一个协议、两个 transport**：subagent 引擎（in-process）与 RPC 子进程共享同一套 option 形状（`{inherit, live, scratch}`），消费者写一次两边都能跑。in-process 零序列化、共享父 gateway、同生共死；RPC 隔离、独立 gateway、每次共享过序列化线。**角色要隔离+持久，更新器要便宜——各得其所，不选边站。**

**scene_brief 从"策展摘要"改为"共创边界"**：承认角色无法被严格隔离，继承时给"粗过滤上下文 + forbidden knowledge 约束"——角色被告知看了这段 context 后哪些是它不该知道的，**主动过滤**（§3）。

明确不做（留给扩展）：addEntry 注入、commit 决策、剧透策展规则。pi-rp 只做机制，默认全拒绝。

## 1. 动机：三座桥 vs 一个原语

### 1.1 现状证据

| 消费者 | 今天怎么做 | 痛点 |
|---|---|---|
| 角色进程 | handoff.ts 手推三座桥：`syncWorldStateToCharacter`（world 下发）、`syncCharacterStateToWriter`（领地回传）、scene_brief（场景策展） | 每次递话筒都要重新序列化上下文；state 同步是手工 get/update 舞步 |
| state-updater | 角色实例**磁盘解析**作家 session 文件（`parseSessionEntries` + 手写最新-文件选取） | 耦合 session 文件格式；拿不到作家**当前**内存态 |
| watchdog（未来） | 无 | 需要同样的"读父会话 + 写回" |

### 1.2 已存在的半成品

- **subagent 引擎**已有继承机制：`prepare.ts:145-150`（inheritHistory 切片）、`prepare.ts:155`（`options.session.stateManager.snapshot()` 播种父 state）、`run.ts:38`（`SessionManager.inMemory`，无磁盘）。但：read-only（`extension.ts:83` 描述原文）、仅 LLM 工具可触发、跑完即弃、写不落父进程。
- **RPC**已有：`get_state`/`update_state`（`rpc-types.ts:29-30`，含 `stateRevision` 乐观并发 `rpc-types.ts:111`）、`get_messages`、fork/clone（`rpc-types.ts:39-44`）、`--no-session` 临时模式（`cli/args.ts:112`）。但：严格 parent→child 单向，**无反向 pull、无出生继承**。

## 2. 核心抽象

### 2.1 能力定义

| 能力 | 语义 | 现有基础 | 缺口 |
|---|---|---|---|
| **A 出生继承** | 出生时继承历史切片 / state 命名空间子集 / 工具 / 模型 / 边界声明 | subagent 已有（`prepare.ts:145-155`）；RPC 无 | RPC 缺 `init_context`；两边都缺 namespace/可见性过滤与 forbidden 声明 |
| **B 活体读取** | 运行中读父会话当前历史 + state | 无 | in-process 直接引用（近乎免费）；RPC 缺 `context_request/response` |
| **C 写回可控** | 写 = 提议（scratch），父进程 commit / 回滚 | RPC 天然满足（child 写自己 state，父 pull=commit，不 pull=回滚——handoff 已这么干） | in-process 缺 scratch 层 |

### 2.2 统一的 affiliate 声明（扩展提供，spawn 时传入）

```jsonc
{
  "inherit": {
    "history": { "count": 24, "filter": "narrative" },   // 粗过滤：只透 user + 最终叙事文本
    "state": ["world", "zhouqiluo"],                     // 命名空间白名单
    "forbidden": [                                       // 边界声明（§3 共创）
      "secret 暗线的存在与内容",
      "其他角色的领地数值",
      "作家对未来的规划"
    ]
  },
  "write": { "namespaces": ["zhouqiluo"] },              // 写回白名单；缺省 = 全拒绝
  "scratch": true                                        // 写回走 scratch，父进程显式 commit
}
```

### 2.3 协议增量（RPC transport）

```
parent→child  init_context {history, state}                // spawn 后、首次 prompt 前；不用 CLI flags（历史可能很大）
child→parent  context_request {requestId, since?, namespaces?}   // 走现有 stdout 事件通道
parent→child  context_response {requestId, messages?, state?, error?}  // 走现有 stdin 命令通道；与其他命令一样回 success ack
```

`context_response` 的数据由父进程扩展提供过滤（RpcClient 暴露钩子）；pi-rp 侧只做路由，不定义过滤规则。

**实现偏差（2026-08-15，commit 7ab3e793f 已落地，本节为对齐后的形状）**：

- `init_context` 省略 `forbidden`——约束已沉预设层（§7-3 探针 D 组结论：手写约束可退役，角色预设信息边界规则 + scene_brief + 通用约束足够）；
- `context_request` 省略 `what`——方向策略（原样全分支 vs 过滤切片）由父扩展按请求自决，第二个消费方出现前不加线；
- `context_response` 的 `history` 改名 `messages`、新增 `error`（父侧无法提供时的快速失败通道，子进程侧立即 reject 而非等超时）；
- 回包语义：context_response 与所有命令一致回 `{id, type:"response", command:"context_response", success:true}` ack——父侧 `send()` 依赖它 resolve，不回会让每次活体读取在父进程挂满 30s 超时。

**init_context 的 ephemeral 契约（接线消费方前必须记录）**：继承的历史只进子进程 `agent.state.messages`，**不写 session 文件**（刻意如此，避免污染子进程持久记忆）；子进程压缩 / 回滚 / 条目编辑会从 session 条目重建 messages（`_syncAgentStateFromSession`），继承内容随之蒸发。需要持久继承时由消费方把继承内容落成 session 条目，或按 §5 的「持久的记忆走播种」路径处理。

## 3. scene_brief 的"共创"改造（继承策略层）

### 3.1 现状的两难（用户原话要点）

scene_brief 是角色唯一的 context 来源，但它是**点估计**——对"角色该知道什么"的一次性猜测：
1. 写太详细 → 泄露角色不该知道的（secret 暗线、作家规划）。
2. 写太少 → 角色缺上下文，行动不连贯。

策展的每一点误差都是硬错误：漏了 → 角色断片；多了 → 泄露。

### 3.2 共创模型：边界声明替代内容策展

承认角色不可能被严格隔离（作家历史里总有暗示、语境、无意识的痕迹），**放弃"控制角色看到了什么"，改为"控制角色把什么当作已知"**：

- 继承给**粗过滤**的部分真实上下文（只剥掉工具调用/思考/secret 原文，不做语义策展）；
- 同时下发 **forbidden knowledge 约束**：明确列出"看完这段 context 后，以下内容你应视为不知道"；
- 角色**主动过滤**——把"角色不知道 X"从外部强制的状态，变成角色自身维持的行为契约。

这是把 referee 的 need-to-know 哲学反转应用到角色侧：referee 是全知者按需回答（**上行隔离**：输出受限）；角色是半知者自我设限（**下行隔离**：输入部分可见、认知受限）。两种哲学并存，各自适用。

### 3.3 为什么可行（与点估计的对比）

| | 策展摘要（现状） | 粗过滤 + 边界声明（共创） |
|---|---|---|
| 传递的是 | 事实的点估计 | 边界（约束）本身 |
| 误差形态 | 硬错误（漏/多） | 角色"假装不知道"——LLM 对显式命名的"你不该知道 X"有良好的角色扮演支持 |
| 失败代价 | 泄露或断片，无中间态 | 有界：角色偶发越界 → 行为异常，作家续写可纠正 |

### 3.4 风险与缓解

1. **自过滤是概率性的**（模型偶尔会忍不住用 forbidden 知识）。缓解：作家是叙事最后一道门（作家续写收尾、可无视/纠正角色越界）；display 层剥 XML（已有）。**越界的代价有界**：是角色行为怪异，不是硬信息泄露给玩家——作家控制最终叙事。
2. **secret namespace 仍不能原样下发**：角色连"存在"都不该确定知道的东西，不进粗过滤后的历史。粗过滤兜底仍在，只是从"语义策展"降级为"机械剥离"。
3. **边界声明本身可能被角色反过来利用**（"我知道我不知道 X"）。缓解：声明以约束形式给（行为契约），不给"秘密清单"的完整内容——只给类别（"暗线的存在"），不给条目。

### 3.5 落地形态

- forbidden 约束随 `init_context`/in-process 继承下发，渲染为继承上下文末尾的一个 slot（如 `<unseen_knowledge>`），由 preset 引用（与 slot 系统一致，`ip-context.ts` 已注册 slot）。
- 角色 preset 需一条硬规则（writer.json 咨询规则的镜像）："凡 `<unseen_knowledge>` 列出的内容，视同不存在；既不引用、也不暗示、更不追问。"

## 4. 实现落点与成本估算

| 步骤 | 改动 | 位置 | 成本 |
|---|---|---|---|
| 1. in-process spawn + scratch | 程序化 spawn（复用 runSubagent 引擎）+ StateManager scratch 层（包装记 diff，run 后 merge/discard） | `core/subagent/run.ts`、`state/state-manager.ts` | ~100-150 行 |
| 2. RPC `init_context` | 新命令 + spawn 后引导（含 forbidden 声明透传） | `modes/rpc/rpc-types.ts`、`rpc-mode.ts`、`rpc-client.ts` | ~60-100 行 |
| 3. RPC `context_request/response` | child→parent 请求事件 + parent 应答命令 + RpcClient 钩子 | 同上 | ~100-150 行 |
| 4. （远期）steering/events | 长驻 observer 的中途转向与事件流（watchdog 需要时再做） | subagent 引擎 | 另估 |

## 5. 权威模型与回滚

- **namespace 归属不变**：world 唯一事实源 = 作家进程，领地唯一事实源 = 角色进程（机制文档既有约定）。policy 由父扩展在 spawn 时声明，pi-rp 默认全拒绝。
- **领地更新器必须留在角色进程**（非 writer-hosted）：若作家侧更新角色领地，下一次 `syncCharacterStateToWriter` pull-back 会用角色进程的旧领地覆盖新 patch（clobber）。角色进程是领地权威，所以角色侧更新器需要 B（活体读取作家）——**这决定了 B 是 load-bearing 而非 nice-to-have**。
- **回滚内建**：写是提议 → commit 决策自带回滚；显式回滚 = 恢复 checkpoint 快照（state 引擎 snapshot/apply 已有）+ session fork（`rpc-types.ts:39-44` 已有）。

## 6. 明确不做（边界）

| 不做 | 理由 | 归属 |
|---|---|---|
| addEntry 反向注入 | `pi.appendEntry` 已有，子进程结果由父扩展注入 | 扩展 |
| commit 决策 / 过滤策略 | 游戏权威模型（world=作家、领地=角色）是领域知识 | 扩展（affiliate 声明） |
| 剧透策展规则 | 共创模型下策展退化为机械粗过滤 + 边界声明 | 扩展 filter |

## 7. 待审问题

1. **forbidden 约束的渲染形态**：独立 slot（`<unseen_knowledge>`）还是系统层注入？给类别还是给条目（§3.4-3）？
2. **粗过滤粒度**：按消息类型（user / 最终 assistant 叙事 / tool / thinking）机械剥离够不够，还是需要内容级过滤？
3. **自过滤失败率可度量性**：✅ 已实测（2026-08-11，`/tmp/leak-probe.mjs`，threelies 存档真实案件，gemini-3-flash-preview，A/B/C × 3 输入 = 9 次调用）。**结论：共创模型方向可行、约束强度不足。**
   - 约束能压住**直接对线**：B（泄露+约束）全程没有否认"陈默说我在公司"；C（裸泄露）被问"陈默这人怎么样"时直接说"他说我当时在公司？建议先带他去做眼科检查"。
   - 约束压不住**事实吸收**：B/诱饵在问题不含任何线索时说出"被林正坤压榨了六年"（对照组 A 同问题只说"唯唯诺诺"）；"六年压榨"在 B 的 opening 和 bait 两次穿透。
   - 泄露形态是认知层而非引用层：模型把泄露事实当作自己的既有常识使用，不引用原文——比引用更难被作家察觉。
   - 正面：三组全部守住领地 truth（当晚去过现场 22:15-22:35 无一泄露），领地保护本身稳健。
   - 含义：被动忽略式约束（"你绝对没看见"）对显式条目有效、对隐性吸收无效；真实场景若只给类别级边界声明会更难防。**需要粗过滤兜底 + 作家终审**（越界形态是"显得知道太多"，作家可察觉纠正），或试验更强的主动否认式约束。
   - **跟进（同日）**：按"约束进预设层"的方向，把「信息边界」规则写进了两个 IP 的 `character.json` 骨架 + 全部 7 个角色预设（threelies 规则 2 / lianyu 规则 3 原位扩展，骨架新增规则 5）：①领地 truth/secret 是底线，无论对方看起来知道什么不松口；②信息来源只有领地/场景简述/亲身经历的世界常识；③玩家与他人的对话内容视作不存在——不引用、不复述、不对线；④拿不准时选择不知道。**复测（D 组：预设规则 + 裸泄露，无手写约束）**：行为 ≈ 手写约束且优于裸泄露——无任何具体指控对线（C 的"他说我当时在公司"消失），"六年"等世界常识仍整合（判定为合理），alibi 全守住。手写约束可退役，作家 handoff 不再需要写保密措辞。
4. **B 的触发时机**：角色侧更新器在 `agent_end` 反向 pull 作家（含未落盘的最新回合），与作家磁盘 session 的时序竞态如何处理（建议：pull 内存态优先，磁盘兜底）？
5. **in-process scratch 的粒度**：按"一次 run 一个 checkpoint"还是按 tool 调用逐个 diff？前者简单、回滚粗；后者细但成本高。

## 8. 建议的推进顺序

1. 先做 §7-3 的泄露探针（成本最低、能证伪共创模型的可行性）——若自过滤在真实模型上失败率不可接受，§3 需回炉。
2. 步骤 1（in-process spawn + scratch）→ 作家侧更新器重写（删 parse/translate/apply 管线）。
3. 步骤 2/3（RPC init_context + context_request）→ 角色侧更新器去磁盘解析 + scene_brief 共创化试点（单个角色）。
4. watchdog 落地时复用同一协议，补步骤 4。
