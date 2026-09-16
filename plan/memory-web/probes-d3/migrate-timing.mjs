import { openDatabase } from "/home/yoshix7ti/projects/pi-rp/packages/memory/src/driver.ts";
import { createSchema } from "/home/yoshix7ti/projects/pi-rp/packages/memory/src/schema.ts";
import { MemoryStore } from "/home/yoshix7ti/projects/pi-rp/packages/memory/src/store.ts";
import { copyFileSync, rmSync, statSync } from "node:fs";

const NODE_FTS_DDL = "CREATE VIRTUAL TABLE IF NOT EXISTS node_fts USING fts5(node_id UNINDEXED, text, disclosure, tokenize='unicode61')";
const KEY = "fts_rebuild_pending";
const hasCol = (db, t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some((r) => r.name === c);

function migrate(db) {
  const version = (db.prepare("SELECT value FROM memory_kv WHERE key='schema_version'").get() || {}).value ?? null;
  const marker = (db.prepare("SELECT value FROM memory_kv WHERE key=?").get(KEY) || {}).value ?? null;
  const needAlias = !hasCol(db, "aliases", "disclosure"), needEdge = !hasCol(db, "edges", "disclosure"), needFts = !hasCol(db, "node_fts", "disclosure");
  const structural = (version !== null && version !== "3") || needAlias || needEdge || needFts;
  if (!structural && !marker) return { migrated: false, rebuild: false };
  db.transaction(() => {
    if (needAlias) db.exec("ALTER TABLE aliases ADD COLUMN disclosure TEXT");
    if (needEdge) db.exec("ALTER TABLE edges ADD COLUMN disclosure TEXT");
    if (needFts) { db.exec("DROP TABLE IF EXISTS node_fts"); db.exec(NODE_FTS_DDL); }
    if (version !== "3") {
      db.prepare("INSERT OR REPLACE INTO memory_kv (key,value,updated_at) VALUES (?,?,?)").run("schema_version", "3", new Date().toISOString());
      db.prepare("INSERT OR REPLACE INTO memory_kv (key,value,updated_at) VALUES (?,?,?)").run(KEY, "1", new Date().toISOString());
    }
  });
  return { migrated: true, rebuild: needFts || marker !== null || version !== "3" };
}
function reindexAll(store) {
  const rows = store.db.prepare("SELECT node_id FROM nodes WHERE is_stub = 0").all();
  const t = performance.now();
  store.db.transaction(() => { for (const r of rows) store.reindexNode(r.node_id); });
  return { n: rows.length, ms: +(performance.now() - t).toFixed(1) };
}

// ── timing on the elias real db (node count read at runtime; jieba tokenizer) ──
const T_DB = "/tmp/d3probe/elias-t.db";
const T_BAK = "/tmp/d3probe/elias-t.bak.db";
{
  // 清理上一轮产物：VACUUM INTO 拒绝已存在的目标文件（会抛 "output file already exists"），
  // 不清理则**脚本第二次跑就崩**。裸 cp 的源清理同理（copyFileSync 会覆盖，但残留的 -wal/-shm 会混淆）。
  for (const p of [T_DB, T_BAK, `${T_DB}-wal`, `${T_DB}-shm`, `${T_BAK}-wal`, `${T_BAK}-shm`]) rmSync(p, { force: true });
  copyFileSync("/home/yoshix7ti/world/magnolia/elias/.pi/memory.db", T_DB);
  const db = await openDatabase(T_DB);
  const t0 = performance.now();
  const r = migrate(db);
  const t1 = performance.now();
  const store = new MemoryStore(db);
  const rx = reindexAll(store);
  db.prepare("DELETE FROM memory_kv WHERE key=?").run(KEY);
  const t2 = performance.now();
  // 标签不写死节点数：真库会话期间会增长（120 → 125 → …），写死=输出撒谎。
  // 用 elias: 而非 elias(120): —— 这个数字对结论无意义（本段测的是耗时），索性不写。
  console.log(`elias: migrate DDL ${(t1-t0).toFixed(1)}ms | reindexAll ${rx.ms}ms (${rx.n} nodes) | total ${(t2-t0).toFixed(1)}ms`);
  const t3 = performance.now();                                  // backup timing
  db.prepare("VACUUM INTO ?").run(T_BAK);
  console.log(`VACUUM INTO backup: ${(performance.now()-t3).toFixed(1)}ms -> ${statSync(T_BAK).size} bytes`);
  db.close();
}

// ── crash recovery: v3 db + marker set + empty fts ──
{
  copyFileSync("/tmp/d3probe/elias-t.bak.db", "/tmp/d3probe/crash.db");
  const db = await openDatabase("/tmp/d3probe/crash.db");
  // simulate "DDL committed, reindex never ran, process died"
  db.transaction(() => {
    db.exec("DROP TABLE IF EXISTS node_fts");
    db.exec(NODE_FTS_DDL);
    db.prepare("INSERT OR REPLACE INTO memory_kv (key,value,updated_at) VALUES (?,?,?)").run(KEY, "1", new Date().toISOString());
  });
  console.log("simulated crash: fts rows =", db.prepare("SELECT COUNT(*) c FROM node_fts").get().c, "version =", db.prepare("SELECT value FROM memory_kv WHERE key='schema_version'").get().value);
  db.close();

  const db2 = await openDatabase("/tmp/d3probe/crash.db");
  const r = migrate(db2);
  const store = new MemoryStore(db2);
  let n = 0;
  if (r.rebuild) { n = reindexAll(store).n; db2.prepare("DELETE FROM memory_kv WHERE key=?").run(KEY); }
  console.log("recovery open: migrate =", r, "| reindexed", n, "| fts rows now =", db2.prepare("SELECT COUNT(*) c FROM node_fts").get().c, "| marker cleared =", db2.prepare("SELECT value FROM memory_kv WHERE key=?").get(KEY) === undefined);
  // third open: no rebuild
  const r3 = migrate(db2);
  console.log("next open (should be no-op):", r3);
  db2.close();
}
