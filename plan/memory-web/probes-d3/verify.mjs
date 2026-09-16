// probes-d3/verify.mjs — 23-迁移.md 的三个核心门槛的可复跑证据（门槛 2 逐条不变 / 门槛 3 幂等 / 门槛 4 回滚）
//
// 用法：
//   node probes-d3/verify.mjs
// 前置：
//   真库副本。/tmp/d3probe/elias-mig.db 缺失时从真库生成（脚本会自动生成）：
//     sqlite3 "/home/yoshix7ti/world/magnolia/elias/.pi/memory.db" \
//       "PRAGMA wal_checkpoint(TRUNCATE); VACUUM INTO '/tmp/d3probe/elias-mig.db';"
//   fixture：node probes-d3/fixture-v2.mjs  -> /tmp/d3probe/fixture-v2.db
//
// 每段都打印 PASS/FAIL，并给出 exit code（非 0 = 有段失败）。
// ⚠️ 迁移器在此脚本内联实现（源码尚未落地）——它与 23-迁移.md §3 步 3/5 逐字对应。
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { openDatabase } from "/home/yoshix7ti/projects/pi-rp/packages/memory/src/driver.ts";
import { createSchema } from "/home/yoshix7ti/projects/pi-rp/packages/memory/src/schema.ts";
import { MemoryStore } from "/home/yoshix7ti/projects/pi-rp/packages/memory/src/store.ts";

const WORK = "/tmp/d3probe";
mkdirSync(WORK, { recursive: true });
const ELIAS = "/home/yoshix7ti/world/magnolia/elias/.pi/memory.db";
const ELIAS_COPY = `${WORK}/elias-mig.db`;
const FIXTURE = `${WORK}/fixture-v2.db`;
const TARGET = "3";                                   // 模拟 bump 后的 SCHEMA_VERSION
const NODE_FTS_DDL =
  "CREATE VIRTUAL TABLE IF NOT EXISTS node_fts USING fts5(node_id UNINDEXED, text, disclosure, tokenize='unicode61')";
const KEY = "fts_rebuild_pending";
const hasCol = (db, t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some((r) => r.name === c);
const kvGet = (db, k) => { const r = db.prepare("SELECT value FROM memory_kv WHERE key=?").get(k); return r ? r.value : null; };

// ── 迁移器（与 23-迁移.md §3 步 3/5 一致；列存在性判据 + 单事务 + marker）─────────
function migrate(db) {
  const stored = kvGet(db, "schema_version"), marker = kvGet(db, KEY);
  const nA = !hasCol(db, "aliases", "disclosure"), nE = !hasCol(db, "edges", "disclosure"), nF = !hasCol(db, "node_fts", "disclosure");
  const structural = (stored !== null && stored !== TARGET) || nA || nE || nF;
  if (!structural && !marker) return { migratedFrom: null, rebuild: false };
  db.transaction(() => {
    if (nA) db.exec("ALTER TABLE aliases ADD COLUMN disclosure TEXT");
    if (nE) db.exec("ALTER TABLE edges ADD COLUMN disclosure TEXT");
    if (nF) { db.exec("DROP TABLE IF EXISTS node_fts"); db.exec(NODE_FTS_DDL); }
    if (stored !== TARGET) {
      db.prepare("INSERT OR REPLACE INTO memory_kv (key,value,updated_at) VALUES (?,?,?)").run("schema_version", TARGET, new Date().toISOString());
      db.prepare("INSERT OR REPLACE INTO memory_kv (key,value,updated_at) VALUES (?,?,?)").run(KEY, "1", new Date().toISOString());
    }
  });
  return { migratedFrom: stored, rebuild: nF || marker !== null || stored !== TARGET };
}
function heal(db, store) {                                // = MemoryStore._healPendingFtsRebuild（§2.2）
  if (kvGet(db, KEY) === null) return 0;
  const rows = db.prepare("SELECT node_id FROM nodes WHERE is_stub = 0").all();
  db.transaction(() => { for (const r of rows) store.reindexNode(r.node_id); });
  db.prepare("DELETE FROM memory_kv WHERE key=?").run(KEY);
  return rows.length;
}
function backup(db, from) {                               // = backupBeforeMigration（§3 步 4）
  const file = db.prepare("PRAGMA database_list").all().find((r) => r.name === "main")?.file;
  if (!file) return { skipped: "in-memory" };
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
  let target = `${file}.pre-v${from}-${stamp}.bak`;
  // ⚠️ stamp 只到秒 ⇒ 同一秒内重跑会撞名，`VACUUM INTO` 抛 "output file already exists"。
  //    生产实现 MUST 处理这个碰撞（见 23-迁移.md §11-C10）；此处脚本加 -N 后缀保证可重跑。
  for (let i = 2; existsSync(target); i++) target = `${file}.pre-v${from}-${stamp}-${i}.bak`;
  try { db.prepare("VACUUM INTO ?").run(target); return { path: target }; }
  catch (e) { return { skipped: e.message }; }
}

const results = [];
const check = (name, cond, detail = "") => { results.push({ name, ok: !!cond, detail }); console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };

// ══ 门槛 2：真库副本上逐条不变 ══════════════════════════════════════════════════
async function threshold2() {
  console.log("\n=== 门槛 2：真库副本迁移，行数与 disclosure 值逐条不变 ===");
  if (!existsSync(ELIAS_COPY)) {                          // 用 VACUUM INTO 生成（含 WAL），不用裸 cp
    const { DatabaseSync } = await import("node:sqlite");
    const src = new DatabaseSync(ELIAS, { readOnly: true });
    src.exec(`VACUUM INTO '${ELIAS_COPY}'`); src.close();
  }
  const db = await openDatabase(ELIAS_COPY);
  const NODES = "SELECT node_id,uri,content,disclosure,importance,updated_ts FROM nodes ORDER BY node_id";
  const ALIAS = "SELECT alias_uri,target_node_id FROM aliases ORDER BY alias_uri";
  const EDGES = "SELECT node_id,target_uri,kind FROM edges ORDER BY node_id,target_uri";
  const RAW = "SELECT COUNT(*) c FROM raw_log"; const AUD = "SELECT COUNT(*) c FROM audit_log";
  const before = { nodes: db.prepare(NODES).all(), alias: db.prepare(ALIAS).all(), edges: db.prepare(EDGES).all(),
                   raw: db.prepare(RAW).get().c, aud: db.prepare(AUD).get().c, fts: db.prepare("SELECT COUNT(*) c FROM node_fts").get().c };
  const r = migrate(db);                                   // ⭐ 有迁移：有事务与 DDL
  const store = new MemoryStore(db);
  if (r.rebuild) heal(db, store);
  const after = { nodes: db.prepare(NODES).all(), alias: db.prepare(ALIAS).all(), edges: db.prepare(EDGES).all(),
                  raw: db.prepare(RAW).get().c, aud: db.prepare(AUD).get().c, fts: db.prepare("SELECT COUNT(*) c FROM node_fts").get().c };
  check("nodes 逐行不变（含 disclosure/importance/updated_ts）", JSON.stringify(before.nodes) === JSON.stringify(after.nodes), `${before.nodes.length} 行`);
  check("aliases 逐行不变", JSON.stringify(before.alias) === JSON.stringify(after.alias), `${before.alias.length} 行`);
  check("edges 逐行不变", JSON.stringify(before.edges) === JSON.stringify(after.edges), `${before.edges.length} 行`);
  check("raw_log / audit_log 行数不变（迁移不触碰）", before.raw === after.raw && before.aud === after.aud, `raw ${before.raw}→${after.raw}, audit ${before.aud}→${after.aud}`);
  check("node_fts 行数 = 迁移前（全量重建后）", before.fts === after.fts, `${before.fts}→${after.fts}`);
  check("node_fts 三列", hasCol(db, "node_fts", "disclosure"));
  check("aliases/edges 三/四列", hasCol(db, "aliases", "disclosure") && hasCol(db, "edges", "disclosure"));
  check("存量 nodes.disclosure 非空数不变", before.nodes.filter((n) => n.disclosure !== null).length === after.nodes.filter((n) => n.disclosure !== null).length,
        `${before.nodes.filter((n) => n.disclosure !== null).length} 条`);
  check("存量 aliases.disclosure 全 NULL（= 继承节点级）", db.prepare("SELECT COUNT(*) c FROM aliases WHERE disclosure IS NOT NULL").get().c === 0);
  db.close();
}

// ══ 门槛 3：幂等 ══════════════════════════════════════════════════════════════
async function threshold3() {
  console.log("\n=== 门槛 3：迁移跑两遍结果一致 ===");
  if (!existsSync(FIXTURE)) { console.log("SKIP  先跑 node probes-d3/fixture-v2.mjs"); return; }
  const p = `${WORK}/idem.db`; copyFileSync(FIXTURE, p);
  const db = await openDatabase(p);
  const r1 = migrate(db); const s1 = new MemoryStore(db); if (r1.rebuild) heal(db, s1);
  const f1 = db.prepare("SELECT COUNT(*) c FROM node_fts").get().c;
  const r2 = migrate(db); const f2 = db.prepare("SELECT COUNT(*) c FROM node_fts").get().c;
  const n1 = db.prepare("SELECT node_id,uri,content,disclosure FROM nodes ORDER BY node_id").all();
  const r3 = migrate(db); const n2 = db.prepare("SELECT node_id,uri,content,disclosure FROM nodes ORDER BY node_id").all();
  check("第二遍 migratedFrom === null", r2.migratedFrom === null);
  check("第二遍 rebuild === false", r2.rebuild === false);
  check("FTS 行数两遍相等", f1 === f2, `${f1} / ${f2}`);
  check("第三遍后 nodes 逐行不变", JSON.stringify(n1) === JSON.stringify(n2));
  // 污染库：版本号回退成 '2' 但结构已三列 -> 列判据必须收口而非崩
  db.prepare("INSERT OR REPLACE INTO memory_kv (key,value,updated_at) VALUES (?,?,?)").run("schema_version", "2", "now");
  let pollutedOk = true, msg = "";
  try { migrate(db); } catch (e) { pollutedOk = false; msg = e.message; }
  check("版本号污染（结构已 v3）下迁移器不崩", pollutedOk, msg);
  db.close();
}

// ══ 门槛 4：回滚 ══════════════════════════════════════════════════════════════
async function threshold4() {
  console.log("\n=== 门槛 4：迁移失败可恢复 ===");
  if (!existsSync(FIXTURE)) { console.log("SKIP  先跑 node probes-d3/fixture-v2.mjs"); return; }
  // (a) 事务内失败 -> 自动 ROLLBACK，库回到 v2 原状（结构 + 行数据）
  const p = `${WORK}/rollback.db`; copyFileSync(FIXTURE, p);
  const db = await openDatabase(p);
  const nodesBefore = db.prepare("SELECT COUNT(*) c FROM nodes").get().c;
  const colsBefore = db.prepare("PRAGMA table_info(node_fts)").all().map((r) => r.name).join(",");
  let threw = false, emsg = "";
  try {
    db.transaction(() => {
      db.exec("ALTER TABLE aliases ADD COLUMN disclosure TEXT");
      db.exec("DROP TABLE IF EXISTS node_fts");
      db.exec(NODE_FTS_DDL);
      db.prepare("INSERT OR REPLACE INTO memory_kv (key,value,updated_at) VALUES (?,?,?)").run(KEY, "1", "now");
      throw new Error("simulated mid-migration failure");   // ← 模拟迁移中途失败
    });
  } catch (e) { threw = true; emsg = e.message; }
  const colsAfter = db.prepare("PRAGMA table_info(node_fts)").all().map((r) => r.name).join(",");
  check("事务内抛错 -> 整体回滚（含 DDL）", threw && colsAfter === colsBefore && db.prepare("SELECT COUNT(*) c FROM nodes").get().c === nodesBefore,
        `cols ${colsBefore}→${colsAfter}, nodes ${nodesBefore}→${db.prepare("SELECT COUNT(*) c FROM nodes").get().c}`);
  check("回滚后 marker 不存在", kvGet(db, KEY) === null);
  db.close();

  // (b) 备份文件可恢复：VACUUM INTO 的副本 == 迁移前的库
  const q = `${WORK}/backup.db`; copyFileSync(FIXTURE, q);
  const db2 = await openDatabase(q);
  const pre = { v: kvGet(db2, "schema_version"), fts: db2.prepare("PRAGMA table_info(node_fts)").all().map((r) => r.name).join(","),
                n: db2.prepare("SELECT COUNT(*) c FROM nodes").get().c, f: db2.prepare("SELECT COUNT(*) c FROM node_fts").get().c };
  const b = backup(db2, pre.v);
  migrate(db2); const s = new MemoryStore(db2); heal(db2, s);
  const post = { v: kvGet(db2, "schema_version"), f: db2.prepare("SELECT COUNT(*) c FROM node_fts").get().c };
  check("迁移确实改变了库（版本号 + FTS 列）", post.v === "3" && hasCol(db2, "node_fts", "disclosure"), `v2→${post.v}`);
  db2.close();
  if ("path" in b) {
    const db3 = await openDatabase(b.path);
    const rb = { v: kvGet(db3, "schema_version"), fts: db3.prepare("PRAGMA table_info(node_fts)").all().map((r) => r.name).join(","),
                 n: db3.prepare("SELECT COUNT(*) c FROM nodes").get().c, f: db3.prepare("SELECT COUNT(*) c FROM node_fts").get().c };
    check("备份 == 迁移前状态（可完整回滚）", rb.v === pre.v && rb.fts === pre.fts && rb.n === pre.n && rb.f === pre.f,
          `备份 ${statSync(b.path).size}B: v${rb.v} fts[${rb.fts}] n=${rb.n} f=${rb.f}`);
    db3.close();
  } else {
    check("备份已生成", false, b.skipped);
  }
}

await threshold2();
await threshold3();
await threshold4();
const failed = results.filter((r) => !r.ok);
console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
if (failed.length) { console.log("FAILED: " + failed.map((f) => f.name).join(" | ")); process.exit(1); }
