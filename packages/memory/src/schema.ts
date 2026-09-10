import type { MemoryDatabase } from "./driver.ts";

const STATEMENTS: string[] = [
	`CREATE TABLE IF NOT EXISTS nodes (
		node_id TEXT PRIMARY KEY,
		parent_id TEXT,
		domain TEXT NOT NULL,
		uri TEXT NOT NULL UNIQUE,
		content TEXT NOT NULL,
		disclosure TEXT,
		priority INTEGER NOT NULL DEFAULT 5,
		importance INTEGER NOT NULL DEFAULT 5,
		source TEXT NOT NULL CHECK(source IN ('auto','manual','import')),
		model TEXT,
		anchor_entry_id TEXT,
		created_at TEXT NOT NULL,
		world_ts TEXT,
		updated_ts TEXT NOT NULL,
		content_hash TEXT NOT NULL,
		is_stub INTEGER NOT NULL DEFAULT 0
	)`,
	`CREATE INDEX IF NOT EXISTS idx_nodes_parent_id ON nodes(parent_id)`,
	`CREATE INDEX IF NOT EXISTS idx_nodes_domain ON nodes(domain)`,
	`CREATE TABLE IF NOT EXISTS node_revisions (
		node_id TEXT NOT NULL,
		version INTEGER NOT NULL,
		content TEXT NOT NULL,
		editor_source TEXT,
		editor_model TEXT,
		created_at TEXT NOT NULL,
		PRIMARY KEY (node_id, version)
	)`,
	`CREATE TABLE IF NOT EXISTS edges (
		node_id TEXT NOT NULL,
		target_uri TEXT NOT NULL,
		kind TEXT,
		PRIMARY KEY (node_id, target_uri)
	)`,
	`CREATE TABLE IF NOT EXISTS aliases (
		alias_uri TEXT PRIMARY KEY,
		target_node_id TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS raw_log (
		raw_id INTEGER PRIMARY KEY AUTOINCREMENT,
		role TEXT NOT NULL,
		text TEXT NOT NULL,
		entry_id TEXT NOT NULL,
		wall_ts TEXT NOT NULL,
		world_ts TEXT
	)`,
	`CREATE INDEX IF NOT EXISTS idx_raw_log_entry_id ON raw_log(entry_id)`,
	// FTS mirrors (docs §3). Currently write-side only: recall scoring runs
	// in-memory via tokenizeForMatch (§9). Kept so a future MATCH-based query
	// path needs no backfill; the jieba space-joined tokens stored at write
	// time are unicode61-compatible.
	`CREATE VIRTUAL TABLE IF NOT EXISTS node_fts USING fts5(uri UNINDEXED, content, tokenize='unicode61')`,
	`CREATE VIRTUAL TABLE IF NOT EXISTS raw_fts USING fts5(entry_id UNINDEXED, text, tokenize='unicode61')`,
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
		object TEXT,
		source TEXT,
		model TEXT,
		turn INTEGER,
		task TEXT,
		anchor TEXT,
		details TEXT
	)`,
	`CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log(ts)`,
];

export function createSchema(db: MemoryDatabase): void {
	for (const sql of STATEMENTS) db.exec(sql);
}
