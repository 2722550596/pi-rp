import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { runToolCall } from "../src/agent-loop.ts";
import type { AgentContext, AgentTool } from "../src/types.ts";

const assistantMessage: AssistantMessage = {
	role: "assistant",
	content: [{ type: "toolCall", id: "child/1", name: "echo", arguments: { value: "ok" } }],
	api: "openai-responses",
	provider: "openai",
	model: "test",
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
const toolCall = assistantMessage.content[0];
if (toolCall.type !== "toolCall") throw new Error("invalid test fixture");
const context: AgentContext = { systemPrompt: "", messages: [], tools: [] };
const echoParameters = Type.Object({ value: Type.String() });
const echoTool: AgentTool<typeof echoParameters> = {
	name: "echo",
	label: "Echo",
	description: "Echo a string",
	parameters: echoParameters,
	execute: async (_id, params) => ({ content: [{ type: "text", text: params.value }], details: {} }),
};

describe("runToolCall", () => {
	it("validates and dispatches only the supplied authorized tool with hook and parent correlation", async () => {
		const seenEvents: Array<{ type: string; parentToolCallId?: string }> = [];
		const hookCalls: string[] = [];
		const outcome = await runToolCall({
			toolCall,
			assistantMessage,
			tools: [echoTool],
			context,
			parentToolCallId: "caller",
			emit: (event) => seenEvents.push(event),
			hooks: {
				beforeToolCall: () => {
					hookCalls.push("before");
					return {};
				},
				afterToolCall: ({ result }) => {
					hookCalls.push("after");
					return { content: [...(result.content ?? []), { type: "text", text: "rewritten" }] };
				},
			},
		});
		expect(outcome.status).toBe("success");
		expect(outcome.result.content.map((item) => (item.type === "text" ? item.text : "image"))).toEqual([
			"ok",
			"rewritten",
		]);
		expect(hookCalls).toEqual(["before", "after"]);
		expect(seenEvents.every((event) => event.parentToolCallId === "caller")).toBe(true);
	});
	it("rejects a hidden tool outside the adapter-authorized set", async () => {
		let executed = false;
		const hiddenTool: AgentTool<typeof echoParameters> = {
			...echoTool,
			name: "denied",
			execute: async () => {
				executed = true;
				return { content: [], details: {} };
			},
		};
		const outcome = await runToolCall({
			toolCall: { ...toolCall, name: "denied" },
			assistantMessage,
			tools: [],
			context: { ...context, tools: [hiddenTool] },
		});
		expect(outcome.status).toBe("validation_error");
		expect(outcome.isError).toBe(true);
		expect(executed).toBe(false);
	});
	it("returns validation, block, execution-error and abort failures as outcomes", async () => {
		const invalid = await runToolCall({
			toolCall: { ...toolCall, arguments: {} },
			assistantMessage,
			tools: [echoTool],
			context,
		});
		expect(invalid.status).toBe("validation_error");
		const blocked = await runToolCall({
			toolCall,
			assistantMessage,
			tools: [echoTool],
			context,
			hooks: { beforeToolCall: () => ({ block: true, reason: "policy" }) },
		});
		expect(blocked.status).toBe("blocked");
		const failingTool: AgentTool<typeof echoParameters> = {
			...echoTool,
			execute: async () => {
				throw new Error("failure");
			},
		};
		const failed = await runToolCall({ toolCall, assistantMessage, tools: [failingTool], context });
		expect(failed.status).toBe("error");
		const controller = new AbortController();
		controller.abort();
		const aborted = await runToolCall({
			toolCall,
			assistantMessage,
			tools: [echoTool],
			context,
			signal: controller.signal,
		});
		expect(aborted.status).toBe("aborted");
	});
	it("propagates structured results and non-throwing tool errors through hooks", async () => {
		const structuredTool: AgentTool<typeof echoParameters> = {
			...echoTool,
			execute: async () => ({
				content: [{ type: "text", text: "original" }],
				details: {},
				structuredContent: { original: true },
				isError: true,
			}),
		};
		const dropped = await runToolCall({
			toolCall,
			assistantMessage,
			tools: [structuredTool],
			context,
			hooks: {
				afterToolCall: ({ isError, result }) => {
					expect(isError).toBe(true);
					expect(result.structuredContent).toEqual({ original: true });
					return { content: [{ type: "text", text: "rewritten" }] };
				},
			},
		});
		expect(dropped.status).toBe("error");
		expect(dropped.isError).toBe(true);
		expect(dropped.result.structuredContent).toBeUndefined();

		const replaced = await runToolCall({
			toolCall,
			assistantMessage,
			tools: [structuredTool],
			context,
			hooks: {
				afterToolCall: () => ({
					content: [{ type: "text", text: "rewritten" }],
					structuredContent: { replaced: true },
					isError: false,
				}),
			},
		});
		expect(replaced.status).toBe("success");
		expect(replaced.isError).toBe(false);
		expect(replaced.result.structuredContent).toEqual({ replaced: true });
	});
});
