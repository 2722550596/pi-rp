import type { SqliteDatabase, SqliteDatabaseFactory } from "@earendil-works/pi-agent-core";
import { type BrowserSqliteDatabaseFactoryOptions, createBrowserSqliteDatabaseFactory } from "./driver-browser.ts";

export interface BrowserSqliteWorkerRequest {
	id: number;
	kind: string;
	payload: unknown;
}

export interface BrowserSqliteWorkerError {
	message: string;
	code?: string | number;
}

export type BrowserSqliteWorkerResponse =
	| { id: number; ok: true; result: unknown }
	| { id: number; ok: false; error: BrowserSqliteWorkerError };

export type BrowserSqliteFactoryCreator = (options?: BrowserSqliteDatabaseFactoryOptions) => SqliteDatabaseFactory;

export type BrowserSqliteWorkerMessageHandler = (message: unknown) => Promise<BrowserSqliteWorkerResponse>;

function objectPayload(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function sqlParams(value: unknown): unknown[] {
	if (Array.isArray(value)) return value;
	if (value === undefined || value === null) return [];
	return [value];
}

function errorPayload(error: unknown): BrowserSqliteWorkerError {
	const message = error instanceof Error ? error.message : String(error);
	const result: BrowserSqliteWorkerError = { message };
	if (error !== null && typeof error === "object" && "code" in error) {
		const code = (error as { code?: unknown }).code;
		if (typeof code === "string" || typeof code === "number") result.code = code;
	}
	return result;
}

export function createBrowserSqliteWorkerHandler(
	createFactory: BrowserSqliteFactoryCreator = createBrowserSqliteDatabaseFactory,
): BrowserSqliteWorkerMessageHandler {
	let database: SqliteDatabase | undefined;
	let activeTxId: number | undefined;

	return async (message: unknown): Promise<BrowserSqliteWorkerResponse> => {
		const request = message as BrowserSqliteWorkerRequest;
		if (
			request === null ||
			typeof request !== "object" ||
			!Number.isInteger(request.id) ||
			typeof request.kind !== "string"
		) {
			return { id: -1, ok: false, error: { message: "invalid worker request" } };
		}
		const payload = objectPayload(request.payload);
		try {
			let result: unknown;
			if (request.kind === "init") {
				if (database !== undefined) throw new Error("database already initialized");
				if (typeof payload.path !== "string") throw new Error("init path must be a string");
				const options = typeof payload.vfs === "string" ? { vfs: payload.vfs } : undefined;
				database = await createFactory(options).open(payload.path);
			} else {
				if (activeTxId !== undefined && payload.txId !== activeTxId) throw new Error("tx session active");
				if (database === undefined) throw new Error("database is not initialized");
				const txId = typeof payload.txId === "number" ? payload.txId : undefined;
				switch (request.kind) {
					case "exec": {
						if (txId !== undefined && txId !== activeTxId) throw new Error("tx session is not active");
						if (typeof payload.sql !== "string") throw new Error("exec SQL must be a string");
						result = database.exec(payload.sql);
						break;
					}
					case "run": {
						if (txId !== undefined && txId !== activeTxId) throw new Error("tx session is not active");
						if (typeof payload.sql !== "string") throw new Error("run SQL must be a string");
						result = database.prepare(payload.sql).run(...sqlParams(payload.params));
						break;
					}
					case "all": {
						if (txId !== undefined && txId !== activeTxId) throw new Error("tx session is not active");
						if (typeof payload.sql !== "string") throw new Error("all SQL must be a string");
						result = database.prepare(payload.sql).all(...sqlParams(payload.params));
						break;
					}
					case "get": {
						if (txId !== undefined && txId !== activeTxId) throw new Error("tx session is not active");
						if (typeof payload.sql !== "string") throw new Error("get SQL must be a string");
						result = database.prepare(payload.sql).get(...sqlParams(payload.params));
						break;
					}
					case "begin": {
						if (activeTxId !== undefined) throw new Error("tx session active");
						if (txId === undefined) throw new Error("begin requires txId");
						database.exec("BEGIN");
						activeTxId = txId;
						break;
					}
					case "commit": {
						if (txId === undefined || txId !== activeTxId) throw new Error("tx session is not active");
						database.exec("COMMIT");
						activeTxId = undefined;
						break;
					}
					case "rollback": {
						if (txId === undefined || txId !== activeTxId) throw new Error("tx session is not active");
						database.exec("ROLLBACK");
						activeTxId = undefined;
						break;
					}
					case "close": {
						database.close();
						database = undefined;
						break;
					}
					default:
						throw new Error(`unsupported worker request: ${request.kind}`);
				}
			}
			return { id: request.id, ok: true, result };
		} catch (error) {
			return { id: request.id, ok: false, error: errorPayload(error) };
		}
	};
}

interface BrowserWorkerScope {
	onmessage: ((event: { data: unknown }) => void) | null;
	postMessage(message: BrowserSqliteWorkerResponse): void;
}

const workerScope = (globalThis as typeof globalThis & { self?: BrowserWorkerScope }).self;
if (workerScope !== undefined) {
	const handleMessage = createBrowserSqliteWorkerHandler();
	workerScope.onmessage = (event) => {
		void handleMessage(event.data).then((response) => workerScope.postMessage(response));
	};
}
