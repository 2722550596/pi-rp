// D2 证据脚本 2/3 —— §10 验收断言 A1–A7 的非空性验证。
//
// 做法：把本文 §8 提议的实现（S3–S7 + R1）以 monkeypatch 形式覆盖到真实类上，
// **不修改任何源码**，然后跑 A1–A7。再用同一组断言跑未改动的 v2（应全部失败）。
//
// 运行：
//   cd packages/memory
//   node --experimental-strip-types ../../../plan/memory-web/d2-evidence-asserts.mjs
//   （或从仓库根：node --experimental-strip-types plan/memory-web/d2-evidence-asserts.mjs）
//
// 期望：第一段 12 条全 PASS；第二段（v2）A1/A2a/A2b/A5/A7 全 FAIL。
import { createRequire } from "node:module";
import { openDatabase } from "../../../packages/memory/src/driver.ts";
import { MemoryStore } from "../../../packages/memory/src/store.ts";
import { createSchema } from "../../../packages/memory/src/schema.ts";
import { tokenizeForSearch } from "../../../packages/memory/src/tokenize.ts";

const W = "0.0, 1.0, 1.0"; // NODE_FTS_BM25_WEIGHTS（§2.2；主 agent 已裁定）


// 先留原始实现，末尾做非空性对照时还原（未改动的 v2）。
const ORIG = {
	reindexNode: MemoryStore.prototype.reindexNode,
	searchNodeFts: MemoryStore.prototype.searchNodeFts,
	updateNode: MemoryStore.prototype.updateNode,
};
// ───────── 提议实现（§8 S3/S4/S5/S6 + R1）─────────
MemoryStore.prototype.reindexNode = function (nodeId) {
	const node = this.getNode(nodeId);
	this.db.prepare("DELETE FROM node_fts WHERE node_id = ?").run(nodeId);
	if (node.is_stub) return;
	const keywords = this.db
		.prepare("SELECT keyword FROM glossary WHERE node_id = ?")
		.all(nodeId)
		.map((r) => r.keyword);
	let text = tokenizeForSearch([node.uri, node.content].join(" "));
	const extra = keywords.filter((k) => k.trim().length > 0).join(" ");
	if (extra) text = `${text} ${extra}`;
	const disc = tokenizeForSearch(node.disclosure ?? "");
	if (!text && !disc) return;
	this.db.prepare("INSERT INTO node_fts (node_id, text, disclosure) VALUES (?, ?, ?)").run(nodeId, text, disc);
};
MemoryStore.prototype.reindexAll = function () {
	this.db.transaction(() => {
		for (const r of this.db.prepare("SELECT node_id FROM nodes WHERE is_stub = 0").all()) this.reindexNode(r.node_id);
	});
};
MemoryStore.prototype.searchNodeFts = function (queries) {
	const hits = new Map();
	if (queries.length === 0) return hits;
	const keywords = this.db
		.prepare("SELECT keyword FROM glossary")
		.all()
		.map((g) => g.keyword)
		.filter((k) => k.length > 0);
	for (const query of queries) {
		if (!query) continue;
		let tokens = tokenizeForSearch(query)
			.split(/\s+/)
			.filter((t) => t.length > 0);
		const extra = keywords.filter((k) => query.includes(k));
		if (extra.length) tokens = [...tokens, ...extra];
		if (!tokens.length) continue;
		const match = tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
		const rows = this.db
			.prepare(`SELECT node_id, bm25(node_fts, ${W}) AS bm FROM node_fts WHERE node_fts MATCH ? ORDER BY rank`)
			.all(match);
		for (const row of rows) {
			const p = hits.get(row.node_id);
			if (p === undefined || row.bm < p) hits.set(row.node_id, row.bm);
		}
	}
	return hits;
};
// R1：content 未变的早退分支也要 reindex（否则只改 disclosure 不更新 FTS）
const origUpdate = MemoryStore.prototype.updateNode;
MemoryStore.prototype.updateNode = function (nodeId, patch) {
	const r = origUpdate.call(this, nodeId, patch);
	if (patch && patch.disclosure !== undefined && patch.content === undefined) this.reindexNode(nodeId);
	return r;
};

// ───────── 建库：v3 形状（模拟 D3 迁移结果）─────────
async function fresh() {
	const db = await openDatabase(":memory:");
	createSchema(db);
	db.exec("ALTER TABLE aliases ADD COLUMN disclosure TEXT");
	db.exec("DROP TABLE node_fts");
	db.exec("CREATE VIRTUAL TABLE node_fts USING fts5(node_id UNINDEXED, text, disclosure, tokenize='unicode61')");
	return { db, s: new MemoryStore(db) };
}
const out = [];
const chk = (name, fn) => {
	try {
		out.push(`${fn() ? "PASS" : "FAIL"} ${name}`);
	} catch (e) {
		out.push(`FAIL ${name}: ${e.message}`);
	}
};

// A1
{
	const { db } = await fresh();
	chk("A1 cols == [node_id,text,disclosure]", () =>
		JSON.stringify(db.prepare("PRAGMA table_info(node_fts)").all().map((x) => x.name)) ===
		JSON.stringify(["node_id", "text", "disclosure"]),
	);
}
// A2 (covers old A3)
{
	const { db, s } = await fresh();
	const n = s.put({ uri: "core://x", content: "正文内容", disclosure: "当闻到晚香玉时" });
	const row = db.prepare("SELECT text, disclosure FROM node_fts WHERE node_id = ?").get(n.node_id);
	chk("A2a disclosure column filled", () => row.disclosure.includes("晚香玉"));
	chk("A2b text column excludes disclosure", () => !row.text.includes("晚香玉"));
	chk("A2c control: uri+content still in text", () => row.text.includes("正文"));
}
// A4
{
	const { db, s } = await fresh();
	const t = s.put({ uri: "core://t", content: "target body", disclosure: null });
	db.prepare("INSERT INTO aliases (alias_uri, target_node_id, disclosure) VALUES (?,?,?)").run(
		"core://entry/only",
		t.node_id,
		"当我经过离心机时",
	);
	chk("A4 alias disclosure NOT in FTS", () => !s.searchNodeFts(["离心机"]).has(t.node_id));
	chk("A4b control: target content IS searchable", () => s.searchNodeFts(["target"]).has(t.node_id));
}
// A5 (R1)
{
	const { db, s } = await fresh();
	const a = s.put({ uri: "core://r", content: "不变的正文", disclosure: "旧条件词" });
	s.updateNode(a.node_id, { disclosure: "换成南瓜子条件" });
	const row = db.prepare("SELECT disclosure FROM node_fts WHERE node_id = ?").get(a.node_id);
	chk("A5 R1: disclosure column updated", () => row.disclosure.includes("南瓜子"));
	chk("A5b R1: old term gone", () => !row.disclosure.includes("旧条件词"));
}
// A6
{
	const { db } = await fresh();
	chk("A6 weight arity == column count", () => W.split(",").length === db.prepare("PRAGMA table_info(node_fts)").all().length);
	chk("A6b weight string executes", () => {
		db.prepare(`SELECT bm25(node_fts, ${W}) FROM node_fts WHERE node_fts MATCH 'x'`).all();
		return true;
	});
}
// A7
{
	const { db, s } = await fresh();
	const n1 = s.put({ uri: "core://ra", content: "甲内容", disclosure: "甲条件词" });
	db.prepare("DELETE FROM node_fts").run();
	s.reindexAll();
	chk("A7 reindexAll restores disclosure", () => s.searchNodeFts(["甲条件词"]).has(n1.node_id));
	chk("A7b reindexAll restores content", () => s.searchNodeFts(["甲内容"]).has(n1.node_id));
}

console.log("── 提议实现（v3 + R1）────────────────────────");
console.log(out.join("\n"));

// ───────── 非空性：同一组断言跑未改动的 v2 ─────────
// 原型已被上面的 monkeypatch 改过，故先还原原始实现，再跑同一组断言——
// 期望全部 FAIL（列不存在 / 函数不存在）。
MemoryStore.prototype.reindexNode = ORIG.reindexNode;
MemoryStore.prototype.searchNodeFts = ORIG.searchNodeFts;
delete MemoryStore.prototype.reindexAll;
MemoryStore.prototype.updateNode = ORIG.updateNode;
{
	const db = await openDatabase(":memory:");
	createSchema(db); // v2 原样：node_fts 只有 (node_id, text)
	const s = new MemoryStore(db);
	const n2 = [];
	const chk2 = (name, fn) => {
		try {
			n2.push(`${fn() ? "UNEXPECTED-PASS" : "FAIL(as-required)"} ${name}`);
		} catch (e) {
			n2.push(`FAIL(as-required) ${name}: ${e.message}`);
		}
	};
	const n = s.put({ uri: "core://x", content: "正文内容", disclosure: "当闻到晚香玉时" });
	chk2("A1 cols == 3", () =>
		JSON.stringify(db.prepare("PRAGMA table_info(node_fts)").all().map((x) => x.name)) ===
		JSON.stringify(["node_id", "text", "disclosure"]),
	);
	chk2("A2a disclosure column filled", () =>
		db.prepare("SELECT disclosure FROM node_fts WHERE node_id = ?").get(n.node_id).disclosure.includes("晚香玉"),
	);
	chk2("A2b text column excludes disclosure", () =>
		!db.prepare("SELECT text FROM node_fts WHERE node_id = ?").get(n.node_id).text.includes("晚香玉"),
	);
	const a = s.put({ uri: "core://r", content: "不变的正文", disclosure: "旧条件词" });
	s.updateNode(a.node_id, { disclosure: "换成南瓜子条件" });
	chk2("A5 disclosure column updated", () =>
		db.prepare("SELECT disclosure FROM node_fts WHERE node_id = ?").get(a.node_id).disclosure.includes("南瓜子"),
	);
	chk2("A7 reindexAll exists", () => typeof s.reindexAll === "function");
	console.log("\n── 未改动 v2（非空性：应全部 FAIL）──────────");
	console.log(n2.join("\n"));
}
