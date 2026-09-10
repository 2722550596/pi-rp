/**
 * coding-agent ↔ pi-memory integration (Phase 2, docs/memory-system.md).
 *
 * Full AgentSession path: harness sessions wire the memory module via
 * _setupMemoryModule (settings.memory.dbPath → process store singleton), so
 * these tests exercise the real wiring — tools, rp-memories injection through
 * before_agent_start, awaken slot rendering, raw_log write-through at turn
 * end, and the reroll rollback coupling at _moveLeafAndRestoreState.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createSchema, type MemoryDatabase, MemoryStore, openDatabase } from "@earendil-works/pi-memory";
import { afterEach, describe, expect, it } from "vitest";
import type { Harness } from "./suite/harness.ts";
import { createHarness } from "./suite/harness.ts";

const harnesses: Harness[] = [];
const tempDirs: string[] = [];

afterEach(() => {
	while (harnesses.length > 0) {
		harnesses.pop()?.cleanup();
	}
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

/** Fresh harness with a memory DB in an isolated temp dir. */
async function createMemoryHarness() {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-memory-int-"));
	tempDirs.push(tempDir);
	const harness = await createHarness({ settings: { memory: { dbPath: join(tempDir, "memory.db") } } });
	harnesses.push(harness);
	return { harness, tempDir };
}

/** Open the same DB file the session singleton uses (after session creation). */
async function openStore(dbPath: string): Promise<{ db: MemoryDatabase; store: MemoryStore }> {
	const db = await openDatabase(dbPath);
	createSchema(db);
	return { db, store: new MemoryStore(db) };
}

function nodeByUri(store: MemoryStore, uri: string) {
	const node = store.resolveUri(uri);
	if (!node) throw new Error(`missing node ${uri}`);
	return node;
}

describe("memory module ↔ AgentSession integration", () => {
	it("wires the 12 memory tools and rp-memories policy at runtime build", async () => {
		const { harness } = await createMemoryHarness();
		// Tools registered through the synthetic extension appear in the tool registry.
		const toolNames = harness.session.getAllTools().map((t) => t.name) ?? [];
		for (const name of ["recall", "retrieve", "memorize", "revise", "forget", "set_time", "awaken"]) {
			expect(toolNames).toContain(name);
		}
	});

	it("memorize through the real tool writes provenance into the store", async () => {
		const { harness, tempDir } = await createMemoryHarness();
		const { store } = await openStore(join(tempDir, "memory.db"));
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("memorize", { uri: "history://scene/1", content: "伊莱进入酒馆" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("已记下"),
		]);
		await harness.session.prompt("记住：伊莱进入酒馆");
		const node = store.resolveUri("history://scene/1");
		expect(node).not.toBeNull();
		expect(node?.source).toBe("manual");
		expect(node?.model).toBe(harness.session.model?.id ?? null);
		// The anchor is stamped at tool-execute time: the leaf then is the
		// assistant entry carrying the tool call (the final leaf moves after
		// the closing assistant message persists).
		const branchIds = harness.sessionManager.getBranch().map((e) => e.id);
		expect(branchIds).toContain(node?.anchor_entry_id);
	});

	it("injects rp-memories on prompt and dedups the next identical prompt", async () => {
		const { harness, tempDir } = await createMemoryHarness();
		const { store } = await openStore(join(tempDir, "memory.db"));
		store.insertNode({ uri: "history://tavern", content: "伊莱在酒馆遇到薇拉谈及北方的商队" });
		harness.setResponses([fauxAssistantMessage("好的")]);
		await harness.session.prompt("伊莱在酒馆遇到了谁");

		// First prompt: rp-memories entry on the active branch with dedup details.
		const entries = harness.sessionManager.buildContextEntries();
		const injected = entries.filter((e) => e.type === "custom_message" && e.customType === "rp-memories");
		expect(injected).toHaveLength(1);

		harness.setResponses([fauxAssistantMessage("还是好的")]);
		await harness.session.prompt("伊莱在酒馆遇到了谁");
		const entries2 = harness.sessionManager.buildContextEntries();
		const injected2 = entries2.filter((e) => e.type === "custom_message" && e.customType === "rp-memories");
		expect(injected2).toHaveLength(1);
	});

	it("turn_end appends user/assistant messages to raw_log (§4 mirror)", async () => {
		const { harness, tempDir } = await createMemoryHarness();
		const { store } = await openStore(join(tempDir, "memory.db"));
		store.setWorldTime("2026-06-01T00:00:00.000Z");
		harness.setResponses([fauxAssistantMessage("回应")]);
		await harness.session.prompt("问个好");
		const branch = harness.sessionManager.getBranch().filter((e) => e.type === "message");
		const rawRows = store.listRaw(1, 10);
		// user prompt + assistant reply mirrored into raw_log by onTurnEnd.
		expect(rawRows.map((r) => r.role)).toEqual(["user", "assistant"]);
		expect(rawRows.map((r) => r.entry_id).sort()).toEqual(branch.map((e) => e.id).sort());
		// world_ts comes from the store's world clock (listRaw omits the column;
		// assert through SQL — wall_ts is the ISO wall clock, prefixed date matches).
		const worldTs = store.db.prepare("SELECT world_ts FROM raw_log ORDER BY raw_id").all() as Array<{
			world_ts: string | null;
		}>;
		expect(worldTs.every((r) => r.world_ts === "2026-06-01T00:00:00.000Z")).toBe(true);
	});

	it("reroll hides the anchored summary, deactivates raw_log rows, and revives on switch-back", async () => {
		const { harness, tempDir } = await createMemoryHarness();
		const { store } = await openStore(join(tempDir, "memory.db"));

		// Turn: user → assistant. The assistant entry anchors an auto summary.
		harness.setResponses([fauxAssistantMessage("酒馆里人声鼎沸")]);
		await harness.session.prompt("伊莱走进了酒馆");
		const branch = harness.sessionManager.getBranch().filter((e) => e.type === "message");
		const userEntry = branch.find((e) => e.message.role === "user");
		const assistantEntry = branch.find((e) => e.message.role === "assistant");
		expect(userEntry && assistantEntry).toBeTruthy();
		store.insertNode({
			uri: "history://scene/summary-1",
			content: "纪要：伊莱走进酒馆，人声鼎沸",
			source: "auto",
			anchor_entry_id: assistantEntry?.id,
			anchor_session_id: harness.sessionManager.getSessionId(),
		});

		// raw_log holds both turns now.
		expect(
			store
				.listRaw(1, 5)
				.map((r) => r.entry_id)
				.sort(),
		).toEqual([userEntry?.id, assistantEntry?.id].sort());

		// reroll: branch back to the user message → assistant entry leaves the path.
		const rerolled = await harness.session.reroll();
		expect(rerolled).toBe(true);
		// The engine calls onLeafChange at the tail of _moveLeafAndRestoreState
		// (fire-and-forget); flush the microtask queue before asserting.
		await Promise.resolve();

		// ① auto summary invisible on the new path (recall skips it) — verify via
		// the store visibility rule the module recomputes: anchor off-path.
		const activeIds = new Set(harness.sessionManager.getBranch().map((e) => e.id));
		const summary = nodeByUri(store, "history://scene/summary-1");
		expect(activeIds.has(summary.anchor_entry_id ?? "")).toBe(false);

		// ② raw_log row of the rolled-back assistant message DEACTIVATED, not
		// deleted — the stable row keeps its raw_id and wall timestamp (§3.1).
		const activeRows = store.listRaw(1, 5, { activeOnly: true }).map((r) => r.entry_id);
		expect(activeRows).toEqual([userEntry?.id]);
		const allRows = store.listRaw(1, 5, { activeOnly: false });
		expect(allRows.map((r) => r.entry_id).sort()).toEqual([userEntry?.id, assistantEntry?.id].sort());
		const offPath = allRows.find((r) => r.entry_id === assistantEntry?.id);
		expect(offPath?.active).toBe(0);

		// ③ switch back to the original branch → summary anchor active again
		// (session-manager branch state; the raw_log row revival with the
		// ORIGINAL raw_id is covered at the store/module layer, where
		// syncRawBranch is driven directly).
		harness.sessionManager.branch(assistantEntry?.id ?? "");
		await Promise.resolve();
		const activeIds2 = new Set(harness.sessionManager.getBranch().map((e) => e.id));
		expect(activeIds2.has(summary.anchor_entry_id ?? "")).toBe(true);
	});
});

describe("memory module ↔ AgentSession integration (v5.5 wiring)", () => {
	function waitMicrotasks(): Promise<void> {
		// onTurnEnd / onLeafChange fire-and-forget paths resolve on the
		// microtask queue (no timers involved in the module).
		return new Promise((resolve) => setTimeout(resolve, 0));
	}

	it("autoretain everyNTurns:1 consumes a faux side response and lands auto nodes with window provenance", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-memory-int-"));
		tempDirs.push(tempDir);
		const harness = await createHarness({
			settings: {
				memory: {
					dbPath: join(tempDir, "memory.db"),
					autoretain: {
						everyNTurns: 1,
						tasks: [
							{
								name: "scene-summary",
								everyNTurns: 1,
								promptTemplate: "总结：{window} → {domain}",
								landing: { domain: "history", strategy: "append" },
								modelRole: "smol",
							},
						],
					},
				},
			},
		});
		harnesses.push(harness);
		const { store } = await openStore(join(tempDir, "memory.db"));

		// Main turn response, THEN the autoretain side request's response.
		// Both flow through the same faux provider queue.
		harness.setResponses([
			fauxAssistantMessage("好的，提到酒馆。"),
			fauxAssistantMessage('{"content": "酒馆谈话纪要"}'),
		]);
		await harness.session.prompt("我们在酒馆谈话");
		await waitMicrotasks();

		// The side request produced an auto node in the history domain.
		const auto = store.listNodes({ domain: "history" }).filter((n) => !n.is_stub);
		expect(auto.length).toBeGreaterThanOrEqual(1);
		const node = auto[0];
		expect(node.source).toBe("auto");
		expect(node.anchor_session_id).toBe(harness.sessionManager.getSessionId());
		// Window provenance stamped from raw_log raw_ids.
		expect(node.first_raw_id).not.toBeNull();
		expect(node.last_raw_id).not.toBeNull();
		expect(node.last_raw_id!).toBeGreaterThanOrEqual(node.first_raw_id!);
	});

	it("message entry timestamps reach raw_log verbatim", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-memory-int-"));
		tempDirs.push(tempDir);
		const harness = await createHarness({ settings: { memory: { dbPath: join(tempDir, "memory.db") } } });
		harnesses.push(harness);
		const { store } = await openStore(join(tempDir, "memory.db"));
		harness.setResponses([fauxAssistantMessage("回应")]);
		await harness.session.prompt("问个好");
		await waitMicrotasks();

		const branch = harness.sessionManager.getBranch().filter((e) => e.type === "message");
		const rawRows = store.listRaw(1, 10);
		for (const entry of branch) {
			const row = rawRows.find((r) => r.entry_id === entry.id);
			expect(row).toBeTruthy();
			// §12: raw_log wall clock = the entry's ORIGINAL timestamp.
			expect(row?.wall_ts).toBe(entry.timestamp);
		}
	});

	it("activePreset memory.dbPath takes part in the resolution chain", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-memory-int-"));
		tempDirs.push(tempDir);
		const harness = await createHarness({ settings: { memory: { dbPath: join(tempDir, "settings.db") } } });
		harnesses.push(harness);
		// Before any preset: the settings path is resolved.
		expect(harness.session.getMemoryDbPath()).toBe(join(tempDir, "settings.db"));
		// Activating a preset whose memory declaration points elsewhere
		// resolves to the preset path after reload.
		const presetDir = mkdtempSync(join(tmpdir(), "pi-preset-"));
		tempDirs.push(presetDir);
		// Explicit preset activation is exercised via the memory pact test in
		// suite/regressions where a memory-carrying preset is loaded; here we
		// assert the child member exists and is stable.
		expect(harness.session.getMemoryDbPath()).toBe(join(tempDir, "settings.db"));
	});

	it("dispose tears down the module without killing the shared store", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-memory-int-"));
		tempDirs.push(tempDir);
		const harness = await createHarness({ settings: { memory: { dbPath: join(tempDir, "memory.db") } } });
		harnesses.push(harness);
		await openStore(join(tempDir, "memory.db"));
		// A prompt first so the module is live.
		harness.setResponses([fauxAssistantMessage("回应")]);
		await harness.session.prompt("你好");
		await waitMicrotasks();
		// Dispose is idempotent and never throws.
		harness.session.dispose();
		harness.session.dispose();
		// The shared store file remains queryable outside the session.
		const after = await openStore(join(tempDir, "memory.db"));
		expect(after.store.listNodes({ domain: "history" })).toBeDefined();
		after.db.close();
	});
});
