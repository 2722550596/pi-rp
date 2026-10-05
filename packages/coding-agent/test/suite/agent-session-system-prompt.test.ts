import { strict as assert } from "node:assert";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, it } from "vitest";
import { createAgentSessionScope } from "../../src/core/session-scope.ts";
import { createHarness } from "./harness.ts";

describe("AgentSession - system prompt", () => {
	it("Phase 0: context.systemPrompt remains empty across multiple turns when using presets", async () => {
		const harness = await createHarness();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: "package.json" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		try {
			await harness.session.prompt("test");
			await harness.session.waitForIdle();
			assert.ok(harness.session.messages.length > 0);
		} finally {
			harness.cleanup();
		}
	});
	it("adds runtime-only context to provider systemPrompt without persisting it", async () => {
		let renderCount = 0;
		const scope = createAgentSessionScope({
			runtimeContextSlots: [
				{
					id: "private",
					render: () => {
						renderCount++;
						return "runtime marker";
					},
				},
			],
		});
		const harness = await createHarness({ scope });
		const providerContexts: Array<{ systemPrompt?: string }> = [];
		const originalStream = harness.session.agent.streamFunction;
		harness.session.agent.streamFunction = (model, context, options) => {
			providerContexts.push(context);
			return originalStream(model, context, options);
		};
		try {
			await harness.session.prompt("first");
			await harness.session.prompt("second");
			assert.ok(providerContexts.length >= 2);
			assert.match(providerContexts[0]?.systemPrompt ?? "", /runtime marker/);
			assert.equal(renderCount, 1);
			assert.ok(!JSON.stringify(harness.session.messages).includes("runtime marker"));
		} finally {
			harness.cleanup();
			scope.dispose();
		}
	});
	it("keeps initial runtime context on the first provider call and retry", async () => {
		let renderCount = 0;
		const scope = createAgentSessionScope({
			runtimeContextSlots: [
				{
					id: "retry-context",
					render: () => {
						renderCount++;
						return "retry runtime marker";
					},
				},
			],
		});
		const harness = await createHarness({
			scope,
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
		});
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("recovered"),
		]);
		const contexts: Array<{ systemPrompt?: string }> = [];
		const originalStream = harness.session.agent.streamFunction;
		harness.session.agent.streamFunction = (model, context, options) => {
			contexts.push(context);
			return originalStream(model, context, options);
		};
		try {
			await harness.session.prompt("test");
			expect(contexts).toHaveLength(2);
			expect(contexts.every((context) => context.systemPrompt?.includes("retry runtime marker"))).toBe(true);
			expect(renderCount).toBe(1);
		} finally {
			harness.cleanup();
			scope.dispose();
		}
	});
});
