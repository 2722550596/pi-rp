import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { registerMacro } from "../src/core/prompt-preset/macro-engine.ts";
import { registerSlot } from "../src/core/prompt-preset/slot-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { getMessageText } from "./suite/harness.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()!();
});

async function fixture(persisted = false) {
	const dir = mkdtempSync(join(tmpdir(), "pi-macro-lifecycle-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	const agentDir = join(dir, "agent");
	mkdirSync(join(agentDir, "prompt-presets"), { recursive: true });
	writeFileSync(
		join(agentDir, "prompt-presets", "epoch.json"),
		JSON.stringify({
			schemaVersion: 1,
			id: "epoch",
			autoActivate: true,
			items: [
				{ kind: "block", id: "value", content: "{{lifecycleEpoch}}" },
				{ kind: "slot", id: "async", slot: "epoch-lifecycle-async" },
			],
		}),
	);
	const faux = registerFauxProvider({ models: [{ id: "epoch-model" }] });
	cleanups.push(() => faux.unregister());
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
	let value = "initial";
	const registry = await createInMemoryModelRegistry(authStorage);
	const model = faux.getModel();
	registry.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		api: model.api,
		apiKey: "faux-key",
		models: [
			{
				id: model.id,
				name: model.name,
				api: model.api,
				reasoning: model.reasoning,
				input: model.input,
				cost: model.cost,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
			},
		],
	});
	const render = vi.fn(() => value);
	registerMacro({ name: "lifecycleEpoch", description: "test", static: true, render });
	registerSlot({ name: "epoch-lifecycle-async", description: "test", async: true, render: async () => "" });
	const factory: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			modelRuntime: getModelRuntime(registry),
			settingsManager: SettingsManager.inMemory(),
			resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true },
		});
		const result = await createAgentSessionFromServices({
			services,
			sessionManager,
			sessionStartEvent,
			model: faux.getModel(),
		});
		await result.session._buildRuntimePromise;
		return { ...result, services, diagnostics: services.diagnostics };
	};
	const manager = persisted ? SessionManager.create(dir, join(dir, "sessions")) : SessionManager.inMemory(dir);
	const runtime = await createAgentSessionRuntime(factory, { cwd: dir, agentDir, sessionManager: manager });
	cleanups.push(() => runtime.session.dispose());
	// The preset block compiles first; restored/forked history is appended after it.
	const output = async () => getMessageText((await runtime.session.getPresetInjectMessages())[0]);
	return {
		dir,
		runtime,
		render,
		output,
		setValue(next: string) {
			value = next;
		},
	};
}

describe("macro epochs across session-ready paths", () => {
	it("starts a new SDK session with a local snapshot and reuses it", async () => {
		const f = await fixture();
		expect(f.runtime.session.sessionScope).toBeUndefined();
		expect(await f.output()).toBe("initial");
		f.setValue("changed");
		expect(await f.output()).toBe("initial");
		expect(f.render).toHaveBeenCalledTimes(1);
	});

	it("starts a fresh epoch after newSession", async () => {
		const f = await fixture();
		expect(await f.output()).toBe("initial");
		f.setValue("changed");
		await f.runtime.newSession();
		expect(await f.output()).toBe("changed");
		expect(await f.output()).toBe("changed");
		expect(f.render).toHaveBeenCalledTimes(2);
	});

	it("starts a fresh epoch after restoring with switchSession", async () => {
		const f = await fixture(true);
		f.runtime.session.sessionManager.appendMessage({ role: "user", content: "saved", timestamp: 0 });
		f.runtime.session.sessionManager.appendMessage(fauxAssistantMessage("saved answer"));
		const path = f.runtime.session.sessionFile!;
		expect(await f.output()).toBe("initial");
		f.setValue("changed");
		await f.runtime.switchSession(path);
		expect(await f.output()).toBe("changed");
		expect(await f.output()).toBe("changed");
		expect(f.render).toHaveBeenCalledTimes(2);
	});

	it.each([
		["persisted with target leaf", true, "at"],
		["persisted without target leaf", true, "before"],
		["in-memory", false, "at"],
	] as const)("starts a fresh epoch after fork: %s", async (_name, persisted, position) => {
		const f = await fixture(persisted);
		const id = f.runtime.session.sessionManager.appendMessage({ role: "user", content: "fork me", timestamp: 0 });
		f.runtime.session.sessionManager.appendMessage(fauxAssistantMessage("answer"));
		expect(await f.output()).toBe("initial");
		f.setValue("changed");
		await f.runtime.fork(id, { position });
		expect(await f.output()).toBe("changed");
		expect(await f.output()).toBe("changed");
		expect(f.render).toHaveBeenCalledTimes(2);
	});
});
