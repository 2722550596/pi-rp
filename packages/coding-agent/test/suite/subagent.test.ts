import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
	createSubagentProfilesToolDefinition,
	createSubagentToolDefinition,
} from "../../src/core/subagent/extension.ts";
import { isPrepareError, prepareSubagentConversation } from "../../src/core/subagent/prepare.ts";
import { runSubagent } from "../../src/core/subagent/run.ts";
import { createHarness } from "./harness.ts";

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
});
