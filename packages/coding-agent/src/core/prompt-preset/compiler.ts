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
	return { systemPrompt: compiled || baseSystemPrompt, diagnostics };
}

// =========================================================================
// Compile Messages
// =========================================================================

export function compileMessages(preset: PromptPreset, runtime: PromptRuntime): CompileMessagesResult {
	const diagnostics: PromptPresetDiagnostic[] = [];
	const sources: CompileMessageSource[] = [];
	const result: AgentMessage[] = [];
	const items = enabledItems(preset);

	const chatHistoryIndex = items.findIndex((item) => item.kind === "slot" && item.slot === "chat-history");

	const beforeItems = chatHistoryIndex === -1 ? items : items.slice(0, chatHistoryIndex);
	const afterItems = chatHistoryIndex === -1 ? [] : items.slice(chatHistoryIndex + 1);

	for (const item of beforeItems) {
		if (item.role === "system" || item.role === undefined) continue;
		addSyntheticMessage(result, item, preset, runtime, sources, diagnostics);
	}

	if (chatHistoryIndex !== -1) {
		const chatHistoryMessages = runtime.messages;
		const options = (items[chatHistoryIndex] as PromptPresetSlotItem).options;

		// Apply role filter
		let filtered = chatHistoryMessages;
		if (options?.roles && options.roles.length > 0) {
			const allowed = new Set(options.roles);
			filtered = filtered.filter((m) => allowed.has(m.role));
		}

		// Strip assistant thinking
		if (options?.stripAssistantThinking === true) {
			filtered = filtered.map(stripThinkingFromMessage);
		}

		// Apply history limits
		let limited = filtered;
		const maxMessages = options?.maxMessages;
		if (maxMessages && limited.length > maxMessages) {
			limited = limited.slice(-maxMessages);
		}
		const maxChars = options?.maxChars;
		if (maxChars && limited.length > 0) {
			limited = takeRecentMessagesWithinChars(limited, maxChars);
		}

		// Omit latest user message
		const omitLatestUser = options?.omitLatestUser;
		if (omitLatestUser && limited.length > 0) {
			const lastUserIdx = findLastUserMessageIndex(limited);
			if (lastUserIdx !== -1) {
				limited = limited.slice(0, lastUserIdx).concat(limited.slice(lastUserIdx + 1));
			}
		}

		for (const msg of limited) {
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

	if (runtime.skipMacroExpansion) return raw;

	const policy = preset.defaults?.unresolvedMacroPolicy;
	return expandMacros(raw, runtime, { unresolvedPolicy: policy });
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

function takeRecentMessagesWithinChars(messages: AgentMessage[], maxChars: number): AgentMessage[] {
	const selected: AgentMessage[] = [];
	let chars = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		const text = contentToText(msg);
		if (selected.length > 0 && chars + text.length > maxChars) break;
		selected.push(msg);
		chars += text.length;
	}
	return selected.reverse();
}

function stripThinkingFromMessage(message: AgentMessage): AgentMessage {
	if (message.role !== "assistant") return message;
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return message;
	const stripped = content.filter((part: { type?: string }) => part?.type !== "thinking");
	if (stripped.length === content.length) return message;
	return { ...message, content: stripped } as AgentMessage;
}

function contentToText(message: AgentMessage): string {
	if (message.role === "bashExecution") {
		return String((message as { output?: string }).output ?? "");
	}
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part: { type?: string; text?: string }) => part?.type === "text")
		.map((part: { text?: string }) => part.text ?? "")
		.join("\n");
}
