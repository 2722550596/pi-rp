/**
 * Custom message types and transformers for the coding agent.
 *
 * Extends the base AgentMessage type with coding-agent specific message types,
 * and provides a transformer to convert them to LLM-compatible messages.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";

export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;

export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;

export const BRANCH_SUMMARY_PREFIX = `The following is a summary of a branch that this conversation came back from:

<summary>
`;

export const BRANCH_SUMMARY_SUFFIX = `</summary>`;

/**
 * Message type for bash executions via the ! command.
 */
export interface BashExecutionMessage {
	role: "bashExecution";
	command: string;
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	fullOutputPath?: string;
	timestamp: number;
	/** If true, this message is excluded from LLM context (!! prefix) */
	excludeFromContext?: boolean;
}

/**
 * Declared policy for how a custom message type participates in the LLM context.
 *
 * Custom messages are persisted as `custom_message` session entries (distinct
 * from audit `custom` entries, which never reach the LLM). By default every
 * custom message converts to a `user` message in the LLM context. Extensions
 * can declare a policy per `customType` via `pi.registerCustomType` to change
 * that:
 *
 * - `context: "exclude"` — the message stays persisted and rendered but never
 *   enters the LLM context (e.g. notifications that would only confuse the model).
 * - `llmRole: "assistant"` — the message enters the context as an assistant
 *   turn (e.g. another agent's speech that the model should treat as already
 *   said, not as new user input).
 *
 * The default policy (`{ context: "include", llmRole: "user" }`) reproduces
 * the historical behavior exactly.
 */
export interface CustomTypePolicy {
	context: "include" | "exclude";
	llmRole: "user" | "assistant";
}

export const DEFAULT_CUSTOM_TYPE_POLICY: CustomTypePolicy = {
	context: "include",
	llmRole: "user",
};

/** Resolves the effective policy for a custom message type; undefined → default. */
export type CustomTypeResolver = (customType: string) => CustomTypePolicy | undefined;

/**
 * Message type for extension-injected messages via sendMessage().
 * These are custom messages that extensions can inject into the conversation.
 *
 * By default they enter the LLM context as `user` messages (see
 * {@link convertToLlm}); declare a policy with `pi.registerCustomType` to
 * exclude a type from context or give it an assistant role. They are
 * persisted as `custom_message` entries — distinct from audit `custom`
 * entries (`pi.appendEntry(type, data)`), which never reach the LLM.
 */
export interface CustomMessage<T = unknown> {
	role: "custom";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: T;
	timestamp: number;
}

export interface BranchSummaryMessage {
	role: "branchSummary";
	summary: string;
	fromId: string;
	timestamp: number;
}

export interface CompactionSummaryMessage {
	role: "compactionSummary";
	summary: string;
	tokensBefore: number;
	timestamp: number;
}

// Extend CustomAgentMessages via declaration merging
declare module "@earendil-works/pi-agent-core" {
	interface CustomAgentMessages {
		bashExecution: BashExecutionMessage;
		custom: CustomMessage;
		branchSummary: BranchSummaryMessage;
		compactionSummary: CompactionSummaryMessage;
	}
}

/**
 * Convert a BashExecutionMessage to user message text for LLM context.
 */
export function bashExecutionToText(msg: BashExecutionMessage): string {
	let text = `Ran \`${msg.command}\`\n`;
	if (msg.output) {
		text += `\`\`\`\n${msg.output}\n\`\`\``;
	} else {
		text += "(no output)";
	}
	if (msg.cancelled) {
		text += "\n\n(command cancelled)";
	} else if (msg.exitCode !== null && msg.exitCode !== undefined && msg.exitCode !== 0) {
		text += `\n\nCommand exited with code ${msg.exitCode}`;
	}
	if (msg.truncated && msg.fullOutputPath) {
		text += `\n\n[Output truncated. Full output: ${msg.fullOutputPath}]`;
	}
	return text;
}

export function createBranchSummaryMessage(summary: string, fromId: string, timestamp: string): BranchSummaryMessage {
	return {
		role: "branchSummary",
		summary,
		fromId,
		timestamp: new Date(timestamp).getTime(),
	};
}

export function createCompactionSummaryMessage(
	summary: string,
	tokensBefore: number,
	timestamp: string,
): CompactionSummaryMessage {
	return {
		role: "compactionSummary",
		summary: summary,
		tokensBefore,
		timestamp: new Date(timestamp).getTime(),
	};
}

/** Convert CustomMessageEntry to AgentMessage format */
export function createCustomMessage(
	customType: string,
	content: string | (TextContent | ImageContent)[],
	display: boolean,
	details: unknown | undefined,
	timestamp: string,
): CustomMessage {
	return {
		role: "custom",
		customType,
		content,
		display,
		details,
		timestamp: new Date(timestamp).getTime(),
	};
}

/** Whether an assistant message carries tool call blocks (and thus must be
 *  immediately followed by its role:"tool" results on OpenAI-completions). */
function hasToolCallBlocks(m: AgentMessage): boolean {
	if (!("content" in m)) return false;
	const content = m.content;
	if (!Array.isArray(content)) return false;
	return content.some((b) => typeof b === "object" && b !== null && "type" in b && b.type === "toolCall");
}

/**
 * Transform AgentMessages (including custom types) to LLM-compatible Messages.
 *
 * This is used by:
 * - Agent's transormToLlm option (for prompt calls and queued messages)
 * - Compaction's generateSummary (for summarization)
 * - Custom extensions and tools
 *
 * `resolveCustomType` optionally supplies the per-type policy (see
 * {@link CustomTypePolicy}); when omitted (or when the resolver returns
 * undefined) the default policy applies — every custom message converts to
 * `user`. Note: compaction/branch-summary paths call this without a resolver,
 * so declared exclusions apply to the live context path; summarization may
 * still include excluded types.
 *
 * Ordering invariant: OpenAI-completions requires every role:"tool" message to
 * immediately follow the assistant message that carried its tool_calls. Custom
 * messages injected between a tool call and its result (e.g. narration streamed
 * mid-turn) convert to role:"user" here; they are held back and emitted after
 * the tool result, preserving their relative order without breaking adjacency.
 */
export function convertToLlm(messages: AgentMessage[], resolveCustomType?: CustomTypeResolver): Message[] {
	const out: Message[] = [];
	// Custom-derived user messages while a tool call is pending; flushed after
	// the tool result so role:"tool" stays adjacent to assistant(tool_calls).
	let held: Message[] = [];
	let pendingToolCall = false;

	const flush = () => {
		if (held.length > 0) out.push(...held);
		held = [];
		pendingToolCall = false;
	};

	for (const m of messages) {
		let converted: Message | undefined;
		switch (m.role) {
			case "bashExecution":
				// Skip messages excluded from context (!! prefix)
				if (m.excludeFromContext) continue;
				converted = {
					role: "user",
					content: [{ type: "text", text: bashExecutionToText(m) }],
					timestamp: m.timestamp,
				};
				break;
			case "custom": {
				const policy = resolveCustomType?.(m.customType) ?? DEFAULT_CUSTOM_TYPE_POLICY;
				if (policy.context === "exclude") continue; // persisted/rendered, never in LLM context
				const content = typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
				// Custom content may carry images, which pi-ai's AssistantMessage type
				// excludes (it models tool/thinking blocks); we never produce those.
				converted = {
					role: policy.llmRole,
					content,
					timestamp: m.timestamp,
				} as Message;
				break;
			}
			case "branchSummary":
				converted = {
					role: "user",
					content: [{ type: "text" as const, text: BRANCH_SUMMARY_PREFIX + m.summary + BRANCH_SUMMARY_SUFFIX }],
					timestamp: m.timestamp,
				};
				break;
			case "compactionSummary":
				converted = {
					role: "user",
					content: [
						{ type: "text" as const, text: COMPACTION_SUMMARY_PREFIX + m.summary + COMPACTION_SUMMARY_SUFFIX },
					],
					timestamp: m.timestamp,
				};
				break;
			case "system":
			case "user":
			case "assistant":
			case "toolResult":
				converted = m;
				break;
			default:
				continue;
		}

		if (m.role === "assistant") {
			flush();
			out.push(converted);
			pendingToolCall = hasToolCallBlocks(m);
		} else if (m.role === "toolResult") {
			out.push(converted); // stays adjacent to its assistant(tool_calls)
		} else if (m.role === "custom" && pendingToolCall) {
			held.push(converted);
		} else {
			flush();
			out.push(converted);
		}
	}
	flush();
	return out;
}
