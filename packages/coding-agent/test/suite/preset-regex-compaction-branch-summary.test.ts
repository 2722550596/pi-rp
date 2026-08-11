/**
 * Regression tests for preset regex coverage of compaction and branch summaries.
 *
 * Audit findings (plan/compaction-summary-specifics.md):
 * - BUG 1: pi-generated compaction summaries (raw LLM output) never ran the
 *   preset's `finalize` regex rules before being persisted.
 * - BUG 2: branch summaries never ran the preset's `outgoing` rules on the
 *   summarized messages nor `finalize` rules on the raw LLM summary.
 *
 * Extension-provided summaries are treated as already-final content and must
 * NOT be rewritten by `finalize` rules.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import { assistantMsg, userMsg } from "../utilities.ts";
import { createHarness, type Harness } from "./harness.ts";

const FINALIZE_PRESET = {
	schemaVersion: 1,
	id: "finalize-summaries",
	items: [],
	regex: {
		schemaVersion: 1,
		rules: [
			{
				id: "redact-sensitive",
				stage: "compiled",
				effect: "finalize",
				pattern: "\\[REDACT\\][\\s\\S]*?\\[/REDACT\\]",
				replace: "[redacted]",
				flags: "g",
			},
			{
				id: "hide-secret",
				stage: "history",
				effect: "outgoing",
				pattern: "SUPER_SECRET_VALUE",
				replace: "[hidden]",
				flags: "g",
			},
		],
	},
};

function createUsage(totalTokens: number) {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function seedCompactableSession(harness: Harness): void {
	harness.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
	const now = Date.now();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "message to compact" }],
		timestamp: now - 1000,
	});
	harness.sessionManager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "assistant response to compact" }],
		usage: createUsage(100),
		api: harness.getModel().api,
		provider: harness.getModel().provider,
		model: harness.getModel().id,
		stopReason: "stop",
		timestamp: now - 500,
	});
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

function useSummaryStreamFn(harness: Harness, summary: string): void {
	harness.session.agent.streamFunction = (model) => {
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			stream.push({
				type: "done",
				reason: "stop",
				message: {
					role: "assistant",
					content: [{ type: "text", text: summary }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: createUsage(10),
					stopReason: "stop",
					timestamp: Date.now(),
				},
			});
		});
		return stream;
	};
}

async function activateFinalizePreset(harness: Harness): Promise<void> {
	const presetDir = join(harness.tempDir, ".pi", "prompt-presets");
	mkdirSync(presetDir, { recursive: true });
	writeFileSync(join(presetDir, "finalize-summaries.json"), JSON.stringify(FINALIZE_PRESET));
	process.env[ENV_AGENT_DIR] = join(harness.tempDir, "agent");
	harness.session.reloadPresets();
	const result = await harness.session.setActivePreset("finalize-summaries");
	expect(result.ok).toBe(true);
}

describe("preset regex on compaction and branch summaries", () => {
	const harnesses: Harness[] = [];
	const originalAgentDir = process.env[ENV_AGENT_DIR];

	afterEach(() => {
		if (originalAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = originalAgentDir;
		}
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("applies preset finalize regex to pi-generated manual compaction summaries (BUG 1)", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		await activateFinalizePreset(harness);
		seedCompactableSession(harness);
		useSummaryStreamFn(harness, "summary with [REDACT]sensitive[/REDACT] content");

		const result = await harness.session.compact();

		expect(result.summary).toContain("[redacted]");
		expect(result.summary).not.toContain("sensitive");
		const compactionEntry = harness.sessionManager
			.getEntries()
			.filter((e) => e.type === "compaction")
			.at(-1);
		expect(compactionEntry?.type === "compaction" ? compactionEntry.summary : undefined).toContain("[redacted]");
	});

	it("applies preset finalize regex to pi-generated auto compaction summaries (BUG 1)", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		await activateFinalizePreset(harness);
		seedCompactableSession(harness);
		useSummaryStreamFn(harness, "auto summary with [REDACT]sensitive[/REDACT] content");

		const sessionInternals = harness.session as unknown as {
			_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<boolean>;
		};
		await sessionInternals._runAutoCompaction("threshold", false);

		const compactionEntry = harness.sessionManager
			.getEntries()
			.filter((e) => e.type === "compaction")
			.at(-1);
		expect(compactionEntry?.type === "compaction" ? compactionEntry.summary : undefined).toContain("[redacted]");
	});

	it("does not rewrite extension-provided compaction summaries with finalize rules", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "extension [REDACT]sensitive[/REDACT] content",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		await activateFinalizePreset(harness);
		seedCompactableSession(harness);

		const result = await harness.session.compact();

		expect(result.summary).toBe("extension [REDACT]sensitive[/REDACT] content");
	});

	it("applies preset outgoing and finalize regex to branch summaries (BUG 2)", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		await activateFinalizePreset(harness);

		let seenPrompt = "";
		harness.session.agent.streamFunction = (model, context) => {
			const first = context.messages[0];
			const content = Array.isArray(first?.content) ? first.content : [];
			seenPrompt += content
				.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join("");

			const stream = createAssistantMessageEventStream();
			stream.push({
				type: "done",
				reason: "stop",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "branch [REDACT]sensitive[/REDACT] summary" }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: createUsage(2),
					stopReason: "stop",
					timestamp: Date.now(),
				},
			});
			return stream;
		};

		const targetId = harness.sessionManager.appendMessage(userMsg("first branch"));
		harness.sessionManager.appendMessage(assistantMsg("first reply"));
		harness.sessionManager.appendMessage(userMsg("SUPER_SECRET_VALUE abandoned branch work"));
		harness.sessionManager.appendMessage(assistantMsg("abandoned reply"));

		const result = await harness.session.navigateTree(targetId, { summarize: true });

		expect(result.cancelled).toBe(false);
		// Outgoing rule filtered the summarized messages before they reached the LLM
		expect(seenPrompt).toContain("[hidden]");
		expect(seenPrompt).not.toContain("SUPER_SECRET_VALUE");
		// Finalize rule rewrote the raw LLM summary before it was persisted
		expect(result.summaryEntry?.summary).toContain("[redacted]");
		expect(result.summaryEntry?.summary).not.toContain("sensitive");
	});
});
