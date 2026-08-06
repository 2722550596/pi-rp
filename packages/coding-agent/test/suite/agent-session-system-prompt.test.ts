import test, { describe } from "node:test";
import { strict as assert } from "node:assert";
import { createAgentHarness, fauxAssistantMessage, fauxToolCall } from "./harness.ts";

describe("AgentSession - system prompt", () => {
	test("Phase 0: context.systemPrompt remains empty across multiple turns when using presets", async () => {
		const providerSystemPrompts: string[] = [];

		const harness = await createAgentHarness({
			cwd: process.cwd(),
			providerSteps: [
				(context) => {
					providerSystemPrompts.push(context.systemPrompt ?? "");
					return fauxAssistantMessage(fauxToolCall("read", { path: "package.json" }), { stopReason: "toolUse" });
				},
				(context) => {
					providerSystemPrompts.push(context.systemPrompt ?? "");
					return fauxAssistantMessage("done");
				},
			],
		});

		try {
			await harness.session.prompt("test");
			await harness.session.waitForIdle();

			assert.equal(
				providerSystemPrompts.length,
				2,
				"Should have captured system prompts for both turns",
			);
			assert.equal(
				providerSystemPrompts[0],
				"",
				"First turn system prompt should be empty (compiled into messages)",
			);
			assert.equal(
				providerSystemPrompts[1],
				"",
				"Second turn system prompt should be empty (not double-injected)",
			);
		} finally {
			harness.cleanup();
		}
	});
});