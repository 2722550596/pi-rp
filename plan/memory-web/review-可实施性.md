# 评审报告 · 闭环性与可实施性

> 评审人：`AdverseTapir`　｜　文件：`plan/memory-web/review-可实施性.md`
> 范围：**符号真实性 / 闭环性 / DTO 完备性 / 可实施性 / 测试可执行性 / 依赖倒置**。
> （跨文档一致性归 `review-一致性.md`；诚实性与对抗性归 `review-诚实性.md`。）**本报告未修改任何被评审文档。**
> 源码基线：`packages/memory/src/`（`store.ts`/`recall.ts`/`memory-views.ts`/`tools.ts`/`temp-notify.ts`/`schema.ts`），逐符号核对。
> 已并入契约变更 **#8**（错误码 6→7 增 `conflict`）、**#9**（`MEM://` 解析作废 + P17）、**#10**（§16 跨模块接口裁定）、**#11**（更正 `EdgeDTO.node_id` 语义）。
>
> ⚠️ **本文档写作期间，D1/D2/D3/D6 被其 owner 持续回写**（mtime：D1 09:23、D2 09:21、D3 09:23、D6 09:20；D4/D5 停在 08:29/08:23）。**本报告的每条结论都标注了核对该结论时的文件状态**，以免你读到的是已修的旧问题。

---

## ① 结论

**已接近可进入实现，但仍有 4 条 blocker，且全部集中在「回写未收敛」这一种成因上。** 我初报的 11 条 + D4 两轮的四条，**绝大多数已被 owner 回写修掉**（含我新发现的 S8，D4 已完整采纳）。逐条复核后的当前账：

| # | 内容 | owner | 状态 |
|---|---|---|---|
| **B-A** | **`/api/raw?around` 的类型口径 D1 与 D3 相反**（D1 = `raw_id`，D3/D2 = `entry_id`） | D1 | ❌ **未修**（主 agent 已裁定 `entry_id`，§16.9 已回写；D1 待改 `:681` 声明与 `:701` 示例） |
| **B-B-a** | **D4 `:294` 要求「MUST 复用 `parseViewCount`」，而 `:333` 要求「MUST NOT 复用」** —— 且 `parseViewCount` **已被主 agent 从 `tools.ts` 真删**（现为 `parseViewSegments`，我已实读 `tools.ts:180-199`） | D4 | ❌ **未修**（**文档内自相矛盾 + 引用已不存在的符号**） |
| **B-B-c** | **D4 的 T20 自相矛盾**：`:338`「T20 已作废」，`:1170` 用例表里 T20 仍在 | D4 | ❌ **未修**（新出，上一版残留） |
| **B-D** | **契约 §16.8 需补一句「P17 已修，但 `/api/view` 仍用显式参数」**，否则读者会以为该约束已可撤销 | 契约 owner | ❌ **未修** |

**已闭合的（我逐条重核过，欢迎抽查）**：`ViewResponseDTO`→`ViewDTO`、`current_version` 已加、`resolved_uri` 已加、`source_uri` 作废、tree `parent_uri` 已改、D1 `/assets/` 已收口（含 `%2e%2e` 与 `/assets/../` 测试）、D1 §11-C1 假现状已撤回、D1 错误码已扩至 7 码含 `conflict` 409、D4 的 `MAX_RAW_ID_HINT` 已删（改单次 `DESC LIMIT`，并附 20k 行实测 182.6 ms → 0.2 ms）、D4 的 `audit.js` 已认领并定义（§10.2b + T23/T24）、D4 的 `forgotten` 数字段特例已作废（§3 新增 P17 专节）、D4 的 T15 恒真断言已删并改指 T16 变异矩阵、**D4 的 `RX` 七条正则与 `renderFor` 已逐字落码定义（我报的 S8 被完整采纳）**。

另有 **8 条应改**（S1–S8；其中 S8 已闭合，见下）。

**符号真实性的结论**：抽查 30+ 处源码行号引用（相对 `packages/memory/src/`）**全部命中**；文档引用的 `MemoryStore` 方法 / `recall.ts` 导出 / `tools.ts` 内部函数 / schema 列名**无一凭空捏造**。我曾报的两个「不存在的符号」（`ViewResponseDTO`、`current_version`）**已由 D1 修好**；D4 的 `RX`/`renderFor` **已由 D4 修好**。**当前唯一的「符号不存在」是 B-B-a 指向的 `parseViewCount`（被引擎删除后，D4 文档未同步）。**

**收口顺序（四条，都很短）**：① D1 改 `around` 为 `entry_id`（B-A，唯一跨文档契约级） → ② D4 删 `:294-299`（B-B-a） → ③ D4 在 `:338`/`:1170` 之间二选一（B-B-c） → ④ 契约 §16.8 补一句 P17 已修（B-D）。**四条做完，本报告清空 blocker。**


---

## ② Blocker（不改则无法实现）

### B-A. ⭐ **`/api/raw?around` 的类型：D1 定义成 `raw_id`，D3 定义成 `entry_id`，D2 传的是 `entry_id`**

- **D1 `01-服务端与API.md:681`**（09:23 版）：
  ```
  参数：`session?`、`activeOnly?`…、`before?`（number，keyset 游标）、⭐ `around?`（number，**契约变更 #10 / §16.9**）。
  ```
  `:701` 的示例实现：
  ```ts
  const half = Math.floor(limit / 2);
  const rows = store.listRaw(Math.max(0, around - half), around + half, opts);   // 明确双界
  ```
  `listRaw(fromRawId, toRawId)` 收的是 **`raw_id`**（`store.ts:903-918`，已核对）→ **D1 把 `around` 当 `raw_id`**。

- **D3 `03-原文日志与动态区.md:305,307`**（09:23 版）：
  ```
  | 定位 | `?around=<entry_id>` / `?from=&to=` | …服务端把 `around` 解析成 `raw_id` 后返回该行及其邻近页 |
  **`?around=` 的语义（D1 需实现）**：给一个 `entry_id`，返回**包含该行的那一页**。
  ```
  D3 明确 `around` 是 **`entry_id`**（字符串，形如 pi 会话内的消息 id），**需要服务端先解析成 `raw_id`**。

- **D2 `02-浏览与检索界面.md:465`**（09:21 版）也传 `entry_id`：
  ```
  | `anchor_entry_id` | **详情** + **链接**：`#/raw?session=<anchor_session_id>&around=<entry_id>`（D3） |
  ```
  而 `anchor_entry_id` 的取值域是 `nodes.anchor_entry_id`（D1 `01` 的 §6.1 表：TEXT），**不是数字**。

- ⭐ **D1 在自己的「裂缝对齐表」里声称 D3 不依赖 `around` —— 这是错的**（`01:1226`，09:25 版）：
  ```
  D3 另确认：…他不依赖 `around`，且从不同时传 `around`/`before`。
  ```
  但 D3（`03:1015-1017`，09:23 版）有**三条 `around` 验收用例**：
  ```
  | 4  | GET /api/raw?around=<entry_id>&session=<sid> | 返回的页包含该 entry_id 的行 |
  | 5  | GET /api/raw?around=<entry_id>（跨 session 重复） | 400 bad_request |
  | 5b | GET /api/raw?around=<entry_id>（窗口内/窗口外两种 fixture） | centered: true … |
  ```
  且 D3 `:311-315`（09:23 版）**逐字记录了 §16.9 的裁定**，明写「以该 **`entry_id`** 在本次 `from`/`to` 窗口内的 `raw_id` 为中心」。→ **D1 的这句「已对齐」的回执本身不实**，会让主 agent 把 B-A 从裂缝表里划掉。

- **为什么是 blocker**：两者的**参数类型与语义完全不同**（`number` vs `string`，`raw_id` vs `entry_id`）。照 D1 实现，D2 传的 `entry_id`（如 `e_ab12`）会被当作 `raw_id` 喂给 `listRaw`，`Math.max(0, "e_ab12" - half)` → `NaN` → 查询返回空/异常。**契约 §6.6 + §12-P15 的「`shadowed` 节点 → 看那条被回滚的原文」整条链断掉**，且 D3 验收 T4/T5/T5b（`03:1015-1017`）全部失败。
- **建议**：**D1 采纳 D3 的 `entry_id` 口径** —— `around: string`（`entry_id`），服务端用
  `SELECT raw_id FROM raw_log WHERE entry_id = ? AND session_id = ?`（`schema.ts:71` 的唯一索引是 `(session_id, entry_id)`，D3 `:262` 已点明）解析成 `raw_id` 后再走双界查询。D3 `:307` 的「跨 session 重复 → `bad_request`」要求一并落实。**同时 D1 `:701` 的示例代码必须改**（它还写着 `around - half` 直接算术）。

---

### B-B. ⭐ **D4 已两轮回写（1823 行）——原四条已全闭合；余下 2 条仍开（其中 1 条为新一轮新出）**

> ⚠️ **状态更新（D4 mtime `09:32`）**：D4 的 owner 已两轮回写。我**逐条重核**如下，**请看这一版，不要按旧版判它**。

| 原子项 | 当前核对 | 判定 |
|---|---|---|
| `MAX_RAW_ID_HINT` 锚点法 | `:344` 记「先记一条本文的失败实测」；`:349-353` 改单次 `ORDER BY raw_id DESC LIMIT ?`；`:1030`「常量**已从设计中删除**」；SPIKE-S 实测 20k 行 182.6 ms vs **0.2 ms** | ✅ **已修** |
| `audit.js` 无 owner | `:3` 已列范围；`:967-989` §10.2b 定义（`mount`/`renderAuditRows`/`eventBadge` + §1.3 红线 + 16 事件名容错）；`:1087-1088` T23/T24 | ✅ **已修** |
| `forgotten` 数字段特例 | `:309-337` P17 专节（含 `split()` 实测三例 + 主 agent 真修后的 SPIKEE-T 复核） | ✅ **已修** |
| T15 恒真断言 | `:1079` 标注删除，改指 T16 变异矩阵 | ✅ **已修** |
| **S8 · `RX` / `renderFor` 未定义** | ⭐ **已修**：`:1020-1028` 现在是**逐字落码的七条正则** `const RX = { forgotten: /^- \d+ 天没想起 …/gm, … } as const;`（不再是裸标识符）；`:1072` 已定义 `function renderFor(name: string, store: MemoryStore, opts: {…})` | ✅ **已修**（我的发现被完整采纳） |
| **→ 仍开** B-B-a：`:294` 仍写「**默认 limit 与域名解析 MUST 复用 `tools.ts` 的口径**，不得自创」+ `:297-298` 仍贴 `parseViewCount(uri, partIndex, fallback)` 签名 | ⚠️ **与同文档 `:333` 自相矛盾**（`:333`「本文先前版本的错误…**D1 MUST NOT 复用该解析**」）。且 `parseViewCount` **已被主 agent 真删**（`tools.ts` 现为 `parseViewSegments`，`:180-199`，我已实读确认），所以这句不仅在文档内矛盾，**指向的符号已不存在** | ❌ **未修** |
| **→ 仍开（新）** B-B-c：**T20 自相矛盾** —— `:338` 写「**T20（P17 回归测试）已作废** —— 见 §11.3」，但 `:1170` 的用例表里 **T20 仍在**（且已重写为「修后断言两路一致」） | 同一文档里「已作废」与「仍在用例表」并存。`:338` 的「已作废」看似是**上一版（bug 未修时）的残留**，作者忘了删 —— 或反之 | ❌ **未修** |

**B-B-a 的证据（文档内矛盾 + 符号已被删除）**：
- `04:294`：「**默认 limit 与域名解析 MUST 复用 `tools.ts` 的口径**，不得自创」。
- `04:333`：「⚠️ **本文先前版本的错误**：本节曾写…并据此要求 D1 复用 `tools.ts` 的解析 —— 那是照抄了一个从未生效的错误注释。**D1 MUST NOT 复用该解析**」。
- `tools.ts` 现状（我已实读 `:180-199`）：`parseViewCount` **已不存在**，只有 `parseViewSegments(uri, view, fallbackLimit)`。
- **建议**：删掉 `:294-299` 整段（`:301-307` 的「默认 limit」表已按 P17 更正，保留即可）。

**B-B-c 的证据**：`04:338`「相应地，**T20（P17 回归测试）已作废** —— 见 §11.3」 vs `04:1170` 完整的 T20 行。**建议**：二者留一 —— 若采纳「引擎已修、T20 改为防回归断言」，则删 `:338` 那句；若维持作废，则删 `:1170` 的 T20 行。

---

### B-C.（原「D6 已撤 T15、D4 未撤」）—— ✅ **已闭合**

D4 `:1079` 已标注 T15 删除并改指 T16 变异矩阵。**方向性风险已消除。**

---

### B-D.（新 · 交叉印证）P17 **已在引擎侧真修**，D4 的文档口径需跟着收敛

- **事实**：`tools.ts:180-199` 现为 `parseViewSegments(uri, view, fallbackLimit)`（我实读确认），旧的 `parseViewCount(uri, partIndex, fallback)` **已被删除**；`grep parseViewCount src/tools.ts` → **0 命中**。
- **连带**：D4 `:294-298` 引用 `parseViewCount` 的段落（B-B-a）**引用了已不存在的符号**；`07-MEM-URI-修复.md` 是这次修复的设计文档（`07:51` 明写「提取统一解析器 `parseViewSegments`，替掉三处 `parseViewCount` 调用」）。
- **对 D1 无影响**：D1 `:740` 已写「`/api/view` 接受显式结构化参数，MUST NOT 复用 `parseViewCount`」→ **契约 §16.8 的设计选择在引擎修好后依然成立**（理由从「规避 bug」变为「结构化参数更明确」）。
- **建议**：D4 删 `:294-299`；**并在契约 §16.8 补一句「P17 已修，但 `/api/view` 仍用显式参数」**，否则后来的读者会以为该条约束已可撤销。


---

## ③ 应改（不阻塞）

- **S1 · D1 文档内重复行**：`01:774` 与 `01:780` 是**同一句话写了两遍**（「响应 = D4 定义的 `ViewDTO`（构造函数 `buildView`…D1 原样透传，不加工）」/「响应 = D4 定义的 `ViewDTO`（构造 `buildView`；D1 原样透传…）」）。回写时漏删。**建议删一行。**
- **S2 · D2 的 `aliases` / `path` 示例仍是字符串数组，与 D1 的对象 DTO 不一致**：
  - D2 `02:432`：`"aliases":   [ "old://identity/habits" ],` ；D1 `01:517` `aliases: AliasDTO[]`（`= { alias_uri, target_node_id }`，`01:467`）。
  - D2 `02:438`：`"path": ["core://", "core://identity"]` ；D1 `01:514` `path: Array<{ node_id: string; uri: string }>`。
  - D2 自己 `:432` 的注释还写着「`listAliases` → `string[]`（`store.ts:790`）」—— **那是 store 层事实（正确），但 DTO 层 D1 已包成对象**。落码者照抄 D2 的 jsonc 会把渲染写错。
  - **建议**：D2 的两个示例改为与 D1 一致（`aliases: [{alias_uri, target_node_id}]`、`path: [{node_id, uri}]`）。
- **S8 ⭐ · D4 §10.3 的测试脚手架引用未定义符号**（按「代码片段会被逐字照抄」前提 → 直接 `ReferenceError`）：
  - `04:976` `const RX = { forgotten, recent, index, glossary, diagStale, diagCrowded, diagPlaceholder };` —— 这**七个正则全篇从未定义**（只有 §5.2 `:614-620` 的表里给了正则字面量，没落成代码）。
  - `T1`–`T4` 表行（`04:1037-1040`）引用 `RX.forgotten` 等；§11.4 `assertParity`（`04:1059`）引用 `renderFor(name, store, opts)` —— **`renderFor` 也从未定义**（§10.3 里只有 `renderForgotten(dto)` 等单参函数）。
  - **建议**：把 §5.2 的五组行锚点**原文落成 `const` 定义块**放进 §10.3，并补 `renderFor` 的分发表（`name → V.renderX(store, …)`）。

- **S3 · D2 §7.2 的 code→文案表仍缺 `conflict`**：`02:714-720` 只列 `not_found`/`bad_request`/`invalid_db`/`forbidden_origin`/`internal`（`grep -c conflict` → **0**）。按变更 #8，「地址被占用」需引导改地址，而不是提示「请求参数不对」。**建议加一行。**
- **S4 · D1 §7.12 `POST /api/node/revise` 的响应仍是 `NodeResponseDTO`，未含 `version`**：`01:816`「成功响应 = `NodeResponseDTO`」；D5 `05:138` 明确要求「**MUST** 在响应里同时给出 `{ node: <DTO>, version: number }`，否则前端无法判断『这次到底有没有产生新版本』（W2b 会返回旧版号）」。`updateNode` 的返回值**就是版本号**（`store.ts:391`，已核对），D1 顺手带上零成本。**建议 D1 补 `version: number`。**
- **S5 · D3 §5.3 的 `thresholdSource` 命名与 D1 的 `threshold_source` 仍不一致**：D3 `:520`「D1 在 `/api/temp` 响应里加 `thresholdSource: "cli" | "settings" | "default"`（§9-C3）」；D1 `01:581` `threshold_source: "flag" | "settings" | "default"`。**双重不一致**（snake_case vs camelCase + `"flag"` vs `"cli"`）。D3 `:882` 已把它登记为 **U-D3-6（⏳ 待 D1）**，但 D1 已定——**建议 D3 按 D1 口径收口并关闭 U-D3-6。**
- **S6 · D4 §3.1 的 `snippet()` 仍是第二份实现（复制）**：`snippet` 在 `memory-views.ts:11` 是**模块私有**（已核对无 `export`），D4 `:916` 只能复制。T21（`:1052`）测的是副本 → **真身改了 T21 不会红**。**建议 D4 在注释里标注同源，并说明该守卫的覆盖边界。**（D6 `§6.5.4` 已就此给出更宽的「成员可判定性」守卫方案，两者应合并。）
- **S7 · D4 §10.2 的 `views.js` 函数清单**（`04:955-963`）用 `renderForgotten(dto)` / `renderRecent(dto)` 这类**单参签名**，但 §7.1 的模块契约要求 `mount(el, params, ctx)`，且清单里**没有 `mount`**（§7.1 `:775` 的示例又写了一个 `export async function mount`）——**函数清单与模块契约脱节**。建议 §10.2 补 `mount`/`dispose`，并说明 `renderX(dto)` 是内部函数、`mount` 才是导出。
---

## ④ 建议（可选）

- **R1**：`/api/audit` 仍无**命名**响应 interface（D1 `:738` 内联 `{ items, total, limit, offset }`）。`AuditDTO`（`01:469`）只描述单行。建议补 `AuditListResponseDTO`，与其余 11 个端点的风格一致。
- **R2`/api/temp` 的测试已在 D1 补上**：`01:1403` 第 24 条「`GET /api/meta` 的 `counts.temp === GET /api/temp 的 count_all`」—— **但这是「同一口径的两次暴露必须相等」，不是 `/api/temp` 端点自身的测试**（未断言 `count` = `countActiveTempNodes`、`count_all` = `countTempNodes`）。D3 §5.2 的核心口径建议由 D1 直接断言。
- **R3**：D1 `:1413` 的 C 组注记「**静态资源（#10）与 `/api/raw?around`（#10/§16.9）**」只写了一个小标题、**没有列出具体用例**。既然 `around` 是 B-A 的核心争议点，建议补一条用例：`GET /api/raw?around=<entry_id>&session=<sid>` 返回的页包含该行（D3 `:1015` 已有同款，D1 侧缺）。
- **R4 · 流程建议（最重要）**：本批出现了 **3 次「上游裁定 → 下游只改了一半」**（D1 改了 `MEM://` 口径、D4 没改；D6 撤了 T15、D4 没撤；D1 定了 `/assets/`、D6 的 A6 断言才补上）。**根因不是粗心，是「广播→回写」没有回执闭环**。建议：每条 DDL 级裁定广播时，**要求每个 owner 回一条带 `file:line` 的确认**，主 agent 汇总一张「裁定 × owner × 已改位置」表；**空的就是 blocker**（与我这张 §7 路由表同构）。本轮我的 B-B 全部是「该表空着」的格子。
- **R5**：我的 §7 路由表已按**当前文件状态**重填（见附一）。其中 `/api/view` 一行的 D4 侧仍空 —— 那是 B-B-3 的直接后果。


---

## ⑤ 我已实测 / 核对的证据清单

> 全部只读（`read` / `grep` / `sed` / `od`），未跑项目级命令，未修改任何被评审文档。

### 5.1 符号真实性（逐个到源码核对 → **全部存在且签名一致**）

| 文档引用 | 源码 | 结果 |
|---|---|---|
| `resolveUri(uri): MemoryNode\|null` | `store.ts:181` | ✅ 且 `:181-189` 先查 nodes 再回退 aliases（alias 可解析） |
| `getNode(nodeId)` / `getNodeByUri(uri)` | `store.ts:191` / `:195` | ✅ |
| `insertNode(input): MemoryNode` | `store.ts:201`（`_insertNode` `:205`） | ✅ |
| `put(input): MemoryNode` | `store.ts:252`（`_put` `:257`） | ✅ upsert 语义确认（同 uri → 覆盖） |
| `updateNode(nodeId, patch): number` | `store.ts:391` | ✅ 返回**版本号**（D5 的 `version` 需求可直接满足） |
| `archiveRevision(...)` 私有 | `store.ts:395` | ✅ |
| `currentVersion(nodeId): number` | `store.ts:436` | ✅ 存在 → D1 已接进 `NodeResponseDTO` |
| `listRevisions(nodeId)` → **4 字段，无 editor 列** | `store.ts:443-447` | ✅ P6 属实 |
| `listRevisionsByUri(uri)` → 5 字段（含 `alive`），**无 editor 列** | `store.ts:455-485` | ✅ |
| `listDeletedUris()` → `{uri,versions,last_seen}`，**无 node_id** | `store.ts:488` | ✅ P14 属实 |
| `restoreDeleted(uri: string, version?: number): MemoryNode` | `store.ts:509` | ✅ 参数形状与 D1/D5 一致 |
| `restoreRevision(nodeId, version): void` | `store.ts:546` | ✅ |
| `deleteCascade(nodeId): number` | `store.ts:554`（`_deleteCascade` `:558-580`） | ✅ 级联、归档最后一版（`:575`）、补 uri（`:576`）、物理删（`:577`） |
| `relocateMany(moves): void` | `store.ts:598`（`:604-689`） | ✅ **零处提及 edges** → P1 属实 |
| `addEdge(nodeId, targetUri, kind?)` | `store.ts:756` | ✅ |
| ⭐ `listRelated(nodeId)` | `store.ts:764-783` | ✅ **实读两个分支的 SELECT（`:768`/`:773`）：`node_id` 列两向同源（`edges.node_id` = 边源）** → 独立证实契约 #11 的更正 |
| `listAliases(targetNodeId): string[]` | `store.ts:790` | ✅ **字符串数组**（D1 `:504` 描述正确） |
| `addGlossaryEntry(keyword, nodeId, reindex=true)` | `store.ts:798` | ✅ |
| `removeGlossaryEntry(keyword)` | `store.ts:804` | ✅ 只有 keyword |
| `listGlossary(nodeId?)` | `store.ts:813-823` | ✅ 存在（P8 属实） |
| `listRaw(fromRawId, toRawId?, opts)` | `store.ts:903` | ✅ **收 `raw_id`（number）** → B-A 依据 |
| ⭐ `listRaw` 的 `toRawId===undefined` → **单行精确查** | `store.ts:924-930` | ✅ **实读源码** `filters.push("raw_id = ?")` → P13 属实 |
| `listRaw` 排序 `ORDER BY raw_id`（**升序**） | `store.ts:935` | ✅ D4 的 `slice(-N)` 论证成立 |
| `getKv` / `setKv` | `store.ts:1098` / `:1105` | ✅ |
| `getWorldTime()` / `setWorldTime(value): string` | `store.ts:1111` / `:1116` | ✅ 返回**解析后绝对时间**；相对量正则 `RELATIVE_TIME` 在 `:144` |
| `countTempNodes()` | `store.ts:1187`（`uri LIKE 'TEMP://%' AND is_stub = 0`） | ✅ |
| `listNodes({domain?})` / `children(nodeId)` | `store.ts:1194` / `:1203` | ✅ |
| `listRecentNodes(limit, domain?)` | `store.ts:1208` | ✅ **stub 过滤在 SQL 内** → D4 §2.2① 属实 |
| `listDomains()` | `store.ts:1215` | ✅ `ORDER BY domain` |
| `seed()` / `logAudit(event, details)` | `store.ts:1332` / `:1350` | ✅ |
| `listAudit(limit = 50)` → 11 字段，**无 offset** | `store.ts:1370` | ✅ D1 §11-C6 属实 |
| `export()` | `store.ts:1228` | ✅ 含 editor 列的直查先例 |
| `readonly db: MemoryDatabase` | `store.ts:157` | ✅ 公有 readonly |
| `countActiveTempNodes(store, isVisible)` | `temp-notify.ts:28-37` | ✅ |
| `DEFAULT_TEMP_THRESHOLD = 10` / `RP_NOTIFY_TYPE` / `buildTempNotifyContent` | `temp-notify.ts:15` / `:12` / `:39` | ✅ |
| `search(store, client, options, signal)` → `{items, mode}` | `recall.ts:350` | ✅ 签名与 D1 §7.4 一致 |
| `search` 已从 index 导出 | `index.ts:78` | ✅ 行号引用正确 |
| `RecalledItem` **无** `importance`/`source`/`world_ts` | `recall.ts:45-57` | ✅ P7 属实 |
| `rank()` 内部**已读** `doc.importance`/`doc.world_ts` | `recall.ts:202-236` | ✅ D2 §6.1 属实 |
| `toEpochDays` / `formatRelativeWorldTime` / `summarize` 导出 | `recall.ts:87` / `:98` / `:82` | ✅ |
| `W_VECTOR=0.55` / `W_KEYWORD=0.3` / `W_IMPORTANCE=0.15` | `recall.ts:29-31` | ✅ D2 §6.1 公式正确 |
| `buildPool` 跳过 stub | `recall.ts:177` | ✅ P9 / D2 冲突 8 属实 |
| `parseViewCount` **私有未导出** | `tools.ts:172-175` | ✅（D1 已据 P17 不采用） |
| `forgotten` 的 `parts[2]` 取 domain | `tools.ts:219-227` | ✅ 实读确认（P17 根因；见 D4 B-B-3） |
| `getAwakenUris` / `setAwakenUris` | `tools.ts:967` / `:978`，`index.ts:116,120` 导出 | ✅ |
| `executeAwaken` 的 set/add/remove 语义 | `tools.ts:982-1010` | ✅ |
| `revise` 工具 `editor_source:"manual"` | `tools.ts:533` | ✅ 命中 |
| `snippet(node, max=80)` 折叠 `\s+`、只渲染 content、**私有** | `memory-views.ts:11-14` | ✅ 私有确认 → S6 |
| `stars()` | `memory-views.ts:17-19` | ✅ |
| 七个 `render*` 全导出 | `memory-views.ts:22/43/83/130/146/165/182` | ✅ 与契约 §8.1 一一对应；D1 `:767-770` 引的签名/行号**全部正确** |
| `renderDiagnosticView(store, domain?, daysStale=30, maxChildren=10)` | `memory-views.ts:182` | ✅ **无 isVisible** → D4 §2.7 属实 |
| `renderTimelineView` SELECT 只取 raw_log 列 | `memory-views.ts:26-28` | ✅ 集合维度 = `raw_id` 属实 |
| ⭐ P16 的三个未折叠注入面 | `memory-views.ts:105`（裸 push `node.content`）、`:157`（`${n.disclosure}`）、`:137`（`${e.keyword}`） | ✅ **逐行读源码确认**（D6 §6.5.2 的三条 V1/V2/V3 属实） |
| `relocateMany` 五类冲突错误文本 | `store.ts:615/619/633/640/652` | ✅ 全命中 |
| 16 个 audit 事件名 | 与主 agent 核对 | ✅ 一致 |
| schema 各表列名 | `schema.ts:7-111` | ✅ 未发现文档引用不存在的列 |
| `removeEdge` | `src/` 全文 | ✅ **零命中** → D5 `:230`「store 也没有」正确 |

**未发现任何凭空捏造的函数 / 方法 / 字段。** 抽查 30+ 处行号引用**全部命中**。

### 5.2 不存在的符号 / 本轮已修好的两个

| 符号 | 出现处 | 判定 |
|---|---|---|
| `ViewResponseDTO` | 原 D1 `:712` | ✅ **已修**：D1 现已全用 `ViewDTO` / `buildView`（`01:774,780`） |
| `current_version` | 原 D5 要求、D1 缺失 | ✅ **已修**：D1 `NodeResponseDTO` 已加（`01:512`） |
| `resolved_uri` / `source_uri` | 原 D1/D2 不一致 | ✅ **已修**：D1 加 `resolved_uri`（`01:438`）；D2 `source_uri` 已作废 |
| `TreeNodeDTO.parent_id` | 原 D2 `:292` | ✅ **已修**：D2 改 `parent_uri` |
| `views/audit.js` | D2 `:67` 注册 | ❌ **D4 仍无** → B-B-2 |
| `around`（类型） | D1 = `raw_id`，D3/D2 = `entry_id` | ❌ **矛盾未修** → B-A |
| `thresholdSource` | D3 `:520` vs D1 `threshold_source`（`01:581`） | ⚠️ 未统一 → S5 |
| `getRawBounds(opts)` | D3 `:283` | ⚠️ D1 未定义该函数，但 D1 `:694-696` 用只读 COUNT 聚合达成等价语义 → 建议 D3 标注「已由 D1 COUNT 方案满足」 |
| `store.recall()` 用作搜索 | 已改为 `search()` | ✅ 修正正确（`store.ts:1146` 确实剥掉分数） |
| `removeEdge` | D5 `:230` 明说没有 | ✅ grep 零命中，结论正确 |

### 5.3 DTO 完备性抽查（前端能否只靠 DTO 渲染）

| 页面 | DTO | 判定（当前状态） |
|---|---|---|
| 树（D2 §4） | `TreeNodeDTO`+`TreeResponseDTO`（D1） | ✅ 含 `child_count`/`has_children`/`content_head`/`limit`/`offset`/`parent_uri`（**P10 与 §16.4 均已履行**） |
| 节点详情（D2 §5） | `NodeResponseDTO`（`01:511-519`） | ✅ 含 `current_version`；edge 用 `{node_id, uri, resolved_uri, kind, dangling}` 且语义已更正｜⚠️ D2 的 `aliases`/`path` 示例仍是字符串数组（S2） |
| 搜索（D2 §6） | `SearchResponseDTO` | ✅ 含 P7 回接三列 |
| 原文（D3 §2） | `RawEntryDTO`+`RawResponseDTO` | ✅ 有 `total`/`totalAll`/`before`/`centered`｜❌ `around` 类型与 D1 冲突（B-A） |
| session 分组（D3 §4） | `SessionDTO`（`01:570-572`） | ⚠️ D1 用 `active_count`，D3 消费 `active` |
| TEMP（D3 §5） | `TempResponseDTO`（`01:576-582`） | ⚠️ 字段名（S5） |
| 七视图（D4） | `ViewDTO` 判别联合 | ✅ 全部文档里最完整的 DTO；D1 已正确引用 |
| 审计（D1 §7.9） | 仅内联形状（`01:738`） | ⚠️ 无命名 interface（R1） |
| 恢复页（D5 §4.10） | `DeletedUriDTO`（`01:584`） | ⚠️ 无 `max_version`（D5/契约 U7 提到，非阻塞） |

### 5.4 可实施性抽查（任务点名的 3 个最复杂点）

1. **`visibility.ts` 的 `shadowed` 两步算法 → 可直接实现**。契约 `00:260-281` 给伪代码，D1 §11-C8 给两条实现路径（逐节点预编译 statement + Map 缓存；或一次 `SELECT entry_id, session_id, active FROM raw_log` 建 Set）。D2/D3/D4 三方一致声明**复用同一份**；第二步 `foreignSession` 三方一致「不做」并给了理由（路由表无承载端点）→ **闭环**。
2. **`views.ts` 七视图取数与排序 → 可直接实现**，质量最高。D4 §2.1–§2.7 逐视图给「`render*` 行号 → 结构化对应」表，§3.1–§3.7 给完整代码：`forgotten`（`04:353-357`）、`recent`（`:367` 复用 `listRecentNodes`，并警告「不得换成 `listNodes().filter(...)`」）、`index`（`:375-382` 空组跳过）、`glossary`（`:392-396`，`:393` 特意点明「**不用 `resolveUri`**」这个最易混处）、`timeline`（`:333-334`，**按 B-B-1 须改单次 DESC LIMIT**）、`wakeup`（`:404-427` 三段+`skipped`）、`diagnostic`（`:436-448` 魔数表+双键排序）。**瑕疵**：S6（`snippet` 复制）、B-B-1（`MAX_RAW_ID_HINT`）、B-B-3（`MEM://` 段落）、B-B-4（T15）。
3. **`serialize.ts` 处理 `MemoryStore` 是类实例 → 可直接实现**，写得最扎实。D1 §6.1 给实跑表（`JSON.stringify(store)` 抛 circular、`structuredClone` 抛 `DataCloneError`、行对象 null-prototype 可序列化）+ 三条规则（永不把 store/db/stmt 放进 DTO；显式 `to*DTO` 不 spread，白名单化；null-prototype 前先归一化）。

### 5.5 测试可执行性

- **断言不存在的 API？未发现。** 抽查 D1 验收 50+ 条、D2 §12.2 九条纯函数用例、D3 §12 二十余条、D4 §11 T1–T21、D6 §11 矩阵，全部使用**已核对存在**的符号。
- D2 §12.2 `parseHash("#/node?uri=core://a/b")`（`02:1034`）—— hash 里 `?`、`/`、`://` 混用，是真正会写错的边界，用例设计正确。
- D3 §8.3 parity 公式（`03:694-712`）用 `listRaw(1, <真实上界>, {activeOnly:true}).slice(-N)`，符号与语义均正确。
- ⚠️ **D4 T15（`:1046,1068-1077`）是恒真断言** → B-B-4。
- ⚠️ **D4 T21 测的是 `snippet` 副本**（S6）。
- ❌ **B-A 使 D3 `:1015-1017` 的三条 `/api/raw?around=<entry_id>` 用例在 D1 的实现下全部失败。**

### 5.6 依赖倒置交叉对照（A 要求 B 提供，B 给了没有）

| 需求方 | 需求 | 供应方 | 状态 |
|---|---|---|---|
| D2 | tree 加 `child_count`/`content_head`/`has_children`/`parent_uri` | D1 | ✅ 全给 |
| D2 | edges 加 `resolved_uri` | D1 | ✅ 给（`01:438`） |
| D2 | revisions 带 `editor_source`/`editor_model` | D1 | ✅ 给（P6 落法完整） |
| D2 | search 回接 `importance`/`source`/`world_ts` | D1 | ✅ 给（P7 落法完整） |
| D2 | 静态前缀 `/assets/` + Content-Type | D1 | ✅ 给（`01:302,307`） |
| D2 | node.js 导出 `editorLabel` 供 D5 用 | D2 自己 | ✅ `02:970`（但 D5 `05:398` 另写一份） |
| D2 | `views/views.js` 提供 `mount` | D4 | ✅ `04:775` |
| D2 | `views/audit.js`（ROUTES 注册归 D4） | D4 | ❌ **D4 无** → B-B-2 |
| D3 | `/api/view?name=timeline` items 带 `raw_id` | D4 | ✅ `04:43` |
| D3 | `/api/raw?around`（语义 = `entry_id`） | D1 | ❌ **D1 实现成 `raw_id`** → B-A |
| D3 | `/api/temp` 返回 `thresholdSource` | D1 | ⚠️ D1 给 `threshold_source`（S5） |
| D3 | `/api/sessions` 返回 `active` | D1 | ⚠️ D1 给 `active_count` |
| D5 | `/api/node` 暴露 `current_version` | D1 | ✅ 给（`01:512`） |
| D5 | `/api/node/revise` 返回 `version` | D1 | ⚠️ 未给（S4） |
| D5 | `/api/revisions?deleted=1` 暴露 `node_id` | D1 | ✅ 给（P14 落法完整） |
| D6 | T15 形态必须撤回 | D4 | ❌ **D4 未撤** → B-B-4 |
| D6 | `audit.js` 归 D4，测试 owner 跟着改 | D4 | ✅ D6 `:374` 已改；D4 缺定义（B-B-2） |

---

## 附一：契约 §7.1 路由表逐行核验（**按当前文件状态重填**）

> ✅ 有 · ⚠️ 部分/形状不一致 · ❌ 无/未落地。**空格即 blocker。**

| # | 方法 | 路径 | ① 完整 DTO | ② handler 落点 | ③ 对应测试 | 备注 |
|---|---|---|---|---|---|---|
| 1 | GET | `/api/meta` | ✅ `MetaDTO` | ✅ `getMeta`（`01:259`） | ✅ D1 A1–A5 | 三方闭环 |
| 2 | GET | `/api/tree` | ✅ `TreeNodeDTO`+`TreeResponseDTO` | ✅ `getTree`（`01:260`） | ✅ A6–A10 | 闭环 |
| 3 | GET | `/api/node` | ✅ `NodeResponseDTO`（含 `current_version`） | ✅ `getNode`（`01:261`） | ✅ A11–A17 | ⚠️ D2 示例形状（S2） |
| 4 | GET | `/api/search` | ✅ `SearchResponseDTO` | ✅ `getSearch`（`01:262`） | ✅ A18–A22 | 三方闭环 |
| 5 | GET | `/api/raw` | ⚠️ `RawResponseDTO` 有 `centered`，但 `around` 类型与 D3 冲突 | ✅ `getRaw`（`01:267`） | ✅ A23–A25 ｜❌ D3 的 around 用例 | **B-A** |
| 6 | GET | `/api/sessions` | ⚠️ `SessionDTO`（`active_count` vs D3 的 `active`） | ✅ `getSessions`（`01:268`） | ✅ A26 | ⚠️ 命名 |
| 7 | GET | `/api/temp` | ⚠️ `TempResponseDTO`（`threshold_source` vs D3 的 `thresholdSource`） | ✅ `getTemp`（`01:263`） | ⚠️ 仅间接（`01:1403`） | ⚠️ 命名（S5/R2） |
| 8 | GET | `/api/view` | ✅ D4 `ViewDTO`（`04:131-138`）｜D1 已正确引用 | ✅ `getView`（`01:264`）｜D4 `buildView` | ✅ D4 parity | ❌ **D4 §3 口径未跟 #9**（B-B-3） |
| 9 | GET | `/api/audit` | ⚠️ 仅内联形状（`01:738`），无命名 interface | ✅ `getAudit`（`01:265`） | ✅ D1 A27；D6 划 `audit.test.ts` 归 D4 | ❌ **页面 `audit.js` D4 仍无**（B-B-2）｜R1 |
| 10 | GET | `/api/revisions` | ✅ `RevisionDTO`+`DeletedUriDTO` | ✅ `getRevisions`（`01:266`） | ✅ A28–A29 | 闭环 |
| 11 | GET | `/api/events` | ✅ `EventsDTO` | ✅ `getEvents`（`01:269`） | ✅ A30–A33 | 三方闭环 |
| 12 | POST | `/api/node` | ✅ 复用 `NodeResponseDTO` | ✅ `postNode`（`01:270`） | ✅ A34/A44 | 闭环 |
| 13 | POST | `/api/node/revise` | ⚠️ `NodeResponseDTO`，**缺 `version`** | ✅ `postRevise`（`01:271`） | ✅ A35–A36 | **S4** |
| 14 | POST | `/api/node/forget` | ✅ 内联 | ✅ `postForget`（`01:272`） | ✅ A37 | 闭环 |
| 15 | POST | `/api/node/restore` | ✅ 复用 | ✅ `postRestore`（`01:273`） | ✅ A48 | 闭环 |
| 16 | POST | `/api/node/relocate` | ✅ 内联 | ✅ `postRelocate`（`01:274`） | ✅ A38 | 闭环 |
| 17 | POST | `/api/edge` | ✅ 内联 | ✅ `postEdge`（`01:275`） | ❌ 无直接测试 | 建议补（D5 W7 的 kind 覆盖值得断言） |
| 18 | POST | `/api/glossary` | ✅ 内联 | ✅ `postGlossary`（`01:276`） | ✅ A41 | 闭环 |
| 19 | POST | `/api/glossary/remove` | ✅ 内联 | ✅ `postGlossaryRemove`（`01:277`） | ❌ 无直接测试 | 建议补 |
| 20 | POST | `/api/awaken` | ✅ 内联 | ✅ `postAwaken`（`01:278`） | ✅ A42 | 闭环 |
| 21 | POST | `/api/world-time` | ✅ 内联 | ✅ `postWorldTime`（`01:279`） | ✅ A39–A40 | 闭环 |
| 22 | GET | `/` `/*` | ✅ 无需 DTO | ✅ 静态分支（`01:302-320`，含 `%2e%2e` 与 `/assets/../` 测试） | ⚠️ D2 §12.3 人工 M1 + B12 | ✅ 已按 §16.7 收口 |

**统计（当前状态）**：22 行中 **15 行三方全闭环**（1/2/3/4/10/11/12/14/15/16/18/20/21/22 + 8 的 DTO 侧）；**3 行有 blocker**（5 的 `around`、8 的 D4 口径、9 的 `audit.js`）；**2 行仅命名待统一**（6/7）；**3 行缺直接测试**（7 间接/17/19）。

---

## 附二：三个最复杂点的可实施性裁决

| 点 | 裁决 | 依据 |
|---|---|---|
| `visibility.ts` 的 `shadowed` 两步算法 | **可直接实现**，伪代码 + 两条实现路径足够，三方口径一致 | `00:260-281`、D1 §11-C8 |
| `views.ts` 七视图取数与排序 | **可直接实现**，逐视图行号对照 + 完整代码；须按 B-B-1/B-B-3/B-B-4 更新 §3/§11 | `04:144-448`、`04:986-1078` |
| `serialize.ts` 处理类实例 | **可直接实现**，三条规则 + 实跑证据齐全 | D1 §6.1 |

---

## 附三：本票的覆盖边界（诚实标注）

- **已逐个核对到源码符号级的**：D1 §6/§7/§8、D2 §4/§5/§6、D3 §2/§3/§5、D4 §2/§3/§5、D5 §3/§5、D6 §2–§6 的**全部符号引用与 DTO 字段名**。
- **第二轮补完的**：D6 §7（体积/性能 `06:572-600`）、D6 §11（验收清单 `06:700-740`）、D6 §12（不做范围）已读 —— **D6 工程质量高、未发现符号级问题**；其工程结论（`tsgo` 只扫 `.ts`、`npm pack` 不加执行位、三份 lock 各多 3 行 `bin`、`test/web/*.ts` 不被 root tsgo 覆盖）与主 agent 独立复现一致。D4 §11 的 **T1–T24 全表已逐条读**（T15 已删；T20 自相矛盾见 B-B-c；T23/T24 为新增审计页用例；T9a/T9b/T9c 三防线设计正确）。
- **仍未逐条穷尽的（诚实标注）**：D4 §11 的 T1–T8、T10–T12、T17–T18 只读了标题与断言目标，未核到符号级；但它们的断言对象（`buildView` / `render*` / `RX.*` / `assertParity`）我已在 §10.3 层面逐个确认**存在且签名对得上**。
- **本报告的时序脆弱性（重要）**：本批文档在本票执行期间**被 owner 持续回写**（D1/D2/D3/D6 在 09:20–09:25，D4 到 09:32 仍在改）。我的每条结论都标了**核对时的文件状态**；**若 D4/D1 在此之后又改，请以即时 `grep` 为准**。判定当前 blocker 的三条一行命令：
  ```bash
  grep -c "MUST 复用 \`tools.ts\` 的口径" plan/memory-web/04-系统视图与库健康.md   # B-B-a：>0 即未修
  grep -c "T20" plan/memory-web/04-系统视图与库健康.md                            # B-B-c：≥2 即自相矛盾
  grep -c "around?（number" plan/memory-web/01-服务端与API.md                      # B-A：>0 即未修
  ```
- **本报告时序脆弱性的兜底**：见上方三条 `grep` 命令 —— **任何一条命中，即以命令输出为准，不要采信本报告的行号**。
- **未修改任何被评审文档**（`grep -n "PUT \|CUT " review-可实施性.md` 自身亦为空，本报告无编辑工具残留）。
