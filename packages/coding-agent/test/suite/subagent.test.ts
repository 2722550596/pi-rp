import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, it } from "vitest";
import { applyResourcePolicy } from "../../src/core/prompt-preset/policy.ts";
import {
	createSubagentProfilesToolDefinition,
	createSubagentToolDefinition,
} from "../../src/core/subagent/extension.ts";
import {
	DEFAULT_SUBAGENT_TOOLS,
	isPrepareError,
	prepareSubagentConversation,
} from "../../src/core/subagent/prepare.ts";
import { runSubagent } from "../../src/core/subagent/run.ts";
import { spawnAgent } from "../../src/core/subagent/spawn.ts";
import { createHarness, getMessageText } from "./harness.ts";

describe("Subagent", () => {
	it("Phase 1: prepareSubagentConversation handles unknown presets", async () => {
		const harness = await createHarness();
		try {
			const result = await prepareSubagentConversation({
				cwd: process.cwd(),
				profileId: "unknown-preset-that-does-not-exist",
				task: "Do something",
				modelRuntime: harness.session.modelRuntime,
			});

			assert.equal(isPrepareError(result), true);
			if (isPrepareError(result)) {
				assert.equal(result.ok, false);
				assert.ok(result.error.includes("not found"));
			}
		} finally {
			harness.cleanup();
		}
	});

	it("Phase 2: runSubagent correctly streams and truncates output", async () => {
		const harness = await createHarness();
		harness.faux.setResponses([fauxAssistantMessage("Task completed successfully. ".repeat(100))]);

		try {
			// Instead of a full preset which requires disk setup, we pass mock preparation
			const result = await runSubagent(
				{
					messages: [{ role: "user", content: [{ type: "text", text: "task" }], timestamp: 0 }],
					model: harness.session.model!,
					thinkingLevel: "medium",
					effectiveTools: [],
					profile: { schemaVersion: 1, id: "test", items: [] },
				},
				harness.session.modelRuntime,
			);

			assert.equal(result.status, "completed");
			assert.ok(result.text.includes("Task completed successfully"));
			assert.equal(result.rawText, "Task completed successfully. ".repeat(100));
		} finally {
			harness.cleanup();
		}
	});

	it("Phase 3: Tools and commands are correctly formatted", async () => {
		const harness = await createHarness();
		try {
			const profilesTool = createSubagentProfilesToolDefinition(harness.session);
			const subagentTool = createSubagentToolDefinition(harness.session);

			assert.equal(profilesTool.name, "subagent_profiles");
			assert.equal(subagentTool.name, "subagent");

			// They should execute (even if they return empty/error states without setup)
			const profilesResult = await profilesTool.execute("1", {}, undefined, undefined, {} as any);
			assert.ok(Array.isArray(profilesResult.content));
			assert.ok(typeof profilesResult.content[0] === "object" && "text" in profilesResult.content[0]);

			const subagentResult = await subagentTool.execute(
				"2",
				{ profileId: "unknown", task: "task" },
				undefined,
				undefined,
				{} as any,
			);
			assert.ok(typeof subagentResult.content[0] === "object" && "text" in subagentResult.content[0]);
		} finally {
			harness.cleanup();
		}
	});

	it("Phase 4: peer completion inherits parent state and history", async () => {
		const harness = await createHarness();
		try {
			// Write a delegatable preset with state + chat-history slots
			const presetDir = join(harness.tempDir, ".pi", "prompt-presets");
			mkdirSync(presetDir, { recursive: true });
			writeFileSync(
				join(presetDir, "test-peer.json"),
				JSON.stringify({
					schemaVersion: 1,
					id: "test-peer",
					name: "Test Peer",
					delegatable: true,
					items: [
						{ kind: "block", id: "role", enabled: true, role: "system", content: "You are a test peer." },
						{
							kind: "slot",
							id: "state",
							enabled: true,
							role: "system",
							slot: "state",
							options: { allowNamespace: ["world", "secret"], format: "yaml" },
						},
						{
							kind: "slot",
							id: "history",
							enabled: true,
							role: "user",
							slot: "chat-history",
							options: { maxMessages: 10 },
						},
					],
				}),
			);
			harness.session.reloadPresets();

			// Seed parent state and conversation history
			harness.session.stateManager.load({ world: { name: "TestWorld" }, secret: { plot: "hidden" } });
			harness.session.agent.state.messages.push(
				{ role: "user", content: [{ type: "text", text: "Hello world" }], timestamp: Date.now() },
				fauxAssistantMessage("Hi there"),
			);

			const result = await prepareSubagentConversation({
				cwd: harness.tempDir,
				profileId: "test-peer",
				task: "What is the world name?",
				modelRuntime: harness.session.modelRuntime,
				session: harness.session,
				inheritHistory: 10,
			});

			assert.equal(isPrepareError(result), false);
			if (!isPrepareError(result)) {
				const allText = result.messages.map((m) => getMessageText(m)).join("\n");
				assert.ok(allText.includes("Hello world"), "compiled messages should contain parent history");
				assert.ok(allText.includes("TestWorld"), "compiled messages should contain parent state (world)");
				assert.ok(allText.includes("hidden"), "compiled messages should contain parent state (secret)");
			}
		} finally {
			harness.cleanup();
		}
	});

	it("Phase 4b: preset-level inheritHistory seeds parent history without explicit option", async () => {
		const harness = await createHarness();
		try {
			const presetDir = join(harness.tempDir, ".pi", "prompt-presets");
			mkdirSync(presetDir, { recursive: true });
			writeFileSync(
				join(presetDir, "test-peer-hist.json"),
				JSON.stringify({
					schemaVersion: 1,
					id: "test-peer-hist",
					delegatable: true,
					inheritHistory: 2,
					items: [
						{ kind: "block", id: "role", role: "system", content: "You are a history peer." },
						{
							kind: "slot",
							id: "history",
							role: "user",
							slot: "chat-history",
							options: { maxMessages: 10 },
						},
					],
				}),
			);
			harness.session.reloadPresets();

			harness.session.agent.state.messages.push(
				{ role: "user", content: [{ type: "text", text: "message-one" }], timestamp: Date.now() },
				fauxAssistantMessage("message-two"),
				{ role: "user", content: [{ type: "text", text: "message-three" }], timestamp: Date.now() },
			);

			const result = await prepareSubagentConversation({
				cwd: harness.tempDir,
				profileId: "test-peer-hist",
				task: "task",
				modelRuntime: harness.session.modelRuntime,
				session: harness.session,
			});

			assert.equal(isPrepareError(result), false);
			if (!isPrepareError(result)) {
				const allText = result.messages.map((m) => getMessageText(m)).join("\n");
				assert.ok(allText.includes("message-two"), "preset inheritHistory should seed recent parent history");
				assert.ok(allText.includes("message-three"));
				assert.ok(!allText.includes("message-one"), "older messages beyond inheritHistory should be dropped");
			}
		} finally {
			harness.cleanup();
		}
	});

	it("Phase 5: peer completion inherits parent extension tools", async () => {
		let peekCalls = 0;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "web_peek",
						label: "Web Peek",
						description: "Peek a URL",
						parameters: Type.Object({}),
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
			// Minimal delegatable preset with a tools slot so the inherited
			// extension tool's snippet is rendered into the compiled messages.
			const presetDir = join(harness.tempDir, ".pi", "prompt-presets");
			mkdirSync(presetDir, { recursive: true });
			writeFileSync(
				join(presetDir, "test-ext.json"),
				JSON.stringify({
					schemaVersion: 1,
					id: "test-ext",
					delegatable: true,
					items: [
						{ kind: "block", id: "role", enabled: true, role: "system", content: "You are an ext peer." },
						{
							kind: "slot",
							id: "tools",
							enabled: true,
							role: "system",
							slot: "tools",
							options: { onlyWithSnippets: true },
						},
						{
							kind: "block",
							id: "prompt",
							enabled: true,
							role: "user",
							content: "Answer the delegated task.",
						},
					],
				}),
			);
			harness.session.reloadPresets();

			const result = await prepareSubagentConversation({
				cwd: harness.tempDir,
				profileId: "test-ext",
				task: "task",
				modelRuntime: harness.session.modelRuntime,
				session: harness.session,
				// Pin the faux model: the runtime also registers default
				// providers (e.g. amazon-bedrock) without configured auth.
				modelRef: `${harness.getModel().provider}/${harness.getModel().id}`,
			});

			assert.equal(isPrepareError(result), false);
			if (!isPrepareError(result)) {
				assert.ok(
					result.effectiveTools.includes("web_peek"),
					"effectiveTools should include the parent's extension tool",
				);
				assert.ok(
					result.customTools?.some((t) => t.name === "web_peek"),
					"preparation should carry the extension tool definition",
				);
				const allText = result.messages.map((m) => getMessageText(m)).join("\n");
				assert.ok(allText.includes("web_peek"), "compiled messages should render the extension tool snippet");

				// End-to-end: the model calls web_peek inside the subagent
				// session. It must be registered and active there.
				harness.setResponses([
					fauxAssistantMessage([fauxToolCall("web_peek", {})], { stopReason: "toolUse" }),
					fauxAssistantMessage("peeked done"),
				]);
				const runResult = await runSubagent(result, harness.session.modelRuntime);
				assert.equal(runResult.status, "completed", `run error: ${runResult.error ?? "none"}`);
				assert.equal(peekCalls, 1, "extension tool should execute inside the subagent session");
			}
		} finally {
			harness.cleanup();
		}
	});

	it("Phase 6: peer completion resolves {{user}} from the parent session's user name", async () => {
		const harness = await createHarness({ settings: { userName: "凌霜" } });
		try {
			const presetDir = join(harness.tempDir, ".pi", "prompt-presets");
			mkdirSync(presetDir, { recursive: true });
			writeFileSync(
				join(presetDir, "test-user-macro.json"),
				JSON.stringify({
					schemaVersion: 1,
					id: "test-user-macro",
					delegatable: true,
					items: [
						{
							kind: "block",
							id: "role",
							enabled: true,
							role: "system",
							content: "Player display name: {{user}}",
						},
					],
				}),
			);
			harness.session.reloadPresets();

			const result = await prepareSubagentConversation({
				cwd: harness.tempDir,
				profileId: "test-user-macro",
				task: "task",
				modelRuntime: harness.session.modelRuntime,
				session: harness.session,
			});

			assert.equal(isPrepareError(result), false);
			if (!isPrepareError(result)) {
				const allText = result.messages.map((m) => getMessageText(m)).join("\n");
				assert.ok(allText.includes("Player display name: 凌霜"), `{{user}} unresolved in: ${allText}`);
				assert.ok(
					!allText.includes("Player display name: user"),
					"{{user}} must not fall back to the literal 'user' when a parent session exists",
				);
			}
		} finally {
			harness.cleanup();
		}
	});

	it("Phase 6b: preset static variables compile, and the session user name wins on collision", async () => {
		const harness = await createHarness({ settings: { userName: "凌霜" } });
		try {
			const presetDir = join(harness.tempDir, ".pi", "prompt-presets");
			mkdirSync(presetDir, { recursive: true });
			writeFileSync(
				join(presetDir, "test-preset-vars.json"),
				JSON.stringify({
					schemaVersion: 1,
					id: "test-preset-vars",
					delegatable: true,
					variables: { era: "承平七年", user: "should-be-overridden" },
					items: [
						{
							kind: "block",
							id: "role",
							enabled: true,
							role: "system",
							content: "Era: {{era}} / Player: {{user}}",
						},
					],
				}),
			);
			harness.session.reloadPresets();

			const result = await prepareSubagentConversation({
				cwd: harness.tempDir,
				profileId: "test-preset-vars",
				task: "task",
				modelRuntime: harness.session.modelRuntime,
				session: harness.session,
			});

			assert.equal(isPrepareError(result), false);
			if (!isPrepareError(result)) {
				const allText = result.messages.map((m) => getMessageText(m)).join("\n");
				assert.ok(allText.includes("Era: 承平七年"), `preset variable unresolved in: ${allText}`);
				assert.ok(allText.includes("Player: 凌霜"), "session user name must win over the preset static");
				assert.ok(!allText.includes("should-be-overridden"));
			}
		} finally {
			harness.cleanup();
		}
	});

	it("Phase 7: default subagent tool set includes write/edit (C1)", async () => {
		const harness = await createHarness();
		try {
			const presetDir = join(harness.tempDir, ".pi", "prompt-presets");
			mkdirSync(presetDir, { recursive: true });
			writeFileSync(
				join(presetDir, "test-tools-default.json"),
				JSON.stringify({
					schemaVersion: 1,
					id: "test-tools-default",
					delegatable: true,
					items: [{ kind: "block", id: "role", enabled: true, role: "system", content: "You are a tools peer." }],
				}),
			);
			harness.session.reloadPresets();

			const result = await prepareSubagentConversation({
				cwd: harness.tempDir,
				profileId: "test-tools-default",
				task: "task",
				modelRuntime: harness.session.modelRuntime,
				session: harness.session,
			});

			assert.equal(isPrepareError(result), false);
			if (!isPrepareError(result)) {
				// The harness session registers memory extension tools, so the
				// effective set is DEFAULT + inherited extensions — assert the
				// full default set (now including write/edit) is present.
				for (const tool of DEFAULT_SUBAGENT_TOOLS) {
					assert.ok(result.effectiveTools.includes(tool), `default set must include ${tool}`);
				}
			}
		} finally {
			harness.cleanup();
		}
	});

	it("Phase 7b: preset tools.allow can select write from the expanded default set (C2)", async () => {
		// policy.ts is a filter, not a whitelist expander: an allow entry can
		// only keep a tool that is already in the input set. Before C1 the
		// default set had no write/edit, so allow could never select them.
		// With the expanded default set, allow picks them out in input order.
		assert.deepEqual(
			applyResourcePolicy([...DEFAULT_SUBAGENT_TOOLS], { allow: ["read", "bash", "write"] }),
			["read", "bash", "write"],
			"allow must select tools present in the (expanded) default set",
		);

		const harness = await createHarness();
		try {
			const presetDir = join(harness.tempDir, ".pi", "prompt-presets");
			mkdirSync(presetDir, { recursive: true });
			writeFileSync(
				join(presetDir, "test-tools-allow.json"),
				JSON.stringify({
					schemaVersion: 1,
					id: "test-tools-allow",
					delegatable: true,
					tools: { allow: ["read", "bash", "write"] },
					items: [{ kind: "block", id: "role", enabled: true, role: "system", content: "You are a tools peer." }],
				}),
			);
			harness.session.reloadPresets();

			const result = await prepareSubagentConversation({
				cwd: harness.tempDir,
				profileId: "test-tools-allow",
				task: "task",
				modelRuntime: harness.session.modelRuntime,
				session: harness.session,
			});

			assert.equal(isPrepareError(result), false);
			if (!isPrepareError(result)) {
				// The expanded default set reaches the subagent pipeline, so
				// the preset's allow policy can keep write/edit instead of
				// silently dropping them.
				assert.ok(result.effectiveTools.includes("write"), "default set must include write for allow to select it");
				assert.ok(result.effectiveTools.includes("edit"), "default set must include edit for allow to select it");
			}
		} finally {
			harness.cleanup();
		}
	});

	it("Phase 7c: spawnAgent without tools exposes the same default set as subagent (C1/C2 alignment)", async () => {
		const harness = await createHarness();
		harness.setResponses([fauxAssistantMessage("done")]);
		let activeTools: string[] | undefined;
		try {
			const presetDir = join(harness.tempDir, ".pi", "prompt-presets");
			mkdirSync(presetDir, { recursive: true });
			writeFileSync(
				join(presetDir, "test-spawn.json"),
				JSON.stringify({
					schemaVersion: 1,
					id: "test-spawn",
					delegatable: true,
					items: [{ kind: "block", id: "role", enabled: true, role: "system", content: "You are a spawn peer." }],
				}),
			);
			harness.session.reloadPresets();

			const spawnResult = await spawnAgent(harness.session, {
				profileId: "test-spawn",
				task: "task",
				model: harness.getModel(),
				onSessionCreated: (sub) => {
					activeTools = sub.getActiveToolNames();
				},
			});

			assert.equal(spawnResult.status, "completed", `spawn error: ${spawnResult.error ?? "none"}`);
			assert.ok(activeTools, "onSessionCreated must fire");
			for (const tool of DEFAULT_SUBAGENT_TOOLS) {
				assert.ok(activeTools!.includes(tool), `spawned session must expose ${tool}`);
			}
		} finally {
			harness.cleanup();
		}
	});

	it("Phase 8: runSubagent runs its session in the preparation's cwd (C5)", async () => {
		const harness = await createHarness();
		harness.setResponses([fauxAssistantMessage("done from custom cwd")]);
		let subSessionCwd: string | undefined;
		try {
			const presetDir = join(harness.tempDir, ".pi", "prompt-presets");
			mkdirSync(presetDir, { recursive: true });
			writeFileSync(
				join(presetDir, "test-cwd.json"),
				JSON.stringify({
					schemaVersion: 1,
					id: "test-cwd",
					delegatable: true,
					items: [{ kind: "block", id: "role", enabled: true, role: "system", content: "You are a cwd peer." }],
				}),
			);
			harness.session.reloadPresets();

			const preparation = await prepareSubagentConversation({
				cwd: harness.tempDir,
				profileId: "test-cwd",
				task: "task",
				modelRuntime: harness.session.modelRuntime,
				session: harness.session,
			});
			assert.equal(isPrepareError(preparation), false);
			assert.notEqual(process.cwd(), harness.tempDir, "test must use a cwd different from process cwd");
			if (!isPrepareError(preparation)) {
				const runResult = await runSubagent(preparation, harness.session.modelRuntime, {
					onSessionCreated: (sub) => {
						subSessionCwd = sub.sessionManager.getCwd();
					},
				});
				assert.equal(runResult.status, "completed", `run error: ${runResult.error ?? "none"}`);
				assert.equal(subSessionCwd, harness.tempDir, "subagent session must run in the preparation cwd");
			}
		} finally {
			harness.cleanup();
		}
	});
});
