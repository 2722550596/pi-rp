# D3 迁移探针脚本（归档）

> 归档自 `/tmp/d3probe/`（2026-09-16）。设计文档：`plan/memory-web/23-迁移.md`。
> **跑法**：全部是 `node <file>`，直接跑；依赖仓库本源（`packages/memory/src/*.ts`，Node ≥ 22.5 的 type-stripping）。
> **路径注意**：多数脚本硬编码 `/tmp/d3probe/` 工作目录与真库路径 `world/magnolia/elias/.pi/memory.db`。本机有 **9 个** `elias/memory.db`，运行前确认路径（契约 §7：引用真库 MUST 写全路径 + `PRAGMA wal_checkpoint(TRUNCATE)`）。
> 归档时**未改一行**，`/tmp/d3probe/` 的内容原样搬来（除 `v2.sql` 是 DDL 转储）。**若脚本与 `23-迁移.md` 的结论冲突，以脚本的实跑输出为准**（重跑一次即可）。

---

**一键复跑三个核心门槛**（全部 exit 0 = 通过）：

```bash
cd /home/yoshix7ti/projects/pi-rp/plan/memory-web
node probes-d3/fixture-v2.mjs    # 造 v2 fixture（源码未 bump 时有效）
node probes-d3/verify.mjs        # 门槛 2/3/4  -> 18/18 PASS, exit 0
node probes-d3/wal-vs-cp.mjs     # 备份必须 VACUUM INTO -> 2/2 PASS, exit 0
node probes-d3/e2e.mjs           # 端到端迁移 -> ALL ASSERTIONS PASS
```
> 实跑记录（2026-09-16）：`verify` 18/18 PASS、`wal-vs-cp` 2/2 PASS、`e2e` ALL ASSERTIONS PASS。

**可重跑性（硬要求）**：所有脚本 MUST 可任意次数重跑（自清理上一轮产物 / 备份撞名加序号）。
归档时逐个体检：17 个脚本各连跑两遍，全 `exit 0`。
> 体检发现并修掉 3 处不可重跑：`verify`（备份时间戳撞名 → 加 `-N` 后缀）、`probe7`（虚表建索引的**预期失败**未捕获 → 误报 exit 1）、`timing3`（`big.db`/`warm.db` 残留 → UNIQUE 约束崩）。
> 设计后果：备份路径的撞名处理**已被写进 `23-迁移.md` §3 步 4 与 §11-C10**（不只是脚本问题——多入口并发可能在同一秒触发两次迁移）。

## 核心（对应 23-迁移.md §10 的验收计划）

| 脚本 | 证明什么 | 对应 |
|---|---|---|
| `fixture-v2.mjs` | **造真 v2 库 fixture**（跑今天的 `createSchema`，形状精确，不手抄 DDL）→ `/tmp/d3probe/fixture-v2.db` | §10.0(A) |
| **`verify.mjs`** | ⭐ **门槛 2/3/4 的一次性可复跑证据**：真库副本逐条不变（全行 JSON 快照比对）、幂等（三遍）、回滚（事务内抛错 + 备份可恢复）。**18/18 PASS，exit 0** | §10.1、§10.3、§10.4 |
| **`wal-vs-cp.mjs`** | ⭐ **为什么备份 MUST 用 `VACUUM INTO`**：合成库造非空 WAL → 裸 `cp` 丢行、`VACUUM INTO` 与 live 一致（危害必现） | §3 步 4、§10.4 |
| `e2e.mjs` | **端到端迁移**：v2 fixture → 迁移 → T-1/T-2/T-3/marker/MATCH 全通过；死别名原样保留 | §10.1b、§10.6 |
| `migrate-timing.mjs` | DDL / `reindexAll` / `VACUUM INTO` 耗时；**崩溃恢复（v3 + marker + 空 FTS → 自愈）** | §3 步 4/6、§10.5 |
| `pollute.mjs` | **版本号污染**：纯版本号判据的迁移器抛 `duplicate column name`；列存在性判据版正常收口 | §11-C1 |
| `import-probe.mjs` | 旧快照（删掉 disclosure 键）能导入；`import()` 把 `schema_version` 写回库 | §9.1(a)(b) |
| `probe6.mjs` | `DROP TABLE node_fts` 连带删掉 5 张 shadow 表 | §3 步 3 |
| `probe7.mjs` | **`CREATE VIRTUAL TABLE IF NOT EXISTS` 撞同名旧表 = 静默空操作**（T9 的具体坑） | §3 步 3 |
| `nulltest.mjs` | 三列 FTS 表里第 3 列写 NULL vs `''` 在 bm25 与 MATCH 上**完全等价** | §10.2 |
| `timing3.mjs` | `reindexAll` 规模曲线（5000 节点 = 1.02 ms/节点；elias 120 节点热 = 195 ms） | §11-C5 |

## bm25 / 排序对照（(a)(a′)(b)(c) 四段）

| 脚本 | 对照 |
|---|---|
| `isolate_a3.mjs` | **(a) 布局·空列 = 0/13**、**(a′) 布局·有值权重 0 = 1/13** —— 门槛 1 的必要条件 |
| `isolate2.mjs` | **(c) 文本修复 = 10/13**（存量 FTS 文本陈旧 vs 重算文本，两列对两列、权重固定） |
| `sortcmp.mjs` | v2 库 vs v3 库真实检索链路的 top-N 对比（**混合了权重 + 文本修复，不能单独归因**，仅作整体观感） |
| `isolate.mjs` | 早期版本（scoring 语义不忠实，被 `isolate2.mjs` 取代，保留备查） |
| `probe.mjs` | 最早的迁移可行性探针（VACUUM INTO / ALTER / DROP+CREATE 全流程） |

## 存量陈旧面

| 脚本 | 测什么 |
|---|---|
| `drift2.mjs` | 存量 `node_fts.text` vs 今天 `reindexNode` 公式（含 glossary）→ **19/120 陈旧** |
| `stale.mjs` | 陈旧节点的 `updated_ts` 分布（集中在上一轮修 glossary 时序 bug 之前） |
| `tokdrift.mjs` | 早期版本（漏了 glossary extras，数字偏小，被 `drift2.mjs` 取代） |

## 其他

| 文件 | 内容 |
|---|---|
| `dumpv2.mjs` | 用今天的 `createSchema` 转储 v2 的完整 DDL |
| `v2.sql` | 上者的输出（v2 全表 DDL + 索引，107 行）—— 供「不跑 Node 也能看形状」 |
| `late` 系列（`p2`~`p8`） | SQLite 语义探针（ALTER 重复、VACUUM INTO 行为、FTS 部分列 INSERT 等），已合并进上述脚本的输出，未单独归档 |

## 实现后新增（D3 落地时）

| 脚本 | 内容 |
|---|---|
| **`real-two-copy.mjs`** | ⭐ 验收要求的**两份真库副本对照**：**先对源库 `wal_checkpoint(TRUNCATE)`** 再 `VACUUM INTO` 出 A/B 两份；A 留 v2 作对照，B 走**真实** `createSchema`+`MemoryStore` 迁移。断言 A 未动、B 为 v3、`nodes`/`aliases`/`edges` 全行 JSON 快照逐条相等、`raw_log`/`audit_log`/`node_revisions` 计数不变、`node_fts` 行数不变、存量 `disclosure` 非空数不变、`searchNodeFts` 在重建后的索引上命中。可复跑（每次 `rm -rf /tmp/d3-real`）。真库全路径：`/home/yoshix7ti/world/magnolia/elias/.pi/memory.db` |
| **`make-fixture-v2.mjs`** | ⭐ bump 之后重建 `packages/memory/test/fixtures/memory-v2.db`（**唯一方式**）。用 `v2.sql` 的固定 DDL（已剔除 5 张 FTS shadow 表的 `CREATE TABLE`，SQLite 会拒），按真 v2 形状灌入 5 节点 / 2 别名（含 1 条死别名）/ 1 边 + 两列 FTS 行 |

> ⚠️ `fixture-v2.mjs` 依赖「源码未 bump」这个前提；bump 到 v3 后它产出的是 **v3** 形状，**不再**是 v2 夹具。它归档在那里只是当时那一次的证据；现在请用 `make-fixture-v2.mjs`。
> ⚠️ `e2e.mjs` 里那行 `bm25(node_fts,0.0,2.5,1.0)` 是初版权重，已被契约否决（改成 `0.0,1.0,1.0`）；它只出现在 `ORDER BY` 里，不影响该脚本的断言。已就地改为冻结值。
