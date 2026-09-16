import { openDatabase } from "/home/yoshix7ti/projects/pi-rp/packages/memory/src/driver.ts";
import { createSchema } from "/home/yoshix7ti/projects/pi-rp/packages/memory/src/schema.ts";
import { MemoryStore } from "/home/yoshix7ti/projects/pi-rp/packages/memory/src/store.ts";
import { copyFileSync } from "node:fs";

const DDL = "CREATE VIRTUAL TABLE IF NOT EXISTS node_fts USING fts5(node_id UNINDEXED, text, disclosure, tokenize='unicode61')";
const hasCol = (db,t,c)=>db.prepare(`PRAGMA table_info(${t})`).all().some(r=>r.name===c);

const QUERIES = ["明瑞","小埃同学","实验室","关系","记忆","first_move","周明瑞","朋友","协议","家"];
async function searchTop(db, store, q, n=8) {
  return store.searchNodeFts([q]);
}
function ranked(map, n=8) {
  return [...map.entries()].sort((a,b)=>a[1]-b[1]).slice(0,n).map(([id,bm])=>`${id}:${bm.toFixed(6)}`);
}

// BEFORE: plain copy of the real db (v2 FTS present)
copyFileSync("/home/yoshix7ti/world/magnolia/elias/.pi/memory.db", "/tmp/d3probe/sort-v2.db");
const dbA = await openDatabase("/tmp/d3probe/sort-v2.db");
const sA = new MemoryStore(dbA);
const before = new Map();
for (const q of QUERIES) before.set(q, ranked(await searchTop(dbA, sA, q)));
dbA.close();

// MIGRATE
copyFileSync("/home/yoshix7ti/world/magnolia/elias/.pi/memory.db", "/tmp/d3probe/sort-v3.db");
const dbB = await openDatabase("/tmp/d3probe/sort-v3.db");
dbB.transaction(()=>{
  dbB.exec("ALTER TABLE aliases ADD COLUMN disclosure TEXT");
  dbB.exec("ALTER TABLE edges ADD COLUMN disclosure TEXT");
  dbB.exec("DROP TABLE IF EXISTS node_fts");
  dbB.exec(DDL);
});
const sB = new MemoryStore(dbB);
const ids = dbB.prepare("SELECT node_id FROM nodes WHERE is_stub=0").all();
dbB.transaction(()=>{ for (const r of ids) sB.reindexNode(r.node_id); });
const after = new Map();
for (const q of QUERIES) after.set(q, ranked(await searchTop(dbB, sB, q)));
dbB.close();

let same = true;
for (const q of QUERIES) {
  const a = before.get(q), b = after.get(q);
  if (JSON.stringify(a) !== JSON.stringify(b)) { same = false; console.log(`DIFF q=${q}\n  v2: ${a}\n  v3: ${b}`); }
}
console.log(same ? "TOP-N IDENTICAL across all 10 queries (FTS rebuild preserves ranking)" : "RANKING CHANGED (expected only if D2 changes bm25 weights)");
