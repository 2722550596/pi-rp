import { expect, it } from "vitest";
import { PromptRegistryScope } from "../../coding-agent/src/core/prompt-preset/registry-scope.ts";
import type {
	PromptPreset,
	PromptPresetSlotItem,
	PromptRuntime,
} from "../../coding-agent/src/core/prompt-preset/types.ts";
import { renderSlotAsync, renderSlotSync } from "../src/browser-slot-renderers.ts";

const preset: PromptPreset = { schemaVersion: 1, id: "fixture", items: [] };
const item: PromptPresetSlotItem = { kind: "slot", id: "pool-context", slot: "sefirot.pool" };

function promptRuntime(scope: PromptRegistryScope): PromptRuntime {
	return { promptRegistry: scope } as PromptRuntime;
}

it("reports the slot identity when a renderer throws or rejects", async () => {
	const syncScope = new PromptRegistryScope();
	syncScope.registerSlot({
		name: "sefirot.pool",
		description: "pool",
		render: () => {
			throw new Error("sync failure");
		},
	});
	expect(() => renderSlotSync(item, preset, promptRuntime(syncScope), [])).toThrow(
		'rendering prompt slot "sefirot.pool" failed',
	);

	const asyncScope = new PromptRegistryScope();
	asyncScope.registerSlot({
		name: "sefirot.pool",
		description: "pool",
		async: true,
		render: async () => {
			throw new Error("async failure");
		},
	});
	await expect(renderSlotAsync(item, preset, promptRuntime(asyncScope), [])).rejects.toThrow(
		'rendering prompt slot "sefirot.pool" failed',
	);
});
