import { openDatabase } from "/home/yoshix7ti/projects/pi-rp/packages/memory/src/driver.ts";
import { MemoryStore } from "/home/yoshix7ti/projects/pi-rp/packages/memory/src/store.ts";
import { tokenizeForSearch } from "/home/yoshix7ti/projects/pi-rp/packages/memory/src/tokenize.ts";
import { copyFileSync } from "node:fs";
copyFileSync("/home/yoshix7ti/world/magnolia/elias/.pi/memory.db","/tmp/d3probe/stale.db");
const db = await openDatabase("/tmp/d3probe/stale.db");
const store = new MemoryStore(db);
const rows = db.prepare("SELECT node_id, text FROM node_fts").all();
const stale=[]; const all=[];
for (const r of rows) {
  const n = store.getNode(r.node_id); if (!n) continue;
  const fresh = tokenizeForSearch([n.uri, n.disclosure ?? "", n.content].join(" "));
  all.push({uri:n.uri, ts:n.updated_ts, stale: fresh!==r.text});
  if (fresh!==r.text) stale.push({uri:n.uri, ts:n.updated_ts});
}
console.log("stale count:", stale.length, "/", all.length);
console.log("stale nodes updated_ts:", stale.map(s=>s.ts).sort());
console.log("non-stale updated_ts range:", all.filter(a=>!a.stale).map(a=>a.ts).sort()[0], "..", all.filter(a=>!a.stale).map(a=>a.ts).sort().slice(-1)[0]);
db.close();
