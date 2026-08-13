import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEndEvent } from "../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "./harness.ts";

function userTexts(messages: Array<{ role: string; content: unknown }>): string[] {
	return messages
		.filter((m) => m.role === "user")
		.map((m) => {
			const content = m.content as { text?: string }[] | string;
			return typeof content === "string" ? content : (content[0]?.text ?? "");
		})
		.filter((t) => t.length > 0);
}

describe("agent_end contextMessages (full LLM view)", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("carries the branch view with custom messages converted per declared policy", async () => {
		let customSent = false;
		let lastAgentEnd: AgentEndEvent | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCustomType("audit_notice", { context: "exclude" });
					pi.on("agent_end", (event) => {
						lastAgentEnd = event as AgentEndEvent;
						if (!customSent) {
							customSent = true;
							// Injected after the first turn: must appear in the NEXT
							// turn's context (custom → user), except the excluded type.
							pi.sendMessage({ customType: "narration", content: "场景叙述", display: true });
							pi.sendMessage({ customType: "audit_notice", content: "不该进上下文", display: true });
						}
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("第一轮"), fauxAssistantMessage("第二轮")]);

		await harness.session.prompt("hello");
		await harness.session.prompt("world");

		expect(lastAgentEnd?.contextMessages).toBeDefined();
		const all = lastAgentEnd!.contextMessages!;
		const texts = userTexts(all);
		// history + current turn, in order
		expect(texts).toEqual(["hello", "场景叙述", "world"]);
		// excluded custom type never enters the context
		expect(all.some((m) => JSON.stringify(m.content).includes("不该进上下文"))).toBe(false);
		// this turn's own messages are also reported
		expect(lastAgentEnd?.messages.some((m) => m.role === "assistant")).toBe(true);
	});

	it("assistant-role custom type enters the context as an assistant message", async () => {
		let customSent = false;
		let lastAgentEnd: AgentEndEvent | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCustomType("character_speech", { llmRole: "assistant" });
					pi.on("agent_end", (event) => {
						lastAgentEnd = event as AgentEndEvent;
						if (!customSent) {
							customSent = true;
							pi.sendMessage({ customType: "character_speech", content: "我是角色", display: true });
						}
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("第一轮"), fauxAssistantMessage("第二轮")]);

		await harness.session.prompt("hello");
		await harness.session.prompt("world");

		const all = lastAgentEnd!.contextMessages!;
		expect(
			all.filter((m) => m.role === "assistant").some((m) => JSON.stringify(m.content).includes("我是角色")),
		).toBe(true);
	});
});
