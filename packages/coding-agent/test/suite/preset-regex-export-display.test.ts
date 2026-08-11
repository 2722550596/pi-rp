/**
 * Regression test: HTML export (TUI /export command and CLI --export) must apply
 * the active preset's `display` regex rules to message text before embedding,
 * matching TUI rendering (`_filterMessageForDisplay` in interactive-mode).
 *
 * The TUI filters message text for display on screen; the export pipeline embeds
 * the raw session entries as JSON in the HTML, so display rules were being skipped.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { registerFauxProvider, streamSimple } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import { AgentSession } from "../../src/core/agent-session.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { exportFromFile } from "../../src/core/export-html/index.ts";
import { convertToLlm } from "../../src/core/messages.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "../model-runtime-test-utils.ts";
import { assistantMsg, createTestResourceLoader, userMsg } from "../utilities.ts";

const DISPLAY_PRESET = {
	schemaVersion: 1,
	id: "display-redact",
	items: [],
	regex: {
		schemaVersion: 1,
		rules: [
			{
				id: "hide-secret",
				stage: "history",
				effect: "display",
				pattern: "SUPER_SECRET_VALUE",
				replace: "[hidden]",
				flags: "g",
			},
			{
				id: "redact-tag",
				stage: "compiled",
				effect: "display",
				pattern: "\\[REDACT\\][\\s\\S]*?\\[/REDACT\\]",
				replace: "[redacted]",
				flags: "g",
			},
		],
	},
};

interface TestHarness {
	session: AgentSession;
	sessionManager: SessionManager;
	tempDir: string;
	cleanup: () => void;
}

async function createExportHarness(): Promise<TestHarness> {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-export-display-"));
	const faux = registerFauxProvider();
	faux.setResponses([]);
	const model = faux.getModel();

	const authStorage = AuthStorage.inMemory();
	await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRegistry = await createInMemoryModelRegistry(authStorage);
	modelRegistry.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		apiKey: "faux-key",
		api: faux.api,
		models: faux.models.map((registeredModel) => ({
			id: registeredModel.id,
			name: registeredModel.name,
			api: registeredModel.api,
			reasoning: registeredModel.reasoning,
			input: registeredModel.input,
			cost: registeredModel.cost,
			contextWindow: registeredModel.contextWindow,
			maxTokens: registeredModel.maxTokens,
			baseUrl: registeredModel.baseUrl,
		})),
	});

	const settingsManager = SettingsManager.inMemory();
	const sessionManager = SessionManager.create(tempDir, join(tempDir, "sessions"));
	const agent = new Agent({
		getApiKey: () => "faux-key",
		initialState: {
			model,
			systemPrompt: "You are a test assistant.",
			tools: [],
		},
		convertToLlm,
		streamFn: streamSimple,
	});
	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: tempDir,
		modelRuntime: getModelRuntime(modelRegistry),
		resourceLoader: createTestResourceLoader(),
	});

	return {
		session,
		sessionManager,
		tempDir,
		cleanup: () => {
			session.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		},
	};
}

function writeDisplayPreset(tempDir: string): void {
	const presetDir = join(tempDir, ".pi", "prompt-presets");
	mkdirSync(presetDir, { recursive: true });
	writeFileSync(join(presetDir, "display-redact.json"), JSON.stringify(DISPLAY_PRESET));
}

function decodeSessionData(html: string): Array<{ type: string; message?: { role?: string; content?: unknown } }> {
	const match = html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/);
	expect(match).not.toBeNull();
	const data = JSON.parse(Buffer.from(match![1], "base64").toString("utf8")) as {
		entries: Array<{ type: string; message?: { role?: string; content?: unknown } }>;
	};
	return data.entries;
}

function allMessageTexts(entries: Array<{ type: string; message?: { role?: string; content?: unknown } }>): string {
	const parts: string[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || !entry.message) continue;
		const content = entry.message.content;
		if (typeof content === "string") {
			parts.push(content);
		} else if (Array.isArray(content)) {
			for (const block of content) {
				if (
					block &&
					typeof block === "object" &&
					"type" in block &&
					block.type === "text" &&
					typeof block.text === "string"
				) {
					parts.push(block.text);
				}
			}
		}
	}
	return parts.join("\n");
}

describe("preset display regex on HTML export", () => {
	const cleanups: Array<() => void> = [];
	const originalAgentDir = process.env[ENV_AGENT_DIR];

	afterEach(() => {
		while (cleanups.length > 0) {
			cleanups.pop()?.();
		}
		if (originalAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = originalAgentDir;
		}
	});

	it("applies the active preset's display regex to /export HTML output", async () => {
		const harness = await createExportHarness();
		cleanups.push(harness.cleanup);
		writeDisplayPreset(harness.tempDir);
		process.env[ENV_AGENT_DIR] = join(harness.tempDir, "agent");
		harness.session.reloadPresets();
		const activated = await harness.session.setActivePreset("display-redact");
		expect(activated.ok).toBe(true);

		// Seed the session with stored text containing both redaction targets.
		harness.sessionManager.appendMessage(userMsg("question with SUPER_SECRET_VALUE"));
		harness.sessionManager.appendMessage(
			assistantMsg("answer with SUPER_SECRET_VALUE and [REDACT]sensitive[/REDACT]"),
		);

		const outputPath = join(harness.tempDir, "export.html");
		await harness.session.exportToHtml(outputPath);
		const texts = allMessageTexts(decodeSessionData(readFileSync(outputPath, "utf8")));

		expect(texts).toContain("[hidden]");
		expect(texts).not.toContain("SUPER_SECRET_VALUE");
		expect(texts).toContain("[redacted]");
		expect(texts).not.toContain("sensitive");
	});

	it("does not rewrite export text when no display rules are active", async () => {
		const harness = await createExportHarness();
		cleanups.push(harness.cleanup);

		harness.sessionManager.appendMessage(userMsg("question with SUPER_SECRET_VALUE"));
		harness.sessionManager.appendMessage(
			assistantMsg("answer with SUPER_SECRET_VALUE and [REDACT]sensitive[/REDACT]"),
		);

		const outputPath = join(harness.tempDir, "export.html");
		await harness.session.exportToHtml(outputPath);
		const texts = allMessageTexts(decodeSessionData(readFileSync(outputPath, "utf8")));

		expect(texts).toContain("SUPER_SECRET_VALUE");
		expect(texts).toContain("[REDACT]sensitive[/REDACT]");
	});

	it("CLI exportFromFile resolves the active preset from the session file", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-export-display-cli-"));
		cleanups.push(() => {
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});
		writeDisplayPreset(tempDir);
		process.env[ENV_AGENT_DIR] = join(tempDir, "agent");

		const sessionManager = SessionManager.create(tempDir, join(tempDir, "sessions"));
		sessionManager.appendMessage(userMsg("question with SUPER_SECRET_VALUE"));
		sessionManager.appendMessage(assistantMsg("answer with SUPER_SECRET_VALUE and [REDACT]sensitive[/REDACT]"));
		sessionManager.appendPresetChange("display-redact");

		const outputPath = join(tempDir, "export.html");
		await exportFromFile(sessionManager.getSessionFile()!, outputPath);
		const texts = allMessageTexts(decodeSessionData(readFileSync(outputPath, "utf8")));

		expect(texts).toContain("[hidden]");
		expect(texts).not.toContain("SUPER_SECRET_VALUE");
		expect(texts).toContain("[redacted]");
		expect(texts).not.toContain("sensitive");
	});

	it("CLI exportFromFile leaves text raw when the session never switched presets", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-export-display-cli-raw-"));
		cleanups.push(() => {
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});
		// Preset exists on disk but is not active in the session (no preset_change entry).
		writeDisplayPreset(tempDir);
		process.env[ENV_AGENT_DIR] = join(tempDir, "agent");

		const sessionManager = SessionManager.create(tempDir, join(tempDir, "sessions"));
		sessionManager.appendMessage(userMsg("question with SUPER_SECRET_VALUE"));
		sessionManager.appendMessage(assistantMsg("answer with SUPER_SECRET_VALUE"));

		const outputPath = join(tempDir, "export.html");
		await exportFromFile(sessionManager.getSessionFile()!, outputPath);
		const texts = allMessageTexts(decodeSessionData(readFileSync(outputPath, "utf8")));

		expect(texts).toContain("SUPER_SECRET_VALUE");
		expect(texts).not.toContain("[hidden]");
	});
});
