/**
 * `/api/*` contract tests (plan/memory-web/01-服务端与API.md §验收测试 A/C).
 *
 * Real SQLite: an in-memory store seeded per test, driven through a real HTTP
 * server on an ephemeral port. Write paths assert the FACTS they must leave
 * behind (audit rows, revision rows), not just the response shape.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openMemoryStore } from "../../src/index.ts";
import type { MemoryStore } from "../../src/store.ts";
import { buildTempNotifyContent } from "../../src/temp-notify.ts";
import { ERROR_CODES, type HandlerResult, mapStoreError, ROUTES } from "../../src/web/routes.ts";
import { type RunningServer, startServer } from "../../src/web/server.ts";

const CONTRACT_CODES = [
	"bad_request",
	"not_found",
	"method_not_allowed",
	"forbidden_origin",
	"invalid_db",
	"conflict",
	"internal",
];

// ── response typing ─────────────────────────────────────────────────────────

interface ApiErrorBody {
	error: { code: string; message: string };
}

interface ApiResult<T> {
	status: number;
	body: T & Partial<ApiErrorBody>;
	headers: Headers;
}

interface MetaBody {
	world_time: string | null;
	domains: string[];
	counts: { nodes: number; stubs: number; raw_total: number; raw_active: number; temp: number };
	thresholdSource: string;
}

interface TreeNode {
	uri: string;
	child_count: number;
	has_children: boolean;
	content_head: string;
	/** ⭐ 边级 disclosure 轨：入口作用域的生效想起条件（可空）。 */
	disclosure: string | null;
}

interface TreeBody {
	items: TreeNode[];
	total: number;
	limit: number;
	offset: number;
	parent_uri: string | null;
}

interface EdgeShape {
	direction: string;
	node_id: string;
	uri: string | null;
	resolved_uri: string | null;
	dangling: boolean;
	/** ⭐ 裸 `edges.disclosure`（**不是** effectiveDisclosure——边不是可寻址入口）。 */
	disclosure: string | null;
}

interface NodeBody {
	current_version: number;
	version: number;
	node: { uri: string; node_id: string; is_stub: boolean; shadowed: boolean; [key: string]: unknown };
	path: Array<{ node_id: string; uri: string }>;
	children: TreeNode[];
	revisions: Array<{ editor_source: string | null; editor_model: string | null }>;
	aliases: Array<{ alias_uri: string; target_node_id: string; disclosure: string | null; dead: boolean }>;
	edges: { outgoing: EdgeShape[]; incoming: EdgeShape[] };
	glossary: Array<{ keyword: string; uri: string | null }>;
}

interface SearchBody {
	items: Array<Record<string, unknown> & { uri: string; importance: number | null; score: number }>;
	total: number;
	mode: string;
}

interface RawItem {
	raw_id: number;
	active: number;
}

interface RawBody {
	items: RawItem[];
	total: number;
	totalAll: number;
	before: number | null;
}

interface SessionsBody {
	items: Array<{
		session_id: string;
		total: number;
		active: number;
		first_raw_id: number;
		last_raw_id: number;
		first_text: string | null;
	}>;
	total: number;
}

interface TempBody {
	count: number;
	count_all: number;
	threshold: number;
	thresholdSource: string;
	notifyPreview: string;
}

interface AuditBody {
	items: Array<{ id: number }>;
}

interface RevisionsBody {
	items: Array<
		Record<string, unknown> & { node_id: string; editor_source: string | null; editor_model: string | null }
	>;
}

interface EventsBody {
	version: number;
	changed: boolean;
}

interface ViewBody {
	items: RawItem[];
}

interface ListBody {
	items: Array<{ raw_id: number }>;
}

// ── Graph (plan/memory-web-redesign/04-图谱.md §2) ──────────────────────────

interface GraphDomainsBody {
	mode: "domains";
	world_time: string | null;
	domains: Array<{ domain: string; node_count: number; edge_count: number }>;
}

interface GraphNodeItem {
	node_id: string;
	uri: string;
	domain: string;
	importance: number;
	is_stub: boolean;
	label: string;
	parent_uri: string | null;
}

interface GraphEdgeItem {
	source_id: string;
	target_id: string | null;
	kind: string | null;
	dangling: boolean;
	target_uri: string;
}

interface GraphAliasItem {
	alias_uri: string;
	target_node_id: string;
	dead: boolean;
}

interface GraphDataBody {
	mode: "graph";
	world_time: string | null;
	domain: string;
	total_nodes: number;
	truncated: boolean;
	nodes: GraphNodeItem[];
	edges: GraphEdgeItem[];
	aliases: GraphAliasItem[];
}

// ── harness ─────────────────────────────────────────────────────────────────

let store: MemoryStore;
let server: RunningServer;
let assets: string;
let workdir: string;
const observedCodes = new Set<string>();

function errorOf(body: Partial<ApiErrorBody>): { code: string; message: string } {
	if (!body.error) throw new Error("expected an error body");
	return body.error;
}

async function boot(databasePath = ""): Promise<void> {
	store = await openMemoryStore(databasePath);
	store.seed();
	server = await startServer(
		{
			store,
			dbPath: databasePath || ":memory:",
			assetsDir: assets,
			tempThreshold: 10,
			tempThresholdSource: "default",
			startedAt: new Date().toISOString(),
		},
		{ port: 0, host: "127.0.0.1" },
	);
}
/**
 * Raw `node:http` rather than `fetch`: undici refuses to send a caller-set
 * `Host`/`Origin`, and the security checks are exactly what several cases
 * exercise, so the harness must be able to lie about both.
 */
async function request<T>(
	pathname: string,
	init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<ApiResult<T>> {
	const url = new URL(server.url);
	const { promise, resolve, reject } = Promise.withResolvers<{
		status: number;
		headers: Headers;
		text: string;
	}>();
	const req = httpRequest(
		{
			hostname: url.hostname,
			port: url.port,
			path: encodeURI(pathname),
			method: init.method ?? "GET",
			headers: init.headers,
		},
		(res) => {
			const chunks: Buffer[] = [];
			res.on("data", (chunk: Buffer) => chunks.push(chunk));
			res.on("end", () => {
				const headers = new Headers();
				for (const [key, value] of Object.entries(res.headers)) {
					if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
				}
				resolve({ status: res.statusCode ?? 0, headers, text: Buffer.concat(chunks).toString("utf8") });
			});
		},
	);
	req.on("error", reject);
	if (init.body !== undefined) req.write(init.body);
	req.end();

	const response = await promise;
	const body = (response.text.startsWith("{") || response.text.startsWith("[") ? JSON.parse(response.text) : {}) as T &
		Partial<ApiErrorBody>;
	if (body.error) observedCodes.add(body.error.code);
	return { status: response.status, body, headers: response.headers };
}

function get<T>(pathname: string): Promise<ApiResult<T>> {
	return request<T>(pathname);
}

function post<T>(pathname: string, payload: unknown, headers: Record<string, string> = {}): Promise<ApiResult<T>> {
	return request<T>(pathname, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: typeof payload === "string" ? payload : JSON.stringify(payload),
	});
}

beforeEach(async () => {
	workdir = mkdtempSync(path.join(tmpdir(), "memweb-"));
	assets = path.join(workdir, "assets");
	mkdirSync(assets, { recursive: true });
	writeFileSync(path.join(assets, "index.html"), "<!doctype html><title>t</title>");
	writeFileSync(path.join(assets, "app.js"), "export const ok = 1;\n");
	await boot();
});

afterEach(async () => {
	await server.close();
	rmSync(workdir, { recursive: true, force: true });
});

function seedTree(): void {
	store.put({ uri: "core://identity", content: "伊莱的身份锚点", importance: 9 });
	store.put({ uri: "core://identity/habits", content: "第一行\n第二行 磨剑的日常", importance: 8 });
	store.put({ uri: "core://identity/habits/tea", content: "傍晚喝茶" });
}

function appendRaw(entries: Array<{ session: string; entry: string; role?: string; text?: string }>): void {
	store.appendRaw(
		entries.map((e, i) => ({
			role: e.role ?? "assistant",
			text: e.text ?? `正文 ${i}`,
			entry_id: e.entry,
			session_id: e.session,
			wall_ts: `2020-01-0${(i % 9) + 1}T00:00:00.000Z`,
		})),
	);
}

// ── Meta & counts ───────────────────────────────────────────────────────────

describe("GET /api/meta", () => {
	it("counts.nodes is bidirectional-equal to listNodes().length", async () => {
		seedTree();
		const { status, body } = await get<MetaBody>("/api/meta");
		expect(status).toBe(200);
		expect(body.counts.nodes).toBe(store.listNodes().length);
	});

	it("counts.stubs equals the is_stub=1 count", async () => {
		// `core://a/b/c` auto-creates two stub ancestors: core://a and core://a/b.
		store.put({ uri: "core://a/b/c", content: "leaf" });
		const stubs = store.listNodes().filter((n) => n.is_stub === 1);
		expect(stubs.map((n) => n.uri).sort()).toEqual(["core://a", "core://a/b"]);
		expect((await get<MetaBody>("/api/meta")).body.counts.stubs).toBe(stubs.length);
	});

	it("counts.raw_active equals COALESCE(SUM(active),0)", async () => {
		appendRaw([
			{ session: "s1", entry: "e1" },
			{ session: "s1", entry: "e2" },
		]);
		store.syncRawBranch("s1", [
			{ role: "assistant", text: "x", entry_id: "e1", session_id: "s1", wall_ts: "2020-01-01T00:00:00.000Z" },
		]);
		const { body } = await get<MetaBody>("/api/meta");
		expect(body.counts.raw_total).toBe(2);
		expect(body.counts.raw_active).toBe(body.counts.raw_total - 1);
	});

	it("world_time is identical to getWorldTime() including null", async () => {
		expect((await get<MetaBody>("/api/meta")).body.world_time).toBe(store.getWorldTime());
		store.setWorldTime("2020-01-02");
		expect((await get<MetaBody>("/api/meta")).body.world_time).toBe("2020-01-02");
	});

	it("domains equals listDomains() in order", async () => {
		seedTree();
		expect((await get<MetaBody>("/api/meta")).body.domains).toEqual(store.listDomains());
	});

	it("uses thresholdSource, not temp_threshold_source", async () => {
		const { body } = await get<MetaBody>("/api/meta");
		expect(body.thresholdSource).toBe("default");
		expect(Object.hasOwn(body, "temp_threshold_source")).toBe(false);
	});
});

// ── Tree ────────────────────────────────────────────────────────────────────

describe("GET /api/tree", () => {
	it("returns exactly the domain-root set", async () => {
		seedTree();
		const { body } = await get<TreeBody>("/api/tree?domain=core");
		const expected = store
			.listNodes({ domain: "core" })
			.filter((n) => n.parent_id === null)
			.map((n) => n.uri);
		expect(new Set(body.items.map((i) => i.uri))).toEqual(new Set(expected));
	});

	it("child_count matches real children() counts", async () => {
		seedTree();
		const { body } = await get<TreeBody>("/api/tree?domain=core&depth=3");
		expect(body.items.length).toBeGreaterThan(0);
		for (const item of body.items) {
			const node = store.resolveUri(item.uri)!;
			expect(item.child_count).toBe(store.children(node.node_id).length);
			expect(item.has_children).toBe(item.child_count > 0);
		}
	});

	it("content_head folds newlines and caps at 60 chars", async () => {
		seedTree();
		const { body } = await get<TreeBody>("/api/tree?parentUri=core://identity");
		const habits = body.items.find((i) => i.uri === "core://identity/habits")!;
		expect(habits.content_head).not.toContain("\n");
		expect(habits.content_head.length).toBeLessThanOrEqual(60);
		store.put({ uri: "core://identity/long", content: "啊".repeat(200) });
		const again = await get<TreeBody>("/api/tree?parentUri=core://identity");
		expect(again.body.items.find((i) => i.uri === "core://identity/long")!.content_head.length).toBe(60);
	});

	it("rejects depth outside 1-3", async () => {
		const { status, body } = await get<TreeBody>("/api/tree?depth=7");
		expect(status).toBe(400);
		expect(errorOf(body).code).toBe("bad_request");
	});

	it("rejects limit=0 and limit=501", async () => {
		expect((await get("/api/tree?limit=0")).status).toBe(400);
		expect((await get("/api/tree?limit=501")).status).toBe(400);
	});

	it("has both child_count and has_children, and parent_uri not parent_id", async () => {
		seedTree();
		const { body } = await get<TreeBody>("/api/tree?domain=core");
		expect(Object.hasOwn(body.items[0], "child_count")).toBe(true);
		expect(Object.hasOwn(body.items[0], "has_children")).toBe(true);
		expect(Object.hasOwn(body.items[0], "disclosure")).toBe(true);
		expect(Object.hasOwn(body, "parent_uri")).toBe(true);
		expect(Object.hasOwn(body, "parent_id")).toBe(false);
	});

	it("⭐ disclosure is ENTRY-scoped and flows through /api/tree (the default landing page)", async () => {
		store.put({ uri: "core://identity", content: "伊莱的身份锚点", disclosure: "谈到身份时", importance: 9 });
		const { body } = await get<TreeBody>("/api/tree?domain=core");
		const item = body.items.find((i) => i.uri === "core://identity")!;
		expect(item.disclosure).toBe("谈到身份时");
		// 无条件的节点必须是 `null`，不是空串或 undefined（前端据此不渲染徽章）。
		const habits = body.items.find((i) => i.uri === "core://identity/habits");
		if (habits) expect(habits.disclosure).toBeNull();
	});
});

// ── Single node ─────────────────────────────────────────────────────────────

describe("GET /api/node", () => {
	it("returns every documented key", async () => {
		seedTree();
		const { status, body } = await get<NodeBody>("/api/node?uri=core://identity/habits");
		expect(status).toBe(200);
		expect(body.node.uri).toBe("core://identity/habits");
		for (const key of ["current_version", "node", "path", "children", "revisions", "aliases", "edges", "glossary"]) {
			expect(Object.hasOwn(body, key)).toBe(true);
		}
		expect(Object.hasOwn(body.edges, "outgoing")).toBe(true);
		expect(Object.hasOwn(body.edges, "incoming")).toBe(true);
	});

	it("404 with the uri in the message", async () => {
		const { status, body } = await get<NodeBody>("/api/node?uri=core://nope");
		expect(status).toBe(404);
		expect(errorOf(body).code).toBe("not_found");
		expect(errorOf(body).message).toContain("core://nope");
	});

	it("400 when uri is missing", async () => {
		expect((await get("/api/node")).status).toBe(400);
	});

	it("⭐ P6: the editor columns reach the revision DTO", async () => {
		store.put({ uri: "core://identity", content: "v1" });
		const node = store.resolveUri("core://identity")!;
		store.updateNode(node.node_id, { content: "v2", editor_source: "manual", editor_model: null });
		// The store's own reader does not select these columns — proof the
		// serializer supplies them.
		expect(Object.hasOwn(store.listRevisions(node.node_id)[0], "editor_source")).toBe(false);
		const { body } = await get<RevisionsBody>("/api/revisions?uri=core://identity");
		expect(body.items[0].editor_source).toBe("manual");
		expect(body.items[0].editor_model).toBeNull();
	});

	it("⭐ P6 per-version: each revision keeps its OWN editor, not the first row's", async () => {
		store.put({ uri: "core://multi", content: "v1" });
		const node = store.resolveUri("core://multi")!;
		// `archiveRevision` stamps the OLD content with the incoming patch's
		// editor, so the archived rows carry: v1←manual, v2←auto/model, v3←manual.
		store.updateNode(node.node_id, { content: "v2", editor_source: "manual", editor_model: null });
		store.updateNode(node.node_id, { content: "v3", editor_source: "auto", editor_model: "claude-sonnet-4-5" });
		store.updateNode(node.node_id, { content: "v4", editor_source: "manual", editor_model: null });
		const { body } = await get<RevisionsBody>("/api/revisions?uri=core://multi");
		expect(body.items.map((i) => [i.version, i.editor_source, i.editor_model])).toEqual([
			[1, "manual", null],
			[2, "auto", "claude-sonnet-4-5"],
			[3, "manual", null],
		]);
	});

	it("⭐ P1: an incoming edge carries the peer uri, and node_id is the edge SOURCE", async () => {
		store.put({ uri: "core://a", content: "A" });
		store.put({ uri: "core://b", content: "B" });
		const b = store.resolveUri("core://b")!;
		store.addEdge(b.node_id, "core://a");
		const { body } = await get<NodeBody>("/api/node?uri=core://a");
		expect(body.edges.incoming).toHaveLength(1);
		expect(body.edges.incoming[0].uri).toBe("core://b");
		expect(body.edges.incoming[0].node_id).toBe(b.node_id);
		expect(body.edges.incoming[0].resolved_uri).toBe(body.edges.incoming[0].uri);
		expect(body.edges.incoming[0].dangling).toBe(false);
	});

	it("⭐ P8: glossary reaches the node response", async () => {
		store.put({ uri: "core://identity", content: "伊莱" });
		const node = store.resolveUri("core://identity")!;
		store.addGlossaryEntry("薇拉", node.node_id);
		const { body } = await get<NodeBody>("/api/node?uri=core://identity");
		expect(body.glossary[0].keyword).toBe("薇拉");
		expect(body.glossary[0].uri).toBe("core://identity");
	});

	it("path is the ancestor chain, root first, excluding self", async () => {
		store.put({ uri: "core://identity/habits/tea", content: "茶" });
		const { body } = await get<NodeBody>("/api/node?uri=core://identity/habits/tea");
		expect(body.path.map((p) => p.uri)).toEqual(["core://identity", "core://identity/habits"]);
	});

	it("⭐ current_version is 0 for a fresh node and 1 after one content revise", async () => {
		store.put({ uri: "core://cv", content: "v1" });
		expect((await get<NodeBody>("/api/node?uri=core://cv")).body.current_version).toBe(0);
		await post("/api/node/revise", { uri: "core://cv", content: "v2" });
		expect((await get<NodeBody>("/api/node?uri=core://cv")).body.current_version).toBe(1);
	});

	it("⭐ §16.14: anchors are exposed for auto nodes, null for manual; first/last_raw_id stay hidden", async () => {
		store.insertNode({
			uri: "core://auto",
			content: "自动",
			source: "auto",
			anchor_entry_id: "e9",
			anchor_session_id: "s9",
		});
		store.put({ uri: "core://manual", content: "手动" });
		const auto = (await get<NodeBody>("/api/node?uri=core://auto")).body.node as Record<string, unknown>;
		expect(auto.anchor_entry_id).toBe("e9");
		expect(auto.anchor_session_id).toBe("s9");
		expect(Object.hasOwn(auto, "first_raw_id")).toBe(false);
		expect(Object.hasOwn(auto, "last_raw_id")).toBe(false);
		const manual = (await get<NodeBody>("/api/node?uri=core://manual")).body.node as Record<string, unknown>;
		expect(manual.anchor_entry_id).toBeNull();
		expect(manual.anchor_session_id).toBeNull();
	});

	it("⭐ §6.6: an auto node whose anchor left the active branch is shadowed", async () => {
		appendRaw([{ session: "s1", entry: "e1" }]);
		store.insertNode({
			uri: "core://auto",
			content: "自动",
			source: "auto",
			anchor_entry_id: "e1",
			anchor_session_id: "s1",
		});
		expect(
			(await get<TreeBody>("/api/tree?domain=core")).body.items.find((i) => i.uri === "core://auto"),
		).toBeDefined();
		store.syncRawBranch("s1", []);
		const { body } = await get<NodeBody>("/api/node?uri=core://auto");
		expect(body.node.shadowed).toBe(true);
	});
});

// ── Search ──────────────────────────────────────────────────────────────────

describe("GET /api/search", () => {
	it("returns score / kw / vec / bm25 / summary — raw search(), not store.recall()", async () => {
		store.put({ uri: "core://identity/habits", content: "伊莱每天清晨磨剑", importance: 9 });
		const { status, body } = await get<SearchBody>("/api/search?q=磨剑");
		expect(status).toBe(200);
		expect(body.items.length).toBeGreaterThan(0);
		for (const key of ["score", "kw", "vec", "bm25", "summary"]) {
			expect(Object.hasOwn(body.items[0], key)).toBe(true);
		}
		expect(body.mode).toBe("keyword");
	});

	it("⭐ P7: importance is back-filled by node_id, never faked from score", async () => {
		store.put({ uri: "core://identity/habits", content: "伊莱每天清晨磨剑", importance: 9 });
		const { body } = await get<SearchBody>("/api/search?q=磨剑");
		expect(body.items[0].importance).toBe(9);
		expect(body.items[0].importance).not.toBe(body.items[0].score);
		expect(body.items[0].source).toBe("manual");
	});

	it("a miss is a legal empty result, not a 404", async () => {
		const { status, body } = await get<SearchBody>("/api/search?q=zzzznotpresentzzzz");
		expect(status).toBe(200);
		expect(body).toEqual({ items: [], total: 0, mode: "keyword" });
	});

	it("400 without q", async () => {
		expect((await get("/api/search")).status).toBe(400);
	});

	it("stub nodes never surface in search", async () => {
		// `core://stubby` is auto-created as a stub parent (empty body, out of FTS).
		store.put({ uri: "core://stubby/leaf", content: "磨剑的日常" });
		expect(store.resolveUri("core://stubby")!.is_stub).toBe(1);
		const { body } = await get<SearchBody>("/api/search?q=磨剑");
		const uris = body.items.map((i) => i.uri);
		expect(uris).toContain("core://stubby/leaf");
		expect(uris).not.toContain("core://stubby");
	});
});

// ── Raw log & sessions ──────────────────────────────────────────────────────

describe("GET /api/raw and /api/sessions", () => {
	it("total is post-filter, totalAll is the whole log", async () => {
		appendRaw([
			{ session: "s1", entry: "e1" },
			{ session: "s1", entry: "e2" },
			{ session: "s2", entry: "e3" },
		]);
		const { body } = await get<RawBody>("/api/raw?limit=100");
		expect(body.totalAll).toBe(3);
		expect(body.total).toBe(3);
		expect(body.items).toHaveLength(3);
	});

	it("activeOnly filters and active is a number 0/1", async () => {
		appendRaw([
			{ session: "s1", entry: "e1" },
			{ session: "s1", entry: "e2" },
		]);
		store.syncRawBranch("s1", [
			{ role: "assistant", text: "x", entry_id: "e1", session_id: "s1", wall_ts: "2020-01-01T00:00:00.000Z" },
		]);
		const { body } = await get<RawBody>("/api/raw?activeOnly=1");
		expect(body.total).toBe(1);
		expect(body.totalAll).toBe(2);
		expect(typeof body.items[0].active).toBe("number");
		expect(body.items.every((r) => r.active === 1)).toBe(true);
	});

	it("⭐ P13: the before cursor is exclusive", async () => {
		appendRaw([
			{ session: "s1", entry: "e1" },
			{ session: "s1", entry: "e2" },
			{ session: "s1", entry: "e3" },
		]);
		const { body } = await get<RawBody>("/api/raw?limit=2&before=3");
		expect(body.items.length).toBeGreaterThan(0);
		expect(body.items.every((r) => r.raw_id < 3)).toBe(true);
		expect(body.before).toBe(3);
	});

	it("⭐ D3: the offset compatibility page does not overlap page 0", async () => {
		appendRaw(Array.from({ length: 8 }, (_, i) => ({ session: "s1", entry: `e${i}` })));
		const page0 = await get<RawBody>("/api/raw?limit=4&offset=0");
		const page1 = await get<RawBody>("/api/raw?limit=4&offset=4");
		const ids0 = new Set(page0.body.items.map((r) => r.raw_id));
		expect(page1.body.items.every((r) => !ids0.has(r.raw_id))).toBe(true);
		expect(new Set([...ids0, ...page1.body.items.map((r) => r.raw_id)]).size).toBe(8);
	});

	it("⭐ §16.9: offset / before / around are mutually exclusive", async () => {
		appendRaw([{ session: "s1", entry: "e1" }]);
		expect((await get("/api/raw?around=e1&session=s1&offset=1")).status).toBe(400);
		expect((await get("/api/raw?before=5&offset=1")).status).toBe(400);
		expect((await get("/api/raw?around=e1&session=s1&before=5")).status).toBe(400);
	});

	it("⭐ around is an entry_id: centred window includes that row", async () => {
		appendRaw(Array.from({ length: 6 }, (_, i) => ({ session: "s1", entry: `e${i}` })));
		const { body } = await get<RawBody>("/api/raw?around=e3&session=s1&limit=4");
		expect(body.before).toBeNull();
		const anchored = store.db.prepare("SELECT raw_id FROM raw_log WHERE entry_id = 'e3'").get() as { raw_id: number };
		expect(body.items.map((r) => r.raw_id)).toContain(anchored.raw_id);
	});

	it("⭐ around with a cross-session duplicate entry_id and no session is 400", async () => {
		appendRaw([
			{ session: "s1", entry: "dup" },
			{ session: "s2", entry: "dup" },
		]);
		const { status, body } = await get<RawBody>("/api/raw?around=dup");
		expect(status).toBe(400);
		expect(errorOf(body).message).toContain("session");
	});

	it("⭐ around is not a raw_id: a numeric string that is no entry_id is rejected", async () => {
		appendRaw([{ session: "s1", entry: "e1" }]);
		expect((await get("/api/raw?around=1&session=s1")).status).toBe(404);
	});

	it("sessions are grouped once each, newest last_raw_id first, active <= total", async () => {
		appendRaw([
			{ session: "s1", entry: "e1" },
			{ session: "s1", entry: "e2" },
			{ session: "s2", entry: "e3" },
		]);
		store.syncRawBranch("s1", [
			{ role: "assistant", text: "x", entry_id: "e1", session_id: "s1", wall_ts: "2020-01-01T00:00:00.000Z" },
		]);
		const { body } = await get<SessionsBody>("/api/sessions");
		expect(body.total).toBe(body.items.length);
		expect(new Set(body.items.map((i) => i.session_id)).size).toBe(body.items.length);
		for (const item of body.items) expect(item.active).toBeLessThanOrEqual(item.total);
		const ids = body.items.map((i) => i.last_raw_id);
		expect(ids).toEqual([...ids].sort((a, b) => b - a));
	});

	it("⭐ F4-B: first_text is the FIRST row's text, whitespace-folded and cut to 80 chars", async () => {
		appendRaw([
			{ session: "s1", entry: "e1", text: "第一行\n第二行 " + "细".repeat(200) },
			{ session: "s1", entry: "e2", text: "绝不是摘要来源" },
			{ session: "s2", entry: "e3", text: "商队从北方来" },
		]);
		const { body } = await get<SessionsBody>("/api/sessions");
		const byId = new Map(body.items.map((i) => [i.session_id, i]));
		const s1 = byId.get("s1")!;
		// substr(120) up front, then `\s+ → " "` folding (no newline survives), then the 80-char cut.
		expect(s1.first_text).toBe("第一行 第二行 " + "细".repeat(72));
		expect(s1.first_text!.length).toBe(80);
		expect(s1.first_text).not.toContain("\n");
		// short text passes through folded and uncut; each session digests its OWN first row
		expect(byId.get("s2")!.first_text).toBe("商队从北方来");
		// the additive field leaves the rest of SessionDTO untouched
		expect(s1.total).toBe(2);
		expect(s1.active).toBe(2);
		expect(s1.first_raw_id).toBeLessThan(s1.last_raw_id);
	});

	it("⭐ F4-B reverse whitelist: NodeDTO never grows a first_text", async () => {
		store.put({ uri: "core://solo", content: "独节点" });
		const { body } = await get<NodeBody>("/api/node?uri=core://solo");
		expect("first_text" in body.node).toBe(false);
	});

	it("⭐ D3: /api/temp exposes thresholdSource and a real notifyPreview", async () => {
		store.put({ uri: "TEMP://draft-1", content: "草稿" });
		const { body } = await get<TempBody>("/api/temp");
		expect(["cli", "settings", "default"]).toContain(body.thresholdSource);
		expect(body.notifyPreview).toBe(buildTempNotifyContent(body.count, body.threshold));
		expect(body.count_all).toBe(store.countTempNodes());
	});
});

// ── Graph (plan/memory-web-redesign/04-图谱.md §2) ──────────────────────────

describe("GET /api/graph (04 图谱)", () => {
	/** Fixture reads go through the store's own resolver — never hand-made ids. */
	function idOf(uri: string): string {
		return store.resolveUri(uri)!.node_id;
	}

	it("domain listing: mode/world_time, counts bidirectional-equal to SQL, zero-edge domain shows 0", async () => {
		seedTree();
		store.put({ uri: "history://war", content: "战记" });
		store.addEdge(idOf("core://identity"), "core://identity/habits", "relates");
		const { status, body } = await get<GraphDomainsBody>("/api/graph");
		expect(status).toBe(200);
		expect(body.mode).toBe("domains");
		expect(body.world_time).toBe(store.getWorldTime());
		const sqlNodes = store.db.prepare("SELECT domain, COUNT(*) AS c FROM nodes GROUP BY domain").all() as Array<{
			domain: string;
			c: number;
		}>;
		const sqlEdges = store.db
			.prepare(
				"SELECT n.domain AS domain, COUNT(*) AS c FROM edges e JOIN nodes n ON n.node_id = e.node_id GROUP BY n.domain",
			)
			.all() as Array<{ domain: string; c: number }>;
		const dtoNodes = new Map(body.domains.map((d) => [d.domain, d.node_count]));
		const dtoEdges = new Map(body.domains.map((d) => [d.domain, d.edge_count]));
		expect(dtoNodes.size).toBe(sqlNodes.length);
		for (const r of sqlNodes) expect(dtoNodes.get(r.domain)).toBe(Number(r.c));
		for (const r of sqlEdges) expect(dtoEdges.get(r.domain)).toBe(Number(r.c));
		// edge_count = edges SOURCED from the domain; a domain with no source edges reports 0, not absence
		expect(dtoEdges.get("core")).toBe(1);
		expect(dtoEdges.get("history")).toBe(0);
		// `domain=""` is the same listing mode (§2.1: null or "" → domains)
		expect((await get<GraphDomainsBody>("/api/graph?domain=")).body.mode).toBe("domains");
	});

	it("empty db: the listing is an empty 200, not a 404", async () => {
		// boot() seeds the index/history/meta roots; drop them to reach a truly empty node table
		for (const uri of ["index://", "history://", "meta://"]) {
			store.deleteCascade(store.resolveUri(uri)!.node_id);
		}
		const { status, body } = await get<GraphDomainsBody>("/api/graph");
		expect(status).toBe(200);
		expect(body.domains).toEqual([]);
	});

	it("graph mode: every item is exactly the whitelist field set — no passthrough", async () => {
		seedTree();
		store.addEdge(idOf("core://identity"), "core://identity/habits", "relates");
		store.addAlias("core://tea-address", idOf("core://identity/habits/tea"));
		const { body } = await get<GraphDataBody>("/api/graph?domain=core");
		expect(body.mode).toBe("graph");
		expect(body.nodes.length).toBeGreaterThan(0);
		expect(body.edges.length).toBeGreaterThan(0);
		expect(body.aliases.length).toBeGreaterThan(0);
		for (const n of body.nodes) {
			expect(Object.keys(n).sort()).toEqual([
				"domain",
				"importance",
				"is_stub",
				"label",
				"node_id",
				"parent_uri",
				"uri",
			]);
		}
		for (const e of body.edges) {
			expect(Object.keys(e).sort()).toEqual(["dangling", "kind", "source_id", "target_id", "target_uri"]);
		}
		for (const a of body.aliases) {
			expect(Object.keys(a).sort()).toEqual(["alias_uri", "dead", "target_node_id"]);
		}
	});

	it("label is the uri's last segment, computed server-side; tail-empty falls back to the whole uri", async () => {
		seedTree();
		store.put({ uri: "core://identity/茶道", content: "茶艺" });
		const { body } = await get<GraphDataBody>("/api/graph?domain=index");
		const labelOf = new Map(body.nodes.map((n) => [n.uri, n.label]));
		// seed() materializes the index:// domain root — the tail-empty-segment case
		expect(labelOf.get("index://")).toBe("index://");
		const core = await get<GraphDataBody>("/api/graph?domain=core");
		const coreLabels = new Map(core.body.nodes.map((n) => [n.uri, n.label]));
		expect(coreLabels.get("core://identity/habits")).toBe("habits");
		expect(coreLabels.get("core://identity/茶道")).toBe("茶道"); // non-ASCII segment verbatim
	});

	it("parent_uri resolves parent_id to the parent's uri; unmaterialized domain root → null; auto stubs are marked", async () => {
		seedTree();
		store.put({ uri: "core://health/sleep", content: "早睡" }); // auto-creates the core://health stub
		const { body } = await get<GraphDataBody>("/api/graph?domain=core");
		const byUri = new Map(body.nodes.map((n) => [n.uri, n]));
		// put() never materializes "core://" itself, so the first segment's parent_id is null (domain-root null)
		expect(byUri.get("core://identity")!.parent_uri).toBeNull();
		expect(byUri.get("core://identity/habits")!.parent_uri).toBe("core://identity");
		expect(byUri.get("core://health")!.is_stub).toBe(true); // auto-created ancestor
		expect(byUri.get("core://health")!.parent_uri).toBeNull();
		expect(byUri.get("core://health/sleep")!.parent_uri).toBe("core://health");
		expect(byUri.get("core://identity/habits")!.is_stub).toBe(false);
	});

	it("in-domain edge: target resolved, kind passed through, target_uri verbatim", async () => {
		seedTree();
		store.addEdge(idOf("core://identity"), "core://identity/habits", "relates");
		const { body } = await get<GraphDataBody>("/api/graph?domain=core");
		expect(body.edges).toEqual([
			{
				source_id: idOf("core://identity"),
				target_id: idOf("core://identity/habits"),
				kind: "relates",
				dangling: false,
				target_uri: "core://identity/habits",
			},
		]);
	});

	it("dangling edge: nothing resolves → target_id null, target_uri kept for the tooltip", async () => {
		seedTree();
		store.addEdge(idOf("core://identity"), "core://ghost");
		const { body } = await get<GraphDataBody>("/api/graph?domain=core");
		expect(body.edges).toHaveLength(1);
		expect(body.edges[0].dangling).toBe(true);
		expect(body.edges[0].target_id).toBeNull();
		expect(body.edges[0].target_uri).toBe("core://ghost");
	});

	it("cross-domain edge: a resolvable target outside the domain is skipped, not drawn", async () => {
		seedTree();
		store.put({ uri: "history://war", content: "战记" });
		store.addEdge(idOf("core://identity"), "history://war");
		const { body } = await get<GraphDataBody>("/api/graph?domain=core");
		expect(body.edges).toEqual([]);
	});

	it("edge to a node cut by limit is skipped too (no dangling endpoints on the canvas)", async () => {
		store.put({ uri: "spec://a", content: "重要", importance: 10 });
		store.put({ uri: "spec://a/b", content: "次要", importance: 1 });
		store.addEdge(idOf("spec://a/b"), "spec://a");
		const { body } = await get<GraphDataBody>("/api/graph?domain=spec&limit=1");
		expect(body.nodes.map((n) => n.uri)).toEqual(["spec://a"]); // importance DESC keeps ★10 through the cut
		expect(body.edges).toEqual([]);
	});

	it("edge via alias resolves to the alias target (resolveUri precedence); target_uri keeps the alias uri", async () => {
		seedTree();
		store.addAlias("core://tea-alias", idOf("core://identity/habits/tea"));
		store.addEdge(idOf("core://identity"), "core://tea-alias", "likes");
		const { body } = await get<GraphDataBody>("/api/graph?domain=core");
		expect(body.edges).toEqual([
			{
				source_id: idOf("core://identity"),
				target_id: idOf("core://identity/habits/tea"),
				kind: "likes",
				dangling: false,
				target_uri: "core://tea-alias",
			},
		]);
	});

	it("aliases: live alias dead=false; uri colliding with a live node uri dead=true; out-of-domain target absent", async () => {
		seedTree();
		store.put({ uri: "history://war", content: "战记" });
		store.addAlias("core://tea-address", idOf("core://identity/habits/tea"));
		store.addAlias("core://identity", idOf("core://identity/habits/tea")); // shadows itself: alias_uri is a live nodes.uri
		store.addAlias("core://war-address", idOf("history://war")); // target in another domain
		const { body } = await get<GraphDataBody>("/api/graph?domain=core");
		const byUri = new Map(body.aliases.map((a) => [a.alias_uri, a]));
		expect(byUri.get("core://tea-address")).toEqual({
			alias_uri: "core://tea-address",
			target_node_id: idOf("core://identity/habits/tea"),
			dead: false,
		});
		expect(byUri.get("core://identity")!.dead).toBe(true); // the aliasListStmt dead predicate, set form
		expect(byUri.has("core://war-address")).toBe(false);
	});

	it("limit: default 200 truncates a 201+ node domain explicitly (total_nodes is the denominator)", async () => {
		for (let i = 0; i < 201; i++) store.put({ uri: `big://n${i}`, content: `节点 ${i}` });
		store.put({ uri: "big://top", content: "最重要的", importance: 10 });
		const { body } = await get<GraphDataBody>("/api/graph?domain=big");
		expect(body.total_nodes).toBe(202);
		expect(body.truncated).toBe(true);
		expect(body.nodes).toHaveLength(200);
		expect(body.nodes[0].uri).toBe("big://top"); // importance DESC: the ★10 survives the cut
	});

	it("limit boundary: 1 applies; 0 / 501 / abc are 400 naming the legal range", async () => {
		seedTree();
		expect((await get<GraphDataBody>("/api/graph?domain=core&limit=1")).body.nodes).toHaveLength(1);
		for (const bad of ["limit=0", "limit=501", "limit=abc"]) {
			const { status, body } = await get<GraphDomainsBody>(`/api/graph?domain=core&${bad}`);
			expect(status).toBe(400);
			expect(errorOf(body).message).toContain("1-500");
		}
	});

	it("unknown domain is a legal empty graph, not a 404", async () => {
		const { status, body } = await get<GraphDataBody>("/api/graph?domain=ghost");
		expect(status).toBe(200);
		expect(body.mode).toBe("graph");
		expect(body.domain).toBe("ghost");
		expect(body.nodes).toEqual([]);
		expect(body.edges).toEqual([]);
		expect(body.aliases).toEqual([]);
		expect(body.total_nodes).toBe(0);
		expect(body.truncated).toBe(false);
	});

	it("POST /api/graph is 405 method_not_allowed with Allow: GET", async () => {
		const { status, body, headers } = await request("/api/graph", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{}",
		});
		expect(status).toBe(405);
		expect(errorOf(body).code).toBe("method_not_allowed");
		expect(headers.get("allow")).toContain("GET");
	});

	it("the graph path keeps dispatch's store-error mapping (locked db → 409 conflict, no new error code)", () => {
		const mapped = mapStoreError(new Error("database is locked"), {});
		expect(mapped.status).toBe(409);
		expect(codeOf(mapped)).toBe("conflict");
	});
});

// ── Audit & deleted revisions ───────────────────────────────────────────────

describe("GET /api/audit and /api/revisions", () => {
	it("offset really excludes the first page", async () => {
		seedTree();
		const first = await get<AuditBody>("/api/audit?limit=10&offset=0");
		const second = await get<AuditBody>("/api/audit?limit=10&offset=10");
		expect(first.body.items.length).toBeLessThanOrEqual(10);
		const firstIds = new Set(first.body.items.map((i) => i.id));
		expect(second.body.items.every((i) => !firstIds.has(i.id))).toBe(true);
	});

	it("⭐ P14: deleted=1 carries node_id and the revision rows really survive", async () => {
		store.put({ uri: "core://gone", content: "v1" });
		const node = store.resolveUri("core://gone")!;
		store.updateNode(node.node_id, { content: "v2" });
		store.deleteCascade(node.node_id);
		expect(store.listAudit(1)[0].event).toBe("delete_node");
		const revisions = store.db
			.prepare("SELECT COUNT(*) AS c FROM node_revisions WHERE node_id = ?")
			.get(node.node_id) as { c: number };
		expect(Number(revisions.c)).toBeGreaterThan(0);

		const { body } = await get<RevisionsBody>("/api/revisions?deleted=1");
		expect(body.items[0].node_id).toBe(node.node_id);
		for (const key of ["node_id", "uri", "versions", "last_seen"]) {
			expect(Object.hasOwn(body.items[0], key)).toBe(true);
		}
	});

	it("400 when neither uri nor deleted is given", async () => {
		expect((await get("/api/revisions")).status).toBe(400);
	});
});

// ── Events ──────────────────────────────────────────────────────────────────

describe("GET /api/events", () => {
	it("first call reports changed=false — no baseline, no phantom change", async () => {
		const { body } = await get<EventsBody>("/api/events");
		expect(body.changed).toBe(false);
		expect(typeof body.version).toBe("number");
	});

	it("two calls with no external write leave changed=false", async () => {
		await get("/api/events");
		expect((await get<EventsBody>("/api/events")).body.changed).toBe(false);
	});

	it("⭐ an external connection's commit is seen", async () => {
		await server.close();
		const file = path.join(workdir, "ext.db");
		await boot(file);
		await get("/api/events");
		const other = new DatabaseSync(file);
		other.exec("INSERT INTO memory_kv (key, value, updated_at) VALUES ('other', '1', '2020-01-01')");
		other.close();
		expect((await get<EventsBody>("/api/events")).body.changed).toBe(true);
	});

	it("⭐ the server's own write is NOT visible to itself (§7.4)", async () => {
		await get("/api/events");
		const wrote = await post("/api/world-time", { value: "2020-05-05" });
		expect(wrote.status).toBe(200);
		expect((await get<EventsBody>("/api/events")).body.changed).toBe(false);
	});
});

// ── Write endpoints ─────────────────────────────────────────────────────────

describe("POST write endpoints", () => {
	it("creates a node and leaves an insert_node audit row", async () => {
		const { status } = await post("/api/node", { uri: "core://new", content: "新" });
		expect(status).toBe(200);
		expect(store.listAudit(1)[0].event).toBe("insert_node");
	});

	it("⭐ put on an existing uri is an upsert (200), never a 409", async () => {
		const first = await post<NodeBody>("/api/node", { uri: "core://dup", content: "v1" });
		const id = first.body.node.node_id;
		const second = await post<NodeBody>("/api/node", { uri: "core://dup", content: "v2" });
		expect(second.status).toBe(200);
		expect(second.body.node.node_id).toBe(id);
		expect(store.listRevisions(id)).toHaveLength(1);
	});

	it("revise on content archives exactly one revision", async () => {
		store.put({ uri: "core://r", content: "v1" });
		const node = store.resolveUri("core://r")!;
		const { status, body } = await post<NodeBody>("/api/node/revise", { uri: "core://r", content: "v2" });
		expect(status).toBe(200);
		expect(store.listRevisions(node.node_id)).toHaveLength(1);
		expect(body.version).toBe(body.current_version);
		expect(body.version).toBe(1);
	});

	it("revise of importance alone archives nothing", async () => {
		store.put({ uri: "core://r", content: "v1" });
		const node = store.resolveUri("core://r")!;
		await post("/api/node/revise", { uri: "core://r", importance: 3 });
		expect(store.listRevisions(node.node_id)).toHaveLength(0);
		expect(store.resolveUri("core://r")!.importance).toBe(3);
	});

	it("⭐ stub promotion returns version 0 as SUCCESS", async () => {
		store.put({ uri: "core://a/b/c", content: "leaf" });
		store.deleteCascade(store.resolveUri("core://a/b/c")!.node_id);
		expect(store.resolveUri("core://a")!.is_stub).toBe(1);
		const { status, body } = await post<NodeBody>("/api/node/revise", { uri: "core://a", content: "now real" });
		expect(status).toBe(200);
		expect(body.version).toBe(0);
		expect(body.node.is_stub).toBe(false);
	});

	it("forget deletes and audits delete_node", async () => {
		store.put({ uri: "core://gone", content: "x" });
		expect((await post("/api/node/forget", { uri: "core://gone" })).status).toBe(200);
		expect(store.resolveUri("core://gone")).toBeNull();
		expect(store.listAudit(1)[0].event).toBe("delete_node");
	});

	it("relocate leaves an alias behind", async () => {
		store.put({ uri: "core://old", content: "x" });
		expect((await post("/api/node/relocate", { moves: [{ from: "core://old", to: "core://new" }] })).status).toBe(
			200,
		);
		expect(store.resolveUri("core://new")).not.toBeNull();
		expect(store.resolveUri("core://old")).not.toBeNull();
	});

	it("world-time echoes the resolved absolute time", async () => {
		store.setWorldTime("2020-01-01T00:00:00.000Z");
		const { status, body } = await post<{ world_time: string }>("/api/world-time", { value: "+1d" });
		expect(status).toBe(200);
		expect(body.world_time).toBe("2020-01-02T00:00:00.000Z");
		expect(store.getWorldTime()).toBe(body.world_time);
	});

	it("world-time rejects a non-date as bad_request", async () => {
		const { status, body } = await post<Record<string, never>>("/api/world-time", { value: "not-a-date" });
		expect(status).toBe(400);
		expect(errorOf(body).code).toBe("bad_request");
	});

	it("glossary writes through the store method", async () => {
		store.put({ uri: "core://g", content: "x" });
		const node = store.resolveUri("core://g")!;
		expect((await post("/api/glossary", { keyword: "薇拉", uri: "core://g" })).status).toBe(200);
		expect(store.lookupGlossary("薇拉")).toBe(node.node_id);
	});

	it("awaken set then list round-trips", async () => {
		const set = await post<{ uris: string[] }>("/api/awaken", { action: "set", uris: ["core://x", "core://y"] });
		expect(set.body.uris).toEqual(["core://x", "core://y"]);
		expect((await post<{ uris: string[] }>("/api/awaken", { action: "list" })).body.uris).toEqual([
			"core://x",
			"core://y",
		]);
	});

	it("rejects malformed and oversized bodies", async () => {
		expect((await post("/api/node", "{not json")).status).toBe(400);
		const huge = `{"uri":"core://big","content":"${"a".repeat(1024 * 1024 + 10)}"}`;
		expect((await post("/api/node", huge)).status).toBe(400);
	});

	it("revise with no editable field is bad_request", async () => {
		store.put({ uri: "core://r", content: "v1" });
		expect((await post("/api/node/revise", { uri: "core://r" })).status).toBe(400);
	});
});

// ── Error boundary ──────────────────────────────────────────────────────────

describe("error boundary", () => {
	it("unknown path is 404 not_found", async () => {
		const { status, body } = await get<Record<string, never>>("/api/nope");
		expect(status).toBe(404);
		expect(errorOf(body).code).toBe("not_found");
	});

	it("known path with the wrong method is 405 plus Allow", async () => {
		const { status, body, headers } = await request<Record<string, never>>("/api/node", { method: "DELETE" });
		expect(status).toBe(405);
		expect(errorOf(body).code).toBe("method_not_allowed");
		expect(headers.get("allow")).toContain("GET");
		expect(headers.get("allow")).toContain("POST");
	});

	it("a /api/ path missing from the table is 404, not 405", async () => {
		expect((await post("/api/nope", {})).status).toBe(404);
	});

	it("⭐ restore against a live uri is 409 conflict with a Chinese message", async () => {
		store.put({ uri: "core://alive", content: "x" });
		const { status, body } = await post<Record<string, never>>("/api/node/restore", { uri: "core://alive" });
		expect(status).toBe(409);
		expect(errorOf(body).code).toBe("conflict");
		expect(errorOf(body).message).not.toMatch(/still exists|UNIQUE constraint|relocate:/);
	});

	it("⭐ relocate onto an occupied target is 409 conflict, not 400", async () => {
		store.put({ uri: "core://a", content: "A" });
		store.put({ uri: "core://b", content: "B" });
		const { status, body } = await post<Record<string, never>>("/api/node/relocate", {
			moves: [{ from: "core://a", to: "core://b" }],
		});
		expect(status).toBe(409);
		expect(errorOf(body).code).toBe("conflict");
		// The top-level {from,to} shell is deliberately NOT a second accepted shape.
		expect((await post("/api/node/relocate", { from: "core://a", to: "core://b" })).status).toBe(400);
	});

	it("⭐ the two remaining conflict triggers map to 409", () => {
		const clash = mapStoreError(new Error("UNIQUE constraint failed: nodes.uri"), { uri: "core://a" });
		expect(clash.status).toBe(409);
		expect(codeOf(clash)).toBe("conflict");
		const occupied = mapStoreError(new Error("relocate: target occupied by core://b"), { to: "core://b" });
		expect(occupied.status).toBe(409);
		expect(codeOf(occupied)).toBe("conflict");
	});

	it("a missing node is 404, never 200 with a null body", async () => {
		const { status, body } = await get<NodeBody>("/api/node?uri=core://definitely/absent");
		expect(status).toBe(404);
		expect(body.node).toBeUndefined();
	});

	it("invalid_db is 409 and never leaks SQLite text", () => {
		const mapped = mapStoreError(
			new Error("memory database schema v1 is incompatible with this build (v2). There is no in-place migration: …"),
			{},
		);
		expect(mapped.status).toBe(409);
		expect(codeOf(mapped)).toBe("invalid_db");
		expect(messageOf(mapped)).not.toContain("incompatible with this build");
	});

	it("a throwing handler becomes 500 internal, not a swallowed 200", async () => {
		ROUTES.push({ method: "GET", path: "/api/boom", handler: boom });
		try {
			const { status, body } = await get<Record<string, never>>("/api/boom");
			expect(status).toBe(500);
			expect(errorOf(body).code).toBe("internal");
		} finally {
			ROUTES.pop();
		}
	});
});

function boom(): HandlerResult {
	throw new Error("kaboom");
}

function codeOf(result: HandlerResult): string {
	const body = result.body as Partial<ApiErrorBody> | undefined;
	if (!body?.error) throw new Error("expected an error body");
	return body.error.code;
}

function messageOf(result: HandlerResult): string {
	const body = result.body as Partial<ApiErrorBody> | undefined;
	if (!body?.error) throw new Error("expected an error body");
	return body.error.message;
}

// ── /api/view ───────────────────────────────────────────────────────────────

describe("GET /api/view", () => {
	it("rejects a missing name with the legal values listed", async () => {
		const { status, body } = await get<Record<string, never>>("/api/view");
		expect(status).toBe(400);
		expect(errorOf(body).message).toContain("timeline");
	});

	it("⭐ never accepts a MEM:// uri parameter", async () => {
		expect((await get("/api/view?name=forgotten&uri=MEM://forgotten/core/5")).status).toBe(400);
	});
});

// ── Static assets ───────────────────────────────────────────────────────────

describe("static assets", () => {
	it("strips the /assets/ prefix and serves index.html at /", async () => {
		const root = await request<Record<string, never>>("/");
		expect(root.status).toBe(200);
		expect(root.headers.get("cache-control")).toBe("no-store");
		const js = await request<Record<string, never>>("/assets/app.js");
		expect(js.status).toBe(200);
		expect(js.headers.get("content-type")).toContain("text/javascript");
		expect(js.headers.get("cache-control")).toBe("no-cache");
	});

	it("gives no alias without the prefix, and no directory index", async () => {
		expect((await get("/app.js")).status).toBe(404);
		expect((await get("/assets/")).status).toBe(404);
	});

	it("⭐ blocks traversal after decoding", async () => {
		expect((await get("/assets/../serialize.ts")).status).toBe(404);
		expect((await get("/assets/%2e%2e/serialize.ts")).status).toBe(404);
	});

	it("adds nosniff everywhere", async () => {
		expect((await request<Record<string, never>>("/api/meta")).headers.get("x-content-type-options")).toBe("nosniff");
	});
});

// ── Mechanical invariants ───────────────────────────────────────────────────

describe("mechanical invariants", () => {
	it("⭐ code set is bidirectionally equal to §7.3", () => {
		expect(new Set(ERROR_CODES)).toEqual(new Set(CONTRACT_CODES));
	});

	it("⭐ every code is reachable", async () => {
		await get("/api/nope"); // not_found
		await request("/api/node", { method: "DELETE" }); // method_not_allowed
		await get("/api/node"); // bad_request
		await post("/api/world-time", { value: "x" }, { Origin: "http://evil.com" }); // forbidden_origin
		store.put({ uri: "core://codec", content: "x" });
		await post("/api/node/restore", { uri: "core://codec" }); // conflict
		ROUTES.push({ method: "GET", path: "/api/boom3", handler: boom });
		try {
			await get("/api/boom3"); // internal
		} finally {
			ROUTES.pop();
		}
		observedCodes.add(
			codeOf(mapStoreError(new Error("memory database schema v1 is incompatible with this build"), {})),
		); // invalid_db
		expect(new Set(observedCodes)).toEqual(new Set(CONTRACT_CODES));
	});

	it("⭐ raw-filtered set === timeline view set (double-endpoint cross-check)", async () => {
		appendRaw([
			{ session: "s1", entry: "e1" },
			{ session: "s1", entry: "e2" },
			{ session: "s1", entry: "e3" },
			{ session: "s2", entry: "e4" },
		]);
		store.syncRawBranch("s1", [
			{ role: "assistant", text: "a", entry_id: "e1", session_id: "s1", wall_ts: "2020-01-01T00:00:00.000Z" },
			{ role: "assistant", text: "b", entry_id: "e3", session_id: "s1", wall_ts: "2020-01-03T00:00:00.000Z" },
		]);
		for (const n of [3, 20, 100]) {
			const raw = await get<ListBody>(`/api/raw?activeOnly=1&limit=${n}`);
			const view = await get<ViewBody>(`/api/view?name=timeline&limit=${n}`);
			expect(new Set(view.body.items.map((i) => i.raw_id))).toEqual(new Set(raw.body.items.map((i) => i.raw_id)));
		}
	});

	it("meta.counts.temp === /api/temp count_all", async () => {
		store.put({ uri: "TEMP://d1", content: "草稿" });
		const meta = await get<MetaBody>("/api/meta");
		const temp = await get<TempBody>("/api/temp");
		expect(meta.body.counts.temp).toBe(temp.body.count_all);
	});
});
