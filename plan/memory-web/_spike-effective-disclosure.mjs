// Spike：验证冻结契约 §3.1 的两分支伪码在三种场景下的行为
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(":memory:");
db.exec(`CREATE TABLE nodes(node_id TEXT PRIMARY KEY, uri TEXT UNIQUE, content TEXT, disclosure TEXT);
         CREATE TABLE aliases(alias_uri TEXT PRIMARY KEY, target_node_id TEXT, disclosure TEXT);`);
const put = (id,uri,c,d)=>db.prepare("INSERT INTO nodes VALUES(?,?,?,?)").run(id,uri,c,d);
put("A","mem://a","A 的内容","node-level A");
put("B","mem://b","B 的内容","node-level B");

// 冻结伪码
const byUri = db.prepare("SELECT disclosure FROM nodes WHERE uri = ?");
const byAlias = db.prepare("SELECT a.disclosure AS ad, n.disclosure AS nd FROM aliases a JOIN nodes n ON n.node_id=a.target_node_id WHERE a.alias_uri = ?");
function effectiveDisclosure(uri) {
  const direct = byUri.get(uri);
  if (direct) return direct.disclosure;              // ① nodes.uri 优先
  const al = byAlias.get(uri);
  if (al) return al.ad ?? al.nd;                      // ② 别名，?? 落节点级
  return null;
}
const resolveUri = (uri) => db.prepare("SELECT node_id, uri FROM nodes WHERE uri=?").get(uri)
  ?? (()=>{const a=db.prepare("SELECT target_node_id FROM aliases WHERE alias_uri=?").get(uri); return a?db.prepare("SELECT node_id, uri FROM nodes WHERE node_id=?").get(a.target_node_id):null;})();

console.log("=== 场景 1：正常别名（无撞名）===");
db.prepare("INSERT INTO aliases VALUES('entry://only','B','entry-level')").run();
console.log("  resolveUri(entry://only) =", resolveUri("entry://only").uri);
console.log("  effectiveDisclosure     =", effectiveDisclosure("entry://only"), "→ 期望 entry-level");
console.log("  别名 disclosure 为 NULL 时：");
db.prepare("UPDATE aliases SET disclosure=NULL WHERE alias_uri='entry://only'").run();
console.log("  effectiveDisclosure     =", effectiveDisclosure("entry://only"), "→ 期望 node-level B（?? 语义）");

console.log("=== 场景 2：死别名（alias_uri 撞存活 nodes.uri）===");
db.prepare("UPDATE aliases SET disclosure='entry-level via alias' WHERE alias_uri='entry://only'").run();
db.prepare("INSERT INTO aliases VALUES('mem://a','B','SHOULD NOT WIN')").run();
console.log("  resolveUri(mem://a)     =", resolveUri("mem://a").uri, "(A 优先)");
console.log("  effectiveDisclosure     =", effectiveDisclosure("mem://a"), "→ 期望 node-level A（一致性）");

console.log("=== 场景 3：节点级条件从入口的可见性（核心承诺）===");
console.log("  从规范 uri 进 mem://b    →", effectiveDisclosure("mem://b"));
console.log("  从别名进   entry://only →", effectiveDisclosure("entry://only"));
