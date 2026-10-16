import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";

const bedrockMock = vi.hoisted(() => ({
	constructorCalls: [] as Array<Record<string, unknown>>,
	streamEvents: undefined as unknown[] | undefined,
}));

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
	class BedrockRuntimeServiceException extends Error {}

	class BedrockRuntimeClient {
		constructor(config: Record<string, unknown>) {
			bedrockMock.constructorCalls.push(config);
		}

		send(): Promise<unknown> {
			if (bedrockMock.streamEvents) {
				const events = bedrockMock.streamEvents;
				return Promise.resolve({
					$metadata: { httpStatusCode: 200 },
					stream: (async function* () {
						yield* events;
					})(),
				});
			}
			return Promise.reject(new Error("mock send"));
		}
	}

	class ConverseStreamCommand {
		readonly input: unknown;

		constructor(input: unknown) {
			this.input = input;
		}
	}

	return {
		BedrockRuntimeClient,
		BedrockRuntimeServiceException,
		ConverseStreamCommand,
		StopReason: {
			END_TURN: "end_turn",
			STOP_SEQUENCE: "stop_sequence",
			MAX_TOKENS: "max_tokens",
			MODEL_CONTEXT_WINDOW_EXCEEDED: "model_context_window_exceeded",
			TOOL_USE: "tool_use",
		},
		CachePointType: { DEFAULT: "default" },
		CacheTTL: { ONE_HOUR: "ONE_HOUR" },
		ConversationRole: { ASSISTANT: "assistant", USER: "user" },
		ImageFormat: { JPEG: "jpeg", PNG: "png", GIF: "gif", WEBP: "webp" },
		ToolResultStatus: { ERROR: "error", SUCCESS: "success" },
	};
});

import { stream as streamBedrock, streamSimple as streamBedrockSimple } from "../src/api/bedrock-converse-stream.ts";
import type { Context, Message, Model, StreamOptions } from "../src/types.ts";

const baseModel: Model<"bedrock-converse-stream"> = {
	id: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
	name: "Claude Sonnet 4.5 (US)",
	api: "bedrock-converse-stream",
	provider: "amazon-bedrock",
	baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	contextWindow: 200000,
	maxTokens: 64000,
	compat: { supportsStrictMode: true },
};

const novaModel: Model<"bedrock-converse-stream"> = {
	...baseModel,
	id: "amazon.nova-lite-v1:0",
	name: "Nova Lite",
	reasoning: false,
	compat: undefined,
};

async function capturePayload(context: Context, model = baseModel, options: StreamOptions = {}): Promise<unknown> {
	let capturedPayload: unknown;
	const s = streamBedrock(model, context, {
		cacheRetention: "none",
		signal: AbortSignal.abort(),
		...options,
		onPayload: (payload) => {
			capturedPayload = payload;
			return payload;
		},
	});
	for await (const event of s) {
		if (event.type === "error") break;
	}
	return capturedPayload;
}

describe("Bedrock compiled cache boundary", () => {
	it.each([
		["U2\n\nTAIL", 3, 1],
		["TAIL", 3, 1],
		["TAIL", undefined, 2],
		["TAIL", 0, -1],
	])("anchors %s with boundary %s", async (tail, volatileFrom, expected) => {
		const messages: Message[] = [
			{ role: "system", content: "SYS", timestamp: 0 },
			{ role: "user", content: "H", timestamp: 0 },
			{
				role: "assistant",
				content: [{ type: "text", text: "A" }],
				api: baseModel.api,
				provider: baseModel.provider,
				model: baseModel.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 0,
			},
			{ role: "user", content: tail, timestamp: 0 },
		];
		const payload = (await capturePayload({ messages }, baseModel, {
			cacheRetention: "short",
			...(volatileFrom !== undefined ? { volatileFrom } : {}),
		})) as { messages: Array<{ content: Array<{ cachePoint?: unknown }> }> };
		expect(
			payload.messages.flatMap((message, index) =>
				message.content.some((block) => block.cachePoint) ? [index] : [],
			),
		).toEqual(expected < 0 ? [] : [expected]);
	});
	it("excludes a tool-result group spanning the boundary", async () => {
		let payload: { messages: Array<{ content: Array<{ cachePoint?: unknown }> }> } | undefined;
		const call: Message = {
			role: "assistant",
			content: ["one", "two"].map((id) => ({ type: "toolCall", id, name: "read", arguments: {} })),
			api: baseModel.api,
			provider: baseModel.provider,
			model: baseModel.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 0,
		};
		const results: Message[] = ["one", "two"].map((id) => ({
			role: "toolResult",
			toolCallId: id,
			toolName: "read",
			content: [{ type: "text", text: id }],
			isError: false,
			timestamp: 0,
		}));
		await streamBedrockSimple(
			baseModel,
			{ messages: [{ role: "user", content: "H", timestamp: 0 }, call, ...results] },
			{
				cacheRetention: "short",
				volatileFrom: 3,
				onPayload: (value) => {
					payload = value as typeof payload;
					throw new Error("captured");
				},
			},
		).result();
		expect(
			payload?.messages.flatMap((message, index) =>
				message.content.some((block) => block.cachePoint) ? [index] : [],
			),
		).toEqual([1]);
	});
});

describe("Bedrock constrained sampling", () => {
	it("gates native strict tool use by model capability", async () => {
		const context: Context = {
			messages: [{ role: "user", content: "Use the tool", timestamp: Date.now() }],
			tools: [
				{
					name: "lookup",
					description: "Look up a value",
					parameters: Type.Object({ value: Type.String() }),
					constrainedSampling: { type: "json_schema", strict: "require" },
				},
			],
		};
		const payload = await capturePayload(context);
		const toolConfig = (payload as { toolConfig: { tools: Array<{ toolSpec: { strict?: boolean } }> } }).toolConfig;
		expect(toolConfig.tools[0].toolSpec.strict).toBe(true);

		context.tools![0].constrainedSampling = { type: "json_schema", strict: "prefer" };
		const novaPayload = await capturePayload(context, novaModel);
		const novaToolConfig = (
			novaPayload as {
				toolConfig: { tools: Array<{ toolSpec: { strict?: boolean } }> };
			}
		).toolConfig;
		expect(novaToolConfig.tools[0].toolSpec.strict).toBeUndefined();
	});
});

describe("Bedrock tool arguments", () => {
	it("preserves empty property names in streamed tool arguments", async () => {
		bedrockMock.streamEvents = [
			{ messageStart: { role: "assistant" } },
			{
				contentBlockStart: {
					contentBlockIndex: 0,
					start: { toolUse: { toolUseId: "tool-1", name: "edit" } },
				},
			},
			{
				contentBlockDelta: {
					contentBlockIndex: 0,
					delta: {
						toolUse: {
							input: '{"path":"/workspace/foobar/file.js","edits":[{"oldText":"first","newText":"updated first"},{"oldText":"second","newText":"updated second","":""}]}',
						},
					},
				},
			},
			{ contentBlockStop: { contentBlockIndex: 0 } },
			{ messageStop: { stopReason: "tool_use" } },
		];

		try {
			const message = await streamBedrock(
				baseModel,
				{ messages: [{ role: "user", content: "Use the tool", timestamp: Date.now() }] },
				{ cacheRetention: "none" },
			).result();

			expect(message.content[0]).toEqual({
				type: "toolCall",
				id: "tool-1",
				name: "edit",
				arguments: {
					path: "/workspace/foobar/file.js",
					edits: [
						{ oldText: "first", newText: "updated first" },
						{ oldText: "second", newText: "updated second", "": "" },
					],
				},
			});
		} finally {
			bedrockMock.streamEvents = undefined;
		}
	});
});

describe("bedrock convertMessages skips unknown content types", () => {
	it("skips unknown user content blocks instead of throwing", async () => {
		const messages: Message[] = [
			{
				role: "user",
				content: [
					{ type: "text", text: "hello" },
					{ type: "unknown", data: "foo" },
				] as any,
				timestamp: Date.now(),
			},
		];
		const payload = await capturePayload({ messages });
		expect(payload).toBeDefined();
		const p = payload as { messages: Array<{ role: string; content: unknown[] }> };
		expect(p.messages).toHaveLength(1);
		expect(p.messages[0].content).toHaveLength(1);
		expect(p.messages[0].content[0]).toEqual({ text: "hello" });
	});

	it("skips unknown assistant content blocks instead of throwing", async () => {
		const messages: Message[] = [
			{
				role: "assistant",
				content: [
					{ type: "text", text: "hello" },
					{ type: "unknown", data: "foo" },
				] as any,
				api: "bedrock-converse-stream",
				provider: "amazon-bedrock",
				model: baseModel.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			},
		];
		const payload = await capturePayload({ messages });
		expect(payload).toBeDefined();
		const p = payload as { messages: Array<{ role: string; content: unknown[] }> };
		expect(p.messages).toHaveLength(1);
		expect(p.messages[0].content).toHaveLength(1);
		expect(p.messages[0].content[0]).toEqual({ text: "hello" });
	});

	it("replaces user messages with only unknown content blocks with a placeholder", async () => {
		const messages: Message[] = [
			{
				role: "user",
				content: [{ type: "unknown", data: "foo" }] as any,
				timestamp: Date.now(),
			},
		];
		const payload = await capturePayload({ messages });
		expect(payload).toBeDefined();
		const p = payload as { messages: Array<{ role: string; content: unknown[] }> };
		expect(p.messages).toHaveLength(1);
		expect(p.messages[0].content).toEqual([{ text: "<empty>" }]);
	});

	it("replaces blank user string content with a placeholder", async () => {
		const payload = await capturePayload({
			messages: [{ role: "user", content: "   ", timestamp: Date.now() }],
		});
		expect(payload).toBeDefined();
		const p = payload as { messages: Array<{ role: string; content: unknown[] }> };
		expect(p.messages).toHaveLength(1);
		expect(p.messages[0].content).toEqual([{ text: "<empty>" }]);
	});

	it("filters blank user text blocks when other content remains", async () => {
		const payload = await capturePayload({
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "" },
						{ type: "text", text: "hello" },
					],
					timestamp: Date.now(),
				},
			],
		});
		expect(payload).toBeDefined();
		const p = payload as { messages: Array<{ role: string; content: unknown[] }> };
		expect(p.messages).toHaveLength(1);
		expect(p.messages[0].content).toEqual([{ text: "hello" }]);
	});

	it("replaces user content emptied by surrogate sanitization with a placeholder", async () => {
		const payload = await capturePayload({
			messages: [{ role: "user", content: String.fromCharCode(0xd83d), timestamp: Date.now() }],
		});
		expect(payload).toBeDefined();
		const p = payload as { messages: Array<{ role: string; content: unknown[] }> };
		expect(p.messages).toHaveLength(1);
		expect(p.messages[0].content).toEqual([{ text: "<empty>" }]);
	});

	it("skips assistant text blocks emptied by surrogate sanitization", async () => {
		const messages: Message[] = [
			{
				role: "assistant",
				content: [{ type: "text", text: String.fromCharCode(0xd83d) }],
				api: "bedrock-converse-stream",
				provider: "amazon-bedrock",
				model: baseModel.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			},
		];
		const payload = await capturePayload({ messages });
		expect(payload).toBeDefined();
		const p = payload as { messages: Array<{ role: string; content: unknown[] }> };
		expect(p.messages).toHaveLength(0);
	});

	it("replaces blank tool result content with a placeholder", async () => {
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tool-1",
				toolName: "tool",
				content: [{ type: "text", text: "" }],
				isError: false,
				timestamp: Date.now(),
			},
		];
		const payload = await capturePayload({ messages });
		expect(payload).toBeDefined();
		const p = payload as {
			messages: Array<{ role: string; content: Array<{ toolResult: { content: unknown[] } }> }>;
		};
		expect(p.messages).toHaveLength(1);
		expect(p.messages[0].content[0].toolResult.content).toEqual([{ text: "<empty>" }]);
	});

	it("skips assistant messages with only unknown content blocks", async () => {
		const messages: Message[] = [
			{
				role: "assistant",
				content: [{ type: "unknown", data: "foo" }] as any,
				api: "bedrock-converse-stream",
				provider: "amazon-bedrock",
				model: baseModel.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			},
		];
		const payload = await capturePayload({ messages });
		expect(payload).toBeDefined();
		const p = payload as { messages: Array<{ role: string; content: unknown[] }> };
		expect(p.messages).toHaveLength(0);
	});

	it("removes empty property names only from replayed Bedrock input", async () => {
		const toolArguments = {
			path: "/workspace/foobar/file.js",
			edits: [
				{ oldText: "first", newText: "updated first" },
				{ oldText: "second", newText: "updated second", "": "" },
			],
		};
		const messages: Message[] = [
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "tool-1",
						name: "edit",
						arguments: toolArguments,
					},
				],
				api: "bedrock-converse-stream",
				provider: "amazon-bedrock",
				model: baseModel.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
			{
				role: "toolResult",
				toolCallId: "tool-1",
				toolName: "edit",
				content: [{ type: "text", text: "done" }],
				isError: false,
				timestamp: Date.now(),
			},
			{ role: "user", content: "Continue", timestamp: Date.now() },
		];

		const payload = await capturePayload({ messages });
		const p = payload as {
			messages: Array<{ content: Array<{ toolUse?: { input: unknown } }> }>;
		};
		expect(p.messages[0].content[0].toolUse?.input).toEqual({
			path: "/workspace/foobar/file.js",
			edits: [
				{ oldText: "first", newText: "updated first" },
				{ oldText: "second", newText: "updated second" },
			],
		});
		expect(toolArguments.edits[1]).toEqual({ oldText: "second", newText: "updated second", "": "" });
	});
});
