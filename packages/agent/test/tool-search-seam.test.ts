import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
	type UserMessage,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { agentLoop } from "../src/agent-loop.ts";
import type { AgentContext, AgentLoopConfig, AgentMessage, AgentTool } from "../src/types.ts";

// Mock stream for testing - mimics MockAssistantStream
class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createModel(): Model<"openai-responses"> {
	return {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function createAssistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: createUsage(),
		stopReason,
		timestamp: Date.now(),
	};
}

function createUserMessage(text: string): UserMessage {
	return {
		role: "user",
		content: text,
		timestamp: Date.now(),
	};
}

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

const echoSchema = Type.Object({ value: Type.String() });

function createEchoTool(executed: string[]): AgentTool<typeof echoSchema, { value: string }> {
	return {
		name: "echo",
		label: "Echo",
		description: "Echoes the given value",
		parameters: echoSchema,
		async execute(_toolCallId, params) {
			executed.push(params.value);
			return {
				content: [{ type: "text", text: `echoed: ${params.value}` }],
				details: { value: params.value },
			};
		},
	};
}

/**
 * Drives a two-request run: the first LLM response is `firstMessage`, the second is a
 * plain "done" text response. Tracks request count and ordering markers.
 */
function createTwoTurnStreamFn(sequence: string[], firstMessage: AssistantMessage) {
	let llmRequests = 0;
	return () => {
		llmRequests++;
		sequence.push(`llm-request-${llmRequests}`);
		const stream = new MockAssistantStream();
		queueMicrotask(() => {
			if (llmRequests === 1) {
				stream.push({ type: "done", reason: firstMessage.stopReason, message: firstMessage });
			} else {
				stream.push({
					type: "done",
					reason: "stop",
					message: createAssistantMessage([{ type: "text", text: "done" }]),
				});
			}
		});
		return stream;
	};
}

function findToolResult(messages: AgentMessage[]) {
	const toolResult = messages.find((message) => message.role === "toolResult");
	return toolResult?.role === "toolResult" ? toolResult : undefined;
}

function joinWarnings(spy: ReturnType<typeof vi.spyOn>): string {
	return spy.mock.calls.map((args) => args.map((arg) => String(arg)).join(" ")).join("\n");
}

describe("onToolBatchCompleted (batch seam)", () => {
	it("fires exactly once per batch, after tool results land in context and before the next LLM request", async () => {
		const executed: string[] = [];
		const tool = createEchoTool(executed);
		const sequence: string[] = [];
		const batchToolCallIds: string[][] = [];
		const toolResultRolesAtSeam: number[] = [];

		const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			onToolBatchCompleted: (toolResults, batchContext) => {
				sequence.push("batch-seam");
				batchToolCallIds.push(toolResults.map((result) => result.toolCallId));
				toolResultRolesAtSeam.push(batchContext.messages.filter((message) => message.role === "toolResult").length);
			},
		};

		const streamFn = createTwoTurnStreamFn(
			sequence,
			createAssistantMessage(
				[
					{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "first" } },
					{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "second" } },
				],
				"toolUse",
			),
		);

		const messages = await agentLoop([createUserMessage("run both")], context, config, undefined, streamFn).result();

		expect(executed).toEqual(["first", "second"]);
		// The seam runs after the batch is finalized and before the next assistant request.
		expect(sequence).toEqual(["llm-request-1", "batch-seam", "llm-request-2"]);
		// Exactly one invocation per batch, carrying the whole batch in order.
		expect(batchToolCallIds).toEqual([["tool-1", "tool-2"]]);
		// Both tool results are already appended to context.messages when the seam runs.
		expect(toolResultRolesAtSeam).toEqual([2]);
		// The loop continued and completed normally.
		const last = messages[messages.length - 1];
		expect(last.role === "assistant" ? last.stopReason : undefined).toBe("stop");
	});

	it("is not called when the turn has no tool calls", async () => {
		const seamCalls: number[] = [];
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [] };
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			onToolBatchCompleted: () => {
				seamCalls.push(1);
			},
		};

		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({
					type: "done",
					reason: "stop",
					message: createAssistantMessage([{ type: "text", text: "hi" }]),
				});
			});
			return stream;
		};

		await agentLoop([createUserMessage("hello")], context, config, undefined, streamFn).result();

		expect(seamCalls).toEqual([]);
	});

	it("records a diagnostic and keeps the loop running when the callback throws", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const executed: string[] = [];
			const tool = createEchoTool(executed);
			const sequence: string[] = [];
			let seamCalls = 0;

			const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
			const config: AgentLoopConfig = {
				model: createModel(),
				convertToLlm: identityConverter,
				onToolBatchCompleted: () => {
					seamCalls++;
					throw new Error("boom");
				},
			};

			const streamFn = createTwoTurnStreamFn(
				sequence,
				createAssistantMessage(
					[{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }],
					"toolUse",
				),
			);

			const messages = await agentLoop([createUserMessage("run")], context, config, undefined, streamFn).result();

			// The throwing callback did not interrupt the loop: the next request still ran.
			expect(seamCalls).toBe(1);
			expect(executed).toEqual(["hello"]);
			expect(sequence).toEqual(["llm-request-1", "llm-request-2"]);
			const last = messages[messages.length - 1];
			expect(last.role === "assistant" ? last.stopReason : undefined).toBe("stop");
			// The error is observable through the loop diagnostic channel.
			const warnings = joinWarnings(warnSpy);
			expect(warnings).toContain("[agent-loop] onToolBatchCompleted failed");
			expect(warnings).toContain("boom");
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("fires once for the synthesized failure batch of a length-truncated assistant message", async () => {
		const executed: string[] = [];
		const tool = createEchoTool(executed);
		const sequence: string[] = [];
		const batchToolCallIds: string[][] = [];

		const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			onToolBatchCompleted: (toolResults) => {
				sequence.push("batch-seam");
				batchToolCallIds.push(toolResults.map((result) => result.toolCallId));
			},
		};

		const streamFn = createTwoTurnStreamFn(
			sequence,
			createAssistantMessage(
				[{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hel" } }],
				"length",
			),
		);

		const messages = await agentLoop([createUserMessage("run")], context, config, undefined, streamFn).result();

		// Truncated calls never execute, but the synthesized error batch still finalizes the seam.
		expect(executed).toEqual([]);
		expect(sequence).toEqual(["llm-request-1", "batch-seam", "llm-request-2"]);
		expect(batchToolCallIds).toEqual([["tool-1"]]);
		const toolResult = findToolResult(messages);
		expect(toolResult?.isError).toBe(true);
	});
});

describe("resolveToolAvailability (folded tool guidance)", () => {
	it("returns the deferred guidance as an error tool result without executing the tool", async () => {
		const executed: string[] = [];
		const tool = createEchoTool(executed);
		const guidance = `Tool 'mystery_tool' is available but not yet loaded. Call tool_search with query "mystery" to load it.`;
		let resolverCalls = 0;
		let resolverSawContextMessages = 0;

		const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			resolveToolAvailability: async (toolName, resolverContext) => {
				resolverCalls++;
				resolverSawContextMessages = resolverContext.messages.length;
				if (toolName === "mystery_tool") {
					return { kind: "deferred", guidance };
				}
				return undefined;
			},
		};

		const sequence: string[] = [];
		const streamFn = createTwoTurnStreamFn(
			sequence,
			createAssistantMessage([{ type: "toolCall", id: "tool-1", name: "mystery_tool", arguments: {} }], "toolUse"),
		);

		const messages = await agentLoop([createUserMessage("use it")], context, config, undefined, streamFn).result();

		// The folded tool never executed; the model got the self-correction guidance instead.
		expect(executed).toEqual([]);
		expect(resolverCalls).toBe(1);
		expect(resolverSawContextMessages).toBeGreaterThan(0);
		const toolResult = findToolResult(messages);
		expect(toolResult?.isError).toBe(true);
		expect(toolResult?.content).toEqual([{ type: "text", text: guidance }]);
		// Guidance is normal control flow: the loop continued to the next request.
		expect(sequence).toEqual(["llm-request-1", "llm-request-2"]);
	});

	it("keeps the default not-found error for names the resolver does not manage", async () => {
		const executed: string[] = [];
		const tool = createEchoTool(executed);
		const sequence: string[] = [];

		const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			// Sync resolver that only knows an unrelated name.
			resolveToolAvailability: (toolName) =>
				toolName === "known_but_absent" ? { kind: "deferred", guidance: "unrelated" } : undefined,
		};

		const streamFn = createTwoTurnStreamFn(
			sequence,
			createAssistantMessage([{ type: "toolCall", id: "tool-1", name: "mystery_tool", arguments: {} }], "toolUse"),
		);

		const messages = await agentLoop([createUserMessage("use it")], context, config, undefined, streamFn).result();

		const toolResult = findToolResult(messages);
		expect(toolResult?.isError).toBe(true);
		expect(toolResult?.content).toEqual([{ type: "text", text: "Tool mystery_tool not found" }]);
		expect(executed).toEqual([]);
		// The not-found error is normal control flow: the loop continued to the next request.
		expect(sequence).toEqual(["llm-request-1", "llm-request-2"]);
	});

	it("falls back to not-found and records a diagnostic when the resolver throws", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const executed: string[] = [];
			const tool = createEchoTool(executed);

			const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
			const config: AgentLoopConfig = {
				model: createModel(),
				convertToLlm: identityConverter,
				resolveToolAvailability: async () => {
					throw new Error("resolver exploded");
				},
			};

			const sequence: string[] = [];
			const streamFn = createTwoTurnStreamFn(
				sequence,
				createAssistantMessage(
					[{ type: "toolCall", id: "tool-1", name: "mystery_tool", arguments: {} }],
					"toolUse",
				),
			);

			const messages = await agentLoop([createUserMessage("use it")], context, config, undefined, streamFn).result();

			const toolResult = findToolResult(messages);
			expect(toolResult?.isError).toBe(true);
			expect(toolResult?.content).toEqual([{ type: "text", text: "Tool mystery_tool not found" }]);
			expect(executed).toEqual([]);
			expect(sequence).toEqual(["llm-request-1", "llm-request-2"]);
			const warnings = joinWarnings(warnSpy);
			expect(warnings).toContain('resolveToolAvailability failed for tool "mystery_tool"');
			expect(warnings).toContain("resolver exploded");
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("executes registered tools normally without consulting the resolver", async () => {
		const executed: string[] = [];
		const tool = createEchoTool(executed);
		let resolverCalls = 0;

		const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			resolveToolAvailability: () => {
				resolverCalls++;
				return undefined;
			},
		};

		const sequence: string[] = [];
		const streamFn = createTwoTurnStreamFn(
			sequence,
			createAssistantMessage(
				[{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }],
				"toolUse",
			),
		);

		const messages = await agentLoop([createUserMessage("echo")], context, config, undefined, streamFn).result();

		expect(executed).toEqual(["hello"]);
		expect(resolverCalls).toBe(0);
		expect(sequence).toEqual(["llm-request-1", "llm-request-2"]);
		const toolResult = findToolResult(messages);
		expect(toolResult?.isError).toBe(false);
		expect(toolResult?.content).toEqual([{ type: "text", text: "echoed: hello" }]);
	});
});
