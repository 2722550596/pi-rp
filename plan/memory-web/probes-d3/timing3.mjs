import { openDatabase } from "/home/yoshix7ti/projects/pi-rp/packages/memory/src/driver.ts";
import { createSchema } from "/home/yoshix7ti/projects/pi-rp/packages/memory/src/schema.ts";
import { MemoryStore } from "/home/yoshix7ti/projects/pi-rp/packages/memory/src/store.ts";
import { copyFileSync, rmSync } from "node:fs";
const DDL="CREATE VIRTUAL TABLE IF NOT EXISTS node_fts USING fts5(node_id UNINDEXED, text, disclosure, tokenize='unicode61')";
// ⚠️ 可重复跑：上一轮的 big.db / warm.db 残留会让再次 createSchema + insertNode 撞
//    `nodes.uri` UNIQUE 约束（"constraint failed"）。每次都从干净文件开始。
for (const p of ["/tmp/d3probe/big.db", "/tmp/d3probe/warm.db", "/tmp/d3probe/big.db-wal", "/tmp/d3probe/warm.db-wal"]) rmSync(p, { force: true });
function reindexAll(store){ const rows=store.db.prepare("SELECT node_id FROM nodes WHERE is_stub=0").all(); const t=performance.now(); store.db.transaction(()=>{for(const r of rows) store.reindexNode(r.node_id);}); return {n:rows.length, ms:+(performance.now()-t).toFixed(1)}; }
// warm jieba
{ const db=await openDatabase(":memory:"); createSchema(db); const s=new MemoryStore(db); s.insertNode({uri:"x://y",content:"热身",source:"manual"}); db.close(); }
{ const db=await openDatabase("/tmp/d3probe/big.db"); createSchema(db); const s=new MemoryStore(db);
  const rows=[];
  for(let i=0;i<5000;i++) rows.push({uri:"core://bulk/"+i, content:"第"+i+"条记忆 内容 测试 检索 记忆系统 角色 关系 世界", disclosure:"当提到"+i+"时", source:"manual"});
  for(const r of rows) s.insertNode(r);
  db.exec("DROP TABLE node_fts"); db.exec(DDL);
  const r=reindexAll(s);
  console.log("5000 nodes: "+r.ms+"ms total, "+(r.ms/5000).toFixed(2)+"ms/node");
  db.close(); }
{ copyFileSync("/home/yoshix7ti/world/magnolia/elias/.pi/memory.db","/tmp/d3probe/warm.db");
  const db=await openDatabase("/tmp/d3probe/warm.db");
  db.exec("DROP TABLE node_fts"); db.exec(DDL);
  const s=new MemoryStore(db);
  console.log("elias warmed:", JSON.stringify(reindexAll(s)));
  db.close(); }
