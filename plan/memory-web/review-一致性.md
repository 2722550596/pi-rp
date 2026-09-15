# review-一致性 · 跨文档一致性与契约冻结遵守

> 评审人：DefeatedChickadee（worker）
> 范围：`00-共同上下文.md`（冻结契约）+ D1–D6 共 6 份设计文档
> 纪律：只读 + 只写本报告；未改任何被评产物。结论均带 `文件:行`。
> 代码以 `packages/memory/src/` 为准（行号相对该目录）。
> **契约评审版本：#1–#11 全量**（含 #8 错误码 6→7、#9 P17 `MEM://` off-by-one、#10 §16 接口裁定、#11 `EdgeDTO.node_id` 语义更正）。
> ⚠️ **D1 在被并发编辑**（`stat` 显示 `09:15:24`，行号在我评审期间已漂移两次）——本报告中 D1 的行号为**我读取时**的值，核验时请按内容定位。

---

## ① 结论

**不可直接进入实现。** 契约**前 7 次变更**（§7.4/§6.6/§8.3/§4.2/§7.1/§9.1/§16 之外）在 6 份文档里**执行得干净，旧版本引用已全部清零**；路由表、术语、`importance` 极性三项**零违规**。**全部问题集中在契约变更 #8–#11 的传播断层**——#10/#11 只有 D1 收到并部分落地（D1 文件时间 `09:15` > 契约 `09:14`），D2/D3/D4/D5/D6 的时间戳（`08:08`–`08:34`）**全部早于契约落笔**，仍带旧字段名、旧 owner、旧取数法。另有 D1 一处**新引入的 DTO 断言错误**（#11 尚未落地）。均为单点、低成本修正。

---

## ①.5 ⭐ 谁需要改 —— 「各文档写在哪一版契约上」一览表

（`stat -c '%y'` 实测；契约前次落笔 `09:14:23`，#12 非空性收紧落笔 `09:16:20`）

| | 旧 7 次变更 | #8 错误码 7 码 | #9 P17 | #10 §16 | #11 node_id | #12 非空性收紧 | 结论 |
|---|---|---|---|---|---|---|---|
| **D1** `01` (`09:16:21`) | ✅ 全对 | ✅ 已改 | ✅ 已改 | ⚠️ 部分（16.2 ✅ ／ 16.5 ❌ ／ 16.6 ❌） | ❌ 未落地（注释仍错） | —（非 parity owner） | **小修 3 处** |
| **D2** `02` (`08:08:12`) | ✅ 全对 | ❌ 无 code 表（低危） | — | ❌ **未动**（`parent_id`、`source_uri`） | ❌ 消费名受影响 | — | **须改 3 处** |
| **D3** `03` (`08:23:33`) | ✅ 全对 | — | ✅ 已自证 | ⚠️ `around` 已请求＝已批准，未提 `centered` | — | ✅ 给了四要素（`:744-750`） | **小修 1 处** |
| **D4** `04` (`08:29:19`) | ✅ 全对 | — | ❌ **未动**（仍写「数字段是 limit」为权威） | ❌ `MAX_RAW_ID_HINT` 仍在；`audit.js` 未认领 | — | ❌ **T15 已被证恒真**（`:1046/:1068` 仍在） | **须改 4 处** |
| **D5** `05` (`08:23:20`) | ✅ 全对 | ⚠️ 未提 `conflict`（无 code 表，低危） | — | ✅ `current_version` 已硬需求，仅措辞过期 | ⚠️ 边警告需用 `uri` | — | **小修 2 处** |
| **D6** `06` (`08:33:49`) | ✅ 全对 | ❌ 无 code 闭合性断言 | — | ❌ 无 `audit.js` owner；无字段名核验项 | — | ⚠️ 纪律已对（`:395`），未点 T15 作废 | **须改 2 处** |

> 一句话：**D1 最接近同步；D2/D4 是 #10 的重灾区；D6 需补 #8/#10 的核验项；D4 的 T15 已被契约 #12 判为假绿。**

---

## ② Blocker（必须改才能实现）

### ②-1 【#11】D1 `EdgeDTO.node_id` 的注释**已被实测推翻**（我独立复现）
- **`01-服务端与API.md:427`**（我读取时）写 `node_id: string; // outgoing: 目标节点；incoming: 源节点`。
- **我的实测**（`/tmp/spike_edge.mjs`，`openMemoryStore("")` + `put(a)`/`put(b)` + `addEdge(a.node_id, "core://p/b")`）：
  ```
  A node_id: n_mu1zckgc_5_z252ep
  B node_id: n_mu1zckgd_6_3idkd0
  listRelated(a): [{"direction":"outgoing","node_id":"n_mu1…","target_uri":"core://p/b"}]
  listRelated(b): [{"direction":"incoming","node_id":"n_mu1…","target_uri":"core://p/b"}]   ← node_id 仍是 a
  ```
  代码依据：`store.ts:768`（outgoing）与 `:773`（incoming）**两个 SELECT 都取 `node_id`（= `edges.node_id`，边的源）**。
- **契约** `:659-665`（§16.1，已被 #11 更正）：`node_id` **两个方向都是边的源**，不是对端；`uri` 才是对端。
- **为什么是 blocker**：D1 若按错误注释填 `node_id`，D2 会拿**源节点**当链接目标渲染（outgoing 方向能对上，incoming 方向指向自己）。D2 `:428-429` 已按 D1 的注释消费 → **错误会向下游传染**。
- **建议**：D1 改注释为「两个方向都是 `edges.node_id`（源）」；`uri`/`resolved_uri` 填对端（outgoing → `resolveUri(target_uri)`；incoming → `node_id` 反查）。D2 渲染可点链接**用 `uri`，别用 `node_id` 当对端**。

### ②-2 【#10·16.5】D1 静态资源**未剥 `/assets/` 前缀** → D2 整页 404
- **D1** `01:301`：「静态根 = `assetsDir`。`/` → `index.html`；其余 **`/app.js`、`/views/tree.js`、`/vendor/pico.min.css`** → `assetsDir` 下同名相对路径」。
- **D2** `02:155/156/170`：`<link href="/assets/vendor/pico.min.css">`、`/assets/app.css`、`<script src="/assets/app.js">`。
- **契约** `:684-688`（§16.5）：`/assets/` 是唯一前缀，D1 MUST 剥前缀再映射。
- **为什么错**：照 D1 现文实现，`/assets/app.js` → `assetsDir/assets/app.js`（不存在）→ 404。D2 的每一页白屏。
- **建议**：D1 §5.3 改为「以 `/assets/` 开头 → 剥前缀 → 映射 `assetsDir`」；加 §16.5 要求的穿越测试（`/assets/../serialize.ts`、`/assets/%2e%2e/x` 均 404）。

### ②-3 【#10·16.6】D1 用 `ViewResponseDTO`，D4 用 `ViewDTO`
- **D1** `01:747`：「响应 = D4 定义的 **`ViewResponseDTO`**」。
- **D4** `04:291`：`export function buildView(...): ViewDTO;`。
- **契约** `:690-692`（§16.6）裁定统一 `ViewDTO` / `buildView`。
- **建议**：D1 `:747` 改 `ViewDTO`。

### ②-4 【#10·16.3／16.1】D2 仍用 `parent_id` 与 `source_uri`（契约已明令作废）
- **`02:292`** `"parent_id": "n_xxx"`；`:314`「层级缩进：**以 `parent_id` 为准**」；`:443`、`:840` 同。
- **`02:429`** `"incoming": [ { node_id, source_uri, kind, target_uri, resolved_uri, dangling } ]`；`:436/:541/:546/:823/:997` 同。
- **契约** `:674-676`（16.3）：「D2 的 tree DTO（`02:292`）用了 `parent_id` → **D2 MUST 改名为 `parent_uri`**」；`:664`（16.1）：「D2 的 `source_uri` 命名**作废**，统一用 `uri`/`resolved_uri`」。
- **为什么错**：D1 按 §16 产出的 DTO 里没有 D2 读的名字 → 树缩进与入边渲染全拿 `undefined`。
- **建议**：D2 全局替换 `parent_id` → `parent_uri`、`source_uri` → `uri`/`resolved_uri`。

### ②-5 【#9 / 契约 P17】D4 仍把 `MEM://` 解析当权威口径，且 `MAX_RAW_ID_HINT` 未删
- **`04:304`** 表格「`forgotten` | 5 | `tools.ts:225` | ⭐ **数字段是 limit 不是 domain**」；`:311-323` 整段以 `parseViewCount` 组合为权威，称 `MEM://forgotten/3` → `limit=3`。
- **`04:333`** `store.listRaw(0, MAX_RAW_ID_HINT, { activeOnly: true })`；`:338`、`:882`、`:999` 同。
- **契约** `:451-464`（§8.1 重写 + P17）：`"MEM://x/y".split("/")` === `["MEM:","","x","y"]` → 索引 2 是**视图名本身**；`MEM://forgotten` 全家族 **返回 0 条**；`MUST NOT 引用为正确口径`。**契约** `:711-712`（§16.10）：**D4 MUST 删除 `MAX_RAW_ID_HINT`，改单次 `ORDER BY raw_id DESC LIMIT n`**。
- **我的实测复核**（R9）：`renderForgottenView(store, undefined, 5)` 返 5 条、`renderForgottenView(store, "core", 5)` 返 2 条——**`render*` 本身收 domain 且正确**，坏的是 URI 解析层。D4 `:322` 的「`MEM://forgotten/core/3` → domain="core"」**与引擎实测不符**（实测 domain=`"forgotten"` → 0 条）。
- **建议**：① 删 `:304` 与 `:311-323`，改为「`/api/view` 走显式参数，不复刻 URI 解析」；② 删 `MAX_RAW_ID_HINT`（`:333/:338/:882/:999`）；③ **核验 fixture 造数据走的是 `renderForgottenView(store,"core",N)` 而非 URI**，否则该视图恒空、parity 主断言失去牙齿（契约 §8.3 要求每视图非空）。

### ②-6 【#10·16.7】audit 页 owner 缺位：D4 未认领
- **D2** `02:67` 注册 `"/audit": () => import("./views/audit.js")` 并标 **D4**；`:36/:103/:882` 同。
- **D4** `04:3` 范围只列 `views.ts` + `views/views.js`；**全文 0 次提及 `audit.js`**（`grep -n 'audit.js' 04-*.md` → 无命中）。
- **契约** `:694-698`（§16.7）裁定 `assets/views/audit.js` 归 D4，并要求补「取数(`/api/audit`) + 渲染 + `mount/dispose` 契约」。
- **为什么错**：契约 §14（`:611`）D4 范围含「视图页」但不含 audit 页 → **渲染页无 owner**，实现阶段会掉在地上。
- **建议**：D4 补 `audit.js` 一节；契约 §14 的 D4 行可加「+ audit 页」。

### ②-7 【#10·16.9】D1 `/api/raw` 缺 `around`/`centered`
- **D3** `03:258-260` 定义 `?around=<entry_id>` 语义；`:958-959` 有验收用例；`02:450` 的深链依赖它。
- **D1**：`grep -n 'around\|centered' 01-*.md` → **0 命中**，`§7.5` 参数表（`:657`）无此项。
- **契约** `:705-707`（§16.9）：**加 `around`（可选）**，DTO 带 `centered: boolean`。
- **建议**：D1 补 `around` 参数与 `centered` 字段；D3 补消费 `centered`（见 ③-6）。

### ②-8 【#8】D6 缺「错误码闭合性」断言
- **D6** 测试矩阵 `06:365-375` **无** code 集断言；`grep -n 'conflict' 06-*.md` → **0**。
- **契约** `:339` 已把 §7.3 扩为 7 码；#8 广播明确要求 D6 加断言。
- **建议**：加**双向相等**断言：`实现里的 code 集 === §7.3 表的 code 集`（少一个会编译失败、多一个只是永不触发，故必须双向）。

### ②-9 【#12】D4 的 T15 已被契约判为**恒真（假绿）**，却仍在文档里

- **`04-系统视图与库健康.md:1046`**（§11.3 T15）：「**故意构造**一个「漏一个节点」的结构化输出（`items.slice(0, -1)`），断言 parity **必须不通过**」；`:1068-1077` 给了完整写法：
  ```ts
  const uiIds = dto.items.map((i) => i.node_id).slice(0, -1);   // 人为漏一个
  expect(uiIds).not.toEqual(textIds);                           // ⭐ 必须不相等
  ```
- **契约** `:475-478`（§8.3，落笔 `09:16:20`）：「**已收紧，因 D4 的 T15 被实测证明为恒真**……`items.slice(0,-1)` 再断言 parity 不通过 —— **在 `views.ts` 完全正确与彻底返回空集两种极端下都通过**，因为它测的只是「`toEqual` 不是恒真函数」，**与实现无关**。**冻结要求**：非空性 MUST 用**变异测试（mutation）**证明」。
- **为什么是 blocker**：契约 §8.3 是「本设计的核心约束」，T15 是它点名的「非空性 / 有牙证明」。留着一个**恒真**用例会让评审误以为「有牙」，实际 0 灵敏度 —— 这正是本批次最该消灭的**假绿**。
- **建议**：D4 把 T15 改写为 mutation 形式（对**真实** `views.ts` 注入 M1/M2/M3 + 基线全绿）；`:1047` 的 T16 已是 mutation 矩阵，**只需把矩阵从参照实现 `structOf()` 迁到真 `views.ts`**（`:726` 已诚实标注这个差距，补一句迁移计划即可）。


---

## ③ 应改（不阻塞但该改）

### ③-1 D1↔D3 `/api/temp` 阈值来源字段名三处不同
- D1 `01:557` `threshold_source: "flag"|"settings"|"default"`；D1 自身 `/api/meta` 用 **`temp_threshold_source`**（`:528/:597`）。
- D3 `03:497/:968` 用 **`thresholdSource: "cli"|"settings"|"default"`**（camelCase）。
- **三处不同名 + 枚举值不同**（`flag` vs `cli`）。契约 §16 未裁此项（漏网）。
- 建议：统一 `threshold_source`、枚举统一 `"flag"|"settings"|"default"`，回写契约。

### ③-2 D1↔D3 `/api/sessions` 的 `active` 字段名不一致
- D1 `01:548` `SessionDTO.active_count`（`:678` `SUM(active) AS active_count`）；D3 `03:384` 示例 `"active": 30`、`:963` 断言按 `active`。
- 建议：定一名（`active_count` 更无歧义），另一方改；契约 §7.1 未冻此字段名。

### ③-3 D1↔D3 `/api/temp` 的 `notifyPreview` 悬空
- D3 `03:825` 请求 D1 加 `notifyPreview`；`:858`（U-D3-5）标 `⏳ 待 D1`。
- D1 `01` 的 `TempResponseDTO` **无此字段**，全文未回应。
- 建议：D1 加 `notifyPreview: string`（`buildTempNotifyContent` 已 export，`temp-notify.ts:39`，零成本）；或契约明确不做。

### ③-4 D1↔D3 `raw.active` 的 JSON 类型（boolean vs number）
- D1 `01:394` `active: boolean`；`§11-C4`（我读取时 `:1073` 附近）**自认**契约 §6.2 未定类型，并留言「若 D3 坚持 number 请通知我」。D3 `03:116` 示例 `active: 1`。
- 建议：以 `boolean` 为准（与 `is_stub` 一致），D3 改示例与断言；契约注明 **`/api/raw.active` 是标志位（boolean）、`/api/sessions.active` 是计数（number）**。

### ③-5 D5 `:774` 措辞过期（`current_version` 已裁定）
- `05:774`：「…二者已写入 §9 的 U3/U5 **待 D1 确认**」。契约 §16.2（`:670`）已裁定、D1 已落实（`01` `current_version` 行）。
- 建议：D5 改为「已裁定（§16.2），D1 已落实」。

### ③-6 D3 未提 `/api/raw` 的 `centered`（§16.9 连带）
- 契约 `:707` 要求 D1 的 DTO 带 `centered`；D3 `:258-260` 未消费。
- 建议：D3 补「`centered === true` 时页首提示『已按定位行居中』」。

### ③-7 D2 前端错误映射缺 `conflict`（#8 连带）
- `grep -n 'conflict' 02-*.md` → 0；D2 `:100-105` 的 `ctx.api` 无 code→文案表。低危，但 #8 广播点名 D2。
- 建议：D2 若加 code 分支表须含 `conflict`。

### ③-8 D5 边相关 WARN 需按 #11 用 `uri`
- D5 `:108` 等涉及 relocate/边的提示。契约 `:663-665`（#11）要求 UI 用 `uri`/`resolved_uri`，**不得**用 `target_uri` 或 `node_id` 当对端。
- 建议：D5 相关文案/字段统一引 `uri`。

### ③-9 契约 §8.3 的 `wakeup` 提取器口径与 D6 通用式表述不同（历史遗留）
- 契约 `:429` 要求**按行锚点/结构解析**、`:438` 要求 `wakeup` 的 `## 最近动态` **降级为行数约束**。
- D6 `06:392` 仍以**通用正则** `/[\w-]+:\/\/[^\s\]）,。]+/g` 为「稳健做法」（该段标 `[推断]`，`:478` 承认复用 D4 抽取器）。
- 不构成矛盾，但建议 D6 `:392` 加一句「wakeup 段除外，按契约 §8.3 降级为行数约束」。

---

## ④ 建议（可选）

1. **契约该补一张「DTO 字段名」表**：③-1…③-4、②-1…②-4 全部源于「§7.1 只冻路径、§16 只裁了部分字段名」。建议补「端点 → 关键字段名/类型」表；D6 据此做机械核验（#10 广播已点名 D6 承担此项）。
2. **传播纪律**：本次 #10/#11 只到了 D1。建议主 agent 广播后**核对每份文档 `stat` 时间戳 ≥ 契约落笔时间**——「已广播」≠「已落地」。**本批次所有 #10/#11 缺口都源于此。**
3. **D4 的 parity fixture 需一次自证**：②-5 的连带风险（fixture 走 URI → 视图恒空 → 假绿）**必须**有一条守卫断言「每视图非空」。D4 `:1014` 有此意图，但若造数据用 URI，守卫本身也失效。
4. **建议给 D1 的 `/api/view` 加反例测试**：传 `uri=MEM://forgotten` → `bad_request`（§16.8 要求 MUST NOT 接受）。把 P17 的教训固化为机器可验。

---

## ⑤ 我实测/核对的证据清单

### 命令与结果（全部只读）

**R1 · 路由双向对比**
```
grep -nE '^\| (GET|POST) \|' 00-共同上下文.md | wc -l   → 21（11 GET + 10 POST）
grep -oE '/api/[a-zA-Z0-9_/-]*' <each doc> | sort | uniq -c
```
- 契约 §7.1 = **21 条**；D1 `ROUTES`（`01:259-279`）= **21 条**，逐一对应，**无缺无多**。✅
- `/api/raw`（`total/totalAll/before`，P13）三处齐：契约 `:301`、D1 `:655-671`、D3 `:215/:243/:841`。✅
- `/api/revisions?deleted=1` 暴露 `node_id`（P14）三处齐：契约 `:581`、D1 `:720`、D5 `:526`。✅
- `/api/search` 用 `search()` 带分数（变更 #5）：契约 `:300`、D1 `:628`（明写「不是 store.recall()」）、D2 `:565`。✅ **无一处残留 `store.recall()`**。

**R2 · 字段名一致性**
```
grep -n 'node_id|uri|raw_id|is_stub|editor_source|editor_model|shadowed|importance' 0*.md
```
- `node_id`/`uri`/`raw_id`/`is_stub`/`editor_source`/`editor_model`/`shadowed`/`importance`：6 文档**写法完全一致**，无 camelCase 变体。✅
- 例外：`threshold_source` vs `thresholdSource`（③-1）；`active_count` vs `active`（③-2）；`parent_id` vs `parent_uri`（②-4）；`source_uri` vs `uri`（②-4）。

**R3 · 术语禁令**（契约 §10.1）
```
grep -nE 'priority|hidden|已隐藏|temp_zone|draft|node_uuid|message_log|log_id|system_views' 0*.md
```
- D1 `document.hidden`、D2 `visibilityState === "hidden"` → **DOM 属性，合法**。
- D2 `:328/:891/:1051/:1088`、D4 `:430/:847` 的「已隐藏」→ **在写禁令本身**，合法。
- D3 `:548-555` `TEMP://draft/deep/node` → `draft` 是**示例 URI 段**，合法。
- D3 `:449` `hiddenAutoNodeIds` → 引擎符号引用，合法。
- **零违规**。唯一 `priority` 实指均为「nocturne 参考」或「禁令表」语境。✅

**R4 · `importance` 极性**
```
grep -nE '0 最重要|数值越大|极性' 0*.md
```
6 文档**全部**写「数值越大越重要」，**无一处写反**；D3 `:567` 排序用**降序**（正确）；D2 `:342` 正确对比 nocturne；D5 `:197` 控件注记正确。✅

**R5 · 计数类断言对源码复核**
```
ls packages/memory/src/*.ts | wc -l    → 14 ✅（契约 §3「既有 14 个 .ts 不动」）
grep -rn 'logAudit(' src/*.ts | grep -oE '"[a-z_]+"' | sort -u   → 恰 16 个
```
- **七个视图**：`grep -n 'export function render' memory-views.ts` → 恰 **7**。✅
- **16 个 audit 事件**：实测集合与契约 `:240` **逐字一致**。✅
- **`DEFAULT_TEMP_THRESHOLD = 10`**：`temp-notify.ts:13` ✅。
- **默认 limit**：实测 `timeline=20`（`tools.ts:215`）、`forgotten=5`（`:225`）、`wakeup=5`（`:208`）、`recent=10`（`:185`）——契约 `:450-452`、D4 `:303-308` 一致。✅
- **代码行号抽查 14 处，全对**：`resolveUri:181`✓ `getNode:191`✓ `put:252`✓ `updateNode:391`✓ `listRevisions:443`✓ `listDeletedUris:488`✓ `listRaw:903`✓ `countTempNodes:1187`✓ `listDomains:1215`✓ `listAudit:1370`✓ `getAwakenUris:967`✓ `search:350`✓ `buildTempNotifyContent:39`✓ `snippet:11`✓。**D1 自称「已实跑核验」抽查通过。**

**R6 · 旧版本引用逐条排查（旧 7 次变更）**

| 变更 | D1 | D2 | D3 | D4 | D5 | D6 |
|---|---|---|---|---|---|---|
| #1 §7.4 自己写入不变 | ✅ | ✅ | ✅ | — | ✅ | ✅ |
| #2 §6.6 跨会话 `continue` | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| #3 §8.3 维度因视图而异 | ✅ | ✅ | ✅ | ✅ | — | ⚠️（③-9） |
| #4 §4.2 三产物各多 3 行 bin | — | — | — | — | — | ✅ |
| #5 §7.1 用 `search()` | ✅ | ✅ | — | — | ✅ | — |
| #6 timeline 双端点互验 | ✅ | — | ✅ | ✅ | — | ⚠️（交 D4） |
| #7 `snippet()` 守卫 + P16 | ✅ | — | — | ✅ | — | ✅ |

- **§7.4 旧表述清零**：全 6 文档 grep「服务端的写入能被 `/api/events` 看到」类表述 → **零**。✅
- **§6.6 旧表述清零**：无一处把别的会话的 auto 节点写成「hidden/已隐藏」为用户文案；D2 `:328`、D4 `:430` 显式引用 `module.ts:344` 的 `continue`。✅
- **§8.3 旧表述清零**：无一处用统一 `node_id` 维度描述 timeline；D4 `:504/:512` 明写 `raw_id`。✅
- **§4.2 旧表述清零**：无一处说 lockfile「零 diff」；D6 `:212/:213` 正确写「依赖项/integrity 零变化、唯一变化是多 3 行 bin」。✅
- **§9.1 旧表述清零**：无一处说「读路径不得直查库」；D5 `:358` 主动自纠「D5 早先『读路径也禁止拼 SQL』的说法是错的」。✅

**R7 · owner 冲突**
```
grep -n 'ROUTES' 0*.md ; grep -n 'views-parity' 0*.md ; grep -n 'audit' 0*.md
```
- **`ROUTES`**：D2 `:931` 维护**前端**表；D1 `:69/:258` 是**后端**同名常量（不同文件）。D3 `:919`、D5 `:60` 均**申请入表**而非自改。✅
- **`views-parity.test.ts`**：契约 `:472` 判 D4；D4 `:3/:958` 认领；D3 `:690/:1096` 明写「本模块 MUST NOT 写」；D6 `:373/:485` 明写「只提供 runner」。✅ **三方口径一致**——本批次最干净的一处。
- **`views.ts`**：契约 `:611` 归 D4；D3 `:1095` 明写「只调/对齐」。✅
- **audit 页**：**唯一悬空项**（②-6）。

**R8 · #8–#12 传播**（`grep -n 'conflict|MAX_RAW_ID_HINT|parent_uri|current_version|audit.js|around|slice(0, -1)'`）
- `conflict`：D1 ✅；D2/D3/D5/D6 **0**。
- `current_version`：D1 ✅、D5 ✅；D2/D3/D4/D6 **0**（不需要）。
- `MAX_RAW_ID_HINT`：D4 **仍在** `:333/:338/:882/:999`。
- `audit.js`：仅契约与 D2；D4 **0**。
- `around`：D3 ✅、D2 ✅；D1 **0**。
- `parent_uri`：**6 份文档 0 命中**（契约 §16.3 要求 D2 用）。
- `slice(0, -1)`/`slice(0,-1)`：**仅 D4 `:1073`**（即被 #12 判废的 T15）。
- **文件时间**（`stat -c '%y'`）：契约 `09:16:20`、D1 `09:16:21`、D2 `08:08:12`、D3 `08:23:33`、D4 `08:29:19`、D5 `08:23:20`、D6 `08:33:49` → **仅 D1 与契约同步（差 1 秒），其余 5 份均早于 #10/#11/#12**。

**R9 · 真跑 spike（只读）**
- `/tmp/spike_cons.mjs`（`openMemoryStore("")` + `seed()` + `syncRawBranch`）：
  ```
  MAX_SAFE ok?: 10
  len via MAX_SAFE: 10
  reverse-window took ms: 0 guard: 1 got: 0
  ```
  → `listRaw(0, MAX_SAFE_INTEGER, {activeOnly:true})` 正常（不溢出）；D3 `:126` 的「300s 挂死」是**其草稿循环不推进游标**所致（我复现的朴素反向窗口若空即死循环），与 `MAX_SAFE_INTEGER` 上界无关。**§16.10 改单次 `LIMIT` 正确且必要**，但 D3 对该 hang 的归因应更精确。
- `/tmp/spike_edge.mjs`：见 ②-1（`listRelated` 两方向 `node_id` 均为源节点，**#11 的更正成立**）。
- `renderForgottenView` 真跑：**`render*` 收 domain 且正确**（支持 #9）。
- `renderRecentView` 真跑：`disclosure = "正常\n- core://ghost [★9]"` 时输出列首含未折叠的 `- core://ghost [★9]` → **P16 的三处注入面（V1/V2/V3）真实**，D6 `:489` 的幽灵 fixture 纪律有据。

### 尝试证伪但**未能**推翻的断言（供校准信任）

1. **契约 §5 S2/S3 确实能挡 CSRF + DNS rebinding**（`:175-177`）。推演：邪恶页 `fetch("http://127.0.0.1:P/api/node")` → `Host: 127.0.0.1:P`（过 S2）、`Origin: http://evil.com`（**S3 拦 POST**）→ 403；DNS rebinding → `Host: attacker.com` → **S2 拦**；`Origin: null`（沙箱/file://）≠ `http://<host>:<port>` → **S3 拦**；GET 无 S3 但服务端不设 `ACAO` → 跨源响应不可读。**未找到绕过路径。**
2. **契约 §6.6 第一步算法与 `module.ts:334-348` 逐行对齐**。实读 `recomputeAnchorVisibility`：缺 anchor → `hidden.add`（对应 `:266-267`）；跨会话 → `continue`（对应 `:251`）；anchor 不在 active → `hidden.add`（对应 `:270`）。**三步全吻合。**
3. **契约 §8.3 timeline 维度 = `raw_id` 正确**。实读 `renderTimelineView`（`memory-views.ts:22-40`）：SELECT 只取 `raw_id, role, text, world_ts`，**全函数无一个节点 URI**。✅
4. **契约 §7.1 `/api/raw` 的 `listRaw` 单行陷阱正确**。实读 `store.ts:903-930`：`toRawId === undefined` → `WHERE raw_id = ?`（**单行**）。✅
5. **错误码闭合性**（除 ②-8 的实现侧缺口）：`internal`(500) 作兜底使 code 集**闭合**；7 码无常见漏项。✅

### 非空性断言（契约 §8.3「必须有一条用例能证明没有修复就会失败」）——诚实核查
- **D4 的 T15 是假绿（⚠️ #12 已定案）**：`04:1046/:1068-1077` 的「`items.slice(0,-1)` 再断言不通过」**恒真**——契约 §8.3 `:475-478` 明判「在完全正确与返回空集两种极端下都通过」。**这是本批次唯一一条被证实的假绿测试**，见 ②-9。
- **D4 的 T16 mutation 矩阵是**真证据 **但**跑在参照实现上**：`04:708-724`（6 mutation × 7 fixture，`M4 忽略 shadowed` 在 `G4` 上 **6/6 红**），且 `04:726` **主动划界**「跑在我写的参照实现 `structOf()` 上，真实测试落地后以真实为准」——契约 §8.3 `:478` 点名这是**全批范本**。⚠️ 但若 `G1` 用 URI 造 forgotten 数据，守卫失效（④-3）。
- **D6 给了纪律**（`06:394-397` + `:489`），**未自跑**（符合其 owner 定位）。
- **D3 给了四要素**（`03:744-750`：`active=0` / `world_ts=null` / `rp-notify` / 三档 N），是**真给的**而非提一嘴。
- **D1/D2/D5 不涉 parity，不适用。**
- 结论：**契约 #12 收紧前，D4 的 T15 是唯一的假绿；#12 已定案，D4 需改。**

---

## 附：一句话交付

契约**前 7 次变更**传播**干净**（路由/术语/极性零违规、旧引用清零）；**问题全部集中在 #8–#12 的传播断层**：仅 D1 收到（且 #11 未落地、§16 有 3 处未落地），D2/D4/D5/D6 未动。共 **9 blocker + 9 应改**。修完即可进入实现。
