import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import type { AgentSessionServices } from "../src/core/agent-session-services.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ProviderConfig } from "../src/core/extensions/types.ts";
import { compileMessages, presetHasAsyncSlots } from "../src/core/prompt-preset/compiler.ts";
import { expandMacros } from "../src/core/prompt-preset/macro-engine.ts";
import type { PromptPreset, PromptRuntime } from "../src/core/prompt-preset/types.ts";
import { assertValidRequestGatewayConfig } from "../src/core/request-gateway.ts";
import { type AgentSessionScope, AgentSessionScopeError, createAgentSessionScope } from "../src/core/session-scope.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createHarness, type Harness } from "./test-harness.ts";

const scopes: AgentSessionScope[] = [];

afterEach(() => {
	while (scopes.length) scopes.pop()!.dispose();
});

function createScope(options?: Parameters<typeof createAgentSessionScope>[0]): AgentSessionScope {
	const scope = createAgentSessionScope(options);
	scopes.push(scope);
	return scope;
}

it("inherits only host-whitelisted prompt slots into an isolated subagent scope", () => {
	const hostSlot = {
		name: "host-subagent-context",
		description: "Host-owned context for delegated sessions.",
		render: () => "host context",
	};
	const parent = createScope({ rejectSessionReplacement: true, subagentPromptSlots: [hostSlot] });
	const update = parent.beginUpdate();
	update.commit();
	expect(parent.promptRegistry.getCustomSlot("host-subagent-context")).toBe(hostSlot);
	parent.promptRegistry.registerSlot({
		name: "private-session-slot",
		description: "Session-bound data that must not leak into children.",
		render: () => "private",
	});

	const child = parent.createSubagentScope();
	scopes.push(child);
	expect(child).not.toBe(parent);
	expect(child.rejectSessionReplacement).toBe(true);
	expect(child.promptRegistry.getCustomSlot("host-subagent-context")).toBe(hostSlot);
	expect(child.promptRegistry.getCustomSlot("private-session-slot")).toBeUndefined();
});

function makeRuntime(scope: AgentSessionScope): PromptRuntime {
	return {
		options: { cwd: "/" },
		messages: [],
		now: new Date(0),
		variables: {},
		skills: [],
		promptRegistry: scope.promptRegistry,
	};
}

function textOf(messages: AgentMessage[]): string {
	const parts: string[] = [];
	for (const message of messages) {
		if (!("content" in message) || !Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (typeof part === "object" && part !== null && part.type === "text") parts.push(part.text);
		}
	}
	return parts.join("\n");
}

const scopedPreset: PromptPreset = {
	schemaVersion: 1,
	id: "session-scope",
	items: [
		{ kind: "block", id: "macro", content: "{{sessionScopeValue}}" },
		{ kind: "slot", id: "slot", slot: "sessionScopeSlot" },
	],
};

const providerConfig: ProviderConfig = {
	baseUrl: "https://provider.test/v1",
	apiKey: "provider-key",
	api: "openai-completions",
	models: [
		{
			id: "scope-model",
			name: "Scope Model",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 16000,
			maxTokens: 1024,
		},
	],
};

function copyProviderConfig(
	config: ProviderConfig,
	refreshModels?: NonNullable<ProviderConfig["refreshModels"]>,
): ProviderConfig {
	const copy = JSON.parse(JSON.stringify(config)) as ProviderConfig;
	if (refreshModels) copy.refreshModels = refreshModels;
	return copy;
}

describe("AgentSession scope isolation", () => {
	it("resolves async slots and macros from the compiling session only", async () => {
		const a = createScope();
		const b = createScope();
		for (const [scope, value] of [
			[a, "session-A"],
			[b, "session-B"],
		] as const) {
			scope.promptRegistry.registerMacro({
				name: "sessionScopeValue",
				description: "session-owned value",
				render: () => value,
			});
			scope.promptRegistry.registerSlot({
				name: "sessionScopeSlot",
				description: "session-owned async slot",
				async: true,
				render: async () => `slot-${value}`,
			});
		}

		expect(presetHasAsyncSlots(scopedPreset, a.promptRegistry)).toBe(true);
		expect(presetHasAsyncSlots(scopedPreset, b.promptRegistry)).toBe(true);
		expect(textOf((await compileMessages(scopedPreset, makeRuntime(a))).messages)).toContain("session-A");
		expect(textOf((await compileMessages(scopedPreset, makeRuntime(a))).messages)).not.toContain("session-B");
		expect(textOf((await compileMessages(scopedPreset, makeRuntime(b))).messages)).toContain("session-B");
		expect(textOf((await compileMessages(scopedPreset, makeRuntime(b))).messages)).not.toContain("session-A");
	});

	it("keeps memory slot renderer closures local and rolls back failed prompt updates", async () => {
		const a = createScope();
		const b = createScope();
		a.promptRegistry.registerSlot(
			{ name: "awaken", description: "A database", async: true, render: async () => "database-A" },
			true,
		);
		b.promptRegistry.registerSlot(
			{ name: "awaken", description: "B database", async: true, render: async () => "database-B" },
			true,
		);
		const memoryPreset: PromptPreset = {
			schemaVersion: 1,
			id: "memory-scope",
			items: [{ kind: "slot", id: "memory", slot: "awaken" }],
		};

		a.promptRegistry.registerMacro({ name: "sessionScopeValue", description: "original", render: () => "old" });
		const failedUpdate = a.beginUpdate();
		a.promptRegistry.registerMacro({ name: "sessionScopeValue", description: "replacement", render: () => "new" });
		failedUpdate.rollback();
		expect(textOf((await compileMessages(memoryPreset, makeRuntime(a))).messages)).toBe("database-A");
		expect(textOf((await compileMessages(memoryPreset, makeRuntime(b))).messages)).toBe("database-B");
		expect(expandMacros("{{sessionScopeValue}}", makeRuntime(a))).toBe("old");
		expect(expandMacros("{{sessionScopeValue}}", makeRuntime(b))).toBe("{{sessionScopeValue}}");
	});

	it("prevents one scope from being attached to more than one AgentSession", async () => {
		const registry = await createInMemoryModelRegistry(AuthStorage.inMemory());
		const scope = createScope();
		const runtime = getModelRuntime(registry);
		scope.bindModelRuntime(runtime);
		expect(() => scope.bindModelRuntime(runtime)).toThrow(/already attached/);
	});
	it("refcounts extension provider ownership and rejects conflicting owners without overwriting", async () => {
		const registry = await createInMemoryModelRegistry(AuthStorage.inMemory());
		const runtime = getModelRuntime(registry);
		const a = createScope();
		const b = createScope();
		a.bindModelRuntime(runtime);
		b.bindModelRuntime(runtime);

		const refreshModels = async () => providerConfig.models ?? [];
		const configWithUndefined: ProviderConfig = {
			...providerConfig,
			name: undefined,
			headers: undefined,
			refreshModels,
		};
		const bConfig = copyProviderConfig(configWithUndefined, refreshModels);
		const aUpdate = a.beginUpdate();
		a.registerProvider("/extensions/provider.ts", "scoped-provider", configWithUndefined);
		configWithUndefined.apiKey = "mutated-after-registration";
		aUpdate.commit();
		expect(runtime.getRegisteredProviderConfig("scoped-provider")?.apiKey).toBe("provider-key");
		const bUpdate = b.beginUpdate();
		b.registerProvider("/extensions/provider.ts", "scoped-provider", bConfig);
		bUpdate.commit();

		a.unregisterProvider("/extensions/provider.ts", "scoped-provider");
		expect(runtime.getRegisteredProviderConfig("scoped-provider")).toBeDefined();
		a.dispose();
		expect(runtime.getRegisteredProviderConfig("scoped-provider")).toBeDefined();
		b.dispose();
		expect(runtime.getRegisteredProviderConfig("scoped-provider")).toBeUndefined();
	});

	it("undoes registrations applied earlier in a failed provider reload", async () => {
		const registry = await createInMemoryModelRegistry(AuthStorage.inMemory());
		const runtime = getModelRuntime(registry);
		const scope = createScope();
		scope.bindModelRuntime(runtime);

		const invalidConfig = {
			streamSimple: (() => {
				throw new Error("must not stream");
			}) as unknown as ProviderConfig["streamSimple"],
		} as ProviderConfig;
		const update = scope.beginUpdate();
		scope.registerProvider("/extensions/provider.ts", "provider-good", providerConfig);
		scope.registerProvider("/extensions/provider.ts", "provider-invalid", invalidConfig);
		expect(() => update.commit()).toThrow();
		update.rollback();
		expect(runtime.getRegisteredProviderConfig("provider-good")).toBeUndefined();
		expect(runtime.getRegisteredProviderConfig("provider-invalid")).toBeUndefined();
	});
	it("rolls back a failed reload before it can remove another session's provider", async () => {
		const registry = await createInMemoryModelRegistry(AuthStorage.inMemory());
		const runtime = getModelRuntime(registry);
		const a = createScope();
		const b = createScope();
		a.bindModelRuntime(runtime);
		b.bindModelRuntime(runtime);

		const refreshModels = async () => providerConfig.models ?? [];
		const configWithUndefined: ProviderConfig = {
			...providerConfig,
			name: undefined,
			headers: undefined,
			refreshModels,
		};
		const initialUpdate = a.beginUpdate();
		a.registerProvider("/extensions/provider.ts", "scoped-provider", configWithUndefined);
		initialUpdate.commit();
		const bUpdate = b.beginUpdate();
		b.registerProvider(
			"/extensions/provider.ts",
			"scoped-provider",
			copyProviderConfig(configWithUndefined, refreshModels),
		);
		bUpdate.commit();

		const changed = copyProviderConfig(providerConfig, refreshModels);
		changed.apiKey = "changed-key";
		const reload = a.beginUpdate();
		a.registerProvider("/extensions/provider.ts", "scoped-provider", changed);
		expect(() => reload.commit()).toThrowError(AgentSessionScopeError);
		reload.rollback();
		expect(runtime.getRegisteredProviderConfig("scoped-provider")?.apiKey).toBe("provider-key");

		const conflict = b.beginUpdate();
		b.registerProvider("/extensions/other-provider.ts", "scoped-provider", copyProviderConfig(providerConfig));
		expect(() => conflict.commit()).toThrowError(AgentSessionScopeError);
		conflict.rollback();
		const changedClosure = async () => providerConfig.models ?? [];
		const functionConflict = b.beginUpdate();
		b.registerProvider(
			"/extensions/provider.ts",
			"scoped-provider",
			copyProviderConfig(providerConfig, changedClosure),
		);
		expect(() => functionConflict.commit()).toThrowError(AgentSessionScopeError);
		functionConflict.rollback();
		expect(runtime.getRegisteredProviderConfig("scoped-provider")?.apiKey).toBe("provider-key");
		a.dispose();
		expect(runtime.getRegisteredProviderConfig("scoped-provider")?.apiKey).toBe("provider-key");
	});

	it("rejects new, fork, switch, and import replacement before touching session files", async () => {
		const scope = createScope({ rejectSessionReplacement: true });
		const session = {
			assertReplacementAllowed: () => scope.assertReplacementAllowed(),
		} as unknown as AgentSession;
		const runtime = new AgentSessionRuntime(session, {} as AgentSessionServices, async () => {
			throw new Error("replacement runtime must not be created");
		});
		const replacements: Array<() => Promise<unknown>> = [
			() => runtime.newSession(),
			() => runtime.fork("entry"),
			() => runtime.switchSession("/missing-session.jsonl"),
			() => runtime.importFromJsonl("/missing-session.jsonl"),
		];

		for (const replace of replacements) {
			await expect(replace()).rejects.toMatchObject({
				name: "AgentSessionScopeError",
				code: "SESSION_REPLACEMENT_UNSUPPORTED",
			});
		}
	});
	it("retains the legacy process-global provider reset for unscoped session reload", async () => {
		const harness = await createHarness();
		const faux = registerFauxProvider();
		expect(getApiProvider(faux.api)).toBeDefined();
		try {
			await harness.session.reload();
			expect(getApiProvider(faux.api)).toBeUndefined();
		} finally {
			faux.unregister();
			harness.cleanup();
		}
	});

	it("does not reset process-global pi-ai providers for a scoped Host session", async () => {
		const scope = createScope({ rejectSessionReplacement: true });
		const harness = await createHarness({ scope });
		const faux = registerFauxProvider();
		const registeredProvider = getApiProvider(faux.api);
		expect(registeredProvider).toBeDefined();
		try {
			await harness.session.reload();
			expect(getApiProvider(faux.api)).toBe(registeredProvider);
		} finally {
			faux.unregister();
			harness.cleanup();
		}
	});
	it("keeps nested scoped reload and memory renderers isolated from the parent scope", async () => {
		const parentScope = createScope({ rejectSessionReplacement: true });
		let parent: Harness | undefined;
		let child: Harness | undefined;
		let unregisterFaux: (() => void) | undefined;
		try {
			parent = await createHarness({ scope: parentScope });
			expect(parent.session.sessionScope).toBe(parentScope);
			const parentSlotRenderer = async () => "parent-slot";
			const parentMemoryRenderer = async () => "parent-memory";
			parentScope.promptRegistry.registerSlot({
				name: "subagentParentSlot",
				description: "parent-scoped extension slot",
				async: true,
				render: parentSlotRenderer,
			});
			parentScope.promptRegistry.registerSlot(
				{
					name: "subagentParentMemory",
					description: "parent-owned memory closure",
					async: true,
					render: parentMemoryRenderer,
				},
				true,
			);
			parentScope.registerProvider("/extensions/parent.ts", "parent-scoped-provider", providerConfig);
			const childScope = parent.session.createSubagentScope();
			expect(childScope).toBeDefined();
			expect(childScope).not.toBe(parentScope);
			scopes.push(childScope!);
			child = await createHarness({ scope: childScope!, modelRuntime: parent.session.modelRuntime });

			const faux = registerFauxProvider();
			unregisterFaux = () => faux.unregister();
			const apiProvider = getApiProvider(faux.api);
			expect(apiProvider).toBeDefined();

			expect(parentScope.promptRegistry.getCustomSlot("subagentParentSlot")?.render).toBe(parentSlotRenderer);
			expect(parentScope.promptRegistry.getBuiltInSlot("subagentParentMemory")?.render).toBe(parentMemoryRenderer);
			expect(childScope!.promptRegistry.getCustomSlot("subagentParentSlot")).toBeUndefined();
			expect(childScope!.promptRegistry.getBuiltInSlot("subagentParentMemory")).toBeUndefined();
			expect(child.session.sessionScope).toBe(childScope);

			await child.session.reload();
			expect(getApiProvider(faux.api)).toBe(apiProvider);
			expect(parent.session.modelRuntime.getRegisteredProviderConfig("parent-scoped-provider")).toBeDefined();
			const childMemoryRenderer = async () => "child-memory";
			childScope!.promptRegistry.registerSlot(
				{
					name: "subagentParentMemory",
					description: "child-owned memory closure",
					async: true,
					render: childMemoryRenderer,
				},
				true,
			);
			expect(childScope!.promptRegistry.getBuiltInSlot("subagentParentMemory")?.render).toBe(childMemoryRenderer);
			expect(childMemoryRenderer).not.toBe(parentMemoryRenderer);
		} finally {
			unregisterFaux?.();
			child?.cleanup();
			parent?.cleanup();
		}
	});
	it("exposes typed replacement rejection for Host-owned fixed sessions", () => {
		const scope = createScope({ rejectSessionReplacement: true });
		let caught: unknown;
		try {
			scope.assertReplacementAllowed();
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(AgentSessionScopeError);
		expect(caught).toMatchObject({ code: "SESSION_REPLACEMENT_UNSUPPORTED" });
	});

	it("validates strict Host gateway bounds without changing gateway defaults", () => {
		expect(() => assertValidRequestGatewayConfig({ defaultMaxConcurrency: 2 })).not.toThrow();
		for (const invalid of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => assertValidRequestGatewayConfig({ defaultMaxConcurrency: invalid })).toThrow(TypeError);
		}
		for (const invalid of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() =>
				assertValidRequestGatewayConfig({
					defaultMaxConcurrency: 2,
					providers: { example: { maxConcurrency: invalid as number } },
				}),
			).toThrow(TypeError);
		}
	});
});
