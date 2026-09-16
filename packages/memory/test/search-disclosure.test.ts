/**
 * 边级 disclosure · D2 检索与打分验收（A1–A7）。
 *
 * 覆盖本次唯一新引入的可观测契约：`node_fts` 从单列 `(node_id, text)` 变成
 * `(node_id, text, disclosure)`，`text` 不再混入 disclosure，以及 R1 缺陷
 * （只改 disclosure 的 revise 原先不重建 FTS）的回归锁。
 *
 * 文档：`plan/memory-web/22-检索与打分.md` §10。全部走 `:memory:` + 公开 API，
 * **不依赖任何 /tmp 路径**（D6 §10.6 归档纪律）。
 *
 * 不复用 `search-keyword.test.ts`：那个文件是「候选选择 vs 打分口径断裂」的
 * 回归，语义不同。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type MemoryDatabase, openDatabase } from "../src/driver.ts";
import { createSchema } from "../src/schema.ts";
import { MemoryStore, NODE_FTS_BM25_WEIGHTS } from "../src/store.ts";

let db: MemoryDatabase;
let store: MemoryStore;

beforeEach(async () => {
	db = await openDatabase(":memory:");
	createSchema(db);
	store = new MemoryStore(db);
});

afterEach(() => {
	db.close();
});

/** Declared columns of the FTS table (FTS5 reports its declared column list). */
function ftsColumns(): string[] {
	return (db.prepare("PRAGMA table_info(node_fts)").all() as Array<{ name: string }>).map((r) => r.name);
}

function ftsRow(nodeId: string): { text: string; disclosure: string } {
	const row = db.prepare("SELECT text, disclosure FROM node_fts WHERE node_id = ?").get(nodeId) as
		| { text: string; disclosure: string }
		| undefined;
	if (!row) throw new Error(`no node_fts row for ${nodeId}`);
	return row;
}

describe("A1 — node_fts has the disclosure column", () => {
	it("declares exactly [node_id, text, disclosure]", () => {
		expect(ftsColumns()).toEqual(["node_id", "text", "disclosure"]);
	});
});

describe("A2 — reindexNode splits disclosure out of text", () => {
	it("fills the disclosure column and keeps its tokens out of text", () => {
		const n = store.put({ uri: "core://x", content: "正文内容", disclosure: "当闻到晚香玉时" });
		const row = ftsRow(n.node_id);
		// A2a: the new column carries the disclosure (tokenized).
		expect(row.disclosure).toContain("晚香玉");
		// A2b: text no longer double-indexes it.
		expect(row.text).not.toContain("晚香玉");
		// A2c (control): uri + content still land in text.
		expect(row.text).toContain("正文");
	});

	it("a disclosure-only term is searchable through MATCH", () => {
		// The point of the independent column: the term exists ONLY in
		// disclosure, yet the node is an FTS candidate.
		const n = store.put({ uri: "core://y", content: "无关正文", disclosure: "当闻到晚香玉时" });
		expect(store.searchNodeFts(["晚香玉"]).has(n.node_id)).toBe(true);
	});
});

describe("A4 — entry (alias) disclosure never enters FTS", () => {
	it("a term only present in an alias disclosure yields no FTS hit", () => {
		const t = store.put({ uri: "core://t", content: "target body", disclosure: null });
		// The production write path is D1's `addAlias(uri, nodeId, disclosure)`.
		// `addAlias` deliberately does NOT reindex: entry conditions never
		// belong in the node-level FTS table.
		store.addAlias("core://entry/only", t.node_id, "当我经过离心机时");
		expect(db.prepare("SELECT disclosure FROM aliases WHERE alias_uri = ?").get("core://entry/only")).toEqual({
			disclosure: "当我经过离心机时",
		});
		// Plan 1: entry conditions are NOT FTS-indexed (FTS is node-level).
		expect(store.searchNodeFts(["离心机"]).has(t.node_id)).toBe(false);
		// Control: the target's own body IS searchable.
		expect(store.searchNodeFts(["target"]).has(t.node_id)).toBe(true);
	});
});

describe("A5 — R1: a disclosure-only revise rebuilds the FTS column", () => {
	it("updates node_fts.disclosure when only disclosure changes", () => {
		const a = store.put({ uri: "core://r", content: "不变的正文", disclosure: "当闻到醋栗时" });
		// content is unchanged → `_updateNode` takes the non-content early
		// return, which used to skip reindexNode entirely (R1).
		store.updateNode(a.node_id, { disclosure: "换成南瓜子条件" });
		const row = ftsRow(a.node_id);
		expect(row.disclosure).toContain("南瓜子");
		expect(row.disclosure).not.toContain("醋栗");
		// The same rebuild must reach MATCH, not just the stored column.
		// Both probe words must be token-stable (a shared token like 条件
		// would let the old query still match the new column).
		expect(store.searchNodeFts(["南瓜子"]).has(a.node_id)).toBe(true);
		expect(store.searchNodeFts(["醋栗"]).has(a.node_id)).toBe(false);
	});

	it("does not touch FTS on a patch with no disclosure key", () => {
		const a = store.put({ uri: "core://r2", content: "正文", disclosure: "条件" });
		const before = ftsRow(a.node_id);
		store.updateNode(a.node_id, { importance: 9 });
		expect(ftsRow(a.node_id)).toEqual(before);
	});
});

describe("A6 — bm25 weight arity matches the column count", () => {
	it("NODE_FTS_BM25_WEIGHTS has one weight per declared column", () => {
		// bm25() silently IGNORES surplus weight args, so a column/weight
		// mismatch fails silently — this arity check is the only guard.
		const weights = NODE_FTS_BM25_WEIGHTS.split(",").map((s) => s.trim());
		expect(weights).toHaveLength(ftsColumns().length);
	});

	it("the weight string executes against the real table", () => {
		expect(() => {
			db.prepare(`SELECT bm25(node_fts, ${NODE_FTS_BM25_WEIGHTS}) FROM node_fts WHERE node_fts MATCH 'x'`).all();
		}).not.toThrow();
	});
});

describe("A7 — reindexAll() rebuilds every non-stub row", () => {
	it("restores text and disclosure rows after a full wipe", () => {
		const n1 = store.put({ uri: "core://ra", content: "甲内容", disclosure: "甲条件词" });
		db.prepare("DELETE FROM node_fts").run();
		expect(store.searchNodeFts(["甲条件词"]).size).toBe(0);
		store.reindexAll();
		expect(store.searchNodeFts(["甲条件词"]).has(n1.node_id)).toBe(true);
		expect(store.searchNodeFts(["甲内容"]).has(n1.node_id)).toBe(true);
	});

	it("keeps stub nodes out of FTS", () => {
		store.put({ uri: "core://deep/child/leaf", content: "叶内容" });
		const stub = store.resolveUri("core://deep")!;
		store.reindexAll();
		const rows = db.prepare("SELECT node_id FROM node_fts").all() as Array<{ node_id: string }>;
		expect(rows.map((r) => r.node_id)).not.toContain(stub.node_id);
	});
});
