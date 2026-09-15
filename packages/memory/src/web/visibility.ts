/**
 * Branch visibility (plan/memory-web/00-共同上下文.md §6.6).
 *
 * The engine decides visibility in-memory (`module.ts:334-348`): an `auto` node
 * shows only while the raw entry that produced it is still on the active
 * branch. A standalone server cannot see "the current session", so it derives
 * the branch state from `raw_log.active` instead — conservatively.
 *
 * Step 1 (unconditional, the Web default): a node's own branch state.
 *   source !== "auto"                      -> not shadowed
 *   auto, anchor_entry_id/session missing  -> shadowed  (mirrors module.ts:340-342)
 *   auto, both anchors present             -> shadowed iff that (entry_id,
 *                                             session_id) row is gone or active = 0
 *
 * Step 2 (only when the caller names a view session): nodes whose anchor
 * belongs to ANOTHER session do not participate at all — the engine `continue`s
 * on them, so we must neither call them shadowed nor call them visible.
 *
 * UI wording is frozen to 「已遮蔽（原分支已回滚）」 — NOT 「已隐藏」, because the
 * engine skips foreign-session nodes rather than hiding them.
 */
import type { MemoryStore } from "../store.ts";

export interface Visibility {
	/** Session-scoped predicate; accepts any `{ node_id }` (store callers pass lean rows). */
	isVisible: (node: { node_id: string }) => boolean;
	/** Step 1's unconditional verdict, by `node_id`. */
	isShadowed: (nodeId: string) => boolean;
	/** `node_id`s skipped by step 2 (foreign session); empty without a session. */
	foreignSession: (nodeId: string) => boolean;
}

/**
 * Step 1 over the whole tree in one pass: one `listNodes()` plus one indexed
 * lookup per `auto` node. Cheap for a page-sized tree, and the same map backs
 * both `/api/tree` and `/api/node`.
 */
export function buildShadowedIndex(store: MemoryStore): Map<string, boolean> {
	const raw = store.db.prepare("SELECT active FROM raw_log WHERE entry_id = ? AND session_id = ?");
	const index = new Map<string, boolean>();
	for (const node of store.listNodes()) {
		if (node.source !== "auto") {
			index.set(node.node_id, false);
			continue;
		}
		if (!node.anchor_entry_id || !node.anchor_session_id) {
			index.set(node.node_id, true);
			continue;
		}
		const row = raw.get(node.anchor_entry_id, node.anchor_session_id) as { active: number } | undefined;
		index.set(node.node_id, !row || Number(row.active) === 0);
	}
	return index;
}

/** Step 1 as a predicate — the default the Web reads with. */
export function makeIsShadowed(index: Map<string, boolean>): (nodeId: string) => boolean {
	return (nodeId) => index.get(nodeId) === true;
}

export function createVisibility(store: MemoryStore, opts: { sessionId?: string } = {}): Visibility {
	const index = buildShadowedIndex(store);
	const sessionId = opts.sessionId;
	const foreign = new Set<string>();
	if (sessionId !== undefined) {
		for (const node of store.listNodes()) {
			if (node.source === "auto" && node.anchor_session_id !== sessionId) foreign.add(node.node_id);
		}
	}
	return {
		isShadowed: (nodeId) => index.get(nodeId) === true,
		foreignSession: (nodeId) => foreign.has(nodeId),
		isVisible: (node) => {
			if (foreign.has(node.node_id)) return false;
			return index.get(node.node_id) !== true;
		},
	};
}
