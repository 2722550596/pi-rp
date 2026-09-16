import { existsSync } from "node:fs";
import type { MemoryDatabase } from "./driver.ts";

/**
 * Bumped whenever `STATEMENTS` changes shape. v2 → v3 is an in-place migration
 * (`migrateV2`); a version with no migrator (v1, v99, a future build's) is
 * still refused with "incompatible with this build".
 */
export const SCHEMA_VERSION = "3";
export const SCHEMA_VERSION_KEY = "schema_version";

/**
 * The one physical copy of the `node_fts` DDL. Both `STATEMENTS` (fresh DBs)
 * and `migrateV2` (DROP + re-create) reference it, so the column layout can
 * only ever drift in one place. FTS5 tables cannot be ALTERed, and
 * `CREATE VIRTUAL TABLE IF NOT EXISTS` on an existing table of the same name
 * is a silent no-op (it keeps the old columns) — hence the explicit DROP.
 */
export const NODE_FTS_DDL =
	"CREATE VIRTUAL TABLE IF NOT EXISTS node_fts USING fts5(node_id UNINDEXED, text, disclosure, tokenize='unicode61')";

/**
 * `memory_kv` marker set by `migrateV2` and cleared once the FTS content has
 * been rebuilt (by `MemoryStore`'s constructor heal). A crash between the two
 * leaves "structure is v3 but node_fts is empty" — recoverable only because
 * this marker outlives the process.
 */
export const FTS_REBUILD_KEY = "fts_rebuild_pending";

/** Versions `createSchema` can migrate in place up to `SCHEMA_VERSION`. */
export const MIGRATABLE_FROM: readonly string[] = ["2"];
const STATEMENTS: string[] = [
	`CREATE TABLE IF NOT EXISTS nodes (
		node_id TEXT PRIMARY KEY,
		parent_id TEXT,
		domain TEXT NOT NULL,
		uri TEXT NOT NULL UNIQUE,
		content TEXT NOT NULL,
		disclosure TEXT,
		importance INTEGER NOT NULL DEFAULT 5,
		source TEXT NOT NULL CHECK(source IN ('auto','manual','import')),
		model TEXT,
		anchor_entry_id TEXT,
		anchor_session_id TEXT,
		first_raw_id INTEGER,
		last_raw_id INTEGER,
		created_at TEXT NOT NULL,
		world_ts TEXT,
		updated_ts TEXT NOT NULL,
		last_accessed_at TEXT,
		content_hash TEXT NOT NULL,
		is_stub INTEGER NOT NULL DEFAULT 0
	)`,
	`CREATE INDEX IF NOT EXISTS idx_nodes_parent_id ON nodes(parent_id)`,
	`CREATE INDEX IF NOT EXISTS idx_nodes_domain ON nodes(domain)`,
	// Revision history. `uri` is carried on every row so a revision stays
	// addressable after its node row is gone: forget() hard-deletes the node
	// (no zombie entries) but keeps the revisions as the recovery path
	// (docs §10 / decision 10, v5.4).
	`CREATE TABLE IF NOT EXISTS node_revisions (
		node_id TEXT NOT NULL,
		version INTEGER NOT NULL,
		uri TEXT,
		content TEXT NOT NULL,
		editor_source TEXT,
		editor_model TEXT,
		created_at TEXT NOT NULL,
		PRIMARY KEY (node_id, version)
	)`,
	`CREATE INDEX IF NOT EXISTS idx_node_revisions_uri ON node_revisions(uri)`,
	`CREATE TABLE IF NOT EXISTS edges (
		node_id TEXT NOT NULL,
		target_uri TEXT NOT NULL,
		kind TEXT,
		disclosure TEXT,
		PRIMARY KEY (node_id, target_uri)
	)`,
	`CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_uri)`,
	`CREATE TABLE IF NOT EXISTS aliases (
		alias_uri TEXT PRIMARY KEY,
		target_node_id TEXT NOT NULL,
		disclosure TEXT
	)`,
	// Raw transcript mirror (§4): rows are NEVER physically deleted — the
	// active-branch reconciliation flips `active` instead, so raw_id, wall and
	// world timestamps stay stable across rollbacks, and sessions sharing one
	// DB never see each other's rows touched. `session_id` scopes every
	// reconcile to its own session.
	`CREATE TABLE IF NOT EXISTS raw_log (
		raw_id INTEGER PRIMARY KEY AUTOINCREMENT,
		role TEXT NOT NULL,
		text TEXT NOT NULL,
		entry_id TEXT NOT NULL,
		session_id TEXT NOT NULL,
		active INTEGER NOT NULL DEFAULT 1,
		wall_ts TEXT NOT NULL,
		world_ts TEXT
	)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_log_session_entry ON raw_log(session_id, entry_id)`,
	`CREATE INDEX IF NOT EXISTS idx_raw_log_session_active ON raw_log(session_id, active, raw_id)`,
	`CREATE INDEX IF NOT EXISTS idx_raw_log_entry_id ON raw_log(entry_id)`,
	// FTS mirrors (docs §3): both tables are read through MATCH queries.
	// `text` holds the unified tokenizer output (jieba space-joined, or the
	// latin+CJK bigram fallback); the stable id column is UNINDEXED and used
	// to join back to the live table for active/visibility filtering.
	NODE_FTS_DDL,
	`CREATE VIRTUAL TABLE IF NOT EXISTS raw_fts USING fts5(raw_id UNINDEXED, text, tokenize='unicode61')`,
	`CREATE TABLE IF NOT EXISTS memory_embeddings (
		node_id TEXT NOT NULL,
		seg_index INTEGER NOT NULL,
		content_hash TEXT,
		vector TEXT,
		model TEXT,
		PRIMARY KEY (node_id, seg_index)
	)`,
	`CREATE TABLE IF NOT EXISTS glossary (
		keyword TEXT PRIMARY KEY,
		node_id TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS memory_kv (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL,
		updated_at TEXT
	)`,
	`CREATE TABLE IF NOT EXISTS audit_log (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		ts TEXT NOT NULL,
		world_ts TEXT,
		event TEXT NOT NULL,
		node_id TEXT,
		object TEXT,
		source TEXT,
		model TEXT,
		turn INTEGER,
		task TEXT,
		anchor TEXT,
		details TEXT
	)`,
	`CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log(ts)`,
	// Per-session, per-task autoretain progress (§5): each task consumes its
	// own window per session, so differently-cadenced tasks never eat each
	// other's rows and off-branch rows are not permanently skipped.
	`CREATE TABLE IF NOT EXISTS autoretain_progress (
		session_id TEXT NOT NULL,
		task TEXT NOT NULL,
		entry_id TEXT NOT NULL,
		processed_at TEXT NOT NULL,
		PRIMARY KEY (session_id, task, entry_id)
	)`,
];

/** What one `createSchema` call did, so callers and tests can assert on it. */
export type SchemaOpenResult = {
	/** null = fresh database; string = the version migrated from. */
	migratedFrom: string | null;
	/** true = the structure is at v3 but `node_fts` still needs a full rebuild. */
	ftsRebuildPending: boolean;
	/** Where the pre-migration backup landed, or why it was skipped. */
	backup: { path: string } | { skipped: string } | null;
};

/**
 * Create the schema, migrating an older in-place-migratable database up to
 * `SCHEMA_VERSION` (or refusing one written by an unsupported version).
 *
 * Reading the stored version first is what makes the failure actionable:
 * `CREATE INDEX IF NOT EXISTS` on a column the old shape lacks fails with a
 * raw "no such column" that reads like corruption. The v2/v1 split routes v2
 * into `migrateV2`, and recalcitrant versions into the same loud refusal as
 * before. This is the ONLY migration entry point — production goes through
 * `openMemoryStore` (`index.ts`), but seven test files call `createSchema`
 * directly and bypass it.
 */
export function createSchema(db: MemoryDatabase): SchemaOpenResult {
	const stored = readSchemaVersion(db);
	const needsMigration = stored !== null && stored !== SCHEMA_VERSION;
	if (needsMigration && !MIGRATABLE_FROM.includes(stored)) {
		throw new Error(
			`memory database schema v${stored} is incompatible with this build (v${SCHEMA_VERSION}). ` +
				`There is no in-place migration from v${stored}: back up the file and cold-start a fresh database ` +
				`(point memory.dbPath / --memory-db elsewhere), or use a build that can migrate it.`,
		);
	}
	let backup: SchemaOpenResult["backup"] = null;
	if (needsMigration) {
		// Backup runs BEFORE `BEGIN`: `VACUUM INTO` refuses to run inside a
		// transaction. A failed backup does not abort the migration — step 3
		// touches no user data, so the backup is redundancy for unknown problems,
		// not the atomicity mechanism (the transaction is).
		backup = backupBeforeMigration(db, stored);
		try {
			db.transaction(() => migrateV2(db));
		} catch (error) {
			const where = "path" in backup ? `; backup: ${backup.path}` : `; backup skipped: ${backup.skipped}`;
			throw new Error(
				`memory database migration failed (v${stored} → v${SCHEMA_VERSION})${where}: ${(error as Error).message}`,
			);
		}
		// stderr, NOT audit_log: a schema upgrade is not an operation on a memory
		// (see docs `memory-system.md` decision on audit events), and `schema.ts`
		// MUST NOT emit an unregistered event name into the frozen 16-name set.
		process.stderr.write(
			`[memory] schema v${stored} → v${SCHEMA_VERSION} migrated in place` +
				("path" in backup ? `; backup: ${backup.path}` : `; backup skipped: ${backup.skipped}`) +
				"\n",
		);
	}
	for (const sql of STATEMENTS) db.exec(sql);
	if (stored === null) {
		db.prepare("INSERT OR REPLACE INTO memory_kv (key, value, updated_at) VALUES (?, ?, ?)").run(
			SCHEMA_VERSION_KEY,
			SCHEMA_VERSION,
			new Date().toISOString(),
		);
	}
	return { migratedFrom: needsMigration ? stored : null, ftsRebuildPending: needsMigration, backup };
}

/**
 * The v2 → v3 structure migration. MUST be called inside a transaction (the
 * caller owns it) so the DDL and the version bump commit or roll back as one.
 *
 * Every action is gated on column EXISTENCE, never on the version number: a
 * snapshot import or a stray `seed()` can write a stale `schema_version` into
 * an already-v3 database, and a version-only migrator would then die with
 * `duplicate column name` on open.
 *
 * `node_fts` is rebuilt empty here; its content is recomputed by the store's
 * `reindexAll` (the sole tokenizer truth source), driven by FTS_REBUILD_KEY.
 */
function migrateV2(db: MemoryDatabase): void {
	if (!hasColumn(db, "aliases", "disclosure")) db.exec("ALTER TABLE aliases ADD COLUMN disclosure TEXT");
	if (!hasColumn(db, "edges", "disclosure")) db.exec("ALTER TABLE edges ADD COLUMN disclosure TEXT");
	// FTS5 tables cannot be ALTERed, and `CREATE VIRTUAL TABLE IF NOT EXISTS`
	// against the existing two-column table is a SILENT no-op that keeps two
	// columns — so the DROP is load-bearing, not defensive.
	if (!hasColumn(db, "node_fts", "disclosure")) {
		db.exec("DROP TABLE IF EXISTS node_fts");
		db.exec(NODE_FTS_DDL);
	}
	const writeKv = db.prepare("INSERT OR REPLACE INTO memory_kv (key, value, updated_at) VALUES (?, ?, ?)");
	writeKv.run(SCHEMA_VERSION_KEY, SCHEMA_VERSION, new Date().toISOString());
	writeKv.run(FTS_REBUILD_KEY, "1", new Date().toISOString());
}

/** Column existence probe — the migration's idempotence predicate. */
function hasColumn(db: MemoryDatabase, table: string, column: string): boolean {
	const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
	return rows.some((row) => row.name === column);
}

/** Main database file path, or null for `:memory:` / a failed PRAGMA. */
function databaseFilePath(db: MemoryDatabase): string | null {
	try {
		const rows = db.prepare("PRAGMA database_list").all() as Array<{ name: string; file: string }>;
		const file = rows.find((row) => row.name === "main")?.file ?? "";
		return file.length > 0 ? file : null;
	} catch {
		return null;
	}
}

/**
 * Snapshot the database with `VACUUM INTO` before migrating. Uses VACUUM INTO
 * rather than a bare `cp` because it reads through the connection and therefore
 * includes data still living in the WAL; a `cp` of the main file alone silently
 * drops the most recent transactions.
 *
 * The timestamp is second-resolution, so a same-second second migration would
 * collide — and `VACUUM INTO` refuses to overwrite a target. Hence the `-N`
 * suffix scan: predictable names a user can find, no randomness.
 */
function backupBeforeMigration(db: MemoryDatabase, fromVersion: string): { path: string } | { skipped: string } {
	const file = databaseFilePath(db);
	if (!file) return { skipped: "in-memory database" };
	const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
	let target = `${file}.pre-v${fromVersion}-${stamp}.bak`;
	for (let i = 2; existsSync(target); i++) target = `${file}.pre-v${fromVersion}-${stamp}-${i}.bak`;
	try {
		db.prepare("VACUUM INTO ?").run(target);
		return { path: target };
	} catch (error) {
		return { skipped: (error as Error).message };
	}
}

/** Stored schema version, or null when memory_kv is not there yet. */
function readSchemaVersion(db: MemoryDatabase): string | null {
	try {
		const row = db.prepare("SELECT value FROM memory_kv WHERE key = ?").get(SCHEMA_VERSION_KEY) as
			| { value: string }
			| undefined;
		return row?.value ?? null;
	} catch {
		// memory_kv missing: a fresh db. Proceed — an old file whose kv table is
		// gone is caught by the CREATE statements below with a clear error.
		return null;
	}
}
