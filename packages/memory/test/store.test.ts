import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type MemoryDatabase, openDatabase } from "../src/driver.ts";
import { createSchema, SCHEMA_VERSION } from "../src/schema.ts";
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
		// FTS is reindexed under the new canonical uri (search hits the node,
		// not the alias).
		const node = store.resolveUri("history://b")!;
		expect(store.searchNodeFts(["history://b"]).has(node.node_id)).toBe(true);
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
		// FTS only holds the non-stub leaf (stub node_ids never appear).
		const ftsHits = store.searchNodeFts(["关键情节"]);
		expect([...ftsHits.keys()]).toEqual([leaf.node_id]);
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
		expect(store.getKv("schema_version")).toBe(SCHEMA_VERSION);
	});
});

describe("raw_log session-isolated mirror (§3)", () => {
	it("appendRaw inserts rows and fts entries (idempotent per session/entry)", () => {
		const id = store.appendRaw([
			{ role: "user", text: "你好", entry_id: "e1", session_id: "s1", wall_ts: "2026-09-10T00:00:00Z" },
			{ role: "assistant", text: "你好呀", entry_id: "e2", session_id: "s1", wall_ts: "2026-09-10T00:00:01Z" },
		]);
		expect(id).toBe(2);
		expect(store.listRaw(1, 2)).toHaveLength(2);
		// Replaying the same session/entry pair upserts, never duplicates.
		store.appendRaw([
			{ role: "user", text: "你好", entry_id: "e1", session_id: "s1", wall_ts: "2026-09-10T00:00:00Z" },
		]);
		expect(store.listRaw(1, 2)).toHaveLength(2);
	});

	it("syncRawBranch deactivates off-path rows of THIS session only; other sessions stay active", () => {
		// Session B's rows exist first — A's reroll must never touch them.
		store.appendRaw([
			{ role: "user", text: "B线", entry_id: "b1", session_id: "session-B", wall_ts: "t1" },
			{ role: "assistant", text: "B回应", entry_id: "b2", session_id: "session-B", wall_ts: "t2" },
		]);
		// Session A seeds its own branch e1,e2.
		store.appendRaw([
			{ role: "user", text: "a", entry_id: "e1", session_id: "session-A", wall_ts: "t3" },
			{ role: "assistant", text: "b", entry_id: "e2", session_id: "session-A", wall_ts: "t4" },
		]);
		const bRowIdsBefore = store.listRaw(1, 2, { sessionId: "session-B" }).map((r) => r.raw_id);

		// A switches to a branch containing only e1.
		store.syncRawBranch("session-A", [
			{ role: "user", text: "a", entry_id: "e1", session_id: "session-A", wall_ts: "t3" },
		]);
		const aActive = store.listRaw(1, 9, { sessionId: "session-A", activeOnly: true });
		expect(aActive.map((r) => r.entry_id)).toEqual(["e1"]);
		const aInactive = store
			.listRaw(1, 9, { sessionId: "session-A", activeOnly: false })
			.find((r) => r.entry_id === "e2");
		expect(aInactive?.active).toBe(0);
		const e2RawId = aInactive!.raw_id;

		// B's rows are untouched: same raw ids, still active.
		const bRows = store.listRaw(1, 2, { sessionId: "session-B", activeOnly: true });
		expect(bRows.map((r) => r.raw_id)).toEqual(bRowIdsBefore);
		expect(bRows.map((r) => r.entry_id)).toEqual(["b1", "b2"]);

		// A switches back to [e1,e2]: e2 revives with its ORIGINAL raw_id.
		store.syncRawBranch("session-A", [
			{ role: "user", text: "a", entry_id: "e1", session_id: "session-A", wall_ts: "t3" },
			{ role: "assistant", text: "b", entry_id: "e2", session_id: "session-A", wall_ts: "t4" },
		]);
		const revived = store.listRaw(1, 9, { sessionId: "session-A", activeOnly: true });
		expect(revived.map((r) => r.entry_id)).toEqual(["e1", "e2"]);
		expect(revived[1].raw_id).toBe(e2RawId);
	});

	it("syncRawBranch with an empty active list only deactivates that session's rows", () => {
		store.appendRaw([{ role: "user", text: "a", entry_id: "e1", session_id: "session-A", wall_ts: "t" }]);
		store.appendRaw([{ role: "user", text: "b", entry_id: "e2", session_id: "session-B", wall_ts: "t" }]);
		store.syncRawBranch("session-A", []);
		const a = store.listRaw(1, 9, { sessionId: "session-A" });
		expect(a[0].active).toBe(0);
		const b = store.listRaw(1, 9, { sessionId: "session-B" });
		expect(b[0].active).toBe(1);
	});

	it("upsert does not overwrite a previously persisted world timestamp", () => {
		store.appendRaw([
			{ role: "user", text: "a", entry_id: "e1", session_id: "s1", wall_ts: "t", world_ts: "2026-05-05T00:00:00Z" },
		]);
		store.syncRawBranch("s1", [
			{
				role: "user",
				text: "a改",
				entry_id: "e1",
				session_id: "s1",
				wall_ts: "t",
				world_ts: "2026-09-09T00:00:00Z",
			},
		]);
		const row = store.listRaw(1, 1);
		expect(row[0].text).toBe("a改");
		expect(row[0].world_ts).toBe("2026-05-05T00:00:00Z");
	});
});

describe("forget keeps the recovery path (§10)", () => {
	it("hard-deletes the node but keeps every revision, incl. the content at deletion", () => {
		const node = store.insertNode({ uri: "core://habit", content: "v1" });
		store.updateNode(node.node_id, { content: "v2" });
		store.deleteCascade(node.node_id);

		// No zombie entry: the node row is really gone.
		expect(store.resolveUri("core://habit")).toBeNull();
		// …but the history survives, ending with the content as it stood.
		const revs = store.listRevisionsByUri("core://habit");
		expect(revs.map((r) => r.content)).toEqual(["v1", "v2"]);
		expect(revs.every((r) => r.alive === false)).toBe(true);
	});

	it("lists deleted uris and restores one from its newest revision", () => {
		const node = store.insertNode({ uri: "core://habit", content: "晨读" });
		store.deleteCascade(node.node_id);
		expect(store.listDeletedUris().map((d) => d.uri)).toEqual(["core://habit"]);

		const restored = store.restoreDeleted("core://habit");
		expect(restored.content).toBe("晨读");
		expect(restored.source).toBe("import");
		expect(store.listDeletedUris()).toEqual([]);
		expect(() => store.restoreDeleted("core://habit")).toThrow(/still exists/);
	});

	it("rejects relocating a node into its own subtree", () => {
		store.put({ uri: "core://a", content: "父" });
		store.put({ uri: "core://a/sub", content: "子" });
		expect(() => store.relocateMany([{ from: "core://a", to: "core://a/sub" }])).toThrow(/nested inside source/);
		// Zero-change guarantee: the tree is untouched and still traversable.
		const root = store.resolveUri("core://a");
		expect(root).not.toBeNull();
		expect(root?.parent_id).toBeNull();
		expect(store.children(root!.node_id).map((n) => n.uri)).toEqual(["core://a/sub"]);
	});

	it("restoreDeleted rebuilds the implicit parent chain", () => {
		store.put({ uri: "core://p", content: "父" });
		const child = store.put({ uri: "core://p/c", content: "子" });
		store.deleteCascade(child.node_id);
		expect(store.resolveUri("core://p/c")).toBeNull();

		const restored = store.restoreDeleted("core://p/c");
		const parent = store.resolveUri("core://p");
		expect(parent).not.toBeNull();
		expect(restored.parent_id).toBe(parent!.node_id);
		expect(store.children(parent!.node_id).map((n) => n.uri)).toContain("core://p/c");
	});

	it("cascade-deletes children and keeps each child's revisions too", () => {
		const parent = store.insertNode({ uri: "core://a", content: "父" });
		store.insertNode({ uri: "core://a/b", content: "子", parent_uri: "core://a" });
		expect(store.deleteCascade(parent.node_id)).toBe(2);
		expect(
			store
				.listDeletedUris()
				.map((d) => d.uri)
				.sort(),
		).toEqual(["core://a", "core://a/b"]);
	});
});

describe("recall", () => {
	it("ranks by keyword overlap with importance weight", () => {
		store.insertNode({ uri: "history://tavern", content: "伊莱在酒馆遇到薇拉", importance: 9 });
		store.insertNode({ uri: "history://forest", content: "薇拉在森林迷路", importance: 1 });
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

	it("writes the full MemoryAuditDetails column set (node_id, turn, task, anchor, model, details)", () => {
		store.insertNode({ uri: "history://x", content: "x" });
		store.logAudit("test_event", {
			node_id: "n1",
			object: "history://x",
			source: "auto",
			model: "m1",
			turn: 7,
			task: "scene-summary",
			anchor: "e-42",
			details: JSON.stringify({ scores: { "history://x": 0.8 } }),
		});
		const row = store.listAudit(1)[0];
		expect(row.event).toBe("test_event");
		expect(row.node_id).toBe("n1");
		expect(row.object).toBe("history://x");
		expect(row.source).toBe("auto");
		expect(row.model).toBe("m1");
		expect(row.turn).toBe(7);
		expect(row.task).toBe("scene-summary");
		expect(row.anchor).toBe("e-42");
		expect(row.details).toContain("0.8");
	});
});

describe("tree writes: stub promotion, world_ts preservation, relocation (§5/§7/§9)", () => {
	it("put() onto a stub promotes it in place — no revision junk, content indexed", () => {
		store.put({ uri: "core://identity/habits/tea", content: "内容" }); // stub chain created
		const stub = store.resolveUri("core://identity")!;
		expect(stub.is_stub).toBe(1);
		expect(stub.content).toBe(""); // §5.1: stub content is empty, no "(stub: URI)"

		// Now fill the stub with real content at an exact URI.
		const promoted = store.put({ uri: "core://identity", content: "我就是伊莱。" });
		expect(promoted.is_stub).toBe(0);
		expect(promoted.content).toBe("我就是伊莱。");
		// Promotion is not a content change — no revision is archived.
		expect(store.listRevisionsByUri("core://identity")).toHaveLength(0);
		// Promoted content becomes searchable via FTS.
		expect(store.searchNodeFts(["伊莱"]).has(promoted.node_id)).toBe(true);
	});

	it("stub ancestors never enter FTS/recall", () => {
		store.put({ uri: "history://arc2/scene1/beat", content: "关键情节" });
		const stub = store.resolveUri("history://arc2")!;
		expect(stub.is_stub).toBe(1);
		// The stub's own node_id never appears as a hit — URI text of the
		// LEAF may match "arc2", but the stub row itself is not indexed.
		const hitIds = [...store.searchNodeFts(["arc2"]).keys()];
		expect(hitIds).not.toContain(stub.node_id);
		expect(hitIds.every((id) => store.getNode(id)!.is_stub === 0)).toBe(true);
	});

	it("upsert without world_ts never wipes an existing world timestamp", () => {
		const node = store.insertNode({
			uri: "history://w",
			content: "v1",
			world_ts: "2026-03-03T00:00:00Z",
		});
		store.updateNode(node.node_id, { content: "v2" }); // no world_ts in patch
		expect(store.getNode(node.node_id)!.world_ts).toBe("2026-03-03T00:00:00Z");
		// Explicit null clears.
		store.updateNode(node.node_id, { content: "v3", world_ts: null });
		expect(store.getNode(node.node_id)!.world_ts).toBeNull();
	});

	it("relocateMany moves a whole subtree across domains, remaps aliases and re-parents", () => {
		store.insertNode({ uri: "history://arc", content: "arc", source: "manual" });
		store.insertNode({ uri: "history://arc/scene1", content: "scene1", parent_uri: "history://arc" });
		store.insertNode({ uri: "history://arc/scene1/beat", content: "beat", parent_uri: "history://arc/scene1" });
		const root = store.resolveUri("history://arc")!;
		const scene = store.resolveUri("history://arc/scene1")!;
		const beat = store.resolveUri("history://arc/scene1/beat")!;

		store.relocateMany([{ from: "history://arc", to: "archive://done" }]);

		const movedRoot = store.resolveUri("archive://done")!;
		expect(movedRoot.node_id).toBe(root.node_id);
		expect(movedRoot.domain).toBe("archive");
		// Old canonical uris kept as working aliases (root AND descendants).
		expect(store.resolveUri("history://arc")?.node_id).toBe(root.node_id);
		expect(store.resolveUri("history://arc/scene1")?.node_id).toBe(scene.node_id);
		expect(store.resolveUri("history://arc/scene1/beat")?.node_id).toBe(beat.node_id);
		// Descendants remapped canonically.
		expect(store.resolveUri("archive://done/scene1")?.node_id).toBe(scene.node_id);
		expect(store.resolveUri("archive://done/scene1/beat")?.node_id).toBe(beat.node_id);
		// parent_id rewritten to the new implicit parent.
		expect(movedRoot.parent_id).toBeNull();
		expect(store.resolveUri("archive://done/scene1")?.parent_id).toBe(movedRoot.node_id);
	});

	it("relocateMany is atomic: any conflict leaves every node untouched", () => {
		store.insertNode({ uri: "history://a", content: "A", source: "manual" });
		store.insertNode({ uri: "history://a/b", content: "AB", parent_uri: "history://a" });
		store.insertNode({ uri: "archive://a/b", content: "occupied", source: "manual" });
		const aId = store.resolveUri("history://a")!.node_id;

		// Moving history://a → archive://a collides with the existing subtree.
		expect(() =>
			store.relocateMany([
				{ from: "history://a", to: "archive://a" },
				{ from: "history://a/b", to: "history://x" }, // would also conflict
			]),
		).toThrow();
		// Nothing moved, no new x.
		expect(store.resolveUri("history://a")?.node_id).toBe(aId);
		expect(store.resolveUri("history://x")).toBeNull();
		expect(store.resolveUri("archive://a/b")?.content).toBe("occupied");
	});
});

describe("revision retention (§12)", () => {
	it("setRevisionRetention validates the limit", () => {
		expect(() => store.setRevisionRetention(0)).toThrow();
		expect(() => store.setRevisionRetention(1.5)).toThrow();
		expect(() => store.setRevisionRetention(-1)).toThrow();
		store.setRevisionRetention(undefined); // unlimited default
		store.setRevisionRetention(3);
	});

	it("prunes the oldest revisions beyond the retention limit on each update", () => {
		store.setRevisionRetention(2);
		const node = store.insertNode({ uri: "core://r", content: "v1" });
		store.updateNode(node.node_id, { content: "v2" });
		store.updateNode(node.node_id, { content: "v3" });
		store.updateNode(node.node_id, { content: "v4" });
		// v4 is the CURRENT content — only archived versions live in the
		// revision log; retention keeps the two newest of those (v2, v3).
		const revs = store.listRevisionsByUri("core://r");
		expect(revs.map((r) => r.content)).toEqual(["v2", "v3"]);
	});

	it("deleteCascade archives the final content and still prunes to the retention limit", () => {
		store.setRevisionRetention(2);
		const node = store.insertNode({ uri: "core://gone", content: "v1" });
		store.updateNode(node.node_id, { content: "v2" });
		store.updateNode(node.node_id, { content: "v3" });
		store.deleteCascade(node.node_id);
		const revs = store.listRevisionsByUri("core://gone");
		// At least the content at deletion survives (§6 guarantee).
		expect(revs.length).toBeGreaterThanOrEqual(1);
		expect(revs[revs.length - 1].content).toBe("v3");
	});
});

describe("export snapshot asset classes (§19)", () => {
	function buildAssets(): void {
		const node = store.insertNode({ uri: "core://self", content: "我是伊莱", source: "manual" });
		store.addAlias("自己", node.node_id);
		store.addEdge(node.node_id, "core://other", "relates");
		store.insertNode({ uri: "core://other", content: "其他" });
		store.addGlossaryEntry("伊莱", node.node_id);
	}

	it("export includes aliases, edges and glossary; import restores them", async () => {
		buildAssets();
		const snap = store.export();
		expect(snap.aliases).toEqual([
			{ alias_uri: "自己", target_node_id: snap.nodes.find((n) => n.uri === "core://self")!.node_id },
		]);
		expect(snap.edges).toEqual([
			{
				node_id: snap.nodes.find((n) => n.uri === "core://self")!.node_id,
				target_uri: "core://other",
				kind: "relates",
			},
		]);
		expect(snap.glossary).toEqual([
			{ keyword: "伊莱", node_id: snap.nodes.find((n) => n.uri === "core://self")!.node_id },
		]);

		const db2 = await openDatabase("");
		createSchema(db2);
		const store2 = new MemoryStore(db2);
		store2.import(snap);
		expect(store2.resolveUri("自己")?.content).toBe("我是伊莱");
		expect(store2.listRelated(store2.resolveUri("core://self")!.node_id).length).toBeGreaterThan(0);
		expect(store2.lookupGlossary("伊莱")).not.toBeNull();
		db2.close();
	});

	it("import rejects non-existent targets and rolls back the whole snapshot", async () => {
		store.insertNode({ uri: "core://self", content: "我是伊莱", source: "manual" });
		const snap = store.export();
		// An alias pointing at a node_id not present in the snapshot.
		snap.aliases.push({ alias_uri: "鬼", target_node_id: "n-ghost" });
		const db2 = await openDatabase("");
		createSchema(db2);
		const store2 = new MemoryStore(db2);
		expect(() => store2.import(snap)).toThrow(/不存在|ghost|n-ghost|unknown/i);
		// Nothing imported.
		expect(store2.listNodes()).toHaveLength(0);
		db2.close();
	});
});
