export type {
	CompileMessageSource,
	CompileMessagesResult,
	CompileSystemPromptResult,
} from "./types.ts";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { expandMacros } from "./macro-engine.ts";
import { applyRegexRulesToMessages, applyRegexRulesToString } from "./regex-engine.ts";
import { isChatHistoryPosition, renderSlot } from "./slot-renderers.ts";
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
export function compileSystemPrompt(
	preset: PromptPreset,
	runtime: PromptRuntime,
	baseSystemPrompt: string,
): CompileSystemPromptResult {
	// Derived view of the single compile pipeline: compileMessages is the one
	// real compile path, and the system prompt is the system-role portion of
	// its output. The LLM-visible message array is byte-identical to a direct
	// compileMessages call.
	const compiled = compileMessages(preset, runtime);
	const derived = deriveSystemPrompt(compiled, preset, baseSystemPrompt);
	return {
		systemPrompt: derived.systemPrompt,
		diagnostics: [...compiled.diagnostics, ...derived.diagnostics],
	};
}

/**
 * Derive the system-prompt string from an already-compiled message array
 * (the same pipeline that produced the LLM context). System-role messages
 * are extracted in order and joined the same way squashMessages merges
 * adjacent same-role messages, then compiled-stage regex rules targeting
 * "system" are applied. Falls back to `baseSystemPrompt` when the preset
 * produces no system content.
 */
export function deriveSystemPrompt(
	compiled: CompileMessagesResult,
	preset: PromptPreset,
	baseSystemPrompt: string,
): CompileSystemPromptResult {
	const diagnostics: PromptPresetDiagnostic[] = [];
	const systemPrompt = deriveSystemPromptString(compiled.messages, preset, diagnostics);
	return { systemPrompt: systemPrompt || baseSystemPrompt, diagnostics };
}

/**
 * Extract and join the system-role text of a compiled message array, applying
 * compiled-stage "system"-target regex rules. Used by /prompt to display the
 * derived system string of the actual payload without re-compiling.
 */
export function deriveSystemPromptString(
	messages: AgentMessage[],
	preset: PromptPreset,
	diagnostics: PromptPresetDiagnostic[] = [],
): string {
	const parts: string[] = [];
	for (const msg of messages) {
		if (msg.role !== "system") continue;
		const text = contentToText(msg);
		if (text) parts.push(text);
	}
	return applyRegexRulesToString(preset, parts.join("\n\n"), "compiled", "system", "outgoing", diagnostics);
}

// =========================================================================
// Compile Messages
// =========================================================================

export function compileMessages(preset: PromptPreset, runtime: PromptRuntime): CompileMessagesResult {
	const diagnostics: PromptPresetDiagnostic[] = [];
	const sources: CompileMessageSource[] = [];
	let result: AgentMessage[] = [];
	const items = enabledItems(preset);

	// The chat-history position is a slot-registry property, not a name match:
	// any slot registered with position "chat-history" (built-in or custom)
	// is the conversation insertion point.
	const chatHistoryIndex = items.findIndex(isChatHistoryPosition);

	const beforeItems = chatHistoryIndex === -1 ? items : items.slice(0, chatHistoryIndex);
	const afterItems = chatHistoryIndex === -1 ? [] : items.slice(chatHistoryIndex + 1);

	// {{lastUserMessage}} resolves from the last real user-role message when
	// PromptRuntime.latestUserMessage is unset. All construction sites pass
	// undefined; the derivation happens here in the compile path.
	const effectiveRuntime = withDerivedLatestUserMessage(runtime);

	for (const item of beforeItems) {
		addSyntheticMessage(result, item, preset, effectiveRuntime, sources, diagnostics);
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
		} else if (options?.stripAssistantThinking === "previous-traces") {
			filtered = stripThinkingFromPreviousTraces(filtered, runtime.messages, runtime.currentTraceStartIndex);
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

		// Apply history-stage regex to chat-history messages
		limited = applyRegexRulesToMessages(preset, limited, "history", "outgoing", diagnostics);

		for (const msg of limited) {
			result.push(msg);
			sources.push({ kind: "chat-history" });
		}
	}

	for (const item of afterItems) {
		addSyntheticMessage(result, item, preset, effectiveRuntime, sources, diagnostics);
	}

	// Squash consecutive same-role messages: merge adjacent messages with the same role
	result = squashMessages(result);

	// Apply compiled-stage regex to the full message array (outgoing + display effects)
	result = applyRegexRulesToMessages(preset, result, "compiled", "outgoing", diagnostics);

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
				last = { ...last, content: [{ type: "text" as const, text: `${lastText}\n\n${msgText}` }] } as AgentMessage;
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
	return expandMacros(raw, runtime, { unresolvedPolicy: policy, diagnostics });
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

/**
 * Resolve `latestUserMessage` for the compile: an explicitly provided value
 * wins; otherwise derive it from the last user-role message with non-empty
 * text in `runtime.messages`. Returns a shallow copy so `setvar`/`addvar`
 * macro mutations still land on the caller's variables object.
 */
function withDerivedLatestUserMessage(runtime: PromptRuntime): PromptRuntime {
	if (runtime.latestUserMessage !== undefined) return runtime;
	return { ...runtime, latestUserMessage: deriveLatestUserMessage(runtime.messages) };
}

/**
 * Find the text of the last user-role message in `messages`.
 *
 * Edge case: the synthetic non-persisted "Continue." message injected by
 * continueSession is a plain `{ role: "user", content: [{type:"text", ...}] }`
 * with no marker field, so it is indistinguishable from a real user message
 * and cannot be excluded here. After a /continue, the derived value may be the
 * continue text (e.g. "Continue."). Presets that re-insert the latest user
 * message should pair {{lastUserMessage}} with the chat-history
 * `omitLatestUser` option; excluding the continue injection would require the
 * session to tag the message, which is out of scope for the compiler.
 */
function deriveLatestUserMessage(messages: AgentMessage[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "user") continue;
		const text = contentToText(msg);
		if (text.trim()) return text;
	}
	return undefined;
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

/**
 * Strip thinking from assistant messages in completed traces (before
 * `currentTraceStartIndex`), keeping the current trace's thinking intact.
 * Filters applied earlier (roles, summaries) drop messages without cloning,
 * so reference identity against the source `messages` array is a reliable
 * membership test for the current trace. Without a trace boundary there is
 * no current trace to protect, so every message is treated as previous.
 */
function stripThinkingFromPreviousTraces(
	messages: AgentMessage[],
	sourceMessages: AgentMessage[],
	currentTraceStartIndex: number | undefined,
): AgentMessage[] {
	if (currentTraceStartIndex === undefined) {
		return messages.map(stripThinkingFromMessage);
	}
	const currentTrace = new Set(sourceMessages.slice(currentTraceStartIndex));
	return messages.map((msg) => (currentTrace.has(msg) ? msg : stripThinkingFromMessage(msg)));
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
