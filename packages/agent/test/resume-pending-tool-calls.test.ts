/**
 * Resuming tool calls left without results (process stopped mid-execution): replay-safe tools
 * run again with the same id, the rest get an "interrupted" error, then the loop continues.
 */

import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";
import { findPendingToolCalls, runAgentLoopResume } from "../src/agent-loop.ts";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, AgentTool } from "../src/types.ts";

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

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const model: Model<"openai-responses"> = {
	id: "mock",
	name: "mock",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 2048,
};

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage,
		stopReason,
		timestamp: 1,
	};
}

function toolResult(toolCallId: string, toolName: string, text: string): ToolResultMessage {
	return { role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError: false, timestamp: 1 };
}

function convertToLlm(messages: AgentMessage[]): Message[] {
	return messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

function replyStream(text: string, requests: Message[][]) {
	return (_model: unknown, context: { messages: Message[] }) => {
		requests.push(context.messages.slice());
		const stream = new MockAssistantStream();
		queueMicrotask(() => {
			stream.push({ type: "done", reason: "stop", message: assistant([{ type: "text", text }], "stop") });
		});
		return stream;
	};
}

function recordingTool(name: string, replay: AgentTool["replay"], executed: string[], terminate = false): AgentTool {
	return {
		name,
		label: name,
		description: name,
		parameters: Type.Object({ text: Type.String() }),
		replay,
		async execute(toolCallId, params) {
			executed.push(`${name}:${toolCallId}:${(params as { text: string }).text}`);
			return { content: [{ type: "text", text: `${name} done` }], details: {}, terminate };
		},
	};
}

const interruptedBatch = (): AgentMessage[] => [
	{ role: "user", content: "hi", timestamp: 1 },
	assistant(
		[
			{ type: "toolCall", id: "c1", name: "speak", arguments: { text: "a" } },
			{ type: "toolCall", id: "c2", name: "post", arguments: { text: "b" } },
			{ type: "toolCall", id: "c3", name: "speak", arguments: { text: "c" } },
		],
		"toolUse",
	),
	toolResult("c1", "speak", "recorded"),
];

describe("findPendingToolCalls", () => {
	it("returns the unanswered calls of the trailing tool-use assistant message", () => {
		const pending = findPendingToolCalls(interruptedBatch());
		expect(pending?.toolCalls.map((call) => call.id)).toEqual(["c2", "c3"]);
	});

	it("ignores settled batches, later user turns and non-tool-use endings", () => {
		const settled = [...interruptedBatch(), toolResult("c2", "post", "x"), toolResult("c3", "speak", "y")];
		expect(findPendingToolCalls(settled)).toBeUndefined();
		expect(
			findPendingToolCalls([...interruptedBatch(), { role: "user", content: "next", timestamp: 2 }]),
		).toBeUndefined();
		expect(findPendingToolCalls([assistant([{ type: "text", text: "ok" }], "stop")])).toBeUndefined();
		expect(findPendingToolCalls([])).toBeUndefined();
	});
});

describe("runAgentLoopResume", () => {
	it("replays safe calls, marks the rest interrupted, then continues to the model", async () => {
		const executed: string[] = [];
		const requests: Message[][] = [];
		const context: AgentContext = {
			systemPrompt: "",
			messages: interruptedBatch(),
			tools: [recordingTool("speak", "safe", executed), recordingTool("post", undefined, executed)],
		};
		const events: AgentEvent[] = [];
		const config: AgentLoopConfig = { model, convertToLlm };

		const newMessages = await runAgentLoopResume(
			context,
			config,
			(event) => {
				events.push(event);
			},
			undefined,
			replyStream("after resume", requests) as never,
		);

		expect(executed).toEqual(["speak:c3:c"]);
		const results = newMessages.filter((m): m is ToolResultMessage => m.role === "toolResult");
		expect(results.map((m) => [m.toolCallId, m.isError])).toEqual([
			["c2", true],
			["c3", false],
		]);
		expect(JSON.stringify(results[0].content)).toContain("interrupted");
		// The recorded assistant message is not re-emitted as a new message.
		expect(newMessages.filter((m) => m.role === "assistant")).toHaveLength(1);
		expect(requests).toHaveLength(1);
		expect(
			requests[0].filter((m) => m.role === "toolResult").map((m) => (m as ToolResultMessage).toolCallId),
		).toEqual(["c1", "c2", "c3"]);
		expect(events[0]).toEqual({ type: "agent_start" });
		expect(events.at(-1)?.type).toBe("agent_end");
	});

	it("stops without a model call when every resumed call is replayed and terminates", async () => {
		const executed: string[] = [];
		const requests: Message[][] = [];
		const messages: AgentMessage[] = [
			{ role: "user", content: "hi", timestamp: 1 },
			assistant([{ type: "toolCall", id: "s1", name: "speak", arguments: { text: "a" } }], "toolUse"),
		];
		const context: AgentContext = {
			systemPrompt: "",
			messages,
			tools: [recordingTool("speak", "safe", executed, true)],
		};

		await runAgentLoopResume(
			context,
			{ model, convertToLlm },
			() => {},
			undefined,
			replyStream("x", requests) as never,
		);

		expect(executed).toEqual(["speak:s1:a"]);
		expect(requests).toHaveLength(0);
	});

	it("rejects a transcript with nothing pending", async () => {
		const context: AgentContext = { systemPrompt: "", messages: [{ role: "user", content: "hi", timestamp: 1 }] };
		await expect(
			runAgentLoopResume(context, { model, convertToLlm }, () => {}, undefined, replyStream("x", []) as never),
		).rejects.toThrow("no pending tool calls");
	});
});

describe("Agent.resumePendingToolCalls", () => {
	it("settles pending calls into state and reports whether it ran", async () => {
		const executed: string[] = [];
		const requests: Message[][] = [];
		const agent = new Agent({
			streamFn: replyStream("done", requests) as never,
			initialState: {
				model,
				messages: interruptedBatch(),
				tools: [recordingTool("speak", "safe", executed), recordingTool("post", "never", executed)],
			},
		});

		expect(agent.getPendingToolCalls()?.toolCalls.map((call) => call.id)).toEqual(["c2", "c3"]);
		expect(await agent.resumePendingToolCalls()).toBe(true);
		expect(executed).toEqual(["speak:c3:c"]);
		expect(agent.getPendingToolCalls()).toBeUndefined();
		const roles = agent.state.messages.map((m) => m.role);
		expect(roles).toEqual(["user", "assistant", "toolResult", "toolResult", "toolResult", "assistant"]);
		expect(await agent.resumePendingToolCalls()).toBe(false);
	});
});
