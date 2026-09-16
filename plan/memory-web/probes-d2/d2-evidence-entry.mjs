// D2 证据脚本 3/3 —— 方案 1 vs 方案 2：入口（别名）条件要不要进 FTS。
//
// 这是「入口条件不进 FTS」（22 §5.4，主 agent 已裁定采纳的方案 1）的**唯一实测证据**。
// D1/D4 的「写 alias disclosure 不需 reindex」纪律挂在它上面。
//
// 做法：在真库副本上造两个合成别名，其 disclosure 含一个「在 target 节点的
// uri/content/disclosure 里一次都不出现」的词（离心机 / 示波器）。然后对比：
//   Option A（方案 1）：FTS disclosure 列只放该节点自身的 nodes.disclosure
//   Option B（方案 2）：把每个入口的条件也折进该节点的 FTS 行
//
// 运行：
//   cd packages/memory
//   SRC=/tmp/d2exp/cur.db node --experimental-strip-types <此文件>
//
// 期望输出（已实测）：
//   Option A: 查 "离心机" -> 0 row(s);  查 "示波器" -> 0 row(s)
//   Option B: 查 "离心机" -> 1 row(s);  查 "示波器" -> 1 row(s)
//   term 在 0 个节点的 content/uri/disclosure 中出现
//
// ⇒ Option B 把「只存在于别名入口的词」命中了 **target 节点** —— 归因说谎（契约 §8 T5）。
//    故采纳 Option A，并承认其代价：入口专属词在 keyword 模式搜不到。
//
// ⚠️ 本脚本会在副本上 ALTER + INSERT（不碰原库）；用副本，别指向真库。
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { cpSync } from "node:fs";

const req = createRequire("file:///home/yoshix7ti/projects/pi-rp/packages/memory/package.json");
const { Jieba } = req("@node-rs/jieba");
const { dict } = req("@node-rs/jieba/dict");
const jieba = Jieba.withDict(dict);
const tok = (s) => (s.length === 0 ? "" : jieba.cutForSearch(s).join(" "));

const SRC = process.env.SRC;
if (!SRC) {
	console.error("usage: SRC=/tmp/d2exp/cur.db node --experimental-strip-types d2-evidence-entry.mjs");
	process.exit(1);
}
const f = "/tmp/d2exp/entry-work.db";
cpSync(SRC, f, { force: true });
const db = new DatabaseSync(f);
db.exec("PRAGMA journal_mode=WAL");
db.exec("ALTER TABLE aliases ADD COLUMN disclosure TEXT"); // 模拟 D3 迁移后的 v3
// 挂两个合成别名，条件里各含一个 target 节点不含的词。
// 目标节点从真库现取（不硬编码 uri —— 真库会演进），取前两个非 stub 且正文非空的。
const targets = db
	.prepare("SELECT node_id, uri, disclosure, content FROM nodes WHERE is_stub = 0 AND length(content) > 0 LIMIT 2")
	.all();
if (targets.length < 2) {
	console.error("need >= 2 non-stub nodes in the snapshot");
	process.exit(1);
}
const entries = [
	{ target: targets[0], alias: "core://entries/bench", disclosure: "当我经过离心机时" },
	{ target: targets[1], alias: "core://entries/lab2", disclosure: "当我看到示波器时" },
];
for (const e of entries) {
	if (!e.target) continue;
	db.prepare("INSERT OR REPLACE INTO aliases (alias_uri, target_node_id, disclosure) VALUES (?,?,?)").run(
		e.alias,
		e.target.node_id,
		e.disclosure,
	);
}
const aliasRows = db
	.prepare("SELECT a.alias_uri, a.disclosure, n.node_id, n.uri FROM aliases a JOIN nodes n ON n.node_id=a.target_node_id")
	.all();
console.log("=== synthetic aliases ===");
for (const a of aliasRows) console.log(`  ${a.alias_uri} -> ${a.uri}  disc=${JSON.stringify(a.disclosure)}`);

const nodes = db.prepare("SELECT node_id,uri,content,disclosure,is_stub FROM nodes WHERE is_stub=0").all();
const gk = [...new Set(db.prepare("SELECT keyword FROM glossary").all().map((r) => r.keyword))];

function build(tag) {
	db.exec("DROP TABLE IF EXISTS t");
	db.exec("CREATE VIRTUAL TABLE t USING fts5(node_id UNINDEXED, text, disclosure, tokenize='unicode61')");
	const ins = db.prepare("INSERT INTO t(node_id,text,disclosure) VALUES(?,?,?)");
	for (const n of nodes) {
		const kws = gk.filter((k) => n.content.includes(k));
		let text = tok([n.uri, n.content].join(" "));
		if (kws.length) text += " " + kws.join(" ");
		let disc = n.disclosure ?? ""; // Option A: 只放节点自身的
		if (tag === "B") {
			const parts = aliasRows.filter((a) => a.node_id === n.node_id).map((a) => a.disclosure).filter(Boolean);
			if (parts.length) disc = [disc, ...parts].filter(Boolean).join(" ");
		}
		ins.run(n.node_id, text, tok(disc));
	}
}
const hitCount = (qq) =>
	db.prepare("SELECT count(*) c FROM t WHERE t MATCH ?").get(`"${tok(qq).split(" ")[0]}"`).c;

for (const tag of ["A", "B"]) {
	build(tag);
	console.log(
		`Option ${tag}: 查 "离心机" -> ${hitCount("离心机")} row(s);  查 "示波器" -> ${hitCount("示波器")} row(s)`,
	);
}
console.log("\n=== the term exists nowhere in node content/uri/disclosure ===");
for (const term of ["离心机", "示波器"]) {
	const c = nodes.filter((n) => n.content.includes(term) || n.uri.includes(term) || (n.disclosure ?? "").includes(term)).length;
	console.log(`  "${term}" appears in ${c} node(s) content/uri/disclosure`);
}
db.close();
