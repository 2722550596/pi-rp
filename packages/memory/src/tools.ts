/**
 * Memory tools — the unified tool surface (docs/memory-system.md §10).
 *
 * Twelve entries covering the 9 core cognitive verbs plus retrace / set_time /
 * awaken. Each execute() runs against a local MemoryStore; provenance (§6) is
 * auto-filled from the session context — never hand-typed by the model. Since
 * v5.5:
 * - revise gains action:"history"|"restore" (revision read path + deleted-uri
 *   recovery), memorize/revise promote stubs in place;
 * - relocate is a thin wrapper over the atomic subtree move relocateMany();
 * - consolidate(group) really re-parents sources under the theme;
 * - associate has two mutually exclusive modes: alias (new_uri) and edge
 *   (related_uri + kind); explicit retrieve diffuses one hop over edges;
 * - retrace walks raw windows by uri anchor and full-text query;
 * - recall/retrieve stamp audit records and access times; all read paths
 *   filter hidden auto nodes via the live visibility predicate.
 */
import { type Static, type TSchema, Type } from "typebox";
import type { EmbeddingClient } from "./embeddings.ts";
import {
	renderDiagnosticView,
	renderForgottenView,
	renderGlossaryView,
	renderIndexView,
	renderRecentView,
	renderTimelineView,
	renderWakeupView,
} from "./memory-views.ts";
import { search, toEpochDays } from "./recall.ts";
import type { MemoryNode, MemoryStore, VisibilityPredicate } from "./store.ts";

/** Minimal structural shape of coding-agent ToolDefinition execute (no pi dep). */
export interface MemoryToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
}

export interface MemoryToolDef {
	name: string;
	label: string;
	description: string;
	/** TypeBox parameter schema. */
	parameters: TSchema;
	execute: (toolCallId: string, params: Record<string, unknown>) => Promise<MemoryToolResult>;
}
export interface MemoryToolContext {
	/** Writer model id (ctx.model.id) — stamped into nodes.model on every write. */
	modelId?: string;
	/** Session leaf entry id — stamped into nodes.anchor_entry_id on every write. */
	leafId?: string | null;
	/** Session id — stamped into nodes.anchor_session_id / audit turn scoping. */
	sessionId?: string;
	/** Current turn counter — stamped into audit rows. */
	turn?: number;
	/** Live visibility predicate — hidden auto nodes never leak into read paths. */
	isVisible?: VisibilityPredicate;
	/** Shared embedding client — enables retrieve(semantic) (docs §9). */
	embeddings?: EmbeddingClient;
}

const AWAKEN_URIS_KEY = "awaken_uris";

// ── helpers ────────────────────────────────────────────────────────────────

function text(t: string): MemoryToolResult {
	return { content: [{ type: "text", text: t }], details: {} };
}
function withDetails(t: string, details: Record<string, unknown>): MemoryToolResult {
	return { content: [{ type: "text", text: t }], details };
}

function nodeRow(node: MemoryNode): string {
	const time = node.world_ts ? ` @ ${node.world_ts}` : "";
	return `${node.uri}${time}\n  ${node.content}`;
}

function snippet(node: MemoryNode, max = 80): string {
	const oneLine = node.content.replace(/\s+/g, " ").trim();
	return `${node.uri}: ${oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine}`;
}

/** Expand a URI into its subtree, depth-bounded. depth -1 = full tree. */
function subtree(store: MemoryStore, root: MemoryNode, depth: number, maxNodes: number): string[] {
	const lines: string[] = [];
	const walk = (node: MemoryNode, level: number): void => {
		if (lines.length >= maxNodes) {
			lines.push(`${node.uri} (内容省略)`);
			return;
		}
		lines.push(level === 0 ? nodeRow(node) : `${"  ".repeat(level)}${nodeRow(node)}`);
		if (depth >= 0 && level >= depth) return;
		for (const child of store.children(node.node_id)) walk(child, level + 1);
	};
	walk(root, 0);
	return lines;
}

function parseWorldTime(store: MemoryStore, time: string | undefined): string | null {
	if (time === undefined || time === "") return null;
	// Relative offsets ("+1d") stamp THIS write only — the global world clock
	// is advanced exclusively by set_time (docs §6/§10 separation).
	const relative = /^([+-])(\d+)([smhdwy])$/.exec(time);
	if (relative) {
		const [, sign, amount, unit] = relative;
		const ms: Record<string, number> = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 };
		const base = Date.parse(store.getWorldTime() ?? new Date().toISOString());
		if (!Number.isFinite(base) || !unit || !ms[unit]) return time;
		const delta = Number(amount) * ms[unit];
		return new Date(sign === "+" ? base + delta : base - delta).toISOString();
	}
	return time;
}

/** Resolve the temporal value a write should stamp: explicit time > world clock. */
function stampWorldTs(store: MemoryStore, time: string | undefined): string | null {
	if (time !== undefined && time !== "") {
		const parsed = parseWorldTime(store, time);
		if (parsed !== null) return parsed;
	}
	return store.getWorldTime();
}

/** Audit a character-initiated recall/retrieve (§12 decision 23, §6.1). */
function auditRecall(
	store: MemoryStore,
	ctx: MemoryToolContext,
	object: string,
	nodeIds: string[],
	extra: Record<string, unknown>,
): void {
	store.logAudit("recall", {
		node_id: nodeIds[0],
		object,
		model: ctx.modelId,
		turn: ctx.turn,
		anchor: ctx.leafId ?? undefined,
		details: JSON.stringify({ node_ids: nodeIds, ...extra }),
	});
}

// ── recall ─────────────────────────────────────────────────────────────────

const recallParams = Type.Object({
	uri: Type.String({
		description:
			"记忆 URI，如 core://identity/habits。系统视图：MEM://recent/<N>、MEM://index/<domain>、MEM://timeline/<domain>/<N>、MEM://forgotten/<domain>/<N>、MEM://glossary、MEM://wakeup/<N>、MEM://diagnostic/<domain>。",
	}),
	depth: Type.Optional(
		Type.Number({
			description: "展开子树的层数。0（默认）= 本节点全文 + 直接子节点 URI 列表；N = 递归 N 层；-1 = 展开整棵子树。",
		}),
	),
	max_nodes: Type.Optional(Type.Number({ description: "子树模式下最多渲染多少条节点正文，防刷爆上下文。默认 200。" })),
});

/** Parse a MEM:// view limit segment: non-negative integer, min 1. */
function parseViewCount(uri: string, partIndex: number, fallback: number): number {
	const raw = Number(uri.split("/")[partIndex]);
	return Number.isInteger(raw) && raw >= 1 ? raw : fallback;
}

async function executeRecall(
	store: MemoryStore,
	params: Static<typeof recallParams>,
	ctx: MemoryToolContext,
): Promise<MemoryToolResult> {
	const { uri, depth, max_nodes: maxNodes } = params;
	// System views never touch access times — browsing is not "想起" (§13/§5.6).
	if (uri === "MEM://recent" || uri.startsWith("MEM://recent/")) {
		const n = parseViewCount(uri, 2, 10);
		const rendered = renderRecentView(store, n, ctx.isVisible);
		const nodes = store.listRecentNodes(n).filter((x) => (ctx.isVisible ? ctx.isVisible(x) : true));
		auditRecall(
			store,
			ctx,
			uri,
			nodes.map((x) => x.node_id),
			{ view: "recent" },
		);
		return withDetails(rendered, { node_ids: nodes.map((x) => x.node_id) });
	}
	if (uri === "MEM://index" || uri.startsWith("MEM://index/")) {
		const rest = uri.slice("MEM://index".length); // "" or "/<domain>"
		const domain = rest.startsWith("/") && rest.length > 1 ? rest.slice(1) : undefined;
		auditRecall(store, ctx, uri, [], { view: "index" });
		return text(renderIndexView(store, domain, ctx.isVisible));
	}
	if (uri === "MEM://glossary") {
		auditRecall(store, ctx, uri, [], { view: "glossary" });
		return text(renderGlossaryView(store));
	}
	if (uri === "MEM://wakeup" || uri.startsWith("MEM://wakeup/")) {
		const n = parseViewCount(uri, 2, 5);
		auditRecall(store, ctx, uri, [], { view: "wakeup" });
		return text(renderWakeupView(store, getAwakenUris(store), n, ctx.isVisible));
	}
	if (uri === "MEM://timeline" || uri.startsWith("MEM://timeline/")) {
		// Data source is raw_log (message-level, §15.4): the domain segment is
		// accepted for uri compatibility but raw_log is domain-agnostic.
		const n = parseViewCount(uri, 3, 20);
		auditRecall(store, ctx, uri, [], { view: "timeline" });
		return text(renderTimelineView(store, n));
	}
	if (uri === "MEM://forgotten" || uri.startsWith("MEM://forgotten/")) {
		const parts = uri.split("/");
		// <domain> must not be numeric: MEM://forgotten/<N> treats N as the
		// limit, not a domain name.
		const second = parts[2];
		const domain = second && second !== "" && !/^\d+$/.test(second) ? second : undefined;
		const n = parseViewCount(uri, /^\d+$/.test(second ?? "") ? 2 : 3, 5);
		auditRecall(store, ctx, uri, [], { view: "forgotten" });
		return text(renderForgottenView(store, domain, n, ctx.isVisible));
	}
	if (uri === "MEM://diagnostic" || uri.startsWith("MEM://diagnostic/")) {
		const domain = uri.slice("MEM://diagnostic/".length) || undefined;
		auditRecall(store, ctx, uri, [], { view: "diagnostic" });
		return text(renderDiagnosticView(store, domain || undefined));
	}

	const node = store.resolveUri(uri);
	if (!node) return text(`未找到记忆：${uri}`);
	if (node.is_stub) return text(`（占位节点，无正文）${uri}`);
	const lines = subtree(store, node, depth ?? 0, maxNodes ?? 200);
	const nodeIds = collectSubtreeIds(store, node);
	// Explicitly recalled: the character is "thinking of" this subtree — the
	// access time is the sleep metric for forgotten/diagnostic (§13).
	store.markAccessed(nodeIds);
	auditRecall(store, ctx, uri, nodeIds, { depth: depth ?? 0 });
	return withDetails(lines.join("\n"), { node_id: node.node_id });
}

function collectSubtreeIds(store: MemoryStore, root: MemoryNode): string[] {
	const ids = [root.node_id];
	for (const child of store.children(root.node_id)) ids.push(...collectSubtreeIds(store, child));
	return ids;
}

// ── retrieve ───────────────────────────────────────────────────────────────

const retrieveParams = Type.Object({
	query: Type.String({ description: "搜索关键词" }),
	domain: Type.Optional(Type.String({ description: "限定 domain（树根），如 core、history" })),
	limit: Type.Optional(Type.Number({ description: "最多返回条数，默认 10" })),
	semantic: Type.Optional(
		Type.Boolean({ description: "是否启用语义检索（默认启用；未配置 embedding API 时自动退化为词法）" }),
	),
});

async function executeRetrieve(store: MemoryStore, params: Static<typeof retrieveParams>, ctx: MemoryToolContext) {
	const limit = params.limit ?? 10;
	// semantic defaults to true: with a client configured this is the hybrid
	// path (§9), without one `search()` returns keyword mode on its own.
	const client = params.semantic === false ? undefined : ctx.embeddings;
	const { items, mode } = await search(store, client, {
		queries: [params.query],
		domain: params.domain,
		domainBlocklist: store.getDomainBlocklist(),
		isVisible: ctx.isVisible,
		topK: limit,
		// Explicit search: rank everything, no injection-grade score floor —
		// but keyword mode STILL demands a real FTS/keyword hit (pruned by the
		// FTS candidate set + `requireKeywordHit` default), so a glossary-only
		// proper noun still recalls while pure importance/recency noise never
		// surfaces (§5.9).
		minScore: 0,
		keywordMinScore: 0,
		nowDays: toEpochDays(store.getWorldTime() ?? new Date().toISOString()) ?? 0,
	});

	// One-hop edge diffusion (§5.5): related nodes append after the direct
	// hits, in hit order. Diffusion never consumes the direct-hit limit but
	// the total is still capped at `limit`.
	const direct = items.slice(0, limit);
	const related: Array<{ node_id: string; via_edge: true; kind: string | null; from_uri: string }> = [];
	const seen = new Set(direct.map((i) => i.node_id));
	for (const item of direct) {
		if (related.length + direct.length >= limit) break;
		for (const edge of store.listRelated(item.node_id)) {
			if (related.length + direct.length >= limit) break;
			const neighbor =
				edge.direction === "outgoing" ? store.resolveUri(edge.target_uri) : store.getNode(edge.node_id);
			if (!neighbor || neighbor.is_stub || seen.has(neighbor.node_id)) continue;
			if (ctx.isVisible && !ctx.isVisible(neighbor)) continue;
			if (store.getDomainBlocklist().includes(neighbor.domain)) continue;
			seen.add(neighbor.node_id);
			related.push({ node_id: neighbor.node_id, via_edge: true, kind: edge.kind, from_uri: item.uri });
		}
	}

	// Character explicitly retrieved — access tracking (§13).
	const hitIds = [...direct.map((i) => i.node_id), ...related.map((r) => r.node_id)];
	if (hitIds.length > 0) store.markAccessed(hitIds);
	auditRecall(store, ctx, params.query, hitIds, {
		mode,
		scores: Object.fromEntries(direct.map((i) => [i.node_id, Number(i.score.toFixed(4))])),
		related: related.map((r) => ({ node_id: r.node_id, from_uri: r.from_uri, kind: r.kind })),
	});

	if (hitIds.length === 0) return text("（无命中）");
	const lines: string[] = [];
	for (const item of direct) {
		const node = store.getNode(item.node_id);
		lines.push(node ? snippet(node, 200) : `${item.uri}: ${item.summary}`);
	}
	for (const r of related) {
		const node = store.getNode(r.node_id);
		if (node) lines.push(`  ↳ ${snippet(node, 160)}（关联：${r.from_uri}${r.kind ? `, ${r.kind}` : ""}）`);
	}
	return withDetails(lines.join("\n"), {
		node_ids: hitIds,
		mode,
		semantic: mode === "vector",
	});
}

// ── memorize ───────────────────────────────────────────────────────────────

const memorizeParams = Type.Object({
	uri: Type.String({ description: "记忆 URI，如 core://identity 或 history://scenes/xxx" }),
	content: Type.String({ description: "记忆的具体内容" }),
	parent_uri: Type.Optional(Type.String({ description: "父节点 URI（可选）；父链不存在时自动补占位父节点" })),
	importance: Type.Optional(Type.Number({ description: "重要性 10=最重要，5=普通，0=边角料（数值越大越重要）" })),
	when: Type.Optional(Type.String({ description: "想起条件（外部信号/情境，如「当对方…」）" })),
	time: Type.Optional(Type.String({ description: "世界时间 YYYY-MM-DD 或相对位移如 -1d；缺省用当前世界时间" })),
});

async function executeMemorize(store: MemoryStore, params: Static<typeof memorizeParams>, ctx: MemoryToolContext) {
	const existing = store.resolveUri(params.uri);
	// Stub targets are demand-promoted in place (memorize fills the ancestor's
	// real content); only a live non-stub node is "already exists" (§5 fix).
	if (existing && !existing.is_stub) {
		return text(`URI 已存在：${params.uri}（改写请用 revise）`);
	}
	const node = store.put({
		uri: params.uri,
		content: params.content,
		parent_uri: params.parent_uri ?? null,
		disclosure: params.when ?? null,
		importance: params.importance ?? 5,
		source: "manual",
		model: ctx.modelId ?? null,
		anchor_entry_id: ctx.leafId ?? null,
		anchor_session_id: ctx.sessionId ?? null,
		world_ts: stampWorldTs(store, params.time),
	});
	return withDetails(`已记下：${nodeRow(node)}`, { node_id: node.node_id });
}

// ── revise ─────────────────────────────────────────────────────────────────

const reviseModSchema = Type.Object({
	uri: Type.String({ description: "要修改的记忆 URI" }),
	old_text: Type.Optional(Type.String({ description: "[替换] 要改掉的原文（须在内容中唯一）" })),
	new_text: Type.Optional(Type.String({ description: "[替换] 改成什么" })),
	append: Type.Optional(Type.String({ description: "[追加] 追加到末尾的文字" })),
	line: Type.Optional(Type.Number({ description: "[行编辑] 行号（从 1 开始）" })),
	line_content: Type.Optional(Type.String({ description: "[行编辑] 该行新内容" })),
	importance: Type.Optional(Type.Number({ description: "修改重要性" })),
	when: Type.Optional(Type.String({ description: "修改想起条件" })),
	time: Type.Optional(Type.String({ description: '修改世界时间；传 "" 清除' })),
});

const reviseParams = Type.Object({
	action: Type.Optional(
		Type.Unsafe<"edit" | "history" | "restore">({
			type: "string",
			enum: ["edit", "history", "restore"],
			description:
				"edit（默认）= 修改内容/元数据；history = 查看修订史（不传 uri 时列出可恢复的已删记忆）；restore = 从修订史恢复指定版本或已删记忆",
		}),
	),
	uri: Type.Optional(Type.String({ description: "单条模式：要修改的记忆 URI" })),
	version: Type.Optional(Type.Number({ description: "restore 时指定版本（活节点必传；已删节点缺省恢复最新版）" })),
	old_text: Type.Optional(Type.String({ description: "[替换] 要改掉的原文" })),
	new_text: Type.Optional(Type.String({ description: "[替换] 改成什么" })),
	append: Type.Optional(Type.String({ description: "[追加] 追加到末尾的文字" })),
	line: Type.Optional(Type.Number({ description: "[行编辑] 行号（从 1 开始）" })),
	line_content: Type.Optional(Type.String({ description: "[行编辑] 该行新内容" })),
	importance: Type.Optional(Type.Number({ description: "修改重要性" })),
	when: Type.Optional(Type.String({ description: "修改想起条件" })),
	time: Type.Optional(Type.String({ description: '修改世界时间；传 "" 清除' })),
	batch: Type.Optional(Type.Array(reviseModSchema, { description: "批量模式：每条 {uri, ...修改}" })),
});

function applyReviseMod(
	store: MemoryStore,
	mod: {
		uri: string;
		old_text?: string;
		new_text?: string;
		append?: string;
		line?: number;
		line_content?: string;
		importance?: number;
		when?: string;
		time?: string;
	},
	editorModel: string | null,
): string {
	const node = store.resolveUri(mod.uri);
	if (!node) return `未找到：${mod.uri}`;
	let content = node.content;
	if (mod.old_text !== undefined) {
		if (!content.includes(mod.old_text)) return `${mod.uri}：old_text 不在当前内容中`;
		if (mod.new_text === undefined) return `${mod.uri}：old_text 需要配 new_text`;
		const first = content.indexOf(mod.old_text);
		if (content.indexOf(mod.old_text, first + 1) !== -1) return `${mod.uri}：old_text 不唯一，请加长`;
		content = content.replace(mod.old_text, mod.new_text);
	}
	if (mod.append !== undefined) {
		content = content ? `${content}\n${mod.append}` : mod.append;
	}
	if (mod.line !== undefined) {
		const lines = content.split("\n");
		if (mod.line < 1 || mod.line > lines.length) return `${mod.uri}：行号越界（共 ${lines.length} 行）`;
		lines[mod.line - 1] = mod.line_content ?? "";
		content = lines.join("\n");
	}
	const worldTs = mod.time === "" ? null : (parseWorldTime(store, mod.time) ?? node.world_ts);
	// Stub with a body edit is promoted in place by _updateNode; editor_source
	// completes the custody chain (§6, §25 fix).
	store.updateNode(node.node_id, {
		...(mod.old_text !== undefined || mod.append !== undefined || mod.line !== undefined ? { content } : {}),
		importance: mod.importance,
		disclosure: mod.when,
		world_ts: mod.time !== undefined ? worldTs : undefined,
		editor_source:
			mod.old_text !== undefined || mod.append !== undefined || mod.line !== undefined ? "manual" : undefined,
		editor_model: editorModel,
	});
	return `已修订：${mod.uri}`;
}

async function executeRevise(store: MemoryStore, params: Static<typeof reviseParams>, ctx: MemoryToolContext) {
	const action = params.action ?? "edit";
	if (action !== "edit") {
		// history / restore: no batch, no edit fields.
		if (params.batch) return text("history/restore 不支持 batch");
		const editFields = [
			params.old_text,
			params.new_text,
			params.append,
			params.line,
			params.line_content,
			params.importance,
			params.when,
			params.time,
		];
		if (editFields.some((f) => f !== undefined)) return text("history/restore 不接受编辑字段");
		if (action === "history") {
			if (!params.uri) {
				// Deleted-uri recovery list (§13 read path for #6).
				const deleted = store.listDeletedUris();
				if (deleted.length === 0) return text("（没有可恢复的已删记忆）");
				return withDetails(
					[
						"可恢复的已删记忆：",
						...deleted.map((d) => `- ${d.uri}（${d.versions} 个版本，最后 ${d.last_seen.slice(0, 10)}）`),
						"用 revise(action='restore', uri='<uri>') 恢复。",
					].join("\n"),
					{ deleted: deleted.map((d) => d.uri) },
				);
			}
			const alive = store.resolveUri(params.uri);
			if (alive) {
				const revs = store.listRevisions(alive.node_id);
				if (revs.length === 0) return text(`该记忆尚无修订历史：${params.uri}`);
				// archiveRevision stores the pre-edit body, so every archived row
				// is an older version; the live node content is the current one.
				const lines = revs.map((r) => `v${r.version} @ ${r.created_at.slice(0, 16)}\n  ${r.content}`);
				lines.push(`current @ ${alive.updated_ts.slice(0, 16)}\n  ${alive.content}`);
				return withDetails(lines.join("\n---\n"), {
					node_id: alive.node_id,
					current: `${alive.uri}\n  ${alive.content}`,
				});
			}
			const chain = store.listRevisionsByUri(params.uri);
			if (chain.length === 0) return text(`未找到修订史：${params.uri}`);
			return withDetails(
				chain
					.map(
						(r) =>
							`v${r.version}${r.alive ? "（已还原）" : "（已删除）"} @ ${r.created_at.slice(0, 16)}\n  ${r.content}`,
					)
					.join("\n---\n"),
				{ node_id: chain[0]?.node_id },
			);
		}
		// restore
		if (!params.uri) return text("restore 需要 uri");
		const alive = store.resolveUri(params.uri);
		if (alive) {
			if (params.version === undefined) return text("活节点 restore 必须指定 version");
			if (!Number.isInteger(params.version) || params.version < 1) return text(`无效版本：${params.version}`);
			try {
				store.restoreRevision(alive.node_id, params.version);
			} catch (error) {
				return text(error instanceof Error ? error.message : String(error));
			}
			return withDetails(`已恢复 v${params.version}：${alive.uri}`, {
				node_id: alive.node_id,
				version: params.version,
			});
		}
		try {
			const node = store.restoreDeleted(params.uri, params.version);
			return withDetails(`已从修订史恢复：${node.uri}`, { node_id: node.node_id, version: params.version ?? null });
		} catch (error) {
			return text(error instanceof Error ? error.message : String(error));
		}
	}
	if (params.action !== undefined && params.action !== "edit") return text("未知 action");
	const mods = params.batch ?? [
		{
			uri: params.uri ?? "",
			old_text: params.old_text,
			new_text: params.new_text,
			append: params.append,
			line: params.line,
			line_content: params.line_content,
			importance: params.importance,
			when: params.when,
			time: params.time,
		},
	];
	const results = mods.map((m) => applyReviseMod(store, m, ctx.modelId ?? null));
	const failed = results.filter((r) => !r.startsWith("已修订"));
	return withDetails(results.join("\n"), { failed: failed.length });
}

// ── forget ─────────────────────────────────────────────────────────────────

const forgetParams = Type.Object({
	target: Type.Union([Type.String(), Type.Array(Type.String())], {
		description: "要删除的 URI（单个或列表）",
	}),
	dry_run: Type.Optional(Type.Boolean({ description: "True 只预览会级联删除哪些子节点，不执行" })),
});

function collectSubtreeUris(store: MemoryStore, uri: string): string[] {
	const node = store.resolveUri(uri);
	if (!node) return [];
	const uris = [node.uri];
	for (const child of store.children(node.node_id)) uris.push(...collectSubtreeUris(store, child.uri));
	return uris;
}

async function executeForget(store: MemoryStore, params: Static<typeof forgetParams>, _ctx: MemoryToolContext) {
	const targets = Array.isArray(params.target) ? params.target : [params.target];
	const previews = targets.map((uri) => ({ uri, affected: collectSubtreeUris(store, uri) }));
	const missing = previews.filter((p) => p.affected.length === 0).map((p) => p.uri);
	if (params.dry_run) {
		return withDetails(
			previews
				.map((p) =>
					p.affected.length
						? `${p.uri}（含 ${p.affected.length} 条，级联：${p.affected.join("、")}）`
						: `${p.uri}：不存在`,
				)
				.join("\n"),
			{ missing },
		);
	}
	let deleted = 0;
	for (const p of previews) {
		const node = store.resolveUri(p.uri);
		if (!node) continue;
		deleted += store.deleteCascade(node.node_id);
	}
	return withDetails(
		`已删除 ${deleted} 条记忆${missing.length ? `（未找到：${missing.join("、")}）` : ""}；修订史已保留，可用 revise(action="history") 查看并用 revise(action="restore") 找回。`,
		{ deleted, missing },
	);
}

// ── relocate ───────────────────────────────────────────────────────────────

const relocateParams = Type.Object({
	uri: Type.Optional(Type.String({ description: "单条模式：要移动的记忆 URI" })),
	to: Type.Optional(Type.String({ description: "目标位置完整 URI（可跨域、可改名）" })),
	batch: Type.Optional(
		Type.Array(
			Type.Object({ from: Type.String({ description: "从哪里" }), to: Type.String({ description: "到哪里" }) }),
			{ description: "批量模式：移动清单" },
		),
	),
	dry_run: Type.Optional(Type.Boolean({ description: "True 只预览不执行" })),
});

async function executeRelocate(store: MemoryStore, params: Static<typeof relocateParams>, _ctx: MemoryToolContext) {
	const moves = params.batch ?? (params.uri && params.to ? [{ from: params.uri, to: params.to }] : []);
	if (moves.length === 0) return text("需要 uri + to 或 batch");
	const previews = moves.map((m) => ({
		...m,
		exists: store.resolveUri(m.from) !== null,
		conflict: store.resolveUri(m.to) !== null,
	}));
	if (params.dry_run) {
		return withDetails(
			previews
				.map((p) => `${p.from} → ${p.to}${p.exists ? "" : "（源不存在）"}${p.conflict ? "（目标已占用）" : ""}`)
				.join("\n"),
			{ previews },
		);
	}
	// One atomic call: any conflict aborts the whole batch with zero changes
	// (§7/§8 — subtree moves, reparenting, alias preservation).
	try {
		store.relocateMany(moves);
	} catch (error) {
		return text(error instanceof Error ? error.message : String(error));
	}
	return withDetails(moves.map((m) => `已移动：${m.from} → ${m.to}`).join("\n"), { moved: moves.length });
}

// ── associate ──────────────────────────────────────────────────────────────

const associateParams = Type.Object({
	target_uri: Type.String({ description: "已有的目标记忆 URI" }),
	new_uri: Type.Optional(Type.String({ description: "别名模式：新入口放哪（与 related_uri 互斥）" })),
	related_uri: Type.Optional(Type.String({ description: "边模式：建立联想关系的另一端 URI（与 new_uri 互斥）" })),
	kind: Type.Optional(Type.String({ description: "边模式：联想类型，如 前后续/因果/同场景" })),
	importance: Type.Optional(Type.Number({ description: "从这个入口想起的重要性" })),
	when: Type.Optional(Type.String({ description: "从这入口什么时候会想起来" })),
});

async function executeAssociate(store: MemoryStore, params: Static<typeof associateParams>, _ctx: MemoryToolContext) {
	const node = store.resolveUri(params.target_uri);
	if (!node) return text(`未找到：${params.target_uri}`);
	const hasAlias = params.new_uri !== undefined;
	const hasEdge = params.related_uri !== undefined;
	if (hasAlias === hasEdge) {
		return text("associate 需要且仅需要 new_uri（别名模式）或 related_uri（边模式）之一");
	}
	if (hasEdge) {
		const related = store.resolveUri(params.related_uri as string);
		if (!related) return text(`未找到：${params.related_uri}`);
		if (related.node_id === node.node_id) return text("不能自关联");
		// Duplicate edges are idempotent — kind overwritten.
		store.addEdge(node.node_id, related.uri, params.kind);
		return withDetails(`已建立联想：${node.uri} --${params.kind ?? ""}-> ${related.uri}`, {
			node_id: node.node_id,
			related_node_id: related.node_id,
		});
	}
	if (store.resolveUri(params.new_uri as string)) return text(`新入口已存在：${params.new_uri}`);
	store.addAlias(params.new_uri as string, node.node_id);
	return withDetails(`已关联：${params.new_uri} → ${params.target_uri}`, { node_id: node.node_id });
}

// ── trigger ────────────────────────────────────────────────────────────────

const triggerParams = Type.Object({
	uri: Type.String({ description: "要贴标签的记忆 URI" }),
	add: Type.Optional(Type.Array(Type.String(), { description: "要加的触发词列表" })),
	remove: Type.Optional(Type.Array(Type.String(), { description: "要删的触发词列表" })),
});

async function executeTrigger(store: MemoryStore, params: Static<typeof triggerParams>, _ctx: MemoryToolContext) {
	const node = store.resolveUri(params.uri);
	if (!node) return text(`未找到：${params.uri}`);
	for (const kw of params.add ?? []) store.addGlossaryEntry(kw, node.node_id);
	for (const kw of params.remove ?? []) store.removeGlossaryEntry(kw);
	return withDetails(
		`触发词已更新：+${(params.add ?? []).join("、") || "无"} -${(params.remove ?? []).join("、") || "无"}`,
		{ keywords: store.listGlossary(node.node_id).map((e) => e.keyword) },
	);
}

// ── consolidate ────────────────────────────────────────────────────────────

const consolidateParams = Type.Object({
	resolution: Type.Unsafe<"group" | "merge" | "link" | "keep">({
		type: "string",
		enum: ["group", "merge", "link", "keep"],
		description:
			"处理策略：group=建主题摘要并把源记忆移到主题下；merge=多条内容合并成一条新记忆（删源）；link=建主题入口保留原位；keep=只建主题不动源记忆",
	}),
	target_uri: Type.String({ description: "主题/合并结果放在哪" }),
	source_uris: Type.Array(Type.String(), { description: "相关源记忆 URI 列表（至少 2 条）" }),
	content: Type.String({ description: "主题总结 / 合并后的完整内容" }),
	importance: Type.Optional(Type.Number({ description: "主题重要性" })),
	when: Type.Optional(Type.String({ description: "什么时候想到这主题" })),
});

async function executeConsolidate(
	store: MemoryStore,
	params: Static<typeof consolidateParams>,
	ctx: MemoryToolContext,
) {
	const sources = params.source_uris.map((uri) => ({ uri, node: store.resolveUri(uri) }));
	const missing = sources.filter((s) => !s.node).map((s) => s.uri);
	if (missing.length) return text(`未找到：${missing.join("、")}`);

	const resolution = params.resolution;
	if (resolution === "merge") {
		for (const s of sources) store.deleteCascade((s.node as MemoryNode).node_id);
		const merged = store.put({
			uri: params.target_uri,
			content: params.content,
			importance: params.importance ?? 5,
			disclosure: params.when ?? null,
			source: "manual",
			model: ctx.modelId ?? null,
			anchor_entry_id: ctx.leafId ?? null,
		});
		return withDetails(`已合并 ${sources.length} 条 → ${merged.uri}`, { node_id: merged.node_id });
	}

	if (resolution === "group") {
		// Preflight BEFORE creating the theme or moving anything (§8):
		// duplicate leaf names, occupied targets, target inside a source
		// subtree, ancestor-overlapping sources — all abort with zero changes.
		const leafName = (uri: string): string => {
			const parts = uri.split("://");
			const segs = (parts[parts.length - 1] ?? "").split("/");
			return segs[segs.length - 1] ?? uri;
		};
		const names = new Set<string>();
		for (const s of sources) {
			const name = leafName(s.uri);
			if (names.has(name)) return text(`group 冲突：源末段重复「${name}」（${s.uri}）`);
			names.add(name);
		}
		const planned = sources.map((s) => ({
			...s,
			to: `${params.target_uri.replace(/\/$/, "")}/${leafName(s.uri)}`,
		}));
		for (const p of planned) {
			const occupied = store.resolveUri(p.to);
			if (occupied) return text(`group 冲突：目标已占用 ${p.to}`);
			const src = p.node as MemoryNode;
			if (p.to.startsWith(`${src.uri}/`) || p.to === src.uri) {
				return text(`group 冲突：目标 ${p.to} 位于源 ${src.uri} 子树内`);
			}
		}
		for (let i = 0; i < sources.length; i++) {
			for (let j = i + 1; j < sources.length; j++) {
				const a = sources[i].node as MemoryNode;
				const b = sources[j].node as MemoryNode;
				if (a.uri === b.uri) return text(`group 冲突：源重复 ${a.uri}`);
				if (b.uri.startsWith(`${a.uri}/`) || a.uri.startsWith(`${b.uri}/`)) {
					return text(`group 冲突：源互为祖先（${a.uri} / ${b.uri}）`);
				}
			}
		}
		// Theme creation AND the subtree move share one transaction: a conflict
		// the preflight missed (relocate re-checks occupancy/self-nesting
		// atomically) rolls the theme back too, so no orphan theme is left.
		const theme = store.consolidateGroup(
			{
				uri: params.target_uri,
				content: params.content,
				importance: params.importance ?? 5,
				disclosure: params.when ?? null,
				source: "manual",
				model: ctx.modelId ?? null,
				anchor_entry_id: ctx.leafId ?? null,
			},
			planned.map((p) => ({ from: p.uri, to: p.to })),
		);
		return withDetails(`已整理 ${sources.length} 条 → ${theme.uri}（group）`, { node_id: theme.node_id });
	}

	// link / keep: create the theme node, then arrange sources.
	const theme = store.put({
		uri: params.target_uri,
		content: params.content,
		importance: params.importance ?? 5,
		disclosure: params.when ?? null,
		source: "manual",
		model: ctx.modelId ?? null,
		anchor_entry_id: ctx.leafId ?? null,
	});
	for (const s of sources) {
		const src = s.node as MemoryNode;
		if (resolution === "link") {
			store.addAlias(src.uri, theme.node_id);
		}
		// keep: leave sources untouched.
	}
	return withDetails(`已整理 ${sources.length} 条 → ${theme.uri}（${resolution}）`, { node_id: theme.node_id });
}

// ── retrace ────────────────────────────────────────────────────────────────

const retraceParams = Type.Object({
	raw_id: Type.Optional(Type.Number({ description: "单条模式：原文日志 ID" })),
	first_raw_id: Type.Optional(Type.Number({ description: "区间模式：起始 raw_id（含）" })),
	last_raw_id: Type.Optional(Type.Number({ description: "区间模式：结束 raw_id（含）" })),
	uri: Type.Optional(Type.String({ description: "纪要模式：带原文区间引用的记忆 URI" })),
	query: Type.Optional(Type.String({ description: "全文模式：在活动原文中按关键词搜索" })),
	limit: Type.Optional(Type.Number({ description: "全文模式：最多返回条数，默认 20" })),
});

async function executeRetrace(store: MemoryStore, params: Static<typeof retraceParams>, _ctx: MemoryToolContext) {
	if (params.raw_id !== undefined) {
		const rows = store.listRaw(params.raw_id);
		if (rows.length === 0) return text(`原文不存在：raw_id=${params.raw_id}`);
		const r = rows[0];
		return withDetails(`[${r.raw_id}] ${r.role}: ${r.text}`, { raw_id: r.raw_id });
	}
	if (params.first_raw_id !== undefined && params.last_raw_id !== undefined) {
		const rows = store.listRaw(params.first_raw_id, params.last_raw_id);
		if (rows.length === 0) return text("区间内无原文");
		return withDetails(rows.map((r) => `[${r.raw_id}] ${r.role}: ${r.text}`).join("\n"), { count: rows.length });
	}
	if (params.uri !== undefined) {
		const node = store.resolveUri(params.uri);
		if (!node) return text(`未找到：${params.uri}`);
		if (node.first_raw_id === null || node.last_raw_id === null) {
			return text(`该记忆没有原文区间（${params.uri}）`);
		}
		// Walk the ORIGINAL window by session scope — inactive rows remain
		// audit-trail readable (§3.2). The node's stored session filters out
		// other sessions' interleaved rows.
		const rows = store.listRaw(node.first_raw_id, node.last_raw_id, {
			sessionId: node.anchor_session_id ?? undefined,
		});
		if (rows.length === 0) return text("区间内无原文");
		return withDetails(rows.map((r) => `[${r.raw_id}] ${r.role}: ${r.text}`).join("\n"), {
			count: rows.length,
			first_raw_id: node.first_raw_id,
			last_raw_id: node.last_raw_id,
		});
	}
	if (params.query !== undefined) {
		// Active rows only — full-text search over the current transcript.
		const rows = store.searchRawFts(params.query, params.limit ?? 20);
		if (rows.length === 0) return text("（无命中原文）");
		return withDetails(rows.map((r) => `[${r.raw_id}] ${r.role}: ${r.text}`).join("\n"), {
			count: rows.length,
			raw_ids: rows.map((r) => r.raw_id),
		});
	}
	return text("需要 raw_id、first_raw_id + last_raw_id、uri 或 query");
}

// ── set_time ───────────────────────────────────────────────────────────────

const setTimeParams = Type.Object({
	time: Type.String({ description: "世界观日期（如 2026-06-05 或 ISO 时间）或相对位移（如 +1d、-2h）" }),
});

async function executeSetTime(store: MemoryStore, params: Static<typeof setTimeParams>, _ctx: MemoryToolContext) {
	const next = store.setWorldTime(params.time);
	return withDetails(`世界时间已设为 ${next}`, { world_time: next });
}

// ── awaken ─────────────────────────────────────────────────────────────────

const awakenParams = Type.Object({
	action: Type.Unsafe<"list" | "set" | "add" | "remove">({
		type: "string",
		enum: ["list", "set", "add", "remove"],
		description: "list 查看，set 完全替换，add 追加，remove 移除",
	}),
	uris: Type.Optional(Type.Array(Type.String(), { description: "set/add/remove 时操作的 URI 列表" })),
});

function getAwakenUris(store: MemoryStore): string[] {
	const raw = store.getKv(AWAKEN_URIS_KEY);
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw) as unknown;
		return Array.isArray(parsed) ? (parsed as string[]) : [];
	} catch {
		return [];
	}
}

function setAwakenUris(store: MemoryStore, uris: string[]): void {
	store.setKv(AWAKEN_URIS_KEY, JSON.stringify(uris));
}

async function executeAwaken(store: MemoryStore, params: Static<typeof awakenParams>, ctx: MemoryToolContext) {
	const current = getAwakenUris(store);
	switch (params.action) {
		case "list": {
			const lines = current.map((uri) => {
				const node = store.resolveUri(uri);
				if (!node) return `${uri}（已失效，渲染时自动剔除）`;
				if (ctx.isVisible && !ctx.isVisible(node)) return `${uri}（已隐藏，渲染时自动剔除）`;
				return snippet(node);
			});
			return withDetails(lines.join("\n") || "（醒来记忆清单为空）", { uris: current });
		}
		case "set": {
			const uris = params.uris ?? [];
			setAwakenUris(store, uris);
			return withDetails(`醒来记忆已设为 ${uris.length} 条`, { uris });
		}
		case "add": {
			const merged = [...current];
			for (const uri of params.uris ?? []) if (!merged.includes(uri)) merged.push(uri);
			setAwakenUris(store, merged);
			return withDetails(`醒来记忆现有 ${merged.length} 条`, { uris: merged });
		}
		case "remove": {
			const drop = new Set(params.uris ?? []);
			const remaining = current.filter((uri) => !drop.has(uri));
			setAwakenUris(store, remaining);
			return withDetails(`醒来记忆现有 ${remaining.length} 条`, { uris: remaining });
		}
	}
}

// ── registration ───────────────────────────────────────────────────────────

/**
 * Build the 12 memory tools bound to `store`.
 * Phase 2 passes a real MemoryToolContext per session; until then provenance
 * fields stay null and the tools are usable standalone.
 */
export function createMemoryTools(store: MemoryStore, ctx: MemoryToolContext = {}): MemoryToolDef[] {
	const defs: Array<
		Omit<MemoryToolDef, "execute"> & { run: (p: Record<string, unknown>) => Promise<MemoryToolResult> }
	> = [
		{
			name: "recall",
			label: "回想记忆",
			description:
				"回想与审视一段记忆：URI 精确寻址 + 子树展开（depth/max_nodes），精确回想会记录访问时间。系统视图：MEM://recent/<N>、MEM://index/<domain>、MEM://timeline/<domain>/<N>、MEM://forgotten/<domain>/<N>、MEM://glossary、MEM://wakeup/<N>、MEM://diagnostic/<domain>。",
			parameters: recallParams,
			run: (p) => executeRecall(store, p as Static<typeof recallParams>, ctx),
		},
		{
			name: "retrieve",
			label: "检索记忆",
			description:
				"线索检索：想不起 URI 时用关键词搜索（FTS 词法，支持触发词专名与联想边一跳扩散）；semantic=true 启用语义检索（未配置 embedding API 自动退化词法）。命中即记录访问时间。",
			parameters: retrieveParams,
			run: (p) => executeRetrieve(store, p as Static<typeof retrieveParams>, ctx),
		},
		{
			name: "memorize",
			label: "铭刻记忆",
			description:
				"记下一段新记忆。可选 parent_uri 挂到已有父节点（父链缺失自动补占位）；time 打世界时间（Events 类可传，Static 类缺省用当前世界时间）。若目标 URI 是占位节点（stub），会原地转正为真实记忆。来源/模型/回溯锚点由系统自动署名，无需手填。",
			parameters: memorizeParams,
			run: (p) => executeMemorize(store, p as Static<typeof memorizeParams>, ctx),
		},
		{
			name: "revise",
			label: "修订记忆",
			description:
				"修订记忆内容或元数据。action=history 查看修订史（不传 uri 时列出可恢复的已删记忆；已删记忆显示完整版本链）；action=restore 从修订史恢复（活节点需指定 version，已删节点缺省恢复最新版）；默认 edit：三种内容编辑三选一（替换 old_text→new_text 须唯一、追加 append、行编辑 line+line_content），也可只改 importance/when/time，批量传 batch。旧内容自动入修订史。",
			parameters: reviseParams,
			run: (p) => executeRevise(store, p as Static<typeof reviseParams>, ctx),
		},
		{
			name: "forget",
			label: "忘掉记忆",
			description:
				"忘掉记忆：target 传单个 URI 或列表。子节点级联删除；dry_run=true 先预览会牵连哪些子节点。节点行真删但修订史全部保留——误删可用 revise(action='history') 查看清单、revise(action='restore') 找回。",
			parameters: forgetParams,
			run: (p) => executeForget(store, p as Static<typeof forgetParams>, ctx),
		},
		{
			name: "relocate",
			label: "迁移记忆",
			description:
				"移动/改名记忆（兼并 move 与 rename）：单条传 uri+to，批量传 batch 列表；可跨域、整棵子树随根移动（子节点 URI 一起重写）。旧路径自动转为别名不破链；目标缺失的父链自动补占位；任一冲突整批零改动。dry_run=true 预览冲突。",
			parameters: relocateParams,
			run: (p) => executeRelocate(store, p as Static<typeof relocateParams>, ctx),
		},
		{
			name: "associate",
			label: "关联记忆",
			description:
				"建立联想通路，两种模式二选一：new_uri=给已有记忆多开一个入口（别名映射，不是复制，共享内容）；related_uri=在两段记忆之间画联想边（可选 kind 标注类型，如 前后续/因果/同场景），显式 retrieve 时沿边一跳扩散找到它。",
			parameters: associateParams,
			run: (p) => executeAssociate(store, p as Static<typeof associateParams>, ctx),
		},
		{
			name: "trigger",
			label: "埋设触发词",
			description:
				"给记忆增删触发词（glossary）。触发词作为专名进全文索引：正文没有该词的节点也能被触发词召回。查看全部触发词用 recall(uri='MEM://glossary')。",
			parameters: triggerParams,
			run: (p) => executeTrigger(store, p as Static<typeof triggerParams>, ctx),
		},
		{
			name: "consolidate",
			label: "整理记忆",
			description:
				"记忆综合与结构收敛（合并+整理合体）：resolution=merge 把多条提炼成一条并删源；group=建主题并把源记忆整棵移到主题下（真分组，children 可见）；link=建主题别名入口保留原位；keep=只建主题不动源记忆。",
			parameters: consolidateParams,
			run: (p) => executeConsolidate(store, p as Static<typeof consolidateParams>, ctx),
		},
		{
			name: "retrace",
			label: "回溯原文",
			description:
				"源头回溯：按 raw_id / first_raw_id+last_raw_id 区间 / 纪要 uri（自动取原文区间引用）/ 关键词全文搜索（活动原文）提取底层对话原文。场景纪要节点用 uri 模式直接定位其来源窗口。",
			parameters: retraceParams,
			run: (p) => executeRetrace(store, p as Static<typeof retraceParams>, ctx),
		},
		{
			name: "set_time",
			label: "推演世界时间",
			description: "世界时钟推演：设置绝对时间或按相对位移（如 +1d）推进。之后的新记忆自动关联新时间。",
			parameters: setTimeParams,
			run: (p) => executeSetTime(store, p as Static<typeof setTimeParams>, ctx),
		},
		{
			name: "awaken",
			label: "醒来记忆",
			description:
				"管理「醒来记忆」——角色醒来自动载入的常驻/工作记忆清单。action=list 查看，set 完全替换，add 追加，remove 移除。节点被删/移走/被回滚隐藏时渲染与 list 自动对账。",
			parameters: awakenParams,
			run: (p) => executeAwaken(store, p as Static<typeof awakenParams>, ctx),
		},
	];
	return defs.map((d) => ({
		name: d.name,
		label: d.label,
		description: d.description,
		promptSnippet: d.description.split("\n")[0],
		parameters: d.parameters,
		execute: async (_toolCallId: string, params: Record<string, unknown>) => d.run(params),
	}));
}

export { AWAKEN_URIS_KEY, getAwakenUris, setAwakenUris };
