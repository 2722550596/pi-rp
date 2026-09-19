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

/** Pin updated_ts so listRecentNodes ordering is deterministic across test runs. */
function touch(uri: string, ts: string): void {
	store.db.prepare("UPDATE nodes SET updated_ts = ? WHERE uri = ?").run(ts, uri);
}

describe("awaken slot", () => {
	it("renders full text, child snippets and world time", async () => {
		store.put({
			uri: "core://self",
			content: "我是伊莱，出身北港。",
			source: "manual",
			disclosure: "当确认自己身份时",
			world_ts: "2026-06-04",
		});
		store.put({
			uri: "core://self/habit",
			content: "喜欢在傍晚喝茶",
			parent_uri: "core://self",
			disclosure: "当闲聊习惯时",
		});
		store.setWorldTime("2026-06-05");
		setAwakenUris(store, ["core://self"]);

		const out = await renderItem("awaken");
		expect(out).toContain("> 当前世界时间: 2026-06-05");
		expect(out).toContain("### core://self");
		expect(out).toContain("> (发生于: 2026-06-04，昨天)");
		expect(out).toContain("> 什么时候想起：当确认自己身份时");
		expect(out).toContain("我是伊莱，出身北港。");
		expect(out).toContain("- core://self/habit (当闲聊习惯时) — 喜欢在傍晚喝茶");
	});

	it("deduplicates child if child uri is also in awaken", async () => {
		store.put({ uri: "core://parent", content: "父节点", source: "manual" });
		store.put({ uri: "core://parent/child", content: "子节点", parent_uri: "core://parent", source: "manual" });
		setAwakenUris(store, ["core://parent", "core://parent/child"]);

		const out = await renderItem("awaken");
		expect(out).toContain("### core://parent\n父节点");
		expect(out).toContain("### core://parent/child\n子节点");
		expect(out).not.toMatch(/- core:\/\/parent\/child/);
	});

	it("reconciles: deleted and stale uris drop out", async () => {
		const node = store.put({ uri: "core://a", content: "A", source: "manual" });
		store.put({ uri: "core://b", content: "B", source: "manual" });
		setAwakenUris(store, ["core://a", "core://b", "core://ghost"]);
		store.deleteCascade(node.node_id);

		const out = await renderItem("awaken");
		expect(out).not.toContain("core://a");
		expect(out).toContain("### core://b\nB");
		expect(out).not.toContain("core://ghost");
	});

	it("renders empty string when nothing is set", async () => {
		expect(await renderItem("awaken")).toBe("");
	});
});

describe("recent slot", () => {
	it("defaults to newest entry as full text plus 4 snippets", async () => {
		for (let i = 1; i <= 6; i++) {
			store.put({ uri: `history://n${i}`, content: `第${i}条\n换行保留`, source: "manual" });
			touch(`history://n${i}`, `2026-06-0${i}T00:00:00.000Z`);
		}
		const out = await renderItem("recent");
		// newest entry renders as full text with its original line breaks
		expect(out).toContain("### history://n6\n第6条\n换行保留");
		// the next four render as snippets (newlines folded)
		expect(out).toContain("history://n5: 第5条 换行保留");
		expect(out).toContain("history://n2: 第2条 换行保留");
		// only 5 entries total; the newest one never appears as a snippet
		expect(out).not.toContain("history://n1");
		expect(out).not.toContain("history://n6:");
	});

	it("honours rawCount and snippetCount options", async () => {
		for (let i = 1; i <= 5; i++) {
			store.put({ uri: `history://n${i}`, content: `第${i}条`, source: "manual" });
			touch(`history://n${i}`, `2026-06-0${i}T00:00:00.000Z`);
		}
		const out = await renderItem("recent", { rawCount: 2, snippetCount: 1 });
		expect(out).toContain("### history://n5\n第5条");
		expect(out).toContain("### history://n4\n第4条");
		expect(out).toContain("history://n3: 第3条");
		expect(out).not.toContain("n2");
		expect(out).not.toContain("n1");
	});

	it("renders all snippets when rawCount is 0", async () => {
		for (let i = 1; i <= 3; i++) {
			store.put({ uri: `history://n${i}`, content: `第${i}条`, source: "manual" });
			touch(`history://n${i}`, `2026-06-0${i}T00:00:00.000Z`);
		}
		const out = await renderItem("recent", { rawCount: 0, snippetCount: 3 });
		expect(out).toContain("history://n3: 第3条");
		expect(out).not.toContain("### ");
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
