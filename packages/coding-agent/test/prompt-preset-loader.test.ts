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

	// ── hiddenOverrides.tempTidy (docs/design/temp-autotidy/02 §3.C) ─────────

	it("parses both tempTidy override fields", () => {
		const cwd = writePresetFile({
			schemaVersion: 1,
			id: "test",
			items: [],
			hiddenOverrides: {
				tempTidy: { systemPrompt: "tidy rules", taskPrompt: "clean TEMP: {temp_list}" },
			},
		});

		const loaded = loadPromptPresets(cwd);
		expect(loaded[0].diagnostics).toEqual([]);
		expect(loaded[0].preset.hiddenOverrides?.tempTidy).toEqual({
			systemPrompt: "tidy rules",
			taskPrompt: "clean TEMP: {temp_list}",
		});
	});

	it("drops non-string tempTidy fields per field", () => {
		const cwd = writePresetFile({
			schemaVersion: 1,
			id: "test",
			items: [],
			hiddenOverrides: {
				tempTidy: { systemPrompt: 42, taskPrompt: { nested: true } },
			},
		});

		const loaded = loadPromptPresets(cwd);
		expect(loaded[0].preset.hiddenOverrides?.tempTidy).toBeUndefined();
		expect(loaded[0].preset.hiddenOverrides).toBeUndefined();
	});

	it("drops blank-string tempTidy fields (deliberate divergence from compaction)", () => {
		const cwd = writePresetFile({
			schemaVersion: 1,
			id: "test",
			items: [],
			hiddenOverrides: {
				// compaction accepts "" verbatim; tempTidy must not: an empty
				// systemPrompt on an unattended background agent is an invisible
				// accident, so whitespace falls back to the built-in default.
				compaction: { systemPrompt: "" },
				tempTidy: { systemPrompt: "", taskPrompt: "   \n\t " },
			},
		});

		const loaded = loadPromptPresets(cwd);
		expect(loaded[0].preset.hiddenOverrides?.compaction?.systemPrompt).toBe("");
		expect(loaded[0].preset.hiddenOverrides?.tempTidy).toBeUndefined();
	});

	it("ignores unknown tempTidy keys and a non-object tempTidy value", () => {
		const cwd = writePresetFile({
			schemaVersion: 1,
			id: "test",
			items: [],
			hiddenOverrides: {
				tempTidy: "not-an-object",
			},
		});

		const loaded = loadPromptPresets(cwd);
		expect(loaded[0].preset.hiddenOverrides).toBeUndefined();

		const cwd2 = writePresetFile({
			schemaVersion: 1,
			id: "test2",
			items: [],
			hiddenOverrides: {
				tempTidy: { systemPrompt: "keep me", briefingPrompt: "unknown key" },
			},
		});

		const loaded2 = loadPromptPresets(cwd2);
		expect(loaded2[0].preset.hiddenOverrides?.tempTidy).toEqual({ systemPrompt: "keep me" });
	});

	it("keeps tempTidy alongside compaction without interference", () => {
		const cwd = writePresetFile({
			schemaVersion: 1,
			id: "test",
			items: [],
			hiddenOverrides: {
				compaction: { systemPrompt: "c" },
				tempTidy: { taskPrompt: "t" },
			},
		});

		const loaded = loadPromptPresets(cwd);
		expect(loaded[0].preset.hiddenOverrides?.compaction).toEqual({ systemPrompt: "c" });
		expect(loaded[0].preset.hiddenOverrides?.tempTidy).toEqual({ taskPrompt: "t" });
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

	it("recurses into nested preset subdirectories (C7)", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-preset-loader-"));
		tempDirs.push(tempDir);
		const presetDir = join(tempDir, ".pi", "prompt-presets");
		mkdirSync(join(presetDir, "nested"), { recursive: true });
		writeFileSync(join(presetDir, "a.json"), JSON.stringify({ schemaVersion: 1, id: "top-a" }));
		writeFileSync(join(presetDir, "nested", "b.json"), JSON.stringify({ schemaVersion: 1, id: "nested-b" }));

		const loaded = loadPromptPresets(tempDir);
		const ids = loaded.map((p) => p.preset.id).sort();
		expect(ids).toEqual(["nested-b", "top-a"]);
	});
});
