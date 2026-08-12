import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { sessionEntryToContextMessages } from "../src/core/session-manager.ts";
import { createHarness, getAssistantTexts, getMessageText, getUserTexts, type Harness } from "./suite/harness.ts";

describe("pi.appendEntry message overload", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("appends real user/assistant message entries that enter LLM context", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", () => {
						// Real conversation messages: persisted + in LLM context.
						pi.appendEntry("message", { role: "assistant", content: "叙事的开场白" });
						pi.appendEntry("message", { role: "user", content: [{ type: "text", text: "旅人的第一个动作" }] });
						// Legacy custom entry: state persistence only, NOT in LLM context.
						pi.appendEntry("state_updater", { count: 42 });
					});
				},
			],
		});
		harnesses.push(harness);

		await harness.session.bindExtensions({});

		const entries = harness.sessionManager.getEntries();
		const messageEntries = entries.filter((e) => e.type === "message");
		const customEntries = entries.filter((e) => e.type === "custom");

		expect(messageEntries).toHaveLength(2);
		expect(messageEntries[0].type).toBe("message");
		expect(messageEntries[0].message.role).toBe("assistant");
		expect(getMessageText(messageEntries[0].message)).toBe("叙事的开场白");
		expect(messageEntries[1].message.role).toBe("user");
		expect(getMessageText(messageEntries[1].message)).toBe("旅人的第一个动作");

		// Custom entries stay out of the LLM context.
		expect(customEntries).toHaveLength(1);
		expect(customEntries[0].type).toBe("custom");
		expect(customEntries[0].customType).toBe("state_updater");
		expect(sessionEntryToContextMessages(customEntries[0])).toEqual([]);

		// Message entries project into the LLM context unchanged.
		expect(sessionEntryToContextMessages(messageEntries[0]).map(getMessageText)).toEqual(["叙事的开场白"]);
		expect(sessionEntryToContextMessages(messageEntries[1]).map(getMessageText)).toEqual(["旅人的第一个动作"]);
		// Seeded messages are in agent state, so the next turn sends them to the model.
		expect(getAssistantTexts(harness)).toEqual(["叙事的开场白"]);
		expect(getUserTexts(harness)).toEqual(["旅人的第一个动作"]);
	});

	it("keeps seeded messages in context across a real turn", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", () => {
						pi.appendEntry("message", { role: "assistant", content: "晨雾中的驿站开场" });
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("回应")]);

		await harness.session.bindExtensions({});
		await harness.session.sendUserMessage("继续");
		await harness.session.agent.waitForIdle();

		expect(getAssistantTexts(harness)).toEqual(["晨雾中的驿站开场", "回应"]);
		expect(getUserTexts(harness)).toEqual(["继续"]);
	});
});
