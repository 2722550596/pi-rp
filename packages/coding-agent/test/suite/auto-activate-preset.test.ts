import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";

describe("auto-activate preset selection", () => {
	let tempDir: string;
	const originalAgentDir = process.env[ENV_AGENT_DIR];

	beforeEach(() => {
		tempDir = join(tmpdir(), `auto-activate-${process.pid}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(join(tempDir, ".pi", "prompt-presets"), { recursive: true });
		process.env[ENV_AGENT_DIR] = join(tempDir, "agent");
	});

	afterEach(() => {
		if (originalAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = originalAgentDir;
		}
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	});

	function baseOptions() {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();
		return {
			cwd: tempDir,
			agentDir: tempDir,
			model: model!,
			sessionManager: SessionManager.inMemory(tempDir),
			settingsManager: SettingsManager.inMemory(),
		};
	}

	it("activates the first auto-activatable preset when no preset flag or settings default exists", async () => {
		writeFileSync(
			join(tempDir, ".pi", "prompt-presets", "hero.json"),
			JSON.stringify({ schemaVersion: 1, id: "hero", autoActivate: false, items: [] }),
		);
		writeFileSync(
			join(tempDir, ".pi", "prompt-presets", "writer.json"),
			JSON.stringify({ schemaVersion: 1, id: "writer", items: [] }),
		);

		const { session } = await createAgentSession(baseOptions());
		expect(session.activePreset.id).toBe("writer");
		session.dispose();
	});

	it("prefers an explicit autoActivate: true preset over earlier non-opted-out ones", async () => {
		writeFileSync(
			join(tempDir, ".pi", "prompt-presets", "hero.json"),
			JSON.stringify({ schemaVersion: 1, id: "hero", items: [] }),
		);
		writeFileSync(
			join(tempDir, ".pi", "prompt-presets", "writer.json"),
			JSON.stringify({ schemaVersion: 1, id: "writer", autoActivate: true, items: [] }),
		);

		const { session } = await createAgentSession(baseOptions());
		expect(session.activePreset.id).toBe("writer");
		session.dispose();
	});

	it("stays on the built-in default when every preset opts out of auto-activation", async () => {
		writeFileSync(
			join(tempDir, ".pi", "prompt-presets", "hero.json"),
			JSON.stringify({ schemaVersion: 1, id: "hero", autoActivate: false, items: [] }),
		);
		writeFileSync(
			join(tempDir, ".pi", "prompt-presets", "writer.json"),
			JSON.stringify({ schemaVersion: 1, id: "writer", autoActivate: false, items: [] }),
		);

		const { session } = await createAgentSession(baseOptions());
		expect(session.activePreset.id).toBe("pi-default");
		session.dispose();
	});

	it("prefers the settings default preset over auto-activation", async () => {
		writeFileSync(
			join(tempDir, ".pi", "prompt-presets", "hero.json"),
			JSON.stringify({ schemaVersion: 1, id: "hero", autoActivate: false, items: [] }),
		);
		writeFileSync(
			join(tempDir, ".pi", "prompt-presets", "writer.json"),
			JSON.stringify({ schemaVersion: 1, id: "writer", items: [] }),
		);

		const options = baseOptions();
		options.settingsManager = SettingsManager.inMemory({ defaultPreset: "hero" });
		const { session } = await createAgentSession(options);
		expect(session.activePreset.id).toBe("hero");
		session.dispose();
	});

	it("restores a recorded preset_change entry over auto-activation on resume", async () => {
		writeFileSync(
			join(tempDir, ".pi", "prompt-presets", "hero.json"),
			JSON.stringify({ schemaVersion: 1, id: "hero", autoActivate: false, items: [] }),
		);
		writeFileSync(
			join(tempDir, ".pi", "prompt-presets", "writer.json"),
			JSON.stringify({ schemaVersion: 1, id: "writer", items: [] }),
		);

		// A resumed session has messages plus a recorded preset_change entry;
		// the recorded preset must win over auto-activation.
		const options = baseOptions();
		options.sessionManager.appendPresetChange("hero");
		options.sessionManager.appendMessage({ role: "user", content: "hi" } as never);
		const { session } = await createAgentSession(options);
		expect(session.activePreset.id).toBe("hero");
		session.dispose();
	});

	describe("setActivePreset persistence", () => {
		it("persists an activated preset to settings so a /preset none can be switched back from", async () => {
			writeFileSync(
				join(tempDir, ".pi", "prompt-presets", "hero.json"),
				JSON.stringify({ schemaVersion: 1, id: "hero", autoActivate: false, items: [] }),
			);

			const settingsManager = SettingsManager.inMemory();
			const { session } = await createAgentSession({ ...baseOptions(), settingsManager });
			expect(session.activePreset.id).toBe("pi-default");

			// Disabling a preset persists "none" as the settings default.
			await session.setActivePreset("none");
			expect(settingsManager.getDefaultPreset()).toBe("none");

			// Activating a real preset must also update the settings default,
			// otherwise a restart would restore the disabled state forever.
			const result = await session.setActivePreset("hero");
			expect(result.ok).toBe(true);
			expect(session.activePreset.id).toBe("hero");
			expect(settingsManager.getDefaultPreset()).toBe("hero");
			session.dispose();

			// Simulate a restart: a fresh session on the same settings restores "hero".
			const { session: restarted } = await createAgentSession({ ...baseOptions(), settingsManager });
			expect(restarted.activePreset.id).toBe("hero");
			restarted.dispose();
		});
	});
});
