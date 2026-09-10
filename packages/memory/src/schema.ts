import type { MemoryDatabase } from "./driver.ts";

/** Bumped whenever STATEMENTS changes shape (§0: no migration path, cold rebuild). */
export const SCHEMA_VERSION = "2";
export const SCHEMA_VERSION_KEY = "schema_version";
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
		PRIMARY KEY (node_id, target_uri)
	)`,
	`CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_uri)`,
	`CREATE TABLE IF NOT EXISTS aliases (
		alias_uri TEXT PRIMARY KEY,
		target_node_id TEXT NOT NULL
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
	`CREATE VIRTUAL TABLE IF NOT EXISTS node_fts USING fts5(node_id UNINDEXED, text, tokenize='unicode61')`,
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

/**
 * Create the schema, or refuse to touch a database written by an older
 * version. §0 gives up on in-place migration, and CREATE INDEX IF NOT EXISTS
 * on a column the old shape lacks (e.g. node_revisions.uri) fails with a raw
 * "no such column" that reads like corruption. Reading the stored version
 * first turns that into an actionable message.
 */
export function createSchema(db: MemoryDatabase): void {
	const stored = readSchemaVersion(db);
	if (stored !== null && stored !== SCHEMA_VERSION) {
		throw new Error(
			`memory database schema v${stored} is incompatible with this build (v${SCHEMA_VERSION}). ` +
				`There is no in-place migration: delete the file (or point memory.dbPath / --memory-db elsewhere) to cold-start a fresh database.`,
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
