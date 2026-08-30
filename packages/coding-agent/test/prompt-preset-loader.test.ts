import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPromptPresets } from "../src/core/prompt-preset/loader.ts";

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function writePresetFile(contents: Record<string, unknown>): string {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-preset-loader-"));
	tempDirs.push(tempDir);
	const presetDir = join(tempDir, ".pi", "prompt-presets");
	mkdirSync(presetDir, { recursive: true });
	writeFileSync(join(presetDir, "test.json"), JSON.stringify(contents));
	return tempDir;
}

describe("prompt preset loader", () => {
	it("copies hiddenOverrides.compaction.branchSummaryPrompt from preset JSON", () => {
		const cwd = writePresetFile({
			schemaVersion: 1,
			id: "test",
			items: [],
			hiddenOverrides: {
				compaction: {
					systemPrompt: "summarize",
					branchSummaryPrompt: "summarize branch",
				},
			},
		});

		const loaded = loadPromptPresets(cwd);
		expect(loaded).toHaveLength(1);
		expect(loaded[0].diagnostics).toEqual([]);
		expect(loaded[0].preset.hiddenOverrides?.compaction?.branchSummaryPrompt).toBe("summarize branch");
		expect(loaded[0].preset.hiddenOverrides?.compaction?.systemPrompt).toBe("summarize");
	});

	it("normalizes wrap on block and slot items", () => {
		const cwd = writePresetFile({
			schemaVersion: 1,
			id: "test",
			items: [
				{ kind: "block", id: "b", content: "x", wrap: "context" },
				{ kind: "slot", id: "s", slot: "tools", wrap: { tag: "tools_wrap", attrs: { lang: "zh" } } },
			],
		});

		const loaded = loadPromptPresets(cwd);
		expect(loaded[0].diagnostics).toEqual([]);
		expect(loaded[0].preset.items[0]).toMatchObject({ wrap: "context" });
		expect(loaded[0].preset.items[1]).toMatchObject({ wrap: { tag: "tools_wrap", attrs: { lang: "zh" } } });
	});

	it("warns and drops invalid wrap values", () => {
		const cwd = writePresetFile({
			schemaVersion: 1,
			id: "test",
			items: [
				{ kind: "block", id: "b", content: "x", wrap: 42 },
				{ kind: "slot", id: "s", slot: "tools", wrap: { attrs: { lang: "zh" } } },
			],
		});

		const loaded = loadPromptPresets(cwd);
		const warnings = loaded[0].diagnostics.filter((d) => d.level === "warning");
		expect(warnings).toHaveLength(2);
		expect(loaded[0].preset.items[0].wrap).toBeUndefined();
		expect(loaded[0].preset.items[1].wrap).toBeUndefined();
	});

	it("normalizes heading and ending on block and slot items", () => {
		const cwd = writePresetFile({
			schemaVersion: 1,
			id: "test",
			items: [
				{ kind: "block", id: "b", content: "x", heading: "## H", ending: "---" },
				{ kind: "slot", id: "s", slot: "tools", heading: "Tools:", ending: "----" },
			],
		});

		const loaded = loadPromptPresets(cwd);
		expect(loaded[0].diagnostics).toEqual([]);
		expect(loaded[0].preset.items[0]).toMatchObject({ heading: "## H", ending: "---" });
		expect(loaded[0].preset.items[1]).toMatchObject({ heading: "Tools:", ending: "----" });
	});

	it("ignores numeric heading and ending values", () => {
		const cwd = writePresetFile({
			schemaVersion: 1,
			id: "test",
			items: [{ kind: "block", id: "b", content: "x", heading: 42, ending: 99 }],
		});

		const loaded = loadPromptPresets(cwd);
		expect(loaded[0].diagnostics).toEqual([]);
		expect(loaded[0].preset.items[0].heading).toBeUndefined();
		expect(loaded[0].preset.items[0].ending).toBeUndefined();
	});

	it("keeps every documented compaction override field", () => {
		const cwd = writePresetFile({
			schemaVersion: 1,
			id: "test",
			items: [],
			hiddenOverrides: {
				compaction: {
					systemPrompt: "s",
					initialPrompt: "i",
					updatePrompt: "u",
					turnPrefixPrompt: "t",
					branchSummaryPrompt: "b",
				},
			},
		});

		const loaded = loadPromptPresets(cwd);
		expect(loaded[0].preset.hiddenOverrides?.compaction).toEqual({
			systemPrompt: "s",
			initialPrompt: "i",
			updatePrompt: "u",
			turnPrefixPrompt: "t",
			branchSummaryPrompt: "b",
		});
	});

	it("passes through chat-history toolMode drop + dropToolNames whitelist", () => {
		const cwd = writePresetFile({
			schemaVersion: 1,
			id: "test",
			items: [
				{
					kind: "slot",
					id: "chat",
					slot: "chat-history",
					options: { toolMode: "drop", dropToolNames: ["show_html"] },
				},
			],
		});

		const loaded = loadPromptPresets(cwd);
		expect(loaded[0].diagnostics).toEqual([]);
		expect(loaded[0].preset.items[0]).toMatchObject({
			options: { toolMode: "drop", dropToolNames: ["show_html"] },
		});
	});

	it("drops non-string dropToolNames entries instead of passing garbage through", () => {
		const cwd = writePresetFile({
			schemaVersion: 1,
			id: "test",
			items: [
				{
					kind: "slot",
					id: "chat",
					slot: "chat-history",
					options: { toolMode: "drop", dropToolNames: ["show_html", 42] },
				},
			],
		});

		const loaded = loadPromptPresets(cwd);
		expect(loaded[0].preset.items[0]).toMatchObject({ options: { dropToolNames: ["show_html"] } });
	});
});
