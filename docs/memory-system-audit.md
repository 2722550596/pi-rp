# 记忆系统 v5.2 落地核查报告

> 核查日期：2026-09-11
> 核查对象：`packages/memory/`（`@earendil-works/pi-memory` 0.84.2，2920 行 src）+ `packages/coding-agent/` 接线，HEAD `b0e14cf49`
> 对照物：`docs/memory-system.md` v5.2 设计、`~/projects/nocturne_memory/`（Python 生产实现）、`~/.pi/agent/extensions/nocturne-memory-recall.ts`（召回调参生产版）
> 方法：逐文件通读 + 对可疑处写临时 vitest 实证复现（临时用例已删除，本文中标注"实证"的均为实跑输出）

## 结论

Phase 0（schema）、Phase 1（工具/slot/路由）、Phase 2（注入/回滚联动/署名）基本落地且骨架正确。但：

- **§9 的向量召回整块没有实现**，且权重折叠把生产标定的阈值破坏了；
- **§5 的 autoretain 在真实引擎里从未触发**——引擎侧 host 没有提供侧请求原语，代码走到 `continue` 静默跳过；
- 另有 **6 个 P0、13 个 P1 级实现缺陷**，其中 7 个已实证复现。

**修复进度（2026-09-11，v5.5 修复轮）**：**#1–#25 全部已修并回归测试闭环**。落地顺序：#3（向量通道）、#4（召回排序）、#6（删除找回路径）、#10（重要性单列 + 极性）先行，随后 v5.5 修复轮一次收口 #1/#2/#5/#7–#25（raw_log 稳定 session 镜像、autoretain 真实引擎接线、stub 转正、relocate 子树原子迁移、consolidate 真分组、revise history/restore 读端、FTS/glossary/edges 真实读端、访问追踪、审计补全、快照三类资产、embeddings 隐私默认、keyword 注入档等），实施过程中新发现的坑记在 §27。**无剩余 P0/P1**。

因此 `docs/memory-system.md` 顶部的"**已实施**（Phase 0-3 全量落地）"**成立**（v5.5 起），见 §27 逐项闭环说明。

## 速览

| # | 严重度 | 问题 | 主要位置 |
|---|---|---|---|
| 1 | ~~P0~~ 已修 | 多 session 共库时，一个会话的分支对账会物理删掉**其它会话**的全部原文 → raw_log 加 `session_id` + `active` 标记，`syncRawBranch` 只动本 session 行 | `store.ts` `module.ts` |
| 2 | ~~P0~~ 已修 | autoretain 永不触发：引擎 host 缺 `completeSideRequest` → host 桥到引擎侧请求原语，真实 AgentSession 可跑 | `agent-session.ts` `module.ts` |
| 3 | ~~P0~~ 已修 | 向量召回整块缺失，且权重折叠使 MIN_SCORE / HIGH_CONFIDENCE 失真 → 已补 `embeddings.ts` + `recall.ts`，权重不再折叠 | `embeddings.ts` `recall.ts` |
| 4 | ~~P0~~ 已修 | `MemoryStore.recall()` 忘了按分数排序 → 统一走 `recall.ts` 的 `rank()`（含排序） | `store.ts` `recall.ts` |
| 5 | ~~P0~~ 已修 | 占位节点（stub）无法转正，永久对召回隐身 → `put()`/memorize/revise 带正文即原地转正，stub 空正文不进 FTS | `store.ts` `tools.ts` |
| 6 | ~~P0~~ 已修 | `forget` 连修订史一起删，删除后无任何找回路径 → 节点真删、修订全留，`node_revisions` 增 `uri` | `store.ts` `schema.ts` |
| 7 | ~~P1~~ 已修 | `relocate` / `rename` 不搬子树 → `relocateMany` 原子批量子树迁移（URI 重写、reparent、alias、awaken 重映射） | `store.ts` |
| 8 | ~~P1~~ 已修 | `consolidate` 的 `group` 不真的分组 → 预检 + 建主题 + `relocateMany` 真移动，源根 parent_id = 主题 | `tools.ts` |
| 9 | ~~P1~~ 已修 | `put()` 更新已有节点会把 `world_ts` 抹成 null → `undefined`=不改，显式 `null` 才清空 | `store.ts` |
| 10 | ~~P1~~ 已修 | `importance` 与 `priority` 两列脱节 → 已合并为单列 `importance` | `schema.ts` `store.ts` `module.ts` |
| 11 | ~~P1~~ 已修 | 纪要节点缺 `first_raw_id`/`last_raw_id` → autoretain 产物写原文区间，`retrace(uri=...)` 可回取 | `schema.ts` `autoretain.ts` |
| 12 | ~~P1~~ 已修 | 回滚后 raw_log 重建丢原始时间戳与顺序，且要等下一回合 → 稳定镜像 upsert（wall_ts 永存、world_ts 不覆盖），`_setupMemoryModule` 后立即 backfill | `module.ts` |
| 13 | ~~P1~~ 已修 | `node_revisions` 没有读端 → `revise` 增 `action:history/restore`（含已删节点恢复） | `tools.ts` |
| 14 | ~~P1~~ 已修 | FTS 表写而不读；jieba 每次调用重建词典 → FTS 检索真实读端 + 模块级单例分词器 | `schema.ts` `tokenize.ts` |
| 15 | ~~P1~~ 已修 | `glossary` / `edges` 是死表 → glossary 专名进 FTS/检索；edges 显式 retrieve 一跳扩散 | `module.ts` `tools.ts` |
| 16 | ~~P1~~ 已修 | 无访问追踪，`MEM://forgotten` 与 diagnostic 的"沉睡"语义走样 → `last_accessed_at`（仅主动 recall/retrieve 更新） | `memory-views.ts` |
| 17 | ~~P1~~ 已修 | `/memories` 解析库路径忽略 settings → 只用 `ctx.getMemoryDbPath()`（AgentSession 已解析路径） | `extensions/memories/index.ts` |
| 18 | ~~P1~~ 已修 | autoretain 多任务共用 raw_id 游标互吞 → `autoretain_progress(session_id,task,entry_id)` per-task/per-session 进度 | `module.ts` |
| 19 | ~~P1~~ 已修 | 审计缺召回/注入事件；`turn`/`task`/`anchor` 列永远为空 → 补全列与 recall/inject/autoretain 事件 | `store.ts` |
| 20 | ~~P2~~ 已修 | preset 这一档没接 → `PromptPreset.memory.dbPath` 接入三级解析链 + 切换 reload | `agent-session.ts` |
| 21 | ~~P2~~ 已修 | `Settings.memory` 缺 `temp` 与 `autoretain.tasks` → 直接复用包导出 `MemorySettings` 全量契约 | `settings-manager.ts` |
| 22 | ~~P2~~ 已修 | 同回合 raw_log 行序与真实消息序不符 → `onTurnEnd` 单遍保序 append（custom 交错） | `module.ts` |
| 23 | ~~P2~~ 已修 | `export()/import()` 丢 aliases / edges / glossary → 快照三类资产齐备，引用缺失回滚 | `store.ts` |
| 24 | ~~P2~~ 已修 | `reconcileRawLog` 全表扫描 → `syncRawBranch` TEMP 表 + session_id 过滤，不读他 session 行 | `store.ts` |
| 25 | ~~P2~~ 已修 | 若干小瑕疵（`editor_source` 未写、`isVisible` 半失效、经别名 rename 丢旧规范 URI 等） | 见 §25 |
| 26 | ~~P2~~ 已修 | 文档自身不一致（状态标注、决策 14 旧工具名、§ 引用错位） → 本报告与 `docs/memory-system.md` v5.5 同步回冲 | `docs/` |
| 27 | — | **实施期新发现的坑**（默认联网、异步竞态、keyword-only 近乎静默、#4 原证据更正等） → 全部收口 | 见 §27 |

---

## P0

### 1. 多 session 共库时，分支对账会删掉其它会话的全部原文

**位置**：`packages/memory/src/store.ts:486 reconcileRawLog()`、`module.ts:572 onLeafChange()`、`schema.ts` 的 `raw_log` 定义

**现象**：`raw_log` 表没有 `session_id` 列，只有 `entry_id`（pi session 树的 entry id）。`reconcileRawLog(activeEntryIds)` 的语义是"删除 entry_id 不在活动路径上的所有行"：

```ts
const stale = rows.filter((r) => !keep.has(r.entry_id)).map((r) => r.raw_id);
```

会话 A 触发一次 reroll / 切分支，传进来的是 **A 自己**的活动路径 entry ids；会话 B 写进同一个库的所有原文行，其 entry_id 天然不在 A 的路径上，于是被整批物理删除。反向亦然：B 下次切分支时把 A 的也删光。两个会话交替回滚 = 原文日志互相清零。

**与设计的出入**：这直接打在 §2 的核心隔离决策上——"**不是 per-session**——一个 agent 的多个 session 共库"（决策 2 同）。§16 风险表里"多 session 并发写同库"的缓解写的是"WAL + busy_timeout + 进程内写队列"，那只解决并发写锁，完全没覆盖这条语义冲突。而 §4 把"切换即对账"当作正确性机制，现在这个机制在设计明确允许的部署形态下是破坏性的。

**影响**：P0。这是唯一会**永久销毁数据**的路径（§4 明确 raw_log 不裁剪、永久保留，是"真正长期记忆的唯一原文底稿"）。真源在 jsonl 不等于没事：重建逻辑不存在（见 #12），且重建也会丢时间戳。

**修复方向**：`raw_log` 加 `session_id`（写入时从 host 取），对账 `DELETE ... WHERE session_id = ? AND entry_id NOT IN (...)`。同一问题也波及 `recomputeAnchorVisibility`（`module.ts:352`）：其它会话写的 `source:auto` 节点，anchor 不在本会话路径上，会被本会话判定为"回滚隐藏"——auto 节点的可见性谓词同样需要 session 维度，或者 anchor 需要带上 session 标识。

**处置/验证（v5.5，2026-09-11）**：

- raw_log 加 `session_id TEXT NOT NULL` + `active INTEGER NOT NULL DEFAULT 1`，唯一索引 `(session_id, entry_id)` 与 `(session_id, active, raw_id)`；**不再物理删除**——`syncRawBranch(sessionId, entries)` 在单事务内：按 `(session_id, entry_id)` upsert 活动分支 → 用连接级 TEMP 表 + `active=0` SQL 只动本 session 行（不读/不扫他 session）→ 同步 `raw_fts`。
- 可见性：`recomputeAnchorVisibility` 按 §3.7 session 维度规则（manual/import 恒可见；auto 缺 anchor_session_id 或 anchor_entry_id 隐藏；跨 session 恒可见；同 session 仅 anchor 在活动路径可见）。
- 回归：`test/store.test.ts` "raw_log session-isolated mirror"（两 session 共库，A 切分支 B 行仍 active 且 raw_id 不变，切回恢复原 raw_id/world_ts）、`test/module.test.ts` "syncs raw_log to the active branch"、`test/module.test.ts` "never hides auto nodes produced by another session"。

### 2. autoretain 永不触发：引擎 host 缺 `completeSideRequest`

**位置**：`packages/coding-agent/src/core/agent-session.ts:4133 _createMemoryModuleHost()`、`packages/memory/src/module.ts:490`

**现象**：`MemoryModuleHost` 把 `completeSideRequest` 声明为**可选**方法，模块里的判断是：

```ts
if (!host?.completeSideRequest) continue; // no side-request primitive → silently skip
```

而 `_createMemoryModuleHost()` 返回的对象只有 `registerTool / registerSlot / registerCustomType / on / getSessionInfo / getBranchSnapshot / getTurnMessages / sendCustomMessage` 八个成员，**没有 `completeSideRequest`**。引擎本身是有这个能力的（`agent-session.ts:3813`，扩展 ctx 上的 `completeSideRequest`，支持 `model` / `priority` / `label` / 会话级 abort），只是没有桥接进 host。

**影响**：P0。§5 的全部产物——场景纪要、自我反思——一条都不会生成。连带失效的还有：`history` / `meta` 两个默认 domain 永远是空的；§9"autoretain 纪要窗口从 raw_log 取"这条 compaction 补偿路径不存在；§8"auto 来源节点跟回滚"没有任何真实数据可跟（手动写的都是 manual）。TEMP 阈值检查因为在同一函数末尾、不依赖侧请求，是唯一还活着的 Phase 3 机制。

**顺带**：即便接上，`AutoretainHost.completeSideRequest(prompt: string)` 的签名没有 model 参数，`AutoretainTask.modelRole: "smol"`（`autoretain.ts:40/61/68`）无处落地——§5"模型角色逐任务可配，默认 smol（omp `providers.memoryModel` 先例）"仍然是空的。§5 要求的 "token 预算 + redact" 也只兑现了 `AUTORETAIN_WINDOW_ROWS = 80` 这半条，redact 完全没有。

**修复方向**：host 加 `completeSideRequest(prompt, opts?: { model? })`，桥到 `runner.createContext().completeSideRequest`；`AutoretainHost` 签名同步加 model；settings 里补一个 memoryModel/smol 的模型解析。

**处置/验证（v5.5，2026-09-11）**：

- `MemoryModuleHost` / `AutoretainHost` 统一必需签名：`completeSideRequest(prompt, { modelRole?: "smol"|"default"; maxTokens?: number; signal?: AbortSignal; label: string })`。
- `_createMemoryModuleHost()` 桥到 `runner.createContext().completeSideRequest()`：单条 user message context（timestamp `Date.now()`）、`findExactModelReferenceMatch` 解析 `memory.autoretain.models.{smol,default}`（未配置回落 session model）、`registerSideRequest` 会话级 abort、`priority 0`、label `memory-autoretain:<task>`。
- `AutoretainTask` 扩展 `maxInputChars`(12000)/`maxOutputTokens`(800)/`redact`(true，Bearer + `api_key|apikey|token|secret|password|authorization` 赋值 → `[REDACTED]`，不改 raw_log)。
- 回归：`test/phase3.test.ts` autoretain 全组（新 host 签名、窗口 provenance first/last_raw_id/anchor_session_id）、`packages/coding-agent/test/memory-module.test.ts` "autoretain everyNTurns:1 consumes a faux side response"（真实 AgentSession 路径）。

### 3. 向量召回整块缺失，且权重折叠破坏了阈值标定（已修：2026-09-11）

**位置**：`packages/memory/src/module.ts:135-137, 397`；`schema.ts` 的 `memory_embeddings`；`config.ts:17`

**现象**：三件事叠在一起。

（a）**没有 embeddings 模块**。`src/` 下没有 `embeddings/`，`memory_embeddings` 表零写入零读取，`settings.memory.embeddings.{mode,model,apiUrl}` 是完全没人读的死配置，`retrieve` 工具的 `semantic` 参数只是原样回填进 details。§12 要求的"`embeddings/` = API 客户端（零依赖 fetch）+ 向量缓存表读写"、§9 的 "chunk 500/overlap 80"、BGE query instruction，一样都没有。

（b）**权重被折叠**：

```ts
let score = (W_VECTOR + W_KEYWORD) * kw + W_PRIORITY * prio;   // 0.85 * kw + 0.15 * prio
```

注释声称"vector 权重折进 keyword 以保持分数量纲，从而 MIN_SCORE / HIGH_CONFIDENCE 仍可比"。这个说法是错的。生产版扩展的注释写得很明确（`nocturne-memory-recall.ts:95-98`）：

> HIGH_CONFIDENCE：the top-ranked item only earns "高度相关，建议读取" when its absolute score clears this bar. **Priority (max 0.15) plus recency (max 0.08) cannot reach it alone — semantic relevance must contribute.**

即 keyword-only 模式下满分是 `0.3*1 + 0.15 + 0.08 = 0.53 < 0.55`，"高度相关"这个锚点在无向量时**按设计就打不出来**。折叠之后 kw≈0.5 就能越过 0.55；MIN_SCORE 0.35 的实际门槛也从"kw ≥ 0.4"松到"kw ≥ 0.24"。

（c）原扩展在 keyword 模式下还额外要求 `s.kw > 0`（这条移植了），但那是为了防"纯 priority 刷分"，不能替代阈值标定。

**影响**：P0。§9 整节的立论是"机制与参数整体迁移自生产验证的调参版，不重新发明"。现在既没有向量通道，阈值又被重标定，注入频率与精度都不是被验证过的那套行为——注入位（TOP_K=3）会被高词频长文档占住，"高度相关"提示会滥发。

**处置（用户决策：补 embeddings，2026-09-11）**：

- 新增 `src/embeddings.ts`：零依赖 fetch 客户端（默认 siliconflow `BAAI/bge-large-zh-v1.5`，`/embeddings`，批量 32，30s 超时，返回向量做 L2 归一化），`chunkText`（500/overlap 80）、`cosine`、`embedHash`、`resolveEmbeddingsConfig`。API key **只从环境变量取**（`PI_MEMORY_EMBEDDING_API_KEY` → `NOCTURNE_EMBEDDING_API_KEY`），settings 里永远不放 key。失败即 latch：一次请求失败后本会话不再重试，直接走 keyword 模式。
- 新增 `src/recall.ts`：**注入与 `retrieve` 共用的唯一打分实现**。双 query（query[0] 带 BGE instruction，其余不带）、逐 query 取最优、keyword 双归一化、recency 三档、`0.55·vec + 0.3·kw + 0.15·importance`。**权重不再折叠**——keyword-only 上限 0.53 < HIGH_CONFIDENCE 0.55，软锚只由语义挣得（生产版原意）。
- 向量缓存落 `memory_embeddings`（`node_id + seg_index`，存 `content_hash` 与 `model`，任一不匹配即失效重算）：`store.loadEmbeddings/saveEmbeddings/pruneEmbeddings`。命中即零 API 调用，实测第二次检索只发一次 query 嵌入请求。
- `retrieve` 工具的 `semantic` 参数**真的生效**了（默认启用，`semantic: false` 强制词法；无 key 自动降级），返回 details 里带 `mode: "vector"|"keyword"`。
- `createMemoryModule` 新增 `embeddings` 覆盖入口，下游/测试可注入自己的客户端。

验证：新增 `test/recall.test.ts` 13 例（禁用条件、失败 latch、分块重叠、缓存命中零调用、内容改动后失效重算、BGE instruction 只加在 intent query、keyword 模式打不出 HIGH_CONFIDENCE、vector 模式能打出、失败降级）。全包 103 例通过。

**新的注意事项见 §27.1 / §27.3**：默认联网、以及 keyword-only 模式下注入近乎静默的代价。

### 4. `MemoryStore.recall()` 忘了按分数排序（已修：2026-09-11，随 #3 重构一并解决）

**位置**：`packages/memory/src/store.ts:550-573`

**现象**：算了 `score` 存进 `scored`，然后：

```ts
return scored.slice(0, limit).map((s) => s.node);
```

**没有 `.sort()`**。候选来自 `listNodes()`（`ORDER BY created_at`），所以返回的是"最早创建的 N 个有命中的节点"。

**实证**：`core://weak`（"咖啡" + 200 字无关填充）先插入、`core://strong`（内容就是"咖啡"）后插入，`recall("咖啡", {limit: 1})` 返回 `core://weak`。

> **证据更正（2026-09-11）**：上面这个例子**不足以证明排序错误**。在双归一化下两条文档的 query-precision 都是 1.0、`priority` 又同为默认值，所以它们**分数相同**，返回 `weak` 只是并列时的插入顺序。缺 `.sort()` 是从代码直接读出的事实（`scored.slice()` 前没有任何排序），但要证明它必须用分数真正不同的例子：查询「咖啡 薇拉」，先插入只含"咖啡摊子"的 `history://half`（query-precision 0.5）、后插入含"咖啡摊子前遇到薇拉"的 `history://full`（1.0），修复前 `limit: 1` 返回 `half`，修复后返回 `full`。现已作为回归用例固定在 `test/recall.test.ts`。

**影响**：P0（功能性）。`retrieve` 工具（`tools.ts:172`）和 `/memories search`（`extensions/memories/index.ts:80`）都走这个函数——角色"想不起 URI 时用关键词搜索"这条主路径返回的是按创建时间排的结果，`limit` 越小越离谱。注意 `module.ts` 里注入用的 `recallForQueries()` 是另一份实现且**排序正确**（`module.ts:409`），所以这个 bug 只在工具侧，也因此更容易被漏掉。

**处置**：没有只加一行 `sort`，而是按"更好的做法"做了：`store.recall()` 与 `module.recallForQueries()` 双实现合并为 `recall.ts` 的 `buildPool()` + `rank()`（`rank` 内含排序），注入与显式检索从此不可能再漂移。两者的差别收敛为参数：注入用 §9 的 `TOP_K`/`MIN_SCORE`，`retrieve` 与 `/memories search` 用 `minScore: 0`（显式检索不设下限，否则搜不出东西）。

回归用例：`test/recall.test.ts` 的 "sorts by score" 与 "ranks bigger importance higher"（后者在无排序时会返回插入顺序，因此同时也是排序守卫）。

### 5. 占位节点（stub）无法转正，永久对召回隐身

**位置**：`store.ts:224 ensureStubAncestors()`、`tools.ts:202 memorize`、`store.ts:_updateNode`

**现象**：`memorize("core://a/b/c")` 会自动补出 `core://a`、`core://a/b` 两个 stub，正文写死为 `(stub: core://a)`，`is_stub = 1`，不进 `node_fts`。之后角色想给这个父节点补真正的内容时：

- `memorize("core://a", ...)` → 被拒："URI 已存在：core://a（改写请用 revise）"；
- `revise("core://a", append: "...")` → 成功，但正文变成 `(stub: core://a)\n父节点真正内容`，**`is_stub` 仍然是 1**。

没有任何代码路径会把 `is_stub` 从 1 改回 0。

**实证**：上述流程跑完后，该节点：`recall("父节点")` 命中为空；`node_fts` 里没有它；`MEM://index` / index slot 的 `!is_stub && parent_id === null` 过滤把它排除；`awaken` slot 与 `MEM://wakeup` 的 `if (!node || node.is_stub) continue` 也跳过它；而 `MEM://diagnostic` 还在"待回填占位节点"里催你去填——填了也没用。

**与设计的出入**：§11 的补充要求原文是"memorize 时自动创建的 placeholder 不能够靠魔法字符串，要在 nodes 表原生引入 `is_stub`，这样全文索引触发器或查询视图增加过滤时看不到垃圾字符串"。`is_stub` 列建了，但（i）魔法字符串还是照写进 `content`，（ii）没有转正路径，把"过滤垃圾"变成了"永久黑洞"。

**影响**：P0。域根节点（`core://`、`life://`…）恰恰是最容易被 stub 化的一批——角色第一次写 `core://identity/habits` 就会把 `core://identity` 变成永久隐身的 stub。`seed()` 只预建了 `index:// / history:// / meta://` 三个根，其余全靠自动补位。

**修复方向**：`put()`/`revise` 写入已有 stub 时清 `is_stub = 0` 并覆盖（而不是追加）占位正文；`memorize` 对 stub 目标不应报"已存在"，而应视作转正写入；stub 的占位正文改为空串（`content` 允许空，渲染时用 uri 兜底），彻底去掉魔法字符串。

**处置/验证（v5.5，2026-09-11）**：

- `ensureStubAncestors()` 的 stub `content` 固定为空串（不再写 `(stub: URI)`）。
- `_updateNode()` 检测 stub 收到正文 → 原地转正（`is_stub=0`），覆盖空占位、不生成垃圾修订、进入 FTS、透传 provenance 字段。
- `executeMemorize()`/`applyReviseMod()`：目标是 stub 时调用 `put()` 转正（不报"已存在"），`editor_source:"manual"` 补 custody 链。
- 回归：`test/store.test.ts` "put() onto a stub promotes it"、"stub ancestors never enter FTS/recall"；`test/tools.test.ts` "memorize onto a stub promotes it"、"revise with a body edit promotes a stub"。

### 6. `forget` 连修订史一起删，删除后无任何找回路径（已修：2026-09-11）

**位置**：`store.ts:347 _deleteCascade()`

**现象**：级联删除时一并 `DELETE FROM node_revisions WHERE node_id = ?`。

**实证**：节点改过一次（有 1 条 revision），`deleteCascade` 之后 `listRevisions()` 返回 0。

**与设计的出入**：§10 结尾原文：**"删除后的找回路径是 node_revisions——不留无入口的僵尸节点。"** 工具对照表里 `forget` 那一行也写着"删除时自动备份"。两者都没实现：既没有备份，修订史也一起没了。（§14 决策 10 的"delete = 真删，无归档层"与 §10 这两句本身就互相冲突，见 #26。）

**对照 nocturne**：那边是三段式——`deprecated` 软删（`_deprecate_node_memories`）→ 孤儿池（`get_all_orphan_memories` / `get_orphan_detail` / `restore_orphan_memory`）→ `permanently_delete_memory` 显式硬删。角色误删有救。

**影响**：P0（不可逆）。`forget` 支持批量 + 子树级联，一次误操作可以静默清掉一整棵子树，`dry_run` 是唯一防线。

**处置（用户裁定，2026-09-11）**：两句都算数，此前是把"真删"读错了。定案口径写进决策 10 与 25：

> **delete = 真删** 指的是**不像 nocturne 那样留僵尸节点**（那边 `remove_path` 只拿掉入口，memory 行还挂在孤儿池里，`get_all_orphan_memories` / `restore_orphan_memory` 一整套）。pi-rp 这边节点行**物理删除**，没有 deprecated 标记、没有孤儿池、没有"看不见但还在"的中间态。**但数据不丢**：删除时把当前正文归档为最后一版，`node_revisions` 全部保留——找回路径就是它。

落地：

- `node_revisions` 新增 `uri` 列（+索引）：节点行没了之后修订仍可寻址。`archiveRevision()` 逐版写入 uri。
- `_deleteCascade()` 不再 `DELETE FROM node_revisions`；删除前先把当前正文归档（否则最新一版会随节点消失），并把该节点的历史修订补上 uri。
- 新增 `listRevisionsByUri(uri)`（带 `alive` 标记）、`listDeletedUris()`（只在修订里存在的 uri + 版本数 + 最后时间）、`restoreDeleted(uri)`（用**原 node_id** 重建，见 §27.4）。
- 级联删除的子节点同样逐个留史。

验证：`test/store.test.ts` 新增 3 例（真删但留史、列出并还原、级联留史）。

**遗留**：角色侧仍然够不到这条路径——工具面没有任何入口读修订史或还原删除（就是 #13）。目前只有 store API。补 `revise(action: "history"|"restore")` 之后 #6 才算对角色成立。

---

## P1

### 7. `relocate` / `rename` 不搬子树

**位置**：`store.ts:366 rename()`

**现象**：只更新本节点一行的 `uri` 与 `domain`：

```sql
UPDATE nodes SET uri = ?, domain = ?, updated_ts = ? WHERE node_id = ?
```

子节点的 `uri` 前缀、`domain` 全部原地不动（`parent_id` 指针仍然正确，所以树结构没断，但地址空间断了）。

**实证**：`core://parent` + 子节点 `core://parent/child`，`rename("core://parent", "life://moved")` 之后：父节点是 `life://moved|life`，子节点仍是 `core://parent/child|core`。此时 `recall("life://moved", depth: 1)` 能列出这个 uri 前缀完全对不上的子节点；`MEM://index` 里 `core` 域凭空多出一个"根节点"（子节点 `parent_id` 非 null，所以也不会显示为根，等于彻底失踪）。

**对照 nocturne**：`graph.py` 的 `_get_subtree_path_rows` / `_cascade_create_paths` / `_delete_subtree_paths` 是整棵子树的路径重建，`add_path`/`remove_path` 也都是子树语义。

**影响**：P1。`relocate` 的工具描述明写"可跨域"，跨域移动一个有子节点的主题就会产生上述状态；`consolidate(group)` 内部也调 `rename`（见 #8）。

**修复方向**：`rename` 里对整棵子树做前缀重写（uri 与 domain 一起），旧地址逐个进 `aliases`；或至少在 `relocate` 层检测到有子节点时拒绝并提示。

**附带**：`rename` 若以别名作为 `oldUri` 调用（`resolveUri` 支持别名），则登记进 `aliases` 的是那个别名，**旧的规范 URI 反而没有被保留成别名**，链就断了。

**处置/验证（v5.5，2026-09-11）**：

- 新增 `relocateMany(moves)` 原子批量子树迁移：预解析 canonical URI（经 alias 发起也以当前 canonical 为旧根）、3 pass 预检（源解析/跨批冲突+目标嵌套/目标占用，冲突在写入前整体抛错零改动）、`ensureStubAncestors` 补占位父链、根 `parent_id` 挂到目标隐式父、全部后代 URI 按 canonical 前缀重写 + domain 改目标 scheme、旧 canonical URI 全链路保留为 alias（既有 alias 保留）、`_remapAwakenUris` 前缀替换、逐节点重建 FTS。`rename()` 收敛为单 move 薄封装。
- 回归：`test/store.test.ts` "relocateMany moves a whole subtree"（跨域、alias、reparent）、"relocateMany is atomic"（冲突零改动）。

### 8. `consolidate` 的 `group` 不真的分组

**位置**：`tools.ts:490`

**现象**：`resolution: "group"` 的实现是把每个源节点 `rename` 到 `target_uri/<最后一段>`，但 `rename` 不动 `parent_id`（#7），所以源节点并没有挂到主题节点下面。

**实证**：`TEMP://a`、`TEMP://b` 两条 group 到 `core://theme`，输出"已整理 2 条 → core://theme（group）"，但 `children(theme)` 为空，三个节点的 `parent_id` 全是 null。工具描述承诺的是"建主题摘要并把源记忆移到主题下"。

**影响**：P1。这是 §7 TEMP 整理流程的主力工具——notify 模板里就写着"revise/consolidate 归位"。角色以为整理完了，实际只是把 URI 改了个名字，`recall(theme, depth: -1)` 看不到任何被归并的内容。另外源节点从 `TEMP://` 改名到 `core://` 后 TEMP 计数确实降下来了，所以 §7 的"清到零"纪律表面达成、实质是空的。

**修复方向**：随 #7 一起修（rename 支持 reparent），或在 group 分支里显式设置 `parent_id`。

**处置/验证（v5.5，2026-09-11）**：

- `executeConsolidate(group)`：先预检（源末段重名 / 目标占用 / 目标在源子树内 / 源互为祖先，冲突时不建主题、不移动任何源）→ `put()` 建主题 → `relocateMany` 把每个源根移到 `target_uri/<源末段>`，移动后源根 `parent_id` = 主题 node_id，源子树一并移动。
- 回归：`test/tools.test.ts` "consolidate group parentage"（`children(theme)` 与 `parent_id`）、"rejects grouping a source into its own subtree"。

### 9. `put()` 更新已有节点会把 `world_ts` 抹成 null

**位置**：`store.ts:215`

```ts
this._updateNode(existing.node_id, { content: input.content, world_ts: input.world_ts ?? null });
```

`NodePatch.world_ts` 的语义是 `undefined` = 不改、`null` = 清空，这里把"调用方没传"翻译成了"清空"。同时 `importance` / `disclosure` / `priority` / `model` / `anchor_entry_id` 在 upsert 路径上被静默丢弃。

**实证**：世界钟 `2026-01-01`，`put({uri, content: "v1"})` 后 `world_ts = 2026-01-01`；再 `put({uri, content: "v2", importance: 2, disclosure: "when2"})` 后 `world_ts = null`，`importance`/`disclosure` 保持旧值。

**影响**：P1。`memorize` 因为对已存在 URI 提前返回而躲过了，但 **autoretain 的 `replaceStale` 落点策略**（`autoretain.ts:121`）和 **`consolidate` 目标 URI 已存在**时都会踩到——纪要节点的世界时间被清空，直接影响 §9 的 recency 加成与 `MEM://timeline` 的可读性。

**修复方向**：`world_ts: input.world_ts ?? undefined`（不传就不改），并把 upsert 的其余字段透传下去。

**处置/验证（v5.5，2026-09-11）**：

- `put()` 透传改为 `world_ts: input.world_ts ?? undefined`（`undefined`=不改，显式 `null` 才清空）；`_updateNode` 同规则，并透传 `disclosure/importance/model/anchor_entry_id/anchor_session_id/first_raw_id/last_raw_id/world_ts`。
- 回归：`test/store.test.ts` "upsert without world_ts never wipes an existing world timestamp"。

### 10. `importance` 与 `priority` 两列脱节（已修：2026-09-11 合并为单列 `importance`，并反转极性）

**位置**：`schema.ts:11-12`（两列并存）、`tools.ts:209/299/467/480`（只写 `importance`）、`module.ts:397` 与 `store.ts:568`（只读 `priority`）

**现象**：`nodes` 表同时有 `priority` 和 `importance`，默认都是 5。所有工具（`memorize` / `revise` / `consolidate`）暴露给角色的参数叫 `importance`，写的也是 `importance` 列；而召回打分、`MEM://recent` 的星级、`MEM://forgotten` 排序、diagnostic 的 stale 阈值，读的全是 `priority` 列——那一列永远是默认值 5。

**实证**：`memorize(uri, content, importance: 0)` 之后节点是 `{ importance: 0, priority: 5 }`。

**与设计的出入**：§3 schema 里这两个字段是写在一起的（`priority/importance`），从没定义过它们的分工；生产版扩展里只有一个概念（`SearchDoc.priority`，注释："importance 0 = most important -> prio score 1.0"），即 nocturne 的 `edge.priority` 就是角色设的重要性。这里是移植时把一个概念拆成了两列，然后写一列读另一列。

**影响**：P1。角色标记"这条极其重要（importance 0）"对召回排序、沉睡诊断、注入优先级**完全没有影响**。§9 权重表里 priority 占 0.15，等于恒定常数。

**处置（用户决策，2026-09-11）**：不需要两列，统一保留 `importance` 一个命名。已落地：

- `schema.ts` 的 `nodes` 删掉 `priority` 列，只留 `importance INTEGER NOT NULL DEFAULT 5`；`MemoryNode` / `NodeInput` / `NodePatch` / `NodeRow` 同步去掉 `priority`，`export()/import()` 的列清单跟着收窄。
- `module.ts` 的 `priorityScore()` → `importanceScore()`、`W_PRIORITY` → `W_IMPORTANCE`（值仍是 0.15）。
- `memory-views.ts` 的星级、`MEM://forgotten` 排序、diagnostic 的 stale 阈值全部改读 `importance`；`/memories` 的 `[★N]` 同理。
- **顺带修掉一处极性反转**：`store.recall()` 原本算的是 `node.priority / 10`（数字越大分越高），与 `module.ts` 的 `1 - p / 10`（0 = 最重要）方向相反。现已统一为 `1 - importance / 10`，两处同口径。

验证：`packages/memory` 87 个测试全绿；`packages/memory` 与 `packages/coding-agent` 的 tsgo 类型检查均通过。设计文档 §3 与决策清单已回冲（v5.3）。

**极性反转（用户决策，2026-09-11 第二轮）**：`importance` 改为**数值越大越重要**（10=最重要 / 5=普通 / 0=边角料），与"重要性"这个词的直觉一致。落地：打分 `importanceScore = importance / 10`（原 `1 - i/10`）；`memorize` 参数描述改写；`MEM://forgotten` 与 diagnostic 的排序改为重要性降序；diagnostic 的沉睡阈值表从 `{0:3, 1:7, 2:14}` 翻成 `{10:3, 9:7, 8:14}`（越重要越不该久睡）。设计文档 §3 与决策 24 同步。

**注意**：这次反转**没有做数据迁移**（§0 第 3 条：不迁移不兼容，冷启动重建）。如果已经有库按旧口径写过 importance，那些数值现在的含义正好相反——要么冷启动，要么自己写一行 `UPDATE nodes SET importance = 10 - importance`。

**遗留（已解决）**：`test/store.test.ts` 的 `ranks by keyword overlap with importance weight` 曾是**假阳性**——它断言的 `hits[0]` 只是插入顺序的产物（见 #4，`store.recall()` 没排序）。极性修正后，正确的排名结果应当是 `history://forest`（importance 1）而不是 `history://tavern`（importance 9）。修 #4 时必须一并把这条断言翻过来。**极性反转后它自动变成了正确断言**：`tavern`（importance 9）确实应该排在 `forest`（importance 1）前面，现在它是因为真实原因通过的。

### 11. 纪要节点缺原文区间引用，§4 的回溯链断裂

**位置**：`schema.ts:4-21`（`nodes` 无相关列）、`autoretain.ts:119 landingUri()`、`tools.ts:507 retrace`

**现象**：§4 明写"**消费**：场景纪要节点存原文区间引用（first_raw_id/last_raw_id），agent 由纪要 id 直接取原文"。`nodes` 表没有这两列。autoretain 只把区间编进 URI 后缀（`history://scene-summary-12-40`），而且这只在 `strategy: "append"` 且模型**没有**自带 `uri` 时才成立——`parseAutoretainJson` 允许模型返回自己的 `uri`（`autoretain.ts:155`），一旦返回，区间信息彻底丢失。

**影响**：P1。`retrace` 工具只接受裸 `raw_id`，角色拿着一条纪要节点没有任何办法定位它对应的原文区间——§4 给 raw_log 立的三条价值中的一条（"由纪要 id 直接取原文"）不成立。

**修复方向**：`nodes` 加 `first_raw_id` / `last_raw_id` 两列（可空），autoretain 落点时写入，`retrace` 支持 `uri` 参数直接按纪要取区间。

**处置/验证（v5.5，2026-09-11）**：schema + `MemoryNode`/`NodeInput`/`NodePatch` 加 `first_raw_id`/`last_raw_id`/`anchor_session_id`；`runAutoretainTask` 写 `first_raw_id=window[0].raw_id`、`last_raw_id=window.at(-1).raw_id`、`anchor_session_id`；`retrace(uri=...)` 校验节点具有 first/last 后按 `anchor_session_id + 区间` 回取。回归：`test/phase3.test.ts` "lands the product ... provenance stamped"（first/last_raw_id）、`test/tools.test.ts` "uri mode returns the raw window anchored by first/last raw ids"。

### 12. 回滚后 raw_log 的"重建"丢时间戳与顺序，且要等下一个回合才发生

**位置**：`module.ts:589-614 onTurnEnd()`、`agent-session.ts:2532-2537`、`MemoryTurnMessage` 定义（`module.ts:58`）

**现象**：§4 的对账逻辑是"物理删除活动路径之外的行……切回旧分支后可按最新活跃树重建"。实现里的"重建"是这样发生的：切分支时引擎把离开路径的 entry 从 `_memorySeenEntryIds` 里剔除（`agent-session.ts:2533`），于是**下一次 turn_end** 时 `getTurnMessages()` 会重新收集这些 entry 并 append。三个问题：

1. **时间戳被污染**：`MemoryTurnMessage` 没有 timestamp 字段，`onTurnEnd` 统一写 `wall_ts: new Date().toISOString()`、`world_ts: 当前世界钟`。重建出来的行带的是"重建时刻"，不是消息原本的时间。jsonl 里有真实时间戳，只是没取。
2. **raw_id 全变且顺序错乱**：重建行拿的是新的自增 id，排在最新行之后。`MEM://timeline` 按 `raw_id DESC` 渲染，切回旧分支后老对话会浮到时间轴顶部；已有纪要里编码的区间（#11）全部失效。
3. **不切实发生**：只有"切回去之后又跑了一个回合"才会重建。用户切回旧分支只是浏览、或者切回后就退出，那段原文就一直不在库里。

**影响**：P1。§4 把"删除不破坏审计"这个论断整个压在"可重建"上，实际的重建是有损且惰性的。

**修复方向**：`MemoryTurnMessage` 带上 entry 的原始时间戳与 world_ts（写入时优先用它）；`onLeafChange` 里主动做一次补齐（按活动路径与库内已有 entry_id 求差集补写）而不是等下一个回合；raw_log 的排序键改为 `(wall_ts, raw_id)` 或显式 `seq`。

**处置/验证（v5.5，2026-09-11）**：

- `MemoryTurnMessage.timestamp` 必需（entry 原始时间戳）；`raw_fts`/`node_fts` 按稳定 ID 存；`onLeafChange` 调 `getActiveBranchMessages()` 后立即 `syncRawBranch(sessionId, messages)`（resume/浏览也补齐，不等下一回合）。
- `onTurnEnd` 单遍保序 append（custom message 交错，§22 一并解决），每条用自身 timestamp 作 wall_ts;已存在行只更新 role/text/wall timestamp，**不覆盖已存 world_ts**;`syncRawBranch` 冷补先用当前 world clock 填新行。
- 回归：`test/module.test.ts` "appends this turn's messages ... original timestamps and world_ts"、"syncs raw_log to the active branch"；`test/store.test.ts` "upsert does not overwrite a previously persisted world timestamp"。

### 13. `node_revisions` 没有读端

**位置**：`tools.ts`（12 个工具无一涉及）、`store.ts:329 listRevisions()` / `store.ts:335 restoreRevision()`

**现象**：store 层有 `listRevisions` / `restoreRevision`，但没有任何工具、slot、`/memories` 子命令暴露它们。`revise` 只写不读。

**与设计的出入**：§3 明写"修订回滚 = 指定 version 重新生效"；§6"修订 custody 链……版本史连成链"；§12 决策 20 还专门为它设计了 `memory.revisions.retention` 裁剪策略（该配置项同样没有实现）。

**影响**：P1。角色无法查看自己某条认知的历史版本，也无法回滚一次写坏的 revise——而 §6 把"版本史即 custody 链"当成署名体系的一部分。同时因为 #6，删除时这些数据还会一起消失，等于整张表只在为 `content_hash` 变更留一份没人看的影子。

**修复方向**：`revise` 增加 `action: "history" | "restore"` + `version` 参数，或独立成 `revise(uri, restore_version: N)`。

**处置/验证（v5.5，2026-09-11）**：

- `revise` 增 `action: "edit"|"history"|"restore"`（默认 edit）。`history + uri`：活节点按 node_id 返回 revisions（现行正文标 current），已删节点按 `listRevisionsByUri` 返回完整版本链;`history` 无 uri：`listDeletedUris()` 列出可恢复 URI。`restore + uri + version?`：活节点必传 version（`restoreRevision`），已删节点 `restoreDeleted(uri, version?)`（缺省最新，不存在的版本返回明确错误且不创建节点）。非 edit action 拒绝 batch/编辑字段。
- 回归：`test/tools.test.ts` "history lists revisions with the live content marked current"、"history without uri lists recoverable deleted uris"、"restore on a deleted uri revives the newest version; a missing version errors"。

### 14. FTS 表写而不读；jieba 每次调用重建词典

**位置**：`schema.ts:52-54`、`store.ts:726 indexNodeFts()`、`tokenize.ts:37-45`

**现象**：`node_fts` / `raw_fts` 两张 FTS5 表在每次写入时维护，但代码里**没有任何一处 `MATCH` 查询**（schema 注释自己承认："Currently write-side only"）。`retrieve` 的工具描述写的是"默认词法（BM25/分词打分）"，实现是 `listNodes()` 全表扫 + 对每个节点重新 `tokenizeForMatch(uri + disclosure + content)`。注入路径（`module.ts:370`）同样每个 prompt 全表扫 + 全量重分词。

`tokenize.ts:44` 更直接：

```ts
if (mod) return new mod.Jieba(mod.dict, mod.idf).cutForSearch(text).join(" ");
```

每调用一次就构造一个 Jieba 实例（加载完整词典 + IDF）。而这个函数唯一的调用点就是往没人查的 FTS 表里写。

**与设计的出入**：§3 把两张 FTS 表列为 schema 核心；§10 `retrieve` 定义为"混合检索（BM25 词法 + 向量语义）"；§15.2 专门为分词质量接受了 `@node-rs/jieba` 的原生依赖代价。目前这三项投入的产出为零。

**影响**：P1（性能 + 名不副实）。写入成本被 jieba 重建词典放大；查询成本随节点数线性增长且每个 prompt 都付一次；库大了之后注入延迟会很显眼。另外 query 侧用的是 bigram（`tokenizeForMatch`），doc 侧 FTS 用的是 jieba 词——两套 token 空间不一致，将来直接开 MATCH 也会命中率异常。

**修复方向**：jieba 实例做模块级单例；`retrieve` 走真正的 `node_fts MATCH` + bm25 排序；query 侧与 doc 侧统一用同一个分词器。

**处置/验证（v5.5，2026-09-11）**：

- `tokenize.ts` 重写为模块级单例（`Jieba.withDict(dict)` 仅一次；`@node-rs/jieba` 不可用回落 latin + CJK bigram，两侧同一 `tokenizeForSearch`）。
- `node_fts`/`raw_fts` 重建为 `fts5(node_id UNINDEXED, text)`/`fts5(raw_id UNINDEXED, text)`；`reindexNode` 统一分词（uri+disclosure+glossary 完整词+content；stub 跳过）。
- 新增 `searchNodeFts(queries)`（quoted term + OR + 绑定参数 MATCH、glossary 完整 token 附加、返回每节点最优 BM25）与 `searchRawFts`（join raw_log 过滤 active=1）——两张 FTS 都有真实读端;keyword 候选集 = FTS 命中。
- 回归：`test/store.test.ts` "stub ancestors never enter FTS/recall"、"rename keeps old uri as working alias"；`test/recall.test.ts` "candidates come from FTS"；`test/tools.test.ts` "query mode searches active raw rows"。

### 15. `glossary` / `edges` 是死表

**位置**：`module.ts:216 keywordScore()`、`store.ts:389 addEdge()`、`tools.ts:425 trigger`

**现象**：
- **glossary**：`trigger` 工具写入关键词，`MEM://glossary` 能列出来，但**召回打分完全不看它**——`keywordScore` 的文档串是 `uri + disclosure + content`。生产版扩展是 `uri + disclosure + searchTerms + content`（`nocturne-memory-recall.ts:335`），`searchTerms` 就是 glossary 拼进去的。nocturne 更进一步：`search_terms.py:43 register_custom_words()` 把专名 `jieba.add_word()` 注册进词典，这才是 §3"专名表（专名→节点，提升分词命中）"的完整机制。
- **edges**：`store.addEdge()` 存在，但**没有任何工具或内部路径调用它**，召回也没有任何图扩散逻辑。`associate` 走的是 `aliases`（别名），不是 edges。§3 给 edges 的定义是"联想图（检索扩散面）"。

**影响**：P1。角色埋触发词这个动作（工具描述："触发词提升分词命中"）对检索**没有任何效果**，属于对角色的功能性欺骗。edges 则是一张永远为空的表 + 一段永不执行的 store API。

**修复方向**：glossary 拼进打分文档串并注册进 jieba 自定义词典；edges 要么补上写入工具与召回扩散，要么从 schema 里删掉并更新 §3。

**处置/验证（v5.5，2026-09-11）**：

- **glossary**：完整专名作为额外 token 进 `node_fts` 文本与 query 侧（`searchNodeFts` 对含 glossary keyword 的 query 追加完整 keyword;`buildGlossaryTerms` 喂给 `keywordScore` 的 extraTerms）——专名可召回正文不含触发词的节点，且**不注册进全局 jieba 词典**（避免跨 DB 污染）。`trigger` 增删自动 reindex 节点。
- **edges**：保留为联想图，`associate` 增 `related_uri`+`kind` 互斥模式写入;显式 `retrieve` 对直接命中按排名做一跳扩散（`listRelated` 双向、标注 direction，附加节点标 `via_edge/kind/from_uri`、不占 direct limit、总截 limit）；**自动注入不做图扩散**（保持 #3 已固定的召回权重/TOP_K 语义）。
- 回归：`test/recall.test.ts` "recalls a node whose glossary keyword matches even when the body does not"；`test/tools.test.ts` "related_uri mode creates a directional edge"、"retrieve diffuses one hop through edges"。

### 16. 无访问追踪，"沉睡"语义走样

**位置**：`memory-views.ts:39 renderForgottenView()` / `:150 renderDiagnosticView()`、`schema.ts`（无 `last_accessed_at`）

**现象**：pi 侧用 `updated_ts`（最后一次**修改**时间）当"沉睡时长"，而 recall / retrieve / 注入读取节点时不更新任何时间戳。nocturne 有 `Node.last_accessed_at` + `MemoryAccessLog` 表 + `log_access()`，`get_forgotten_nodes` 的口径是"有 last_accessed_at 用它，没有的回落 created_at（从未访问 = 出生即沉睡）"。

**影响**：P1（语义错误）。§13 Phase 3 明确 "forgotten 语义 = 捞沉睡最久的活记忆"。现在实际口径是"最久没被编辑的记忆"——一条天天被召回、从不修改的核心设定会被判为"沉睡 300 天"，一条刚被 autoretain 批量改过的边角料则显示为"刚想起"。diagnostic 的 stale 判定同理。

**修复方向**：`nodes` 加 `last_accessed_at`，在 `recall` 工具命中、注入命中、slot 渲染时更新（注入更新与否需要定义：建议只在角色**主动** recall 时更新，注入不算"想起"）。这也可以顺带给 §9 提供一个真正的 recency 信号。

**处置/验证（v5.5，2026-09-11）**：`last_accessed_at` 列 + `markAccessed(nodeIds)` 批量更新（不改 `updated_ts`）;仅 `recall` 精确/子树、`retrieve` 命中节点调用;自动注入、slot、MEM 系统视图、`/memories` 浏览不 touch。`renderForgottenView`/`renderDiagnosticView` 沉睡基准 = `last_accessed_at ?? created_at`。回归：`test/phase3.test.ts` "forgotten renders the least-recently-accessed live memories"、"diagnostic reports stale / crowded / placeholder issues"。

### 17. `/memories` 打开的可能不是会话那个库

**位置**：`packages/coding-agent/src/extensions/memories/index.ts:24`

```ts
const dbPath = resolveMemoryDbPath(process.env.PI_MEMORY_DB, undefined, undefined, ctx.cwd);
```

而会话侧是 `resolveMemoryDbPath(process.env.PI_MEMORY_DB, settings, undefined, this._cwd)`（`agent-session.ts:4090`）。settings 被传成了 `undefined`。

**影响**：P1。用户在 settings 里配了 `memory.dbPath`（§2 明列的解析链第二档）时，`/memories` 会去 `<cwd>/.pi/memory.db` ——那个路径不存在的话 `openMemoryStore` 会**建一个空库**并建表。用户看到的是"记忆库是空的"，同时磁盘上多出一个幽灵库。文件头的注释还写着"so /memories browses the tree the session is actually writing to"，与实现相反。

**修复方向**：把 settings 传进去（扩展 ctx 能拿到 settings 的话直接用；拿不到就从 AgentSession 暴露一个"当前 memory db path"给扩展）。

**处置/验证（v5.5，2026-09-11）**：`ExtensionContext`/`ExtensionContextActions` 增只读 `getMemoryDbPath(): string | undefined`（AgentSession 返回当前 `_memoryDbPath`）;interactive-mode 快捷 ctx 同步实现。`/memories` 改用它打开 store（不重算路径），初始化失败路径为空时提示 "Memory store unavailable"，不得创建默认幽灵库。回归：`test/memory-module.test.ts`（dispose 用例顺带验证共享 store 文件可查询）。

### 18. autoretain 多任务共用一个 raw_id 游标

**位置**：`module.ts:481-500`

**现象**：游标是全局单值 `autoretain_last_raw_id`，在**任务循环外**读一次，循环内每个成功的任务都写一次。

**影响**：P1。默认两个任务周期都是 4，暂时看不出来；一旦下游按 §5"周期全部自定义"注册了不同周期的任务（比如纪要每 4 回合、反思每 20 回合），每 20 回合的反思任务能看到的窗口只是"上一个纪要任务推进之后新增的那几行"，拿不到它本该回看的 20 回合。§5 的"回看 n 回合行动"因此不成立。

顺带两个小问题：（i）`lastProcessed` 在循环外只读一次，同轮多任务实际拿的是同一个窗口（这个行为是对的，但依赖读取时机而非显式设计）；（ii）游标是 raw_id，而 raw_id 会因分支对账被物理删除（#1/#12），游标可能指向一个已经不存在的位置。

**修复方向**：游标改为 per-task（`autoretain_last_raw_id:<task.name>`）。

**处置/验证（v5.5，2026-09-11）**：新增 `autoretain_progress(session_id, task, entry_id, processed_at)`（PK 三者）;每个到期任务用 `listUnprocessedActiveRaw(sessionId, task, limit)` 取本 session 活动分支中该任务未消费的行，成功后在**同一事务** `markAutoretainProcessed(sessionId, task, entryIds)`，失败不写进度;不同任务、不同 session 不互吞窗口，离枝再回的低 raw_id 行不永久跳过;不再用会因分支切换绕过的单值 raw-id 游标。回归：`test/phase3.test.ts` "module onTurnEnd fires due autoretain tasks via host.completeSideRequest"（per-task 窗口 + 进度）;`test/store.test.ts` syncRawBranch/appendRaw 幂等。

### 19. 审计只覆盖写路径，三列永远为空

**位置**：`store.ts:702 logAudit()`、`schema.ts:75-88`

**现象**：`audit_log` 建了 `turn` / `task` / `anchor` 三列，但 `logAudit()` 的签名是 `{ object?, source?, model?, details? }`——这三列**永远是 NULL**。事件覆盖面上，写/改/删/rename/glossary/对账/世界钟/seed/import/autoretain 有记录，**召回与注入两类完全没有**（`recallForQueries` 与 `handleBeforeAgentStart` 里没有任何 `logAudit`）。

**与设计的出入**：§12 决策 23 原文列举的是"每次对外动作（写入/编辑/删除/**召回**/**注入**/autoretain 任务产出）都出一条 append-only 结构化审计记录（时间 + world_ts、事件类型、对象（node_id / 原文区间）、来源与模型、**所在回合/任务**、**anchor**）"。

**影响**：P1。§12 给审计定的目的是"下游可用它对账、复盘、解释'记忆发生了什么'"——恰恰是"为什么这条记忆被注入了/没被注入"最需要留痕，而这正是缺的那部分。另外 `object` 存的是 uri 字符串而非 node_id，rename 之后无法回溯同一节点。

**修复方向**：`logAudit` 签名补 turn / task / anchor / node_id；注入与召回各记一条（含命中 uri、分数、mode）。

**处置/验证（v5.5，2026-09-11）**：

- `MemoryAuditDetails` 精确字段 `{node_id, object, source, model, turn, task, anchor, details}`，`logAudit` 写满对应列（audit_log 加 node_id 列）。
- 工具 `recall`/`retrieve` 各写一条 `recall` audit（query/URI、命中 node ids、scores/mode、session turn、model、anchor）;`handleBeforeAgentStart` 只在真正返回 fresh 注入时记 `inject`;autoretain 的 `autoretain_task`/`autoretain_product` 写 task/turn/anchor/node_id/model，失败任务也留 audit;rename 的 details 记录 old/new URI。
- `MemoryToolContext` 动态 `sessionId`/`turn`/`isVisible`（getter，reload/turn 切换不冻结）。
- 回归：`test/store.test.ts` "writes the full MemoryAuditDetails column set"。

---

## P2

### 20. preset 这一档没接

`agent-session.ts:4090` 给 `resolveMemoryDbPath` 的第三个参数恒为 `undefined`。§2 与 Phase 1 定义的是"CLI `--memory-db` > settings > preset"三级链，实际只有两级（CLI 经 `PI_MEMORY_DB` 环境变量传递，`main.ts:646`）。`PresetMemoryDeclaration` 类型定义在 `config.ts:21` 但无人构造。

**处置/验证（v5.5，2026-09-11）**：`PromptPreset` 与 loader 增 `memory?: { dbPath?: string }`（仅接受非空字符串）;抽出 `_ensureActivePresetRestored()`（`_setupMemoryModule` 前确定 `_activePreset`）;路径链 `PI_MEMORY_DB > settings.memory.dbPath > activePreset.memory.dbPath > <cwd>/.pi/memory.db`;`setActivePreset` 新旧解析路径不同时 `requestReload()` 干净重绑，不在同一 runner 上叠加第二个 synthetic memory extension。回归：`test/memory-module.test.ts` "activePreset memory.dbPath takes part in the resolution chain";`test/tools.test.ts` "follows CLI > settings > preset > default precedence"。

### 21. `Settings.memory` 缺 `temp` 与 `autoretain.tasks`

`settings-manager.ts:151-162` 的 `memory` 字段有 `dbPath / rawLog / autoretain.everyNTurns / recall / embeddings`，缺 `temp.threshold`（包里 `config.ts:16` 有、`module.ts` 读了）与 `autoretain.tasks`（§5 任务注册制的下游入口，`config.ts:14` 有）。结果：§7 的"阈值默认 10，可调"和 §5 的"下游可增删改任务——提示词、落点、周期全部自定义"在 settings 层没有出口。

**处置/验证（v5.5，2026-09-11）**：`Settings.memory` 直接复用包导出 `MemorySettings` 全量契约（`temp`/`autoretain.tasks|models`/`revisions`/`recall.keywordMinScore` 全部成 settings 可配字段）;深合并保留任务数组与嵌套字段。回归：`test/settings-manager.test.ts` "merges nested memory fields across global and project without losing the tasks array"、"memory array fields override wholesale"。

### 22. 同回合 raw_log 行序与真实消息序不符

`module.ts:593-614`：先把所有普通消息映射成 `rows`，再把 captured 的 custom message 映射成 `captured`，然后 `appendRaw([...rows, ...captured])`。同一回合内如果既有普通消息又有被收编的 custom message，raw_id 顺序不等于消息发生顺序。影响 `MEM://timeline` 的可读性与 autoretain 窗口的上下文连贯性。应按 `getTurnMessages()` 的原始顺序一次映射。

**处置/验证（v5.5，2026-09-11）**：`onTurnEnd` 改为单遍遍历 `getTurnMessages()`，**在原始顺序中**同时处理普通与 custom message（各自带自身 timestamp），删除 `[...rows, ...captured]` 两段拼接。回归：`test/module.test.ts` "captures custom messages per the three-way switch"（`rp-state` 与 user 行序按原序）+ "appends this turn's messages to raw_log with original timestamps and world_ts"。

### 23. `export()/import()` 丢 aliases / edges / glossary

`store.ts:628` 的快照范围是 `nodes + node_revisions + memory_kv`，注释说明 aliases/edges/glossary 是"derivable maintenance state"。这个判断不成立：`aliases` 由角色用 `associate` 亲手建（§10："建立联想通路……让事件在多处自然通达"），`glossary` 由 `trigger` 亲手埋，两者都是不可推导的角色资产。§12 把 `export()/import()` 定义为"供迁移/备份/审计"，按当前范围迁移一次就丢一批。（`awaken_uris` 在 kv 里，这个没丢。）文档 §12 的措辞同样只写了"树 + 修订 + kv"，所以这条要连设计一起改。

**处置/验证（v5.5，2026-09-11）**：`ExportSnapshot` 增 `aliases`（alias_uri→target_node_id）、`edges`（node_id/target_uri/kind）、`glossary`（keyword/node_id）三类资产;`export()` 按键排序输出;`import()` 在 nodes/revisions 后恢复三类资产并重建每个活节点 FTS，输入引用不存在节点立即抛错并**整体回滚**。§12 措辞已同步（"nodes + revisions + kv + aliases + edges + glossary"）。回归：`test/store.test.ts` "export includes aliases, edges and glossary; import restores them"、"import rejects non-existent targets and rolls back the whole snapshot"。

### 24. `reconcileRawLog` 每次切分支全表扫描

`store.ts:486`：`SELECT raw_id, entry_id FROM raw_log`（全表）→ JS 侧过滤 → 分块删除。§4 决定 raw_log 永久不裁剪、无限增长，于是每次 reroll / 切分支的成本随历史总量线性增长。`idx_raw_log_entry_id` 索引建了但这条路径用不上。应改为 SQL 侧的 `DELETE ... WHERE entry_id NOT IN (临时表)`，或至少限定在最近 N 条内（配合 #1 的 session_id 一起做）。

**处置/验证（v5.5，2026-09-11）**：`syncRawBranch` 在**连接级 TEMP 表** `_raw_active` 装载本 session 活动 entry ids，用一条 `UPDATE raw_log SET active=0 WHERE session_id = ? AND entry_id NOT IN (SELECT entry_id FROM _raw_active)`——活动路径判定下沉到 SQL，**不读取/不扫描其他 session 的行到 JS**;只更新本 session 行。切回旧分支只把旧行重新置 active。回归：`test/store.test.ts` "syncRawBranch deactivates off-path rows of THIS session only; other sessions stay active" 等 raw_log 镜像组。

### 25. 若干小瑕疵

- **`revise` 不写 `editor_source`**：`tools.ts:280` 只传 `editor_model`，`node_revisions.editor_source` 永远是 NULL。§6 的 custody 链要求"版本署蒸馏者（editor_source/editor_model）"，少了一半。
- **`store.isVisible()` 半失效**：`store.ts:582` 的签名是 `isVisible(node, anchorActive = true)`，而 `recall()` 内部调用时不传第二个参数（`store.ts:560`），等于恒真——除了"auto 且无 anchor"这一种情况。`RecallOptions.visibleOnly` 因此基本是个空开关。真正的可见性判定只在 `module.ts` 那份（用 `hiddenAutoNodeIds`）里。
- **`_updateNode` 非内容分支的返回值无意义**：`store.ts:261` 的 `node.content_hash === hashContent(node.content) ? this.currentVersion(nodeId) : 0` —— 条件恒为真（除非哈希已损坏），写法上像是没写完的逻辑。
- **`VisibilityPredicate` 类型导出但无人使用**（`store.ts:64`、`index.ts` 导出）。
- **`memory.revisions.retention` 未实现**：§12 决策 20 唯一指定的裁剪点，配置项与逻辑都不存在。
- **`recall` 的 `MEM://forgotten` 未传可见性谓词**：`renderForgottenView` 的第四个参数默认恒真（`memory-views.ts:43`），被回滚隐藏的 auto 节点会出现在沉睡列表里。

**处置/验证（v5.5，2026-09-11）**（逐项）：

- `editor_source`：`applyReviseMod` 正文编辑传 `editor_source: "manual"` + `editor_model`，stub 转正同样补 custody 链。
- `isVisible` 半失效：`RecallOptions.visibleOnly` 删除;`recall({isVisible})` 由调用者显式传 `VisibilityPredicate`;`createMemoryTools/createMemorySlots` 注入动态 `isVisible`，所有精确 recall/retrieve/forgotten/diagnostic/awaken/recent/index 过滤隐藏 auto 节点。
- `_updateNode` 非内容分支返回：删除恒真 content-hash 分支，非内容 patch 直接 `currentVersion(nodeId)`。
- `memory.revisions.maxVersionsPerNode`：`setRevisionRetention`（正整数或 undefined）+ `_applyRevisionRetention`（每次归档后剪最旧超额版本;删除前归档也应用,保证至少保留一版可恢复正文）。
- `recall` MEM 视图可见性：`renderForgottenView/renderDiagnosticView/renderWakeupView/renderRecentView/renderIndexView` 均接 `ctx.isVisible` 过滤。

回归：`test/store.test.ts` "setRevisionRetention validates the limit"/"prunes the oldest revisions"/"deleteCascade archives the final content";`test/module.test.ts` "auto nodes missing provenance are always hidden";`test/slots.test.ts` isVisible 过滤组。

### 26. 文档自身需要跟上

- **状态标注**：`docs/memory-system.md:3` 的"Phase 0-3 全量落地"应按本报告结论回退。
- **§14 决策 14 用的是旧工具名**：`docs/memory-system.md:192` 写"browse→recall、forget→delete、archive_history 废除、新增 raw（约 16-18 个）"，与 §10 表格（`forget` / `retrace` / 收敛到 9 个核心动词，实际注册 12 个）冲突。
- **§10 与决策 10 互相矛盾**：§10 末"删除后的找回路径是 node_revisions"、工具表"删除时自动备份" vs 决策 10"delete = 真删，无归档层，无机器 retention"。见 #6，需要定一个。
- **§3 `priority/importance` 双列从未定义分工**，见 #10。
- **§ 引用错位**：`extensions/memories/index.ts:1` 注释写"docs/memory-system.md §14"，`/memories` 实际出自 §13 Phase 3；同文件 §7 引用无误。
- **§12 的 export 范围**需按 #23 重新表述。

**处置/验证（v5.5，2026-09-11）**：本文档（v5.5 同步）与 `docs/memory-system.md`（状态行 + §3 schema + §4/§5/§8/§9/§10/§12/§13/§14 决策 + §16 风险）已整体回冲为实施后真相;`packages/memory/README.md` 同步（见 Phase 7 交付）;`extensions/memories/index.ts` 注释 §14 → §13 并说明使用 AgentSession 已解析路径。决策 14 工具名更新为 12 个（recall / retrieve / memorize / revise / forget / relocate / associate / trigger / consolidate / retrace / set_time / awaken），决策 10/25 的"真删"口径统一为"节点真删 + node_revisions 找回路径"。

---

## 27. 实施期新发现的坑（2026-09-11）

下面这几条不是通读时看出来的，是动手改 #3 / #6 / #10 的过程中撞出来的。

### 27.1 embeddings 默认联网，且注入路径在每个 prompt 的关键路径上

`resolveEmbeddingsConfig()` 的默认 `mode` 是 `"api"`，只要环境里存在 `PI_MEMORY_EMBEDDING_API_KEY` 或 `NOCTURNE_EMBEDDING_API_KEY`，会话就会**自动开始给外部服务发请求**——不需要任何显式配置。

**这不是推测**：接上 embeddings 后第一次跑测试套件，`packages/memory` 的单元测试直接打到了真实的 siliconflow API（本机环境里有 `NOCTURNE_EMBEDDING_API_KEY`），套件耗时从 0.9s 涨到 7.5s，并在测试结束关库后炸出 `database is not open`（见 §27.2）。测试已改为显式 `mode: "off"` / 注入假客户端，但**产品行为仍然是"有 key 就联网"**。

需要拿主意的地方：

- 空库首次召回会把**全库节点**一次性嵌入（批量 32 一轮），这笔延迟落在 `before_agent_start` 上，也就是用户敲下第一句话之后、模型开口之前。缓存之后就没了，但第一次很显眼。
- 记忆内容会离开本机发给第三方。RP 语料通常是私人的，这一点应当是显式选择而不是默认。
- 现在的 30s 超时是从生产版扩展照搬的；最坏情况下一个 prompt 卡 30s（失败后 latch 生效，本会话不再重试）。

建议：默认 `mode` 改为 `"off"`，或至少在首次启用时提示一次；超时下调到 5–10s。**这条留给你定，我没有擅自改默认值。**

**已定结论（v5.5，2026-09-11）**：默认 `mode` **改为 `"off"`**——未显式设置 `memory.embeddings.mode:"api"` 时恒为 off，即使环境有 key 也不出网;只有明确 `mode:"api"` 才读 env key 外呼。超时固定 **10s**。回归断言：`test/recall.test.ts` "is off by default even when an env key is present (privacy-first)"、"explicit mode api with a key enables the client"（fake-fetch 内联，不访问真实网络）。

### 27.2 异步召回与会话生命周期存在竞态

召回变成异步之后，`before_agent_start` 的处理函数会在 await 期间让出。如果这期间会话被 dispose、DB 被关闭（测试里就是这个场景），回写向量缓存会抛 `ERR_INVALID_STATE: database is not open`，而且是在一个没人接的 promise 里。

已加两层兜底：`computeVectorScores` 里的 `saveEmbeddings` 包 try/catch（缓存写失败不影响本轮打分），`handleBeforeAgentStart` 里整个召回包 try/catch（召回永远不能弄挂这一回合）。但**根因还在**：模块没有 dispose/abort 的概念，会话结束时在飞的嵌入请求不会被取消。引擎侧的 `completeSideRequest` 是有会话级 abort 的（`registerSideRequest`），嵌入这条路没有对应机制。接 #2 的时候应该一并给模块加一个 `dispose()`。

**已定结论（v5.5，2026-09-11）**：`MemoryModule.dispose()` 落地——每次召回用子 `AbortController`，`onLeafChange()` 取消旧分支在飞召回、`dispose()` 取消全部召回（含 autoretain side 请求），catch 后不注入过期结果;`EmbeddingClient.embed(texts, signal?)` 用 `AbortSignal.any([signal, 10s timeout])`，**外部 abort 不触发 sticky failure latch**（取消不是故障，下次可重试），HTTP/响应错误仍 latch。回归：`test/recall.test.ts` "an external abort cancels the request without latching failure";`test/memory-module.test.ts` "dispose tears down the module without killing the shared store"。

### 27.3 keyword-only 模式下自动注入近乎静默

这是 #3 修好之后必然浮现的代价，得写明白：权重不折叠之后，keyword 模式的分数是 `0.3·kw + 0.15·importance + recency`。默认 importance 5（→0.075）、无 recency 时，要越过 `MIN_SCORE = 0.35` 需要 **kw ≥ 0.917**——几乎只有整段查询词都命中才行。

**证据**：把注入测试从折叠版切到真实权重后，原本能注入的 6 个用例全部返回"无注入"，最后是给它们接上确定性的假嵌入客户端（vector 模式）才恢复语义。

这与生产版扩展的行为一致（那边 keyword 只是 API 挂掉时的降级），但对本包意味着：**不配 embedding key ≈ 没有自动召回**，只剩角色主动 `retrieve`。要么接受（并在文档里说清），要么给 keyword 模式单独一档更低的 `minScore`。§9 已按前者写入，配置口子是 `memory.recall.minScore`。

**已定结论（v5.5，2026-09-11）**：keyword 注入档独立为 **`memory.recall.keywordMinScore`（默认 0.12）**，且 keyword 模式**始终要求真实 keyword/FTS 命中（kw>0）**（glossary 专名也算命中）;vector 模式仍用 `minScore` 默认 0.35。显式 `retrieve` 两种模式均 `minScore:0`，但 keyword 模式同样要求真实命中。**keyword 模式仍达不到 HIGH_CONFIDENCE（0.55）**——软锚只由语义挣得的标定保留。回归：`test/recall.test.ts` "keyword 0.12 可注入且 HIGH_CONFIDENCE 仍不可达"（rank 断言）;"keyword-only 无召回"由 module 注入默认（无 key 时 vector 降级 keyword,仍可注入 kw 命中）承担。

### 27.4 删除还原必须复用原 node_id，否则修订史会变孤儿

第一版 `restoreDeleted()` 用 `_insertNode` 新建节点，结果：还原出来的节点是个全新 node_id，旧的修订行仍然挂在旧 id 上、仍然"没有对应的活节点"，于是 `listDeletedUris()` 在还原之后**依然把这个 uri 列为已删除**（测试直接抓到了）。

改成按原 node_id 重建（`_insertNode` 加 `forceId`），修订史直接接回去，还原后的节点带着完整版本链，`listDeletedUris()` 也干净了。同一个 uri 反复删除/还原时版本号继续递增，不会重号。

### 27.5 `store.recall()` 的并列名次由插入顺序决定

双归一化（query-precision 与 doc-coverage×1.4 取 max）会让"查询词全中"的文档统统拿到 kw = 1.0，无论文档有多长。也就是说**并列非常常见**，并列时的名次由 `listNodes()` 的 `ORDER BY created_at` 决定，等于"先写的排前面"。

这既是 #4 原始证据不成立的原因（见该条的证据更正），也是一个还没处理的实际问题：并列时按创建时间排，不见得比按 `updated_ts`、按 importance 或按文档长度排更合理。目前维持现状（排序稳定、可预期），但如果之后发现注入位老是被老节点占住，第一个该看的就是这里。

**已定结论（v5.5，2026-09-11）**：稳定同分次键固定为 `score DESC → kw DESC → vec DESC → bm25 ASC（null 最后）→ importance DESC → updated_ts DESC → uri ASC`，不再由插入顺序决定;`RecalledItem` 增 `bm25: number | null` 供次键。回归：`test/recall.test.ts` "tie-breaks are deterministic ... uri decides"、"RecalledItem carries bm25"。

### 27.6 `retrieve` 与注入的阈值必须分开

合并两处打分实现时才意识到：注入的 `MIN_SCORE = 0.35` 绝不能套到 `retrieve` 工具上，否则角色主动搜索在 keyword 模式下基本永远返回"（无命中）"。现在 `minScore` 是 `SearchOptions` 的显式参数——注入传 0.35，`retrieve` 与 `/memories search` 传 0。这一条已写进 §9，免得以后有人"顺手统一"回去。


## 交付状态（2026-09-11，v5.5 修复轮）

**#1–#25 与 §27 全部收口，无剩余 P0/P1/P2**。落地顺序即本文各条「处置/验证」段落;每项均有代码与回归测试闭环：

- 数据安全：#1（session 隔离镜像）、#12（时间戳保真）、#24（SQL 侧对账）
- 引擎接线：#2（completeSideRequest 桥接）、#18（per-task 进度）、#20（preset 解析链）、#21（MemorySettings 复用）、#27.2（dispose/abort）
- 语义修复：#5（stub 转正）、#7/#8（子树搬迁与真分组）、#9（world_ts 保留）、#13（修订读端）、#25（editor_source/isVisible/retention）
- 检索真实化：#14（FTS 读端 + jieba 单例）、#15（glossary/edges 消费）、#16（访问追踪）、#27.1/27.3/27.5/27.6（默认 off/关键词 0.12/稳定次键/阈值分离）
- 审计与资产：#19（审计补全）、#23（快照三类资产）、#26（文档回冲）

测试基线：`packages/memory/test/` **138 例**（store/tools/recall/module/phase3/slots）+ `packages/coding-agent/test/`（memory-module 9 例 + settings-manager 61 例，含深合并新增）。全仓非 e2e 全量由 `./test.sh` 收口，`npm run check` 零错误。
