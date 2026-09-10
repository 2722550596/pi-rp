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
			{ role: "user", text: "开场白", entry_id: "e1", wall_ts: "t1" },
			{ role: "assistant", text: "回应", entry_id: "e2", wall_ts: "t2" },
		]);
		const one = await run("retrace", { raw_id: 1 });
		expect(one.text).toContain("开场白");
		const range = await run("retrace", { first_raw_id: 1, last_raw_id: 2 });
		expect(range.text).toContain("回应");
		expect(range.details.count).toBe(2);
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
		const r = await run("recall", { uri: "system://recent/5" });
		expect(r.text).toContain("history://one");
		expect(r.text).toContain("history://two");
	});

	it("index view lists domain roots", async () => {
		await run("memorize", { uri: "core://identity", content: "身份" });
		const r = await run("recall", { uri: "system://index" });
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
