/**
 * V4 / V5 / V8c / V14c / V15 — the server-side multi-db contract.
 *
 * Source of truth: `plan/memory-web/15-多库测试与文档.md` §3.1, §3.3, §3.8, plus
 * `12-多库安全与路径校验.md` §9.3 (C1–C5) and §9.4 (D1–D5).
 *
 * ⚠️ **The non-loopback cases MUST forge a LOOPBACK `Host`.** `checkHost` is a
 *    literal whitelist (`localhost|127.0.0.1|[::1]`) that is independent of
 *    `--host`, so a `Host: 0.0.0.0:port` request would be 403 by S2 — and every
 *    "the management route is 403" assertion would pass for the WRONG reason.
 *    V5a + V5b + V5d are deliberately three-way for this: 403 on management,
 *    non-403 on a data route, and non-403 on management under a loopback bind.
 *    Drop any one and V5 either fake-greens or fake-reds.
 * ⚠️ **V5c MUST have a positive control** (V5d's sibling below): first register a
 *    second db under a LOOPBACK bind and assert `?db=` returns 200. Without it,
 *    a 404 under a non-loopback bind is indistinguishable from "never registered"
 *    — the exact fake-green this feature was already bitten by.
 * ⚠️ The gate reads `ctx.bindHost` (the CLI `--host`), never `req.headers.host`:
 *    S2 has already forced the header to loopback, so gating on it would be dead
 *    code that no test could distinguish. This file can only inject the value
 *    through `startServer(..., { host })` / `ctx.bindHost`, which is why it does.
 * ⚠️ Raw `node:http`, not `fetch`: undici refuses a caller-set `Host`, and forging
 *    `Host`/`Origin` is what several of these cases exist to do.
 */
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openMemoryStore } from "../../src/index.ts";
import { StoreRegistry } from "../../src/web/registry.ts";
import { ERROR_CODES, mapStoreError } from "../../src/web/routes.ts";
import { type RunningServer, startServer } from "../../src/web/server.ts";

// ── response typing ─────────────────────────────────────────────────────────

interface ApiError {
	code: string;
	message: string;
}

interface Result<T> {
	status: number;
	body: T & { error?: ApiError };
	headers: Record<string, string | string[] | undefined>;
}

interface MetaBody {
	db_path: string;
}

interface OpenedBody {
	path: string;
}

type EmptyBody = Record<string, unknown>;

// ── harness ─────────────────────────────────────────────────────────────────

let workdir: string;
let dbsDir: string;
let assets: string;
let processDb: string;
/** One store per server we start in a test; closed with the server. */
let servers: RunningServer[] = [];

/** Raw `node:http`; `host` is forgeable so the S2/S4 gates can be told apart. */
async function call<T>(
	base: string,
	pathname: string,
	init: { method?: string; host?: string; origin?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Result<T>> {
	const url = new URL(base);
	const headers: Record<string, string> = { Host: init.host ?? `127.0.0.1:${url.port}`, ...init.headers };
	if (init.origin !== undefined) headers.Origin = init.origin;
	if (init.body !== undefined && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
	const { promise, resolve, reject } = Promise.withResolvers<{
		status: number;
		headers: Record<string, string | string[] | undefined>;
		text: string;
	}>();
	const req = httpRequest(
		// ⚠️ NO `encodeURI` here: callers build their query with
		// `URLSearchParams`, so the string is already encoded — re-encoding would
		// turn `%2F` into `%252F` and every `?db=` value would 404.
		{ hostname: url.hostname, port: url.port, path: pathname, method: init.method ?? "GET", headers },
		(res) => {
			const chunks: Buffer[] = [];
			res.on("data", (chunk: Buffer) => chunks.push(chunk));
			res.on("end", () =>
				resolve({
					status: res.statusCode ?? 0,
					headers: res.headers,
					text: Buffer.concat(chunks).toString("utf8"),
				}),
			);
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
	return { status: response.status, body, headers: response.headers };
}

async function makeMemoryDb(file: string, uri = "core://seed"): Promise<string> {
	mkdirSync(path.dirname(file), { recursive: true });
	const store = await openMemoryStore(file);
	store.put({ uri, content: "种子节点" });
	store.db.close();
	return file;
}

function _makePlainSqlite(file: string): string {
	mkdirSync(path.dirname(file), { recursive: true });
	const db = new DatabaseSync(file);
	db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)");
	db.close();
	return file;
}

/**
 * `bindHost` is the CLI `--host`; the socket always listens on loopback so the
 * request reaches the server. A test that wants "the gate is off" sets
 * `bindHost: "0.0.0.0"` while still connecting over 127.0.0.1.
 */

async function boot(options: { bindHost?: string } = {}): Promise<RunningServer> {
	const store = await openMemoryStore(processDb);
	store.seed();
	return startServer(
		{
			store,
			dbPath: processDb,
			assetsDir: assets,
			tempThreshold: 10,
			tempThresholdSource: "default",
			startedAt: new Date().toISOString(),
			pathPolicy: { roots: [dbsDir], allowAnyPath: false },
			bindHost: options.bindHost ?? "127.0.0.1",
		},
		{ port: 0, host: "127.0.0.1" },
	).then((server) => {
		servers.push(server);
		return server;
	});
}

/** Boot with an INJECTED registry, so a pre-registered db survives the rebind. */
async function startWith(registry: StoreRegistry, bindHost: string): Promise<RunningServer> {
	const store = await openMemoryStore(processDb);
	store.seed();
	const server = await startServer(
		{
			store,
			dbPath: processDb,
			assetsDir: assets,
			tempThreshold: 10,
			tempThresholdSource: "default",
			startedAt: new Date().toISOString(),
			registry,
			pathPolicy: { roots: [dbsDir], allowAnyPath: false },
			bindHost,
		},
		{ port: 0, host: "127.0.0.1" },
	);
	servers.push(server);
	return server;
}

/** Table names of a db, read read-only so the check cannot itself mutate it. */
function tablesOf(file: string): string[] {
	const db = new DatabaseSync(file, { readOnly: true });
	try {
		return (
			db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>
		).map((r) => r.name);
	} finally {
		db.close();
	}
}

/** Register a db through the real endpoint (the only door into `?db=`). */
function register(base: string, file: string): Promise<Result<OpenedBody>> {
	return call<OpenedBody>(base, "/api/databases/open", {
		method: "POST",
		body: JSON.stringify({ path: file }),
	});
}

beforeEach(() => {
	workdir = mkdtempSync(path.join(tmpdir(), "memweb-api-"));
	dbsDir = path.join(workdir, "dbs");
	mkdirSync(dbsDir, { recursive: true });
	assets = path.join(workdir, "assets");
	mkdirSync(assets, { recursive: true });
	processDb = path.join(workdir, "process.db");
	servers = [];
});

afterEach(async () => {
	for (const server of servers.splice(0)) await server.close();
	rmSync(workdir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

// ── V4: no `?db=` still means the process db ────────────────────────────────

describe("V4 · the process db stays the default", () => {
	it("V4a: /api/meta without `?db=` reports the process db", async () => {
		await makeMemoryDb(processDb);
		const server = await boot();
		// A second db exists and is registered: the default must NOT drift to it.
		const second = await makeMemoryDb(path.join(dbsDir, "second.db"));
		expect((await register(server.url, second)).status).toBe(200);

		const res = await call<MetaBody>(server.url, "/api/meta");
		expect(res.status).toBe(200);
		expect(res.body.db_path).toBe(path.resolve(processDb));
	});

	it("V4b: /api/meta?db=<second> reports the SECOND db", async () => {
		await makeMemoryDb(processDb);
		const server = await boot();
		const second = await makeMemoryDb(path.join(dbsDir, "second.db"));
		await register(server.url, second);

		const res = await call<MetaBody>(server.url, `/api/meta?${new URLSearchParams({ db: second })}`);
		expect(res.status).toBe(200);
		expect(res.body.db_path).toBe(path.resolve(second));
	});

	it("V4c: /api/meta?db=<process db> equals the no-parameter response", async () => {
		// The launcher's reuse probe compares `db_path` for exact equality, so a
		// `?db=`-carrying request must not change what it reports.
		await makeMemoryDb(processDb);
		const server = await boot();

		const bare = await call<MetaBody>(server.url, "/api/meta");
		const withParam = await call<MetaBody>(server.url, `/api/meta?${new URLSearchParams({ db: processDb })}`);
		expect(withParam.status).toBe(200);
		expect(withParam.body.db_path).toBe(bare.body.db_path);
	});
});

// ── V5: a non-loopback bind disables multi-db entirely ──────────────────────

describe("V5 · non-loopback bind disables multi-db", () => {
	const MANAGEMENT = ["/api/databases", "/api/databases/open", "/api/databases/create"];

	it("V5a: all three management paths are 403 forbidden_origin under bindHost 0.0.0.0", async () => {
		await makeMemoryDb(processDb);
		const server = await boot({ bindHost: "0.0.0.0" });

		for (const route of MANAGEMENT) {
			// Method matters for the two POSTs, but the gate runs before dispatch.
			const res = await call<EmptyBody>(server.url, route, {
				method: route === "/api/databases" ? "GET" : "POST",
				// ⭐ Loopback Host on purpose: S2 would otherwise 403 first and the
				//    assertion would pass without the S4 gate existing at all.
				host: `127.0.0.1:${new URL(server.url).port}`,
				body: route === "/api/databases" ? undefined : JSON.stringify({}),
			});
			expect(res.status, route).toBe(403);
			expect(res.body.error?.code, route).toBe("forbidden_origin");
		}
	});

	it("V5b: CONTROL — a data route is NOT 403 under the same bind", async () => {
		// Proves V5a's 403 comes from the S4 gate and not from S2 rejecting every
		// path (which is what a forged Host would produce).
		await makeMemoryDb(processDb);
		const server = await boot({ bindHost: "0.0.0.0" });
		const res = await call<MetaBody>(server.url, "/api/tree");
		expect(res.status).not.toBe(403);
		expect(res.status).toBe(200);
	});

	it("V5c: ⭐ `?db=<registered second db>` is refused BY THE GATE, not by absence", async () => {
		// ⚠️ The trap this case exists to avoid: registering under a loopback bind
		//    and then re-booting as non-loopback gives a FRESH registry (the
		//    fallback registry is keyed by ctx), so the 404 comes from "never
		//    registered" — a fake green. The registry must be pre-populated and
		//    then handed to a non-loopback server, and the registration must be
		//    asserted to still be there, or the 404 proves nothing.
		await makeMemoryDb(processDb);
		const second = await makeMemoryDb(path.join(dbsDir, "second.db"), "core://second");
		const registry = new StoreRegistry({ policy: { roots: [dbsDir], allowAnyPath: false } });
		const seeded = await registry.register(second);
		registry.release(seeded);

		const before = tablesOf(second);
		// CONTROL first, on a loopback server sharing the same registry: the same
		// request is 200. Only this makes the 404 below attributable to the gate.
		// ⚠️ That server must NOT be closed before the assertion below —
		//    `close()` calls `registry.closeAll()`, which empties the registry and
		//    would make the 404 look like "never registered" again.
		const loopback = await startWith(registry, "127.0.0.1");
		const control = await call<OpenedBody>(loopback.url, `/api/tree?${new URLSearchParams({ db: second })}`);
		expect(control.status).toBe(200);

		// Same registry, non-loopback bind ⇒ refused.
		const blocked = await startWith(registry, "0.0.0.0");
		const res = await call<EmptyBody>(blocked.url, `/api/tree?${new URLSearchParams({ db: second })}`);
		expect(res.status).toBe(404);
		expect(res.body.error?.code).toBe("not_found");
		// ⭐ The db IS registered, and the process db still works: the 404 is the
		//    gate, not an empty registry.
		expect(registry.entryOf(second)).not.toBeNull();
		expect((await call<MetaBody>(blocked.url, "/api/meta")).status).toBe(200);
		// The 404 must be indistinguishable from "never registered": the message
		// may echo the caller's OWN input path (it is theirs, not ours), but the
		// wording must not differ between the two cases, or a network visitor
		// could enumerate the registry by comparing messages.
		const unregistered = path.join(dbsDir, "never-registered.db");
		const miss = await call<EmptyBody>(blocked.url, `/api/tree?${new URLSearchParams({ db: unregistered })}`);
		expect(miss.status).toBe(404);
		const strip = (message: string, file: string): string => message.split(file).join("<path>");
		expect(res.body.error?.code).toBe(miss.body.error?.code);
		expect(strip(res.body.error?.message ?? "", second)).toBe(strip(miss.body.error?.message ?? "", unregistered));

		expect(tablesOf(second)).toEqual(before);
	});

	it("V5d: ⭐ CONTROL — under a loopback bind the same three paths are NOT 403", async () => {
		// The third leg of the tripod: proves the gate actually READS `bindHost`
		// instead of being a constant. A gate hard-wired to "always on" passes V5a
		// and fails here.
		await makeMemoryDb(processDb);
		const server = await boot({ bindHost: "127.0.0.1" });

		const listRes = await call<EmptyBody>(server.url, "/api/databases");
		expect(listRes.status).toBe(200);
		// The two POSTs are legitimately 400 (missing `path`) — the point is only
		// that the gate did not reject them.
		for (const route of ["/api/databases/open", "/api/databases/create"]) {
			const res = await call<EmptyBody>(server.url, route, { method: "POST", body: JSON.stringify({}) });
			expect(res.status, route).not.toBe(403);
		}
	});

	it("V5e: ⭐ 403 on /api/databases means discovery did NOT run", async () => {
		// Listing paths is itself information disclosure ("this machine has these
		// worlds/characters"), so "403" alone is not enough: the scan must not have
		// happened either. The assertion is on the ROUTE's effect — the response
		// carries no `databases` key, and the sentinel db was never described.
		//
		// ⚠️ A syscall-counting spy is deliberately NOT used: `node:fs` is imported
		//    by name across the module graph, so `vi.spyOn` cannot patch it (ESM
		//    namespaces are frozen — measured), and a `vi.mock` of `node:fs` would
		//    rewrite how every transitive module loads, for one assertion.
		const sentinelDir = path.join(dbsDir, "sentinel");
		mkdirSync(sentinelDir, { recursive: true });
		const sentinelDb = await makeMemoryDb(path.join(sentinelDir, "memory.db"));
		const before = statSync(sentinelDb).mtimeMs;

		const server = await boot({ bindHost: "0.0.0.0" });
		const res = await call<EmptyBody>(server.url, "/api/databases");
		expect(res.status).toBe(403);
		expect(res.body).not.toHaveProperty("databases");

		// The sentinel's main file did not move. A read-only probe of a WAL db
		// leaves `-wal`/`-shm` (contract §2.4b) but never touches the main file, so
		// its mtime is the stable signal that nothing opened it.
		expect(statSync(sentinelDb).mtimeMs).toBe(before);
	});
});

// ── V8c: read paths stay write-free, per db ─────────────────────────────────

describe("V8c · read paths do not write, in either db", () => {
	it("11 GETs against db A leave A's audit/revisions/access columns alone", async () => {
		await makeMemoryDb(processDb);
		const server = await boot();
		const a = await makeMemoryDb(path.join(dbsDir, "a.db"), "core://a");
		const b = await makeMemoryDb(path.join(dbsDir, "b.db"), "core://b");
		await register(server.url, a);
		await register(server.url, b);

		const counts = (file: string): { audit: number; revisions: number; accessed: number } => {
			const db = new DatabaseSync(file, { readOnly: true });
			const one = (sql: string): number => Number((db.prepare(sql).get() as { c: number } | undefined)?.c ?? 0);
			const result = {
				audit: one("SELECT COUNT(*) AS c FROM audit_log"),
				revisions: one("SELECT COUNT(*) AS c FROM node_revisions"),
				accessed: one("SELECT COUNT(*) AS c FROM nodes WHERE last_accessed_at IS NOT NULL"),
			};
			db.close();
			return result;
		};

		const aBefore = counts(a);
		const bBefore = counts(b);

		const gets = [
			"/api/meta",
			"/api/tree",
			"/api/node?uri=core%3A%2F%2Fa",
			"/api/search?q=core",
			"/api/temp",
			"/api/view?name=forgotten",
			"/api/audit",
			"/api/revisions?uri=core%3A%2F%2Fa",
			"/api/raw?limit=5",
			"/api/sessions",
			"/api/events",
		];
		for (const route of gets) {
			const sep = route.includes("?") ? "&" : "?";
			const res = await call<EmptyBody>(server.url, `${route}${sep}${new URLSearchParams({ db: a })}`);
			expect(res.status, route).toBe(200);
		}

		expect(counts(a)).toEqual(aBefore);
		// The cross-contamination half: reading A must not have written B's audit
		// either (one connection per path is what makes that true).
		expect(counts(b)).toEqual(bBefore);
	});
});

// ── V14c: the lock conflict maps to 409, not 500 ────────────────────────────

describe("V14c · `database is locked` maps to conflict (409)", () => {
	it("mapStoreError maps the SQLite lock text to 409 conflict with human text", () => {
		// The pure-function half of V14 (the real lock lives in the slow file).
		// This is the mapping table, i.e. the ONLY implementation point, so a
		// missing branch here is invisible to an end-to-end test that never locks.
		const result = mapStoreError(new Error("database is locked"), {});
		expect(result.status).toBe(409);
		const body = result.body as { error: { code: string; message: string } };
		expect(body.error.code).toBe("conflict");
		// The message must tell the user to retry. Falling through to `internal`
		// would render "the service may not be running or has exited" — a factual
		// falsehood, and the reason this mapping was added with multi-db.
		expect(body.error.message).toContain("稍后重试");
		expect(body.error.message).not.toContain("服务可能未启动");
	});

	it("mapStoreError maps the table-level lock text to the same 409", () => {
		const result = mapStoreError(new Error("database table is locked"), {});
		expect(result.status).toBe(409);
		expect((result.body as { error: { code: string } }).error.code).toBe("conflict");
	});

	it("no new error code was introduced", () => {
		// The closed set is frozen at seven (contract §4.6). `conflict` already
		// exists, so this change needs no eighth code.
		expect([...ERROR_CODES]).toEqual([
			"bad_request",
			"not_found",
			"method_not_allowed",
			"forbidden_origin",
			"invalid_db",
			"conflict",
			"internal",
		]);
	});
});

// ── V15: multi-db does not widen the CSRF surface ───────────────────────────

describe("V15 · CSRF surface is not widened by the three new routes", () => {
	it("V15a: cross-origin preflight and POST to a management route are 403", async () => {
		await makeMemoryDb(processDb);
		const server = await boot();

		// Preflight: the browser never sends the real POST if this is refused.
		const preflight = await call<EmptyBody>(server.url, "/api/databases/open", {
			method: "OPTIONS",
			origin: "http://evil.com",
		});
		expect(preflight.status).toBe(403);
		expect(preflight.body.error?.code).toBe("forbidden_origin");

		// A cross-origin POST cannot happen via a simple form either: the Origin
		// header is what S3 rejects, not the body (the body JSON is not a defense).
		for (const origin of ["http://evil.com", "null"]) {
			const res = await call<EmptyBody>(server.url, "/api/databases/open", {
				method: "POST",
				origin,
				body: JSON.stringify({ path: "/etc/passwd" }),
			});
			expect(res.status, origin).toBe(403);
			expect(res.body.error?.code, origin).toBe("forbidden_origin");
		}
	});

	it("V15b: no response carries Access-Control-Allow-Origin", async () => {
		// Any ACAO would let an arbitrary page READ the responses — i.e. enumerate
		// the user's databases. The service must never emit one.
		await makeMemoryDb(processDb);
		const server = await boot();
		const responses = [
			await call<EmptyBody>(server.url, "/api/databases"),
			await call<EmptyBody>(server.url, "/api/meta", { origin: "http://evil.com" }),
			await call<EmptyBody>(server.url, "/api/databases/open", {
				method: "OPTIONS",
				origin: "http://evil.com",
			}),
		];
		for (const res of responses) {
			expect(res.headers["access-control-allow-origin"]).toBeUndefined();
		}
	});

	it("V15c: GET /api/meta with a hostile Origin still returns 200 (existing behaviour)", async () => {
		// S3 only guards non-GET/HEAD. Multi-db MUST NOT push GETs into it: doing so
		// would turn the launcher's probe into a 403.
		await makeMemoryDb(processDb);
		const server = await boot();
		const res = await call<MetaBody>(server.url, "/api/meta", { origin: "http://evil.com" });
		expect(res.status).toBe(200);
		expect(res.headers["access-control-allow-origin"]).toBeUndefined();
	});
});
