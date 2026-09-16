import { openDatabase } from "/home/yoshix7ti/projects/pi-rp/packages/memory/src/driver.ts";
import { createSchema } from "/home/yoshix7ti/projects/pi-rp/packages/memory/src/schema.ts";
import { MemoryStore } from "/home/yoshix7ti/projects/pi-rp/packages/memory/src/store.ts";

// A v3-shaped db (as the new build will create it)
function ddlV3(db){ db.exec("CREATE TABLE memory_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT)"); db.exec("CREATE TABLE aliases (alias_uri TEXT PRIMARY KEY, target_node_id TEXT NOT NULL, disclosure TEXT)"); db.exec("CREATE TABLE edges (node_id TEXT NOT NULL, target_uri TEXT NOT NULL, kind TEXT, disclosure TEXT, PRIMARY KEY(node_id,target_uri))"); db.exec("CREATE VIRTUAL TABLE node_fts USING fts5(node_id UNINDEXED, text, tokenize='unicode61')"); db.exec("INSERT INTO memory_kv VALUES('schema_version','3','now')"); }

// Simulate: v3 store, then import() restores a v2 snapshot's kv verbatim
const db = await openDatabase(":memory:");
ddlV3(db);
db.prepare("INSERT OR REPLACE INTO memory_kv VALUES(?,?,?)").run("schema_version","2","now");
console.log("after polluted import: kv version =", db.prepare("SELECT value FROM memory_kv WHERE key='schema_version'").get().value);
console.log("aliases already has disclosure?", db.prepare("PRAGMA table_info(aliases)").all().some(r=>r.name==="disclosure"));

// Naive version-only migrator
try {
  db.transaction(()=>{ db.exec("ALTER TABLE aliases ADD COLUMN disclosure TEXT"); });
  console.log("naive version-only migrator: OK (unexpected)");
} catch(e){ console.log("NAIVE version-only migrator -> FAILS:", e.message); }

// Column-presence migrator (defensive)
try {
  const need = !db.prepare("PRAGMA table_info(aliases)").all().some(r=>r.name==="disclosure");
  db.transaction(()=>{ if (need) db.exec("ALTER TABLE aliases ADD COLUMN disclosure TEXT"); db.prepare("INSERT OR REPLACE INTO memory_kv VALUES(?,?,?)").run("schema_version","3","now"); });
  console.log("column-presence migrator: OK; kv now =", db.prepare("SELECT value FROM memory_kv WHERE key='schema_version'").get().value);
} catch(e){ console.log("column-presence migrator -> ", e.message); }
db.close();
