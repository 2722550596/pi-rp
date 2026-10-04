import { expect, it } from "vitest";
import { PromptRegistryScope } from "../../coding-agent/src/core/prompt-preset/registry-scope.ts";
import type {
	PromptPreset,
	PromptPresetSlotItem,
	PromptRuntime,
} from "../../coding-agent/src/core/prompt-preset/types.ts";
import { renderSlotSync } from "../src/browser-slot-renderers.ts";

const preset: PromptPreset = { schemaVersion: 1, id: "fixture", items: [] };
const item: PromptPresetSlotItem = { kind: "slot", id: "pool", slot: "sefirot.pool" };

it("renders the latest compact replacement for the same scoped slot without accumulating values", () => {
	const scope = new PromptRegistryScope();
	scope.registerSlot({ name: "sefirot.pool", description: "pool context", render: () => "renderer fallback" });
	const runtime = { promptRegistry: scope } as PromptRuntime;
	scope.replaceContextSlots([{ slotId: "sefirot.pool", content: "first snapshot" }]);
	expect(renderSlotSync(item, preset, runtime, [])).toBe("first snapshot");
	scope.replaceContextSlots([{ slotId: "sefirot.pool", content: "new snapshot" }]);
	expect(renderSlotSync(item, preset, runtime, [])).toBe("new snapshot");
});
