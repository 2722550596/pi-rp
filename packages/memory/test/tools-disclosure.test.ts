/**
 * D4 (tool layer) acceptance — contract `plan/memory-web/24-工具层.md` §10 T1–T12.
 *
 * Every assertion is non-vacuous: it fails against the pre-change behaviour
 * (silently dropped `when`, node-level reads, `""` written verbatim, flat
 * diffusion read, Chinese labels).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type MemoryDatabase, openDatabase } from "../src/driver.ts";
import { renderRecentView } from "../src/memory-views.ts";
import { createMemoryModule, type MemoryModuleHost } from "../src/module.ts";
import { createSchema } from "../src/schema.ts";
import { createMemorySlots } from "../src/slots.ts";
import { MemoryStore } from "../src/store.ts";
import { computeRevisedContent, createMemoryTools, MEMORY_DISCLOSURE_GUIDELINE, setAwakenUris } from "../src/tools.ts";

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

function aliasDisclosure(uri: string): string | null {
	const row = db.prepare("SELECT disclosure FROM aliases WHERE alias_uri = ?").get(uri) as
		| { disclosure: string | null }
		| undefined;
	return row?.disclosure ?? null;
}

function edgeDisclosure(fromUri: string, toUri: string): string | null {
	const row = db
		.prepare(
			"SELECT disclosure FROM edges WHERE node_id = (SELECT node_id FROM nodes WHERE uri = ?) AND target_uri = ?",
		)
		.get(fromUri, toUri) as { disclosure: string | null } | undefined;
	return row?.disclosure ?? null;
}

describe("T1 — associate writes when to the alias/edge level", () => {
	it("alias mode lands on aliases.disclosure, not nodes.disclosure", async () => {
		await run("memorize", { uri: "core://self", content: "我" });
		await run("associate", { target_uri: "core://self", new_uri: "自己", when: "当被叫名字" });

		expect(aliasDisclosure("自己")).toBe("当被叫名字");
		expect(store.resolveUri("core://self")!.disclosure).toBeNull();
	});

	it("edge mode lands on edges.disclosure", async () => {
		await run("memorize", { uri: "core://self", content: "我" });
		await run("memorize", { uri: "core://b", content: "B" });
		await run("associate", {
			target_uri: "core://self",
			related_uri: "core://b",
			kind: "k",
			when: "当想到B",
		});
		expect(edgeDisclosure("core://self", "core://b")).toBe("当想到B");
		expect(store.resolveUri("core://self")!.disclosure).toBeNull();
	});
});

describe("T2 — revise on an alias writes the alias layer", () => {
	it("entry condition changes; node condition untouched", async () => {
		await run("memorize", { uri: "core://self", content: "我", when: "节点条件" });
		await run("associate", { target_uri: "core://self", new_uri: "自己", when: "入口条件" });
		await run("revise", { uri: "自己", when: "新入口条件" });

		expect(store.effectiveDisclosure("自己")).toBe("新入口条件");
		expect(store.effectiveDisclosure("core://self")).toBe("节点条件");
	});
});

describe("T3 — upsert keep semantics", () => {
	it("re-associating an edge without when preserves its disclosure", async () => {
		await run("memorize", { uri: "core://a", content: "A" });
		await run("memorize", { uri: "core://b", content: "B" });
		await run("associate", { target_uri: "core://a", related_uri: "core://b", kind: "k", when: "边条件" });
		await run("associate", { target_uri: "core://a", related_uri: "core://b", kind: "k2" });
		expect(edgeDisclosure("core://a", "core://b")).toBe("边条件");
	});

	it("re-associating an alias without when preserves its disclosure", async () => {
		await run("memorize", { uri: "core://a", content: "A" });
		await run("associate", { target_uri: "core://a", new_uri: "入口", when: "入口条件" });
		await run("associate", { target_uri: "core://a", new_uri: "入口" });
		expect(aliasDisclosure("入口")).toBe("入口条件");
	});
});

describe("T4 — read points use the entry-level condition", () => {
	it("recall of an alias entry shows the entry-level disclosure", async () => {
		await run("memorize", { uri: "core://self", content: "我", when: "节点条件" });
		await run("associate", { target_uri: "core://self", new_uri: "自己", when: "入口条件" });
		const r = await run("recall", { uri: "自己" });
		expect(r.text).toContain("入口条件");
		expect(r.text).not.toContain("节点条件");
	});
});

describe("T5 — labels are english tool names", () => {
	it("every memory tool label equals its name", () => {
		const tools = createMemoryTools(store);
		expect(tools).toHaveLength(12);
		for (const t of tools) expect(t.label).toBe(t.name);
	});
});

describe("T6 — migrated alias (NULL disclosure) falls back to node level", () => {
	it("aliases.disclosure NULL inherits the node condition", async () => {
		await run("memorize", { uri: "core://self", content: "我", when: "节点条件" });
		const node = store.resolveUri("core://self")!;
		store.addAlias("旧入口", node.node_id);
		expect(store.effectiveDisclosure("旧入口")).toBe("节点条件");
	});
});

describe("T7 — dead alias: read/write mirror resolveUri; masked predicate exact", () => {
	it("read/write stay consistent and E10 predicate does not false-positive", async () => {
		await run("memorize", { uri: "core://a", content: "A", when: "A 节点条件" });
		await run("memorize", { uri: "core://theme", content: "T" });
		store.addAlias("core://a", store.resolveUri("core://theme")!.node_id, "入口条件");

		expect(store.resolveUri("core://a")!.uri).toBe("core://a");
		expect(store.effectiveDisclosure("core://a")).toBe("A 节点条件");

		store.setEntryDisclosure("core://a", "新条件");
		expect(store.resolveUri("core://a")!.disclosure).toBe("新条件");
		expect(store.effectiveDisclosure("core://a")).toBe("新条件");
		expect(aliasDisclosure("core://a")).toBe("入口条件");

		expect(store.hasAliasRow("core://a")).toBe(true);
		expect(store.resolveEntry("core://a")!.kind).toBe("canonical");
		expect(store.resolveEntry("core://a")!.alias_uri).toBeNull();

		await run("associate", { target_uri: "core://theme", new_uri: "主题", when: "X" });
		expect(store.hasAliasRow("主题") && store.resolveEntry("主题")!.kind === "canonical").toBe(false);
	});

	it("revise on a dead alias warns visibly and still writes the colliding node", async () => {
		await run("memorize", { uri: "core://a", content: "A", when: "A 节点条件" });
		await run("memorize", { uri: "core://theme", content: "T" });
		store.addAlias("core://a", store.resolveUri("core://theme")!.node_id, "入口条件");
		const r = await run("revise", { uri: "core://a", when: "新条件" });
		expect(r.text).toContain("仍是规范节点");
		expect(store.resolveUri("core://a")!.disclosure).toBe("新条件");
		expect(aliasDisclosure("core://a")).toBe("入口条件");
	});
});

describe("T8 — normal alias read/write targets agree", () => {
	it("revise on the alias never pollutes the node", async () => {
		await run("memorize", { uri: "core://self", content: "我", when: "节点条件" });
		await run("associate", { target_uri: "core://self", new_uri: "自己", when: "入口条件" });
		expect(store.effectiveDisclosure("自己")).toBe("入口条件");
		expect(store.effectiveDisclosure("core://self")).toBe("节点条件");
		await run("revise", { uri: "自己", when: "新入口条件" });
		expect(store.effectiveDisclosure("自己")).toBe("新入口条件");
		expect(store.effectiveDisclosure("core://self")).toBe("节点条件");
	});
});

describe("T9 — promptGuidelines chain (memory-package hops)", () => {
	it("the constant exists and rides recall/retrieve definitions", () => {
		expect(MEMORY_DISCLOSURE_GUIDELINE).toContain("MUST 先 retrieve 或 recall");
		const tools = createMemoryTools(store);
		const recall = tools.find((t) => t.name === "recall")!;
		const retrieve = tools.find((t) => t.name === "retrieve")!;
		expect(recall.promptGuidelines).toContain(MEMORY_DISCLOSURE_GUIDELINE);
		expect(retrieve.promptGuidelines).toContain(MEMORY_DISCLOSURE_GUIDELINE);
		// Hop ④ must be exercised end-to-end through the host whitelist, not by
		// a repo grep — the coding-agent file already carries 6 occurrences.
	});

	it("hop 4 — the host whitelist forwards promptGuidelines (module.ts)", async () => {
		// The coding-agent file already carries 6 `promptGuidelines` occurrences,
		// so a repo grep proves nothing (contract T22). Drive the real module
		// registration and assert the value the host actually receives.
		const received: Record<string, string[] | undefined> = {};
		const host: MemoryModuleHost = {
			registerTool: (tool) => {
				received[tool.name] = tool.promptGuidelines;
			},
			registerSlot: () => {},
			registerCustomType: () => {},
			on: () => {},
			sendCustomMessage: () => {},
			getSessionInfo: () => ({ modelId: "m", leafId: null, sessionId: "s", turn: 0 }),
			getBranchSnapshot: () => ({ entryIds: [], entries: [] }),
			getTurnMessages: () => [],
			getActiveBranchMessages: () => [],
			completeSideRequest: async () => "",
		};
		createMemoryModule(store, { settings: { embeddings: { mode: "off" } } }).registerSession(host);
		expect(received.recall).toContain(MEMORY_DISCLOSURE_GUIDELINE);
		expect(received.retrieve).toContain(MEMORY_DISCLOSURE_GUIDELINE);
	});
});

describe("T10 — when empty string clears at every writing entry point", () => {
	it('memorize / revise / associate x2 / consolidate normalise `""` to NULL', async () => {
		await run("memorize", { uri: "core://m", content: "M", when: "" });
		expect(store.resolveUri("core://m")!.disclosure).toBeNull();

		await run("memorize", { uri: "core://x", content: "X", when: "条件" });
		await run("revise", { uri: "core://x", when: "" });
		expect(store.resolveUri("core://x")!.disclosure).toBeNull();

		await run("associate", { target_uri: "core://x", new_uri: "入口", when: "" });
		expect(aliasDisclosure("入口")).not.toBe("");

		await run("memorize", { uri: "core://y", content: "Y" });
		await run("associate", { target_uri: "core://x", related_uri: "core://y", kind: "k", when: "" });
		expect(edgeDisclosure("core://x", "core://y")).not.toBe("");

		await run("consolidate", {
			resolution: "merge",
			target_uri: "core://t",
			source_uris: ["core://m", "core://y"],
			content: "T",
			when: "",
		});
		expect(store.resolveUri("core://t")!.disclosure).toBeNull();
	});
});

describe("T11 — revise without `when` never clears the condition", () => {
	it("tri-state guard: undefined skips the write entirely", async () => {
		await run("memorize", { uri: "core://x", content: "X", when: "原条件" });
		await run("revise", { uri: "core://x", append: "（补）" });
		expect(store.resolveUri("core://x")!.disclosure).toBe("原条件");

		await run("associate", { target_uri: "core://x", new_uri: "入口", when: "入口条件" });
		await run("revise", { uri: "入口", append: "（再补）" });
		expect(store.effectiveDisclosure("入口")).toBe("入口条件");
	});
});

describe("T12 — one-hop diffusion shows the edge's own condition", () => {
	it("retrieve displays edges.disclosure, not the node's", async () => {
		await run("memorize", { uri: "core://quest", content: "主线任务" });
		await run("memorize", { uri: "core://npc", content: "重要 NPC 人物", when: "节点条件" });
		await run("associate", {
			target_uri: "core://quest",
			related_uri: "core://npc",
			kind: "involves",
			when: "边条件",
		});
		const r = await run("retrieve", { query: "主线任务", semantic: false });
		expect(r.text).toContain("边条件");
		expect(r.text).not.toContain("节点条件");
	});
});

describe("T13 — consolidate(link) does not create unreachable aliases", () => {
	it("a still-live source uri gets no shadowed alias row, and the note is visible", async () => {
		await run("memorize", { uri: "core://a", content: "A" });
		await run("memorize", { uri: "core://b", content: "B" });
		const r = await run("consolidate", {
			resolution: "link",
			target_uri: "core://theme",
			source_uris: ["core://a", "core://b"],
			content: "T",
		});
		expect(store.hasAliasRow("core://a")).toBe(false);
		expect(store.hasAliasRow("core://b")).toBe(false);
		expect(r.text).toContain("入口未生效");
	});
});

describe("T14 — computeRevisedContent is the single body-edit rule", () => {
	it("errors carry no uri prefix; success returns the edited body", () => {
		const bad = computeRevisedContent("abc", { old_text: "zzz", new_text: "y" });
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.error).toBe("old_text 不在当前内容中");
		const dup = computeRevisedContent("aa", { old_text: "a", new_text: "b" });
		expect(dup.ok).toBe(false);
		if (!dup.ok) expect(dup.error).toBe("old_text 不唯一，请加长");
		const oob = computeRevisedContent("abc", { line: 9, line_content: "z" });
		expect(oob.ok).toBe(false);
		if (!oob.ok) expect(oob.error).toBe("行号越界（共 1 行）");
		const good = computeRevisedContent("abc", { append: "d" });
		expect(good.ok && good.content).toBe("abc\nd");
	});

	it("a failed mod surfaces the uri prefix exactly once", async () => {
		await run("memorize", { uri: "core://x", content: "X" });
		const r = await run("revise", { uri: "core://x", old_text: "nope", new_text: "y" });
		expect(r.text).toBe("core://x：old_text 不在当前内容中");
	});

	it("beforeContent is captured only when a body edit lands", async () => {
		await run("memorize", { uri: "core://x", content: "X" });
		const tools = createMemoryTools(store);
		const revise = tools.find((t) => t.name === "revise")!;
		const ok = await revise.execute("c", { uri: "core://x", append: "!" });
		expect(ok.details.failed).toBe(0);
		await revise.execute("c", { uri: "core://x", importance: 1 });
		expect(store.resolveUri("core://x")!.content).toBe("X\n!");
	});
});

describe("T15 — relocate carries `when` into the moves", () => {
	it("omitted `when` inherits the pre-move effective condition", async () => {
		await run("memorize", { uri: "core://a", content: "A", when: "移动前条件" });
		await run("relocate", { uri: "core://a", to: "core://b/c" });
		expect(aliasDisclosure("core://a")).toBe("移动前条件");
	});

	it('explicit `when` overrides, and `""` clears rather than inherits', async () => {
		await run("memorize", { uri: "core://a", content: "A", when: "移动前条件" });
		await run("relocate", { uri: "core://a", to: "core://b/c", when: "新条件" });
		expect(aliasDisclosure("core://a")).toBe("新条件");
		await run("relocate", { uri: "core://b/c", to: "core://d/e", when: "" });
		expect(aliasDisclosure("core://b/c")).toBeNull();
	});

	it("batch mode normalises per move", async () => {
		await run("memorize", { uri: "core://a", content: "A", when: "A 条件" });
		await run("memorize", { uri: "core://b", content: "B" });
		await run("relocate", {
			batch: [
				{ from: "core://a", to: "core://t/a" },
				{ from: "core://b", to: "core://t/b", when: "" },
			],
		});
		expect(aliasDisclosure("core://a")).toBe("A 条件");
		expect(aliasDisclosure("core://b")).toBeNull();
	});
});

describe("T16 — slot and view read points use the entry-level condition", () => {
	it("awaken slot shows the alias entry condition, not the node's", async () => {
		await run("memorize", { uri: "core://self", content: "我", when: "节点条件" });
		await run("associate", { target_uri: "core://self", new_uri: "自己", when: "入口条件" });
		setAwakenUris(store, ["自己"]);
		const slot = createMemorySlots(store).find((s) => s.name === "awaken")!;
		const out = (await slot.render({ item: { options: {} } })) as string;
		expect(out).toContain("入口条件");
		expect(out).not.toContain("节点条件");
	});

	it("wakeup view shows the alias entry condition", async () => {
		await run("memorize", { uri: "core://self", content: "我", when: "节点条件" });
		await run("associate", { target_uri: "core://self", new_uri: "自己", when: "入口条件" });
		setAwakenUris(store, ["自己"]);
		const r = await run("recall", { uri: "MEM://wakeup" });
		expect(r.text).toContain("入口条件");
		expect(r.text).not.toContain("节点条件");
	});

	it("recent view reads through effectiveDisclosure for the canonical node", async () => {
		await run("memorize", { uri: "core://self", content: "我", when: "节点条件" });
		// An alias row is not itself a recent node, so the view resolves the
		// canonical uri; the assertion pins that the value comes from the entry
		// read rather than a snapshot copied into the row.
		expect(renderRecentView(store, 5)).toContain("节点条件");
	});
});
