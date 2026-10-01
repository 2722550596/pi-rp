import {
	type ImageContent as AiImageContent,
	type TextContent as AiTextContent,
	type Usage as AiUsage,
	type Api,
	type AssistantMessage,
	getSupportedThinkingLevels,
	type Model,
	type ModelThinkingLevel,
	type ToolCall,
	type ToolResultMessage,
	type UserMessage,
} from "@earendil-works/pi-ai";
import type { ModelMetadata, ThinkingLevel } from "@earendil-works/pi-protocol";

export type {
	AssistantTranscriptOptions,
	ToolTranscriptOptions,
	UserTranscriptOptions,
} from "@earendil-works/pi-session-protocol";
export {
	sanitizeProtocolDetails,
	toProtocolAssistantMessage,
	toProtocolJsonValue,
	toProtocolToolResultMessage,
	toProtocolUsage,
	toProtocolUserMessage,
} from "@earendil-works/pi-session-protocol";

type Assert<T extends true> = T;
type ExactKeys<T, Keys extends keyof T> = keyof T extends Keys ? true : false;
type _AiThinkingLevelsFitProtocol = Assert<ModelThinkingLevel extends ThinkingLevel ? true : false>;
type _ProtocolThinkingLevelsFitAi = Assert<ThinkingLevel extends ModelThinkingLevel ? true : false>;
type AiModelInput = Model<Api>["input"][number];
type ProtocolModelInput = ModelMetadata["input"][number];
type _AiModelInputsFitProtocol = Assert<AiModelInput extends ProtocolModelInput ? true : false>;
type _ProtocolModelInputsFitAi = Assert<ProtocolModelInput extends AiModelInput ? true : false>;
/**
 * Enumerate mapped and intentionally omitted pi-ai fields so additions fail compilation here.
 * Provider replay metadata, diagnostics, cache-write retention splits, model transport settings,
 * model sampling defaults, pricing tiers, and deferred-tool availability remain intentionally
 * server-side.
 */
type _AiTextContentFieldsAccountedFor = Assert<ExactKeys<AiTextContent, "type" | "text" | "textSignature">>;
type _AiThinkingContentFieldsAccountedFor = Assert<
	ExactKeys<
		Extract<AssistantMessage["content"][number], { type: "thinking" }>,
		"type" | "thinking" | "thinkingSignature" | "redacted"
	>
>;
type _AiImageContentFieldsAccountedFor = Assert<ExactKeys<AiImageContent, "type" | "data" | "mimeType">>;
type _AiToolCallFieldsAccountedFor = Assert<
	ExactKeys<ToolCall, "type" | "id" | "name" | "arguments" | "thoughtSignature" | "namespace">
>;
type _AiUsageFieldsAccountedFor = Assert<
	ExactKeys<
		AiUsage,
		"input" | "output" | "cacheRead" | "cacheWrite" | "cacheWrite1h" | "reasoning" | "totalTokens" | "cost"
	>
>;
type _AiUsageCostFieldsAccountedFor = Assert<
	ExactKeys<AiUsage["cost"], "input" | "output" | "cacheRead" | "cacheWrite" | "total">
>;
type _AiModelFieldsAccountedFor = Assert<
	ExactKeys<
		Model<Api>,
		| "id"
		| "name"
		| "api"
		| "provider"
		| "baseUrl"
		| "reasoning"
		| "thinkingLevelMap"
		| "input"
		| "cost"
		| "contextWindow"
		| "maxTokens"
		| "samplingParams"
		| "headers"
		| "compat"
	>
>;
type _AiModelCostFieldsAccountedFor = Assert<
	ExactKeys<Model<Api>["cost"], "input" | "output" | "cacheRead" | "cacheWrite" | "tiers">
>;
type _AiUserMessageFieldsAccountedFor = Assert<ExactKeys<UserMessage, "role" | "content" | "timestamp">>;
type _AiAssistantMessageFieldsAccountedFor = Assert<
	ExactKeys<
		AssistantMessage,
		| "role"
		| "content"
		| "api"
		| "provider"
		| "model"
		| "responseModel"
		| "responseId"
		| "diagnostics"
		| "usage"
		| "stopReason"
		| "deferred"
		| "errorMessage"
		| "rawStopReason"
		| "endTurn"
		| "timestamp"
	>
>;
type _AiToolResultMessageFieldsAccountedFor = Assert<
	ExactKeys<
		ToolResultMessage,
		"role" | "toolCallId" | "toolName" | "content" | "details" | "usage" | "addedToolNames" | "isError" | "timestamp"
	>
>;

function nonNegativeNumber(value: number): number {
	return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function identifier(value: string, label: string): string {
	if (typeof value !== "string" || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
	return value;
}

export function toProtocolModelMetadata(model: Model<Api>, authenticated: boolean): ModelMetadata {
	const result = {
		provider: identifier(model.provider, "Model provider"),
		id: identifier(model.id, "Model id"),
		name: identifier(model.name, "Model name"),
		api: identifier(model.api, "Model API"),
		reasoning: model.reasoning,
		input: [...model.input],
		contextWindow: Math.max(1, Math.floor(model.contextWindow)),
		maxTokens: Math.max(1, Math.floor(model.maxTokens)),
		cost: {
			input: nonNegativeNumber(model.cost.input),
			output: nonNegativeNumber(model.cost.output),
			cacheRead: nonNegativeNumber(model.cost.cacheRead),
			cacheWrite: nonNegativeNumber(model.cost.cacheWrite),
		},
		supportedThinkingLevels: getSupportedThinkingLevels(model),
		authenticated,
	} satisfies ModelMetadata;
	return result;
}
