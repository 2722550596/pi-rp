import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, it } from "vitest";
import {
	createSubagentProfilesToolDefinition,
	createSubagentToolDefinition,
} from "../../src/core/subagent/extension.ts";
import { isPrepareError, prepareSubagentConversation } from "../../src/core/subagent/prepare.ts";
import { runSubagent } from "../../src/core/subagent/run.ts";
import { createHarness, getMessageText } from "./harness.ts";

describe("Subagent", () => {
	it("Phase 1: prepareSubagentConversation handles unknown presets", async () => {
		const harness = await createHarness();
		try {
			const result = await prepareSubagentConversation({
				cwd: process.cwd(),
				profileId: "unknown-preset-that-does-not-exist",
				task: "Do something",
				modelRuntime: harness.session.modelRuntime,
			});

			assert.equal(isPrepareError(result), true);
			if (isPrepareError(result)) {
				assert.equal(result.ok, false);
				assert.ok(result.error.includes("not found"));
			}
		} finally {
			harness.cleanup();
		}
	});

	it("Phase 2: runSubagent correctly streams and truncates output", async () => {
		const harness = await createHarness();
		harness.faux.setResponses([fauxAssistantMessage("Task completed successfully. ".repeat(100))]);

		try {
			// Instead of a full preset which requires disk setup, we pass mock preparation
			const result = await runSubagent(
				{
					messages: [{ role: "user", content: [{ type: "text", text: "task" }], timestamp: 0 }],
					model: harness.session.model!,
					thinkingLevel: "medium",
					effectiveTools: [],
					profile: { schemaVersion: 1, id: "test", items: [] },
				},
				harness.session.modelRuntime,
			);

			assert.equal(result.status, "completed");
			assert.ok(result.text.includes("Task completed successfully"));
			assert.equal(result.rawText, "Task completed successfully. ".repeat(100));
		} finally {
			harness.cleanup();
		}
	});

	it("Phase 3: Tools and commands are correctly formatted", async () => {
		const harness = await createHarness();
		try {
			const profilesTool = createSubagentProfilesToolDefinition(harness.session);
			const subagentTool = createSubagentToolDefinition(harness.session);

			assert.equal(profilesTool.name, "subagent_profiles");
			assert.equal(subagentTool.name, "subagent");

			// They should execute (even if they return empty/error states without setup)
			const profilesResult = await profilesTool.execute("1", {}, undefined, undefined, {} as any);
			assert.ok(Array.isArray(profilesResult.content));
			assert.ok(typeof profilesResult.content[0] === "object" && "text" in profilesResult.content[0]);

			const subagentResult = await subagentTool.execute(
				"2",
				{ profileId: "unknown", task: "task" },
				undefined,
				undefined,
				{} as any,
			);
			assert.ok(typeof subagentResult.content[0] === "object" && "text" in subagentResult.content[0]);
		} finally {
			harness.cleanup();
		}
	});

	it("Phase 4: peer completion inherits parent state and history", async () => {
		const harness = await createHarness();
		try {
			// Write a delegatable preset with state + chat-history slots
			const presetDir = join(harness.tempDir, ".pi", "prompt-presets");
			mkdirSync(presetDir, { recursive: true });
			writeFileSync(
				join(presetDir, "test-peer.json"),
				JSON.stringify({
					schemaVersion: 1,
					id: "test-peer",
					name: "Test Peer",
					delegatable: true,
					items: [
						{ kind: "block", id: "role", enabled: true, role: "system", content: "You are a test peer." },
						{
							kind: "slot",
							id: "state",
							enabled: true,
							role: "system",
							slot: "state",
							options: { allowNamespace: ["world", "secret"], format: "yaml" },
						},
						{
							kind: "slot",
							id: "history",
							enabled: true,
							role: "user",
							slot: "chat-history",
							options: { maxMessages: 10 },
						},
					],
				}),
			);
			harness.session.reloadPresets();

			// Seed parent state and conversation history
			harness.session.stateManager.load({ world: { name: "TestWorld" }, secret: { plot: "hidden" } });
			harness.session.agent.state.messages.push(
				{ role: "user", content: [{ type: "text", text: "Hello world" }], timestamp: Date.now() },
				fauxAssistantMessage("Hi there"),
			);

			const result = prepareSubagentConversation({
				cwd: harness.tempDir,
				profileId: "test-peer",
				task: "What is the world name?",
				modelRuntime: harness.session.modelRuntime,
				session: harness.session,
				inheritHistory: 10,
			});

			assert.equal(isPrepareError(result), false);
			if (!isPrepareError(result)) {
				const allText = result.messages.map((m) => getMessageText(m)).join("\n");
				assert.ok(allText.includes("Hello world"), "compiled messages should contain parent history");
				assert.ok(allText.includes("TestWorld"), "compiled messages should contain parent state (world)");
				assert.ok(allText.includes("hidden"), "compiled messages should contain parent state (secret)");
			}
		} finally {
			harness.cleanup();
		}
	});
});
