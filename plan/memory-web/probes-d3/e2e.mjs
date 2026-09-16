// D3 end-to-end: fixture-v2.db -> migrate -> assert §10.6 T-1,T-2,T-3 (+ match works).
// NOTE: source is NOT bumped yet, so TARGET="3" simulates the post-bump SCHEMA_VERSION.
import { copyFileSync, rmSync } from "node:fs";
import { openDatabase } from "/home/yoshix7ti/projects/pi-rp/packages/memory/src/driver.ts";
import { MemoryStore } from "/home/yoshix7ti/projects/pi-rp/packages/memory/src/store.ts";

const TARGET = "3";
const DDL = "CREATE VIRTUAL TABLE IF NOT EXISTS node_fts USING fts5(node_id UNINDEXED, text, disclosure, tokenize='unicode61')";
const KEY = "fts_rebuild_pending";
const hasCol = (db,t,c)=>db.prepare(`PRAGMA table_info(${t})`).all().some(r=>r.name===c);
const kvGet = (db,k)=>{ const r=db.prepare("SELECT value FROM memory_kv WHERE key=?").get(k); return r?r.value:null; };

function migrate(db){
  const stored = kvGet(db,"schema_version"), marker = kvGet(db,KEY);
  const nA=!hasCol(db,"aliases","disclosure"), nE=!hasCol(db,"edges","disclosure"), nF=!hasCol(db,"node_fts","disclosure");
  const structural = (stored!==null && stored!==TARGET) || nA || nE || nF;
  if(!structural && !marker) return { migratedFrom:null, rebuild:false };
  db.transaction(()=>{
    if(nA) db.exec("ALTER TABLE aliases ADD COLUMN disclosure TEXT");
    if(nE) db.exec("ALTER TABLE edges ADD COLUMN disclosure TEXT");
    if(nF){ db.exec("DROP TABLE IF EXISTS node_fts"); db.exec(DDL); }
    if(stored!==TARGET){
      db.prepare("INSERT OR REPLACE INTO memory_kv (key,value,updated_at) VALUES (?,?,?)").run("schema_version",TARGET,new Date().toISOString());
      db.prepare("INSERT OR REPLACE INTO memory_kv (key,value,updated_at) VALUES (?,?,?)").run(KEY,"1",new Date().toISOString());
    }
  });
  return { migratedFrom: stored, rebuild: nF || marker!==null || stored!==TARGET };
}
function heal(db,store){ if(kvGet(db,KEY)===null) return 0;
  const rows=db.prepare("SELECT node_id FROM nodes WHERE is_stub=0").all();
  db.transaction(()=>{ for(const r of rows) store.reindexNode(r.node_id); });
  db.prepare("DELETE FROM memory_kv WHERE key=?").run(KEY); return rows.length; }

rmSync("/tmp/d3probe/e2e.db",{force:true}); copyFileSync("/tmp/d3probe/fixture-v2.db","/tmp/d3probe/e2e.db");
const db = await openDatabase("/tmp/d3probe/e2e.db");
const NODES = "SELECT node_id,uri,content,disclosure FROM nodes ORDER BY node_id";
const ALIAS = "SELECT alias_uri,target_node_id FROM aliases ORDER BY alias_uri";
const before = db.prepare(NODES).all(), abefore = db.prepare(ALIAS).all();
const r1 = migrate(db); const s = new MemoryStore(db); const n = r1.rebuild ? heal(db,s) : 0;
const fails=[];
if(!hasCol(db,"node_fts","disclosure")) fails.push("T-1 cols");
const ftsCount = db.prepare("SELECT COUNT(*) c FROM node_fts").get().c;
if(ftsCount===0) fails.push("T-1 empty");
if(kvGet(db,"schema_version")!==TARGET) fails.push("T-2 version");
if(JSON.stringify(before)!==JSON.stringify(db.prepare(NODES).all())) fails.push("T-2 nodes");
if(JSON.stringify(abefore)!==JSON.stringify(db.prepare(ALIAS).all())) fails.push("T-2 aliases");
const r2 = migrate(db);
if(r2.migratedFrom!==null||r2.rebuild) fails.push("T-3 not idempotent");
if(db.prepare("SELECT COUNT(*) c FROM node_fts").get().c!==ftsCount) fails.push("T-3 fts count");
// Weights are the frozen contract pair `bm25(node_fts, 0.0, 1.0, 1.0)` (D2 §3.2).
const hits = db.prepare("SELECT node_id FROM node_fts WHERE node_fts MATCH ? ORDER BY bm25(node_fts,0.0,1.0,1.0)").all('"alpha"');
if(hits.length===0) fails.push("MATCH alpha empty (reindex did not run)");
if(kvGet(db,KEY)!==null) fails.push("marker not cleared");
const al = db.prepare("SELECT disclosure FROM aliases WHERE alias_uri='diary://b_entry'").get();
if(al.disclosure!==null) fails.push("stored alias disclosure should be NULL (inherit)");
if(db.prepare("SELECT COUNT(*) c FROM edges WHERE disclosure IS NOT NULL").get().c!==0) fails.push("edge disclosure should be NULL");
console.log("migrate#1:",r1,"| reindexed:",n);
console.log("migrate#2:",r2);
console.log("fts rows:",ftsCount,"| fts cols:",db.prepare("PRAGMA table_info(node_fts)").all().map(r=>r.name).join(","));
console.log("MATCH 'alpha' hits:",hits.length,"| marker cleared:",kvGet(db,KEY)===null);
console.log("nodes:",JSON.stringify(db.prepare(NODES).all().map(r=>[r.uri,r.disclosure])));
console.log("aliases:",JSON.stringify(db.prepare("SELECT alias_uri,disclosure FROM aliases").all()));
console.log(fails.length===0 ? "ALL ASSERTIONS PASS" : "FAILURES: "+fails.join("; "));
db.close();
