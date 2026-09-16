import { openDatabase } from "/home/yoshix7ti/projects/pi-rp/packages/memory/src/driver.ts";
import { MemoryStore } from "/home/yoshix7ti/projects/pi-rp/packages/memory/src/store.ts";
import { tokenizeForSearch } from "/home/yoshix7ti/projects/pi-rp/packages/memory/src/tokenize.ts";
import { copyFileSync } from "node:fs";
copyFileSync("/home/yoshix7ti/world/magnolia/elias/.pi/memory.db","/tmp/d3probe/drift.db");
const db = await openDatabase("/tmp/d3probe/drift.db");
const store = new MemoryStore(db);
const rows = db.prepare("SELECT node_id, text FROM node_fts").all();
let diff = 0, total = 0;
for (const r of rows) {
  const node = store.getNode(r.node_id); if (!node) continue;
  total++;
  const fresh = tokenizeForSearch([node.uri, node.disclosure ?? "", node.content].join(" "));
  if (fresh !== r.text) { diff++; if (diff <= 2) console.log("DRIFT node", node.uri, "\n  stored:", JSON.stringify(r.text).slice(0,160), "\n  fresh :", JSON.stringify(fresh).slice(0,160)); }
}
console.log(`stored FTS text != freshly tokenized: ${diff}/${total} nodes`);
db.close();
