# 13 · 模块 D：memory 与 sqlite 归化

> 契约依据：`01-共同上下文.md` §2.3 / §10 / I6；验收基准：`00-需求原话.md` §2 E1–E8。
> **2026-09-30 明月拍板（本版定稿依据）**：全剖面统一 Intl.Segmenter，彻底移除 `@node-rs/jieba`——三剖面 tokenizer 完全一致（I6 最强形态，无降级声明），全仓唯一 native 依赖消灭；契约 §10 已回写（含迁移前置纪律）。本文档 §11.1 的 jieba 对照实测数据**全部保留**作为决策依据；反转记录见 §11.1.5。
> 本文档所有实测均于 2026-09-30 在本仓真实环境（Node v26.8.1 / WSL2 x64）执行，脚本为一次性临时脚本（已删），方法与原始数据随文内表格留档。候选包版本均为当日 npm latest：`sql.js@1.14.2`、`wa-sqlite@1.0.0`、`@sqlite.org/sqlite-wasm@3.53.4-build1`、`@node-rs/jieba-wasm32-wasi@2.0.3`、仓内 `@node-rs/jieba@2.0.2`。

---

## 1. 需求对照（E1–E8 与原话）

| 效果 | 本模块达成/关联 | 依据 |
|---|---|---|
| E1 打包成接口、便携载体运行 | sqlite 驱动收敛为单点工厂注入（§4 步骤 1–3），memory 主入口 6 文件 node: 静态导入全部归化（§9 代码落点），memory 可进入浏览器 bundle | §4/§9 |
| E2 scale 不占服务器 | memory 全链（recall/disclosure/注入门控/12 工具/3 slots）在用户侧设备运行，LLM 语义依赖只剩 embeddings API 的 fetch（默认 `mode:"off"`，`embeddings.ts:63-77` 隐私默认不出网） | §7 前端可见面 |
| E3 无沙箱无 shell 可用 | memory 不消费 shell 位（对 A 的 capabilities 确认：MemD 零消费）；FTS 检索、打分、注入门控全部进程内 + wasm sqlite | §7/§10 |
| E4 harness 能力面完整（memory 是其中之一） | 12 工具（`module.ts:168-181`）、3 slots（`slots.ts:58,108,125`）、注入门控语义三剖面一致，I6 达成路径见 §10 | §11 |
| E5 阻碍项"聪明地改掉"而非绕过 | node:sqlite → 接口化驱动 + 按剖面注入实现（非砍除）；jieba native → **彻底移除**、三剖面统一 Intl.Segmenter（2026-09-30 拍板，实测依据 §11.1，反转记录 §11.1.5），无环境 hack | §4/§11.1 |
| E6 仍是 pi-rp，不分叉物种 | 浏览器降级项全部**显式声明**（§10 降级清单），harness 代码本体无 `if (profile)` 分叉；差异只存在于注入的实现与 db 元数据标记 | §11 |
| E7 bash 纯前端禁用 | 与本模块无交集（memory 工具不经 bash）；本文档不涉及 | — |
| E8 兼容优先不锚定临时方案 | 三候选 sqlite、四候选分词均实测对照后裁决；`01-共同上下文.md` §10 的候选清单按证据收窄（sql.js 出局，§11.2） | §11.1/§11.2 |

原话关联：消息 3「某些模块依赖 node…聪明一点改掉」= driver.ts 的 node:sqlite 单点与 `@node-rs/jieba` native（§2.3 调研事实）；消息 6「核心诉求浏览器化+兼容」= I6 三剖面语义一致 + 降级显式。

---

## 2. 一句话定位

把 `packages/memory` 的两个 Node 硬依赖——node:sqlite 驱动（唯一持久层）与 @node-rs/jieba 分词（唯一 native 依赖）——归化收尾：驱动收敛为**单点工厂注入**；分词按 2026-09-30 拍板**三剖面统一 Intl.Segmenter、jieba 彻底移除**（迁移门保证存量库安全过渡），使 memory 全功能（存储/检索/注入门控/12 工具/3 slots）在 node / browser / hosted 三剖面**逐位一致**地运行，残余降级项显式成清单。

---

## 3. 签名参数（归化后的注入接口）

### 3.1 sqlite 驱动接口（收敛既有注入架构，不造第四抽象）

既有的工厂注入架构在 session 后端：`SqliteDatabaseFactory { open(path): Promise<SqliteDatabase> }`（`packages/session-backends/sqlite-node/src/sqlite/types.ts:28-30`，`packages/agent/README.md:13` 声明的注入口）。memory 的 `MemoryDatabase`（`packages/memory/src/driver.ts:28-33`）与之形状几乎同构：

| 方法 | memory `MemoryDatabase` | sqlite-node `SqliteDatabase` | 差异 |
|---|---|---|---|
| exec(sql) | ✅ | ✅ | 无 |
| prepare(sql)→语句 | `{run, get, all}`（driver.ts:3-9） | `{run, get, all, iterate}`（types.ts:9-14） | memory 少 `iterate`（memory 全仓不用 iterate，收敛后白得） |
| transaction(fn) | ✅ | ✅ | 无 |
| close() | ✅ | ✅ | 无 |

**设计：四个类型（`SqliteRunResult`/`SqliteStatement`/`SqliteDatabase`/`SqliteDatabaseFactory`）上移至 `packages/agent`（建议落点 `src/harness/sqlite.ts`，纯 types + 零运行时），sqlite-node 包改为 re-export（调用方零改动），memory 包新增 types-only 依赖 `@earendil-works/pi-agent-core`。** [推断] pi-agent-core 已是 FileSystem/ExecutionEnv/JsonlSessionRepo 类型的家，types-only 上移无环（pi-agent-core 不依赖 memory，已核 `packages/agent` 无 pi-memory 依赖）。

memory 驱动入口归化后签名：

```ts
// packages/memory/src/driver.ts（归化后）
export interface MemoryDriverOptions {
  /** 缺省 = node 剖面实现（经 sqlite-node 的 createNodeSqliteFactory 动态拼装，见 §9） */
  sqlite?: SqliteDatabaseFactory;
}
export async function openDatabase(path: string, options?: MemoryDriverOptions): Promise<SqliteDatabase>;
export async function openMemoryStore(path: string, options?: MemoryDriverOptions): Promise<MemoryStore>;
```

`openDatabaseReadonly(path)` **不再作为工厂级第二入口**，改为 `SqliteDatabaseFactory` 的可选第二语义位：

```ts
export interface SqliteDatabaseFactory {
  open(path: string): Promise<SqliteDatabase>;
  /** 只读打开。node 实现 = driver.ts:89-151 现逻辑原样搬入；browser 实现见 §10 降级项 D3 */
  openReadonly?(path: string): Promise<SqliteDatabase>;
}
```

### 3.2 分词器接口（2026-09-30 拍板：三剖面统一 Segmenter）

```ts
// packages/memory/src/tokenize.ts（归化后）
export interface MemoryTokenizer {
  /** 恒为 "segmenter"——memory_kv.fts_tokenizer 落账值域即此单值（连预留位都不留，拍板原文） */
  readonly space: "segmenter";
  /** FTS 空间（写侧与查询侧同一函数，tokenize.ts:6-9 注释契约保留） */
  tokenizeForSearch(text: string): string;
}
export function createMemoryTokenizer(): MemoryTokenizer;
```

**契约 §3 纪律（评审门 R3-E6 修正，拍板后进一步简化）**：无参工厂、无剖面名、无 kind 联合——三剖面同一种分词器，注入差异不复存在于分词面；接口保留仅为测试可注入 stub。`memory_kv.fts_tokenizer` 值域 = `"segmenter"` 单值。

**jieba/bigram 作为分词器种类永久删除**（拍板原文）；`tokenizeForMatch`（打分空间，latin+bigram，`tokenize.ts:22-31`）**保留不变**——它是打分算法（keywordScore 的 query/doc 重叠度量），不是分词器配置，与 `fts_tokenizer` 无关（tokenize.ts:15-18 的「选择用 FTS 空间、打分用 bigram」分工注释是行为契约）。

**环境前提（engines 底线）**：Node 侧 `Intl.Segmenter("zh")` 依赖 full-icu——Node ≥13 官方构建默认 full-icu，`packages/memory/package.json` engines `>=22.19.0` 已覆盖，**底线不变、无需声明新增**；非官方 small-icu 自定义构建下 Segmenter 构造失败 ⇒ **throw 明确错误**（含修复指引），不做静默劣化兜底（I6 非静默；浏览器 Chrome 87+/Safari 14.1+ 原生内置，无此问题）。与浏览器同一份 CLDR/ICU 分词数据 ⇒ 三剖面 token 序列逐位一致。

### 3.3 env 与路径解析签名（现状签名不变，注入点变化）

- `resolveMemoryDbPath(cliFlag, settings, preset, cwd)`（`packages/memory/src/config.ts:59-67`）签名不变；`cwd` 在 browser 剖面由组装点传入工作区虚拟根（依赖 11-B 命名空间：默认落点 `/workspace/<project>/.pi/memory.db`，settings/preset 覆盖可为 `/state/**`——与 StoreB 已对齐）。
- `resolveEmbeddingsConfig(settings, env)`（`embeddings.ts:50-51`）的 `env` 默认参数 `process.env` 改为**必传**（去掉默认值），browser 组装点传宿主提供的 env 记录；`PI_MEMORY_EMBEDDING_API_KEY`/`NOCTURNE_EMBEDDING_API_KEY` 键名语义不变（embeddings.ts:37）。
- `PI_MEMORY_DB` env 位：node/hosted 保持读 `process.env.PI_MEMORY_DB`（`agent-session.ts:4787`）；browser 无 env，由组装点以 `cliFlag` 参数位注入同一优先级（config.ts:65 的 `cliFlag ?? settings ?? preset ?? default` 链原样复用）。

---

## 4. 行为契约逐步（每步"漏了会怎样"）

**步骤 1 · 类型上移。** `SqliteRunResult/SqliteStatement/SqliteDatabase/SqliteDatabaseFactory` 移入 `packages/agent/src/harness/sqlite.ts`（types-only），sqlite-node `types.ts` 改 `export * from`（或逐名 re-export）。
漏了会怎样：memory 与 sqlite-node 各持一份结构相同但无亲缘的接口 = 第二抽象，契约 §0 禁止；且两接口将来漂移（如 memory 加 iterate 消费）时无编译期对齐。

**步骤 2 · memory 驱动改造注入。** `openDatabase` 现体内两段：`await import("node:sqlite")`（driver.ts:46-51）+ WAL/busy_timeout pragma（driver.ts:53-54）。归化为：`(options?.sqlite ?? await defaultNodeFactory())`；node 默认工厂 = `createNodeSqliteFactory()`（`sqlite-node/src/index.ts:105-110`）包装后补 `PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000`（现语义逐字保留）。
漏了会怎样：WAL 语义静默丢失会改变 node 剖面多进程并发行为（README.md:216 明示 WAL 是现状契约）；busy_timeout 丢失会让并发写立刻 SQLITE_BUSY。

**步骤 3 · openDatabaseReadonly 拆语义位。** driver.ts:89-151 整体（statSync 预检三态 `ReadonlyOpenError{missing,not-a-file,unreadable}`、FIFO 挂死防护注释、readOnly:true 打开、只设 busy_timeout 不设 journal_mode 的注释契约）搬入 sqlite-node 的 node 工厂 `openReadonly`。memory 的调用方 `web/discovery.ts:159,236` 改经工厂调用。
漏了会怎样：预检三态是 discovery 的错误词汇表（driver.ts:11-13 注释），搬丢会把「文件缺失」和「chmod 000」混成一个错误；FIFO 预检丢失会让 `new DatabaseSync(<FIFO>, {readOnly:true})` 同步挂死进程（driver.ts:97-101 实测记录 exit code 124）。

**步骤 4 · browser 工厂实现。** `@sqlite.org/sqlite-wasm`（裁决见 §11.2）：`open` = oo1 `new sqlite3.oo1.DB(path, "ct")`，`openReadonly` = `"cr"`（§10 降级项 D3）；适配层把 oo1 Stmt（`bind/step/get([])/getColumnNames/finalize`，实测原型方法表见 §11.2）适配成 `SqliteStatement`（run/get/all/iterate——iterate 用 step 循环实现）。适配器把位置数组 + `getColumnNames()` 拼成**普通对象行**（非 null-prototype，见 §8）。OPFS VFS 选择：**默认 `opfs-sahpool`**（官方文档：默认 `opfs` VFS 依赖 SharedArrayBuffer，需 COOP/COEP 响应头；sahpool 无此要求——引用 sqlite.org/wasm/doc/trunk/persistence.md）。
漏了会怎样：选 `opfs` VFS 会把「宿主页面必须带跨域隔离响应头」变成 pi-rp 下游的隐性部署义务，违反 E1 便携性；不拼行对象会让 MemoryStore 的 `rowToNode` 类按名取列代码拿到数组。

**步骤 5 · 迁移门：存量 jieba 空间库 → segmenter 空间（2026-09-30 拍板新增闭案项）。** 四个设计结论：

- **结论一：仅靠 `fts_tokenizer` 键检测，不 bump SCHEMA_VERSION（v4 不动，MIGRATABLE_FROM 不加）。** 理由：① DDL 零变化——`NODE_FTS_DDL`/`raw_fts` DDL 原样（`tokenize='unicode61'` 是 FTS5 内建按空白切，JS 侧 token 空间与该参数无关），版本号语义保持「物理结构版本」；② 既有 `FTS_REBUILD_KEY` + `_healPendingFtsRebuild`（store.ts:2031-2046）机制就是为「结构已就位、内容需重建」设计，自带正确顺序纪律（**重建成功先于删键**，store.ts:2026-2029 注释冻结）与崩溃重试语义（throw 传播 → open 失败 → 下次打开重试），迁移门直接复用、零新机制；③ 键检测按值比对天然覆盖未来任何 tokenizer 变更，版本号不膨胀。键读取点 = store 构造（store.ts:246 `_healPendingFtsRebuild` 挂点前扩一步）。
- **结论二：重建方式 = DROP + CREATE（NODE_FTS_DDL 单点）+ 事务内全量重灌；否决 DELETE 全行重灌。** 理由：① 与 `migrateSchema` v3 先例同构（schema.ts:255-258，注释明言 DROP is load-bearing）；② FTS5 无 TRUNCATE，`DELETE FROM node_fts` 对影子表（%_content/%_doclist/%_idx）逐行维护的代价高于 DROP 的元数据级操作；③ 顺序纪律照契约冻结：**先开库读键 → 重建 FTS → 写新键**，键的写入必须晚于重灌成功（复用 store.ts:2026-2029 既有顺序，禁止反向）。范围含两张表：`node_fts`（`reindexAll`，store.ts:2015-2021，已在事务内）+ `raw_fts`（jieba 空间同样写过，需**新增 `reindexAllRaw()`**：`SELECT raw_id, text FROM raw_log WHERE active = 1` 逐行走 `_reindexRawFts`——现状只有逐行 upsert 路径 store.ts:1222/1231/:1235-1239，无全量重灌，这是本次必须补的缺口）。
- **结论三：存量用户数据安全 = 事务内重建失败整体回滚；否决「保留旧索引只读降级」。** 理由：`reindexAll` 已在事务内（store.ts:2016），DROP+CREATE+重灌+写新键同一事务 ⇒ 任一步失败 ROLLBACK，旧索引原样、新键未写、门条件依旧成立 ⇒ 下次打开自动重试（`_healPendingFtsRebuild` 既有 throw→重试语义，store.ts:2026-2029 注释）；重试窗口内旧（jieba）索引对 Segmenter 查询侧只是质量轻微劣化（§11.1.3：两空间顶级质量同级），不是零召回，可接受。「只读降级」需新增状态机且引入第三种库状态，复杂度不值。**不做 VACUUM INTO 文件备份**：FTS 是可从 `nodes`/`raw_log` 全量推导的衍生索引（非唯一真相），且事务回滚已保证完整性——与 v2→v3 迁移做备份的场景（DROP 在版本迁移事务里、当年无 heal 重试）不同。
- **结论四：重建耗时估算 [推断]**。实测锚点：163 docs（约 2.9 万 CJK 字）Segmenter 全量分词 ~41ms ⇒ ~0.25ms/doc 均摊（§11.1.3 tokMs），加 FTS 插入与逐行 reindexNode 开支按 ~3× 计 ~0.75ms/doc。外推：1 万节点（均 500 字）≈ 8–15 s；10 万节点 ≈ 数分钟。重建同步发生在 store 构造（与既有 v3 heal 同款同步语义）⇒ **大库首开一次性卡顿**是已知代价，如实声明；量级失控时再议异步重建（本次不做，避免新状态机）。

漏了会怎样：无迁移门的「新代码读旧索引」= 查询侧 Segmenter token 对 jieba 索引静默错位，检索劣化不可见——契约 §10 冻结的前置纪律正是堵这个。

**步骤 6 · 分词器统一实现。** tokenize.ts 重写为纯 JS/Web 标准：`Intl.Segmenter("zh", {granularity:"word"})` 拼接器（isWordLike 过滤），node/browser/hosted 同一实现、同一 ICU/CLDR 数据 ⇒ token 序列逐位一致；`loadJieba()`（tokenize.ts:40-51）与 `createRequire`/`node:module` 导入整体删除；Segmenter 构造失败 ⇒ throw 明确错误（§3.2 环境前提），无兜底链。
漏了会怎样：静态 `import { createRequire } from "node:module"`（tokenize.ts:1）留在主链会让 memory 主入口 esbuild browser 打包直接失败（仓内 browser-smoke 只守护 packages/agent 五入口，check-browser-smoke.mjs:35-41，memory 不在守护面，坏了解不会被 CI 发现）。

**步骤 7 · 剩余 node: 静态导入清除**（清单见 §9）。其中 md5（embeddings.ts:101-103 `embedHash`、module.ts:190-192 注入去重）换纯 JS md5 实现（~2KB），**不换 sha-256**：哈希值是 memory_embeddings 缓存键与注入去重键，纯 JS md5 保持字节级一致 ⇒ 跨剖面同库缓存/去重不失效；subtle.digest 无 MD5 且异步化会污染同步调用点（module.ts buildMemoriesBlock 同步渲染路径）。
漏了会怎样：换哈希算法 = 全量重嵌 embeddings（钱）+ 注入去重首轮失效（体验）；留 node:crypto = 打包失败。

**步骤 8 · 路径链接线。** browser 组装点：`resolveMemoryDbPath(cliFlag←组装参数, settings, preset, cwd←工作区虚拟根)` → 得虚拟绝对路径（11-B 命名空间）→ `openMemoryStore(dbPath, { sqlite: browserSqliteFactory })`；工厂闭包持 OPFS root，直接消费虚拟绝对路径字符串（StoreB 已确认契约）。父目录创建：`agent-session.ts` 单例壳 `getMemoryStoreSingleton`（:235-253）内的 mkdirSync（:240-243，实际 `openMemoryStore` 调用点 :246）换成 `SqliteSessionRepositoryEnv` 同款 `env.createDir`（types.ts:46 已有此 Pick 面，memory 复用同形状）。
漏了会怎样：路径链四个优先级位（PI_MEMORY_DB > settings > preset > default，agent-session.ts:4775 注释契约）任何一档在 browser 断掉，都等于 memory 配置面在浏览器缺角。

---

## 5. 文件与副作用

**新增文件**：\`packages/agent/src/harness/sqlite.ts\`（types-only）；\`packages/memory/src/driver-browser.ts\`、\`md5.ts\`。**不再新增** tokenize-node.ts / tokenize-browser.ts（拍板统一后只有一个实现，见 §3.2）。

**修改文件**：\`packages/memory\` 的 driver/tokenize/config/schema/embeddings/module/store/index（逐点见 §9）；\`packages/session-backends/sqlite-node/src/index.ts\`（工厂扩 openReadonly）与 \`src/sqlite/types.ts\`（re-export）；\`packages/coding-agent/src/core/agent-session.ts\` 三处组装点；\`packages/agent/README.md:13\` 补一句声明。

**外部资产（分发形态依赖 15-F）**：browser bundle 携带 \`sqlite3.wasm\`（869KB raw / 403KB gzip）+ glue \`index.mjs\`（175KB gzip）；分词器**零资产**。wasm 加载 = \`new URL('./sqlite3.wasm', import.meta.url)\` fetch，\`./sqlite3.wasm\` 是包的显式 exports 子路径，bundler 可静态资源化。

**依赖变更**：\`packages/memory\` **删除** \`@node-rs/jieba\`（拍板：全仓唯一 native 依赖消灭，jieba/bigram 分词器种类永久移除）——install 体积随之减去平台二进制 + 11MB 词典文本（dict.txt 5.07MB + idf.txt 6.20MB raw，§11.1.4 实测）；新增 types-only \`@earendil-works/pi-agent-core\` 与 devDep \`@sqlite.org/sqlite-wasm\`。

**db 副作用**：\`memory_kv\` 新键 \`fts_tokenizer\`（建库写入，值域 \`"segmenter"\` 单值）；存量 jieba 库首开触发一次全量 FTS 重建（迁移门，§4 步骤 5：DROP+CREATE+事务重灌 node_fts 与 raw_fts，写 \`fts_rebuild_pending\` 复用既有机制）；schema 迁移备份文件（\`*.pre-v*-{stamp}.bak\`，schema.ts:313-316 VACUUM INTO）在 browser 落 OPFS 同子树（迁移门本身不做文件备份，结论三）。

**临时脚本**：本次实测脚本位于 /tmp（tokenize-bench / sqlite-probe / sqlite-probe2.mjs），已按纪律用完即删，不留仓内痕迹。

## 6. 落账

- **\`memory_kv.fts_tokenizer\`**（新）：**\`"segmenter"\` 单值**（拍板：jieba/bigram 值永久删除，连预留位都不留）。建库写入；打开时读键 ≠ \`"segmenter"\`（含旧库缺键）⇒ 迁移门触发（§4 步骤 5：DROP+CREATE+事务重灌 → 成功后写键）。缺键旧库 = jieba 空间，正是迁移门的服务对象。
- **README 回写**：\`packages/memory/README.md:216-217\` 两段（node:sqlite 单点 / jieba 依赖）随归化改写为「工厂注入 + 统一 Intl.Segmenter（无 native 依赖）」描述，消除 C1 冲突。
- **契约回写**：2026-09-30 拍板已由主代理回写契约 §10（统一 Segmenter + 迁移前置纪律）；本模块侧记录见 §12 拍板申报行。
- **日志面**：迁移门重建/失败走 \`_setupMemoryModule\` 既有 emitError 通道（agent-session.ts:4815-4830），不新增第二日志源。

## 7. 前端可见面

浏览器剖面上 memory 的对外形状三剖面一致（I6）：

- **12 个 LLM 工具**（`module.ts:168-181`）：recall / retrieve / memorize / revise / forget / relocate / associate / trigger / consolidate / retrace / set_time / awaken——注册路径经 `createMemoryModule` → `MemoryModuleHost.registerTool`（module.ts:72-79 结构接口，引擎满足之），签名与提示词零改动。
- **3 个 prompt slots**（awaken/recent/index，`slots.ts:58,108,125`）+ rp-memories 自定义类型门控（module.ts `registerCustomType`）。
- **注入门控**：`before_agent_start` 自动 recall → `search()`（recall.ts:614）打分 `0.55·vec+0.3·kw+0.15·importance+recency`、`minScore`/`keywordMinScore`/breaker/select 门控（config.ts:19-48 语义注释）——纯计算 + 可选 provider fetch，三剖面同语义。
- **embeddings**：OpenAI 形 `/embeddings` fetch 客户端（embeddings.ts:5-8「zero-dependency fetch client」注释），默认 `mode:"off"` 不出网（embeddings.ts:64-71 隐私优先注释）；browser 组装点以 env 记录供键（§3.3）。
- **不进浏览器面**：`pi-memory-web`（web/ 目录 = Node http 检视服务，bin `web/cli.ts`）——它是**宿主壳/本机工具**，不是浏览器剖面组件；`web/discovery.ts` 多库只读探测同属 Node 服务面。

---

## 8. 错误边界

1. **驱动加载失败**：现状 `openDatabase` 对 `import("node:sqlite")` 失败 throw 明确错误（driver.ts:52-54，README.md:216 契约）。归化后同语义：browser 工厂对 wasm 实例化失败 throw `Failed to load browser sqlite driver: …`；memory 层错误文案不再硬编码 "requires Node >= 22.5"（那是 node 工厂的文案）。
2. **readonly 三态**：`ReadonlyOpenError{missing,not-a-file,unreadable}`（driver.ts:20-24）为 node/hosted 契约；browser 无文件权限语义，`openReadonly` 退化为 open（降级项 D3），`discovery.ts` 三态消费面不进浏览器（§7）。
3. **memory 永不阻断启动**：`_setupMemoryModule` 的 catch-degrade 契约（agent-session.ts:4815-4830：dispose + emitError「Memory module unavailable」）三剖面保留——browser 的 sqlite/分词器任何初始化失败都落进这条既有降级沟。
4. **分词器失败语义（拍板后无降级链）**：三剖面同一 Segmenter 实现；`new Intl.Segmenter("zh")` 构造失败（Node 非官方 small-icu 构建 / 极老浏览器）⇒ throw 明确错误（含环境修复指引），**无 bigram 静默兜底**——现状 tokenize.ts:47-49 的「catch→null→静默换空间」随 jieba 一起删除，I6 非静默原则的彻底版。
5. **行对象契约**：`web/serialize.ts:11-13` 记录的 node:sqlite null-prototype 规则（「按名读列，勿在行上调宿主方法」）对适配层仍然成立且**自动满足**——适配器产普通对象行，规则无成本保留；`SELECT *`（store.ts:224 等）跨实现安全。
6. **事务语义**：`transaction(fn)` 同步回调 + BEGIN/COMMIT/ROLLBACK 包装（driver.ts:70-79）在适配层逐字复刻；sqlite-wasm oo1 同步执行语义兼容（实测）。

---

## 9. 代码落点（精确到文件与函数）

### packages/agent（上游同调面）
- 新增 `src/harness/sqlite.ts`：四类型定义（自 `session-backends/sqlite-node/src/sqlite/types.ts:4-46` 上移）。
- `README.md:13` 声明处补一句「memory 使用同一工厂接口」。

### packages/session-backends/sqlite-node
- `src/sqlite/types.ts` → re-export 上移类型（兼容面不动）。
- `src/index.ts:105-110` `createNodeSqliteFactory` 扩展可选 `openReadonly`（吸收 driver.ts:89-151 全部逻辑与注释）；pragma 逻辑保持 repo.ts:952-967 `configureSqliteDatabase` 现状。

### packages/memory
- `src/driver.ts`：重写为注入式 `openDatabase(path, options?)`（§3.1）；node:fs/node:sqlite 导入清空；`ReadonlyOpenError` 随 node 工厂走（类型留在 memory 或上移 agent，随 discovery 消费面定）。
- `src/tokenize.ts`：整体重写——删 `createRequire`/`node:module`（:1）与 `loadJieba`（:40-51），`tokenizeForSearch` 改 `Intl.Segmenter("zh", {granularity:"word"})` 实现；导出 `MemoryTokenizer` 接口 + 无参 `createMemoryTokenizer()`（§3.2）；`tokenizeForMatch` 打分函数原样保留。
- `src/store.ts`：构造器迁移门扩一步（读 `fts_tokenizer` ≠ "segmenter" ⇒ DROP+CREATE 两张 FTS 表 + `reindexAll` + **新增 `reindexAllRaw()`** + 写键，包在同一事务，§4 步骤 5）；`reindexAllRaw()` 落 `store.ts`（`SELECT raw_id, text FROM raw_log WHERE active = 1` 逐行 `_reindexRawFts`，补 store.ts:1222/1231 只有逐行 upsert 的缺口）。
- `src/config.ts:7`：node:path → 纯 POSIX 字符串工具（`isAbsolute/join/resolve` 三函数，就地小工具或复用仓内既有跨运行时路径工具[待实现时核]）；`config.ts:59-67` 逻辑不变。
- `src/schema.ts:1,313`：existsSync 备份重名探测 → `SqliteDatabase` 内 `SELECT`/VFS stat 等价（实现期择一，行为契约：备份名唯一性保留）。
- `src/embeddings.ts:12,101-103` 与 `src/module.ts:23,190-192`：node:crypto → 纯 JS md5（新增 `src/md5.ts`，零依赖 ~2KB）；`embeddings.ts:50-51` env 默认参数删除（改必传）。
- `src/index.ts:137-141`：`openMemoryStore(path, options?)` 透传工厂；`index.ts:125` 的 `tokenizeForSearch` 导出保持（实现已换）。
- `package.json`：**删除 `@node-rs/jieba@2.0.2`**（dependencies 清出 native 依赖；install 体积 -11MB 词典文本，§5）；新增 devDep `@sqlite.org/sqlite-wasm`（browser 工厂测试用）与 dep `@earendil-works/pi-agent-core`（types-only）。
- 新增 `src/driver-browser.ts`：sqlite-wasm oo1 → `SqliteDatabaseFactory` 适配器（§11.2 裁决实现，含 opfs-sahpool 默认 VFS 常量）。

### packages/coding-agent
- `src/core/agent-session.ts`：单例壳 `getMemoryStoreSingleton`（:235-253，内含 mkdirSync :240-243、`openMemoryStore` 调用点 :246）、`:4786-4791`（`_setupMemoryModule` 的 resolveMemoryDbPath 调用）、`:2276-2280`（reload 路径）：组装点按剖面注入 browser 工厂与 env 记录；node 分支逐字不动（E6）。

### 依赖接口（广播留痕）
- **11-B（StoreB）**：memory.db 的 OPFS 落点 = 虚拟绝对路径 `/workspace/<project>/.pi/memory.db`（默认）或 `/state/**`（覆盖），布局权威 = StoreB 文档；browser 工厂闭包持 OPFS root，消费路径原文。
- **15-F（PackF）**：browser bundle 需携带 `sqlite3.wasm`（403KB gzip）+ glue（175KB gzip）；tokenizer 零资产。分发形态随 PackF 独立包裁决。
- **10-A（ProfileA）**：memory 归化零 capability 位消费（已回执确认）。

---

## 10. 与现状差异


| # | 现状 | 归化后 | 不变量 |
|---|---|---|---|
| 1 | `openDatabase` 内部硬 `await import("node:sqlite")` ×2（driver.ts:46-51,126-130） | 单工厂注入点；node 默认 = sqlite-node 工厂 + WAL/busy_timeout | node 行为逐字节不变 |
| 2 | readonly 独立函数 + statSync 预检（driver.ts:89-151） | factory 可选 `openReadonly` 语义位；node 逻辑原样搬入 | discovery 三态错误词汇不变（node 面） |
| 3 | jieba 经 createRequire 装载（tokenize.ts:43-46），失败静默 fallback bigram | **三剖面统一 Intl.Segmenter（拍板）**，jieba 依赖整体删除；Segmenter 失败明确报错无兜底 | FTS 两空间分工注释契约保留（tokenize.ts:4-18）；打分空间 bigram 算法不变 |
| 4 | token 空间是「剖面的隐式属性」 | token 空间是「db 的显式属性」，三剖面恒为 segmenter——存量 jieba 库经迁移门一次性重建（§4 步骤 5） | I6 最强形态：三剖面 token 序列逐位一致，无跨剖面分叉 |
| 5 | node:crypto md5（embeddings.ts:101,module.ts:190） | 纯 JS md5 | 哈希值字节不变，缓存/去重零迁移 |
| 6 | `resolveEmbeddingsConfig(settings)` 隐式读 `process.env` | env 必传 | node 组装点传 `process.env`，行为不变 |
| 7 | memory 主入口 6 文件 node: 静态导入（config:7/driver:1/embeddings:12/module:23/schema:1/tokenize:1） | 全部归化，主入口可 esbuild platform=browser | browser-smoke 可扩守护 memory 入口（验收 §11.3） |
| 8 | web/ 目录与浏览器无关（Node 检视服务） | 不变（明确边界，防误读） | — |

---


### 10.1 I6：三剖面语义一致面与显式降级清单

**一致面（无降级）**：12 工具签名与语义、3 slots、recall 打分公式与权重（recall.ts:38-40）、注入门控阈值（minScore 0.35/keyword 0.12/ breaker tau/select tau，config.ts:19-48）、autoretain、temp-notify、世界钟、glossary 触发词、修订史、别名/联想边、`memory_kv` schema、`VACUUM INTO` 备份（schema.ts:315，sqlite 引擎级能力全剖面可用）。

**降级清单（browser，全部显式；2026-09-30 拍板后分词面已无降级项）**：

| # | 项 | node/hosted | browser | 显式化机制 |
|---|---|---|---|---|
| D1 | ~~FTS token 空间~~ **已消除（拍板）** | Intl.Segmenter | Intl.Segmenter | 三剖面同实现同 ICU/CLDR 数据，token 序列逐位一致——不再存在分词降级；存量 jieba 库走 §4 步骤 5 迁移门一次性重建（事务回滚保证安全） |
| D2 | ~~分词兜底链~~ **已消除（拍板）** | 无兜底 | 无兜底 | Segmenter 构造失败 ⇒ throw 明确错误（环境前提见 §3.2：Node ≥13 官方构建 full-icu 默认、engines ≥22.19 已覆盖；浏览器 Chrome 87+/Safari 14.1+ 原生）——静默劣化兜底不复存在 |
| D3 | readonly 语义 | 三态 `ReadonlyOpenError`（权限/缺失/非文件） | 无 OS 权限位，`openReadonly` ≡ open 失败单态 | 工厂接口可选位 + 文档声明；消费面（discovery）不在浏览器 |
| D4 | journal/并发 pragma | WAL + busy_timeout 5000 | 不设 WAL（opfs-sahpool 串行单连接；capabilities.concurrentFsAccess=false 单 tab 假设，对 10-A 已对齐） | 工厂实现差异，错误面一致（SQLITE_BUSY 语义由 VFS 层保留） |
| D5 | env 覆盖位 | `PI_MEMORY_DB`/`PI_MEMORY_EMBEDDING_API_KEY` 读 process.env | 组装参数注入 env 记录，键名语义不变 | 组装点显式传参 |
| D6 | PI_MEMORY_DB 之外的父目录创建 | `mkdirSync`（agent-session.ts:240-243） | `env.createDir`（FileSystem Pick 面） | 同 §9 agent-session 落点 |

---

## 11. 验收测试

### 11.1 分词实测（硬验收数据，本模块验收项）

> 以下为 2026-09-30 拍板前的五候选对照实测，**全部保留作为反转决策依据与 Segmenter 路线质量基线**；jieba 系候选已随拍板出局，现行方案 = 统一 Intl.Segmenter（§11.1.5）。

#### 11.1.1 方法

- 语料：仓内真实中文文档 8 件——`docs/memory-system.md`（8955 CJK 字）、`packages/memory/README.md`（6062）、`packages/memory/docs/skills/` 下 6 个 SKILL.md（合计 ~11k）——切段落、滤 CJK≥40 字，得 **163 docs**。
- 查询四组（机械确定性构造，非手挑）：**Q6/Q10** = 恰好只出现在 1 个 doc 中的 6/10 字连续 CJK 子串（各 217 条，真值唯一）；**QEN** = 中英混合子串（12 条）；**Q1** = 单字查询（163 条——`recall.ts:305-309` 记录过的真实缺陷场景：「日」FTS 51 候选但 kw>0 过滤成 0）。
- 评测管线与生产同构：FTS5 `tokenize='unicode61'`（schema.ts:20 NODE_FTS_DDL 原样），查询 = `tokenizeForSearch(query)` 分词后逐 token 引号转义 OR-join MATCH（store.ts:1471-1485 `searchNodeFts` 同款）；指标 = 命中正确 doc 的 recall@1/@5/@10 与 MRR。
- 候选五：jieba-node（现状基线，`@node-rs/jieba@2.0.2` + 全量 dict）、jieba-wasm32-wasi（`@node-rs/jieba-wasm32-wasi@2.0.3`，喂同一 dict.txt）、jieba-wasm（`jieba-wasm@0.1.x`，词典内置）、Intl.Segmenter（Node 内置 full-icu `zh-CN` word 级）、bigram（仓内 `tokenizeForMatch` 同款，现状 fallback）。

#### 11.1.2 一致性（跨剖面 token 空间）

**jieba-wasm32-wasi vs jieba-node：163/163 段落 cutForSearch 输出逐位一致（0 不一致）。** 同一 Rust 引擎 + 同一词典 ⇒ 浏览器若选它，token 空间与 node **零分叉**。

#### 11.1.3 检索质量（FTS5 MATCH 召回，真值唯一）

| 分词器 | Q6 r@1 / @5 / @10 / MRR | Q10 r@1 / @5 / @10 / MRR | QEN r@1 / MRR | Q1 r@1 / @10 / MRR | tok/doc | 163 doc 全量分词耗时 |
|---|---|---|---|---|---|---|
| jieba-node（现状） | .783 / .991 / **1.000** / .872 | .922 / .995 / 1.000 / .956 | .750 / .814 | .061 / .190 / .096 | 207 | ~39ms |
| jieba-wasm32-wasi | .783 / .991 / 1.000 / .872 | .922 / .995 / 1.000 / .956 | .750 / .814 | .061 / .190 / .096 | 207 | ~77ms（约 2×） |
| jieba-wasm | .793 / .982 / 0.991 / .877 | .940 / 1.000 / 1.000 / .967 | .833 / .856 | .049 / .160 / .076 | 200 | 首调 JIT ~493ms，稳态 ~74ms |
| **Intl.Segmenter** | .788 / .972 / 1.000 / .871 | .931 / 1.000 / 1.000 / .960 | .750 / .814 | .067 / .215 / .107 | **118.6（-43%）** | ~41ms |
| bigram（现状 fallback） | **.954** / 1.000 / 1.000 / .975 | **.982** / 1.000 / 1.000 / .991 | .833 / .854 | **.000 / .000 / .000（全灭）** | 149 | ~38ms |

读数（诚实口径）：

1. **bigram 的 Q6/Q10 领先是构造红利**：逐字连续子串查询在 bigram 空间天然全 token 命中（查询 bigram ⊆ 文档 bigram）；真实用户查询是 paraphrase（`scripts/fixtures/recall-benchmark-queries.json` 30 条真查询全是口语改写），该红利会缩水。但 **Q1 全灭是结构性缺陷**：单字查询在 bigram 索引上产出 0 token ⇒ FTS 零候选 ⇒ 连「差排序」都做不到。这正是 tokenize.ts:22-31 把 bigram 定位为「打分空间」而非「选择空间」、recall.ts:305-309 记载 kw>0 过滤归零的同一族问题。**bigram 不能任 browser 默认。**
2. **Intl.Segmenter 与 jieba 质量统计等价**（MRR 差 ≤.005，Q6 @5 差 .019，Q1 反而略好且属噪声级）；代价是专名切分粒度略粗（样例：「专名」→「专/名」、「话头」→「话/头」，jieba 均整词）——在本语料 FTS 选择层未兑现为召回损失。收益：索引 token 数 -43%，分词耗时持平，**零依赖零资源**。
3. **jieba-wasm 质量与 jieba 同级**（不同词典版本导致微小差异），但见 §11.1.4 成本表，无胜出维度。
4. 局限声明：本测的是「FTS 候选选择」层，非 recall 全链打分（打分层 keywordScore 是 bigram 空间、三剖面不变）；语料主题集中（memory 系统文档），专名多样性低于真实记忆库。结论按「分词器之间相对差距」使用，不按绝对值使用。

#### 11.1.4 成本与部署约束

| 候选 | 网络载重（gzip） | 运行时依赖 | 部署约束 |
|---|---|---|---|
| Intl.Segmenter | **0**（浏览器内置） | 无 | 无（[公开文档知识] Chrome 87+/Safari 14.1+/FF 125+ 起内置 zh 分段） |
| jieba-wasm32-wasi | wasm 682KB + 词典 1.91MB（dict.txt 5.07MB raw 实测 gzip） | SharedArrayBuffer（`jieba.wasi-browser.js` 源码 `new WebAssembly.Memory({shared:true})`）+ module Worker | **页面必须 COOP/COEP 跨域隔离** |
| jieba-wasm | wasm **2.82MB**（4.02MB raw） | 无 | 词典内置不可裁剪 |
| bigram | 0 | 无 | 无（但 Q1 全灭，见上） |

#### 11.1.5 2026-09-30 明月拍板：全剖面统一 Segmenter（反转记录）

**原模块内建议**（保留备查）：browser 默认 Segmenter + node/hosted 维持 jieba + bigram 兜底 + jieba-wasm32-wasi 留拍板（依据 = §11.1.3/§11.1.4 数据）。

**拍板反转**（2026-09-30，契约 §10 已回写）：**三剖面统一 Intl.Segmenter，彻底移除 @node-rs/jieba**。反转理由：①本模块实测已证明 Segmenter 与 jieba 检索质量统计等价（§11.1.3 读数 2）——「node 保留 jieba」的原始动机（质量优先）不成立；②统一后 I6 达成最强形态：三剖面 token 序列逐位一致（同一 ICU/CLDR 数据），无降级声明、无跨剖面迁移问题；③全仓唯一 native 依赖消灭，install 体积 -11MB 词典文本（§11.1.4 实测 raw 尺寸）；④memory 包是本仓新增包，无上游同调负担（上游 pi 若跟进，路径已铺平）；⑤jieba-wasm 留拍板项作废（2.82MB gzip 无胜出维度）；jieba-wasm32-wasi 的「逐位一致 premium」被 Segmenter 统一以零成本达成。**本表上方实测数据全部保留**——它们既是反转的决策依据，也是 Segmenter 路线的质量基线（验收阈值出处）。

---


### 11.2 sqlite 三候选实测（API 对齐 / FTS5 / 包体 / wasm 加载）

实测方法：Node 宿主加载各包，对同一 SQL 面（建表/插入/位置与命名参数/行对象/Fts5 建表+CJK MATCH）逐项探测；体积取关键产物字节数与 `gzip -c | wc -c`。

| 维度 | sql.js@1.14.2 | wa-sqlite@1.0.0 | @sqlite.org/sqlite-wasm@3.53.4-build1 |
|---|---|---|---|
| **FTS5** | ❌ **实测 `no such module: fts5`** | ✅ 实测通过（含 CJK MATCH） | ✅ 实测通过（含 CJK MATCH） |
| API 面 | `db.exec/prepare` → Stmt `{step,get,getAsObject,free}`（手动步进，free 语义） | capi 低层：`open_v2/prepare_v2/step/column/changes`（open 返回 Promise，手工拼行） | **oo1**：`new DB(path,flags)`、`db.exec`、`db.prepare` → Stmt `{bind,step,get([]),getColumnNames,finalize,…}`；另有 capi 全集 |
| 与 `SqliteDatabaseFactory` 对齐度 | 中（语句面需步进循环适配，run 的 changes 语义要手工维护） | 低（capi 手工层，等于自写半个适配器） | **高**（exec/prepare/事务语义一一映射） |
| 行对象形态 | `getAsObject` 普通对象 | 纯位置数组，适配器自拼 | 位置数组（`get([])` 填充），适配器拼普通对象（实测 `oo1Rows` 为 plain Object） |
| 关键产物 gzip | wasm 323KB + glue 17KB | wasm 274KB + glue 15KB | wasm **403KB** + `index.mjs` 175KB |
| wasm 加载方式 | `initSqlJs({locateFile})` | emscripten glue + 自定义 VFS 插件（社区 OPFS VFS 另装） | `import("@sqlite.org/sqlite-wasm")` + `new URL('…/sqlite3.wasm', import.meta.url)` fetch；**`./sqlite3.wasm` 是显式 exports 子路径**（bundler 资源化友好） |
| OPFS 持久化 | 无内置（`db.export()` 全量字节手动落） | 靠第三方 VFS | **内置**：`opfs` VFS（需 COOP/COEP+SAB）/ `opfs-sahpool` VFS（无需响应头，官方文档 persistence.md 明示）/ `kvvfs` |
| 维护体感 | 老牌但缓慢（1.x 多年） | 活跃，但 VFS 靠生态 | SQLite 官方项目，跟随 SQLite 版本 |

**裁决：browser 剖面 sqlite = `@sqlite.org/sqlite-wasm`（oo1 + opfs-sahpool 默认 VFS）。** sql.js **出局**——无 FTS5 是一票否决（memory 的 `node_fts`/`raw_fts` 与 session 的 `session_search_fts` 全依赖 FTS5，任何 FTS5 缺失实现都会让检索静默为空）。wa-sqlite 备用（FTS5 ✅ 但 capi 适配面大、OPFS 靠第三方 VFS、长期维护风险高于官方）。

---


### 11.3 永久验收测试清单


1. **驱动契约一致性**：一套 statement/transaction/pragma 套件（对照 `session-backends/sqlite-node/test/adapter.test.ts:3-45` 风格）分别跑 node 工厂与 browser 工厂（vitest + `@sqlite.org/sqlite-wasm`，Node 可加载，实测通过），断言：run 返回 changes、named/positional 绑定、行对象按名取列、transaction 回滚。
2. **迁移门**：jieba 空间建库（或直接构造缺键旧库 fixture）→ 新代码打开 ⇒ 断言 `node_fts`/`raw_fts` 被 DROP+CREATE 且 MATCH 可命中、`fts_tokenizer` 已写 "segmenter"、`fts_rebuild_pending` 已清；重建中途注入失败（stub reindexNode throw）⇒ 断言事务回滚（旧索引行数不变）、键未写、下次 open 重试成功（复用 `test/schema-migration.test.ts:160-166` 的 rebuild 断言模式 + `_healPendingFtsRebuild` 重试语义）。
3. **打包冒烟**：memory 主入口 esbuild `platform:"browser", format:"esm"` 构建通过且 metafile 无 node_modules/node 内置模块——建议追加进 `scripts/check-browser-smoke.mjs` 第三入口（本仓守护模式 §2.1）。
4. **分词质量回归**（把 §11.1 固化）：语料/查询构造脚本参数化进 `packages/memory/test/tokenizer-quality.test.ts`，断言 Segmenter 实现 Q6 recall@5 ≥ .95 且 Q1 ≥ .15（阈值随 §11.1.3 数据定，防 ICU/CLDR 版本漂移回归）。
5. **哈希稳定性**：`embedHash("x")` 与 md5 参考值逐字节比对（防有人「顺手」换 sha-256 破坏缓存键）。
6. **jieba 断根检查**：`grep @node-rs/jieba packages/memory` 零命中 + `node:module`/`createRequire` 零命中（拍板「彻底移除」的机械验收）。
7. **手测脚本**（一次性，已删）：`/tmp/memd-bench/{tokenize-bench,sqlite-probe,sqlite-probe2}.mjs`，产出即 §11.1/§11.2 全部数据。

---

## 12. 发现的冲突

| # | 冲突 | 等级 | 处置 |
|---|---|---|---|
| C1 | `packages/memory/README.md:216` 称「包内**唯一**一处 `await import("node:sqlite")` 在 `openDatabase()`」——实际 `openDatabaseReadonly`（driver.ts:126-130）同样动态 import，共两处 | 轻微（文档过时） | 归化后该句随 §9 落点一并改写；不需回写契约 |
| C2 | 契约 §10 候选「sql.js/wa-sqlite/sqlite-wasm」——实测 sql.js 无 FTS5，出局 | 非冲突（按证据收窄候选） | 本文 §11.2 留档实测；契约候选清单不删不改，本模块裁决记录在案 |
| C3 | 契约 §2.3「memory 包已有 `web/` 子目录（serialize.ts 记录 node:sqlite null-prototype 差异等），web 侧适配意识已存在」——**`web/` 实为 Node http 检视服务（pi-memory-web）**，不是浏览器适配层；可复用面仅 serialize.ts:11-13 的行对象纪律 | 表述澄清 | 已在 §7/§8 写明边界；不影响任何冻结项 |
| C4 | [推断级] memory 新增 types-only 依赖 `pi-agent-core`——两包目前无依赖关系，此为新增边 | 已闭案（2026-09-30 评审门裁决：**维持上移**） | §3.1 给出理由（唯一不造第四抽象的收敛点，收敛既有 sqlite-node 类型正是契约 §0「优先收敛既有半成品」）；types-only 零运行时依赖，评审门认可，无需备选 |
| C5 | R1-D3：browser sqlite 工厂经 opfs-sahpool VFS 直写是否构成 I4「第三条落盘路径」 | 已闭案（2026-09-30 评审门） | 主代理已在契约 §6 I4 增补豁免句：browser sqlite 工厂 VFS 直写不属第三条落盘路径，由 `SqliteDatabaseFactory` 注入缝管控；本文 §4 步骤 4 方案维持不变 |
| C6 | **2026-09-30 明月拍板（申报备案）**：tokenizer 方案反转——原「node 留 jieba + browser Segmenter + jieba-wasm32-wasi 留拍板」改为**全剖面统一 Intl.Segmenter，彻底移除 @node-rs/jieba**；jieba/bigram 分词器值永久删除，`fts_tokenizer` 值域收窄 `"segmenter"` 单值 | 拍板执行（契约 §10 已由主代理回写，含迁移前置纪律） | 本文档已完成反转修订：§3.2 签名收窄、§4 步骤 5 迁移门四结论、§5 依赖删除、§10.1 D1/D2 降级消除、§11.1.5 反转记录（实测数据全保留）、§11.3 验收 2/6 更新；R3-C4（SqliteDatabaseFactory 上移）维持原裁决不变 |

---

## 13. 仍未知待拍板

1. **hosted 剖面 sqlite 装载形态**：宿主注入 node:sqlite 工厂（能力等价 node，推荐默认）还是宿主 webview 内直接用 browser 工厂（同 sqlite3.wasm）？两者接口已同形，属组装点决策，建议 hosted 默认 = 宿主声明（与 10-A hosted 申报机制对齐）。
2. ~~是否接受「逐位一致」premium~~ **已闭案（2026-09-30 拍板）**：统一 Segmenter 以零成本达成逐位一致，jieba-wasm32-wasi 候选随 jieba 一起出局。
3. **opfs-sahpool 的单连接串行是否够用**：memory 单例 store（agent-session.ts:235 map 单例）+ 单 tab 假写下够；若未来浏览器多 tab 共库（需 Web Locks 协调层）——属 StoreB 锁策略延伸，本模块不扩。
4. ~~`fts_tokenizer` 标记是否升 SCHEMA_VERSION~~ **已闭案（拍板迁移设计结论一）**：仅键检测，v4 不动——DDL 零变化 + 复用既有 heal 机制 + 键值比对覆盖未来变更（§4 步骤 5）。
5. **Intl.Segmenter 浏览器支持下限**（Chrome 87+/Safari 14.1+，[公开文档知识]，未在仓内核实下游支持矩阵）：拍板后无兜底链，更老内核直接明确报错——若下游产品要求兼容更老浏览器，需产品侧重开拍板（代价 = 重新引入第二 token 空间，破坏本次拍板的逐位一致）。
6. **大库迁移门首开卡顿**：§4 步骤 5 结论四估算 [推断] 万级节点 ≈ 10s 量级同步重建——若真实用户库实测超预期，再议异步重建（需新状态机，本次不做）。
