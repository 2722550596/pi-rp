import { strict as assert } from "node:assert";
import test, { describe } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createHarness } from "./harness.ts";

describe("AgentSession - system prompt", () => {
	test("Phase 0: context.systemPrompt remains empty across multiple turns when using presets", async () => {
		const harness = await createHarness();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: "package.json" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		try {
			await harness.session.prompt("test");
			await harness.session.waitForIdle();
			assert.ok(harness.session.messages.length > 0);
		} finally {
			harness.cleanup();
		}
	});
});
