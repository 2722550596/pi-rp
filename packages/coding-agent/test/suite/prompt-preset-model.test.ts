import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("Prompt preset model switching", () => {
	let harness: Harness;
	const originalAgentDir = process.env[ENV_AGENT_DIR];

	afterEach(() => {
		if (originalAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = originalAgentDir;
		}
		harness?.cleanup();
	});

	it("switches model when a preset is activated and surfaces errors if missing", async () => {
		harness = await createHarness({
			withConfiguredAuth: true,
			models: [
				{ id: "faux-1", reasoning: false },
				{ id: "faux-2", reasoning: false },
			],
		});
		const presetDir = join(harness.tempDir, ".pi", "prompt-presets");
		mkdirSync(presetDir, { recursive: true });

		// Valid model switch
		writeFileSync(
			join(presetDir, "valid.json"),
			JSON.stringify({
				schemaVersion: 1,
				id: "valid",
				model: "faux/faux-2",
				items: [],
			}),
		);

		// Unresolvable model
		writeFileSync(
			join(presetDir, "invalid.json"),
			JSON.stringify({
				schemaVersion: 1,
				id: "invalid",
				model: "faux/nonexistent",
				items: [],
			}),
		);

		// Point the agent dir at a temp dir so the user's real global presets
		// cannot collide with the test preset ids; getAgentDir() reads the env at call time.
		process.env[ENV_AGENT_DIR] = join(harness.tempDir, "agent");
		harness.session.reloadPresets();

		// Act & Assert invalid
		const errResult = await harness.session.setActivePreset("invalid");
		expect(errResult.ok).toBe(true);
		expect(errResult.error).toContain("not found");
		expect(harness.session.model?.id).toBe("faux-1"); // unchanged

		// Act & Assert valid
		const okResult = await harness.session.setActivePreset("valid");
		expect(okResult.ok).toBe(true);
		expect(okResult.model?.id).toBe("faux-2");
		expect(harness.session.model?.id).toBe("faux-2");
	});
});
