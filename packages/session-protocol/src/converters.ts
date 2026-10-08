import type {
	AssistantMessage,
	ImageContent,
	TextContent,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from "@earendil-works/pi-ai";
import type {
	AssistantTranscriptItem,
	CustomTranscriptItem,
	JsonValue,
	ToolTranscriptItem,
	Usage,
	UserTranscriptItem,
} from "@earendil-works/pi-protocol";

export interface UserTranscriptOptions {
	id: string;
}
export interface AssistantTranscriptOptions {
	id: string;
}
export interface ToolTranscriptOptions {
	id: string;
	call: ToolCall;
}
function identifier(value: string, label: string): string {
	if (typeof value !== "string" || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
	return value;
}
function timestamp(value: number): number {
	if (!Number.isSafeInteger(value) || value < 0)
		throw new TypeError("Protocol timestamps must be non-negative integers");
	return value;
}
export function toProtocolJsonValue(value: unknown, seen = new Set<object>()): JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new TypeError("Protocol JSON numbers must be finite");
		return value;
	}
	if (typeof value !== "object") throw new TypeError(`Unsupported protocol JSON value: ${typeof value}`);
	if (seen.has(value)) throw new TypeError("Protocol JSON values must not contain circular references");
	const prototype = Object.getPrototypeOf(value);
	if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null)
		throw new TypeError("Protocol JSON objects must be plain objects");
	seen.add(value);
	try {
		if (Array.isArray(value)) return Array.from(value, (entry) => toProtocolJsonValue(entry, seen));
		const result: Record<string, JsonValue> = {};
		for (const [key, entry] of Object.entries(value)) result[key] = toProtocolJsonValue(entry, seen);
		return result;
	} finally {
		seen.delete(value);
	}
}
export function sanitizeProtocolDetails(value: unknown, seen = new Set<object>()): JsonValue | undefined {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
	if (typeof value === "bigint") return value.toString();
	if (value === undefined || typeof value === "function" || typeof value === "symbol") return undefined;
	if (value instanceof Date) return value.toISOString();
	if (typeof value !== "object") return String(value);
	if (seen.has(value)) return "[Circular]";
	seen.add(value);
	try {
		if (Array.isArray(value)) return Array.from(value, (entry) => sanitizeProtocolDetails(entry, seen) ?? null);
		const result: Record<string, JsonValue> = {};
		for (const [key, entry] of Object.entries(value)) {
			const normalized = sanitizeProtocolDetails(entry, seen);
			if (normalized !== undefined) result[key] = normalized;
		}
		return result;
	} finally {
		seen.delete(value);
	}
}
function nonNegativeInteger(value: number | undefined): number | undefined {
	if (value === undefined || !Number.isFinite(value)) return undefined;
	return Math.max(0, Math.floor(value));
}
function nonNegativeNumber(value: number): number {
	return Number.isFinite(value) ? Math.max(0, value) : 0;
}
export function toProtocolUsage(
	usage: AssistantMessage["usage"] | ToolResultMessage["usage"] | undefined,
): Usage | undefined {
	if (!usage) return undefined;
	const reasoning = nonNegativeInteger(usage.reasoning);
	return {
		input: nonNegativeInteger(usage.input) ?? 0,
		output: nonNegativeInteger(usage.output) ?? 0,
		cacheRead: nonNegativeInteger(usage.cacheRead) ?? 0,
		cacheWrite: nonNegativeInteger(usage.cacheWrite) ?? 0,
		...(reasoning === undefined ? {} : { reasoning }),
		totalTokens: nonNegativeInteger(usage.totalTokens) ?? 0,
		cost: {
			input: nonNegativeNumber(usage.cost.input),
			output: nonNegativeNumber(usage.cost.output),
			cacheRead: nonNegativeNumber(usage.cost.cacheRead),
			cacheWrite: nonNegativeNumber(usage.cost.cacheWrite),
			total: nonNegativeNumber(usage.cost.total),
		},
	};
}
export function toProtocolUserMessage(message: UserMessage, options: UserTranscriptOptions): UserTranscriptItem {
	const content: UserTranscriptItem["content"] =
		typeof message.content === "string"
			? [{ type: "text", text: message.content }]
			: message.content.map((part) =>
					part.type === "text"
						? { type: "text", text: part.text }
						: { type: "image", data: part.data, mimeType: part.mimeType },
				);
	return {
		id: identifier(options.id, "Transcript item id"),
		role: "user",
		content,
		timestamp: timestamp(message.timestamp),
	};
}
export interface CustomTranscriptOptions {
	id: string;
	customType: string;
	timestamp: number;
}
export function toProtocolCustomMessage(
	message: { content: string | readonly (TextContent | ImageContent)[] },
	options: CustomTranscriptOptions,
): CustomTranscriptItem {
	const content: CustomTranscriptItem["content"] =
		typeof message.content === "string"
			? [{ type: "text", text: message.content }]
			: message.content.map((part) =>
					part.type === "text"
						? { type: "text", text: part.text }
						: { type: "image", data: part.data, mimeType: part.mimeType },
				);
	return {
		id: identifier(options.id, "Transcript item id"),
		role: "custom",
		customType: identifier(options.customType, "Custom type"),
		content,
		timestamp: timestamp(options.timestamp),
	};
}
export function toProtocolAssistantMessage(
	message: AssistantMessage,
	options: AssistantTranscriptOptions,
): AssistantTranscriptItem {
	const content: AssistantTranscriptItem["content"] = message.content.map((part) => {
		switch (part.type) {
			case "text":
				return { type: "text", text: part.text };
			case "thinking":
				return {
					type: "thinking",
					thinking: part.thinking,
					...(part.redacted === undefined ? {} : { redacted: part.redacted }),
				};
			case "toolCall":
				return {
					type: "toolCall",
					toolCallId: identifier(part.id, "Tool call id"),
					toolName: identifier(part.name, "Tool call name"),
					input: toProtocolJsonValue(part.arguments),
				};
			default:
				throw new TypeError("Unsupported assistant content part");
		}
	});
	const usage = toProtocolUsage(message.usage);
	const common = {
		id: identifier(options.id, "Transcript item id"),
		role: "assistant" as const,
		content,
		model: {
			provider: identifier(message.provider, "Assistant provider"),
			id: identifier(message.model, "Assistant model"),
		},
		...(message.responseModel === undefined
			? {}
			: { responseModel: identifier(message.responseModel, "Assistant response model") }),
		...(usage ? { usage } : {}),
		timestamp: timestamp(message.timestamp),
	};
	switch (message.stopReason) {
		case "pending":
			return { ...common, status: "streaming" };
		case "stop":
		case "length":
		case "toolUse":
			return { ...common, status: "complete", stopReason: message.stopReason };
		case "deferred":
			throw new TypeError("Deferred assistant messages are not supported by protocol v1");
		case "error":
			if (message.errorMessage?.length === 0) throw new TypeError("Assistant error messages must not be empty");
			return {
				...common,
				status: "error",
				stopReason: "error",
				...(message.errorMessage === undefined ? {} : { errorMessage: message.errorMessage }),
			};
		case "aborted":
			return {
				...common,
				status: "aborted",
				stopReason: "aborted",
				...(message.errorMessage === undefined ? {} : { errorMessage: message.errorMessage }),
			};
	}
}
export function toProtocolToolResultMessage(
	message: ToolResultMessage,
	options: ToolTranscriptOptions,
): Extract<ToolTranscriptItem, { status: "complete" | "error" }> {
	const callId = identifier(options.call.id, "Tool call id");
	const callName = identifier(options.call.name, "Tool call name");
	if (identifier(message.toolCallId, "Tool result call id") !== callId)
		throw new TypeError(`Tool result ${message.toolCallId} does not match tool call ${callId}`);
	if (identifier(message.toolName, "Tool result name") !== callName)
		throw new TypeError(`Tool result ${message.toolName} does not match tool call ${callName}`);
	const content: ToolTranscriptItem["content"] = message.content.map((part) =>
		part.type === "text"
			? { type: "text", text: part.text }
			: { type: "image", data: part.data, mimeType: part.mimeType },
	);
	const details = sanitizeProtocolDetails(message.details);
	const usage = toProtocolUsage(message.usage);
	const common = {
		id: identifier(options.id, "Transcript item id"),
		role: "tool" as const,
		toolCallId: callId,
		toolName: callName,
		input: toProtocolJsonValue(options.call.arguments),
		content,
		...(details === undefined ? {} : { details }),
		...(usage ? { usage } : {}),
		timestamp: timestamp(message.timestamp),
	};
	return message.isError
		? { ...common, status: "error", isError: true }
		: { ...common, status: "complete", isError: false };
}
export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:\n\n<summary>\n`;
export const COMPACTION_SUMMARY_SUFFIX = `\n</summary>`;
export const BRANCH_SUMMARY_PREFIX = `The following is a summary of a branch that this conversation came back from:\n\n<summary>\n`;
export const BRANCH_SUMMARY_SUFFIX = `</summary>`;
export interface SummaryToUserMessageOptions {
	id: string;
	timestamp: number;
	kind: "compaction" | "branch";
	summary: string;
}
export function summaryToUserMessage({
	id,
	timestamp: messageTimestamp,
	kind,
	summary,
}: SummaryToUserMessageOptions): UserTranscriptItem {
	const prefix = kind === "compaction" ? COMPACTION_SUMMARY_PREFIX : BRANCH_SUMMARY_PREFIX;
	const suffix = kind === "compaction" ? COMPACTION_SUMMARY_SUFFIX : BRANCH_SUMMARY_SUFFIX;
	return {
		id: identifier(id, "Transcript item id"),
		role: "user",
		content: [{ type: "text", text: prefix + summary + suffix }],
		timestamp: timestamp(messageTimestamp),
	};
}
