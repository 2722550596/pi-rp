import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { ExtensionFactory, ToolDefinition } from "../../../src/core/extensions/types.ts";
import { createHarnessWithExtensions } from "../../test-harness.ts";

const emptyParameters = Type.Object({});

function registeredTool(
	name: string,
	fields: Partial<
		Pick<ToolDefinition, "exposure" | "defaultActive" | "deferrable" | "namespace" | "annotations">
	> = {},
): ToolDefinition {
	return {
		name,
		label: name,
		description: `${name} description`,
		parameters: emptyParameters,
		...fields,
		execute: async () => ({ content: [{ type: "text", text: name }], details: {} }),
	};
}

describe("extension tool loadout integration", () => {
	it("honors defaultActive and preserves explicit activation transitions", async () => {
		const extension: ExtensionFactory = (pi) => {
			pi.registerTool(registeredTool("active"));
			pi.registerTool(registeredTool("inactive", { defaultActive: false }));
			pi.registerTool(registeredTool("deferred", { exposure: "deferred", defaultActive: false }));
		};
		const harness = await createHarnessWithExtensions({ extensionFactories: [extension] });
		try {
			expect(harness.session.getActiveToolNames()).toContain("active");
			expect(harness.session.getActiveToolNames()).not.toContain("inactive");
			expect(harness.session.getActiveToolNames()).not.toContain("deferred");

			harness.session.setActiveToolsByName(["inactive", "deferred"]);
			expect(harness.session.getActiveToolNames()).toEqual(["inactive", "deferred"]);
			expect(harness.session.agent.state.tools.map((tool) => tool.name)).toEqual(["inactive", "deferred"]);
		} finally {
			harness.cleanup();
		}
	});

	it("activates tool search for deferrable direct tools without exposing hidden tools", async () => {
		const extension: ExtensionFactory = (pi) => {
			pi.registerTool(registeredTool("searchable", { deferrable: true }));
			pi.registerTool(registeredTool("private", { exposure: "hidden", deferrable: true }));
		};
		const harness = await createHarnessWithExtensions({
			extensionFactories: [extension],
			settings: { toolSearch: { mode: "on" } },
		});
		try {
			await harness.session.prompt("activate search", { expandPromptTemplates: false });
			expect(harness.session.getActiveToolNames()).toContain("tool_search");
			expect(harness.session.getActiveToolNames()).not.toContain("searchable");
			expect(harness.session.getActiveToolNames()).not.toContain("private");
			expect(harness.session.getAllTools().find((tool) => tool.name === "private")?.exposure).toBe("hidden");
		} finally {
			harness.cleanup();
		}
	});

	it("hides direct declarations in mode-only while nested calls retain hooks and structured results", async () => {
		const toolCallEvents: Array<{ toolName: string; parentToolCallId?: string }> = [];
		const toolResultEvents: Array<{ toolName: string; parentToolCallId?: string; isError: boolean }> = [];
		let runtimeAnnotations: unknown;
		let runtimeNamespace: unknown;
		let preparedNamespace: { name: string; description?: string } | undefined;
		let authorizedToolNames: string[] = [];
		const extension: ExtensionFactory = (pi) => {
			pi.on("tool_call", (event) => {
				toolCallEvents.push({ toolName: event.toolName, parentToolCallId: event.parentToolCallId });
			});
			pi.on("tool_result", (event) => {
				toolResultEvents.push({
					toolName: event.toolName,
					parentToolCallId: event.parentToolCallId,
					isError: event.isError,
				});
				if (event.toolName === "target") {
					return {
						content: [{ type: "text", text: "hooked child" }],
						structuredContent: { source: "after-hook" },
					};
				}
			});
			pi.registerTool({
				...registeredTool("target", {
					namespace: { name: "target", description: "Target tools" },
					annotations: { readOnlyHint: true },
				}),
				execute: async () => ({
					content: [{ type: "text", text: "raw child" }],
					details: { original: true },
					structuredContent: { source: "tool" },
					isError: true,
				}),
			});
			pi.registerTool({
				...registeredTool("hidden"),
				exposure: "hidden",
			});
			pi.registerTool({
				...registeredTool("orchestrator"),
				exposure: "model-only",
				defaultActive: true,
				prepareLoadout: (loadout) => {
					preparedNamespace = loadout.getNamespace("target");
					return {
						hiddenDeclarations: loadout.callable
							.filter((tool) => loadout.getExposure(tool.name) === "direct")
							.map((tool) => tool.name),
					};
				},
				execute: async (_id, _args, _signal, _onUpdate, ctx) => {
					authorizedToolNames = ctx.tools.map((tool) => tool.name);
					const registeredTarget = ctx.tools.find((tool) => tool.name === "target");
					runtimeAnnotations = registeredTarget && Reflect.get(registeredTarget, "annotations");
					runtimeNamespace = registeredTarget && Reflect.get(registeredTarget, "namespace");
					const target = await ctx.executeTool("target", {});
					const hidden = await ctx.executeTool("hidden", {});
					return {
						content: target.result.content,
						details: { hiddenStatus: hidden.status },
						structuredContent: target.result.structuredContent,
						isError: target.isError,
					};
				},
			});
		};
		const harness = await createHarnessWithExtensions({
			extensionFactories: [extension],
			responses: [{ toolCalls: [{ id: "parent", name: "orchestrator", args: {} }] }, "finished"],
		});
		try {
			expect(harness.session.agent.state.tools.map((tool) => tool.name)).toContain("orchestrator");
			expect(harness.session.agent.state.tools.map((tool) => tool.name)).not.toContain("target");
			expect(harness.session.getAllTools().find((tool) => tool.name === "target")).toMatchObject({
				namespace: { name: "target", description: "Target tools" },
				annotations: { readOnlyHint: true },
			});
			await harness.session.prompt("run nested tools", { expandPromptTemplates: false });
			expect(runtimeAnnotations).toEqual({ readOnlyHint: true });
			expect(runtimeNamespace).toEqual({ name: "target", description: "Target tools" });
			expect(preparedNamespace).toEqual({ name: "target", description: "Target tools" });
			expect(authorizedToolNames).toContain("target");
			expect(authorizedToolNames).not.toContain("hidden");

			const childCall = toolCallEvents.find((event) => event.toolName === "target");
			const childResult = toolResultEvents.find((event) => event.toolName === "target");
			expect(childCall?.parentToolCallId).toBe("parent");
			expect(childResult).toMatchObject({ parentToolCallId: "parent", isError: true });
			const nestedEnd = harness.events.find(
				(event) => event.type === "tool_execution_end" && event.toolCallId === "parent/1",
			);
			expect(nestedEnd).toMatchObject({
				parentToolCallId: "parent",
				result: { structuredContent: { source: "after-hook" } },
				isError: true,
			});
			const parentEnd = harness.events.find(
				(event) => event.type === "tool_execution_end" && event.toolCallId === "parent",
			);
			expect(parentEnd).toMatchObject({
				result: { structuredContent: { source: "after-hook" }, details: { hiddenStatus: "validation_error" } },
				isError: true,
			});
			expect(toolResultEvents.filter((event) => event.toolName === "target")).toHaveLength(1);
			const transcriptToolResults = harness.session.agent.state.messages.filter(
				(message) => message.role === "toolResult",
			);
			expect(transcriptToolResults).toHaveLength(1);
			expect(transcriptToolResults[0]).toMatchObject({
				toolName: "orchestrator",
				details: { hiddenStatus: "validation_error" },
				isError: true,
			});
		} finally {
			harness.cleanup();
		}
	});

	it("returns aborted nested calls as tool outcomes instead of rejecting", async () => {
		let slowExecuted = false;
		const extension: ExtensionFactory = (pi) => {
			pi.registerTool({
				...registeredTool("slow"),
				execute: async () => {
					slowExecuted = true;
					return { content: [{ type: "text", text: "slow" }], details: {} };
				},
			});
			pi.registerTool({
				...registeredTool("abort-parent"),
				exposure: "model-only",
				defaultActive: true,
				execute: async (_id, _args, _signal, _onUpdate, ctx) => {
					const controller = new AbortController();
					controller.abort();
					const outcome = await ctx.executeTool("slow", {}, { signal: controller.signal });
					return {
						content: [{ type: "text", text: outcome.status }],
						details: { status: outcome.status },
					};
				},
			});
		};
		const harness = await createHarnessWithExtensions({
			extensionFactories: [extension],
			responses: [{ toolCalls: [{ id: "abort-parent-call", name: "abort-parent", args: {} }] }, "done"],
		});
		try {
			await harness.session.prompt("abort nested call", { expandPromptTemplates: false });
			expect(slowExecuted).toBe(false);
			expect(
				harness.session.agent.state.messages.filter((message) => message.role === "toolResult")[0],
			).toMatchObject({
				content: [{ type: "text", text: "aborted" }],
			});
		} finally {
			harness.cleanup();
		}
	});

	it("scopes MCP registration removal to its owner and clears registrations on teardown", async () => {
		const snapshots: string[][] = [];
		const cleared = Promise.withResolvers<void>();
		const factories: ExtensionFactory[] = [
			(pi) => {
				pi.on("session_start", () => {
					pi.registerMcpServer("shared", { type: "http", url: "http://127.0.0.1:9000/mcp" });
				});
				pi.on("mcp_servers_change", (event) => {
					const names = event.servers.map((server) => server.name);
					snapshots.push(names);
					if (names.length === 0) cleared.resolve();
				});
			},
			(pi) => {
				pi.on("session_start", () => {
					pi.unregisterMcpServer("shared");
					snapshots.push(pi.getMcpServers().map((server) => server.name));
				});
			},
		];
		const harness = await createHarnessWithExtensions({ extensionFactories: factories });
		await harness.session.bindExtensions({ mode: "rpc" });
		harness.cleanup();
		await cleared.promise;
		expect(snapshots).toContainEqual(["shared"]);
		expect(snapshots[snapshots.length - 1]).toEqual([]);
	});
});
