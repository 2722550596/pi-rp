import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { compileMessages, compileMessagesSync, presetHasAsyncSlots } from "../src/core/prompt-preset/compiler.ts";
import { registerSlot } from "../src/core/prompt-preset/slot-renderers.ts";
import type { PromptPreset, PromptRuntime } from "../src/core/prompt-preset/types.ts";

function userMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 0 };
}

function runtime(messages: AgentMessage[] = []): PromptRuntime {
	return {
		options: { cwd: "" },
		messages,
		now: new Date(0),
		variables: {},
		skills: [],
	};
}

function messageText(message: AgentMessage): string {
	if (!("content" in message) || !Array.isArray(message.content)) return "";
	const parts: string[] = [];
	for (const block of message.content) {
		if (typeof block !== "object" || block === null) continue;
		const part = block as { type?: string; text?: string };
		if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
	}
	return parts.join("\n");
}

function presetWithItems(items: PromptPreset["items"]): PromptPreset {
	return { schemaVersion: 1, id: "async-test", items };
}

describe("async slots", () => {
	const slotName = "test-async-slot";
	registerSlot({
		name: slotName,
		description: "test async slot",
		async: true,
		render: async () => "async content",
	});

	it("renders async slot content through the async compile path", async () => {
		const preset = presetWithItems([{ kind: "slot", id: "s", slot: slotName }]);
		const compiled = await compileMessages(preset, runtime());
		expect(messageText(compiled.messages[0])).toBe("async content");
	});

	it("presetHasAsyncSlots detects async slots", () => {
		const withAsync = presetWithItems([{ kind: "slot", id: "s", slot: slotName }]);
		const withoutAsync = presetWithItems([{ kind: "block", id: "b", content: "x" }]);
		expect(presetHasAsyncSlots(withAsync)).toBe(true);
		expect(presetHasAsyncSlots(withoutAsync)).toBe(false);
	});

	it("sync fast path renders async slots as empty with an info diagnostic", () => {
		const preset = presetWithItems([{ kind: "slot", id: "s", slot: slotName }]);
		const result = compileMessagesSync(preset, runtime());
		expect(result.messages).toHaveLength(0);
		const info = result.diagnostics.find((d) => d.level === "info");
		expect(info).toBeTruthy();
		expect(info?.message).toContain(slotName);
	});

	it("sync compile path still handles non-async slots and blocks normally", () => {
		registerSlot({ name: "test-sync-slot", description: "test", render: () => "sync content" });
		const preset = presetWithItems([
			{ kind: "block", id: "b", content: "block content" },
			{ kind: "slot", id: "s", slot: "test-sync-slot", role: "user" },
		]);
		const result = compileMessagesSync(preset, runtime());
		expect(result.messages.map(messageText)).toEqual(["block content", "sync content"]);
		expect(result.diagnostics.some((d) => d.level === "info")).toBe(false);
	});

	it("renders async slots in item order with chat-history preserved", async () => {
		const secondSlot = "test-async-slot-2";
		registerSlot({
			name: secondSlot,
			description: "test async slot 2",
			async: true,
			render: async () => "second",
		});
		const history = [userMessage("h1")];
		const preset = presetWithItems([
			{ kind: "slot", id: "a", slot: slotName },
			{ kind: "slot", id: "chat", slot: "chat-history", options: {} },
			{ kind: "slot", id: "b", slot: secondSlot },
		]);
		const compiled = await compileMessages(preset, runtime(history));
		expect(compiled.messages.map(messageText)).toEqual(["async content", "h1", "second"]);
	});
});

describe("parallel rendering", () => {
	it("renders multiple async slots concurrently (wall time ~ max, not sum)", async () => {
		const slowSlot = "test-parallel-slot";
		registerSlot({
			name: slowSlot,
			description: "slow async slot",
			async: true,
			render: async () => {
				await new Promise((resolve) => setTimeout(resolve, 80));
				return "slow";
			},
		});
		const preset = presetWithItems([
			{ kind: "slot", id: "s1", slot: slowSlot, role: "system" },
			{ kind: "slot", id: "s2", slot: slowSlot, role: "user" },
			{ kind: "slot", id: "s3", slot: slowSlot, role: "assistant" },
		]);
		const start = performance.now();
		const compiled = await compileMessages(preset, runtime());
		const elapsed = performance.now() - start;
		expect(compiled.messages.map(messageText)).toEqual(["slow", "slow", "slow"]);
		// Three 80ms slots: parallel ≈ 80ms, serial would be ≈ 240ms.
		expect(elapsed).toBeLessThan(200);
	});

	it("renders serially when a block carries a side-effecting macro", async () => {
		const orderingSlot = "test-ordering-slot";
		const seen: string[] = [];
		registerSlot({
			name: orderingSlot,
			description: "records render order",
			async: true,
			render: async () => {
				await new Promise((resolve) => setTimeout(resolve, 10));
				seen.push("slot");
				return "slot-content";
			},
		});
		// {{setvar}} mutates shared variables; later items may read them, so
		// rendering must stay serial (slot after the setvar block).
		const preset = presetWithItems([
			{ kind: "block", id: "set", content: "{{setvar::key::value}}" },
			{ kind: "slot", id: "s", slot: orderingSlot },
		]);
		const compiled = await compileMessages(preset, runtime());
		expect(compiled.messages).toHaveLength(1);
		expect(messageText(compiled.messages[0])).toBe("slot-content");
	});
});
