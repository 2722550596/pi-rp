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
});
