# pi-rp 记忆系统设计(v5)

> 状态:**已实施**(Phase 0-3 全量落地,实施 commit b0708f1e6,2026-09-10)
> 相关:`plan.md`(功能规划第 6 项)、`plan/multi-agent-infrastructure.md`(多会话 daemon)、`plan/archives/memory-system.md`(v3 档案)、`~/MEMORY.md`(角色侧补充要求)
> 版本史:v3(2026-09-01,RP 双轨定位)→ v4(2026-09-09,胶水层现状重核)→ **v5(2026-09-09,逐枝设计评审版,本版取代 v4)** → **v5.1(2026-09-10,首消费者回冲修订,本版取代 v5)** → **v5.2(2026-09-10,系统视图 scheme 更名 `system://` → `MEM://`,与 `TEMP://` 同属保留前缀;seed 索引根改为 `index://` 真域根)**

## 0. v5 相对 v4 的根本分歧

v5 由一轮逐枝设计评审产生,两路输入:用户对 v4 的四点观察(autoretain 是通用能力;客观轨应存"历史原文 + 摘要";`~/MEMORY.md` 的署名与动态区要求;两表工具不应割裂),以及 grilling 评审逐项收敛的二十余项决策。v4 的双轨溶解为双域:

1. **双轨溶解**:role/story 两套语义的切分取消。场景纪要不再是独立表,而是 autoretain 的一种产物——写进树里约定 domain(如 history)的普通节点。客观轨只剩一张新增的**原文日志表**(append-only 消息镜像);主观与客观共用同一棵树、同一套工具、同一条召回管线。
2. **全面取代**:本包是所有 pi 消费者(独立角色、pi-rp RP 基础设施、作家)的唯一记忆系统。v4 的"standalone 长期共存"废止;nocturne Python 服务与胶水扩展在包达到功能对等后退役。
3. **彻底放弃兼容**:不迁移、不导入、无过渡双读。旧库字段结构不同,冷启动重建;将来真要搬数据是用户自己写的百来行脚本。文档与实现不出现任何兼容代码。
4. **引擎层内建**:署名(§6)、动态区(§7)、autoretain(§5)、注入与回滚联动(§8)都是 harness 能力,不再是 MCP 外部服务可企及的功能。

---

## 1. 术语正名

| 术语 | 含义 | 说明 |
|---|---|---|
| **context** | 隔离单元 | 一个库 = 一个 context ≈ 一个角色或一个作家;`namespace` 一词退役 |
| **domain** | 树根 = 内容域 | 定稿 / 关系 / 生活 / 世界 / meta / history / TEMP 全是普通根;除 TEMP 外 core 无任何特殊能力,名字纯约定 |
| **anchor** | 回溯指针 | 节点上的 `anchor_entry_id`(pi 活动树 entry id)+ 世界时间戳 |

(注:`~/MEMORY.md` 中所说的 "namespace" 实指下行的 domain,已正名。)

## 2. 隔离与部署形态

- **per-project 一库**:DB 路径默认 `<project>/.pi/memory.db`,解析顺序 CLI `--memory-db` > settings > preset。两档 project 粒度均成立:`project = world`(如 `world/magnolia`,多角色 + 作家共用)或 `project = 角色/作家`(如 `world/magnolia/chars/elias`)。**不是 per-session**——一个 agent 的多个 session 共库。
- **库内只有一棵树**:树根即 domain。无跨库派生表,v4 的 nsops 模块整个消失(ns_migrate 式联动改表的事故类从 schema 层根除)。
- 回滚正确性挂在"pi session jsonl 活动路径正常回滚 → DB 跟随"这条链上,与 DB 文件怎么分无关。
- `packages/memory`(`@earendil-works/pi-memory`,scope 待定)仍是 pi-rp workspace 包,monorepo 三处接入(tsconfig paths / vitest workspaceSourcePaths / build 链)沿 v4。

## 3. Schema(全新,无 legacy)

```
memory.db
├── nodes              树。单节点单树:node_id 主键、parent_id、domain、
│                      uri、content、disclosure(想起条件)、priority/importance、
│                      source(auto|manual|import)、model(写入引擎模型 id)、
│                      anchor_entry_id、created_at、world_ts、updated_ts、content_hash
├── node_revisions     修订制:node_id、version、content、editor_source、
│                      editor_model、created_at。编辑时旧版归档于此,
│                      现行版在 nodes;修订回滚 = 指定 version 重新生效;
│                      裁剪点(可配):node_revisions 是库内唯一适合裁剪的表,
│                      内容可重建(raw_log 不可裁,见 §4 增长与留存)
├── edges              联想图(检索扩散面),挂 node_id
├── aliases            别名寻址(uri 稳定性:rename 不破链)
├── raw_log            原文日志(新,见 §4)
├── node_fts           FTS5(树节点:纪要/反思/定稿自动入召回)
├── raw_fts            FTS5(原文日志)
├── memory_embeddings  向量(仅树节点;API 嵌入,见 §9)
├── glossary           专名表(专名→节点,提升分词命中)
└── memory_kv          世界钟等配置(记忆包内建世界钟:配置存此,
                       set_world_time 工具 + clock 读取 API + timeline/recency 用)
```

**明确不存在的表**:`story_events`(取消,纪要=树节点)、`memory_ops`(取消,回滚由 anchor 谓词 + 切换对账接管)、revisions 全局树(取消,由 node_revisions + raw_log 接管)、presets 表(动态区等约定由下游配置承载)。

## 4. 原文日志(raw_log)

**定位**:活跃树消息的镜像,append-only,是"场景记忆"的原文层。

- 每消息一行:`raw_id`、`role`、`text`、`entry_id`(pi 活动树 entry id,回溯指针)、wall 时间戳、world_ts。
- **写入**:turn_end 钩子批量 append 本回合新增。默认收叙事 user / assistant;**custom message 不预设排除**——display:true 的可收,收编规则做成可配置接口(现阶段不实现复杂规则,但口子留好)。
- **检索**:FTS5 + 按 id/区间取回工具(见 §10 工具面)。无向量。
- **与活动树的同步(切换即对账)**:reroll / 切分支 / 回滚后,立即物理删除活动路径之外的原文行。依据:pi session 树 append-only、entry 永不删,切回旧分支后可按最新活跃树重建,DB 只是派生视图——真源在 jsonl,删除不破坏审计,且避免反复回滚时影子行堆积。
- **消费**:场景纪要节点存原文区间引用(first_raw_id/last_raw_id),agent 由纪要 id 直接取原文。
- **增长与留存(v5.1 定论)**:raw_log **无限增长,不做任何裁剪/归档/retention**。逐消息一行的体量对 SQLite 长期成本极小,而保留下来的原文是"真正长期记忆"的唯一原文底稿(compaction / 回滚后仍可变回原文),这是白赚的收益,不接受反驳。**如需控体积,裁剪只发生在 node_revisions(修订版,内容可重建),不在 raw_log**;raw_log 唯一的"删"语义是切换分支对账(本§上文),属正确性不是容量。

## 5. autoretain(引擎侧后台生成)

**定位**(沿 `~/MEMORY.md` §4):保险,不是记忆。止损,不增值;产物是"关于我的记录",整理时降级为参考草稿。

- **通用能力,非剧情摘要专属**。对角色:回看 n 回合行动,意识到行为模式 / 性格变化 / 倾向(反思);对作家 / 角色通用的场景纪要。不同下游产物不同。
- **写入行为模型:引擎侧后台 LLM 生成**(omp stage1 姿势):廉模型 + strict JSON 输出契约 + token 预算 + redact;不经角色主循环,失败静默跳过(下轮重试覆盖窗口;原文日志不丢,永可重做)。确定性强、不干扰主循环,恰合"保险"生态位。
- **任务注册制**:每任务 = `{name, everyNTurns, 提示词模板, 产物落点(domain+放置策略), 模型角色}`。core 自带默认任务(场景纪要、自我反思),下游可增删改——提示词、落点、周期全部自定义,`history` 这类 domain 名就是下游取的。
- **模型角色**:逐任务可配,默认 smol(omp `providers.memoryModel` 先例)。
- 多任务共用一个回合计数器,各自按周期触发。

## 6. 署名(provenance,harness 内建)

沿 `~/MEMORY.md` §3,字段全量进 schema,引擎自动填,写入工具无需手填:

- `source`:auto / manual / import。
- `model`:写入时角色模型 id。**同款/异款判定 = 模型 id 全等**;呈现规则("写入引擎非当前引擎时显示 By <name>")是读端 UI 的事,不进 schema。自定义代号(name 字段)暂不做,模型 id 随时可补代号(元数据可修订)。
- `anchor_entry_id` + `world_ts`:回溯指针。**有了 raw_log 与 anchor,session 文件不再承担归档职责**(退化为运行时暂存),"悬空引用"问题消失。
- 修订 custody 链:内容署写入者(source/model),版本署蒸馏者(node_revisions.editor_source/editor_model),版本史连成链。
- 阅读协议(信任梯度、复调)是纯认知约定,代码无需设计——记入文档供教程引用。

## 7. 动态区(TEMP://)

- **机制引擎内建,命名是唯一约定**:约定名 `TEMP://`(可配)。机制 = 阈值计数 + 达标 notify + 整理流程。
- **notify 与 autoretain 反思任务共用同一条原语**:core 的"系统→角色定向消息"(display:false、triggerTurn、不入历史快照),notify 与反思任务各写各的模板。
- **计数口径**:TEMP:// 下活跃节点数 ≥ 阈值(默认 10,可调)即触发。不设独立计数器表,一次 COUNT 查询;节点增删由工具自然影响计数,"活跃"复用可见性谓词(回滚隐藏的不算)。
- **整理 = 要求清到零**(不是修剪);一旦允许"先处理一部分",缓冲区变垃圾场(MEMORY.md 历史教训)。
- **TEMP 节点是普通树节点**:可召回、有完整元数据、参与打分,不特殊处理——草稿若真相关,召回它正是"保险"在生效。
- 直通例外(修正类、时效类不经缓冲)与巡库/散步是认知协议,进教程不进代码。

## 8. 回滚与可见性

- **auto 来源节点跟回滚**:所有 `source:auto` 的节点(纪要、反思、autoretain 一切产物)带 anchor(anchor_entry_id 或原文区间);anchor 离开活动路径时节点转不可见——可见性谓词,不删行,切回分支自动复活(与 pi 树 append-only 哲学一致)。
- **manual 节点永不自动隐藏**(角色主权):角色手动写的认知不被 reroll 抹掉。
- **raw_log 行:切换即对账**(§4,物理删除活动路径之外的行)。
- 钩子绑定 `_moveLeafAndRestoreState`(reroll 与 navigateTree 的共同 choke point,`session_tree` 事件已标记退役);`session_before_reroll` / `leaf_changed` 仅作扩展生态观察口,包不依赖。
- `memory_ops` 表与"全量重算"流程取消——上述两条规则覆盖其全部职责,且更简单。

## 9. 召回(autorecall)

- **机制与参数整体迁移自 recall 扩展调参版**(生产验证,不重新发明):双 query(当前 prompt 带 BGE instruction + "Prior context:" 最近 6 条)、权重 vec 0.55 / keyword 0.3 / priority 0.15、keyword 双归一化(query-precision 与 doc-coverage×1.4 取 max)、MIN_SCORE 0.35、TOP_K 3、HIGH_CONFIDENCE 0.55、世界钟 recency 加成(0.08/0.04/0.02)、chunk 500/overlap 80、md5(content|search_terms) hash。
- **注入只出树节点**(线索 ≤80 字 + 软锚),原文日志不进注入——原文只能拿 id 主动取;场景记忆的"自然想起"由纪要节点承担(它就在树里,本来就会被召回)。
- **domain 黑名单**:autorecall 的域级排除机制照搬(默认 maintenance 类运维噪音;TEMP **不进**默认黑名单——动态区随时可召回,前面已定)。`/recall domain add|remove` 交互沿袭。
- **RRF 不引入召回通道**:那是工具查询场景的融合方案,与加权召回并存于各自场景(沿 v4)。
- 注入通道:`before_agent_start` → 混合召回 → `rp-memories` custom message(context:include / llmRole:user / compaction:exclude / display:false);去重每 prompt 从 `buildContextEntries()` 重建。
- `memory.autoretain.everyNTurns`(默认 4)语义并入 §5 任务注册制。
- **compaction 交互**:raw_log 独立于 compaction(它是库的镜像,不是 session 内容),原文照常落库;注入的 rp-memories 沿用 compaction:exclude。**autoretain 纪要窗口从 raw_log 取而非活跃上下文**——compaction 把上下文摘要掉之后,纪要照常生成,这正是原文日志存在的意义之一。

## 10. 工具面（统一、重命名与收敛）

**一套工具服务角色与作家**，不因内容域割裂。摒弃机械去后缀，采用“高阶认知动词 + 语义无冲突”命名；全面吸收 `batch_*` 批处理与冗余工具，将原系统 16–18 个工具槽位精简收敛为 **9 个高聚合核心工具**：

### 对照表

| 旧名 | 推荐新名 | 说明 |
| --- | --- | --- |
| `browse_memory` | **`recall`** | 回想与审视：支持精确 URI 寻址、子树多层展开（`depth`/`max_nodes`）及内置系统视图（`MEM://*`）|
| `search_memory` | **`retrieve`** | 线索检索：混合检索（BM25 词法 + 向量语义），聚合树命中与原文命中摘要，保留 `semantic` 参数|
| `remember_memory` / `remember_child_memory` | **`memorize`** | 铭刻新记忆：单工具兼具根节点/子节点记入；提供可选 `parent_uri`（自动补齐占位父链）与世界时间打标|
| `edit_memory` / `batch_edit_memories` | **`revise`** | 修订记忆：避开与 Harness 的 `edit` 冲突；单条支持精确 Patch/追加/行编辑，多条支持批量修饰属性|
| `forget_memory` / `batch_forget_memories` | **`forget`** | 遗忘清理：单/多条统一入口；`target` 参数多态化（`str | list[str]`），支持 `dry_run` 预览级联影响，删除时自动备份|
| `move_memory` / `rename_memory` / `batch_move_memories` | **`relocate`** | 认知重构/路径迁移：兼并改名与跨域迁移；单条传 `uri` + `to`，多条传 `batch` 列表，支持 `dry_run`|
| `link_memory` | **`associate`** | 建立联想通路：在新的上下文路径开辟别名映射（底层 `add_path`），让事件在多处自然通达|
| `tag_memory` | **`trigger`** | 埋设检索线索：增删触发词汇（`glossary_keywords`），彻底消除“主动执行触发”的动词误解|
| `merge_memories` / `organize_memory` | **`consolidate`** | 记忆综合与结构收敛：统一多源提炼；通过 `resolution` 参数切换处理策略（`group`/`merge`/`link`/`keep`）|
| `boot_memory` | **`awaken`** | 意识焦点管理：管理角色醒来自动载入的常驻/工作记忆清单（`add`/`set`/`remove`/`list`）|
| `set_world_time` | **`set_time`** | 世界时钟推演：设置或按相对位移（如 `+1d`）推进世界观时间轴；单动词与全体系保持绝对对齐|
| `archive_history` | **(废除)** | 场景历史日志归档属于运行时快照/审计流水，不占角色主记忆认知工具位|
| `recent_memories` | **(废除)** | 职责完全被 `recall(uri="MEM://recent/10")` 覆盖，不再独立占用顶级工具位|
| (新增) | **`retrace`** | 源头回溯：按 ID 或起止区间提取底层历史原文日志，与认知层面的记忆节点解耦 |

写入工具(source/model/anchor/world_time...)由引擎自动填。删除后的找回路径是 node_revisions——不留无入口的僵尸节点。

## 11. Slot(重新设计,3 个)

| slot | 内容 | 取代 |
|---|---|---|
| **awaken** | 常驻觉知记忆：醒来时预加载的 URI 原文 + 子节点 snippet（+世界时间行） | 旧 boot（彻底去除系统启动味与 state 化） |
| **recent** | 按 updated_ts 拉最新记忆;原文 / snippet 各自数量可配(options) | 旧 history + state(两 slot 职能合并) |
| **index** | 所有 domain 根节点 snippet 视图 | 新增(现 MEM://index/<domain> 的全局化) |

//boot_uris → awaken_uris 的命名也要全链路对齐，比如MEM://awaken替换MEM://boot
//awaken记忆变更时也要自动对账，比如节点被遗忘时自动剔除，被relocate时自动更新
//顺便补一个之前没有的细节，就是memorize时如果不存在父节点自动创建的placeholder不能够靠魔法字符串了，要在 nodes 表原生引入 is_stub，这样全文索引触发器或查询视图增加过滤时看不到垃圾字符串

静态注册进 `SUPPORTED_SLOTS` + `PromptPresetSlot`(沿 v4);slot 定义声明 `async: true`(异步编译路径已由扩展验证)。

## 12. 包结构与 API

- **两层 API**:`createMemoryModule`(session 绑定,注册工具/slot/钩子/注入,RP 场景直接用)+ `MemoryStore`(纯库层:graph/search/kv,无 pi 依赖,worldlines 类外部消费者直接以 TS 依赖引用)。另留 autoretain 任务注册接口。
- SQLite 驱动:**node:sqlite 为主**(`DatabaseSync`,与 session 存储同族,pi-rp 主链路是 node,Bun 只用于编译二进制);包内只留一个 `openDatabase()` 内部函数,若 bun 编译产物中 node:sqlite 不可用再局部加后备,不预付双驱动成本。
- 向量:仅树节点;**只做 API 模式**(siliconflow bge-large-zh-v1.5,`mode: off` 纯 FTS 降级);`embeddings/` = API 客户端(零依赖 fetch)+ 向量缓存表读写。
- CJK 分词:**`@node-rs/jieba`**。零依赖不是目标本身,分词质量优先;引入原生依赖的代价(install 体积、平台二进制)接受。接口仍抽象,极端场景可换。
- **不做 MCP wrapper**:nocturne Python 服务退役后,外部消费者走 MemoryStore 纯库层;协议层等真实需求出现再单独成包。
- **便捷写库/引导(v5.1)**:空库是新会话的**常态**(如同新 jsonl 无消息),不属缺陷。包提供低成本写入口:`seed()`(导入初始树/Boot 节点)、`remember/put` 双向(单节点写入无需预置 parent)。参考实现引导即可,不搞自动化"空库自检"。
- **恢复与迁移(v5.1)**:DB 文件损坏/丢失 = 冷启动重建 + 从 session jsonl 重建 raw_log 镜像(真源在 jsonl,§4 对账已说明);记忆库本体提供 `export()/import()`(树 + 修订 + kv 的 JSON 快照)供迁移/备份/审计。不做与 session 无关的二次冗余。
- **审计留痕(v5.1,非 usage/token 计量)**:不埋 token/耗时这类成本 metric——那不是记忆系统的职责。取 pi 每次 LLM 请求都带 usage 的**透明姿态**:记忆系统每次对外动作(写入/编辑/删除/召回/注入/autoretain 任务产出)都出一条 **append-only 结构化审计记录**(时间 + world_ts、事件类型、对象(node_id / 原文区间)、来源与模型、所在回合/任务、anchor)。**只留痕,不参与系统语义**——不投入回滚/查询/注入回路,系统正确性不依赖它;下游可用它对账、复盘、解释"记忆发生了什么"。默认开、可关、不设观测面板。

## 13. Phase 计划(存储先行,autoretain 殿后)

- **Phase 0 — 包骨架 + 新 schema**:workspace 接入三处;schema 全建(§3);存储层纯 vitest 测试(不碰 pi 集成);`openDatabase()` 驱动口。
- **Phase 1 — 工具面 + slot + context 路由**:§10 全部工具注册;awaken/recent/index 三 slot;`--memory-db` / settings / preset 解析链。
- **Phase 2 — 召回 + 注入 + 回滚联动 + 署名**:recall 机制与调参迁移(§9);before_agent_start 注入;`_moveLeafAndRestoreState` 绑定(auto anchor 谓词 + raw_log 对账);署名自动填(§6)。验收含:awaken 注入、写/改/删(修订入 revisions)、reroll(纪要隐藏 + 原文删除 + 切回复活)、注入去重 + compaction 重算。
- **Phase 3 — autoretain + TEMP + 读端**:任务注册引擎(§5)、"系统→角色定向消息"原语、TEMP 动态区机制(§7)、系统视图移植(timeline / forgotten / wakeup;forgotten 语义 = 捞沉睡最久的活记忆,与删除无关)、`/memories` interactive、(可选)smol 模型角色接 autoretain。

## 14. 已定决策清单

1. 全面取代 nocturne 胶水与 Python 服务(对 pi 消费者);不迁移不兼容。
2. 术语:context = 隔离单元(库),domain = 树根;per-project 一库(world 或角色档),`--memory-db` 可覆盖;非 per-session。
2a. **多进程格局(作家与角色)**:同一 world project 下,**进程各一库**——主进程(GM/作家 agent)与角色子进程各有自己的 context(库边界 = 进程边界;session 自身已实现上下文隔离)。作家库记剧情大纲/伏笔/世界状态,角色库记主观记忆与自视角纪要(现网 elias 与全局 namespace 的分离已是此格局)。raw_log 各记各的 session;世界钟**各库自存**(memory_kv),包只提供读写 API,子进程如何跟随主进程推进由下游接线;两库不共享表,靠 world_ts 讲同一个时间故事。
3. 树为脊,单节点单树,树根即 domain;TEMP 之外无特殊 domain。
4. 客观轨 = raw_log 原文日志(逐消息行,turn_end 批量;custom message 收编 = settings 三态开关,默认 all-display-true);纪要 = 树节点(autoretain 产物,落点默认 history domain,纯下游约定)。
5. raw_log 与活动树切换即对账(物理删除路径外行);真源是 pi session jsonl,DB 是派生。
6. autoretain:通用能力、引擎侧后台生成(廉模型 + strict JSON)、任务注册制、模型逐任务可配默认 smol、失败静默跳过。
7. 署名全字段内建(source/model/anchor+world_ts),引擎自动填;同款/异款 = 模型 id 全等;custody 链经 node_revisions。
8. 动态区:机制内建、命名 TEMP:// 唯一约定、计数 = TEMP 活跃节点数、整理 = 清零、TEMP 节点普通可召回;notify 与 autoretain 共用"系统→角色定向消息"原语。
9. 回滚:auto 来源节点带 anchor 跟回滚(谓词隐藏,切回复活),manual 永不自动隐藏;钩子绑 `_moveLeafAndRestoreState`;memory_ops 取消。
10. 节点版本:node_revisions 表(修订制 + custody 链);delete = 真删,无归档层,无机器 retention。
11. edges / aliases / glossary 保留(schema 随新设计重写)。
12. 召回:调参版整体迁移(0.55/0.3/0.15 等);注入只出树节点;黑名单默认 maintenance 类,TEMP 不进;RRF 只在工具查询场景。
13. slot:awaken / recent / index 三个,静态注册,async:true。
14. 工具:一套统一、去后缀、归并(约 16-18 个);browse→recall、forget→delete、archive_history 废除、新增 raw。
15. 世界钟内建记忆包(配置 memory_kv + 工具 + 读取 API)。
16. 包 API 两层:MemoryStore 纯库 + createMemoryModule;autoretain 任务注册接口。
17. 驱动:node:sqlite 为主,编译场景留后备口;向量仅节点、仅 API、可 off。
18. Phase:0 schema → 1 工具/slot/路由 → 2 召回/注入/回滚/署名 → 3 autoretain/TEMP/读端。
19. **raw_log 无限增长不裁剪(v5.1)**:append-only 永久保留,不做 retention/归档/容量裁剪;成本极低,收益 = 原文永久可得。唯一"删"= 切换分支对账。
20. **裁剪点只在 node_revisions(v5.1)**:修订版内容可重建,`memory.revisions.retention`(默认无限,可配保留版本数/体积上限)。两表分工从此清晰。
21. **写库接口与空库语义(v5.1)**:空库 = 新会话常态;包提供 seed()/put 低门槛写入口,不做自动化空库自检。
22. **恢复与迁移(v5.1)**:损坏/丢失 → 冷启动重建 + jsonl 重建 raw_log;`export()/import()` JSON 快照供迁移/备份/审计。
23. **审计留痕(v5.1)**:不是 usage/token 计量;而是每次写入/编辑/删除/召回/注入/autoretain 产出 append-only 结构化审计流(事件 + 对象 + 来源/模型 + 时间/world_ts + 回合/任务 + anchor),供下游透明审计;除对外暴露外不参与系统语义。

## 15. 本轮评审补充决策(2026-09-09,ask 批次)

1. **包名:`@earendil-works/pi-memory`**(与 workspace 现有 scope 一致)。
2. **CJK 分词:`@node-rs/jieba`**。零依赖不是目标本身,分词质量优先;原生依赖的代价接受,接口仍抽象可换。
3. **custom message 收编:settings 三态开关** `memory.rawLog.customTypes` = `"all-display-true"`(默认)/ `"none"` / 自定义 type 名列表;引擎按此决定 raw_log 收编范围,Phase 2 落地。
4. **timeline 视图数据源 = raw_log**(消息级,带 world_ts);纪要节点不入轴,避免同场双条。
5. **compaction 交互**:raw_log 独立于 compaction;autoretain 纪要窗口从 raw_log 取(见 §9)。
6. **MCP wrapper 不做**:外部消费者走 MemoryStore 纯库层;协议层等真实需求出现再单独成包。

## 16. 风险(v5 重写)

| 风险 | 缓解 |
|---|---|
| raw_log 物理删除误伤(活动路径判定 bug) | 对账逻辑以 `buildContextEntries()` 为唯一真源;Phase 2 验收专测 reroll / 切分支 / compaction 三场景;jsonl 永不删,可重建 |
| auto anchor 谓词与 pi 内部结构耦合(anchor_entry_id 语义变化) | 谓词集中单文件;`leaf_changed`/`session_before_reroll` 作旁路观察口 |
| autoretain 后台生成质量(廉模型写歪) | strict JSON 契约 + 验收 schema;产物 source:auto 天然"整理时降级为参考草稿";失败静默跳过不影响主链路 |
| TEMP 清零纪律失效(历史教训:143 节点) | notify 注入含教程与清零要求;display:false 不扰用户;机制内建不可绕过 |
| TEMP 草稿偶发占据注入位 | 接受(前面已定不特殊处理);priority 可调;真实影响出现再议 |
| recall 调参在新数据形态下漂移 | 参数进 `memory.recall.*` 默认值;生产观察后回写 |
| `session_tree` 退役过渡 | 包不依赖它(绑 choke point);胶水扩展退役前维持现状 |
| bun 编译产物中 node:sqlite 不可用 | `openDatabase()` 单点;Phase 1 用 `bun build --compile` 冒烟验证,不行局部加后备 |
| embedding API 抖动/限流 | 缓存命中零调用;`mode: off` 纯 FTS 降级;minScore 过滤 |
| 多 session 并发写同库 | WAL + busy_timeout + 进程内写队列 |
| 注入消息累积进 session 文件 | 接受(jsonl 本就是垃圾堆);compaction:exclude;去重 + compaction 清空 |
| CJK 分词质量 | `@node-rs/jieba` 已选型,接口仍抽象可换 |
| raw_log 无限增长导致库体积缓慢膨胀 | 接受(§4 增长与留存:收益白赚、成本极低);若实测异常增加,先查 node_revisions 与 embeddings 缓存,不裁 raw_log |
| DB 文件损坏/丢失 | 真源在 session jsonl;raw_log 可由 jsonl 重建;树/修订/kv 经 export()/import() 快照恢复;文档写明恢复流程 |
| 审计留痕成本 | append-only 单行,不参与查询/注入/回滚语义;默认开可关;暴露即接口,不透出存储细节 |
