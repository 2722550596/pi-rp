import { openDatabase } from "/home/yoshix7ti/projects/pi-rp/packages/memory/src/driver.ts";
import { MemoryStore } from "/home/yoshix7ti/projects/pi-rp/packages/memory/src/store.ts";
import { tokenizeForSearch } from "/home/yoshix7ti/projects/pi-rp/packages/memory/src/tokenize.ts";
import { copyFileSync } from "node:fs";
copyFileSync("/home/yoshix7ti/world/magnolia/elias/.pi/memory.db","/tmp/d3probe/isoA3.db");
const db = await openDatabase("/tmp/d3probe/isoA3.db");
const store = new MemoryStore(db);
const fresh = new Map();
for (const r of db.prepare("SELECT node_id FROM node_fts").all()) {
  const n = store.getNode(r.node_id); if (!n) continue;
  const kw = db.prepare("SELECT keyword FROM glossary WHERE node_id=?").all(r.node_id).map(x=>x.keyword).filter(k=>k.trim()).join(" ");
  fresh.set(r.node_id, tokenizeForSearch([n.uri, n.disclosure ?? "", n.content].join(" ")) + (kw?` ${kw}`:""));
}
db.exec("CREATE VIRTUAL TABLE f2  USING fts5(node_id UNINDEXED, text, tokenize='unicode61')");
db.exec("CREATE VIRTUAL TABLE f3e USING fts5(node_id UNINDEXED, text, disclosure, tokenize='unicode61')"); // disclosure EMPTY
db.exec("CREATE VIRTUAL TABLE f3f USING fts5(node_id UNINDEXED, text, disclosure, tokenize='unicode61')"); // disclosure FILLED
for (const [id,text] of fresh) {
  db.prepare("INSERT INTO f2(node_id,text) VALUES(?,?)").run(id,text);
  db.prepare("INSERT INTO f3e(node_id,text,disclosure) VALUES(?,?,?)").run(id,text,"");
  db.prepare("INSERT INTO f3f(node_id,text,disclosure) VALUES(?,?,?)").run(id,text,store.getNode(id).disclosure ?? "");
}
const kw = db.prepare("SELECT keyword FROM glossary").all().map(g=>g.keyword).filter(k=>k.length>0);
function ids(t,q,colspec,n=10){ let toks=tokenizeForSearch(q).split(/\s+/).filter(Boolean); const extra=kw.filter(k=>q.includes(k)); if(extra.length) toks=[...toks,...extra]; if(!toks.length) return []; const m=toks.map(x=>`"${x.replace(/"/g,'""')}"`).join(" OR ");
  return db.prepare(`SELECT node_id FROM ${t} WHERE ${t} MATCH ? ORDER BY bm25(${t}${colspec}) LIMIT ?`).all(m,n).map(r=>r.node_id); }
const QS=["明瑞","小埃同学","实验室","关系","记忆","first_move","周明瑞","朋友","协议","家","明月","记忆设计","小苍兰"];
let a=0,b=0;
for(const q of QS){ if(JSON.stringify(ids("f2",q,",0.0,1.0"))!==JSON.stringify(ids("f3e",q,",0.0,1.0,0.0"))) a++; }
for(const q of QS){ if(JSON.stringify(ids("f2",q,",0.0,1.0"))!==JSON.stringify(ids("f3f",q,",0.0,1.0,0.0"))) b++; }
console.log(`layout-only (3rd col present but EMPTY, weight 0): ${a}/13 order diffs`);
console.log(`layout + FILLED disclosure col (weight 0):        ${b}/13 order diffs`);
db.close();
