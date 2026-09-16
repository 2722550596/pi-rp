import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync("v2fix.db");
db.exec("CREATE TABLE IF NOT EXISTS memory_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT)");
// emulate full current v2 schema by invoking the real createSchema
import { createSchema, SCHEMA_VERSION } from "/home/yoshix7ti/projects/pi-rp/packages/memory/src/schema.ts";
createSchema(db);
const rows = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, name").all();
let out = "";
for (const r of rows) { if (/^node_fts|^raw_fts/.test(r.name) && r.type !== "table") continue; out += r.sql.trim().replace(/,$/, "") + ";\n"; }
console.log(out);
console.log("-- version:", SCHEMA_VERSION, "| objs:", rows.length);
