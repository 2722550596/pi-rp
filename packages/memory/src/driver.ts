import type { SqliteDatabase, SqliteDatabaseFactory, SqliteStatement } from "@earendil-works/pi-agent-core";

/**
 * Memory's database vocabulary is the shared `SqliteDatabase` family from
 * `@earendil-works/pi-agent-core` (13-D §3.1). These aliases keep the
 * package's public API names stable for existing consumers.
 */
export type MemoryDatabase = SqliteDatabase;
export type MemoryStatement = SqliteStatement;

/**
 * A read-only open failed. `reason` shares its vocabulary with
 * `ProbeOutcome.reason` so discovery can map it straight through.
 *
 * The reasons are separated because SQLite's own errors are ambiguous: a
 * missing file and a `chmod 000` file both report "unable to open database
 * file". Only the pre-flight `stat` distinguishes them, which is why the
 * reason is decided in the driver (`driver-node.ts`) rather than by
 * string-matching an exception.
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

export interface MemoryDriverOptions {
	/**
	 * SQLite factory injection seam (the shared `SqliteDatabaseFactory` from
	 * `@earendil-works/pi-agent-core`). Default = the node profile
	 * (`node:sqlite`, WAL + busy_timeout — `driver-node.ts`, dynamically
	 * imported so the browser bundle never touches it); browser assemblers
	 * inject the sqlite-wasm factory (`driver-browser.ts`).
	 */
	sqlite?: SqliteDatabaseFactory;
}

/**
 * Open (creating if needed) the memory database at `path`. `""` opens an
 * in-memory database. The injected/default factory owns the connection
 * pragmas (WAL + busy_timeout on the node profile; none on the browser
 * profile — opfs-sahpool is a serial single connection).
 */
export async function openDatabase(path: string, options?: MemoryDriverOptions): Promise<SqliteDatabase> {
	const factory = options?.sqlite ?? (await defaultFactory());
	return factory.open(path === "" ? ":memory:" : path);
}

/**
 * Read-only open, for multi-db probing/discovery. Routed through the factory's
 * `openReadonly` when it provides one (node: stat pre-flight three-state
 * `ReadonlyOpenError`); falls back to a plain `open` on factories without OS
 * permission semantics (browser — D3: readonly ≡ open there). Callers MUST
 * `close()` in a `finally`; a leaked handle is a leaked fd.
 */
export async function openDatabaseReadonly(path: string, options?: MemoryDriverOptions): Promise<SqliteDatabase> {
	const factory = options?.sqlite ?? (await defaultFactory());
	if (factory.openReadonly) return factory.openReadonly(path);
	return factory.open(path);
}

async function defaultFactory(): Promise<SqliteDatabaseFactory> {
	// Dynamic import on purpose: driver-node.ts pulls `node:sqlite`/`node:fs`,
	// platform-specific builtins that must stay out of the browser bundle's
	// static graph. The browser assembler always injects a factory, so this
	// branch never executes there.
	const { createNodeDriverFactory } = await import("./driver-node.ts");
	return createNodeDriverFactory();
}
