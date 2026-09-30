import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import {
	convertToLlm,
	type FauxProviderRegistration,
	registerFauxProvider,
	streamSimple,
} from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_PROJECT_CONFIG_DIR } from "../src/config.ts";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { loadPromptPresets } from "../src/core/prompt-preset/loader.ts";
import { loadPromptTemplates } from "../src/core/prompt-templates.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { listOpeningPresets } from "../src/extensions/opening/preset.ts";
import { loadSchemaDefs } from "../src/state/schema-loader.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { MemoryStorageBackend } from "./resource-supply-mocks.ts";
import { createTestResourceLoader } from "./utilities.ts";

/**
 * Per-harness project-root isolation (17 §3.1, 18 §2.6): same cwd, different configDir values
 * select separate project resources/settings without consulting PI_PROJECT_CONFIG_DIR.
 */

const previousProjectConfigDir = process.env[ENV_PROJECT_CONFIG_DIR];
const fauxProviders: FauxProviderRegistration[] = [];

afterEach(() => {
	while (fauxProviders.length) fauxProviders.pop()!.unregister();
	if (previousProjectConfigDir === undefined) delete process.env[ENV_PROJECT_CONFIG_DIR];
	else process.env[ENV_PROJECT_CONFIG_DIR] = previousProjectConfigDir;
});

function seedIp(storage: MemoryStorageBackend, configDir: string, id: string): void {
	const root = `/workspace/repo/${configDir}`;
	storage.seedJson(`${root}/prompt-presets/${id}.json`, { schemaVersion: 1, id, items: [] });
	storage.seedJson(`${root}/schemas/${id}.json`, { namespace: id, schema: { type: "object" } });
	storage.seedJson(`${root}/openings/${id}.json`, { name: id, messages: [] });
	storage.seed(`${root}/prompts/${id}.md`, `Prompt for ${id}`);
	storage.seedJson(`${root}/settings.json`, { defaultPreset: id, theme: id });
}

const locks = {
	lockSync: () => () => {},
	lockAsync: async () => async () => {},
};

describe("per-harness configDir isolation", () => {
	it("keeps project resources and SettingsManager project settings isolated for the same cwd", async () => {
		const storage = new MemoryStorageBackend("opfs");
		seedIp(storage, "ip/aurora", "aurora");
		seedIp(storage, "ip/borealis", "borealis");
		process.env[ENV_PROJECT_CONFIG_DIR] = "global-env-must-not-win";
		const stores = { storage, locks, paths: { agentDir: () => "/state/agent" } };
		const cwd = "/workspace/repo";
		const agentDir = "/state/agent";

		for (const [configDir, id] of [
			["ip/aurora", "aurora"],
			["ip/borealis", "borealis"],
		] as const) {
			const presets = loadPromptPresets(cwd, agentDir, { storage, configDir });
			expect(presets.map((preset) => preset.preset.id)).toEqual([id]);

			const schemas = await loadSchemaDefs(cwd, agentDir, { storage, configDir });
			expect(schemas.schemas.map((schema) => schema.schemaId)).toEqual([id]);

			expect(listOpeningPresets(cwd, { storage, configDir }).map((opening) => opening.id)).toEqual([id]);

			const prompts = loadPromptTemplates({
				cwd,
				agentDir,
				promptPaths: [],
				includeDefaults: true,
				storage,
				configDir,
			});
			expect(prompts.map((prompt) => prompt.name)).toEqual([id]);

			const settingsManager = SettingsManager.create(cwd, agentDir, { stores, configDir });
			expect(settingsManager.getProjectSettings()).toMatchObject({ defaultPreset: id, theme: id });
		}
		expect(process.env[ENV_PROJECT_CONFIG_DIR]).toBe("global-env-must-not-win");
	});
	it("uses each configDir as the default AgentSession StateStore root", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-configdir-isolation-"));
		const agentDir = join(cwd, "agent");
		const storage = new MemoryStorageBackend("opfs");
		const stores = { storage, locks, paths: { agentDir: () => agentDir } };
		const configRoots = [
			["ip/aurora", "aurora"],
			["ip/borealis", "borealis"],
		] as const;
		for (const [configDir] of configRoots) {
			storage.seedJson(join(cwd, configDir, "settings.json"), { state: { store: "file" } });
		}
		process.env[ENV_PROJECT_CONFIG_DIR] = "global-env-must-not-win";

		const faux = registerFauxProvider({});
		fauxProviders.push(faux);
		const model = faux.getModel();
		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRuntime = getModelRuntime(await createInMemoryModelRegistry(authStorage));
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const sessions: AgentSession[] = [];
		try {
			for (const [configDir, id] of configRoots) {
				const agent = new Agent({
					getApiKey: () => "faux-key",
					streamFn: streamSimple,
					initialState: { model, systemPrompt: "State root isolation test.", tools: [] },
					convertToLlm,
				});
				const session = new AgentSession({
					agent,
					sessionManager: SessionManager.inMemory(cwd),
					settingsManager: SettingsManager.create(cwd, agentDir, { stores, configDir }),
					cwd,
					agentDir,
					configDir,
					stores,
					inlineSchemas: [
						{
							schemaId: "world",
							namespace: "world",
							schema: { type: "object", properties: { value: { type: "string" } } },
						},
					],
					modelRuntime,
					resourceLoader: createTestResourceLoader(),
				});
				sessions.push(session);
				await session._buildRuntimePromise;
				const stateFile = join(cwd, configDir, "state", "world.json");
				session.stateManager.apply("world.value", "replace", id);
				session.stateManager.flushStore();
				expect(existsSync(stateFile)).toBe(true);
				expect(JSON.parse(readFileSync(stateFile, "utf8")).state).toEqual({ value: id });
			}
			expect(process.env[ENV_PROJECT_CONFIG_DIR]).toBe("global-env-must-not-win");
			expect(existsSync(join(cwd, "global-env-must-not-win", "state", "world.json"))).toBe(false);
		} finally {
			for (const session of sessions) session.dispose();
			warn.mockRestore();
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
