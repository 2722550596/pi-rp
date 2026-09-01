import { join } from "node:path";
import { Agent, type AgentMessage, setDefaultStreamFn, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import { clampThinkingLevel, type Message, type Model, streamSimple } from "@earendil-works/pi-ai/compat";
import { getAgentDir } from "../config.ts";
import { resolvePath } from "../utils/paths.ts";
import { AgentSession } from "./agent-session.ts";
import type { AgentSessionRuntimeDiagnostic } from "./agent-session-services.ts";
import { formatNoModelsAvailableMessage } from "./auth-guidance.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import type { ExtensionRunner, LoadExtensionsResult, SessionStartEvent, ToolDefinition } from "./extensions/index.ts";
import { convertToLlm } from "./messages.ts";
import { findInitialModel } from "./model-resolver.ts";
import { ModelRuntime } from "./model-runtime.ts";
import { chooseDefaultPreset, loadPromptPresets } from "./prompt-preset/loader.ts";
import { mergeProviderAttributionHeaders } from "./provider-attribution.ts";
import type { RequestIdentity } from "./request-gateway.ts";
import { RequestGateway } from "./request-gateway.ts";
import type { ResourceLoader } from "./resource-loader.ts";
import { DefaultResourceLoader } from "./resource-loader.ts";
import {
	getDefaultSessionDir,
	type PresetChangeEntry,
	type SchemaChangeEntry,
	type SessionEntry,
	SessionManager,
	type StrictChangeEntry,
} from "./session-manager.ts";
import { SettingsManager } from "./settings-manager.ts";
import { time } from "./timings.ts";
import {
	createBashTool,
	createCodingTools,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadOnlyTools,
	createReadTool,
	createWriteTool,
	type ToolName,
	withFileMutationQueue,
} from "./tools/index.ts";

// Preserve the pre-0.81 fallback for extensions that construct Agent instances
// or invoke low-level agent loops without supplying streamFn. Agent core remains
// provider-agnostic and does not import pi-ai/compat itself.
setDefaultStreamFn(streamSimple);

/** Latest entry of a given type walking backward (newest first). */
function latestEntryOfType<T extends SessionEntry>(entries: SessionEntry[], type: T["type"]): T | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].type === type) return entries[i] as T;
	}
	return undefined;
}

/** Latest schema_change for a namespace walking backward (newest first). */
function latestSchemaChangeForNamespace(entries: SessionEntry[], namespace: string): SchemaChangeEntry | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (e.type === "schema_change" && (e as SchemaChangeEntry).namespace === namespace) {
			return e as SchemaChangeEntry;
		}
	}
	return undefined;
}

export interface CreateAgentSessionOptions {
	/** Working directory for project-local discovery. Default: process.cwd() */
	cwd?: string;
	/** Global config directory. Default: ~/.pi/agent */
	agentDir?: string;

	/** Canonical model/auth runtime. Defaults to a runtime using agentDir/auth.json and models.json. */
	modelRuntime?: ModelRuntime;

	/** Model to use. Default: from settings, else first available */
	model?: Model<any>;
	/** Thinking level. Default: from settings, else 'medium' (clamped to model capabilities) */
	thinkingLevel?: ThinkingLevel;
	/** Models available for cycling (Ctrl+P in interactive mode) */
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;

	/**
	 * Optional default tool suppression mode when no explicit allowlist is provided.
	 *
	 * - "all": start with no tools enabled
	 * - "builtin": disable the default built-in tools (read, bash, edit, write)
	 *   but keep extension/custom tools enabled
	 */
	noTools?: "all" | "builtin";
	/**
	 * Optional allowlist of tool names.
	 *
	 * When omitted, pi uses the `defaultTools` setting for the initial built-in
	 * selection when configured. Otherwise it enables the default built-in tools
	 * (read, bash, edit, write). Extension/custom tools remain enabled unless
	 * `noTools` changes that default. When provided, only the listed tool names are
	 * enabled.
	 */
	tools?: string[];
	/** Optional denylist of tool names to disable. Applies after `tools` when both are provided. */
	excludeTools?: string[];
	/** Custom tools to register (in addition to built-in tools). */
	customTools?: ToolDefinition[];

	/** Resource loader. When omitted, DefaultResourceLoader is used. */
	resourceLoader?: ResourceLoader;

	/** Session manager. Default: SessionManager.create(cwd) */
	sessionManager?: SessionManager;

	/** Settings manager. Default: SettingsManager.create(cwd, agentDir) */
	settingsManager?: SettingsManager;
	/** Request gateway for per-provider concurrency control. When omitted, a new one is created. */
	requestGateway?: RequestGateway;
	/** Identity for gateway-attributed requests from this session. Default: main-tier identity. */
	requestIdentity?: RequestIdentity;
	/** Session start event metadata for extension runtime startup. */
	sessionStartEvent?: SessionStartEvent;
	/** Prompt preset ID to activate at startup. Wins over session restore and settings default; not persisted to settings. */
	preset?: string;
	/** Initial messages to seed the session with (used by subagents) */
	initialMessages?: AgentMessage[];
	/** State schema IDs to load at startup, in order. Recorded as schema_change entries. */
	schemas?: string[];
	/** Enable state schema strict mode: reject state writes to paths not covered by a loaded schema. */
	strict?: boolean;
	/** Mount the cross-process shared state store (default: true). Pass false for in-memory subagents. */
	attachStateStore?: boolean;
}

/** Result from createAgentSession */
export interface CreateAgentSessionResult {
	/** The created session */
	session: AgentSession;
	/** Extensions result (for UI context setup in interactive mode) */
	extensionsResult: LoadExtensionsResult;
	/** Warning if session was restored with a different model than saved */
	modelFallbackMessage?: string;
	/** Diagnostics from startup preset/schema application (warnings only). */
	sessionDiagnostics?: AgentSessionRuntimeDiagnostic[];
}

// Re-exports

export * from "./agent-session-runtime.ts";
export type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
	InlineExtension,
	SlashCommandInfo,
	SlashCommandSource,
	ToolDefinition,
} from "./extensions/index.ts";
export type { PromptTemplate } from "./prompt-templates.ts";
export type { Skill } from "./skills.ts";
export type { Tool } from "./tools/index.ts";

export {
	withFileMutationQueue,
	// Tool factories (for custom cwd)
	createCodingTools,
	createReadOnlyTools,
	createReadTool,
	createBashTool,
	createEditTool,
	createWriteTool,
	createGrepTool,
	createFindTool,
	createLsTool,
};

// Helper Functions

function getDefaultAgentDir(): string {
	return getAgentDir();
}

/**
 * Create an AgentSession with the specified options.
 *
 * @example
 * ```typescript
 * // Minimal - uses defaults
 * const { session } = await createAgentSession();
 *
 * // With explicit model
 * import { getModel } from '@earendil-works/pi-ai';
 * const { session } = await createAgentSession({
 *   model: getModel('anthropic', 'claude-opus-4-5'),
 *   thinkingLevel: 'high',
 * });
 *
 * // Continue previous session
 * const { session, modelFallbackMessage } = await createAgentSession({
 *   continueSession: true,
 * });
 *
 * // Full control
 * const loader = new DefaultResourceLoader({
 *   cwd: process.cwd(),
 *   agentDir: getAgentDir(),
 *   settingsManager: SettingsManager.create(),
 * });
 * await loader.reload();
 * const { session } = await createAgentSession({
 *   model: myModel,
 *   tools: ["read", "bash"],
 *   resourceLoader: loader,
 *   sessionManager: SessionManager.inMemory(),
 * });
 * ```
 */
export async function createAgentSession(options: CreateAgentSessionOptions = {}): Promise<CreateAgentSessionResult> {
	const cwd = resolvePath(options.cwd ?? options.sessionManager?.getCwd() ?? process.cwd());
	const agentDir = options.agentDir ? resolvePath(options.agentDir) : getDefaultAgentDir();
	let resourceLoader = options.resourceLoader;

	const authPath = options.agentDir ? join(agentDir, "auth.json") : undefined;
	const modelsPath = options.agentDir ? join(agentDir, "models.json") : undefined;
	const modelRuntime = options.modelRuntime ?? (await ModelRuntime.create({ authPath, modelsPath }));

	const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
	const sessionManager = options.sessionManager ?? SessionManager.create(cwd, getDefaultSessionDir(cwd, agentDir));

	if (!resourceLoader) {
		resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		await resourceLoader.reload();
		time("resourceLoader.reload");
	}

	// Check if session has existing data to restore
	const existingSession = sessionManager.buildSessionContext();
	const hasExistingSession = existingSession.messages.length > 0;
	const hasThinkingEntry = sessionManager.getBranch().some((entry) => entry.type === "thinking_level_change");

	let model = options.model;
	let modelFallbackMessage: string | undefined;

	// If session has data, try to restore model from it
	if (!model && hasExistingSession && existingSession.model) {
		const restoredModel = modelRuntime.getModel(existingSession.model.provider, existingSession.model.modelId);
		if (restoredModel && modelRuntime.hasConfiguredAuth(restoredModel.provider)) {
			model = restoredModel;
		}
		if (!model) {
			modelFallbackMessage = `Could not restore model ${existingSession.model.provider}/${existingSession.model.modelId}`;
		}
	}

	// If still no model, use findInitialModel (checks settings default, then provider defaults)
	if (!model) {
		const result = await findInitialModel({
			scopedModels: [],
			isContinuing: hasExistingSession,
			defaultProvider: settingsManager.getDefaultProvider(),
			defaultModelId: settingsManager.getDefaultModel(),
			defaultThinkingLevel: settingsManager.getDefaultThinkingLevel(),
			modelRuntime,
		});
		model = result.model;
		if (!model) {
			modelFallbackMessage = formatNoModelsAvailableMessage();
		} else if (modelFallbackMessage) {
			modelFallbackMessage += `. Using ${model.provider}/${model.id}`;
		}
	}

	let thinkingLevel = options.thinkingLevel;

	// If session has data, restore thinking level from it
	if (thinkingLevel === undefined && hasExistingSession) {
		thinkingLevel = hasThinkingEntry
			? (existingSession.thinkingLevel as ThinkingLevel)
			: (settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL);
	}

	// Fall back to settings default
	if (thinkingLevel === undefined) {
		thinkingLevel = settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
	}

	// Clamp to model capabilities
	if (!model) {
		thinkingLevel = "off";
	} else {
		thinkingLevel = clampThinkingLevel(model, thinkingLevel) as ThinkingLevel;
	}

	const defaultActiveToolNames: (ToolName | "state_update" | "get_state" | "subagent_profiles" | "subagent")[] = [
		"read",
		"bash",
		"edit",
		"write",
		"state_update",
		"get_state",
		"subagent_profiles",
		"subagent",
	];
	const configuredDefaultToolNames = settingsManager.getDefaultTools();
	const allowedToolNames = options.tools ?? (options.noTools === "all" ? [] : undefined);
	const excludedToolNames = options.excludeTools;
	const excludedToolNameSet = excludedToolNames ? new Set(excludedToolNames) : undefined;
	const initialActiveToolNames = (
		options.tools ?? (options.noTools ? [] : (configuredDefaultToolNames ?? defaultActiveToolNames))
	).filter((name) => !excludedToolNameSet?.has(name));

	let agent: Agent;

	// Create convertToLlm wrapper that filters images if blockImages is enabled (defense-in-depth)
	const convertToLlmWithBlockImages = (messages: AgentMessage[]): Message[] => {
		// Resolve per-type custom-message policies from the extension runner (declared
		// via pi.registerCustomType); defaults apply when no runner or no declaration.
		const converted = convertToLlm(messages, (customType) =>
			extensionRunnerRef.current?.getCustomTypePolicy(customType),
		);
		// Check setting dynamically so mid-session changes take effect
		if (!settingsManager.getBlockImages()) {
			return converted;
		}
		// Filter out ImageContent from all messages, replacing with text placeholder
		return converted.map((msg) => {
			if (msg.role === "user" || msg.role === "toolResult") {
				const content = msg.content;
				if (Array.isArray(content)) {
					const hasImages = content.some((c) => c.type === "image");
					if (hasImages) {
						const filteredContent = content
							.map((c) =>
								c.type === "image" ? { type: "text" as const, text: "Image reading is disabled." } : c,
							)
							.filter(
								(c, i, arr) =>
									// Dedupe consecutive "Image reading is disabled." texts
									!(
										c.type === "text" &&
										c.text === "Image reading is disabled." &&
										i > 0 &&
										arr[i - 1].type === "text" &&
										(arr[i - 1] as { type: "text"; text: string }).text === "Image reading is disabled."
									),
							);
						return { ...msg, content: filteredContent };
					}
				}
			}
			return msg;
		});
	};

	const extensionRunnerRef: { current?: ExtensionRunner } = {};
	const sessionRef: { current?: AgentSession } = {};

	// Per-provider concurrency gate for all LLM requests in this session.
	// Wrapping the single streamFn below catches the main loop, compaction,
	// and branch summarization (all read `agent.streamFunction`).
	const gateway =
		options.requestGateway ?? new RequestGateway(modelRuntime, settingsManager.getRequestGatewayConfig());
	// Hoisted before streamFn's own `options` param shadows the session options.
	const sessionRequestIdentity = options.requestIdentity;

	agent = new Agent({
		initialState: {
			systemPrompt: "",
			model,
			thinkingLevel,
			tools: [],
		},
		convertToLlm: convertToLlmWithBlockImages,
		streamFn: async (model, context, options) => {
			const providerRetrySettings = settingsManager.getProviderRetrySettings();
			const httpIdleTimeoutMs = settingsManager.getHttpIdleTimeoutMs();
			// SDKs treat timeout=0 as 0ms (immediate timeout), not "no timeout".
			// Use max int32 to effectively disable the timeout.
			const effectiveTimeoutMs = httpIdleTimeoutMs === 0 ? 2147483647 : httpIdleTimeoutMs;
			const timeoutMs = options?.timeoutMs ?? providerRetrySettings.timeoutMs ?? effectiveTimeoutMs;
			const websocketConnectTimeoutMs =
				options?.websocketConnectTimeoutMs ?? settingsManager.getWebSocketConnectTimeoutMs();
			const headerRunner = extensionRunnerRef.current;
			return gateway.streamSimple(
				model,
				context,
				{
					...options,
					timeoutMs,
					websocketConnectTimeoutMs,
					maxRetries: options?.maxRetries ?? providerRetrySettings.maxRetries,
					maxRetryDelayMs: options?.maxRetryDelayMs ?? providerRetrySettings.maxRetryDelayMs,
					transformHeaders: async (requestHeaders) => {
						const headers = mergeProviderAttributionHeaders(
							model,
							settingsManager,
							options?.sessionId,
							requestHeaders,
						);
						return headerRunner?.hasHandlers("before_provider_headers")
							? headerRunner.emitBeforeProviderHeaders(headers ?? {})
							: (headers ?? {});
					},
				},
				sessionRequestIdentity ?? { sessionId: "?", priority: 2, label: "main" },
				options?.signal,
			);
		},
		onPayload: async (payload, _model) => {
			const runner = extensionRunnerRef.current;
			if (!runner?.hasHandlers("before_provider_request")) {
				return payload;
			}
			return runner.emitBeforeProviderRequest(payload);
		},
		onResponse: async (response, _model) => {
			const runner = extensionRunnerRef.current;
			if (!runner?.hasHandlers("after_provider_response")) {
				return;
			}
			await runner.emit({
				type: "after_provider_response",
				status: response.status,
				headers: response.headers,
			});
		},
		sessionId: sessionManager.getSessionId(),
		transformContext: async (messages) => {
			let result: AgentMessage[] = messages;
			// When a user preset is active, use preset-compiled messages directly.
			// getPresetInjectMessages() already embeds agent.state.messages at chat-history position,
			// so appending raw messages would duplicate the conversation.
			if (sessionRef.current) {
				if (sessionRef.current.isSealedContext()) {
					return result;
				}
				const presetItems = await sessionRef.current.getPresetInjectMessages();
				if (presetItems.length > 0) {
					result = presetItems;
				}
			}
			// Run extensions on the full context (preset + conversation)
			const runner = extensionRunnerRef.current;
			result = runner ? await runner.emitContext(result) : result;
			// Capture final payload for /prompt inspection
			if (sessionRef.current) {
				sessionRef.current.lastTransformedMessages = result;
			}
			return result;
		},
		steeringMode: settingsManager.getSteeringMode(),
		followUpMode: settingsManager.getFollowUpMode(),
		transport: settingsManager.getTransport(),
		thinkingBudgets: settingsManager.getThinkingBudgets(),
		maxRetryDelayMs: settingsManager.getProviderRetrySettings().maxRetryDelayMs,
	});

	// Restore messages if session has existing data
	if (hasExistingSession) {
		agent.state.messages = existingSession.messages;
		if (!hasThinkingEntry) {
			sessionManager.appendThinkingLevelChange(thinkingLevel);
		}
	} else {
		// Save initial model, thinking level, and preset for new sessions
		if (model) {
			sessionManager.appendModelChange(model.provider, model.id);
		}
		sessionManager.appendThinkingLevelChange(thinkingLevel);
		if (!options.preset) {
			// New sessions record the actually-effective default preset:
			// settings default → first auto-activatable preset on disk → built-in default.
			const defaultPresetId =
				settingsManager.getDefaultPreset() ??
				chooseDefaultPreset(loadPromptPresets(cwd, agentDir))?.preset.id ??
				"default";
			sessionManager.appendPresetChange(defaultPresetId);
		}
	}

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd,
		scopedModels: options.scopedModels,
		resourceLoader,
		customTools: options.customTools,
		modelRuntime,
		requestGateway: gateway,
		initialActiveToolNames,
		allowedToolNames,
		excludedToolNames,
		extensionRunnerRef,
		sessionStartEvent: options.sessionStartEvent,
		attachStateStore: options.attachStateStore,
	});
	sessionRef.current = session;
	const sessionDiagnostics: AgentSessionRuntimeDiagnostic[] = [];
	if (options.initialMessages) {
		session.setInitialMessages(options.initialMessages);
	}
	// 续档去重：preset/schema/strict 的最新条目与本次 CLI 参数一致时，只应用内存态、
	// 不追加 change 条目——进程重启（--continue 续档、web 壳断线重连后重新 spawn）
	// 不再给会话文件留下重复的 preset_change/schema_change/strict_change 尾巴。
	const resumedEntries = hasExistingSession ? sessionManager.getEntries() : [];
	const presetAlreadyActive =
		options.preset !== undefined &&
		latestEntryOfType<PresetChangeEntry>(resumedEntries, "preset_change")?.presetId === options.preset;
	if (options.preset) {
		const presetResult = await session.setActivePreset(options.preset, {
			persistSettings: false,
			record: !presetAlreadyActive,
		});
		if (!presetResult.ok) {
			const available =
				session
					.getAllPresets()
					.map((p) => p.preset.id)
					.join(", ") || "(none defined)";
			sessionDiagnostics.push({
				type: "warning",
				message: `Prompt preset "${options.preset}" not found. Available: ${available}`,
			});
		} else if (presetResult.error) {
			sessionDiagnostics.push({ type: "warning", message: presetResult.error });
		}
	}
	for (const schemaId of options.schemas ?? []) {
		const def = session.getLoadedSchemaDefs().find((s) => s.schemaId === schemaId);
		const alreadyLoaded =
			def !== undefined &&
			latestSchemaChangeForNamespace(resumedEntries, def.namespace)?.action === "load" &&
			latestSchemaChangeForNamespace(resumedEntries, def.namespace)?.schemaId === schemaId;
		const schemaResult = session.loadSchema(schemaId, { record: !alreadyLoaded });
		if (!schemaResult.ok) {
			sessionDiagnostics.push({
				type: "warning",
				message: schemaResult.error ?? `Schema "${schemaId}" not found`,
			});
		}
	}
	if (options.strict) {
		const alreadyStrict = latestEntryOfType<StrictChangeEntry>(resumedEntries, "strict_change")?.enabled === true;
		session.setStrictMode(true, { record: !alreadyStrict });
	}
	const extensionsResult = resourceLoader.getExtensions();

	return {
		session,
		extensionsResult,
		modelFallbackMessage,
		sessionDiagnostics,
	};
}
