import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(":memory:");
db.exec("CREATE VIRTUAL TABLE f USING fts5(node_id UNINDEXED, text, tokenize='unicode61')");
db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS f USING fts5(node_id UNINDEXED, text, disclosure, tokenize='unicode61')");
console.log("IF NOT EXISTS differing DDL -> cols:", db.prepare("PRAGMA table_info(f)").all().map(r=>r.name));
// ⚠️ SQLite 的 FTS5 虚表**不能建索引**：`CREATE INDEX ... ON <vtable>` 抛
//    "virtual tables may not be indexed"。本探针演示的是这类「看起来该能跑、实际直接报错」
//    的边界；这一条是**预期失败**，故捕获后不 rethrow（否则整个脚本 exit 1，复核者会误以为探针坏了）。
try { db.exec("CREATE INDEX IF NOT EXISTS ix ON f(node_id)"); console.log("index on fts: ok (unexpected)"); }
catch (e) { console.log("index on fts ->", e.message, "（预期：虚表不可索引）"); }
db.close();
