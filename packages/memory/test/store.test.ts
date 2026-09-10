import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type MemoryDatabase, openDatabase } from "../src/driver.ts";
import { createSchema } from "../src/schema.ts";
import { type MemoryNode, MemoryStore } from "../src/store.ts";

let db: MemoryDatabase;
let store: MemoryStore;

beforeEach(async () => {
	db = await openDatabase(":memory:");
	createSchema(db);
	store = new MemoryStore(db);
});

afterEach(() => {
	db.close();
});

function nodeByUri(uri: string): MemoryNode {
	const node = store.resolveUri(uri);
	if (!node) throw new Error(`missing node ${uri}`);
	return node;
}

describe("MemoryStore CRUD", () => {
	it("inserts and gets a node", () => {
		const node = store.insertNode({ uri: "history://scene/001", content: "伊莱进入酒馆" });
		expect(node.node_id).toBeTruthy();
		expect(node.domain).toBe("history");
		expect(node.is_stub).toBe(0);
		expect(nodeByUri("history://scene/001").content).toBe("伊莱进入酒馆");
	});

	it("updates a node and archives a revision", () => {
		const node = store.insertNode({ uri: "history://scene/001", content: "v1" });
		const version = store.updateNode(node.node_id, { content: "v2" });
		expect(version).toBe(1);
		expect(nodeByUri("history://scene/001").content).toBe("v2");
		const revs = store.listRevisions(node.node_id);
		expect(revs).toHaveLength(1);
		expect(revs[0].content).toBe("v1");
		expect(revs[0].version).toBe(1);
	});

	it("restoreRevision brings old content back and archives again", () => {
		const node = store.insertNode({ uri: "history://scene/001", content: "v1" });
		store.updateNode(node.node_id, { content: "v2" });
		store.restoreRevision(node.node_id, 1);
		expect(nodeByUri("history://scene/001").content).toBe("v1");
		expect(store.currentVersion(node.node_id)).toBe(2);
	});

	it("deleteCascade removes node, children, aliases and fts", () => {
		const parent = store.insertNode({ uri: "history://arc", content: "arc" });
		const child = store.insertNode({ uri: "history://arc/scene", content: "scene", parent_uri: "history://arc" });
		store.addAlias("旧地址", parent.node_id);
		expect(store.deleteCascade(parent.node_id)).toBe(2);
		expect(store.resolveUri("history://arc")).toBeNull();
		expect(store.resolveUri("history://arc/scene")).toBeNull();
		expect(store.resolveUri("旧地址")).toBeNull();
		expect(child.node_id).toBeTruthy();
		const fts = db.prepare("SELECT COUNT(*) AS c FROM node_fts").get() as { c: number };
		expect(fts.c).toBe(0);
	});
});

describe("alias addressing", () => {
	it("resolves through alias", () => {
		const node = store.insertNode({ uri: "meta://self", content: "self" });
		store.addAlias("我", node.node_id);
		expect(store.resolveUri("我")?.node_id).toBe(node.node_id);
	});

	it("rename keeps old uri as working alias", () => {
		store.insertNode({ uri: "history://a", content: "content" });
		store.rename("history://a", "history://b");
		expect(store.resolveUri("history://b")?.content).toBe("content");
		expect(store.resolveUri("history://a")?.content).toBe("content");
		const fts = db.prepare("SELECT uri FROM node_fts").all() as Array<{ uri: string }>;
		expect(fts.map((r) => r.uri)).toEqual(["history://b"]);
	});
});

describe("stub parent chain", () => {
	it("put() auto-creates stub ancestors and filters them from FTS/recall", () => {
		store.put({ uri: "history://arc2/scene1/beat", content: "关键情节" });
		const stub = nodeByUri("history://arc2");
		expect(stub.is_stub).toBe(1);
		expect(nodeByUri("history://arc2/scene1").is_stub).toBe(1);
		const leaf = nodeByUri("history://arc2/scene1/beat");
		expect(leaf.is_stub).toBe(0);
		expect(leaf.parent_id).toBe(nodeByUri("history://arc2/scene1").node_id);
		// FTS only holds the non-stub leaf.
		const fts = db.prepare("SELECT uri FROM node_fts").all() as Array<{ uri: string }>;
		expect(fts.map((r) => r.uri)).toEqual(["history://arc2/scene1/beat"]);
		// Stub content is not recallable.
		expect(store.recall("arc2").map((n) => n.uri)).not.toContain("history://arc2");
		expect(store.recall("关键情节").map((n) => n.uri)).toContain("history://arc2/scene1/beat");
	});
});

describe("kv and world clock", () => {
	it("roundtrips kv values", () => {
		store.setKv("boot_uris", "history://a");
		expect(store.getKv("boot_uris")).toBe("history://a");
		expect(store.getKv("missing")).toBeNull();
	});

	it("setWorldTime supports absolute and relative shifts", () => {
		const abs = store.setWorldTime("2026-09-10T00:00:00.000Z");
		expect(abs).toBe("2026-09-10T00:00:00.000Z");
		const plus = store.setWorldTime("+1d");
		expect(plus).toBe("2026-09-11T00:00:00.000Z");
		const minus = store.setWorldTime("-2h");
		expect(minus).toBe("2026-09-10T22:00:00.000Z");
		// World time is stamped on new nodes.
		const node = store.insertNode({ uri: "history://t", content: "t" });
		expect(node.world_ts).toBe("2026-09-10T22:00:00.000Z");
	});

	it("setWorldTime rejects garbage", () => {
		expect(() => store.setWorldTime("not-a-time")).toThrow();
	});
});

describe("export / import", () => {
	it("roundtrips through a second store", async () => {
		const node = store.insertNode({ uri: "history://x", content: "v1" });
		store.updateNode(node.node_id, { content: "v2" });
		store.setKv("world_time", "2026-01-01T00:00:00.000Z");
		store.setKv("boot_uris", "history://x");
		const snapshot = store.export();
		const db2 = await openDatabase(":memory:");
		createSchema(db2);
		const store2 = new MemoryStore(db2);
		store2.import(snapshot);
		expect(store2.resolveUri("history://x")?.content).toBe("v2");
		expect(store2.getKv("boot_uris")).toBe("history://x");
		db2.close();
	});

	it("import into a fresh store restores full state", async () => {
		const node = store.insertNode({ uri: "history://x", content: "v1" });
		store.updateNode(node.node_id, { content: "v2" });
		store.setKv("world_time", "2026-01-01T00:00:00.000Z");
		const snapshot = store.export();

		const db2 = await openDatabase(":memory:");
		createSchema(db2);
		const store2 = new MemoryStore(db2);
		store2.import(snapshot);
		const restored = store2.resolveUri("history://x");
		expect(restored?.content).toBe("v2");
		expect(restored?.node_id).toBe(node.node_id);
		expect(store2.listRevisions(node.node_id)).toHaveLength(1);
		expect(store2.getKv("world_time")).toBe("2026-01-01T00:00:00.000Z");
		// FTS rebuilt on import.
		expect(store2.recall("v2").map((n) => n.uri)).toContain("history://x");
		db2.close();
	});
});

describe("seed", () => {
	it("creates core domains idempotently", () => {
		store.seed();
		store.seed();
		expect(store.resolveUri("index://")).not.toBeNull();
		expect(store.resolveUri("history://")).not.toBeNull();
		expect(store.resolveUri("meta://")).not.toBeNull();
		expect(store.getKv("schema_version")).toBe("1");
	});
});

describe("raw_log reconciliation", () => {
	it("appendRaw inserts rows and fts entries", () => {
		const id = store.appendRaw([
			{ role: "user", text: "你好", entry_id: "e1", wall_ts: "2026-09-10T00:00:00Z" },
			{ role: "assistant", text: "你好呀", entry_id: "e2", wall_ts: "2026-09-10T00:00:01Z" },
		]);
		expect(id).toBe(2);
		expect(store.listRaw(1, 2)).toHaveLength(2);
	});

	it("reconcileRawLog deletes rows off the active path (fts included)", () => {
		store.appendRaw([
			{ role: "user", text: "a", entry_id: "e1", wall_ts: "t" },
			{ role: "assistant", text: "b", entry_id: "e2", wall_ts: "t" },
			{ role: "user", text: "c", entry_id: "e3", wall_ts: "t" },
		]);
		const deleted = store.reconcileRawLog(["e1", "e3"]);
		expect(deleted).toBe(1);
		expect(store.listRaw(1, 3).map((r) => r.entry_id)).toEqual(["e1", "e3"]);
		const fts = db.prepare("SELECT entry_id FROM raw_fts").all() as Array<{ entry_id: string }>;
		expect(fts.map((r) => r.entry_id).sort()).toEqual(["e1", "e3"]);
	});

	it("reconcile with empty active path is a no-op (never wipes the log)", () => {
		store.appendRaw([{ role: "user", text: "x", entry_id: "e1", wall_ts: "t" }]);
		expect(store.reconcileRawLog([])).toBe(0);
		expect(store.listRaw(1)).toHaveLength(1);
	});
});

describe("recall", () => {
	it("ranks by keyword overlap with priority weight", () => {
		store.insertNode({ uri: "history://tavern", content: "伊莱在酒馆遇到薇拉", priority: 9 });
		store.insertNode({ uri: "history://forest", content: "薇拉在森林迷路", priority: 1 });
		const hits = store.recall("薇拉");
		expect(hits[0].uri).toBe("history://tavern");
	});

	it("domain blocklist filters results", () => {
		store.insertNode({ uri: "meta://noise", content: "系统维护记录 maintenance" });
		store.insertNode({ uri: "history://keep", content: "剧情 keep" });
		expect(store.recall("maintenance keep", { domainBlocklist: ["meta"] }).map((n) => n.uri)).toEqual([
			"history://keep",
		]);
	});

	it("respects limit", () => {
		for (let i = 0; i < 5; i++) store.insertNode({ uri: `history://n${i}`, content: `共同关键词 ${i}` });
		expect(store.recall("共同关键词", { limit: 2 })).toHaveLength(2);
	});
});

describe("TEMP dynamic zone", () => {
	it("counts only active non-stub TEMP nodes", () => {
		store.insertNode({ uri: "TEMP://note1", content: "临时 1" });
		store.insertNode({ uri: "TEMP://note2", content: "临时 2" });
		store.put({ uri: "TEMP://nested/deep", content: "临时 3" });
		expect(store.countTempNodes()).toBe(3);
	});
});

describe("anchor visibility predicate", () => {
	it("manual nodes are always visible; auto nodes depend on anchor", () => {
		const manual = store.insertNode({ uri: "history://m", content: "manual", source: "manual" });
		const autoActive = store.insertNode({
			uri: "history://a1",
			content: "auto on path",
			source: "auto",
			anchor_entry_id: "entry-1",
		});
		const autoOrphan = store.insertNode({
			uri: "history://a2",
			content: "auto off path",
			source: "auto",
			anchor_entry_id: "entry-9",
		});
		const activeBranch = new Set(["entry-1"]);
		const visible = (n: MemoryNode) =>
			store.isVisible(n, n.anchor_entry_id === null || activeBranch.has(n.anchor_entry_id));
		expect(visible(manual)).toBe(true);
		expect(visible(autoActive)).toBe(true);
		expect(visible(autoOrphan)).toBe(false);
	});
});

describe("audit log", () => {
	it("records external actions", () => {
		store.insertNode({ uri: "history://x", content: "x" });
		store.updateNode(store.resolveUri("history://x")!.node_id, { content: "y" });
		store.deleteCascade(store.resolveUri("history://x")!.node_id);
		const events = store.listAudit(10).map((a) => a.event);
		expect(events).toContain("insert_node");
		expect(events).toContain("update_node");
		expect(events).toContain("delete_node");
	});
});
