import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveMemoryDbPath } from "../src/config.ts";
import { type MemoryDatabase, openDatabase } from "../src/driver.ts";
import { createSchema } from "../src/schema.ts";
import { MemoryStore } from "../src/store.ts";
import { createMemoryTools, getAwakenUris, MAX_DIFF_BYTES, MAX_DIFF_ITEMS } from "../src/tools.ts";

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

	it("forget target schema is anyOf array-first (Vertex function-declaration validation)", async () => {
		// Vertex/Gemini merges anyOf branches; string-first unions yield an illegal
		// `type: string` + `items` schema → 400 "schema type should be ARRAY".
		// Same trap as the read tool's `path`: array branch MUST come first.
		const forget = createMemoryTools(store).find((t) => t.name === "forget");
		expect(forget).toBeTruthy();
		// In-process TypeBox definition whose exact shape we control; TSchema's
		// static type just doesn't expose object properties — named, shape-checked.
		const params = forget!.parameters as {
			properties: { target: { anyOf: Array<{ type?: string; items?: { type: string } }> } };
		};
		const target = params.properties.target;
		expect(target.anyOf[0].type).toBe("array");
		expect(target.anyOf[0].items?.type).toBe("string");
		expect(target.anyOf[1].type).toBe("string");
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
		expect(r.details.failed_uris).toEqual([]);
		expect(store.resolveUri("history://a")!.importance).toBe(2);
		expect(store.resolveUri("history://b")!.content).toContain("（补）");
	});

	it("batch mode reports failed uris when a mod cannot apply (§16 S2/S3)", async () => {
		const r = await run("revise", {
			batch: [
				{ uri: "history://a", importance: 2 },
				{ uri: "history://nope", append: "（补）" },
			],
		});
		expect(r.details.failed).toBe(1);
		expect(r.details.failed_uris).toEqual(["history://nope"]);
		expect(r.text).toContain("已修订：history://a");
		expect(r.text).toContain("未找到：history://nope");
	});

	it("old_text uniqueness is enforced", async () => {
		await run("memorize", { uri: "history://dup", content: "重复 重复" });
		const r = await run("revise", { uri: "history://dup", old_text: "重复", new_text: "唯一" });
		expect(r.text).toContain("不唯一");
	});

	// 2026-09-21 mochi 事故：revise { uri, new_text }（漏 old_text）静默 no-op 却报"已修订"，
	// 库里内容纹丝不动，agent 被迫自写 memsafe 回读防御。孤立编辑字段必须响亮报错。
	it("orphan new_text fails loudly instead of silently no-oping", async () => {
		await run("memorize", { uri: "history://nt", content: "旧内容" });
		const r = await run("revise", { uri: "history://nt", new_text: "昨夜整理完成" });
		expect(r.text).not.toContain("已修订");
		expect(r.text).toContain("old_text");
		expect(store.resolveUri("history://nt")!.content).toBe("旧内容");
	});

	it("orphan line_content fails loudly instead of silently no-oping", async () => {
		const r = await run("revise", { uri: "history://a", line_content: "孤儿" });
		expect(r.text).not.toContain("已修订");
		expect(r.text).toContain("line");
		expect(store.resolveUri("history://a")!.content).toBe("第一行\n第二行\n第三行");
	});

	it("a mod with no edit fields at all fails loudly", async () => {
		const r = await run("revise", { uri: "history://a" });
		expect(r.text).not.toContain("已修订");
		expect(store.resolveUri("history://a")!.content).toBe("第一行\n第二行\n第三行");
	});

	// 整条重写：与 web 编辑器 content 字段同语义，store 全量覆写能力接进工具层。
	it("content rewrites the whole body, archives a revision, and renders a diff", async () => {
		const r = await run("revise", { uri: "history://a", content: "全新正文" });
		expect(r.text).toContain("已修订");
		expect(store.resolveUri("history://a")!.content).toBe("全新正文");
		expect(store.listRevisions(store.resolveUri("history://a")!.node_id)).toHaveLength(1);
		const diffs = r.details.diffs as Array<{ uri: string }>;
		expect(diffs).toHaveLength(1);
		expect(diffs[0].uri).toBe("history://a");
	});

	it("content rejects mixing with incremental edits", async () => {
		const r = await run("revise", { uri: "history://a", content: "新", old_text: "第一行", new_text: "改" });
		expect(r.text).toContain("混用");
		expect(store.resolveUri("history://a")!.content).toBe("第一行\n第二行\n第三行");
	});

	it("content rejects an empty body (delete is forget's job)", async () => {
		const r = await run("revise", { uri: "history://a", content: "" });
		expect(r.text).toContain("forget");
		expect(store.resolveUri("history://a")!.content).toBe("第一行\n第二行\n第三行");
	});

	it("content rewrite can also set metadata in one call", async () => {
		const r = await run("revise", { uri: "history://a", content: "新正文", importance: 3 });
		expect(r.text).toContain("已修订");
		expect(store.resolveUri("history://a")!.content).toBe("新正文");
		expect(store.resolveUri("history://a")!.importance).toBe(3);
	});

	it("batch supports per-mod content rewrites", async () => {
		const r = await run("revise", { batch: [{ uri: "history://a", content: "重写一" }] });
		expect(r.text).toContain("已修订");
		expect(store.resolveUri("history://a")!.content).toBe("重写一");
	});
});

describe("memorize result contract (§16 S2/S4)", () => {
	it("no longer echoes the body, keeping uri + machine signal", async () => {
		const r = await run("memorize", { uri: "core://q", content: "一大段正文不该出现在 result 里" });
		expect(r.text).toContain("已记下：core://q");
		expect(r.text).not.toContain("一大段正文");
		expect(r.details.ok).toBe(true);
		expect(r.details.uri).toBe("core://q");
		expect(r.details.node_id).toBeTruthy();
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

describe("recall rich formatting", () => {
	it("renders title, relative world time, disclosure, tags, and deeper memories at depth 0", async () => {
		store.setWorldTime("2020-09-28");
		await run("memorize", {
			uri: "history://scenes/tavern",
			content: "伊莱在酒馆遇到薇拉",
			when: "当提起酒馆之夜",
			time: "2020-09-27",
		});
		await run("trigger", { uri: "history://scenes/tavern", add: ["酒馆", "初遇"] });
		await run("memorize", {
			uri: "history://scenes/tavern/fight",
			content: "酒馆里发生了冲突",
			parent_uri: "history://scenes/tavern",
			when: "当提到打斗",
		});

		const r = await run("recall", { uri: "history://scenes/tavern", depth: 0 });
		expect(r.text).toContain("# [history://scenes/tavern]");
		expect(r.text).toContain("> (发生于: 2020-09-27，昨天)");
		expect(r.text).toContain("> (想起条件: 当提起酒馆之夜)");
		expect(r.text).toContain("> (标签: 初遇, 酒馆)");
		expect(r.text).toContain("伊莱在酒馆遇到薇拉");
		expect(r.text).toContain("更深层的记忆:");
		expect(r.text).toContain("- history://scenes/tavern/fight (当提到打斗)");
	});

	it("renders subtree with indentation and disclosure at depth > 0", async () => {
		await run("memorize", {
			uri: "core://identity",
			content: "我是伊莱",
			when: "当确认身份",
		});
		await run("memorize", {
			uri: "core://identity/habits",
			content: "平时的习惯",
			parent_uri: "core://identity",
			when: "当闲聊日常",
		});

		const r = await run("recall", { uri: "core://identity", depth: 1 });
		expect(r.text).toContain("# [core://identity]");
		expect(r.text).toContain("■ core://identity/habits");
		expect(r.text).toContain("(想起条件: 当闲聊日常)");
		expect(r.text).toContain("平时的习惯");
	});
});

describe("retrieve formatting", () => {
	it("finds nodes by keyword and renders importance, disclosure, and snippet", async () => {
		await run("memorize", {
			uri: "history://tavern",
			content: "薇拉在酒馆喝麦酒",
			importance: 8,
			when: "当提起酒馆饮酒",
		});
		const r = await run("retrieve", { query: "薇拉 酒馆" });
		expect(r.text).toContain("找到了 1 条和「薇拉 酒馆」相关的记忆：");
		expect(r.text).toContain("- history://tavern");
		expect(r.text).toContain("重要性：8");
		expect(r.text).toContain("想起条件：当提起酒馆饮酒");
		expect(r.text).toContain("薇拉在酒馆喝麦酒");
	});

	it("renders not-found message when query has no hits", async () => {
		const r = await run("retrieve", { query: "完全不存在的词汇" });
		expect(r.text).toBe("所有域名里没有找到和「完全不存在的词汇」相关的记忆。");
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

describe("revise details: authoritative diffs (§10.1 T-A / §10.2 T-F)", () => {
	it("returns the pre-edit body as a diff the renderer can draw (T-A)", async () => {
		await run("memorize", { uri: "core://r1", content: "甲\n乙\n丙" });
		const r = await run("revise", { uri: "core://r1", old_text: "乙", new_text: "乙乙" });
		const diffs = r.details.diffs as Array<{ uri: string; diff: string; firstChangedLine?: number }>;
		expect(diffs).toHaveLength(1);
		expect(diffs[0].uri).toBe("core://r1");
		expect(diffs[0].diff).toContain("+2 乙乙");
		expect(diffs[0].diff).toContain("-2 乙");
		expect(diffs[0].firstChangedLine).toBe(2);
		// `before` carries the same uuids in the same order.
		expect(r.details.before).toEqual([{ uri: "core://r1", content: "甲\n乙\n丙" }]);
	});

	it("omits diffs for a metadata-only edit (no body touched)", async () => {
		await run("memorize", { uri: "core://r2", content: "甲\n乙" });
		const r = await run("revise", { uri: "core://r2", importance: 9 });
		expect(r.details.diffs).toEqual([]);
		expect(r.details.before).toEqual([]);
	});

	it("folds the truncation flags in only when a cap actually bites (T-F)", async () => {
		await run("memorize", { uri: "core://big", content: "起点" });
		const big = await run("revise", { uri: "core://big", append: "x".repeat(MAX_DIFF_BYTES + 1) });
		expect(big.details.truncated).toBe(true);
		// Item cap not reached: the key stays absent (absent ⇒ false).
		expect(big.details.diffsTruncated).toBeUndefined();
		expect((big.details.diffs as Array<{ diff: string }>)[0].diff).toContain("（已截断）");

		await run("memorize", { uri: "core://small", content: "起点\n中点" });
		const small = await run("revise", { uri: "core://small", old_text: "起点", new_text: "终点" });
		expect(small.details.truncated).toBeUndefined();
		expect(small.details.diffsTruncated).toBeUndefined();

		// Sanity floor so a fat-fingered constant cannot silently green this.
		expect(MAX_DIFF_BYTES).toBeGreaterThanOrEqual(1024);
		expect(MAX_DIFF_ITEMS).toBeGreaterThanOrEqual(1);
	});

	it("keeps one diff segment per mod, in results order, for a batch", async () => {
		await run("memorize", { uri: "core://b1", content: "一\n二" });
		await run("memorize", { uri: "core://b2", content: "三\n四" });
		const r = await run("revise", {
			batch: [
				{ uri: "core://b1", old_text: "二", new_text: "贰" },
				{ uri: "core://b2", importance: 4 },
				{ uri: "core://b2", append: "五" },
			],
		});
		const diffs = r.details.diffs as Array<{ uri: string }>;
		expect(diffs.map((d) => d.uri)).toEqual(["core://b1", "core://b2"]);
	});

	it("never emits a diff for a write-back no-op", async () => {
		await run("memorize", { uri: "core://noop", content: "甲\n乙" });
		const r = await run("revise", { uri: "core://noop", line: 2, line_content: "乙" });
		expect(r.details.diffs).toEqual([]);
	});
});
