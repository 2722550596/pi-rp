/**
 * V3 / V6 — one connection per path, an LRU cap, and "eviction ≠ deregistration".
 *
 * Source of truth: `plan/memory-web/15-多库测试与文档.md` §3.1 (V3, V6), with the
 * fixture shape from `11-多库发现与注册表.md` §9 (C7/C8/C15/C16/C17).
 *
 * What each case defends, in the order they appear:
 *  - V3: a per-request store would drift the `PRAGMA data_version` baseline, so
 *    `/api/events` would report `changed: false` forever. Reference equality is
 *    the only assertion that catches it.
 *  - V3b: a registry that caches the entry object but rebuilds the store on every
 *    request looks "deduped" and still breaks the baseline.
 *  - V3c: the detector is a `WeakMap` keyed by store, so "one connection per
 *    path" is also what keeps `changed` from cross-contaminating two DBs.
 *  - V6a: fd exhaustion / a slow start when dozens of DBs exist.
 *  - V6b: implementing "evict" as "forget the registration" makes the next
 *    switch back a 404. Eviction must drop the CONNECTION, not the path.
 *  - V6d: the fail-open regression. `policy` is required so omitting it is a
 *    compile error — the exact shape this feature already shipped once.
 *  - V6e: the registry really consults the policy it was given (test-green /
 *    production-dead-code is the failure mode this feature has hit twice).
 *  - V6f: the CONTROL that makes "openCount <= limit" meaningful. Eviction is
 *    driven by `release()`, so the same sequence WITHOUT releases must exceed the
 *    cap — otherwise a registry that never evicts would still look capped.
 *
 * ⚠️ `resolve` requires a REGISTERED path (it returns null otherwise, and D3 maps
 *    that to 404). Every fixture therefore registers first — which is also how
 *    the real request path works.
 * ⚠️ `resolve` also stats first, so a removed file throws `DbUnavailableError`
 *    instead of silently recreating an empty DB (D1's measured finding). Never
 *    `rm` a fixture mid-test except in the case that asserts exactly that.
 * ⚠️ V6 fixtures, where "how many are open" is asserted, all carry a node, so
 *    "empty DB" never becomes an accidental contract under test (§11-U4 is open).
 */
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openMemoryStore } from "../../src/index.ts";
import { checkPathAllowed, type PathPolicy } from "../../src/web/db-path-policy.ts";
import { DbUnavailableError, StoreRegistry } from "../../src/web/registry.ts";
import { startServer } from "../../src/web/server.ts";

// ── fixtures ────────────────────────────────────────────────────────────────

/** A real memory db with one node, so it is never mistaken for an empty DB. */
async function makeMemoryDb(file: string, uri = "core://seed"): Promise<string> {
	mkdirSync(path.dirname(file), { recursive: true });
	const store = await openMemoryStore(file);
	store.put({ uri, content: "种子节点" });
	store.db.close();
	return file;
}

/** A plain SQLite file (not a memory db) — used only as a hardlink target. */
function makeStrangerDb(file: string): string {
	mkdirSync(path.dirname(file), { recursive: true });
	const db = new DatabaseSync(file);
	db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY)");
	db.close();
	return file;
}

let workdir: string;
let dbsDir: string;

function registryFor(options: { limit?: number; policy?: PathPolicy } = {}): StoreRegistry {
	return new StoreRegistry({
		limit: options.limit,
		policy: options.policy ?? { roots: [dbsDir], allowAnyPath: false },
	});
}

/** Register + resolve + release in one step: the shape of a completed request. */
async function borrow(registry: StoreRegistry, file: string): Promise<void> {
	const entry = await registry.register(file);
	registry.release(entry);
}

beforeEach(() => {
	workdir = mkdtempSync(path.join(tmpdir(), "memweb-registry-"));
	dbsDir = path.join(workdir, "dbs");
	mkdirSync(dbsDir, { recursive: true });
});

afterEach(() => {
	rmSync(workdir, { recursive: true, force: true });
});

// ── V3: one connection per path ─────────────────────────────────────────────

describe("V3 · one path, one connection", () => {
	it("V3a: two resolves of the same path return the same entry AND the same store", async () => {
		const file = await makeMemoryDb(path.join(dbsDir, "a.db"));
		const registry = registryFor();
		await registry.register(file);

		const a = await registry.resolve(file);
		const b = await registry.resolve(file);

		expect(a).not.toBeNull();
		// `toBe` on both: a registry that returns a fresh entry object per request
		// (or a fresh store) breaks the `data_version` baseline that makes
		// `/api/events` mean anything.
		expect(b).toBe(a);
		expect(b?.store).toBe(a?.store);
		expect(registry.openCount).toBe(1);
		if (a) registry.release(a);
		if (b) registry.release(b);
	});

	it("V3a: concurrent resolves dedupe to one connection", async () => {
		const file = await makeMemoryDb(path.join(dbsDir, "concurrent.db"));
		const registry = registryFor();
		await registry.register(file);

		// In-flight promise dedupe, not a lock: the synchronous section up to the
		// `inflight` map cannot be interleaved, so this must collapse to one open.
		const [a, b] = await Promise.all([registry.resolve(file), registry.resolve(file)]);
		expect(a).toBe(b);
		expect(registry.openCount).toBe(1);
		if (a) registry.release(a);
		if (b) registry.release(b);
	});

	it("V3b: the entry from `entryOf` IS the entry `resolve` hands out", async () => {
		const file = await makeMemoryDb(path.join(dbsDir, "same.db"));
		const registry = registryFor();
		const entry = await registry.register(file);

		// `entryOf` is the pure lookup the route layer uses to decide "already open".
		expect(registry.entryOf(file)?.store).toBe(entry.store);
		// It must not open anything, and it normalizes its own input (so a caller
		// never needs to resolve the path first).
		expect(registry.entryOf(path.join(dbsDir, ".", "same.db"))?.store).toBe(entry.store);
		expect((await registry.resolve(file))?.store).toBe(entry.store);
		registry.release(entry);
	});

	it("V3c: /api/events `changed` is per-db, not shared", async () => {
		// End-to-end, because the detector is a `WeakMap` keyed by store inside
		// `runtime.ts` — only a real request can observe the keying.
		const aFile = await makeMemoryDb(path.join(dbsDir, "a.db"), "core://a");
		const bFile = await makeMemoryDb(path.join(dbsDir, "b.db"), "core://b");
		const assets = path.join(workdir, "assets");
		mkdirSync(assets, { recursive: true });
		const processDb = path.join(workdir, "process.db");
		const processStore = await openMemoryStore(processDb);

		const server = await startServer(
			{
				store: processStore,
				dbPath: processDb,
				assetsDir: assets,
				tempThreshold: 10,
				tempThresholdSource: "default",
				startedAt: new Date().toISOString(),
				pathPolicy: { roots: [dbsDir], allowAnyPath: false },
				bindHost: "127.0.0.1",
			},
			{ port: 0, host: "127.0.0.1" },
		);
		try {
			// Register through the real endpoint: that is the only door into `?db=`.
			for (const db of [aFile, bFile]) {
				const res = await fetch(`${server.url}/api/databases/open`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ path: db }),
				});
				expect(res.status, db).toBe(200);
			}
			const events = async (db: string): Promise<{ version: number; changed: boolean }> => {
				const res = await fetch(`${server.url}/api/events?${new URLSearchParams({ db })}`);
				expect(res.status).toBe(200);
				return (await res.json()) as { version: number; changed: boolean };
			};

			expect((await events(aFile)).changed).toBe(false); // first read: no baseline yet
			// A write through a DIFFERENT connection to A ⇒ A reports a change.
			const sideStore = await openMemoryStore(aFile);
			sideStore.put({ uri: "core://a/extra", content: "外部写入" });
			sideStore.db.close();
			expect((await events(aFile)).changed).toBe(true);
			// B has its own detector: A's write must not leak into B.
			expect((await events(bFile)).changed).toBe(false);
			// And switching back does not re-report (the baseline survived).
			expect((await events(aFile)).changed).toBe(false);
		} finally {
			await server.close();
		}
	});
});

// ── V6: the cap, eviction-vs-deregistration, and a wired-up policy ──────────

describe("V6 · open cap and eviction semantics", () => {
	async function seed(count: number, prefix: string): Promise<string[]> {
		const files: string[] = [];
		for (let i = 0; i < count; i++) {
			files.push(await makeMemoryDb(path.join(dbsDir, `${prefix}${i}.db`), `core://${prefix}${i}`));
		}
		return files;
	}

	it("V6a: with limit 2, three DBs never leave more than 2 open", async () => {
		const registry = registryFor({ limit: 2 });
		for (const file of await seed(3, "l")) await borrow(registry, file);
		expect(registry.openCount).toBeLessThanOrEqual(2);
	});

	it("V6b: ⭐ eviction drops the CONNECTION, not the registration", async () => {
		const registry = registryFor({ limit: 2 });
		const files = await seed(3, "e");
		for (const file of files) await borrow(registry, file);

		// The first path is now evicted. `has` = "registered" (stays true);
		// `entryOf` = "has a live connection" (becomes null). Conflating the two is
		// the bug that turns a switch-back into a 404.
		expect(registry.has(files[0])).toBe(true);
		expect(registry.entryOf(files[0])).toBeNull();
		expect(registry.list().some((r) => r.path === path.resolve(files[0]))).toBe(true);
	});

	it("V6c: a re-resolve after eviction re-opens and stays under the cap", async () => {
		const registry = registryFor({ limit: 2 });
		const files = await seed(3, "r");
		for (const file of files) await borrow(registry, file);

		const again = await registry.resolve(files[0]);
		expect(again).not.toBeNull();
		expect(registry.openCount).toBeLessThanOrEqual(2);
		if (again) registry.release(again);
	});

	it("V6d: ⭐ omitting `policy` is a compile error (fail-closed by type)", () => {
		// `@ts-expect-error` is the whole assertion: it turns red the moment
		// `policy` (or the options container) becomes optional, which is the
		// fail-open shape this feature has already shipped once.
		// The construction is inside `expect(…).toThrow()` as well, because the
		// shipped constructor ALSO refuses at runtime: a caller who bypasses the
		// type system must not get a registry that silently skips the check.
		expect(
			// @ts-expect-error — `policy` is required: omitting it MUST NOT compile.
			() => new StoreRegistry({}),
		).toThrow(/policy/);

		// @ts-expect-error — the container itself is required too: `opts?` would let
		// `new StoreRegistry()` compile and then fail at runtime, which cancels the
		// guarantee above ("a required field inside an optional container is not
		// actually required").
		expect(() => new StoreRegistry()).toThrow();
	});

	it("V6e: ⭐ a policy that rejects the path proves the registry consults it", async () => {
		const file = await makeMemoryDb(path.join(dbsDir, "real.db"));
		// A policy whose only root is somewhere else entirely. Both entry points
		// must refuse: if either silently skipped `checkPathAllowed`, the guard
		// would be dead code in production while every test stayed green.
		const rejecting = registryFor({ policy: { roots: ["/definitely/not/this/dir"], allowAnyPath: false } });
		await expect(rejecting.register(file)).rejects.toMatchObject({ reason: "path-escalated" });

		// CONTROL: the identical sequence under `allowAnyPath` must succeed, so the
		// rejection above cannot be explained by something else refusing the path.
		const permissive = registryFor({ policy: { roots: [], allowAnyPath: true } });
		const entry = await permissive.register(file);
		expect(entry.store).toBeDefined();
		permissive.release(entry);
	});

	it("V6e2: ⭐ re-pointing a registered symlink out of roots is refused on REOPEN (R5)", async () => {
		// The lifecycle hole R5 closes: the guard ran once at registration, and the
		// link is re-pointed afterwards. No race is won here — the next open simply
		// happens later, which is what an LRU eviction guarantees will occur.
		const real = await makeMemoryDb(path.join(dbsDir, "real.db"));
		const link = path.join(dbsDir, "swap.db");
		symlinkSync(real, link);
		const outside = makeStrangerDb(path.join(workdir, "outside", "victim.db"));

		const registry = registryFor({ limit: 1 });
		await registry.register(link); // legal at registration time
		expect(registry.entryOf(link)).not.toBeNull();

		// Re-point the link, then force a reopen by registering a second db.
		unlinkSync(link);
		symlinkSync(outside, link);
		await borrow(registry, await makeMemoryDb(path.join(dbsDir, "other.db"), "core://other"));

		await expect(registry.resolve(link)).rejects.toMatchObject({ reason: "path-escalated" });
		// The victim was never opened, so it still has exactly its one table.
		const ro = new DatabaseSync(outside, { readOnly: true });
		const rows = ro.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
		ro.close();
		expect(rows.map((r) => r.name)).toEqual(["users"]);
	});

	it("V6f: ⭐ CONTROL — held leases exceed the cap (eviction is lease-driven)", async () => {
		const registry = registryFor({ limit: 2 });
		const files = await seed(6, "n");

		// Same sequence as V6a EXCEPT the lease is never returned: `register`
		// registers + opens, `resolve` then raises the refcount and nothing lowers
		// it. No entry is evictable, so the cap is exceeded.
		//
		// This is the control that makes V6a non-vacuous. It is also the observable
		// shape of "D3 forgot `release(entry)` in the dispatch `finally`": the
		// refcount only grows, so eviction never fires and openCount climbs — a
		// silent DEGRADATION (fd growth), not an error, which is why it needs a
		// control case to be visible at all.
		for (const file of files) {
			await registry.register(file);
			await registry.resolve(file);
		}
		expect(registry.openCount).toBeGreaterThan(2);
	});

	it("V6 control: a db whose file vanished throws instead of being silently recreated", async () => {
		const file = await makeMemoryDb(path.join(dbsDir, "gone.db"));
		const registry = registryFor();
		await registry.register(file);
		rmSync(file);

		await expect(registry.resolve(file)).rejects.toThrow(DbUnavailableError);
		await expect(registry.resolve(file)).rejects.toMatchObject({ reason: "missing" });
		// Not silently removed from the registry (contract §3.2#5).
		expect(registry.has(file)).toBe(true);
	});

	it("V6 control: a hardlink is refused at REGISTRATION, but a later hardlink still resolves", async () => {
		// The pair matters: refusing hardlinks at registration is the guard; NOT
		// re-checking it on every resolve is what keeps `cp -al` / `rsync
		// --link-dest` users from losing access to their own DB (design §8.2c).
		const victim = makeStrangerDb(path.join(workdir, "victim.db"));
		const linked = path.join(dbsDir, "linked.db");
		linkSync(victim, linked);

		const registry = registryFor();
		await expect(registry.register(linked)).rejects.toMatchObject({ reason: "hardlink" });

		// The nlink guard lives in `admitForRegistration`, which `checkPathAllowed`
		// must NOT call: a policy check on a 2-link file still admits it.
		expect(checkPathAllowed({ roots: [dbsDir], allowAnyPath: false }, linked).ok).toBe(true);

		// A path that BECOMES hardlinked after registration keeps resolving — that
		// is the `cp -al` backup user whose DB must keep working.
		const single = await makeMemoryDb(path.join(dbsDir, "backed-up.db"));
		await registry.register(single);
		linkSync(single, path.join(dbsDir, "backup-copy.db"));
		const entry = await registry.resolve(single);
		expect(entry).not.toBeNull();
		if (entry) registry.release(entry);
	});
});
