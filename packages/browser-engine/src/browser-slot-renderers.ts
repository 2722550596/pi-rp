/**
 * Browser-profile slot renderers — alias target for `core/prompt-preset/slot-renderers.ts`
 * (12-C 禁止清单：渲染器留守面不进 browser bundle；node 构建不受影响).
 *
 * `isChatHistoryPosition` 是编译路径的纯判定（slot-registry 查表），按源语义保留；
 * `renderSlotSync`/`renderSlotAsync` 在浏览器剖面按「该 slot 不由浏览器编译路径渲染」
 * 降级（与源实现中 async slot 的既有降级分支同型，diagnostics 记 info）。
 */
import { getSlot } from "../../coding-agent/src/core/prompt-preset/slot-registry.ts";
import type {
	PromptPreset,
	PromptPresetDiagnostic,
	PromptPresetItem,
	PromptPresetSlotItem,
	PromptRuntime,
} from "../../coding-agent/src/core/prompt-preset/types.ts";

export function isChatHistoryPosition(item: PromptPresetItem): boolean {
	return item.kind === "slot" && getSlot(item.slot)?.position === "chat-history";
}

export function renderSlotSync(
	item: PromptPresetSlotItem,
	_preset: PromptPreset,
	_runtime: PromptRuntime,
	diagnostics: PromptPresetDiagnostic[],
): string {
	diagnostics.push({
		level: "info",
		message: `Slot "${item.slot}" is not rendered by the browser compile path.`,
		itemId: item.id,
	});
	return "";
}

export async function renderSlotAsync(
	item: PromptPresetSlotItem,
	_preset: PromptPreset,
	_runtime: PromptRuntime,
	diagnostics: PromptPresetDiagnostic[],
): Promise<string> {
	diagnostics.push({
		level: "info",
		message: `Slot "${item.slot}" is not rendered by the browser compile path.`,
		itemId: item.id,
	});
	return "";
}
