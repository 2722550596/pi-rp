import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

function createNoopTool(): AgentTool {
	return {
		name: "noop",
		label: "No-op",
		description: "Return immediately",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
	};
}

describe("issue #7253: manual compaction during an active response", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("persists the aborted response before running the requested manual compaction", async () => {
		let markSecondResponseStarted = () => {};
		const secondResponseStarted = new Promise<void>((resolve) => {
			markSecondResponseStarted = resolve;
		});
		let releaseSecondResponse = () => {};
		const secondResponseReleased = new Promise<void>((resolve) => {
			releaseSecondResponse = resolve;
		});

		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1000, maxTokens: 1000 }],
			settings: { compaction: { enabled: true, reserveTokens: 200, keepRecentTokens: 2 } },
			tools: [createNoopTool()],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: `${event.reason} summary`,
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("noop", {}), { stopReason: "toolUse" }),
			async () => {
				markSecondResponseStarted();
				await secondResponseReleased;
				return fauxAssistantMessage(`second response:${"x".repeat(4000)}`);
			},
		]);

		const promptPromise = harness.session.prompt("Run the tool, then continue responding.");
		await secondResponseStarted;

		const compactPromise = harness.session.compact();
		const compactExpectation = expect(compactPromise).resolves.toMatchObject({ summary: "manual summary" });
		releaseSecondResponse();
		await Promise.all([promptPromise, compactExpectation]);

		// Assert the contract, not the exact event list: whether an automatic threshold
		// compaction also fires before this one depends on the active tool set (tool
		// schemas count toward the context estimate). Adding tools must not fail this test.
		const compactionStarts = harness.eventsOfType("compaction_start").map((event) => event.reason);
		expect(compactionStarts.filter((reason) => reason === "manual")).toHaveLength(1);
		expect(harness.eventsOfType("compaction_end").map((event) => event.reason)).toEqual(
			harness.eventsOfType("compaction_start").map((event) => event.reason),
		);

		const entries = harness.sessionManager.getEntries();
		const abortedResponseIndex = entries.findIndex(
			(entry) =>
				entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "aborted",
		);
		const manualCompactionIndex = entries.findIndex(
			(entry) => entry.type === "compaction" && entry.summary === "manual summary",
		);
		expect(abortedResponseIndex).toBeGreaterThan(-1);
		// The aborted response must be persisted before the manual compaction rewrites history.
		expect(manualCompactionIndex).toBeGreaterThan(abortedResponseIndex);
		expect(entries.filter((entry) => entry.type === "compaction" && entry.summary === "manual summary")).toHaveLength(
			1,
		);
	});
});
