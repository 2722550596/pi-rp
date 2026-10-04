import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { OPENAI_MODELS } from "./openai.models.ts";

export function openaiProvider(): Provider<"openai-responses" | "openai-completions"> {
	return createProvider<"openai-responses" | "openai-completions">({
		id: "openai",
		name: "OpenAI",
		baseUrl: "https://api.openai.com/v1",
		auth: { apiKey: envApiKeyAuth("OpenAI API key", ["OPENAI_API_KEY"]) },
		models: Object.values(OPENAI_MODELS),
		// 按 model.api 分派：官方端点走 responses；openai-completions 供
		// 自定义 baseUrl 的 OpenAI 兼容网关（chat/completions）直连。
		api: {
			"openai-responses": openAIResponsesApi(),
			"openai-completions": openAICompletionsApi(),
		},
	});
}
