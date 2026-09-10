/**
 * Memory tools — the unified tool surface (docs/memory-system.md §10).
 *
 * Twelve entries covering the 9 core cognitive verbs plus retrace / set_time /
 * awaken. Each execute() runs against a local MemoryStore; provenance (§6) is
 * auto-filled from the session context — never hand-typed by the model.
 */
import { type Static, type TSchema, Type } from "typebox";
import type { MemoryNode, MemoryStore } from "./store.ts";
import {
	renderDiagnosticView,
	renderForgottenView,
	renderGlossaryView,
	renderIndexView,
	renderRecentView,
	renderTimelineView,
	renderWakeupView,
} from "./system-views.ts";

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

// ── recall ─────────────────────────────────────────────────────────────────

const recallParams = Type.Object({
	uri: Type.String({
		description:
			"记忆 URI，如 core://identity/habits。系统视图：system://recent/<N>、system://index/<domain>、system://timeline/<domain>/<N>、system://forgotten/<domain>/<N>、system://glossary、system://wakeup/<N>、system://diagnostic/<domain>。",
	}),
	depth: Type.Optional(
		Type.Number({
			description: "展开子树的层数。0（默认）= 本节点全文 + 直接子节点 URI 列表；N = 递归 N 层；-1 = 展开整棵子树。",
		}),
	),
	max_nodes: Type.Optional(Type.Number({ description: "子树模式下最多渲染多少条节点正文，防刷爆上下文。默认 200。" })),
});

/** Parse a system:// view limit segment: non-negative integer, min 1. */
function parseViewCount(uri: string, partIndex: number, fallback: number): number {
	const raw = Number(uri.split("/")[partIndex]);
	return Number.isInteger(raw) && raw >= 1 ? raw : fallback;
}

async function executeRecall(store: MemoryStore, params: Static<typeof recallParams>): Promise<MemoryToolResult> {
	const { uri, depth, max_nodes: maxNodes } = params;
	if (uri === "system://recent" || uri.startsWith("system://recent/")) {
		const n = parseViewCount(uri, 2, 10);
		const rendered = renderRecentView(store, n);
		const nodes = store.listRecentNodes(n);
		return withDetails(rendered, { node_ids: nodes.map((x) => x.node_id) });
	}
	if (uri === "system://index" || uri.startsWith("system://index/")) {
		const rest = uri.slice("system://index".length); // "" or "/<domain>"
		const domain = rest.startsWith("/") && rest.length > 1 ? rest.slice(1) : undefined;
		return text(renderIndexView(store, domain));
	}
	if (uri === "system://glossary") {
		return text(renderGlossaryView(store));
	}
	if (uri === "system://wakeup" || uri.startsWith("system://wakeup/")) {
		const n = parseViewCount(uri, 2, 5);
		return text(renderWakeupView(store, getAwakenUris(store), n));
	}
	if (uri === "system://timeline" || uri.startsWith("system://timeline/")) {
		// Data source is raw_log (message-level, §15.4): the domain segment is
		// accepted for uri compatibility but raw_log is domain-agnostic.
		const n = parseViewCount(uri, 3, 20);
		return text(renderTimelineView(store, n));
	}
	if (uri === "system://forgotten" || uri.startsWith("system://forgotten/")) {
		const parts = uri.split("/");
		// <domain> must not be numeric: system://forgotten/<N> treats N as the
		// limit, not a domain name.
		const second = parts[2];
		const domain = second && second !== "" && !/^\d+$/.test(second) ? second : undefined;
		const n = parseViewCount(uri, /^\d+$/.test(second ?? "") ? 2 : 3, 5);
		return text(renderForgottenView(store, domain, n));
	}
	if (uri === "system://diagnostic" || uri.startsWith("system://diagnostic/")) {
		const domain = uri.slice("system://diagnostic/".length) || undefined;
		return text(renderDiagnosticView(store, domain || undefined));
	}

	const node = store.resolveUri(uri);
	if (!node) return text(`未找到记忆：${uri}`);
	if (node.is_stub) return text(`（占位节点，无正文）${uri}`);
	return withDetails(subtree(store, node, depth ?? 0, maxNodes ?? 200).join("\n"), { node_id: node.node_id });
}

// ── retrieve ───────────────────────────────────────────────────────────────

const retrieveParams = Type.Object({
	query: Type.String({ description: "搜索关键词" }),
	domain: Type.Optional(Type.String({ description: "限定 domain（树根），如 core、history" })),
	limit: Type.Optional(Type.Number({ description: "最多返回条数，默认 10" })),
	semantic: Type.Optional(Type.Boolean({ description: "是否启用语义检索（未配置 embedding API 时自动退化词法）" })),
});

async function executeRetrieve(store: MemoryStore, params: Static<typeof retrieveParams>, _ctx: MemoryToolContext) {
	const limit = params.limit ?? 10;
	const hits = store.recall(params.query, { domain: params.domain, limit });
	if (hits.length === 0) return text("（无命中）");
	return withDetails(hits.map((x) => snippet(x, 200)).join("\n"), {
		node_ids: hits.map((x) => x.node_id),
		semantic: params.semantic === true,
	});
}

// ── memorize ───────────────────────────────────────────────────────────────

const memorizeParams = Type.Object({
	uri: Type.String({ description: "记忆 URI，如 core://identity 或 history://scenes/xxx" }),
	content: Type.String({ description: "记忆的具体内容" }),
	parent_uri: Type.Optional(Type.String({ description: "父节点 URI（可选）；父链不存在时自动补占位父节点" })),
	importance: Type.Optional(Type.Number({ description: "重要性 0=最重要，5=普通，10=边角料" })),
	when: Type.Optional(Type.String({ description: "想起条件（外部信号/情境，如「当对方…」）" })),
	time: Type.Optional(Type.String({ description: "世界时间 YYYY-MM-DD 或相对位移如 -1d；缺省用当前世界时间" })),
});

async function executeMemorize(store: MemoryStore, params: Static<typeof memorizeParams>, ctx: MemoryToolContext) {
	if (store.resolveUri(params.uri)) {
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
	uri: Type.Optional(Type.String({ description: "单条模式：要修改的记忆 URI" })),
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
	store.updateNode(node.node_id, {
		...(mod.old_text !== undefined || mod.append !== undefined || mod.line !== undefined ? { content } : {}),
		importance: mod.importance,
		disclosure: mod.when,
		world_ts: mod.time !== undefined ? worldTs : undefined,
		editor_model: editorModel,
	});
	return `已修订：${mod.uri}`;
}

async function executeRevise(store: MemoryStore, params: Static<typeof reviseParams>, ctx: MemoryToolContext) {
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
	return withDetails(`已删除 ${deleted} 条记忆${missing.length ? `（未找到：${missing.join("、")}）` : ""}`, {
		deleted,
		missing,
	});
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
	const results: string[] = [];
	for (const p of previews) {
		if (!p.exists) {
			results.push(`${p.from}：不存在`);
			continue;
		}
		if (p.conflict) {
			results.push(`${p.to}：目标已占用`);
			continue;
		}
		store.rename(p.from, p.to);
		results.push(`已移动：${p.from} → ${p.to}`);
	}
	return withDetails(results.join("\n"), { moved: results.filter((r) => r.startsWith("已移动")).length });
}

// ── associate ──────────────────────────────────────────────────────────────

const associateParams = Type.Object({
	target_uri: Type.String({ description: "已有的目标记忆 URI" }),
	new_uri: Type.String({ description: "新入口放哪（别名路径）" }),
	importance: Type.Optional(Type.Number({ description: "从这个入口想起的重要性" })),
	when: Type.Optional(Type.String({ description: "从这入口什么时候会想起来" })),
});

async function executeAssociate(store: MemoryStore, params: Static<typeof associateParams>, _ctx: MemoryToolContext) {
	const node = store.resolveUri(params.target_uri);
	if (!node) return text(`未找到：${params.target_uri}`);
	if (store.resolveUri(params.new_uri)) return text(`新入口已存在：${params.new_uri}`);
	store.addAlias(params.new_uri, node.node_id);
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

	// group / link / keep: create the theme node, then arrange sources.
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
		if (resolution === "group") {
			const childUri = `${params.target_uri.replace(/\/$/, "")}/${src.uri.split("/").pop()}`;
			if (!store.resolveUri(childUri)) store.rename(src.uri, childUri);
		} else if (resolution === "link") {
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
	return text("需要 raw_id 或 first_raw_id + last_raw_id");
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

async function executeAwaken(store: MemoryStore, params: Static<typeof awakenParams>, _ctx: MemoryToolContext) {
	const current = getAwakenUris(store);
	switch (params.action) {
		case "list": {
			const lines = current.map((uri) => {
				const node = store.resolveUri(uri);
				return node ? snippet(node) : `${uri}（已失效，渲染时自动剔除）`;
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
				"回想与审视一段记忆：URI 精确寻址 + 子树展开（depth/max_nodes）。系统视图：system://recent/<N>、system://index/<domain>、system://timeline/<domain>/<N>、system://forgotten/<domain>/<N>、system://glossary、system://wakeup/<N>、system://diagnostic/<domain>。",
			parameters: recallParams,
			run: (p) => executeRecall(store, p as Static<typeof recallParams>),
		},
		{
			name: "retrieve",
			label: "检索记忆",
			description:
				"线索检索：想不起 URI 时用关键词搜索。默认词法（BM25/分词打分）；semantic=true 启用语义检索（未配置 embedding API 自动退化词法）。",
			parameters: retrieveParams,
			run: (p) => executeRetrieve(store, p as Static<typeof retrieveParams>, ctx),
		},
		{
			name: "memorize",
			label: "铭刻记忆",
			description:
				"记下一段新记忆。可选 parent_uri 挂到已有父节点（父链缺失自动补占位）；time 打世界时间（Events 类可传，Static 类缺省用当前世界时间）。来源/模型/回溯锚点由系统自动署名，无需手填。",
			parameters: memorizeParams,
			run: (p) => executeMemorize(store, p as Static<typeof memorizeParams>, ctx),
		},
		{
			name: "revise",
			label: "修订记忆",
			description:
				"修订记忆内容或元数据。三种内容编辑三选一：替换（old_text→new_text，old_text 须唯一）、追加（append）、行编辑（line+line_content）；也可只改 importance/when/time。批量传 batch 列表。旧内容自动入修订史。",
			parameters: reviseParams,
			run: (p) => executeRevise(store, p as Static<typeof reviseParams>, ctx),
		},
		{
			name: "forget",
			label: "忘掉记忆",
			description: "忘掉记忆：target 传单个 URI 或列表。子节点级联删除；dry_run=true 先预览会牵连哪些子节点。",
			parameters: forgetParams,
			run: (p) => executeForget(store, p as Static<typeof forgetParams>, ctx),
		},
		{
			name: "relocate",
			label: "迁移记忆",
			description:
				"移动/改名记忆（兼并 move 与 rename）：单条传 uri+to，批量传 batch 列表；可跨域。旧路径自动转为别名不破链；dry_run=true 预览冲突。",
			parameters: relocateParams,
			run: (p) => executeRelocate(store, p as Static<typeof relocateParams>, ctx),
		},
		{
			name: "associate",
			label: "关联记忆",
			description: "同一条记忆多开一个入口（别名映射），不是复制：两个入口共享内容，改一个另一个也变。",
			parameters: associateParams,
			run: (p) => executeAssociate(store, p as Static<typeof associateParams>, ctx),
		},
		{
			name: "trigger",
			label: "埋设触发词",
			description:
				"给记忆增删触发词（glossary）。触发词提升分词命中；查看全部触发词用 recall(uri='system://glossary')。",
			parameters: triggerParams,
			run: (p) => executeTrigger(store, p as Static<typeof triggerParams>, ctx),
		},
		{
			name: "consolidate",
			label: "整理记忆",
			description:
				"记忆综合与结构收敛（合并+整理合体）：resolution=merge 把多条提炼成一条并删源；group=建主题并把源记忆移到主题下；link=建主题别名入口保留原位；keep=只建主题不动源记忆。",
			parameters: consolidateParams,
			run: (p) => executeConsolidate(store, p as Static<typeof consolidateParams>, ctx),
		},
		{
			name: "retrace",
			label: "回溯原文",
			description:
				"源头回溯：按 raw_id 或 first_raw_id+last_raw_id 区间提取底层原文日志。场景纪要节点引用原文区间时用它取原文。",
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
				"管理「醒来记忆」——角色醒来自动载入的常驻/工作记忆清单。action=list 查看，set 完全替换，add 追加，remove 移除。节点被删/移走后渲染时自动对账。",
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
