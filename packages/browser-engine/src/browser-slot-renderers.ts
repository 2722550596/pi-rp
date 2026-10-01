/**
 * Browser-profile slot renderers — alias target for `core/prompt-preset/slot-renderers.ts`
 * (12-C 禁止清单：渲染器留守面不进 browser bundle；node 构建不受影响).
 *
 * `isChatHistoryPosition` 是编译路径的纯判定（slot-registry 查表），按源语义保留；
 * `renderSlotSync`/`renderSlotAsync` 在浏览器剖面按「该 slot 不由浏览器编译路径渲染」
 * 降级（与源实现中 async slot 的既有降级分支同型，diagnostics 记 info）。
 */
import { getSlot, registerSlot } from "../../coding-agent/src/core/prompt-preset/slot-registry.ts";
import type {
	PromptPreset,
	PromptPresetDiagnostic,
	PromptPresetItem,
	PromptPresetSlotItem,
	PromptRuntime,
} from "../../coding-agent/src/core/prompt-preset/types.ts";

// 内建槽的「定义面」必须在浏览器剖面同样注册：compileMessages 靠
// getSlot(item.slot)?.position === "chat-history" 定位对话插入点（compiler.ts
// chatHistoryIndex），别名替换整个 slot-renderers 模块会把 node 侧的顶层
// registerSlot 一并丢掉——缺座时 chat-history 判定失效，对话历史被追加到
// 编译产物末尾（任务指令之后），side request（/choice 等）读到「指令在历史前」
// 的倒序上下文。渲染面仍按下方降级（12-C 禁止清单不动）；这里只补回编译路径
// 消费的纯元数据。未来若 compiler 再消费新的 position/async 元数据，需同步在此注册。
registerSlot(
	{
		name: "chat-history",
		description: "Conversation history insertion point.",
		position: "chat-history",
		render: (): string => "",
	},
	true,
);

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
