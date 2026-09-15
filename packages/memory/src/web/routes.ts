/**
 * Route table + dispatch (plan/memory-web/01-服务端与API.md §5, §7, §8).
 *
 * Table-driven, exact-path matching. The API surface is small and entirely
 * literal, so exact match makes "routes not in the table MUST NOT exist"
 * (§7.1) enumerable in code rather than a claim about a regex.
 *
 * Every write goes through a `MemoryStore` method (§9.1 discipline 2) — this
 * file contains no INSERT/UPDATE/DELETE. Read paths may query directly (§16.6),
 * which is how the editor columns, counts and P14 grouping are obtained.
 */
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { search, toEpochDays } from "../recall.ts";
import { SCHEMA_VERSION } from "../schema.ts";
import type { MemoryNode } from "../store.ts";
import { buildTempNotifyContent, countActiveTempNodes } from "../temp-notify.ts";
import { getAwakenUris, setAwakenUris } from "../tools.ts";
import { borrowDetector, visibilityFor } from "./runtime.ts";
import { checkHost, checkOrigin } from "./security.ts";
import {
	buildChildCounts,
	type DeletedUriDTO,
	type MetaDTO,
	type RawResponseDTO,
	type RawRow,
	type RevisionDTO,
	readEditorColumns,
	type SearchResponseDTO,
	type SessionDTO,
	type TempResponseDTO,
	type TreeResponseDTO,
	toAuditDTO,
	toNodeResponseDTO,
	toRawDTO,
	toRevisionDTO,
	toTreeNodeDTO,
} from "./serialize.ts";
import type { ServerContext } from "./server.ts";
import { buildView, isViewName, VIEW_NAMES } from "./views.ts";

// ── Result + error shapes ───────────────────────────────────────────────────

export type Method = "GET" | "POST" | "HEAD";

export interface RequestCtx {
	req: IncomingMessage;
	url: URL;
	ctx: ServerContext;
	body: unknown;
}

export interface HandlerResult {
	status: number;
	body?: unknown;
	raw?: Buffer;
	contentType?: string;
	headers?: Record<string, string>;
}

export type RouteHandler = (rc: RequestCtx) => Promise<HandlerResult> | HandlerResult;

export interface RouteDef {
	method: Method;
	path: string;
	handler: RouteHandler;
}

/** The seven codes of §7.3 — the closed set the API may emit. */
export const ERROR_CODES = [
	"bad_request",
	"not_found",
	"method_not_allowed",
	"forbidden_origin",
	"invalid_db",
	"conflict",
	"internal",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const DEFAULT_MESSAGE: Record<ErrorCode, string> = {
	bad_request: "请求参数不合法。",
	not_found: "未找到。",
	method_not_allowed: "该路径不支持此方法。",
	forbidden_origin: "请求来源不被信任。",
	invalid_db: "记忆库版本不兼容，无法读取。",
	conflict: "目标地址已被占用。",
	internal: "服务器内部错误。",
};

function fail(status: number, code: ErrorCode, message?: string): HandlerResult {
	return { status, body: { error: { code, message: message ?? DEFAULT_MESSAGE[code] } } };
}

export function badRequest(message: string): HandlerResult {
	return fail(400, "bad_request", message);
}

export function notFound(message: string): HandlerResult {
	return fail(404, "not_found", message);
}

// ── store error mapping (§8.2 / §8.3) ───────────────────────────────────────

/**
 * The ONLY place store exceptions are caught. Raw SQLite text never reaches
 * the response body (§8.3): the original goes to the server log, the client
 * gets a Chinese message.
 */
export function mapStoreError(error: unknown, ctx: { uri?: string; to?: string }): HandlerResult {
	const msg = error instanceof Error ? error.message : String(error);
	console.error("memory-web: store error", msg);

	if (msg.includes("incompatible with this build")) return fail(409, "invalid_db");
	if (msg.includes("file is not a database")) return fail(409, "invalid_db");
	if (msg.includes("unable to open database file")) return fail(409, "invalid_db");
	// conflict (409) — target occupied / restore clash (§7.3, contract change #8)
	if (msg.includes("target occupied")) return fail(409, "conflict", `目标地址已被占用：${ctx.to ?? "（未知）"}`);
	if (msg.includes("still exists"))
		return fail(409, "conflict", `该地址仍有节点存活，无法作为「恢复已删」处理：${ctx.uri ?? "（未知）"}`);
	if (msg.includes("UNIQUE constraint failed: nodes.node_id"))
		return fail(409, "conflict", "该节点的另一个历史地址已被恢复，请先撤销后再试");
	if (msg.includes("UNIQUE constraint failed")) return fail(409, "conflict", `地址已被占用：${ctx.uri ?? "（未知）"}`);
	// not_found (404)
	if (msg.includes("unknown uri")) return fail(404, "not_found", `未找到：${ctx.uri ?? "（未知）"}`);
	if (msg.includes("no revisions for") || msg.includes("no version"))
		return fail(404, "not_found", `未找到可恢复的修订：${ctx.uri ?? "（未知）"}`);
	// bad_request (400) — pure form validation
	if (msg.includes("nested inside source")) return fail(400, "bad_request", "不能把节点移动到它自己的子路径下");
	if (msg.includes("sources overlap")) return fail(400, "bad_request", "同一批移动里存在重叠的源路径");
	if (msg.includes("targets collide")) return fail(400, "bad_request", "多个节点移动后会落在同一地址");
	if (msg.includes("invalid time")) return fail(400, "bad_request", "世界钟时间格式不合法。");
	if (msg.includes("required")) return fail(400, "bad_request", "缺少必需参数。");
	// internal (500)
	if (msg.includes("cannot start a transaction")) return fail(500, "internal");
	if (msg.includes("database is not open")) return fail(500, "internal");
	if (msg.includes("vanished") || msg.includes("unknown node")) return fail(500, "internal");
	return fail(500, "internal");
}

// ── parameter helpers ───────────────────────────────────────────────────────

class BadParam extends Error {}

function optionalInt(sp: URLSearchParams, name: string): number | undefined {
	const raw = sp.get(name);
	if (raw === null || raw === "") return undefined;
	const value = Number(raw);
	if (!Number.isInteger(value)) throw new BadParam(`${name} 必须是整数，收到 "${raw}"`);
	return value;
}

function intOrThrow(sp: URLSearchParams, name: string, opts: { min: number; max: number; def: number }): number {
	const raw = sp.get(name);
	if (raw === null || raw === "") return opts.def;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < opts.min || value > opts.max) {
		throw new BadParam(`${name} 必须是 ${opts.min}-${opts.max} 的整数，收到 "${raw}"`);
	}
	return value;
}

// ── GET handlers ────────────────────────────────────────────────────────────

function countOf(rc: RequestCtx, sql: string, ...params: unknown[]): number {
	const row = rc.ctx.store.db.prepare(sql).get(...params) as { c: number } | undefined;
	return Number(row?.c ?? 0);
}

function getMeta(rc: RequestCtx): HandlerResult {
	const { store } = rc.ctx;
	const domains = store.listDomains();
	const nodes = store.listNodes();
	const body: MetaDTO = {
		db_path: rc.ctx.dbPath,
		schema_version: SCHEMA_VERSION,
		world_time: store.getWorldTime(),
		domains,
		counts: {
			nodes: nodes.length,
			stubs: nodes.filter((n) => n.is_stub === 1).length,
			domains: domains.length,
			raw_total: countOf(rc, "SELECT COUNT(*) AS c FROM raw_log"),
			raw_active: countOf(rc, "SELECT COALESCE(SUM(active), 0) AS c FROM raw_log"),
			revisions: countOf(rc, "SELECT COUNT(*) AS c FROM node_revisions"),
			edges: countOf(rc, "SELECT COUNT(*) AS c FROM edges"),
			aliases: countOf(rc, "SELECT COUNT(*) AS c FROM aliases"),
			glossary: countOf(rc, "SELECT COUNT(*) AS c FROM glossary"),
			audit: countOf(rc, "SELECT COUNT(*) AS c FROM audit_log"),
			sessions: countOf(rc, "SELECT COUNT(DISTINCT session_id) AS c FROM raw_log"),
			temp: store.countTempNodes(),
		},
		temp_threshold: rc.ctx.tempThreshold,
		thresholdSource: rc.ctx.tempThresholdSource,
	};
	return { status: 200, body };
}

function getTree(rc: RequestCtx): HandlerResult {
	const { store } = rc.ctx;
	const sp = rc.url.searchParams;
	const domain = sp.get("domain") ?? undefined;
	const parentUri = sp.get("parentUri");
	const depth = intOrThrow(sp, "depth", { min: 1, max: 3, def: 1 });
	const limit = intOrThrow(sp, "limit", { min: 1, max: 500, def: 100 });
	const offset = intOrThrow(sp, "offset", { min: 0, max: Number.MAX_SAFE_INTEGER, def: 0 });
	// An unknown or empty domain is a legal empty list, not a 404 — a fresh
	// database has no `core` nodes, and the tree page must render empty there
	// rather than fail. (§8.4's "no silent empty" rule is about resolveUri.)
	const vis = visibilityFor(rc.ctx);
	const childCount = buildChildCounts(store);

	let candidates: MemoryNode[];
	let resolvedParent: string | null = null;
	if (parentUri !== null && parentUri !== "") {
		const parent = store.resolveUri(parentUri);
		if (!parent) return notFound(`未找到：${parentUri}`);
		resolvedParent = parent.uri;
		candidates = depth === 1 ? store.children(parent.node_id) : descendants(store, parent, depth);
	} else {
		candidates = store.listNodes(domain === undefined ? {} : { domain }).filter((n) => n.parent_id === null);
		if (depth > 1) {
			const roots = candidates;
			candidates = [];
			for (const root of roots) candidates.push(root, ...descendants(store, root, depth));
		}
	}

	const items = candidates.map((n) => toTreeNodeDTO(n, childCount.get(n.node_id) ?? 0, vis.isShadowed(n.node_id)));
	const body: TreeResponseDTO = {
		items: items.slice(offset, offset + limit),
		total: items.length,
		limit,
		offset,
		parent_uri: resolvedParent,
	};
	return { status: 200, body };
}

/** Subtree below `root`, excluding `root`, breadth-first, limited by depth. */
function descendants(store: ServerContext["store"], root: MemoryNode, depth: number): MemoryNode[] {
	const out: MemoryNode[] = [];
	let level: MemoryNode[] = [root];
	for (let d = 1; d < depth; d++) {
		const next: MemoryNode[] = [];
		for (const node of level) {
			for (const child of store.children(node.node_id)) {
				out.push(child);
				next.push(child);
			}
		}
		level = next;
	}
	return out;
}

function getNode(rc: RequestCtx): HandlerResult {
	const uri = rc.url.searchParams.get("uri");
	if (uri === null || uri === "") return badRequest("缺少必需参数：uri");
	const { store } = rc.ctx;
	const node = store.resolveUri(uri);
	if (!node) return notFound(`未找到：${uri}`);
	const vis = visibilityFor(rc.ctx);
	return {
		status: 200,
		body: toNodeResponseDTO(store, node, {
			isShadowed: vis.isShadowed,
			childCount: buildChildCounts(store),
		}),
	};
}

async function getSearch(rc: RequestCtx): Promise<HandlerResult> {
	const sp = rc.url.searchParams;
	const q = sp.get("q");
	if (q === null || q === "") return badRequest("缺少必需参数：q");
	const limit = intOrThrow(sp, "limit", { min: 1, max: 50, def: 10 });
	const domain = sp.get("domain") ?? undefined;
	const { store } = rc.ctx;
	const vis = visibilityFor(rc.ctx);
	const result = await search(store, undefined, {
		queries: [q],
		domain,
		topK: limit,
		minScore: 0,
		keywordMinScore: 0,
		nowDays: toEpochDays(store.getWorldTime()) ?? 0,
		domainBlocklist: [],
		isVisible: vis.isVisible,
	});
	const byId = new Map(store.listNodes().map((n) => [n.node_id, n]));
	const body: SearchResponseDTO = {
		items: result.items.map((item) => {
			// P7 back-fill: RecalledItem has no importance/source/world_ts.
			// Never substitute `score` — different scale and polarity.
			const node = byId.get(item.node_id);
			return {
				node_id: item.node_id,
				uri: item.uri,
				disclosure: item.disclosure,
				summary: item.summary,
				content: item.content,
				score: item.score,
				kw: item.kw,
				vec: item.vec,
				bm25: item.bm25,
				importance: node?.importance ?? null,
				source: node?.source ?? null,
				world_ts: node?.world_ts ?? null,
			};
		}),
		total: result.items.length,
		mode: result.mode,
	};
	return { status: 200, body };
}

function getRaw(rc: RequestCtx): HandlerResult {
	const sp = rc.url.searchParams;
	const { store } = rc.ctx;
	const session = sp.get("session") ?? undefined;
	const activeOnlyRaw = sp.get("activeOnly");
	const activeOnly = activeOnlyRaw === "1" || activeOnlyRaw === "true";
	const from = optionalInt(sp, "from");
	const to = optionalInt(sp, "to");
	const limit = intOrThrow(sp, "limit", { min: 1, max: 500, def: 100 });
	const offsetRaw = sp.get("offset");
	const before = optionalInt(sp, "before");
	const around = sp.get("around") ?? undefined;

	// offset / before / around are mutually exclusive (§16.9).
	const exclusive = [offsetRaw !== null && offsetRaw !== "", before !== undefined, around !== undefined].filter(
		Boolean,
	).length;
	if (exclusive > 1) return badRequest("分页参数 offset / before / around 只能三选一");
	// from/to are window bounds and cannot combine with before/around.
	if ((before !== undefined || around !== undefined) && (from !== undefined || to !== undefined)) {
		return badRequest("窗口边界 from/to 不能与 before / around 同时使用");
	}

	const opts = { sessionId: session, activeOnly };
	const clauses: string[] = [];
	const params: unknown[] = [];
	if (session) {
		clauses.push("session_id = ?");
		params.push(session);
	}
	if (activeOnly) clauses.push("active = 1");
	const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
	const total = countOf(rc, `SELECT COUNT(*) AS c FROM raw_log ${where}`, ...params);
	const totalAll = countOf(rc, "SELECT COUNT(*) AS c FROM raw_log");

	let rows: RawRow[];
	let centered = false;
	let beforeValue: number | null = null;
	const offset =
		offsetRaw !== null && offsetRaw !== ""
			? intOrThrow(sp, "offset", { min: 0, max: Number.MAX_SAFE_INTEGER, def: 0 })
			: 0;

	if (around !== undefined) {
		// `around` is an entry_id (TEXT), never a raw_id — resolve first.
		const matches = store.db
			.prepare("SELECT raw_id FROM raw_log WHERE entry_id = ? AND session_id = ?")
			.all(around, session ?? "") as Array<{ raw_id: number }>;
		if (matches.length === 0) {
			if (session === undefined) {
				const anywhere = store.db.prepare("SELECT COUNT(*) AS c FROM raw_log WHERE entry_id = ?").get(around) as {
					c: number;
				};
				if (Number(anywhere.c) > 0) {
					return badRequest("未找到该原文条目；该 entry_id 跨会话重复，请一并指定 session");
				}
			}
			return notFound(`未找到原文条目：${around}`);
		}
		if (matches.length > 1) {
			return badRequest("该 entry_id 跨会话重复，请一并指定 session");
		}
		const anchor = matches[0].raw_id;
		const half = Math.floor(limit / 2);
		const window = store.listRaw(Math.max(0, anchor - half), anchor + half, opts);
		rows = window.slice(0, limit);
		centered = true;
	} else if (before !== undefined) {
		beforeValue = before;
		const window = store.listRaw(0, before - 1, opts);
		rows = window.slice(-limit);
	} else {
		const window = store.listRaw(from ?? 0, to ?? Number.MAX_SAFE_INTEGER, opts);
		rows = window.slice(offset, offset + limit);
	}

	const body: RawResponseDTO = {
		items: rows.map(toRawDTO),
		total,
		totalAll,
		limit,
		offset,
		before: beforeValue,
		centered,
	};
	return { status: 200, body };
}

function getSessions(rc: RequestCtx): HandlerResult {
	const rows = rc.ctx.store.db
		.prepare(
			`SELECT session_id, COUNT(*) AS total, SUM(active) AS active,
			        MIN(raw_id) AS first_raw_id, MAX(raw_id) AS last_raw_id,
			        MIN(wall_ts) AS wall_first, MAX(wall_ts) AS wall_last
			 FROM raw_log GROUP BY session_id ORDER BY last_raw_id DESC`,
		)
		.all() as Array<{
		session_id: string;
		total: number;
		active: number;
		first_raw_id: number;
		last_raw_id: number;
		wall_first: string;
		wall_last: string;
	}>;
	const items: SessionDTO[] = rows.map((r) => ({
		session_id: r.session_id,
		total: Number(r.total),
		active: Number(r.active),
		first_raw_id: Number(r.first_raw_id),
		last_raw_id: Number(r.last_raw_id),
		wall_first: r.wall_first,
		wall_last: r.wall_last,
	}));
	return { status: 200, body: { items, total: items.length } };
}

function getTemp(rc: RequestCtx): HandlerResult {
	const { store } = rc.ctx;
	const vis = visibilityFor(rc.ctx);
	const count = countActiveTempNodes(store, vis.isVisible);
	const countAll = store.countTempNodes();
	const tempNodes = store
		.listNodes()
		.filter((n) => n.uri.startsWith("TEMP://") || n.uri.toLowerCase().startsWith("temp://"))
		.filter((n) => n.is_stub === 0);
	const childCount = buildChildCounts(store);
	const body: TempResponseDTO = {
		items: tempNodes.map((n) => toTreeNodeDTO(n, childCount.get(n.node_id) ?? 0, vis.isShadowed(n.node_id))),
		count,
		count_all: countAll,
		threshold: rc.ctx.tempThreshold,
		thresholdSource: rc.ctx.tempThresholdSource,
		notifyPreview: buildTempNotifyContent(count, rc.ctx.tempThreshold),
	};
	return { status: 200, body };
}

function getView(rc: RequestCtx): HandlerResult {
	const sp = rc.url.searchParams;
	const name = sp.get("name");
	if (name === null || name === "") {
		return badRequest(`缺少必需参数：name（合法值：${VIEW_NAMES.join(" / ")}）`);
	}
	if (!isViewName(name)) {
		return badRequest(`未知视图：${name}（合法值：${VIEW_NAMES.join(" / ")}）`);
	}
	if (rc.url.searchParams.get("uri") !== null) {
		return badRequest("不支持 uri 参数；请使用 name / domain / limit 显式参数");
	}
	const vis = visibilityFor(rc.ctx);
	// Explicit structured params only — never parsed from a MEM:// URI (§16.8).
	return {
		status: 200,
		body: buildView(rc.ctx.store, {
			name,
			domain: sp.get("domain") ?? undefined,
			limit:
				sp.get("limit") === null || sp.get("limit") === ""
					? undefined
					: intOrThrow(sp, "limit", { min: 1, max: 500, def: 20 }),
			isVisible: vis.isVisible,
			isShadowed: vis.isShadowed,
		}),
	};
}

function getAudit(rc: RequestCtx): HandlerResult {
	const limit = intOrThrow(rc.url.searchParams, "limit", { min: 1, max: 500, def: 50 });
	const offset = intOrThrow(rc.url.searchParams, "offset", { min: 0, max: Number.MAX_SAFE_INTEGER, def: 0 });
	// listAudit has no offset parameter — over-fetch, then slice in memory.
	const rows = rc.ctx.store.listAudit(limit + offset);
	const items = rows.slice(offset, offset + limit).map(toAuditDTO);
	return { status: 200, body: { items, total: rows.length, limit, offset } };
}

function getRevisions(rc: RequestCtx): HandlerResult {
	const sp = rc.url.searchParams;
	const { store } = rc.ctx;
	const uri = sp.get("uri");
	const deleted = sp.get("deleted");
	const limit = intOrThrow(sp, "limit", { min: 1, max: 500, def: 50 });
	const offset = intOrThrow(sp, "offset", { min: 0, max: Number.MAX_SAFE_INTEGER, def: 0 });

	if (deleted === "1" || deleted === "true") {
		if (uri !== null && uri !== "") return badRequest("uri 与 deleted=1 互斥，只能二选一");
		// ⭐ P14: `listDeletedUris` has no node_id, but the recovery page must
		// group one deleted node's multiple historical addresses together.
		const rows = store.db
			.prepare(
				`SELECT r.uri AS uri, r.node_id AS node_id, COUNT(*) AS versions, MAX(r.created_at) AS last_seen
				 FROM node_revisions r
				 WHERE r.uri IS NOT NULL
				   AND NOT EXISTS(SELECT 1 FROM nodes n WHERE n.node_id = r.node_id)
				 GROUP BY r.uri ORDER BY last_seen DESC`,
			)
			.all() as Array<{ uri: string; node_id: string | null; versions: number; last_seen: string }>;
		const items: DeletedUriDTO[] = rows.map((r) => ({
			uri: r.uri,
			node_id: r.node_id,
			versions: Number(r.versions),
			last_seen: r.last_seen,
		}));
		return { status: 200, body: { items: items.slice(offset, offset + limit), total: items.length, limit, offset } };
	}
	if (uri === null || uri === "") return badRequest("必须提供 uri 或 deleted=1");

	const resolved = store.resolveUri(uri);
	let items: RevisionDTO[];
	if (resolved) {
		items = store
			.listRevisions(resolved.node_id)
			.map((row) =>
				toRevisionDTO(resolved.node_id, row, readEditorColumns(store, resolved.node_id, row.uri, row.version)),
			);
	} else {
		// Deleted node: revisions keep their own uri, so this still resolves.
		items = store.listRevisionsByUri(uri).map((row) => {
			const editor = readEditorColumns(store, row.node_id, uri, row.version);
			return {
				node_id: row.node_id,
				version: row.version,
				uri,
				content: row.content,
				editor_source: editor.editor_source,
				editor_model: editor.editor_model,
				created_at: row.created_at,
			};
		});
	}
	return { status: 200, body: { items: items.slice(offset, offset + limit), total: items.length, limit, offset } };
}

function getEvents(rc: RequestCtx): HandlerResult {
	return { status: 200, body: borrowDetector(rc.ctx).read() };
}

// ── POST handlers ───────────────────────────────────────────────────────────

interface JsonObject {
	[key: string]: unknown;
}

function asObject(body: unknown): JsonObject | null {
	return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as JsonObject) : null;
}

function strField(obj: JsonObject, key: string): string | null {
	const value = obj[key];
	return typeof value === "string" && value !== "" ? value : null;
}

function numField(obj: JsonObject, key: string): number | null {
	const value = obj[key];
	return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function postNode(rc: RequestCtx): HandlerResult {
	const obj = asObject(rc.body);
	if (!obj) return badRequest("请求体必须是 JSON 对象");
	const uri = strField(obj, "uri");
	const content = typeof obj.content === "string" ? (obj.content as string) : null;
	if (!uri) return badRequest("缺少必需参数：uri");
	if (content === null) return badRequest("缺少必需参数：content");
	const { store } = rc.ctx;
	// put() is an upsert: an existing uri is OVERWRITTEN with 200, never 409.
	const node = store.put({
		uri,
		content,
		disclosure: typeof obj.disclosure === "string" ? (obj.disclosure as string) : undefined,
		importance: numField(obj, "importance") ?? undefined,
		source: "manual",
		model: null,
	});
	return nodeResponse(rc, node);
}

function postRevise(rc: RequestCtx): HandlerResult {
	const obj = asObject(rc.body);
	if (!obj) return badRequest("请求体必须是 JSON 对象");
	const uri = strField(obj, "uri");
	if (!uri) return badRequest("缺少必需参数：uri");
	const { store } = rc.ctx;
	const node = store.resolveUri(uri);
	if (!node) return notFound(`未找到：${uri}`);

	const patch: {
		content?: string;
		disclosure?: string | null;
		importance?: number;
		world_ts?: string | null;
		editor_source: "manual";
		editor_model: null;
	} = { editor_source: "manual", editor_model: null };
	if (typeof obj.content === "string") patch.content = obj.content as string;
	if (typeof obj.disclosure === "string" || obj.disclosure === null) {
		patch.disclosure = obj.disclosure as string | null;
	}
	if (typeof obj.importance === "number") {
		const importance = obj.importance as number;
		if (!Number.isInteger(importance) || importance < 0 || importance > 10) {
			return badRequest("importance 必须是 0-10 的整数");
		}
		patch.importance = importance;
	}
	if (typeof obj.world_ts === "string" || obj.world_ts === null) patch.world_ts = obj.world_ts as string | null;
	if (
		patch.content === undefined &&
		patch.disclosure === undefined &&
		patch.importance === undefined &&
		patch.world_ts === undefined
	) {
		return badRequest("至少需要一个可改字段：content / disclosure / importance / world_ts");
	}

	const version = store.updateNode(node.node_id, patch);
	const response = nodeResponse(rc, store.getNode(node.node_id) ?? node);
	return { ...response, body: { ...(response.body as object), version } };
}

function nodeResponse(rc: RequestCtx, node: MemoryNode): HandlerResult {
	const vis = visibilityFor(rc.ctx);
	return {
		status: 200,
		body: toNodeResponseDTO(rc.ctx.store, node, {
			isShadowed: vis.isShadowed,
			childCount: buildChildCounts(rc.ctx.store),
		}),
	};
}

function postForget(rc: RequestCtx): HandlerResult {
	const obj = asObject(rc.body);
	if (!obj) return badRequest("请求体必须是 JSON 对象");
	const uri = strField(obj, "uri");
	if (!uri) return badRequest("缺少必需参数：uri");
	const node = rc.ctx.store.resolveUri(uri);
	if (!node) return notFound(`未找到：${uri}`);
	try {
		rc.ctx.store.deleteCascade(node.node_id);
	} catch (error) {
		return mapStoreError(error, { uri });
	}
	return { status: 200, body: { deleted: true, uri: node.uri, node_id: node.node_id } };
}

function postRestore(rc: RequestCtx): HandlerResult {
	const obj = asObject(rc.body);
	if (!obj) return badRequest("请求体必须是 JSON 对象");
	const uri = strField(obj, "uri");
	if (!uri) return badRequest("缺少必需参数：uri");
	const version = numField(obj, "version") ?? undefined;
	const store = rc.ctx.store;
	try {
		const restored = store.restoreDeleted(uri, version);
		return nodeResponse(rc, restored);
	} catch (error) {
		return mapStoreError(error, { uri });
	}
}

function postRelocate(rc: RequestCtx): HandlerResult {
	const obj = asObject(rc.body);
	if (!obj) return badRequest("请求体必须是 JSON 对象");
	// The engine's native shape is an array (`relocateMany(moves)`), and the
	// contract calls this a BATCH move — a top-level {from,to} shell would be a
	// second truth for the same operation, so it is deliberately not accepted.
	const rawMoves = obj.moves;
	if (!Array.isArray(rawMoves) || rawMoves.length === 0) {
		return badRequest("缺少必需参数：moves（形如 [{ from, to }]）");
	}
	const moves: Array<{ from: string; to: string }> = [];
	for (const entry of rawMoves) {
		const move = asObject(entry);
		const from = move ? strField(move, "from") : null;
		const to = move ? strField(move, "to") : null;
		if (!from || !to) return badRequest("moves 的每一项都需要 from 与 to");
		if (from === to) return badRequest("源地址与目标地址相同");
		moves.push({ from, to });
	}
	try {
		rc.ctx.store.relocateMany(moves);
	} catch (error) {
		return mapStoreError(error, { uri: moves[0].from, to: moves[0].to });
	}
	const first = moves[0];
	return { status: 200, body: { moved: moves.length, from: first.from, to: first.to, alias_uri: first.from } };
}

function postEdge(rc: RequestCtx): HandlerResult {
	const obj = asObject(rc.body);
	if (!obj) return badRequest("请求体必须是 JSON 对象");
	const uri = strField(obj, "uri");
	const targetUri = strField(obj, "target_uri");
	if (!uri) return badRequest("缺少必需参数：uri");
	if (!targetUri) return badRequest("缺少必需参数：target_uri");
	const store = rc.ctx.store;
	const node = store.resolveUri(uri);
	if (!node) return notFound(`未找到：${uri}`);
	const kind = typeof obj.kind === "string" ? (obj.kind as string) : undefined;
	store.addEdge(node.node_id, targetUri, kind);
	return { status: 200, body: { added: true, node_id: node.node_id, target_uri: targetUri, kind: kind ?? null } };
}

function postGlossary(rc: RequestCtx): HandlerResult {
	const obj = asObject(rc.body);
	if (!obj) return badRequest("请求体必须是 JSON 对象");
	const keyword = strField(obj, "keyword");
	const uri = strField(obj, "uri");
	if (!keyword) return badRequest("缺少必需参数：keyword");
	if (!uri) return badRequest("缺少必需参数：uri");
	const node = rc.ctx.store.resolveUri(uri);
	if (!node) return notFound(`未找到：${uri}`);
	rc.ctx.store.addGlossaryEntry(keyword, node.node_id);
	return { status: 200, body: { added: true, keyword, node_id: node.node_id } };
}

function postGlossaryRemove(rc: RequestCtx): HandlerResult {
	const obj = asObject(rc.body);
	if (!obj) return badRequest("请求体必须是 JSON 对象");
	const keyword = strField(obj, "keyword");
	if (!keyword) return badRequest("缺少必需参数：keyword");
	rc.ctx.store.removeGlossaryEntry(keyword);
	return { status: 200, body: { removed: true, keyword } };
}

function postAwaken(rc: RequestCtx): HandlerResult {
	const obj = asObject(rc.body);
	if (!obj) return badRequest("请求体必须是 JSON 对象");
	const action = strField(obj, "action");
	if (action === null || !["list", "set", "add", "remove"].includes(action)) {
		return badRequest("action 必须是 list / set / add / remove 之一");
	}
	const store = rc.ctx.store;
	const current = getAwakenUris(store);
	if (action === "list") return { status: 200, body: { uris: current } };
	const rawUris = obj.uris;
	if (!Array.isArray(rawUris) || rawUris.some((u) => typeof u !== "string")) {
		return badRequest("set / add / remove 需要 uris 字符串数组");
	}
	const uris = rawUris as string[];
	// Elements are NOT validated for resolvability — matches the engine (§7.12).
	const next =
		action === "set" ? uris : action === "add" ? [...current, ...uris] : current.filter((u) => !uris.includes(u));
	setAwakenUris(store, next);
	return { status: 200, body: { uris: next } };
}

function postWorldTime(rc: RequestCtx): HandlerResult {
	const obj = asObject(rc.body);
	if (!obj) return badRequest("请求体必须是 JSON 对象");
	const value = strField(obj, "value");
	if (!value) return badRequest("缺少必需参数：value");
	try {
		// setWorldTime returns the resolved absolute time, so "+1d" echoes back as ISO.
		return { status: 200, body: { world_time: rc.ctx.store.setWorldTime(value) } };
	} catch (error) {
		return mapStoreError(error, {});
	}
}

// ── Static assets (§5.3 / §16.5) ────────────────────────────────────────────

const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".map": "application/json; charset=utf-8",
};

const ASSET_PREFIX = "/assets/";

async function serveStatic(rc: RequestCtx, pathname: string): Promise<HandlerResult | null> {
	let relative: string;
	if (pathname === "/") {
		relative = "index.html";
	} else if (pathname.startsWith(ASSET_PREFIX)) {
		// The prefix MUST be stripped before mapping, or every page 404s.
		try {
			relative = decodeURIComponent(pathname.slice(ASSET_PREFIX.length));
		} catch {
			return notFound(`未找到：${pathname}`);
		}
	} else {
		// No aliases: `/app.js` is 404 so one file never has two URLs.
		return null;
	}
	const abs = path.resolve(rc.ctx.assetsDir, relative);
	// Containment via path.relative — `startsWith` is fooled by sibling dirs.
	// The decode above MUST happen first, or %2e%2e escapes this check.
	const rel = path.relative(rc.ctx.assetsDir, abs);
	if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return notFound(`未找到：${pathname}`);
	if (relative.endsWith("/")) return notFound(`未找到：${pathname}`);

	let buffer: Buffer;
	try {
		buffer = await readFile(abs);
	} catch {
		return notFound(`未找到：${pathname}`);
	}
	const ext = path.extname(abs).toLowerCase();
	const headers: Record<string, string> = {
		"Content-Type": CONTENT_TYPES[ext] ?? "application/octet-stream",
		// No content-hashed filenames (zero build), so no immutable caching.
		"Cache-Control": ext === ".html" ? "no-store" : "no-cache",
	};
	return { status: 200, raw: buffer, contentType: headers["Content-Type"], headers };
}

// ── The table ───────────────────────────────────────────────────────────────

export const ROUTES: RouteDef[] = [
	{ method: "GET", path: "/api/meta", handler: getMeta },
	{ method: "GET", path: "/api/tree", handler: getTree },
	{ method: "GET", path: "/api/node", handler: getNode },
	{ method: "GET", path: "/api/search", handler: getSearch },
	{ method: "GET", path: "/api/temp", handler: getTemp },
	{ method: "GET", path: "/api/view", handler: getView },
	{ method: "GET", path: "/api/audit", handler: getAudit },
	{ method: "GET", path: "/api/revisions", handler: getRevisions },
	{ method: "GET", path: "/api/raw", handler: getRaw },
	{ method: "GET", path: "/api/sessions", handler: getSessions },
	{ method: "GET", path: "/api/events", handler: getEvents },
	{ method: "POST", path: "/api/node", handler: postNode },
	{ method: "POST", path: "/api/node/revise", handler: postRevise },
	{ method: "POST", path: "/api/node/forget", handler: postForget },
	{ method: "POST", path: "/api/node/restore", handler: postRestore },
	{ method: "POST", path: "/api/node/relocate", handler: postRelocate },
	{ method: "POST", path: "/api/edge", handler: postEdge },
	{ method: "POST", path: "/api/glossary", handler: postGlossary },
	{ method: "POST", path: "/api/glossary/remove", handler: postGlossaryRemove },
	{ method: "POST", path: "/api/awaken", handler: postAwaken },
	{ method: "POST", path: "/api/world-time", handler: postWorldTime },
];

const MAX_BODY = 1024 * 1024;

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const buf = chunk as Buffer;
		size += buf.length;
		if (size > MAX_BODY) throw new BadParam("请求体超过 1 MiB 上限");
		chunks.push(buf);
	}
	if (size === 0) return undefined;
	const text = Buffer.concat(chunks).toString("utf8");
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new BadParam("请求体不是合法 JSON");
	}
}

// ── Dispatch ────────────────────────────────────────────────────────────────
export async function dispatch(req: IncomingMessage, res: ServerResponse, ctx: ServerContext): Promise<void> {
	const method = (req.method ?? "GET").toUpperCase();
	const rawUrl = req.url ?? "/";
	const url = new URL(rawUrl, "http://localhost");
	const headers = { "X-Content-Type-Options": "nosniff" };

	try {
		// S2 first: DNS rebinding attacks the Host header on EVERY path,
		// including static assets.
		const host = req.headers.host;
		if (!checkHost(host)) {
			return send(
				res,
				fail(
					403,
					"forbidden_origin",
					`Host 头不被信任：${host ?? "(缺失)"}。本服务只接受 127.0.0.1 / localhost / [::1]。`,
				),
				headers,
			);
		}
		// S3 applies to non-GET/HEAD only; absent Origin passes (curl/scripts).
		if (method !== "GET" && method !== "HEAD" && !checkOrigin(req.headers.origin, host)) {
			return send(res, fail(403, "forbidden_origin", `Origin 头不被信任：${req.headers.origin}。`), headers);
		}

		const normalized: Method = method === "HEAD" ? "GET" : (method as Method);
		const route = ROUTES.find((r) => r.method === normalized && r.path === url.pathname);
		if (route) {
			try {
				const body = req.method === "POST" ? await readJsonBody(req) : undefined;
				const result = await route.handler({ req, url, ctx, body });
				return send(res, result, headers, method === "HEAD");
			} catch (error) {
				if (error instanceof BadParam) return send(res, badRequest(error.message), headers);
				return send(res, mapStoreError(error, {}), headers);
			}
		}

		const samePath = ROUTES.filter((r) => r.path === url.pathname);
		if (samePath.length > 0) {
			const allow = [...new Set(samePath.map((r) => r.method))].join(", ");
			return send(res, fail(405, "method_not_allowed", `路径 ${url.pathname} 不支持方法 ${method}`), {
				...headers,
				Allow: allow,
			});
		}

		const stat = await serveStatic({ req, url, ctx, body: undefined }, url.pathname);
		if (stat) return send(res, stat, headers, method === "HEAD");

		return send(res, notFound(`未找到：${url.pathname}`), headers);
	} catch (error) {
		return send(res, mapStoreError(error, {}), headers);
	}
}

function send(res: ServerResponse, result: HandlerResult, base: Record<string, string>, headOnly = false): void {
	if (res.headersSent) return;
	const headers = { ...base, ...(result.headers ?? {}) };
	for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
	if (result.raw) {
		res.statusCode = result.status;
		if (result.contentType) res.setHeader("Content-Type", result.contentType);
		res.end(headOnly ? undefined : result.raw);
		return;
	}
	res.setHeader("Content-Type", "application/json; charset=utf-8");
	res.statusCode = result.status;
	res.end(headOnly ? undefined : JSON.stringify(result.body ?? null));
}
