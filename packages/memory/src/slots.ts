/**
 * Memory slots — the three prompt-preset slots (docs/memory-system.md §11).
 *
 * awaken: preloaded URI list (原文 + 子 snippet + 世界时间行), reconciled
 *   against live URIs at render time (deleted nodes drop out, renames follow).
 * recent: most recently updated nodes (updated_ts desc): the newest rawCount
 *   entries render as full text (default 1), the next snippetCount as
 *   snippets (default 4).
 * index:  one snippet per domain root.
 *
 * All three filter hidden auto nodes through the module's live visibility
 * predicate (§5.7): a rolled-back summary must never surface through the
 * prompt preset either.
 */
import { formatRelativeWorldTime } from "./recall.ts";
import type { MemoryNode, MemoryStore, VisibilityPredicate } from "./store.ts";
import { getAwakenUris } from "./tools.ts";

/** Structural mirror of coding-agent SlotDefinition (packages/memory must not depend on coding-agent). */
export interface MemorySlotDefinition {
	name: string;
	description: string;
	async: true;
	render: (context: { item: { options?: Record<string, unknown> } }) => string | Promise<string>;
}

export interface RecentSlotOptions {
	/** Newest entries rendered as full original text. Default 1. */
	rawCount?: number;
	/** Following entries rendered as one-line snippets. Default 4. */
	snippetCount?: number;
}

export interface MemorySlotsOptions {
	/** Live visibility predicate from the module (hidden auto nodes skipped). */
	isVisible?: VisibilityPredicate;
}

function snippet(store: MemoryStore, node: { uri: string; content: string }, max = 80): string {
	const oneLine = node.content.replace(/\s+/g, " ").trim();
	const disc = store.effectiveDisclosure(node.uri);
	return `${node.uri}${disc ? ` (${disc})` : ""}: ${oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine}`;
}

function fullText(store: MemoryStore, node: { uri: string; content: string }): string {
	const disc = store.effectiveDisclosure(node.uri);
	return `### ${node.uri}${disc ? ` (${disc})` : ""}\n${node.content}`;
}

/**
 * Build the 3 memory slots bound to `store`.
 * Rendering runs inside the prompt-preset compile path; Phase 2 registers
 * these via registerSlot(def, true).
 */
export function createMemorySlots(store: MemoryStore, opts: MemorySlotsOptions = {}): MemorySlotDefinition[] {
	const visible = (node: MemoryNode): boolean => (opts.isVisible ? opts.isVisible(node) : true);

	const awaken: MemorySlotDefinition = {
		name: "awaken",
		description: "常驻觉知记忆：醒来时预加载的 URI 原文 + 子节点 snippet（+世界时间行）",
		async: true,
		render: () => {
			const uris = getAwakenUris(store);
			const worldTime = store.getWorldTime();
			const fullUris = new Set(uris);
			const blocks: string[] = [];
			for (const uri of uris) {
				const node = store.resolveUri(uri);
				if (!node || node.is_stub || !visible(node)) continue; // 对账：已删/失效/隐藏 uri 自动剔除
				const lines = [`### ${node.uri}`];
				if (node.world_ts) {
					const rel = formatRelativeWorldTime(node.world_ts, worldTime);
					lines.push(rel ? `> (发生于: ${node.world_ts}，${rel})` : `> (发生于: ${node.world_ts})`);
				}
				// The awaken entry is what the user registered — it may be an alias,
				// and that entry's own condition is what belongs here (not the
				// resolved node's, which would show another entry's disclosure).
				const disc = store.effectiveDisclosure(uri);
				if (disc) {
					lines.push(`> 什么时候想起：${disc}\n`);
				}
				lines.push(node.content);
				const childLines: string[] = [];
				for (const child of store.children(node.node_id)) {
					if (child.is_stub || !visible(child)) continue;
					if (fullUris.has(child.uri)) continue; // 已作为完整 awaken 块渲染的 URI 不再作为子 snippet 重复显示
					const childDisc = store.effectiveDisclosure(child.uri);
					const disc = childDisc ? ` (${childDisc})` : "";
					const rawContent = (child.content || "").replace(/\s+/g, " ").trim();
					const snip = rawContent.length > 100 ? `${rawContent.slice(0, 100)}...` : rawContent;
					const snipStr = snip ? ` — ${snip}` : "";
					childLines.push(`- ${child.uri}${disc}${snipStr}`);
				}
				if (childLines.length > 0) {
					lines.push("", ...childLines);
				}
				blocks.push(lines.join("\n"));
			}
			if (blocks.length === 0) return "";
			if (worldTime) {
				blocks.unshift(`> 当前世界时间: ${worldTime}`);
			}
			return blocks.join("\n\n---\n\n");
		},
	};

	const recent: MemorySlotDefinition = {
		name: "recent",
		description:
			"最近记忆：按 updated_ts 倒序，最新 rawCount 条给完整原文（默认 1），其后 snippetCount 条给 snippet（默认 4）",
		async: true,
		render: (context) => {
			const options = (context.item.options ?? {}) as RecentSlotOptions;
			const rawCount = Math.max(options.rawCount ?? 1, 0);
			const snippetCount = Math.max(options.snippetCount ?? 4, 0);
			const total = rawCount + snippetCount;
			if (total === 0) return "";
			const nodes = store.listRecentNodes(total).filter((n) => visible(n));
			if (nodes.length === 0) return "";
			return nodes.map((node, i) => (i < rawCount ? fullText(store, node) : snippet(store, node))).join("\n");
		},
	};

	const index: MemorySlotDefinition = {
		name: "index",
		description: "记忆索引：所有 domain 根节点 snippet 视图",
		async: true,
		render: () => {
			const lines: string[] = [];
			for (const domain of store.listDomains()) {
				const roots = store.listNodes({ domain }).filter((x) => !x.is_stub && x.parent_id === null && visible(x));
				for (const root of roots) lines.push(snippet(store, root));
			}
			return lines.join("\n");
		},
	};

	return [awaken, recent, index];
}
