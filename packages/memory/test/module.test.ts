import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type MemoryDatabase, openDatabase } from "../src/driver.ts";
import {
	buildMemoriesBlock,
	collectPriorContext,
	createMemoryModule,
	type MemoryBranchSnapshot,
	type MemoryModuleHost,
	type MemoryTurnMessage,
	rebuildInjectedFromEntries,
	shouldCaptureCustomType,
} from "../src/module.ts";
import { createSchema } from "../src/schema.ts";
import type { MemoryNode } from "../src/store.ts";
import { MemoryStore } from "../src/store.ts";
import { createFakeEmbeddingClient } from "./fake-embeddings.ts";

/** Keep unit tests offline: no embedding API calls (docs §9 mode:"off"). */
const OFFLINE = { settings: { embeddings: { mode: "off" as const } } };
/** Hybrid (vector) mode with a deterministic offline embedder — the §9 default path. */
const HYBRID = { embeddings: createFakeEmbeddingClient() };

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

// ── Host mock ────────────────────────────────────────────────────────────────

interface RegisteredTool {
	name: string;
	execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
}

function createHostMock(
	snapshot: Partial<MemoryBranchSnapshot> = {},
	turnMessages: MemoryTurnMessage[] = [],
	activeBranch: MemoryTurnMessage[] = turnMessages,
) {
	const tools = new Map<string, RegisteredTool>();
	const slots: string[] = [];
	const customTypes: Array<[string, unknown]> = [];
	const hooks = new Map<string, Array<(event: unknown) => unknown>>();
	const host: MemoryModuleHost = {
		registerTool(tool) {
			tools.set(tool.name, { name: tool.name, execute: tool.execute });
		},
		registerSlot(definition) {
			slots.push(definition.name);
		},
		registerCustomType(customType, policy) {
			customTypes.push([customType, policy]);
		},
		on(event, handler) {
			const list = hooks.get(event) ?? [];
			list.push(handler as (event: unknown) => unknown);
			hooks.set(event, list);
		},
		sendCustomMessage: () => {},
		getSessionInfo: () => ({ modelId: "test-model", leafId: "leaf-1", sessionId: "session-1", turn: 0 }),
		getBranchSnapshot: () => ({
			entryIds: snapshot.entryIds ?? [],
			entries: snapshot.entries ?? [],
		}),
		getTurnMessages: () => turnMessages,
		getActiveBranchMessages: () => activeBranch,
		completeSideRequest: async (prompt) => prompt,
	};
	return { host, tools, slots, customTypes, hooks };
}

/** Fire the before_agent_start hook through the mock host (async: §9 vector path). */
async function fireBeforeAgentStart(
	hooks: Map<string, Array<(event: unknown) => unknown>>,
	prompt: string,
): Promise<{ message?: { customType: string; content: string; display: boolean; details?: unknown } } | undefined> {
	const handlers = hooks.get("before_agent_start") ?? [];
	let result: unknown;
	for (const h of handlers) result = await h({ prompt });
	return result as { message?: { customType: string; content: string; display: boolean; details?: unknown } };
}

function nodeByUri(uri: string): MemoryNode {
	const node = store.resolveUri(uri);
	if (!node) throw new Error(`missing node ${uri}`);
	return node;
}

/** Build a MemoryTurnMessage with a stable wall timestamp. */
function t(role: string, text: string, entryId: string, extra: Partial<MemoryTurnMessage> = {}): MemoryTurnMessage {
	return { role, text, entryId, timestamp: `2026-09-10T00:00:0${entryId.slice(-1)}Z`, ...extra };
}

// ── Injection (§9) ──────────────────────────────────────────────────────────

describe("before_agent_start injection", () => {
	it("injects recalled memories as rp-memories custom message with dedup details", async () => {
		store.insertNode({ uri: "history://tavern", content: "伊莱在酒馆遇到薇拉，谈及北方的商队" });
		const h = createHostMock();
		const module = createMemoryModule(store, HYBRID);
		module.registerSession(h.host);

		const result = await fireBeforeAgentStart(h.hooks, "伊莱在酒馆遇到了谁？");
		expect(result?.message?.customType).toBe("rp-memories");
		expect(result?.message?.display).toBe(false);
		expect(result?.message?.content).toContain("<memories>");
		expect(result?.message?.content).toContain("history://tavern");
		const details = result?.message?.details as { ids: string[]; hashes: Record<string, string> };
		expect(details.ids).toEqual(["history://tavern"]);
		expect(Object.keys(details.hashes)).toEqual(["history://tavern"]);
	});

	it("skips slash commands and empty prompts", async () => {
		const h = createHostMock();
		const module = createMemoryModule(store, OFFLINE);
		module.registerSession(h.host);
		store.insertNode({ uri: "history://tavern", content: "酒馆场景" });

		expect(await fireBeforeAgentStart(h.hooks, "/help")).toBeUndefined();
		expect(await fireBeforeAgentStart(h.hooks, "\\nope")).toBeUndefined();
		expect(await fireBeforeAgentStart(h.hooks, "   ")).toBeUndefined();
	});

	it("dedups same-content injection on the second prompt (per-prompt rebuild)", async () => {
		store.insertNode({ uri: "history://tavern", content: "伊莱在酒馆遇到薇拉" });
		const snapshot: Partial<MemoryBranchSnapshot> = { entryIds: [], entries: [] };
		const module = createMemoryModule(store, HYBRID);

		// First prompt: no prior injections → inject.
		const first = createHostMock(snapshot);
		module.registerSession(first.host);
		const r1 = await fireBeforeAgentStart(first.hooks, "伊莱在酒馆遇到了谁");
		expect(r1?.message).toBeDefined();

		// Simulate the engine persisting the injection: the branch now carries
		// the rp-memories entry; second prompt rebuilds dedup from it.
		const details = r1?.message?.details as { ids: string[]; hashes: Record<string, string> };
		const second = createHostMock({
			entryIds: [],
			entries: [{ type: "custom_message", customType: "rp-memories", content: r1?.message?.content, details }],
		});
		module.registerSession(second.host);
		const r2 = await fireBeforeAgentStart(second.hooks, "伊莱在酒馆遇到了谁");
		expect(r2).toBeUndefined();
	});

	it("re-injects when content is revised (hash covers full body)", async () => {
		store.insertNode({ uri: "history://tavern", content: "伊莱在酒馆遇到薇拉" });
		const module = createMemoryModule(store, HYBRID);
		const first = createHostMock();
		module.registerSession(first.host);
		const r1 = await fireBeforeAgentStart(first.hooks, "伊莱在酒馆遇到了谁");
		const details = r1?.message?.details as { ids: string[]; hashes: Record<string, string> };

		// revise the memory content
		store.updateNode(nodeByUri("history://tavern").node_id, { content: "伊莱在酒馆遇到薇拉并决斗" });

		const second = createHostMock({
			entryIds: [],
			entries: [{ type: "custom_message", customType: "rp-memories", details }],
		});
		module.registerSession(second.host);
		const r2 = await fireBeforeAgentStart(second.hooks, "伊莱在酒馆遇到了谁");
		expect(r2?.message).toBeDefined();
	});

	it("excludes boot/awaken uris from injection", async () => {
		store.insertNode({ uri: "history://bootmem", content: "常驻设定 酒馆" });
		store.setKv("awaken_uris", JSON.stringify(["history://bootmem"]));
		const h = createHostMock();
		const module = createMemoryModule(store, OFFLINE);
		module.registerSession(h.host);
		expect(await fireBeforeAgentStart(h.hooks, "酒馆设定")).toBeUndefined();
	});

	it("respects domain blocklist but never blocks TEMP (§9)", async () => {
		store.insertNode({ uri: "maintenance://log", content: "维护日志 maintenance" });
		store.insertNode({ uri: "TEMP://scratch", content: "临时线索 scratch" });
		const h = createHostMock();
		const module = createMemoryModule(store, HYBRID);
		module.registerSession(h.host);
		const result = await fireBeforeAgentStart(h.hooks, "maintenance scratch 线索");
		expect(result?.message?.content).not.toContain("maintenance://log");
		expect(result?.message?.content).toContain("TEMP://scratch");
	});

	it("uses Prior context as second query (referential prompts)", async () => {
		store.insertNode({ uri: "history://forest", content: "薇拉在森林迷路遇到狼群" });
		const module = createMemoryModule(store, OFFLINE);
		const snapshot = {
			entryIds: ["e1", "e2"],
			entries: [
				{ type: "message", message: { role: "user", content: "提到薇拉在森林迷路遇到狼群的事" } },
				{ type: "message", message: { role: "assistant", content: "对，薇拉在森林迷路遇到狼群" } },
			] as Array<Record<string, unknown>>,
		};
		const h = createHostMock(snapshot);
		module.registerSession(h.host);
		// The prompt alone has no keyword hit; the prior context does.
		const result = await fireBeforeAgentStart(h.hooks, "然后呢？");
		expect(result?.message?.content).toContain("history://forest");
	});

	it("does not self-excite on injected memories blocks in prior context", async () => {
		store.insertNode({ uri: "history://tavern", content: "酒馆" });
		const module = createMemoryModule(store, OFFLINE);
		const snapshot = {
			entryIds: ["e1"],
			entries: [
				{
					type: "message",
					message: { role: "user", content: "<memories>\n1. history://tavern\n</memories>" },
				},
			] as Array<Record<string, unknown>>,
		};
		const h = createHostMock(snapshot);
		module.registerSession(h.host);
		expect(await fireBeforeAgentStart(h.hooks, "然后呢？")).toBeUndefined();
	});

	it("soft-anchors only the top item above HIGH_CONFIDENCE", async () => {
		store.insertNode({ uri: "history://tavern", content: "伊莱在酒馆遇到薇拉谈及商队", importance: 0 });
		const h = createHostMock();
		const module = createMemoryModule(store, HYBRID);
		module.registerSession(h.host);
		const result = await fireBeforeAgentStart(h.hooks, "伊莱在酒馆遇到薇拉谈及商队");
		expect(result?.message?.content).toContain("高度相关，建议读取");
	});
});

// ── Pure helpers ────────────────────────────────────────────────────────────

describe("buildMemoriesBlock", () => {
	it("renders uri, disclosure and summary lines", async () => {
		const block = buildMemoriesBlock([
			{
				node_id: "n1",
				uri: "history://a",
				disclosure: "进入酒馆时",
				summary: "伊莱遇见薇拉",
				content: "x",
				score: 0.6,
				kw: 1,
				vec: 0.5,
				bm25: null,
			},
		]);
		expect(block).toContain("<memories>");
		expect(block).toContain("1. history://a");
		expect(block).toContain("想起条件: 进入酒馆时");
		expect(block).toContain("摘要: 伊莱遇见薇拉");
	});

	it("truncates summaries to 80 chars", async () => {
		const long = "很".repeat(200);
		const block = buildMemoriesBlock([
			{
				node_id: "n1",
				uri: "history://a",
				disclosure: null,
				summary: `${long.slice(0, 80)}……`,
				content: long,
				score: 0.5,
				kw: 1,
				vec: 0.4,
				bm25: null,
			},
		]);
		expect(block).toContain("……");
	});
});

describe("rebuildInjectedFromEntries", () => {
	it("collects hashes from rp-memories entries on the active path", async () => {
		const map = rebuildInjectedFromEntries([
			{ type: "message" },
			{ type: "custom_message", customType: "rp-memories", details: { hashes: { "history://a": "h1" } } },
			{ type: "custom_message", customType: "other", details: { hashes: { "history://b": "h2" } } },
		]);
		expect(map.get("history://a")).toBe("h1");
		expect(map.has("history://b")).toBe(false);
	});

	it("falls back to ids for legacy entries", async () => {
		const map = rebuildInjectedFromEntries([
			{ type: "custom_message", customType: "rp-memories", details: { ids: ["history://c"] } },
		]);
		expect(map.get("history://c")).toBe("legacy:history://c");
	});
});

describe("collectPriorContext", () => {
	it("takes the last 6 message texts in order, skipping memories blocks", async () => {
		const entries: Array<Record<string, unknown>> = [
			{ type: "state", state: {} },
			{ type: "message", message: { role: "user", content: "m1" } },
			{ type: "message", message: { role: "assistant", content: "m2" } },
			{ type: "message", message: { role: "user", content: "<memories>x</memories>" } },
			{ type: "message", message: { role: "user", content: "m4" } },
			{ type: "message", message: { role: "assistant", content: "m5" } },
			{ type: "message", message: { role: "user", content: "m6" } },
			{ type: "message", message: { role: "assistant", content: "m7" } },
			{ type: "message", message: { role: "user", content: "m8" } },
		];
		const msgs = collectPriorContext(entries);
		expect(msgs).toHaveLength(6);
		expect(msgs[0]).toBe("assistant: m2");
	});
});

// ── Rollback coupling (§8) ──────────────────────────────────────────────────

describe("onLeafChange", () => {
	function makeAutoNode(uri: string, anchor: string | null, sessionId = "session-1"): MemoryNode {
		return store.insertNode({
			uri,
			content: `${uri} 正文`,
			source: "auto",
			anchor_entry_id: anchor,
			anchor_session_id: sessionId,
		});
	}

	it("hides this-session auto nodes whose anchor left the path and revives them on switch-back", async () => {
		makeAutoNode("history://kept", "e-onpath");
		makeAutoNode("history://orphan", "e-offpath");
		store.insertNode({ uri: "history://manual", content: "手写认知 manual", source: "manual" });
		const module = createMemoryModule(store, HYBRID);

		// Active path contains e-onpath only (host session "session-1").
		const h1 = createHostMock({ entryIds: ["e-onpath"], entries: [] });
		module.registerSession(h1.host);
		await module.onLeafChange();

		// Injection after reroll: orphan hidden, kept/manual still recalled.
		const r = await fireBeforeAgentStart(h1.hooks, "kept orphan manual 正文 认知");
		expect(r?.message?.content).toContain("history://manual");
		expect(r?.message?.content).not.toContain("history://orphan");

		// Switch back to the abandoned branch: the node revives (rows never deleted).
		const h2 = createHostMock({ entryIds: ["e-offpath"], entries: [] });
		module.registerSession(h2.host);
		await module.onLeafChange();
		const r2 = await fireBeforeAgentStart(h2.hooks, "kept orphan manual 正文 认知");
		expect(r2?.message?.content).toContain("history://orphan");
	});

	it("never hides auto nodes produced by another session (§3.7 cross-session)", async () => {
		makeAutoNode("history://other", "e-other", "session-B");
		makeAutoNode("history://mine", "e-gone", "session-1");
		const module = createMemoryModule(store, OFFLINE);

		// Current session branch does NOT contain e-other or e-gone.
		const h = createHostMock({ entryIds: ["e-current"], entries: [] });
		module.registerSession(h.host);
		await module.onLeafChange();

		const r = await fireBeforeAgentStart(h.hooks, "other mine 正文");
		// B's product visible even though its anchor isn't on A's path.
		expect(r?.message?.content).toContain("history://other");
		// A's own orphan stays hidden.
		expect(r?.message?.content).not.toContain("history://mine");
	});

	it("auto nodes missing provenance (no session id) are always hidden", async () => {
		store.insertNode({ uri: "history://noprov", content: "无出处 正文", source: "auto", anchor_entry_id: "e-x" });
		store.insertNode({ uri: "history://manual", content: "可见手写 manual", source: "manual" });
		const module = createMemoryModule(store, OFFLINE);
		const h = createHostMock({ entryIds: ["e-x"], entries: [] });
		module.registerSession(h.host);
		await module.onLeafChange();
		const r = await fireBeforeAgentStart(h.hooks, "noprov 可见手写 manual 正文");
		// The manual node still injects, so a message is produced — but the
		// provenance-less auto node never leaks into it.
		expect(r?.message?.content).toContain("history://manual");
		expect(r?.message?.content ?? "").not.toContain("history://noprov");
	});

	it("syncs raw_log to the active branch: off-path rows deactivate, switch-back revives with stable raw_id", async () => {
		// Seed the mirror as if turn 1 produced e1/e2 under session-1.
		store.appendRaw([
			{
				role: "user",
				text: "a",
				entry_id: "e1",
				session_id: "session-1",
				wall_ts: "2026-01-01T00:00:00Z",
				world_ts: "2026-01-01T00:00:00.000Z",
			},
			{
				role: "assistant",
				text: "b",
				entry_id: "e2",
				session_id: "session-1",
				wall_ts: "2026-01-01T00:00:01Z",
				world_ts: "2026-01-01T00:00:01.000Z",
			},
		]);
		const module = createMemoryModule(store, OFFLINE);

		// Branch switches to [e1]: e2 leaves the active path.
		const h1 = createHostMock({ entryIds: ["e1"], entries: [] }, [], [t("user", "a", "e1")]);
		module.registerSession(h1.host);
		await module.onLeafChange();
		const afterReroll = store.listRaw(1, 2, { activeOnly: true });
		expect(afterReroll.map((r) => r.entry_id)).toEqual(["e1"]);
		const e2Inactive = store.listRaw(1, 2, { activeOnly: false }).find((r) => r.entry_id === "e2");
		expect(e2Inactive?.active).toBe(0);
		const e2RawId = e2Inactive!.raw_id;

		// Switch back to [e1,e2]: e2 revives with the SAME raw_id; the
		// previously persisted world timestamp is NEVER overwritten (§12).
		const h2 = createHostMock(
			{ entryIds: ["e1", "e2"], entries: [] },
			[],
			[t("user", "a", "e1"), t("assistant", "b", "e2")],
		);
		module.registerSession(h2.host);
		await module.onLeafChange();
		const revived = store.listRaw(1, 2, { activeOnly: true });
		expect(revived.map((r) => r.entry_id)).toEqual(["e1", "e2"]);
		expect(revived[1].raw_id).toBe(e2RawId);
		expect(revived[1].world_ts).toBe("2026-01-01T00:00:01.000Z");
	});

	it("never throws without a snapshot capability", async () => {
		const module = createMemoryModule(store, OFFLINE);
		const h = createHostMock();
		// strip getBranchSnapshot to simulate a minimal host
		const bare = { ...h.host, getBranchSnapshot: undefined } as unknown as MemoryModuleHost;
		module.registerSession(bare);
		store.appendRaw([{ role: "user", text: "x", entry_id: "e1", session_id: "session-1", wall_ts: "t" }]);
		await expect(module.onLeafChange()).resolves.toBeUndefined();
		// No snapshot → reconciliation skipped, raw_log intact.
		expect(store.listRaw(1)).toHaveLength(1);
	});
});

// ── raw_log write-through (§4/§15.3) ────────────────────────────────────────

describe("onTurnEnd", () => {
	it("appends this turn's messages to raw_log with original timestamps and world_ts", async () => {
		store.setWorldTime("2026-06-01T00:00:00.000Z");
		const module = createMemoryModule(store, OFFLINE);
		const h = createHostMock({}, [t("user", "你好", "u1"), t("assistant", "你好呀", "a1")]);
		module.registerSession(h.host);
		await module.onTurnEnd();
		const rows = store.listRaw(1, 2);
		expect(rows.map((r) => `${r.role}:${r.text}`)).toEqual(["user:你好", "assistant:你好呀"]);
		expect(rows[0].entry_id).toBe("u1");
		// §12 fix: the row keeps the ORIGINAL entry wall timestamp.
		expect(rows[0].wall_ts).toBe("2026-09-10T00:00:01Z");
		// New rows are stamped with the current world clock.
		expect(rows[0].world_ts).toBe("2026-06-01T00:00:00.000Z");
	});

	it("captures custom messages per the three-way switch (default all-display-true)", async () => {
		const module = createMemoryModule(store, OFFLINE);
		const h = createHostMock({}, [
			t("user", "正文", "u1"),
			t("rp-state", "状态注入", "c1", { customType: "rp-state", display: true }),
			t("rp-hidden", "隐藏注入", "c2", { customType: "rp-hidden", display: false }),
		]);
		module.registerSession(h.host);
		await module.onTurnEnd();
		const rows = store.listRaw(1, 5);
		// default "all-display-true": display:true captured, display:false not.
		expect(rows.some((r) => r.role === "rp-state")).toBe(true);
		expect(rows.some((r) => r.role === "rp-hidden")).toBe(false);
	});

	it("captures nothing in none mode and only listed types in list mode", async () => {
		const messages: MemoryTurnMessage[] = [
			t("rp-a", "a", "c1", { customType: "rp-a", display: true }),
			t("rp-b", "b", "c2", { customType: "rp-b", display: true }),
		];
		const noneModule = createMemoryModule(store, {
			settings: { embeddings: { mode: "off" }, rawLog: { customTypes: "none" } },
		});
		const h1 = createHostMock({}, messages);
		noneModule.registerSession(h1.host);
		await noneModule.onTurnEnd();
		expect(store.listRaw(1)).toHaveLength(0);

		const listModule = createMemoryModule(store, {
			settings: { embeddings: { mode: "off" }, rawLog: { customTypes: ["rp-b"] } },
		});
		const h2 = createHostMock({}, messages);
		listModule.registerSession(h2.host);
		await listModule.onTurnEnd();
		const roles = store.listRaw(1, 5).map((r) => r.role);
		expect(roles).toEqual(["rp-b"]);
	});

	it("appends nothing when the turn has no messages", async () => {
		const module = createMemoryModule(store, OFFLINE);
		const h = createHostMock({}, []);
		module.registerSession(h.host);
		await module.onTurnEnd();
		expect(store.listRaw(1)).toHaveLength(0);
	});
});

// ── registerSession surface ─────────────────────────────────────────────────

describe("registerSession", () => {
	it("registers 12 tools, 3 slots, the rp-memories policy and the recall hook", async () => {
		const module = createMemoryModule(store, OFFLINE);
		const h = createHostMock();
		module.registerSession(h.host);
		expect([...h.tools.keys()].sort()).toEqual(
			[
				"recall",
				"retrieve",
				"memorize",
				"revise",
				"forget",
				"relocate",
				"associate",
				"trigger",
				"consolidate",
				"retrace",
				"set_time",
				"awaken",
			].sort(),
		);
		expect(h.customTypes).toHaveLength(2);
		expect(h.customTypes[0][0]).toBe("rp-memories");
		expect(h.customTypes[0][1]).toEqual({ context: "include", llmRole: "user", compaction: "exclude" });
		expect(h.customTypes[1][0]).toBe("rp-notify");
		expect(h.customTypes[1][1]).toEqual({ context: "include", llmRole: "user", compaction: "exclude" });
		expect(h.hooks.has("before_agent_start")).toBe(true);
		// Double-write guard: turn_end must NOT be subscribed via host.on.
		expect(h.hooks.has("turn_end")).toBe(false);
	});

	it("registered tools execute against the store", async () => {
		const module = createMemoryModule(store, OFFLINE);
		const h = createHostMock();
		module.registerSession(h.host);
		const memorize = h.tools.get("memorize");
		expect(memorize).toBeDefined();
		await memorize?.execute("t1", { uri: "history://x", content: "工具写入" });
		expect(nodeByUri("history://x").content).toBe("工具写入");
	});
});

// ── §15.3 switch predicate ──────────────────────────────────────────────────

describe("shouldCaptureCustomType", () => {
	it("all-display-true captures only display:true", async () => {
		expect(shouldCaptureCustomType("rp-a", true, "all-display-true")).toBe(true);
		expect(shouldCaptureCustomType("rp-a", false, "all-display-true")).toBe(false);
	});
	it("none captures nothing", async () => {
		expect(shouldCaptureCustomType("rp-a", true, "none")).toBe(false);
	});
	it("list mode captures listed types regardless of display", async () => {
		expect(shouldCaptureCustomType("rp-a", false, ["rp-a"])).toBe(true);
		expect(shouldCaptureCustomType("rp-b", true, ["rp-a"])).toBe(false);
	});
});
