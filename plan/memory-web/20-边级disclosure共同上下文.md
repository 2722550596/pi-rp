# 20 — 边级 disclosure 共同上下文（冻结契约）

> 本文件是**跨模块共享地基**。所有子设计文档 MUST 遵守 §3 的形状约定；冲突时按 §0 的权威层级裁决。
> 子文档 MAY 推翻本文件的**事实断言**（带 `file:line` 证据），MUST NOT 私自改共享形状。
> 发现本文件错误 → 立即用 hub 报告主 agent，不要静默绕过。

---

## §0 权威层级

1. **本文件的 §3（共享形状）** > 子文档。
2. **实测证据**（`file:line` + 可复现命令） > 任何文档断言，**包括本文件**。
3. `docs/memory-system.md`（设计规格 v5.5）> `plan/memory-web/` 既有文档。
4. 本文件与既有冻结契约（`00`/`10`/`16`）冲突时，以本文件为准，并记入 §11。

---

### §0.1 产出文件名（唯一权威映射，2026-09-16 定案）

全部落在 `plan/memory-web/`：

| 编号 | 文件名 | owner |
|---|---|---|
| `21-数据模型与语义核心.md` | D1 | DbEdgeD1 |
| `22-检索与打分.md` | D2 | DbEdgeD2 |
| `23-迁移.md` | D3 | DbEdgeD3 |
| `24-工具层.md` | D4 | DbEdgeD4 |
| `25-前端与文档.md` | D5 | DbEdgeD5 |
| `26-渲染与测试.md` | D6 | DbEdgeD6 |

> ⚠️ 主 agent 曾在广播中把 D5 误写成 `21` 并造成往返。**以本表为准**，不再变更。

## §1 背景：为什么现在做这件事

### §1.1 用户的原始观察

> 「记忆系统到底有没有 disclosure 这种东西？它几乎没有存在感……在前端我甚至看不见它，然而连 importance 起码都有标记，但 disclosure 理论上不应该是更重要的吗？」

### §1.2 三路 scout 的实测结论（已核实）

**disclosure 在 pi-rp 是「二等公民」，而它在 nocturne 后端是一等公民。** 证据分层：

| 维度 | nocturne **Python 后端** | nocturne **pi 扩展** | pi-rp `packages/memory` |
|---|---|---|---|
| 挂载位置 | **Edge（边）**，`models.py:136` | 拼接文本 | `nodes.disclosure` 单列 |
| 独立 FTS 列 | ✅ `search_documents_fts` 第 7 列 | ❌ | ❌ `node_fts(node_id UNINDEXED, text)` 单列 |
| bm25 权重 | ✅ **1.0，与 content 同权** | ❌ | ❌（无 bm25 权重表） |
| 写入必填 | ✅ 必填，空则 422（`api/browse.py:326,354`） | — | ❌ `Type.Optional` |
| UI | 琥珀色徽章 + ⚠️ 图标 | — | `mw-muted` 灰化；**`tree.js` 0 处** |
| 文档 | README 专段「条件触发路由」 | — | 正文 1 次（schema 注释） |
| 自触发指令 | ✅ `docs/system_prompt.md:36` | — | ❌ **不存在** |

### §1.3 降格发生的确切位置（git 考古，已核实）

- **桥梁文件**：`/home/yoshix7ti/projects/nocturne_memory/install/extensions/nocturne-memory-recall.ts`
  —— 这是给 **pi**（非 MCP）用的扩展，**正是 pi-rp `recall.ts` 的直系祖先**。
  - 权重 `W_VECTOR=0.55 / W_KEYWORD=0.3 / W_PRIORITY=0.15`，与 pi-rp 一字不差（pi-rp 把 priority 改名 importance 并**翻转极性**）。
  - 该文件的文档串是 `uri + disclosure + searchTerms + content` —— disclosure 在这里**已经只是拼接文本**。
- **出生提交**：`d9140a3c4`（nocturne 仓库）。全历史 `git log --all -S"W_DISCLOSURE"` **零命中** —— **disclosure 从未有过独立权重**。
- **结论**：降格发生在「Python 后端 → pi 扩展」这一步。pi-rp 继承了这个残缺版本，前端与文档又进一步退化。

### §1.4 设计意图曾被写下但未兑现（最扎的一条）

- `plan/archives/memory-system.md:356`：「角色记忆轨 = `search_documents`（FTS 词法 + **disclosure/priority 加权**，**nocturne 原能力保留**）」
- 该文件 `:351` 的公式是 `score = 0.5·vector + 0.3·keyword + 0.2·priority`
- 实现 `recall.ts:29-31` 是 `0.55/0.3/0.15` 且**无 disclosure 项**。
- `docs/memory-system-audit.md:395` 记过同类问题（那次是 glossary 缺席于打分），disclosure 无人提及。

### §1.5 用户 2026-09-16 的裁定（原文）

> 「**恢复 nocturne 的边级 disclosure**。这种东西基本上是早期预期漂移，现在只能踩坑，没招。现在不做，以后也得做。不过问题不大，反正人多力量大，交给子代理让它们去发愁吧」

> 「disclosure 要补齐，**迁移那些也得做**，那个改动会很大，认真走流程。」
> 追问「迁移指哪个」→ 答：**「两者都要」**（存量库 schema 迁移 + relocate 与 disclosure 的关系）

---

## §2 现状事实（带 `file:line`，实现前 MUST 复核）

> ⚠️ 本节的每个断言都有保质期。子代理实现前 MUST 用代码/探针复核，标 `[须复核]`。

### §2.1 数据模型

| 事实 | 位置 |
|---|---|
| `nodes.disclosure TEXT`（可空，无索引） | `src/schema.ts:13` |
| `edges(node_id, target_uri, kind)`，PK `(node_id, target_uri)`，**无 disclosure 列** | `src/schema.ts:45-50` |
| `aliases(alias_uri PK, target_node_id)`，**无 disclosure 列** | `src/schema.ts:52-55` |
| `node_revisions(node_id, version, uri, content, editor_source, editor_model, created_at)` | `src/schema.ts:34-43` |
| `node_fts(node_id UNINDEXED, text)` — **单列**，tokenize `unicode61` | `src/schema.ts:78` |
| `SCHEMA_VERSION = "2"`，注释明写 **no migration path, cold rebuild** | `src/schema.ts:3-4` |
| `createSchema` 在版本不匹配时**抛错拒绝启动** | `src/schema.ts:131-147` |

### §2.2 检索与打分

| 事实 | 位置 |
|---|---|
| `W_VECTOR=0.55 / W_KEYWORD=0.3 / W_IMPORTANCE=0.15`，**无 disclosure 项** | `src/recall.ts:29-31` |
| 打分公式 `0.55·vec + 0.3·kw + 0.15·importanceScore + recencyBoost` | `src/recall.ts:231-235` |
| `importanceScore()` 是独立映射函数；**disclosure 无对应函数** | `src/recall.ts`（`importanceScore` 定义处）|
| 文档文本拼接含 disclosure：`uri + disclosure + extraTerms + content` | `src/recall.ts:159` |
| 嵌入文本拼接含 disclosure：`uri \n disclosure \n content` | `src/embeddings.ts:102` |
| `reindexNode` 把 `[uri, disclosure, content]` join 后 tokenize 进 `node_fts.text` | `src/store.ts:1429` |
| **无任何依 disclosure 的门控/过滤/加权** | 全包 grep 确认 |

### §2.3 FTS 与 reindex

| 事实 | 位置 |
|---|---|
| `reindexNode(nodeId)` 重建单节点 FTS 行；stub 直接 return | `src/store.ts:1419-1436` |
| `import()` 在插入 glossary **之后**补 reindex（修过的 bug） | `src/store.ts:1320-1335` |
| `searchNodeFts` 是唯一的 MATCH 查询入口 | `src/store.ts`（用 `bm25()` 但**无列权重**）|

### §2.4 写入路径

| 工具 | when 参数 | 落点 |
|---|---|---|
| `memorize` | `when: Type.Optional(String)` | `src/tools.ts:448` → `disclosure: params.when ?? null` |
| `revise`（edit） | `when: Type.Optional(String)` | `src/tools.ts:484,505` → `disclosure: mod.when` |
| `associate` | `when: Type.Optional(String)`「从这入口什么时候会想起来」 | `src/tools.ts:764`（`associateParams`，**唯一**一处）→ **现状静默丢弃**（见 §2.9） |
| `consolidate` | `when: Type.Optional(String)`「什么时候想到这主题」 | `src/tools.ts:823`（`consolidateParams`）→ `:842,895,910`，**已实现** |
| `autoretain` | JSON 契约字段 `disclosure`（**不是**工具参数 `when`） | `AUTORETAIN_JSON_CONTRACT`（`src/autoretain.ts:67-68`）+ `parseAutoretainJson`（`:109-133`）→ `:227` `store.put({disclosure: ...})` |

> ⚠️ **契约初版 §2.4 有 3 处笔误（2026-09-16 由 D4 顶回，主 agent 已逐个复核）**：
> 1. 初版把 `associate` 的 `when` 列成两行（`:764` 与 `:823`）——**错**。`:764` 是 `associateParams`；**`:823` 是 `consolidateParams.when`**，两个不同工具。
> 2. 初版写「`remember`（autoretain 用）」——**该函数不存在**（全仓 grep 无 `remember`）。真实落点是 `runAutoretainTask`，且字段名是 `disclosure`（JSON 字段），非工具参数 `when`。
> 3. 初版 §3.3 漏列 `consolidate.when`（存在且已实现，`tools.ts:842,895,910`）。D4 裁定：**不改**（新主题节点 = 规范入口 → `nodes.disclosure` 正确）。

### §2.5 消费面（谁读 disclosure）

- `src/slots.ts`（awaken 注入块：「想起条件: …」）
- `src/memory-views.ts:103,110,158`（MEM:// 视图渲染）
- `src/module.ts`（注入块）
- `src/web/routes.ts`（DTO 组装 + patch 处理）
- `src/web/serialize.ts`（`readEditorColumns`）
- 前端 `assets/views/{node,views,search,edit}.js`（**不含 `tree.js`**）

### §2.6 引用密度（改动的规模感）

| 面 | disclosure 引用数 |
|---|---|
| `src/`（排除 `web/`）| **51 行**（初版写 58 不可复现；按出现次数为 64）|
| `src/web/` | 35 |
| `test/` | 18（6 个文件） |

### §2.7 nocturne 边级语义（必须复制的部分）

来自 `backend/db/graph.py`：

- `:153,363,444` — 读节点时 disclosure **来自 edge**，不是 nodes 表。
- `:886` — 创建 edge 时写入（`disclosure=disclosure`）。
- `:1495-1498` — **patch 校验**：`"At least one of content, priority, disclosure, or world_timestamp must be set."`
- `:1537-1538` — patch 更新 edge.disclosure。
- `:1673-1675` — **`relocate` 时继承**：
  ```python
  # Inherit disclosure from the target if not explicitly provided
  if disclosure is None and target_edge.disclosure:
      disclosure = target_edge.disclosure
  ```
- `edges` 表约束：`UNIQUE(parent_uuid, child_uuid)`，`priority INTEGER DEFAULT 0`，`disclosure TEXT` 可空。

### §2.8 前端 DTO 的冻结面（2026-09-16 补，D5 报告后核实）

| DTO | 有无 `disclosure` | 位置 |
|---|---|---|
| `NodeDTO` | ✅ 有 | `serialize.ts:22-41` |
| `TreeNodeDTO` | ❌ **无** | `serialize.ts:43-53` |
| `EdgeDTO` | ❌ **无** | `serialize.ts:63-73` |
| `AliasDTO` | ❌ **无** | `serialize.ts:75-78` |

⇒ **`tree.js` 拿不到 disclosure 数据**（`/api/tree` 只回 `TreeNodeDTO`）——这是「默认落地页不显示」的**服务端根因**，不只是前端懒得画。

对照先例：`recent` 视图的字段表**有** `disclosure`（`test/web/dto-contract.test.ts:27`），`TreeNodeDTO` 没有。

### §2.9 既有 bug：`associate` 的 `when` 被静默丢弃（2026-09-16 发现）

- 参数定义存在：`tools.ts:764` `when: Type.Optional(Type.String({ description: "从这入口什么时候会想起来" }))`
- **`executeAssociate`（`tools.ts:767-789`）函数体内完全没有读取 `params.when`**（grep 确认）。
- 对照：`memorize`（`:463`）、`revise`（`:562`）、`consolidate`（`:842,895,910`）都用了。
- ⇒ 「**声明了但没有实现**」：用户传了 `when`，磁盘上什么都不会发生，且**无任何报错**。
- **归属**：D4 MUST 在还原 `when` 接线时一并修掉，§10 加非空性断言（修前失败、修后通过）。

### §2.10 `tools.ts` 内部的 disclosure 读点（2026-09-16 补，契约初版遗漏）

契约初版 §2.5 只说 web/slots，漏了 `tools.ts` 内部 **5 处**直接读 `node.disclosure` 做**显示**：

- `tools.ts:100-101`、`:264-265`、`:319-320`、`:413-414`、`:426-427`

同型问题亦见于：
- `slots.ts:37`（`snippet`）、`:66-67`（awaken 块）、`:74`（子节点列表）
- `memory-views.ts:103`、`:110`、`:158`

⇒ **边级改造后，从别名入口进入时这些读点会看到节点级条件而非入口条件**。D1 MUST 给方案。

#### ✅ 可行性已核实（2026-09-16，主 agent 逐个查证）

**结论：这 11 个读点全部拿得到 uri，改动可做，不是设计死结。**

| 读点 | 持 uri 的证据 |
|---|---|
| `tools.ts:100-101` | `:99` 已用 `node.uri` 渲染标题 |
| `tools.ts:264-265` | `:256` 函数参 `uri`；`:258` 用 `node.uri` |
| `tools.ts:319-320` | `:319` 直接渲染 `child.uri` |
| `tools.ts:413-414` | `:412` 渲染 `n.uri` |
| `tools.ts:426-427` | `:425` 渲染 `n.uri` |
| `slots.ts:37`（`snippet`）| `:35` 形参即 `{ uri, content, disclosure? }` |
| `slots.ts:66-67` | 在 `for (const uri of uris)`（`:50`）内 |
| `slots.ts:74` | `:76` 渲染 `child.uri` |
| `memory-views.ts:103` | `:98` 渲染 `node.uri` |
| `memory-views.ts:110` | `:114` 渲染 `child.uri` |
| `memory-views.ts:158` | `:157` 渲染 `n.uri` |

**统一改法**：`node.disclosure` / `child.disclosure` → `store.effectiveDisclosure(<该点手上的 uri>)`。**无需任何反查。**

---

## §3 共享形状（冻结 —— 子文档 MUST 遵守）

> ⚠️ **本节是本契约的核心。** 任何子文档若需改动这里的形状，MUST 先报主 agent。

### §3.1 存储位置：disclosure 迁到「入口」上（2026-09-16 修正）

> ⚠️ **本节初版有映射错误，已修正。** 初版写「别名 → `aliases.disclosure`、联想边 → `edges.disclosure`」并把两者塞进同一条回退链——**错误**。详见下方「为什么初版是错的」。

#### 为什么初版是错的（nocturne `edge` ≠ pi-rp `edges`）

**nocturne 的 `edge` 是「层级路径段」**：
```sql
CREATE TABLE edges (parent_uuid, child_uuid, name, priority, disclosure, ...
                    CONSTRAINT uq_edge_parent_child UNIQUE(parent_uuid, child_uuid));
```
一条 edge = 「child 作为 parent 的具名子项」= **一段路径**。disclosure 挂这里 = 挂在路径段上。

**且 nocturne 没有独立 aliases 表**——它的「别名」就是**同一个 child 的多条 edge**（同 child 多个 parent 入口）。证据：`backend/db/graph.py:145-146` `total_paths = _count_incoming_paths(child_uuid); alias_count = max(0, total_paths - 1)`。

**pi-rp 是三套互不相同的机制**：

| pi-rp 机制 | 表/列 | 对应 nocturne 的什么 |
|---|---|---|
| 层级路径 | `nodes.uri` + `nodes.parent_id` | **edge**（层级路径段）|
| 额外入口（别名）| `aliases(alias_uri, target_node_id)` | **同 child 的另一条 edge** |
| 联想关系 | `edges(node_id, target_uri, kind)` | **nocturne 无此概念**（`grep` `associations\|related\|link` 于 `models.py` 为空）|

⇒ **`nocturne.edge.disclosure` 在 pi-rp 的正确对应物是 `aliases.disclosure`，不是 `edges.disclosure`。**

#### 裁定（冻结）

1. **`nodes.disclosure` 保留**，语义 = **「规范入口（`nodes.uri`）的想起条件」**。
   - 注：它**不是** nocturne 的直接对应物（nocturne 一切路径都经 edge，故条件全在边上）。保留理由：规范入口必然存在且需要存放处；完全移除会迫使每条路径独立建行，得不偿失；且兼容现有 12 工具的 `when` 参数。
2. **`aliases.disclosure` = nocturne `edge.disclosure` 的真正对应物**（**核心交付物**）。
3. **`edges.disclosure`（联想边）仍然要做**，但它是 **pi-rp 的扩展**，**MUST NOT** 在文档/注释里说成「恢复 nocturne 语义」。理由：`associate({related_uri, when})` 的参数描述本就是「什么时候想到这主题」（`tools.ts:764`），设计者预留了它，只是从未实现（见 §2.9 既有 bug）。

#### 生效想起条件（effective disclosure）—— 回退链（2026-09-16 精确化，冻结）

> ⚠️ **本段曾被 D2 实测挑战，主 agent 裁定后精确化。** 争议：某 uri **同时**是 `nodes.uri`（节点 A）与 `aliases.alias_uri`（指向 B）时该取谁？→ **裁定：镜像 `resolveUri`，节点优先。**

**实现（冻结，两分支，精确伪码）**：
```ts
effectiveDisclosure(uri: string): string | null {
  const direct = byUriStmt.get(uri);              // ① nodes.uri 命中 → 节点条件
  if (direct) return direct.disclosure;
  const alias = aliasStmt.get(uri);                // ② 否则看 aliases.alias_uri
  if (alias) return alias.disclosure ?? (指向节点的 disclosure);   // ?? 语义
  return null;
}
```

**为什么是节点优先（决定性理由：一致性）**：
同一 uri 上，`resolveUri` 返回 A 的**内容**。若本函数返回 B 的**条件**，则一次 `GET /api/node?uri=…` 会给出「A 的内容 + B 的想起条件」= **静默错乱**（§8 T5 类）。
⇒ **任何关于一个 uri 的口径 MUST 一致**：`resolveUri` 说它是谁，条件就得是谁的。

#### ⚠️ 三个判据 MUST NOT 混用（2026-09-16 评审后冻结，D1/D4 协同定稿）

「一个 uri 与别名/规范节点的关系」有三个**正交**问题，各有专属原语：

| 问的是 | 用 | 定义 |
|---|---|---|
| ① `aliases` 表里有没有这行（**含死别名**）| `hasAliasRow(uri)` [NEW] | `EXISTS(SELECT 1 FROM aliases WHERE alias_uri = ?)` |
| ② 这个 uri **解析后是否走别名** | `resolveEntry(uri)?.kind === "alias"` | 镜像 `resolveUri` |
| ③ 这个 uri **是否被遮蔽**（死别名）| `hasAliasRow(uri) && resolveEntry(uri)?.kind === "canonical"` | 两者合取 |

**MUST NOT 用 `resolveUri(uri) !== null` 判「被遮蔽」**——普通别名也非 null ⇒ **假阳性**（可达到口被误报为「写了看不到」）。
**MUST NOT 用 `resolveEntry(uri)?.alias_uri !== null`**——规范分支硬编码 `alias_uri: null`（D1 M4b `:182`）⇒ 恒 false。
**`listAliasEntries` 是「按 target 节点查」**（`listAliasEntries(T.node_id)`），手上只有 uri 时够不到那条 entry —— 这正是 `hasAliasRow` 必需的原因。
> 注：契约初版措辞「该 uri 是别名（命中 `aliases.alias_uri`）」在**非死别名**场景下与镜像等价（非死别名 ⇒ 该 uri 不是 `nodes.uri`）。二者**只在死别名（歧义状态）下分歧**——那是措辞不够精确，非本函数的问题。
> 死别名（M3/X6）的处置见 §5 X6（归 D1）。

> ✅ **实现前 spike 已验证本函数三场景行为**（2026-09-16，主 agent 亲跑，脚本归档 `plan/memory-web/_spike-effective-disclosure.mjs`）：
> | 场景 | `effectiveDisclosure` | 期望 |
> |---|---|---|
> | 正常别名（有值）| `entry-level` | ✅ |
> | 正常别名（disclosure=NULL）| `node-level B` | ✅（`??` 语义）|
> | 死别名（`mem://a` 撞存活节点）| `node-level A` | ✅（与 `resolveUri` 一致）|
> | 从规范 uri 进 vs 从别名进（同一节点 B）| `node-level B` vs `entry-level` | ✅（**核心承诺**：不同入口不同条件）|
> ⇒ 两分支伪码可直接照写。

> ⚠️ **`edges.disclosure` MUST NOT 进这条链。** 联想边是「遍历扩散时的关系条件」，与「解析某个 uri 得到的入口条件」是两回事。初版把三者混在一条链里是错的。

> 命名：统一称**「生效想起条件」**。实现 MUST 提供**单一函数**计算它，禁止各处自行 fallback。
> 落点（D1 定稿）：`MemoryStore.effectiveDisclosure(uri): string | null`。签名细节由 D1 给，但 MUST 遵守上面的两段回退链。

#### 边界情形（D1 MUST 逐个给行为）

- uri 同时是某别名、又是某联想边的 target → 按上面链，**取别名的**（联想边不参与）。
- uri 是 `nodes.uri` 且有别名指向它 → 从别名进来取 `aliases.disclosure`；从规范 uri 进来取 `nodes.disclosure`。
- `edges.disclosure` 的**读取者是谁**？→ D1 裁定（建议：仅在 `retrieve` 沿边扩散时作为该跳的说明展示，不参与打分，除非 D2 有实测支持）。

### §3.2 Schema 变更（v2 → v3）

**新增列**（均为可空 `TEXT`）：
- `ALTER TABLE aliases ADD COLUMN disclosure TEXT`
- `ALTER TABLE edges ADD COLUMN disclosure TEXT`

**DTO 新增字段（2026-09-16 批准，D5 报告后裁定）**：

批准给以下 DTO 各加一个可空字段 `disclosure: string | null`：
- `TreeNodeDTO`（`serialize.ts:43-53`）— **不加则「默认落地页显示 disclosure」物理不可达**
- `EdgeDTO`（`serialize.ts:63-73`）— 节点页呈现「各入口的想起条件」需要
- `AliasDTO`（`serialize.ts:75-78`）— 同上

> ⚠️ 这是对既有冻结契约 `plan/memory-web/00-共同上下文.md` §16.4 字段表的**变更**。变更已知会 D2/D3（`views-parity` 测试可能受影响）。

**三条补充裁定（2026-09-16，RevConsistency 评审发现正文未更新后补）**：

1. **`NodeDTO.disclosure`：字段不增，但取值口径变更** —— 初版写「`NodeDTO` 已有该字段，不动」**不准确**。现裁定：`NodeDTO.disclosure` = **入口作用域**，由**请求进来的那个 uri** 算 `effectiveDisclosure(requestedUri)`（不是 `node.disclosure`）。
   - 理由：用户从哪个入口进，看到/编辑的就该是哪个入口的条件；原口径下「显示 A、实际改 B」，是**显示层 bug**（D5 的 B 条）。
   - 连带：`toNodeDTO`（`serialize.ts:314-322`）MUST 加 `disclosure` **覆盖参数** —— 不是只改 `toNodeResponseDTO` 的调用点。
2. **`EdgeDTO.disclosure` = 裸列 `edges.disclosure`（本节的唯一例外）** —— 它**不**经 `effectiveDisclosure`。理由：`edges(node_id, target_uri, kind)` 是联想边，**不是可寻址入口**（`resolveUri` 只认 `nodes.uri` 与 `aliases.alias_uri`），且 §3.1 已明文 `edges.disclosure` 不进生效链。
   - UI MUST 与入口条件**视觉区分**（D5 方案：灰 chip + 「关联条件」文案，**不给琥珀徽章**）。
3. **`AliasDTO.dead: boolean` 已批准**（D5 提出）——定义 `dead = exists(SELECT 1 FROM nodes WHERE uri = alias_uri)`，**与 `resolveUri` 优先级同源**（§3.1 镜像裁定）。它由 `listAliasEntries` 同一条 SQL 带出。

> 除 `EdgeDTO` 的例外外，新增字段一律**可空**，且 MUST 通过 `effectiveDisclosure` 计算得出（不是裸读 `nodes.disclosure`），否则别名入口的 UI 会显示错的条件。

**`node_fts` 改为多列**（对齐 nocturne 的独立列 + bm25 权重）：
```sql
-- 现状
CREATE VIRTUAL TABLE node_fts USING fts5(node_id UNINDEXED, text, tokenize='unicode61')
-- 目标
CREATE VIRTUAL TABLE node_fts USING fts5(
    node_id UNINDEXED, text, disclosure, tokenize='unicode61'
)
```
> ⚠️ FTS5 表**不能 ALTER**。改列 = DROP + CREATE + 全量重建。这是迁移的主要成本。

**bm25 权重（2026-09-16 由 D2 实测推翻并重新裁定）**：
```sql
bm25(node_fts, 0.0, 1.0, 1.0)
--               ↑ node_id  ↑ text  ↑ disclosure
```

**为什么不是契约初版的 `2.5`（初版错，D2 顶回）**：
1. **范畴错误**：初版说「`text` 给 2.5 对应 nocturne 的 path 权重位」。但 nocturne 的 `2.5` 属于 **`path` 列**（`search_documents_fts` 第 3 列，`demo.db` schema 确认），而 **pi-rp 没有 `path` 列**（`text = uri + content + glossary`）。⇒ 拿 path 的权重套在 text 上，是**不同语义的列**。
2. **实测扰动**：`2.5/1.0` 在真库引入 **13/86**（现库）、**13/73**（模板）的纯 tiebreak 噪声；`1.0/1.0` 是 **86/86 与 73/73 全同**。
3. **`1.0` 恰好是 FTS5 默认**（主 agent 独立实测）：`bm25(t)` ≡ `bm25(t,1.0,1.0)`（同分数）。⇒ 推荐值 = **行为保持**，不是新引入的偏好。
4. nocturne 的 disclosure 位权重就是 **1.0**（与 content 同权），这一半初版是对的。

> `bm25` 在 pi-rp 只是**第 4 级 tiebreak**，从不作为评分项（`recall.ts:231-259`）⇒ 权重只在同分时的排序里可见。
> 两档都能过 §10 的断言（A6 只锁元数、不锁数值），但**裁定取 `1.0/1.0`**（最小惊讶 + 行为保持）。

**`SCHEMA_VERSION` → `"3"`**。

### §3.3 工具参数契约

**冻结**：工具参数名保持 `when`（外部可见 API 不变），语义改为**「生效想起条件的写入目标」**：
- `memorize({uri, when})` → 写到 **`nodes.disclosure`**（新建节点，无入口）
- `associate({new_uri, when})` → 写到 **`aliases.disclosure`**（新入口的想起条件）
- `associate({related_uri, when})` → 写到 **`edges.disclosure`**（新边的想起条件）
- `revise({when})` → 写哪个？**见 §3.4**

### §3.4 `revise({when})` 的歧义（D1 MUST 裁定并给理由）

`revise` 的 `uri` 可能解析到：① 规范节点；② 别名入口；③ 边的 target。
- 若写 `nodes.disclosure` → 改的是「节点自身」的条件，可能是用户想改的入口条件。
- 若写「生效位置的 disclosure」→ 需要先确定「这个 uri 代表哪个入口」。

**本契约的建议（D1 可推翻，但 MUST 给证据）**：`revise(uri=X, when=Y)` 写入 **X 这个「入口」的 disclosure**（即按 §3.1 回退规则命中的那一层）。理由：用户从 X 进入、看到 X 的条件、要改的自然是 X 的条件。若 X 是规范 uri 且无入口 → 写 `nodes.disclosure`。

#### ✅ 已采纳 D1 的更正确方案（2026-09-16）：写「结构层」，不是「命中层」

D1 指出上面的「命中层」方案有**跨入口副作用**：
> 别名 disclosure 为 NULL 时「命中层」是 `nodes.disclosure`，按命中层写会让「从某个别名 revise」**覆盖掉规范入口与其他别名共享的节点级条件**。

**裁定（冻结，取代上段）**：
- `revise(uri=X, when=Y)` 写入 **X 在结构上表示的那一层**：
  - X 命中 `aliases.alias_uri` → 写 **`aliases.disclosure`**
  - 否则（X 是规范 uri）→ 写 **`nodes.disclosure`**
- **不是**「命中/回退到哪层就写哪层」——回退链只用于**读取**，不用于**写入**。

#### ✅ 已采纳 D1 的 NULL 语义（2026-09-16）

回退链**定死为**：`aliases.disclosure ?? nodes.disclosure`
- 别名自身 disclosure 为 NULL 时 → **落到节点级**（`??` 语义，不是「命中即止」）。
- **为什么关键**：这样 D3「存量 alias 留 NULL」才能成立——否则 `effectiveDisclosure(旧别名)` 会从今天的 `nodes` 值**变成 null**（行为回归）。
- 推论：`aliases.disclosure` 的 NULL = 「继承节点级」，而非「无想起条件」。**要表达"这个入口没有想起条件"需要别的机制**——D1 MUST 在文档里明说这个限制，MUST NOT 假装它能表达。

### §3.5 `relocate` 与 disclosure（用户明确要求）

**冻结**：`relocateMany` 移动子树时，MUST 处理 disclosure：
#### 修正后的裁定（2026-09-16，初版表述错误）

**初版写「别名继承被移动边的 disclosure」——错误。** 经复核 `graph.py:1673-1675` 与 pi-rp 的实际结构：

- nocturne 的 inherit 是「新的 edge 从 **target edge** 继承」。映射到 pi-rp（`aliases` = nocturne 的「另一条 edge」），方向对，**但「继承什么」要重新定义**。
- pi-rp 的 `edges` 是**联想边**（nocturne 无此概念），跟「移动路径」无关 ⇒ 别名**不该**从 `edges` 继承任何东西。
- **正确语义**：旧 uri 变别名时，该别名代表「这条被移动的路径段」，它应保留**移动前的生效条件**。

```ts
// 对每个 member（伪码；D1 MUST 给出真实签名）
const prior = this.effectiveDisclosure(member.node.uri);   // 移动前
this.db.prepare(
  "INSERT INTO aliases (alias_uri, target_node_id, disclosure) VALUES (?, ?, ?)"
).run(member.node.uri, member.node.node_id, prior);
```

#### ⚠️ 同处的一个静默丢失（新发现，MUST 一并修）

`store.ts:677-679` 现状是：
```sql
INSERT OR REPLACE INTO aliases (alias_uri, target_node_id) VALUES (?, ?)
```
**只写两列。** 加 `aliases.disclosure` 后，`OR REPLACE`（先删后插）会把该别名的 disclosure **重置为 NULL** ⇒ 已有 disclosure 的别名被 relocate 一碰就**静默丢失**。

**MUST 显式列出 `disclosure` 列。** 这是「修 A 引入 B」的典型形态，症状沉默（契约 §8 T5 类）。

#### P1 交叉（D1 MUST 读）

`plan/memory-web/00-共同上下文.md` §12 登记 P1：「`relocateMany` 从不重写 `edges.target_uri` → incoming 边静默消失」。**实测确认**：`store.ts:656-688` Pass 3 只改 `nodes`（`:668-674`）与插 `aliases`（`:677-679`），`edges` 表一个字节不动。
- 出边仍可解析（旧 uri 现在是别名）；**入边**（`edges WHERE target_uri = 新uri`）查不到 → 静默消失。
- D1 MUST 判断：边级 disclosure 落地后，这个 P1 是否加重（若 D2 决定 `edges.disclosure` 参与检索，则「入边消失」会连带条件消失）。

### §3.6 迁移（用户明确要求「两者都要」）

**两个独立交付物**：

**(a) 存量库 schema 迁移**：把 v2 库升级到 v3，**不丢数据**。
- 现状是 cold rebuild（删库），用户有真实库，MUST NOT 丢。**迁移样本（2026-09-16 实测，MUST 连路径引用）**：
  - `/home/yoshix7ti/world/magnolia/elias/.pi/memory.db` —— **120 nodes / 86 带 disclosure / 3 aliases / 0 edges**（现库，带 WAL）
  - 同目录另有 `memory.migrated.db`（73/73/0）与 `memory.db.pre-elias-migration-20260914`（105/79/0）——**不是现库，勿混用**
  - ⚠️ **快照纪律**：本机有 9 个 `elias/memory.db`，同一 `.pi/` 下可有 3 个版本。**引用真库 MUST 写全路径**（本契约初版写「elias 116 节点」是旧数，且主 agent 曾误引 73 节点的模板副本）。
- FTS 表不能 ALTER → 必须 DROP + 重建 + 全量 reindex。
- disclosure 数据：`nodes.disclosure` 已有值**必须保留**（迁到何处见 §3.1 回退规则——对无入口的节点，留在 `nodes.disclosure`）。
- MUST 有回滚/备份策略与幂等性（重复跑不坏）。
- 子文档 D3 负责。

**(b) `relocate` 与 disclosure 的关系**：见 §3.5。
- 子文档 D1/D3 共同负责（D1 定语义，D3 定迁移时存量数据怎么办）。

### §3.7 前端与文档（用户明确要求）

- **前端显示（2026-09-16 精确化）**：初版写「7 视图全显示」——**过宽**。`memory-views.ts` 函数归属核实后裁定：

| 视图 | 裁定 | 理由 |
|---|---|---|
| `tree`（**默认落地页**）| ✅ MUST | 当前 0 处，最高优先；且 `TreeNodeDTO` 缺字段（§2.8）|
| `node` | ✅ MUST | 已有，需改口径为 `effectiveDisclosure` |
| `recent` | ✅ MUST | 已有（`:158`）|
| `search` | ✅ MUST | 已有 |
| `wakeup` | ✅ MUST | 已有（`:103,110`）|
| `edit` | ✅ MUST | 表单里已有；需支持入口级 |
| `forgotten` | ⚠️ MAY（D5 判）| 语义打架：该视图卖点就是「多久没被想起」，再叠想起条件会稀释两个信号 |
| `timeline` / `index` / `diagnostic` / `glossary` | ❌ MUST NOT | 语义无关 |
| `audit` / `databases` | ❌ MUST NOT | 管理页 |

D5 MUST 在文档里给出逐视图的「显示 / 不显示 + 理由」表，MUST NOT 笼统说"全显示"。
理由（§8 T1 同源）：**「到处都显示」≠「更好用」**。
- 视觉权重 **MUST 对标 nocturne**：琥珀色/警示色 + 图标，而非 `mw-muted` 灰化。
- **文档**：`docs/memory-system.md` 补 disclosure 专门段落（当前仅 1 次提及）。
- **自触发指导文本**：对齐 nocturne `docs/system_prompt.md:36`（「disclosure 条件被触发时 MUST 主动读取」）。子文档负责确定 pi-rp 的落点。

### §3.8 命名与术语（冻结）

| 概念 | 统一用词 |
|---|---|
| 字段本体 | `disclosure` |
| 中文 | **想起条件**（历史用词，保留） |
| 计算后的值 | **生效想起条件**（effective disclosure） |
| 入口 | **entry**（别名入口 / 边入口） |
| 工具参数 | `when`（**不改名**） |

---

## §4 模块切分与归属（主 agent 裁定）

| 编号 | 模块 | 负责范围 | 明确 NOT |
|---|---|---|---|
| **D1** | 数据模型与语义核心 | §3.1 回退规则、§3.4 revise 裁定、§3.5 relocate 语义、`effectiveDisclosure` 签名、edges/aliases 的 CRUD | 不写迁移脚本（D3） |
| **D2** | 检索与打分 | node_fts 多列改造、bm25 权重、reindexNode 改造、tokenize 路径 | 不做 UI |
| **D3** | 迁移 | v2→v3 迁移器、FTS 重建、幂等/回滚、存量 disclosure 处置 | 不改检索权重（D2） |
| **D4** | 工具层 | 12 工具的 `when` 参数接线、associate/memorize/revise 的目标层、工具描述文案 | 不改 schema |
| **D5** | 前端与文档 | 7 视图显示、视觉权重重做、docs 补段落、自触发指导文本落点 | 不改数据层 |
| **D6** | 渲染与测试 | revise 的 diff 渲染（见 §6）、测试策略、回归夹具 | — |

**跨模块边界**：D1 的 `effectiveDisclosure` 是 D2/D4/D5 的**唯一**入口；D2 的 FTS 列名是 D3（迁移）与 D4（reindex 触发）的契约。

---

## §5 顺手修的既有问题（发现即修，不推给下一波）

| 编号 | 问题 | 位置 | 归属 |
|---|---|---|---|
| **X1** | `MEM://` URI 解析 off-by-one | 已在上一轮修复（P17） | — |
| **X2** | 沉睡时间基准混用 | 已在上一轮修复（P18） | — |
| **X3** | `relocateMany` 从不重写 `edges.target_uri` → incoming 边静默消失 | `plan/memory-web/00` §12 P1 | D1 MUST 评估是否加重 |
| **X4** | `node_fts` 单列导致不能独立加权 | `schema.ts:78` | D2 本任务核心 |
| **X5** | 前 3 轮已修的同型缺陷：`setAttribute("onclick")`（`el()`/`h()`）| 已修 | — |
| **X6 (M3)** | `consolidate(link)` 建的别名是**死别名**：`resolveUri` 先命中 `nodes.uri` 才看 `aliases`（`store.ts:181-189`），而 `link` 时 `src.uri` 仍是 `nodes` 里的行（`tools.ts:917`）⇒ 别名永不生效 | `store.ts:181-189` + `tools.ts:915-919` | **D1**（已复核属实）。**直接威胁本改动前提**——见 §3.1 的别名判定要求 |
| **X7 (C7)** | `addAlias` 无 `logAudit`（`addEdge` 有） | `store.ts:784-788` vs `:760` | **D1**（已复核属实） |
| **X8** | 契约 §2.4 三处笔误（`associate.when` 重复列、`remember` 不存在、漏 `consolidate.when`） | `tools.ts:758-765,823` | 已修（2026-09-16） |

> 实现期若发现新缺陷，就地登记进本节，并在同一批次修掉（除非它阻断设计）。

---

## §6 渲染轨（用户 2026-09-16 要求，独立子轨）

### §6.1 需求（用户原话）

> 「塞 details 还有一个显而易见的好处，就是容易审计。」（**details 是被认可的方案**）

> 「edit diff & write 这边也要对齐。」

> 「顺手把 memorize →『铭刻记忆』这种工具名的 render 给去掉，保持工具风格统一。」

### §6.2 已核实的事实（三路 scout）

- **write 的 result 成功时零渲染**：`write.ts:170-176` `if (!result.isError) return undefined`。**用户的猜测成立。**
- **edit 的 diff 两处算**：① 预览 = `renderCall` 里 `computeEditsDiff` **直接读盘**（`edit-diff.ts:531-537`）；② 权威 = `execute` 里 `generateDiffString` 塞进 `details.diff`（`edit.ts:356-365`）。
- **edit 的显式去重**（全仓唯一）：`edit.ts:232-234` `if (resultDiff && resultDiff !== previewDiff) return renderDiff(...)`。
- **`memory-renderers.ts:114` 的注释「J5 — there is no before-body」是错的**：改前正文在 `tools.ts:534` `let content = node.content` 就有。真问题是**渲染器拿不到 store**（`extensions/types.ts:479-500` 无 store/dbPath）。
- **接线点就在同一作用域**：`agent-session.ts:4295` `const store = await getMemoryStoreSingleton(dbPath)`，`:4297` 调 `_createMemoryModuleHost()`。改成工厂注入是 **2–3 行**。
- **`details` 对 LLM 零 token 成本**（provider 只取 content），只占 session JSONL。
- **格式陷阱**：`diff.ts:9` `parseDiffLine` 正则要求 `+`/`-` 后紧跟空白；手拼 diff 会被**静默涂灰**。MUST 走 `generateDiffString`。
- **路径 B 的致命缺陷**：`tool-renderer.ts:90`（初版误写 `:84`，D6 三次实测订正）HTML 导出**硬编码 `argsComplete: true`** → 读库拿到改后正文、diff 退化成空。**故 B 单独使用在导出场景是错的。**

### §6.3 冻结的渲染方案

**采用 Path A + B 混合**（= edit 的完整模型）：

| 槽 | 数据来源 | 说明 |
|---|---|---|
| `renderCall` **预览** | **Path B**：`argsComplete` 时读库（持有 session 的 store） | 有流式预览感 |
| `renderResult` **权威** | **Path A**：`execute` 把 before/after 塞 `details` | 回放/导出正确、**易审计**（用户明确认可） |
| 去重 | **不能照抄 `edit.ts:232-234`**（2026-09-16 由 D6 顶回并实测，主 agent 复核属实）——见下方「去重的必要修正」 | 防止两槽各画一遍 |

#### 去重的必要修正（2026-09-16）

**契约为初版写「照抄 `edit.ts:232-234`」——错误。** D6 指出并实测：

- edit 的 call 与 result **共用同一个组件**：`edit.ts:397` `renderResult` 取 `context.state.callComponent`，`edit.ts:383` 的预览也写它 ⇒ 两槽互斥才有意义。
- memory 的 call 与 result 是**两个独立槽**：`tool-execution.ts:286`（`callRendererComponent`）vs `:307`（`resultRendererComponent`），各自 `addChild`。
⇒ 照抄 edit 的判据会得到「**预览有、权威无**」——result 槽在 `details.diff === previewDiff` 时返回 `undefined`，而它**不会**替换 call 槽的预览。

**修正后的去重规则（冻结）**：
- **逐段比较**（batch 场景每个 mod 一段），不是整串比较。
- **结果槽恒画权威**（`details.diffs` 存在就画），**不因与预览重复而省略**。
- 重复控制的正确位置是**预览侧**：`renderCall` 在 `argsComplete` 后才读库（Path B），而 `renderResult` 到达时预览已显示——重复是可接受的（两者语义不同：预览=改前推测，权威=实际结果）。
> D6 归属，证据：`tool-execution.ts:286,307` + `edit.ts:383,397`。

**硬约束**：
1. MUST 走 `generateDiffString`，MUST NOT 手拼 diff 字符串。
2. MUST 持有 **session 那一个 store 实例**，MUST NOT 从 `context.cwd` 反推 DB 路径（`extensions/memories/index.ts:9-11` 明文纪律）。
3. batch 是 N 条异构操作 → **逐 mod 各画一段 diff**，MUST NOT 拼成单个"文件 diff"。
4. 渲染器 MUST NOT 返回 `undefined`（`Container.addChild` 不校验 → 下次 `render()` 抛错 → 无 catch → 崩进程）。
5. 读库 MUST 只走纯 SELECT（`resolveUri`/`getNode`/`listRevisions`），MUST NOT 调 `markAccessed`/`logAudit`（读路径零写纪律）。
### §6.4 工具名 render 统一（用户明确要求）

**现状**：`memory-renderers.ts:85,126` 在 header 硬写 `theme.bold("铭刻记忆")` / `theme.bold("修订记忆")`。
**对照**：`write.ts:147` 硬写 `theme.bold("write")`、`edit.ts:208` 硬写 `theme.bold("edit")`。

**裁定（冻结）**：memory 工具 header 改用**工具自身名**（`memorize` / `revise`），与 `write`/`edit` 风格统一。**这也顺带解决「中文名与 label 字段重复」**。

> ⚠️ `src/tools.ts:1077` 的 `label: "铭刻记忆"` 是**另一处**（`label` 字段）。`label` 当前在 TUI 里**不被消费**（`tool-execution.ts` 用 `this.toolName`）。D6 MUST 决定：是否同时把 12 个工具的中文 label 改为英文（对齐 `write`/`edit` 的 `label: "write"` 风格）。**建议改，但需 D6 给证据**（列出所有 `label` 消费者）。


**§6.5 app.css 行数预算（2026-09-16 修正，D5 报告事实后裁定）**

- 契约初版写「现状 184 行、预算 ≤250」——**184 是上一轮的旧数，已过时**。
- 实测：`src/web/assets/app.css` = **246 行**（`wc -l`），头部注释明写「< 250 行」。
- **裁定：预算放宽到 ≤ 300 行。** 理由：disclosure 徽章是已确立的视觉语言（`.mk-*` 9 条已存在），硬压到 246 会伤害可读性，而「行数预算」本是防臃肿的自律而非硬指标。
- **同时要求**：D5 MUST 在 §6 里给出「新增 N 行 / 删减 M 行」的净额核算，MUST NOT 只增不删。
- 证据（D5 提供，主 agent 已复核）：`src/web/assets/app.css:1`（头部注释）、`:199-207`（9 条 `.mk-*`）。

---

## §7 验收门槛（冻结）

1. **排序逐位对比（2026-09-16 修正，D3 顶回后采纳）**：初版只要求「改动前 vs 改动后 top-N 逐位对比」——**过粗**，会把三个原因混成一坨（与门槛 8 同源）。**MUST 拆成三段对照**：

| 对照 | 固定 | 变动 | 期望 | 证明什么 |
|---|---|---|---|---|
| **(a) DDL/列布局** | 文本（同一次 reindex 输出）+ 旧权重（无权重 bm25）| 两列 vs 三列 | **差异 = 0**（必要条件）| DDL 改造本身不引入差异 |
| **(b) 权重** | 文本（固定）| `bm25()` 权重（无权重 → **`0.0,1.0,1.0`**）| 差异可量化 | `1.0` 的真实效果（**初版此格误写 `2.5`，§3.2 已推翻**）|
| **(c) 文本修复**（迁移专属）| 权重（固定）| 存量陈旧文本 vs 重算文本 | 差异 = 陈旧修复量 | 迁移的可见后果（**期望行为**）|

- **(a) 差异 ≠ 0 即 bug**，(b)(c) 的结论都不可信。
- **实测依据**（主 agent 独立复核 D3 的发现）：真库 `world/magnolia/elias/.pi/memory.db`（120 节点，49 触发词）中 **30/49 glossary 关键词不在 `node_fts.text`**（样本：`排骨藕汤`/`焖烧罐`/`问好`/`周明瑞`/`p4告警`）⇒ 存量 FTS 确实陈旧，迁移全量 reindex **必然改变排序**。与上一轮 §17 的「glossary reindex 时序 bug」同源（当时只修 `import()`，存量未修）。
- D2 §10 MUST 给出三段（每段：命令 + 输出 + 归因），MUST NOT 只写单一 before/after。
2. **迁移真跑**：v2 库 → v3 库 MUST 在**真库副本**上跑过，且 `nodes`/`aliases`/`edges` 行数与 disclosure 值逐条不变（除设计要改的）。
3. **幂等**：迁移跑两遍结果一致。
4. **回滚**：迁移失败 MUST 可恢复。
5. **渲染**：`details` 落盘可审计（照 `test/fixtures/before-compaction.jsonl:37` 的先例——`:37` 是 `toolName:"edit"` 的 toolResult；初版误写 `:31`，那是 `role:"user"` 消息，不含 `details`）。
6. **前端**：按 §3.7 的**逐视图三档表**（MUST/MAY/MUST NOT）验收——**不是**「7 视图全显示」；浏览器实测无控制台错误。
7. **全量门禁**：`npm run check` + `packages/memory` 全测 + `packages/coding-agent` 相关测试。**由主 agent 统一跑**，子代理跳过。
8. **核验范围 = 门禁范围**，失败 MUST 归因到错误类型（不是只看计数）。
9. **真库数据引用纪律（2026-09-16 新增，本批次两次事故换来）**：
   - **MUST 写全路径**（本机有 9 个 `elias/memory.db`，同一 `.pi/` 下可有现库 + 迁移产物 + 备份三个版本）。
   - **WAL 纪律（2026-09-16 RevHonesty 实测订正）：MUST 先对「源库」checkpoint，再拷贝；或一律 `VACUUM INTO`。** ⚠️ **顺序不可颠倒**——`cp memory.db out.db`（不带 `-wal`）**已读到旧快照**，事后对**副本**跑 `PRAGMA wal_checkpoint(TRUNCATE)` 只作用于副本自身的 WAL，**无法补救**。实测同一路径：裸 `cp` = 122 nodes/88 disc；`VACUUM INTO`/带 `-wal` = 121/87。真库有 4MB 未合并 WAL。
   - **探针 MUST 复跑一致**（两次结果相同才可引用）。
   - 事故记录：① 主 agent 误引模板副本（73 节点）当现库；② D2 初稿漏 `-wal` 导致全部测量无效。
10. **对照臂 MUST 在数学上可区分（2026-09-16 新增，D2 自我订正换来）**：
   - 若两个对照臂取值在数学上恒等，其「完全一致」的结论是**同义反复、零信息量**，**MUST NOT** 当作回归证明。
   - 实例：D2 的 (b′) 段「`1.0/1.0` 零扰动 86/86」——因 `bm25(t) ≡ bm25(t,1.0,1.0)`（FTS5 默认权重即 1.0），两侧本就是同一函数取值。**它不是回归证据，是「推荐值 == 现状默认」的恒等校验**。
   - **正面证据的正确形态**：用 (b) 段「`2.5` 引入 13/86 噪声」证明权重确有影响，再据默认值恒等裁定取 `1.0`。
   - 与门槛 9 同族：9 抓**数据引用层**（引用错快照），10 抓**对照设计层**（对照臂不可区分）。

---

## §8 已知陷阱清单（子文档 MUST 逐条核对）

| # | 陷阱 | 出处 |
|---|---|---|
| T1 | 「加了检查」≠「更安全」——守卫会误伤已明文支持的特例 | `00-共同上下文.md` §9.1 |
| T2 | 安全开关缺省值 MUST 最严，且缺省路径 MUST 被编译期/测试抓住 | 同上 |
| T3 | 「测试绿、生产死代码」：必填字段的容器本身 MUST 必填 | 上一轮实测 |
| T4 | 「修 A 引入 B」：改调用点时 MUST 重查该点全部契约义务 | 上一轮实测 |
| T5 | 静默缺陷最危险（`setAttribute("onclick")` 类）——需要阳性对照 | 上一轮实测 |
| T6 | 断言症状 = 把 bug 奉为规范；写断言前先问「这是设计要的吗」 | workflow skill |
| T7 | 契约一改 MUST 立刻广播（定向 + 广播两条都要） | 同上 |
| T8 | `parseDiffLine` 会静默涂灰手拼 diff | `diff.ts:9` |
| T9 | FTS5 表不能 ALTER，改列 = DROP + 重建 | SQLite 语义 |
| T10 | `schema.ts` 现状是 cold rebuild，**没有**迁移路径 | `schema.ts:3` |
| T11 | **两个拒收闸门 MUST 同批改**：`schema.ts:131-138` + `web/discovery.ts:190-196`（只改前者 ⇒ 多库 web 路径继续拒 v2）| 2026-09-16 D3 侦察（已复核）|
| T12 | **`createSchema` 是唯一安全迁移收口点**：生产 `index.ts:125` + **测试 7 个文件直调**（`module` / `phase3` / `recall` / `search-keyword` / `slots` / `store` / `tools`），装在别处会被绕过。⚠️ `module.test.ts`（`:27-28`）用裸 `openDatabase`+`createSchema`，**绕过 `openMemoryStore`** —— 它正是最容易漏的那个 | 同上（主 agent 初稿漏 `module.test.ts`，MarineMammal 顶回）|
| T13 | **探针 MUST 只读且不迁移**（`12-…:470-473` 把 readonly-probe 当安全属性）| 同上 |
| T14 | **审计门禁有盲区**：`test/web/audit.test.ts:239` 只扫 6 个文件（**不含 `schema.ts`**）⇒ 在 `schema.ts` 写未登记事件名**门禁绿**。迁移事件 MUST 明确决策（登记进 `AUDIT_EVENTS`+文件清单，或明确不审计）| 同上（已复核）|
| T15 | **覆盖可能是同义反复**：`test/store.test.ts:172` 用同一常量写读（`store.ts:1342`）；`incompatible` 分支零覆盖；**全仓无 v2 fixture** | 同上（已复核）|
| T16 | **失败被通用 catch 吞掉**：`agent-session.ts:4290-4320` 会把半迁移库伪装成「功能未配置」 | 同上 |
| T17 | **归属 MUST 精确到执行者**，不得因同名合并认领（本批次两个 D3 实体）| MarineMammal 提出（已采纳）|
| T18 | **`INSERT OR REPLACE` 三态陷阱**：本批次 **11 处** `OR REPLACE`，其中 **5 处**写 `aliases`/`edges`（`store.ts:678,758,786,1308,1317`）MUST 改。**两个方向的 pattern-match 都错**：① 照改裸 `ON CONFLICT DO UPDATE`（丢「快照覆盖」语义）；② 保持裸 `OR REPLACE`（旧快照清空）。**正确解 = 显式三态**：键缺失=保留 / 显式 null=清除 / 有值=写入 | D1 普查（主 agent 已复核）|
| T19 | **政策改动会让文案变成谎话**：改「不迁移冷启动」→「就地迁移」后，两处文案 MUST 同批改——`app.js:364`（`invalid_db` 说「请先升级 / 迁移记忆库」会在 v2 自动迁移后**反向误导**，只剩「库高于程序」一种情形）、`databases.js:101` + `discovery.ts:190-196`（`detail` 的「（无就地迁移）」MUST 改「（打开时会自动迁移）」）| D5 提出（主 agent 已复核）|
| T20 | **`import()` 旧快照的「键缺失」≠「null」**：`ExportSnapshot.aliases:107`/`.edges:108` 类型无 `disclosure`，`export()` SELECT（`store.ts:1238-1250`）也不取 ⇒ 往返静默丢。MUST 四处同步（类型 / SQL / §9 / 验收）| D1 发现 |
| T21 | **同一字面量多 owner = 静默丢改动**：`agent-session.ts:4363-4374` 是**同一个** `definition` 字面量——D6 改签名/展开（机械），D4 加 `promptGuidelines` 键（数据）。**该 hunk 的 diff MUST 同时含两者** | RevFeasibility 提出（已复核）|
| T22 | **`promptGuidelines` 端到端四道，漏一条即整链失效**：`tools.ts` 定义(③) → `registerTool` 6 键白名单(④ `module.ts:70-79`) → **跨包** `agent-session.ts:4363-4374`(⑤) → `types.ts:519`（已存在该字段）。实测 `packages/memory/src/` 全包 `grep promptGuidelines` = **0**；且 `agent-session.ts` **现有 6 处**（`:1315,1540,1545,1562,1592,4127`）⇒ **任何「全文件 grep ≥1/≥3」的断言今天就是绿的、抓不住漏接**。⇒ **主门禁 MUST 打到链路终点**：断言构造出的 `ToolDefinition.promptGuidelines` 非空含「想起条件」，或真跑 prompt 编译断 `Guidelines:` 段 | 同上（R2 复核实测）|
| T23 | **证据脚本 MUST 归档**（`/tmp` 会蒸发）：现存 **`probes-d2/`**（`d2-evidence-{isolate,entry,asserts}.mjs` + README）、**`probes-d3/`**（19 个）、**`d6-probes/`**（7 个）。**T23 只要求「可跑 + README 索引 + 真库全路径 + WAL 纪律」，不锁文件名。** 其中 **`probes-d2/d2-evidence-entry.mjs` 是「入口条件不进 FTS」（方案 1）的唯一实测证据**；**MUST NOT 借改写弱化 bm25 `0.0,1.0,1.0` 与方案 1 的裁定** | RevFeasibility 提出（已复核）|
| T24 | **备份文件名只靠秒级时间戳会撞名**：`VACUUM INTO` 对已存在文件直接失败（主 agent 实测：`output file already exists`）。生产可达——`openMemoryStore` 有 **5 个入口**（`agent-session.ts:231`、`extensions/memories/index.ts:36`、`web/cli.ts:197`、`web/registry.ts:384`、`web/routes.ts:1187`），多入口并发首开同一 v2 库可同秒触发。后果：备份失败但迁移继续 ⇒ **用户以为有备份实际没有**。⇒ 命名 MUST 带序号（`-N`），MUST NOT 依赖随机数（备份要用户能一眼找到）| D3 实测（主 agent 已复核）|
| T25 | **「能跑通一次」≠「可复跑」**：D3 连跑 17 个探针两遍，**3 个不可复跑**（`verify.mjs` 备份撞名、`probe7.mjs` 预期失败未捕获致 exit 1、`timing3.mjs` 残留 db 撞 UNIQUE）。⇒ **交付的证据脚本 MUST 先自证可复跑**（连跑两遍 exit 0），否则等于没有证据——复核者拿不去跑 | D3 提出（已采纳）|

---

## §9 子文档统一结构（12 节）

每份子文档 MUST 按此结构（长度可比实现文件长，正常）：
1. 一句话定位
2. 签名与参数（精确）
3. 行为契约逐步（每步写「漏了会怎样」）
4. 文件与副作用（带 `file:line`）
5. 落账/审计
6. 前端/UI 影响
7. 错误边界与降级
8. **代码落点**（精确到文件与函数）
9. 与现状差异（含**迁移**影响）
10. 验收测试（含**一条非空性断言**：没有此修改就会失败）
11. **发现的冲突 / 需要修订的上位文档**
12. **仍未知待拍板**

---

## §10 纪律（硬约束）

- **跳过全量构建/测试/lint**——那是主 agent 的活。只跑自己那片的快速检查，并把输出贴进报告。
- 结论带 `file:line`；推断标 `[推断]`；未知不许伪装成已定。
- 有重大发现/阻断 → **立刻** `hub` 报告，不要憋到最后。
- peer 列表与边界见 §4；范围重叠 → 先发消息达成一致。
- **契约一改，主 agent 立刻广播**（§8 T7）。
- 现状断言（§2）的实现前复核义务。

---

## §11 待主 agent 裁定 / 已知未决

| # | 事项 | 状态（2026-09-16 全部收口） |
|---|---|---|
| U1 | `effectiveDisclosure` 签名与落点 | ✅ **D1 定稿**（`21` §2.1 + §3-M8 两分支伪码）；主 agent spike 已验证三场景 |
| U2 | bm25 权重 | ✅ **裁定 `bm25(node_fts, 0.0, 1.0, 1.0)`**（D2 实测顶回初版 2.5；`1.0` = FTS5 默认，行为保持） |
| U3 | `revise({when})` 写哪一层 | ✅ **D1 裁定：写「结构层」**；评审后又定 **`setEntryDisclosure` 优先级镜像 `resolveUri`**（写路径=读路径优先级） |
| U4 | 12 个中文 label 是否统一改英文 | ✅ **D4 裁定改**（零消费者已独立复核）；**归 D4**（不是 D6——D6 只负责 `memory-renderers.ts:85,126` 的 header，已由主 agent 落） |
| U5 | 迁移是否保持 backward-compat | ✅ **不保持**（D3 给 5 条理由 + 实测：旧版对 v3 库的唯一失败点是 `createSchema` 守卫，数据形状兼容） |
| U6 | `AliasDTO.dead` 是否加 | ✅ **批准**（D5 提出，见 §3.2 补充裁定 3） |
| U7 | `SearchItemDTO.disclosure` 口径 | ✅ **D2 裁定：选项 (b)** `effectiveDisclosure(item.uri)`（D5 待消费） |
| U8 | `edge.disclosure` 的读取者 | ✅ D1 定：仅 `retrieve` 沿边扩散展示，不参与打分、不进回退链 |
| U9 | 迁移器是否写 audit 事件 | ✅ **D3 裁定：不写**（`schema.ts` 里 MUST NOT 出现 `logAudit`） |
| U10 | 迁移失败是否独立错误分支 | ✅ **D3 裁定**：消息带稳定词根 `migration failed`，**不改** `agent-session.ts` 结构 |
| Q4 | `tools.ts:413/426` 两处读点口径 | ✅ **裁定：统一改道 `effectiveDisclosure`**（评审发现 D1/D4 冲突后定） |

---

## §12 变更记录

| 时间 | 变更 | 广播 |
|---|---|---|
| 2026-09-16 | §2.9 新增：`associate` 的 `when` 静默丢弃（既有 bug） | 已广播 |
| 2026-09-16 | §2.8 新增：三张 DTO 无 disclosure（D5 提供，已复核） | 已广播 |
| 2026-09-16 | **§3.1 修正**：nocturne `edge` = 层级路径段（非联想边）；`aliases.disclosure` 才是真对应物；回退链剔除 `edges` | 已广播（含定向 D1/D2/D4） |
| 2026-09-16 | **§3.5 修正**：relocate 别名的 disclosure 来源重新定义；发现 `INSERT OR REPLACE` 漏列导致静默丢失 | 已广播 |
| 2026-09-16 | §3.2 批准：`TreeNodeDTO`/`EdgeDTO`/`AliasDTO` 各加可空 `disclosure` | 已广播（含定向 D5） |
| 2026-09-16 | **§3.1 回退链精确化**：裁定 `effectiveDisclosure` 镜像 `resolveUri`（节点优先），给两分支伪码（D2 实测挑战后裁定） | 已广播 |
| 2026-09-16 | §5 登记 X6(M3 死别名) / X7(C7 addAlias 缺 audit) / X8(§2.4 笔误) | 已广播 |
| 2026-09-16 | §3.2 新增例外条款：`EdgeDTO.disclosure` = 裸列（非入口级），UI MUST 视觉区分（D5 提出） | 已广播 |
| 2026-09-16 | §3.4 采纳 D1：revise 写「结构层」；`??` 回退语义；NULL 无法表达"永不主动想起" | 已广播 |
| 2026-09-16 | §3.7 精确化：逐视图「显示/不显示」表（初版"7 视图全显示"过宽） | 已广播 |
| 2026-09-16 | **§3.2 正文补全**：`NodeDTO` 取值口径变更（入口作用域）+ `EdgeDTO` 例外 + `AliasDTO.dead`（RevConsistency 发现 changelog 记了但正文没落） | 已广播 |
| 2026-09-16 | **§3.4 补裁定**：`setEntryDisclosure` 优先级**镜像 `resolveUri`**（写路径=读路径优先级）；D1 的 T-7 据此改写 | 已广播 |
| 2026-09-16 | §11 全部 U 项收口（U1–U10 + Q4） | — |
| 2026-09-16 | §7 门槛 1 三段→四段对照（(a)(a′)(b)(c)）；门槛 9（WAL/全路径）；门槛 10（对照臂可区分） | 已广播 |
| 2026-09-16 | §8 陷阱 T11–T20（D3 侦察 6 条 + OR REPLACE 普查 + 政策文案 + 快照三态 + 归属） | 已广播 |
| 2026-09-16 | 实现前 spike 验证 `effectiveDisclosure` 三场景（脚本 `_spike-effective-disclosure.mjs`）| 已广播 |
