import type { SqliteDatabase, SqliteDatabaseFactory } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { createBrowserSqliteDatabaseFactory } from "./driver-browser.ts";
import { type BrowserSqliteWorkerTransport, createWorkerSqliteDatabaseFactory } from "./driver-browser-async.ts";
import { type BrowserSqliteWorkerRequest, createBrowserSqliteWorkerHandler } from "./driver-browser-worker.ts";

interface MemoryWorker extends BrowserSqliteWorkerTransport {
	readonly requests: BrowserSqliteWorkerRequest[];
	crash(): void;
	setPaused(paused: boolean): void;
}

function createMemoryWorker(createFactory = createBrowserSqliteDatabaseFactory): MemoryWorker {
	const onMessage: Array<(event: { data: unknown }) => void> = [];
	const onError: Array<() => void> = [];
	const handler = createBrowserSqliteWorkerHandler(createFactory);
	const requests: BrowserSqliteWorkerRequest[] = [];
	let paused = false;
	let terminated = false;
	const worker: MemoryWorker = {
		requests,
		postMessage(message: BrowserSqliteWorkerRequest) {
			requests.push(message);
			if (paused || terminated) return;
			queueMicrotask(() => {
				void handler(message).then((response) => {
					if (!terminated) for (const listener of onMessage) listener({ data: response });
				});
			});
		},
		addEventListener(type, listener) {
			if (type === "message") onMessage.push(listener as (event: { data: unknown }) => void);
			else if (type === "error") onError.push(listener as () => void);
		},
		terminate() {
			terminated = true;
		},
		crash() {
			terminated = true;
			for (const listener of onError) listener();
		},
		setPaused(value) {
			paused = value;
		},
	};
	return worker;
}

function createDatabaseFactory(open: (path: string) => Promise<SqliteDatabase>): SqliteDatabaseFactory {
	return { open };
}

describe("createWorkerSqliteDatabaseFactory", () => {
	it("opens and round-trips exec, run, all, get, and both parameter forms", async () => {
		const db = await createWorkerSqliteDatabaseFactory({
			workerFactory: () => createMemoryWorker(),
		}).open(":memory:");
		try {
			await db.exec("CREATE TABLE values_table (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
			expect(await db.run("INSERT INTO values_table (value) VALUES (?)", ["positional"])).toEqual({
				changes: 1,
				lastInsertRowid: 1,
			});
			expect(await db.run("INSERT INTO values_table (value) VALUES (:value)", { value: "named" })).toEqual({
				changes: 1,
				lastInsertRowid: 2,
			});
			expect(await db.all("SELECT id, value FROM values_table ORDER BY id")).toEqual([
				{ id: 1, value: "positional" },
				{ id: 2, value: "named" },
			]);
			expect(await db.get("SELECT value FROM values_table WHERE id = ?", [1])).toEqual({ value: "positional" });
			expect(await db.get("SELECT value FROM values_table WHERE id = ?", [99])).toBeUndefined();
		} finally {
			await db.close();
		}
	});

	it("reconstructs worker errors and preserves their code", async () => {
		const codedError = Object.assign(new Error("database unavailable"), { code: "SQLITE_BUSY" });
		const workerFactory = () =>
			createMemoryWorker(() =>
				createDatabaseFactory(async () => ({
					exec() {},
					prepare() {
						throw codedError;
					},
					transaction<T>(fn: () => T) {
						return fn();
					},
					close() {},
				})),
			);
		const db = await createWorkerSqliteDatabaseFactory({ workerFactory }).open(":memory:");
		await expect(db.all("SELECT 1")).rejects.toMatchObject({
			message: "database unavailable",
			code: "SQLITE_BUSY",
		});
		await db.close();
	});

	it("rejects open when worker construction or bootstrap fails", async () => {
		const constructionFactory = createWorkerSqliteDatabaseFactory({
			workerFactory: () => {
				throw new Error("construction probe");
			},
		});
		await expect(constructionFactory.open(":memory:")).rejects.toThrow("construction probe");

		const bootstrapFactory = createWorkerSqliteDatabaseFactory({
			workerFactory: () =>
				createMemoryWorker(() => ({
					open: async () => {
						throw new Error("bootstrap probe");
					},
				})),
		});
		await expect(bootstrapFactory.open(":memory:")).rejects.toThrow("worker bootstrap failed: bootstrap probe");

		let worker!: MemoryWorker;
		const earlyExitFactory = createWorkerSqliteDatabaseFactory({
			workerFactory: () => {
				worker = createMemoryWorker();
				return worker;
			},
		});
		const opening = earlyExitFactory.open(":memory:");
		worker.crash();
		await expect(opening).rejects.toThrow("worker bootstrap failed");
	});

	it("commits successful transactions, rolls back rejections, and preserves statement order", async () => {
		const db = await createWorkerSqliteDatabaseFactory({
			workerFactory: () => createMemoryWorker(),
		}).open(":memory:");
		try {
			await db.exec("CREATE TABLE events (value TEXT NOT NULL)");
			const sequence: string[] = [];
			await db.transaction(async (tx) => {
				sequence.push("first");
				await tx.run("INSERT INTO events VALUES (?)", ["committed"]);
				sequence.push("second");
				await tx.get("SELECT value FROM events");
				sequence.push("third");
			});
			expect(sequence).toEqual(["first", "second", "third"]);
			await expect(
				db.transaction(async (tx) => {
					await tx.run("INSERT INTO events VALUES (?)", ["rolled back"]);
					throw new Error("transaction probe");
				}),
			).rejects.toThrow("transaction probe");
			expect(await db.all("SELECT value FROM events")).toEqual([{ value: "committed" }]);
		} finally {
			await db.close();
		}
	});

	it("defers non-transaction requests until the active transaction commits", async () => {
		let worker!: MemoryWorker;
		const db = await createWorkerSqliteDatabaseFactory({
			workerFactory: () => {
				worker = createMemoryWorker();
				return worker;
			},
		}).open(":memory:");
		try {
			await db.exec("CREATE TABLE events (value TEXT NOT NULL)");
			const started = Promise.withResolvers<void>();
			const gate = Promise.withResolvers<void>();
			const transaction = db.transaction(async (tx) => {
				await tx.run("INSERT INTO events VALUES (?)", ["transaction"]);
				started.resolve();
				await gate.promise;
			});
			await started.promise;
			const requestsBeforeOrdinary = worker.requests.length;
			const ordinaryRequest = db.run("INSERT INTO events VALUES (?)", ["ordinary"]);
			expect(worker.requests).toHaveLength(requestsBeforeOrdinary);
			gate.resolve();
			await transaction;
			await ordinaryRequest;
			expect(await db.all("SELECT value FROM events ORDER BY rowid")).toEqual([
				{ value: "transaction" },
				{ value: "ordinary" },
			]);
		} finally {
			await db.close();
		}
	});

	it("closes idempotently and rolls back a suspended transaction", async () => {
		const db = await createWorkerSqliteDatabaseFactory({
			workerFactory: () => createMemoryWorker(),
		}).open(":memory:");
		await db.exec("CREATE TABLE events (value TEXT NOT NULL)");
		const started = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		const transaction = db.transaction(async (tx) => {
			await tx.run("INSERT INTO events VALUES (?)", ["uncommitted"]);
			started.resolve();
			await gate.promise;
			await tx.exec("SELECT 1");
		});
		await started.promise;
		await db.close();
		await db.close();
		gate.resolve();
		await expect(transaction).rejects.toThrow();
	});

	it("rejects non-transaction worker messages during an exclusive transaction", async () => {
		const handle = createBrowserSqliteWorkerHandler();
		await handle({ id: 1, kind: "init", payload: { path: ":memory:" } });
		await handle({ id: 2, kind: "begin", payload: { txId: 7 } });
		expect(await handle({ id: 3, kind: "all", payload: { sql: "SELECT 1" } })).toMatchObject({
			id: 3,
			ok: false,
			error: { message: "tx session active" },
		});
		await handle({ id: 4, kind: "rollback", payload: { txId: 7 } });
		await handle({ id: 5, kind: "close", payload: {} });
	});

	it("rejects every pending request when the worker terminates", async () => {
		let worker!: MemoryWorker;
		const db = await createWorkerSqliteDatabaseFactory({
			workerFactory: () => {
				worker = createMemoryWorker();
				return worker;
			},
		}).open(":memory:");
		worker.setPaused(true);
		const first = expect(db.exec("SELECT 1")).rejects.toThrow("worker terminated");
		const second = expect(db.all("SELECT 2")).rejects.toThrow("worker terminated");
		worker.crash();
		await Promise.all([first, second]);
		await db.close();
	});
});
