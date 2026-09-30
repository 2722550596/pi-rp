/**
 * Browser-profile pi-ai compat — alias target for `@earendil-works/pi-ai/compat`
 * (build.mjs `workspaceSrcPlugin` alias, node builds untouched).
 *
 * The real compat.ts registers ALL builtin API implementations (including
 * bedrock-converse-stream → @aws-sdk, check-browser-harness A3 禁入) plus the full static
 * provider catalog. The browser profile needs exactly the direct-connect set (契约 §8):
 * anthropic / openai (completions+responses) / google / mistral / openrouter(openai-completions).
 *
 * Semantics mirrored from compat.ts: the api-registry (getApiProvider/registerApiProvider/
 * resetApiProviders), the provider-aware stream dispatch (getBuiltinProviderForModel →
 * provider.streamSimple, else api-registry fallback), and the star re-export of the
 * browser-safe pi-ai barrel (clampThinkingLevel/isContextOverflow/… 消费面不变).
 */

import { anthropicMessagesApi } from "../../ai/src/api/anthropic-messages.lazy.ts";
import { googleGenerativeAIApi } from "../../ai/src/api/google-generative-ai.lazy.ts";
import { mistralConversationsApi } from "../../ai/src/api/mistral-conversations.lazy.ts";
import { openAICompletionsApi } from "../../ai/src/api/openai-completions.lazy.ts";
import { openAIResponsesApi } from "../../ai/src/api/openai-responses.lazy.ts";
import { getEnvApiKey } from "../../ai/src/env-api-keys.ts";
import type {
	Api,
	ApiStreamOptions,
	AssistantMessageEventStream,
	Context,
	Model,
	ProviderStreamOptions,
	ProviderStreams,
	SimpleStreamOptions,
	StreamOptions,
} from "../../ai/src/types.ts";
import { builtinProviders } from "./browser-catalog.ts";

// browser-safe barrel (upstream browser-smoke 守护面)：clampThinkingLevel / isContextOverflow /
// isRecoverableLength / isRetryableAssistantError / modelsAreEqual / cleanupSessionResources /
// getSupportedThinkingLevels / complete… 全部经此转出。
export * from "../../ai/src/index.ts";

interface ApiProviderInternal {
	api: Api;
	stream: ProviderStreams["stream"];
	streamSimple: ProviderStreams["streamSimple"];
}

const apiProviderRegistry = new Map<Api, ApiProviderInternal>();

function wrapStream(api: Api, streams: ProviderStreams): ApiProviderInternal {
	return {
		api,
		stream: (model, context, options) => {
			if (model.api !== api) throw new Error(`Mismatched api: ${model.api} expected ${api}`);
			return streams.stream(model, context, options);
		},
		streamSimple: (model, context, options) => {
			if (model.api !== api) throw new Error(`Mismatched api: ${model.api} expected ${api}`);
			return streams.streamSimple(model, context, options);
		},
	};
}

/** 直连集 API 实现表（契约 §8 五家；bedrock/vertex 需网关——不注册，命中即结构化报错）。 */
const BROWSER_APIS: Array<[Api, ProviderStreams]> = [
	["anthropic-messages", anthropicMessagesApi()],
	["openai-completions", openAICompletionsApi()],
	["openai-responses", openAIResponsesApi()],
	["google-generative-ai", googleGenerativeAIApi()],
	["mistral-conversations", mistralConversationsApi()],
];

export function registerApiProvider(
	provider: { api: Api; stream: ProviderStreams["stream"]; streamSimple: ProviderStreams["streamSimple"] },
	sourceId?: string,
): void {
	void sourceId;
	apiProviderRegistry.set(
		provider.api,
		wrapStream(provider.api, { stream: provider.stream, streamSimple: provider.streamSimple }),
	);
}

export function getApiProvider(api: Api): ApiProviderInternal | undefined {
	return apiProviderRegistry.get(api);
}

export function getApiProviders(): ApiProviderInternal[] {
	return Array.from(apiProviderRegistry.values());
}

export function unregisterApiProviders(sourceId: string): void {
	void sourceId;
}

export function resetApiProviders(): void {
	apiProviderRegistry.clear();
	for (const [api, streams] of BROWSER_APIS) {
		apiProviderRegistry.set(api, wrapStream(api, streams));
	}
}

for (const [api, streams] of BROWSER_APIS) {
	apiProviderRegistry.set(api, wrapStream(api, streams));
}

// ---- provider-aware dispatch（compat.ts getBuiltinProviderForModel 语义的直连集版）----

const providersById = new Map(builtinProviders().map((provider) => [provider.id, provider]));
const AMBIENT_AUTH_MARKER = "<authenticated>";

function hasExplicitApiKey(apiKey: string | undefined): apiKey is string {
	return typeof apiKey === "string" && apiKey.trim().length > 0;
}

function withEnvApiKey<TOptions extends StreamOptions>(
	model: Model<Api>,
	options: TOptions | undefined,
): TOptions | undefined {
	if (hasExplicitApiKey(options?.apiKey)) return options;
	const apiKey = getEnvApiKey(model.provider, options?.env);
	if (!apiKey || apiKey === AMBIENT_AUTH_MARKER) return options;
	return { ...options, apiKey } as TOptions;
}

function getBuiltinProviderForModel(model: Model<Api>) {
	const provider = providersById.get(model.provider);
	if (!provider) return undefined;
	return provider.getModels().some((candidate) => candidate.api === model.api) ? provider : undefined;
}

function resolveApiProvider(api: Api): ApiProviderInternal {
	const provider = getApiProvider(api);
	if (!provider) {
		throw new Error(
			`No API provider registered for api: ${api} (browser direct-connect set: ${BROWSER_APIS.map(([name]) => name).join(", ")})`,
		);
	}
	return provider;
}

export function stream<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: ProviderStreamOptions,
): AssistantMessageEventStream {
	const builtinProvider = getBuiltinProviderForModel(model);
	if (builtinProvider) {
		// 与 compat.ts 同型：provider 面按 ApiStreamOptions 分派（api 与 options 形状由 catalog 保证一致）。
		return builtinProvider.stream(model, context, withEnvApiKey(model, options) as ApiStreamOptions<TApi>);
	}
	return resolveApiProvider(model.api).stream(model, context, withEnvApiKey(model, options) as StreamOptions);
}

export function streamSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const builtinProvider = getBuiltinProviderForModel(model);
	if (builtinProvider) {
		return builtinProvider.streamSimple(model, context, withEnvApiKey(model, options) as ApiStreamOptions<TApi>);
	}
	return resolveApiProvider(model.api).streamSimple(model, context, withEnvApiKey(model, options));
}

export async function completeSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): Promise<Awaited<ReturnType<AssistantMessageEventStream["result"]>>> {
	const events = streamSimple(model, context, options);
	return events.result();
}
