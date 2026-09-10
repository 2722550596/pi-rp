export interface MemoryStatement {
	run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
	get(...params: unknown[]): unknown;
	all(...params: unknown[]): unknown[];
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
