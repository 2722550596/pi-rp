import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, test } from "vitest";
import { type CustomMessage, type CustomTypeResolver, convertToLlm } from "../src/core/messages.ts";

// ── Fixtures ────────────────────────────────────────────────────────────
// convertToLlm only consumes role/content/timestamp; payloads are minimal.

function assistant(content: Array<{ type: string; [k: string]: unknown }>): AgentMessage {
	return { role: "assistant", content, timestamp: 1 } as unknown as AgentMessage;
}

function toolCallAssistant(id: string, text = ""): AgentMessage {
	return assistant([
		...(text ? [{ type: "text", text }] : []),
		{ type: "toolCall", id, name: "handoff", arguments: {} },
	]);
}

function toolResult(id: string): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "handoff",
		content: [{ type: "text", text: "done" }],
		isError: false,
		timestamp: 2,
	} as unknown as AgentMessage;
}

function custom(customType: string, content: string): CustomMessage {
	return { role: "custom", customType, content, display: true, timestamp: 3 };
}

function user(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: 3 } as unknown as AgentMessage;
}

function system(text: string): AgentMessage {
	return { role: "system", content: text, timestamp: 0 } as unknown as AgentMessage;
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("convertToLlm tool adjacency", () => {
	test("custom between toolCall and toolResult moves after the tool result", () => {
		const out = convertToLlm([toolCallAssistant("c1"), custom("narration", "场景叙述"), toolResult("c1")]);
		expect(out.map((m) => m.role)).toEqual(["assistant", "toolResult", "user"]);
		expect(out[2]).toMatchObject({ role: "user", content: [{ type: "text", text: "场景叙述" }] });
	});

	test("custom converts to user and keeps content when not in a tool window", () => {
		const out = convertToLlm([user("玩家输入"), custom("narration", "叙述")]);
		expect(out.map((m) => m.role)).toEqual(["user", "user"]);
		expect(out[1]).toMatchObject({ role: "user", content: [{ type: "text", text: "叙述" }] });
	});

	test("multiple held customs flush in order after the tool result", () => {
		const out = convertToLlm([
			toolCallAssistant("c1"),
			custom("narration", "第一段"),
			custom("character_reply", "第二段"),
			toolResult("c1"),
			custom("narration", "第三段"),
		]);
		expect(out.map((m) => m.role)).toEqual(["assistant", "toolResult", "user", "user", "user"]);
		const texts = out.filter((m) => m.role === "user").map((m) => (m.content as { text: string }[])[0].text);
		expect(texts).toEqual(["第一段", "第二段", "第三段"]);
	});

	test("assistant without tool calls resets the window and flushes held customs before it", () => {
		const out = convertToLlm([
			toolCallAssistant("c1"),
			custom("narration", "叙述"),
			toolResult("c1"),
			assistant([{ type: "text", text: "收尾" }]),
			custom("narration", "新叙述"),
		]);
		expect(out.map((m) => m.role)).toEqual(["assistant", "toolResult", "user", "assistant", "user"]);
	});

	test("tool adjacency preserved when no custom is interleaved", () => {
		const out = convertToLlm([toolCallAssistant("c1"), toolResult("c1")]);
		expect(out.map((m) => m.role)).toEqual(["assistant", "toolResult"]);
	});

	test("real user message flushes held customs but does not break later tool adjacency", () => {
		// Real user messages cannot interrupt a tool pair in the loop, but the
		// reorder must not corrupt the window when it happens anyway.
		const out = convertToLlm([toolCallAssistant("c1"), custom("narration", "叙述"), user("中途输入")]);
		expect(out.map((m) => m.role)).toEqual(["assistant", "user", "user"]);
	});

	test("system and user messages are emitted in place after flushing held customs", () => {
		const out = convertToLlm([
			system("系统"),
			user("玩家"),
			toolCallAssistant("c1"),
			custom("narration", "叙述"),
			toolResult("c1"),
		]);
		expect(out.map((m) => m.role)).toEqual(["system", "user", "assistant", "toolResult", "user"]);
	});

	test("excluded bashExecution messages do not disturb the tool window", () => {
		const excluded = {
			role: "bashExecution",
			command: "ls",
			output: "",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			excludeFromContext: true,
			timestamp: 1,
		} as unknown as AgentMessage;
		const out = convertToLlm([toolCallAssistant("c1"), excluded, custom("narration", "叙述"), toolResult("c1")]);
		expect(out.map((m) => m.role)).toEqual(["assistant", "toolResult", "user"]);
	});

	test("dangling toolCall at end with held custom still flushes", () => {
		const out = convertToLlm([toolCallAssistant("c1"), custom("narration", "叙述")]);
		expect(out.map((m) => m.role)).toEqual(["assistant", "user"]);
	});
});

describe("convertToLlm custom type policy", () => {
	const resolver: CustomTypeResolver = (customType) => {
		switch (customType) {
			case "audit_notice":
				return { context: "exclude", llmRole: "user" };
			case "character_speech":
				return { context: "include", llmRole: "assistant" };
			default:
				return undefined; // → default policy
		}
	};

	test("no resolver keeps default behavior (custom → user)", () => {
		const out = convertToLlm([user("玩家"), custom("character_reply", "你好")]);
		expect(out.map((m) => m.role)).toEqual(["user", "user"]);
	});

	test("unresolved type with resolver present still defaults to user", () => {
		const out = convertToLlm([custom("undecided_type", "正文")], resolver);
		expect(out.map((m) => m.role)).toEqual(["user"]);
	});

	test("excluded custom type never enters the context", () => {
		const out = convertToLlm(
			[user("玩家"), custom("audit_notice", "状态已更新"), custom("character_reply", "哦")],
			resolver,
		);
		expect(out.map((m) => m.role)).toEqual(["user", "user"]);
		expect(out[0]).toMatchObject({ content: "玩家" });
		expect(out[1]).toMatchObject({ content: [{ type: "text", text: "哦" }] });
	});

	test("assistant-role custom converts to an assistant message", () => {
		const out = convertToLlm([user("玩家"), custom("character_speech", "我是角色")], resolver);
		expect(out.map((m) => m.role)).toEqual(["user", "assistant"]);
		expect(out[1]).toMatchObject({ role: "assistant", content: [{ type: "text", text: "我是角色" }] });
	});

	test("assistant-role custom stays held during a tool window, then emits as assistant", () => {
		const out = convertToLlm(
			[toolCallAssistant("c1"), custom("character_speech", "说话"), toolResult("c1")],
			resolver,
		);
		expect(out.map((m) => m.role)).toEqual(["assistant", "toolResult", "assistant"]);
	});

	test("excluded custom inside a tool window does not disturb adjacency", () => {
		const out = convertToLlm([toolCallAssistant("c1"), custom("audit_notice", "通知"), toolResult("c1")], resolver);
		expect(out.map((m) => m.role)).toEqual(["assistant", "toolResult"]);
	});
});
