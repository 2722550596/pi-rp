/**
 * Memory slots — the three prompt-preset slots (docs/memory-system.md §11).
 *
 * awaken: preloaded URI list (原文 + 子 snippet + 世界时间行), reconciled
 *   against live URIs at render time (deleted nodes drop out, renames follow).
 * recent: most recently updated nodes (updated_ts desc), counts configurable.
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
	rawCount?: number;
	snippetCount?: number;
}

export interface MemorySlotsOptions {
	/** Live visibility predicate from the module (hidden auto nodes skipped). */
	isVisible?: VisibilityPredicate;
}

function snippet(node: { uri: string; content: string; disclosure?: string | null }, max = 80): string {
	const oneLine = node.content.replace(/\s+/g, " ").trim();
	const disc = "disclosure" in node && node.disclosure ? ` (${node.disclosure})` : "";
	return `${node.uri}${disc}: ${oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine}`;
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
				if (node.disclosure) {
					lines.push(`> 什么时候想起：${node.disclosure}\n`);
				}
				lines.push(node.content);
				const childLines: string[] = [];
				for (const child of store.children(node.node_id)) {
					if (child.is_stub || !visible(child)) continue;
					if (fullUris.has(child.uri)) continue; // 已作为完整 awaken 块渲染的 URI 不再作为子 snippet 重复显示
					const disc = child.disclosure ? ` (${child.disclosure})` : "";
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
		description: "最近记忆：按 updated_ts 倒序拉最新（raw / snippet 数量可配）",
		async: true,
		render: (context) => {
			const options = (context.item.options ?? {}) as RecentSlotOptions;
			const nodes = store.listRecentNodes(Math.max(options.snippetCount ?? 10, 1)).filter((n) => visible(n));
			if (nodes.length === 0) return "";
			const rawCount = options.rawCount ?? 0;
			if (rawCount > 0) {
				const last = store.db.prepare("SELECT MAX(raw_id) AS m FROM raw_log").get() as { m: number | null };
				const upto = last.m ?? 0;
				// Recent slot shows the ACTIVE transcript (inactive rows are
				// rolled-back variants, §3.2).
				const rows = upto > 0 ? store.listRaw(Math.max(1, upto - rawCount + 1), upto, { activeOnly: true }) : [];
				const rawLines = rows.map((r) => `[${r.raw_id}] ${r.role}: ${r.text.slice(0, 200)}`);
				const snippetLines = nodes.slice(0, options.snippetCount ?? 10).map((x) => snippet(x));
				return [...rawLines, ...snippetLines].join("\n");
			}
			return nodes.map((x) => snippet(x)).join("\n");
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
				for (const root of roots) lines.push(snippet(root));
			}
			return lines.join("\n");
		},
	};

	return [awaken, recent, index];
}
