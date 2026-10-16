import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dayNumber, formatStamp, resolveMemoryClock, WORLD_CLOCK } from "../src/clock.ts";
import { openMemoryStore } from "../src/index.ts";
import { renderWakeupView } from "../src/memory-views.ts";
import { createMemorySlots } from "../src/slots.ts";
import type { MemoryStore } from "../src/store.ts";
import { createMemoryTools, type MemoryToolResult, setAwakenUris } from "../src/tools.ts";

const real = resolveMemoryClock({ mode: "real", timezone: "Asia/Shanghai" });
let store: MemoryStore;
const outputText = (value: MemoryToolResult) => value.content.map((c) => c.text).join("\n");

beforeEach(async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date("2026-10-16T20:00:00Z"));
	store = await openMemoryStore(":memory:");
	store.setClock(real);
});
afterEach(() => {
	store.db.close();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("real memory clock", () => {
	it("resolves invalid mode and timezone through one stderr warning each", () => {
		const warn = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		expect(resolveMemoryClock({ mode: "bad" })).toEqual(WORLD_CLOCK);
		expect(warn).toHaveBeenCalledTimes(1);
		for (const timezone of ["Not/AZone", "", 42, null]) {
			warn.mockClear();
			expect(resolveMemoryClock({ mode: "real", timezone })).toEqual({
				mode: "real",
				timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
			});
			expect(warn).toHaveBeenCalledTimes(1);
		}
		warn.mockClear();
		expect(resolveMemoryClock({ mode: "world", timezone: "Not/AZone" })).toEqual(WORLD_CLOCK);
		expect(resolveMemoryClock(undefined)).toEqual(WORLD_CLOCK);
		expect(resolveMemoryClock({ mode: "real", timezone: "Asia/Shanghai" })).toEqual(real);
		expect(resolveMemoryClock({ mode: "real" }).timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
		expect(warn).not.toHaveBeenCalled();
	});

	it("formats midnight, DST and fractional offsets using the instant's zone", () => {
		for (const [timezone, instant, expected] of [
			["Asia/Shanghai", "2026-10-16T16:00:00Z", "2026-10-17T00:00:00+08:00"],
			["America/New_York", "2026-01-01T12:00:00Z", "2026-01-01T07:00:00-05:00"],
			["America/New_York", "2026-07-01T12:00:00Z", "2026-07-01T08:00:00-04:00"],
			["Australia/Lord_Howe", "2026-07-01T12:00:00Z", "2026-07-01T22:30:00+10:30"],
			["Asia/Kathmandu", "2026-07-01T12:00:00Z", "2026-07-01T17:45:00+05:45"],
			["UTC", "2026-07-01T12:00:00Z", "2026-07-01T12:00:00+00:00"],
		])
			expect(formatStamp(new Date(instant), resolveMemoryClock({ mode: "real", timezone }))).toBe(expected);
		expect(dayNumber(store.referenceNow(), real)).toBe(Date.UTC(2026, 9, 17) / 86400000);
		expect(dayNumber("2026-10-16T20:00:00Z", WORLD_CLOCK)).toBe(Date.UTC(2026, 9, 16) / 86400000);
		expect(dayNumber("invalid", real)).toBeNull();
	});

	it("stamps memorize, store writes and audit without reading the world clock", async () => {
		const get = vi.spyOn(store, "getWorldTime").mockImplementation(() => {
			throw new Error("world clock read");
		});
		const tools = createMemoryTools(store);
		await tools.find((t) => t.name === "memorize")!.execute("m", { uri: "core://clock", content: "时间记忆" });
		expect(store.resolveUri("core://clock")!.world_ts).toBe("2026-10-17T04:00:00+08:00");
		expect(store.put({ uri: "core://direct", content: "直接写入" }).world_ts).toBe(store.nowStamp());
		store.logAudit("clock_probe", {});
		const row = store.db.prepare("SELECT world_ts FROM audit_log WHERE event = ?").get("clock_probe") as {
			world_ts: string;
		};
		expect(row.world_ts).toBe("2026-10-17T04:00:00+08:00");
		expect(get).not.toHaveBeenCalled();
		get.mockRestore();
		expect(store.getWorldTime()).toBeNull();
	});

	it("uses real relative offsets, preserves absolute inputs and allows explicit clearing", async () => {
		const tools = new Map(createMemoryTools(store).map((t) => [t.name, t]));
		await tools.get("memorize")!.execute("m", { uri: "history://relative", content: "昨天", time: "-1d" });
		expect(store.resolveUri("history://relative")!.world_ts).toBe("2026-10-16T04:00:00+08:00");
		await tools.get("revise")!.execute("r", { uri: "history://relative", time: "2020-01-01" });
		expect(store.resolveUri("history://relative")!.world_ts).toBe("2020-01-01");
		await tools.get("revise")!.execute("r", { uri: "history://relative", time: "" });
		expect(store.resolveUri("history://relative")!.world_ts).toBeNull();
	});

	it("uses local calendar dates in recall, awaken and wakeup with a world control", async () => {
		store.put({ uri: "core://yesterday", content: "跨日记忆", world_ts: "2026-10-16T23:30:00+08:00" });
		setAwakenUris(store, ["core://yesterday"]);
		const recall = createMemoryTools(store).find((t) => t.name === "recall")!;
		expect(outputText(await recall.execute("r", { uri: "core://yesterday" }))).toContain("，昨天)");
		const awaken = await createMemorySlots(store)
			.find((s) => s.name === "awaken")!
			.render({ item: {} });
		expect(awaken).toContain("，昨天)");
		expect(awaken).not.toContain("当前世界时间");
		expect(renderWakeupView(store, ["core://yesterday"])).toContain("，昨天)");
		expect(renderWakeupView(store, ["core://yesterday"])).not.toContain("当前世界时间");
		store.setClock(WORLD_CLOCK);
		expect(outputText(await recall.execute("r", { uri: "core://yesterday" }))).toContain("，今天)");
		expect(renderWakeupView(store, ["core://yesterday"])).toContain("> 当前世界时间: 2026-10-16T20:00:00.000Z");
	});

	it("omits only set_time in real mode and preserves the world tool definitions", () => {
		const realTools = createMemoryTools(store);
		store.setClock(WORLD_CLOCK);
		const worldTools = createMemoryTools(store);
		expect(realTools.map((t) => t.name)).toEqual(worldTools.filter((t) => t.name !== "set_time").map((t) => t.name));
		expect(worldTools).toHaveLength(12);
		for (const tool of realTools.filter((t) => t.name !== "memorize" && t.name !== "revise")) {
			expect(tool.description).toBe(worldTools.find((t) => t.name === tool.name)!.description);
		}
	});
});
