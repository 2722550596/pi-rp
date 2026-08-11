import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { compileMessages } from "../src/core/prompt-preset/compiler.ts";
import type { PromptPreset, PromptRuntime } from "../src/core/prompt-preset/types.ts";

function assistantMessage(text: string, thinking?: string): AssistantMessage {
	const content: AssistantMessage["content"] = [];
	if (thinking !== undefined) content.push({ type: "thinking", thinking });
	content.push({ type: "text", text });
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
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
	};
}

function userMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 0 };
}

function toolResultMessage(): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "test",
		content: [{ type: "text", text: "result" }],
		isError: false,
		timestamp: 0,
	};
}

function chatHistoryPreset(options: {
	stripAssistantThinking?: boolean | "previous-traces";
	roles?: string[];
}): PromptPreset {
	return {
		schemaVersion: 1,
		id: "test",
		items: [
			{
				kind: "slot",
				id: "chat",
				slot: "chat-history",
				options:
					options.stripAssistantThinking === undefined && options.roles === undefined
						? undefined
						: {
								...(options.stripAssistantThinking !== undefined
									? { stripAssistantThinking: options.stripAssistantThinking }
									: {}),
								...(options.roles !== undefined ? { roles: options.roles } : {}),
							},
			},
		],
	};
}

function runtime(messages: AgentMessage[], currentTraceStartIndex?: number): PromptRuntime {
	return {
		options: { cwd: "" },
		messages,
		currentTraceStartIndex,
		now: new Date(0),
		variables: {},
		skills: [],
	};
}

function hasThinking(message: AgentMessage): boolean {
	if (message.role !== "assistant" || !("content" in message) || !Array.isArray(message.content)) return false;
	return message.content.some((part: { type?: string }) => part?.type === "thinking");
}

describe("chat-history stripAssistantThinking", () => {
	it("strips thinking from every assistant message when true", () => {
		const messages = [
			userMessage("first round"),
			assistantMessage("first answer", "first reasoning"),
			userMessage("second round"),
			assistantMessage("second answer", "second reasoning"),
		];
		const compiled = compileMessages(chatHistoryPreset({ stripAssistantThinking: true }), runtime(messages)).messages;

		expect(compiled).toHaveLength(4);
		expect(compiled.filter(hasThinking)).toHaveLength(0);
	});

	it("keeps thinking untouched when the option is unset", () => {
		const messages = [userMessage("round"), assistantMessage("answer", "reasoning")];
		const compiled = compileMessages(chatHistoryPreset({}), runtime(messages)).messages;

		expect(compiled.filter(hasThinking)).toHaveLength(1);
	});

	it('strips only previous traces with "previous-traces" and keeps the current trace thinking', () => {
		const messages = [
			userMessage("first round"),
			assistantMessage("first answer", "first reasoning"),
			userMessage("second round"),
			assistantMessage("second answer", "second reasoning"),
		];
		// Current trace starts at index 2 (after the first completed trace).
		const compiled = compileMessages(
			chatHistoryPreset({ stripAssistantThinking: "previous-traces" }),
			runtime(messages, 2),
		).messages;

		expect(compiled).toHaveLength(4);
		expect(hasThinking(compiled[1])).toBe(false);
		expect(hasThinking(compiled[3])).toBe(true);
	});

	it("treats every message as previous when no trace boundary is provided", () => {
		const messages = [userMessage("round"), assistantMessage("answer", "reasoning")];
		const compiled = compileMessages(
			chatHistoryPreset({ stripAssistantThinking: "previous-traces" }),
			runtime(messages),
		).messages;

		expect(compiled.filter(hasThinking)).toHaveLength(0);
	});

	it("keeps all thinking when the current trace starts at index 0", () => {
		const messages = [userMessage("round"), assistantMessage("answer", "reasoning")];
		const compiled = compileMessages(
			chatHistoryPreset({ stripAssistantThinking: "previous-traces" }),
			runtime(messages, 0),
		).messages;

		expect(compiled.filter(hasThinking)).toHaveLength(1);
	});

	it("keeps trace membership intact when an earlier role filter drops messages", () => {
		const messages = [
			userMessage("first round"),
			assistantMessage("first answer", "first reasoning"),
			toolResultMessage(),
			userMessage("second round"),
			assistantMessage("second answer", "second reasoning"),
		];
		const compiled = compileMessages(
			chatHistoryPreset({ stripAssistantThinking: "previous-traces", roles: ["user", "assistant"] }),
			runtime(messages, 3),
		).messages;

		// toolResult dropped by the role filter; membership is by reference so stripping still targets the right messages.
		expect(compiled).toHaveLength(4);
		expect(hasThinking(compiled[1])).toBe(false);
		expect(hasThinking(compiled[3])).toBe(true);
	});

	it("never strips non-assistant messages", () => {
		const messages = [userMessage("round"), assistantMessage("answer", "reasoning")];
		const compiled = compileMessages(chatHistoryPreset({ stripAssistantThinking: true }), runtime(messages)).messages;

		expect(compiled[0]).toBe(messages[0]); // user message untouched
		expect(compiled[0]).toEqual({ role: "user", content: [{ type: "text", text: "round" }], timestamp: 0 });
	});
});
