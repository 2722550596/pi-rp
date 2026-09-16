import { openDatabase } from "/home/yoshix7ti/projects/pi-rp/packages/memory/src/driver.ts";
import { createSchema } from "/home/yoshix7ti/projects/pi-rp/packages/memory/src/schema.ts";
import { MemoryStore } from "/home/yoshix7ti/projects/pi-rp/packages/memory/src/store.ts";

const db = await openDatabase(":memory:");
createSchema(db);
const store = new MemoryStore(db);
store.seed();
const n = store.insertNode({ uri: "core://a", content: "alpha", disclosure: "dA", source: "manual" });
store.addAlias("diary://x", n.node_id);
const snap = store.export();
console.log("kv in snapshot:", snap.kv);

// import into a fresh store
const db2 = await openDatabase(":memory:");
createSchema(db2);
const s2 = new MemoryStore(db2);
s2.import(snap);
console.log("after import kv schema_version:", s2.getKv("schema_version"));

// OLD snapshot (no `disclosure` field on aliases) into a NEW store
const oldSnap = JSON.parse(JSON.stringify(snap));
for (const a of oldSnap.aliases) delete a.disclosure;
for (const e of oldSnap.edges) delete e.disclosure;
console.log("old snap alias entry:", oldSnap.aliases[0]);
const db3 = await openDatabase(":memory:");
createSchema(db3);
const s3 = new MemoryStore(db3);
try { s3.import(oldSnap); console.log("old snapshot import: OK"); }
catch (e) { console.log("old snapshot import ->", e.message); }
db.close(); db2.close(); db3.close();
