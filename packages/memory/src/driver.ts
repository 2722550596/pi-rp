import { type Stats, statSync } from "node:fs";

export interface MemoryStatement {
	run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
	get(...params: unknown[]): unknown;
	all(...params: unknown[]): unknown[];
}

/**
 * A read-only open failed. `reason` shares its vocabulary with
 * `ProbeOutcome.reason` so discovery can map it straight through.
 *
 * The reasons are separated because SQLite's own errors are ambiguous: a
 * missing file and a `chmod 000` file both report "unable to open database
 * file". Only the pre-flight `stat` distinguishes them, which is why the
 * reason is decided here rather than by string-matching an exception.
 */
export class ReadonlyOpenError extends Error {
	readonly reason: "missing" | "not-a-file" | "unreadable";
	readonly path: string;

	constructor(reason: ReadonlyOpenError["reason"], path: string, detail: string) {
		super(detail);
		this.name = "ReadonlyOpenError";
		this.reason = reason;
		this.path = path;
	}
}

export interface MemoryDatabase {
	exec(sql: string): void;
	prepare(sql: string): MemoryStatement;
	transaction<T>(fn: () => T): T;
	close(): void;
}

export async function openDatabase(path: string): Promise<MemoryDatabase> {
	const resolved = path === "" ? ":memory:" : path;
	let DatabaseSync: new (
		path: string,
	) => {
		exec(sql: string): void;
		prepare(sql: string): MemoryStatement;
		close(): void;
	};
	try {
		({ DatabaseSync } = await import("node:sqlite"));
	} catch (error) {
		throw new Error(`Failed to load node:sqlite driver (requires Node >= 22.5): ${String(error)}`);
	}
	const db = new DatabaseSync(resolved);
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA busy_timeout = 5000");
	return {
		exec: (sql: string) => db.exec(sql),
		prepare: (sql: string) => db.prepare(sql),
		transaction<T>(fn: () => T): T {
			db.exec("BEGIN");
			try {
				const result = fn();
				db.exec("COMMIT");
				return result;
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		},
		close: () => db.close(),
	};
}

/**
 * Read-only open, for multi-db probing/discovery.
 *
 * This exists because `openDatabase` cannot be used for probing: it runs
 * `PRAGMA journal_mode = WAL`, and flipping a database into WAL has to write
 * the file header. On a readOnly connection that throws `attempt to write a
 * readonly database`; on a writable one it *rewrites the header of the file
 * being probed*. Probing must not have that effect.
 *
 * The returned `MemoryDatabase` has the same shape as `openDatabase`'s —
 * `exec`, `prepare` and `transaction` all work (SQLite permits BEGIN/COMMIT on
 * a read-only connection) — but every write statement throws `attempt to write
 * a readonly database`.
 *
 * Callers MUST `close()` in a `finally`. This function holds no global
 * reference, so a leaked handle is a leaked fd.
 */
export async function openDatabaseReadonly(path: string): Promise<MemoryDatabase> {
	// ⭐ The type guard lives HERE, not at the call sites. "The caller remembers
	// to check" already failed at one of three call sites, and the consequence is
	// a permanently wedged process: `new DatabaseSync(<FIFO>, { readOnly: true })`
	// blocks forever (the synchronous API occupies the event loop; measured exit
	// code 124 under `timeout`). Sinking the guard into the single read-only open
	// point covers every read-only entry point, including ones added later.
	//
	// The guard is synchronous and runs BEFORE the dynamic import, so its
	// protection does not depend on import timing.
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
		// Directories, FIFOs, character devices and sockets all land here. FIFOs
		// are the dangerous one (see above). procfs/sysfs pseudo-files report
		// `isFile() === true` and are excluded by the probe instead — the two
		// layers each block a different class.
		throw new ReadonlyOpenError("not-a-file", path, `不是普通文件（目录/管道/设备）：${path}`);
	}

	let DatabaseSync: new (
		path: string,
		options?: { readOnly?: boolean },
	) => {
		exec(sql: string): void;
		prepare(sql: string): MemoryStatement;
		close(): void;
	};
	try {
		({ DatabaseSync } = await import("node:sqlite"));
	} catch (error) {
		throw new Error(`Failed to load node:sqlite driver (requires Node >= 22.5): ${String(error)}`);
	}
	let db: {
		exec(sql: string): void;
		prepare(sql: string): MemoryStatement;
		close(): void;
	};
	try {
		db = new DatabaseSync(path, { readOnly: true });
	} catch (error) {
		// chmod 000 reports the SAME message as a missing file, so the pre-flight
		// stat above is what keeps "the file is gone" distinguishable from
		// "cannot be read".
		throw new ReadonlyOpenError("unreadable", path, (error as Error).message);
	}
	// ⚠️ busy_timeout only. MUST NOT set journal_mode here — see above.
	db.exec("PRAGMA busy_timeout = 5000");
	return {
		exec: (sql: string) => db.exec(sql),
		prepare: (sql: string) => db.prepare(sql),
		transaction<T>(fn: () => T): T {
			db.exec("BEGIN");
			try {
				const result = fn();
				db.exec("COMMIT");
				return result;
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		},
		close: () => db.close(),
	};
}
