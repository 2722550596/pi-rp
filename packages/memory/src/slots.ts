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
 * Static memory.* macros share these renderers and emit absolute-date snapshots.
 */
import { dayNumber } from "./clock.ts";
import { formatRelativeWorldTime } from "./recall.ts";
import type { MemoryStore, VisibilityPredicate } from "./store.ts";
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

export interface MemoryRenderOptions {
	/** Live visibility predicate from the module (hidden auto nodes skipped). */
	isVisible?: VisibilityPredicate;
	/** settings.memory.render.relativeTime; false renders neutral plain stamps. Default true. */
	relativeTime?: boolean;
}

/** Neutral `YYYY-MM-DD HH:mm` (date only when the stamp has no time); unparseable stamps pass through. */
export function plainStamp(ts: string): string {
	const match = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/.exec(ts);
	if (!match) return ts;
	return match[2] ? `${match[1]} ${match[2]}` : match[1]!;
}

export interface MemorySlotsOptions extends MemoryRenderOptions {}

export type MemoryRenderForm = "slot" | "snapshot";

/** Structural mirror of the synchronous coding-agent macro contract. */
export interface MemoryMacroRenderContext {
	runtime: unknown;
	variables: Record<string, string>;
	params?: string;
}

export interface MemoryMacroDefinition {
	name: string;
	description: string;
	render: (context: MemoryMacroRenderContext) => string;
	static?: boolean;
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

export function renderAwaken(store: MemoryStore, opts: MemoryRenderOptions, form: MemoryRenderForm): string {
	const uris = getAwakenUris(store);
	const relative = opts.relativeTime !== false;
	const worldTime =
		form === "slot"
			? store.getClock().mode === "real"
				? store.referenceNow()
				: (store.getWorldTime() ?? new Date().toISOString())
			: undefined;
	const fullUris = new Set(uris);
	const blocks: string[] = [];
	for (const uri of uris) {
		const node = store.resolveUri(uri);
		if (!node || node.is_stub || (opts.isVisible && !opts.isVisible(node))) continue;
		const lines = [`### ${node.uri}`];
		if (node.world_ts) {
			const rel =
				form === "slot" && relative
					? formatRelativeWorldTime(node.world_ts, worldTime, (t) => dayNumber(t, store.getClock()))
					: "";
			const stamp = relative ? node.world_ts : plainStamp(node.world_ts);
			lines.push(rel ? `> (发生于: ${stamp}，${rel})` : `> (发生于: ${stamp})`);
		}
		// Disclosure belongs to the registered entry, including an alias.
		const disc = store.effectiveDisclosure(uri);
		if (disc) lines.push(`> 什么时候想起：${disc}\n`);
		lines.push(node.content);
		const childLines: string[] = [];
		for (const child of store.children(node.node_id)) {
			if (child.is_stub || (opts.isVisible && !opts.isVisible(child))) continue;
			if (fullUris.has(child.uri)) continue;
			const childDisc = store.effectiveDisclosure(child.uri);
			const disc = childDisc ? ` (${childDisc})` : "";
			const rawContent = (child.content || "").replace(/\s+/g, " ").trim();
			const snip = rawContent.length > 100 ? `${rawContent.slice(0, 100)}...` : rawContent;
			const snipStr = snip ? ` — ${snip}` : "";
			childLines.push(`- ${child.uri}${disc}${snipStr}`);
		}
		if (childLines.length > 0) lines.push("", ...childLines);
		blocks.push(lines.join("\n"));
	}
	if (blocks.length === 0) return "";
	if (form === "slot" && store.getClock().mode !== "real" && worldTime) {
		blocks.unshift(`> 当前世界时间: ${relative ? worldTime : plainStamp(worldTime)}`);
	}
	return blocks.join("\n\n---\n\n");
}

export function renderRecent(
	store: MemoryStore,
	opts: MemoryRenderOptions,
	options: RecentSlotOptions,
	_form: MemoryRenderForm,
): string {
	const rawCount = Math.max(options.rawCount ?? 1, 0);
	const snippetCount = Math.max(options.snippetCount ?? 4, 0);
	const total = rawCount + snippetCount;
	if (total === 0) return "";
	const nodes = store.listRecentNodes(total).filter((n) => !opts.isVisible || opts.isVisible(n));
	if (nodes.length === 0) return "";
	return nodes.map((node, i) => (i < rawCount ? fullText(store, node) : snippet(store, node))).join("\n");
}

export function renderIndex(store: MemoryStore, opts: MemoryRenderOptions, _form: MemoryRenderForm): string {
	const lines: string[] = [];
	for (const domain of store.listDomains()) {
		const roots = store
			.listNodes({ domain })
			.filter((x) => !x.is_stub && x.parent_id === null && (!opts.isVisible || opts.isVisible(x)));
		for (const root of roots) lines.push(snippet(store, root));
	}
	return lines.join("\n");
}

/** Build the live prompt slots; their world-mode output stays unchanged. */
export function createMemorySlots(store: MemoryStore, opts: MemorySlotsOptions = {}): MemorySlotDefinition[] {
	return [
		{
			name: "awaken",
			description: "常驻觉知记忆：醒来时预加载的 URI 原文 + 子节点 snippet（+世界时间行）",
			async: true,
			render: () => renderAwaken(store, opts, "slot"),
		},
		{
			name: "recent",
			description:
				"最近记忆：按 updated_ts 倒序，最新 rawCount 条给完整原文（默认 1），其后 snippetCount 条给 snippet（默认 4）",
			async: true,
			render: (context) => renderRecent(store, opts, (context.item.options ?? {}) as RecentSlotOptions, "slot"),
		},
		{
			name: "index",
			description: "记忆索引：所有 domain 根节点 snippet 视图",
			async: true,
			render: () => renderIndex(store, opts, "slot"),
		},
	];
}

export function parseRecentMacroParams(params: string | undefined): RecentSlotOptions {
	const options: RecentSlotOptions = { rawCount: 1, snippetCount: 4 };
	for (const part of (params ?? "").split(",")) {
		const equals = part.indexOf("=");
		if (equals < 0) continue;
		const key = part.slice(0, equals).trim();
		if (key !== "rawCount" && key !== "snippetCount") continue;
		const value = part.slice(equals + 1).trim();
		const count = /^-?\d+$/.test(value) ? Number(value) : NaN;
		options[key] = Number.isFinite(count) ? Math.max(count, 0) : key === "rawCount" ? 1 : 4;
	}
	return options;
}

/** Snapshot caching belongs to the host's macro epoch, never to memory. */
export function createMemoryMacros(store: MemoryStore, opts: MemoryRenderOptions = {}): MemoryMacroDefinition[] {
	return [
		{
			name: "memory.awaken",
			description: "醒来记忆的静态快照",
			renderBody: () => renderAwaken(store, opts, "snapshot"),
		},
		{
			name: "memory.recent",
			description: "最近记忆的静态快照",
			renderBody: (params: string | undefined) =>
				renderRecent(store, opts, parseRecentMacroParams(params), "snapshot"),
		},
		{
			name: "memory.index",
			description: "记忆索引的静态快照",
			renderBody: () => renderIndex(store, opts, "snapshot"),
		},
	].map<MemoryMacroDefinition>(({ name, description, renderBody }) => ({
		name,
		description,
		static: true,
		render: ({ params }) => {
			const now = store.referenceNow();
			const header = `> 快照时间: ${opts.relativeTime === false ? plainStamp(now) : now}（此后新写入的记忆不在这份快照里，需要时用 recall 或 retrieve 查）`;
			const body = renderBody(params);
			return body === "" ? "" : `${header}\n${body}`;
		},
	}));
}
