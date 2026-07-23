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
	let result: AgentMessage[] = [];
	const items = enabledItems(preset);

	const chatHistoryIndex = items.findIndex((item) => item.kind === "slot" && item.slot === "chat-history");

	const beforeItems = chatHistoryIndex === -1 ? items : items.slice(0, chatHistoryIndex);
	const afterItems = chatHistoryIndex === -1 ? [] : items.slice(chatHistoryIndex + 1);

	for (const item of beforeItems) {
		addSyntheticMessage(result, item, preset, runtime, sources, diagnostics);
	}

	if (chatHistoryIndex !== -1) {
		const chatHistoryMessages = runtime.messages;
		const options = (items[chatHistoryIndex] as PromptPresetSlotItem).options;
		let shouldRepairToolPairs = false;

		// Apply role filter
		let filtered = chatHistoryMessages;
		if (options?.roles && options.roles.length > 0) {
			const allowed = new Set(options.roles);
			filtered = filtered.filter((m) => allowed.has(m.role));
			shouldRepairToolPairs = true;
		}

		// Filter summaries
		if (options?.includeSummaries === false) {
			filtered = filtered.filter((m) => !isSummaryMessage(m));
		}

		// Strip assistant thinking
		if (options?.stripAssistantThinking === true) {
			filtered = filtered.map(stripThinkingFromMessage);
		}

		// Drop tool history
		if (options?.toolMode === "drop") {
			filtered = dropToolHistory(filtered);
		}

		// Apply history limits
		let limited = filtered;
		const maxMessages = options?.maxMessages;
		if (maxMessages && limited.length > maxMessages) {
			limited = limited.slice(-maxMessages);
			shouldRepairToolPairs = true;
		}
		const maxChars = options?.maxChars;
		if (maxChars && limited.length > 0) {
			limited = takeRecentMessagesWithinChars(limited, maxChars);
			shouldRepairToolPairs = true;
		}

		// Omit latest user message
		const omitLatestUser = options?.omitLatestUser;
		if (omitLatestUser && limited.length > 0) {
			const lastUserIdx = findLastUserMessageIndex(limited);
			if (lastUserIdx !== -1) {
				limited = limited.slice(0, lastUserIdx).concat(limited.slice(lastUserIdx + 1));
				shouldRepairToolPairs = true;
			}
		}

		// Repair dangling tool pairs after filtering
		if (shouldRepairToolPairs && options?.toolMode !== "drop") {
			limited = repairToolPairs(limited);
		}

		for (const msg of limited) {
			result.push(msg);
			sources.push({ kind: "chat-history" });
		}
	}

	for (const item of afterItems) {
		addSyntheticMessage(result, item, preset, runtime, sources, diagnostics);
	}

	// Squash consecutive same-role messages: merge adjacent messages with the same role
	result = squashMessages(result);

	return { messages: result, sources, diagnostics };
}

/**
 * Merge consecutive messages with the same role.
 * e.g. [system, system, user, system, system] → [system(merged), user, system(merged)]
 */
function squashMessages(messages: AgentMessage[]): AgentMessage[] {
	if (messages.length < 2) return messages;

	const squashed: AgentMessage[] = [];
	let last: AgentMessage | undefined;
	for (const msg of messages) {
		if (!("content" in msg) || !msg.content) continue;
		if (!last) {
			last = msg;
			continue;
		}
		if (last.role === msg.role && typeof last.content === "object" && typeof msg.content === "object") {
			const lastArr = last.content as Array<{ type: string; text?: string }>;
			const msgArr = msg.content as Array<{ type: string; text?: string }>;
			const lastText = lastArr
				.filter((p) => p.type === "text")
				.map((p) => p.text ?? "")
				.join("\n");
			const msgText = msgArr
				.filter((p) => p.type === "text")
				.map((p) => p.text ?? "")
				.join("\n");
			if (lastText && msgText) {
				last = { ...last, content: [{ type: "text" as const, text: lastText + "\n\n" + msgText }] } as AgentMessage;
				continue;
			}
		}
		squashed.push(last);
		last = msg;
	}
	if (last) squashed.push(last);
	return squashed;
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

	const role = item.role ?? "system";
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
const SUMMARY_ROLES = new Set(["branchSummary", "compactionSummary"]);

function isSummaryMessage(message: AgentMessage): boolean {
	return SUMMARY_ROLES.has(message.role as string);
}

function isToolResultMessage(message: AgentMessage): boolean {
	return message.role === "toolResult";
}

function hasToolCallParts(message: AgentMessage): boolean {
	if (message.role !== "assistant") return false;
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return false;
	return content.some((part: { type?: string }) => part?.type === "toolCall");
}

function stripToolCallParts(message: AgentMessage): { message: AgentMessage | null; removedCalls: number } {
	if (message.role !== "assistant") return { message, removedCalls: 0 };
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return { message, removedCalls: 0 };
	const kept = content.filter((part: { type?: string }) => part?.type !== "toolCall");
	const removed = content.length - kept.length;
	if (removed === 0) return { message, removedCalls: 0 };
	if (kept.length === 0) return { message: null, removedCalls: removed };
	return { message: { ...message, content: kept } as AgentMessage, removedCalls: removed };
}

function dropToolHistory(messages: AgentMessage[]): AgentMessage[] {
	const result: AgentMessage[] = [];
	for (const msg of messages) {
		if (isToolResultMessage(msg)) continue;
		const stripped = stripToolCallParts(msg);
		if (!stripped.message) continue;
		result.push(stripped.message);
	}
	return result;
}

/**
 * After chat-history filtering (role filters, limits), remove dangling tool pairs.
 * A tool call without a matching result (or vice versa) is removed.
 */
function repairToolPairs(messages: AgentMessage[]): AgentMessage[] {
	const toolCallIds = new Set<string>();
	const result: AgentMessage[] = [];
	for (const msg of messages) {
		if (isToolResultMessage(msg)) {
			const id = (msg as { toolCallId?: string }).toolCallId;
			if (id && toolCallIds.has(id)) {
				result.push(msg);
				toolCallIds.delete(id);
			}
			// Orphan tool result — drop it
			continue;
		}
		if (msg.role === "assistant") {
			const content = (msg as { content?: unknown }).content;
			if (Array.isArray(content)) {
				for (const part of content) {
					if (part?.type === "toolCall" && (part as { id?: string }).id) {
						toolCallIds.add((part as { id: string }).id);
					}
				}
			}
		}
		result.push(msg);
	}
	// Remove dangling tool calls (tool calls whose result was filtered out)
	if (toolCallIds.size > 0) {
		return result.filter((msg) => {
			if (msg.role !== "assistant") return true;
			const content = (msg as { content?: unknown }).content;
			if (!Array.isArray(content)) return true;
			const kept = content.filter((part: { type?: string; id?: string }) => {
				if (part?.type !== "toolCall") return true;
				return !toolCallIds.has(part.id ?? "");
			});
			if (kept.length === content.length) return true;
			if (kept.length === 0) return false;
			(msg as { content: unknown }).content = kept;
			return true;
		});
	}
	return result;
}
