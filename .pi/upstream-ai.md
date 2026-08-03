# Upstream changes: packages/ai
- Commits: ~70+ / Files: 153 (+8278/-4989)

## 核心变化

### 1. 模型目录生成方式彻底重构 (5dc40fee3, 3a40794ea)
**变化**: `generate-models.ts` 全面重写。旧方案是每个 provider 的 `.models.ts` 文件里内联硬编码模型数据并用 `as` cast；新方案改为 per-provider JSON 数据文件 (`data/<provider>.json`) + 薄 `.models.ts` shard (`flattenModelCatalog` 包装) + manifest 校验。`models.generated.ts` 现在用明确的 `typeof` 类型注解替代 `as const`，对每个 provider key 做更精确的类型推断。
**动机**: 可验证、可分发的模型数据格式；JSON 更易被其他工具消费；构建时校验防止过期数据。`validateModelDataDirectory()` 在每次构建时运行。

### 2. Constrained Sampling / 受限采样 (24bace27c)
**变化**: 新增 `constrained-sampling.ts` 模块。`Tool` 类型增加 `constrainedSampling` 字段，支持两种约束：
- `json_schema`：利用 provider 的 strict/structured output 能力
- `grammar`：利用 provider 的 Lark/regex 语法控制输出格式
**影响范围**: OpenAI (`custom_tool_call` grammar 工具)、Anthropic (`strict: true` tools)、Bedrock (`strict` toolSpec)、Mistral (strict tools)、Google (Gemini 3+ VALIDATED 模式)。新增 compat flags: `supportsStrictMode`, `supportsStrictTools`, `supportsOpenAIGrammarTools`, `BedrockCompat`。

### 3. Per-Request Fetch 注入 (027a58479)
**变化**: 每个 API adapter 的 options 新增 `fetch` 参数，允许调用方注入自定义 fetch 实现。通过 `simple-options.ts` 统一传递到 `buildBaseOptions`。Anthropic SDK、OpenAI SDK、Mistral HTTPClient、Bedrock 均支持。Google 明确拒绝（抛错）。
**动机**: 支持代理、拦截、监控等场景。

### 4. Raw Stop Reason 全量保留 (23cb385b6, 926eb15c1, 637737ca7, fe1c9b6d5, e5ef8d065, 5a53f086e)
**变化**: 所有 provider 现在统一保留 `rawStopReason` 到 `AssistantMessage`。output 初始 stopReason 从 `"stop"` 改为 `"pending"`，流结束时检测是否有合法 finish reason。无 finish_reason 的流现在被正确处理。新增 `supportsFinishReason` compat flag。
**涉及 provider**: Google, Anthropic, Bedrock, OpenAI Completions, OpenAI Responses, Mistral。Bedrock 还增加了结构化 error metadata (diagnostics)。

### 5. 新 Provider 与 OAuth 登录
- **Qwen Token Plan** (bbb91fa8a): 全新内置 provider（qwen-token-plan / qwen-token-plan-cn），OpenAI-compatible API
- **OpenRouter OAuth** (7b52cef2e, 61da9e2f3): OpenRouter 支持 OAuth 登录，含手动 redirect URL fallback
- **Kimi Code OAuth** (a5afc3f17): Kimi Code 订阅制 OAuth 登录
- **Claude Opus 5** (921c35435, af3b934fa, 60f6a8034): 在 Anthropic、Bedrock、GitHub Copilot 上支持 Opus 5，含 xhigh effort、adaptive thinking、prompt caching
- **ANTHROPIC_AUTH_TOKEN** (24e5cc04f): 新增 Bearer token 认证方式，自定义 `anthropicApiKeyAuth()` 函数

### 6. 重试可中止 (7af8533c6)
**变化**: `retryAssistantCall` 和 `provider-retry.ts` 新增 abort 信号支持。`sleep()` 在 backoff 期间可被 abort 中断。新增 `onRetryFinished` 回调。`onRetryScheduled` 回调签名扩展（新增 `attempt`/`maxAttempts`/`errorMessage` 参数）。

### 7. 错误处理与诊断增强
- `error-body.ts`: `isPlainNonEmptyObject()` 只认纯对象，避免序列化 SDK class instances（如 Bedrock 的 `$response.body`）
- `ModelsError`: 保留 underlying `cause` 到 message 中
- OAuth resolution: `minOAuthValidityMs` 可配置（默认 5 分钟），刷新后二次校验
- Codex WebSocket: session cache 从单 entry 改为 per-account Map 结构（`cfe6b6a05`）
- Bedrock error metadata: 结构化 diagnostics（status, errorCode, requestId）

### 8. 其他显著改动
- Google: 带签名的空 text/thinking block 现在被保留（`6138f5a07`），否则推理链断裂
- Anthropic SSE: 保留初始 stream block 内容（`59ad3dead`）
- Anthropic `sensitive` stop reason: 从静默 error 改为带 message 的 error
- GPT-5.6 pricing 更新
- OpenRouter: tool result caching + cache control for aliases
- DNS transport failure retry（`33e40c3e1`）
- Fireworks Kimi K3 路由改为 OpenAI compatibility（`a688e257c`）
- Z.AI: send max_tokens（`2fe21b407`）
- Bedrock: 优先使用配置的 profile 而非 ambient AWS keys（`b63403a50`）
- Radius OAuth 走 gateway（`a9f5b1c12`）
- TypeBox nullable array validation fix（`f9476a61e`）

## 关键文件与符号改动

### types.ts
- `ConstrainedSamplingConfig` 类型：`json_schema` | `grammar`
- `Tool.constrainedSampling?: false | ConstrainedSamplingConfig`
- `OpenAICompletionsCompat.supportsFinishReason?: boolean`
- `OpenAICompletionsCompat.supportsOpenAIGrammarTools?: boolean`
- `OpenAIResponsesCompat.supportsStrictMode?: boolean`
- `OpenAIResponsesCompat.supportsOpenAIGrammarTools?: boolean`
- `OpenAIResponsesCompat.supportsExplicitPromptCacheMode?: boolean`
- `AnthropicMessagesCompat.supportsStrictTools?: boolean`
- `BedrockCompat` 新类型：`supportsStrictMode?: boolean`
- `Model.compat` 条件类型扩展：`bedrock-converse-stream` → `BedrockCompat`；`azure-openai-responses` 加入 OpenAIResponsesCompat 分支

### api/constrained-sampling.ts (新文件)
- `resolveJsonSchemaStrictSampling()`
- `resolveGrammarConstrainedSampling()`
- `createGrammarToolInputProperties()`
- `appendGrammarToolInputJsonDelta()`
- `GrammarVariants`, `GrammarConstrainedSampling` types

### api/* (各 adapter)
- `fetch` 参数贯穿：`createClient()` → SDK client options
- `stopReason` 初始值改为 `"pending"`
- `output.rawStopReason` 赋值各 provider
- `convertTools()` 函数签名变化（新增 strict/grammar 参数）
- `convertToolConfig()` → Bedrock 新增 `supportsStrictMode` 参数
- `mapStopReason()` 返回更丰富的 error message
- Google `resolveGoogleFunctionCallingMode()` 新函数

### utils/retry.ts & utils/provider-retry.ts
- `RetrySleepAbortError` class
- `sleep()` 带 AbortSignal
- `retryAssistantCall()` 签名扩展（callbacks）
- `onRetryScheduled` 回调签名变化

### auth/
- `AuthResolutionOverrides.minOAuthValidityMs`
- `resolveStoredOAuth()`: 5min 提前刷新窗口 + 二次校验
- `ModelsError`: cause detail 保留

### providers/
- 所有 `.models.ts` shard 文件：从内联数据改为 `flattenModelCatalog()` 包装的 JSON 导入
- 数据从 `.models.ts` 迁移到 `data/<provider>.json`
- `all.ts`: 新增 `getBuiltinModelDataGeneratedAt()`，注册 qwen-token-plan provider
- `anthropic.ts`: auth 重写（自定义 `anthropicApiKeyAuth()` 替代 `envApiKeyAuth`）
- 新文件: `qwen-token-plan.ts`, `qwen-token-plan-cn.ts` 及对应 `.models.ts`

### models.generated.ts
- `MODELS` 对象从 `as const` 改为显式 `typeof` 类型标注
- 新增 `qwen-token-plan` / `qwen-token-plan-cn` entries

## 新功能 / 删除的功能

**新增**:
- Constrained sampling (json_schema + grammar)
- Qwen Token Plan provider (国内 + 国际)
- OpenRouter OAuth, Kimi Code OAuth
- Per-request fetch 注入
- 可中止的重试 backoff
- Bedrock error metadata diagnostics
- ANTHROPIC_AUTH_TOKEN Bearer auth
- 模型数据 build-time validation
- `supportsFinishReason` compat flag
- Stream end 安全检测（pending → error）
- Claude Opus 5 全系支持

**删除/废弃**:
- 无重大删除。旧的内联模型数据从 `.models.ts` 中移走但有等价 JSON 替代。

## Breaking / API 变化

1. **`models.generated.ts` 类型变化**: `as const` → `typeof` 标注。外部消费 `MODELS[key]` 的类型可能更精确；如果依赖 `as const` 的 literal type 则需要适配。
2. **`.models.ts` shard 文件结构变化**: 从 `{ "model-id": { ... } } as Type` 变为 `ModelCatalog<typeof values>` + JSON 导入。不能再从这些文件直接 `import` 类型（数据在 JSON 里）。
3. **`retryAssistantCall` 回调签名变化**: `onRetryScheduled` 新增 `attempt`/`maxAttempts`/`errorMessage` 参数；新增 `onRetryFinished` 回调。
4. **`convertTools` 等函数签名变化**: 各 API adapter 的 `convertTools`/`convertToolConfig` 新增 strict/grammar 参数。
5. **`ModelsError` 构造函数**: cause 现在保留到 message 中，可能影响错误消息的精确匹配。
6. **OAuth**: `resolveStoredOAuth` 新增 `minOAuthValidityMs` 参数。
7. **Stop reason 语义**: 初始 `stopReason` 从 `"stop"` 改为 `"pending"`，依赖初始值的代码需适配。

## 与本 fork 的重叠（冲突文件清单）

**两方都修改的文件（高冲突风险）**:

| 文件 | 上游改动 | Fork 改动 |
|---|---|---|
| `scripts/generate-models.ts` | 全面重写（JSON派生+shard生成） | Opus 5 + thinking level 元数据扩展 |
| `src/types.ts` | ConstrainedSampling + BedrockCompat + compat flags | SystemMessage + ToolResultMessage.usage |
| `src/api/anthropic-messages.ts` | fetch injection + strict tools + stop reason | splitSystemMessages + TokenRouter |
| `src/api/bedrock-converse-stream.ts` | error metadata + strict mode + Opus 5 | splitSystemMessages |
| `src/api/google-generative-ai.ts` | raw stop reason + strict tool sampling + pending | splitSystemMessages |
| `src/api/google-vertex.ts` | 同上 | splitSystemMessages |
| `src/api/mistral-conversations.ts` | raw stop reason + fetch + strict tools | splitSystemMessages |
| `src/api/openai-codex-responses.ts` | per-account websocket + grammar tools | splitSystemMessages |
| `src/api/openai-completions.ts` | raw stop reason + grammar tools + supportsFinishReason | splitSystemMessages |
| `src/api/openai-responses-shared.ts` | grammar tools + strict mode | splitSystemMessages + ToolResultMessage |
| `src/api/openai-responses.ts` | grammar tools + prompt cache + pending | splitSystemMessages |
| `src/api/openrouter-images.ts` | fetch injection | splitSystemMessages |
| `src/providers/*.models.ts` (20+ files) | JSON数据派生重构 | 模型目录重新生成（含 TokenRouter 检测） |
| `src/utils/retry.ts` | abortable sleep + callbacks | abortable sleep + callbacks |
| `src/utils/provider-retry.ts` | 新文件 | 新文件 |
| `test/*` (15+ files) | 各种新测试 | test reference 更新 |

**上游新增但 fork 没有的文件（需引入）**:
- `src/api/constrained-sampling.ts`
- `src/providers/qwen-token-plan.ts`, `src/providers/qwen-token-plan-cn.ts`
- `src/providers/qwen-token-plan.models.ts`, `src/providers/qwen-token-plan-cn.models.ts`
- `src/providers/data/qwen-token-plan.json`, `src/providers/data/qwen-token-plan-cn.json`
- `test/constrained-sampling.test.ts`, `test/fetch-option.test.ts`, `test/bedrock-error-metadata.test.ts`, `test/openrouter-oauth.test.ts`, `test/kimi-coding-oauth.test.ts`, `test/anthropic-auth-token.test.ts`, `test/model-data-validation.test.ts`, `test/anthropic-sse-parsing.test.ts`, `test/google-raw-stop-reason.test.ts`, `test/mistral-raw-stop-reason.test.ts`, `test/bedrock-credentials.test.ts`, 等

## 合入注意点

### 1. models.generated.ts 生成方式 —— 最大冲突面
**上游已将 generate-models.ts 全面重写**。fork 的 modify（Opus 5 + thinking metadata 扩展）需要移植到新生成脚本中。具体来说：
- fork 在 `isAnthropicAdaptiveThinkingModel()` 和 `isAnthropicTemperatureUnsupportedModel()` 中添加了 `opus-5` 检测
- fork 在 `applyThinkingLevelMetadata()` 中添加了 `opus-5` xhigh support
- 这些修改必须手动回溯到上游新版的 `generate-models.ts` 中
- **建议**: 先跑上游新 `npm run generate-models`，再在我们的 JSON 数据上补 Opus 5 模型，最后迁移 thinking metadata 逻辑

**数据层面**: fork 已运行过 `generate-models`，`src/providers/data/` 下的 JSON 和 `.models.ts` shard 已经是新格式。上游改动应与这些文件兼容（JSON schema 不变）。

### 2. types.ts 冲突
- 上游新增: `ConstrainedSamplingConfig`, `BedrockCompat`, 多个 compat flags
- Fork 新增: `SystemMessage`, `ToolResultMessage.usage`
- `Message` union 类型两边都要改 — 手动合并
- `Model.compat` 条件类型两边都要改 — 上游加了 `azure-openai-responses` 和 `bedrock-converse-stream` 分支，fork 没动这个。需保留上游改动。

### 3. transform-messages.ts
- Fork 新增了 `splitSystemMessages()` 函数
- 上游改动了此文件（增加 constrained sampling 相关逻辑如 `appendGrammarToolInputJsonDelta`）
- **注意**: 检查上游是否有 `constrained-sampling.ts` 的一些逻辑迁移到此文件。如果 fork 改动只加在文件末尾，冲突小。

### 4. 各 API adapter 的 splitSystemMessages 调用
- Fork 在 12 个 API adapter 中添加 `splitSystemMessages` 调用
- 上游在同样这些文件中进行了大量改动（fetch, strict tools, grammar, stop reason）
- **这是最耗时的合并工作**：需要在每个 adapter 中同时保留两边的改动
- 建议逐个 adapter 手工合并，确保 `splitSystemMessages` 调用路径与新的 `fetch`/`grammarToolInputProperties`/`convertTools` 签名兼容

### 5. utils/retry.ts 和 utils/provider-retry.ts
两边都创建了这些文件的修改版本。fork 版本和上游版本的功能类似（abortable sleep + callbacks），但可能参数/签名有细微差异。**需要 diff 比较选择一版或合并**。

### 6. 新增 provider 注册
上游新增的 `qwen-token-plan` / `qwen-token-plan-cn` provider 需要完整引入：
- `all.ts` 的 import 和注册
- `.models.ts` shard 文件
- JSON 数据文件
- `env-api-keys.ts` 的 env var 映射
- `models.generated.ts` 的 import

### 7. 新增 API 模块
`constrained-sampling.ts` 必须完整复制到 fork。需要确保 `transform-messages.ts`（fork 改了）中没有与 constrained-sampling 冲突的逻辑。

### 8. 测试迁移
上游新增大量测试文件，fork 在已有测试上做了一些 reference 更新。**先接受上游测试文件，再跑一遍全量测试**，修复因 fork 改动导致的 reference 不匹配（TokenRouter 检测等）。

### 9. 合入顺序建议
1. 先接受上游所有纯新增文件（constrained-sampling, qwen-token-plan, 新测试等）
2. 合并 `types.ts`（两边新增类型不冲突，手动合并）
3. 合并 `generate-models.ts`（以新版为基础，迁移 fork 的 Opus 5 逻辑）
4. 逐个合并各 API adapter（最耗时，12 个文件）
5. 合并 `utils/retry.ts` 和 `utils/provider-retry.ts`
6. 合并 providers 注册文件（all.ts, env-api-keys.ts, anthropic.ts）
7. 跑 `generate-models` 重新生成所有 `.models.ts` shard
8. 全量测试，修复因合并导致的问题
