// D3 §10.0(A) — build a REAL v2 fixture via the current package source.
import { openDatabase } from "/home/yoshix7ti/projects/pi-rp/packages/memory/src/driver.ts";
import { createSchema, SCHEMA_VERSION } from "/home/yoshix7ti/projects/pi-rp/packages/memory/src/schema.ts";
import { MemoryStore } from "/home/yoshix7ti/projects/pi-rp/packages/memory/src/store.ts";
import { rmSync } from "node:fs";
rmSync("/tmp/d3probe/fixture-v2.db", { force: true });
const db = await openDatabase("/tmp/d3probe/fixture-v2.db");
createSchema(db);
const s = new MemoryStore(db);
s.seed();
const a = s.insertNode({ uri: "core://a", content: "alpha body", disclosure: "node-level A", source: "manual" });
const b = s.insertNode({ uri: "core://b", content: "beta body",  disclosure: "node-level B", source: "manual" });
s.addAlias("diary://b_entry", b.node_id);   // live alias
s.addAlias("core://a", b.node_id);          // dead alias (alias_uri == nodes.uri)
s.addEdge(a.node_id, "core://b", "related");
console.log("built with SCHEMA_VERSION =", SCHEMA_VERSION);
console.log("nodes:", db.prepare("SELECT COUNT(*) c FROM nodes").get().c,
            "fts:", db.prepare("SELECT COUNT(*) c FROM node_fts").get().c,
            "aliases:", db.prepare("SELECT COUNT(*) c FROM aliases").get().c,
            "edges:", db.prepare("SELECT COUNT(*) c FROM edges").get().c);
console.log("fts cols:", db.prepare("PRAGMA table_info(node_fts)").all().map(r=>r.name));
console.log("kv:", db.prepare("SELECT key,value FROM memory_kv").all());
db.close();
