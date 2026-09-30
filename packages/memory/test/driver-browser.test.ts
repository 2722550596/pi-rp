import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/driver.ts";
import { createBrowserSqliteDatabaseFactory } from "../src/driver-browser.ts";
import { openMemoryStore } from "../src/index.ts";
import type { MemoryStore } from "../src/store.ts";
import { tokenizeForSearch } from "../src/tokenize.ts";

/**
 * Driver contract consistency (13-D §11.3-1): the SAME statement/transaction/
 * pragma suite runs against the node factory (openDatabase default) and the
 * browser factory (@sqlite.org/sqlite-wasm under Node — loadable per 13-D
 * §11.2 实测). MemoryStore's raw-log mirror keys FTS off
 * `run().lastInsertRowid`, so both adapters must supply it.
 */

const factories: Array<[string, () => ReturnType<typeof openDatabase>]> = [
	["node", () => openDatabase(":memory:")],
	["browser-wasm", () => createBrowserSqliteDatabaseFactory().open(":memory:")],
];

describe.each(factories)("%s driver adapter contract", (_label, makeDb) => {
	it("commits a synchronous transaction and rolls back on throw", async () => {
		const db = await makeDb();
		try {
			db.exec("CREATE TABLE values_table (value INTEGER NOT NULL)");
			expect(
				db.transaction(() => {
					db.prepare("INSERT INTO values_table (value) VALUES (?)").run(42);
					return "committed";
				}),
			).toBe("committed");
			expect(() =>
				db.transaction(() => {
					db.prepare("INSERT INTO values_table (value) VALUES (?)").run(43);
					throw new Error("rollback-probe");
				}),
			).toThrow("rollback-probe");
			expect(db.prepare("SELECT value FROM values_table").all()).toEqual([{ value: 42 }]);
		} finally {
			db.close();
		}
	});

	it("forwards positional and named parameters and returns plain-object rows", async () => {
		const db = await makeDb();
		try {
			db.exec("CREATE TABLE values_table (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
			const first = db.prepare("INSERT INTO values_table (value) VALUES (?)").run("positional");
			expect(first.changes).toBe(1);
			expect(first.lastInsertRowid).toBe(1);
			expect(db.prepare("INSERT INTO values_table (value) VALUES (:value)").run({ value: "named" })).toEqual({
				changes: 1,
				lastInsertRowid: 2,
			});
			expect(db.prepare("SELECT id, value FROM values_table WHERE id = ?").get(1)).toEqual({
				id: 1,
				value: "positional",
			});
			expect(db.prepare("SELECT value FROM values_table WHERE id >= :id ORDER BY id").all({ id: 2 })).toEqual([
				{ value: "named" },
			]);
			expect([...db.prepare("SELECT value FROM values_table ORDER BY id").iterate()]).toEqual([
				{ value: "positional" },
				{ value: "named" },
			]);
		} finally {
			db.close();
		}
	});

	it("runs FTS5 with unified-tokenizer CJK content end-to-end", async () => {
		const db = await makeDb();
		try {
			db.exec("CREATE VIRTUAL TABLE node_fts USING fts5(node_id UNINDEXED, text, tokenize='unicode61')");
			db.prepare("INSERT INTO node_fts (node_id, text) VALUES (?, ?)").run(
				"n1",
				tokenizeForSearch("雨夜的码头，黑伞没有说话。"),
			);
			expect(db.prepare("SELECT node_id FROM node_fts WHERE node_fts MATCH ?").all(`"码头" OR "黑伞"`)).toEqual([
				{ node_id: "n1" },
			]);
			expect(db.prepare("SELECT node_id FROM node_fts WHERE node_fts MATCH ?").all(`"不存在的词"`)).toEqual([]);
		} finally {
			db.close();
		}
	});
});

describe("browser factory through the injection seam", () => {
	let store: MemoryStore;

	beforeEach(async () => {
		store = await openMemoryStore(":memory:", { sqlite: createBrowserSqliteDatabaseFactory() });
	});

	afterEach(() => {
		store.db.close();
	});

	it("opens, writes and searches a full MemoryStore on the wasm driver", async () => {
		const node = store.insertNode({ uri: "history://scene/雨夜", content: "雨夜的码头，她握着那把黑伞没有说话。" });
		store.appendRaw([
			{
				role: "user",
				text: "她的黑伞落在了码头",
				entry_id: "e1",
				session_id: "s1",
				wall_ts: "2026-09-30T00:00:00Z",
			},
		]);
		// raw_log upsert keys the FTS mirror off run().lastInsertRowid — the
		// wasm adapter's capi rowid keeps that path alive.
		expect(store.searchRawFts("码头")).toEqual([{ raw_id: 1, role: "user", text: "她的黑伞落在了码头" }]);
		expect([...store.searchNodeFts(["黑伞"]).keys()]).toContain(node.node_id);
		expect(store.getKv("fts_tokenizer")).toBe("segmenter");
	});
});
