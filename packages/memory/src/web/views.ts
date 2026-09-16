/**
 * Seven `MEM://` views as structured DTOs (plan/memory-web/04-系统视图与库健康.md §2/§3,
 * contract §8.2/§8.3/§16.8).
 *
 * This is the SECOND implementation of `memory-views.ts`: it transports the exact
 * same semantics into plain JSON so the Web UI can sort / filter / link without
 * re-deriving anything. Every `filter` / `sort` / `slice` below has a one-to-one
 * counterpart in `memory-views.ts`; when the two drift, `test/web/views-parity.test.ts`
 * goes red.
 *
 * Discipline (D4 §11.1, contract §12-P12):
 *   - the ONLY SQL in this file is `buildTimelineView`'s single descending
 *     `ORDER BY raw_id DESC LIMIT ?` (the literal mirror of memory-views.ts:26 —
 *     `listRaw` has no "from here to infinity" form, and anchoring at
 *     MAX_SAFE_INTEGER was banned by contract §16.10);
 *   - every other view goes through a public `MemoryStore` method.
 *
 * The entry point takes EXPLICIT structured parameters (`name` / `domain` / `limit`).
 * It MUST NOT accept or parse a `MEM://` URI (contract §16.8 / P17).
 */
import { formatRelativeWorldTime, toEpochDays } from "../recall.ts";
import type { MemoryNode, MemoryStore, VisibilityPredicate } from "../store.ts";
import { getAwakenUris } from "../tools.ts";

// ── DTOs (D4 §2.0) ──────────────────────────────────────────────────────────

/** Fields every node-shaped item carries. `uri` is the UI's addressing key. */
export interface ViewItemBase {
	node_id: string;
	uri: string;
	domain: string;
	importance: number;
	/** Already-shadowed (its original branch was rolled back). Contract §6.6. */
	shadowed: boolean;
}

/** `MEM://timeline` — the collection dimension is `raw_id`, not `node_id`. */
export interface TimelineItem {
	raw_id: number;
	world_ts: string | null;
	/** May be a customType (contract §12-P5) — the UI must not whitelist it. */
	role: string;
	/** Whitespace-folded and truncated to 200 chars, same as `renderTimelineView`. */
	text: string;
	session_id: string;
}

export interface ForgottenItem extends ViewItemBase {
	days_asleep: number;
	snippet: string;
}

export interface RecentItem extends ViewItemBase {
	/** Full `node.updated_ts` (ISO); `render*` only prints the first 16 chars. */
	updated_ts: string;
	disclosure: string | null;
}

export interface IndexRoot extends ViewItemBase {
	snippet: string;
}

export interface IndexDomainGroup {
	domain: string;
	roots: IndexRoot[];
}

export interface GlossaryItem {
	keyword: string;
	node_id: string;
	uri: string;
	/** `getNode` returns stubs too — the UI wants to mark those as placeholders. */
	is_stub: boolean;
}

export interface WakeupChild {
	node_id: string;
	uri: string;
	domain: string;
	importance: number;
	shadowed: boolean;
	disclosure: string | null;
	snippet: string;
}

export interface WakeupFocus {
	node_id: string;
	uri: string;
	domain: string;
	importance: number;
	/** Always false — a shadowed focus is `continue`d before it can be pushed. */
	shadowed: boolean;
	world_ts: string | null;
	/** `formatRelativeWorldTime(node.world_ts, worldTime)`; "" when uncomputable. */
	world_ts_relative: string;
	disclosure: string | null;
	/** Full body, never truncated (`render*` does not truncate here either). */
	content: string;
	children: WakeupChild[];
}

/**
 * `MEM://wakeup` is three semantically different collections, not a flat list —
 * see D4 §4.4 for why `recent` can only be parity-checked by line count.
 */
export interface WakeupViewDTO {
	world_time: string | null;
	focuses: WakeupFocus[];
	/** Entries still in the awaken list that `render*` dropped, with the reason. */
	skipped: Array<{ uri: string; reason: "missing" | "stub" | "shadowed" }>;
	recent: Array<{ node_id: string; uri: string; snippet: string }>;
}

export interface DiagnosticStaleItem extends ViewItemBase {
	days_asleep: number;
	snippet: string;
}

export interface DiagnosticCrowdedItem extends ViewItemBase {
	child_count: number;
}

export interface DiagnosticPlaceholderItem extends ViewItemBase {
	child_count: number;
	created_at: string;
}

export interface DiagnosticCategories {
	stale: DiagnosticStaleItem[];
	crowded: DiagnosticCrowdedItem[];
	placeholder: DiagnosticPlaceholderItem[];
}

export interface DiagnosticViewDTO {
	domain: string | null;
	categories: DiagnosticCategories;
	/** `render*` prints an English constant when all three categories are empty. */
	healthy: boolean;
}

/**
 * The `/api/view` response union (contract §7.2 list envelope: `{ items, total }`).
 * `domain` exists only on the three domain-aware branches — D6's
 * `test/web/dto-contract.test.ts` asserts that presence exactly.
 */
export type ViewDTO =
	| { name: "timeline"; items: TimelineItem[]; total: number }
	| { name: "forgotten"; items: ForgottenItem[]; total: number; domain: string | null }
	| { name: "recent"; items: RecentItem[]; total: number }
	| { name: "index"; items: IndexDomainGroup[]; total: number; domain: string | null }
	| { name: "glossary"; items: GlossaryItem[]; total: number }
	| { name: "wakeup"; items: WakeupViewDTO; total: number }
	| { name: "diagnostic"; items: DiagnosticViewDTO; total: number; domain: string | null };

export type ViewName = "timeline" | "forgotten" | "wakeup" | "glossary" | "recent" | "index" | "diagnostic";

/** The seven legal view names, in tab order (`views.js` mirrors this list). */
export const VIEW_NAMES: readonly ViewName[] = [
	"timeline",
	"forgotten",
	"wakeup",
	"glossary",
	"recent",
	"index",
	"diagnostic",
];

export function isViewName(name: string): name is ViewName {
	return (VIEW_NAMES as readonly string[]).includes(name);
}

export interface ViewRequest {
	/**
	 * View name. Typed as `string` because the HTTP layer narrows it first
	 * (`routes.ts`); an unknown value throws rather than silently rendering.
	 */
	name: string;
	/** Same meaning as the `domain` segment of a `MEM://` URI; `timeline` ignores it. */
	domain?: string;
	/** Defaults per view (D4 §3): timeline 20, forgotten/wakeup 5, recent 10. */
	limit?: number;
	/** Session-scoped visibility (contract §6.6 step 2). Default: everything visible. */
	isVisible?: VisibilityPredicate;
	/** Unconditional branch state (contract §6.6 step 1). Default: nothing shadowed. */
	isShadowed?: (nodeId: string) => boolean;
}

// ── defaults frozen in D4 §3 (aligned with tools.ts fallbacks, NOT re-derived) ─

const DEFAULT_TIMELINE_LIMIT = 20;
const DEFAULT_FORGOTTEN_LIMIT = 5;
const DEFAULT_WAKEUP_LIMIT = 5;
const DEFAULT_RECENT_LIMIT = 10;

/** Diagnostic thresholds — `renderDiagnosticView`'s positional defaults (§3.7). */
const DEFAULT_DAYS_STALE = 30;
const DEFAULT_MAX_CHILDREN = 10;

/** `memory-views.ts:11-14`, character for character. */
function snippet(node: MemoryNode, max = 80): string {
	const oneLine = node.content.replace(/\s+/g, " ").trim();
	return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/** Non-negative integer, minimum 1, else the view's frozen fallback (§3). */
function clampLimit(raw: number | undefined, fallback: number): number {
	if (raw === undefined || !Number.isFinite(raw)) return fallback;
	const n = Math.floor(raw);
	return n >= 1 ? n : fallback;
}

/** `renderForgottenView`/`renderDiagnosticView` sleep basis: REAL wall clock. */
function nowEpochDays(): number {
	return toEpochDays(new Date().toISOString()) ?? 0;
}

/** `nowDays - epochDays(last_accessed_at ?? created_at)`, both sides wall clock. */
function daysAsleep(node: MemoryNode, nowDays: number): number {
	return nowDays - (toEpochDays(node.last_accessed_at ?? node.created_at) ?? nowDays);
}

function toItem(node: MemoryNode, isShadowed: (nodeId: string) => boolean): ViewItemBase {
	return {
		node_id: node.node_id,
		uri: node.uri,
		domain: node.domain,
		importance: node.importance,
		shadowed: isShadowed(node.node_id),
	};
}

// ── Seven views ─────────────────────────────────────────────────────────────

/** `MEM://timeline/<domain>/<N>` — `memory-views.ts:22-40`. The only SQL here. */
export function buildTimelineView(store: MemoryStore, limit: number): ViewDTO {
	// Literal mirror of memory-views.ts:26 — same ORDER BY, same LIMIT semantics.
	// `session_id` is the one added column (§8.1#6): D3's session grouping needs it
	// and it is invisible to parity (the dimension is `raw_id`).
	const rows = store.db
		.prepare(
			"SELECT raw_id, role, text, world_ts, session_id FROM raw_log WHERE active = 1 ORDER BY raw_id DESC LIMIT ?",
		)
		.all(limit) as Array<{
		raw_id: number;
		role: string;
		text: string;
		world_ts: string | null;
		session_id: string;
	}>;
	const items: TimelineItem[] = rows.map((r) => {
		const folded = r.text.replace(/\s+/g, " ").trim();
		return {
			raw_id: r.raw_id,
			world_ts: r.world_ts ?? null,
			role: r.role,
			text: folded.length > 200 ? `${folded.slice(0, 200)}…` : folded,
			session_id: r.session_id,
		};
	});
	return { name: "timeline", items, total: items.length };
}

/** `MEM://forgotten/<domain>/<N>` — `memory-views.ts:43-76`. */
export function buildForgottenView(
	store: MemoryStore,
	domain: string | undefined,
	limit: number,
	isVisible: VisibilityPredicate,
	isShadowed: (nodeId: string) => boolean,
): ViewDTO {
	const nowDays = nowEpochDays();
	const items = store
		.listNodes(domain ? { domain } : {})
		.filter((n) => !n.is_stub && isVisible(n))
		.map((n) => ({ node: n, days: daysAsleep(n, nowDays) }))
		.sort((a, b) => b.days - a.days)
		.slice(0, limit)
		.map(
			({ node, days }): ForgottenItem => ({
				...toItem(node, isShadowed),
				days_asleep: days,
				snippet: snippet(node),
			}),
		);
	return { name: "forgotten", items, total: items.length, domain: domain ?? null };
}

/** `MEM://recent/<N>` — `memory-views.ts:145-161`. `listRecentNodes` already drops stubs. */
export function buildRecentView(
	store: MemoryStore,
	limit: number,
	isVisible: VisibilityPredicate,
	isShadowed: (nodeId: string) => boolean,
): ViewDTO {
	const items = store
		.listRecentNodes(limit)
		.filter((n) => isVisible(n))
		.map(
			(n): RecentItem => ({
				...toItem(n, isShadowed),
				updated_ts: n.updated_ts,
				// ⭐ Entry-scoped via the single read entry (`views.ts:302` per D5 §4).
				//    Value-identical to `n.disclosure` on a canonical uri, but routing it
				//    through the store keeps view pages from drifting if alias semantics
				//    ever change.
				disclosure: store.effectiveDisclosure(n.uri),
			}),
		);
	return { name: "recent", items, total: items.length };
}

/** `MEM://index[/<domain>]` — `memory-views.ts:164-178`. Empty domains are skipped. */
export function buildIndexView(
	store: MemoryStore,
	domain: string | undefined,
	isVisible: VisibilityPredicate,
	isShadowed: (nodeId: string) => boolean,
): ViewDTO {
	const domains = domain ? [domain] : store.listDomains();
	const items: IndexDomainGroup[] = [];
	for (const d of domains) {
		const roots = store
			.listNodes({ domain: d })
			.filter((n) => !n.is_stub && n.parent_id === null && isVisible(n))
			.map(
				(n): IndexRoot => ({
					...toItem(n, isShadowed),
					snippet: snippet(n),
				}),
			);
		if (roots.length === 0) continue; // `memory-views.ts:174`
		items.push({ domain: d, roots });
	}
	return { name: "index", items, total: items.length, domain: domain ?? null };
}

/** `MEM://glossary` — `memory-views.ts:129-142`. Keyed by `node_id`, so `getNode`. */
export function buildGlossaryView(store: MemoryStore): ViewDTO {
	const items: GlossaryItem[] = [];
	for (const e of store.listGlossary()) {
		// `getNode` takes a node_id (not `resolveUri`, which takes a uri). A
		// missing node drops the whole entry — never a `uri: null` row (§3.5).
		const node = store.getNode(e.node_id);
		if (!node) continue; // `memory-views.ts:139-140`
		items.push({ keyword: e.keyword, node_id: node.node_id, uri: node.uri, is_stub: node.is_stub === 1 });
	}
	return { name: "glossary", items, total: items.length };
}

/** `MEM://wakeup/<N>` — `memory-views.ts:82-126`. The densest filtering of the seven. */
export function buildWakeupView(
	store: MemoryStore,
	awakenUris: string[],
	limit: number,
	isVisible: VisibilityPredicate,
	isShadowed: (nodeId: string) => boolean,
): ViewDTO {
	const worldTime = store.getWorldTime();
	// Both sets start from the RAW list (§2.6 ①/③): an alias in the list makes
	// the `fullUris.has(child.uri)` test miss, and `render*` replays that miss.
	const fullUris = new Set<string>(awakenUris);
	const listed = new Set<string>(awakenUris);
	const focuses: WakeupFocus[] = [];
	const skipped: WakeupViewDTO["skipped"] = [];

	for (const uri of awakenUris) {
		// Iterate the ORIGINAL array, not the Set — duplicates render twice (§2.6 ②).
		const node = store.resolveUri(uri); // aliases resolve (§2.6 ①)
		if (!node) {
			skipped.push({ uri, reason: "missing" });
			continue;
		}
		if (node.is_stub) {
			skipped.push({ uri, reason: "stub" });
			continue;
		}
		if (!isVisible(node)) {
			skipped.push({ uri, reason: "shadowed" });
			continue;
		}
		const children: WakeupChild[] = [];
		for (const child of store.children(node.node_id)) {
			if (child.is_stub || !isVisible(child)) continue;
			if (fullUris.has(child.uri)) continue; // `memory-views.ts:109`
			listed.add(child.uri);
			children.push({
				node_id: child.node_id,
				uri: child.uri,
				domain: child.domain,
				importance: child.importance,
				shadowed: isShadowed(child.node_id),
				disclosure: store.effectiveDisclosure(child.uri),
				snippet: snippet(child, 100),
			});
		}
		focuses.push({
			node_id: node.node_id,
			uri: node.uri, // the RESOLVED uri, never the list's original string
			domain: node.domain,
			importance: node.importance,
			shadowed: isShadowed(node.node_id),
			world_ts: node.world_ts,
			world_ts_relative: formatRelativeWorldTime(node.world_ts, worldTime),
			disclosure: store.effectiveDisclosure(node.uri),
			content: node.content,
			children,
		});
	}

	// `limit` bounds ONLY `recent`; the focus count is the awaken list's length (§3.6).
	const recent = store
		.listRecentNodes(limit)
		.filter((n) => !listed.has(n.uri) && isVisible(n))
		.map((n) => ({ node_id: n.node_id, uri: n.uri, snippet: snippet(n) }));

	const items: WakeupViewDTO = { world_time: worldTime, focuses, skipped, recent };
	return { name: "wakeup", items, total: focuses.length + recent.length };
}

/**
 * `MEM://diagnostic/<domain>` — `memory-views.ts:180-224`.
 *
 * ⚠️ It takes NO `isVisible`: `renderDiagnosticView` never filters shadowed
 * nodes (it is a library-health report, not a node collection). Adding a filter
 * here would break parity immediately (§3.7, §6).
 */
export function buildDiagnosticView(
	store: MemoryStore,
	domain: string | undefined,
	isShadowed: (nodeId: string) => boolean,
): ViewDTO {
	const nodes = store.listNodes(domain ? { domain } : {}).filter((n) => !n.is_stub);
	const nowDays = nowEpochDays();
	// Magic thresholds copied verbatim from memory-views.ts:186, not re-derived.
	const importanceThreshold: Record<number, number> = { 10: 3, 9: 7, 8: 14 };
	const stale = nodes
		.map((n) => ({ node: n, days: daysAsleep(n, nowDays) }))
		.filter(({ node, days }) => days > (importanceThreshold[node.importance] ?? DEFAULT_DAYS_STALE))
		.sort((a, b) => b.node.importance - a.node.importance || b.days - a.days)
		.map(
			({ node, days }): DiagnosticStaleItem => ({
				...toItem(node, isShadowed),
				days_asleep: days,
				snippet: snippet(node),
			}),
		);

	// `childCount` counts NON-STUB children only (the base set already dropped stubs).
	const childCount = new Map<string, number>();
	for (const n of nodes) {
		if (n.parent_id) childCount.set(n.parent_id, (childCount.get(n.parent_id) ?? 0) + 1);
	}
	const crowded = nodes
		.filter((n) => (childCount.get(n.node_id) ?? 0) > DEFAULT_MAX_CHILDREN)
		.map(
			(n): DiagnosticCrowdedItem => ({
				...toItem(n, isShadowed),
				child_count: childCount.get(n.node_id) ?? 0,
			}),
		);
	// ⚠️ The placeholder base set is re-queried WITHOUT the stub filter — this
	// deliberate asymmetry with `nodes` is what makes stubs show up (§3.7).
	const placeholder = store
		.listNodes(domain ? { domain } : {})
		.filter((n) => n.is_stub && (childCount.get(n.node_id) ?? 0) > 0)
		.map(
			(n): DiagnosticPlaceholderItem => ({
				...toItem(n, isShadowed),
				child_count: childCount.get(n.node_id) ?? 0,
				created_at: n.created_at,
			}),
		);

	const healthy = stale.length === 0 && crowded.length === 0 && placeholder.length === 0;
	const items: DiagnosticViewDTO = {
		domain: domain ?? null,
		categories: { stale, crowded, placeholder },
		healthy,
	};
	return {
		name: "diagnostic",
		items,
		total: stale.length + crowded.length + placeholder.length,
		domain: domain ?? null,
	};
}

// ── The single entry point ──────────────────────────────────────────────────

/**
 * Dispatch to one of the seven builders.
 *
 * `name`, `domain` and `limit` are taken as explicit structured parameters —
 * NEVER parsed out of a `MEM://` URI (contract §16.8 / P17). Both predicates are
 * request-scoped and optional; when omitted everything is treated as visible and
 * nothing as shadowed (which is what `/api/view` never does, but what the parity
 * tests and non-session callers rely on).
 */
export function buildView(store: MemoryStore, req: ViewRequest): ViewDTO {
	const isVisible: VisibilityPredicate = req.isVisible ?? (() => true);
	const isShadowed = req.isShadowed ?? (() => false);
	switch (req.name) {
		case "timeline":
			// `domain` is ignored: raw_log has no domain concept (§3.0).
			return buildTimelineView(store, clampLimit(req.limit, DEFAULT_TIMELINE_LIMIT));
		case "forgotten":
			return buildForgottenView(
				store,
				req.domain,
				clampLimit(req.limit, DEFAULT_FORGOTTEN_LIMIT),
				isVisible,
				isShadowed,
			);
		case "recent":
			// `recent` has no domain segment in `render*` either (§8.1#3).
			return buildRecentView(store, clampLimit(req.limit, DEFAULT_RECENT_LIMIT), isVisible, isShadowed);
		case "index":
			return buildIndexView(store, req.domain, isVisible, isShadowed);
		case "glossary":
			return buildGlossaryView(store);
		case "wakeup":
			return buildWakeupView(
				store,
				getAwakenUris(store),
				clampLimit(req.limit, DEFAULT_WAKEUP_LIMIT),
				isVisible,
				isShadowed,
			);
		case "diagnostic":
			return buildDiagnosticView(store, req.domain, isShadowed);
		default:
			throw new Error(`unknown view ${req.name}`);
	}
}
