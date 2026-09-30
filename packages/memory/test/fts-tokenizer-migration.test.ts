import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type MemoryDatabase, openDatabase } from "../src/driver.ts";
import { openMemoryStore } from "../src/index.ts";
import {
	createSchema,
	FTS_REBUILD_KEY,
	FTS_TOKENIZER_KEY,
	FTS_TOKENIZER_VALUE,
	SCHEMA_VERSION,
	SCHEMA_VERSION_KEY,
} from "../src/schema.ts";
import { MemoryStore } from "../src/store.ts";
import { tokenizeForSearch } from "../src/tokenize.ts";

/**
 * Tokenizer-space migration gate (13-D §4 step 5 / 契约 §10 前置纪律).
 *
 * A database whose `memory_kv.fts_tokenizer` is missing (every jieba-era
 * database) or different holds FTS indexes in a foreign token space while the
 * query side speaks Segmenter. The gate must DROP+CREATE both FTS tables and
 * fully re-backfill them (nodes + active raw rows) inside ONE transaction,
 * write the key only after success, roll back everything on failure, and
 * retry on the next open.
 */

let workdir: string;
const open: MemoryDatabase[] = [];

beforeEach(() => {
	workdir = mkdtempSync(path.join(tmpdir(), "mem-tok-migrate-"));
	open.length = 0;
});

afterEach(() => {
	for (const db of open) db.close();
	rmSync(workdir, { recursive: true, force: true });
});

function ftsText(db: MemoryDatabase, nodeId: string): string | undefined {
	const row = db.prepare("SELECT text FROM node_fts WHERE node_id = ?").get(nodeId) as { text: string } | undefined;
	return row?.text;
}

function rowCount(db: MemoryDatabase, sql: string): number {
	return (db.prepare(sql).get() as { c: number }).c;
}

/** Build a pre-Segmenter ("jieba-era") database: indexes hold foreign-space
 * token text and the `fts_tokenizer` key is absent. Returns the live store
 * plus the node id for later assertions. */
async function openLegacy(file: string): Promise<{ store: MemoryStore; nodeId: string; rawId: number }> {
	const store = await openMemoryStore(file);
	open.push(store.db);
	const node = store.insertNode({ uri: "history://scene/雨夜", content: "雨夜的码头，她握着那把黑伞没有说话。" });
	const rawId = store.appendRaw([
		{ role: "user", text: "她的黑伞落在了码头", entry_id: "e1", session_id: "s1", wall_ts: "2026-09-30T00:00:00Z" },
	]);
	// Overwrite both FTS tables with bigram-era junk and strip the key — the
	// exact on-disk shape a jieba-era database presents to the new code.
	store.db.exec("DELETE FROM node_fts");
	store.db.prepare("INSERT INTO node_fts (node_id, text) VALUES (?, ?)").run(node.node_id, "雨夜 码头 黑伞");
	store.db.exec("DELETE FROM raw_fts");
	store.db.prepare("INSERT INTO raw_fts (raw_id, text) VALUES (?, ?)").run(rawId, "黑伞 码头");
	store.db.prepare("DELETE FROM memory_kv WHERE key = ?").run(FTS_TOKENIZER_KEY);
	return { store, nodeId: node.node_id, rawId };
}

describe("fts_tokenizer migration gate", () => {
	it("writes the key on fresh databases and skips the gate", async () => {
		const file = path.join(workdir, "memory.db");
		const store = await openMemoryStore(file);
		open.push(store.db);
		expect(store.getKv(FTS_TOKENIZER_KEY)).toBe(FTS_TOKENIZER_VALUE);
		expect(store.getKv(SCHEMA_VERSION_KEY)).toBe(SCHEMA_VERSION);
		expect(store.getKv(FTS_REBUILD_KEY)).toBeNull();
	});

	it("rebuilds both FTS tables and writes the key when opening a keyless (jieba-era) database", async () => {
		const file = path.join(workdir, "memory.db");
		const legacy = await openLegacy(file);
		legacy.store.db.close();
		open.pop();

		const reopened = await openMemoryStore(file);
		open.push(reopened.db);

		// Key written only after the rebuild (order discipline, 契约 §10).
		expect(reopened.getKv(FTS_TOKENIZER_KEY)).toBe(FTS_TOKENIZER_VALUE);
		// node_fts content re-tokens from the live nodes — segmenter space.
		expect(ftsText(reopened.db, legacy.nodeId)).toBe(
			tokenizeForSearch(`history://scene/雨夜 雨夜的码头，她握着那把黑伞没有说话。`),
		);
		// MATCH with segmenter tokens hits (the junk index could not).
		expect([...reopened.searchNodeFts(["黑伞"]).keys()]).toContain(legacy.nodeId);
		// raw_fts rebuilt from ACTIVE raw rows (reindexAllRaw).
		expect(reopened.searchRawFts("码头")).toEqual([
			{ raw_id: legacy.rawId, role: "user", text: "她的黑伞落在了码头" },
		]);
		// A stale v3-era pending marker is satisfied by the same rebuild.
		expect(reopened.getKv(FTS_REBUILD_KEY)).toBeNull();
		// No schema-version bump: DDL is unchanged (13-D 结论一).
		expect(reopened.getKv(SCHEMA_VERSION_KEY)).toBe(SCHEMA_VERSION);
	});

	it("does not rebuild when the key already says segmenter", async () => {
		const file = path.join(workdir, "memory.db");
		const first = await openMemoryStore(file);
		open.push(first.db);
		const node = first.insertNode({ uri: "history://scene/1", content: "内容一" });
		// Sabotage the index content while keeping the correct key: the gate is
		// keyed on the recorded space, not on content heuristics.
		first.db.prepare("UPDATE node_fts SET text = 'sabotaged'").run();

		const reopened = await openMemoryStore(file);
		open.push(reopened.db);
		expect(ftsText(reopened.db, node.node_id)).toBe("sabotaged");
	});

	it("rolls back the whole rebuild on failure and retries on the next open", async () => {
		const file = path.join(workdir, "memory.db");
		const legacy = await openLegacy(file);
		const legacyNodeFts = rowCount(legacy.store.db, "SELECT COUNT(*) AS c FROM node_fts");
		const legacyRawFts = rowCount(legacy.store.db, "SELECT COUNT(*) AS c FROM raw_fts");

		// Inject a mid-transaction failure (private method, type-level only).
		const proto = MemoryStore.prototype as unknown as { _reindexAllNodes(): void };
		const original = proto._reindexAllNodes;
		proto._reindexAllNodes = () => {
			throw new Error("simulated reindex failure");
		};
		let failed: unknown;
		try {
			try {
				new MemoryStore(legacy.store.db);
			} catch (error) {
				failed = error;
			}
		} finally {
			proto._reindexAllNodes = original;
		}
		expect((failed as Error).message).toBe("simulated reindex failure");

		// Transactional rollback: DROP+CREATE undone, old junk index intact,
		// key unwritten — the gate condition still holds.
		expect(legacy.store.getKv(FTS_TOKENIZER_KEY)).toBeNull();
		expect(rowCount(legacy.store.db, "SELECT COUNT(*) AS c FROM node_fts")).toBe(legacyNodeFts);
		expect(rowCount(legacy.store.db, "SELECT COUNT(*) AS c FROM raw_fts")).toBe(legacyRawFts);
		expect(ftsText(legacy.store.db, legacy.nodeId)).toBe("雨夜 码头 黑伞");

		// Next open retries and succeeds.
		const reopened = await openMemoryStore(file);
		open.push(reopened.db);
		expect(reopened.getKv(FTS_TOKENIZER_KEY)).toBe(FTS_TOKENIZER_VALUE);
		expect([...reopened.searchNodeFts(["黑伞"]).keys()]).toContain(legacy.nodeId);
	});

	it("leaves the readonly probe path untouched by the gate", async () => {
		const file = path.join(workdir, "memory.db");
		const legacy = await openLegacy(file);
		legacy.store.db.close();
		open.pop();
		const { openDatabaseReadonly } = await import("../src/driver.ts");
		const probe = await openDatabaseReadonly(file);
		open.push(probe);
		// Read-only open does NOT trigger the gate (gate lives in MemoryStore's
		// constructor on write opens): the junk index is still there.
		expect(rowCount(probe, "SELECT COUNT(*) AS c FROM node_fts")).toBe(1);
	});
});

describe("createSchema (direct)", () => {
	it("never writes the tokenizer key on existing databases — the gate owns it", async () => {
		const db = await openDatabase(":memory:");
		open.push(db);
		createSchema(db);
		// Simulate a pre-key database: structure is current, the key is absent
		// (exactly what every jieba-era v4 database looks like). A re-run of
		// createSchema must NOT hand out the key — otherwise the store-side
		// gate would never fire and new code would query the old index.
		db.prepare("DELETE FROM memory_kv WHERE key = ?").run(FTS_TOKENIZER_KEY);
		const result = createSchema(db);
		expect(result.migratedFrom).toBeNull();
		expect(db.prepare("SELECT value FROM memory_kv WHERE key = ?").get(FTS_TOKENIZER_KEY)).toBeUndefined();
	});
});
