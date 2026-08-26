import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { createProvider, type Provider } from "../models.ts";
import { CLOUDFLARE_AI_GATEWAY_MODELS } from "./cloudflare-ai-gateway.models.ts";
import { cloudflareAIGatewayAuth } from "./cloudflare-auth.ts";
import { cloudflareStreams } from "./cloudflare-stream.ts";

export function cloudflareAIGatewayProvider(): Provider<
	"anthropic-messages" | "openai-completions" | "openai-responses"
> {
	// 显式给出 API 联合：createProvider 默认从 models 推断 TApi，而静态 models 里没有
	// openai-completions 的条目，推断结果会漏掉它，导致下方 api 映射里那一项被判为多余属性
	// （TS2353）。本 provider 的 api 映射是「按 model.api 分派」的能力声明，不该被静态
	// model 列表的覆盖面反推收窄。
	return createProvider<"anthropic-messages" | "openai-completions" | "openai-responses">({
		id: "cloudflare-ai-gateway",
		name: "Cloudflare AI Gateway",
		auth: { apiKey: cloudflareAIGatewayAuth() },
		models: Object.values(CLOUDFLARE_AI_GATEWAY_MODELS),
		api: {
			"anthropic-messages": cloudflareStreams(anthropicMessagesApi()),
			"openai-completions": cloudflareStreams(openAICompletionsApi()),
			"openai-responses": cloudflareStreams(openAIResponsesApi()),
		},
	});
}
