import { describe, expect, it } from "vitest";
import { PromptRegistryScope } from "../../coding-agent/src/core/prompt-preset/registry-scope.ts";
import type {
	PromptPreset,
	PromptPresetSlotItem,
	PromptRuntime,
} from "../../coding-agent/src/core/prompt-preset/types.ts";
import { renderSlotAsync, renderSlotSync } from "../src/browser-slot-renderers.ts";

const preset: PromptPreset = { schemaVersion: 1, id: "fixture", items: [] };
const item: PromptPresetSlotItem = { kind: "slot", id: "identity", slot: "identity" };

function runtime(scope: PromptRegistryScope): PromptRuntime {
	return { promptRegistry: scope } as PromptRuntime;
}

describe("browser session-scoped prompt slots", () => {
	it("renders same-name slot definitions from each session registry without cross-talk", () => {
		const first = new PromptRegistryScope();
		const second = new PromptRegistryScope();
		first.registerSlot({ name: "identity", description: "first", render: () => "Writer" });
		second.registerSlot({ name: "identity", description: "second", render: () => "Screenwriter" });
		const diagnostics = [];
		expect(renderSlotSync(item, preset, runtime(first), diagnostics)).toBe("Writer");
		expect(renderSlotSync(item, preset, runtime(second), diagnostics)).toBe("Screenwriter");
		expect(diagnostics).toEqual([]);
	});

	it("awaits async slot rendering and falls back to unknown-slot warning for missing definitions", async () => {
		const scope = new PromptRegistryScope();
		scope.registerSlot({ name: "identity", description: "async", async: true, render: async () => "loaded" });
		expect(await renderSlotAsync(item, preset, runtime(scope), [])).toBe("loaded");
		expect(() => renderSlotSync(item, preset, runtime(scope), [])).toThrow("requires async prompt compilation");
		// 未知 slot 与 coding-agent 原生语义一致：warning + 占位，不抛错（内建 slot 在
		// 工具禁用等场景可能无定义，抛错会破坏既有 preset 编译）。
		const diagnostics: PromptPresetDiagnostic[] = [];
		await expect(renderSlotAsync(item, preset, runtime(new PromptRegistryScope()), diagnostics)).resolves.toBe(
			"[unknown slot: identity]",
		);
		expect(diagnostics.some((d) => d.level === "warning" && d.message.includes("identity"))).toBe(true);
	});
});
