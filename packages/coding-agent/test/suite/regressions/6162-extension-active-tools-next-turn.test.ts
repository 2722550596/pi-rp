import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { convertToLlm } from "../../../src/core/messages.ts";
import type { ExtensionFactory } from "../../../src/index.ts";
import { createHarness } from "../harness.ts";

describe("extension active tools next-turn refresh", () => {
	it("applies pi.setActiveTools before the next provider request in the same run", async () => {
		const extensionFactories: ExtensionFactory[] = [
			(pi) => {
				pi.registerTool({
					name: "switch_tools",
					label: "Switch Tools",
					description: "Switch the active extension tool set",
					promptSnippet: "Switch to the next extension tool",
					parameters: Type.Object({}),
					execute: async () => {
						pi.setActiveTools(["after_switch"]);
						return {
							content: [{ type: "text", text: "switched" }],
							details: {},
						};
					},
				});

				pi.registerTool({
					name: "after_switch",
					label: "After Switch",
					description: "Tool that should be available after switching",
					promptSnippet: "Run after the active tool set changes",
					parameters: Type.Object({}),
					execute: async () => ({
						content: [{ type: "text", text: "after" }],
						details: {},
					}),
				});
			},
		];
		const harness = await createHarness({
			extensionFactories,
		});

		try {
			harness.session.setActiveToolsByName(["switch_tools"]);

			const providerToolNames: string[][] = [];
			harness.setResponses([
				(context) => {
					providerToolNames.push((context.tools ?? []).map((tool) => tool.name).sort());
					return fauxAssistantMessage(fauxToolCall("switch_tools", {}), { stopReason: "toolUse" });
				},
				(context) => {
					providerToolNames.push((context.tools ?? []).map((tool) => tool.name).sort());
					return fauxAssistantMessage("done");
				},
			]);

			expect(harness.session.getActiveToolNames()).toEqual(["switch_tools"]);

			await harness.session.prompt("start");

			expect(harness.session.getActiveToolNames()).toEqual(["after_switch"]);
			expect(providerToolNames).toEqual([["switch_tools"], ["after_switch"]]);
		} finally {
			harness.cleanup();
		}
	});

	it("records additive active tool changes on the current tool result", async () => {
		const extensionFactories: ExtensionFactory[] = [
			(pi) => {
				pi.registerTool({
					name: "load_more_tools",
					label: "Load More Tools",
					description: "Load more tools",
					parameters: Type.Object({}),
					execute: async () => {
						pi.setActiveTools([...pi.getActiveTools(), "after_load"]);
						return {
							content: [{ type: "text", text: "loaded" }],
							details: {},
						};
					},
				});

				pi.registerTool({
					name: "after_load",
					label: "After Load",
					description: "Tool available after loading",
					parameters: Type.Object({}),
					execute: async () => ({
						content: [{ type: "text", text: "after" }],
						details: {},
					}),
				});
			},
		];
		const harness = await createHarness({ extensionFactories });

		try {
			harness.session.setActiveToolsByName(["load_more_tools"]);

			const addedToolNames: string[][] = [];
			harness.setResponses([
				() => fauxAssistantMessage(fauxToolCall("load_more_tools", {}), { stopReason: "toolUse" }),
				(context) => {
					addedToolNames.push(
						context.messages
							.filter((message) => message.role === "toolResult")
							.flatMap((message) => message.addedToolNames ?? []),
					);
					return fauxAssistantMessage("done");
				},
			]);

			await harness.session.prompt("start");

			expect(harness.session.getActiveToolNames()).toEqual(["load_more_tools", "after_load"]);
			expect(addedToolNames).toEqual([["after_load"]]);
		} finally {
			harness.cleanup();
		}
	});

	it("preserves before_agent_start system prompt overrides when tools change mid-run", async () => {
		const extensionFactories: ExtensionFactory[] = [
			(pi) => {
				pi.on("before_agent_start", async (event) => ({
					systemPrompt: `${event.systemPrompt}\n\nkeep this run override`,
				}));

				pi.registerTool({
					name: "switch_tools",
					label: "Switch Tools",
					description: "Switch the active extension tool set",
					promptSnippet: "Switch to the next extension tool",
					parameters: Type.Object({}),
					execute: async () => {
						pi.setActiveTools(["after_switch"]);
						return {
							content: [{ type: "text", text: "switched" }],
							details: {},
						};
					},
				});

				pi.registerTool({
					name: "after_switch",
					label: "After Switch",
					description: "Tool that should be available after switching",
					promptSnippet: "Run after the active tool set changes",
					parameters: Type.Object({}),
					execute: async () => ({
						content: [{ type: "text", text: "after" }],
						details: {},
					}),
				});
			},
		];
		const harness = await createHarness({
			extensionFactories,
		});

		try {
			harness.session.setActiveToolsByName(["switch_tools"]);

			const providerSystemPrompts: string[] = [];
			const providerToolNames: string[][] = [];
			harness.setResponses([
				(context) => {
					providerSystemPrompts.push(context.systemPrompt ?? "");
					providerToolNames.push((context.tools ?? []).map((tool) => tool.name).sort());
					return fauxAssistantMessage(fauxToolCall("switch_tools", {}), { stopReason: "toolUse" });
				},
				(context) => {
					providerSystemPrompts.push(context.systemPrompt ?? "");
					providerToolNames.push((context.tools ?? []).map((tool) => tool.name).sort());
					return fauxAssistantMessage("done");
				},
			]);

			await harness.session.prompt("start");

			expect(providerToolNames).toEqual([["switch_tools"], ["after_switch"]]);
			expect(providerSystemPrompts).toHaveLength(2);
			expect(providerSystemPrompts[0]).toContain("keep this run override");
			expect(providerSystemPrompts[1]).toContain("keep this run override");
		} finally {
			harness.cleanup();
		}
	});
	it("makes tool-appended messages visible to the next request once without starting another turn", async () => {
		const appendEntered = Promise.withResolvers<void>();
		const allowToolFinish = Promise.withResolvers<void>();
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCustomType("pool.visible", {
						context: "include",
						llmRole: "user",
						compaction: "exclude",
					});
					pi.registerCustomType("pool.hidden", {
						context: "exclude",
						llmRole: "user",
						compaction: "exclude",
					});
					pi.registerTool({
						name: "load_context",
						label: "Load Context",
						description: "Load context into the current tool loop",
						parameters: Type.Object({}),
						execute: async (_toolCallId, _params, _signal, _onUpdate, extension) => {
							extension.appendMessage({
								customType: "pool.visible",
								content: "loaded full pool text",
								display: false,
							});
							extension.appendMessage({
								customType: "pool.hidden",
								content: "excluded pool text",
								display: false,
							});
							appendEntered.resolve();
							await allowToolFinish.promise;
							return { content: [{ type: "text", text: "loaded" }], details: undefined };
						},
					});
				},
			],
		});

		let run: Promise<void> | undefined;
		try {
			const providerContexts: string[] = [];
			harness.setResponses([
				(context) => {
					providerContexts.push(JSON.stringify(context.messages));
					return fauxAssistantMessage(fauxToolCall("load_context", {}), { stopReason: "toolUse" });
				},
				(context) => {
					providerContexts.push(JSON.stringify(context.messages));
					return fauxAssistantMessage("done");
				},
			]);

			run = harness.session.prompt("start");
			await appendEntered.promise;
			expect(providerContexts).toHaveLength(1);
			allowToolFinish.resolve();
			await run;

			const nextRequest = providerContexts[1]!;
			expect(nextRequest).toContain("loaded full pool text");
			expect(nextRequest.indexOf('"role":"toolResult"')).toBeLessThan(nextRequest.indexOf("loaded full pool text"));
			const llmMessages = convertToLlm(harness.session.messages, (customType) =>
				harness.session.extensionRunner.getCustomTypePolicy(customType),
			);
			const llmPrompt = JSON.stringify(llmMessages);
			expect(llmPrompt).toContain("loaded full pool text");
			expect(llmPrompt).not.toContain("excluded pool text");
			expect(nextRequest.split("loaded full pool text").length - 1).toBe(1);
			expect(
				harness.session.messages.filter(
					(message) => message.role === "custom" && message.customType === "pool.visible",
				),
			).toHaveLength(1);
			expect(harness.faux.state.callCount).toBe(2);
		} finally {
			allowToolFinish.resolve();
			await run?.catch(() => {});
			harness.cleanup();
		}
	});
});
