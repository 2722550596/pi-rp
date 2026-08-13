import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type AssistantMessage,
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { describe, it } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import { isPrepareError, prepareSubagentConversation } from "../../src/core/subagent/prepare.ts";
import { spawnAgent } from "../../src/core/subagent/spawn.ts";
import { createHarness, getMessageText } from "./harness.ts";

// Minimal state-updater-like preset: role + state slot + task block.
const PRESET = JSON.stringify({
	schemaVersion: 1,
	id: "test-spawn",
	items: [
		{ kind: "block", id: "role", role: "system", content: "You are a state updater." },
		{
			kind: "slot",
			id: "state",
			role: "system",
			slot: "state",
			options: { allowNamespace: ["world", "secret"], format: "json" },
		},
		{ kind: "block", id: "task", role: "user", content: "Update state per instructions." },
	],
});

async function setupHarness() {
	const harness = await createHarness();
	const presetDir = join(harness.tempDir, ".pi", "prompt-presets");
	mkdirSync(presetDir, { recursive: true });
	writeFileSync(join(presetDir, "test-spawn.json"), PRESET);
	// Isolate schema discovery: ENV_AGENT_DIR points at a temp agent dir so the
	// user's global schemas cannot interfere with the "world" namespace fixture.
	// The subagent session resolves schemas from getAgentDir() at create time.
	const schemaDir = join(harness.tempDir, "agent", "schemas");
	mkdirSync(schemaDir, { recursive: true });
	writeFileSync(
		join(schemaDir, "world.ts"),
		'import { Type } from "typebox";\nexport default Type.Object({ seen: Type.Optional(Type.Array(Type.String())) });',
	);
	process.env[ENV_AGENT_DIR] = join(harness.tempDir, "agent");
	harness.session.reloadPresets();
	return harness;
}

describe("spawnAgent", () => {
	it("spawns a subagent with only state_update/get_state tools (no extension tool leakage)", async () => {
		let peekCalls = 0;
		const prev = process.env[ENV_AGENT_DIR];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "web_peek",
						label: "Web Peek",
						description: "Peek a URL",
						parameters: { type: "object", properties: {} },
						promptSnippet: "web_peek: peek a URL",
						execute: async () => {
							peekCalls++;
							return { content: [{ type: "text", text: "peeked" }], details: undefined };
						},
					});
				},
			],
		});
		try {
			const presetDir = join(harness.tempDir, ".pi", "prompt-presets");
			mkdirSync(presetDir, { recursive: true });
			writeFileSync(join(presetDir, "test-spawn.json"), PRESET);
			process.env[ENV_AGENT_DIR] = join(harness.tempDir, "agent");
			mkdirSync(join(harness.tempDir, "agent", "schemas"), { recursive: true });
			harness.session.reloadPresets();

			harness.faux.setResponses([fauxAssistantMessage("DONE")]);
			let activeTools: string[] | undefined;
			const result = await spawnAgent(harness.session, {
				profileId: "test-spawn",
				task: "Update the world.",
				onSessionCreated: (sub) => {
					activeTools = sub.getActiveToolNames();
				},
			});

			assert.equal(result.status, "completed", result.error ?? "");
			assert.deepEqual(activeTools, ["state_update", "get_state"]);
			assert.equal(peekCalls, 0, "parent extension tool must not execute inside the subagent");
			assert.deepEqual(result.stateOps, []);
		} finally {
			restoreEnv(prev);
			harness.cleanup();
		}
	});

	it("seeds the subagent state from the parent snapshot, filtered by stateNamespaces", async () => {
		const prev = process.env[ENV_AGENT_DIR];
		const harness = await setupHarness();
		try {
			harness.session.stateManager.load({ world: { seen: ["a", "b"] }, secret: { plot: "hidden" } });
			harness.faux.setResponses([fauxAssistantMessage("DONE")]);

			let seed: Record<string, unknown> | undefined;
			const result = await spawnAgent(harness.session, {
				profileId: "test-spawn",
				task: "Update the world.",
				stateNamespaces: ["world"],
				onSessionCreated: (sub) => {
					seed = sub.stateManager.snapshot();
				},
			});

			assert.equal(result.status, "completed", result.error ?? "");
			assert.deepEqual(seed, { world: { seen: ["a", "b"] } }, "seed must contain world and exclude secret");
		} finally {
			restoreEnv(prev);
			harness.cleanup();
		}
	});

	it("replays successful state_update calls as stateOps in order", async () => {
		const prev = process.env[ENV_AGENT_DIR];
		const harness = await setupHarness();
		try {
			harness.session.stateManager.load({ world: { seen: ["a", "b"] } });
			harness.faux.setResponses([
				fauxAssistantMessage([fauxToolCall("state_update", { op: "add", path: "/world/seen", value: "c" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("DONE"),
			]);

			const result = await spawnAgent(harness.session, {
				profileId: "test-spawn",
				task: "Append c to /world/seen.",
				stateNamespaces: ["world"],
				schemas: ["world"],
			});

			assert.equal(result.status, "completed", result.error ?? "");
			assert.deepEqual(result.stateOps, [{ op: "add", path: "/world/seen", value: "c" }]);
		} finally {
			restoreEnv(prev);
			harness.cleanup();
		}
	});

	it("strict gate: state_update calls to namespaces without a loaded schema are not recorded", async () => {
		const prev = process.env[ENV_AGENT_DIR];
		const harness = await setupHarness();
		try {
			harness.session.stateManager.load({ world: { seen: ["a", "b"] } });
			harness.faux.setResponses([
				fauxAssistantMessage([fauxToolCall("state_update", { op: "replace", path: "/secret/x", value: 1 })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("DONE"),
			]);

			const result = await spawnAgent(harness.session, {
				profileId: "test-spawn",
				task: "Write /secret/x.",
				stateNamespaces: ["world"],
				schemas: ["world"],
			});

			assert.equal(result.status, "completed", result.error ?? "");
			assert.deepEqual(result.stateOps, [], "rejected writes must not be replayed");
		} finally {
			restoreEnv(prev);
			harness.cleanup();
		}
	});

	it("returns timed-out (empty stateOps) when the run exceeds timeoutMs on a hanging provider", async () => {
		const prev = process.env[ENV_AGENT_DIR];
		const harness = await setupHarness();
		try {
			const hanging: FauxResponseFactory = () => new Promise<AssistantMessage>(() => {});
			harness.faux.setResponses([hanging]);

			const result = await spawnAgent(harness.session, {
				profileId: "test-spawn",
				task: "Update the world.",
				timeoutMs: 1,
			});

			assert.equal(result.status, "timed-out");
			assert.deepEqual(result.stateOps, []);
		} finally {
			restoreEnv(prev);
			harness.cleanup();
		}
	});

	it("prepare filters the state slot to stateNamespaces", async () => {
		const prev = process.env[ENV_AGENT_DIR];
		const harness = await setupHarness();
		try {
			harness.session.stateManager.load({ world: { name: "TestWorld" }, secret: { plot: "hidden" } });

			const result = prepareSubagentConversation({
				cwd: harness.tempDir,
				profileId: "test-spawn",
				task: "task",
				modelRuntime: harness.session.modelRuntime,
				session: harness.session,
				stateNamespaces: ["world"],
			});

			assert.equal(isPrepareError(result), false);
			if (!isPrepareError(result)) {
				const allText = result.messages.map((m) => getMessageText(m)).join("\n");
				assert.ok(allText.includes("TestWorld"), "state slot should include the world namespace");
				assert.ok(!allText.includes("hidden"), "state slot should exclude the secret namespace");
			}
		} finally {
			restoreEnv(prev);
			harness.cleanup();
		}
	});
});

function restoreEnv(prev: string | undefined): void {
	if (prev === undefined) {
		delete process.env[ENV_AGENT_DIR];
	} else {
		process.env[ENV_AGENT_DIR] = prev;
	}
}
