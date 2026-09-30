import type {
	SqliteDatabase,
	SqliteDatabaseFactory,
	SqliteRunResult,
	SqliteStatement,
} from "@earendil-works/pi-agent-core";
import type {
	BindableValue,
	BindingSpec,
	PreparedStatement,
	Sqlite3Static,
	SqlValue,
	Database as WasmDatabase,
} from "@sqlite.org/sqlite-wasm";

/**
 * Browser-profile SQLite factory backed by `@sqlite.org/sqlite-wasm`
 * (13-D §11.2 裁决: oo1 API, FTS5 enabled; sql.js was ruled out for lacking
 * FTS5). The browser assembler injects this via `MemoryDriverOptions.sqlite`
 * / the harness `SqliteDatabaseFactory` seam — it is never imported into a
 * node runtime path.
 *
 * - Persistence: VFS defaults to `opfs-sahpool` when OPFS is available —
 *   the official OPFS VFS that needs NO COOP/COEP cross-origin isolation
 *   headers (unlike the `opfs` VFS, which requires SharedArrayBuffer). The
 *   VFS choice lives in THIS module — the injected profile implementation —
 *   never as a profile fork in harness code. Outside OPFS (Node test host,
 *   non-secure contexts) it falls back to the module's default VFS.
 * - No journal pragmas (D4): opfs-sahpool is a serial single connection and
 *   the browser profile assumes a single tab/writer
 *   (capabilities.concurrentFsAccess=false); SQLITE_BUSY semantics stay with
 *   the VFS layer.
 * - No `openReadonly` (D3): a browser has no OS permission bits, so readonly
 *   degenerates to a plain open; `openDatabaseReadonly`'s factory fallback
 *   covers it, and the three-state `ReadonlyOpenError` vocabulary is a
 *   node/hosted-only surface.
 * - Rows are PLAIN objects (position values zipped with
 *   `getColumnNames()`), satisfying the memory package's "read columns by
 *   name, never call host methods on rows" contract without either side
 *   caring about prototype provenance.
 */

/** Default OPFS VFS name for the browser profile (installed on demand). */
export const OPFS_SAHPoolVfs = "opfs-sahpool";

export interface BrowserSqliteDatabaseFactoryOptions {
	/**
	 * VFS name passed to the oo1 `DB` constructor. Default: `opfs-sahpool`
	 * when the environment exposes OPFS, otherwise the sqlite3 module default.
	 */
	vfs?: string;
}

let wasmModule: Promise<Sqlite3Static> | undefined;

function initSqlite3(): Promise<Sqlite3Static> {
	// Dynamic import on purpose: the wasm glue is a large browser asset that
	// must not enter a node bundle's static graph, and instantiation is
	// deferred until the first open (module load stays cheap).
	if (wasmModule === undefined) {
		wasmModule = import("@sqlite.org/sqlite-wasm").then(
			(mod) => mod.default(),
			(error) => {
				wasmModule = undefined;
				throw new Error(`Failed to load browser sqlite driver: ${String(error)}`);
			},
		);
	}
	return wasmModule;
}

function opfsAvailable(): boolean {
	const storage = (globalThis as { navigator?: { storage?: { getDirectory?: unknown } } }).navigator?.storage;
	return typeof storage?.getDirectory === "function";
}

function resolveVfs(options: BrowserSqliteDatabaseFactoryOptions | undefined): string | undefined {
	if (options?.vfs !== undefined) return options.vfs;
	return opfsAvailable() ? OPFS_SAHPoolVfs : undefined;
}

function isNamedParameters(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object") return false;
	if (Array.isArray(value) || ArrayBuffer.isView(value)) return false;
	return true;
}

/**
 * Map bare parameter names onto the statement's bindable parameters.
 * node:sqlite accepts object keys with or without the `:`/`@`/`$` prefix;
 * oo1 binds by exact name, so the adapter resolves the prefixed form here.
 * A key matching nothing is kept as-is and oo1's own bind error surfaces.
 */
function namedBinding(stmt: PreparedStatement, params: Record<string, unknown>): BindingSpec {
	const mapped: Record<string, BindableValue> = {};
	for (const [key, value] of Object.entries(params)) {
		let bound = false;
		for (const candidate of [key, `:${key}`, `@${key}`, `$${key}`]) {
			if (stmt.getParamIndex(candidate)) {
				mapped[candidate] = value as BindableValue;
				bound = true;
				break;
			}
		}
		if (!bound) mapped[key] = value as BindableValue;
	}
	return mapped;
}

/** One plain-object row: column names zipped over the positional values. */
function rowObject(stmt: PreparedStatement): Record<string, SqlValue> {
	const values = stmt.get([]) as SqlValue[];
	const names = stmt.getColumnNames();
	const row: Record<string, SqlValue> = {};
	for (let i = 0; i < names.length; i++) row[names[i]] = values[i] ?? null;
	return row;
}

class WasmDriverStatement implements SqliteStatement {
	private readonly sqlite3: Sqlite3Static;
	private readonly db: WasmDatabase;
	private readonly stmt: PreparedStatement;

	constructor(sqlite3: Sqlite3Static, db: WasmDatabase, stmt: PreparedStatement) {
		this.sqlite3 = sqlite3;
		this.db = db;
		this.stmt = stmt;
	}

	private bindAll(params: unknown[]): void {
		if (params.length === 0) return;
		const first = params[0];
		if (isNamedParameters(first)) {
			this.stmt.bind(namedBinding(this.stmt, first));
			return;
		}
		this.stmt.bind(params as BindableValue[]);
	}

	run(...params: unknown[]): SqliteRunResult {
		this.bindAll(params);
		// oo1 auto-resets when step() completes (returns false); a truthy row
		// result from a non-query run needs the explicit reset to keep the
		// statement reusable.
		if (this.stmt.step()) this.stmt.reset();
		const handle = this.db.pointer;
		return {
			changes: Number(this.db.changes()),
			// MemoryStore's raw-log mirror keys FTS off this id (oo1 exposes it
			// via capi only; it comes back as bigint and is narrowed here).
			lastInsertRowid:
				handle === undefined ? undefined : Number(this.sqlite3.capi.sqlite3_last_insert_rowid(handle)),
		};
	}

	get<TRow extends object>(...params: unknown[]): TRow | undefined {
		this.bindAll(params);
		if (!this.stmt.step()) return undefined;
		const row = rowObject(this.stmt) as TRow;
		// node:sqlite get() semantics: the statement must come back reusable —
		// oo1 only auto-resets when step() completes (false), so a hit leaves an
		// active row that would make the next bind a SQLITE_MISUSE.
		this.stmt.reset();
		return row;
	}

	all<TRow extends object>(...params: unknown[]): TRow[] {
		this.bindAll(params);
		const rows: TRow[] = [];
		while (this.stmt.step()) rows.push(rowObject(this.stmt) as TRow);
		return rows;
	}

	*iterate<TRow extends object>(...params: unknown[]): Iterable<TRow> {
		this.bindAll(params);
		while (this.stmt.step()) yield rowObject(this.stmt) as TRow;
	}
}

class WasmDriverDatabase implements SqliteDatabase {
	private readonly sqlite3: Sqlite3Static;
	private readonly db: WasmDatabase;

	constructor(sqlite3: Sqlite3Static, db: WasmDatabase) {
		this.sqlite3 = sqlite3;
		this.db = db;
	}

	exec(sql: string): void {
		this.db.exec(sql);
	}

	prepare(sql: string): SqliteStatement {
		return new WasmDriverStatement(this.sqlite3, this.db, this.db.prepare(sql));
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
		// oo1 close() finalizes any statements still open on the handle.
		this.db.close();
	}
}

export function createBrowserSqliteDatabaseFactory(
	options?: BrowserSqliteDatabaseFactoryOptions,
): SqliteDatabaseFactory {
	return {
		async open(path: string): Promise<SqliteDatabase> {
			const sqlite3 = await initSqlite3();
			const vfs = resolveVfs(options);
			if (vfs === OPFS_SAHPoolVfs && !sqlite3.capi.sqlite3_vfs_find(vfs)) {
				// Loud failure if OPFS vanished between the sniff and here — no
				// silent fallback to an ephemeral VFS (I6 非静默).
				await sqlite3.installOpfsSAHPoolVfs({ name: OPFS_SAHPoolVfs });
			}
			// "c": create if missing (implies read-write). ":memory:" keeps its
			// special meaning in the wasm build as well.
			const db = new sqlite3.oo1.DB(path, "c", vfs);
			return new WasmDriverDatabase(sqlite3, db);
		},
	};
}
