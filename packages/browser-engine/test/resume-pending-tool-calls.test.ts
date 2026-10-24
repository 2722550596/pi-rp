/**
 * 进程在工具执行中被杀：会话档里留下没有结果的 toolCall。续档后
 * continueSession({ resumePendingToolCalls: true }) 让 replay:"safe" 的工具以同一 id 重跑。
 */

import { afterEach, expect, it, vi } from "vitest";
import { type ExecutionEnv, type HarnessEnv, negotiate } from "../../agent/src/harness/capabilities.ts";
import { createAssistantMessageEventStream } from "../../ai/src/utils/event-stream.ts";
import { MemoryStorageBackend } from "../../coding-agent/test/resource-supply-mocks.ts";
import type { CreatePiHarnessOptions } from "../src/assemble.ts";
import { type BrowserPiHarness, createPiHarnessWithTools } from "../src/extended-harness.ts";
import { SessionManager } from "../src/index.ts";

vi.mock("../src/export-html-assets.ts", () => ({ execExportTemplateAssets: () => {} }));

const cwd = "/workspace/resume";
const sessionDir = "/state/sessions";
const created: BrowserPiHarness[] = [];

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

type Reply = { toolCall?: { id: string; name: string; arguments: Record<string, unknown> }; text?: string };

function scriptedStreamFn(replies: Reply[]) {
	return (requestModel: { provider: string; id: string; api: string }) => {
		const reply = replies.shift() ?? { text: "done" };
		const stream = createAssistantMessageEventStream();
		const message = {
			role: "assistant" as const,
			content: reply.toolCall
				? [{ type: "toolCall" as const, ...reply.toolCall }]
				: [{ type: "text" as const, text: reply.text ?? "" }],
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
			stopReason: reply.toolCall ? ("toolUse" as const) : ("stop" as const),
			timestamp: Date.now(),
		};
		queueMicrotask(() => {
			stream.push({ type: "start", partial: message });
			stream.push({ type: "done", reason: message.stopReason, message });
			stream.end();
		});
		return stream;
	};
}

async function openHarness(
	storage: MemoryStorageBackend,
	replies: Reply[],
	speak: (toolCallId: string, text: string) => Promise<void>,
): Promise<BrowserPiHarness> {
	return createPiHarnessWithTools({
		profile: "hosted",
		env: hostedEnv(),
		cwd,
		model,
		stores: {
			storage,
			locks: { lockSync: () => () => {}, lockAsync: async () => async () => {} },
			paths: { agentDir: () => "/state/agent" },
		},
		storage: { sessionManager: SessionManager.continueRecent(cwd, sessionDir, storage) },
		llm: { streamFn: scriptedStreamFn(replies) } as unknown as NonNullable<CreatePiHarnessOptions["llm"]>,
		tools: {
			enabled: ["speak"],
			custom: [
				{
					definition: {
						name: "speak",
						label: "speak",
						description: "say something",
						parameters: {
							type: "object",
							properties: { text: { type: "string" } },
							required: ["text"],
						} as never,
						replay: "safe",
					},
					handler: async (toolCallId, params) => {
						await speak(toolCallId, (params as { text: string }).text);
						return { content: [{ type: "text", text: "sent" }], terminate: true };
					},
				},
			],
		},
	});
}

it("replays a replay-safe tool call that was cut off by a process kill", async () => {
	const storage = new MemoryStorageBackend("opfs");

	// 第一次：speak 开始执行后永不返回 —— 模拟进程在工具执行中被杀（不 dispose，直接丢弃）。
	let started!: () => void;
	const speakStarted = new Promise<void>((resolve) => {
		started = resolve;
	});
	const first = await openHarness(
		storage,
		[{ toolCall: { id: "call-1", name: "speak", arguments: { text: "hello" } } }],
		async () => {
			started();
			await new Promise(() => {});
		},
	);
	void first.session.prompt("hi");
	await speakStarted;

	// 第二次：同一存储续档，结果缺失的 speak 以同一 id 重跑；speak 终止批次，不再请求模型。
	const spoken: string[] = [];
	const second = await openHarness(storage, [], async (toolCallId, text) => {
		spoken.push(`${toolCallId}:${text}`);
	});
	created.push(second);
	expect(second.session.agent.getPendingToolCalls()?.toolCalls.map((call) => call.id)).toEqual(["call-1"]);

	expect(await second.session.continueSession({ resumePendingToolCalls: true })).toBe(true);

	expect(spoken).toEqual(["call-1:hello"]);
	const roles = second.session.agent.state.messages.map((message) => message.role);
	expect(roles).toEqual(["user", "assistant", "toolResult"]);
	const persisted = second.session.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "message")
		.map((entry) => (entry as { message: { role: string } }).message.role);
	expect(persisted).toEqual(["user", "assistant", "toolResult"]);
});
