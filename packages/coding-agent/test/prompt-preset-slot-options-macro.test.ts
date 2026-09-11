import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileMessages } from "../src/core/prompt-preset/compiler.ts";
import { registerSlot } from "../src/core/prompt-preset/slot-renderers.ts";
import type { PromptPreset, PromptRuntime, SlotRenderContext } from "../src/core/prompt-preset/types.ts";

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-slot-options-"));
	tempDirs.push(dir);
	return dir;
}

function makeRuntime(cwd: string, variables: Record<string, string>): PromptRuntime {
	return {
		options: {
			cwd,
			skills: [],
			contextFiles: [],
			customPrompt: undefined,
			appendSystemPrompt: undefined,
			selectedTools: [],
			toolSnippets: {},
			promptGuidelines: [],
		},
		messages: [],
		latestUserMessage: undefined,
		now: new Date(),
		variables,
		skills: [],
	};
}

function makePreset(items: PromptPreset["items"]): PromptPreset {
	return { schemaVersion: 1, id: "test", items };
}

// Custom slot that echoes its (post-expansion) options back as JSON, so tests
// can observe exactly what the renderers receive after macro expansion.
registerSlot(
	{
		name: "options-probe",
		description: "Echo slot options as JSON for tests.",
		render: (ctx: SlotRenderContext): string => JSON.stringify(ctx.item.options ?? {}),
	},
	false,
);

describe("slot options macro expansion (C3)", () => {
	afterEach(() => {
		while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
	});

	it("expands {{macros}} in a file slot's path option and reads the resolved file", async () => {
		const cwd = makeTempDir();
		writeFileSync(join(cwd, "w.md"), "hello from w.md");
		const preset = makePreset([
			{ kind: "block", id: "intro", role: "system", content: "Intro" },
			{ kind: "slot", id: "f", role: "system", slot: "file", options: { path: "{{name}}.md" } },
		]);

		const compiled = await compileMessages(preset, makeRuntime(cwd, { name: "w" }));

		expect(compiled.diagnostics.filter((d) => d.level === "error")).toEqual([]);
		const allText = compiled.messages.map((m) => JSON.stringify(m.content)).join("\n");
		expect(allText).toContain("hello from w.md");
	});

	it("expands only string leaves; numbers, arrays and booleans pass through unchanged", async () => {
		const cwd = makeTempDir();
		const preset = makePreset([
			{
				kind: "slot",
				id: "probe",
				role: "system",
				slot: "options-probe",
				options: {
					path: "{{name}}.md",
					maxMessages: 5,
					roles: ["user"],
					glob: false,
					sort: true,
					allowNamespace: ["world"],
				},
			},
		]);

		const compiled = await compileMessages(preset, makeRuntime(cwd, { name: "w" }));

		expect(compiled.diagnostics.filter((d) => d.level === "error")).toEqual([]);
		const probeMessage = compiled.messages.find((m) => m.role === "system");
		expect(probeMessage).toBeDefined();
		const text = probeMessage!.content as Array<{ type: string; text?: string }>;
		const echoed = JSON.parse(
			text
				.filter((p) => p.type === "text")
				.map((p) => p.text)
				.join("\n"),
		);

		expect(echoed.path).toBe("w.md"); // string leaf: expanded
		expect(echoed.maxMessages).toBe(5); // number: unchanged
		expect(echoed.roles).toEqual(["user"]); // array: unchanged
		expect(echoed.glob).toBe(false); // boolean: unchanged
		expect(echoed.sort).toBe(true); // boolean: unchanged
		expect(echoed.allowNamespace).toEqual(["world"]); // array: unchanged
	});

	it("keeps unresolved macros as placeholders without error when no unresolvedMacroPolicy is set", async () => {
		const cwd = makeTempDir();
		const preset = makePreset([
			{
				kind: "slot",
				id: "probe",
				role: "system",
				slot: "options-probe",
				options: { path: "{{missing}}.md" },
			},
		]);

		const compiled = await compileMessages(preset, makeRuntime(cwd, {}));

		// No error despite the unresolved macro; placeholder is preserved.
		expect(compiled.diagnostics.filter((d) => d.level === "error")).toEqual([]);
		const probeMessage = compiled.messages.find((m) => m.role === "system");
		expect(probeMessage).toBeDefined();
		const text = probeMessage!.content as Array<{ type: string; text?: string }>;
		const echoed = JSON.parse(
			text
				.filter((p) => p.type === "text")
				.map((p) => p.text)
				.join("\n"),
		);
		expect(echoed.path).toBe("{{missing}}.md");
	});
});
