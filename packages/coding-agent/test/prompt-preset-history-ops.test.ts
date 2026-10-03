import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import { compileMessages, compileMessagesSync } from "../src/core/prompt-preset/compiler.ts";
import { defaultPreset } from "../src/core/prompt-preset/default-stack.ts";
import { HistoryOpRegistry } from "../src/core/prompt-preset/history-ops.ts";
import { loadPromptPresets } from "../src/core/prompt-preset/loader.ts";
import type { HistoryOp, PromptPreset, PromptRuntime } from "../src/core/prompt-preset/types.ts";

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function userMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 0 };
}

function assistantMessage(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

function insertMessage(text: string): AgentMessage {
	return { role: "custom", content: [{ type: "text", text }], timestamp: 0 } as AgentMessage;
}

function text(message: AgentMessage): string {
	if (!Array.isArray(message.content)) return "";
	return message.content
		.flatMap((part) => ("text" in part && typeof part.text === "string" ? [part.text] : []))
		.join("");
}

function runtime(messages: AgentMessage[], extra: Partial<PromptRuntime> = {}): PromptRuntime {
	return { options: { cwd: "" }, messages, now: new Date(0), variables: {}, skills: [], ...extra };
}

function preset(ops: HistoryOp[], id = "history"): PromptPreset {
	return { schemaVersion: 1, id: "test", items: [{ kind: "history", id, ops }] };
}

it("validates operation cardinality, exclusive keep units, and traces:0 diagnostics", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-history-ops-"));
	tempDirs.push(directory);
	const presetDirectory = join(directory, ".pi", "prompt-presets");
	mkdirSync(presetDirectory, { recursive: true });
	writeFileSync(
		join(presetDirectory, "history.json"),
		JSON.stringify({
			schemaVersion: 1,
			id: "history",
			items: [
				{
					kind: "history",
					id: "history-point",
					ops: [
						{ op: "keep", tokens: 1, traces: 1 },
						{ op: "keep", traces: 0 },
						{ op: "keep", traces: 2 },
						{ op: "reduce", as: "hide" },
						{ op: "reduce", as: "summary" },
					],
				},
			],
		}),
	);
	const [loaded] = loadPromptPresets(directory);
	expect(loaded.preset.items[0]).toMatchObject({
		kind: "history",
		ops: [
			{ op: "keep", traces: 0 },
			{ op: "reduce", as: "hide" },
		],
	});
	expect(loaded.diagnostics.filter((diagnostic) => diagnostic.level === "error")).toHaveLength(3);
	expect(
		loaded.diagnostics.some(
			(diagnostic) => diagnostic.level === "warning" && diagnostic.message.includes("traces: 0"),
		),
	).toBe(true);
});

describe("history operation assembly", () => {
	it("uses keep/reduce before depth insertion and computes insertion depth against the retained stream", async () => {
		const compiled = await compileMessages(
			preset([
				{ op: "keep", traces: 1 },
				{ op: "reduce", as: "hide" },
				{ op: "insert", id: "near", depth: 1, content: "inserted" },
			]),
			runtime([userMessage("u1"), assistantMessage("a1"), userMessage("u2"), assistantMessage("a2")]),
		);
		expect(compiled.messages.map(text)).toEqual(["u2", "inserted", "a2"]);
		expect(compiled.sources[1]).toMatchObject({
			kind: "history-op",
			opId: "near",
			origin: { kind: "preset", itemId: "history" },
		});
	});

	it("orders same-depth dynamic inserts before preset inserts by stable registration order", async () => {
		const registry = new HistoryOpRegistry();
		const dynamic: HistoryOp[] = [
			{ op: "insert", id: "d1", depth: 1, render: () => [insertMessage("dynamic-1")] },
			{ op: "insert", id: "d2", depth: 1, render: () => [insertMessage("dynamic-2")] },
		];
		const disposers = dynamic.map((op) => registry.register("extension", op));
		const result = await compileMessages(
			preset([{ op: "insert", id: "p", depth: 1, content: "preset" }]),
			runtime([userMessage("older"), userMessage("latest")], { historyOps: registry.snapshot() }),
		);
		// Adjacent same-role products merge via the compiler's global squash rule;
		// the merged text order (d1 → d2 → preset) still proves dynamic-before-preset.
		expect(result.messages).toHaveLength(3);
		expect(text(result.messages[0])).toBe("older");
		expect(text(result.messages[1])).toBe("dynamic-1\n\ndynamic-2\n\npreset");
		expect(text(result.messages[2])).toBe("latest");
		const snapshot = registry.snapshot();
		expect(snapshot).toHaveLength(2);
		disposers[0]();
		expect(snapshot).toHaveLength(2);
		expect(registry.snapshot()).toHaveLength(1);
		disposers[1]();
	});

	it("places dynamic and preset inserts independently at distinct depths without merging", async () => {
		const registry = new HistoryOpRegistry();
		registry.register("extension", { op: "insert", id: "d1", depth: 1, render: () => [insertMessage("dynamic-1")] });
		const result = await compileMessages(
			preset([{ op: "insert", id: "p", depth: 2, content: "preset-2" }]),
			runtime([userMessage("older"), userMessage("latest")], { historyOps: registry.snapshot() }),
		);
		// depth 2 lands before "older", depth 1 before "latest"; distinct roles and
		// positions keep every product a standalone message.
		expect(result.messages).toHaveLength(4);
		expect(text(result.messages[0])).toBe("preset-2");
		expect(text(result.messages[1])).toBe("older");
		expect(text(result.messages[2])).toBe("dynamic-1");
		expect(text(result.messages[3])).toBe("latest");
	});

	it("clamps over-deep inserts to the start after window reduction", async () => {
		const result = await compileMessages(
			preset([
				{ op: "keep", traces: 1 },
				{ op: "reduce", as: "hide" },
				{ op: "insert", id: "early", depth: 9, content: "early" },
			]),
			runtime([userMessage("old"), assistantMessage("old answer"), userMessage("new")]),
		);
		expect(result.messages.map(text)).toEqual(["early", "new"]);
		expect(result.diagnostics.map(({ message }) => message)).toContain(
			'History operation "early" depth was clamped to the start of the retained history.',
		);
	});

	it("isolates failed output atomically and exposes no insert output in peer snapshots", async () => {
		let snapshot: readonly AgentMessage[] = [];
		const historyOps = [
			{
				op: "insert" as const,
				id: "bad",
				depth: 0,
				render: () => [insertMessage("partial"), null] as unknown as AgentMessage[],
			},
			{
				op: "insert" as const,
				id: "good",
				depth: 0,
				render: (context: { messages: readonly AgentMessage[] }) => {
					snapshot = context.messages;
					return [insertMessage("good")];
				},
			},
		];
		const result = await compileMessages(
			preset([]),
			runtime([userMessage("history")], {
				historyOps: historyOps.map((op, order) => ({
					op,
					origin: { kind: "extension" as const, extensionId: "ext", opId: op.id },
					order,
				})),
			}),
		);
		expect(result.messages.map(text)).toEqual(["history", "good"]);
		expect(snapshot.map(text)).toEqual(["history"]);
		expect(result.diagnostics).toMatchObject([
			{ code: "history-op-render-failed", origin: { extensionId: "ext", opId: "bad" } },
		]);
	});

	it("uses namespaced host data with provider versions and fetches it anew each request", async () => {
		let calls = 0;
		let versionSeen: string | number | undefined;
		let valueSeen: unknown;
		const historyOp: HistoryOp = {
			op: "insert",
			id: "host",
			depth: 0,
			hostData: [{ namespace: "org.example", key: "pool" }],
			async: true,
			render: (context) => {
				valueSeen = context.hostData["org.example"].pool.value;
				versionSeen = context.hostData["org.example"].pool.version;
				return [userMessage(String(valueSeen))];
			},
		};
		const runtimeOptions: Partial<PromptRuntime> = {
			historyOps: [{ op: historyOp, origin: { kind: "extension", extensionId: "ext", opId: "host" }, order: 0 }],
			historyHostData: [{ namespace: "org.example", get: () => ++calls, version: () => `rev-${calls}` }],
		};
		await compileMessages(preset([]), runtime([userMessage("h")], runtimeOptions));
		await compileMessages(preset([]), runtime([userMessage("h")], runtimeOptions));
		expect(valueSeen).toBe(2);
		expect(versionSeen).toBe("rev-2");
		expect(calls).toBe(2);
	});
	it("keeps the first provider when a hostData namespace is registered twice", async () => {
		let firstCalls = 0;
		let secondCalls = 0;
		const operation: HistoryOp = {
			op: "insert",
			id: "namespace",
			depth: 0,
			hostData: [{ namespace: "org.example", key: "pool" }],
			render: (context) => [insertMessage(String(context.hostData["org.example"].pool.value))],
		};
		const result = await compileMessages(
			preset([]),
			runtime([userMessage("history")], {
				historyOps: [
					{ op: operation, origin: { kind: "extension", extensionId: "ext", opId: "namespace" }, order: 0 },
				],
				historyHostData: [
					{
						namespace: "org.example",
						get: () => {
							firstCalls++;
							return "first";
						},
					},
					{
						namespace: "org.example",
						get: () => {
							secondCalls++;
							return "second";
						},
					},
				],
			}),
		);
		expect(result.messages.map(text)).toEqual(["history", "first"]);
		expect(firstCalls).toBe(1);
		expect(secondCalls).toBe(0);
		expect(result.diagnostics).toMatchObject([
			{ code: "history-host-data-namespace-duplicate", origin: { opId: "namespace" } },
		]);
	});

	it("isolates host-data provider failures to dependent inserts", async () => {
		let dependentRendered = false;
		const dependent: HistoryOp = {
			op: "insert",
			id: "dependent",
			depth: 0,
			async: true,
			hostData: [{ namespace: "missing", key: "value" }],
			render: () => {
				dependentRendered = true;
				return [insertMessage("unexpected")];
			},
		};
		const independent: HistoryOp = {
			op: "insert",
			id: "independent",
			depth: 0,
			render: () => [insertMessage("kept")],
		};
		const result = await compileMessages(
			preset([]),
			runtime([userMessage("history")], {
				historyOps: [dependent, independent].map((op, order) => ({
					op,
					origin: { kind: "extension" as const, extensionId: "ext", opId: op.id },
					order,
				})),
				historyHostData: [],
			}),
		);
		expect(dependentRendered).toBe(false);
		expect(result.messages.map(text)).toEqual(["history", "kept"]);
		expect(result.diagnostics).toMatchObject([{ code: "history-op-render-failed", origin: { opId: "dependent" } }]);
	});
	it("aborts the whole compilation rather than reporting an insert failure", async () => {
		const controller = new AbortController();
		const operation: HistoryOp = {
			op: "insert",
			id: "abort",
			depth: 0,
			async: true,
			render: () => {
				controller.abort(new Error("cancelled"));
				return [];
			},
		};
		await expect(
			compileMessages(
				preset([]),
				runtime([userMessage("h")], {
					historyOps: [
						{ op: operation, origin: { kind: "extension", extensionId: "ext", opId: "abort" }, order: 0 },
					],
					signal: controller.signal,
				}),
			),
		).rejects.toThrow("cancelled");
	});

	it("lets an enabled history item override legacy chat-history positioning and filtering", async () => {
		const combined: PromptPreset = {
			schemaVersion: 1,
			id: "migration",
			items: [
				{ kind: "slot", id: "legacy", slot: "chat-history", options: { maxMessages: 1 } },
				{ kind: "history", id: "new-history", ops: [{ op: "insert", id: "fixed", depth: 0, content: "marker" }] },
			],
		};
		const result = await compileMessages(combined, runtime([userMessage("first"), userMessage("second")]));
		expect(result.messages.map(text)).toEqual(["first\n\nsecond", "marker"]);
		expect(
			result.diagnostics.some(
				(diagnostic) =>
					diagnostic.level === "warning" && diagnostic.message.includes("Legacy chat-history position is ignored"),
			),
		).toBe(true);
	});

	it("uses an existing summary for summary reduction and does not synthesize one when absent", async () => {
		const summary = {
			role: "compactionSummary",
			content: [{ type: "text", text: "old summary" }],
			timestamp: 0,
		} as AgentMessage;
		const result = await compileMessages(
			preset([
				{ op: "keep", traces: 1 },
				{ op: "reduce", as: "summary" },
			]),
			runtime([userMessage("old"), summary, userMessage("new")]),
		);
		expect(result.messages.map(text)).toEqual(["old summary", "new"]);
		const withoutSummary = await compileMessages(
			preset([
				{ op: "keep", traces: 1 },
				{ op: "reduce", as: "summary" },
			]),
			runtime([userMessage("old"), userMessage("new")]),
		);
		expect(withoutSummary.messages.map(text)).toEqual(["new"]);
	});

	it("skips async operations from the synchronous compiler with an info diagnostic", () => {
		const asyncItem: PromptPreset = {
			schemaVersion: 1,
			id: "sync-preview",
			items: [
				{
					kind: "history",
					id: "history",
					ops: [
						{ op: "insert", id: "async", depth: 0, async: true, render: async () => [insertMessage("later")] },
					],
				},
			],
		};
		const result = compileMessagesSync(asyncItem, runtime([userMessage("history")]));
		expect(result.messages.map(text)).toEqual(["history"]);
		expect(result.diagnostics).toMatchObject([
			{ level: "info", message: expect.stringContaining("requires async compilation") },
		]);
	});
	it("keeps the built-in preset on an explicit zero-operation history item", () => {
		expect(defaultPreset.items.some((item) => item.kind === "history" && item.ops.length === 0)).toBe(true);
	});
});
