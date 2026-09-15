/**
 * V1 / V2 / V10 — the data-safety falsification pair, and the roots path policy.
 *
 * Source of truth: `plan/memory-web/15-多库测试与文档.md` §3.1, §3.2, §3.5 and
 * `12-多库安全与路径校验.md` §9.1/§9.2. Read those before changing an assertion.
 *
 * Three rules this file exists to honour, each learned from a measured failure:
 *
 * ⚠️ **The fingerprint is the MAIN FILE** (md5 + table set + size). It is NOT a
 *    `readdir` listing. A read-only probe of a WAL db leaves `-wal`/`-shm`
 *    behind (contract §2.4b, re-measured for this feature), so comparing file
 *    listings would red-flag this feature's OWN dbs. Do not "improve" this into
 *    a directory comparison.
 * ⚠️ **The fingerprint reader itself MUST open read-only.** Opening writable to
 *    read the table set would make V2a a "change then compare" test that passes
 *    on a corrupted file.
 * ⚠️ **V2c is a POSITIVE CONTROL, not an extra case.** Without it, "the file did
 *    not change" is satisfied by a registration entry point that throws early —
 *    a test that rewards doing nothing. V2c calls `openMemoryStore` directly and
 *    proves the destruction is real. It fails if `openMemoryStore` stops
 *    flood-tabling strangers, and that is a signal, not a regression: contract
 *    Q1 freezes that behaviour on purpose (fixing it would touch pi's main path).
 *
 * V10 asserts REJECTS AND ACCEPTS IN PAIRS (design §3.5): a test that only
 * rejects rewards "refuse everything"; a test that only accepts rewards
 * "trust path.resolve". Only both together pin the consistency check.
 *
 * No fixture reaches outside `mkdtemp` (contract §7.5): nothing here asserts a
 * real-machine path, and no case depends on a real memory db existing.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openMemoryStore } from "../../src/index.ts";
import { checkPathAllowed, type PathPolicy } from "../../src/web/db-path-policy.ts";
import { type RunningServer, startServer } from "../../src/web/server.ts";

// ── fixtures ────────────────────────────────────────────────────────────────

/**
 * A plain SQLite file that is NOT a memory db: one table, so "did it get
 * flood-tabled?" is answerable by counting tables. `journal_mode` stays
 * `delete` (measured), so a read-only probe does not even leave `-wal`/`-shm`.
 */
function makePlainSqlite(file: string): string {
	mkdirSync(path.dirname(file), { recursive: true });
	const db = new DatabaseSync(file);
	db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)");
	db.exec("INSERT INTO users (name) VALUES ('ada')");
	db.close();
	return file;
}

interface Fingerprint {
	md5: string;
	tables: string[];
	size: number;
}

/** Main-file fingerprint. See the header: md5 + table set + size, never a listing. */
function fingerprint(file: string): Fingerprint {
	const ro = new DatabaseSync(file, { readOnly: true });
	let tables: string[];
	try {
		const rows = ro.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{
			name: string;
		}>;
		tables = rows.map((r) => r.name);
	} finally {
		ro.close();
	}
	return {
		md5: createHash("md5").update(readFileSync(file)).digest("hex"),
		tables,
		size: statSync(file).size,
	};
}

/** The frozen `memory_*` set is what "flood-tabled" means; membership beats a count. */
const MEMORY_TABLES = ["nodes", "memory_kv", "audit_log", "node_revisions", "edges", "aliases", "glossary"];

/** Build a real, empty memory db on disk (schema created, then the handle closed). */
async function makeMemoryDb(file: string): Promise<string> {
	mkdirSync(path.dirname(file), { recursive: true });
	const store = await openMemoryStore(file);
	store.db.close();
	return file;
}

// ── response typing ─────────────────────────────────────────────────────────

interface ApiError {
	code: string;
	message: string;
}

interface OpenedBody {
	path: string;
}

/**
 * The parsed response. `T` is the payload a case asserts on; `error` is always
 * allowed because every refusal path carries it.
 */
interface Result<T> {
	status: number;
	body: T & { error?: ApiError };
	text: string;
}

/** Error-only responses: nothing beyond `error` is asserted on. */
type EmptyBody = Record<string, unknown>;

interface DatabasesBody {
	databases: Array<{ path: string; registered: boolean }>;
}

// ── harness ─────────────────────────────────────────────────────────────────

let server: RunningServer;
let workdir: string;
/** The process db ("--db"). It is a real file, so `registryOf`'s fallback adopts it. */
let processDb: string;
/** The policy's single root; every fixture lives under it unless stated otherwise. */
let roots: string;

const policy = (): PathPolicy => ({ roots: [roots], allowAnyPath: false });

/** Same encoder the frontend uses (contract §7.7): never string-concatenated. */
function dbQuery(value: string): string {
	return new URLSearchParams({ db: value }).toString();
}

/**
 * Raw `node:http`, not `fetch`: several cases forge `Host`, and undici refuses a
 * caller-set `Host` (the same reason `security.test.ts` uses this shape).
 */
async function call<T>(
	pathname: string,
	init: { method?: string; host?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Result<T>> {
	const url = new URL(server.url);
	const headers: Record<string, string> = { Host: init.host ?? `127.0.0.1:${url.port}`, ...init.headers };
	if (init.body !== undefined && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
	const { promise, resolve, reject } = Promise.withResolvers<{ status: number; text: string }>();
	const req = httpRequest(
		{ hostname: url.hostname, port: url.port, path: encodeURI(pathname), method: init.method ?? "GET", headers },
		(res) => {
			const chunks: Buffer[] = [];
			res.on("data", (chunk: Buffer) => chunks.push(chunk));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
		},
	);
	req.on("error", reject);
	if (init.body !== undefined) req.write(init.body);
	req.end();
	const response = await promise;
	const parsed: unknown =
		response.text.startsWith("{") || response.text.startsWith("[") ? JSON.parse(response.text) : {};
	const body =
		typeof parsed === "object" && parsed !== null
			? (parsed as T & { error?: ApiError })
			: ({} as T & { error?: ApiError });
	return { status: response.status, body, text: response.text };
}

/** Rebuild the server with a different policy (V10d needs a symlinked root). */
async function bootServer(pathPolicy: PathPolicy, dbPath = processDb): Promise<RunningServer> {
	return startServer(
		{
			store: await openMemoryStore(dbPath),
			dbPath,
			assetsDir: path.join(workdir, "assets"),
			tempThreshold: 10,
			tempThresholdSource: "default",
			startedAt: new Date().toISOString(),
			// No `registry`: `routes.ts` builds the single-db fallback, which is the
			// same path a bare context takes in production.
			pathPolicy,
			bindHost: "127.0.0.1",
		},
		{ port: 0, host: "127.0.0.1" },
	);
}

beforeEach(async () => {
	workdir = mkdtempSync(path.join(tmpdir(), "memweb-probe-"));
	roots = path.join(workdir, "roots");
	mkdirSync(roots, { recursive: true });
	const assets = path.join(workdir, "assets");
	mkdirSync(assets, { recursive: true });
	writeFileSync(path.join(assets, "index.html"), "<!doctype html><title>t</title>");
	processDb = path.join(workdir, "process.db");
	await makeMemoryDb(processDb);
	server = await bootServer(policy());
});

afterEach(async () => {
	await server.close();
	rmSync(workdir, { recursive: true, force: true });
});

// ── V1: an unregistered `?db=` is 404 AND the file is never touched ─────────

describe("V1 · unregistered ?db= is refused without opening the file", () => {
	it("V1a: GET /api/tree?db=<plain sqlite> is 404 not_found", async () => {
		const plain = makePlainSqlite(path.join(workdir, "plain.db"));
		const res = await call<EmptyBody>(`/api/tree?${dbQuery(plain)}`);
		expect(res.status).toBe(404);
		expect(res.body.error?.code).toBe("not_found");
	});

	it("V1b: ⭐ the plain file is byte-identical and table-identical afterwards", async () => {
		const plain = makePlainSqlite(path.join(workdir, "plain.db"));
		const before = fingerprint(plain);
		expect(before.tables).toEqual(["users"]);

		const res = await call<EmptyBody>(`/api/tree?${dbQuery(plain)}`);
		expect(res.status).toBe(404);

		// The whole point: a 404 written into the response proves nothing about
		// whether `openMemoryStore` already ran. Only the file can say that.
		const after = fingerprint(plain);
		expect(after.md5).toBe(before.md5);
		expect(after.tables).toEqual(before.tables);
		expect(after.size).toBe(before.size);
	});

	it("V1c: the refused path is NOT silently registered by the attempt", async () => {
		// Discovery only picks up files literally named `memory.db`, so the fixture
		// that must appear in the listing has to carry that name while still being
		// a plain SQLite file.
		makePlainSqlite(path.join(roots, "somewhere", "memory.db"));

		const res = await call<DatabasesBody>("/api/databases");
		expect(res.status).toBe(200);
		const listed = res.body.databases.find((d) => d.path.endsWith(path.join("somewhere", "memory.db")));
		expect(listed, "discovery should list the plain memory.db under roots").toBeDefined();
		// Present because discovery found it, NOT because the registry admitted it.
		expect(listed?.registered).toBe(false);
	});

	it("V1d: `..`, relative and smuggled-query variants are all 404 and harmless", async () => {
		const plain = makePlainSqlite(path.join(workdir, "plain.db"));
		const before = fingerprint(plain);
		const variants = [
			path.join(roots, "..", "plain.db"), // `..` escape, unregistered
			"./plain.db", // relative
			plain, // plain absolute
			`${plain}?x=1`, // a query smuggled INSIDE the db value (the bad-concat shape)
		];
		for (const variant of variants) {
			const res = await call<EmptyBody>(`/api/meta?${dbQuery(variant)}`);
			expect(res.status, variant).toBe(404);
			expect(res.body.error?.code, variant).toBe("not_found");
		}
		const after = fingerprint(plain);
		expect(after.md5).toBe(before.md5);
		expect(after.tables).toEqual(before.tables);
	});
});

// ── V2: a plain SQLite file is never flood-tabled (with positive control) ───

describe("V2 · a stranger's SQLite file is never written into", () => {
	it("V2a: ⭐ POST /api/databases/open is 400 and the file is untouched", async () => {
		const plain = makePlainSqlite(path.join(roots, "plain.db"));
		const before = fingerprint(plain);

		const res = await call<EmptyBody>("/api/databases/open", {
			method: "POST",
			body: JSON.stringify({ path: plain }),
		});
		expect(res.status).toBe(400);
		expect(res.body.error?.code).toBe("bad_request");
		expect(res.body.error?.message).toContain(plain);

		const after = fingerprint(plain);
		expect(after.md5).toBe(before.md5);
		expect(after.tables).toEqual(before.tables);
		expect(after.tables.filter((t) => MEMORY_TABLES.includes(t))).toEqual([]);
	});

	it("V2b: the `?db=` entry point is closed too (both doors, not one)", async () => {
		const plain = makePlainSqlite(path.join(roots, "plain.db"));
		const before = fingerprint(plain);
		const res = await call<EmptyBody>(`/api/tree?${dbQuery(plain)}`);
		expect(res.status).toBe(404);
		const after = fingerprint(plain);
		expect(after.md5).toBe(before.md5);
		expect(after.tables).toEqual(before.tables);
	});

	it("V2c: ⭐ POSITIVE CONTROL — openMemoryStore really does flood-table a stranger", async () => {
		// This is the only case in the matrix that asserts the EXISTING
		// implementation is destructive. That behaviour is frozen (contract Q1:
		// not fixed, because changing it touches pi's main path), so this is not a
		// bug report — it is the proof that V2a/V2b's "unchanged" is not vacuous.
		const plain = makePlainSqlite(path.join(workdir, "control.db"));
		const before = fingerprint(plain);
		expect(before.tables).toEqual(["users"]);

		const store = await openMemoryStore(plain);
		store.db.close();

		const after = fingerprint(plain);
		expect(after.md5).not.toBe(before.md5);
		expect(after.tables.length).toBeGreaterThan(before.tables.length);
		for (const table of MEMORY_TABLES) expect(after.tables, table).toContain(table);
		// Flood-tabling ADDS tables; it does not replace the file.
		expect(after.tables).toContain("users");
	});
});

// ── V10: roots policy = per-segment real resolution + consistency check ─────

describe("V10 · roots path policy (rejects and accepts, in pairs)", () => {
	/** Create `<workdir>/outside/secret.db` and a roots-internal symlink pointing at it. */
	function linkOutside(linkName: string, targetFile = "secret.db"): string {
		const outside = path.join(workdir, "outside");
		mkdirSync(outside, { recursive: true });
		const link = path.join(roots, linkName);
		mkdirSync(path.dirname(link), { recursive: true });
		// Relative on purpose: the link is what the kernel walks, so "points
		// outside" must hold regardless of how the absolute path was spelled.
		symlinkSync(path.relative(path.dirname(link), outside), link);
		return path.join(outside, targetFile);
	}

	function openVia(pathArg: string): Promise<Result<OpenedBody>> {
		return call<OpenedBody>("/api/databases/open", { method: "POST", body: JSON.stringify({ path: pathArg }) });
	}

	function createVia(pathArg: string): Promise<Result<OpenedBody>> {
		return call<OpenedBody>("/api/databases/create", {
			method: "POST",
			body: JSON.stringify({ path: pathArg, confirm: true }),
		});
	}

	it("V10a: ⭐ an ambiguous `..` across a symlink is REJECTED (B13)", async () => {
		// The measured escape: `path.resolve` folds `..` lexically (staying visibly
		// inside roots) while the kernel walks the symlink first and steps back to
		// <workdir>/outside — a real, readable escape. Both earlier implementations
		// admitted it.
		const secret = linkOutside("link"); // roots/link -> <workdir>/outside
		makePlainSqlite(secret);
		const before = fingerprint(secret);

		const res = await openVia(path.join(roots, "link", "..", "outside", "secret.db"));
		expect(res.status).toBe(400);
		expect(res.body.error?.code).toBe("bad_request");

		const after = fingerprint(secret);
		expect(after.md5).toBe(before.md5);
		expect(after.tables).toEqual(before.tables); // not opened, let alone flood-tabled
	});

	it("V10b: ⭐ an unambiguous `..` is ACCEPTED (B14)", async () => {
		// The other half of V10a. A "refuse any path containing `..`" implementation
		// passes V10a and fails here — and users paste `..` paths constantly.
		const good = await makeMemoryDb(path.join(roots, "real", "good.db"));
		mkdirSync(path.join(roots, "sub"), { recursive: true });

		const res = await openVia(path.join(roots, "sub", "..", "real", "good.db"));
		expect(res.status).toBe(200);
		expect(res.body.path).toBe(good);
	});

	it("V10c: a dangling symlink under roots is REJECTED (B15)", async () => {
		symlinkSync(path.join(workdir, "does-not-exist"), path.join(roots, "dangling"));
		const res = await openVia(path.join(roots, "dangling", "x.db"));
		expect(res.status).toBe(400);
	});

	it("V10d: ⭐ a root that IS a symlink is ACCEPTED, not mis-refused (B12)", async () => {
		// Realpath-ing the root and then comparing against the real candidate is the
		// tempting shape that fails here: it refuses every path under a linked root.
		const realDir = path.join(workdir, "real-root");
		mkdirSync(realDir, { recursive: true });
		const good = await makeMemoryDb(path.join(realDir, "x.db"));
		const linkedRoot = path.join(workdir, "linked-root");
		symlinkSync(realDir, linkedRoot);

		await server.close();
		server = await bootServer({ roots: [linkedRoot], allowAnyPath: false });

		const res = await openVia(good);
		expect(res.status).toBe(200);
	});

	it("V10e: a direct and a deep symlink escape are both REJECTED (B5/B16)", async () => {
		const direct = linkOutside("link2");
		makePlainSqlite(direct);
		const deep = linkOutside(path.join("sub", "up"), "deep-secret.db");
		makePlainSqlite(deep);

		for (const candidate of [path.join(roots, "link2", "secret.db"), path.join(roots, "sub", "up", "secret.db")]) {
			const res = await openVia(candidate);
			expect(res.status, candidate).toBe(400);
		}
		expect(fingerprint(direct).tables).toEqual(["users"]);
		expect(fingerprint(deep).tables).toEqual(["users"]);
	});

	it("V10f: a symlink staying INSIDE roots is ACCEPTED (B6)", async () => {
		await makeMemoryDb(path.join(roots, "real", "good.db"));
		symlinkSync(path.join(roots, "real"), path.join(roots, "linkin"));

		const res = await openVia(path.join(roots, "linkin", "good.db"));
		expect(res.status).toBe(200);
	});

	it("V10g: a nonexistent create target is not refused for being missing (B8)", async () => {
		// Policy level: `realpathSync` throws ENOENT on a missing path, so a naive
		// realpath-based containment check kills every `create`.
		const target = path.join(roots, "new", "deep", "x.db");
		expect(checkPathAllowed(policy(), target).ok).toBe(true);

		// Route level: `create` requires the PARENT to exist (it refuses to
		// `mkdir -p`, contract §5.3), so the reachable shape is a missing file in
		// an existing directory. Both halves are needed — the first pins the policy,
		// the second pins that `create` is not dead.
		mkdirSync(path.join(roots, "new"), { recursive: true });
		const res = await createVia(path.join(roots, "new", "created.db"));
		expect(res.status).toBe(200);
	});

	it("V10h: a create target behind a symlink out of roots is REJECTED", async () => {
		const outside = path.join(workdir, "outside");
		mkdirSync(outside, { recursive: true });
		symlinkSync(outside, path.join(roots, "escapelink"));

		const res = await createVia(path.join(roots, "escapelink", "new.db"));
		expect(res.status).toBe(400);
		expect(res.body.error?.code).toBe("bad_request");
		// Nothing was created outside.
		expect(() => statSync(path.join(outside, "new.db"))).toThrow();
	});
});
