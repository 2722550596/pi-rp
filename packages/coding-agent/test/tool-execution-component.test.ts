import { join, resolve } from "node:path";
import { createSchema, generateDiffString, MemoryStore, openDatabase } from "@earendil-works/pi-memory";
import { Text, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { beforeAll, describe, expect, test } from "vitest";
import { getReadmePath } from "../src/config.ts";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { type BashOperations, createBashToolDefinition } from "../src/core/tools/bash.ts";
import { createMemoryToolRenderers } from "../src/core/tools/memory-renderers.ts";
import { createReadTool, createReadToolDefinition } from "../src/core/tools/read.ts";
import { createWriteToolDefinition } from "../src/core/tools/write.ts";
import { renderDiff } from "../src/modes/interactive/components/diff.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createBaseToolDefinition(name = "custom_tool"): ToolDefinition {
	return {
		name,
		label: name,
		description: "custom tool",
		parameters: Type.Any(),
		execute: async () => ({
			content: [{ type: "text", text: "ok" }],
			details: {},
		}),
	};
}

/** Bound renderers for the memory describe block, built in its beforeAll. */
let memoryRenderers: Record<string, unknown>;
let memoryStore: MemoryStore;

/**
 * Mirrors agent-session's synthetic host: renderers spread over a full
 * definition, bound to the live store the renderers were built with.
 */
function createMemoryToolDefinition(name: "memorize" | "revise"): ToolDefinition {
	return { ...createBaseToolDefinition(name), ...(memoryRenderers[name] as object) };
}

function createFakeTui(): TUI {
	return {
		requestRender: () => {},
	} as unknown as TUI;
}

describe("ToolExecutionComponent parity", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("stacks custom call and result renderers like the old implementation", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderCall: () => new Text("custom call", 0, 0),
			renderResult: () => new Text("custom result", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-1",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		expect(stripAnsi(component.render(120).join("\n"))).toContain("custom call");

		component.updateResult(
			{
				content: [{ type: "text", text: "done" }],
				details: {},
				isError: false,
			},
			false,
		);

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("custom call");
		expect(rendered).toContain("custom result");
	});

	test("self-rendered empty tool rows take no layout space", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderShell: "self",
			renderCall: () => new Text("", 0, 0),
			renderResult: () => new Text("", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-empty-self-render",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		expect(component.render(120)).toEqual([]);

		component.updateResult(
			{
				content: [],
				details: {},
				isError: false,
			},
			false,
		);

		expect(component.render(120)).toEqual([]);
	});

	test("uses built-in rendering for built-in overrides without custom renderers", () => {
		const overrideDefinition: ToolDefinition = {
			...createBaseToolDefinition("edit"),
		};

		const component = new ToolExecutionComponent(
			"edit",
			"tool-2",
			{ path: "README.md", oldText: "before", newText: "after" },
			{},
			overrideDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [], details: { diff: "+1 after", firstChangedLine: 1 }, isError: false });
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("edit");
		expect(rendered).toContain("README.md");
		expect(rendered).not.toContain(":1");
	});

	test("preserves legacy file_path rendering compatibility for built-in tools", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-3",
			{ file_path: "README.md" },
			{},
			undefined,
			createFakeTui(),
			process.cwd(),
		);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("read");
		expect(rendered).toContain("README.md");
	});

	test("bash execute emits an initial empty partial update before output arrives", async () => {
		const updates: Array<{ content: Array<{ type: string; text?: string }>; details?: unknown }> = [];
		const operations: BashOperations = {
			exec: async () => {
				await new Promise((resolve) => setTimeout(resolve, 10));
				return { exitCode: 0 };
			},
		};
		const tool = createBashToolDefinition(process.cwd(), { operations, exposeSessionEnvironment: false });
		const promise = tool.execute(
			"tool-bash-1",
			{ command: "sleep 10" },
			undefined,
			(update) => updates.push(update as { content: Array<{ type: string; text?: string }>; details?: unknown }),
			{} as never,
		);
		expect(updates).toEqual([{ content: [], details: undefined }]);
		await promise;
	});

	test("bash renderer does not duplicate final full output truncation details", async () => {
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onData }) => {
				for (let i = 1; i <= 4000; i++) {
					onData(Buffer.from(`line-${String(i).padStart(4, "0")}\n`));
				}
				return { exitCode: 0 };
			},
		};
		const tool = createBashToolDefinition(process.cwd(), { operations, exposeSessionEnvironment: false });
		const result = await tool.execute(
			"tool-bash-1b",
			{ command: "generate output" },
			undefined,
			undefined,
			{} as never,
		);
		const component = new ToolExecutionComponent(
			"bash",
			"tool-bash-1b",
			{ command: "generate output" },
			{},
			tool,
			createFakeTui(),
			process.cwd(),
		);
		component.setExpanded(true);
		component.updateResult({ ...result, isError: false }, false);

		const rendered = stripAnsi(component.render(200).join("\n"));
		expect(rendered.match(/Full output:/g)?.length ?? 0).toBe(1);
		expect(rendered).toMatch(/line-4000[^\n]*\n[^\S\n]*\n \[Full output:/);
		expect(rendered).not.toMatch(/line-4000[^\n]*\n[^\S\n]*\n[^\S\n]*\n \[Full output:/);
		expect(rendered).toContain("Truncated: showing 2000 of 4000 lines");
		expect(rendered).not.toContain("[Showing lines 2001-4000 of 4000. Full output:");
	});

	test("does not duplicate built-in headers when passed the active built-in definition", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-4",
			{ path: "README.md" },
			{},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered.match(/\bread\b/g)?.length ?? 0).toBe(1);
	});

	test("inherits missing built-in result renderer slot from the built-in tool", () => {
		const overrideDefinition: ToolDefinition = {
			...createBaseToolDefinition("read"),
			renderCall: () => new Text("override call", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"read",
			"tool-4b",
			{ path: "notes.txt" },
			{},
			overrideDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		component.setExpanded(true);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("override call");
		expect(rendered).toContain("hello");
	});

	test("inherits missing built-in call renderer slot from the built-in tool", () => {
		const overrideDefinition: ToolDefinition = {
			...createBaseToolDefinition("read"),
			renderResult: () => new Text("override result", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"read",
			"tool-4c",
			{ path: "README.md" },
			{},
			overrideDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("read");
		expect(rendered).toContain("README.md");
		expect(rendered).toContain("override result");
	});

	test("uses custom renderers for built-in overrides that reuse built-in definition parameters", () => {
		const builtInDefinition = createReadToolDefinition(process.cwd());
		const component = new ToolExecutionComponent(
			"read",
			"tool-4d",
			{ path: "README.md" },
			{},
			{
				...builtInDefinition,
				renderCall: () => new Text("override call", 0, 0),
				renderResult: () => new Text("override result", 0, 0),
			},
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("override call");
		expect(rendered).toContain("override result");
		expect(rendered).not.toContain("read README.md");
	});

	test("uses custom renderers for built-in overrides that reuse wrapped built-in tool parameters", () => {
		const builtInTool = createReadTool(process.cwd());
		const component = new ToolExecutionComponent(
			"read",
			"tool-4e",
			{ path: "README.md" },
			{},
			{
				...createBaseToolDefinition("read"),
				parameters: builtInTool.parameters,
				renderCall: () => new Text("wrapped override call", 0, 0),
				renderResult: () => new Text("wrapped override result", 0, 0),
			},
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("wrapped override call");
		expect(rendered).toContain("wrapped override result");
	});

	test("shares renderer state across custom call and result slots", () => {
		type RenderState = { token?: string };
		const toolDefinition: ToolDefinition<any, unknown, RenderState> = {
			...createBaseToolDefinition(),
			renderCall: (_args, _theme, context) => {
				context.state.token ??= "shared-token";
				return new Text(`custom call ${context.state.token}`, 0, 0);
			},
			renderResult: (_result, _options, _theme, context) => {
				return new Text(`custom result ${context.state.token}`, 0, 0);
			},
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-5",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "done" }], details: {}, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("custom call shared-token");
		expect(rendered).toContain("custom result shared-token");
	});

	test("exposes args in render result context", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderCall: () => new Text("call", 0, 0),
			renderResult: (_result, _options, _theme, context) =>
				new Text(`arg:${String((context.args as { foo: string }).foo)}`, 0, 0),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-5b",
			{ foo: "bar" },
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "done" }], details: {}, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("arg:bar");
	});

	test("collapses fallback results until expanded", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-6",
			{ foo: "bar" },
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		const output = Array.from({ length: 15 }, (_, index) => `line-${index + 1}`).join("\n");
		component.updateResult({ content: [{ type: "text", text: output }], details: {}, isError: false }, false);

		const collapsed = stripAnsi(component.render(120).join("\n"));
		expect(collapsed).toContain("custom_tool");
		expect(collapsed).toContain("line-10");
		expect(collapsed).not.toContain("line-11");
		expect(collapsed).toContain("5 more lines");
		expect(collapsed).toContain("to expand");

		component.setExpanded(true);
		const expanded = stripAnsi(component.render(120).join("\n"));
		expect(expanded).toContain("line-15");
		expect(expanded).not.toContain("more lines");
	});

	test("trims trailing blank display lines from write previews", () => {
		const component = new ToolExecutionComponent(
			"write",
			"tool-7",
			{ path: "README.md", content: "one\ntwo\n" },
			{},
			createWriteToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("one");
		expect(rendered).toContain("two");
		expect(rendered).not.toContain("two\n\n");
	});

	test("trims trailing blank display lines from read results", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-8",
			{ path: "notes.txt" },
			{},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{ content: [{ type: "text", text: "one\ntwo\n" }], details: undefined, isError: false },
			false,
		);
		component.setExpanded(true);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("one");
		expect(rendered).toContain("two");
		expect(rendered).not.toContain("two\n\n");
	});

	test("does not syntax-highlight read errors based on the requested file path", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-read-error-highlighting",
			{ path: "config.exs", offset: 120, limit: 130 },
			{},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		const error = "Offset 120 is beyond end of file (96 lines total)";
		component.updateResult({ content: [{ type: "text", text: error }], details: undefined, isError: true }, false);

		const rendered = component.render(120).join("\n");
		expect(stripAnsi(rendered)).toContain(error);
		expect(rendered).toContain(theme.fg("toolOutput", error));
	});

	test("collapses ordinary read results until expanded", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-ordinary-read-collapsed",
			{ path: "notes.txt" },
			{},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{ content: [{ type: "text", text: "hidden content" }], details: undefined, isError: false },
			false,
		);

		const collapsed = stripAnsi(component.render(120).join("\n"));
		expect(collapsed).toContain("read");
		expect(collapsed).toContain("notes.txt");
		expect(collapsed).not.toContain("hidden content");

		component.setExpanded(true);
		const expanded = stripAnsi(component.render(120).join("\n"));
		expect(expanded).toContain("hidden content");
	});

	for (const scenario of [
		{
			title: "SKILL.md",
			path: join(process.cwd(), "attio", "SKILL.md"),
			content: "---\nname: attio\ndescription: CRM helper\n---\n\n# Hidden skill instructions",
			compact: "[skill] attio",
			hidden: "Hidden skill instructions",
			absent: "read skill attio",
		},
		{
			title: "AGENTS.md",
			path: join(process.cwd(), ".pi", "AGENTS.md"),
			content: "Hidden resource instructions",
			compact: "read resource .pi/AGENTS.md",
			hidden: "Hidden resource instructions",
			absent: undefined,
		},
		{
			title: "AGENTS.override.md",
			path: join(process.cwd(), ".pi", "AGENTS.override.md"),
			content: "Hidden override instructions",
			compact: "read resource .pi/AGENTS.override.md",
			hidden: "Hidden override instructions",
			absent: undefined,
		},
		{
			title: "outside AGENTS.md",
			path: resolve(process.cwd(), "..", "AGENTS.md"),
			content: "Hidden outside resource instructions",
			compact: `read resource ${resolve(process.cwd(), "..", "AGENTS.md").replace(/\\/g, "/")}`,
			hidden: "Hidden outside resource instructions",
			absent: undefined,
		},
		{
			title: "Pi documentation",
			path: getReadmePath(),
			content: "Hidden docs content",
			compact: "read docs README.md",
			hidden: "Hidden docs content",
			absent: undefined,
		},
	] as const) {
		test(`renders ${scenario.title} read results compactly until expanded`, () => {
			const component = new ToolExecutionComponent(
				"read",
				`tool-compact-${scenario.title}`,
				{ path: scenario.path },
				{},
				createReadToolDefinition(process.cwd()),
				createFakeTui(),
				process.cwd(),
			);
			component.updateResult(
				{ content: [{ type: "text", text: scenario.content }], details: undefined, isError: false },
				false,
			);

			const collapsed = stripAnsi(component.render(120).join("\n"));
			expect(collapsed).toContain(scenario.compact);
			expect(collapsed).not.toContain(scenario.hidden);
			if (scenario.absent) {
				expect(collapsed).not.toContain(scenario.absent);
			}

			component.setExpanded(true);
			const expanded = stripAnsi(component.render(120).join("\n"));
			expect(expanded).toContain(scenario.hidden);
		});
	}

	for (const scenario of [
		{ title: "SKILL.md", path: join(process.cwd(), "attio", "SKILL.md"), compact: "[skill] attio:120-329" },
		{ title: "Pi documentation", path: getReadmePath(), compact: "read docs README.md:120-329" },
	] as const) {
		test(`shows the read line range in compact ${scenario.title} reads before the expand hint`, () => {
			const component = new ToolExecutionComponent(
				"read",
				`tool-compact-range-${scenario.title}`,
				{ path: scenario.path, offset: 120, limit: 210 },
				{},
				createReadToolDefinition(process.cwd()),
				createFakeTui(),
				process.cwd(),
			);

			const collapsed = stripAnsi(component.render(120).join("\n"));
			expect(collapsed).toContain(scenario.compact);
			expect(collapsed.indexOf(":120-329")).toBeLessThan(collapsed.indexOf("to expand"));
		});
	}
});

describe("memory tool renderers (§16)", () => {
	beforeAll(async () => {
		initTheme("dark");
		const db = await openDatabase(":memory:");
		createSchema(db);
		memoryStore = new MemoryStore(db);
		memoryRenderers = createMemoryToolRenderers(memoryStore) as Record<string, unknown>;
	});

	test("memorize renders streaming args in the call slot (§16 S1)", () => {
		const component = new ToolExecutionComponent(
			"memorize",
			"mem-1",
			{},
			{},
			createMemoryToolDefinition("memorize"),
			createFakeTui(),
			process.cwd(),
		);
		component.updateArgs({ uri: "core://identity", content: "伊莱在酒馆遇到了薇拉" });
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("core://identity");
		expect(rendered).toContain("伊莱在酒馆遇到了薇拉");
	});

	test("memorize call survives the pre-stream window with empty args (§16 F1/F5)", () => {
		const component = new ToolExecutionComponent(
			"memorize",
			"mem-partial",
			{},
			{},
			createMemoryToolDefinition("memorize"),
			createFakeTui(),
			process.cwd(),
		);
		component.updateArgs(undefined);
		expect(() => component.render(120)).not.toThrow();
		component.updateArgs({ uri: "core://identi" });
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("core://identi");
	});

	test("memory renderResult never returns undefined (§16 F4 — undefined crashes the TUI)", () => {
		const component = new ToolExecutionComponent(
			"memorize",
			"mem-2",
			{},
			{},
			createMemoryToolDefinition("memorize"),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [], details: {}, isError: false }, false);
		expect(() => component.render(120)).not.toThrow();
	});

	test("memorize result de-duplicates the uri shown by the call slot (§10.1 T-H)", () => {
		const component = new ToolExecutionComponent(
			"memorize",
			"mem-3",
			{},
			{},
			createMemoryToolDefinition("memorize"),
			createFakeTui(),
			process.cwd(),
		);
		component.updateArgs({ uri: "core://r1", content: "甲" });
		component.updateResult(
			{
				content: [{ type: "text", text: "已记下：core://r1" }],
				details: { node_id: "n1", uri: "core://r1", ok: true },
				isError: false,
			},
			false,
		);
		// The renderer must return a component, never undefined (that crashes render()).
		expect(() => component.render(120)).not.toThrow();
		const out = stripAnsi(component.render(120).join("\n"));
		expect(out.split("core://r1").length - 1).toBe(1);
	});

	test("memorize still renders the error text on failure", () => {
		const component = new ToolExecutionComponent(
			"memorize",
			"mem-err",
			{},
			{},
			createMemoryToolDefinition("memorize"),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{ content: [{ type: "text", text: "已存在：core://x" }], details: {}, isError: true },
			false,
		);
		expect(stripAnsi(component.render(120).join("\n"))).toContain("已存在：core://x");
	});

	test("revise result renders the authoritative diff from details (§10.1 T-B)", () => {
		const component = new ToolExecutionComponent(
			"revise",
			"rev-b",
			{ uri: "core://r1" },
			{},
			createMemoryToolDefinition("revise"),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{
				content: [{ type: "text", text: "已修订：core://r1" }],
				details: { failed: 0, diffs: [{ uri: "core://r1", diff: " 1 甲\n-2 乙\n+2 乙乙\n 3 丙" }] },
				isError: false,
			},
			false,
		);
		const out = stripAnsi(component.render(120).join("\n"));
		expect(out).toContain("+2 乙乙");
		expect(out).toContain("-2 乙");
		expect(out).toContain("已修订：core://r1");
	});

	test("revise keeps the confirmation line when there is no diff (§10.1 T-I)", () => {
		const component = new ToolExecutionComponent(
			"revise",
			"rev-i",
			{ uri: "core://r1" },
			{},
			createMemoryToolDefinition("revise"),
			createFakeTui(),
			process.cwd(),
		);
		// A metadata-only revise: legal input, no diffs key at all.
		component.updateResult(
			{ content: [{ type: "text", text: "已修订：core://r1" }], details: { failed: 0 }, isError: false },
			false,
		);
		expect(stripAnsi(component.render(120).join("\n"))).toContain("已修订：core://r1");
	});

	test("revise survives a hook that replaces details wholesale (§12 U6-6)", () => {
		const component = new ToolExecutionComponent(
			"revise",
			"rev-hook",
			{ uri: "core://r1" },
			{},
			createMemoryToolDefinition("revise"),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{
				content: [{ type: "text", text: "已修订：core://r1" }],
				details: { diffs: "not-an-array" },
				isError: false,
			},
			false,
		);
		expect(() => component.render(120)).not.toThrow();
		expect(stripAnsi(component.render(120).join("\n"))).toContain("已修订：core://r1");
	});

	test("revise diffs land in BOTH slots, never suppressed by the preview (§10.1 T-D)", () => {
		const DIFF = " 1 甲\n-2 乙\n+2 乙乙";
		// Seed the store so path B has a before-body to preview.
		const node = memoryStore.put({
			uri: "core://p1",
			content: "甲\n乙",
			parent_uri: null,
			disclosure: null,
			importance: 5,
			source: "manual",
			model: null,
			anchor_entry_id: null,
			anchor_session_id: null,
			world_ts: null,
		});
		expect(node.uri).toBe("core://p1");

		const component = new ToolExecutionComponent(
			"revise",
			"rev-p1",
			{ uri: "core://p1", old_text: "乙", new_text: "乙乙" },
			{},
			createMemoryToolDefinition("revise"),
			createFakeTui(),
			process.cwd(),
		);
		component.setArgsComplete(); // call slot computes the preview
		component.updateResult(
			{
				content: [{ type: "text", text: "已修订：core://p1" }],
				details: { diffs: [{ uri: "core://p1", diff: DIFF }] },
				isError: false,
			},
			false,
		);
		const out = stripAnsi(component.render(120).join("\n"));
		// Preview (call slot) + authoritative (result slot) = 2 each. A de-dup
		// filter or a missing wire-up both drop this to 1.
		expect(out.split("-2 乙").length - 1).toBe(2);
		expect(out.split("+2 乙乙").length - 1).toBe(2);
	});

	test("revise call previews the pre-edit body once args are complete (§10.1 T-C)", () => {
		memoryStore.put({
			uri: "core://p2",
			content: "甲\n乙\n丙",
			parent_uri: null,
			disclosure: null,
			importance: 5,
			source: "manual",
			model: null,
			anchor_entry_id: null,
			anchor_session_id: null,
			world_ts: null,
		});
		const component = new ToolExecutionComponent(
			"revise",
			"rev-p2",
			{},
			{},
			createMemoryToolDefinition("revise"),
			createFakeTui(),
			process.cwd(),
		);
		component.updateArgs({ uri: "core://p2", old_text: "乙", new_text: "乙乙" });
		const before = stripAnsi(component.render(120).join("\n"));
		expect(before).toContain("替换「乙」->「乙乙」");
		expect(before).not.toContain("+2 乙乙");

		component.setArgsComplete();
		const after = stripAnsi(component.render(120).join("\n"));
		expect(after).toContain("-2 乙");
		expect(after).toContain("+2 乙乙");
	});

	test("the call preview re-reads when only the uri changes", () => {
		for (const [uri, content] of [
			["core://fp1", "一\n二\n三"],
			["core://fp2", "壹\n贰\n叁"],
		] as const) {
			memoryStore.put({
				uri,
				content,
				parent_uri: null,
				disclosure: null,
				importance: 5,
				source: "manual",
				model: null,
				anchor_entry_id: null,
				anchor_session_id: null,
				world_ts: null,
			});
		}
		const component = new ToolExecutionComponent(
			"revise",
			"rev-fp",
			{},
			{},
			createMemoryToolDefinition("revise"),
			createFakeTui(),
			process.cwd(),
		);
		// Same body edit, different node: a fingerprint that ignored the uri would
		// keep the first node's diff on screen.
		component.updateArgs({ uri: "core://fp1", line: 2, line_content: "二改" });
		component.setArgsComplete();
		expect(stripAnsi(component.render(120).join("\n"))).toContain("-2 二");

		component.updateArgs({ uri: "core://fp2", line: 2, line_content: "二改" });
		const out = stripAnsi(component.render(120).join("\n"));
		expect(out).toContain("-2 贰");
		expect(out).not.toContain("-2 二 ");
	});

	test("argsComplete:false still renders the authoritative diff (§10.4 export path)", () => {
		// The HTML export renders with argsComplete:false (tool-renderer.ts:93):
		// the live preview is suppressed, but `details` must still carry the diff.
		memoryStore.put({
			uri: "core://p3",
			content: "甲\n乙\n丙",
			parent_uri: null,
			disclosure: null,
			importance: 5,
			source: "manual",
			model: null,
			anchor_entry_id: null,
			anchor_session_id: null,
			world_ts: null,
		});
		const component = new ToolExecutionComponent(
			"revise",
			"rev-p3",
			{ uri: "core://p3", old_text: "乙", new_text: "乙乙" },
			{},
			createMemoryToolDefinition("revise"),
			createFakeTui(),
			process.cwd(),
		);
		// No setArgsComplete(): args stay "in flight", as in an export.
		expect(stripAnsi(component.render(120).join("\n"))).not.toContain("+2 乙乙");
		component.updateResult(
			{
				content: [{ type: "text", text: "已修订：core://p3" }],
				details: { diffs: [{ uri: "core://p3", diff: " 1 甲\n-2 乙\n+2 乙乙\n 3 丙" }] },
				isError: false,
			},
			false,
		);
		const out = stripAnsi(component.render(120).join("\n"));
		expect(out).toContain("-2 乙");
		expect(out).toContain("+2 乙乙");
	});

	test('revise call renders when:"" as a clear, not an empty condition (§10.1 T-G)', () => {
		const component = new ToolExecutionComponent(
			"revise",
			"rev-when",
			{},
			{},
			createMemoryToolDefinition("revise"),
			createFakeTui(),
			process.cwd(),
		);
		component.updateArgs({ uri: "core://r1", when: "" });
		component.setArgsComplete();
		const out = stripAnsi(component.render(120).join("\n"));
		expect(out).toContain("清除");
		expect(out).not.toContain("「」");
	});

	test("revise call summarises a batch, and never throws on a mod with no uri (§16 F6)", () => {
		const component = new ToolExecutionComponent(
			"revise",
			"rev-1",
			{},
			{},
			createMemoryToolDefinition("revise"),
			createFakeTui(),
			process.cwd(),
		);
		component.updateArgs({
			batch: [{ uri: "core://a", importance: 2 }, { uri: "core://b", append: "（补）" }, { importance: 3 }],
		});
		let rendered = "";
		expect(() => {
			rendered = stripAnsi(component.render(120).join("\n"));
		}).not.toThrow();
		expect(rendered).toContain("core://a");
		expect(rendered).toContain("重要度 → 2");
		expect(rendered).toContain("＋追加「（补）」");
	});

	test("long memorize bodies are truncated to MAX_CALL_LINES (§16 F7)", () => {
		const component = new ToolExecutionComponent(
			"memorize",
			"mem-long",
			{},
			{},
			createMemoryToolDefinition("memorize"),
			createFakeTui(),
			process.cwd(),
		);
		const body = Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 行`).join("\n");
		component.updateArgs({ uri: "core://long", content: body });
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("第 1 行");
		expect(rendered).not.toContain("第 40 行");
		expect(rendered).toContain("30 more lines, 40 total");
	});

	test("expanding shows the rest of a long memorize body (§16 F7)", () => {
		const component = new ToolExecutionComponent(
			"memorize",
			"mem-long-expanded",
			{},
			{},
			createMemoryToolDefinition("memorize"),
			createFakeTui(),
			process.cwd(),
		);
		const body = Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 行`).join("\n");
		component.updateArgs({ uri: "core://long", content: body });
		component.setExpanded(true);
		expect(stripAnsi(component.render(120).join("\n"))).toContain("第 40 行");
	});

	test("memory renderers are injected for exactly the §16 tool names", () => {
		expect(Object.keys(memoryRenderers).sort()).toEqual(["memorize", "revise"]);
	});

	test("memory diffs never degrade to grey context lines (§10.2 T-E)", () => {
		const { diff } = generateDiffString("甲\n乙", "甲\n乙乙");
		const colored = renderDiff(diff);
		// A hand-built "-乙\n+乙乙" would land in grey context: no line-number slot.
		expect(colored).toContain("\u001b[38;2;204;102;102m-2 乙\u001b[39m");
		expect(colored).toContain("\u001b[38;2;181;189;104m+2 乙乙\u001b[39m");
		expect(colored).not.toContain("\u001b[38;2;128;128;128m-2 乙");
	});
});
