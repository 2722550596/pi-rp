/**
 * v2 → v3 in-place migration (`plan/memory-web/23-迁移.md` §3, §10.6).
 *
 * The fixture is a REAL v2 database — `test/fixtures/memory-v2.db` was produced
 * by running the pre-bump `createSchema`, so its shape cannot drift from the
 * DDL (nothing here hand-copies `CREATE TABLE`). Every case works on a copy.
 *
 * These are the non-emptiness assertions of §10.6: each one FAILS without the
 * migration — before this change, opening a v2 database threw outright.
 */
import { copyFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type MemoryDatabase, openDatabase, openDatabaseReadonly } from "../src/driver.ts";
import { openMemoryStore } from "../src/index.ts";
import { createSchema, FTS_REBUILD_KEY, MIGRATABLE_FROM, NODE_FTS_DDL, SCHEMA_VERSION } from "../src/schema.ts";
import { MemoryStore } from "../src/store.ts";
import { probeMemoryDb } from "../src/web/discovery.ts";
import { StoreRegistry } from "../src/web/registry.ts";

const FIXTURE_V2 = fileURLToPath(new URL("./fixtures/memory-v2.db", import.meta.url));
const NODES = "SELECT node_id, uri, content, disclosure, importance, updated_ts FROM nodes ORDER BY node_id";
const ALIASES = "SELECT alias_uri, target_node_id FROM aliases ORDER BY alias_uri";

let workdir: string;
const open: MemoryDatabase[] = [];

beforeEach(() => {
	workdir = mkdtempSync(path.join(tmpdir(), "mem-migrate-"));
});

afterEach(() => {
	while (open.length > 0) open.pop()?.close();
	rmSync(workdir, { recursive: true, force: true });
});

/** Copy the committed v2 fixture into the per-test temp dir. */
function fixtureCopy(name = "memory.db"): string {
	const target = path.join(workdir, name);
	copyFileSync(FIXTURE_V2, target);
	return target;
}

async function openCopy(name = "memory.db"): Promise<MemoryDatabase> {
	const db = await openDatabase(fixtureCopy(name));
	open.push(db);
	return db;
}

function kv(db: MemoryDatabase, key: string): string | null {
	const row = db.prepare("SELECT value FROM memory_kv WHERE key = ?").get(key) as { value: string } | undefined;
	return row?.value ?? null;
}

function setKv(db: MemoryDatabase, key: string, value: string): void {
	db.prepare("INSERT OR REPLACE INTO memory_kv (key, value, updated_at) VALUES (?, ?, ?)").run(key, value, "now");
}

function count(db: MemoryDatabase, sql: string): number {
	const row = db.prepare(sql).get() as { c: number } | undefined;
	return row?.c ?? 0;
}

function cols(db: MemoryDatabase, table: string): string[] {
	const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
	return rows.map((r) => r.name);
}

describe("v2 → v3 in-place migration", () => {
	it("T-1/T-2: upgrades structure, keeps every row, rebuilds FTS content", async () => {
		const db = await openCopy();
		const nodesBefore = db.prepare(NODES).all();
		const aliasesBefore = db.prepare(ALIASES).all();
		const ftsBefore = count(db, "SELECT COUNT(*) AS c FROM node_fts");
		const disclosuresBefore = count(db, "SELECT COUNT(*) AS c FROM nodes WHERE disclosure IS NOT NULL");

		const result = createSchema(db);
		expect(result.migratedFrom).toBe("2");
		expect(result.ftsRebuildPending).toBe(true);
		expect(result.backup).not.toBeNull();
		const store = new MemoryStore(db); // the constructor heals the pending rebuild

		// T-1 — three columns AND a non-empty index. Checking the column alone
		// would pass on a silently-empty FTS table.
		expect(cols(db, "node_fts")).toEqual(["node_id", "text", "disclosure"]);
		expect(kv(db, FTS_REBUILD_KEY)).toBeNull();
		expect(count(db, "SELECT COUNT(*) AS c FROM node_fts")).toBe(ftsBefore);
		expect(ftsBefore).toBeGreaterThan(0);

		// T-2 — the migration claims v3 and changes no stored data. Full-row
		// snapshots, not counts: `disclosure`/`importance`/`updated_ts` must be
		// identical row by row.
		expect(kv(db, "schema_version")).toBe(SCHEMA_VERSION);
		expect(JSON.stringify(db.prepare(NODES).all())).toBe(JSON.stringify(nodesBefore));
		expect(JSON.stringify(db.prepare(ALIASES).all())).toBe(JSON.stringify(aliasesBefore));
		expect(count(db, "SELECT COUNT(*) AS c FROM nodes WHERE disclosure IS NOT NULL")).toBe(disclosuresBefore);
		// New entry columns stay NULL — under `??` inheritance the effective
		// disclosure equals the pre-migration node-level value.
		expect(count(db, "SELECT COUNT(*) AS c FROM aliases WHERE disclosure IS NOT NULL")).toBe(0);
		expect(count(db, "SELECT COUNT(*) AS c FROM edges WHERE disclosure IS NOT NULL")).toBe(0);
		// The dead alias (`alias_uri` is itself a live `nodes.uri`) survives untouched.
		expect(count(db, "SELECT COUNT(*) AS c FROM aliases WHERE alias_uri = 'core://a'")).toBe(1);

		// The rebuilt index is queryable, not merely present.
		expect(db.prepare("SELECT node_id FROM node_fts WHERE node_fts MATCH ?").all('"alpha"').length).toBeGreaterThan(
			0,
		);
		expect(store.getKv("schema_version")).toBe(SCHEMA_VERSION);
	});

	it("T-3: a second open is a no-op and the FTS count is stable", async () => {
		const db = await openCopy();
		expect(createSchema(db).migratedFrom).toBe("2");
		new MemoryStore(db);
		const ftsFirst = count(db, "SELECT COUNT(*) AS c FROM node_fts");

		const second = createSchema(db);
		expect(second.migratedFrom).toBeNull();
		expect(second.ftsRebuildPending).toBe(false);
		expect(second.backup).toBeNull();
		expect(count(db, "SELECT COUNT(*) AS c FROM node_fts")).toBe(ftsFirst);
		expect(createSchema(db).migratedFrom).toBeNull();
	});

	it("column existence, not the version number, makes it idempotent", async () => {
		// A snapshot import (or a stray `seed()`) can write a stale
		// `schema_version` into an already-v3 database. A version-only migrator
		// would then die on `duplicate column name` during open.
		const db = await openCopy();
		createSchema(db);
		new MemoryStore(db);
		setKv(db, "schema_version", "2");
		expect(() => createSchema(db)).not.toThrow();
		expect(kv(db, "schema_version")).toBe(SCHEMA_VERSION);
		expect(cols(db, "node_fts")).toHaveLength(3);
	});

	it("T-5: the store constructor heals a crashed migration through the real entry point", async () => {
		// Crash window shape: structure at v3, marker present, node_fts empty.
		const db = await openCopy();
		createSchema(db);
		db.exec("DELETE FROM node_fts");
		setKv(db, FTS_REBUILD_KEY, "1");
		db.close();
		open.length = 0;

		// MUST go through `openMemoryStore` — a hand-written `reindexAll` call
		// would not prove the constructor is wired up.
		const store = await openMemoryStore(path.join(workdir, "memory.db"));
		expect(count(store.db, "SELECT COUNT(*) AS c FROM node_fts")).toBeGreaterThan(0);
		expect(store.getKv(FTS_REBUILD_KEY)).toBeNull();
		store.db.close();
	});

	it("T-6: the probe gate and the open gate admit v2 together", async () => {
		const file = fixtureCopy();
		// Gate 1 — read-only discovery must admit a migratable version…
		expect(await probeMemoryDb(file)).toMatchObject({ ok: true, schemaVersion: "2" });
		// …and must NOT have migrated anything on the way (read-only connection,
		// so this would have thrown had the probe tried to write).
		const probe = await openDatabase(file);
		open.push(probe);
		expect(cols(probe, "node_fts")).toEqual(["node_id", "text"]);
		expect(kv(probe, FTS_REBUILD_KEY)).toBeNull();
		probe.close();
		open.length = 0;

		// Gate 2 — the write-open path actually upgrades it.
		const store = await openMemoryStore(file);
		expect(store.getKv("schema_version")).toBe(SCHEMA_VERSION);
		expect(count(store.db, "SELECT COUNT(*) AS c FROM node_fts")).toBeGreaterThan(0);
		store.db.close();
	});

	it("probeMemoryDb reports an un-migratable version as incompatible", async () => {
		const file = fixtureCopy("memory-v99.db");
		const db = await openDatabase(file);
		open.push(db);
		setKv(db, "schema_version", "99");
		db.close();
		open.length = 0;

		expect(MIGRATABLE_FROM).not.toContain("99");
		expect(await probeMemoryDb(file)).toMatchObject({ ok: false, reason: "incompatible" });
		// The write gate refuses the same version, with the frozen prefix that
		// `routes.ts` maps to a 409 `invalid_db`.
		const refused = await openDatabase(file);
		open.push(refused);
		expect(() => createSchema(refused)).toThrow(/incompatible with this build/);
		expect(cols(refused, "node_fts")).toEqual(["node_id", "text"]);
	});

	it("names a failed migration `migration failed` and reports the backup", async () => {
		// A read-only connection cannot run the ALTER; `VACUUM INTO` already
		// failed first, so the message also carries why there is no backup.
		const db = await openDatabaseReadonly(fixtureCopy());
		open.push(db);
		let message = "";
		try {
			createSchema(db);
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toContain("migration failed");
		expect(message).toMatch(/; backup(:| skipped:)/);
	});

	it("falls back to a `-N` suffixed backup path when the timestamp name is taken", async () => {
		// The stamp resolves only to the second, so two migrations in the same
		// second collide — and `VACUUM INTO` refuses an existing target. Freeze
		// the clock so the collision is deterministic instead of luck.
		const file = fixtureCopy();
		const stamp = "20260916T010000";
		copyFileSync(FIXTURE_V2, `${file}.pre-v2-${stamp}.bak`);

		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-09-16T01:00:00Z"));
		try {
			const db = await openDatabase(file);
			open.push(db);
			expect(createSchema(db).backup).toMatchObject({ path: `${file}.pre-v2-${stamp}-2.bak` });
			expect(statSync(`${file}.pre-v2-${stamp}-2.bak`).size).toBeGreaterThan(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("backs up through VACUUM INTO, so uncheckpointed rows survive", async () => {
		// A bare `cp` of the main file drops the newest transaction; the backup
		// must equal what the live connection sees.
		const db = await openCopy();
		db.prepare(
			"INSERT INTO nodes (node_id, parent_id, domain, uri, content, disclosure, importance, source, created_at, updated_ts, content_hash, is_stub) " +
				"VALUES (?, NULL, 'core', 'core://wal', 'wal row', NULL, 5, 'manual', ?, ?, 'deadbeef', 0)",
		).run("n_wal_test", "2026-09-16T01:00:00Z", "2026-09-16T01:00:00Z");

		const backup = createSchema(db).backup;
		expect(backup).not.toBeNull();
		const restored = await openDatabase((backup as { path: string }).path);
		open.push(restored);
		expect(restored.prepare("SELECT content FROM nodes WHERE node_id = ?").get("n_wal_test")).toMatchObject({
			content: "wal row",
		});
		expect(kv(restored, "schema_version")).toBe("2");
		expect(cols(restored, "node_fts")).toEqual(["node_id", "text"]);
	});
});

describe("multi-db path", () => {
	it("a registry-open of a v2 db migrates it (the `/api/databases/open` path)", async () => {
		// Contract §7 门槛 2 requires the migration to be reachable through the
		// MULTI-DB path, not just `openMemoryStore`. `register` is that door
		// (`routes.ts` `/api/databases/open`), and it only proceeds at all if the
		// read-only probe admitted the version.
		const file = fixtureCopy("registered.db");
		expect(await probeMemoryDb(file)).toMatchObject({ ok: true, schemaVersion: "2" });

		const registry = new StoreRegistry({ policy: { roots: [workdir], allowAnyPath: false } });
		try {
			const entry = await registry.register(file);
			expect(entry.store.getKv("schema_version")).toBe(SCHEMA_VERSION);
			// `registry.closeAll()` in the `finally` owns this connection — do NOT
			// also push it into `open`, or afterEach would double-close it.
			expect(count(entry.store.db, "SELECT COUNT(*) AS c FROM node_fts")).toBeGreaterThan(0);
			expect(entry.store.effectiveDisclosure("core://a")).toBe("node-level A");
		} finally {
			registry.closeAll();
		}
	});
});

describe("v3 → v4 in-place migration", () => {
	/** Build a real v3-shaped database: current tables minus the v4 revision columns. */
	async function openV3(name = "memory-v3.db"): Promise<MemoryDatabase> {
		const db = await openDatabase(path.join(workdir, name));
		open.push(db);
		db.exec(`
			CREATE TABLE memory_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT);
			CREATE TABLE nodes (
				node_id TEXT PRIMARY KEY,
				parent_id TEXT,
				domain TEXT NOT NULL,
				uri TEXT NOT NULL UNIQUE,
				content TEXT NOT NULL,
				disclosure TEXT,
				importance INTEGER NOT NULL DEFAULT 5,
				source TEXT NOT NULL CHECK(source IN ('auto','manual','import')),
				model TEXT,
				anchor_entry_id TEXT,
				anchor_session_id TEXT,
				first_raw_id INTEGER,
				last_raw_id INTEGER,
				created_at TEXT NOT NULL,
				world_ts TEXT,
				updated_ts TEXT NOT NULL,
				last_accessed_at TEXT,
				content_hash TEXT NOT NULL,
				is_stub INTEGER NOT NULL DEFAULT 0
			);
			CREATE TABLE node_revisions (
				node_id TEXT NOT NULL,
				version INTEGER NOT NULL,
				uri TEXT,
				content TEXT NOT NULL,
				editor_source TEXT,
				editor_model TEXT,
				created_at TEXT NOT NULL,
				PRIMARY KEY (node_id, version)
			);
			CREATE TABLE aliases (
				alias_uri TEXT PRIMARY KEY,
				target_node_id TEXT NOT NULL,
				disclosure TEXT
			);
			CREATE TABLE edges (
				node_id TEXT NOT NULL,
				target_uri TEXT NOT NULL,
				kind TEXT,
				disclosure TEXT,
				PRIMARY KEY (node_id, target_uri)
			);
		`);
		db.exec(NODE_FTS_DDL);
		db.prepare(
			"INSERT INTO nodes (node_id, domain, uri, content, importance, source, created_at, updated_ts, content_hash) VALUES ('n1', 'history', 'history://a', 'v3 正文', 6, 'manual', 't', 't', 'h')",
		).run();
		db.prepare(
			"INSERT INTO node_revisions (node_id, version, uri, content, editor_source, editor_model, created_at) VALUES ('n1', 1, 'history://a', 'v3 修订前', 'manual', null, 't')",
		).run();
		setKv(db, "schema_version", "3");
		return db;
	}

	it("adds the snapshot + anchor columns in place, keeps every row, does NOT rebuild FTS", async () => {
		const db = await openV3();
		const result = createSchema(db);
		expect(result.migratedFrom).toBe("3");
		// v3 node_fts already has the disclosure column — no DROP, no rebuild.
		expect(result.ftsRebuildPending).toBe(false);
		expect(kv(db, FTS_REBUILD_KEY)).toBeNull();
		expect(kv(db, "schema_version")).toBe(SCHEMA_VERSION);
		for (const column of [
			"importance",
			"disclosure",
			"world_ts",
			"updated_ts",
			"anchor_entry_id",
			"anchor_session_id",
		]) {
			expect(cols(db, "node_revisions")).toContain(column);
		}
		// Old rows keep NULL in every new column — the projection treats them
		// as "applies unconditionally".
		const rev = db.prepare("SELECT content, importance, anchor_session_id FROM node_revisions").get() as Record<
			string,
			unknown
		>;
		expect(rev.content).toBe("v3 修订前");
		expect(rev.importance).toBeNull();
		expect(rev.anchor_session_id).toBeNull();
		expect(db.prepare("SELECT content FROM nodes").get()).toMatchObject({ content: "v3 正文" });
	});

	it("the migrated store opens and the projection skips NULL-anchored rows", async () => {
		const db = await openV3("memory-v3-store.db");
		createSchema(db);
		const store = new MemoryStore(db);
		expect(store.getKv("schema_version")).toBe(SCHEMA_VERSION);
		// n1 has no session-anchored revisions → nothing to project.
		expect(store.reconcileNodeProjections("s1", ["e1"])).toBe(0);
	});

	it("MIGRATABLE_FROM admits v2 and v3 together", () => {
		expect(MIGRATABLE_FROM).toContain("2");
		expect(MIGRATABLE_FROM).toContain("3");
	});
});
