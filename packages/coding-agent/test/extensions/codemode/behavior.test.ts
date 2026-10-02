import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionToolContext, ToolLoadout } from "../../../src/core/extensions/types.ts";
import type { SessionEntry } from "../../../src/core/session-manager.ts";
import { executeCodemode, readCodemodeStore } from "../../../src/extensions/codemode/execute.ts";
import { createCodemodeExtension } from "../../../src/extensions/codemode/index.ts";
import { createCodemodeToolDefinition } from "../../../src/extensions/codemode/tool.ts";

const echoParameters = Type.Object({ text: Type.String() });
const echoTool: AgentTool<typeof echoParameters> = {
	name: "echo",
	label: "Echo",
	description: "Echo a string",
	parameters: echoParameters,
	execute: async () => ({ content: [{ type: "text", text: "unused" }], details: {} }),
};

function mockLoadout(): ToolLoadout {
	const deferredTool = { ...echoTool, name: "delayed" };
	const remoteTool = { ...echoTool, name: "remote" };
	const hiddenTool = { ...echoTool, name: "hidden" };
	const exposures = new Map([
		["echo", "direct"],
		["delayed", "deferred"],
		["remote", "codemode"],
		["hidden", "hidden"],
	] as const);
	return {
		declared: [echoTool],
		callable: [echoTool, deferredTool, remoteTool],
		registered: [echoTool, deferredTool, remoteTool, hiddenTool],
		getExposure: (name) => exposures.get(name) ?? "hidden",
		getNamespace: (name) =>
			name === "remote"
				? { name: "mcp:server", description: "server tools", instructions: "use safely" }
				: undefined,
	};
}

function fakeContext(options: { allowed?: boolean; aborted?: boolean; fail?: boolean } = {}) {
	const branch: SessionEntry[] = [];
	const appended: unknown[] = [];
	let executionCount = 0;
	const context = {
		tools: options.allowed === false ? [] : [echoTool],
		sessionManager: { getBranch: () => branch },
		executeTool: async (name: string, args: unknown, callOptions?: { signal?: AbortSignal }) => {
			executionCount++;
			if (name !== "echo" || options.allowed === false) {
				return {
					result: { content: [{ type: "text", text: "Tool unavailable" }], details: undefined },
					isError: true,
					status: "error",
				};
			}
			if (options.aborted || callOptions?.signal?.aborted) {
				return {
					result: { content: [{ type: "text", text: "Aborted" }], details: undefined },
					isError: true,
					status: "aborted",
				};
			}
			if (options.fail) {
				return {
					result: { content: [{ type: "text", text: "Rejected by policy" }], details: undefined },
					isError: true,
					status: "error",
				};
			}
			if (!args || typeof args !== "object" || !("text" in args) || typeof args.text !== "string") {
				throw new Error("Invalid echo arguments");
			}
			return {
				result: { content: [{ type: "text", text: `echo:${args.text}` }], details: undefined },
				isError: false,
				status: "success",
			};
		},
	} as unknown as ExtensionToolContext;
	return {
		context,
		branch,
		appended,
		count: () => executionCount,
		append: (customType: string, data: unknown) => {
			appended.push({ customType, data });
			branch.push({
				type: "custom",
				customType,
				data,
				id: `entry-${branch.length}`,
				parentId: null,
				timestamp: new Date(0).toISOString(),
			} as SessionEntry);
		},
	};
}

describe("codemode extension adapter", () => {
	it("registers an inactive model-only tool and prepares callable exposure catalog", async () => {
		let registered: Record<string, unknown> | undefined;
		let sessionStart: ((...args: never[]) => unknown) | undefined;
		createCodemodeExtension()({
			registerTool: (tool: Record<string, unknown>) => {
				registered = tool;
			},
			appendEntry: () => {},
			getAllTools: () => [],
			on: (event: string, handler: (...args: never[]) => unknown) => {
				if (event === "session_start") sessionStart = handler;
			},
		} as unknown as ExtensionAPI);
		await sessionStart?.({} as never, { settings: {} } as never);
		expect(registered).toMatchObject({ name: "codemode", exposure: "model-only", defaultActive: false });

		const onDefinition = createCodemodeToolDefinition({ models: false, getMode: () => "on" });
		const onPrepared = onDefinition.prepareLoadout?.(mockLoadout());
		expect(onPrepared?.descriptions?.echo).toContain("Codemode: `tools.echo(args)`");
		expect(onPrepared?.descriptions?.codemode).not.toContain("### `echo`");
		const definition = createCodemodeToolDefinition({ models: false, getMode: () => "only" });
		const prepared = definition.prepareLoadout?.(mockLoadout());
		expect(prepared?.descriptions?.codemode).toContain("mcp:server");
		expect(prepared?.descriptions?.codemode).toContain("use safely");
		expect(prepared?.descriptions?.codemode).not.toContain("hidden");
		expect(prepared?.descriptions?.codemode).not.toContain("delayed");
		expect(prepared?.hiddenDeclarations).toContain("echo");
	});

	it("routes script calls through executeTool and persists store writes", async () => {
		const fixture = fakeContext();
		const definition = createCodemodeToolDefinition({ appendEntry: fixture.append, models: false });
		const result = await definition.execute(
			"parent",
			{ code: 'store("key", 4); return await tools.echo({ text: "ok" });' },
			undefined,
			undefined,
			fixture.context,
		);
		expect(result.isError).toBeUndefined();
		expect(result.content.map((part) => (part.type === "text" ? part.text : "image")).join("\n")).toContain(
			"echo:ok",
		);
		expect(fixture.count()).toBe(1);
		expect(fixture.appended).toEqual([{ customType: "codemode-store", data: { set: { key: 4 }, delete: [] } }]);
		expect(readCodemodeStore(fixture.branch)).toEqual({ key: 4 });
		const loaded = await definition.execute(
			"parent-2",
			{ code: 'return load("key");' },
			undefined,
			undefined,
			fixture.context,
		);
		expect(
			loaded.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n"),
		).toContain("4");
	});

	it("returns nested failures as script errors and rejects hidden tools before dispatch", async () => {
		const fixture = fakeContext({ allowed: false });
		const failed = await executeCodemode(
			"parent",
			{ code: 'return await tools.hidden({ text: "no" });' },
			undefined,
			undefined,
			fixture.context,
		);
		expect(failed.isError).toBe(true);
		expect(fixture.count()).toBe(0);
		expect(
			failed.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n"),
		).toContain("Script error");
	});
	it("reports nested dispatch failures and cancellation without bypassing the host", async () => {
		const fixture = fakeContext({ fail: true });
		const failed = await executeCodemode(
			"parent",
			{ code: 'try { await tools.echo({ text: "no" }); } catch (error) { return error.message; }' },
			undefined,
			undefined,
			fixture.context,
		);
		expect(failed.isError).toBeUndefined();
		expect(
			failed.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n"),
		).toContain("Rejected by policy");
		expect(failed.details?.calls).toMatchObject([{ id: "parent/1", status: "error", error: "Rejected by policy" }]);
		expect(fixture.count()).toBe(1);

		const cancelled = fakeContext({ aborted: true });
		const result = await executeCodemode(
			"parent",
			{ code: 'try { await tools.echo({ text: "stop" }); } catch (error) { return error.message; }' },
			undefined,
			undefined,
			cancelled.context,
		);
		expect(result.details?.calls).toMatchObject([{ status: "cancelled", error: "Aborted" }]);
	});

	it("bounds nested calls and gives scripts a catchable limit error", async () => {
		const fixture = fakeContext();
		const result = await executeCodemode(
			"parent",
			{
				code: 'let failure; for (let i = 0; i < 129; i++) { try { await tools.echo({ text: "x" }); } catch (error) { failure = error.message; break; } } return failure;',
			},
			undefined,
			undefined,
			fixture.context,
		);
		expect(fixture.count()).toBe(128);
		expect(result.details?.calls).toHaveLength(128);
		expect(new Set(result.details?.calls.map((call) => call.id)).size).toBe(128);
		expect(
			result.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n"),
		).toContain("at most 128 nested tool calls");
	});

	it("passes abort through sandbox execution", async () => {
		const fixture = fakeContext();
		const controller = new AbortController();
		controller.abort();
		const result = await executeCodemode(
			"parent",
			{ code: "while (true) {}" },
			controller.signal,
			undefined,
			fixture.context,
		);
		expect(result.isError).toBe(true);
	});
});
