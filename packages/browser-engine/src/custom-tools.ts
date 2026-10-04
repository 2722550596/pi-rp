import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type {
	ExtensionAPI,
	ExtensionToolContext,
	ToolDefinition,
} from "../../coding-agent/src/core/extensions/types.ts";
import type { CustomTypePolicy } from "../../coding-agent/src/core/messages.ts";
import type { AskBroker } from "./ask-broker.ts";
import type { ExtensionFactory } from "./reexports.ts";

export type MaybePromise<T> = T | Promise<T>;
export type BrowserAppendMessage = Omit<Parameters<ExtensionToolContext["appendMessage"]>[0], "display"> & {
	readonly display: false;
};

export interface BrowserToolHandlerContext {
	readonly sessionId: string;
	readonly signal?: AbortSignal;
	appendMessage(message: BrowserAppendMessage): void;
	askHost(question: string, options?: { readonly signal?: AbortSignal }): Promise<string>;
	readonly extension: ExtensionToolContext;
}

export interface BrowserCustomTool {
	readonly definition: Omit<ToolDefinition, "execute">;
	readonly handler: (
		toolCallId: string,
		params: unknown,
		context: BrowserToolHandlerContext,
		onUpdate?: (progress: unknown) => void,
	) => MaybePromise<{ content: readonly unknown[]; details?: unknown }>;
}

export interface BrowserCustomTypePolicy {
	readonly customType: string;
	readonly policy: Partial<CustomTypePolicy>;
}

const POLICY_KEYS = ["context", "llmRole", "compaction", "renderContent"] as const;

function validateCustomTypes(declarations: readonly BrowserCustomTypePolicy[]): Map<string, Partial<CustomTypePolicy>> {
	const policies = new Map<string, Partial<CustomTypePolicy>>();
	for (const declaration of declarations) {
		if (!declaration.customType.trim()) throw new Error("pi-harness: customType must be non-empty");
		const policy = declaration.policy;
		for (const key of Object.keys(policy)) {
			if (!(POLICY_KEYS as readonly string[]).includes(key)) {
				throw new Error(`pi-harness: unknown custom type policy key ${JSON.stringify(key)}`);
			}
		}
		if (policy.context !== undefined && policy.context !== "include" && policy.context !== "exclude") {
			throw new Error(
				`pi-harness: invalid custom type context policy for ${JSON.stringify(declaration.customType)}`,
			);
		}
		if (policy.llmRole !== undefined && policy.llmRole !== "user" && policy.llmRole !== "assistant") {
			throw new Error(
				`pi-harness: invalid custom type llmRole policy for ${JSON.stringify(declaration.customType)}`,
			);
		}
		if (policy.compaction !== undefined && policy.compaction !== "include" && policy.compaction !== "exclude") {
			throw new Error(
				`pi-harness: invalid custom type compaction policy for ${JSON.stringify(declaration.customType)}`,
			);
		}
		if (policy.renderContent !== undefined && typeof policy.renderContent !== "function") {
			throw new Error(
				`pi-harness: invalid custom type renderContent policy for ${JSON.stringify(declaration.customType)}`,
			);
		}
		const previous = policies.get(declaration.customType);
		if (
			previous &&
			POLICY_KEYS.some((key) => effectivePolicyValue(previous, key) !== effectivePolicyValue(policy, key))
		) {
			throw new Error(`pi-harness: conflicting custom type policy for ${JSON.stringify(declaration.customType)}`);
		}
		if (!previous) policies.set(declaration.customType, { ...policy });
	}
	return policies;
}

function effectivePolicyValue(policy: Partial<CustomTypePolicy>, key: (typeof POLICY_KEYS)[number]): unknown {
	if (key === "context") return policy.context ?? "include";
	if (key === "llmRole") return policy.llmRole ?? "user";
	if (key === "compaction") return policy.compaction ?? "include";
	return policy.renderContent;
}

export function createBrowserCustomToolFactory(
	tools: readonly BrowserCustomTool[],
	customTypes: readonly BrowserCustomTypePolicy[],
	sessionId: string,
	broker?: AskBroker,
): ExtensionFactory {
	const policies = validateCustomTypes(customTypes);
	const names = new Set<string>();
	for (const tool of tools) {
		if (!tool.definition.name.trim()) throw new Error("pi-harness: custom tool name must be non-empty");
		if (names.has(tool.definition.name)) {
			throw new Error(`pi-harness: duplicate custom tool ${JSON.stringify(tool.definition.name)}`);
		}
		names.add(tool.definition.name);
	}
	return (pi: ExtensionAPI) => {
		for (const [customType, policy] of policies) pi.registerCustomType(customType, policy);
		for (const custom of tools) {
			pi.registerTool({
				...custom.definition,
				async execute(toolCallId, params, signal, onUpdate, extension) {
					const handlerContext: BrowserToolHandlerContext = {
						sessionId,
						signal,
						extension,
						appendMessage(message) {
							if (!policies.has(message.customType)) {
								throw new Error(
									`pi-harness: custom type ${JSON.stringify(message.customType)} has no registered policy`,
								);
							}
							extension.appendMessage(message);
						},
						askHost(question, askOptions) {
							if (!broker) {
								return Promise.reject(new Error("pi-harness: askHost requires a browser host broker"));
							}
							return broker.ask(question, askOptions?.signal ?? signal);
						},
					};
					const result = await custom.handler(
						toolCallId,
						params,
						handlerContext,
						onUpdate ? (progress) => onUpdate(progress as AgentToolResult<unknown>) : undefined,
					);
					return { content: [...result.content], details: result.details } as AgentToolResult<unknown>;
				},
			});
		}
	};
}
