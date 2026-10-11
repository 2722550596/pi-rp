import { type Context, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionFactory } from "../../src/index.ts";
import { createHarness, getMessageText } from "./harness.ts";

function lateTool(name: string) {
	return {
		name,
		label: name,
		description: `${name} does things.`,
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }),
	};
}

function catalogNotices(context: Context): string[] {
	return context.messages
		.filter((message) => message.role === "user")
		.map((message) => getMessageText(message))
		.filter((text) => text.startsWith("Tools added") || text.startsWith("Tools removed"));
}

describe("tool search catalog delta", () => {
	it("keeps late tool registrations out of the user queue and announces them once, merged, to the next request", async () => {
		let api: ExtensionAPI | undefined;
		const extensionFactories: ExtensionFactory[] = [
			(pi) => {
				api = pi;
			},
		];
		const harness = await createHarness({
			extensionFactories,
			settings: { toolSearch: { enabled: true, mode: "on", thresholdPercent: 10, reservedTools: [] } },
		});

		try {
			if (!api) throw new Error("extension api was not captured");
			// Post-bind registrations (MCP connect, session_start handlers) each
			// trigger a separate tool refresh.
			api.registerTool(lateTool("late_a"));
			api.registerTool(lateTool("late_b"));
			api.registerTool(lateTool("late_c"));

			// Engine notifications never occupy the user's input queue.
			expect(harness.session.getSteeringMessages()).toEqual([]);
			expect(harness.session.pendingMessageCount).toBe(0);

			const notices: string[][] = [];
			const record = (context: Context) => {
				notices.push(catalogNotices(context));
				return fauxAssistantMessage("ok");
			};
			harness.setResponses([record, record, record]);

			// First request: the system prompt already lists the full catalog,
			// so a fresh session gets no delta.
			await harness.session.prompt("first");

			api.registerTool(lateTool("late_d"));
			api.registerTool(lateTool("late_e"));
			expect(harness.session.getSteeringMessages()).toEqual([]);

			await harness.session.prompt("second");
			await harness.session.prompt("third");

			expect(notices).toEqual([[], ["Tools added: late_d, late_e"], ["Tools added: late_d, late_e"]]);
			// The notice is persisted once, not re-queued per request.
			const persisted = harness.session.messages.filter(
				(message) => message.role === "custom" && getMessageText(message).startsWith("Tools added"),
			);
			expect(persisted).toHaveLength(1);
		} finally {
			harness.cleanup();
		}
	});
});
