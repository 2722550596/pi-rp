/**
 * streamFn 自管态 + 宿主自定义 provider：模型不在内置表（modelsPath: null）时，prompt 前置的
 * hasConfiguredAuth 门也必须放行，请求整体交给 streamFn。
 */

import { afterEach, expect, it, vi } from "vitest";
import { type ExecutionEnv, type HarnessEnv, negotiate } from "../../agent/src/harness/capabilities.ts";
import { createAssistantMessageEventStream } from "../../ai/src/utils/event-stream.ts";
import { MemoryStorageBackend } from "../../coding-agent/test/resource-supply-mocks.ts";
import { type CreatePiHarnessOptions, createPiHarness, type PiHarness } from "../src/assemble.ts";

vi.mock("../src/export-html-assets.ts", () => ({ execExportTemplateAssets: () => {} }));

const cwd = "/workspace/custom-provider";
const created: PiHarness[] = [];

afterEach(async () => {
	await Promise.all(created.splice(0).map((harness) => harness.dispose()));
});

function hostedEnv(): HarnessEnv {
	const env = {
		cwd,
		exec: async () => {
			throw new Error("must not execute shell commands");
		},
		cleanup: async () => {},
	} as unknown as ExecutionEnv;
	return { env, capabilities: negotiate({ shell: env }) };
}

it("prompts through streamFn for a host model whose provider is not in the built-in registry", async () => {
	const model = {
		id: "host-model",
		name: "Host model",
		api: "openai-completions",
		provider: "host-gateway",
		baseUrl: "https://gateway.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32768,
		maxTokens: 4096,
	} as CreatePiHarnessOptions["model"];
	const calls: Array<{ provider: string; id: string }> = [];
	const streamFn = (requestModel: { provider: string; id: string; api: string }) => {
		calls.push({ provider: requestModel.provider, id: requestModel.id });
		const stream = createAssistantMessageEventStream();
		const message = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "hello from gateway" }],
			api: requestModel.api,
			provider: requestModel.provider,
			model: requestModel.id,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop" as const,
			timestamp: Date.now(),
		};
		queueMicrotask(() => {
			stream.push({ type: "start", partial: message });
			stream.push({ type: "done", reason: "stop", message });
			stream.end();
		});
		return stream;
	};
	const harness = await createPiHarness({
		profile: "hosted",
		env: hostedEnv(),
		cwd,
		model,
		stores: {
			storage: new MemoryStorageBackend("opfs"),
			locks: { lockSync: () => () => {}, lockAsync: async () => async () => {} },
			paths: { agentDir: () => "/state/agent" },
		},
		llm: { streamFn } as unknown as NonNullable<CreatePiHarnessOptions["llm"]>,
	});
	created.push(harness);

	await harness.session.prompt("hi");

	expect(calls).toEqual([{ provider: "host-gateway", id: "host-model" }]);
	const last = harness.session.agent.state.messages.at(-1);
	expect(last).toMatchObject({ role: "assistant", stopReason: "stop" });
});
