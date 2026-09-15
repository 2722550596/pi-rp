/**
 * DTO layer — the ONLY legal channel between `MemoryStore` and JSON
 * (plan/memory-web/01-服务端与API.md §6).
 *
 * Three frozen rules:
 *   1. Never place `store` / `store.db` / a prepared statement into a DTO.
 *      `JSON.stringify(store)` throws on the cycle through `db`.
 *   2. Every DTO is built by an explicit `to*DTO`. No `{ ...node }` passthrough:
 *      the whitelist keeps internal columns (`content_hash`, `anchor_*` when
 *      unintended) out of the API surface.
 *   3. `node:sqlite` hands back null-prototype rows (`row.hasOwnProperty` is
 *      undefined) — read columns by name, never call host methods on a row.
 *
 * Read paths may query the DB directly (§9.1 discipline 2 governs WRITE paths
 * only). That is how the editor columns (§12-P6), the P7 back-fill, the P10
 * child counts and the P14 grouping get their data without touching the engine.
 */
import type { MemoryNode, MemoryStore } from "../store.ts";

// ── Nodes ───────────────────────────────────────────────────────────────────

export interface NodeDTO {
	node_id: string;
	uri: string;
	domain: string;
	parent_uri: string | null;
	content: string;
	disclosure: string | null;
	importance: number;
	source: "auto" | "manual" | "import";
	model: string | null;
	created_at: string;
	updated_ts: string;
	world_ts: string | null;
	last_accessed_at: string | null;
	is_stub: boolean;
	shadowed: boolean;
	foreignSession?: boolean;
	anchor_entry_id: string | null;
	anchor_session_id: string | null;
}

export interface TreeNodeDTO {
	node_id: string;
	uri: string;
	domain: string;
	importance: number;
	is_stub: boolean;
	shadowed: boolean;
	child_count: number;
	has_children: boolean;
	content_head: string;
}

export interface TreeResponseDTO {
	items: TreeNodeDTO[];
	total: number;
	limit: number;
	offset: number;
	parent_uri: string | null;
}

export interface EdgeDTO {
	direction: "outgoing" | "incoming";
	/** ⭐ Always `edges.node_id` — the SOURCE of the edge, in both directions. */
	node_id: string;
	/** The PEER's uri: outgoing → resolved `target_uri`; incoming → the source node. */
	uri: string | null;
	/** Alias of `uri`, kept for consumers that already use this name. */
	resolved_uri: string | null;
	kind: string | null;
	dangling: boolean;
}

export interface AliasDTO {
	alias_uri: string;
	target_node_id: string;
}

export interface GlossaryDTO {
	keyword: string;
	node_id: string;
	uri: string | null;
}

export interface RevisionDTO {
	node_id: string;
	version: number;
	uri: string | null;
	content: string;
	editor_source: string | null;
	editor_model: string | null;
	created_at: string;
}

export interface NodeResponseDTO {
	/** Optimistic lock (§16.2): `insertNode` archives no revision, so a new node reads 0. */
	current_version: number;
	node: NodeDTO;
	path: Array<{ node_id: string; uri: string }>;
	children: TreeNodeDTO[];
	revisions: RevisionDTO[];
	aliases: AliasDTO[];
	edges: { outgoing: EdgeDTO[]; incoming: EdgeDTO[] };
	glossary: GlossaryDTO[];
}

// ── Raw log ─────────────────────────────────────────────────────────────────

export interface RawEntryDTO {
	raw_id: number;
	role: string;
	text: string;
	entry_id: string;
	session_id: string;
	wall_ts: string;
	world_ts: string | null;
	/** 0/1 branch state — deliberately a number, NOT a boolean (§11-C4). */
	active: number;
}

export interface RawResponseDTO {
	items: RawEntryDTO[];
	total: number;
	totalAll: number;
	limit: number;
	offset: number;
	before: number | null;
	centered: boolean;
}

export interface SessionDTO {
	session_id: string;
	total: number;
	active: number;
	first_raw_id: number;
	last_raw_id: number;
	wall_first: string;
	wall_last: string;
}

// ── The rest ────────────────────────────────────────────────────────────────

export interface AuditDTO {
	id: number;
	ts: string;
	event: string;
	object: string | null;
	details: Record<string, unknown> | string | null;
}

export interface MetaDTO {
	db_path: string;
	schema_version: string;
	world_time: string | null;
	domains: string[];
	counts: {
		nodes: number;
		stubs: number;
		domains: number;
		raw_total: number;
		raw_active: number;
		revisions: number;
		edges: number;
		aliases: number;
		glossary: number;
		audit: number;
		sessions: number;
		temp: number;
	};
	temp_threshold: number;
	thresholdSource: "cli" | "settings" | "default";
}

export interface SearchItemDTO {
	node_id: string;
	uri: string;
	disclosure: string | null;
	summary: string;
	content: string;
	score: number;
	kw: number;
	vec: number;
	bm25: number | null;
	importance: number | null;
	source: string | null;
	world_ts: string | null;
}

export interface SearchResponseDTO {
	items: SearchItemDTO[];
	total: number;
	mode: "vector" | "keyword";
}

export interface TempResponseDTO {
	items: TreeNodeDTO[];
	count: number;
	count_all: number;
	threshold: number;
	thresholdSource: "cli" | "settings" | "default";
	notifyPreview: string;
}

export interface DeletedUriDTO {
	uri: string;
	node_id: string | null;
	versions: number;
	last_seen: string;
}

export interface EventsDTO {
	version: number;
	changed: boolean;
}

// ── Multi-database (plan/memory-web/13-多库服务端API.md §5) ──────────────────

/** One memory db as it appears in a listing (contract §4.3, frozen shape). */
export interface DatabaseDTO {
	/** Absolute path — also the db id (contract §4.2). */
	path: string;
	/** Short display name (rules in the routes layer). */
	label: string;
	/** Already in the registry (false = discovered but never opened). */
	registered: boolean;
	/** File currently exists and probes read-only as a memory db. */
	reachable: boolean;
	/**
	 * Node count; `null` when `reachable === false`.
	 * ⚠️ `0` is a REAL state (an empty db) — the two MUST NOT be conflated.
	 */
	node_count: number | null;
	/** World clock; `null` on the same terms as `node_count`. */
	world_time: string | null;
	/** Human-readable reason when unreachable; `null` when reachable. */
	error: string | null;
}

/** Discovery-scan metadata (contract §4.3). */
export interface DiscoveryMetaDTO {
	/** Whether multi-db is enabled (false when bound to a non-loopback host). */
	enabled: boolean;
	/** ⚠️ Directories actually visited — NOT the db count. */
	scanned: number;
	/** Human-readable errors (path + errno name). */
	errors: string[];
}

export interface DatabasesDTO {
	/** The PROCESS db (the startup `--db`). NOT "the current selection" — that lives in the frontend. */
	current: string;
	/** Registered ∪ discovered, deduped by path, sorted deterministically. */
	databases: DatabaseDTO[];
	/** Effective roots. Meaning "unrestricted" when `--allow-any-path` is on, so `[]` (contract §5.4). */
	roots: string[];
	discovery: DiscoveryMetaDTO;
}

/** Returned by open/create on success; identical shape so the frontend renders both the same way. */
export interface DatabaseOpenedDTO {
	/** Normalized absolute path = db id. */
	path: string;
	label: string;
	/** Always true: these endpoints only return 200 on success. */
	registered: true;
	reachable: true;
	node_count: number;
	world_time: string | null;
	/** `open` → false; `create` → true. */
	created: boolean;
	/** Whether it was already registered (`open` called twice → true). Always false for `create`. */
	already_registered: boolean;
}

/** Discovery result → the "unregistered and unreachable" baseline (probe failure path). */
export function toUnreachableDatabaseDTO(path: string, label: string, error: string): DatabaseDTO {
	return { path, label, registered: false, reachable: false, node_count: null, world_time: null, error };
}

/** Known node_count / world_time. ⚠️ No probing here — probing belongs to the discovery layer. */
export function toDatabaseDTO(input: {
	path: string;
	label: string;
	registered: boolean;
	nodeCount: number | null;
	worldTime: string | null;
	error: string | null;
}): DatabaseDTO {
	return {
		path: input.path,
		label: input.label,
		registered: input.registered,
		reachable: input.error === null,
		node_count: input.nodeCount,
		world_time: input.worldTime,
		error: input.error,
	};
}

/** The sole construction point for `current`: it MUST be the process db path the caller passes in. */
export function toDiscoveryMetaDTO(enabled: boolean, scanned: number, errors: string[]): DiscoveryMetaDTO {
	return { enabled, scanned, errors };
}

// ── Converters ──────────────────────────────────────────────────────────────

/** Collapse whitespace then cut — a tree row must never contain a newline. */
export function contentHead(content: string, max = 60): string {
	const flat = content.replace(/\s+/g, " ").trim();
	return flat.length > max ? flat.slice(0, max) : flat;
}

export function toNodeDTO(
	n: MemoryNode,
	extra: { shadowed: boolean; foreignSession?: boolean; parentUri?: string | null },
): NodeDTO {
	return {
		node_id: n.node_id,
		uri: n.uri,
		domain: n.domain,
		parent_uri: extra.parentUri ?? null,
		content: n.content,
		disclosure: n.disclosure,
		importance: n.importance,
		source: n.source,
		model: n.model,
		created_at: n.created_at,
		updated_ts: n.updated_ts,
		world_ts: n.world_ts,
		last_accessed_at: n.last_accessed_at,
		is_stub: n.is_stub === 1,
		shadowed: extra.shadowed,
		...(extra.foreignSession === undefined ? {} : { foreignSession: extra.foreignSession }),
		anchor_entry_id: n.anchor_entry_id,
		anchor_session_id: n.anchor_session_id,
	};
}

/**
 * `parent_id` is a table column, not an API field (§16.3): the UI addresses
 * nodes by uri, so the parent's uri is resolved here (or null at a domain root).
 */
export function parentUriOf(store: MemoryStore, n: MemoryNode): string | null {
	if (!n.parent_id) return null;
	return store.getNode(n.parent_id)?.uri ?? null;
}

export interface RawRow {
	raw_id: number;
	role: string;
	text: string;
	entry_id: string;
	session_id: string;
	wall_ts: string;
	world_ts: string | null;
	active: number;
}

export function toRawDTO(r: RawRow): RawEntryDTO {
	return {
		raw_id: r.raw_id,
		role: r.role,
		text: r.text,
		entry_id: r.entry_id,
		session_id: r.session_id,
		wall_ts: r.wall_ts,
		world_ts: r.world_ts,
		active: Number(r.active),
	};
}

export function toRevisionDTO(
	nodeId: string,
	row: { version: number; uri: string | null; content: string; created_at: string },
	editor: { editor_source: string | null; editor_model: string | null },
): RevisionDTO {
	return {
		node_id: nodeId,
		version: row.version,
		uri: row.uri,
		content: row.content,
		editor_source: editor.editor_source,
		editor_model: editor.editor_model,
		created_at: row.created_at,
	};
}

/**
 * ⭐ §12-P6: `listRevisions` / `listRevisionsByUri` do not SELECT the editor
 * columns, so they are read here on the read path (allowed, §16.6/P12).
 *
 * The match key is the `(node_id, uri)` PAIR, never `(node_id, version)`:
 * `node_revisions.uri` is the uri at archive time and does not follow a
 * relocate, so pairing on version alone would cross-wire revisions from a
 * different address of the same node.
 */
export function readEditorColumns(
	store: MemoryStore,
	nodeId: string,
	uri: string | null,
	version: number,
): { editor_source: string | null; editor_model: string | null } {
	if (uri === null) return { editor_source: null, editor_model: null };
	// The key is the (node_id, uri, version) TRIPLE. Dropping `version` would
	// make every revision of one address share the first row's provenance;
	// dropping `uri` would cross-wire revisions after a relocate (the stored
	// uri does not follow the move), so both halves are required.
	const row = store.db
		.prepare("SELECT editor_source, editor_model FROM node_revisions WHERE node_id = ? AND uri = ? AND version = ?")
		.get(nodeId, uri, version) as { editor_source: string | null; editor_model: string | null } | undefined;
	return { editor_source: row?.editor_source ?? null, editor_model: row?.editor_model ?? null };
}

/**
 * ⭐ §16.1: `node_id` is the edge's SOURCE in both directions. The peer uri is
 * derived per direction; incoming rows carry no source uri of their own, which
 * is exactly the P1 compensation this function exists for.
 */
export function toEdgeDTO(
	e: { direction: "outgoing" | "incoming"; node_id: string; target_uri: string; kind: string | null },
	store: MemoryStore,
	cache: Map<string, string | null>,
): EdgeDTO {
	const peerUri =
		e.direction === "outgoing" ? resolveCached(store, cache, e.target_uri) : (store.getNode(e.node_id)?.uri ?? null);
	return {
		direction: e.direction,
		node_id: e.node_id,
		uri: peerUri,
		resolved_uri: peerUri,
		kind: e.kind,
		dangling: peerUri === null,
	};
}

function resolveCached(store: MemoryStore, cache: Map<string, string | null>, uri: string): string | null {
	if (cache.has(uri)) return cache.get(uri) ?? null;
	const resolved = store.resolveUri(uri)?.uri ?? null;
	cache.set(uri, resolved);
	return resolved;
}

export function toAliasDTO(targetNodeId: string, aliasUri: string): AliasDTO {
	return { alias_uri: aliasUri, target_node_id: targetNodeId };
}

export function toGlossaryDTO(entry: { keyword: string; node_id: string }, uriIndex: Map<string, string>): GlossaryDTO {
	return { keyword: entry.keyword, node_id: entry.node_id, uri: uriIndex.get(entry.node_id) ?? null };
}

export function toAuditDTO(row: {
	id: number;
	ts: string;
	event: string;
	object: string | null;
	details: string | null;
}): AuditDTO {
	let details: Record<string, unknown> | string | null = null;
	if (row.details !== null) {
		try {
			const parsed = JSON.parse(row.details) as unknown;
			details = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : row.details;
		} catch {
			// Keep the raw string: dropping it would lose information.
			details = row.details;
		}
	}
	return { id: row.id, ts: row.ts, event: row.event, object: row.object, details };
}

export function toTreeNodeDTO(n: MemoryNode, childCount: number, shadowed: boolean): TreeNodeDTO {
	return {
		node_id: n.node_id,
		uri: n.uri,
		domain: n.domain,
		importance: n.importance,
		is_stub: n.is_stub === 1,
		shadowed,
		child_count: childCount,
		has_children: childCount > 0,
		content_head: contentHead(n.content),
	};
}

/** `node_id → uri` for the whole tree; callers need it to render links. */
export function buildUriIndex(store: MemoryStore): Map<string, string> {
	return new Map(store.listNodes().map((n) => [n.node_id, n.uri]));
}

/** Ancestor chain, root first, EXCLUDING the node itself. */
export function buildPath(store: MemoryStore, node: MemoryNode): Array<{ node_id: string; uri: string }> {
	const chain: Array<{ node_id: string; uri: string }> = [];
	const seen = new Set<string>([node.node_id]);
	let current = node.parent_id ? store.getNode(node.parent_id) : null;
	while (current && !seen.has(current.node_id)) {
		seen.add(current.node_id);
		chain.unshift({ node_id: current.node_id, uri: current.uri });
		current = current.parent_id ? store.getNode(current.parent_id) : null;
	}
	return chain;
}

/**
 * The `/api/node` aggregate (§16.2). `current_version` is the optimistic lock
 * D5 needs; `insertNode` archives no revision, so a freshly `put` node reads 0.
 */
export function toNodeResponseDTO(
	store: MemoryStore,
	node: MemoryNode,
	opts: { isShadowed: (nodeId: string) => boolean; childCount: Map<string, number> },
): NodeResponseDTO {
	const edgeCache = new Map<string, string | null>();
	const related = store.listRelated(node.node_id);
	const uriIndex = buildUriIndex(store);
	return {
		current_version: store.currentVersion(node.node_id),
		node: toNodeDTO(node, { shadowed: opts.isShadowed(node.node_id), parentUri: parentUriOf(store, node) }),
		path: buildPath(store, node),
		children: store
			.children(node.node_id)
			.map((c) => toTreeNodeDTO(c, opts.childCount.get(c.node_id) ?? 0, opts.isShadowed(c.node_id))),
		revisions: store
			.listRevisions(node.node_id)
			.map((row) => toRevisionDTO(node.node_id, row, readEditorColumns(store, node.node_id, row.uri, row.version))),
		aliases: store.listAliases(node.node_id).map((aliasUri) => toAliasDTO(node.node_id, aliasUri)),
		edges: {
			outgoing: related.filter((e) => e.direction === "outgoing").map((e) => toEdgeDTO(e, store, edgeCache)),
			incoming: related.filter((e) => e.direction === "incoming").map((e) => toEdgeDTO(e, store, edgeCache)),
		},
		glossary: store.listGlossary(node.node_id).map((entry) => toGlossaryDTO(entry, uriIndex)),
	};
}

/** One `listNodes()` pass → `parent_id → child count` (P10; avoids N queries). */
export function buildChildCounts(store: MemoryStore): Map<string, number> {
	const counts = new Map<string, number>();
	for (const n of store.listNodes()) {
		if (!n.parent_id) continue;
		counts.set(n.parent_id, (counts.get(n.parent_id) ?? 0) + 1);
	}
	return counts;
}
