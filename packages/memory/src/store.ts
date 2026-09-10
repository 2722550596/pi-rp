import type { MemoryDatabase, MemoryStatement } from "./driver.ts";
import { tokenizeForMatch, tokenizeForSearch } from "./tokenize.ts";

export type NodeSource = "auto" | "manual" | "import";

export interface MemoryNode {
	node_id: string;
	parent_id: string | null;
	domain: string;
	uri: string;
	content: string;
	disclosure: string | null;
	priority: number;
	importance: number;
	source: NodeSource;
	model: string | null;
	anchor_entry_id: string | null;
	created_at: string;
	world_ts: string | null;
	updated_ts: string;
	content_hash: string;
	is_stub: number;
}

export interface NodeInput {
	uri: string;
	content: string;
	parent_uri?: string | null;
	disclosure?: string | null;
	priority?: number;
	importance?: number;
	source?: NodeSource;
	model?: string | null;
	anchor_entry_id?: string | null;
	world_ts?: string | null;
}

export interface NodePatch {
	content?: string;
	disclosure?: string | null;
	priority?: number;
	importance?: number;
	editor_source?: NodeSource;
	editor_model?: string | null;
	world_ts?: string | null;
}

export interface RawEntry {
	raw_id?: number;
	role: string;
	text: string;
	entry_id: string;
	wall_ts: string;
	world_ts?: string | null;
}

export interface RecallOptions {
	domainBlocklist?: string[];
	domain?: string;
	limit?: number;
	visibleOnly?: boolean;
}

export type VisibilityPredicate = (node: MemoryNode) => boolean;

export interface ExportSnapshot {
	nodes: MemoryNode[];
	revisions: Array<{
		node_id: string;
		version: number;
		content: string;
		editor_source: string | null;
		editor_model: string | null;
		created_at: string;
	}>;
	kv: Record<string, string>;
}

interface NodeRow {
	node_id: string;
	parent_id: string | null;
	domain: string;
	uri: string;
	content: string;
	disclosure: string | null;
	priority: number;
	importance: number;
	source: string;
	model: string | null;
	anchor_entry_id: string | null;
	created_at: string;
	world_ts: string | null;
	updated_ts: string;
	content_hash: string;
	is_stub: number;
}

function hashContent(content: string): string {
	// FNV-1a 32-bit hex; stable, allocation-free, no crypto needed.
	let h = 0x811c9dc5;
	for (let i = 0; i < content.length; i++) {
		h ^= content.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, "0");
}

const RELATIVE_TIME = /^([+-])(\d+)([smhdwy])$/;
const UNIT_SECONDS: Record<string, number> = {
	s: 1,
	m: 60,
	h: 3600,
	d: 86400,
	w: 604800,
	y: 31536000,
};

const WORLD_TIME_KEY = "world_time";
const SCHEMA_VERSION_KEY = "schema_version";
const SCHEMA_VERSION = "1";

export class MemoryStore {
	readonly db: MemoryDatabase;
	private getStmt: MemoryStatement;
	private byUriStmt: MemoryStatement;
	private childrenStmt: MemoryStatement;
	private blocklist: string[] = [];

	constructor(db: MemoryDatabase) {
		this.db = db;
		this.getStmt = db.prepare("SELECT * FROM nodes WHERE node_id = ?");
		this.byUriStmt = db.prepare("SELECT * FROM nodes WHERE uri = ?");
		this.childrenStmt = db.prepare("SELECT * FROM nodes WHERE parent_id = ? ORDER BY created_at");
	}

	setDomainBlocklist(domains: string[]): void {
		this.blocklist = [...domains];
	}

	getDomainBlocklist(): string[] {
		return [...this.blocklist];
	}

	// ── Addressing ────────────────────────────────────────────────────────────

	resolveUri(uri: string): MemoryNode | null {
		const direct = this.rowToNode(this.byUriStmt.get(uri) as NodeRow | undefined);
		if (direct) return direct;
		const alias = this.db.prepare("SELECT target_node_id FROM aliases WHERE alias_uri = ?").get(uri) as
			| { target_node_id: string }
			| undefined;
		if (!alias) return null;
		return this.rowToNode(this.getStmt.get(alias.target_node_id) as NodeRow | undefined);
	}

	getNode(nodeId: string): MemoryNode | null {
		return this.rowToNode(this.getStmt.get(nodeId) as NodeRow | undefined);
	}

	getNodeByUri(uri: string): MemoryNode | null {
		return this.resolveUri(uri);
	}

	// ── CRUD ──────────────────────────────────────────────────────────────────

	insertNode(input: NodeInput): MemoryNode {
		return this.db.transaction(() => this._insertNode(input));
	}

	private _insertNode(input: NodeInput, isStub = false): MemoryNode {
		const now = new Date().toISOString();
		const nodeId = this.generateId("n");
		const domain = input.uri.split("://")[0] ?? input.uri;
		let parent: string | null = null;
		if (input.parent_uri) {
			const parentNode = this.resolveUri(input.parent_uri);
			if (parentNode) parent = parentNode.node_id;
		}
		this.db
			.prepare(
				`INSERT INTO nodes (node_id, parent_id, domain, uri, content, disclosure, priority, importance,
					source, model, anchor_entry_id, created_at, world_ts, updated_ts, content_hash, is_stub)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				nodeId,
				parent,
				domain,
				input.uri,
				input.content,
				input.disclosure ?? null,
				input.priority ?? 5,
				input.importance ?? 5,
				input.source ?? "manual",
				input.model ?? null,
				input.anchor_entry_id ?? null,
				now,
				input.world_ts ?? this.getWorldTime(),
				now,
				hashContent(input.content),
				isStub ? 1 : 0,
			);
		if (!isStub) this.indexNodeFts(input.uri, input.content);
		const node = this.getNode(nodeId);
		if (!node) throw new Error(`insertNode: node ${nodeId} vanished`);
		this.logAudit("insert_node", { object: input.uri, source: node.source });
		return node;
	}

	/** put(): upsert by uri. Missing ancestors are auto-created as stub nodes. */
	put(input: NodeInput): MemoryNode {
		return this.db.transaction(() => {
			const existing = this.resolveUri(input.uri);
			if (existing) {
				this._updateNode(existing.node_id, { content: input.content, world_ts: input.world_ts ?? null });
				return this.getNode(existing.node_id) as MemoryNode;
			}
			this.ensureStubAncestors(input.uri, input.parent_uri ?? null);
			const parentUri = input.parent_uri ?? this.implicitParentUri(input.uri);
			return this._insertNode({ ...input, parent_uri: parentUri });
		});
	}

	private ensureStubAncestors(uri: string, explicitParent: string | null): void {
		if (explicitParent) return;
		// Scheme separator ("scheme://") must not count as a path segment boundary.
		const parts = uri.split("://");
		const prefix = parts.length === 2 ? `${parts[0]}://` : "";
		const segments = (parts[parts.length - 1] ?? "").split("/");
		if (segments.length < 2) return;
		let parentUri: string | null = null;
		for (let i = 0; i < segments.length - 1; i++) {
			const ancestorUri = prefix + segments.slice(0, i + 1).join("/");
			if (this.resolveUri(ancestorUri)) {
				parentUri = ancestorUri;
				continue;
			}
			this._insertNode(
				{ uri: ancestorUri, content: `(stub: ${ancestorUri})`, parent_uri: parentUri, source: "manual" },
				true,
			);
			parentUri = ancestorUri;
		}
	}

	/** The implicit parent of a hierarchical uri: the uri minus its last segment. */
	private implicitParentUri(uri: string): string | null {
		const parts = uri.split("://");
		const prefix = parts.length === 2 ? `${parts[0]}://` : "";
		const segments = (parts[parts.length - 1] ?? "").split("/");
		if (segments.length < 2) return null;
		return prefix + segments.slice(0, -1).join("/");
	}

	private _updateNode(nodeId: string, patch: NodePatch): number {
		const node = this.getNode(nodeId);
		if (!node) throw new Error(`updateNode: unknown node ${nodeId}`);
		if (patch.content === undefined || patch.content === node.content) {
			// Non-content patches just touch columns without revision churn.
			this.applyPatchColumns(nodeId, patch);
			return node.content_hash === hashContent(node.content) ? this.currentVersion(nodeId) : 0;
		}
		const version = this.archiveRevision(
			nodeId,
			node.content,
			patch.editor_source ?? null,
			patch.editor_model ?? null,
		);
		this.applyPatchColumns(nodeId, { ...patch, content: patch.content });
		this.db
			.prepare("UPDATE nodes SET content_hash = ?, updated_ts = ? WHERE node_id = ?")
			.run(hashContent(patch.content), new Date().toISOString(), nodeId);
		this.indexNodeFts(node.uri, patch.content);
		this.logAudit("update_node", { object: node.uri });
		return version;
	}

	private applyPatchColumns(nodeId: string, patch: NodePatch): void {
		const sets: string[] = [];
		const values: unknown[] = [];
		if (patch.content !== undefined) {
			sets.push("content = ?");
			values.push(patch.content);
		}
		if (patch.disclosure !== undefined) {
			sets.push("disclosure = ?");
			values.push(patch.disclosure);
		}
		if (patch.priority !== undefined) {
			sets.push("priority = ?");
			values.push(patch.priority);
		}
		if (patch.importance !== undefined) {
			sets.push("importance = ?");
			values.push(patch.importance);
		}
		if (patch.world_ts !== undefined) {
			sets.push("world_ts = ?");
			values.push(patch.world_ts);
		}
		sets.push("updated_ts = ?");
		values.push(new Date().toISOString());
		values.push(nodeId);
		this.db.prepare(`UPDATE nodes SET ${sets.join(", ")} WHERE node_id = ?`).run(...values);
	}

	updateNode(nodeId: string, patch: NodePatch): number {
		return this.db.transaction(() => this._updateNode(nodeId, patch));
	}

	archiveRevision(nodeId: string, content: string, editorSource: string | null, editorModel: string | null): number {
		const version = this.currentVersion(nodeId) + 1;
		this.db
			.prepare(
				`INSERT INTO node_revisions (node_id, version, content, editor_source, editor_model, created_at)
				VALUES (?, ?, ?, ?, ?, ?)`,
			)
			.run(nodeId, version, content, editorSource, editorModel, new Date().toISOString());
		return version;
	}

	currentVersion(nodeId: string): number {
		const row = this.db.prepare("SELECT MAX(version) AS v FROM node_revisions WHERE node_id = ?").get(nodeId) as
			| { v: number | null }
			| undefined;
		return row?.v ?? 0;
	}

	listRevisions(nodeId: string): Array<{ version: number; content: string; created_at: string }> {
		return this.db
			.prepare("SELECT version, content, created_at FROM node_revisions WHERE node_id = ? ORDER BY version")
			.all(nodeId) as Array<{ version: number; content: string; created_at: string }>;
	}

	restoreRevision(nodeId: string, version: number): void {
		const rev = this.db
			.prepare("SELECT content FROM node_revisions WHERE node_id = ? AND version = ?")
			.get(nodeId, version) as { content: string } | undefined;
		if (!rev) throw new Error(`restoreRevision: no version ${version} for ${nodeId}`);
		this._updateNode(nodeId, { content: rev.content });
	}

	deleteCascade(nodeId: string): number {
		return this.db.transaction(() => this._deleteCascade(nodeId));
	}

	private _deleteCascade(nodeId: string): number {
		const node = this.getNode(nodeId);
		if (!node) return 0;
		let deleted = 1;
		const children = this.db.prepare("SELECT node_id FROM nodes WHERE parent_id = ?").all(nodeId) as Array<{
			node_id: string;
		}>;
		for (const child of children) deleted += this._deleteCascade(child.node_id);
		this.db.prepare("DELETE FROM node_fts WHERE uri = ?").run(node.uri);
		this.db.prepare("DELETE FROM aliases WHERE target_node_id = ?").run(nodeId);
		this.db.prepare("DELETE FROM edges WHERE node_id = ? OR target_uri = ?").run(nodeId, node.uri);
		this.db.prepare("DELETE FROM glossary WHERE node_id = ?").run(nodeId);
		this.db.prepare("DELETE FROM memory_embeddings WHERE node_id = ?").run(nodeId);
		this.db.prepare("DELETE FROM node_revisions WHERE node_id = ?").run(nodeId);
		this.db.prepare("DELETE FROM nodes WHERE node_id = ?").run(nodeId);
		this.logAudit("delete_node", { object: node.uri });
		return deleted;
	}

	rename(oldUri: string, newUri: string): void {
		this.db.transaction(() => {
			const node = this.resolveUri(oldUri);
			if (!node) throw new Error(`rename: unknown uri ${oldUri}`);
			const updated = new Date().toISOString();
			const domain = newUri.split("://")[0] ?? newUri;
			this.db
				.prepare("UPDATE nodes SET uri = ?, domain = ?, updated_ts = ? WHERE node_id = ?")
				.run(newUri, domain, updated, node.node_id);
			// Preserve the old address as an alias so existing links do not break.
			this.db
				.prepare("INSERT OR REPLACE INTO aliases (alias_uri, target_node_id) VALUES (?, ?)")
				.run(oldUri, node.node_id);
			// Reindex FTS with the new uri.
			this.db.prepare("DELETE FROM node_fts WHERE uri = ?").run(node.uri);
			const current = this.getNode(node.node_id) as MemoryNode;
			this.indexNodeFts(newUri, current.content);
			this.logAudit("rename_node", { object: `${oldUri} -> ${newUri}` });
		});
	}

	// ── Edges / aliases / glossary ────────────────────────────────────────────

	addEdge(nodeId: string, targetUri: string, kind?: string): void {
		this.db
			.prepare("INSERT OR REPLACE INTO edges (node_id, target_uri, kind) VALUES (?, ?, ?)")
			.run(nodeId, targetUri, kind ?? null);
		this.logAudit("add_edge", { object: `${nodeId} -> ${targetUri}` });
	}

	addAlias(aliasUri: string, targetNodeId: string): void {
		this.db
			.prepare("INSERT OR REPLACE INTO aliases (alias_uri, target_node_id) VALUES (?, ?)")
			.run(aliasUri, targetNodeId);
	}

	listAliases(targetNodeId: string): string[] {
		return (
			this.db.prepare("SELECT alias_uri FROM aliases WHERE target_node_id = ?").all(targetNodeId) as Array<{
				alias_uri: string;
			}>
		).map((r) => r.alias_uri);
	}
	addGlossaryEntry(keyword: string, nodeId: string): void {
		this.db.prepare("INSERT OR REPLACE INTO glossary (keyword, node_id) VALUES (?, ?)").run(keyword, nodeId);
		this.logAudit("add_glossary", { object: keyword });
	}

	removeGlossaryEntry(keyword: string): void {
		this.db.prepare("DELETE FROM glossary WHERE keyword = ?").run(keyword);
		this.logAudit("remove_glossary", { object: keyword });
	}

	listGlossary(nodeId?: string): Array<{ keyword: string; node_id: string }> {
		if (nodeId !== undefined) {
			return this.db
				.prepare("SELECT keyword, node_id FROM glossary WHERE node_id = ? ORDER BY keyword")
				.all(nodeId) as Array<{ keyword: string; node_id: string }>;
		}
		return this.db.prepare("SELECT keyword, node_id FROM glossary ORDER BY keyword").all() as Array<{
			keyword: string;
			node_id: string;
		}>;
	}

	lookupGlossary(keyword: string): string | null {
		const row = this.db.prepare("SELECT node_id FROM glossary WHERE keyword = ?").get(keyword) as
			| { node_id: string }
			| undefined;
		return row?.node_id ?? null;
	}

	// ── raw_log ───────────────────────────────────────────────────────────────

	appendRaw(entries: RawEntry[]): number {
		return this.db.transaction(() => {
			let lastId = 0;
			for (const entry of entries) {
				const result = this.db
					.prepare("INSERT INTO raw_log (role, text, entry_id, wall_ts, world_ts) VALUES (?, ?, ?, ?, ?)")
					.run(entry.role, entry.text, entry.entry_id, entry.wall_ts, entry.world_ts ?? null);
				lastId = Number(result.lastInsertRowid);
				this.db
					.prepare("INSERT INTO raw_fts (entry_id, text) VALUES (?, ?)")
					.run(entry.entry_id, tokenizeForSearch(entry.text));
			}
			return lastId;
		});
	}

	listRaw(
		fromRawId: number,
		toRawId?: number,
	): Array<{ raw_id: number; role: string; text: string; entry_id: string }> {
		if (toRawId === undefined) {
			return this.db
				.prepare("SELECT raw_id, role, text, entry_id FROM raw_log WHERE raw_id = ?")
				.all(fromRawId) as Array<{ raw_id: number; role: string; text: string; entry_id: string }>;
		}
		return this.db
			.prepare("SELECT raw_id, role, text, entry_id FROM raw_log WHERE raw_id >= ? AND raw_id <= ? ORDER BY raw_id")
			.all(fromRawId, toRawId) as Array<{ raw_id: number; role: string; text: string; entry_id: string }>;
	}

	/** Latest N raw_log rows ascending (autoretain 纪要窗口，§5/§9). */
	listRawTail(limit: number): Array<{ raw_id: number; role: string; text: string }> {
		const rows = this.db
			.prepare("SELECT raw_id, role, text FROM raw_log ORDER BY raw_id DESC LIMIT ?")
			.all(limit) as Array<{ raw_id: number; role: string; text: string }>;
		return rows.reverse();
	}

	/**
	 * Reconcile raw_log against the active branch: physically delete rows whose
	 * entry_id is not on the active path (§8 — 切换即对账). Compute the
	 * full keep-set first, then delete in chunks (SQLite parameter limit is
	 * 32766; 500-sized chunks stay far below it). An empty active path is
	 * treated as "not ready" and skipped — the caller must pass a real
	 * snapshot; wiping the whole log is never a reconciliation side effect.
	 */
	reconcileRawLog(activeEntryIds: string[]): number {
		if (activeEntryIds.length === 0) return 0;
		return this.db.transaction(() => {
			const keep = new Set(activeEntryIds);
			const rows = this.db.prepare("SELECT raw_id, entry_id FROM raw_log").all() as Array<{
				raw_id: number;
				entry_id: string;
			}>;
			const stale = rows.filter((r) => !keep.has(r.entry_id)).map((r) => r.raw_id);
			for (let i = 0; i < stale.length; i += 500) {
				const chunk = stale.slice(i, i + 500);
				const placeholders = chunk.map(() => "?").join(", ");
				this.db.prepare(`DELETE FROM raw_log WHERE raw_id IN (${placeholders})`).run(...chunk);
			}
			// FTS mirror: rows only ever enter via raw_log, so one pass after
			// the deletes suffices.
			this.db.prepare("DELETE FROM raw_fts WHERE entry_id NOT IN (SELECT entry_id FROM raw_log)").run();
			if (stale.length > 0) this.logAudit("reconcile_raw", { details: String(stale.length) });
			return stale.length;
		});
	}

	// ── kv / world clock ──────────────────────────────────────────────────────

	getKv(key: string): string | null {
		const row = this.db.prepare("SELECT value FROM memory_kv WHERE key = ?").get(key) as
			| { value: string }
			| undefined;
		return row?.value ?? null;
	}

	setKv(key: string, value: string): void {
		this.db
			.prepare("INSERT OR REPLACE INTO memory_kv (key, value, updated_at) VALUES (?, ?, ?)")
			.run(key, value, new Date().toISOString());
	}

	getWorldTime(): string | null {
		return this.getKv(WORLD_TIME_KEY);
	}

	/** setWorldTime("2026-09-10T12:00:00Z") or relative like "+1d", "-2h". */
	setWorldTime(value: string): string {
		const current = this.getWorldTime();
		const match = RELATIVE_TIME.exec(value);
		if (match) {
			const sign = match[1] === "+" ? 1 : -1;
			const amount = Number(match[2]);
			const unit = match[3];
			const base = current ? Date.parse(current) : Date.now();
			if (Number.isNaN(base)) throw new Error(`setWorldTime: invalid current world time ${String(current)}`);
			const next = new Date(base + sign * amount * UNIT_SECONDS[unit] * 1000).toISOString();
			this.setKv(WORLD_TIME_KEY, next);
			this.logAudit("set_world_time", { details: next });
			return next;
		}
		if (Number.isNaN(Date.parse(value))) throw new Error(`setWorldTime: invalid time ${value}`);
		this.setKv(WORLD_TIME_KEY, value);
		this.logAudit("set_world_time", { details: value });
		return value;
	}

	// ── Recall ────────────────────────────────────────────────────────────────

	recall(query: string, options: RecallOptions = {}): MemoryNode[] {
		const blocklist = options.domainBlocklist ?? this.blocklist;
		const limit = options.limit ?? 10;
		const queryTokens = new Set(tokenizeForMatch(query));
		if (queryTokens.size === 0) return [];
		const candidates = this.listNodes({ domain: options.domain });
		const scored: Array<{ node: MemoryNode; score: number }> = [];
		for (const node of candidates) {
			if (node.is_stub) continue;
			if (blocklist.includes(node.domain)) continue;
			if (options.visibleOnly && !this.isVisible(node)) continue;
			const docTokens = new Set(tokenizeForMatch(`${node.uri} ${node.disclosure ?? ""} ${node.content}`));
			let hits = 0;
			for (const token of queryTokens) if (docTokens.has(token)) hits++;
			if (hits === 0) continue;
			const queryPrecision = hits / queryTokens.size;
			const docCoverage = hits / docTokens.size;
			const keyword = Math.max(queryPrecision, docCoverage * 1.4);
			const priority = node.priority / 10;
			const score = keyword * 0.85 + priority * 0.15;
			if (score <= 0) continue;
			scored.push({ node, score });
		}
		return scored.slice(0, limit).map((s) => s.node);
	}
	/**
	 * Visibility predicate (§8), raw form: auto nodes are visible only when
	 * their anchor entry is on the active branch. Callers hold the branch
	 * state — pass `anchorActive=false` for anchors that left the path. The
	 * session-bound module keeps the live hidden-set; this store-level form
	 * exists for tests and direct library consumers.
	 */
	isVisible(node: MemoryNode, anchorActive = true): boolean {
		if (node.source !== "auto") return true;
		return anchorActive && Boolean(node.anchor_entry_id);
	}

	countTempNodes(): number {
		const row = this.db
			.prepare("SELECT COUNT(*) AS c FROM nodes WHERE uri LIKE 'TEMP://%' AND is_stub = 0")
			.get() as { c: number };
		return row.c;
	}

	listNodes(options: { domain?: string } = {}): MemoryNode[] {
		const rows = options.domain
			? (this.db
					.prepare("SELECT * FROM nodes WHERE domain = ? ORDER BY created_at")
					.all(options.domain) as NodeRow[])
			: (this.db.prepare("SELECT * FROM nodes ORDER BY created_at").all() as NodeRow[]);
		return rows.map((r) => this.rowToNode(r) as MemoryNode);
	}

	children(nodeId: string): MemoryNode[] {
		return (this.childrenStmt.all(nodeId) as NodeRow[]).map((r) => this.rowToNode(r) as MemoryNode);
	}

	/** Most recently updated non-stub nodes (recency views / recent slot). */
	listRecentNodes(limit: number, domain?: string): MemoryNode[] {
		const sql = `SELECT * FROM nodes WHERE is_stub = 0${domain ? " AND domain = ?" : ""}
			ORDER BY updated_ts DESC LIMIT ?`;
		const rows = (domain ? this.db.prepare(sql).all(domain, limit) : this.db.prepare(sql).all(limit)) as NodeRow[];
		return rows.map((r) => this.rowToNode(r) as MemoryNode);
	}

	listDomains(): string[] {
		return (
			this.db.prepare("SELECT DISTINCT domain FROM nodes ORDER BY domain").all() as Array<{ domain: string }>
		).map((r) => r.domain);
	}

	// ── Export / import / seed ────────────────────────────────────────────────

	/**
	 * Snapshot scope per docs §12: tree + revisions + kv. Association surfaces
	 * (aliases/edges/glossary) are intentionally excluded — they are derivable
	 * maintenance state, not memory content.
	 */
	export(): ExportSnapshot {
		const nodes = this.listNodes();
		const revisions = this.db
			.prepare(
				"SELECT node_id, version, content, editor_source, editor_model, created_at FROM node_revisions ORDER BY node_id, version",
			)
			.all() as ExportSnapshot["revisions"];
		const kvRows = this.db.prepare("SELECT key, value FROM memory_kv").all() as Array<{ key: string; value: string }>;
		const kv: Record<string, string> = {};
		for (const row of kvRows) kv[row.key] = row.value;
		return { nodes, revisions, kv };
	}

	import(snapshot: ExportSnapshot): void {
		this.db.transaction(() => {
			for (const node of snapshot.nodes) {
				this.db
					.prepare(
						`INSERT OR REPLACE INTO nodes (node_id, parent_id, domain, uri, content, disclosure, priority,
							importance, source, model, anchor_entry_id, created_at, world_ts, updated_ts, content_hash, is_stub)
						VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					)
					.run(
						node.node_id,
						node.parent_id,
						node.domain,
						node.uri,
						node.content,
						node.disclosure,
						node.priority,
						node.importance,
						node.source,
						node.model,
						node.anchor_entry_id,
						node.created_at,
						node.world_ts,
						node.updated_ts,
						node.content_hash,
						node.is_stub,
					);
				if (!node.is_stub) this.indexNodeFts(node.uri, node.content);
			}
			for (const rev of snapshot.revisions) {
				this.db
					.prepare(
						"INSERT OR REPLACE INTO node_revisions (node_id, version, content, editor_source, editor_model, created_at) VALUES (?, ?, ?, ?, ?, ?)",
					)
					.run(rev.node_id, rev.version, rev.content, rev.editor_source, rev.editor_model, rev.created_at);
			}
			for (const [key, value] of Object.entries(snapshot.kv)) {
				this.setKv(key, value);
			}
		});
		this.logAudit("import_snapshot", { details: String(snapshot.nodes.length) });
	}

	seed(): void {
		this.db.transaction(() => {
			this.setKv(SCHEMA_VERSION_KEY, SCHEMA_VERSION);
			if (!this.resolveUri("index://")) {
				this._insertNode({ uri: "index://", content: "Index domain root", source: "manual" });
			}
			if (!this.resolveUri("history://")) {
				this._insertNode({ uri: "history://", content: "Scene summary domain", source: "manual" });
			}
			if (!this.resolveUri("meta://")) {
				this._insertNode({ uri: "meta://", content: "Self-reflection domain", source: "manual" });
			}
		});
		this.logAudit("seed", { details: "seed" });
	}

	// ── Audit ─────────────────────────────────────────────────────────────────

	logAudit(event: string, details: { object?: string; source?: string; model?: string; details?: string } = {}): void {
		this.db
			.prepare(
				"INSERT INTO audit_log (ts, world_ts, event, object, source, model, details) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				new Date().toISOString(),
				this.getWorldTime(),
				event,
				details.object ?? null,
				details.source ?? null,
				details.model ?? null,
				details.details ?? null,
			);
	}

	listAudit(limit = 50): Array<{ id: number; ts: string; event: string; object: string | null }> {
		return this.db
			.prepare("SELECT id, ts, event, object FROM audit_log ORDER BY id DESC LIMIT ?")
			.all(limit) as Array<{ id: number; ts: string; event: string; object: string | null }>;
	}

	// ── Internals ─────────────────────────────────────────────────────────────

	private indexNodeFts(uri: string, content: string): void {
		this.db.prepare("DELETE FROM node_fts WHERE uri = ?").run(uri);
		if (!content) return;
		this.db.prepare("INSERT INTO node_fts (uri, content) VALUES (?, ?)").run(uri, tokenizeForSearch(content));
	}

	private rowToNode(row: NodeRow | undefined): MemoryNode | null {
		if (!row) return null;
		return { ...row, source: row.source as NodeSource };
	}

	private idCounter = 0;

	private generateId(prefix: string): string {
		this.idCounter = (this.idCounter + 1) % 0xffffffff;
		return `${prefix}_${Date.now().toString(36)}_${this.idCounter.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
	}
}
