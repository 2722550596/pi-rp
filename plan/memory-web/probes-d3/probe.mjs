import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, statSync } from "node:fs";

copyFileSync("/home/yoshix7ti/world/magnolia/elias/.pi/memory.db", "elias2.db");
const db = new DatabaseSync("elias2.db");
db.exec("PRAGMA journal_mode = WAL");
const q = (s, ...p) => db.prepare(s).all(...p);
const one = (s, ...p) => db.prepare(s).get(...p);

console.log("before version:", one("SELECT value FROM memory_kv WHERE key='schema_version'"));
console.log("before counts:", one("SELECT (SELECT COUNT(*) FROM nodes) nodes,(SELECT COUNT(*) FROM node_fts) fts,(SELECT COUNT(*) FROM aliases) al,(SELECT COUNT(*) FROM edges) ed"));
console.log("shadow tables before:", q("SELECT name FROM sqlite_master WHERE name LIKE 'node_fts%'").map(r=>r.name));
console.log("fts cols before:", q("PRAGMA table_info(node_fts)").map(r=>r.name));

// backup via VACUUM INTO
db.exec("VACUUM INTO 'elias2.v2.bak.db'");
console.log("backup written:", existsSync("elias2.v2.bak.db"), statSync("elias2.v2.bak.db").size);

// migration tx
db.exec("BEGIN IMMEDIATE");
db.exec("ALTER TABLE aliases ADD COLUMN disclosure TEXT");
db.exec("ALTER TABLE edges ADD COLUMN disclosure TEXT");
db.exec("DROP TABLE node_fts");
db.exec("CREATE VIRTUAL TABLE node_fts USING fts5(node_id UNINDEXED, text, disclosure, tokenize='unicode61')");
db.prepare("INSERT OR REPLACE INTO memory_kv (key,value,updated_at) VALUES (?,?,?)").run("fts_rebuild_pending","1",new Date().toISOString());
db.prepare("INSERT OR REPLACE INTO memory_kv (key,value,updated_at) VALUES (?,?,?)").run("schema_version","3",new Date().toISOString());
db.exec("COMMIT");

console.log("shadow tables after:", q("SELECT name FROM sqlite_master WHERE name LIKE 'node_fts%'").map(r=>r.name));
console.log("fts cols after:", q("PRAGMA table_info(node_fts)").map(r=>r.name));
console.log("after counts:", one("SELECT (SELECT COUNT(*) FROM nodes) nodes,(SELECT COUNT(*) FROM node_fts) fts,(SELECT COUNT(*) FROM aliases) al,(SELECT COUNT(*) FROM edges) ed"));
console.log("after version:", one("SELECT value FROM memory_kv WHERE key='schema_version'"));
console.log("alias cols:", q("PRAGMA table_info(aliases)").map(r=>r.name));
console.log("edges cols:", q("PRAGMA table_info(edges)").map(r=>r.name));
console.log("nodes.disclosure unchanged:", one("SELECT COUNT(*) c FROM nodes WHERE disclosure IS NOT NULL AND disclosure<>''"));
console.log("aliases all null disclosure:", one("SELECT COUNT(*) c FROM aliases WHERE disclosure IS NULL"));

// idempotency re-run: version now 3 -> guard by table_info
console.log("re-run fts guard:", q("PRAGMA table_info(node_fts)").some(r=>r.name==='disclosure'));
db.exec("BEGIN IMMEDIATE");
db.exec("DROP TABLE IF EXISTS node_fts");
db.exec("CREATE VIRTUAL TABLE node_fts USING fts5(node_id UNINDEXED, text, disclosure, tokenize='unicode61')");
db.exec("COMMIT");
console.log("empty fts:", one("SELECT COUNT(*) c FROM node_fts"));
db.close();

// backup integrity: open backup read-only
const b = new DatabaseSync("elias2.v2.bak.db", { readOnly: true });
console.log("backup version:", b.prepare("SELECT value FROM memory_kv WHERE key='schema_version'").get());
console.log("backup fts cols:", b.prepare("PRAGMA table_info(node_fts)").all().map(r=>r.name));
console.log("backup counts:", b.prepare("SELECT (SELECT COUNT(*) FROM nodes) n,(SELECT COUNT(*) FROM node_fts) f").get());
b.close();
