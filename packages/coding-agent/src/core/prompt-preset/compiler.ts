export type {
	CompileMessageSource,
	CompileMessagesResult,
	CompileSystemPromptResult,
} from "./types.ts";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { expandMacros } from "./macro-engine.ts";
import { renderSlot } from "./slot-renderers.ts";
import type {
	CompileMessageSource,
	CompileMessagesResult,
	CompileSystemPromptResult,
	PromptPreset,
	PromptPresetBlockItem,
	PromptPresetDiagnostic,
	PromptPresetItem,
	PromptPresetSlotItem,
	PromptRuntime,
} from "./types.ts";

// =========================================================================
// Compile System Prompt
// =========================================================================

export function compileSystemPrompt(
	preset: PromptPreset,
	runtime: PromptRuntime,
	baseSystemPrompt: string,
): CompileSystemPromptResult {
	const diagnostics: PromptPresetDiagnostic[] = [];
	const parts: string[] = [];

	for (const item of enabledItems(preset)) {
		if (item.role !== "system" && item.role !== undefined) continue;
		if (item.kind === "slot" && item.slot === "chat-history") continue;

		const text = renderItemText(item, preset, runtime, diagnostics);
		if (text) parts.push(text);
	}

	const compiled = parts.join("\n\n");
	const mode = preset.mode ?? "replace";

	let systemPrompt: string;
	if (mode === "append" && compiled) {
		systemPrompt = `${baseSystemPrompt}\n\n${compiled}`;
	} else if (mode === "prepend" && compiled) {
		systemPrompt = `${compiled}\n\n${baseSystemPrompt}`;
	} else {
		systemPrompt = compiled || baseSystemPrompt;
	}

	return { systemPrompt, diagnostics };
}

// =========================================================================
// Compile Messages
// =========================================================================

export function compileMessages(preset: PromptPreset, runtime: PromptRuntime): CompileMessagesResult {
	const diagnostics: PromptPresetDiagnostic[] = [];
	const sources: CompileMessageSource[] = [];
	const result: AgentMessage[] = [];
	const items = enabledItems(preset);

	const chatHistoryIndex = items.findIndex(
		(item) => item.kind === "slot" && item.slot === "chat-history",
	);

	const beforeItems = chatHistoryIndex === -1 ? items : items.slice(0, chatHistoryIndex);
	const afterItems = chatHistoryIndex === -1 ? [] : items.slice(chatHistoryIndex + 1);

	for (const item of beforeItems) {
		if (item.role === "system" || item.role === undefined) continue;
		addSyntheticMessage(result, item, preset, runtime, sources, diagnostics);
	}

	if (chatHistoryIndex !== -1) {
		const chatHistoryMessages = runtime.messages;
		const options = (items[chatHistoryIndex] as PromptPresetSlotItem).options;

		let limitedMessages = chatHistoryMessages;
		const maxMessages = options?.maxMessages;
		if (maxMessages && limitedMessages.length > maxMessages) {
			limitedMessages = limitedMessages.slice(-maxMessages);
		}

		const omitLatestUser = options?.omitLatestUser;
		if (omitLatestUser && limitedMessages.length > 0) {
			const lastUserIdx = findLastUserMessageIndex(limitedMessages);
			if (lastUserIdx !== -1) {
				limitedMessages = limitedMessages.slice(0, lastUserIdx).concat(limitedMessages.slice(lastUserIdx + 1));
			}
		}

		for (const msg of limitedMessages) {
			result.push(msg);
			sources.push({ kind: "chat-history" });
		}
	}

	for (const item of afterItems) {
		if (item.role === "system" || item.role === undefined) continue;
		addSyntheticMessage(result, item, preset, runtime, sources, diagnostics);
	}

	return { messages: result, sources, diagnostics };
}

// =========================================================================
// Helpers
// =========================================================================

function enabledItems(preset: PromptPreset): PromptPresetItem[] {
	return preset.items.filter((item) => item.enabled !== false);
}

function renderItemText(
	item: PromptPresetItem,
	preset: PromptPreset,
	runtime: PromptRuntime,
	diagnostics: PromptPresetDiagnostic[],
): string {
	let raw: string;
	if (item.kind === "block") {
		raw = (item as PromptPresetBlockItem).content;
	} else {
		raw = renderSlot(item as PromptPresetSlotItem, preset, runtime, diagnostics);
	}

	if (!raw) return "";

	const policy = preset.defaults?.unresolvedMacroPolicy;
	const expanded = expandMacros(raw, runtime, { unresolvedPolicy: policy });

	return expanded;
}

function addSyntheticMessage(
	messages: AgentMessage[],
	item: PromptPresetItem,
	preset: PromptPreset,
	runtime: PromptRuntime,
	sources: CompileMessageSource[],
	diagnostics: PromptPresetDiagnostic[],
): void {
	const text = renderItemText(item, preset, runtime, diagnostics);
	if (!text) return;

	const role = item.role ?? "user";
	messages.push({
		role,
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	} as AgentMessage);
	sources.push({
		kind: "preset-item",
		itemId: item.id,
		itemName: item.name,
		slot: item.kind === "slot" ? (item as PromptPresetSlotItem).slot : undefined,
	});
}

function findLastUserMessageIndex(messages: AgentMessage[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "user") return i;
	}
	return -1;
}