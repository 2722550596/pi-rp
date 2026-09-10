# @earendil-works/pi-memory — pi-rp 记忆系统

> 面向使用者与下游集成者的系统介绍。设计规格见根目录 [`docs/memory-system.md`](../../docs/memory-system.md)(v5.1),本文档描述实现行为,不重复设计论证。

## 1. 这是什么

pi-rp 的记忆系统,作为独立的 workspace 包落地。一套 SQLite 库承载角色/作家的全部记忆:

- **一棵树**(nodes),树根即 domain(`core` / `history` / `meta` / `TEMP` 等,除 `TEMP://` 外名字纯约定)。
- **一份原文日志**(raw_log),逐消息 append-only 镜像,是"场景记忆"的原文底稿。
- **一套工具**(12 个)与 **三个 prompt slot**(awaken / recent / index),外加召回注入、回滚联动、autoretain、TEMP 动态区等引擎内建能力。

它取代了 nocturne 的 Python 服务与胶水扩展:本仓不主动退役胶水扩展,退役与否由下游消费者决定;功能上 pi-memory 已对等并内建到引擎。

**开箱即用**:接入 coding-agent 后零配置即可用,默认库在 `<cwd>/.pi/memory.db`。

## 2. 快速开始

### 2.1 让 agent 记住并想起

```text
你:请记住:伊莱在酒馆遇到薇拉,谈及北方的商队。
agent:已记住。(memorize core://scenes/tavern 或 history://scenes/tavern)

你:伊莱之前在酒馆里遇到谁?
agent:(召回注入自动带上该节点;必要时可主动 recall)
```

记忆工具由模型按需调用,引擎在每次对话前自动召回相关内容注入上下文(见 §7)。

### 2.2 指定库位置

```bash
# CLI flag(最高优先级)
pi --memory-db ./world/magnolia/memory.db

# 或 settings 文件
# settings.json:
# { "memory": { "dbPath": "./world/magnolia/memory.db" } }
```

解析链:`--memory-db`(CLI,经 `PI_MEMORY_DB` env 传入)> settings `memory.dbPath` > prompt preset 声明 > 默认 `<cwd>/.pi/memory.db`。

### 2.3 在 TUI 里看库

```text
/memories               # 概览:世界时间、节点数、TEMP 数、领域列表
/memories stat          # 同上
/memories history://scenes/tavern   # 单节点全文 + 子节点
/memories search 商队   # 关键词搜索
/memories temp          # TEMP 暂存区内容 + 清理提醒
```

## 3. 架构:两层 API

```
┌────────────────────────────────────────────────┐
│  coding-agent (AgentSession)                    │
│   ├─ createMemoryModule(store)  ← 会话绑定层     │
│   │   注册 12 工具 / 3 slot / customType / 钩子   │
│   │   召回注入、回滚联动、raw_log、autoretain、TEMP │
│   └─ MemoryStore               ← 纯库层(无 pi 依赖)│
│       graph CRUD / alias / kv / 世界钟 / 快照      │
└────────────────────────────────────────────────┘
```

- **`MemoryStore`**:纯库层,只依赖 `node:sqlite`。外部消费者(worldlines 这类不走 agent 管线的项目)直接以 TS 依赖引用它做读写,不需要 pi 运行时。
- **`createMemoryModule(store, { settings? })`**:会话绑定层,签名:

```ts
export interface MemoryModule {
  registerSession(host: MemoryModuleHost): void; // 工具/slot/customType/钩子
  onLeafChange(): Promise<void>;                 // 回滚联动 + raw 镜像对账
  onTurnEnd(): Promise<void>;                    // raw_log 写入 + autoretain + TEMP
  dispose(): void;                               // 取消在飞召回/side 请求(v5.5)
}
```

宿主(`MemoryModuleHost`)由引擎实现,包含 `registerTool` / `registerSlot` / `registerCustomType` / `sendCustomMessage` / `getSessionInfo`(id/turn) / `getBranchSnapshot` / `getTurnMessages` / `getActiveBranchMessages` / `completeSideRequest` 等 9 个方法;记忆包零依赖 coding-agent,类型是结构镜像。

### 驱动与依赖

- SQLite:`node:sqlite` `DatabaseSync`,包内 **唯一** 一处 `await import("node:sqlite")` 在 `openDatabase()`,失败 throw 明确错误。Bun 编译产物若运行时不支持,有单点后备口(默认不写)。
- CJK 分词:`@node-rs/jieba@2.0.2`(optionalDependencies 平台二进制),仅用于 FTS 写侧分词。

## 4. 数据模型

库内全部表(`packages/memory/src/schema.ts`,全新 schema,无兼容/迁移代码):

| 表 | 职责 |
|---|---|
| `nodes` | 记忆树。`node_id` PK、`parent_id`、`domain`、`uri`(唯一)、`content`、`disclosure`(想起条件)、`importance`(0–10,数值越大越重要,单列)、`source`(auto/manual/import)、`model`、`anchor_entry_id`、`anchor_session_id`、`first_raw_id`/`last_raw_id`(原文区间)、`last_accessed_at`(主动想起时间)、`created_at`/`world_ts`/`updated_ts`、`content_hash`、`is_stub` |
| `node_revisions` | 修订制:`(node_id, version)` PK,逐行带 `uri`。编辑时旧版归档于此,现行版在 nodes;`restoreRevision` 指定版本回滚;删除后经 `restoreDeleted` 按原 node_id 找回 |
| `edges` | 联想图(associate `related_uri` 建立),显式 retrieve 一跳扩散 |
| `aliases` | 别名寻址:rename/relocate 后旧地址转 alias,已有引用不破链 |
| `raw_log` | 原文日志:每消息一行,`raw_id` 全库自增、`session_id`、`role`、`text`、`entry_id`、`wall_ts`(entry 原始时间)、`world_ts`、`active`(活动路径标记);`(session_id, entry_id)` 唯一 |
| `node_fts` / `raw_fts` | FTS5(unified token 文本 + 稳定 ID 回表过滤);召回候选与 retrace query 的真实读端;只收 `is_stub=0` 行 |
| `autoretain_progress` | autoretain 逐任务消费进度 `(session_id, task, entry_id)` |
| `memory_embeddings` | 向量缓存表(树节点分片,存 content_hash + model,任一失配即失效重算);API 模式 |
| `glossary` | 专名表(trigger 工具维护),专名 → 节点;完整专名参与索引与检索 |
| `memory_kv` | 键值:世界钟(`world_time`)、awaken_uris 等 |
| `audit_log` | append-only 审计流(node_id/source/model/turn/task/anchor/details),见 §15 |

关键概念:

- **`is_stub`**:memorize 自动补占位的父链节点标记为 1(空正文);FTS、召回、视图一律过滤。stub 不为垃圾,它是"等待被 memorize/revise 填实"的占位——带正文写入 stub 即原地转正(`is_stub=0`,不生成垃圾修订)。
- **uri 约定**:`domain://路径/段`,如 `history://scenes/tavern`、`core://identity/habits`。`TEMP://`(动态区)与 `MEM://`(系统视图)是保留前缀,内容 domain 不得使用。
- **raw_log 是稳定活动镜像,不裁剪、不物理删除**(v5.1 定论 + v5.5 修订):`(session_id, entry_id)` 唯一 upsert;切换分支把本 session 离枝行置 `active=0`(不删行、不碰他 session),切回旧分支按原 `raw_id` 复活。重放同一条时 `world_ts` 保留首次写入的世界时间、`wall_ts` 由调用方传入的 entry 原始时间戳刷新(调用方始终传原始时间,故等于不变);要控体积只裁 `node_revisions`。

## 5. 工具面(12 个)

全部工具为 TypeBox 参数,引擎自动填署名(§10)。写入工具挂在会话上,模型按需调用。

| 工具 | 作用 | 要点 |
|---|---|---|
| `recall` | 回想与审视 | 精确 URI + 子树展开(`depth`/`max_nodes`);命中记访问时间(§16 沉睡语义);内置 `MEM://` 视图(§9) |
| `retrieve` | 线索检索 | 关键词混合打分(`query`/`domain`/`limit`/`semantic?`);显式检索无分数下限但 keyword 模式要求真实命中;对直接命中做一跳边扩散(带 via_edge/kind/from_uri) |
| `memorize` | 铭刻新记忆 | `uri`/`content`/`when`(=disclosure)/`parent_uri`(缺父链自动补 stub)/`time`;目标是 stub 时原地转正 |
| `revise` | 修订记忆 | `action: edit\|history\|restore`(默认 edit)。edit 支 replace/append/行编辑 + 批量 `batch`;history 看修订史(不传 uri 列出已删可恢复清单);restore 从修订史恢复(活节点必传 version,已删节点缺省最新,按原 node_id 接回修订史) |
| `forget` | 遗忘清理 | `target` 单/多条,`dry_run` 级联预览;节点真删、cascade 子树;**修订史全留**——`revise(action:"history")` 查清单、`revise(action:"restore")` 找回 |
| `relocate` | 认知重构 | `uri`+`to` 或 `batch`,`dry_run`;`relocateMany` 原子批量子树迁移(整棵跨域、URI 前缀重写、reparent、旧地址全链路转 alias、awaken 重映射);冲突在写入前整体抛错零改动 |
| `associate` | 建立联想通路 | 双互斥模式:`new_uri` 建别名 / `related_uri`+可选 `kind` 建联想边(自连禁止,重复边幂等) |
| `trigger` | 埋设检索线索 | 增删 glossary 专名;增删自动重建 FTS,专名即可召回正文不含触发词的节点 |
| `consolidate` | 记忆综合与收敛 | `resolution: group\|merge\|link\|keep`;group 预检后建主题并用 relocateMany 真分组(源根 parent_id = 主题) |
| `retrace` | 源头回溯 | `raw_id`、`first_raw_id`+`last_raw_id`、`uri`(节点原文区间)或 `query`(活动原文 FTS)取原文日志 |
| `set_time` | 世界时钟推演 | 绝对或相对位移(`+1d`/`-2h`),写入全局世界钟 |
| `awaken` | 意识焦点管理 | `action: list\|set\|add\|remove`;清单存 kv(`awaken_uris`) |

典型链路:

```text
memorize(uri="history://scenes/tavern", content="伊莱在酒馆遇到薇拉,谈及北方商队", when="当话题涉及酒馆或商队")
  → recall(uri="history://scenes/tavern", depth=1)        # 回想
  → revise(uri="history://scenes/tavern", append="薇拉答应三日后启程")
  → forget(target="history://scenes/tavern/过期分支", dry_run=true)  # 预览后真删
  → retrace(first_raw_id=12, last_raw_id=18)              # 直接翻原文
```

## 6. 三个 prompt slot

static 注册进 `SUPPORTED_SLOTS` + `PromptPresetSlot`,全部 `async: true`(异步编译路径):

| slot | 内容 |
|---|---|
| `awaken` | 常驻觉知记忆:awaken_uris 清单原文 + 子节点 snippet + 世界时间行。渲染时按 uri 现值解析,节点被删/被 relocate 天然对账 |
| `recent` | 按 `updated_ts` 倒序的最新记忆;`{ rawCount?, snippetCount? }` 可配原文/snippet 数量 |
| `index` | 所有 domain 根节点 snippet 一览 |

preset 声明示例:

```yaml
slots:
  - name: awaken
  - name: recent
    options: { rawCount: 3, snippetCount: 5 }
  - name: index
```

## 7. 召回与注入(引擎内建)

- 每次 `before_agent_start`,对当前 prompt 做 **双 query**:当前 prompt(检索意图)+ `Prior context:` 最近 6 条消息(陈述文本)。
- 打分:权重 vec 0.55 / keyword 0.3 / importance 0.15(v5.4 单列;数值越大越重要),keyword 双归一化(query-precision 与 doc-coverage×1.4 取 max),世界钟 recency 加成(0.08/0.04/0.02);vector 模式 `MIN_SCORE 0.35`、keyword 模式独立 `keywordMinScore 0.12`、`TOP_K 3`、`HIGH_CONFIDENCE 0.55`(唯一"高度相关"绝对档,keyword 模式按设计打不出)。
- **候选集**:keyword 模式 = 节点 FTS `MATCH` 命中 ∩ kw>0(glossary 专名也算命中);vector 模式保留全 pool 语义空间但只为 FTS 命中节点算 kw。稳定同分次键:`score → kw → vec → bm25 → importance → updated_ts → uri`。
- 注入只出 **树节点**(线索 ≤80 字 + 软锚),原文日志不进注入,只能 `retrace` 主动取。
- 去重:每 prompt 从 `buildContextEntries()` 重建 `uri → md5(uri|content)` 表;同内容版本不重复注入,修订后自动失效重注;只在真正 fresh 注入时记一条 `inject` 审计。
- 通道:`rp-memories` custom message,`context: include / llmRole: user / compaction: exclude / display: false`。`/` 与 `\` 开头 prompt 跳过。
- **domain 黑名单**:默认 `["maintenance", "history_raw"]`(运维噪音);`TEMP` 不在黑名单——动态区草稿随时可被召回,这正是"保险"在生效。
- 参数可配:`settings.memory.recall.{topK, minScore, keywordMinScore, blocklist}`。
- **embeddings 隐私默认 off(v5.5)**:未显式 `mode:"api"` 恒不联网(即使 env 有 key);显式 api 才读 env key 外呼(10s 超时、外部 abort 不 latch、响应错误 latch);无向量时自动降级 keyword 注入。

## 8. 回滚联动

挂在 `_moveLeafAndRestoreState`(reroll 与 navigateTree 的共同 choke point)尾部,零成本可选链:

1. **anchor 可见性重算**(session 维度):`source: auto` 的节点若缺 `anchor_session_id` 或 `anchor_entry_id` 恒不可见;来自**其他 session** 的 auto 节点恒可见(B 的 reroll 不隐藏 A 的产物);来自**当前 session** 的仅当 `anchor_entry_id` 在活动路径可见。`manual` 节点永不自动隐藏(角色主权)。
2. **raw_log 对账**:`syncRawBranch` 把本 session 活动分支整体 upsert,并把本 session 不在路径的行置 `active=0`——**不物理删除、不碰其他 session 行**;切回旧分支旧行按原 `raw_id`/时间戳复活。`registerSession` 后立即 backfill 一次,resume/浏览不等下一回合。

行为验证场景:reroll 后纪要隐藏 + 原文行 active=0;切回旧分支后两者复活(原文 raw_id 不变)。

## 9. MEM:// 视图

`recall(uri="MEM://...")` 内置视图:

| 视图 | 数据源 | 说明 |
|---|---|---|
| `MEM://timeline/<domain>/<N>` | raw_log | 消息级原文时间轴,带 world_ts,倒序 |
| `MEM://forgotten/<domain>/<N>` | nodes | 沉睡最久的活记忆(基准 = `last_accessed_at ?? created_at`,仅主动 recall/retrieve 更新;隐藏 auto 节点过滤) |
| `MEM://wakeup/<N>` | awaken_uris | 意识焦点:清单全文 + 最近动态 |
| `MEM://glossary` | glossary | 全部触发词 |
| `MEM://recent/<N>` | nodes | 最近修改的结构化列表 |
| `MEM://index/<domain>` | nodes | 域根节点一览 |
| `MEM://diagnostic/<domain>` | nodes | 库健康诊断:stale / crowded / placeholder |

## 10. 署名与世界钟(引擎自动填)

写入工具(`memorize`/`revise`/`autoretain`)执行时引擎自动填,模型无需手写:

- `source`:manual(工具)/ auto(autoretain 产物)。
- `model`:当前模型 id;同款/异款判定 = 模型 id 全等。
- `anchor_entry_id`:当前 leaf entry id;`world_ts`:写入时世界钟。
- 修订 custody 链:内容署写入者,版本署蒸馏者(`node_revisions.editor_source/editor_model`)。

世界钟存 `memory_kv["world_time"]`:

- `set_time("2026-09-10")` 绝对设置;`set_time("+1d")` 相对推进(±Nsmhdwy)。
- 写入工具的 `time` 参数:绝对或相对均可,但**相对位移只给本次写入打时间戳,不动全局钟**——全局钟只有 `set_time` 能推进,批量 revise 不会连推 N 次。

## 11. autoretain(后台生成,保险机制)

**定位**:保险不是记忆——止损不增值,产物是"关于我的记录",整理时降级为参考草稿。

- **任务注册制**:每任务 `{ name, everyNTurns, promptTemplate, landing: { domain, strategy: "append"|"underParent"|"replaceStale" }, modelRole?, maxInputChars?, maxOutputTokens?, redact? }`。core 内置两个默认任务,下游可覆盖/注册:

| 任务 | 落点 | 内容 |
|---|---|---|
| `scene-summary` | `history` 域,append | 场景纪要(发生了什么、关键事实、未尽事项) |
| `self-reflection` | `meta` 域,append | 第一人称行为模式 / 性格变化反思 |

- **触发**:turn_end 计数(多任务共用计数器,各自按 everyNTurns 触发);**autoretain 默认关闭**——需要显式配置 `memory.autoretain`(cadence 或任务列表)才启用,避免裸会话每 N 回合静默消耗 side-request 模型配额(与 embeddings 隐私默认 off 同一姿态)。到期任务经宿主 `completeSideRequest(prompt, {modelRole, maxTokens, signal, label})` 跑廉模型 + strict JSON 契约(`{"uri":…,"content":…,"disclosure":…}`),桥到引擎侧请求原语(`memory.autoretain.models.{smol,default}` 解析引用,未配回落 session model;会话 dispose 中止在飞请求)。
- **提示词预算与脱敏(v5.5)**:窗口按 `maxInputChars`(默认 12000)从尾部按字符边界截断;`redact`(默认 true)把 Bearer token 与 `api_key|apikey|token|secret|password|authorization` 赋值替换为 `[REDACTED]`——不改 raw_log 原文。
- **进度(v5.5)**:per-task/per-session(`autoretain_progress` 表),`listUnprocessedActiveRaw(sessionId, task, limit)` 只取本 session 活动分支中该任务未消费行;**成功才写进度,失败静默跳过、下轮重试同一窗口**——不同任务不同 session 不互吞窗口,离枝再回的低 raw_id 行不永久跳过。窗口上限 80 行。
- 产物走 memorize 内部路径,`source: "auto"`,anchor 自动填,并写 `anchor_session_id` + `first_raw_id`/`last_raw_id`(原文区间);每次触发(成败)都写 audit(`autoretain_task`)。

## 12. TEMP 动态区

- **机制**:`TEMP://` 下活跃节点数(非 stub 且可见谓词通过,回滚隐藏的不算)≥ 阈值(默认 10,`settings.memory.temp.threshold` 可调)即 notify。
- **notify 原语**:`rp-notify` custom message,`display: false` + `triggerTurn: true`,compaction exclude;模板含"整理目标是把 TEMP:// 清到零"与教程链接。滞后防重发:未清到阈值以下不重复打扰。
- **TEMP 节点是普通树节点**:可召回、有完整元数据、参与打分,不进黑名单。
- 整理流程:agent 收到 notify → `recall("MEM://recent/20")` 或逐条 recall TEMP 节点 → `consolidate`/`revise` 归位、`forget` 删除。

## 13. 配置参考

编码在 `Settings.memory`,全字段:

```jsonc
{
  "memory": {
    "dbPath": "./world/magnolia/memory.db",          // 项目级或绝对路径
    "rawLog": {
      "customTypes": "all-display-true"               // "all-display-true" | "none" | ["type-a", ...]
    },
    "autoretain": {
      "everyNTurns": 4,                               // 默认任务 cadence;配置本例即启用 autoretain(未配置则关闭)
      "tasks": [ /* 覆盖/新增 AutoretainTask */ ],
      "models": { "smol": "model-ref", "default": "model-ref" }  // 侧请求模型引用;未配回落 session model
    },
    "recall": {
      "topK": 3,
      "minScore": 0.35,                               // vector 注入档
      "keywordMinScore": 0.12,                        // keyword 注入档(v5.5)
      "blocklist": ["maintenance", "history_raw"]
    },
    "temp": { "threshold": 10 },
    "revisions": { "maxVersionsPerNode": 20 },        // 每节点保留修订数上限;缺省无限(不配置即不裁)
    "embeddings": { "mode": "off", "model": "bge-large-zh-v1.5", "apiUrl": "..." }  // 隐私默认 off;apiKey 走 env
  }
}
```

- `rawLog.customTypes`:三态开关决定 custom message 是否收编进原文日志(默认收 display:true 的);user/assistant 消息恒收。
- `embeddings`:**默认 `mode:"off"`(隐私优先,v5.5)**——未显式 `"api"` 永不联网,即使 env 有 key;`"api"` 才读 `PI_MEMORY_EMBEDDING_API_KEY`/`NOCTURNE_EMBEDDING_API_KEY` 外呼(10s 超时)。无向量自动降级 keyword 注入。
- `revisions.maxVersionsPerNode`:正整数或缺省(无限);每次归档后剪掉该节点最旧超额版本,删除前归档也应用同一策略,保证至少保留一版可恢复正文。

## 14. 与下游集成

**不走 agent 管线的消费者**直接用 MemoryStore:

```ts
import { MemoryStore, openMemoryStore } from "@earendil-works/pi-memory";

const store = await openMemoryStore("./role.db"); // open + createSchema
store.put({ uri: "history://scene/1", content: "……", parent_uri: "history://scene" });
const node = store.resolveUri("history://scene/1");
store.export();  // { nodes, revisions, kv, aliases, edges, glossary } JSON 快照(迁移/备份/审计;三类资产不丢,v5.5)
```

公开面(`src/index.ts`):`openMemoryStore` / `MemoryStore` / `createMemoryModule` / `createMemoryTools` / `createMemorySlots` / `resolveMemoryDbPath` / `runAutoretainTask` / `dueTasks` / system 视图渲染函数 / 全部常量与类型。

## 15. 审计与可观测

`audit_log`(append-only):每次写入 / 编辑 / 删除 / 召回 / 注入 / autoretain 产出都留一条结构化记录(ts、world_ts、event、object、source、model、turn/task、anchor、details)。**只留痕不参与系统语义**——不投入回滚/查询/注入回路,系统正确性不依赖它;下游可对账、复盘、解释"记忆发生了什么"。默认开(可关)、无观测面板。

## 16. 已知行为与实战建议

- **FTS 有真实读端(v5.5)**:`node_fts`/`raw_fts` 是检索候选与 retrace query 的来源(统一分词 + 稳定 ID 回表过滤);`@node-rs/jieba` 为模块级单例,不可用时回落 latin + bigram,两侧同一 token 空间。
- **访问追踪只记主动想起**:`last_accessed_at` 仅由角色 `recall`/`retrieve` 更新;自动注入、slot、MEM 视图、`/memories` 浏览不 touch。`MEM://forgotten` 与 diagnostic 的沉睡基准 = `last_accessed_at ?? created_at`。
- **空库是新会话常态**,不是缺陷;`seed()`/`put` 是低门槛写入口。
- **恢复**:DB 损坏/丢失 → 冷启动重建 + 从 session jsonl 重建 raw_log;树/修订/kv/aliases/edges/glossary 用 `export()/import()` 快照恢复。
- **多进程格局**:同一 world project 下,作家(GM)与角色子进程各一库(库边界 = 进程边界),世界钟各库自存,靠 `world_ts` 讲同一个时间故事。
- **不要裁 raw_log**:控制体积只动 `node_revisions`(可重建),原文日志永久保留(`active=0` 行用于审计/retrace)。
- 写前读设计文档的 §16 风险表(本实现继承了全部缓解措施)。

## 17. 测试与验证

- 包内测试:`packages/memory/test/` **138 例**(store 37 / tools 33 / recall 22 / module 28 / phase3 / slots,`:memory:` 真库;覆盖 session 隔离镜像、stub 转正、relocate 原子迁移、revise history/restore、associate 边 + 一跳扩散、retrace uri/query、glossary 专名召回、embeddings 默认 off/abort 不 latch、revision retention、快照三类资产、审计完整列)。
- 集成测试:`packages/coding-agent/test/memory-module.test.ts`(9 例:真实 harness 工具注册/注入去重/raw_log 镜像/reroll active 标记与切回复活/autoretain 消费 side response/时间戳落库/preset 路径/dispose 幂等)、`settings-manager.test.ts`(61 例,含 MemorySettings 深合并)。
- 全仓:`npm run check`(biome / pinned-deps / ts-imports / shrinkwrap / install-lock / tsgo / browser-smoke)。
- Bun 编译冒烟:`bun build --compile` 含 `openDatabase` 的最小入口,验证动态导入不炸构建。
