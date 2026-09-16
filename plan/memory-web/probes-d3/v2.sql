CREATE TABLE aliases (
		alias_uri TEXT PRIMARY KEY,
		target_node_id TEXT NOT NULL
	);
CREATE TABLE audit_log (
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
	);
CREATE TABLE autoretain_progress (
		session_id TEXT NOT NULL,
		task TEXT NOT NULL,
		entry_id TEXT NOT NULL,
		processed_at TEXT NOT NULL,
		PRIMARY KEY (session_id, task, entry_id)
	);
CREATE TABLE edges (
		node_id TEXT NOT NULL,
		target_uri TEXT NOT NULL,
		kind TEXT,
		PRIMARY KEY (node_id, target_uri)
	);
CREATE TABLE glossary (
		keyword TEXT PRIMARY KEY,
		node_id TEXT NOT NULL
	);
CREATE TABLE memory_embeddings (
		node_id TEXT NOT NULL,
		seg_index INTEGER NOT NULL,
		content_hash TEXT,
		vector TEXT,
		model TEXT,
		PRIMARY KEY (node_id, seg_index)
	);
CREATE TABLE memory_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT);
CREATE VIRTUAL TABLE node_fts USING fts5(node_id UNINDEXED, text, tokenize='unicode61');
CREATE TABLE 'node_fts_config'(k PRIMARY KEY, v) WITHOUT ROWID;
CREATE TABLE 'node_fts_content'(id INTEGER PRIMARY KEY, c0, c1);
CREATE TABLE 'node_fts_data'(id INTEGER PRIMARY KEY, block BLOB);
CREATE TABLE 'node_fts_docsize'(id INTEGER PRIMARY KEY, sz BLOB);
CREATE TABLE 'node_fts_idx'(segid, term, pgno, PRIMARY KEY(segid, term)) WITHOUT ROWID;
CREATE TABLE node_revisions (
		node_id TEXT NOT NULL,
		version INTEGER NOT NULL,
		uri TEXT,
		content TEXT NOT NULL,
		editor_source TEXT,
		editor_model TEXT,
		created_at TEXT NOT NULL,
		PRIMARY KEY (node_id, version)
	);
CREATE TABLE nodes (
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
	);
CREATE VIRTUAL TABLE raw_fts USING fts5(raw_id UNINDEXED, text, tokenize='unicode61');
CREATE TABLE 'raw_fts_config'(k PRIMARY KEY, v) WITHOUT ROWID;
CREATE TABLE 'raw_fts_content'(id INTEGER PRIMARY KEY, c0, c1);
CREATE TABLE 'raw_fts_data'(id INTEGER PRIMARY KEY, block BLOB);
CREATE TABLE 'raw_fts_docsize'(id INTEGER PRIMARY KEY, sz BLOB);
CREATE TABLE 'raw_fts_idx'(segid, term, pgno, PRIMARY KEY(segid, term)) WITHOUT ROWID;
CREATE TABLE raw_log (
		raw_id INTEGER PRIMARY KEY AUTOINCREMENT,
		role TEXT NOT NULL,
		text TEXT NOT NULL,
		entry_id TEXT NOT NULL,
		session_id TEXT NOT NULL,
		active INTEGER NOT NULL DEFAULT 1,
		wall_ts TEXT NOT NULL,
		world_ts TEXT
	);
CREATE INDEX idx_audit_log_ts ON audit_log(ts);
CREATE INDEX idx_edges_target ON edges(target_uri);
CREATE INDEX idx_node_revisions_uri ON node_revisions(uri);
CREATE INDEX idx_nodes_domain ON nodes(domain);
CREATE INDEX idx_nodes_parent_id ON nodes(parent_id);
CREATE INDEX idx_raw_log_entry_id ON raw_log(entry_id);
CREATE INDEX idx_raw_log_session_active ON raw_log(session_id, active, raw_id);
CREATE UNIQUE INDEX idx_raw_log_session_entry ON raw_log(session_id, entry_id);

-- version: 2 | objs: 30
