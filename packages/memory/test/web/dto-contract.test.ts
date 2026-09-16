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

/**
 * ⭐ 边级 disclosure 轨（D5 §10-B/§10-C/§10-G）的三张 DTO 新字段与入口作用域。
 *
 * 非空性：`TreeNodeDTO`/`EdgeDTO`/`AliasDTO` 三个 `disclosure` 与 `AliasDTO.dead`
 * 在本轮之前**都不存在**（契约 §2.8 实测），故这些断言在旧代码上必红。
 */
describe("disclosure：三张 DTO 的新字段与入口作用域（D5 §2.1 / §10-B）", () => {
	it("TreeNodeDTO / EdgeDTO / AliasDTO 都带可空 disclosure，AliasDTO 另带 dead", async () => {
		const tree = asRecord((await get("/api/tree?domain=core")).body, "tree");
		const treeItem = asRecord((tree.items as unknown[])[0], "TreeNodeDTO");
		expect(Object.hasOwn(treeItem, "disclosure"), "TreeNodeDTO 缺 disclosure").toBe(true);

		store.addEdge(nodeOf("core://dto/alpha").node_id, "core://dto/beta", "k");
		store.addAlias("core://dto/old-alpha", nodeOf("core://dto/alpha").node_id, "入口级");
		const dto = asRecord((await get("/api/node?uri=core://dto/alpha")).body, "node");
		const edges = asRecord(dto.edges, "edges");
		const out = asRecord((edges.outgoing as unknown[])[0], "EdgeDTO");
		expect(Object.hasOwn(out, "disclosure"), "EdgeDTO 缺 disclosure").toBe(true);
		const alias = asRecord((dto.aliases as unknown[])[0], "AliasDTO");
		expect(Object.hasOwn(alias, "disclosure"), "AliasDTO 缺 disclosure").toBe(true);
		expect(Object.hasOwn(alias, "dead"), "AliasDTO 缺 dead").toBe(true);
		// `dead` 谓词：alias_uri 不是存活 nodes.uri ⇒ false。
		expect(alias.dead).toBe(false);
	});

	it("⭐ 入口作用域：同一节点从别名进 vs 从规范 uri 进看到不同 disclosure", async () => {
		store.insertNode({ uri: "core://dto/entry", content: "X", disclosure: "节点级", source: "manual" });
		store.addAlias("core://dto/entry/alias", nodeOf("core://dto/entry").node_id, "入口级");

		// ① 从别名进 → 入口值
		const a = asRecord(asRecord((await get("/api/node?uri=core://dto/entry/alias")).body, "node").node, "node");
		expect(a.disclosure).toBe("入口级");
		// ② 从规范 uri 进 → 节点值（同一节点，不同答案）
		const b = asRecord(asRecord((await get("/api/node?uri=core://dto/entry")).body, "node").node, "node");
		expect(b.disclosure).toBe("节点级");
		// ③ 从别名 revise → 只改别名层，规范入口不变（防跨入口污染）
		const res = await fetch(`${server.url}/api/node/revise`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Host: new URL(server.url).host },
			body: JSON.stringify({ uri: "core://dto/entry/alias", disclosure: "入口级2" }),
		});
		expect(res.status).toBe(200);
		expect(store.effectiveDisclosure("core://dto/entry/alias")).toBe("入口级2");
		expect(store.effectiveDisclosure("core://dto/entry")).toBe("节点级");

		// ④ `renderEntryDisclosures` 需要 ≥2 入口才渲染 ⇒ 此节点的 aliases 非空。
		const dto = asRecord((await get("/api/node?uri=core://dto/entry/alias")).body, "node");
		expect((dto.aliases as unknown[]).length).toBeGreaterThan(0);
	});

	it('⭐ route 层 `""` 归一为 null（不写空串、不切断 ?? 回退）', async () => {
		store.insertNode({ uri: "core://dto/blank", content: "Y", source: "manual" });
		const post = async (path: string, payload: unknown): Promise<number> => {
			const res = await fetch(`${server.url}${path}`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Host: new URL(server.url).host },
				body: JSON.stringify(payload),
			});
			return res.status;
		};
		expect(await post("/api/node/revise", { uri: "core://dto/blank", disclosure: "" })).toBe(200);
		const after = asRecord(asRecord((await get("/api/node?uri=core://dto/blank")).body, "node").node, "node");
		expect(after.disclosure, '空串必须归一为 null，不是 ""').toBeNull();
		expect(store.effectiveDisclosure("core://dto/blank")).toBeNull();

		// 别名入口上同理：空串 → 别名层 NULL ⇒ 仍能 `??` 继承节点级（没被空串截断）。
		store.addAlias("core://dto/blank-alias", nodeOf("core://dto/blank").node_id, "别名条件");
		expect(await post("/api/node/revise", { uri: "core://dto/blank-alias", disclosure: "" })).toBe(200);
		expect(store.effectiveDisclosure("core://dto/blank-alias")).toBeNull();
		// 节点级此时也是 null，故加一个再验继承真的走通。
		expect(await post("/api/node/revise", { uri: "core://dto/blank", disclosure: "节点级" })).toBe(200);
		expect(store.effectiveDisclosure("core://dto/blank-alias"), "?? 回退被空串切断").toBe("节点级");
	});

	it('⭐ POST /api/node 同样归一 `""`（不是只改 revise 一路）', async () => {
		const res = await fetch(`${server.url}/api/node`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Host: new URL(server.url).host },
			body: JSON.stringify({ uri: "core://dto/blank-node", content: "Z", disclosure: "" }),
		});
		expect(res.status).toBe(200);
		const dto = asRecord((await get("/api/node?uri=core://dto/blank-node")).body, "node");
		expect(asRecord(dto.node, "node").disclosure).toBeNull();
	});

	it("⭐ `EdgeDTO.disclosure` 是裸边列，不经 effectiveDisclosure（契约 §3.2 例外）", async () => {
		store.insertNode({ uri: "core://dto/peer", content: "对端", disclosure: "对端的想起条件", source: "manual" });
		store.addEdge(nodeOf("core://dto/alpha").node_id, "core://dto/peer", "k", "边自己的关联条件");
		const dto = asRecord((await get("/api/node?uri=core://dto/alpha")).body, "node");
		const edges = asRecord(dto.edges, "edges");
		const edge = (edges.outgoing as unknown[])
			.map((raw) => asRecord(raw, "EdgeDTO"))
			.find((e) => e.uri === "core://dto/peer");
		expect(edge, "找不到指向 peer 的边").toBeDefined();
		expect(edge!.disclosure, "边条件被对端节点的想起条件顶替了").toBe("边自己的关联条件");
		// 反向证明二者不是一回事：对端节点自己的入口条件不同。
		expect(store.effectiveDisclosure("core://dto/peer")).toBe("对端的想起条件");
	});
});

/**
 * ⭐ 边级 disclosure 轨（D5 §10-B/§10-C/§10-G）的三张 DTO 新字段与入口作用域。
 *
 * 非空性：`TreeNodeDTO`/`EdgeDTO`/`AliasDTO` 三个 `disclosure` 与 `AliasDTO.dead`
 * 在本轮之前**都不存在**（契约 §2.8 实测），故这些断言在旧代码上必红。
 */
describe("disclosure：三张 DTO 的新字段与入口作用域（D5 §2.1 / §10-B）", () => {
	const jsonPost = async (path: string, payload: unknown): Promise<{ status: number; body: unknown }> => {
		const res = await fetch(`${server.url}${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Host: new URL(server.url).host },
			body: JSON.stringify(payload),
		});
		const text = await res.text();
		return { status: res.status, body: text ? JSON.parse(text) : null };
	};

	it("TreeNodeDTO / EdgeDTO / AliasDTO 都带可空 disclosure，AliasDTO 另带 dead", async () => {
		const tree = asRecord((await get("/api/tree?domain=core")).body, "tree");
		const treeItem = asRecord((tree.items as unknown[])[0], "TreeNodeDTO");
		expect(Object.hasOwn(treeItem, "disclosure"), "TreeNodeDTO 缺 disclosure").toBe(true);

		store.addEdge(nodeOf("core://dto/alpha").node_id, "core://dto/beta", "k");
		store.addAlias("core://dto/old-alpha", nodeOf("core://dto/alpha").node_id, "入口级");
		const dto = asRecord((await get("/api/node?uri=core://dto/alpha")).body, "node");
		const edges = asRecord(dto.edges, "edges");
		const out = asRecord((edges.outgoing as unknown[])[0], "EdgeDTO");
		expect(Object.hasOwn(out, "disclosure"), "EdgeDTO 缺 disclosure").toBe(true);
		const alias = asRecord((dto.aliases as unknown[])[0], "AliasDTO");
		expect(Object.hasOwn(alias, "disclosure"), "AliasDTO 缺 disclosure").toBe(true);
		expect(Object.hasOwn(alias, "dead"), "AliasDTO 缺 dead").toBe(true);
		// `dead` 谓词：alias_uri 不是存活 nodes.uri ⇒ false。
		expect(alias.dead).toBe(false);
	});

	it("⭐ 入口作用域：同一节点从别名进 vs 从规范 uri 进看到不同 disclosure", async () => {
		store.insertNode({ uri: "core://dto/entry", content: "X", disclosure: "节点级", source: "manual" });
		store.addAlias("core://dto/entry/alias", nodeOf("core://dto/entry").node_id, "入口级");

		// ① 从别名进 → 入口值
		const a = asRecord(asRecord((await get("/api/node?uri=core://dto/entry/alias")).body, "node").node, "node");
		expect(a.disclosure).toBe("入口级");
		// ② 从规范 uri 进 → 节点值（同一节点，不同答案）
		const b = asRecord(asRecord((await get("/api/node?uri=core://dto/entry")).body, "node").node, "node");
		expect(b.disclosure).toBe("节点级");
		// ③ 从别名 revise → 只改别名层，规范入口不变（防跨入口污染）
		expect(
			(await jsonPost("/api/node/revise", { uri: "core://dto/entry/alias", disclosure: "入口级2" })).status,
		).toBe(200);
		expect(store.effectiveDisclosure("core://dto/entry/alias")).toBe("入口级2");
		expect(store.effectiveDisclosure("core://dto/entry")).toBe("节点级");

		// ④ `renderEntryDisclosures` 需要 ≥2 入口才渲染 ⇒ 此节点的 aliases 非空。
		const dto = asRecord((await get("/api/node?uri=core://dto/entry/alias")).body, "node");
		expect((dto.aliases as unknown[]).length).toBeGreaterThan(0);
	});

	it('⭐ route 层 `""` 归一为 null（不写空串、不切断 ?? 回退）', async () => {
		store.insertNode({ uri: "core://dto/blank", content: "Y", source: "manual" });
		expect((await jsonPost("/api/node/revise", { uri: "core://dto/blank", disclosure: "" })).status).toBe(200);
		const after = asRecord(asRecord((await get("/api/node?uri=core://dto/blank")).body, "node").node, "node");
		expect(after.disclosure, '空串必须归一为 null，不是 ""').toBeNull();
		expect(store.effectiveDisclosure("core://dto/blank")).toBeNull();

		// 别名入口上同理：空串 → 别名层 NULL ⇒ 仍能 `??` 继承节点级（没被空串截断）。
		store.addAlias("core://dto/blank-alias", nodeOf("core://dto/blank").node_id, "别名条件");
		expect((await jsonPost("/api/node/revise", { uri: "core://dto/blank-alias", disclosure: "" })).status).toBe(200);
		expect(store.effectiveDisclosure("core://dto/blank-alias")).toBeNull();
		expect((await jsonPost("/api/node/revise", { uri: "core://dto/blank", disclosure: "节点级" })).status).toBe(200);
		expect(store.effectiveDisclosure("core://dto/blank-alias"), "?? 回退被空串切断").toBe("节点级");
	});

	it('⭐ POST /api/node 同样归一 `""`（不是只改 revise 一路）', async () => {
		const res = await jsonPost("/api/node", { uri: "core://dto/blank-node", content: "Z", disclosure: "" });
		expect(res.status).toBe(200);
		const dto = asRecord((await get("/api/node?uri=core://dto/blank-node")).body, "node");
		expect(asRecord(dto.node, "node").disclosure).toBeNull();
	});

	it("⭐ `EdgeDTO.disclosure` 是裸边列，不经 effectiveDisclosure（契约 §3.2 例外）", async () => {
		store.insertNode({ uri: "core://dto/peer", content: "对端", disclosure: "对端的想起条件", source: "manual" });
		store.addEdge(nodeOf("core://dto/alpha").node_id, "core://dto/peer", "k", "边自己的关联条件");
		const dto = asRecord((await get("/api/node?uri=core://dto/alpha")).body, "node");
		const edges = asRecord(dto.edges, "edges");
		const edge = (edges.outgoing as unknown[])
			.map((raw) => asRecord(raw, "EdgeDTO"))
			.find((e) => e.uri === "core://dto/peer");
		expect(edge, "找不到指向 peer 的边").toBeDefined();
		expect(edge?.disclosure, "边条件被对端节点的想起条件顶替了").toBe("边自己的关联条件");
		// 反向证明二者不是一回事：对端节点自己的入口条件不同。
		expect(store.effectiveDisclosure("core://dto/peer")).toBe("对端的想起条件");
	});
});
