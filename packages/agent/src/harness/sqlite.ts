/**
 * Shared SQLite capability vocabulary (13-D §3.1 / contract §10).
 *
 * These four types are the single injection seam for every SQLite consumer in the
 * monorepo: the session backends (`@earendil-works/pi-session-backend-sqlite-*`)
 * and the memory package (`@earendil-works/pi-memory`) both program against
 * them, and each runtime profile injects its own factory (node:sqlite,
 * `@sqlite.org/sqlite-wasm`, …). Types-only, zero runtime: the core package
 * never pulls a SQLite driver into its dependency graph.
 */

/** Result of a prepared SQLite statement execution. */
export interface SqliteRunResult {
	/** Number of rows changed by the statement. */
	changes: number;
	/** Inserted row id when the backend exposes one. */
	lastInsertRowid?: number;
}

/** Prepared SQLite statement capability used by the SQLite session backend. */
export interface SqliteStatement {
	run(...params: unknown[]): SqliteRunResult;
	get<TRow extends object>(...params: unknown[]): TRow | undefined;
	all<TRow extends object>(...params: unknown[]): TRow[];
	iterate<TRow extends object>(...params: unknown[]): Iterable<TRow>;
}

/** SQLite database capability used by the SQLite session backend. */
export interface SqliteDatabase {
	exec(sql: string): void;
	prepare(sql: string): SqliteStatement;
	/** Runs a synchronous write transaction. The callback must not return a promise. */
	transaction<T>(fn: () => T): T;
	close(): void;
}

export interface SqliteDatabaseFactory {
	open(path: string): Promise<SqliteDatabase>;
	/**
	 * Read-only open, for probing/inspection paths that MUST NOT mutate the file
	 * (flipping journal modes rewrites the header). Optional: runtimes without
	 * OS-level file permissions (browser) may omit it, and callers fall back to
	 * `open`. Implementations that do provide it own their failure vocabulary
	 * (the node profile throws `ReadonlyOpenError` with
	 * `missing`/`not-a-file`/`unreadable` — see `@earendil-works/pi-memory`).
	 */
	openReadonly?(path: string): Promise<SqliteDatabase>;
}
