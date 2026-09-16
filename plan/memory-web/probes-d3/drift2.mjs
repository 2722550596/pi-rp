import { openDatabase } from "/home/yoshix7ti/projects/pi-rp/packages/memory/src/driver.ts";
import { MemoryStore } from "/home/yoshix7ti/projects/pi-rp/packages/memory/src/store.ts";
import { tokenizeForSearch } from "/home/yoshix7ti/projects/pi-rp/packages/memory/src/tokenize.ts";
import { copyFileSync } from "node:fs";
copyFileSync("/home/yoshix7ti/world/magnolia/elias/.pi/memory.db","/tmp/d3probe/drift2.db");
const db = await openDatabase("/tmp/d3probe/drift2.db");
const store = new MemoryStore(db);
const rows = db.prepare("SELECT node_id, text FROM node_fts").all();
let diff=0,n=0; const stale=[];
for (const r of rows) {
  const node = store.getNode(r.node_id); if (!node) continue; n++;
  const keywords = store.db.prepare("SELECT keyword FROM glossary WHERE node_id = ?").all(r.node_id).map(x=>x.keyword);
  let fresh = tokenizeForSearch([node.uri, node.disclosure ?? "", node.content].join(" "));
  const extra = keywords.filter(k=>k.trim().length>0).join(" ");
  if (extra) fresh = `${fresh} ${extra}`;
  if (fresh !== r.text) { diff++; stale.push({uri:node.uri, ts:node.updated_ts}); }
}
console.log(`stored vs fresh (WITH glossary extras, faithful to reindexNode): ${diff}/${n} differ`);
for (const s of stale.slice(0,5)) console.log("  ", s.uri, s.ts);
db.close();
