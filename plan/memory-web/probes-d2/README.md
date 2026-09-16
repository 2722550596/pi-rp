# D2 检索与打分探针脚本（归档）

> 归档自 `/tmp/d2exp/`（2026-09-16，由主 agent 评审 F9 触发——原 `/tmp` 引用会在清理后蒸发）。设计文档：`plan/memory-web/22-检索与打分.md`。
>
> **若本目录脚本的实跑输出与 `22-检索与打分.md` 的结论冲突，以脚本实跑输出为准**（重跑一次即可）。

## 跑法

全部是 `node --experimental-strip-types <file>`，从仓库根或 `packages/memory` 均可（脚本用绝对路径解析 `@node-rs/jieba`，见下）。

```bash
cd /home/yoshix7ti/projects/pi-rp

# 1. 验收断言 A1–A7 的非空性（不需要真库，自建 :memory: 库）
node --experimental-strip-types plan/memory-web/probes-d2/d2-evidence-asserts.mjs

# 2. 三段隔离（需要一份 v2 真库快照，见「快照制备」）
SRC=/tmp/d2exp/cur.db node --experimental-strip-types plan/memory-web/probes-d2/d2-evidence-isolate.mjs

# 3. 入口条件是否进 FTS（方案 1 的唯一实测证据）
SRC=/tmp/d2exp/cur.db node --experimental-strip-types plan/memory-web/probes-d2/d2-evidence-entry.mjs
```

> ⚠️ **`/tmp/d2exp/*.db` 是本 README 教你自己现造的 SQLite 快照路径，不是归档物**——归档里**没有** `.db` 文件（真库十几 MB 且持续变动，不适合入库）。每次跑前按下一节现造即可。

## 快照制备（⚠️ 纪律：契约 §7 门槛 9）

```bash
mkdir -p /tmp/d2exp
# 现库（权威样本；本机有 9 个 elias/memory.db，MUST 写全路径）
# ✅ 首选 VACUUM INTO —— 它「先固化源库再落盘」，一步到位。
sqlite3 "file:/home/yoshix7ti/world/magnolia/elias/.pi/memory.db?mode=ro" \
  "VACUUM INTO '/tmp/d2exp/cur.db'"
# 校验（数字随真库演进，仅确认非空/非零）
sqlite3 "file:/tmp/d2exp/cur.db?mode=ro" \
  "select count(*) from nodes; select count(*) from nodes where disclosure is not null and disclosure<>'';"
```

> ⚠️ **不要用「`cp` 之后对副本 `PRAGMA wal_checkpoint`」**——那**无效**：`cp memory.db out.db` 不带 `-wal`，
> **当场就复制走了旧快照**；事后对副本 checkpoint 只作用于副本自己的 `-wal`，补救不了。
> 替代写法（同样正确）：**先对源库 checkpoint，再 `cp`**：
> ```bash
> sqlite3 /home/yoshix7ti/world/magnolia/elias/.pi/memory.db "PRAGMA wal_checkpoint(TRUNCATE)" && \
>   cp /home/yoshix7ti/world/magnolia/elias/.pi/memory.db /tmp/d2exp/cur.db
> ```
> 实证（写者持锁 + `wal_autocheckpoint=0`，222 KB 未合并 WAL）：裸 `cp` 与「cp 后 checkpoint 副本」**都丢新表**，
> 只有 `VACUUM INTO` 与「先 checkpoint 源库再 cp」拿到完整数据。详见 `22-检索与打分.md` §10.0。

> 📌 **节点数会变**：撰写时（2026-09-16）现库为 **120 节点 / 86 带 disclosure**；本文档最终校验时真库已长到 **122 / 88**。脚本输出里的 `N/M` 分母即当时查询数，**不是**固定常量；(a) 段要求 `N/N`（恒等），其余按比例判读。

## 脚本清单

| 脚本 | 证明什么 | 对应 22 文档 | 需要真库 |
|---|---|---|---|
| `d2-evidence-asserts.mjs` | **A1–A7 全部通过**（把 §8 提议实现 monkeypatch 到真实类上，**不改源码**）；**同一组断言在未改动 v2 上全部 FAIL**（非空性） | §10 非空性断言 | 否（`:memory:`） |
| `d2-evidence-isolate.mjs` | **三段隔离**：(a) 布局 `N/N`、(b) 权重、(b′) 恒等校验、(c) 文本修复；**附加四段**：(i) token 接缝、(ii) bare≡默认权重、(iii) bm25 多余权重静默忽略、(iv) **`ORDER BY rank` 忽略自定义权重** | §5.2 / §5.3 / §3.2 / §3.4 | 是（附加四段只用 `:memory:`，与真库无关） |
| `d2-evidence-entry.mjs` | **方案 1 vs 方案 2**：入口专属词在方案 A 下 0 命中、方案 B 下命中 **target 节点**（归因说谎） | §5.4 | 是（会写副本） |

**(1) bm25 权重 `0.0, 1.0, 1.0`**（契约 §3.2，主 agent 已裁定采纳）：
- `d2-evidence-isolate.mjs` 的 **(b) 段**：`0.0, 2.5, 1.0` 在真库上扰动 74/88 的完整排序（top-1 不变）。
- 同脚本 **bare 校验**：`bare ≡ (1.0,1.0) ≡ (0.0,1.0,1.0)` 为 `true`，而 `bare ≡ (0.0,2.5,1.0)` 为 `false`
  ⇒ **推荐值 = FTS5 默认权重，纯行为保持**；`2.5` 才是改变行为的那一个。
- 同脚本 **arity 校验**：3 个权重 == 5 个权重（多余被**静默忽略**）⇒ E2 陷阱成立。
- 同脚本 **(iv) 段**：`ORDER BY rank` 与 `bm25(t,1.0,1.0)` 同序、与 `bm25(t,0.0,2.5,1.0)` **反序**
  ⇒ **`rank` 用 FTS5 默认权重、忽略 SELECT 里的自定义权重**。这条支撑「`searchNodeFts` 的 `ORDER BY rank` 与权重无关，权重只在 `rank()` 的 tiebreak 生效」（本文 §3.2）。
  ⚠️ 该段用到 `tok()`（jieba），但**不需要真库**（`:memory:` 自建表）；真库快照被删后也能跑。

**(2) 方案 1「入口条件不进 FTS」**（契约 §5.4 / T23）：
- `d2-evidence-entry.mjs`：`Option A: 查 "离心机" -> 0 row(s)` / `Option B: 1 row(s)`，
  而该词在 **0 个节点的 content/uri/disclosure** 中出现。
  ⇒ 方案 B 会把「只存在于别名入口的词」命中到 **target 节点**（用户搜的是入口条件，返回的是节点）——归因说谎（契约 §8 T5）。
- ⚠️ 本脚本**硬编码两个词**（`离心机`/`示波器`）与两个别名 uri，但**目标节点从快照现取**（不硬编码节点 uri）。若真库演进导致该词偶然出现，重跑会显示；可直接换词。

## 与 D3 探针的关系

- D3 的四段对照框架在 `probes-d3/isolate_a3.mjs`（(a) 布局·空列 / (a′) 布局·有值权重 0 / (b) 权重 / (c) 文本修复）。
- 本目录的 `isolate` 是 **D2 自己的版本**：额外把 (a) 段做实为「**同 token 多重集**下 2 列折入 vs 3 列拆出 ⇒ 0 差异」（D3 的 (a) 是「空列」，是另一角度），并附带 token 接缝 / bare / arity / **rank 忽略自定义权重** 四段。两者结论同向（布局中立、权重仅 tiebreak、文本修复是预期差异）。
- D3 用**真库 13 条可区分序**做分母，D2 用**全部带 disclosure 节点**（86→88 条）做分母；口径不同，**都满足门槛 1 的「三段可归因」**。

## 依赖

- Node ≥ 22.5（`node:sqlite` 的 `DatabaseSync`）。
- `@node-rs/jieba`：脚本用 `createRequire` 指向 **`/home/yoshix7ti/projects/pi-rp/packages/memory/package.json`**（绝对路径）。若把本目录整体搬走，改这个字符串。
- `asserts` 脚本 import 仓库源 `../../packages/memory/src/{driver,store,schema,tokenize}.ts`（相对仓库根），故**从仓库根跑**。
