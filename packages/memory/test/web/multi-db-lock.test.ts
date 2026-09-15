/**
 * V14a / V14b — a REAL lock conflict, end to end. The slow half of V14.
 *
 * Source of truth: `plan/memory-web/15-多库测试与文档.md` §3.8 and contract §2.8/Q5.
 * The fast half (`V14c`, the pure mapping) lives in `multi-db-api.test.ts`; this
 * file exists separately because it has to burn the busy timeout.
 *
 * ## The trap this file is written around
 *
 * The tempting way to keep this fast is to lower the TEST timeout. That produces
 * a green that proves nothing: the assertion never runs, the request is killed
 * first, and the test reports success. **The waiting must be done by the DB
 * connection, not by the harness.** So the busy timeout is lowered with `PRAGMA`
 * on the connection the test controls, and the vitest timeout is left generous.
 *
 * ⚠️ This file builds its OWN dbs in its own `mkdtemp`. A lock is process-wide
 *    state on a file, so sharing a fixture with another file would leak the lock
 *    into unrelated cases.
 * ⚠️ If the lock cannot be produced deterministically on this platform/load, the
 *    honest move is `it.skip` with the reason in the title — NOT a green tick.
 *    The design says so explicitly: "MUST NOT 假装跑过". `V14c` already proves the
 *    mapping itself, so skipping here is lossy but not misleading.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openMemoryStore } from "../../src/index.ts";
import { type RunningServer, startServer } from "../../src/web/server.ts";

interface Result<T> {
	status: number;
	body: T & { error?: { code: string; message: string } };
}

interface EmptyBody {
	[key: string]: unknown;
}

/**
 * The engine's production busy timeout is 5000 ms (`driver.ts`). Lowering it here
 * only affects the connection the TEST opens (the holder); the SERVER's own
 * connection keeps the production value, so what these cases measure is still the
 * real behavior — and each blocked request therefore costs ~5 s. That is why the
 * file is separate and why the vitest timeouts below are generous: the DB must do
 * the waiting, and a harness timeout shorter than the busy timeout would make
 * these cases pass without ever running their assertions.
 */
const TEST_BUSY_TIMEOUT_MS = 200;

let workdir: string;
let dbsDir: string;
let processDb: string;
let server: RunningServer | null = null;

async function makeMemoryDb(file: string, uri = "core://seed"): Promise<string> {
	mkdirSync(path.dirname(file), { recursive: true });
	const store = await openMemoryStore(file);
	store.put({ uri, content: "种子节点" });
	store.db.close();
	return file;
}

async function call<T>(
	base: string,
	pathname: string,
	init: { method?: string; body?: string } = {},
): Promise<Result<T>> {
	const url = new URL(base);
	const headers: Record<string, string> = { Host: `127.0.0.1:${url.port}` };
	if (init.body !== undefined) headers["Content-Type"] = "application/json";
	const { promise, resolve, reject } = Promise.withResolvers<{ status: number; text: string }>();
	const req = httpRequest(
		{ hostname: url.hostname, port: url.port, path: pathname, method: init.method ?? "GET", headers },
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
	const parsed: unknown = response.text.startsWith("{") ? JSON.parse(response.text) : {};
	const body =
		typeof parsed === "object" && parsed !== null
			? (parsed as T & { error?: { code: string; message: string } })
			: ({} as T & { error?: { code: string; message: string } });
	return { status: response.status, body };
}

async function register(base: string, file: string): Promise<number> {
	return (
		await call<EmptyBody>(base, "/api/databases/open", {
			method: "POST",
			body: JSON.stringify({ path: file }),
		})
	).status;
}

beforeEach(async () => {
	workdir = mkdtempSync(path.join(tmpdir(), "memweb-lock-"));
	dbsDir = path.join(workdir, "dbs");
	mkdirSync(dbsDir, { recursive: true });
	const assets = path.join(workdir, "assets");
	mkdirSync(assets, { recursive: true });
	processDb = path.join(workdir, "process.db");

	const store = await openMemoryStore(processDb);
	store.seed();
	server = await startServer(
		{
			store,
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
});

afterEach(async () => {
	if (server) await server.close();
	server = null;
	rmSync(workdir, { recursive: true, force: true });
});

describe("V14 · a real lock conflict maps to conflict, not internal", () => {
	it("V14a: a write while another connection holds the write lock returns 409", async () => {
		if (!server) throw new Error("server not booted");
		const base = server.url;
		const db = await makeMemoryDb(path.join(dbsDir, "locked.db"));
		expect(await register(base, db)).toBe(200);

		// A SEPARATE connection (real SQLite, its own handle) takes the write lock
		// and holds it, so the server's next write must hit `database is locked`
		// after its own busy timeout expires.
		const holder = new DatabaseSync(db);
		holder.exec(`PRAGMA busy_timeout = ${TEST_BUSY_TIMEOUT_MS}`);
		holder.exec("BEGIN IMMEDIATE");
		holder.exec("INSERT INTO memory_kv (key, value) VALUES ('lock-probe', 'held')");
		try {
			const res = await call<EmptyBody>(base, `/api/world-time?${new URLSearchParams({ db })}`, {
				method: "POST",
				body: JSON.stringify({ value: "2020-01-02T00:00:00.000Z" }),
			});
			// 409 conflict — NOT 500 internal. The old behavior surfaced the lock as
			// `internal`, which the UI renders as "the service may not be running or
			// has exited": a factual falsehood for a transient conflict.
			expect(res.status).toBe(409);
			expect(res.body.error?.code).toBe("conflict");
			expect(res.body.error?.message).toContain("稍后重试");
			expect(res.body.error?.message).not.toContain("服务可能未启动");
		} finally {
			holder.exec("ROLLBACK");
			holder.close();
		}
	}, 20_000);

	it("V14b: the conflict is TEMPORARY — the same request succeeds after the lock is released", async () => {
		if (!server) throw new Error("server not booted");
		const base = server.url;
		const db = await makeMemoryDb(path.join(dbsDir, "transient.db"));
		expect(await register(base, db)).toBe(200);

		const write = (): Promise<Result<EmptyBody>> =>
			call<EmptyBody>(base, `/api/world-time?${new URLSearchParams({ db })}`, {
				method: "POST",
				body: JSON.stringify({ value: "2020-01-02T00:00:00.000Z" }),
			});

		const holder = new DatabaseSync(db);
		holder.exec(`PRAGMA busy_timeout = ${TEST_BUSY_TIMEOUT_MS}`);
		holder.exec("BEGIN IMMEDIATE");
		holder.exec("INSERT INTO memory_kv (key, value) VALUES ('lock-probe', 'held')");
		const blocked = await write();
		expect(blocked.status).toBe(409);
		holder.exec("ROLLBACK");
		holder.close();

		// Retrying must succeed. A conflict implemented as a permanent failure
		// would force the user to restart the web server.
		const retried = await write();
		expect(retried.status).toBe(200);
	}, 20_000);
});
