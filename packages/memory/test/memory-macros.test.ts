import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveMemoryClock } from "../src/clock.ts";
import { openMemoryStore } from "../src/index.ts";
import { createMemoryMacros, createMemorySlots, parseRecentMacroParams } from "../src/slots.ts";
import type { MemoryStore } from "../src/store.ts";
import { setAwakenUris } from "../src/tools.ts";

let store: MemoryStore;
beforeEach(async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date("2026-10-16T20:00:00Z"));
	store = await openMemoryStore(":memory:");
});
afterEach(() => {
	store.db.close();
	vi.useRealTimers();
});

function render(name: string, params?: string): string {
	return createMemoryMacros(store)
		.find((macro) => macro.name === `memory.${name}`)!
		.render({ runtime: undefined, variables: {}, params });
}

function body(text: string): string {
	return text.slice(text.indexOf("\n") + 1);
}

describe("memory snapshot macros", () => {
	it("keeps the complete world slot output unchanged after shared-render extraction", async () => {
		store.setWorldTime("2026-06-05");
		store.put({ uri: "core://self", content: "身份正文", disclosure: "确认身份", world_ts: "2026-06-04" });
		store.put({ uri: "core://self/habit", parent_uri: "core://self", content: "傍晚\n喝茶", disclosure: "聊习惯" });
		store.db.prepare("UPDATE nodes SET updated_ts = ? WHERE uri = ?").run("2026-06-05T01:00:00Z", "core://self");
		store.db
			.prepare("UPDATE nodes SET updated_ts = ? WHERE uri = ?")
			.run("2026-06-05T02:00:00Z", "core://self/habit");
		setAwakenUris(store, ["core://self"]);
		const slots = createMemorySlots(store);
		expect(await slots[0].render({ item: {} })).toBe(
			[
				"> 当前世界时间: 2026-06-05",
				"",
				"---",
				"",
				"### core://self",
				"> (发生于: 2026-06-04，昨天)",
				"> 什么时候想起：确认身份",
				"",
				"身份正文",
				"",
				"- core://self/habit (聊习惯) — 傍晚 喝茶",
			].join("\n"),
		);
		expect(await slots[1].render({ item: {} })).toBe(
			"### core://self/habit (聊习惯)\n傍晚\n喝茶\ncore://self (确认身份): 身份正文",
		);
		expect(await slots[2].render({ item: {} })).toBe("core://self (确认身份): 身份正文");
	});

	it.each(["world", "real"] as const)("renders synchronous %s snapshots with absolute dates", (mode) => {
		if (mode === "real") store.setClock(resolveMemoryClock({ mode, timezone: "Asia/Shanghai" }));
		else store.setWorldTime("2026-10-17T04:00:00+08:00");
		store.put({ uri: "core://focus", content: "没有相对时间的正文", world_ts: "2026-10-16T23:30:00+08:00" });
		setAwakenUris(store, ["core://focus"]);
		const macros = createMemoryMacros(store);
		expect(macros.map((macro) => macro.name)).toEqual(["memory.awaken", "memory.recent", "memory.index"]);
		for (const macro of macros) {
			expect(macro.static).toBe(true);
			const out = macro.render({ runtime: undefined, variables: {} });
			expect(typeof out).toBe("string");
			expect(out.split("\n")[0]).toContain("2026-10-17T04:00:00+08:00");
			expect(body(out)).not.toMatch(/今天|昨天|前天|明天|约 \d+ (天|周|个月|年)前/);
			expect(out).not.toContain("当前世界时间");
		}
		expect(body(render("awaken"))).toContain("> (发生于: 2026-10-16T23:30:00+08:00)");
	});

	it("uses the wall-clock reference in unset world snapshots", () => {
		store.put({ uri: "core://focus", content: "正文" });
		expect(render("index").split("\n")[0]).toContain("2026-10-16T20:00:00.000Z");
	});

	it("shares recent/index bodies with slots and applies macro parameters", async () => {
		for (let i = 1; i <= 7; i++) {
			store.put({ uri: `history://n${i}`, content: `正文 ${i}\n第二行` });
			store.db
				.prepare("UPDATE nodes SET updated_ts = ? WHERE uri = ?")
				.run(`2026-10-0${i}T00:00:00Z`, `history://n${i}`);
		}
		const slots = createMemorySlots(store);
		expect(body(render("recent", "rawCount=2,snippetCount=4"))).toBe(
			await slots[1].render({ item: { options: { rawCount: 2, snippetCount: 4 } } }),
		);
		expect(body(render("index"))).toBe(await slots[2].render({ item: {} }));
		expect(render("recent", "rawCount=abc")).toBe(render("recent"));
		expect(render("recent", "rawCount=0,snippetCount=0")).toBe("");
	});

	it("returns empty snapshots without a header and filters hidden nodes live", () => {
		for (const macro of createMemoryMacros(store))
			expect(macro.render({ runtime: undefined, variables: {} })).toBe("");
		store.put({ uri: "core://hidden", content: "隐藏正文" });
		setAwakenUris(store, ["core://hidden"]);
		let visible = false;
		const macros = createMemoryMacros(store, { isVisible: () => visible });
		for (const macro of macros) expect(macro.render({ runtime: undefined, variables: {} })).toBe("");
		visible = true;
		for (const macro of macros) expect(macro.render({ runtime: undefined, variables: {} })).toContain("隐藏正文");
	});

	it("does not cache memory or time inside macro definitions", () => {
		store.setClock(resolveMemoryClock({ mode: "real", timezone: "Asia/Shanghai" }));
		store.put({ uri: "core://focus", content: "原正文" });
		setAwakenUris(store, ["core://focus"]);
		const macro = createMemoryMacros(store)[0];
		const first = macro.render({ runtime: undefined, variables: {} });
		store.put({ uri: "core://focus", content: "新正文" });
		vi.setSystemTime(new Date("2026-10-16T20:00:01Z"));
		const second = macro.render({ runtime: undefined, variables: {} });
		expect(first).toContain("原正文");
		expect(second).toContain("新正文");
		expect(second.split("\n")[0]).toContain("2026-10-17T04:00:01+08:00");
	});
});

describe("recent macro parameter parsing", () => {
	it.each([
		[undefined, { rawCount: 1, snippetCount: 4 }],
		["", { rawCount: 1, snippetCount: 4 }],
		["rawCount=-3", { rawCount: 0, snippetCount: 4 }],
		["unknown=3", { rawCount: 1, snippetCount: 4 }],
		[" rawCount = 2 , snippetCount = 7 ", { rawCount: 2, snippetCount: 7 }],
		["rawCount=2,rawCount=3", { rawCount: 3, snippetCount: 4 }],
		["rawCount=2,rawCount=bad", { rawCount: 1, snippetCount: 4 }],
		["rawCount=1.5,snippetCount=2e1", { rawCount: 1, snippetCount: 4 }],
		["rawCount=0x10,snippetCount=4=2", { rawCount: 1, snippetCount: 4 }],
	])("parses %s deterministically", (params, expected) => {
		expect(parseRecentMacroParams(params)).toEqual(expected);
	});
});
