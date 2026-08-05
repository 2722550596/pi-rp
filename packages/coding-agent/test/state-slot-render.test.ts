import { describe, expect, it } from "vitest";
import { getSlot } from "../src/core/prompt-preset/slot-renderers.ts";
import type { PromptPresetSlotItem, SlotRenderContext } from "../src/core/prompt-preset/types.ts";

function renderState(state: Record<string, unknown>, options?: PromptPresetSlotItem["options"]): string {
	const slot = getSlot("state");
	if (!slot) throw new Error("state slot not registered");
	const item: PromptPresetSlotItem = { kind: "slot", id: "state", slot: "state", options };
	// Test-only minimal context; the renderer only reads runtime.state and item.options.
	const ctx = {
		runtime: { state },
		item,
		preset: { schemaVersion: 1, id: "test", items: [] },
		diagnostics: [],
	} as unknown as SlotRenderContext;
	return slot.render(ctx);
}

describe("state slot", () => {
	it("renders nothing for empty state", () => {
		expect(renderState({})).toBe("");
	});

	it("defaults to key-value format with dot-notation paths", () => {
		const out = renderState({ magnolia: { character: { hp: 50 }, gold: 10 } });
		expect(out).toBe("magnolia.character.hp: 50\nmagnolia.gold: 10");
	});

	it("renders pretty-printed JSON with format json", () => {
		const out = renderState({ magnolia: { character: { hp: 50 } } }, { format: "json" });
		expect(out).toBe('{\n  "magnolia": {\n    "character": {\n      "hp": 50\n    }\n  }\n}');
	});

	it("renders YAML with format yaml, sharing keys under one parent", () => {
		const out = renderState({ magnolia: { character: { hp: 50, name: "wanderer" }, gold: 10 } }, { format: "yaml" });
		expect(out).toBe("magnolia:\n  character:\n    hp: 50\n    name: wanderer\n  gold: 10\n");
	});

	it("omits the namespace prefix in key-value format", () => {
		const out = renderState({ magnolia: { character: { hp: 50 }, gold: 10 } }, { omitNamespace: true });
		expect(out).toBe("character.hp: 50\ngold: 10");
	});

	it("omits the namespace prefix in yaml format", () => {
		const out = renderState(
			{ magnolia: { character: { hp: 50 } }, gold: 10 },
			{ format: "yaml", omitNamespace: true },
		);
		expect(out).toBe("character:\n  hp: 50\ngold: 10\n");
	});

	it("omits the namespace prefix in json format", () => {
		const out = renderState({ magnolia: { character: { hp: 50 } } }, { format: "json", omitNamespace: true });
		expect(out).toBe('{\n  "character": {\n    "hp": 50\n  }\n}');
	});

	it("keeps scalar top-level values under omitNamespace (no namespace level to drop)", () => {
		const out = renderState({ magnolia: { hp: 50 }, misc: 5 }, { format: "yaml", omitNamespace: true });
		expect(out).toBe("hp: 50\nmisc: 5\n");
	});
});
