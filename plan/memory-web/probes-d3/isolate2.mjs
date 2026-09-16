import { openDatabase } from "/home/yoshix7ti/projects/pi-rp/packages/memory/src/driver.ts";
import { MemoryStore } from "/home/yoshix7ti/projects/pi-rp/packages/memory/src/store.ts";
import { tokenizeForSearch } from "/home/yoshix7ti/projects/pi-rp/packages/memory/src/tokenize.ts";
import { copyFileSync } from "node:fs";
copyFileSync("/home/yoshix7ti/world/magnolia/elias/.pi/memory.db","/tmp/d3probe/iso2.db");
const db = await openDatabase("/tmp/d3probe/iso2.db");
const store = new MemoryStore(db);
const oldRows = db.prepare("SELECT node_id, text FROM node_fts").all();
const fresh = new Map();
for (const r of oldRows) { const n = store.getNode(r.node_id); if (n) fresh.set(r.node_id, tokenizeForSearch([n.uri, n.disclosure ?? "", n.content].join(" "))); }

db.exec("CREATE VIRTUAL TABLE old_f USING fts5(node_id UNINDEXED, text, tokenize='unicode61')");
db.exec("CREATE VIRTUAL TABLE new_f USING fts5(node_id UNINDEXED, text, tokenize='unicode61')");
for (const r of oldRows) { db.prepare("INSERT INTO old_f(node_id,text) VALUES(?,?)").run(r.node_id, r.text); db.prepare("INSERT INTO new_f(node_id,text) VALUES(?,?)").run(r.node_id, fresh.get(r.node_id)); }

// faithful searchNodeFts semantics: OR of tokenizeForSearch tokens, match against `text` column only
const matchOf = (q) => tokenizeForSearch(q).split(/\s+/).filter(Boolean).map(t=>`"${t.replace(/"/g,'""')}"`).join(" OR ");
const kw = db.prepare("SELECT keyword FROM glossary").all().map(g=>g.keyword).filter(k=>k.length>0);
function top(t,q,n=10){ let toks=tokenizeForSearch(q).split(/\s+/).filter(Boolean); const extra=kw.filter(k=>q.includes(k)); if(extra.length) toks=[...toks,...extra]; if(!toks.length) return []; const m=toks.map(x=>`"${x.replace(/"/g,'""')}"`).join(" OR ");
  return db.prepare(`SELECT node_id, bm25(${t}, 0.0, 1.0) bm FROM ${t} WHERE ${t} MATCH ? ORDER BY bm LIMIT ?`).all(m,n).map(r=>r.node_id); }
const QS=["明瑞","小埃同学","实验室","关系","记忆","first_move","周明瑞","朋友","协议","家","明月","记忆设计","小苍兰"];
let diff=0;
for(const q of QS){const a=top("old_f",q),b=top("new_f",q); if(JSON.stringify(a)!==JSON.stringify(b)){diff++; console.log(`DIFF q=${q}\n  old(${a.length}): ${a.slice(0,4).join(",")}\n  new(${b.length}): ${b.slice(0,4).join(",")}`);}}
console.log(`\nTEXT-ONLY drift (identical columns+weights, OR-token semantics): top-10 order changes in ${diff}/${QS.length}`);
db.close();
