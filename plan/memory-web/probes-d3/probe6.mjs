import { DatabaseSync } from "node:sqlite";
const m = new DatabaseSync(":memory:");
try { console.log("pragma_database_list mem:", m.prepare("SELECT name, file FROM pragma_database_list").all()); } catch(e){ console.log("err", e.message); }
m.close();
const f = new DatabaseSync("p6.db");
try { console.log("pragma_database_list file:", f.prepare("SELECT name, file FROM pragma_database_list").all()); } catch(e){ console.log("err", e.message); }
f.exec("CREATE VIRTUAL TABLE x USING fts5(a UNINDEXED, b, tokenize='unicode61')");
console.log("shadow count:", f.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name LIKE 'x%'").get());
f.exec("DROP TABLE x");
console.log("after drop shadow:", f.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'x%'").all());
f.close();
