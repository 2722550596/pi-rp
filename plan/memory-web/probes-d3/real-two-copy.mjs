// D3 acceptance: two real-db copies, side-by-side, SOURCE CHECKPOINTED FIRST.
//   copy A  -> left at v2 (untouched control)
//   copy B  -> migrated in place through the REAL createSchema + MemoryStore
// Asserts: v2 control is unchanged, B is v3 with data byte-identical, and A vs B
// differ ONLY in the schema shape + the FTS index (the point of the migration).
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "/home/yoshix7ti/projects/pi-rp/packages/memory/src/driver.ts";
import { createSchema, MIGRATABLE_FROM, SCHEMA_VERSION } from "/home/yoshix7ti/projects/pi-rp/packages/memory/src/schema.ts";
import { MemoryStore } from "/home/yoshix7ti/projects/pi-rp/packages/memory/src/store.ts";

const SRC = "/home/yoshix7ti/world/magnolia/elias/.pi/memory.db";
const WORK = "/tmp/d3-real";
rmSync(WORK, { recursive: true, force: true }); // re-runnable: prior copies gone
mkdirSync(WORK, { recursive: true });
const A = `${WORK}/copy-a-v2.db`;
const B = `${WORK}/copy-b-v3.db`;

// ── Checkpoint the SOURCE first, through a real connection (not the shell).
//    Order is load-bearing: checkpoint must happen BEFORE the copy.
{
  const src = new DatabaseSync(SRC);
  const row = src.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
  console.log("source wal_checkpoint(TRUNCATE):", JSON.stringify(row));
  src.exec(`VACUUM INTO '${A}'`);
  src.exec(`VACUUM INTO '${B}'`);
  src.close();
}
console.log("copies:", [A, B].map((p) => `${p} ${statSync(p).size}B`).join(" | "));
console.log("source -wal size now:", existsSync(`${SRC}-wal`) ? statSync(`${SRC}-wal`).size : "(none)");

const snap = (db) => ({
  schema: (db.prepare("SELECT value FROM memory_kv WHERE key='schema_version'").get() ?? {}).value ?? null,
  ftsCols: db.prepare("PRAGMA table_info(node_fts)").all().map((r) => r.name),
  aliasCols: db.prepare("PRAGMA table_info(aliases)").all().map((r) => r.name),
  edgeCols: db.prepare("PRAGMA table_info(edges)").all().map((r) => r.name),
  nodeCols: db.prepare("PRAGMA table_info(nodes)").all().map((r) => r.name),
  nodes: db.prepare("SELECT node_id,uri,content,disclosure,importance,updated_ts,content_hash FROM nodes ORDER BY node_id").all(),
  aliases: db.prepare("SELECT alias_uri,target_node_id FROM aliases ORDER BY alias_uri").all(),
  edges: db.prepare("SELECT node_id,target_uri,kind FROM edges ORDER BY node_id,target_uri").all(),
  rawCount: db.prepare("SELECT COUNT(*) c FROM raw_log").get().c,
  auditCount: db.prepare("SELECT COUNT(*) c FROM audit_log").get().c,
  revCount: db.prepare("SELECT COUNT(*) c FROM node_revisions").get().c,
  ftsCount: db.prepare("SELECT COUNT(*) c FROM node_fts").get().c,
  marker: (db.prepare("SELECT value FROM memory_kv WHERE key='fts_rebuild_pending'").get() ?? {}).value ?? null,
});

const fails = [];
const check = (name, ok, detail = "") => {
  if (!ok) fails.push(name);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

// ── Copy A: the untouched v2 control. Never opened writable.
const a2 = new DatabaseSync(A, { readOnly: true });
const beforeA = snap(a2);
a2.close();

// ── Copy B: migrate through the real code path.
const dbB = await openDatabase(B);
const beforeB = snap(dbB);
const result = createSchema(dbB);
const store = new MemoryStore(dbB); // constructor heals the pending rebuild
const afterB = snap(dbB);

console.log("\ncreateSchema ->", JSON.stringify(result));
check("B: migratedFrom === '2'", result.migratedFrom === "2");
check("B: backup written", !!(result.backup && "path" in result.backup), JSON.stringify(result.backup));

// The control must not have moved: it is a real on-disk file, and copying it
// out of the source cannot have migrated it.
const a2b = new DatabaseSync(A, { readOnly: true });
const afterA = snap(a2b);
a2b.close();
check("A (control) unchanged: still v2, two fts cols, marker absent",
  afterA.schema === "2" && afterA.ftsCols.join(",") === "node_id,text" && afterA.marker === null,
  `v${afterA.schema} fts[${afterA.ftsCols}]`);
check("A === snapshot taken before B was migrated (same file, no drift)",
  JSON.stringify(beforeA) === JSON.stringify(afterA));

// B: version + shape.
console.log(`\nB fts cols:      ${afterB.ftsCols.join(",")}`);
console.log(`B aliases cols:  ${afterB.aliasCols.join(",")}`);
console.log(`B edges cols:    ${afterB.edgeCols.join(",")}`);
console.log(`A fts cols:      ${afterA.ftsCols.join(",")}`);
console.log(`A aliases cols:  ${afterA.aliasCols.join(",")}`);
console.log(`A edges cols:    ${afterA.edgeCols.join(",")}`);
check("B: schema_version === SCHEMA_VERSION", afterB.schema === SCHEMA_VERSION, `${beforeB.schema} → ${afterB.schema}`);
check("B: node_fts three cols", afterB.ftsCols.join(",") === "node_id,text,disclosure");
check("B: aliases/edges gained disclosure", afterB.aliasCols.includes("disclosure") && afterB.edgeCols.includes("disclosure"));
check("B: marker cleared by the store constructor", afterB.marker === null);
check("B: nodes schema untouched (same columns as A)", JSON.stringify(afterB.nodeCols) === JSON.stringify(beforeA.nodeCols));

// B: data byte-identical to the v2 copy.
check("B: nodes 逐行不变 vs A（全列 JSON 快照）", JSON.stringify(afterB.nodes) === JSON.stringify(beforeA.nodes), `${beforeB.nodes.length} 行`);
check("B: aliases 逐行不变 vs A", JSON.stringify(afterB.aliases) === JSON.stringify(beforeA.aliases), `${beforeB.aliases.length} 行`);
check("B: edges 逐行不变 vs A", JSON.stringify(afterB.edges) === JSON.stringify(beforeA.edges), `${beforeB.edges.length} 行`);
check("B: raw_log / audit_log / node_revisions 计数不变",
  afterB.rawCount === beforeA.rawCount && afterB.auditCount === beforeA.auditCount && afterB.revCount === beforeA.revCount,
  `raw ${beforeA.rawCount}→${afterB.rawCount}, audit ${beforeA.auditCount}→${afterB.auditCount}, rev ${beforeA.revCount}→${afterB.revCount}`);
check("B: node_fts 行数 = A（全量重建）", afterB.ftsCount === beforeA.ftsCount, `${beforeA.ftsCount}→${afterB.ftsCount}`);
check("B: 存量 nodes.disclosure 非空数不变",
  beforeA.nodes.filter((n) => n.disclosure !== null).length === afterB.nodes.filter((n) => n.disclosure !== null).length,
  `${beforeA.nodes.filter((n) => n.disclosure !== null).length} 条`);
check("B: 存量 aliases.disclosure 全 NULL", afterB.aliases.length === 0 || dbB.prepare("SELECT COUNT(*) c FROM aliases WHERE disclosure IS NOT NULL").get().c === 0);
check("B: 存量 edges.disclosure 全 NULL", dbB.prepare("SELECT COUNT(*) c FROM edges WHERE disclosure IS NOT NULL").get().c === 0);
check("MIGRATABLE_FROM 含 '2'", MIGRATABLE_FROM.includes("2"));

// The rebuilt index is queryable through the production search path (jieba
// token space — a hand-written MATCH on raw text would miss it, since the
// indexed rows are jieba-segmented).
const hits = store.searchNodeFts(["核心"]);
check("B: searchNodeFts 在重建后的索引上命中", hits.size > 0, `${hits.size} 命中`);
dbB.close();
