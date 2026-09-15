/**
 * 接口字段名一致性（契约 §16 跨模块接口裁定 10 条 / D6 §11.3「接口字段名一致性 MUST 纳入核验」）。
 *
 * 本文件**只覆盖 api.test.ts 不覆盖的维度**：`/api/view` 的 `ViewDTO` 判别联合
 * （七个 name 各自的 `name`/`items`/`total`/`domain` 判别字段 + 每视图 item 的字段名），
 * 以及两条跨端点别名不变量（`EdgeDTO.dangling ⇔ uri === null`；`/api/node` 的 `path[]` 形状）。
 * `current_version` / `parent_uri` / `EdgeDTO.uri+resolved_uri` 的断言在 `api.test.ts`（避免重复）。
 *
 * ⭐ 契约 §4.3：真实 SQLite（`openMemoryStore("")` + `seed()`）+ 真实 HTTP。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openMemoryStore } from "../../src/index.ts";
import type { MemoryNode, MemoryStore } from "../../src/store.ts";
import { type RunningServer, startServer } from "../../src/web/server.ts";

const VIEW_NAMES = ["timeline", "forgotten", "recent", "index", "glossary", "wakeup", "diagnostic"] as const;
type ViewName = (typeof VIEW_NAMES)[number];

/**
 * 契约 §6.1/§16 冻结的字段名。`null` = 该字段是 optional/可为空但**必须存在**；
 * `"opt"` 前缀表示可缺省。
 */
const VIEW_ITEM_FIELDS: Record<ViewName, readonly string[]> = {
	timeline: ["raw_id", "world_ts", "role", "text", "session_id"],
	forgotten: ["node_id", "uri", "domain", "importance", "shadowed", "days_asleep", "snippet"],
	recent: ["node_id", "uri", "domain", "importance", "shadowed", "updated_ts", "disclosure"],
	index: ["domain", "roots"],
	glossary: ["keyword", "node_id", "uri"],
	// wakeup / diagnostic 的 items 不是数组（见下方专门用例）。
	wakeup: [],
	diagnostic: [],
};

let store: MemoryStore;
let server: RunningServer;

async function get(path: string): Promise<{ status: number; body: unknown }> {
	const res = await fetch(`${server.url}${path}`, { headers: { Host: new URL(server.url).host } });
	const text = await res.text();
	return { status: res.status, body: text ? JSON.parse(text) : null };
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${what} 不是对象：${JSON.stringify(value)}`);
	}
	return value as Record<string, unknown>;
}

function nodeOf(uri: string): MemoryNode {
	const node = store.resolveUri(uri);
	if (!node) throw new Error(`fixture 缺少节点：${uri}`);
	return node;
}

beforeEach(async () => {
	store = await openMemoryStore("");
	store.seed();
	// fixture：每个视图都必须非空（空视图会让字段断言静默失去意义，契约 §8.3）。
	store.insertNode({
		uri: "core://dto/alpha",
		content: "甲的记忆",
		disclosure: "想起时",
		source: "manual",
		importance: 8,
	});
	store.insertNode({ uri: "core://dto/alpha/child", content: "子记忆", source: "manual", importance: 3 });
	store.addEdge(nodeOf("core://dto/alpha").node_id, "core://dto/beta");
	store.addGlossaryEntry("触发词", nodeOf("core://dto/alpha").node_id);
	store.appendRaw([
		{ role: "user", text: "嗨", entry_id: "e1", session_id: "s1", wall_ts: "2026-09-15T00:00:00.000Z" },
		{ role: "assistant", text: "在", entry_id: "e2", session_id: "s1", wall_ts: "2026-09-15T00:00:01.000Z" },
	]);
	server = await startServer(
		{
			store,
			dbPath: "",
			assetsDir: new URL("../../src/web/assets", import.meta.url).pathname,
			tempThreshold: 10,
			tempThresholdSource: "default",
			startedAt: new Date().toISOString(),
		},
		{ port: 0, host: "127.0.0.1" },
	);
});
afterEach(async () => {
	// `RunningServer.close()` 自己关 store 的 db（server.ts 生命周期），此处不得重复 close。
	await server.close();
});

describe("/api/view 的 ViewDTO 判别联合（契约 §16.6 / D4 §2.0）", () => {
	it("七视图各返回 200，且 `name` 回显 === 请求的 name", async () => {
		for (const name of VIEW_NAMES) {
			const { status, body } = await get(`/api/view?name=${name}&limit=5`);
			expect(status, `name=${name}`).toBe(200);
			const dto = asRecord(body, `view ${name}`);
			expect(dto.name, `name=${name}`).toBe(name);
		}
	});

	it("所有视图都带 `items` 与 `total`（判别联合的共同成员）", async () => {
		for (const name of VIEW_NAMES) {
			const dto = asRecord((await get(`/api/view?name=${name}&limit=5`)).body, `view ${name}`);
			expect(Object.hasOwn(dto, "items"), `${name} 缺 items`).toBe(true);
			expect(typeof dto.total, `${name} 的 total`).toBe("number");
		}
	});

	it("`domain` 只出现在 forgotten / index / diagnostic 三个分支上", async () => {
		const withDomain: readonly ViewName[] = ["forgotten", "index", "diagnostic"];
		for (const name of VIEW_NAMES) {
			const dto = asRecord((await get(`/api/view?name=${name}&limit=5`)).body, `view ${name}`);
			const hasDomain = Object.hasOwn(dto, "domain");
			expect(hasDomain, `${name} 的 domain 存在性`).toBe(withDomain.includes(name));
		}
	});

	it("每个视图的 item 字段名与 D4 §2.0 逐字一致（不得自造同义字段）", async () => {
		for (const name of VIEW_NAMES) {
			const required = VIEW_ITEM_FIELDS[name];
			if (required.length === 0) continue; // wakeup/diagnostic 另有专门用例
			const dto = asRecord((await get(`/api/view?name=${name}&limit=5`)).body, `view ${name}`);
			expect(Array.isArray(dto.items), `${name}.items`).toBe(true);
			const items = dto.items as unknown[];
			expect(items.length, `${name} 必须非空`).toBeGreaterThan(0);
			const first = asRecord(items[0], `${name}.items[0]`);
			for (const field of required) {
				expect(Object.hasOwn(first, field), `${name} 缺字段 ${field}`).toBe(true);
			}
		}
	});

	it("index 的 item 是分组结构 { domain, roots[] }，roots 元素带 snippet", async () => {
		const dto = asRecord((await get("/api/view?name=index&limit=5")).body, "index");
		const groups = dto.items as unknown[];
		expect(groups.length).toBeGreaterThan(0);
		const group = asRecord(groups[0], "index group");
		expect(typeof group.domain).toBe("string");
		expect(Array.isArray(group.roots)).toBe(true);
		const roots = group.roots as unknown[];
		expect(roots.length).toBeGreaterThan(0);
		const root = asRecord(roots[0], "index root");
		for (const field of ["node_id", "uri", "domain", "importance", "shadowed", "snippet"]) {
			expect(Object.hasOwn(root, field), `index root 缺字段 ${field}`).toBe(true);
		}
	});

	it("wakeup 的 items 是三段式对象 { world_time, focuses, skipped, recent }（不是数组）", async () => {
		const dto = asRecord((await get("/api/view?name=wakeup&limit=5")).body, "wakeup");
		const items = asRecord(dto.items, "wakeup.items");
		expect(Array.isArray(dto.items)).toBe(false);
		for (const field of ["world_time", "focuses", "skipped", "recent"]) {
			expect(Object.hasOwn(items, field), `wakeup.items 缺字段 ${field}`).toBe(true);
		}
		expect(Array.isArray(items.focuses)).toBe(true);
		expect(Array.isArray(items.skipped)).toBe(true);
		expect(Array.isArray(items.recent)).toBe(true);
	});

	it("diagnostic 的 items 是 { domain, categories{stale,crowded,placeholder}, healthy }", async () => {
		const dto = asRecord((await get("/api/view?name=diagnostic&domain=core")).body, "diagnostic");
		expect(Array.isArray(dto.items)).toBe(false);
		const items = asRecord(dto.items, "diagnostic.items");
		expect(typeof items.healthy).toBe("boolean");
		const categories = asRecord(items.categories, "diagnostic.categories");
		for (const key of ["stale", "crowded", "placeholder"]) {
			expect(Array.isArray(categories[key]), `categories.${key}`).toBe(true);
		}
	});

	it("未知 name 与缺失 name → 400 bad_request（不是 404/500）", async () => {
		for (const q of ["name=bogus", ""]) {
			const { status, body } = await get(`/api/view?${q}`);
			expect(status, q).toBe(400);
			const err = asRecord(asRecord(body, "错误响应").error, "error");
			expect(err.code).toBe("bad_request");
		}
	});
});

describe("跨端点字段名不变量（契约 §16.1 / §16.3）", () => {
	it("EdgeDTO：`dangling ⇔ uri === null ⇔ resolved_uri === null`，且 uri === resolved_uri", async () => {
		// 造一条悬空边（目标 uri 不存在，契约 §12-P4 允许）与一条正常边。
		store.insertNode({ uri: "core://dto/gamma", content: "丙", source: "manual" });
		store.addEdge(nodeOf("core://dto/gamma").node_id, "core://dto/nonexistent");
		store.addEdge(nodeOf("core://dto/gamma").node_id, "core://dto/alpha");

		const dto = asRecord((await get("/api/node?uri=core://dto/gamma")).body, "node");
		const edges = asRecord(dto.edges, "edges");
		const outgoing = edges.outgoing as unknown[];
		expect(outgoing.length).toBeGreaterThan(0);
		for (const raw of outgoing) {
			const e = asRecord(raw, "edge");
			expect(e.uri).toBe(e.resolved_uri);
			expect(e.dangling).toBe(e.uri === null);
		}
		// 悬空边确实出现（否则上一条断言是空断言）。
		expect(outgoing.some((raw) => asRecord(raw, "edge").dangling === true)).toBe(true);
	});

	it("`/api/node` 的 path[] 是 { node_id, uri } 且不含自身，根在前", async () => {
		// `put` 会为缺失祖先建 stub（`insertNode` 不会）—— 这是唯一能造出祖先链的入口。
		store.put({ uri: "core://dto/chain/leaf", content: "叶", source: "manual" });
		const dto = asRecord((await get("/api/node?uri=core://dto/chain/leaf")).body, "node");
		const chain = dto.path as unknown[];
		const selfUri = asRecord(dto.node, "node").uri;
		expect(chain.map((raw) => asRecord(raw, "path entry").uri)).toEqual(["core://dto", "core://dto/chain"]);
		for (const raw of chain) {
			const entry = asRecord(raw, "path entry");
			expect(typeof entry.node_id).toBe("string");
			expect(typeof entry.uri).toBe("string");
			expect(entry.uri).not.toBe(selfUri);
		}
	});
});
