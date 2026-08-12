import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import type { JsonValue } from "../../src/state/state-manager.ts";

describe("CLI --preset and --schema flags", () => {
	let tempDir: string;
	const originalAgentDir = process.env[ENV_AGENT_DIR];

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-cli-preset-schema-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(join(tempDir, ".pi", "prompt-presets"), { recursive: true });
		mkdirSync(join(tempDir, ".pi", "schemas"), { recursive: true });
		writeFileSync(
			join(tempDir, ".pi", "prompt-presets", "plan.json"),
			JSON.stringify({ schemaVersion: 1, id: "plan", items: [] }),
		);
		writeFileSync(
			join(tempDir, ".pi", "prompt-presets", "fast.json"),
			JSON.stringify({ schemaVersion: 1, id: "fast", items: [] }),
		);
		writeFileSync(
			join(tempDir, ".pi", "schemas", "character.ts"),
			'import { Type } from "typebox";\nexport default Type.Object({ name: Type.String({ default: "无名" }) });',
		);
		// Point the agent dir at a temp dir so the user's real global presets and
		// schemas cannot collide with the test fixture ids; getAgentDir() reads the
		// env at call time and is NOT reached by the agentDir passed to createAgentSession.
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

	it("activates the preset and records a preset_change without persisting settings", async () => {
		const options = baseOptions();
		const { session } = await createAgentSession({ ...options, preset: "plan" });

		expect(session.activePreset.id).toBe("plan");

		const presetEntries = options.sessionManager.getBranch().filter((e) => e.type === "preset_change");
		expect(presetEntries).toHaveLength(1);
		expect(presetEntries[0].presetId).toBe("plan");

		expect(options.settingsManager.getDefaultPreset()).toBeUndefined();

		session.dispose();
	});

	it("CLI preset wins over the settings default preset", async () => {
		const options = baseOptions();
		const settingsManager = SettingsManager.inMemory({ defaultPreset: "fast" });
		const { session } = await createAgentSession({ ...options, settingsManager, preset: "plan" });

		expect(session.activePreset.id).toBe("plan");

		session.dispose();
	});

	it("warns when the preset is not found but still creates the session", async () => {
		const options = baseOptions();
		const { session, sessionDiagnostics } = await createAgentSession({ ...options, preset: "bogus" });

		expect(session).toBeTruthy();
		expect(sessionDiagnostics?.some((d) => /Prompt preset "bogus" not found/.test(d.message))).toBe(true);

		session.dispose();
	});

	it("loads schemas at startup and seeds default state", async () => {
		const options = baseOptions();
		const { session } = await createAgentSession({ ...options, schemas: ["character"] });

		expect(session.schemaValidator.getActiveNamespaces()).toContain("character");
		expect(session.stateManager.get("character.name")).toBe("无名");

		const schemaEntries = options.sessionManager.getBranch().filter((e) => e.type === "schema_change");
		expect(schemaEntries).toHaveLength(1);
		expect(schemaEntries[0].schemaId).toBe("character");

		session.dispose();
	});

	it("warns when a schema is not found", async () => {
		const options = baseOptions();
		const { session, sessionDiagnostics } = await createAgentSession({ ...options, schemas: ["nope"] });

		expect(sessionDiagnostics?.some((d) => /Schema "nope" not found/.test(d.message))).toBe(true);

		session.dispose();
	});

	it("enables strict mode at startup when strict is set", async () => {
		const options = baseOptions();
		const { session } = await createAgentSession({ ...options, schemas: ["character"], strict: true });

		expect(session.schemaValidator.isStrict()).toBe(true);

		const state = session.stateManager.snapshot() as unknown as Record<string, JsonValue>;
		const rejected = session.schemaValidator.validate("notes.todo", "replace", "x", state);
		expect(rejected.ok).toBe(false);
		if (!rejected.ok) expect(rejected.reason).toContain("Strict mode");
		expect(session.schemaValidator.validate("character.name", "replace", "A", state).ok).toBe(true);

		session.dispose();
	});

	it("leaves strict mode off by default", async () => {
		const options = baseOptions();
		const { session } = await createAgentSession({ ...options, schemas: ["character"] });

		expect(session.schemaValidator.isStrict()).toBe(false);

		const state = session.stateManager.snapshot() as unknown as Record<string, JsonValue>;
		expect(session.schemaValidator.validate("notes.todo", "replace", "x", state).ok).toBe(true);

		session.dispose();
	});

	it("does not re-append preset/schema/strict entries when resuming with identical flags", async () => {
		const options = baseOptions();
		const first = await createAgentSession({ ...options, preset: "plan", schemas: ["character"], strict: true });
		// 模拟续档：会话里已有消息（hasExistingSession = true）
		options.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "hi" }],
			timestamp: Date.now(),
		});
		first.session.dispose();

		const { session } = await createAgentSession({
			...options,
			preset: "plan",
			schemas: ["character"],
			strict: true,
		});

		const branch = options.sessionManager.getBranch();
		expect(branch.filter((e) => e.type === "preset_change")).toHaveLength(1);
		expect(branch.filter((e) => e.type === "schema_change")).toHaveLength(1);
		expect(branch.filter((e) => e.type === "strict_change")).toHaveLength(1);
		// 去重只跳过追加，内存态仍全部生效
		expect(session.activePreset.id).toBe("plan");
		expect(session.schemaValidator.getActiveNamespaces()).toContain("character");
		expect(session.schemaValidator.isStrict()).toBe(true);

		session.dispose();
	});

	it("still records preset change when resumed preset differs from the session", async () => {
		const options = baseOptions();
		const first = await createAgentSession({ ...options, preset: "plan", schemas: ["character"], strict: true });
		options.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "hi" }],
			timestamp: Date.now(),
		});
		first.session.dispose();

		// 换预设 → 追加新的 preset_change；schema/strict 未变仍去重
		const { session } = await createAgentSession({
			...options,
			preset: "fast",
			schemas: ["character"],
			strict: true,
		});

		const branch = options.sessionManager.getBranch();
		const presetEntries = branch.filter((e) => e.type === "preset_change");
		expect(presetEntries).toHaveLength(2);
		expect(presetEntries.at(-1)?.presetId).toBe("fast");
		expect(branch.filter((e) => e.type === "schema_change")).toHaveLength(1);
		expect(branch.filter((e) => e.type === "strict_change")).toHaveLength(1);
		expect(session.activePreset.id).toBe("fast");

		session.dispose();
	});
});
