/**
 * Phase 3 tests (docs/memory-system.md §5/§7/§10):
 *   - autoretain task engine (side LLM via completeSideRequest)
 *   - TEMP dynamic-zone threshold notify (rp-notify)
 *   - MEM:// views (timeline / forgotten / recent / diagnostic)
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AutoretainTask, dueTasks, runAutoretainTask } from "../src/autoretain.ts";
import { type MemoryDatabase, openDatabase } from "../src/driver.ts";
import {
	renderDiagnosticView,
	renderForgottenView,
	renderRecentView,
	renderTimelineView,
} from "../src/memory-views.ts";
import { createMemoryModule, type MemoryModuleHost, type MemoryTurnMessage } from "../src/module.ts";
import { createSchema } from "../src/schema.ts";
import type { MemoryNode } from "../src/store.ts";
import { MemoryStore } from "../src/store.ts";

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

// ── autoretain (§5) ─────────────────────────────────────────────────────────

const SUMMARY_TASK: AutoretainTask = {
	name: "scene-summary",
	everyNTurns: 4,
	promptTemplate: "总结以下窗口，写入 {domain} 域。\n\n{window}\n\n输出仅一个 JSON 对象。",
	landing: { domain: "history", strategy: "append" },
	modelRole: "smol",
};

function autoretainHost(response: string, calls: string[] = []) {
	return {
		completeSideRequest: async (prompt: string, _options?: { label?: string }) => {
			calls.push(prompt);
			return response;
		},
		getSessionInfo: () => ({ modelId: "side-model", leafId: "leaf-42", sessionId: "session-1" }),
	};
}

/** Seed one raw row with the required session_id (§3.1). */
function rawRow(
	entryId: string,
	role: string,
	text: string,
	wallTs: string,
): Parameters<MemoryStore["appendRaw"]>[0][number] {
	return { role, text, entry_id: entryId, session_id: "session-1", wall_ts: wallTs };
}

describe("autoretain", () => {
	it("lands the product in the history domain with source auto and provenance stamped", async () => {
		store.appendRaw([
			rawRow("e1", "user", "我们在酒馆谈话", "2026-09-10T00:00:00Z"),
			rawRow("e2", "assistant", "薇拉谈到了北方商队", "2026-09-10T00:00:01Z"),
		]);
		const window = store.listUnprocessedActiveRaw("session-1", SUMMARY_TASK.name, 80);
		const outcome = await runAutoretainTask(
			store,
			SUMMARY_TASK,
			window,
			autoretainHost('{"content": "酒馆谈话纪要：北方商队"}'),
		);
		expect(outcome.ok).toBe(true);
		const node = store.resolveUri(outcome.uri!);
		expect(node).not.toBeNull();
		expect(node!.domain).toBe("history");
		expect(node!.source).toBe("auto");
		expect(node!.model).toBe("side-model");
		expect(node!.anchor_entry_id).toBe("leaf-42");
		expect(node!.content).toBe("酒馆谈话纪要：北方商队");
	});

	it("silently skips on JSON contract violation", async () => {
		store.appendRaw([rawRow("e1", "user", "hi", "2026-09-10T00:00:00Z")]);
		const outcome = await runAutoretainTask(
			store,
			SUMMARY_TASK,
			store.listUnprocessedActiveRaw("session-1", SUMMARY_TASK.name, 80),
			autoretainHost("我不是 JSON"),
		);
		expect(outcome.ok).toBe(false);
		expect(outcome.error).toContain("JSON");
	});

	it("fires due tasks on the shared turn counter", () => {
		const tasks: AutoretainTask[] = [SUMMARY_TASK, { ...SUMMARY_TASK, name: "self-reflection", everyNTurns: 8 }];
		expect(dueTasks(tasks, 4).map((t) => t.name)).toEqual(["scene-summary"]);
		expect(dueTasks(tasks, 8).map((t) => t.name)).toEqual(["scene-summary", "self-reflection"]);
		expect(dueTasks(tasks, 5)).toEqual([]);
	});

	it("module onTurnEnd fires due autoretain tasks via host.completeSideRequest", async () => {
		const calls: string[] = [];
		const sendCalls: unknown[] = [];
		const messages: MemoryTurnMessage[] = [
			{ role: "user", text: "谈话内容一", entryId: "e1", timestamp: "2026-09-10T00:00:00Z" },
			{ role: "assistant", text: "回应内容二", entryId: "e2", timestamp: "2026-09-10T00:00:01Z" },
		];
		const host: MemoryModuleHost = {
			registerTool: () => {},
			registerSlot: () => {},
			registerCustomType: () => {},
			on: () => {},
			sendCustomMessage: (m) => {
				sendCalls.push(m);
			},
			getSessionInfo: () => ({ modelId: "side-model", leafId: "leaf-9", sessionId: "session-1", turn: 0 }),
			getBranchSnapshot: () => ({ entryIds: ["e1", "e2"], entries: [] }),
			getTurnMessages: () => messages,
			getActiveBranchMessages: () => messages,
			completeSideRequest: async (prompt, _options) => {
				calls.push(prompt);
				return '{"content": "自动纪要内容"}';
			},
		};
		const module = createMemoryModule(store, {
			settings: { embeddings: { mode: "off" }, autoretain: { everyNTurns: 1 } },
		});
		module.registerSession(host);
		await module.onTurnEnd(); // turn 1: everyNTurns=1 → both default tasks due

		expect(calls.length).toBeGreaterThanOrEqual(1);
		const products = store.listNodes({ domain: "history" }).filter((n) => !n.is_stub);
		expect(products.length).toBeGreaterThanOrEqual(1);
		const node = products[0] as MemoryNode;
		expect(node.source).toBe("auto");
		expect(node.model).toBe("side-model");
		expect(node.anchor_entry_id).toBe("leaf-9");
		// §4 consumption path: the window provenance is stamped.
		expect(node.first_raw_id).not.toBeNull();
		expect(node.last_raw_id).not.toBeNull();
		expect(node.anchor_session_id).toBe("session-1");
	});
});

// ── TEMP dynamic zone (§7) ──────────────────────────────────────────────────

describe("TEMP threshold notify", () => {
	function tempHost() {
		const sent: Array<{ customType: string; content: string; display: false; details?: unknown }> = [];
		const host: MemoryModuleHost = {
			registerTool: () => {},
			registerSlot: () => {},
			registerCustomType: () => {},
			on: () => {},
			sendCustomMessage: (m) => {
				sent.push(m);
			},
			getSessionInfo: () => ({ sessionId: "session-1", turn: 0 }),
			getBranchSnapshot: () => ({ entryIds: [], entries: [] }),
			getTurnMessages: () => [],
			getActiveBranchMessages: () => [],
			completeSideRequest: async () => "{}",
		};
		return { host, sent };
	}

	it("notifies once when TEMP nodes reach the threshold and stays quiet until cleaned", async () => {
		const { host, sent } = tempHost();
		const module = createMemoryModule(store, {
			settings: { temp: { threshold: 2 }, autoretain: { everyNTurns: 999 } },
		});
		module.registerSession(host);

		// One turn with 2 TEMP writes below... at threshold (2 >= 2).
		for (let i = 1; i <= 2; i++) {
			store.put({ uri: `TEMP://draft-${i}`, content: `草稿${i}`, source: "manual" });
		}
		await module.onTurnEnd();
		expect(sent).toHaveLength(1);
		expect(sent[0]!.customType).toBe("rp-notify");
		expect(sent[0]!.display).toBe(false);
		expect(sent[0]!.content).toContain("TEMP 暂存区现有 2 条");

		// Another turn with the zone untouched → hysteresis keeps it quiet.
		await module.onTurnEnd();
		expect(sent).toHaveLength(1);

		// Clean below threshold → re-armed; refilling notifies again.
		store.deleteCascade(store.resolveUri("TEMP://draft-1")!.node_id);
		store.deleteCascade(store.resolveUri("TEMP://draft-2")!.node_id);
		await module.onTurnEnd();
		store.put({ uri: "TEMP://draft-3", content: "新草稿", source: "manual" });
		store.put({ uri: "TEMP://draft-4", content: "新草稿2", source: "manual" });
		await module.onTurnEnd();
		expect(sent).toHaveLength(2);
	});
});

// ── MEM:// views (§10) ───────────────────────────────────────────────────

describe("MEM:// views", () => {
	function seed() {
		store.insertNode({ uri: "history://alpha", content: "阿尔法事件：北方商队抵达", importance: 3 });
		store.insertNode({ uri: "history://beta", content: "贝塔事件：酒馆易主", importance: 5 });
		store.insertNode({ uri: "core://self", content: "自我认知：沉默寡言" });
		store.appendRaw([
			{
				role: "user",
				text: "第一条消息",
				entry_id: "e1",
				session_id: "session-1",
				wall_ts: "2026-09-09T00:00:00Z",
				world_ts: "1000-01-01",
			},
			{
				role: "assistant",
				text: "第二条消息",
				entry_id: "e2",
				session_id: "session-1",
				wall_ts: "2026-09-09T00:00:01Z",
				world_ts: "1000-01-02",
			},
		]);
	}

	it("timeline renders raw_log messages with world_ts, newest first", () => {
		seed();
		const out = renderTimelineView(store, 20);
		expect(out).toContain("# 原文时间轴");
		expect(out).toContain("第二条消息");
		expect(out).toContain("1000-01-02");
		expect(out.indexOf("第二条消息")).toBeLessThan(out.indexOf("第一条消息"));
	});

	it("forgotten renders the least-recently-accessed live memories (§13)", () => {
		seed();
		// Alpha was actively recalled 60 days ago and never since; beta was
		// just recalled. Sleeping metric = last_accessed_at (§13).
		db.prepare("UPDATE nodes SET last_accessed_at = ? WHERE uri = ?").run(
			new Date(Date.now() - 60 * 86400000).toISOString(),
			"history://alpha",
		);
		store.markAccessed([store.resolveUri("history://beta")!.node_id], new Date().toISOString());
		const out = renderForgottenView(store, undefined, 1);
		expect(out).toContain("history://alpha");
		expect(out).not.toContain("history://beta");
	});

	it("recent renders newest-updated memories with snippets", () => {
		seed();
		const out = renderRecentView(store, 10);
		expect(out).toContain("history://beta");
	});

	it("diagnostic reports stale / crowded / placeholder issues", () => {
		seed();
		// Pin alpha's last access back 60 days → stale (importance 3 < 8 →
		// default 30d threshold), and give it a child → parent status.
		db.prepare("UPDATE nodes SET last_accessed_at = ? WHERE uri = ?").run(
			new Date(Date.now() - 60 * 86400000).toISOString(),
			"history://alpha",
		);
		store.put({ uri: "history://alpha/child", content: "占位", source: "manual" });
		const out = renderDiagnosticView(store, "history");
		expect(out).toContain("Stale");
		expect(out).toContain("history://alpha");
	});
});
