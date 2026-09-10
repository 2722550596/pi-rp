import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type MemoryDatabase, openDatabase } from "../src/driver.ts";
import { createSchema } from "../src/schema.ts";
import { createMemorySlots } from "../src/slots.ts";
import { MemoryStore } from "../src/store.ts";
import { setAwakenUris } from "../src/tools.ts";

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

function renderItem(name: string, options?: Record<string, unknown>): Promise<string> {
	const slot = createMemorySlots(store).find((s) => s.name === name);
	if (!slot) throw new Error(`slot ${name} missing`);
	return Promise.resolve(slot.render({ item: { options } }) as string);
}

describe("awaken slot", () => {
	it("renders full text, child snippets and world time", async () => {
		store.put({ uri: "core://self", content: "我是伊莱，出身北港。", source: "manual" });
		store.put({ uri: "core://self/habit", content: "喜欢在傍晚喝茶", parent_uri: "core://self" });
		store.setWorldTime("2026-06-05");
		setAwakenUris(store, ["core://self"]);

		const out = await renderItem("awaken");
		expect(out).toContain("世界时间：2026-06-05");
		expect(out).toContain("## core://self");
		expect(out).toContain("我是伊莱，出身北港。");
		expect(out).toContain("core://self/habit: 喜欢在傍晚喝茶");
	});

	it("reconciles: deleted and stale uris drop out", async () => {
		const node = store.put({ uri: "core://a", content: "A", source: "manual" });
		store.put({ uri: "core://b", content: "B", source: "manual" });
		setAwakenUris(store, ["core://a", "core://b", "core://ghost"]);
		store.deleteCascade(node.node_id);

		const out = await renderItem("awaken");
		expect(out).not.toContain("core://a");
		expect(out).toContain("## core://b\nB");
		expect(out).not.toContain("core://ghost");
	});

	it("renders empty string when nothing is set", async () => {
		expect(await renderItem("awaken")).toBe("");
	});
});

describe("recent slot", () => {
	it("lists nodes by updated_ts desc with configurable count", async () => {
		store.put({ uri: "history://one", content: "第一条", source: "manual" });
		store.put({ uri: "history://two", content: "第二条", source: "manual" });
		const out = await renderItem("recent");
		expect(out).toContain("history://one: 第一条");
		expect(out).toContain("history://two: 第二条");

		const limited = await renderItem("recent", { snippetCount: 1 });
		expect(limited.split("\n")).toHaveLength(1);
	});

	it("includes raw_log rows when rawCount is set", async () => {
		store.appendRaw([{ role: "user", text: "最新对话原文", entry_id: "e1", session_id: "session-1", wall_ts: "t" }]);
		store.put({ uri: "history://one", content: "纪要", source: "manual" });
		const out = await renderItem("recent", { rawCount: 1, snippetCount: 5 });
		expect(out).toContain("[1] user: 最新对话原文");
		expect(out).toContain("history://one: 纪要");
	});

	it("renders empty when there are no nodes", async () => {
		expect(await renderItem("recent")).toBe("");
	});
});

describe("index slot", () => {
	it("lists one snippet per domain root", async () => {
		store.put({ uri: "core://identity", content: "身份记忆", source: "manual" });
		store.put({ uri: "history://scene1", content: "场景一", source: "manual" });
		const out = await renderItem("index");
		expect(out).toContain("core://identity: 身份记忆");
		expect(out).toContain("history://scene1: 场景一");
	});
	it("skips stub roots", async () => {
		store.put({ uri: "core://self/habit", content: "喝茶", source: "manual" });
		const out = await renderItem("index");
		// core://self exists only as a stub parent — not listed.
		expect(out).not.toContain("core://self");
	});

	it("lists non-stub roots regardless of domain", async () => {
		store.put({ uri: "core://identity", content: "身份记忆", source: "manual" });
		store.put({ uri: "core://identity/habit", content: "喝茶", source: "manual" });
		const out = await renderItem("index");
		expect(out).toContain("core://identity: 身份记忆");
		expect(out).not.toContain("core://identity/habit: 喝茶");
	});
});
