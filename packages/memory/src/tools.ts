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
import { generateDiffString } from "./diff.ts";
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
import { formatRelativeWorldTime, search, toEpochDays } from "./recall.ts";
import type { MemoryNode, MemoryStore, VisibilityPredicate } from "./store.ts";

/**
 * Per-mod diff caps for `details.diffs`. Constants, not settings: audit tools
 * must be able to assume an upper bound on the persisted shape.
 */
export const MAX_DIFF_BYTES = 8192;
export const MAX_DIFF_ITEMS = 50;

/**
 * Cut a diff to `maxBytes` on a LINE boundary, marking the cut on its own line.
 *
 * Cutting mid-line would emit a line that `parseDiffLine` (components/diff.ts:9)
 * rejects, so renderDiff would paint it as anonymous grey context — a silently
 * broken diff. Bytes, not chars: a Chinese body is ~3× longer in UTF-8.
 */
function cutDiff(diff: string, maxBytes: number): string {
	const lines = diff.split("\n");
	const kept: string[] = [];
	let used = 0;
	for (const line of lines) {
		const size = Buffer.byteLength(line, "utf8") + 1;
		if (kept.length > 0 && used + size > maxBytes) break;
		kept.push(line);
		used += size;
	}
	if (kept.length >= lines.length) return diff;
	return `${kept.join("\n")}\n⇢ （已截断）`;
}

export interface MemoryToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
}

export interface MemoryToolDef {
	name: string;
	label: string;
	description: string;
	/** Extra "Guidelines:" lines for the compiled system prompt (§T22 chain). */
	promptGuidelines?: string[];
	/** TypeBox parameter schema. */
	parameters: TSchema;
	execute: (toolCallId: string, params: Record<string, unknown>) => Promise<MemoryToolResult>;
}

/**
 * Self-trigger guidance for disclosure (想起条件). Appended to the read tools
 * so the model knows a triggered condition obliges it to go read the memory.
 * Shared by recall/retrieve to keep the wording from drifting (contract §24
 * §8.7; JSON-free single source).
 */
export const MEMORY_DISCLOSURE_GUIDELINE =
	"想起条件（disclosure）是「什么时候该想起这条记忆」的标签。当对话触发了某条记忆的想起条件，" +
	"而你还不知道它的内容时，MUST 先 retrieve 或 recall 读取它再作答。";
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

/** Confirmation line: uri + world time. The body is not echoed — it already
 * travels in the tool-call arguments (and thus reaches compaction's tool-calls
 * section), so repeating it in the result is pure duplication (§16 S4). */
function nodeLine(node: MemoryNode): string {
	const time = node.world_ts ? ` @ ${node.world_ts}` : "";
	return `${node.uri}${time}`;
}

function snippet(node: MemoryNode, max = 80): string {
	const oneLine = node.content.replace(/\s+/g, " ").trim();
	return `${node.uri}: ${oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine}`;
}

/** Render one descendant node (plus recursively its children if remaining != 0) with indentation. */
function renderChildSubtree(
	store: MemoryStore,
	node: MemoryNode,
	remaining: number,
	indent: string,
	budget: { count: number },
	isVisible?: VisibilityPredicate,
): string[] {
	if (budget.count <= 0) {
		return [`${indent}■ ${node.uri} (内容省略：已达 max_nodes 上限)`];
	}
	budget.count--;
	const pad = `${indent}  `;
	const out: string[] = [`${indent}■ ${node.uri}`];
	const disc = store.effectiveDisclosure(node.uri);
	if (disc) {
		out.push(`${pad}(想起条件: ${disc})`);
	}
	for (const line of node.content.split("\n")) {
		out.push(`${pad}${line}`);
	}
	if (remaining !== 0) {
		const kids = store.children(node.node_id).filter((c) => !c.is_stub && (isVisible ? isVisible(c) : true));
		for (const kid of kids) {
			const sub = renderChildSubtree(store, kid, remaining > 0 ? remaining - 1 : -1, pad, budget, isVisible);
			out.push("", ...sub);
		}
	}
	return out;
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

/**
 * Parse the segments after a `MEM://<view>` prefix into a `{ domain, limit }`
 * pair. `uri.split("/")` yields `["MEM:", "", "<view>", ...]`, so the segments
 * MUST be read past the view name, not at a fixed index.
 *
 * Ambiguity rule: a purely numeric segment (min 1) is the limit; the first
 * non-numeric segment is the domain. Views that ignore the domain (timeline,
 * recent, wakeup) simply drop what comes back.
 */
function parseViewSegments(uri: string, view: string, fallbackLimit: number): { domain?: string; limit: number } {
	const rest = uri.slice(`MEM://${view}`.length); // "" or "/<seg>/<seg>..."
	let domain: string | undefined;
	let limit = fallbackLimit;
	for (const seg of rest.split("/")) {
		if (seg === "") continue;
		if (/^\d+$/.test(seg)) {
			const raw = Number(seg);
			if (Number.isInteger(raw) && raw >= 1) limit = raw;
		} else if (domain === undefined) {
			domain = seg;
		}
	}
	return { domain, limit };
}

async function executeRecall(
	store: MemoryStore,
	params: Static<typeof recallParams>,
	ctx: MemoryToolContext,
): Promise<MemoryToolResult> {
	const { uri, depth, max_nodes: maxNodes } = params;
	// System views never touch access times — browsing is not "想起" (§13/§5.6).
	if (uri === "MEM://recent" || uri.startsWith("MEM://recent/")) {
		const { limit: n } = parseViewSegments(uri, "recent", 10);
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
		const { limit: n } = parseViewSegments(uri, "wakeup", 5);
		auditRecall(store, ctx, uri, [], { view: "wakeup" });
		return text(renderWakeupView(store, getAwakenUris(store), n, ctx.isVisible));
	}
	if (uri === "MEM://timeline" || uri.startsWith("MEM://timeline/")) {
		// Data source is raw_log (message-level, §15.4): the domain segment is
		// accepted for uri compatibility but raw_log is domain-agnostic.
		const { limit: n } = parseViewSegments(uri, "timeline", 20);
		auditRecall(store, ctx, uri, [], { view: "timeline" });
		return text(renderTimelineView(store, n));
	}
	if (uri === "MEM://forgotten" || uri.startsWith("MEM://forgotten/")) {
		// A numeric segment is the limit (MEM://forgotten/<N>); the first
		// non-numeric one is the domain (MEM://forgotten/<domain>[/<N>]).
		const { domain, limit: n } = parseViewSegments(uri, "forgotten", 5);
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

	const lines: string[] = [`# [${node.uri}]`];
	const currWorldTime = store.getWorldTime();
	if (node.world_ts) {
		const rel = formatRelativeWorldTime(node.world_ts, currWorldTime);
		lines.push(rel ? `> (发生于: ${node.world_ts}，${rel})` : `> (发生于: ${node.world_ts})`);
	}
	const nodeDisc = store.effectiveDisclosure(uri);
	if (nodeDisc) {
		lines.push(`> (想起条件: ${nodeDisc})`);
	}
	const nodeKeywords = store.listGlossary(node.node_id).map((g) => g.keyword);
	if (nodeKeywords.length > 0) {
		lines.push(`> (标签: ${nodeKeywords.join(", ")})`);
	}
	lines.push("", "---", "", node.content, "");

	// Related associations via glossary in content or explicit edges
	const uriToKeywords = new Map<string, string[]>();
	const allGlossary = store.listGlossary();
	for (const g of allGlossary) {
		if (g.node_id === node.node_id) continue;
		if (node.content.includes(g.keyword)) {
			const target = store.getNode(g.node_id);
			if (target && !target.is_stub && (ctx.isVisible ? ctx.isVisible(target) : true)) {
				const list = uriToKeywords.get(target.uri) ?? [];
				if (!list.includes(g.keyword)) list.push(g.keyword);
				uriToKeywords.set(target.uri, list);
			}
		}
	}
	for (const edge of store.listRelated(node.node_id)) {
		const targetUri = edge.direction === "outgoing" ? edge.target_uri : store.getNode(edge.node_id)?.uri;
		if (targetUri) {
			const target = store.resolveUri(targetUri);
			if (target && !target.is_stub && (ctx.isVisible ? ctx.isVisible(target) : true)) {
				const list = uriToKeywords.get(target.uri) ?? [];
				if (edge.kind && !list.includes(edge.kind)) list.push(edge.kind);
				uriToKeywords.set(target.uri, list);
			}
		}
	}
	if (uriToKeywords.size > 0) {
		lines.push("---", "相关联想:");
		for (const [targetUri, kws] of uriToKeywords.entries()) {
			const kwStr = kws.map((k) => `@${k}`).join(", ");
			lines.push(`- ${kwStr} -> ${targetUri}`);
		}
		lines.push("");
	}

	const children = store.children(node.node_id).filter((c) => !c.is_stub && (ctx.isVisible ? ctx.isVisible(c) : true));
	if (children.length > 0) {
		const d = depth ?? 0;
		if (d !== 0) {
			const budget = { count: maxNodes ?? 200 };
			for (const child of children) {
				const childLines = renderChildSubtree(store, child, d > 0 ? d - 1 : -1, "", budget, ctx.isVisible);
				lines.push("", ...childLines);
			}
		} else {
			lines.push("---", "更深层的记忆:", "");
			for (const child of children) {
				const childDisc = store.effectiveDisclosure(child.uri);
				lines.push(childDisc ? `- ${child.uri} (${childDisc})` : `- ${child.uri}`);
			}
		}
	}

	const nodeIds = collectSubtreeIds(store, node);
	// Explicitly recalled: the character is "thinking of" this subtree — the
	// access time is the sleep metric for forgotten/diagnostic (§13).
	store.markAccessed(nodeIds);
	auditRecall(store, ctx, uri, nodeIds, { depth: depth ?? 0 });
	return withDetails(lines.join("\n").trimEnd(), { node_id: node.node_id });
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
	const related: Array<{
		node_id: string;
		via_edge: true;
		kind: string | null;
		from_uri: string;
		disclosure: string | null;
	}> = [];
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
			related.push({
				node_id: neighbor.node_id,
				via_edge: true,
				kind: edge.kind,
				from_uri: item.uri,
				disclosure: edge.disclosure,
			});
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

	if (hitIds.length === 0) {
		const scope = params.domain ? `在 ${params.domain} ` : "所有域名";
		return text(`${scope}里没有找到和「${params.query}」相关的记忆。`);
	}
	const lines: string[] = [`找到了 ${direct.length} 条和「${params.query}」相关的记忆：`, ""];
	for (const item of direct) {
		const node = store.getNode(item.node_id);
		if (!node) continue;
		lines.push(`- ${node.uri}`);
		lines.push(`  重要性：${node.importance}`);
		const disc = store.effectiveDisclosure(node.uri);
		if (disc) {
			lines.push(`  想起条件：${disc}`);
		}
		const rawContent = (node.content || "").replace(/\s+/g, " ").trim();
		// Hit-anchored excerpt from the shared scorer — the passage that
		// matched, not a fixed head — falling back to the head summary when
		// nothing locatable matched. Kept in sync with item.excerpt length.
		const snip = item.excerpt || (rawContent.length > 200 ? `${rawContent.slice(0, 200)}…` : rawContent);
		lines.push(`  ${snip}`);
		lines.push("");
	}
	for (const r of related) {
		const node = store.getNode(r.node_id);
		if (!node) continue;
		lines.push(`  ↳ ${node.uri}（关联：${r.from_uri}${r.kind ? `, ${r.kind}` : ""}）`);
		lines.push(`    重要性：${node.importance}`);
		// The hop's own edge condition wins; the node-level entry is only the
		// fallback (contract §24 §8.4 — flat here would hide every edge `when`).
		const edgeDisc = r.disclosure ?? store.effectiveDisclosure(node.uri);
		if (edgeDisc) {
			lines.push(`    想起条件：${edgeDisc}`);
		}
		const rawContent = (node.content || "").replace(/\s+/g, " ").trim();
		const snip = rawContent.length > 160 ? `${rawContent.slice(0, 160)}…` : rawContent;
		lines.push(`    ${snip}`);
		lines.push("");
	}
	return withDetails(lines.join("\n").trimEnd(), {
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
	when: Type.Optional(Type.String({ description: "这条记忆（规范入口）自身的想起条件" })),
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
		// `""` = "我没填" → clear; `undefined` and `null` are equivalent for a
		// brand-new node. MUST NOT write `params.when ?? null` — `""` is not
		// nullish, so it would persist a literal empty string (P1-1).
		disclosure: params.when === "" ? null : params.when,
		importance: params.importance ?? 5,
		source: "manual",
		model: ctx.modelId ?? null,
		anchor_entry_id: ctx.leafId ?? null,
		anchor_session_id: ctx.sessionId ?? null,
		world_ts: stampWorldTs(store, params.time),
	});
	return withDetails(`已记下：${nodeLine(node)}`, { node_id: node.node_id, uri: node.uri, ok: true });
}

// ── revise ─────────────────────────────────────────────────────────────────

const reviseModSchema = Type.Object({
	uri: Type.String({ description: "要修改的记忆 URI" }),
	content: Type.Optional(Type.String({ description: "[整条重写] 用全文替换整条正文（不能与替换/追加/行编辑混用）" })),
	old_text: Type.Optional(Type.String({ description: "[替换] 要改掉的原文（须在内容中唯一）" })),
	new_text: Type.Optional(Type.String({ description: "[替换] 改成什么（须配 old_text）" })),
	append: Type.Optional(Type.String({ description: "[追加] 追加到末尾的文字" })),
	line: Type.Optional(Type.Number({ description: "[行编辑] 行号（从 1 开始）" })),
	line_content: Type.Optional(Type.String({ description: "[行编辑] 该行新内容（须配 line）" })),
	importance: Type.Optional(Type.Number({ description: "修改重要性" })),
	when: Type.Optional(
		Type.String({
			description:
				"改想起条件（写法同 memorize.when：预演未来的触发话头，不是内容复述）；URI 命中别名入口→改该入口；否则改节点自身",
		}),
	),
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
	new_text: Type.Optional(Type.String({ description: "[替换] 改成什么（须配 old_text）" })),
	content: Type.Optional(Type.String({ description: "[整条重写] 用全文替换整条正文（不能与替换/追加/行编辑混用）" })),
	append: Type.Optional(Type.String({ description: "[追加] 追加到末尾的文字" })),
	line: Type.Optional(Type.Number({ description: "[行编辑] 行号（从 1 开始）" })),
	line_content: Type.Optional(Type.String({ description: "[行编辑] 该行新内容（须配 line）" })),
	importance: Type.Optional(Type.Number({ description: "修改重要性" })),
	when: Type.Optional(
		Type.String({
			description:
				"改想起条件（写法同 memorize.when：预演未来的触发话头，不是内容复述）；URI 命中别名入口→改该入口；否则改节点自身",
		}),
	),
	time: Type.Optional(Type.String({ description: '修改世界时间；传 "" 清除' })),
	batch: Type.Optional(Type.Array(reviseModSchema, { description: "批量模式：每条 {uri, ...修改}" })),
});

/** One revise mod's outcome; `text` is the model-facing line, `ok` the machine signal. */
export interface ReviseModOutcome {
	ok: boolean;
	uri: string;
	text: string;
	/** Pre-edit body, captured only when a body edit was applied (Path A diff input). */
	beforeContent?: string;
	/** Pre-edit effective disclosure, captured only when `mod.when !== undefined`. */
	beforeDisclosure?: string | null;
}

/**
 * Apply one mod's body edit — replace / append / line — to `content`.
 *
 * Exported so the render path (Path B preview) and the authoritative write
 * share ONE rule set; a preview computed differently from this would be a
 * fake diff. Errors carry the bare reason: the caller owns the `uri：` prefix,
 * or the uri would appear twice.
 */
export function computeRevisedContent(
	content: string,
	mod: {
		content?: string;
		old_text?: string;
		new_text?: string;
		append?: string;
		line?: number;
		line_content?: string;
	},
): { ok: true; content: string } | { ok: false; error: string } {
	// Full-body rewrite: explicit whole-content overwrite, mutually exclusive
	// with the incremental edits (same semantics as the web editor's content
	// field). Empty body is a delete, not a write — point at forget.
	if (mod.content !== undefined) {
		const incremental =
			mod.old_text !== undefined ||
			mod.new_text !== undefined ||
			mod.append !== undefined ||
			mod.line !== undefined ||
			mod.line_content !== undefined;
		if (incremental) return { ok: false, error: "content 整条重写不能与替换/追加/行编辑混用" };
		if (mod.content === "") return { ok: false, error: "正文不能为空；要删整条记忆用 forget" };
		return { ok: true, content: mod.content };
	}
	// Orphan edit fields are rejected here so the ONE body-edit rule set also
	// guards the preview path — a preview can never show a change the write
	// would refuse (T14). Errors carry the bare reason; the caller owns the
	// `uri：` prefix.
	if (mod.new_text !== undefined && mod.old_text === undefined) {
		return { ok: false, error: "new_text 需要与 old_text 配对（替换模式）；只追加用 append；整条重写用 content" };
	}
	if (mod.line_content !== undefined && mod.line === undefined) {
		return { ok: false, error: "line_content 需要与 line 配对（行编辑模式）" };
	}
	let next = content;
	if (mod.old_text !== undefined) {
		if (!next.includes(mod.old_text)) return { ok: false, error: "old_text 不在当前内容中" };
		if (mod.new_text === undefined) return { ok: false, error: "old_text 需要配 new_text" };
		const first = next.indexOf(mod.old_text);
		if (next.indexOf(mod.old_text, first + 1) !== -1) return { ok: false, error: "old_text 不唯一，请加长" };
		next = next.replace(mod.old_text, mod.new_text);
	}
	if (mod.append !== undefined) {
		next = next ? `${next}\n${mod.append}` : mod.append;
	}
	if (mod.line !== undefined) {
		const lines = next.split("\n");
		if (mod.line < 1 || mod.line > lines.length) {
			return { ok: false, error: `行号越界（共 ${lines.length} 行）` };
		}
		lines[mod.line - 1] = mod.line_content ?? "";
		next = lines.join("\n");
	}
	return { ok: true, content: next };
}

function applyReviseMod(
	store: MemoryStore,
	mod: {
		uri: string;
		content?: string;
		old_text?: string;
		new_text?: string;
		append?: string;
		line?: number;
		line_content?: string;
		importance?: number;
		when?: string;
		time?: string;
	},
	ctx: MemoryToolContext,
): ReviseModOutcome {
	const node = store.resolveUri(mod.uri);
	if (!node) return { ok: false, uri: mod.uri, text: `未找到：${mod.uri}` };
	// §8 v4: revisions carry the write's branch position, so a revise can be
	// rolled back with the branch that wrote it. Un-anchored ctx → undefined
	// → the change stays global (pre-v4 semantics).
	const provenance =
		ctx.leafId && ctx.sessionId ? { anchor_entry_id: ctx.leafId, anchor_session_id: ctx.sessionId } : undefined;
	// One predicate for "a body edit happened", shared by the diff snapshot and
	// the update below — splitting them yields diffs for edits that never land.
	// Orphan fields (new_text without old_text, line_content without line) count
	// as touched so they reach computeRevisedContent and fail THERE instead of
	// silently no-oping while reporting success (2026-09-21 mochi incident:
	// revise { uri, new_text } returned 已修订 with the body untouched).
	const touchedBody =
		mod.content !== undefined ||
		mod.old_text !== undefined ||
		mod.new_text !== undefined ||
		mod.append !== undefined ||
		mod.line !== undefined ||
		mod.line_content !== undefined;
	if (!touchedBody && mod.importance === undefined && mod.when === undefined && mod.time === undefined) {
		return { ok: false, uri: mod.uri, text: `${mod.uri}：没有指定任何修改` };
	}
	const beforeContent = touchedBody ? node.content : undefined;
	let content = node.content;
	if (touchedBody) {
		const edited = computeRevisedContent(content, mod);
		if (!edited.ok) return { ok: false, uri: mod.uri, text: `${mod.uri}：${edited.error}` };
		content = edited.content;
	}
	const worldTs = mod.time === "" ? null : (parseWorldTime(store, mod.time) ?? node.world_ts);
	const versionBefore = store.currentVersion(node.node_id);
	// 1) Body / importance / time — via updateNode. `disclosure` MUST NOT be
	//    passed here: the entry layer is resolved by setEntryDisclosure (step 2)
	//    and node_id is shared by aliases and their canonical node (§8.2).
	store.updateNode(
		node.node_id,
		{
			...(touchedBody ? { content } : {}),
			importance: mod.importance,
			world_ts: mod.time !== undefined ? worldTs : undefined,
			editor_source: touchedBody ? "manual" : undefined,
			editor_model: ctx.modelId ?? null,
		},
		provenance,
	);
	// 2) `when` — the sole entry-disclosure write path. Tri-state: `undefined`
	//    MUST skip the call entirely (an expression cannot express "don't call"
	//    and every body-only revise would silently clear the condition, R5);
	//    `""` clears; any other string writes.
	let beforeDisclosure: string | null | undefined;
	let masked = false;
	if (mod.when !== undefined) {
		beforeDisclosure = store.effectiveDisclosure(mod.uri);
		store.setEntryDisclosure(mod.uri, mod.when === "" ? null : mod.when);
		// Dead alias: the uri still resolves to a node, so the write lands on
		// that node while the shadowed alias row keeps its own condition (E10).
		masked = store.hasAliasRow(mod.uri) && store.resolveEntry(mod.uri)?.kind === "canonical";
	}
	// §8 v4: when a mod really changed state but produced no revision
	// (when-only — the entry-disclosure path never archives), archive the
	// post-write state under this mod's anchor so the projection keeps the
	// change reproducible.
	const after = store.resolveUri(mod.uri);
	const stateChanged =
		(after !== null && after.content !== node.content) ||
		(after !== null && after.world_ts !== node.world_ts) ||
		(mod.importance !== undefined && mod.importance !== node.importance) ||
		(beforeDisclosure !== undefined && store.effectiveDisclosure(mod.uri) !== beforeDisclosure);
	if (provenance && stateChanged && store.currentVersion(node.node_id) === versionBefore && after !== null) {
		store.archiveRevision(
			node.node_id,
			after.content,
			"manual",
			ctx.modelId ?? null,
			node.uri,
			{
				importance: after.importance,
				disclosure: after.disclosure,
				world_ts: after.world_ts,
				updated_ts: after.updated_ts,
			},
			provenance,
		);
	}
	const note = masked ? "（注意：该 URI 仍是规范节点，其别名入口的想起条件无法经 revise 修改）" : "";
	return {
		ok: true,
		uri: mod.uri,
		text: `已修订：${mod.uri}${note}`,
		beforeContent,
		beforeDisclosure,
	};
}

async function executeRevise(store: MemoryStore, params: Static<typeof reviseParams>, ctx: MemoryToolContext) {
	const action = params.action ?? "edit";
	if (action !== "edit") {
		// history / restore: no batch, no edit fields.
		if (params.batch) return text("history/restore 不支持 batch");
		const editFields = [
			params.content,
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
				// §8 v4: the restore itself is a branched write — anchor it.
				store.restoreRevision(
					alive.node_id,
					params.version,
					ctx.leafId && ctx.sessionId
						? { anchor_entry_id: ctx.leafId, anchor_session_id: ctx.sessionId }
						: undefined,
				);
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
			content: params.content,
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
	const results = mods.map((m) => applyReviseMod(store, m, ctx));
	const failed = results.filter((r) => !r.ok);
	// Path A (authoritative): pair each mod's pre-edit snapshot with the body
	// re-read after the write. Kept in `results` order so a batch renders 1:1.
	const diffs: Array<{ uri: string; diff: string; firstChangedLine: number | undefined }> = [];
	const before: Array<{ uri: string; content: string }> = [];
	let truncated = false;
	let diffsTruncated = false;
	for (const r of results) {
		if (!r.ok || r.beforeContent === undefined) continue;
		// Re-read rather than returning after-content through ReviseModOutcome:
		// the interface stays "what one mod did", details stays "what to show".
		const after = store.resolveUri(r.uri);
		if (!after || after.content === r.beforeContent) continue;
		if (diffs.length >= MAX_DIFF_ITEMS) {
			diffsTruncated = true;
			continue;
		}
		const { diff, firstChangedLine } = generateDiffString(r.beforeContent, after.content);
		let shown = diff;
		if (Buffer.byteLength(diff, "utf8") > MAX_DIFF_BYTES) {
			shown = cutDiff(diff, MAX_DIFF_BYTES);
			truncated = true;
		}
		diffs.push({ uri: r.uri, diff: shown, firstChangedLine });
		before.push({ uri: r.uri, content: r.beforeContent });
	}
	return withDetails(results.map((r) => r.text).join("\n"), {
		failed: failed.length,
		failed_uris: failed.map((r) => r.uri),
		diffs,
		before,
		// Present only when a cap actually bit: an ordinary call keeps four keys.
		...(truncated ? { truncated: true } : {}),
		...(diffsTruncated ? { diffsTruncated: true } : {}),
	});
}

// ── forget ─────────────────────────────────────────────────────────────────

const forgetParams = Type.Object({
	// Array branch MUST come first: Vertex/Gemini function-declaration validation rejects
	// `anyOf: [string, array]` with "For schema with items, schema type should be ARRAY"
	// (its schema merger conflates the scalar branch with the array branch's `items`).
	// Order is semantically irrelevant to JSON Schema, but array-first passes everywhere.
	target: Type.Union([
		Type.Array(Type.String({ description: "要删除的记忆 URI" }), {
			description: "批量删除：列表里每个 URI 的子树都会级联删除",
		}),
		Type.String({ description: "要删除的单个记忆 URI" }),
	]),
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
			Type.Object({
				from: Type.String({ description: "从哪里" }),
				to: Type.String({ description: "到哪里" }),
				when: Type.Optional(Type.String({ description: "别名入口的想起条件；缺省继承移动前的生效条件" })),
			}),
			{ description: "批量模式：移动清单" },
		),
	),
	when: Type.Optional(Type.String({ description: "别名入口的想起条件；缺省继承移动前的生效条件" })),
	dry_run: Type.Optional(Type.Boolean({ description: "True 只预览不执行" })),
});

async function executeRelocate(store: MemoryStore, params: Static<typeof relocateParams>, _ctx: MemoryToolContext) {
	const moves: Array<{ from: string; to: string; when?: string | null }> = params.batch
		? params.batch.map((m) => ({
				from: m.from,
				to: m.to,
				// `""` clears; `undefined` inherits the pre-move effective
				// condition (relocateMany's tri-state, distinct from revise's
				// "don't touch") — moves.ts §8.2 / contract §3.5.
				when: m.when === undefined ? undefined : m.when === "" ? null : m.when,
			}))
		: params.uri && params.to
			? [
					{
						from: params.uri,
						to: params.to,
						when: params.when === undefined ? undefined : params.when === "" ? null : params.when,
					},
				]
			: [];
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
	when: Type.Optional(
		Type.String({
			description:
				"别名模式→该入口专属想起条件；边模式→这条联想边自己的想起条件（写法同 memorize.when：预演未来的触发话头）",
		}),
	),
});

async function executeAssociate(store: MemoryStore, params: Static<typeof associateParams>, _ctx: MemoryToolContext) {
	const node = store.resolveUri(params.target_uri);
	if (!node) return text(`未找到：${params.target_uri}`);
	const hasAlias = params.new_uri !== undefined;
	const hasEdge = params.related_uri !== undefined;
	if (hasAlias === hasEdge) {
		return text("associate 需要且仅需要 new_uri（别名模式）或 related_uri（边模式）之一");
	}
	// `""` normalises to NULL (clear); `undefined` MUST stay undefined — it
	// means "keep whatever is there". `?? null` here would silently erase the
	// condition on every re-associate (D1 upsert tri-state, E2).
	const when = params.when === "" ? null : params.when;
	if (hasEdge) {
		const related = store.resolveUri(params.related_uri as string);
		if (!related) return text(`未找到：${params.related_uri}`);
		if (related.node_id === node.node_id) return text("不能自关联");
		// Duplicate edges are idempotent — kind overwritten; disclosure is kept
		// unless explicitly passed (undefined = keep).
		store.addEdge(node.node_id, related.uri, params.kind, when);
		const disc = when ? `（想起条件：${when}）` : "";
		return withDetails(`已建立联想：${node.uri} --${params.kind ?? ""}-> ${related.uri}${disc}`, {
			node_id: node.node_id,
			related_node_id: related.node_id,
		});
	}
	if (store.resolveUri(params.new_uri as string)) return text(`新入口已存在：${params.new_uri}`);
	store.addAlias(params.new_uri as string, node.node_id, when);
	const disc = when ? `（想起条件：${when}）` : "";
	return withDetails(`已关联：${params.new_uri} → ${params.target_uri}${disc}`, { node_id: node.node_id });
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
	when: Type.Optional(Type.String({ description: "什么时候想到这主题（预演未来的触发话头，不是内容复述）" })),
});

async function executeConsolidate(
	store: MemoryStore,
	params: Static<typeof consolidateParams>,
	ctx: MemoryToolContext,
) {
	const sources = params.source_uris.map((uri) => ({ uri, node: store.resolveUri(uri) }));
	const missing = sources.filter((s) => !s.node).map((s) => s.uri);
	if (missing.length) return text(`未找到：${missing.join("、")}`);
	// Same P1-1 normalisation as memorize/revise/associate: `""` is not nullish,
	// so `?? null` would persist a literal empty string that no badge can show
	// and that permanently cuts the `??` fallback for aliases under this theme.
	const disc = params.when === "" ? null : params.when;
	const resolution = params.resolution;
	if (resolution === "merge") {
		for (const s of sources) store.deleteCascade((s.node as MemoryNode).node_id);
		const merged = store.put({
			uri: params.target_uri,
			content: params.content,
			importance: params.importance ?? 5,
			disclosure: disc,
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
				disclosure: disc,
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
		disclosure: disc,
		source: "manual",
		model: ctx.modelId ?? null,
		anchor_entry_id: ctx.leafId ?? null,
	});
	let unreachable = 0;
	for (const s of sources) {
		const src = s.node as MemoryNode;
		if (resolution === "link") {
			// resolveUri prefers nodes.uri, so while the source is still a live
			// node the alias would be permanently shadowed (dead alias, X6).
			// Only create it when it can actually be reached.
			if (store.resolveUri(src.uri)) {
				unreachable++;
			} else {
				store.addAlias(src.uri, theme.node_id);
			}
		}
		// keep: leave sources untouched.
	}
	const note = unreachable ? `（${unreachable} 条源仍是规范节点，入口未生效）` : "";
	return withDetails(`已整理 ${sources.length} 条 → ${theme.uri}（${resolution}）${note}`, { node_id: theme.node_id });
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
			label: "recall",
			// The second sentence rides its own line so `promptSnippet`
			// (description.split("\n")[0]) stays the one-line tool summary.
			description:
				"回想与审视一段记忆：URI 精确寻址 + 子树展开（depth/max_nodes），精确回想会记录访问时间。系统视图：MEM://recent/<N>、MEM://index/<domain>、MEM://timeline/<domain>/<N>、MEM://forgotten/<domain>/<N>、MEM://glossary、MEM://wakeup/<N>、MEM://diagnostic/<domain>。\n" +
				"当对话触发了某条记忆的想起条件（disclosure），而你还不知道它的内容时，MUST 读取它再作答。",
			promptGuidelines: [MEMORY_DISCLOSURE_GUIDELINE],
			parameters: recallParams,
			run: (p) => executeRecall(store, p as Static<typeof recallParams>, ctx),
		},
		{
			name: "retrieve",
			label: "retrieve",
			description:
				"线索检索：想不起 URI 时用关键词搜索（FTS 词法，支持触发词专名与联想边一跳扩散）；semantic=true 启用语义检索（未配置 embedding API 自动退化词法）。命中即记录访问时间。",
			promptGuidelines: [MEMORY_DISCLOSURE_GUIDELINE],
			parameters: retrieveParams,
			run: (p) => executeRetrieve(store, p as Static<typeof retrieveParams>, ctx),
		},
		{
			name: "memorize",
			label: "memorize",
			description:
				"记下一段新记忆。可选 parent_uri 挂到已有父节点（父链缺失自动补占位）；time 打世界时间（Events 类可传，Static 类缺省用当前世界时间）；若目标 URI 是占位节点（stub），会原地转正为真实记忆。来源/模型/回溯锚点由系统自动署名，无需手填。\nwhen（想起条件）写法：预演「未来的什么话头该想起它」，不是内容的复述（复述无检索价值）。两条路线：①上位锚——事实上移一到两级的类别或情境（如吃虾起疹 →「食物过敏」「海鲜上桌」）；②强联想线索——一旦出现几乎必然相关的场景/物件/感官（如「闻到小苍兰」「看到缺口陶盆」）。写一到三条，每条独立可用；「聊到生活时」这类泛泛条件不合格。",
			parameters: memorizeParams,
			run: (p) => executeMemorize(store, p as Static<typeof memorizeParams>, ctx),
		},
		{
			name: "revise",
			label: "revise",
			description:
				"修订记忆内容或元数据。action=history 查看修订史（不传 uri 时列出可恢复的已删记忆；已删记忆显示完整版本链）；action=restore 从修订史恢复（活节点需指定 version，已删节点缺省恢复最新版）；默认 edit：四种内容编辑四选一（整条重写 content、替换 old_text→new_text 须唯一、追加 append、行编辑 line+line_content），也可只改 importance/when/time（改 when 时，URI 若是别名入口则改该入口专属条件，否则改节点自身条件），批量传 batch。旧内容自动入修订史。",
			parameters: reviseParams,
			run: (p) => executeRevise(store, p as Static<typeof reviseParams>, ctx),
		},
		{
			name: "forget",
			label: "forget",
			description:
				"忘掉记忆：target 传单个 URI 或列表。子节点级联删除；dry_run=true 先预览会牵连哪些子节点。节点行真删但修订史全部保留——误删可用 revise(action='history') 查看清单、revise(action='restore') 找回。",
			parameters: forgetParams,
			run: (p) => executeForget(store, p as Static<typeof forgetParams>, ctx),
		},
		{
			name: "relocate",
			label: "relocate",
			description:
				"移动/改名记忆（兼并 move 与 rename）：单条传 uri+to，批量传 batch 列表；可跨域、整棵子树随根移动（子节点 URI 一起重写）。旧路径自动转为别名不破链；目标缺失的父链自动补占位；任一冲突整批零改动。dry_run=true 预览冲突。",
			parameters: relocateParams,
			run: (p) => executeRelocate(store, p as Static<typeof relocateParams>, ctx),
		},
		{
			name: "associate",
			label: "associate",
			description:
				"建立联想通路，两种模式二选一：new_uri=给已有记忆多开一个入口（别名映射，不是复制，共享内容）；related_uri=在两段记忆之间画联想边（可选 kind 标注类型，如 前后续/因果/同场景），显式 retrieve 时沿边一跳扩散找到它。when 分别落到该入口的专属想起条件（别名）或该联想边的想起条件（边）。",
			parameters: associateParams,
			run: (p) => executeAssociate(store, p as Static<typeof associateParams>, ctx),
		},
		{
			name: "trigger",
			label: "trigger",
			description:
				"给记忆增删触发词（glossary）。触发词作为专名进全文索引：正文没有该词的节点也能被触发词召回。查看全部触发词用 recall(uri='MEM://glossary')。",
			parameters: triggerParams,
			run: (p) => executeTrigger(store, p as Static<typeof triggerParams>, ctx),
		},
		{
			name: "consolidate",
			label: "consolidate",
			description:
				"记忆综合与结构收敛（合并+整理合体）：resolution=merge 把多条提炼成一条并删源；group=建主题并把源记忆整棵移到主题下（真分组，children 可见）；link=建主题别名入口保留原位；keep=只建主题不动源记忆。",
			parameters: consolidateParams,
			run: (p) => executeConsolidate(store, p as Static<typeof consolidateParams>, ctx),
		},
		{
			name: "retrace",
			label: "retrace",
			description:
				"源头回溯：按 raw_id / first_raw_id+last_raw_id 区间 / 纪要 uri（自动取原文区间引用）/ 关键词全文搜索（活动原文）提取底层对话原文。场景纪要节点用 uri 模式直接定位其来源窗口。",
			parameters: retraceParams,
			run: (p) => executeRetrace(store, p as Static<typeof retraceParams>, ctx),
		},
		{
			name: "set_time",
			label: "set_time",
			description: "世界时钟推演：设置绝对时间或按相对位移（如 +1d）推进。之后的新记忆自动关联新时间。",
			parameters: setTimeParams,
			run: (p) => executeSetTime(store, p as Static<typeof setTimeParams>, ctx),
		},
		{
			name: "awaken",
			label: "awaken",
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
		promptGuidelines: d.promptGuidelines,
		promptSnippet: d.description.split("\n")[0],
		parameters: d.parameters,
		execute: async (_toolCallId: string, params: Record<string, unknown>) => d.run(params),
	}));
}

export { AWAKEN_URIS_KEY, getAwakenUris, setAwakenUris };
