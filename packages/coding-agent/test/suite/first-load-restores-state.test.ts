/**
 * Regression: first-load state restore must run even when prompt presets exist
 * on disk (P0-1). The preset-restore and state-restore sentinels were split:
 * loading presets before the state block made the old `_loadedPresets` guard
 * permanently false, so resume never replayed the session state snapshot.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";

describe("first load restores session state with presets on disk", () => {
	let tempDir: string;
	const originalAgentDir = process.env[ENV_AGENT_DIR];

	beforeEach(() => {
		tempDir = join(tmpdir(), `first-load-state-${process.pid}-${Math.random().toString(36).slice(2)}`);
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

	it("replays the latest state entry despite a preset file on disk", async () => {
		writeFileSync(
			join(tempDir, ".pi", "prompt-presets", "writer.json"),
			JSON.stringify({ schemaVersion: 1, id: "writer", items: [] }),
		);

		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();
		const sessionManager = SessionManager.inMemory(tempDir);
		sessionManager.appendMessage({ role: "user", content: "hi" } as never);
		sessionManager.appendState({ ns: { v: 42 } });
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			model: model!,
			sessionManager,
			settingsManager: SettingsManager.inMemory(),
		});
		expect(session.stateManager.get("ns")).toEqual({ v: 42 });
		session.dispose();
	});
});
