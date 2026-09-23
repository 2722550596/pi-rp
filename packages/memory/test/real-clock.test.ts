import { beforeEach, describe, expect, it } from "vitest";
import { type MemoryDatabase, openDatabase } from "../src/driver.ts";
import { createSchema } from "../src/schema.ts";
import { MemoryStore } from "../src/store.ts";
import { createMemoryTools } from "../src/tools.ts";

// 真实时钟回退（nocturne enabled=false 语义）：世界钟未设时，写入按墙钟打点、
// 相对标注按墙钟算；getWorldTime() 本身保持可空、忠实报告钟未设。
let db: MemoryDatabase;
let store: MemoryStore;
let tools: Map<string, { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }>;

beforeEach(async () => {
	db = await openDatabase("");
	createSchema(db);
	store = new MemoryStore(db);
	tools = new Map(createMemoryTools(store).map((tool) => [tool.name, tool]));
});

const text = (out: unknown): string => {
	const r = out as { content?: Array<{ type?: string; text?: string }> };
	if (Array.isArray(r.content)) return r.content.map((c) => c.text ?? "").join("\n");
	return String(out);
};

describe("real-clock fallback (world clock unset)", () => {
	it("getWorldTime() stays null — the clock is honestly unset", () => {
		expect(store.getWorldTime()).toBeNull();
	});

	it("stamps writes with the wall clock and recalls them as 今天", async () => {
		const before = Date.now();
		await tools.get("memorize")!.execute("t", {
			uri: "diary://test/real-clock",
			content: "真实时钟打点测试条目",
		});
		const node = store.resolveUri("diary://test/real-clock");
		expect(node).toBeTruthy();
		expect(node!.world_ts).toBeTruthy();
		const stamped = Date.parse(node!.world_ts!);
		expect(Number.isNaN(stamped)).toBe(false);
		expect(Math.abs(stamped - before)).toBeLessThan(60_000);

		const out = await tools.get("recall")!.execute("t", { uri: "diary://test/real-clock" });
		expect(text(out)).toContain("今天");
	});
});
