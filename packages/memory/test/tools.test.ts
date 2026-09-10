import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveMemoryDbPath } from "../src/config.ts";
import { type MemoryDatabase, openDatabase } from "../src/driver.ts";
import { createSchema } from "../src/schema.ts";
import { MemoryStore } from "../src/store.ts";
import { createMemoryTools, getAwakenUris } from "../src/tools.ts";

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

function run(name: string, args: Record<string, unknown>): Promise<{ text: string; details: Record<string, unknown> }> {
	const tool = createMemoryTools(store).find((t) => t.name === name);
	if (!tool) throw new Error(`tool ${name} missing`);
	return tool.execute("call-1", args).then((r) => ({
		text: r.content.map((c) => c.text).join(""),
		details: r.details,
	}));
}

describe("memorize → recall → revise → forget chain", () => {
	it("full lifecycle with provenance autofill", async () => {
		const mem = createMemoryTools(store, { modelId: "test-model", leafId: "entry-42" });
		const memorize = mem.find((t) => t.name === "memorize");
		expect(memorize).toBeTruthy();

		const result = await memorize!.execute("c1", {
			uri: "history://scenes/tavern",
			content: "伊莱在酒馆遇到薇拉",
			when: "当提起酒馆之夜",
			importance: 3,
		});
		expect(result.content[0].text).toContain("已记下");

		const node = store.resolveUri("history://scenes/tavern")!;
		expect(node.source).toBe("manual");
		expect(node.model).toBe("test-model");
		expect(node.anchor_entry_id).toBe("entry-42");
		expect(node.disclosure).toBe("当提起酒馆之夜");
		expect(node.importance).toBe(3);

		// recall it back
		const recalled = await run("recall", { uri: "history://scenes/tavern" });
		expect(recalled.text).toContain("伊莱在酒馆遇到薇拉");

		// revise: replace
		const revised = await run("revise", { uri: "history://scenes/tavern", old_text: "伊莱", new_text: "艾莉丝" });
		expect(revised.text).toContain("已修订");
		expect(store.resolveUri("history://scenes/tavern")!.content).toContain("艾莉丝");
		expect(store.listRevisions(node.node_id)).toHaveLength(1);

		// forget (dry run first)
		const dry = await run("forget", { target: "history://scenes/tavern", dry_run: true });
		expect(dry.text).toContain("history://scenes/tavern");
		expect(store.resolveUri("history://scenes/tavern")).not.toBeNull();

		const gone = await run("forget", { target: "history://scenes/tavern" });
		expect(gone.details.deleted).toBe(1);
		expect(store.resolveUri("history://scenes/tavern")).toBeNull();
	});

	it("memorize with missing parent creates stub chain filtered from FTS", async () => {
		const result = await run("memorize", {
			uri: "core://identity/habits/tea",
			content: "喜欢在傍晚喝茶",
		});
		expect(result.text).toContain("已记下");
		expect(store.resolveUri("core://identity")).not.toBeNull();
		expect(store.resolveUri("core://identity/habits")!.is_stub).toBe(1);
		expect(store.resolveUri("core://identity/habits/tea")!.is_stub).toBe(0);

		// stub content must not pollute keyword recall
		const hits = store.recall("stub core identity");
		expect(hits.map((h) => h.uri)).not.toContain("core://identity");
	});

	it("duplicate memorize is rejected", async () => {
		await run("memorize", { uri: "core://x", content: "a" });
		const again = await run("memorize", { uri: "core://x", content: "b" });
		expect(again.text).toContain("已存在");
	});
});

describe("revise variants", () => {
	beforeEach(async () => {
		await run("memorize", { uri: "history://a", content: "第一行\n第二行\n第三行" });
	});

	it("append", async () => {
		const r = await run("revise", { uri: "history://a", append: "第四行" });
		expect(r.text).toContain("已修订");
		expect(store.resolveUri("history://a")!.content).toBe("第一行\n第二行\n第三行\n第四行");
	});

	it("line edit", async () => {
		await run("revise", { uri: "history://a", line: 2, line_content: "改过的第二行" });
		expect(store.resolveUri("history://a")!.content).toBe("第一行\n改过的第二行\n第三行");
	});

	it("batch mode", async () => {
		await run("memorize", { uri: "history://b", content: "另一条" });
		const r = await run("revise", {
			batch: [
				{ uri: "history://a", importance: 2 },
				{ uri: "history://b", append: "（补）" },
			],
		});
		expect(r.details.failed).toBe(0);
		expect(store.resolveUri("history://a")!.importance).toBe(2);
		expect(store.resolveUri("history://b")!.content).toContain("（补）");
	});

	it("old_text uniqueness is enforced", async () => {
		await run("memorize", { uri: "history://dup", content: "重复 重复" });
		const r = await run("revise", { uri: "history://dup", old_text: "重复", new_text: "唯一" });
		expect(r.text).toContain("不唯一");
	});
});

describe("retrace", () => {
	it("single id and range fetch raw text", async () => {
		store.appendRaw([
			{ role: "user", text: "开场白", entry_id: "e1", session_id: "session-1", wall_ts: "t1" },
			{ role: "assistant", text: "回应", entry_id: "e2", session_id: "session-1", wall_ts: "t2" },
		]);
		const one = await run("retrace", { raw_id: 1 });
		expect(one.text).toContain("开场白");
		const range = await run("retrace", { first_raw_id: 1, last_raw_id: 2 });
		expect(range.text).toContain("回应");
		expect(range.details.count).toBe(2);
	});

	it("query mode searches active raw rows (activeOnly)", async () => {
		store.appendRaw([
			{ role: "user", text: "北方商队抵达", entry_id: "e1", session_id: "session-1", wall_ts: "t1" },
			{ role: "assistant", text: "薇拉回应", entry_id: "e2", session_id: "session-1", wall_ts: "t2" },
		]);
		const r = await run("retrace", { query: "商队" });
		expect(r.text).toContain("北方商队");
		expect(r.details.count).toBe(1);
	});

	it("uri mode returns the raw window anchored by first/last raw ids", async () => {
		store.appendRaw([
			{ role: "user", text: "第一句", entry_id: "e1", session_id: "session-1", wall_ts: "t1" },
			{ role: "assistant", text: "第二句", entry_id: "e2", session_id: "session-1", wall_ts: "t2" },
		]);
		store.put({
			uri: "history://sum",
			content: "纪要",
			first_raw_id: 1,
			last_raw_id: 2,
			anchor_session_id: "session-1",
		});
		const r = await run("retrace", { uri: "history://sum" });
		expect(r.text).toContain("第一句");
		expect(r.text).toContain("第二句");
	});
});

describe("set_time", () => {
	it("absolute and relative shift", async () => {
		await run("set_time", { time: "2026-06-05" });
		expect(store.getWorldTime()).toBe("2026-06-05");
		const next = await run("set_time", { time: "+1d" });
		expect(next.text).toContain("2026-06-06");
	});
});

describe("awaken list/set/add/remove", () => {
	it("manages awaken_uris in memory_kv", async () => {
		store.insertNode({ uri: "core://self", content: "我是伊莱" });
		await run("awaken", { action: "set", uris: ["core://self"] });
		expect(getAwakenUris(store)).toEqual(["core://self"]);

		store.insertNode({ uri: "core://goal", content: "目标" });
		await run("awaken", { action: "add", uris: ["core://goal"] });
		expect(getAwakenUris(store)).toEqual(["core://self", "core://goal"]);

		await run("awaken", { action: "remove", uris: ["core://self"] });
		expect(getAwakenUris(store)).toEqual(["core://goal"]);

		const listed = await run("awaken", { action: "list" });
		expect(listed.text).toContain("core://goal");
	});
});

describe("relocate", () => {
	it("moves node and keeps old uri as alias", async () => {
		await run("memorize", { uri: "history://scene1", content: "场景" });
		const r = await run("relocate", { uri: "history://scene1", to: "archive://scene1" });
		expect(r.text).toContain("已移动");
		expect(store.resolveUri("archive://scene1")!.content).toBe("场景");
		expect(store.resolveUri("history://scene1")!.content).toBe("场景");
	});

	it("dry_run previews conflicts", async () => {
		await run("memorize", { uri: "history://a", content: "a" });
		await run("memorize", { uri: "history://b", content: "b" });
		const r = await run("relocate", { uri: "history://a", to: "history://b", dry_run: true });
		expect(r.text).toContain("目标已占用");
	});
});

describe("associate and trigger", () => {
	it("associate creates alias entry", async () => {
		await run("memorize", { uri: "core://self", content: "我" });
		const r = await run("associate", { target_uri: "core://self", new_uri: "自己" });
		expect(r.text).toContain("已关联");
		expect(store.resolveUri("自己")!.uri).toBe("core://self");
	});

	it("trigger adds and removes glossary", async () => {
		await run("memorize", { uri: "core://self", content: "我" });
		await run("trigger", { uri: "core://self", add: ["伊莱"] });
		expect(store.lookupGlossary("伊莱")).not.toBeNull();
		await run("trigger", { uri: "core://self", remove: ["伊莱"] });
		expect(store.lookupGlossary("伊莱")).toBeNull();
	});
});

describe("consolidate", () => {
	beforeEach(async () => {
		await run("memorize", { uri: "history://s1", content: "场景一" });
		await run("memorize", { uri: "history://s2", content: "场景二" });
	});

	it("merge folds sources into one node and deletes them", async () => {
		const r = await run("consolidate", {
			resolution: "merge",
			target_uri: "history://merged",
			source_uris: ["history://s1", "history://s2"],
			content: "两场景合并",
		});
		expect(r.text).toContain("已合并");
		expect(store.resolveUri("history://s1")).toBeNull();
		expect(store.resolveUri("history://merged")!.content).toBe("两场景合并".slice(0, 5) || "两场景合并");
	});

	it("keep creates theme without touching sources", async () => {
		await run("consolidate", {
			resolution: "keep",
			target_uri: "meta://theme",
			source_uris: ["history://s1", "history://s2"],
			content: "主题",
		});
		expect(store.resolveUri("history://s1")).not.toBeNull();
		expect(store.resolveUri("meta://theme")).not.toBeNull();
	});

	it("group moves sources under the theme", async () => {
		await run("consolidate", {
			resolution: "group",
			target_uri: "meta://arc",
			source_uris: ["history://s1", "history://s2"],
			content: "主题",
		});
		expect(store.resolveUri("meta://arc/s1")).not.toBeNull();
	});
});

describe("recall system views", () => {
	it("recent view lists by updated_ts", async () => {
		await run("memorize", { uri: "history://one", content: "一" });
		await run("memorize", { uri: "history://two", content: "二" });
		const r = await run("recall", { uri: "MEM://recent/5" });
		expect(r.text).toContain("history://one");
		expect(r.text).toContain("history://two");
	});

	it("index view lists domain roots", async () => {
		await run("memorize", { uri: "core://identity", content: "身份" });
		const r = await run("recall", { uri: "MEM://index" });
		expect(r.text).toContain("core://identity");
	});
});

describe("retrieve", () => {
	it("finds nodes by keyword", async () => {
		await run("memorize", { uri: "history://tavern", content: "薇拉在酒馆" });
		const r = await run("retrieve", { query: "薇拉 酒馆" });
		expect(r.text).toContain("history://tavern");
	});
});

describe("resolveMemoryDbPath", () => {
	it("follows CLI > settings > preset > default precedence", () => {
		expect(resolveMemoryDbPath("/tmp/cli.db", { memory: { dbPath: "settings.db" } }, undefined, "/p")).toBe(
			"/tmp/cli.db",
		);
		expect(
			resolveMemoryDbPath(undefined, { memory: { dbPath: "settings.db" } }, { memory: { dbPath: "p.db" } }, "/p"),
		).toBe("/p/settings.db");
		expect(resolveMemoryDbPath(undefined, undefined, { memory: { dbPath: "/abs/p.db" } }, "/p")).toBe("/abs/p.db");
		expect(resolveMemoryDbPath(undefined, undefined, undefined, "/p")).toBe("/p/.pi/memory.db");
	});
});

describe("revise history/restore (§13/§25)", () => {
	it("history lists revisions with the live content marked current", async () => {
		await run("memorize", { uri: "history://evolve", content: "v1" });
		await run("revise", { uri: "history://evolve", append: "v2-tail" });
		const r = await run("revise", { action: "history", uri: "history://evolve" });
		expect(r.text).toContain("v1");
		expect(r.text).toContain("v1\nv2-tail");
		expect(r.text).toContain("current");
	});

	it("history without uri lists recoverable deleted uris", async () => {
		await run("memorize", { uri: "history://gone", content: "将被删除" });
		await run("forget", { target: "history://gone" });
		const r = await run("revise", { action: "history" });
		expect(r.text).toContain("history://gone");
	});

	it("restore on a deleted uri revives the newest version; a missing version errors", async () => {
		await run("memorize", { uri: "history://resurrect", content: "v-original" });
		await run("revise", { uri: "history://resurrect", old_text: "v-original", new_text: "v-new" });
		await run("forget", { target: "history://resurrect" });
		// Wrong version → hard error, nothing recreated.
		const bad = await run("revise", { action: "restore", uri: "history://resurrect", version: 99 });
		expect(bad.text).toMatch(/版本|version/i);
		expect(store.resolveUri("history://resurrect")).toBeNull();
		// Correct restore → newest version back.
		const r = await run("revise", { action: "restore", uri: "history://resurrect" });
		expect(r.text).toContain("已从修订史恢复");
		expect(store.resolveUri("history://resurrect")!.content).toBe("v-new");
	});
});

describe("associate edges and one-hop retrieve diffusion (§15.5)", () => {
	it("related_uri mode creates a directional edge (self-links forbidden)", async () => {
		await run("memorize", { uri: "core://alice", content: "艾丽丝" });
		await run("memorize", { uri: "core://bob", content: "鲍勃" });
		const r = await run("associate", { target_uri: "core://alice", related_uri: "core://bob", kind: "associate_of" });
		expect(r.text).toContain("已建立联想");
		const related = store.listRelated(store.resolveUri("core://alice")!.node_id);
		expect(
			related.some((e) => e.target_uri === "core://bob" && e.kind === "associate_of" && e.direction === "outgoing"),
		).toBe(true);
		// Self-link rejected.
		const self = await run("associate", { target_uri: "core://alice", related_uri: "core://alice" });
		expect(self.text).toContain("自关联");
	});

	it("new_uri and related_uri are mutually exclusive", async () => {
		await run("memorize", { uri: "core://a", content: "A" });
		const r = await run("associate", { target_uri: "core://a", new_uri: "甲", related_uri: "core://a" });
		expect(r.text).toContain("需要且仅需要");
	});

	it("retrieve diffuses one hop through edges and labels them via_edge", async () => {
		await run("memorize", { uri: "history://quest", content: "主线任务 quest" });
		await run("memorize", { uri: "history://npc", content: "重要 NPC 人物" });
		await run("associate", { target_uri: "history://quest", related_uri: "history://npc", kind: "involves" });
		// Direct hit on quest only — the NPC comes via the edge.
		const r = await run("retrieve", { query: "主线任务", semantic: false });
		expect(r.text).toContain("history://quest");
		expect(r.text).toContain("history://npc");
		const npcId = store.resolveUri("history://npc")!.node_id;
		expect(r.details.node_ids as string[]).toContain(npcId);
	});
});

describe("consolidate group parentage (§2.5)", () => {
	beforeEach(async () => {
		await run("memorize", { uri: "history://g1", content: "分组一" });
		await run("memorize", { uri: "history://g2", content: "分组二" });
	});

	it("reparents moved roots onto the theme node", async () => {
		await run("consolidate", {
			resolution: "group",
			target_uri: "meta://arc",
			source_uris: ["history://g1", "history://g2"],
			content: "主题",
		});
		const theme = store.resolveUri("meta://arc")!;
		// children() exposes canonical uris — the sources now live under the
		// theme, old uris kept as aliases.
		expect(
			store
				.children(theme.node_id)
				.map((c) => c.uri)
				.sort(),
		).toEqual(["meta://arc/g1", "meta://arc/g2"]);
		expect(store.resolveUri("history://g1")!.parent_id).toBe(theme.node_id);
		expect(store.resolveUri("history://g2")!.parent_id).toBe(theme.node_id);
	});

	it("rejects grouping a source into its own subtree", async () => {
		await run("memorize", { uri: "history://g1/child", content: "子节点", parent_uri: "history://g1" });
		const r = await run("consolidate", {
			resolution: "group",
			target_uri: "history://g1/child",
			source_uris: ["history://g1"],
			content: "主题",
		});
		expect(r.text).toContain("冲突");
		// Nothing changed: no theme was created, source untouched.
		expect(store.resolveUri("history://g1")).not.toBeNull();
		expect(store.resolveUri("history://g1/child")?.content).toBe("子节点");
	});
});

describe("stub promotion through tools (§5.3)", () => {
	it("memorize onto a stub promotes it instead of rejecting", async () => {
		await run("memorize", { uri: "core://identity/habits/tea", content: "先建链" });
		// The stub exists as an ancestor.
		expect(store.resolveUri("core://identity")!.is_stub).toBe(1);
		// Memorizing real content at the stub uri promotes it.
		const r = await run("memorize", { uri: "core://identity", content: "身份：我是伊莱" });
		expect(r.text).not.toContain("已存在");
		expect(store.resolveUri("core://identity")!.is_stub).toBe(0);
		expect(store.resolveUri("core://identity")!.content).toBe("身份：我是伊莱");
	});

	it("revise with a body edit promotes a stub and stamps editor_source manual", async () => {
		await run("memorize", { uri: "core://self/habit", content: "喝茶习惯" });
		await run("revise", { uri: "core://self", append: "被修订的身份" });
		const node = store.resolveUri("core://self")!;
		expect(node.is_stub).toBe(0);
		expect(node.content).toBe("被修订的身份");
		expect(node.source).toBe("manual");
	});
});
