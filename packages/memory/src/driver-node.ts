import type { Stats } from "node:fs";
import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";
import type {
	SqliteDatabase,
	SqliteDatabaseFactory,
	SqliteRunResult,
	SqliteStatement,
} from "@earendil-works/pi-agent-core";
import { ReadonlyOpenError } from "./driver.ts";

/**
 * Node-profile SQLite factory — the DEFAULT behind `openDatabase` /
 * `openDatabaseReadonly` (13-D §3.1/§4 step 2).
 *
 * Lives in its own module and is reached ONLY through a dynamic import, so the
 * memory main entry's static import graph contains no `node:` runtime modules
 * and can bundle for the browser (where the assembler always injects a
 * factory, making this module dead code). `node:sqlite`/`node:fs` are
 * platform-specific builtins that do not exist in the browser — a static
 * import here would fail the browser bundle at build time, which is exactly
 * the loading-boundary exception for keeping `await import()`.
 *
 * Behavior is the historical `openDatabase`/`openDatabaseReadonly` contract,
 * preserved verbatim:
 *
 * - write opens set `journal_mode = WAL` + `busy_timeout = 5000` (README §3:
 *   WAL is the multi-process concurrency contract; losing it silently changes
 *   node-profile behavior);
 * - read-only opens run the synchronous `stat` pre-flight FIRST and set
 *   `busy_timeout` ONLY — flipping journal_mode on a read-only connection
 *   throws `attempt to write a readonly database`, and on a writable one it
 *   would rewrite the header of the very file being probed.
 */

function isNamedParameters(value: unknown): value is Record<string, SQLInputValue> {
	if (value === null || typeof value !== "object") return false;
	if (Array.isArray(value) || ArrayBuffer.isView(value)) return false;
	return true;
}

class NodeDriverStatement implements SqliteStatement {
	private readonly statement: StatementSync;

	constructor(statement: StatementSync) {
		this.statement = statement;
	}

	run(...params: unknown[]): SqliteRunResult {
		const [first, ...rest] = params;
		const result = isNamedParameters(first)
			? this.statement.run(first, ...(rest as SQLInputValue[]))
			: this.statement.run(...(params as SQLInputValue[]));
		return {
			changes: Number(result.changes),
			lastInsertRowid: result.lastInsertRowid === undefined ? undefined : Number(result.lastInsertRowid),
		};
	}

	get<TRow extends object>(...params: unknown[]): TRow | undefined {
		const [first, ...rest] = params;
		return (
			isNamedParameters(first)
				? this.statement.get(first, ...(rest as SQLInputValue[]))
				: this.statement.get(...(params as SQLInputValue[]))
		) as TRow | undefined;
	}

	all<TRow extends object>(...params: unknown[]): TRow[] {
		const [first, ...rest] = params;
		return (
			isNamedParameters(first)
				? this.statement.all(first, ...(rest as SQLInputValue[]))
				: this.statement.all(...(params as SQLInputValue[]))
		) as TRow[];
	}

	*iterate<TRow extends object>(...params: unknown[]): Iterable<TRow> {
		// The shared statement contract includes `iterate`; node:sqlite exposes
		// it natively (this keeps the default driver interchangeable with the
		// session-backend adapter). Memory itself never consumes it.
		yield* this.statement.iterate(...(params as SQLInputValue[])) as Iterable<TRow>;
	}
}

class NodeDriverDatabase implements SqliteDatabase {
	private readonly db: DatabaseSync;

	constructor(db: DatabaseSync) {
		this.db = db;
	}

	exec(sql: string): void {
		this.db.exec(sql);
	}

	prepare(sql: string): SqliteStatement {
		return new NodeDriverStatement(this.db.prepare(sql));
	}

	transaction<T>(fn: () => T): T {
		this.db.exec("BEGIN");
		try {
			const result = fn();
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	close(): void {
		this.db.close();
	}
}

/**
 * Default node-profile factory. A hosted shell can also inject it explicitly —
 * `SqliteDatabaseFactory` is the shared seam; the memory package itself only
 * reaches this through the dynamic default path in `driver.ts`.
 */
export function createNodeDriverFactory(): SqliteDatabaseFactory {
	return {
		async open(path: string): Promise<SqliteDatabase> {
			let DatabaseCtor: new (path: string) => DatabaseSync;
			try {
				({ DatabaseSync: DatabaseCtor } = await import("node:sqlite"));
			} catch (error) {
				throw new Error(`Failed to load node:sqlite driver (requires Node >= 22.5): ${String(error)}`);
			}
			const db = new DatabaseCtor(path);
			db.exec("PRAGMA journal_mode = WAL");
			db.exec("PRAGMA busy_timeout = 5000");
			return new NodeDriverDatabase(db);
		},
		/**
		 * Read-only open, for multi-db probing/discovery.
		 *
		 * This exists because `open` cannot be used for probing: it runs
		 * `PRAGMA journal_mode = WAL`, and flipping a database into WAL has to
		 * write the file header. On a readOnly connection that throws
		 * `attempt to write a readonly database`; on a writable one it
		 * *rewrites the header of the file being probed*. Probing must not have
		 * that effect.
		 *
		 * The returned database has the same shape as `open`'s — `exec`,
		 * `prepare` and `transaction` all work (SQLite permits BEGIN/COMMIT on a
		 * read-only connection) — but every write statement throws
		 * `attempt to write a readonly database`.
		 *
		 * Callers MUST `close()` in a `finally`. This factory holds no global
		 * reference, so a leaked handle is a leaked fd.
		 */
		async openReadonly(path: string): Promise<SqliteDatabase> {
			// ⭐ The type guard lives HERE, not at the call sites. "The caller
			// remembers to check" already failed at one of three call sites, and
			// the consequence is a permanently wedged process:
			// `new DatabaseSync(<FIFO>, { readOnly: true })` blocks forever (the
			// synchronous API occupies the event loop; measured exit code 124
			// under `timeout`). Sinking the guard into the single read-only open
			// point covers every read-only entry point, including ones added
			// later. The guard is synchronous and runs BEFORE the dynamic import,
			// so its protection does not depend on import timing.
			const { statSync } = await import("node:fs");
			let stats: Stats;
			try {
				stats = statSync(path);
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				throw new ReadonlyOpenError(
					code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unreadable",
					path,
					`无法访问 ${path}：${code ?? String(error)}`,
				);
			}
			if (!stats.isFile()) {
				// Directories, FIFOs, character devices and sockets all land here.
				// FIFOs are the dangerous one (see above). procfs/sysfs
				// pseudo-files report `isFile() === true` and are excluded by the
				// probe instead — the two layers each block a different class.
				throw new ReadonlyOpenError("not-a-file", path, `不是普通文件（目录/管道/设备）：${path}`);
			}

			let DatabaseCtor: new (path: string, options?: { readOnly?: boolean }) => DatabaseSync;
			try {
				({ DatabaseSync: DatabaseCtor } = await import("node:sqlite"));
			} catch (error) {
				throw new Error(`Failed to load node:sqlite driver (requires Node >= 22.5): ${String(error)}`);
			}
			let db: DatabaseSync;
			try {
				db = new DatabaseCtor(path, { readOnly: true });
			} catch (error) {
				// chmod 000 reports the SAME message as a missing file, so the
				// pre-flight stat above is what keeps "the file is gone"
				// distinguishable from "cannot be read".
				throw new ReadonlyOpenError("unreadable", path, (error as Error).message);
			}
			// ⚠️ busy_timeout only. MUST NOT set journal_mode here — see above.
			db.exec("PRAGMA busy_timeout = 5000");
			return new NodeDriverDatabase(db);
		},
	};
}
