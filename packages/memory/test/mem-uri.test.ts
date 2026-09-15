/**
 * MEM:// system-view URI parsing regression tests (tools.ts parseViewSegments).
 *
 * Bug: `"MEM://x/y".split("/")` === `["MEM:","","x","y"]` — index 2 is the view
 * name, index 3 the first real argument. The old code read index 2 (or guessed),
 * so `MEM://recent/<N>` / `MEM://wakeup/<N>` ignored N and `MEM://forgotten/*`
 * resolved domain="forgotten" (illegal) and silently returned 0 rows.
 *
 * These tests drive the model-visible surface — the `recall` tool with a
 * MEM:// uri — against a real SQLite store.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openMemoryStore } from "../src/index.ts";
import type { MemoryStore } from "../src/store.ts";
import { createMemoryTools } from "../src/tools.ts";

let store: MemoryStore;

beforeEach(async () => {
	store = await openMemoryStore("");
	store.seed();
});

afterEach(() => {
	store.db.close();
});

function run(uri: string): Promise<{ text: string; details: Record<string, unknown> }> {
	const tool = createMemoryTools(store).find((t) => t.name === "recall");
	if (!tool) throw new Error("recall tool missing");
	return tool.execute("call-1", { uri }).then((r) => ({
		text: r.content.map((c) => c.text).join(""),
		details: r.details,
	}));
}

/** Seed N live memories with distinct content markers, in creation order. */
function seedMarked(domain: string, count: number): void {
	for (let i = 1; i <= count; i++) {
		store.insertNode({ uri: `${domain}://item/${i}`, content: `MARK-${i}`, importance: 5 });
	}
}

/** How many of the given markers appear in the rendered text. */
function markerCount(text: string, count: number): number {
	let hits = 0;
	for (let i = 1; i <= count; i++) if (text.includes(`MARK-${i}`)) hits++;
	return hits;
}

describe("MEM://<view>/<N> — the limit segment is honoured", () => {
	it("MEM://recent/2 limits to 2 (was silently 10)", async () => {
		seedMarked("core", 4);
		const limited = await run("MEM://recent/2");
		expect((limited.details.node_ids as string[]).length).toBe(2);
		// Default keeps every seeded node.
		const all = await run("MEM://recent");
		expect((all.details.node_ids as string[]).length).toBeGreaterThan(2);
	});

	it("MEM://wakeup/3 limits the recent-dynamics section to 3 (was silently 5)", async () => {
		seedMarked("core", 6);
		const limited = await run("MEM://wakeup/3");
		expect(markerCount(limited.text, 6)).toBe(3);
		const unLimited = await run("MEM://wakeup");
		expect(markerCount(unLimited.text, 6)).toBeGreaterThan(3);
	});

	it("MEM://timeline/<N> limits raw_log entries", async () => {
		store.appendRaw(
			[1, 2, 3].map((i) => ({
				role: "user",
				text: `原文-${i}`,
				entry_id: `e${i}`,
				session_id: "s1",
				wall_ts: `2026-09-0${i}T00:00:00Z`,
				world_ts: `1000-01-0${i}`,
			})),
		);
		const two = await run("MEM://timeline/2");
		expect(two.text).toContain("> 条目: 2 条");
		const all = await run("MEM://timeline");
		expect(all.text).toContain("> 条目: 3 条");
	});
});

describe("MEM://forgotten — domain resolution", () => {
	it("MEM://forgotten/core resolves domain=core and recalls it (was 0 rows)", async () => {
		store.insertNode({ uri: "core://self", content: "自我认知", importance: 5 });
		store.insertNode({ uri: "history://scene", content: "场景纪要", importance: 5 });
		const core = await run("MEM://forgotten/core");
		expect(core.text).toContain("> 领域: core");
		expect(core.text).toContain("core://self");
		expect(core.text).not.toContain("history://scene");
	});

	it("MEM://forgotten (no arg) spans all domains (was 0 rows)", async () => {
		store.insertNode({ uri: "core://self", content: "自我认知", importance: 5 });
		store.insertNode({ uri: "history://scene", content: "场景纪要", importance: 5 });
		const out = await run("MEM://forgotten");
		expect(out.text).toContain("> 领域: 全部");
		expect(out.text).toContain("core://self");
		expect(out.text).toContain("history://scene");
	});

	it("MEM://forgotten/<N> treats N as the limit, not a domain (was 0 rows)", async () => {
		seedMarked("core", 4);
		const one = await run("MEM://forgotten/1");
		expect(one.text).toContain("> 领域: 全部");
		expect(one.text).toContain("> 条目: 1 条");
	});

	it("MEM://forgotten/<domain>/<N> applies both domain and limit (was 0 rows)", async () => {
		seedMarked("core", 4);
		store.insertNode({ uri: "history://scene", content: "场景纪要", importance: 5 });
		const out = await run("MEM://forgotten/core/2");
		expect(out.text).toContain("> 领域: core");
		expect(out.text).toContain("> 条目: 2 条");
		expect(out.text).not.toContain("history://scene");
	});
});

describe("MEM:// views already correct are preserved", () => {
	it("MEM://timeline/<domain>/<N> keeps domain-agnostic raw_log but honours N", async () => {
		store.appendRaw(
			[1, 2, 3].map((i) => ({
				role: "user",
				text: `原文-${i}`,
				entry_id: `e${i}`,
				session_id: "s1",
				wall_ts: `2026-09-0${i}T00:00:00Z`,
				world_ts: `1000-01-0${i}`,
			})),
		);
		const out = await run("MEM://timeline/core/2");
		expect(out.text).toContain("> 条目: 2 条");
	});

	it("MEM://index/<domain> filters to that domain", async () => {
		store.insertNode({ uri: "core://self", content: "自我认知", importance: 5 });
		const out = await run("MEM://index/core");
		expect(out.text).toContain("core://self");
	});

	it("MEM://diagnostic/<domain> reports issues for that domain", async () => {
		store.insertNode({ uri: "core://self", content: "占位", importance: 5 });
		const out = await run("MEM://diagnostic/core");
		expect(out.text).not.toBe("");
	});

	it("MEM://glossary lists keywords", async () => {
		const node = store.insertNode({ uri: "core://self", content: "自我认知", importance: 5 });
		store.addGlossaryEntry("真名", node.node_id);
		const out = await run("MEM://glossary");
		expect(out.text).toContain("真名");
	});
});
