import { Agent } from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import {
	convertToLlm,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	registerFauxProvider,
	streamSimple,
} from "@earendil-works/pi-ai/compat";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { LoadedPromptPresetSource } from "../src/core/prompt-preset/loader.ts";
import type { PromptPreset, SlotDefinition } from "../src/core/prompt-preset/types.ts";
import { RequestGateway } from "../src/core/request-gateway.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { type AgentSessionScope, createAgentSessionScope } from "../src/core/session-scope.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { prepareSubagentConversation, runSubagent } from "../src/core/subagent";
import type { SchemaDefSource } from "../src/state/schema-loader.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { MemoryStorageBackend } from "./resource-supply-mocks.ts";
import { createTestResourceLoader } from "./utilities.ts";

/**
 * 18 号 §10.5 — 子代理资源供给继承（getResourceSupply 三元组转发）。
 *
 * §10.4 的 E5 reject 用例走 scripts/check-browser-harness.mjs 的 A6 资源审计 entry
 * （ci-entry-resources.ts 的 runResourceRejects）：assemble.ts 经 export-html-assets.ts
 * 引入 esbuild 专属 `raw:` 模板资产，纯 node/vitest 无法加载该模块图，reject 探针在
 * bundle 侧执行（同一 createPiHarness 源码，零复制）。
 *
 * 本文件用 faux provider 驱动真实 prepareSubagentConversation + runSubagent 流程；
 * 子会话断言在 onSessionCreated 里做（run 结束即 dispose）。
 */

const fauxProviders: FauxProviderRegistration[] = [];

afterEach(() => {
	while (fauxProviders.length) fauxProviders.pop()!.unregister();
});

function noopLocks() {
	return {
		lockSync: () => () => {},
		lockAsync: async () => async () => {},
	};
}

function presetBody(id: string, extra: Record<string, unknown> = {}): PromptPreset {
	return {
		schemaVersion: 1,
		id,
		items: [{ kind: "block", id: "intro", content: `REJECT-SMOKE-BLOCK-${id}` }],
		...extra,
	} as PromptPreset;
}

function seedStorage(): MemoryStorageBackend {
	const storage = new MemoryStorageBackend("opfs");
	storage.seedJson("/state/agent/prompt-presets/disk-preset.json", presetBody("disk-preset"));
	storage.seedJson("/workspace/default/ip/aurora/prompt-presets/project-preset.json", presetBody("project-preset"));
	storage.seedJson("/workspace/default/ip/aurora/schemas/project-schema.json", {
		namespace: "project",
		schema: { type: "object", properties: { title: { type: "string" } } },
	});
	storage.seedJson("/state/agent/schemas/world.json", {
		namespace: "world",
		schema: { type: "object", properties: { day: { type: "number", default: 1 } } },
	});
	storage.seedJson("/workspace/default/.pi/openings/first-light.json", {
		name: "First Light",
		messages: [{ role: "assistant", content: "REJECT-SMOKE-OPENING-LINE" }],
	});
	return storage;
}

describe("subagent resource supply inheritance (18 号 §10.5)", () => {
	it("child session resolves presets/schemas through the parent supply seam", async () => {
		const storage = seedStorage();
		const stores = { storage, locks: noopLocks(), paths: { agentDir: () => "/state/agent" } };
		const inlinePresets: LoadedPromptPresetSource[] = [
			{
				preset: presetBody("inline-peer", {
					delegatable: true,
					items: [
						{ kind: "block", id: "intro", content: "{{subagentParentMacro}}" },
						{ kind: "slot", id: "parent-slot", slot: "subagentParentSlot" },
					],
				}),
				filePath: "inline:inline-peer",
				diagnostics: [],
			},
		];
		const inlineSchemas: SchemaDefSource[] = [
			{ schemaId: "peer-schema", namespace: "peer", schema: { type: "object", properties: {} } },
		];

		const faux = registerFauxProvider({});
		faux.setResponses([fauxAssistantMessage("peer done")]);
		fauxProviders.push(faux);
		const model = faux.getModel();
		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRuntime = getModelRuntime(await createInMemoryModelRegistry(authStorage));
		const parentGateway = new RequestGateway(modelRuntime, {});

		const parentScope = createAgentSessionScope({ rejectSessionReplacement: true });
		// Parent session: browser-shaped supply (OPFS-kind stores + inline sets) over a faux-model agent.
		const agent = new Agent({
			getApiKey: () => "faux-key",
			streamFn: streamSimple,
			initialState: { model, systemPrompt: "You are a test assistant.", tools: [] },
			convertToLlm,
		});
		const parent = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory("/workspace/default"),
			settingsManager: SettingsManager.inMemory(),
			cwd: "/workspace/default",
			agentDir: "/state/agent",
			configDir: "ip/aurora",
			stores,
			inlinePresets,
			inlineSchemas,
			modelRuntime,
			requestGateway: parentGateway,
			resourceLoader: createTestResourceLoader(),
			requestIdentity: { sessionId: "parent-host-session", priority: 2, label: "main" },
			scope: parentScope,
		});
		try {
			await parent._buildRuntimePromise;
			expect(parent.sessionScope).toBe(parentScope);
			parentScope.promptRegistry.registerMacro({
				name: "subagentParentMacro",
				description: "parent-scoped macro",
				render: () => "parent-scoped-macro-value",
			});
			parentScope.promptRegistry.registerSlot({
				name: "subagentParentSlot",
				description: "parent-scoped async slot",
				async: true,
				render: async () => "parent-scoped-slot-value",
			});

			const preparation = await prepareSubagentConversation({
				cwd: "/workspace/default",
				profileId: "inline-peer",
				task: "peer task",
				modelRuntime,
				session: parent,
			});
			if (!("messages" in preparation)) throw new Error(`prepare failed: ${JSON.stringify(preparation)}`);

			const preparedText = preparation.messages
				.map((message) => ("content" in message ? contentText(message.content, "") : ""))
				.join("\n");
			expect(preparedText).toContain("parent-scoped-macro-value");
			expect(preparedText).toContain("parent-scoped-slot-value");

			let child: AgentSession | undefined;
			let childScope: AgentSessionScope | undefined;
			let childSlot: SlotDefinition | undefined;
			const parentSlot = parent.promptRegistryScope?.getCustomSlot("subagentParentSlot");
			const result = await runSubagent(preparation, modelRuntime, {
				parentSession: parent,
				onSessionCreated: (session) => {
					child = session;
					childScope = session.sessionScope;
					expect(session.promptRegistryScope?.getCustomSlot("subagentParentSlot")).toBeUndefined();
					const slot: SlotDefinition = {
						name: "subagentParentSlot",
						description: "child-scoped async slot",
						async: true,
						render: async () => "child-scoped-slot-value",
					};
					session.promptRegistryScope?.registerSlot(slot);
					childSlot = session.promptRegistryScope?.getCustomSlot("subagentParentSlot");
					expect(session.requestIdentity).toEqual({
						sessionId: "parent-host-session",
						priority: 0,
						label: "subagent",
					});
					expect(session.requestGateway).toBe(parentGateway);
				},
			});
			expect(result.status).toBe("completed");
			expect(child).toBeDefined();
			expect(childScope).toBeDefined();
			expect(childScope).not.toBe(parentScope);
			expect(parentSlot).toBeDefined();
			expect(childSlot).toBeDefined();
			expect(childSlot).not.toBe(parentSlot);

			// The supply seam (not a snapshot) is inherited: same storage backend + inline sets.
			const supply = child!.getResourceSupply();
			expect(supply.stores.storage).toBe(storage);
			expect(supply.configDir).toBe("ip/aurora");
			expect(supply.agentDir).toBe("/state/agent");
			expect(supply.inlinePresets.map((preset) => preset.preset.id)).toEqual(["inline-peer"]);
			expect(supply.inlineSchemas.map((schema) => schema.schemaId)).toEqual(["peer-schema"]);

			// Merged-set resolution works in the child: inline preset + OPFS schema both visible.
			expect(child!.getAllPresets().map((preset) => preset.preset.id)).toContain("inline-peer");
			expect(child!.getAllPresets().map((preset) => preset.preset.id)).toContain("project-preset");
			expect(child!.activePreset.id).toBe("inline-peer");
			const childSchemaIds = child!.getLoadedSchemaDefs().map((def) => def.schemaId);
			expect(childSchemaIds).toContain("peer-schema");
			expect(childSchemaIds).toContain("world");
			expect(childSchemaIds).toContain("project-schema");
			expect(child!.loadSchema("world").ok).toBe(true);
		} finally {
			parent.dispose();
			parentScope.dispose();
		}
	});
});
