import type { MemoryDatabase, MemoryStatement } from "./driver.ts";
import { buildGlossaryTerms, buildPool, rank, toEpochDays } from "./recall.ts";
import { SCHEMA_VERSION, SCHEMA_VERSION_KEY } from "./schema.ts";
import { tokenizeForSearch } from "./tokenize.ts";

export type NodeSource = "auto" | "manual" | "import";

export interface MemoryNode {
	node_id: string;
	parent_id: string | null;
	domain: string;
	uri: string;
	content: string;
	disclosure: string | null;
	/** 重要性：10 = 最重要，5 = 普通，0 = 边角料（数值越大越重要；单列口径）。 */
	importance: number;
	source: NodeSource;
	model: string | null;
	anchor_entry_id: string | null;
	/** Session that produced this node (auto nodes; manual/import may carry it). */
	anchor_session_id: string | null;
	/** Raw-log window this node summarizes (autoretain products; §4 consumption path). */
	first_raw_id: number | null;
	last_raw_id: number | null;
	created_at: string;
	world_ts: string | null;
	updated_ts: string;
	/** Last time the character ACTIVELY recalled/retrieved this node (§13 沉睡语义). */
	last_accessed_at: string | null;
	content_hash: string;
	is_stub: number;
}

export interface NodeInput {
	uri: string;
	content: string;
	parent_uri?: string | null;
	disclosure?: string | null;
	importance?: number;
	source?: NodeSource;
	model?: string | null;
	anchor_entry_id?: string | null;
	anchor_session_id?: string | null;
	first_raw_id?: number | null;
	last_raw_id?: number | null;
	world_ts?: string | null;
}

export interface NodePatch {
	content?: string;
	disclosure?: string | null;
	importance?: number;
	editor_source?: NodeSource;
	editor_model?: string | null;
	model?: string | null;
	anchor_entry_id?: string | null;
	anchor_session_id?: string | null;
	first_raw_id?: number | null;
	last_raw_id?: number | null;
	world_ts?: string | null;
}

export interface RawEntry {
	raw_id?: number;
	role: string;
	text: string;
	entry_id: string;
	session_id: string;
	wall_ts: string;
	world_ts?: string | null;
}

export interface RecallOptions {
	domainBlocklist?: string[];
	domain?: string;
	limit?: number;
	/** Explicit visibility predicate — callers own the branch state (§8). */
	isVisible?: VisibilityPredicate;
}

export type VisibilityPredicate = (node: MemoryNode) => boolean;

/** Structured audit fields (docs §12 decision 23). */
export interface MemoryAuditDetails {
	node_id?: string;
	object?: string;
	source?: string;
	model?: string;
	turn?: number;
	task?: string;
	anchor?: string;
	details?: string;
}

export interface ExportSnapshot {
	nodes: MemoryNode[];
	revisions: Array<{
		node_id: string;
		version: number;
		uri: string | null;
		content: string;
		editor_source: string | null;
		editor_model: string | null;
		created_at: string;
	}>;
	kv: Record<string, string>;
	aliases: Array<{ alias_uri: string; target_node_id: string }>;
	edges: Array<{ node_id: string; target_uri: string; kind: string | null }>;
	glossary: Array<{ keyword: string; node_id: string }>;
}

interface NodeRow {
	node_id: string;
	parent_id: string | null;
	domain: string;
	uri: string;
	content: string;
	disclosure: string | null;
	importance: number;
	source: string;
	model: string | null;
	anchor_entry_id: string | null;
	anchor_session_id: string | null;
	first_raw_id: number | null;
	last_raw_id: number | null;
	created_at: string;
	world_ts: string | null;
	updated_ts: string;
	last_accessed_at: string | null;
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

export class MemoryStore {
	readonly db: MemoryDatabase;
	private getStmt: MemoryStatement;
	private byUriStmt: MemoryStatement;
	private childrenStmt: MemoryStatement;
	private blocklist: string[] = [];
	private revisionRetention: number | undefined;

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

	private _insertNode(input: NodeInput, isStub = false, forceId?: string): MemoryNode {
		const now = new Date().toISOString();
		// forceId: restoreDeleted() re-creates a node under its ORIGINAL id so the
		// revision history reconnects instead of orphaning (docs §10 recovery).
		const nodeId = forceId ?? this.generateId("n");
		const domain = input.uri.split("://")[0] ?? input.uri;
		let parent: string | null = null;
		if (input.parent_uri) {
			const parentNode = this.resolveUri(input.parent_uri);
			if (parentNode) parent = parentNode.node_id;
		}
		this.db
			.prepare(
				`INSERT INTO nodes (node_id, parent_id, domain, uri, content, disclosure, importance,
					source, model, anchor_entry_id, anchor_session_id, first_raw_id, last_raw_id,
					created_at, world_ts, updated_ts, last_accessed_at, content_hash, is_stub)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				nodeId,
				parent,
				domain,
				input.uri,
				input.content,
				input.disclosure ?? null,
				input.importance ?? 5,
				input.source ?? "manual",
				input.model ?? null,
				input.anchor_entry_id ?? null,
				input.anchor_session_id ?? null,
				input.first_raw_id ?? null,
				input.last_raw_id ?? null,
				now,
				input.world_ts ?? this.getWorldTime(),
				now,
				null,
				hashContent(input.content),
				isStub ? 1 : 0,
			);
		if (!isStub) this.reindexNode(nodeId);
		const node = this.getNode(nodeId);
		if (!node) throw new Error(`insertNode: node ${nodeId} vanished`);
		this.logAudit("insert_node", { node_id: nodeId, object: input.uri, source: node.source });
		return node;
	}

	/** put(): upsert by uri. Missing ancestors are auto-created as stub nodes. */
	put(input: NodeInput): MemoryNode {
		return this.db.transaction(() => this._put(input));
	}

	/** Transaction-free core of put() — for callers already inside a tx. */
	private _put(input: NodeInput): MemoryNode {
		const existing = this.resolveUri(input.uri);
		if (existing) {
			// undefined = leave unchanged; explicit null clears nullable
			// fields. When `world_ts` is omitted it is NOT wiped (v5.4).
			this._updateNode(existing.node_id, {
				content: input.content,
				disclosure: input.disclosure,
				importance: input.importance,
				model: input.model,
				anchor_entry_id: input.anchor_entry_id,
				anchor_session_id: input.anchor_session_id,
				first_raw_id: input.first_raw_id,
				last_raw_id: input.last_raw_id,
				world_ts: input.world_ts,
			});
			return this.getNode(existing.node_id) as MemoryNode;
		}
		this.ensureStubAncestors(input.uri, input.parent_uri ?? null);
		const parentUri = input.parent_uri ?? this.implicitParentUri(input.uri);
		return this._insertNode({ ...input, parent_uri: parentUri });
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
			// Stub bodies are EMPTY (not a magic string): they are placeholder
			// rows, never entered into FTS and never recalled (§11).
			this._insertNode({ uri: ancestorUri, content: "", parent_uri: parentUri, source: "manual" }, true);
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
		// Stub promotion: any content write turns the placeholder into a real
		// node in place — overwrite the empty body, no revision churn, into
		// FTS. Fields not provided keep their current values.
		if (node.is_stub && patch.content !== undefined && patch.content !== node.content) {
			this.applyPatchColumns(nodeId, patch);
			this.db
				.prepare("UPDATE nodes SET is_stub = 0, content_hash = ?, updated_ts = ? WHERE node_id = ?")
				.run(hashContent(patch.content), new Date().toISOString(), nodeId);
			this.reindexNode(nodeId);
			this.logAudit("promote_stub", { node_id: nodeId, object: node.uri });
			return 0;
		}
		if (patch.content === undefined || patch.content === node.content) {
			// Non-content patches just touch columns without revision churn.
			this.applyPatchColumns(nodeId, patch);
			return this.currentVersion(nodeId);
		}
		const version = this.archiveRevision(
			nodeId,
			node.content,
			patch.editor_source ?? null,
			patch.editor_model ?? null,
			node.uri,
		);
		this.applyPatchColumns(nodeId, { ...patch, content: patch.content });
		this.db
			.prepare("UPDATE nodes SET content_hash = ?, updated_ts = ? WHERE node_id = ?")
			.run(hashContent(patch.content), new Date().toISOString(), nodeId);
		this.reindexNode(nodeId);
		this.logAudit("update_node", { node_id: nodeId, object: node.uri, model: patch.editor_model ?? undefined });
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
		if (patch.importance !== undefined) {
			sets.push("importance = ?");
			values.push(patch.importance);
		}
		if (patch.model !== undefined) {
			sets.push("model = ?");
			values.push(patch.model);
		}
		if (patch.anchor_entry_id !== undefined) {
			sets.push("anchor_entry_id = ?");
			values.push(patch.anchor_entry_id);
		}
		if (patch.anchor_session_id !== undefined) {
			sets.push("anchor_session_id = ?");
			values.push(patch.anchor_session_id);
		}
		if (patch.first_raw_id !== undefined) {
			sets.push("first_raw_id = ?");
			values.push(patch.first_raw_id);
		}
		if (patch.last_raw_id !== undefined) {
			sets.push("last_raw_id = ?");
			values.push(patch.last_raw_id);
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

	archiveRevision(
		nodeId: string,
		content: string,
		editorSource: string | null,
		editorModel: string | null,
		uri: string | null = null,
	): number {
		const version = this.currentVersion(nodeId) + 1;
		this.db
			.prepare(
				`INSERT INTO node_revisions (node_id, version, uri, content, editor_source, editor_model, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(nodeId, version, uri, content, editorSource, editorModel, new Date().toISOString());
		this._applyRevisionRetention(nodeId);
		return version;
	}

	/** Revision retention policy (§12 decision 20): undefined = unlimited. */
	setRevisionRetention(limit: number | undefined): void {
		if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
			throw new Error(`setRevisionRetention: ${String(limit)} must be a positive integer (or undefined)`);
		}
		this.revisionRetention = limit;
	}

	getRevisionRetention(): number | undefined {
		return this.revisionRetention;
	}

	private _applyRevisionRetention(nodeId: string): void {
		if (this.revisionRetention === undefined) return;
		this.db
			.prepare(
				`DELETE FROM node_revisions WHERE node_id = ? AND version NOT IN (
					SELECT version FROM node_revisions WHERE node_id = ? ORDER BY version DESC LIMIT ?
				)`,
			)
			.run(nodeId, nodeId, this.revisionRetention);
	}

	currentVersion(nodeId: string): number {
		const row = this.db.prepare("SELECT MAX(version) AS v FROM node_revisions WHERE node_id = ?").get(nodeId) as
			| { v: number | null }
			| undefined;
		return row?.v ?? 0;
	}

	listRevisions(nodeId: string): Array<{ version: number; uri: string | null; content: string; created_at: string }> {
		return this.db
			.prepare("SELECT version, uri, content, created_at FROM node_revisions WHERE node_id = ? ORDER BY version")
			.all(nodeId) as Array<{ version: number; uri: string | null; content: string; created_at: string }>;
	}

	/**
	 * Revisions addressed by uri — the recovery path for deleted memories
	 * (docs §10, decision 10 v5.4): forget() removes the node row but keeps
	 * every revision, and the last one carries the content as it stood at
	 * deletion time.
	 */
	listRevisionsByUri(uri: string): Array<{
		node_id: string;
		version: number;
		content: string;
		created_at: string;
		alive: boolean;
	}> {
		return this.db
			.prepare(
				`SELECT r.node_id, r.version, r.content, r.created_at,
					EXISTS(SELECT 1 FROM nodes n WHERE n.node_id = r.node_id) AS alive_flag
				FROM node_revisions r WHERE r.uri = ? ORDER BY r.node_id, r.version`,
			)
			.all(uri)
			.map((row) => {
				const r = row as {
					node_id: string;
					version: number;
					content: string;
					created_at: string;
					alive_flag: number;
				};
				return {
					node_id: r.node_id,
					version: r.version,
					content: r.content,
					created_at: r.created_at,
					alive: r.alive_flag === 1,
				};
			});
	}

	/** URIs that exist only in node_revisions — deleted, still recoverable. */
	listDeletedUris(): Array<{ uri: string; versions: number; last_seen: string }> {
		return this.db
			.prepare(
				`SELECT r.uri AS uri, COUNT(*) AS versions, MAX(r.created_at) AS last_seen
				FROM node_revisions r
				WHERE r.uri IS NOT NULL
					AND NOT EXISTS(SELECT 1 FROM nodes n WHERE n.node_id = r.node_id)
				GROUP BY r.uri ORDER BY last_seen DESC`,
			)
			.all() as Array<{ uri: string; versions: number; last_seen: string }>;
	}

	/**
	 * Recreate a deleted node from its newest surviving revision. Throws when
	 * the uri is still alive (use restoreRevision) or has no revisions left.
	 * The revived node keeps its original id (so revision history reconnects)
	 * and is re-parented through put() semantics: stub ancestors are rebuilt
	 * and the implicit parent is re-linked, so URI and tree structure agree.
	 * Node revisions only archive content/editor provenance, so importance,
	 * disclosure and world_ts cannot be recovered and fall back to defaults.
	 */
	restoreDeleted(uri: string, version?: number): MemoryNode {
		return this.db.transaction(() => {
			if (this.resolveUri(uri)) throw new Error(`restoreDeleted: ${uri} still exists`);
			const rev = (
				version === undefined
					? this.db
							.prepare(
								`SELECT node_id, version, content FROM node_revisions
							WHERE uri = ? ORDER BY version DESC LIMIT 1`,
							)
							.get(uri)
					: this.db
							.prepare(
								`SELECT node_id, version, content FROM node_revisions
							WHERE uri = ? AND version = ?`,
							)
							.get(uri, version)
			) as { node_id: string; version: number; content: string } | undefined;
			if (!rev) {
				throw new Error(
					version === undefined
						? `restoreDeleted: no revisions for ${uri}`
						: `restoreDeleted: no version ${version} for ${uri}`,
				);
			}
			const node = this._insertNode({ uri, content: rev.content, source: "import" }, false, rev.node_id);
			this.ensureStubAncestors(uri, null);
			const implicitParent = this.implicitParentUri(uri);
			const parentId = implicitParent ? (this.resolveUri(implicitParent)?.node_id ?? null) : null;
			this.db.prepare("UPDATE nodes SET parent_id = ? WHERE node_id = ?").run(parentId, node.node_id);
			const relinked = this.getNode(node.node_id);
			if (!relinked) throw new Error(`restoreDeleted: node ${rev.node_id} vanished`);
			this.logAudit("restore_deleted", { node_id: relinked.node_id, object: uri, details: `v${rev.version}` });
			return relinked;
		});
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
		this.db.prepare("DELETE FROM node_fts WHERE node_id = ?").run(nodeId);
		this.db.prepare("DELETE FROM aliases WHERE target_node_id = ?").run(nodeId);
		this.db.prepare("DELETE FROM edges WHERE node_id = ? OR target_uri = ?").run(nodeId, node.uri);
		this.db.prepare("DELETE FROM glossary WHERE node_id = ?").run(nodeId);
		this.db.prepare("DELETE FROM memory_embeddings WHERE node_id = ?").run(nodeId);
		// Recovery path (docs §10, decision 10 v5.4): the node row is really
		// gone — no zombie entry, no orphan pool — but the revision history
		// stays, with the content as it stood at deletion archived as the
		// final version. node_revisions.uri keeps it addressable afterwards.
		this.archiveRevision(nodeId, node.content, node.source, node.model, node.uri);
		this.db.prepare("UPDATE node_revisions SET uri = COALESCE(uri, ?) WHERE node_id = ?").run(node.uri, nodeId);
		this.db.prepare("DELETE FROM nodes WHERE node_id = ?").run(nodeId);
		this.logAudit("delete_node", { node_id: nodeId, object: node.uri });
		return deleted;
	}

	// ── Relocation (rename / relocate / consolidate reparent) ────────────────

	/**
	 * Atomic multi-move: rewrite the whole subtree of every source under its
	 * target. All conflicts are resolved BEFORE any write — one conflict
	 * aborts the entire batch with zero changes:
	 *   - unknown source
	 *   - target inside a moved source's subtree (self-nesting)
	 *   - target or any rewritten descendant uri occupied by a node outside
	 *     the moved set (or by an alias)
	 *   - two moves whose targets collide (identical or ancestor/descendant)
	 *   - two moves whose sources are ancestors of each other
	 * On success every moved node's OLD canonical uri becomes an alias, every
	 * descendant's uri/domain is rewritten, FTS is rebuilt per node, and
	 * awaken_uris entries under an old canonical prefix are remapped.
	 */
	relocateMany(moves: Array<{ from: string; to: string }>): void {
		if (moves.length === 0) return;
		this.db.transaction(() => this._relocateMany(moves));
	}

	/** Transaction-free core of relocateMany() — for callers inside a tx. */
	private _relocateMany(moves: Array<{ from: string; to: string }>): void {
		const plans: Array<{
			fromUri: string;
			toRoot: string;
			members: Array<{ node: MemoryNode; rel: string }>;
		}> = [];
		const movedNodeIds = new Set<string>();
		// Pass 1: resolve sources (aliases resolve to their canonical uri,
		// which is then the old root) and collect subtree members.
		for (const m of moves) {
			const node = this.resolveUri(m.from);
			if (!node) throw new Error(`relocate: unknown uri ${m.from}`);
			const members = this._subtreeMembers(node);
			for (const member of members) {
				if (movedNodeIds.has(member.node.node_id)) {
					throw new Error(`relocate: sources overlap (${member.node.uri} moved twice)`);
				}
			}
			for (const member of members) movedNodeIds.add(member.node.node_id);
			plans.push({ fromUri: node.uri, toRoot: m.to, members });
		}
		// Pass 2: cross-batch conflict checks, all before any write.
		const rewritten = new Set<string>();
		for (const plan of plans) {
			const rootChanged = plan.toRoot !== plan.fromUri;
			if (!rootChanged) continue;
			for (const member of plan.members) {
				const newUri = this._rewriteUri(plan.toRoot, member.rel);
				if (rewritten.has(newUri)) {
					throw new Error(`relocate: targets collide at ${newUri}`);
				}
				rewritten.add(newUri);
				// Target-in-source-subtree: a rewritten uri must not fall back
				// inside any moved subtree, including its own source.
				for (const other of plans) {
					if (this._isInSubtree(newUri, other.fromUri)) {
						throw new Error(`relocate: target ${newUri} nested inside source ${other.fromUri}`);
					}
				}
			}
		}
		// Target occupancy: a rewritten uri may not resolve to a node or
		// alias OUTSIDE the moved set.
		for (const plan of plans) {
			for (const member of plan.members) {
				const newUri = this._rewriteUri(plan.toRoot, member.rel);
				const occupant = this.resolveUri(newUri);
				if (occupant && !movedNodeIds.has(occupant.node_id)) {
					throw new Error(`relocate: target occupied by ${occupant.uri}`);
				}
			}
		}
		// Pass 3: apply.
		for (const plan of plans) {
			if (plan.toRoot === plan.fromUri) continue;
			this.ensureStubAncestors(plan.toRoot, null);
			const implicitParent = this.implicitParentUri(plan.toRoot);
			const parentId = implicitParent ? (this.resolveUri(implicitParent)?.node_id ?? null) : null;
			const toDomain = plan.toRoot.split("://")[0] ?? plan.toRoot;
			const updated = new Date().toISOString();
			for (const member of plan.members) {
				const newUri = this._rewriteUri(plan.toRoot, member.rel);
				const isRoot = member.rel === "";
				if (isRoot) {
					this.db
						.prepare("UPDATE nodes SET uri = ?, domain = ?, parent_id = ?, updated_ts = ? WHERE node_id = ?")
						.run(newUri, toDomain, parentId, updated, member.node.node_id);
				} else {
					this.db
						.prepare("UPDATE nodes SET uri = ?, domain = ?, updated_ts = ? WHERE node_id = ?")
						.run(newUri, toDomain, updated, member.node.node_id);
				}
				// Old canonical uri becomes an alias; existing aliases kept.
				this.db
					.prepare("INSERT OR REPLACE INTO aliases (alias_uri, target_node_id) VALUES (?, ?)")
					.run(member.node.uri, member.node.node_id);
				this.reindexNode(member.node.node_id);
			}
			this._remapAwakenUris(plan.fromUri, plan.toRoot);
			this.logAudit("rename_node", {
				node_id: plan.members[0]?.node.node_id,
				object: `${plan.fromUri} -> ${plan.toRoot}`,
				details: `moved ${plan.members.length} nodes`,
			});
		}
	}

	/**
	 * consolidate(group) in ONE transaction: create the theme node, then
	 * re-parent every source subtree under it. Both must land together —
	 * creating the theme outside the move leaves an orphan theme whenever the
	 * move aborts on a conflict the preflight missed.
	 */
	consolidateGroup(theme: NodeInput, moves: Array<{ from: string; to: string }>): MemoryNode {
		return this.db.transaction(() => {
			const node = this._put(theme);
			if (moves.length > 0) this._relocateMany(moves);
			return node;
		});
	}

	rename(oldUri: string, newUri: string): void {
		this.relocateMany([{ from: oldUri, to: newUri }]);
	}

	private _subtreeMembers(root: MemoryNode): Array<{ node: MemoryNode; rel: string }> {
		const members: Array<{ node: MemoryNode; rel: string }> = [{ node: root, rel: "" }];
		const walk = (node: MemoryNode, rel: string): void => {
			for (const child of this.children(node.node_id)) {
				const childRel = rel ? `${rel}/${child.uri.split("/").pop()}` : (child.uri.split("/").pop() ?? "");
				members.push({ node: child, rel: childRel });
				walk(child, childRel);
			}
		};
		walk(root, "");
		return members;
	}

	/** newUri = toRoot + relative suffix (root itself maps to toRoot). */
	private _rewriteUri(toRoot: string, rel: string): string {
		if (rel === "") return toRoot;
		return `${toRoot.replace(/\/$/, "")}/${rel}`;
	}

	private _isInSubtree(uri: string, ancestorUri: string): boolean {
		if (uri === ancestorUri) return true;
		return uri.startsWith(`${ancestorUri}/`);
	}

	private _remapAwakenUris(fromPrefix: string, toPrefix: string): void {
		const raw = this.getKv("awaken_uris");
		if (!raw) return;
		try {
			const list = JSON.parse(raw) as unknown;
			if (!Array.isArray(list)) return;
			let changed = false;
			const next = list.map((u) => {
				if (typeof u !== "string") return u;
				if (u === fromPrefix || u.startsWith(`${fromPrefix}/`)) {
					changed = true;
					return toPrefix + u.slice(fromPrefix.length);
				}
				return u;
			});
			if (changed) this.setKv("awaken_uris", JSON.stringify(next));
		} catch {
			// Malformed kv — leave untouched; the awaken slot reconciles anyway.
		}
	}

	// ── Edges / aliases / glossary ────────────────────────────────────────────

	addEdge(nodeId: string, targetUri: string, kind?: string): void {
		this.db
			.prepare("INSERT OR REPLACE INTO edges (node_id, target_uri, kind) VALUES (?, ?, ?)")
			.run(nodeId, targetUri, kind ?? null);
		this.logAudit("add_edge", { node_id: nodeId, object: `${nodeId} -> ${targetUri}` });
	}

	/** One-hop adjacency (both directions) for explicit retrieve diffusion. */
	listRelated(
		nodeId: string,
	): Array<{ direction: "outgoing" | "incoming"; node_id: string; target_uri: string; kind: string | null }> {
		const outgoing = this.db
			.prepare(`SELECT 'outgoing' AS direction, node_id, target_uri, kind FROM edges WHERE node_id = ?`)
			.all(nodeId) as Array<{ direction: "outgoing"; node_id: string; target_uri: string; kind: string | null }>;
		const node = this.getNode(nodeId);
		const incoming = node
			? (this.db
					.prepare(`SELECT 'incoming' AS direction, node_id, target_uri, kind FROM edges WHERE target_uri = ?`)
					.all(node.uri) as Array<{
					direction: "incoming";
					node_id: string;
					target_uri: string;
					kind: string | null;
				}>)
			: [];
		return [...outgoing, ...incoming];
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

	addGlossaryEntry(keyword: string, nodeId: string, reindex = true): void {
		this.db.prepare("INSERT OR REPLACE INTO glossary (keyword, node_id) VALUES (?, ?)").run(keyword, nodeId);
		if (reindex) this.reindexNode(nodeId);
		this.logAudit("add_glossary", { node_id: nodeId, object: keyword });
	}

	removeGlossaryEntry(keyword: string): void {
		const row = this.db.prepare("SELECT node_id FROM glossary WHERE keyword = ?").get(keyword) as
			| { node_id: string }
			| undefined;
		this.db.prepare("DELETE FROM glossary WHERE keyword = ?").run(keyword);
		if (row) this.reindexNode(row.node_id);
		this.logAudit("remove_glossary", { object: keyword, node_id: row?.node_id });
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

	// ── raw_log (stable per-session active mirror, docs §4) ───────────────────

	/**
	 * Upsert one raw row keyed by (session_id, entry_id). Existing rows keep
	 * their raw_id and world_ts (the world clock at first write is never
	 * re-stamped); role/text/wall_ts are REFRESHED from the incoming entry and
	 * the row is marked active. Callers pass the entry's ORIGINAL timestamp, so
	 * wall_ts stays the true message time across re-syncs — a caller passing a
	 * new timestamp would move it. FTS is updated by the stable raw_id.
	 */
	private _upsertRaw(entry: RawEntry): number {
		const existing = this.db
			.prepare("SELECT raw_id, world_ts FROM raw_log WHERE session_id = ? AND entry_id = ?")
			.get(entry.session_id, entry.entry_id) as { raw_id: number; world_ts: string | null } | undefined;
		if (existing) {
			this.db
				.prepare("UPDATE raw_log SET role = ?, text = ?, active = 1, wall_ts = ?, world_ts = ? WHERE raw_id = ?")
				.run(entry.role, entry.text, entry.wall_ts, existing.world_ts, existing.raw_id);
			this._reindexRawFts(existing.raw_id, entry.text);
			return existing.raw_id;
		}
		const result = this.db
			.prepare(
				"INSERT INTO raw_log (role, text, entry_id, session_id, active, wall_ts, world_ts) VALUES (?, ?, ?, ?, 1, ?, ?)",
			)
			.run(entry.role, entry.text, entry.entry_id, entry.session_id, entry.wall_ts, entry.world_ts ?? null);
		const rawId = Number(result.lastInsertRowid);
		this._reindexRawFts(rawId, entry.text);
		return rawId;
	}

	private _reindexRawFts(rawId: number, text: string): void {
		this.db.prepare("DELETE FROM raw_fts WHERE raw_id = ?").run(rawId);
		const tokens = tokenizeForSearch(text);
		if (tokens) this.db.prepare("INSERT INTO raw_fts (raw_id, text) VALUES (?, ?)").run(rawId, tokens);
	}

	/**
	 * Incremental entry point of the same upsert primitive: replaying the same
	 * session/entry twice is idempotent (same raw_id, world_ts preserved).
	 */
	appendRaw(entries: RawEntry[]): number {
		return this.db.transaction(() => {
			let lastId = 0;
			for (const entry of entries) lastId = this._upsertRaw(entry);
			return lastId;
		});
	}

	/**
	 * Reconcile ONE session's raw_log mirror against its active branch. Rows
	 * of other sessions are never read into JS and never touched. Rows that
	 * left THIS session's active path are marked inactive (kept forever);
	 * switching back re-marks them active with identical raw_id / timestamps.
	 */
	syncRawBranch(sessionId: string, entries: RawEntry[]): void {
		this.db.transaction(() => {
			for (const entry of entries) this._upsertRaw({ ...entry, session_id: sessionId });
			this.db.exec("CREATE TEMP TABLE IF NOT EXISTS _raw_active (entry_id TEXT NOT NULL PRIMARY KEY)");
			this.db.exec("DELETE FROM _raw_active");
			const ins = this.db.prepare("INSERT OR IGNORE INTO _raw_active (entry_id) VALUES (?)");
			for (const entry of entries) ins.run(entry.entry_id);
			this.db
				.prepare(
					"UPDATE raw_log SET active = 0 WHERE session_id = ? AND entry_id NOT IN (SELECT entry_id FROM _raw_active)",
				)
				.run(sessionId);
			this.db.exec("DROP TABLE IF EXISTS _raw_active");
		});
	}

	listRaw(
		fromRawId: number,
		toRawId?: number,
		opts: { sessionId?: string; activeOnly?: boolean } = {},
	): Array<{
		raw_id: number;
		role: string;
		text: string;
		entry_id: string;
		session_id: string;
		wall_ts: string;
		world_ts: string | null;
		active: number;
	}> {
		const filters: string[] = [];
		const params: unknown[] = [];
		if (opts.sessionId) {
			filters.push("session_id = ?");
			params.push(opts.sessionId);
		}
		if (opts.activeOnly) filters.push("active = 1");
		if (toRawId === undefined) {
			filters.push("raw_id = ?");
			params.push(fromRawId);
		} else {
			filters.push("raw_id >= ? AND raw_id <= ?");
			params.push(fromRawId, toRawId);
		}
		const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
		return this.db
			.prepare(
				`SELECT raw_id, role, text, entry_id, session_id, wall_ts, world_ts, active
				 FROM raw_log ${where} ORDER BY raw_id`,
			)
			.all(...params) as Array<{
			raw_id: number;
			role: string;
			text: string;
			entry_id: string;
			session_id: string;
			wall_ts: string;
			world_ts: string | null;
			active: number;
		}>;
	}

	/**
	 * Rows of one session's active branch not yet consumed by the given
	 * autoretain task (§5 per-task progress; §3.5).
	 */
	listUnprocessedActiveRaw(
		sessionId: string,
		task: string,
		limit: number,
	): Array<{ raw_id: number; role: string; text: string; entry_id: string }> {
		return this.db
			.prepare(
				`SELECT r.raw_id, r.role, r.text, r.entry_id
				FROM raw_log r
				WHERE r.session_id = ? AND r.active = 1
					AND NOT EXISTS (SELECT 1 FROM autoretain_progress p
						WHERE p.session_id = r.session_id AND p.task = ? AND p.entry_id = r.entry_id)
				ORDER BY r.raw_id ASC
				LIMIT ?`,
			)
			.all(sessionId, task, limit) as Array<{ raw_id: number; role: string; text: string; entry_id: string }>;
	}

	/** Record consumed entries for one (session, task) — idempotent. */
	markAutoretainProcessed(sessionId: string, task: string, entryIds: string[]): void {
		if (entryIds.length === 0) return;
		this.db.transaction(() => {
			const stmt = this.db.prepare(
				"INSERT OR IGNORE INTO autoretain_progress (session_id, task, entry_id, processed_at) VALUES (?, ?, ?, ?)",
			);
			const now = new Date().toISOString();
			for (const id of entryIds) stmt.run(sessionId, task, id, now);
		});
	}

	// ── FTS query (docs §3/§14) ─────────────────────────────────────────────

	/**
	 * MATCH both node FTS table(s). Every query goes through the same unified
	 * tokenizer as indexing; every token is double-quote-escaped + quoted and
	 * OR-joined, executed via a bound parameter. When a raw query contains a
	 * glossary keyword the FULL keyword joins the token list too, so proper
	 * nouns are recallable even if the body never mentions them. Returns the
	 * best (lowest) BM25 per node across queries; empty input → empty map.
	 */
	searchNodeFts(queries: string[]): Map<string, number> {
		const hits = new Map<string, number>();
		if (queries.length === 0) return hits;
		const glossary = this.db.prepare("SELECT keyword FROM glossary").all() as Array<{ keyword: string }>;
		const keywords = glossary.map((g) => g.keyword).filter((k) => k.length > 0);
		for (const query of queries) {
			if (!query) continue;
			let tokens = tokenizeForSearch(query)
				.split(/\s+/)
				.filter((t) => t.length > 0);
			const extra = keywords.filter((k) => query.includes(k));
			if (extra.length > 0) tokens = [...tokens, ...extra];
			if (tokens.length === 0) continue;
			const match = tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
			const rows = this.db
				.prepare(
					`SELECT node_id, bm25(node_fts) AS bm FROM node_fts WHERE node_fts MATCH ?
					ORDER BY rank`,
				)
				.all(match) as Array<{ node_id: string; bm: number }>;
			for (const row of rows) {
				const prev = hits.get(row.node_id);
				if (prev === undefined || row.bm < prev) hits.set(row.node_id, row.bm);
			}
		}
		return hits;
	}

	/** MATCH raw transcript rows joined to raw_log, active rows only. */
	searchRawFts(query: string, limit = 20): Array<{ raw_id: number; role: string; text: string }> {
		const tokens = tokenizeForSearch(query)
			.split(/\s+/)
			.filter((t) => t.length > 0);
		if (tokens.length === 0) return [];
		const match = tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
		return this.db
			.prepare(
				`SELECT r.raw_id, r.role, r.text
				FROM raw_fts f JOIN raw_log r ON r.raw_id = f.raw_id
				WHERE raw_fts MATCH ? AND r.active = 1
				ORDER BY r.raw_id LIMIT ?`,
			)
			.all(match, limit) as Array<{ raw_id: number; role: string; text: string }>;
	}

	// ── Embedding cache (memory_embeddings, docs §9/§12) ─────────────────────

	/**
	 * Cached segment vectors for the given nodes, keyed by node_id. A row is
	 * only returned when BOTH the embed-text hash and the model match — a
	 * content edit or a model switch invalidates it silently.
	 */
	loadEmbeddings(wanted: Array<{ node_id: string; hash: string }>, model: string): Map<string, Float32Array[]> {
		const out = new Map<string, Float32Array[]>();
		if (wanted.length === 0) return out;
		const byId = new Map(wanted.map((w) => [w.node_id, w.hash]));
		const rows = this.db
			.prepare(
				"SELECT node_id, seg_index, content_hash, vector, model FROM memory_embeddings ORDER BY node_id, seg_index",
			)
			.all() as Array<{
			node_id: string;
			seg_index: number;
			content_hash: string | null;
			vector: string | null;
			model: string | null;
		}>;
		for (const row of rows) {
			const hash = byId.get(row.node_id);
			if (!hash || hash !== row.content_hash || row.model !== model || !row.vector) continue;
			try {
				const vec = Float32Array.from(JSON.parse(row.vector) as number[]);
				const list = out.get(row.node_id);
				if (list) list[row.seg_index] = vec;
				else out.set(row.node_id, [vec]);
			} catch {
				// Corrupt cache row: skip it, the doc re-embeds this round.
			}
		}
		return out;
	}

	/** Replace one node's cached segment vectors. */
	saveEmbeddings(nodeId: string, hash: string, model: string, vectors: Float32Array[]): void {
		this.db.transaction(() => {
			this.db.prepare("DELETE FROM memory_embeddings WHERE node_id = ?").run(nodeId);
			const stmt = this.db.prepare(
				"INSERT INTO memory_embeddings (node_id, seg_index, content_hash, vector, model) VALUES (?, ?, ?, ?, ?)",
			);
			for (let i = 0; i < vectors.length; i++) {
				stmt.run(nodeId, i, hash, JSON.stringify([...vectors[i]]), model);
			}
		});
	}

	/** Drop cache rows whose node is gone (housekeeping after bulk deletes). */
	pruneEmbeddings(): number {
		const result = this.db
			.prepare("DELETE FROM memory_embeddings WHERE node_id NOT IN (SELECT node_id FROM nodes)")
			.run();
		return Number(result.changes);
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

	/**
	 * Keyword-mode search over the tree (docs §9). Candidates come from the
	 * node FTS MATCH of the query (no full-tree re-tokenization), then rank
	 * with the shared scorer. No score floor — this is the explicit-search
	 * path (the retrieve tool, `/memories search`), not injection.
	 *
	 * `MemoryStore` stays synchronous and pi-free, so this path never embeds.
	 */
	recall(query: string, options: RecallOptions = {}): MemoryNode[] {
		const searchOptions = {
			queries: [query],
			domain: options.domain,
			domainBlocklist: options.domainBlocklist ?? this.blocklist,
			isVisible: options.isVisible,
			topK: options.limit ?? 10,
			minScore: 0,
			nowDays: toEpochDays(this.getWorldTime() ?? new Date().toISOString()) ?? 0,
		};
		const fts = this.searchNodeFts([query]);
		if (fts.size === 0) return [];
		const pool = buildPool(this, searchOptions).filter((n) => fts.has(n.node_id));
		if (pool.length === 0) return [];
		// Glossary keywords feed keywordScore so a proper noun attached via
		// trigger() recalls even when the body never mentions it (§5.5).
		const glossaryTerms = buildGlossaryTerms(this, pool);
		const items = rank(pool, searchOptions, null, "keyword", fts, glossaryTerms);
		const byId = new Map(pool.map((n) => [n.node_id, n]));
		return items.map((item) => byId.get(item.node_id) as MemoryNode);
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

	/** Batch access tracking — ONLY the character actively recalling (§13). */
	markAccessed(nodeIds: string[], at: string = new Date().toISOString()): void {
		if (nodeIds.length === 0) return;
		const stmt = this.db.prepare("UPDATE nodes SET last_accessed_at = ? WHERE node_id = ?");
		for (const id of nodeIds) stmt.run(at, id);
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
	 * Snapshot scope per docs §12: tree + revisions + kv + the character's
	 * hand-built association surfaces (aliases / edges / glossary) — none of
	 * them rerivable after a migration.
	 */
	export(): ExportSnapshot {
		const nodes = this.listNodes();
		const revisions = this.db
			.prepare(
				"SELECT node_id, version, uri, content, editor_source, editor_model, created_at FROM node_revisions ORDER BY node_id, version",
			)
			.all() as ExportSnapshot["revisions"];
		const kvRows = this.db.prepare("SELECT key, value FROM memory_kv").all() as Array<{ key: string; value: string }>;
		const kv: Record<string, string> = {};
		for (const row of kvRows) kv[row.key] = row.value;
		const aliases = this.db
			.prepare("SELECT alias_uri, target_node_id FROM aliases ORDER BY alias_uri")
			.all() as ExportSnapshot["aliases"];
		const edges = this.db
			.prepare("SELECT node_id, target_uri, kind FROM edges ORDER BY node_id, target_uri")
			.all() as ExportSnapshot["edges"];
		const glossary = this.db
			.prepare("SELECT keyword, node_id FROM glossary ORDER BY keyword")
			.all() as ExportSnapshot["glossary"];
		return { nodes, revisions, kv, aliases, edges, glossary };
	}

	import(snapshot: ExportSnapshot): void {
		this.db.transaction(() => {
			for (const node of snapshot.nodes) {
				this.db
					.prepare(
						`INSERT OR REPLACE INTO nodes (node_id, parent_id, domain, uri, content, disclosure,
							importance, source, model, anchor_entry_id, anchor_session_id, first_raw_id, last_raw_id,
							created_at, world_ts, updated_ts, last_accessed_at, content_hash, is_stub)
						VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					)
					.run(
						node.node_id,
						node.parent_id,
						node.domain,
						node.uri,
						node.content,
						node.disclosure,
						node.importance,
						node.source,
						node.model,
						node.anchor_entry_id,
						node.anchor_session_id,
						node.first_raw_id,
						node.last_raw_id,
						node.created_at,
						node.world_ts,
						node.updated_ts,
						node.last_accessed_at,
						node.content_hash,
						node.is_stub,
					);
				if (!node.is_stub) this.reindexNode(node.node_id);
			}
			for (const rev of snapshot.revisions) {
				this.db
					.prepare(
						"INSERT OR REPLACE INTO node_revisions (node_id, version, uri, content, editor_source, editor_model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
					)
					.run(
						rev.node_id,
						rev.version,
						rev.uri ?? null,
						rev.content,
						rev.editor_source,
						rev.editor_model,
						rev.created_at,
					);
			}
			for (const [key, value] of Object.entries(snapshot.kv)) {
				this.setKv(key, value);
			}
			// Association surfaces — every reference must exist or the whole
			// import rolls back (this transaction throws before COMMIT).
			for (const alias of snapshot.aliases) {
				if (!this.getNode(alias.target_node_id)) {
					throw new Error(`import: alias ${alias.alias_uri} targets missing node ${alias.target_node_id}`);
				}
				this.db
					.prepare("INSERT OR REPLACE INTO aliases (alias_uri, target_node_id) VALUES (?, ?)")
					.run(alias.alias_uri, alias.target_node_id);
			}
			for (const edge of snapshot.edges) {
				const from = this.getNode(edge.node_id);
				const to = this.resolveUri(edge.target_uri);
				if (!from) throw new Error(`import: edge from missing node ${edge.node_id}`);
				if (!to) throw new Error(`import: edge target missing ${edge.target_uri}`);
				this.db
					.prepare("INSERT OR REPLACE INTO edges (node_id, target_uri, kind) VALUES (?, ?, ?)")
					.run(edge.node_id, edge.target_uri, edge.kind);
			}
			for (const g of snapshot.glossary) {
				if (!this.getNode(g.node_id)) {
					throw new Error(`import: glossary ${g.keyword} targets missing node ${g.node_id}`);
				}
				this.db
					.prepare("INSERT OR REPLACE INTO glossary (keyword, node_id) VALUES (?, ?)")
					.run(g.keyword, g.node_id);
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

	logAudit(event: string, details: MemoryAuditDetails = {}): void {
		this.db
			.prepare(
				"INSERT INTO audit_log (ts, world_ts, event, node_id, object, source, model, turn, task, anchor, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				new Date().toISOString(),
				this.getWorldTime(),
				event,
				details.node_id ?? null,
				details.object ?? null,
				details.source ?? null,
				details.model ?? null,
				details.turn ?? null,
				details.task ?? null,
				details.anchor ?? null,
				details.details ?? null,
			);
	}

	listAudit(limit = 50): Array<{
		id: number;
		ts: string;
		event: string;
		object: string | null;
		node_id: string | null;
		source: string | null;
		model: string | null;
		turn: number | null;
		task: string | null;
		anchor: string | null;
		details: string | null;
	}> {
		return this.db
			.prepare(
				`SELECT id, ts, event, object, node_id, source, model, turn, task, anchor, details
				 FROM audit_log ORDER BY id DESC LIMIT ?`,
			)
			.all(limit) as Array<{
			id: number;
			ts: string;
			event: string;
			object: string | null;
			node_id: string | null;
			source: string | null;
			model: string | null;
			turn: number | null;
			task: string | null;
			anchor: string | null;
			details: string | null;
		}>;
	}

	// ── Internals ─────────────────────────────────────────────────────────────

	/**
	 * Rebuild one node's FTS row from uri + disclosure + glossary keywords +
	 * content, all through the unified tokenizer. Stubs never enter FTS.
	 * insert / update / rename / stub-promotion / glossary changes all route
	 * through here.
	 */
	reindexNode(nodeId: string): void {
		const node = this.getNode(nodeId);
		if (!node) return;
		this.db.prepare("DELETE FROM node_fts WHERE node_id = ?").run(nodeId);
		if (node.is_stub) return;
		const keywords = (
			this.db.prepare("SELECT keyword FROM glossary WHERE node_id = ?").all(nodeId) as Array<{
				keyword: string;
			}>
		).map((r) => r.keyword);
		let text = tokenizeForSearch([node.uri, node.disclosure ?? "", node.content].join(" "));
		// Full glossary keywords are appended as whole tokens so proper nouns
		// survive jieba splitting, without touching the global dictionary.
		const extra = keywords.filter((k) => k.trim().length > 0).join(" ");
		if (extra) text = `${text} ${extra}`;
		if (!text) return;
		this.db.prepare("INSERT INTO node_fts (node_id, text) VALUES (?, ?)").run(nodeId, text);
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
