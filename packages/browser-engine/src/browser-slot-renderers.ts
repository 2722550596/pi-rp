import type { PromptRegistryReader } from "../../coding-agent/src/core/prompt-preset/registry-scope.ts";
import { getSlot, registerSlot } from "../../coding-agent/src/core/prompt-preset/slot-registry.ts";
import type {
	PromptPreset,
	PromptPresetDiagnostic,
	PromptPresetItem,
	PromptPresetSlotItem,
	PromptRuntime,
	SlotDefinition,
} from "../../coding-agent/src/core/prompt-preset/types.ts";

registerSlot(
	{
		name: "chat-history",
		description: "Conversation history insertion point.",
		position: "chat-history",
		render: () => "",
	},
	true,
);

export function isChatHistoryPosition(item: PromptPresetItem, scope?: PromptRegistryReader): boolean {
	return item.kind === "slot" && getSlot(item.slot, scope)?.position === "chat-history";
}

function getBrowserSlot(item: PromptPresetSlotItem, runtime: PromptRuntime): SlotDefinition | undefined {
	return getSlot(item.slot, runtime.promptRegistry);
}

function unknownSlotWarning(item: PromptPresetSlotItem, diagnostics: PromptPresetDiagnostic[]): string {
	diagnostics.push({
		level: "warning",
		message: `Unknown slot "${item.slot}"`,
		itemId: item.id,
	});
	return `[unknown slot: ${item.slot}]`;
}

function replacementFor(slotId: string, runtime: PromptRuntime): string | undefined {
	return runtime.promptRegistry?.getContextSlotContent?.(slotId);
}

function slotRenderError(slotId: string, cause: unknown): Error {
	return new Error(`pi-harness: rendering prompt slot ${JSON.stringify(slotId)} failed`, { cause });
}

export function renderSlotSync(
	item: PromptPresetSlotItem,
	preset: PromptPreset,
	runtime: PromptRuntime,
	diagnostics: PromptPresetDiagnostic[],
): string {
	const definition = getBrowserSlot(item, runtime);
	if (!definition) return unknownSlotWarning(item, diagnostics);
	if (definition.position === "chat-history") return "";
	const replacement = replacementFor(item.slot, runtime);
	if (replacement !== undefined) return replacement;
	if (definition.async) {
		throw new Error(
			`pi-harness: asynchronous prompt slot ${JSON.stringify(item.slot)} requires async prompt compilation`,
		);
	}
	let rendered: string | Promise<string>;
	try {
		rendered = definition.render({ runtime, preset, item, diagnostics });
	} catch (error) {
		throw slotRenderError(item.slot, error);
	}
	if (typeof rendered !== "string") {
		void rendered.catch(() => {});
		throw new Error(`pi-harness: prompt slot ${JSON.stringify(item.slot)} returned a Promise without async:true`);
	}
	return rendered;
}

export async function renderSlotAsync(
	item: PromptPresetSlotItem,
	preset: PromptPreset,
	runtime: PromptRuntime,
	diagnostics: PromptPresetDiagnostic[],
): Promise<string> {
	const definition = getBrowserSlot(item, runtime);
	if (!definition) return unknownSlotWarning(item, diagnostics);
	if (definition.position === "chat-history") return "";
	const replacement = replacementFor(item.slot, runtime);
	if (replacement !== undefined) return replacement;
	try {
		return await definition.render({ runtime, preset, item, diagnostics });
	} catch (error) {
		throw slotRenderError(item.slot, error);
	}
}
