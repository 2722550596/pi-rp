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
import { statSync, unlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import { openMemoryStore } from "../index.ts";
import { search, toEpochDays } from "../recall.ts";
import { SCHEMA_VERSION } from "../schema.ts";
import type { MemoryNode, MemoryStore } from "../store.ts";
import { buildTempNotifyContent, countActiveTempNodes } from "../temp-notify.ts";
import { getAwakenUris, setAwakenUris } from "../tools.ts";
import { checkPathAllowed, multiDbEnabled, type PathPolicy } from "./db-path-policy.ts";
import { discoverMemoryDbs, type ProbeOutcome, probeMemoryDb, readMemoryDbStats } from "./discovery.ts";
import { DbUnavailableError, type StoreEntry, StoreRegistry } from "./registry.ts";
import { borrowDetector, visibilityFor } from "./runtime.ts";
import { checkHost, checkOrigin } from "./security.ts";
import {
	buildChildCounts,
	contentHead,
	type DatabaseDTO,
	type DatabaseOpenedDTO,
	type DatabasesDTO,
	type DeletedUriDTO,
	type GraphDataDTO,
	type GraphDomainsDTO,
	type GraphEdgeDTO,
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
	toDatabaseDTO,
	toDiscoveryMetaDTO,
	toGraphAliasDTO,
	toGraphEdgeDTO,
	toGraphNodeDTO,
	toNodeResponseDTO,
	toRawDTO,
	toRevisionDTO,
	toTreeNodeDTO,
	toUnreachableDatabaseDTO,
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
	// ── Multi-db (13-多库服务端API.md §8.3) ─────────────────────────────────
	// Q5 (contract §2.8): once busy_timeout (5000) is exhausted, SQLite throws
	// "database is locked". That is a TRANSIENT conflict (a retry after the
	// writer COMMITs succeeds), not an environment failure. Falling through to
	// internal(500) made the frontend show "the service may not be running" —
	// flatly wrong.
	if (msg.includes("database is locked") || msg.includes("database table is locked")) {
		return fail(409, "conflict", "记忆库正被另一个进程写入，请稍后重试。");
	}
	// A registered db deleted (or turned into a directory) underneath us. The
	// registry throws a NAMED error, so match on the class — never on message
	// text (D1 made `reason`/`path` readonly fields for exactly this).
	// ⚠️ Keep this before the trailing `internal` fallback, or it degrades
	//    silently into a 500.
	if (error instanceof DbUnavailableError) {
		switch (error.reason) {
			// Registration-time path-form rejection: the user picked a path we will
			// not register (a hardlinked file — it would alias a db elsewhere on
			// disk). That is a 400 on the submitted request, not a broken db.
			case "hardlink":
				return fail(400, "bad_request", `该路径不被接受：${error.message}`);
			// An already-registered db that went bad under us: a resource-state
			// problem, so 409 like every other invalid_db.
			case "not-a-file":
				return fail(409, "invalid_db", `该路径已不是一个文件：${error.path}`);
			case "path-escalated":
				return fail(409, "invalid_db", `该路径不在允许的 roots 内：${error.path}`);
			case "missing":
				return fail(409, "invalid_db", `记忆库文件已不存在：${error.path}`);
			// Exhaustive by construction: a new reason without a case here is a
			// compile error, not a silent fall-through to "file missing".
			default: {
				const unreachable: never = error.reason;
				return fail(500, "internal", `未处理的记忆库错误：${String(unreachable)}`);
			}
		}
	}
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

	const items = candidates.map((n) =>
		toTreeNodeDTO(n, childCount.get(n.node_id) ?? 0, vis.isShadowed(n.node_id), store.effectiveDisclosure(n.uri)),
	);
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
	// ⭐ The request uri is kept as the ENTRY scope: `resolveUri` may land on
	//    another node (it resolves aliases), but "which address did the caller
	//    come in through" is what its `disclosure` must answer. Dropping this
	//    would make the node page silently report the canonical entry's
	//    condition for every alias, i.e. the whole per-entry dimension invisible.
	const requestedUri = uri;
	const node = store.resolveUri(requestedUri);
	if (!node) return notFound(`未找到：${uri}`);
	const vis = visibilityFor(rc.ctx);
	return {
		status: 200,
		body: toNodeResponseDTO(store, node, {
			isShadowed: vis.isShadowed,
			childCount: buildChildCounts(store),
			entryUri: requestedUri,
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
				// ⭐ D2 ruling (b) / D1 §3-M7 #12: the SINGLE read entry for the whole
				//    site. Value-identical to `item.disclosure` (search candidates are
				//    canonical uris), but routing it here means a future alias-semantics
				//    change cannot silently leave the search page behind.
				disclosure: store.effectiveDisclosure(item.uri),
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
	// ⭐ F4-B (plan/memory-web-redesign/03 §10.3): the session picker shows a
	// first-message digest. ONE batched lookup over the already-indexed
	// `first_raw_id`s — never a correlated GROUP BY subquery, which would scan
	// a large raw_log once per session. substr(120) up front so that after
	// whitespace folding there is still ≥80 chars of substance to cut.
	const textById = new Map<number, string>();
	const firstIds = rows.map((r) => Number(r.first_raw_id));
	for (let i = 0; i < firstIds.length; i += 500) {
		const chunk = firstIds.slice(i, i + 500);
		const placeholders = chunk.map(() => "?").join(",");
		const textRows = rc.ctx.store.db
			.prepare(`SELECT raw_id, substr(text, 1, 120) AS head FROM raw_log WHERE raw_id IN (${placeholders})`)
			.all(...chunk) as Array<{ raw_id: number; head: string | null }>;
		for (const t of textRows) {
			if (t.head !== null) textById.set(Number(t.raw_id), t.head);
		}
	}
	const items: SessionDTO[] = rows.map((r) => {
		const head = textById.get(Number(r.first_raw_id));
		return {
			session_id: r.session_id,
			total: Number(r.total),
			active: Number(r.active),
			first_raw_id: Number(r.first_raw_id),
			last_raw_id: Number(r.last_raw_id),
			wall_first: r.wall_first,
			wall_last: r.wall_last,
			first_text: head === undefined ? null : contentHead(head, 80),
		};
	});
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
		items: tempNodes.map((n) =>
			toTreeNodeDTO(n, childCount.get(n.node_id) ?? 0, vis.isShadowed(n.node_id), store.effectiveDisclosure(n.uri)),
		),
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

// ── Graph (plan/memory-web-redesign/04-图谱.md §2) ──────────────────────────

const GRAPH_LIMIT = { min: 1, max: 500, def: 200 };

/**
 * GET /api/graph — two modes off one endpoint (contract §4):
 *   no `domain`        → domain listing (mode:"domains"), the pick-a-domain step;
 *   non-empty `domain` → one domain's nodes/edges/aliases (mode:"graph").
 *
 * Read-only inline SQL is the established routes-layer practice (§16.6; the
 * file header, `getMeta`'s counts, `export()`'s full edge read). The joins the
 * graph needs (parent_id→uri, the set form of the dead-alias predicate, the
 * resolveUri precedence as two Maps) have no store method, and adding one-off
 * read-model queries to the long-lived store API would be worse — so they live
 * here, one thin-column pass each, joined in JS. No N+1: nothing here loops
 * over nodes issuing per-node queries.
 */
function getGraph(rc: RequestCtx): HandlerResult {
	const { store } = rc.ctx;
	const sp = rc.url.searchParams;
	const worldTime = store.getWorldTime();

	// ── Mode 1: domain listing (no domain) ────────────────────────────────
	const domain = sp.get("domain");
	if (domain === null || domain === "") {
		// Per-domain node counts in one GROUP BY (listDomains() is DISTINCT-only).
		const nodeRows = store.db
			.prepare("SELECT domain, COUNT(*) AS c FROM nodes GROUP BY domain ORDER BY domain")
			.all() as Array<{ domain: string; c: number }>;
		// edges has no domain column — an edge's domain is its SOURCE node's.
		const edgeRows = store.db
			.prepare(
				"SELECT n.domain AS domain, COUNT(*) AS c FROM edges e JOIN nodes n ON n.node_id = e.node_id GROUP BY n.domain",
			)
			.all() as Array<{ domain: string; c: number }>;
		const edgeByDomain = new Map(edgeRows.map((r) => [r.domain, Number(r.c)]));
		const body: GraphDomainsDTO = {
			mode: "domains",
			world_time: worldTime,
			domains: nodeRows.map((r) => ({
				domain: r.domain,
				node_count: Number(r.c),
				edge_count: edgeByDomain.get(r.domain) ?? 0,
			})),
		};
		return { status: 200, body };
	}

	// ── Mode 2: graph (with domain) ──────────────────────────────────────
	const limit = intOrThrow(sp, "limit", GRAPH_LIMIT);

	// ① One light full-table index pass (node_id/uri/parent_id — never the fat
	//    content column), three uses:
	//    a) parent_id → uri (parent_uri without per-node parentUriOf N+1);
	//    b) the live-uri set — the set form of aliasListStmt's shadow JOIN,
	//       i.e. the dead-alias predicate;
	//    c) uri → node_id, the CANONICAL resolver — resolveUri's first
	//       precedence (nodes.uri wins over aliases).
	const indexRows = store.db.prepare("SELECT node_id, uri, parent_id FROM nodes").all() as Array<{
		node_id: string;
		uri: string;
		parent_id: string | null;
	}>;
	const uriOf = new Map(indexRows.map((r) => [r.node_id, r.uri]));
	const nodeIdOf = new Map(indexRows.map((r) => [r.uri, r.node_id]));

	// ② This domain's nodes, then importance DESC / uri ASC before cutting:
	//    truncation must drop the least important first (radius ∝ importance,
	//    so what stays is what matters), and the uri tiebreak keeps the cut
	//    boundary stable across requests so memory:changed hot refreshes do
	//    not shuffle which points are on screen.
	const domainNodes = store.listNodes({ domain });
	domainNodes.sort((a, b) => b.importance - a.importance || (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0));
	const nodes = domainNodes.slice(0, limit);
	const inSet = new Set(nodes.map((n) => n.node_id));

	// ③ Alias thin columns — the SECOND resolver precedence.
	const aliasRows = store.db.prepare("SELECT alias_uri, target_node_id FROM aliases").all() as Array<{
		alias_uri: string;
		target_node_id: string;
	}>;
	const aliasIdOf = new Map(aliasRows.map((r) => [r.alias_uri, r.target_node_id]));

	// ④ Full edge read (export()'s SQL), classified against the truncated set.
	const edgeRows = store.db
		.prepare("SELECT node_id, target_uri, kind FROM edges ORDER BY node_id, target_uri")
		.all() as Array<{ node_id: string; target_uri: string; kind: string | null }>;
	const edges: GraphEdgeDTO[] = [];
	for (const row of edgeRows) {
		if (!inSet.has(row.node_id)) continue; // source outside this domain's cut set
		// resolveUri precedence: nodes.uri first, aliases second.
		const target = nodeIdOf.get(row.target_uri) ?? aliasIdOf.get(row.target_uri) ?? null;
		if (target === null) {
			edges.push(toGraphEdgeDTO(row, null)); // dangling: nothing resolves
		} else if (inSet.has(target)) {
			edges.push(toGraphEdgeDTO(row, target)); // in-domain edge
		}
		// else: resolves OUTSIDE the set (a cross-domain node, or a same-domain
		// node cut by limit) → not drawn. An edge to a missing endpoint would
		// blur `dangling`'s meaning (which is reserved for truly dead targets).
	}

	// ⑤ Aliases pinned to nodes that made the cut; the dead predicate is the
	//    set form of aliasListStmt's: alias_uri is ALSO a live nodes.uri.
	const aliases = aliasRows
		.filter((r) => inSet.has(r.target_node_id))
		.map((r) => toGraphAliasDTO(r, nodeIdOf.has(r.alias_uri)));

	const body: GraphDataDTO = {
		mode: "graph",
		world_time: worldTime,
		domain,
		total_nodes: domainNodes.length,
		truncated: domainNodes.length > nodes.length,
		nodes: nodes.map((n) => toGraphNodeDTO(n, n.parent_id ? (uriOf.get(n.parent_id) ?? null) : null)),
		edges,
		aliases,
	};
	return { status: 200, body };
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
	// ⚠️ `""` MUST be normalized HERE (not only in the client): `edit.js` already
	//    maps empty → null, but the HTTP surface cannot rely on clients being
	//    well-behaved — curl and future clients bypass it. A stored `''` would
	//    make `effectiveDisclosure` treat it as a real value, permanently cutting
	//    the `??` inheritance, and `discBadge("")` renders nothing ⇒ invisible.
	const node = store.put({
		uri,
		content,
		disclosure: normalizeDisclosure(obj.disclosure),
		importance: numField(obj, "importance") ?? undefined,
		source: "manual",
		model: null,
	});
	return nodeResponse(rc, node);
}

/**
 * ⭐ Route-layer `""` → `null` normalization (frozen §8.2 / D1 §7.5). The store
 * only accepts `string | null | undefined`; `undefined` means "do not touch".
 * Non-string, non-null input is also "do not touch" — matching the pre-existing
 * lenient behaviour for unrecognized JSON types.
 */
function normalizeDisclosure(value: unknown): string | null | undefined {
	if (typeof value !== "string") return value === null ? null : undefined;
	return value === "" ? null : value;
}

function postRevise(rc: RequestCtx): HandlerResult {
	const obj = asObject(rc.body);
	if (!obj) return badRequest("请求体必须是 JSON 对象");
	const uri = strField(obj, "uri");
	if (!uri) return badRequest("缺少必需参数：uri");
	const { store } = rc.ctx;
	const node = store.resolveUri(uri);
	if (!node) return notFound(`未找到：${uri}`);

	// ⭐ `disclosure` is SPLIT OFF from the node patch (frozen §8.2 / D1 §3-M4):
	//    it is an ENTRY-level field, written through `setEntryDisclosure`, which
	//    resolves to the layer this uri STRUCTURALLY denotes (alias row vs node
	//    column). Folding it into `updateNode` would always hit `nodes.disclosure`
	//    ⇒ editing from an alias entry would silently overwrite the condition
	//    shared by the canonical entry and every other alias.
	const patch: {
		content?: string;
		importance?: number;
		world_ts?: string | null;
		editor_source: "manual";
		editor_model: null;
	} = { editor_source: "manual", editor_model: null };
	if (typeof obj.content === "string") patch.content = obj.content as string;
	const disclosure = normalizeDisclosure(obj.disclosure);
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
		disclosure === undefined &&
		patch.importance === undefined &&
		patch.world_ts === undefined
	) {
		return badRequest("至少需要一个可改字段：content / disclosure / importance / world_ts");
	}

	// `setEntryDisclosure` throws on an unknown uri, but `resolveUri` above has
	// already guaranteed the uri exists — the throw is unreachable here.
	if (disclosure !== undefined) store.setEntryDisclosure(uri, disclosure);
	const version = store.updateNode(node.node_id, patch);
	const response = nodeResponse(rc, store.getNode(node.node_id) ?? node, uri);
	return { ...response, body: { ...(response.body as object), version } };
}

function nodeResponse(rc: RequestCtx, node: MemoryNode, entryUri?: string): HandlerResult {
	const vis = visibilityFor(rc.ctx);
	return {
		status: 200,
		body: toNodeResponseDTO(rc.ctx.store, node, {
			isShadowed: vis.isShadowed,
			childCount: buildChildCounts(rc.ctx.store),
			entryUri,
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

// ── Multi-database (plan/memory-web/13-多库服务端API.md) ────────────────────

/**
 * Short display name for a db id. A pure function: the same path always yields
 * the same label (no global counter), so it cannot perturb sort determinism.
 * Three steps:
 *   ① drop the trailing `memory.db` (the db's filename, always the last segment).
 *   ② drop EVERY structural segment `.pi` / `characters` — they appear at ANY
 *      depth, they are not a trailing suffix. Stripping them as a suffix does
 *      not work: `…/characters/elias/.pi/memory.db` keeps `characters` forever
 *      because the tail after `.pi` is `…/characters/elias`.
 *   ③ prefer what follows `worlds/`; else go `~`-relative to home; else literal.
 */
export function labelOf(absPath: string): string {
	const resolved = path.resolve(absPath);
	const parts = resolved.split(path.sep).filter(Boolean);
	if (parts.length > 0 && parts[parts.length - 1] === "memory.db") parts.pop();
	const kept = parts.filter((segment) => segment !== ".pi" && segment !== "characters");
	const worldsAt = kept.lastIndexOf("worlds");
	if (worldsAt >= 0 && worldsAt < kept.length - 1) return kept.slice(worldsAt + 1).join("/");
	// The display separator is `/` on purpose (a UI string, never path math).
	const stem = (resolved.startsWith(path.sep) ? path.sep : "") + kept.join(path.sep);
	const home = homedir();
	if (stem === home) return "~";
	if (stem.startsWith(`${home}${path.sep}`)) return `~${stem.slice(home.length)}`;
	return stem;
}

/** Contract §4.3: registered first → node_count desc → path asc. MUST be a pure function. */
function compareDatabases(a: DatabaseDTO, b: DatabaseDTO): number {
	if (a.registered !== b.registered) return a.registered ? -1 : 1;
	// `null` (unreachable) sorts after every number: it means "unknown", not "zero".
	const an = a.node_count ?? -1;
	const bn = b.node_count ?? -1;
	if (an !== bn) return bn - an;
	// String comparison, NOT localeCompare: ICU/locale would break determinism.
	return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

const MANAGEMENT_PATHS = new Set(["/api/databases", "/api/databases/open", "/api/databases/create"]);
const MGMT_DISABLED_MESSAGE = "多库功能只在回环绑定下可用（当前 --host 不是 127.0.0.1 / ::1 / localhost）。";

/**
 * Lazily built registry for a `ServerContext` that carries none (existing tests
 * / single-db usage). MUST be treated as a compatibility shim, NOT the main
 * path: `cli.ts` passes a real `registry` in production, so this WeakMap never
 * participates there.
 *
 * - The key is the `ctx` object, which `startServer` holds for the whole server
 *   lifetime, so one server builds exactly one registry.
 * - It adopts the process db: without that, `?db=<process db>` would 404.
 * - ⚠️ `:memory:` / `""` MUST be skipped: the registry normalizes keys and
 *   rejects those, which would turn EVERY request into a 500.
 */
const fallbackRegistries = new WeakMap<ServerContext, StoreRegistry>();

/** `:memory:` and the empty path are not registrable db paths. */
function isRegistrable(pathValue: string): boolean {
	return pathValue !== "" && pathValue !== ":memory:";
}

function registryOf(ctx: ServerContext): StoreRegistry {
	if (ctx.registry) return ctx.registry;
	let registry = fallbackRegistries.get(ctx);
	if (!registry) {
		registry = new StoreRegistry({
			// The registry's `policy` is required (fail-closed). Bare tests have no
			// policy to speak of, so fall back to the same default as the CLI.
			policy: ctx.pathPolicy ?? { roots: [process.cwd()], allowAnyPath: false },
		});
		if (isRegistrable(ctx.dbPath)) registry.adopt(ctx.dbPath, ctx.store);
		fallbackRegistries.set(ctx, registry);
	}
	return registry;
}

/** Whether `candidate` is the process db itself (the non-loopback gate + bare-test guard). */
function isProcessDb(ctx: ServerContext, candidate: string): boolean {
	if (!isRegistrable(ctx.dbPath)) return false;
	return candidate === path.resolve(ctx.dbPath);
}

/**
 * Resolve `?db=` into the `ServerContext` for this request (contract §3.3).
 * - No switch (absent / empty string / management route) ⇒ the returned `ctx`
 *   is REFERENCE-EQUAL to the argument and `entry === null`.
 * - Hit ⇒ a NEW context plus that entry; the caller MUST `release(entry)` in a
 *   `finally` so the entry survives LRU eviction for the request's duration.
 * - Miss ⇒ a `HandlerResult` ready to `send` (404). An entry that is registered
 *   but whose file vanished THROWS `DbUnavailableError`, which the outer
 *   `dispatch` catch funnels through `mapStoreError` (§8.3).
 */
async function resolveTargetContext(
	ctx: ServerContext,
	url: URL,
): Promise<{ ok: true; ctx: ServerContext; entry: StoreEntry | null } | { ok: false; result: HandlerResult }> {
	// Management routes MUST stay inert: the frontend's HTTP layer appends ?db= to
	// EVERY request, so erroring here would break "list the dbs" right after a switch.
	if (MANAGEMENT_PATHS.has(url.pathname)) return { ok: true, ctx, entry: null };

	const raw = url.searchParams.get("db");
	// Absent and empty are both equivalent to the process db. The empty string
	// returns BEFORE `path.resolve`: `resolve("")` is cwd and must never be used
	// as a lookup key.
	if (raw === null || raw === "") return { ok: true, ctx, entry: null };

	// `?db=` is a LOOKUP KEY. Normalize first, then query the registry; the
	// normalized value is never handed to `openMemoryStore`.
	const candidate = path.resolve(raw);

	// Non-loopback bind ⇒ multi-db is off entirely: only the process db passes.
	// ⚠️ This MUST be explicit. The registry's CONTENT depends on whether the
	//    user ever clicked "open", not on `--host`, so "the registry happens to
	//    hold only the process db" is a coincidence, not an invariant.
	// ⚠️ Gate on the CLI's --host (ctx.bindHost); S2 guarantees the request's
	//    Host header is loopback, so using it would make this branch never true.
	if (!multiDbEnabled(ctx.bindHost ?? "127.0.0.1") && !isProcessDb(ctx, candidate)) {
		// The message must say WHY (non-loopback) without revealing whether the
		// path is registered: the two 404 branches must stay indistinguishable on
		// registry content, or a network visitor could enumerate the registry.
		return { ok: false, result: notFound(`未注册的记忆库：${candidate}（非回环绑定下只能访问进程库）`) };
	}

	const entry = await registryOf(ctx).resolve(candidate);
	if (!entry) {
		// Unregistered ⇒ 404, and this file was never touched.
		return { ok: false, result: notFound(`未注册的记忆库：${candidate}（请先在「记忆库」页选择或打开它）`) };
	}
	// Only store / dbPath change: every other field is process-level, so letting
	// it vary per db would be a bug.
	return { ok: true, ctx: { ...ctx, store: entry.store, dbPath: candidate }, entry };
}

function policyOf(ctx: ServerContext): PathPolicy {
	return ctx.pathPolicy ?? { roots: [process.cwd()], allowAnyPath: false };
}

/**
 * `ProbeOutcome` → response (§4.3.1). The four 400 messages prefix the reason
 * the D1 probe already rendered in human terms; `incompatible` is NOT a form
 * error (the path and db are fine, only the version differs) so it is the
 * pre-existing `invalid_db`(409) — the same code the store path already emits
 * for version skew, so the frontend needs one message.
 *
 * ⭐ `incompatible` now covers ONLY versions with no in-place migrator (frozen
 * §8.5 / D3 §8.5): an older-but-migratable db is ADMITTED by the probe and
 * upgraded by the write-open path, so it never reaches this branch.
 */
function probeFailure(outcome: ProbeOutcome & { ok: false }): HandlerResult {
	const { reason, detail } = outcome;
	if (reason === "incompatible") return fail(409, "invalid_db", detail);
	return badRequest(detail);
}

/** open / create share one response shape so the frontend renders both the same way. */
function openedBody(input: {
	path: string;
	nodeCount: number;
	worldTime: string | null;
	created: boolean;
	alreadyRegistered: boolean;
}): DatabaseOpenedDTO {
	return {
		path: input.path,
		label: labelOf(input.path),
		registered: true,
		reachable: true,
		node_count: input.nodeCount,
		world_time: input.worldTime,
		created: input.created,
		already_registered: input.alreadyRegistered,
	};
}

async function getDatabases(rc: RequestCtx): Promise<HandlerResult> {
	const { ctx } = rc;
	const policy = policyOf(ctx);
	const registry = registryOf(ctx);
	const registered = registry.list();
	// Discovery is the ONLY thing a non-loopback bind suppresses, and this
	// endpoint is the only discovery entry point — so gating it here is enough.
	const found = await discoverMemoryDbs(policy.roots);

	// Union, deduped by path. Discovered entries go in first, then the registry
	// OVERWRITES them as registered — the registry always wins, because it means
	// "the user explicitly opened this".
	const seen = new Map<string, DatabaseDTO>();
	for (const p of found.paths) {
		// The discovery baseline: discovered but not yet registered, and not yet
		// counted. The stats pass below overwrites this for every reachable db.
		seen.set(p, toUnreachableDatabaseDTO(p, labelOf(p), "尚未打开（未注册）。"));
	}
	for (const db of registered) {
		seen.set(
			db.path,
			toDatabaseDTO({
				path: db.path,
				label: labelOf(db.path),
				registered: true,
				nodeCount: null,
				worldTime: null,
				error: null,
			}),
		);
	}
	// The process db is a registered db BY DEFINITION, not as a patch: `cli.ts`
	// adopts it at startup, so this only matters for bare contexts.
	if (isRegistrable(ctx.dbPath)) {
		const processPath = path.resolve(ctx.dbPath);
		seen.set(
			processPath,
			toDatabaseDTO({
				path: processPath,
				label: labelOf(processPath),
				registered: true,
				nodeCount: null,
				worldTime: null,
				error: null,
			}),
		);
	}

	// Fill counters. Already-open dbs come free from their own connection;
	// unopened ones go through the discovery layer's cached read-only probe.
	// ⚠️ MUST NOT `registry.resolve()` here: that would lazy-open every
	//    discovered db, blowing past the LRU cap just to render a list.
	const databases = await Promise.all(
		[...seen.values()].map(async (record) => {
			const open = registry.entryOf(record.path);
			if (open) {
				return toDatabaseDTO({
					path: record.path,
					label: record.label,
					registered: record.registered,
					nodeCount: open.store.listNodes().length,
					worldTime: open.store.getWorldTime(),
					// A connection we hold reads as reachable; an external delete
					// surfaces on the next real request as invalid_db. Listing must
					// not manufacture a failure the user would blame on the page.
					error: null,
				});
			}
			// Unopened: a read-only probe via the discovery layer. Registered dbs
			// that lie outside the roots land here too — registration does not
			// exempt them from being counted.
			const stats = await readMemoryDbStats(record.path);
			if (stats) {
				return toDatabaseDTO({
					path: record.path,
					label: record.label,
					registered: record.registered,
					nodeCount: stats.nodeCount,
					worldTime: stats.worldTime,
					error: null,
				});
			}
			// ⚠️ `node_count: null`, NEVER 0: zero is the meaningful state "empty
			//    db", and conflating the two leaves the UI unable to tell them apart.
			// The reason comes from the probe, which already renders it in human
			// terms (path + errno); this layer only re-labels it.
			const probed = await probeMemoryDb(record.path);
			return toDatabaseDTO({
				path: record.path,
				label: record.label,
				registered: record.registered,
				nodeCount: null,
				worldTime: null,
				error: probed.ok ? "无法读取该记忆库的统计信息。" : probed.detail,
			});
		}),
	);
	databases.sort(compareDatabases);

	const body: DatabasesDTO = {
		current: isRegistrable(ctx.dbPath) ? path.resolve(ctx.dbPath) : ctx.dbPath,
		databases,
		roots: policy.allowAnyPath ? [] : policy.roots,
		discovery: toDiscoveryMetaDTO(multiDbEnabled(ctx.bindHost ?? "127.0.0.1"), found.scanned, found.errors),
	};
	return { status: 200, body };
}

/**
 * Register a path the user pointed at. Order is load-bearing (contract §5.2
 * R1): path policy → read-only probe → register. NO write may occur between the
 * probe and the registration — the probe is the single gate that keeps
 * `openMemoryStore` from flood-table-ing a stranger's SQLite file.
 */
async function postDatabasesOpen(rc: RequestCtx): Promise<HandlerResult> {
	const obj = asObject(rc.body);
	const raw = obj ? strField(obj, "path") : null;
	if (!raw) return badRequest("缺少必需参数：path");

	const allowed = checkPathAllowed(policyOf(rc.ctx), raw);
	if (!allowed.ok) return badRequest(allowed.detail);

	const outcome = await probeMemoryDb(allowed.path);
	if (!outcome.ok) return probeFailure(outcome);

	const registry = registryOf(rc.ctx);
	const alreadyRegistered = registry.has(allowed.path);
	const entry = await registry.register(allowed.path);
	return {
		status: 200,
		body: openedBody({
			path: allowed.path,
			nodeCount: entry.store.listNodes().length,
			worldTime: entry.store.getWorldTime(),
			created: false,
			alreadyRegistered,
		}),
	};
}

/**
 * Create a NEW empty db. `confirm: true` must be explicit (strict `=== true`):
 * silently creating a db turns a typo into a mystery file.
 *
 * The ordering exists because `openMemoryStore` does NOT validate a stranger's
 * SQLite file — it just adds tables (contract §2.3). So an existing path must be
 * refused outright, and the placeholder is created with `wx` to close the
 * check-then-create window.
 */
async function postDatabasesCreate(rc: RequestCtx): Promise<HandlerResult> {
	const obj = asObject(rc.body);
	const raw = obj ? strField(obj, "path") : null;
	if (!raw) return badRequest("缺少必需参数：path");
	if (obj?.confirm !== true) return badRequest("新建记忆库需要 `confirm: true` 显式确认");

	const allowed = checkPathAllowed(policyOf(rc.ctx), raw);
	if (!allowed.ok) return badRequest(allowed.detail);
	const target = allowed.path;

	// MUST NOT `mkdir -p`: that turns one typo into a directory tree.
	try {
		if (!statSync(path.dirname(target)).isDirectory()) {
			return badRequest(`父目录不存在：${path.dirname(target)}`);
		}
	} catch {
		return badRequest(`父目录不存在：${path.dirname(target)}`);
	}
	// create NEVER overwrites anything, of any type.
	try {
		statSync(target);
		return fail(409, "conflict", "该路径已存在，若要使用它请点「打开」。");
	} catch {
		/* does not exist — the expected case */
	}
	// Atomic placeholder. Zero bytes is a legal empty SQLite db, so nothing else
	// is needed; `wx` makes a concurrent creator lose with EEXIST.
	try {
		writeFileSync(target, "", { flag: "wx" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			return fail(409, "conflict", "该路径已存在，若要使用它请点「打开」。");
		}
		return mapStoreError(error, {});
	}

	let store: MemoryStore | null = null;
	try {
		store = await openMemoryStore(target);
	} catch (error) {
		// Best-effort cleanup: only remove a file that is still the 0-byte
		// placeholder, and never let cleanup failures mask the original error.
		try {
			if (statSync(target).size === 0) unlinkSync(target);
		} catch {
			/* leave it */
		}
		return mapStoreError(error, {});
	}
	// ⚠️ Close the creation connection BEFORE registering. `register` opens its
	//    own connection (it takes no store — `adopt` does, and must not be used
	//    here: adopt pins the connection so it is never evicted or closed, i.e.
	//    an fd leak). Leaving this one open would leave TWO live connections on
	//    one path, breaking "one path, one store" and desyncing the change
	//    detector, with nobody holding the second.
	try {
		store.db.close();
	} catch {
		/* already closed */
	}

	// ⚠️ `register`, NOT `adopt`: a created db has no reason to be pinned.
	const entry = await registryOf(rc.ctx).register(target);
	// Counters come from the ENTRY's store — the creation handle above is closed.
	return {
		status: 200,
		body: openedBody({
			path: target,
			nodeCount: entry.store.listNodes().length,
			worldTime: entry.store.getWorldTime(),
			created: true,
			alreadyRegistered: false,
		}),
	};
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
	{ method: "GET", path: "/api/graph", handler: getGraph },
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
	// Management routes are appended (not interleaved) so `git diff` shows the
	// existing 21 rows as untouched: +3 -0.
	{ method: "GET", path: "/api/databases", handler: getDatabases },
	{ method: "POST", path: "/api/databases/open", handler: postDatabasesOpen },
	{ method: "POST", path: "/api/databases/create", handler: postDatabasesCreate },
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
		const samePath = ROUTES.filter((r) => r.path === url.pathname);

		// S4: a non-loopback bind disables all three management routes. The gate
		// reads the CLI's --host (ctx.bindHost) — S2 has already guaranteed the
		// request's Host header is loopback, so gating on that would be dead code.
		// ⚠️ Before `ROUTES.find`: otherwise `POST /api/databases` (GET-only in the
		//    table) would trip 405 first, both leaking that the path exists and
		//    letting "disabled entirely" fall through.
		if (MANAGEMENT_PATHS.has(url.pathname) && !multiDbEnabled(ctx.bindHost ?? "127.0.0.1")) {
			return send(res, fail(403, "forbidden_origin", MGMT_DISABLED_MESSAGE), headers);
		}
		// 405 MUST precede target resolution: otherwise
		// `DELETE /api/node?db=<unregistered>` would drift from 405 to 404 — a
		// multi-db-unrelated semantic change that existing tests pin.
		if (!route && samePath.length > 0) {
			const allow = [...new Set(samePath.map((r) => r.method))].join(", ");
			return send(res, fail(405, "method_not_allowed", `路径 ${url.pathname} 不支持方法 ${method}`), {
				...headers,
				Allow: allow,
			});
		}

		if (route) {
			// ⭐ `entry`'s lifetime: `resolve` raises the refcount, so this entry
			// cannot be LRU-evicted while the request runs; `release` in the
			// `finally` drops it again.
			let entry: StoreEntry | null = null;
			try {
				const target = await resolveTargetContext(ctx, url);
				if (!target.ok) return send(res, target.result, headers);
				entry = target.entry;
				const body = req.method === "POST" ? await readJsonBody(req) : undefined;
				const result = await route.handler({ req, url, ctx: target.ctx, body });
				return send(res, result, headers, method === "HEAD");
			} catch (error) {
				if (error instanceof BadParam) return send(res, badRequest(error.message), headers);
				return send(res, mapStoreError(error, {}), headers);
			} finally {
				// `entry === null` for the default ?db= (the process db is adopted,
				// so it is not inside the LRU) — never call release on a non-entry.
				// ⚠️ Use the ORIGINAL ctx: the registry is process-level, and a
				//    stable WeakMap key matters for the lazy fallback.
				if (entry) registryOf(ctx).release(entry);
			}
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
