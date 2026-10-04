import type { SqlValue } from "@sqlite.org/sqlite-wasm";
import type { BrowserSqliteDatabaseFactoryOptions } from "./driver-browser.ts";
import type { BrowserSqliteWorkerRequest, BrowserSqliteWorkerResponse } from "./driver-browser-worker.ts";

export interface AsyncSqliteRunResult {
	changes: number;
	lastInsertRowid?: number;
}

/** Statement execution surface. Parameters follow the synchronous driver semantics. */
export interface AsyncSqliteWork {
	exec(sql: string): Promise<void>;
	run(sql: string, params?: readonly unknown[] | Record<string, unknown>): Promise<AsyncSqliteRunResult>;
	all<TRow extends object = Record<string, SqlValue>>(
		sql: string,
		params?: readonly unknown[] | Record<string, unknown>,
	): Promise<TRow[]>;
	get<TRow extends object = Record<string, SqlValue>>(
		sql: string,
		params?: readonly unknown[] | Record<string, unknown>,
	): Promise<TRow | undefined>;
}

export interface AsyncSqliteDatabase extends AsyncSqliteWork {
	transaction<T>(fn: (tx: AsyncSqliteWork) => Promise<T>): Promise<T>;
	close(): Promise<void>;
}

export interface AsyncSqliteDatabaseFactory {
	open(path: string): Promise<AsyncSqliteDatabase>;
}

/** Minimal worker surface, also used by the in-process RPC test transport. */
export interface BrowserSqliteWorkerTransport {
	postMessage(message: BrowserSqliteWorkerRequest): void;
	addEventListener(
		type: "message" | "error" | "messageerror",
		listener: (event: { data?: unknown; message?: string }) => void,
	): void;
	terminate?(): unknown;
}

export interface BrowserSqliteDatabaseFactoryWorkerOptions extends BrowserSqliteDatabaseFactoryOptions {
	/** Overrides the default worker entry URL for bundlers that need an explicit asset reference. */
	workerUrl?: URL;
	/** Replaces Worker construction; intended for embedders and in-process protocol tests. */
	workerFactory?: (workerUrl: URL) => BrowserSqliteWorkerTransport;
}

interface QueuedRequest {
	id: number;
	kind: string;
	payload: unknown;
	txId?: number;
	resolve(value: unknown): void;
	reject(error: Error): void;
}

function makeWorker(workerUrl: URL): BrowserSqliteWorkerTransport {
	type WorkerConstructor = new (url: URL, options: { type: "module" }) => BrowserSqliteWorkerTransport;
	const WorkerGlobal = (globalThis as typeof globalThis & { Worker?: WorkerConstructor }).Worker;
	if (WorkerGlobal === undefined) throw new Error("Worker is not available in this environment");
	return new WorkerGlobal(workerUrl, { type: "module" });
}

function restoreError(error: { message: string; code?: string | number }): Error {
	const restored = new Error(error.message);
	if (error.code !== undefined) Object.assign(restored, { code: error.code });
	return restored;
}

class BrowserSqliteRpcClient {
	private readonly worker: BrowserSqliteWorkerTransport;
	private readonly queue: QueuedRequest[] = [];
	private readonly pending = new Set<QueuedRequest>();
	private nextId = 1;
	private nextTxId = 1;
	private inFlight: QueuedRequest | undefined;
	private activeTxId: number | undefined;
	private transactionId: number | undefined;
	private opened = false;
	private closing = false;
	private closed = false;
	private deadError: Error | undefined;
	private closePromise: Promise<void> | undefined;

	constructor(worker: BrowserSqliteWorkerTransport) {
		this.worker = worker;
		worker.addEventListener("message", (event) => this.receive(event.data));
		worker.addEventListener("error", () => this.workerFailed());
		worker.addEventListener("messageerror", () => this.workerFailed());
	}

	async initialize(path: string, vfs?: string): Promise<void> {
		try {
			await this.request("init", { path, vfs });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.fail(new Error(`worker bootstrap failed: ${message}`));
			throw this.deadError;
		}
	}

	database(): AsyncSqliteDatabase {
		return {
			exec: (sql) => this.execute("exec", sql) as Promise<void>,
			run: (sql, params) => this.execute("run", sql, params) as Promise<AsyncSqliteRunResult>,
			all: <TRow extends object>(sql: string, params?: readonly unknown[] | Record<string, unknown>) =>
				this.execute("all", sql, params) as Promise<TRow[]>,
			get: <TRow extends object>(sql: string, params?: readonly unknown[] | Record<string, unknown>) =>
				this.execute("get", sql, params) as Promise<TRow | undefined>,
			transaction: (fn) => this.transaction(fn),
			close: () => this.close(),
		};
	}

	private execute(
		kind: "exec" | "run" | "all" | "get",
		sql: string,
		params?: readonly unknown[] | Record<string, unknown>,
		txId?: number,
	): Promise<unknown> {
		const payload: { sql: string; params?: readonly unknown[] | Record<string, unknown>; txId?: number } = { sql };
		if (params !== undefined) payload.params = params;
		if (txId !== undefined) payload.txId = txId;
		return this.request(kind, payload, txId);
	}

	private transaction<T>(fn: (tx: AsyncSqliteWork) => Promise<T>): Promise<T> {
		if (this.closing || this.closed || this.deadError !== undefined) {
			return Promise.reject(this.deadError ?? new Error("database is closed"));
		}
		if (this.transactionId !== undefined) return Promise.reject(new Error("transaction already active"));
		const txId = this.nextTxId++;
		this.transactionId = txId;
		const tx: AsyncSqliteWork = {
			exec: (sql) => this.execute("exec", sql, undefined, txId) as Promise<void>,
			run: (sql, params) => this.execute("run", sql, params, txId) as Promise<AsyncSqliteRunResult>,
			all: <TRow extends object>(sql: string, params?: readonly unknown[] | Record<string, unknown>) =>
				this.execute("all", sql, params, txId) as Promise<TRow[]>,
			get: <TRow extends object>(sql: string, params?: readonly unknown[] | Record<string, unknown>) =>
				this.execute("get", sql, params, txId) as Promise<TRow | undefined>,
		};
		return this.request("begin", { txId }, txId)
			.then(async () => {
				try {
					const result = await fn(tx);
					await this.request("commit", { txId }, txId);
					return result;
				} catch (error) {
					if (this.transactionId === txId) {
						try {
							await this.request("rollback", { txId }, txId, true);
						} catch {
							// Preserve the transaction's original failure; worker failure rejects all queued work.
						}
					}
					throw error;
				} finally {
					if (this.transactionId === txId && this.activeTxId !== txId) this.transactionId = undefined;
				}
			})
			.catch((error: unknown) => {
				if (this.transactionId === txId && this.activeTxId !== txId) this.transactionId = undefined;
				throw error;
			});
	}

	private close(): Promise<void> {
		if (this.closePromise !== undefined) return this.closePromise;
		if (this.deadError !== undefined || this.closed) {
			this.closed = true;
			return Promise.resolve();
		}
		this.closing = true;
		this.closePromise = (async () => {
			const txId = this.transactionId ?? this.activeTxId;
			if (txId !== undefined) {
				try {
					await this.request("rollback", { txId }, txId, true);
				} catch (error) {
					if (this.deadError !== undefined) {
						this.closed = true;
						return;
					}
					if (!(error instanceof Error && error.message === "tx session is not active")) {
						this.fail(new Error("worker terminated"));
						this.worker.terminate?.();
						this.closed = true;
						throw error;
					}
				}
			}
			try {
				await this.request("close", {}, undefined, true);
			} finally {
				this.closed = true;
				this.worker.terminate?.();
			}
		})();
		return this.closePromise;
	}

	private request(kind: string, payload: unknown, txId?: number, duringClose = false): Promise<unknown> {
		if (this.deadError !== undefined) return Promise.reject(this.deadError);
		if (this.closed || (this.closing && !duringClose)) return Promise.reject(new Error("database is closed"));
		if (txId !== undefined && this.transactionId !== txId) {
			return Promise.reject(new Error("transaction is no longer active"));
		}
		const deferred = Promise.withResolvers<unknown>();
		const request: QueuedRequest = {
			id: this.nextId++,
			kind,
			payload,
			txId,
			resolve: deferred.resolve,
			reject: deferred.reject,
		};
		this.queue.push(request);
		this.pending.add(request);
		this.pump();
		return deferred.promise;
	}

	private pump(): void {
		if (this.inFlight !== undefined || this.deadError !== undefined) return;
		let index = 0;
		if (this.activeTxId !== undefined) {
			index = this.queue.findIndex((request) => request.txId === this.activeTxId);
			if (index === -1) return;
		}
		const request = this.queue.splice(index, 1)[0];
		if (request === undefined) return;
		this.inFlight = request;
		try {
			this.worker.postMessage({ id: request.id, kind: request.kind, payload: request.payload });
		} catch {
			this.workerFailed();
		}
	}

	private receive(data: unknown): void {
		if (data === null || typeof data !== "object") return;
		const response = data as BrowserSqliteWorkerResponse;
		const request = this.inFlight;
		if (request === undefined || response.id !== request.id) return;
		this.inFlight = undefined;
		this.pending.delete(request);
		if (response.ok) {
			if (request.kind === "init") this.opened = true;
			if (request.kind === "begin") this.activeTxId = request.txId;
			if ((request.kind === "commit" || request.kind === "rollback") && request.txId === this.activeTxId) {
				this.activeTxId = undefined;
				this.transactionId = undefined;
			}
			if (request.kind === "close") this.closed = true;
			request.resolve(response.result);
		} else {
			request.reject(restoreError(response.error));
		}
		this.pump();
	}

	private workerFailed(): void {
		if (this.deadError !== undefined || this.closed) return;
		const message = this.opened ? "worker terminated" : "worker bootstrap failed";
		this.fail(new Error(message));
	}

	private fail(error: Error): void {
		if (this.deadError !== undefined) return;
		this.deadError = error;
		this.inFlight = undefined;
		this.activeTxId = undefined;
		this.transactionId = undefined;
		this.queue.length = 0;
		for (const request of this.pending) request.reject(error);
		this.pending.clear();
	}
}

export function createWorkerSqliteDatabaseFactory(
	options?: BrowserSqliteDatabaseFactoryWorkerOptions,
): AsyncSqliteDatabaseFactory {
	return {
		async open(path: string): Promise<AsyncSqliteDatabase> {
			const workerUrl = options?.workerUrl ?? new URL("./driver-browser-worker.js", import.meta.url);
			const worker = options?.workerFactory === undefined ? makeWorker(workerUrl) : options.workerFactory(workerUrl);
			const client = new BrowserSqliteRpcClient(worker);
			await client.initialize(path, options?.vfs);
			return client.database();
		},
	};
}
