import { openDatabase } from "/home/yoshix7ti/projects/pi-rp/packages/memory/src/driver.ts";
import { MemoryStore } from "/home/yoshix7ti/projects/pi-rp/packages/memory/src/store.ts";
import { tokenizeForSearch } from "/home/yoshix7ti/projects/pi-rp/packages/memory/src/tokenize.ts";
import { copyFileSync } from "node:fs";
copyFileSync("/home/yoshix7ti/world/magnolia/elias/.pi/memory.db","/tmp/d3probe/iso.db");
const db = await openDatabase("/tmp/d3probe/iso.db");
const store = new MemoryStore(db);
// old text
const oldRows = db.prepare("SELECT node_id, text FROM node_fts").all();
// fresh text
const fresh = new Map();
for (const r of oldRows) { const n = store.getNode(r.node_id); if (n) fresh.set(r.node_id, tokenizeForSearch([n.uri, n.disclosure ?? "", n.content].join(" "))); }
// scratch 2-col tables, identical DDL/weights -> isolates TEXT drift from WEIGHT change
db.exec("CREATE VIRTUAL TABLE old_f USING fts5(node_id UNINDEXED, text, tokenize='unicode61')");
db.exec("CREATE VIRTUAL TABLE new_f USING fts5(node_id UNINDEXED, text, tokenize='unicode61')");
for (const r of oldRows) { db.prepare("INSERT INTO old_f(node_id,text) VALUES(?,?)").run(r.node_id, r.text); db.prepare("INSERT INTO new_f(node_id,text) VALUES(?,?)").run(r.node_id, fresh.get(r.node_id)); }
const QS=["明瑞","小埃同学","实验室","关系","记忆","first_move","周明瑞","朋友","协议","家"];
const top=(t,q,n=8)=>{const m=`"${q}"`;return db.prepare(`SELECT node_id, bm25(${t}) bm FROM ${t} WHERE ${t} MATCH ? ORDER BY bm LIMIT ?`).all(m,n).map(r=>r.node_id);};
let driftQueries=0;
for(const q of QS){const a=top("old_f",q),b=top("new_f",q); if(JSON.stringify(a)!==JSON.stringify(b)){driftQueries++; console.log(`order DIFF q=${q}\n  old: ${a.join(",")}\n  new: ${b.join(",")}`);}}
console.log(`\nwith IDENTICAL weights+columns, text-only drift changes top-8 order in ${driftQueries}/${QS.length} queries`);
db.close();
