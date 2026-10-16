import { describe, expect, test } from "vitest";
import { createExtensionRuntime } from "../src/core/extensions/loader.ts";
import { convertToLlm, DEFAULT_CUSTOM_TYPE_POLICY } from "../src/core/messages.ts";

describe("custom type registry (ExtensionRuntime)", () => {
	test("undeclared types resolve to the default policy", () => {
		const runtime = createExtensionRuntime();
		expect(runtime.getCustomTypePolicy("anything")).toEqual(DEFAULT_CUSTOM_TYPE_POLICY);
	});

	test("registerCustomType stores the declared policy", () => {
		const runtime = createExtensionRuntime();
		runtime.registerCustomType("notice", { context: "exclude", llmRole: "user" });
		expect(runtime.getCustomTypePolicy("notice")).toEqual({ context: "exclude", llmRole: "user" });
	});

	test("first declaration per type wins; later declarations are ignored", () => {
		const runtime = createExtensionRuntime();
		runtime.registerCustomType("x", { context: "exclude", llmRole: "user" });
		runtime.registerCustomType("x", { context: "include", llmRole: "assistant" });
		expect(runtime.getCustomTypePolicy("x")).toEqual({ context: "exclude", llmRole: "user" });
	});

	test("registrations are isolated between runtimes", () => {
		const a = createExtensionRuntime();
		const b = createExtensionRuntime();
		a.registerCustomType("x", { context: "exclude", llmRole: "user" });
		expect(b.getCustomTypePolicy("x")).toEqual(DEFAULT_CUSTOM_TYPE_POLICY);
	});
	test("maps held custom messages and exclusions to their original source", () => {
		const sources: number[] = [];
		const messages = convertToLlm(
			[
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "call", name: "read", arguments: {} }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "test",
					stopReason: "toolUse",
					timestamp: 0,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				},
				{ role: "custom", customType: "held", content: "held", display: false, timestamp: 1 },
				{ role: "custom", customType: "excluded", content: "excluded", display: false, timestamp: 2 },
				{
					role: "toolResult",
					toolCallId: "call",
					toolName: "read",
					content: [{ type: "text", text: "result" }],
					isError: false,
					timestamp: 3,
				},
			],
			(type) => ({ ...DEFAULT_CUSTOM_TYPE_POLICY, context: type === "excluded" ? "exclude" : "include" }),
			false,
			sources,
		);
		expect(messages.map((message) => message.role)).toEqual(["assistant", "toolResult", "user"]);
		expect(sources).toEqual([0, 3, 1]);
	});
	test("maps excluded bash and summarization policies without changing message objects", () => {
		const kept = { role: "user" as const, content: "kept", timestamp: 0 };
		const sources: number[] = [];
		const messages = convertToLlm(
			[
				{
					role: "bashExecution",
					command: "echo omitted",
					output: "omitted",
					exitCode: 0,
					cancelled: false,
					truncated: false,
					excludeFromContext: true,
					timestamp: 0,
				},
				{ role: "custom", customType: "summary-excluded", content: "excluded", display: false, timestamp: 0 },
				kept,
			],
			() => ({ ...DEFAULT_CUSTOM_TYPE_POLICY, compaction: "exclude" }),
			true,
			sources,
		);
		expect(messages).toEqual([kept]);
		expect(messages[0]).toBe(kept);
		expect(sources).toEqual([2]);
	});
});
