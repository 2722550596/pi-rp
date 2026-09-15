import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

function seedCompactableSession(harness: Harness): void {
	harness.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "one" }],
		timestamp: Date.now() - 2000,
	});
	harness.sessionManager.appendMessage(fauxAssistantMessage("first", { timestamp: Date.now() - 1500 }));
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "two" }],
		timestamp: Date.now() - 1000,
	});
	harness.sessionManager.appendMessage(fauxAssistantMessage("second", { timestamp: Date.now() - 500 }));
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

async function createAbortableCompactionHarness(): Promise<{
	harness: Harness;
	compactionStarted: Promise<void>;
}> {
	let markCompactionStarted = () => {};
	const compactionStarted = new Promise<void>((resolve) => {
		markCompactionStarted = resolve;
	});
	const harness = await createHarness({
		settings: { compaction: { keepRecentTokens: 1 } },
		extensionFactories: [
			(pi) => {
				pi.on("session_before_compact", async (event) => {
					return await new Promise<{ cancel: true }>((resolve) => {
						event.signal.addEventListener("abort", () => resolve({ cancel: true }), { once: true });
						markCompactionStarted();
					});
				});
			},
		],
	});
	seedCompactableSession(harness);
	return { harness, compactionStarted };
}

describe("#8920 abort cancels in-progress manual compaction", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("aborts an in-progress manual compaction and waits until the session is idle", async () => {
		const { harness, compactionStarted } = await createAbortableCompactionHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("continued")]);

		const compactPromise = harness.session.compact();
		const compactExpectation = expect(compactPromise).rejects.toThrow("Compaction cancelled");
		await compactionStarted;
		await harness.session.abort();
		await compactExpectation;

		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "manual",
			aborted: true,
		});
		expect(harness.session.isCompacting).toBe(false);
		expect(harness.session.isIdle).toBe(true);

		await expect(harness.session.prompt("next prompt")).resolves.toBeUndefined();
		expect(harness.session.getLastAssistantText()).toBe("continued");
	});
});
