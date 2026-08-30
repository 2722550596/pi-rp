/**
 * AgentSession - Core abstraction for agent lifecycle and session management.
 *
 * This class is shared between all run modes (interactive, print, rpc).
 * It encapsulates:
 * - Agent state access
 * - Event subscription with automatic session persistence
 * - Model and thinking level management
 * - Compaction (manual and auto)
 * - Bash execution
 * - Session switching and branching
 *
 * Modes use this class and add their own I/O layer on top.
 */

export type {
	CompileMessageSource,
	CompileMessagesResult,
	CompileSystemPromptResult,
} from "./prompt-preset/compiler.ts";

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type {
	Agent,
	AgentEvent,
	AgentMessage,
	AgentState,
	AgentTool,
	PrepareNextTurnContext,
	StreamFn,
	ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { contentText } from "@earendil-works/pi-ai";
import type {
	Api,
	AssistantMessage,
	AuthResult,
	ImageContent,
	Model,
	ProviderHeaders,
	SimpleStreamOptions,
	TextContent,
	Usage,
} from "@earendil-works/pi-ai/compat";
import {
	clampThinkingLevel,
	cleanupSessionResources,
	getSupportedThinkingLevels,
	isContextOverflow,
	isRecoverableLength,
	isRetryableAssistantError,
	modelsAreEqual,
	type RetryCallbacks,
	resetApiProviders,
	streamSimple,
} from "@earendil-works/pi-ai/compat";
import { registerBuiltinCommandEntries, syncExtensionCommands } from "../commands/index.ts";
import { getAgentDir, getProjectConfigDir } from "../config.ts";
import { getThemeByName, theme } from "../modes/interactive/theme/theme.ts";
import { type LoadedSchemaDef, loadCustomValidators, loadSchemaDefs } from "../state/schema-loader.ts";
import { type CustomValidator, SchemaValidator } from "../state/schema-validator.ts";
import { type JsonValue, StateManager } from "../state/state-manager.ts";
import { StateStore } from "../state/state-store.ts";
import { stripFrontmatter } from "../utils/frontmatter.ts";
import { resolvePath } from "../utils/paths.ts";
import { sleep } from "../utils/sleep.ts";
import { normalizeToolResultImages } from "../utils/tool-result-images.ts";
import { formatNoApiKeyFoundMessage, formatNoModelSelectedMessage } from "./auth-guidance.ts";
import { type BashResult, executeBashWithOperations } from "./bash-executor.ts";
import {
	type CompactionPreparation,
	type CompactionPromptOverrides,
	type CompactionResult,
	calculateContextTokens,
	collectEntriesForBranchSummary,
	compact,
	completeSummarization,
	estimateContextTokens,
	estimateTokens,
	generateBranchSummary,
	prepareCompaction,
	shouldCompact,
} from "./compaction/index.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import { exportSessionToHtml, type ToolHtmlRenderer } from "./export-html/index.ts";
import { createToolHtmlRenderer } from "./export-html/tool-renderer.ts";
import {
	type AgentEndEvent,
	type ContextUsage,
	type ExtensionCommandContextActions,
	type ExtensionErrorListener,
	type ExtensionMode,
	ExtensionRunner,
	type ExtensionUIContext,
	type InputSource,
	type LiveMessageHandle,
	type MessageEndEvent,
	type MessageStartEvent,
	type MessageUpdateEvent,
	type ReplacedSessionContext,
	type SessionBeforeCompactResult,
	type SessionBeforeTreeResult,
	type SessionStartEvent,
	type ShutdownHandler,
	type ToolDefinition,
	type ToolExecutionEndEvent,
	type ToolExecutionStartEvent,
	type ToolExecutionUpdateEvent,
	type ToolInfo,
	type TreePreparation,
	type TurnEndEvent,
	type TurnStartEvent,
	wrapRegisteredTools,
} from "./extensions/index.ts";
import { emitSessionShutdownEvent } from "./extensions/runner.ts";
import type { OrchestrationAck } from "./extensions/types.ts";
import type { BashExecutionMessage, CustomMessage } from "./messages.ts";
import { convertToLlm } from "./messages.ts";
import { ModelRegistry } from "./model-registry.ts";
import { findExactModelReferenceMatch } from "./model-resolver.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import {
	compileMessages,
	compileSystemPrompt,
	deriveSystemPrompt,
} from "./prompt-preset/compiler.ts";
import type {
	LoadedPromptPreset,
	PromptPreset,
	PromptPresetDiagnostic,
	PromptPresetSlotItem,
	PromptRuntime,
} from "./prompt-preset/index.ts";
import { defaultPreset } from "./prompt-preset/index.ts";
import { chooseDefaultPreset, isDisabledPromptPresetId, loadPromptPresets } from "./prompt-preset/loader.ts";
import { expandMacros } from "./prompt-preset/macro-engine.ts";
import { applyResourcePolicy, hasResourcePolicy } from "./prompt-preset/policy.ts";
import { applyFinalizeRegexRulesToMessage, applyRegexRulesToMessages } from "./prompt-preset/regex-engine.ts";
import { isChatHistoryPosition } from "./prompt-preset/slot-renderers.ts";
import { expandPromptTemplate, type PromptTemplate } from "./prompt-templates.ts";
import type { RequestGateway } from "./request-gateway.ts";
import type { ResourceExtensionPaths, ResourceLoader } from "./resource-loader.ts";
import type { BranchSummaryEntry, CompactionEntry, SessionEntry, SessionManager } from "./session-manager.ts";
import {
	CURRENT_SESSION_VERSION,
	getLatestCompactionEntry,
	type SessionHeader,
	sessionEntryToContextMessages,
} from "./session-manager.ts";
import type { SettingsManager } from "./settings-manager.ts";
import type { SlashCommandInfo } from "./slash-commands.ts";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.ts";
import { createSubagentProfilesToolDefinition, createSubagentToolDefinition } from "./subagent/extension.ts";
import { spawnAgent } from "./subagent/spawn.ts";
import { type BuildSystemPromptOptions, buildSystemPrompt } from "./system-prompt.ts";
import { type BashOperations, createLocalBashOperations } from "./tools/bash.ts";
import { createAllToolDefinitions } from "./tools/index.ts";
import { createGetStateToolDefinition, createStateUpdateToolDefinition } from "./tools/state-update.ts";
import { createToolDefinitionFromAgentTool } from "./tools/tool-definition-wrapper.ts";
import { addUsageToTotals, createUsageTotals } from "./usage-totals.ts";
// ============================================================================

/** Parsed skill block from a user message */
export interface ParsedSkillBlock {
	name: string;
	location: string;
	content: string;
	userMessage: string | undefined;
}

/**
 * Parse a skill block from message text.
 * Returns null if the text doesn't contain a skill block.
 */
export function parseSkillBlock(text: string): ParsedSkillBlock | null {
	const match = text.match(/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/);
	if (!match) return null;
	return {
		name: match[1],
		location: match[2],
		content: match[3],
		userMessage: match[4]?.trim() || undefined,
	};
}

/** Session-specific events that extend the core AgentEvent */
export type AgentSessionEvent =
	| Exclude<AgentEvent, { type: "agent_end" }>
	| {
			type: "agent_end";
			messages: AgentMessage[];
			willRetry: boolean;
	  }
	| { type: "agent_settled" }
	| {
			type: "queue_update";
			steering: readonly string[];
			followUp: readonly string[];
	  }
	| { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
	| { type: "entry_appended"; entry: SessionEntry }
	| { type: "session_info_changed"; name: string | undefined }
	| { type: "thinking_level_changed"; level: ThinkingLevel }
	| {
			type: "compaction_end";
			reason: "manual" | "threshold" | "overflow";
			result: CompactionResult | undefined;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
	  }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| {
			type: "summarization_retry_scheduled";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
	  }
	| { type: "summarization_retry_attempt_start"; source: "branchSummary" }
	| {
			type: "summarization_retry_attempt_start";
			source: "compaction";
			reason: "manual" | "threshold" | "overflow";
	  }
	| { type: "summarization_retry_finished" }
	| { type: "bash_execution_update"; id?: string; delta: string }
	| { type: "custom_message_update"; message: CustomMessage }
	| { type: "leaf_changed"; newLeafId: string | null; oldLeafId: string | null }
	| { type: "entry_edited"; entryId: string }
	| { type: "preset_activated"; presetId: string };

/** Listener function for agent session events */
export type AgentSessionEventListener = (event: AgentSessionEvent) => void;

// ============================================================================
// Types
// ============================================================================

function withoutDeletedHeaders(headers: ProviderHeaders | undefined): Record<string, string> | undefined {
	return headers
		? Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== null))
		: undefined;
}

export interface AgentSessionConfig {
	agent: Agent;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	cwd: string;
	/** Models to cycle through with Ctrl+P (from --models flag) */
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	/** Resource loader for extensions, skills, prompts, themes, context files, and system prompt */
	resourceLoader: ResourceLoader;
	/** SDK custom tools registered outside extensions */
	customTools?: ToolDefinition[];
	/** Canonical model/auth runtime used by coding-agent internals. */
	modelRuntime: ModelRuntime;
	/** Optional request gateway for per-provider concurrency control. */
	requestGateway?: RequestGateway;
	/** Initial active built-in tool names. Default: [read, bash, edit, write] */
	initialActiveToolNames?: string[];
	/** Optional allowlist of tool names. When provided, only these tool names are exposed. */
	allowedToolNames?: string[];
	/** Optional denylist of tool names. When provided, these tool names are not exposed. */
	excludedToolNames?: string[];
	/**
	 * Override base tools (useful for custom runtimes).
	 *
	 * These are synthesized into minimal ToolDefinitions internally so AgentSession can keep
	 * a definition-first registry even when callers provide plain AgentTool instances.
	 */
	baseToolsOverride?: Record<string, AgentTool>;
	/** Mutable ref used by Agent to access the current ExtensionRunner */
	extensionRunnerRef?: { current?: ExtensionRunner };
	/** Session start event metadata emitted when extensions bind to this runtime. */
	sessionStartEvent?: SessionStartEvent;
	/** Mount the cross-process shared state store (default: true). Subagents pass false. */
	attachStateStore?: boolean;
}

export interface ExtensionBindings {
	uiContext?: ExtensionUIContext;
	mode?: ExtensionMode;
	commandContextActions?: ExtensionCommandContextActions;
	abortHandler?: () => void;
	shutdownHandler?: ShutdownHandler;
	onError?: ExtensionErrorListener;
	/**
	 * 子进程扩展的「活体读取父会话」（affiliated-session B）：RPC 模式绑定走
	 * context_request/response 通道的实现；TUI/print 无父会话，不绑定（ctx.requestParentContext 为 undefined）。
	 */
	parentContextRequest?: (request: { since?: string; namespaces?: string[] }) => Promise<{
		messages?: Array<{ role: string; content: unknown }>;
		state?: Record<string, unknown>;
	}>;
	/**
	 * 子进程扩展的「请求父会话编排」（pass_mic）：RPC 模式绑定走
	 * orchestration_request/response 通道的实现；TUI/print 无父会话，不绑定（ctx.requestOrchestration 为 undefined）。
	 */
	orchestrationRequest?: (request: { kind: "pass_mic"; from: string; target: string }) => Promise<{
		ack: OrchestrationAck;
	}>;
}

/** Options for AgentSession.prompt() */
export interface PromptOptions {
	/** Whether to dispatch extension commands and expand skill commands and prompt templates (default: true) */
	expandPromptTemplates?: boolean;
	/** Image attachments */
	images?: ImageContent[];
	/** When streaming, how to queue the message: "steer" (interrupt) or "followUp" (wait). Required if streaming. */
	streamingBehavior?: "steer" | "followUp";
	/** Source of input for extension input event handlers. Defaults to "interactive". */
	source?: InputSource;
	/** Internal hook used by RPC mode to observe prompt preflight acceptance or rejection. */
	preflightResult?: (success: boolean) => void;
}

/** Result from setActivePreset() */
export interface SetActivePresetResult {
	/** true if preset found and activated; false if preset not found */
	ok: boolean;
	/** Set if the preset activated but its declared model failed to apply */
	error?: string;
	/** Set to the active model when the preset declared one and it is now active */
	model?: Model<Api>;
}

/** Result from cycleModel() */

export interface ModelCycleResult {
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	/** Whether cycling through scoped models (--models flag) or all available */
	isScoped: boolean;
}

/** Session statistics for /session command */
export interface SessionStats {
	sessionFile: string | undefined;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number;
	contextUsage?: ContextUsage;
}

interface ToolDefinitionEntry {
	definition: ToolDefinition;
	sourceInfo: SourceInfo;
}

function estimateMessagesTokens(messages: AgentMessage[]): number {
	let tokens = 0;
	for (const message of messages) {
		tokens += estimateTokens(message);
	}
	return tokens;
}

// ============================================================================
// Constants
// ============================================================================

/** Standard thinking levels */
const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];

// ============================================================================
// AgentSession Class
// ============================================================================

export class AgentSession {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;

	private _scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;

	// Event subscription state
	private _unsubscribeAgent?: () => void;
	private _eventListeners: AgentSessionEventListener[] = [];
	private _isAgentRunActive = false;
	private _idleWaitPromise: Promise<void> | undefined;
	private _resolveIdleWait: (() => void) | undefined;

	/** Tracks pending steering messages for UI display. Removed when delivered. */
	private _steeringMessages: string[] = [];
	/** Tracks pending follow-up messages for UI display. Removed when delivered. */
	private _followUpMessages: string[] = [];
	/** Messages queued to be included with the next user prompt as context ("asides"). */
	private _pendingNextTurnMessages: CustomMessage[] = [];

	// Compaction state
	private _compactionAbortController: AbortController | undefined = undefined;
	private _autoCompactionAbortController: AbortController | undefined = undefined;
	private _overflowRecoveryAttempted = false;

	// Branch summarization state
	private _branchSummaryAbortController: AbortController | undefined = undefined;

	// Retry state
	private _retryAbortController: AbortController | undefined = undefined;
	private _retryAttempt = 0;

	// Bash execution state
	private _bashAbortControllers = new Set<AbortController>();
	private _pendingBashMessages: BashExecutionMessage[] = [];

	// Extension system
	private _extensionRunner!: ExtensionRunner;
	private _turnIndex = 0;
	/**
	 * Index into agent.state.messages where the current trace (agent start to
	 * agent end) begins. Recorded on agent_start, when state.messages still
	 * contains only completed traces. Consumed by chat-history
	 * `stripAssistantThinking: "previous-traces"`.
	 */
	private _currentTraceStartIndex = 0;

	private _resourceLoader: ResourceLoader;
	private _customTools: ToolDefinition[];
	private _stateManager: StateManager;
	private _schemaValidator: SchemaValidator;
	private _loadedSchemaDefs: LoadedSchemaDef[] = [];
	private _loadedCustomValidators: CustomValidator[] = [];
	private _baseToolDefinitions: Map<string, ToolDefinition> = new Map();
	private _cwd: string;
	private _extensionRunnerRef?: { current?: ExtensionRunner };
	private _initialActiveToolNames?: string[];
	private _allowedToolNames?: Set<string>;
	private _excludedToolNames?: Set<string>;
	private _baseToolsOverride?: Record<string, AgentTool>;
	private _sessionStartEvent: SessionStartEvent;
	private _extensionMode: ExtensionMode = "print";
	private _extensionCommandContextActions?: ExtensionCommandContextActions;
	private _extensionAbortHandler?: () => void;
	private _extensionShutdownHandler?: ShutdownHandler;
	private _extensionErrorListener?: ExtensionErrorListener;
	private _extensionErrorUnsubscriber?: () => void;
	private _extensionParentContextRequest?: ExtensionBindings["parentContextRequest"];
	private _extensionOrchestrationRequest?: ExtensionBindings["orchestrationRequest"];
	private _modelRuntime: ModelRuntime;
	private _requestGateway?: RequestGateway;
	private _attachStateStore = true;
	private _extensionUIContext?: ExtensionUIContext;
	private _toolRegistry: Map<string, AgentTool> = new Map();
	private _toolDefinitions: Map<string, ToolDefinitionEntry> = new Map();
	private _toolPromptSnippets: Map<string, string> = new Map();
	private _toolPromptGuidelines: Map<string, string[]> = new Map();

	private _baseSystemPrompt = "";
	private _activePreset: PromptPreset = defaultPreset;
	/** True once setActivePreset() ran — the lazy restore block must not override an explicit activation. */
	private _presetExplicitlyActivated = false;
	private _loadedPresets: LoadedPromptPreset[] = [];

	private _baseSystemPromptOptions!: BuildSystemPromptOptions;

	private _systemPromptOverride?: string;

	// Baseline tool set before the active preset's tools policy was applied
	private _toolPolicyBaseline?: string[];
	/** Captured messages from the last agent run, for /prompt inspection. */
	private _lastCompiledMessages: AgentMessage[] = [];
	private _sealedContext = false;
	private _lastCompiledSystemPrompt = "";

	/** Check if this session's context is sealed by a subagent preparation */
	isSealedContext(): boolean {
		return this._sealedContext;
	}

	/** Seed initial messages directly. Only valid if the last message is from a user. Seals the context. */
	setInitialMessages(messages: AgentMessage[]): void {
		if (messages.length > 0 && messages[messages.length - 1].role !== "user") {
			throw new Error("Initial messages must end with a user message");
		}
		this.agent.state.messages = [...messages];
		this._currentTraceStartIndex = 0;
		this._sealedContext = true;
	}

	get modelRuntime(): ModelRuntime {
		return this._modelRuntime;
	}

	get requestGateway(): RequestGateway | undefined {
		return this._requestGateway;
	}

	get stateManager(): StateManager {
		return this._stateManager;
	}

	get schemaValidator(): SchemaValidator {
		return this._schemaValidator;
	}

	/** Flattened system-prompt options for subagent peer-completion. */
	get systemPromptOptions(): BuildSystemPromptOptions {
		return this._baseSystemPromptOptions;
	}

	/** Final messages after transformContext (extensions + preset injection). */
	lastTransformedMessages: AgentMessage[] = [];
	constructor(config: AgentSessionConfig) {
		this.agent = config.agent;
		this.sessionManager = config.sessionManager;
		this.settingsManager = config.settingsManager;
		this._scopedModels = config.scopedModels ?? [];
		this._resourceLoader = config.resourceLoader;
		this._customTools = config.customTools ?? [];
		this._stateManager = new StateManager();
		this._schemaValidator = new SchemaValidator();
		this._cwd = config.cwd;
		this._modelRuntime = config.modelRuntime;
		this._requestGateway = config.requestGateway;
		this._extensionRunnerRef = config.extensionRunnerRef;
		this._initialActiveToolNames = config.initialActiveToolNames;
		this._allowedToolNames = config.allowedToolNames ? new Set(config.allowedToolNames) : undefined;
		this._excludedToolNames = config.excludedToolNames ? new Set(config.excludedToolNames) : undefined;
		this._baseToolsOverride = config.baseToolsOverride;
		this._sessionStartEvent = config.sessionStartEvent ?? { type: "session_start", reason: "startup" };
		this._attachStateStore = config.attachStateStore ?? true;

		// Always subscribe to agent events for internal handling
		// (session persistence, extensions, auto-compaction, retry logic)
		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
		this._installAgentToolHooks();
		this._installAgentNextTurnRefresh();

		this._buildRuntime({
			activeToolNames: this._initialActiveToolNames,
			includeAllExtensionTools: true,
		});
	}

	private async _getRequiredRequestAuth(model: Model<any>): Promise<{
		model: Model<any>;
		apiKey?: string;
		headers?: Record<string, string>;
		env?: Record<string, string>;
	}> {
		let result: AuthResult | undefined;
		try {
			result = await this._modelRuntime.getAuth(model);
		} catch (error) {
			const cause = error instanceof Error ? error.cause : undefined;
			if (cause instanceof Error && cause.message === "authHeader requires a resolved API key") {
				throw new Error(formatNoApiKeyFoundMessage(model.provider));
			}
			throw error;
		}
		if (result && (result.auth.apiKey || result.auth.headers)) {
			const requestModel = result.auth.baseUrl ? { ...model, baseUrl: result.auth.baseUrl } : model;
			return {
				model: requestModel,
				apiKey: result.auth.apiKey,
				headers: withoutDeletedHeaders(result.auth.headers),
				env: result.env,
			};
		}

		const isOAuth = this._modelRuntime.isUsingOAuth(model.provider);
		if (isOAuth) {
			throw new Error(
				`Authentication failed for "${model.provider}". ` +
					`Credentials may have expired or network is unavailable. ` +
					`Run '/login ${model.provider}' to re-authenticate.`,
			);
		}
		throw new Error(formatNoApiKeyFoundMessage(model.provider));
	}
	private async _getSummarizationRequestAuth(model: Model<any>): Promise<{
		model: Model<any>;
		apiKey?: string;
		headers?: Record<string, string>;
		env?: Record<string, string>;
	}> {
		if (this.agent.streamFunction === streamSimple) {
			return this._getRequiredRequestAuth(model);
		}

		try {
			const result = await this._modelRuntime.getAuth(model);
			if (!result) return { model };
			const requestModel = result.auth.baseUrl ? { ...model, baseUrl: result.auth.baseUrl } : model;
			return {
				model: requestModel,
				apiKey: result.auth.apiKey,
				headers: withoutDeletedHeaders(result.auth.headers),
				env: result.env,
			};
		} catch {
			return { model };
		}
	}

	/**
	 * Install tool hooks once on the Agent instance.
	 *
	 * The callbacks read `this._extensionRunner` at execution time, so extension reload swaps in the
	 * new runner without reinstalling hooks. Extension-specific tool wrappers are still used to adapt
	 * registered tool execution to the extension context. Tool call and tool result interception now
	 * happens here instead of in wrappers.
	 */
	private _installAgentToolHooks(): void {
		this.agent.beforeToolCall = async ({ toolCall, args }) => {
			const runner = this._extensionRunner;
			if (!runner.hasHandlers("tool_call")) {
				return undefined;
			}

			try {
				return await runner.emitToolCall({
					type: "tool_call",
					toolName: toolCall.name,
					toolCallId: toolCall.id,
					input: args as Record<string, unknown>,
				});
			} catch (err) {
				if (err instanceof Error) {
					throw err;
				}
				throw new Error(`Extension failed, blocking execution: ${String(err)}`);
			}
		};

		this.agent.afterToolCall = async ({ toolCall, args, result, isError }) => {
			const runner = this._extensionRunner;
			const hookResult = runner.hasHandlers("tool_result")
				? await runner.emitToolResult({
						type: "tool_result",
						toolName: toolCall.name,
						toolCallId: toolCall.id,
						input: args as Record<string, unknown>,
						content: result.content,
						details: result.details,
						isError,
						usage: result.usage,
					})
				: undefined;

			const content = hookResult?.content ?? result.content ?? [];
			// Runs after the extension hook so images injected or replaced by extensions are normalized too.
			const normalizedContent = await normalizeToolResultImages(content, {
				autoResizeImages: this.settingsManager.getImageAutoResize(),
			});

			if (!hookResult && normalizedContent === content) {
				return undefined;
			}

			return {
				content: normalizedContent,
				details: hookResult?.details,
				isError: hookResult?.isError ?? isError,
				usage: hookResult?.usage,
			};
		};
	}

	private _installAgentNextTurnRefresh(): void {
		const previousPrepareNextTurnWithContext =
			this.agent.prepareNextTurnWithContext ??
			(this.agent.prepareNextTurn
				? async (_turn: PrepareNextTurnContext, signal?: AbortSignal) => await this.agent.prepareNextTurn?.(signal)
				: undefined);
		this.agent.prepareNextTurnWithContext = async (turn, signal) => {
			const previousSnapshot = await previousPrepareNextTurnWithContext?.(turn, signal);
			const previousContext = previousSnapshot?.context ?? turn.context;

			const hasCustomPrompt = this._resourceLoader.getSystemPrompt() !== undefined;
			const sysPrompt = this._systemPromptOverride ?? (hasCustomPrompt ? this._baseSystemPrompt : "");
			return {
				...previousSnapshot,
				context: {
					...previousContext,
					systemPrompt: sysPrompt,
					tools: this.agent.state.tools.slice(),
				},
				model: this.agent.state.model,
				thinkingLevel: this.agent.state.thinkingLevel,
			};
		};
	}

	// =========================================================================
	// Event Subscription
	// =========================================================================

	/** Emit an event to all listeners */
	private _emit(event: AgentSessionEvent): void {
		for (const l of this._eventListeners) {
			l(event);
		}
	}

	/** Emit a session event to local listeners and mirror it to extensions. */
	private _emitSessionEvent(
		event:
			| { type: "leaf_changed"; newLeafId: string | null; oldLeafId: string | null }
			| { type: "entry_edited"; entryId: string }
			| { type: "preset_activated"; presetId: string },
	): void {
		this._emit(event);
		void this._extensionRunner.emit(event);
	}

	private _emitQueueUpdate(): void {
		this._emit({
			type: "queue_update",
			steering: [...this._steeringMessages],
			followUp: [...this._followUpMessages],
		});
	}

	private _getIdleWaitPromise(): Promise<void> {
		if (!this._idleWaitPromise) {
			this._idleWaitPromise = new Promise((resolve) => {
				this._resolveIdleWait = resolve;
			});
		}
		return this._idleWaitPromise;
	}

	private _resolveIdleWaitIfIdle(): void {
		if (this._isAgentRunActive || !this._resolveIdleWait) {
			return;
		}
		const resolve = this._resolveIdleWait;
		this._idleWaitPromise = undefined;
		this._resolveIdleWait = undefined;
		resolve();
	}

	private async _emitAgentSettled(): Promise<void> {
		this._isAgentRunActive = false;
		try {
			await this._extensionRunner.emit({ type: "agent_settled" });
			this._emit({ type: "agent_settled" });
		} finally {
			this._resolveIdleWaitIfIdle();
		}
	}

	// Track last assistant message for auto-compaction check
	private _lastAssistantMessage: AssistantMessage | undefined = undefined;

	/** Internal handler for agent events - shared by subscribe and reconnect */
	private _handleAgentEvent = async (event: AgentEvent): Promise<void> => {
		// When a user message starts, check if it's from either queue and remove it BEFORE emitting
		// This ensures the UI sees the updated queue state
		if (event.type === "message_start" && event.message.role === "user") {
			this._overflowRecoveryAttempted = false;
			const messageText = contentText(event.message.content, "");
			if (messageText) {
				// Check steering queue first
				const steeringIndex = this._steeringMessages.indexOf(messageText);
				if (steeringIndex !== -1) {
					this._steeringMessages.splice(steeringIndex, 1);
					this._emitQueueUpdate();
				} else {
					// Check follow-up queue
					const followUpIndex = this._followUpMessages.indexOf(messageText);
					if (followUpIndex !== -1) {
						this._followUpMessages.splice(followUpIndex, 1);
						this._emitQueueUpdate();
					}
				}
			}
		}

		// Emit to extensions first
		await this._emitExtensionEvent(event);

		// Notify all listeners
		this._emit(event.type === "agent_end" ? { ...event, willRetry: this._willRetryAfterAgentEnd(event) } : event);

		// Handle session persistence
		if (event.type === "message_end") {
			// Check if this is a custom message from extensions
			if (event.message.role === "custom") {
				// Persist as CustomMessageEntry
				this.sessionManager.appendCustomMessageEntry(
					event.message.customType,
					event.message.content,
					event.message.display,
					event.message.details,
				);
			} else if (
				event.message.role === "user" ||
				event.message.role === "assistant" ||
				event.message.role === "toolResult"
			) {
				// Regular LLM message - persist as SessionMessageEntry
				this.sessionManager.appendMessage(event.message);
			}
			// Other message types (bashExecution, compactionSummary, branchSummary) are persisted elsewhere

			// Track assistant message for auto-compaction (checked on agent_end)
			if (event.message.role === "assistant") {
				this._lastAssistantMessage = event.message;

				const assistantMsg = event.message as AssistantMessage;
				if (assistantMsg.stopReason !== "error" && assistantMsg.stopReason !== "length") {
					this._overflowRecoveryAttempted = false;
				}

				// Reset retry counter immediately on successful assistant response
				// This prevents accumulation across multiple LLM calls within a turn
				if (assistantMsg.stopReason !== "error" && this._retryAttempt > 0) {
					this._emit({
						type: "auto_retry_end",
						success: true,
						attempt: this._retryAttempt,
					});
					this._retryAttempt = 0;
				}
			}
		}
		// Persist state snapshot at turn boundaries: one snapshot per turn (not per
		// state_update call). By turn_end, all messages for this turn are already
		// persisted, so state and transcript stay aligned. Aborted turns never emit
		// turn_end, so state stays at the last completed turn — also consistent.
		if (event.type === "turn_end" && this._stateManager.dirty) {
			this.sessionManager.appendState(this._stateManager.snapshot());
			this._stateManager.clearDirty();
			// Files must not lag the session snapshot: if the process exits
			// inside the debounce window, restart would restore stale file
			// values over the fresher session snapshot.
			this._stateManager.flushStore();
		}
	};

	private _willRetryAfterAgentEnd(event: Extract<AgentEvent, { type: "agent_end" }>): boolean {
		const settings = this.settingsManager.getRetrySettings();
		if (!settings.enabled || this._retryAttempt >= settings.maxRetries) {
			return false;
		}

		for (let i = event.messages.length - 1; i >= 0; i--) {
			const message = event.messages[i];
			if (message.role === "assistant") {
				return this._isRetryableError(message as AssistantMessage);
			}
		}
		return false;
	}

	/** Find the last assistant message in agent state (including aborted ones) */
	private _findLastAssistantMessage(): AssistantMessage | undefined {
		const messages = this.agent.state.messages;
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === "assistant") {
				return msg as AssistantMessage;
			}
		}
		return undefined;
	}

	private _replaceMessageInPlace(target: AgentMessage, replacement: AgentMessage): void {
		// Agent-core stores the finalized message object in its state before emitting message_end.
		// SessionManager persistence happens later in _handleAgentEvent() with event.message.
		// Mutating this object in place keeps agent state, later turn/agent events, listeners,
		// and the eventual SessionManager.appendMessage(event.message) persistence in sync.
		if (target === replacement) {
			return;
		}

		const targetRecord = target as unknown as Record<string, unknown>;
		for (const key of Object.keys(targetRecord)) {
			delete targetRecord[key];
		}
		Object.assign(targetRecord, replacement);
	}

	/** Emit extension events based on agent events */
	private async _emitExtensionEvent(event: AgentEvent): Promise<void> {
		if (event.type === "agent_start") {
			this._turnIndex = 0;
			// agent_start fires before the new trace's prompt messages are pushed,
			// so state.messages.length is the first index of the current trace.
			this._currentTraceStartIndex = this.agent.state.messages.length;
			await this._extensionRunner.emit({ type: "agent_start" });
		} else if (event.type === "agent_end") {
			// contextMessages = the full LLM view of the current branch (custom messages
			// converted per declared policies). Computed only when an extension actually
			// listens, so plain sessions don't pay a branch walk on every turn.
			const extensionEvent: AgentEndEvent = {
				type: "agent_end",
				messages: event.messages,
				...(this._extensionRunner.hasHandlers("agent_end")
					? {
							contextMessages: convertToLlm(
								this.sessionManager.buildContextEntries().flatMap(sessionEntryToContextMessages),
								(customType) => this._extensionRunner.getCustomTypePolicy(customType),
							),
						}
					: {}),
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "turn_start") {
			const extensionEvent: TurnStartEvent = {
				type: "turn_start",
				turnIndex: this._turnIndex,
				timestamp: Date.now(),
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "turn_end") {
			const extensionEvent: TurnEndEvent = {
				type: "turn_end",
				turnIndex: this._turnIndex,
				message: event.message,
				toolResults: event.toolResults,
			};
			await this._extensionRunner.emit(extensionEvent);
			this._turnIndex++;
		} else if (event.type === "message_start") {
			const extensionEvent: MessageStartEvent = {
				type: "message_start",
				message: event.message,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_update") {
			const extensionEvent: MessageUpdateEvent = {
				type: "message_update",
				message: event.message,
				assistantMessageEvent: event.assistantMessageEvent,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_end") {
			const extensionEvent: MessageEndEvent = {
				type: "message_end",
				message: event.message,
			};
			const replacement = await this._extensionRunner.emitMessageEnd(extensionEvent);
			const finalMessage = replacement ?? event.message;
			// Normalize: untyped extension handlers can return messages with null/missing content
			const normalized =
				(finalMessage.role === "user" ||
					finalMessage.role === "assistant" ||
					finalMessage.role === "toolResult" ||
					finalMessage.role === "custom") &&
				finalMessage.content == null
					? ({ ...finalMessage, content: [] } as AgentMessage)
					: finalMessage;
			// Apply finalize regex from active preset
			if (this._activePreset !== defaultPreset && this._activePreset.id !== "pi-default") {
				const finalizeDiags: PromptPresetDiagnostic[] = [];
				const finalizeResult = applyFinalizeRegexRulesToMessage(this._activePreset, normalized, finalizeDiags);
				if (finalizeResult) {
					this._replaceMessageInPlace(event.message, finalizeResult);
				} else {
					this._replaceMessageInPlace(event.message, normalized);
				}
			} else {
				this._replaceMessageInPlace(event.message, normalized);
			}
		} else if (event.type === "tool_execution_start") {
			const extensionEvent: ToolExecutionStartEvent = {
				type: "tool_execution_start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_update") {
			const extensionEvent: ToolExecutionUpdateEvent = {
				type: "tool_execution_update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				partialResult: event.partialResult,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_end") {
			const extensionEvent: ToolExecutionEndEvent = {
				type: "tool_execution_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: event.result,
				isError: event.isError,
			};
			await this._extensionRunner.emit(extensionEvent);
		}
	}

	/**
	 * Subscribe to agent events.
	 * Session persistence is handled internally (saves messages on message_end).
	 * Multiple listeners can be added. Returns unsubscribe function for this listener.
	 */
	subscribe(listener: AgentSessionEventListener): () => void {
		this._eventListeners.push(listener);

		// Return unsubscribe function for this specific listener
		return () => {
			const index = this._eventListeners.indexOf(listener);
			if (index !== -1) {
				this._eventListeners.splice(index, 1);
			}
		};
	}

	/** Disconnect from agent events during disposal. */
	private _disconnectFromAgent(): void {
		if (this._unsubscribeAgent) {
			this._unsubscribeAgent();
			this._unsubscribeAgent = undefined;
		}
	}

	/**
	 * Remove all listeners and disconnect from agent.
	 * Call this when completely done with the session.
	 */
	dispose(): void {
		try {
			this.abortRetry();
			this.abortCompaction();
			this.abortBranchSummary();
			this.abortBash();
			this.agent.abort();
		} catch {
			// Dispose must succeed even if an abort hook throws.
		}

		this._extensionRunner.invalidate(
			"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
		);
		this._disconnectFromAgent();
		this._eventListeners = [];
		cleanupSessionResources(this.sessionId);
	}

	// =========================================================================
	// Read-only State Access
	// =========================================================================

	/** Full agent state */
	get state(): AgentState {
		return this.agent.state;
	}

	/** Current model (may be undefined if not yet selected) */
	get model(): Model<any> | undefined {
		return this.agent.state.model;
	}

	/** Current thinking level */
	get thinkingLevel(): ThinkingLevel {
		return this.agent.state.thinkingLevel;
	}

	/** Whether the session is currently processing an agent run or post-run continuation. */
	get isStreaming(): boolean {
		return this._isAgentRunActive;
	}

	/** Whether the session has no active agent run, retry, auto-compaction, or queued continuation. */
	get isIdle(): boolean {
		return !this._isAgentRunActive;
	}

	/** Current effective system prompt (includes any per-turn extension modifications) */
	get systemPrompt(): string {
		return this.agent.state.systemPrompt;
	}

	/** Current retry attempt (0 if not retrying) */
	get retryAttempt(): number {
		return this._retryAttempt;
	}

	/**
	 * Get the names of currently active tools.
	 * Returns the names of tools currently set on the agent.
	 */
	getActiveToolNames(): string[] {
		return this.agent.state.tools.map((t) => t.name);
	}

	/**
	 * Messages captured from the last agent run, for /prompt inspection.
	 * Includes preset items, extension custom messages, and the user message.
	 */
	get lastCompiledMessages(): readonly AgentMessage[] {
		return this._lastCompiledMessages;
	}

	get lastCompiledSystemPrompt(): string {
		return this._lastCompiledSystemPrompt;
	}
	/**
	 * Get all configured tools with name, description, parameter schema, prompt guidelines, and source metadata.
	 */

	getAllTools(): ToolInfo[] {
		return Array.from(this._toolDefinitions.values()).map(({ definition, sourceInfo }) => ({
			name: definition.name,
			description: definition.description,
			parameters: definition.parameters,
			promptGuidelines: definition.promptGuidelines,
			sourceInfo,
		}));
	}

	getToolDefinition(name: string): ToolDefinition | undefined {
		return this._toolDefinitions.get(name)?.definition;
	}

	/**
	 * Set active tools by name.
	 * Only tools in the registry can be enabled. Unknown tool names are ignored.
	 * Also rebuilds the system prompt to reflect the new tool set.
	 * Changes take effect on the next agent turn.
	 */
	setActiveToolsByName(toolNames: string[]): void {
		const tools: AgentTool[] = [];
		const validToolNames: string[] = [];
		for (const name of toolNames) {
			const tool = this._toolRegistry.get(name);
			if (tool) {
				tools.push(tool);
				validToolNames.push(name);
			}
		}
		this.agent.state.tools = tools;

		// Rebuild base system prompt with new tool set
		this._baseSystemPrompt = this._rebuildSystemPrompt(validToolNames);
		this._applyDynamicSystemPrompt();
	}

	/** Whether compaction or branch summarization is currently running */
	get isCompacting(): boolean {
		return (
			this._autoCompactionAbortController !== undefined ||
			this._compactionAbortController !== undefined ||
			this._branchSummaryAbortController !== undefined
		);
	}

	/** All messages including custom types like BashExecutionMessage */
	get messages(): AgentMessage[] {
		return this.agent.state.messages;
	}

	/** Current steering mode */
	get steeringMode(): "all" | "one-at-a-time" {
		return this.agent.steeringMode;
	}

	/** Current follow-up mode */
	get followUpMode(): "all" | "one-at-a-time" {
		return this.agent.followUpMode;
	}

	/** Current session file path, or undefined if sessions are disabled */
	get sessionFile(): string | undefined {
		return this.sessionManager.getSessionFile();
	}

	/** Current session ID */
	get sessionId(): string {
		return this.sessionManager.getSessionId();
	}

	/** Current session display name, if set */
	get sessionName(): string | undefined {
		return this.sessionManager.getSessionName();
	}

	/** Scoped models for cycling (from --models flag) */
	get scopedModels(): ReadonlyArray<{ model: Model<any>; thinkingLevel?: ThinkingLevel }> {
		return this._scopedModels;
	}

	/** Update scoped models for cycling */
	setScopedModels(scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>): void {
		this._scopedModels = scopedModels;
	}

	/** File-based prompt templates */
	get promptTemplates(): ReadonlyArray<PromptTemplate> {
		return this._resourceLoader.getPrompts().prompts;
	}

	private _normalizePromptSnippet(text: string | undefined): string | undefined {
		if (!text) return undefined;
		const oneLine = text
			.replace(/[\r\n]+/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		return oneLine.length > 0 ? oneLine : undefined;
	}

	private _normalizePromptGuidelines(guidelines: string[] | undefined): string[] {
		if (!guidelines || guidelines.length === 0) {
			return [];
		}

		const unique = new Set<string>();
		for (const guideline of guidelines) {
			const normalized = guideline.trim();
			if (normalized.length > 0) {
				unique.add(normalized);
			}
		}
		return Array.from(unique);
	}
	/**
	 * Restore StateManager state + SchemaValidator schemas/strict mode from the
	 * session's active leaf path. Walks entries backward from the current leaf,
	 * applying the latest state snapshot, the latest schema_change per namespace,
	 * and the latest strict_change entry.
	 * Shared by first-time session load (_rebuildSystemPrompt) and navigateTree
	 * (rollback), which must also rewind state to the target branch.
	 */
	private _restoreStateFromSessionEntries(): void {
		// Leaf-path entry list: tree traversal from current leaf to root,
		// compaction-aware (state entries included). SessionManager.buildContextEntries()
		// passes this.byId internally, so this is exactly the active branch.
		const entries = this.sessionManager.buildContextEntries();

		// Restore state from session entries: latest state entry on the active path
		for (let i = entries.length - 1; i >= 0; i--) {
			const e = entries[i];
			if (e.type === "state") {
				this._stateManager.load(e.state);
				break;
			}
		}

		this._restoreSchemasFromEntries(entries);
	}

	/**
	 * Mount the cross-process shared state store (settings opt-in). Files
	 * override the session-restored namespace values: the shared file is the
	 * authoritative mirror across processes. Called on first load (after
	 * _restoreStateFromSessionEntries) and after reload re-builds the runtime.
	 */
	private _initStateStore(): void {
		if (!this._attachStateStore) return;
		const cfg = this.settingsManager.getStateStoreConfig();
		if (!cfg.enabled) return;
		let dir = getProjectConfigDir(this._cwd, "state");
		if (cfg.storeDir !== undefined) {
			dir = resolve(this._cwd, cfg.storeDir);
		} else {
			console.warn(`[state-store] storeDir 未解析（检查 settings.state.storeDir 的 \${VAR}），回退项目配置目录`);
		}
		const store = new StateStore(dir);
		store.cleanTmp();
		const gate = (ns: string) => this._schemaValidator.hasSchema(ns);
		this._stateManager.attachStore(store, {
			canLoadNamespace: gate,
			// Files are authoritative but often partial: restore schema-default
			// keys absent from the file so required-key validation still passes.
			fillDefaults: (ns) => this.applySchemaDefaults(ns),
		});
		for (const ns of store.listNamespaces()) {
			if (!gate(ns)) continue; // gate: don't load secret/other-actor namespaces
			const snap = store.readNamespace(ns);
			if (snap.state !== undefined) this._stateManager.loadNamespace(ns, snap.state);
		}
	}

	/**
	 * Re-apply loaded schemas and strict mode from session entries.
	 * Clears all currently loaded schemas first, then replays the latest
	 * schema_change per namespace and the latest strict_change entry.
	 * Called on reload (after _loadedSchemaDefs is refreshed) and by
	 * _restoreStateFromSessionEntries (first load / tree rollback).
	 */
	private _restoreSchemasFromEntries(entries: SessionEntry[]): void {
		// Clear stale schemas so reload picks up file changes
		this._schemaValidator.clearSchemas();

		// Restore schemas: latest action per namespace, backward from leaf
		const schemaActions: Array<{ action: "load" | "unload"; schemaId: string; namespace: string }> = [];
		for (let i = entries.length - 1; i >= 0; i--) {
			const e = entries[i];
			if (e.type === "schema_change") {
				if (!schemaActions.some((a) => a.namespace === e.namespace)) {
					schemaActions.push({ action: e.action, schemaId: e.schemaId, namespace: e.namespace });
				}
			}
		}
		for (const a of schemaActions) {
			if (a.action === "load") {
				const def = this._loadedSchemaDefs.find((s) => s.schemaId === a.schemaId);
				if (def) {
					this._schemaValidator.loadSchema(def.schemaId, def.namespace, def.schema);
					this.applySchemaDefaults(def.namespace);
				}
			}
		}

		// Restore strict mode: latest strict_change entry on the active path
		for (let i = entries.length - 1; i >= 0; i--) {
			const e = entries[i];
			if (e.type === "strict_change") {
				this._schemaValidator.setStrict(e.enabled);
				break;
			}
		}
	}

	private _rebuildSystemPrompt(toolNames: string[]): string {
		if (this._loadedPresets.length === 0) {
			this._loadedPresets = loadPromptPresets(this._cwd, getAgentDir());

			// Restore active preset: existing preset_change entry → settings default → built-in default
			const entries = this.sessionManager.getEntries();
			let storedPresetId: string | undefined;
			for (let i = entries.length - 1; i >= 0; i--) {
				const e = entries[i];
				if (e.type === "preset_change") {
					storedPresetId = e.presetId;
					break;
				}
			}

			const settingsPresetId = this.settingsManager.getDefaultPreset();
			if (!this._presetExplicitlyActivated) {
				const restoreId = storedPresetId ?? settingsPresetId;
				if (restoreId && !isDisabledPromptPresetId(restoreId) && restoreId !== "default") {
					const found = this._loadedPresets.find((p) => p.preset.id === restoreId);
					if (found) this._activePreset = found.preset;
				} else if (!restoreId) {
					// No recorded restore target (fresh session, no settings default):
					// fall back to the first auto-activatable preset on disk.
					const chosen = chooseDefaultPreset(this._loadedPresets);
					if (chosen) this._activePreset = chosen.preset;
				}
			}

			// No initial write needed — sdk.ts handles that for new sessions

			// Restore StateManager state + SchemaValidator schemas from the
			// session's active leaf path (shared with navigateTree rollback)
			this._restoreStateFromSessionEntries();

			// Mount cross-process state store; files override session values
			this._initStateStore();
		}

		const validToolNames = toolNames.filter((name) => this._toolRegistry.has(name));
		const toolSnippets: Record<string, string> = {};
		const promptGuidelines: string[] = [];
		for (const name of validToolNames) {
			const snippet = this._toolPromptSnippets.get(name);
			if (snippet) toolSnippets[name] = snippet;
			const toolGuidelines = this._toolPromptGuidelines.get(name);
			if (toolGuidelines) promptGuidelines.push(...toolGuidelines);
		}

		const loaderSystemPrompt = this._resourceLoader.getSystemPrompt();
		const loaderAppendSystemPrompt = this._resourceLoader.getAppendSystemPrompt();
		const appendSystemPrompt =
			loaderAppendSystemPrompt.length > 0 ? loaderAppendSystemPrompt.join("\n\n") : undefined;
		const loadedSkills = this._resourceLoader.getSkills().skills;
		const loadedContextFiles = this._resourceLoader.getAgentsFiles().agentsFiles;

		this._baseSystemPromptOptions = {
			cwd: this._cwd,
			skills: loadedSkills,
			contextFiles: loadedContextFiles,
			customPrompt: loaderSystemPrompt,
			appendSystemPrompt,
			selectedTools: validToolNames,
			toolSnippets,
			promptGuidelines,
		};

		if (loaderSystemPrompt) {
			return buildSystemPrompt(this._baseSystemPromptOptions);
		}

		// Compile system prompt with static macros frozen, dynamic macros as {{...}} placeholders
		const staticRuntime: PromptRuntime = {
			options: this._baseSystemPromptOptions,
			messages: [],
			latestUserMessage: undefined,
			now: new Date(),
			variables: {},
			skills: loadedSkills,
			model: this.model,
			thinkingLevel: this.thinkingLevel,
		};
		const systemResult = compileSystemPrompt(this._activePreset, staticRuntime, "");
		return expandMacros(systemResult.systemPrompt, staticRuntime, { mode: "static" });
	}

	// =========================================================================
	// Prompt Preset Management
	// =========================================================================

	// Prompt Preset Management
	// =========================================================================

	/** Get the currently active prompt preset. */
	get activePreset(): PromptPreset {
		return this._activePreset;
	}

	/** Get all loaded presets from disk. */
	getAllPresets(): LoadedPromptPreset[] {
		return this._loadedPresets;
	}

	/** Load presets from disk and re-resolve active preset. */
	reloadPresets(preferredId?: string): void {
		const preferred = preferredId && !isDisabledPromptPresetId(preferredId) ? preferredId : undefined;
		this._loadedPresets = loadPromptPresets(this._cwd, getAgentDir());

		// Re-resolve active preset against the newly loaded list
		const activeId = this._activePreset.id;
		const match = preferred
			? this._loadedPresets.find((p) => p.preset.id === preferred)
			: this._loadedPresets.find((p) => p.preset.id === activeId);

		if (match) {
			this._activePreset = match.preset;
			this._syncActiveToolPolicy();
		} else {
			this._toolPolicyBaseline = undefined;
		}
	}

	/** Schema definitions loaded from disk (for /schema list). */
	getLoadedSchemaDefs(): LoadedSchemaDef[] {
		return this._loadedSchemaDefs;
	}

	/** Custom validators loaded from disk (for /validator list). */
	getLoadedCustomValidators(): CustomValidator[] {
		return this._loadedCustomValidators;
	}
	/** Merge a loaded schema's default values into state (existing values win) and return them. */
	private applySchemaDefaults(namespace: string): JsonValue | undefined {
		const defaults = this._schemaValidator.getDefaultValue(namespace);
		if (defaults !== undefined) {
			this._stateManager.applyDefaults({ [namespace]: defaults });
		}
		return defaults;
	}

	/** Load a schema by ID and record it as a session entry. Pass `record: false` to apply in-memory only (e.g. resume dedup). */
	loadSchema(schemaId: string, options?: { record?: boolean }): { ok: boolean; namespace?: string; error?: string } {
		const def = this._loadedSchemaDefs.find((s) => s.schemaId === schemaId);
		if (!def) return { ok: false, error: `Schema "${schemaId}" not found` };
		this._schemaValidator.loadSchema(def.schemaId, def.namespace, def.schema);
		this.applySchemaDefaults(def.namespace);
		// The shared store attaches before the CLI applies --schema (prompt
		// rebuild in the constructor), so the initial file load was gated out.
		// Once a schema lands, pull any store file for this namespace that is
		// newer than what we have seen.
		this._stateManager.reloadNamespaceFromStore(def.namespace);
		if (options?.record !== false) this.sessionManager.appendSchemaChange("load", def.schemaId, def.namespace);
		return { ok: true, namespace: def.namespace };
	}

	/** Unload a schema by namespace and record it as a session entry. */
	unloadSchema(namespace: string): void {
		this._schemaValidator.unloadSchema(namespace);
		this.sessionManager.appendSchemaChange("unload", namespace, namespace);
	}

	/** Toggle strict mode and record it as a session entry. Pass `record: false` to apply in-memory only (e.g. resume dedup). */
	setStrictMode(enabled: boolean, options?: { record?: boolean }): void {
		this._schemaValidator.setStrict(enabled);
		if (options?.record !== false) this.sessionManager.appendStrictChange(enabled);
	}
	/**
	 * Set the active prompt preset by ID. Persists to session.
	 * If the preset declares a model, switches to it (failures are reported
	 * via the result's `error` without failing the preset switch).
	 */
	async setActivePreset(
		id: string,
		options?: { persistSettings?: boolean; record?: boolean },
	): Promise<SetActivePresetResult> {
		const emitPresetActivated = (): void => {
			this._emitSessionEvent({ type: "preset_activated", presetId: id });
		};

		if (isDisabledPromptPresetId(id)) {
			this._activePreset = defaultPreset;
			this._presetExplicitlyActivated = true;
			this._restoreToolPolicy();
			if (options?.record !== false) this.sessionManager.appendPresetChange(id);
			if (options?.persistSettings !== false) this.settingsManager.setDefaultPreset(id);
			// _restoreToolPolicy calls setActiveToolsByName which rebuilds the prompt
			emitPresetActivated();
			return { ok: true };
		}
		const found = this._loadedPresets.find((p) => p.preset.id === id);
		if (!found) return { ok: false };
		this._activePreset = found.preset;
		this._presetExplicitlyActivated = true;
		this._syncActiveToolPolicy();
		if (options?.record !== false) this.sessionManager.appendPresetChange(id);
		// Apply preset thinking level (fail-soft)
		const presetThinkingLevel = found.preset.thinkingLevel;
		if (presetThinkingLevel) {
			try {
				const level = presetThinkingLevel as ThinkingLevel;
				if (THINKING_LEVELS.includes(level)) {
					this.setThinkingLevel(level);
				}
			} catch {
				// fail-soft: ignore invalid thinking level
			}
		}
		// _syncActiveToolPolicy calls setActiveToolsByName which rebuilds the prompt

		const modelRef = found.preset.model;
		if (!modelRef) {
			emitPresetActivated();
			return { ok: true };
		}

		const available = [...this._modelRuntime.getModels()];
		const model = findExactModelReferenceMatch(modelRef, available);
		if (!model) {
			emitPresetActivated();
			return { ok: true, error: `Preset model "${modelRef}" not found among available models.` };
		}

		if (this.model && modelsAreEqual(this.model, model)) {
			emitPresetActivated();
			return { ok: true, model };
		}

		try {
			await this.setModel(model);
			emitPresetActivated();
			return { ok: true, model };
		} catch (error) {
			emitPresetActivated();
			return {
				ok: true,
				error: `Failed to switch to preset model "${modelRef}": ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}

	private _syncActiveToolPolicy(): void {
		const policy = this._activePreset.tools;
		if (!hasResourcePolicy(policy)) {
			this._restoreToolPolicy();
			return;
		}
		// Use the full tool registry as the filter source so that tools
		// registered after the preset was activated (e.g. via pi.setActiveTools
		// from pi-mcp-adapter) are also subject to the preset's policy.
		this._toolPolicyBaseline ??= this.getActiveToolNames();
		const filtered = applyResourcePolicy([...this._toolRegistry.keys()], policy);
		this.setActiveToolsByName(filtered);
	}
	private _restoreToolPolicy(): void {
		if (this._toolPolicyBaseline) {
			this.setActiveToolsByName(this._toolPolicyBaseline);
			this._toolPolicyBaseline = undefined;
		}
	}
	/**
	 * Run the real prompt-building pipeline (preset injection + extensions) without sending to LLM.
	 * Captures result in lastTransformedMessages for /prompt inspection.
	 */
	async previewPrompt(): Promise<AgentMessage[]> {
		const presetItems = this.getPresetInjectMessages();
		let result: AgentMessage[] = presetItems.length > 0 ? presetItems : [...this.agent.state.messages];
		result = await this._extensionRunner.emitContext(result);

		return result;
	}

	/**
	 * Set agent.state.systemPrompt.
	 * - When a custom prompt exists (loaderSystemPrompt): use _baseSystemPrompt (legacy path).
	 * - Otherwise: use "" (system content comes from preset-compiled messages array).
	 */
	private _applyDynamicSystemPrompt(): void {
		const hasCustomPrompt = this._resourceLoader.getSystemPrompt() !== undefined;
		if (this._systemPromptOverride !== undefined) {
			this.agent.state.systemPrompt = this._systemPromptOverride;
		} else if (hasCustomPrompt) {
			this.agent.state.systemPrompt = this._baseSystemPrompt;
		} else {
			this.agent.state.systemPrompt = "";
		}
	}
	/**
	 * Variables for a preset compile: the active preset's static `variables`
	 * first, then session facts (`user`) which win on key collision. Single
	 * source for every compile site so `/prompt` display cannot diverge from
	 * what is actually sent.
	 */
	private _buildRuntimeVariables(): Record<string, string> {
		return { ...this._activePreset.variables, user: this.settingsManager.getUserName() };
	}
	/**
	 * Get compiled preset messages for injection into the LLM context.
	 * Uses compileMessages() which correctly handles chat-history slot positioning.
	 * Returns [] when a custom prompt exists (system is in systemPrompt field).
	 */
	getPresetInjectMessages(): AgentMessage[] {
		const hasCustomPrompt = this._resourceLoader.getSystemPrompt() !== undefined;
		if (hasCustomPrompt) return [];
		const loadedSkills = this._resourceLoader.getSkills().skills;
		const runtime: PromptRuntime = {
			options: this._baseSystemPromptOptions,
			messages: this.agent.state.messages,
			currentTraceStartIndex: this._currentTraceStartIndex,
			latestUserMessage: undefined,
			now: new Date(),
			variables: this._buildRuntimeVariables(),
			skills: loadedSkills,
			state: this._stateManager.snapshot(),
			model: this.model,
			thinkingLevel: this.thinkingLevel,
		};
		return compileMessages(this._activePreset, runtime).messages;
	}
	/**
	 * Re-compile the system prompt from the active preset (for /prompt display).
	 */
	compileSystemPrompt(): string {
		const loadedSkills = this._resourceLoader.getSkills().skills;
		const runtime: PromptRuntime = {
			options: this._baseSystemPromptOptions,
			messages: this.agent.state.messages,
			latestUserMessage: undefined,
			now: new Date(),
			variables: this._buildRuntimeVariables(),
			skills: loadedSkills,
			state: this._stateManager.snapshot(),
			model: this.model,
			thinkingLevel: this.thinkingLevel,
		};
		const result = compileSystemPrompt(this._activePreset, runtime, "");
		return result.systemPrompt;
	}

	private async _handlePostAgentRun(): Promise<boolean> {
		const msg = this._lastAssistantMessage;
		this._lastAssistantMessage = undefined;
		if (!msg) {
			return false;
		}

		if (this._isRetryableError(msg) && (await this._prepareRetry(msg))) {
			return true;
		}

		if (msg.stopReason === "error" && this._retryAttempt > 0) {
			this._emit({
				type: "auto_retry_end",
				success: false,
				attempt: this._retryAttempt,
				finalError: msg.errorMessage,
			});
			this._retryAttempt = 0;
		}

		if (await this._checkCompaction(msg)) {
			return true;
		}

		const queued = this.agent.hasQueuedMessages();
		return queued;
	}

	private async _runAgentPrompt(messages: AgentMessage | AgentMessage[]): Promise<void> {
		this._isAgentRunActive = true;
		try {
			await this.agent.prompt(messages);
			while (await this._handlePostAgentRun()) {
				await this.agent.continue();
			}
		} finally {
			this._systemPromptOverride = undefined;
			this._flushPendingBashMessages();
			await this._emitAgentSettled();
		}
	}

	/**
	 * Send a prompt to the agent.
	 * - Handles extension commands (registered via pi.registerCommand) immediately, even during streaming
	 * - Expands file-based prompt templates by default
	 * - During streaming, queues via steer() or followUp() based on streamingBehavior option
	 * - Validates model and API key before sending (when not streaming)
	 * @throws Error if streaming and no streamingBehavior specified
	 * @throws Error if no model selected or no API key available (when not streaming)
	 */
	async prompt(text: string, options?: PromptOptions): Promise<void> {
		const expandPromptTemplates = options?.expandPromptTemplates ?? true;
		const preflightResult = options?.preflightResult;
		let messages: AgentMessage[] | undefined;

		try {
			// Handle extension commands first (execute immediately, even during streaming)
			// Extension commands manage their own LLM interaction via pi.sendMessage()
			if (expandPromptTemplates && text.startsWith("/")) {
				const handled = await this._tryExecuteExtensionCommand(text);
				if (handled) {
					// Extension command executed, no prompt to send
					preflightResult?.(true);
					return;
				}
			}

			if (this._compactionAbortController !== undefined) {
				throw new Error(
					"Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.",
				);
			}

			// Emit input event for extension interception (before skill/template expansion)
			let currentText = text;
			let currentImages = options?.images;
			if (this._extensionRunner.hasHandlers("input")) {
				const inputResult = await this._extensionRunner.emitInput(
					currentText,
					currentImages,
					options?.source ?? "interactive",
					this.isStreaming ? options?.streamingBehavior : undefined,
				);
				if (inputResult.action === "handled") {
					preflightResult?.(true);
					return;
				}
				if (inputResult.action === "transform") {
					currentText = inputResult.text;
					currentImages = inputResult.images ?? currentImages;
				}
			}

			// Expand skill commands (/skill:name args) and prompt templates (/template args)
			let expandedText = currentText;
			if (expandPromptTemplates) {
				expandedText = this._expandSkillCommand(expandedText);
				expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);
			}

			// If streaming, queue via steer() or followUp() based on option
			if (this.isStreaming) {
				if (!options?.streamingBehavior) {
					throw new Error(
						"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
					);
				}
				if (options.streamingBehavior === "followUp") {
					await this._queueFollowUp(expandedText, currentImages);
				} else {
					await this._queueSteer(expandedText, currentImages);
				}
				preflightResult?.(true);
				return;
			}

			// Flush any pending bash messages before the new prompt
			this._flushPendingBashMessages();

			// Validate model
			if (!this.model) {
				throw new Error(formatNoModelSelectedMessage());
			}

			const hasConfiguredAuth =
				this._modelRuntime.hasConfiguredAuth(this.model.provider) ||
				(await this._modelRuntime.checkAuth(this.model.provider)) !== undefined;
			if (!hasConfiguredAuth) {
				const isOAuth = this._modelRuntime.isUsingOAuth(this.model.provider);
				if (isOAuth) {
					throw new Error(
						`Authentication failed for "${this.model.provider}". ` +
							`Credentials may have expired or network is unavailable. ` +
							`Run '/login ${this.model.provider}' to re-authenticate.`,
					);
				}
				throw new Error(formatNoApiKeyFoundMessage(this.model.provider));
			}

			// Check if we need to compact before sending (catches aborted responses).
			// The user's new prompt is sent below, so do not call agent.continue() here.
			const lastAssistant = this._findLastAssistantMessage();
			if (lastAssistant) {
				await this._checkCompaction(lastAssistant, false);
			}

			// Build messages array (custom message if any, then user message)
			messages = [];

			// Add user message
			const userContent: (TextContent | ImageContent)[] = [{ type: "text", text: expandedText }];
			if (currentImages) {
				userContent.push(...currentImages);
			}
			messages.push({
				role: "user",
				content: userContent,
				timestamp: Date.now(),
			});

			// Inject any pending "nextTurn" messages as context alongside the user message
			for (const msg of this._pendingNextTurnMessages) {
				messages.push(msg);
			}
			this._pendingNextTurnMessages = [];

			// Emit before_agent_start extension event
			const result = await this._extensionRunner.emitBeforeAgentStart(
				expandedText,
				currentImages,
				this._baseSystemPrompt,
				this._baseSystemPromptOptions,
			);
			// Add all custom messages from extensions
			if (result?.messages) {
				for (const msg of result.messages) {
					messages.push({
						role: "custom",
						customType: msg.customType,
						// Untyped extensions can pass null/missing content; normalize at ingestion.
						content: msg.content ?? [],
						display: msg.display,
						details: msg.details,
						timestamp: Date.now(),
					});
				}
			}
			// Apply extension-modified system prompt, or reset to base
			if (result?.systemPrompt !== undefined) {
				this._systemPromptOverride = result.systemPrompt;
				this.agent.state.systemPrompt = result.systemPrompt;
			} else {
				// Ensure we're using the base prompt (in case previous turn had modifications)
				this._systemPromptOverride = undefined;
				this._applyDynamicSystemPrompt();
			}
		} catch (error) {
			preflightResult?.(false);
			throw error;
		}

		if (!messages) {
			return;
		}
		preflightResult?.(true);

		await this._runAgentPrompt(messages);

		// Capture the actual messages sent to the LLM (post context event / preset injection)
		this._lastCompiledMessages = [...(this._extensionRunner.lastContextMessages ?? [])];
		// /prompt shows the legacy system-prompt string only when that path is in
		// use. In the preset path agent.state.systemPrompt is "" by design
		// (_applyDynamicSystemPrompt) and the preset-compiled message array —
		// including preamble and chat-history, which are non-system roles — is
		// rendered in full by previewPrompt(). Deriving a system-only string here
		// would double-render the preset and hide preamble/chat-history.
		this._lastCompiledSystemPrompt = this.agent.state.systemPrompt;
	}

	/**
	 * Try to execute an extension command. Returns true if command was found and executed.
	 */
	private async _tryExecuteExtensionCommand(text: string): Promise<boolean> {
		// Parse command name and args
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

		const command = this._extensionRunner.getCommand(commandName);
		if (!command) return false;

		// Get command context from extension runner (includes session control methods)
		const ctx = this._extensionRunner.createCommandContext();

		try {
			await command.handler(args, ctx);
			return true;
		} catch (err) {
			// Emit error via extension runner
			this._extensionRunner.emitError({
				extensionPath: `command:${commandName}`,
				event: "command",
				error: err instanceof Error ? err.message : String(err),
			});
			return true;
		}
	}

	/**
	 * Expand skill commands (/skill:name args) to their full content.
	 * Returns the expanded text, or the original text if not a skill command or skill not found.
	 * Emits errors via extension runner if file read fails.
	 */
	private _expandSkillCommand(text: string): string {
		if (!text.startsWith("/skill:")) return text;

		const spaceIndex = text.indexOf(" ");
		const skillName = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();

		const skill = this.resourceLoader.getSkills().skills.find((s) => s.name === skillName);
		if (!skill) return text; // Unknown skill, pass through

		try {
			const content = readFileSync(skill.filePath, "utf-8");
			const body = stripFrontmatter(content).trim();
			const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
			return args ? `${skillBlock}\n\n${args}` : skillBlock;
		} catch (err) {
			// Emit error like extension commands do
			this._extensionRunner.emitError({
				extensionPath: skill.filePath,
				event: "skill_expansion",
				error: err instanceof Error ? err.message : String(err),
			});
			return text; // Return original on error
		}
	}

	/**
	 * Queue a steering message while the agent is running.
	 * Delivered after the current assistant turn finishes executing its tool calls,
	 * before the next LLM call.
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @throws Error if text is an extension command
	 */
	async steer(text: string, images?: ImageContent[]): Promise<void> {
		// Check for extension commands (cannot be queued)
		if (text.startsWith("/")) {
			this._throwIfExtensionCommand(text);
		}

		// Expand skill commands and prompt templates
		let expandedText = this._expandSkillCommand(text);
		expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);

		await this._queueSteer(expandedText, images);
	}

	/**
	 * Queue a follow-up message to be processed after the agent finishes.
	 * Delivered only when agent has no more tool calls or steering messages.
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @throws Error if text is an extension command
	 */
	async followUp(text: string, images?: ImageContent[]): Promise<void> {
		// Check for extension commands (cannot be queued)
		if (text.startsWith("/")) {
			this._throwIfExtensionCommand(text);
		}

		// Expand skill commands and prompt templates
		let expandedText = this._expandSkillCommand(text);
		expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);

		await this._queueFollowUp(expandedText, images);
	}

	/**
	 * Internal: Queue a steering message (already expanded, no extension command check).
	 */
	private async _queueSteer(text: string, images?: ImageContent[]): Promise<void> {
		this._steeringMessages.push(text);
		this._emitQueueUpdate();
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images) {
			content.push(...images);
		}
		this.agent.steer({
			role: "user",
			content,
			timestamp: Date.now(),
		});
	}

	/**
	 * Internal: Queue a follow-up message (already expanded, no extension command check).
	 */
	private async _queueFollowUp(text: string, images?: ImageContent[]): Promise<void> {
		this._followUpMessages.push(text);
		this._emitQueueUpdate();
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images) {
			content.push(...images);
		}
		this.agent.followUp({
			role: "user",
			content,
			timestamp: Date.now(),
		});
	}

	/**
	 * Throw an error if the text is an extension command.
	 */
	private _throwIfExtensionCommand(text: string): void {
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const command = this._extensionRunner.getCommand(commandName);

		if (command) {
			throw new Error(
				`Extension command "/${commandName}" cannot be queued. Use prompt() or execute the command when not streaming.`,
			);
		}
	}

	/**
	 * Send a custom message to the session. Creates a CustomMessageEntry.
	 *
	 * Handles three cases:
	 * - Streaming: queues message, processed when loop pulls from queue
	 * - Not streaming + triggerTurn: appends to state/session, starts new turn
	 * - Not streaming + no trigger: appends to state/session, no turn
	 *
	 * @param message Custom message with customType, content, display, details
	 * @param options.triggerTurn If true and not streaming, triggers a new LLM turn
	 * @param options.deliverAs Delivery mode: "steer", "followUp", or "nextTurn"
	 */
	async sendCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): Promise<void> {
		const appMessage = {
			role: "custom" as const,
			customType: message.customType,
			// Untyped extensions can pass null/missing content; normalize at ingestion.
			content: message.content ?? [],
			display: message.display,
			details: message.details,
			timestamp: Date.now(),
		} satisfies CustomMessage<T>;
		if (options?.deliverAs === "nextTurn") {
			this._pendingNextTurnMessages.push(appMessage);
		} else if (this.isStreaming && options?.triggerTurn !== false) {
			if (options?.deliverAs === "followUp") {
				this.agent.followUp(appMessage);
			} else {
				this.agent.steer(appMessage);
			}
		} else if (options?.triggerTurn) {
			await this._runAgentPrompt(appMessage);
		} else {
			this.agent.state.messages.push(appMessage);
			this.sessionManager.appendCustomMessageEntry(
				message.customType,
				message.content,
				message.display,
				message.details,
			);
			this._emit({ type: "message_start", message: appMessage });
			this._emit({ type: "message_end", message: appMessage });
		}
	}

	/**
	 * Start a live (streamable) custom message. Pushes the message and emits
	 * message_start; the returned handle streams message_update on update() and
	 * persists + emits message_end on end(). Does not trigger an agent turn.
	 */
	startLiveMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
	): LiveMessageHandle<T> {
		const appMessage: CustomMessage<T> = {
			role: "custom",
			customType: message.customType,
			content: message.content ?? [],
			display: message.display,
			details: message.details,
			timestamp: Date.now(),
		};
		this.agent.state.messages.push(appMessage);
		this._emit({ type: "message_start", message: appMessage });

		let ended = false;
		return {
			update: (content: string | (TextContent | ImageContent)[], details?: T) => {
				if (ended) return;
				appMessage.content = content;
				if (details !== undefined) appMessage.details = details;
				this._emit({ type: "custom_message_update", message: appMessage });
			},
			end: async (entryId?: string) => {
				if (ended) return;
				ended = true;
				this.sessionManager.appendCustomMessageEntry(
					appMessage.customType,
					appMessage.content,
					appMessage.display,
					appMessage.details,
					entryId,
				);
				this._emit({ type: "message_end", message: appMessage });
			},
		};
	}

	/**
	 * Send a user message to the agent. Always triggers a turn.
	 * When the agent is streaming, use deliverAs to specify how to queue the message.
	 *
	 * @param content User message content (string or content array)
	 * @param options.deliverAs Delivery mode when streaming: "steer" or "followUp"
	 * @param options.expandPromptTemplates Whether to dispatch extension commands and expand skill commands and prompt templates. Default: false.
	 */
	async sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean },
	): Promise<void> {
		// Normalize content to text string + optional images
		let text: string;
		let images: ImageContent[] | undefined;

		if (typeof content === "string") {
			text = content;
		} else {
			const textParts: string[] = [];
			images = [];
			for (const part of content) {
				if (part.type === "text") {
					textParts.push(part.text);
				} else {
					images.push(part);
				}
			}
			text = textParts.join("\n");
			if (images.length === 0) images = undefined;
		}

		await this.prompt(text, {
			expandPromptTemplates: options?.expandPromptTemplates ?? false,
			streamingBehavior: options?.deliverAs,
			images,
			source: "extension",
		});
	}

	/**
	 * Sync agent state messages to the current session branch path.
	 * Must be called after any operation that changes the active path
	 * (branch, reroll, rewind, compaction, tree navigation, etc.),
	 * otherwise the LLM context and session tree will diverge.
	 */
	private _syncAgentStateFromSession(): void {
		const sessionContext = this.sessionManager.buildSessionContext();
		this.agent.state.messages = sessionContext.messages;
	}

	/**
	 * Run agent.continue() with lifecycle management.
	 * Sets _isAgentRunActive (for Escape abort), runs the post-agent-run
	 * loop (auto-retry, compaction, queued messages), and clears the flag.
	 */
	private async _runAgentContinue(): Promise<void> {
		this._isAgentRunActive = true;
		try {
			await this.agent.continue();
			while (await this._handlePostAgentRun()) {
				await this.agent.continue();
			}
		} finally {
			this._isAgentRunActive = false;
		}
	}

	/**
	 * Prepare a reroll: branch the session tree to the last user message,
	 * restore agent state / StateManager state / schemas to the new path, and
	 * emit leaf_changed so the UI rebuilds. Does NOT start the agent run.
	 *
	 * Callers then call startRerollRun() to begin the agent loop.
	 *
	 * @returns true if a user message was found and branch performed
	 */
	async reroll(): Promise<boolean> {
		if (!this.isIdle || this.isStreaming) {
			return false;
		}

		// Allow extensions to intercept reroll (e.g. delegate to a character sub-session).
		// If handled, skip the default reroll logic entirely.
		try {
			const result = await this._extensionRunner.emit({ type: "session_before_reroll" });
			if (result?.handled) return true;
		} catch {
			// Extension error → fall through to default reroll logic
		}

		const path = this.sessionManager.getBranch();
		for (let i = path.length - 1; i >= 0; i--) {
			const entry = path[i];
			if (entry.type === "message" && entry.message.role === "user") {
				const oldLeafId = this.sessionManager.getLeafId();
				// Branch to the user message itself: the regenerated response
				// appends as a sibling of the old response, and the active path
				// (and the state restored from it) still includes the message.
				this._moveLeafAndRestoreState(entry.id);
				this._emitSessionEvent({
					type: "leaf_changed",
					newLeafId: this.sessionManager.getLeafId(),
					oldLeafId,
				});
				return true;
			}
			// Also match custom_message entries whose declared policy marks them
			// as user turns (e.g. a consumer extension's direct player-input type).
			// The policy is registered by extensions via registerCustomType — pi-rp
			// never hardcodes extension-specific customType values.
			if (entry.type === "custom_message") {
				const policy = this._extensionRunner.getCustomTypePolicy(entry.customType);
				if (policy.llmRole === "user") {
					const oldLeafId = this.sessionManager.getLeafId();
					this._moveLeafAndRestoreState(entry.id);
					this._emitSessionEvent({
						type: "leaf_changed",
						newLeafId: this.sessionManager.getLeafId(),
						oldLeafId,
					});
					return true;
				}
			}
		}
		return false;
	}

	/**
	 * Move the session leaf to a target entry and roll back agent state,
	 * StateManager state, and schemas to the new active path. Shared by
	 * reroll() and navigateTree() — the two path-changing leaf moves.
	 *
	 * @param targetLeafId Entry id to branch to, or null to reset to root.
	 * @param options.summaryText Attach a branch_summary entry at the target
	 *   (navigateTree summarization) instead of a bare branch.
	 * @returns The branch summary entry id when a summary was attached.
	 */
	private _moveLeafAndRestoreState(
		targetLeafId: string | null,
		options?: {
			summaryText?: string;
			summaryDetails?: unknown;
			fromExtension?: boolean;
			summaryUsage?: Usage;
		},
	): string | undefined {
		let summaryId: string | undefined;
		if (options?.summaryText) {
			summaryId = this.sessionManager.branchWithSummary(
				targetLeafId,
				options.summaryText,
				options.summaryDetails,
				options.fromExtension,
				options.summaryUsage,
			);
		} else if (targetLeafId === null) {
			this.sessionManager.resetLeaf();
		} else {
			this.sessionManager.branch(targetLeafId);
		}

		// Update agent state
		this._syncAgentStateFromSession();

		// Restore StateManager state + schemas to the target branch (rollback)
		this._restoreStateFromSessionEntries();

		// Rolled-back memory is older than the shared files: commit owned
		// namespaces so the next apply replays onto the rolled-back baseline
		// instead of the stale (ahead) file revision.
		this._stateManager.commitOwnedToStore();

		return summaryId;
	}

	/**
	 * Start the agent run after reroll().
	 * Handles _isAgentRunActive lifecycle and post-agent-run loop
	 * (auto-retry, compaction, queued messages).
	 */
	async startRerollRun(): Promise<void> {
		await this._runAgentContinue();
	}

	/**
	 * Continue the session: make the agent generate regardless of the last
	 * message's state. Cleans up trailing aborted/errored empty assistant
	 * messages from agent state, injects an invisible "Continue." user message,
	 * and runs the agent loop. The injected message is not persisted to the session.
	 *
	 * @returns true if the agent was started
	 */
	async continueSession(): Promise<boolean> {
		if (!this.isIdle || this.isStreaming) {
			return false;
		}

		const messages = this.agent.state.messages;

		// Strip trailing aborted/errored empty assistant messages from agent state.
		// The session entries are preserved in the tree; this only cleans the LLM context.
		while (messages.length > 0) {
			const last = messages[messages.length - 1];
			if (
				last.role === "assistant" &&
				(last.stopReason === "aborted" || last.stopReason === "error") &&
				contentText(last.content, "").trim() === ""
			) {
				messages.pop();
			} else {
				break;
			}
		}

		// Inject an invisible continue message (not persisted to session).
		const continueText = this._activePreset.hiddenOverrides?.continueText ?? "Continue.";
		messages.push({
			role: "user",
			content: [{ type: "text", text: continueText }],
			timestamp: Date.now(),
		});

		await this._runAgentContinue();
		return true;
	}

	/**
	 * Edit the text content of a session message entry in place.
	 * Mutates the in-memory entry, rewrites the session file, and re-syncs
	 * the agent state if the edited entry lies on the current branch path.
	 *
	 * @returns true if the entry was found and updated
	 */
	editMessage(entryId: string, text: string): boolean {
		const updated = this.sessionManager.updateMessageContent(entryId, text);
		if (!updated) return false;

		// Check if the edited entry is on the current branch path.
		// If so, re-sync agent state so the change takes effect immediately.
		const path = this.sessionManager.getBranch();
		const onCurrentPath = path.some((e) => e.id === entryId);
		if (onCurrentPath) {
			this._syncAgentStateFromSession();
		}

		// Notify listeners so the UI can refresh the edited message node.
		this._emitSessionEvent({ type: "entry_edited", entryId });

		return true;
	}
	/**
	 * Clear all queued messages and return them.
	 * Useful for restoring to editor when user aborts.
	 * @returns Object with steering and followUp arrays
	 */
	clearQueue(): { steering: string[]; followUp: string[] } {
		const steering = [...this._steeringMessages];
		const followUp = [...this._followUpMessages];
		this._steeringMessages = [];
		this._followUpMessages = [];
		this.agent.clearAllQueues();
		this._emitQueueUpdate();
		return { steering, followUp };
	}

	/** Number of pending messages (includes both steering and follow-up) */
	get pendingMessageCount(): number {
		return this._steeringMessages.length + this._followUpMessages.length;
	}

	/** Get pending steering messages (read-only) */
	getSteeringMessages(): readonly string[] {
		return this._steeringMessages;
	}

	/** Get pending follow-up messages (read-only) */
	getFollowUpMessages(): readonly string[] {
		return this._followUpMessages;
	}

	get resourceLoader(): ResourceLoader {
		return this._resourceLoader;
	}

	/**
	 * Abort current operation and wait for agent to become idle.
	 */
	async abort(): Promise<void> {
		this.abortRetry();
		this.agent.abort();
		await this.waitForIdle();
	}

	async waitForIdle(): Promise<void> {
		if (this.isIdle) {
			return;
		}
		await this._getIdleWaitPromise();
	}

	// =========================================================================
	// Model Management
	// =========================================================================

	private async _emitModelSelect(
		nextModel: Model<any>,
		previousModel: Model<any> | undefined,
		source: "set" | "cycle" | "restore",
	): Promise<void> {
		if (modelsAreEqual(previousModel, nextModel)) return;
		await this._extensionRunner.emit({
			type: "model_select",
			model: nextModel,
			previousModel,
			source,
		});
	}

	/**
	 * Set model directly.
	 * Validates that auth is configured, saves to session and settings.
	 * @throws Error if no auth is configured for the model
	 */
	async setModel(model: Model<any>, persistSettings = true): Promise<void> {
		if (!(await this._modelRuntime.checkAuth(model.provider))) {
			throw new Error(`No API key for ${model.provider}/${model.id}`);
		}

		const previousModel = this.model;
		const thinkingLevel = this._getThinkingLevelForModelSwitch();
		this.agent.state.model = model;
		this.sessionManager.appendModelChange(model.provider, model.id);
		// persistSettings=false：只改内存态 + 写会话 JSONL（model_change 是 resume 的
		// 事实源），不碰全局 settings.json——给"多会话共享一个 agent dir"的宿主
		// （如 Nodesign RPC 模式）留的 opt-out，避免一个会话的热切换污染共享默认。
		if (persistSettings) {
			this.settingsManager.setDefaultModelAndProvider(model.provider, model.id);
		}

		// Re-clamp thinking level for new model's capabilities
		this.setThinkingLevel(thinkingLevel, persistSettings);

		await this._emitModelSelect(model, previousModel, "set");
	}

	/**
	 * Cycle to next/previous model.
	 * Uses scoped models (from --models flag) if available, otherwise all available models.
	 * @param direction - "forward" (default) or "backward"
	 * @returns The new model info, or undefined if only one model available
	 */
	async cycleModel(direction: "forward" | "backward" = "forward"): Promise<ModelCycleResult | undefined> {
		if (this._scopedModels.length > 0) {
			return this._cycleScopedModel(direction);
		}
		return this._cycleAvailableModel(direction);
	}

	private async _cycleScopedModel(direction: "forward" | "backward"): Promise<ModelCycleResult | undefined> {
		const availableIds = new Set(
			this._modelRuntime.getAvailableSnapshot().map((model) => `${model.provider}\0${model.id}`),
		);
		const scopedModels = this._scopedModels.filter((scoped) =>
			availableIds.has(`${scoped.model.provider}\0${scoped.model.id}`),
		);
		if (scopedModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = scopedModels.findIndex((sm) => modelsAreEqual(sm.model, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = scopedModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const next = scopedModels[nextIndex];
		const thinkingLevel = this._getThinkingLevelForModelSwitch(next.thinkingLevel);

		// Apply model
		this.agent.state.model = next.model;
		this.sessionManager.appendModelChange(next.model.provider, next.model.id);
		this.settingsManager.setDefaultModelAndProvider(next.model.provider, next.model.id);

		// Apply thinking level.
		// - Explicit scoped model thinking level overrides current session level
		// - Undefined scoped model thinking level inherits the current session preference
		// setThinkingLevel clamps to model capabilities.
		this.setThinkingLevel(thinkingLevel);

		await this._emitModelSelect(next.model, currentModel, "cycle");

		return { model: next.model, thinkingLevel: this.thinkingLevel, isScoped: true };
	}

	private async _cycleAvailableModel(direction: "forward" | "backward"): Promise<ModelCycleResult | undefined> {
		const availableModels = this._modelRuntime.getAvailableSnapshot();
		if (availableModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = availableModels.findIndex((m) => modelsAreEqual(m, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = availableModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const nextModel = availableModels[nextIndex];

		const thinkingLevel = this._getThinkingLevelForModelSwitch();
		this.agent.state.model = nextModel;
		this.sessionManager.appendModelChange(nextModel.provider, nextModel.id);
		this.settingsManager.setDefaultModelAndProvider(nextModel.provider, nextModel.id);

		// Re-clamp thinking level for new model's capabilities
		this.setThinkingLevel(thinkingLevel);

		await this._emitModelSelect(nextModel, currentModel, "cycle");

		return { model: nextModel, thinkingLevel: this.thinkingLevel, isScoped: false };
	}

	// =========================================================================
	// Thinking Level Management
	// =========================================================================

	/**
	 * Set thinking level.
	 * Clamps to model capabilities based on available thinking levels.
	 * Saves to session and settings only if the level actually changes.
	 */
	setThinkingLevel(level: ThinkingLevel, persistSettings = true): void {
		const availableLevels = this.getAvailableThinkingLevels();
		const effectiveLevel = availableLevels.includes(level) ? level : this._clampThinkingLevel(level, availableLevels);

		// Only persist if actually changing
		const previousLevel = this.agent.state.thinkingLevel;
		const isChanging = effectiveLevel !== previousLevel;

		this.agent.state.thinkingLevel = effectiveLevel;

		if (isChanging) {
			this.sessionManager.appendThinkingLevelChange(effectiveLevel);
			// persistSettings=false：会话 JSONL 照写（resume 恢复靠它），全局
			// settings.json 不写——见 setModel 的同名参数说明。
			if (persistSettings && (this.supportsThinking() || effectiveLevel !== "off")) {
				this.settingsManager.setDefaultThinkingLevel(effectiveLevel);
			}
			this._emit({ type: "thinking_level_changed", level: effectiveLevel });
			void this._extensionRunner.emit({
				type: "thinking_level_select",
				level: effectiveLevel,
				previousLevel,
			});
		}
	}

	/**
	 * Cycle to next thinking level.
	 * @returns New level, or undefined if model doesn't support thinking
	 */
	cycleThinkingLevel(): ThinkingLevel | undefined {
		if (!this.supportsThinking()) return undefined;

		const levels = this.getAvailableThinkingLevels();
		const currentIndex = levels.indexOf(this.thinkingLevel);
		const nextIndex = (currentIndex + 1) % levels.length;
		const nextLevel = levels[nextIndex];

		this.setThinkingLevel(nextLevel);
		return nextLevel;
	}

	/**
	 * Get available thinking levels for current model.
	 * The provider will clamp to what the specific model supports internally.
	 */
	getAvailableThinkingLevels(): ThinkingLevel[] {
		if (!this.model) return THINKING_LEVELS;
		return getSupportedThinkingLevels(this.model) as ThinkingLevel[];
	}

	/**
	 * Check if current model supports thinking/reasoning.
	 */
	supportsThinking(): boolean {
		return !!this.model?.reasoning;
	}

	private _getThinkingLevelForModelSwitch(explicitLevel?: ThinkingLevel): ThinkingLevel {
		if (explicitLevel !== undefined) {
			return explicitLevel;
		}
		if (!this.supportsThinking()) {
			return this.settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
		}
		return this.thinkingLevel;
	}

	private _clampThinkingLevel(level: ThinkingLevel, _availableLevels: ThinkingLevel[]): ThinkingLevel {
		return this.model ? (clampThinkingLevel(this.model, level) as ThinkingLevel) : "off";
	}

	// =========================================================================
	// Queue Mode Management
	// =========================================================================

	private syncQueueModesFromSettings(): void {
		this.agent.steeringMode = this.settingsManager.getSteeringMode();
		this.agent.followUpMode = this.settingsManager.getFollowUpMode();
	}

	/**
	 * Set steering message mode.
	 * Saves to settings.
	 */
	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.agent.steeringMode = mode;
		this.settingsManager.setSteeringMode(mode);
	}

	/**
	 * Set follow-up message mode.
	 * Saves to settings.
	 */
	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.agent.followUpMode = mode;
		this.settingsManager.setFollowUpMode(mode);
	}

	// =========================================================================
	// Compaction
	// =========================================================================

	/**
	 * Manually compact the session context.
	 * Aborts current agent operation first.
	 * @param customInstructions Optional instructions for the compaction summary
	 */
	async compact(customInstructions?: string): Promise<CompactionResult> {
		await this.abort();
		this._compactionAbortController = new AbortController();
		this._emit({ type: "compaction_start", reason: "manual" });

		try {
			if (!this.model) {
				throw new Error(formatNoModelSelectedMessage());
			}

			const { model: requestModel, apiKey, headers, env } = await this._getSummarizationRequestAuth(this.model);

			const pathEntries = this.sessionManager.getBranch();
			const settings = this.settingsManager.getCompactionSettings();

			const preparation = prepareCompaction(pathEntries, settings);
			if (!preparation) {
				// Check why we can't compact
				const lastEntry = pathEntries[pathEntries.length - 1];
				if (lastEntry?.type === "compaction") {
					throw new Error("Already compacted");
				}
				throw new Error("Nothing to compact (session too small)");
			}

			let extensionCompaction: CompactionResult | undefined;
			let fromExtension = false;

			if (this._extensionRunner.hasHandlers("session_before_compact")) {
				const result = (await this._extensionRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions,
					reason: "manual",
					willRetry: false,
					signal: this._compactionAbortController.signal,
				})) as SessionBeforeCompactResult | undefined;

				if (result?.cancel) {
					throw new Error("Compaction cancelled");
				}

				if (result?.compaction) {
					extensionCompaction = result.compaction;
					fromExtension = true;
				}
			}

			let summary: string;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let usage: Usage | undefined;
			let details: unknown;

			// Apply preset regex to compaction messages so the summarizer sees
			// the same filtered content as the main model
			const filteredPrep = this._applyPresetToCompactionPreparation(preparation);

			if (extensionCompaction) {
				// Extension provided compaction content
				summary = extensionCompaction.summary;
				firstKeptEntryId = extensionCompaction.firstKeptEntryId;
				tokensBefore = extensionCompaction.tokensBefore;
				usage = extensionCompaction.usage;
				details = extensionCompaction.details;
			} else {
				// Generate compaction result
				const result = await compact(
					filteredPrep,
					requestModel,
					apiKey,
					headers,
					customInstructions,
					this._compactionAbortController.signal,
					this.thinkingLevel,
					this.agent.streamFunction,
					env,
					this.settingsManager.getRetrySettings(),
					this._summarizationRetryCallbacks({ source: "compaction", reason: "manual" }),
					this._activePreset.hiddenOverrides?.compaction as CompactionPromptOverrides | undefined,
					(customType) => this._extensionRunner.getCustomTypePolicy(customType),
				);
				summary = result.summary;
				firstKeptEntryId = result.firstKeptEntryId;
				tokensBefore = result.tokensBefore;
				usage = result.usage;
				details = result.details;
			}

			// Pi-generated summaries are LLM output: apply the active preset's finalize
			// regex rules before persisting, matching assistant-message post-processing.
			// Extension-provided summaries are already in final form and are left as-is.
			if (!fromExtension) {
				summary = this._applyFinalizeToSummaryText(summary);
			}

			if (this._compactionAbortController.signal.aborted) {
				throw new Error("Compaction cancelled");
			}

			this.sessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromExtension, usage);
			const newEntries = this.sessionManager.getEntries();
			this._syncAgentStateFromSession();
			const estimatedTokensAfter = estimateMessagesTokens(this.agent.state.messages);

			// Get the saved compaction entry for the extension event
			const savedCompactionEntry = newEntries.find((e) => e.type === "compaction" && e.summary === summary) as
				| CompactionEntry
				| undefined;

			if (this._extensionRunner && savedCompactionEntry) {
				await this._extensionRunner.emit({
					type: "session_compact",
					compactionEntry: savedCompactionEntry,
					fromExtension,
					reason: "manual",
					willRetry: false,
				});
			}

			const compactionResult: CompactionResult = {
				summary,
				firstKeptEntryId,
				tokensBefore,
				estimatedTokensAfter,
				usage,
				details,
			};
			// compaction_end listeners may submit queued prompts, so expose idle state before notifying them.
			this._compactionAbortController = undefined;
			this._emit({
				type: "compaction_end",
				reason: "manual",
				result: compactionResult,
				aborted: false,
				willRetry: false,
			});
			return compactionResult;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const aborted = message === "Compaction cancelled" || (error instanceof Error && error.name === "AbortError");
			this._compactionAbortController = undefined;
			this._emit({
				type: "compaction_end",
				reason: "manual",
				result: undefined,
				aborted,
				willRetry: false,
				errorMessage: aborted ? undefined : `Compaction failed: ${message}`,
			});
			throw error;
		} finally {
			this._compactionAbortController = undefined;
		}
	}

	/**
	 * Cancel in-progress compaction (manual or auto).
	 */
	abortCompaction(): void {
		this._compactionAbortController?.abort();
		this._autoCompactionAbortController?.abort();
	}

	/** Apply the active preset's outgoing regex and stripAssistantThinking to compaction messages. */
	private _applyPresetToCompactionPreparation(preparation: CompactionPreparation): CompactionPreparation {
		const preset = this._activePreset;
		if (preset === defaultPreset || preset.id === "pi-default") return preparation;

		const diags: PromptPresetDiagnostic[] = [];
		// Mirror compileMessages: apply history stage first, then compiled stage
		let messagesToSummarize = applyRegexRulesToMessages(
			preset,
			preparation.messagesToSummarize,
			"history",
			"outgoing",
			diags,
		);
		messagesToSummarize = applyRegexRulesToMessages(preset, messagesToSummarize, "compiled", "outgoing", diags);
		let turnPrefixMessages = applyRegexRulesToMessages(
			preset,
			preparation.turnPrefixMessages,
			"history",
			"outgoing",
			diags,
		);
		turnPrefixMessages = applyRegexRulesToMessages(preset, turnPrefixMessages, "compiled", "outgoing", diags);

		// Check for stripAssistantThinking on the chat-history position slot
		const chatHistoryItem = preset.items.find((item): item is PromptPresetSlotItem => isChatHistoryPosition(item));
		// "previous-traces" also strips everything here: the summarized messages
		// are replaced by the summary regardless, and the current trace's retained
		// tail keeps its thinking verbatim.
		const stripThinkingMode = chatHistoryItem?.options?.stripAssistantThinking;
		if (stripThinkingMode === true || stripThinkingMode === "previous-traces") {
			const stripThinking = (msg: AgentMessage): AgentMessage => {
				if (typeof msg !== "object" || msg === null || !("content" in msg)) return msg;
				const content = msg.content;
				if (!Array.isArray(content)) return msg;
				return { ...msg, content: content.filter((x) => x.type !== "thinking") } as AgentMessage;
			};
			return {
				...preparation,
				messagesToSummarize: messagesToSummarize.map(stripThinking),
				turnPrefixMessages: turnPrefixMessages.map(stripThinking),
			};
		}

		return { ...preparation, messagesToSummarize, turnPrefixMessages };
	}

	/** Apply the active preset's finalize regex rules to a pi-generated summary text. */
	private _applyFinalizeToSummaryText(summary: string): string {
		const preset = this._activePreset;
		if (preset === defaultPreset || preset.id === "pi-default") return summary;
		const diags: PromptPresetDiagnostic[] = [];
		const message = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: summary }],
		} as AgentMessage;
		// applyFinalizeRegexRulesToMessage only transforms assistant messages, so the
		// result keeps the assistant role and always carries content.
		const finalized = applyFinalizeRegexRulesToMessage(preset, message, diags) as AssistantMessage | undefined;
		if (!finalized) return summary;
		return contentText(finalized.content, "");
	}

	/**
	 * Cancel in-progress branch summarization.
	 */
	abortBranchSummary(): void {
		this._branchSummaryAbortController?.abort();
	}

	/**
	 * Check if compaction is needed and run it.
	 * Called after agent_end and before prompt submission.
	 *
	 * Two cases:
	 * 1. Recoverable failure: LLM returned context overflow or stopped below its desired output limit;
	 *    remove the assistant message, compact, and auto-retry once
	 * 2. Threshold: Context over threshold, compact, NO auto-retry (user continues manually)
	 *
	 * @param assistantMessage The assistant message to check
	 * @param skipAbortedCheck If false, include aborted messages (for pre-prompt check). Default: true
	 */
	private async _checkCompaction(assistantMessage: AssistantMessage, skipAbortedCheck = true): Promise<boolean> {
		const settings = this.settingsManager.getCompactionSettings();
		if (!settings.enabled) return false;

		// Skip if message was aborted (user cancelled) - unless skipAbortedCheck is false
		if (skipAbortedCheck && assistantMessage.stopReason === "aborted") return false;

		const contextWindow = this.model?.contextWindow ?? 0;

		// Skip overflow check if the message came from a different model.
		// This handles the case where user switched from a smaller-context model (e.g. opus)
		// to a larger-context model (e.g. codex) - the overflow error from the old model
		// shouldn't trigger compaction for the new model.
		const sameModel =
			this.model && assistantMessage.provider === this.model.provider && assistantMessage.model === this.model.id;

		// Skip compaction checks if this assistant message is older than the latest
		// compaction boundary. This prevents a stale pre-compaction usage/error
		// from retriggering compaction on the first prompt after compaction.
		const compactionEntry = getLatestCompactionEntry(this.sessionManager.getBranch());
		const assistantIsFromBeforeCompaction =
			compactionEntry !== null && assistantMessage.timestamp <= new Date(compactionEntry.timestamp).getTime();
		if (assistantIsFromBeforeCompaction) {
			return false;
		}

		// Case 1: Recoverable failure. Explicit/silent context overflow still uses context metadata.
		// A length stop is recoverable when output ended below the model's original desired limit,
		// independent of the configured context size or any context-clamped provider request limit.
		// A successful response over the configured window should compact but must not retry: the
		// assistant answer already completed and agent.continue() cannot continue from an assistant.
		const recoverableLength = sameModel && isRecoverableLength(assistantMessage, this.model?.maxTokens ?? 0);
		if (sameModel && (isContextOverflow(assistantMessage, contextWindow) || recoverableLength)) {
			const willRetry = assistantMessage.stopReason !== "stop";

			if (!willRetry) {
				return await this._runAutoCompaction("overflow", false);
			}

			if (this._overflowRecoveryAttempted) {
				this._emit({
					type: "compaction_end",
					reason: "overflow",
					result: undefined,
					aborted: false,
					willRetry: false,
					errorMessage:
						"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
				});
				return false;
			}

			this._overflowRecoveryAttempted = true;
			// Remove the failed or truncated message from agent state. It remains in session history,
			// but must not be included in the compact-and-retry context.
			const messages = this.agent.state.messages;
			if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
				this.agent.state.messages = messages.slice(0, -1);
			}
			return await this._runAutoCompaction("overflow", willRetry);
		}

		// Case 2: Threshold - context is getting large
		// For error messages or all-zero usage messages, estimate from the last valid response.
		// This ensures sessions that hit persistent API errors (e.g. 529) or malformed zero-usage
		// responses can still compact and do not reset context accounting.
		let contextTokens: number;
		const directContextTokens = assistantMessage.usage ? calculateContextTokens(assistantMessage.usage) : 0;
		if (assistantMessage.stopReason === "error" || directContextTokens === 0) {
			const messages = this.agent.state.messages;
			const estimate = estimateContextTokens(messages);
			if (estimate.lastUsageIndex === null) return false; // No usage data at all
			// Verify the usage source is post-compaction. Kept pre-compaction messages
			// have stale usage reflecting the old (larger) context and would falsely
			// trigger compaction right after one just finished.
			const usageMsg = messages[estimate.lastUsageIndex];
			if (
				compactionEntry &&
				usageMsg.role === "assistant" &&
				(usageMsg as AssistantMessage).timestamp <= new Date(compactionEntry.timestamp).getTime()
			) {
				return false;
			}
			contextTokens = estimate.tokens;
		} else {
			contextTokens = directContextTokens;
		}
		if (shouldCompact(contextTokens, contextWindow, settings)) {
			return await this._runAutoCompaction("threshold", false);
		}
		return false;
	}

	/**
	 * Internal: Run auto-compaction with events.
	 */
	private async _runAutoCompaction(reason: "overflow" | "threshold", willRetry: boolean): Promise<boolean> {
		const settings = this.settingsManager.getCompactionSettings();
		let started = false;

		try {
			if (!this.model) {
				return false;
			}

			const { model: requestModel, apiKey, headers, env } = await this._getSummarizationRequestAuth(this.model);

			const pathEntries = this.sessionManager.getBranch();

			const preparation = prepareCompaction(pathEntries, settings);
			if (!preparation) {
				return false;
			}

			this._emit({ type: "compaction_start", reason });
			this._autoCompactionAbortController = new AbortController();
			started = true;

			let extensionCompaction: CompactionResult | undefined;
			let fromExtension = false;

			if (this._extensionRunner.hasHandlers("session_before_compact")) {
				const extensionResult = (await this._extensionRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions: undefined,
					reason,
					willRetry,
					signal: this._autoCompactionAbortController.signal,
				})) as SessionBeforeCompactResult | undefined;

				if (extensionResult?.cancel) {
					this._emit({
						type: "compaction_end",
						reason,
						result: undefined,
						aborted: true,
						willRetry: false,
					});
					return false;
				}

				if (extensionResult?.compaction) {
					extensionCompaction = extensionResult.compaction;
					fromExtension = true;
				}
			}

			let summary: string;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let usage: Usage | undefined;
			let details: unknown;

			// Apply preset regex to compaction messages for consistency
			const filteredPrep = this._applyPresetToCompactionPreparation(preparation);

			if (extensionCompaction) {
				// Extension provided compaction content
				summary = extensionCompaction.summary;
				firstKeptEntryId = extensionCompaction.firstKeptEntryId;
				tokensBefore = extensionCompaction.tokensBefore;
				usage = extensionCompaction.usage;
				details = extensionCompaction.details;
			} else {
				// Generate compaction result
				const compactResult = await compact(
					filteredPrep,
					requestModel,
					apiKey,
					headers,
					undefined,
					this._autoCompactionAbortController.signal,
					this.thinkingLevel,
					this.agent.streamFunction,
					env,
					this.settingsManager.getRetrySettings(),
					this._summarizationRetryCallbacks({ source: "compaction", reason }),
					this._activePreset.hiddenOverrides?.compaction as CompactionPromptOverrides | undefined,
					(customType) => this._extensionRunner.getCustomTypePolicy(customType),
				);
				summary = compactResult.summary;
				firstKeptEntryId = compactResult.firstKeptEntryId;
				tokensBefore = compactResult.tokensBefore;
				usage = compactResult.usage;
				details = compactResult.details;
			}

			// Pi-generated summaries are LLM output: apply the active preset's finalize
			// regex rules before persisting, matching assistant-message post-processing.
			// Extension-provided summaries are already in final form and are left as-is.
			if (!fromExtension) {
				summary = this._applyFinalizeToSummaryText(summary);
			}

			if (this._autoCompactionAbortController.signal.aborted) {
				this._emit({
					type: "compaction_end",
					reason,
					result: undefined,
					aborted: true,
					willRetry: false,
				});
				return false;
			}

			this.sessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromExtension, usage);
			const newEntries = this.sessionManager.getEntries();
			this._syncAgentStateFromSession();
			const estimatedTokensAfter = estimateMessagesTokens(this.agent.state.messages);

			// Get the saved compaction entry for the extension event
			const savedCompactionEntry = newEntries.find((e) => e.type === "compaction" && e.summary === summary) as
				| CompactionEntry
				| undefined;

			if (this._extensionRunner && savedCompactionEntry) {
				await this._extensionRunner.emit({
					type: "session_compact",
					compactionEntry: savedCompactionEntry,
					fromExtension,
					reason,
					willRetry,
				});
			}

			const result: CompactionResult = {
				summary,
				firstKeptEntryId,
				tokensBefore,
				estimatedTokensAfter,
				usage,
				details,
			};
			this._emit({ type: "compaction_end", reason, result, aborted: false, willRetry });

			if (willRetry) {
				const messages = this.agent.state.messages;
				const lastMsg = messages[messages.length - 1];
				// The overflow response was persisted on message_end before _checkCompaction() removed it
				// from agent state. Rebuilding state from the new compaction can restore that kept entry,
				// leaving an assistant as the final message. agent.continue() rejects that state, so remove
				// the retriable error or truncated-length response again before continuing the interrupted turn.
				if (lastMsg?.role === "assistant" && (lastMsg.stopReason === "error" || lastMsg.stopReason === "length")) {
					this.agent.state.messages = messages.slice(0, -1);
				}
				return true;
			}

			// Auto-compaction can complete while follow-up/steering/custom messages are waiting.
			// Continue once so queued messages are delivered.
			return this.agent.hasQueuedMessages();
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "compaction failed";
			if (started) {
				this._emit({
					type: "compaction_end",
					reason,
					result: undefined,
					aborted: false,
					willRetry: false,
					errorMessage:
						reason === "overflow"
							? `Context overflow recovery failed: ${errorMessage}`
							: `Auto-compaction failed: ${errorMessage}`,
				});
			}
			return false;
		} finally {
			this._autoCompactionAbortController = undefined;
		}
	}

	/**
	 * Toggle auto-compaction setting.
	 */
	setAutoCompactionEnabled(enabled: boolean): void {
		this.settingsManager.setCompactionEnabled(enabled);
	}

	/** Whether auto-compaction is enabled */
	get autoCompactionEnabled(): boolean {
		return this.settingsManager.getCompactionEnabled();
	}

	async bindExtensions(bindings: ExtensionBindings): Promise<void> {
		if (bindings.uiContext !== undefined) {
			this._extensionUIContext = bindings.uiContext;
		}
		if (bindings.mode !== undefined) {
			this._extensionMode = bindings.mode;
		}
		if (bindings.commandContextActions !== undefined) {
			this._extensionCommandContextActions = bindings.commandContextActions;
		}
		if (bindings.abortHandler !== undefined) {
			this._extensionAbortHandler = bindings.abortHandler;
		}
		if (bindings.shutdownHandler !== undefined) {
			this._extensionShutdownHandler = bindings.shutdownHandler;
		}
		if (bindings.onError !== undefined) {
			this._extensionErrorListener = bindings.onError;
		}
		if (bindings.parentContextRequest !== undefined) {
			this._extensionParentContextRequest = bindings.parentContextRequest;
		}
		if (bindings.orchestrationRequest !== undefined) {
			this._extensionOrchestrationRequest = bindings.orchestrationRequest;
		}

		this._applyExtensionBindings(this._extensionRunner);
		await this._extensionRunner.emit(this._sessionStartEvent);
		await this.extendResourcesFromExtensions(this._sessionStartEvent.reason === "reload" ? "reload" : "startup");
	}

	private async extendResourcesFromExtensions(reason: "startup" | "reload"): Promise<void> {
		if (!this._extensionRunner.hasHandlers("resources_discover")) {
			return;
		}

		const { skillPaths, promptPaths, themePaths } = await this._extensionRunner.emitResourcesDiscover(
			this._cwd,
			reason,
		);

		if (skillPaths.length === 0 && promptPaths.length === 0 && themePaths.length === 0) {
			return;
		}

		const extensionPaths: ResourceExtensionPaths = {
			skillPaths: this.buildExtensionResourcePaths(skillPaths),
			promptPaths: this.buildExtensionResourcePaths(promptPaths),
			themePaths: this.buildExtensionResourcePaths(themePaths),
		};

		this._resourceLoader.extendResources(extensionPaths);
		this._baseSystemPrompt = this._rebuildSystemPrompt(this.getActiveToolNames());
		this._applyDynamicSystemPrompt();
	}

	private buildExtensionResourcePaths(entries: Array<{ path: string; extensionPath: string }>): Array<{
		path: string;
		metadata: { source: string; scope: "temporary"; origin: "top-level"; baseDir?: string };
	}> {
		return entries.map((entry) => {
			const source = this.getExtensionSourceLabel(entry.extensionPath);
			const baseDir = entry.extensionPath.startsWith("<") ? undefined : dirname(entry.extensionPath);
			return {
				path: entry.path,
				metadata: {
					source,
					scope: "temporary",
					origin: "top-level",
					baseDir,
				},
			};
		});
	}

	private getExtensionSourceLabel(extensionPath: string): string {
		if (extensionPath.startsWith("<")) {
			return `extension:${extensionPath.replace(/[<>]/g, "")}`;
		}
		const base = basename(extensionPath);
		const name = base.replace(/\.(ts|js)$/, "");
		return `extension:${name}`;
	}

	private _applyExtensionBindings(runner: ExtensionRunner): void {
		runner.setUIContext(this._extensionUIContext, this._extensionMode);
		runner.bindCommandContext(this._extensionCommandContextActions);
		runner.setParentContextRequest(this._extensionParentContextRequest);
		runner.setOrchestrationRequest(this._extensionOrchestrationRequest);

		this._extensionErrorUnsubscriber?.();
		this._extensionErrorUnsubscriber = this._extensionErrorListener
			? runner.onError(this._extensionErrorListener)
			: undefined;
	}

	private _refreshCurrentModelFromRegistry(): void {
		const currentModel = this.model;
		if (!currentModel) {
			return;
		}

		const refreshedModel = this._modelRuntime.getModel(currentModel.provider, currentModel.id);
		if (!refreshedModel || refreshedModel === currentModel) {
			return;
		}

		this.agent.state.model = refreshedModel;
	}

	private _bindExtensionCore(runner: ExtensionRunner): void {
		const getCommands = (): SlashCommandInfo[] => {
			const extensionCommands: SlashCommandInfo[] = runner.getRegisteredCommands().map((command) => ({
				name: command.invocationName,
				description: command.description,
				source: "extension",
				sourceInfo: command.sourceInfo,
			}));

			const templates: SlashCommandInfo[] = this.promptTemplates.map((template) => ({
				name: template.name,
				description: template.description,
				...(template.argumentHint && { argumentHint: template.argumentHint }),
				source: "prompt",
				sourceInfo: template.sourceInfo,
			}));

			const skills: SlashCommandInfo[] = this._resourceLoader.getSkills().skills.map((skill) => ({
				name: `skill:${skill.name}`,
				description: skill.description,
				source: "skill",
				sourceInfo: skill.sourceInfo,
			}));

			return [...extensionCommands, ...templates, ...skills];
		};

		runner.bindCore(
			{
				sendMessage: (message, options) => {
					this.sendCustomMessage(message, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				sendUserMessage: (content, options) => {
					this.sendUserMessage(content, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_user_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				startLiveMessage: (message) => this.startLiveMessage(message),
				appendEntry: (typeOrCustomType: string, data?: unknown) => {
					if (typeOrCustomType === "message") {
						// Real message entry: persisted in the session, included in LLM
						// context (agent state + session entries), rendered in the TUI.
						const input = data as {
							role: "user" | "assistant";
							content: string | (TextContent | ImageContent)[];
						};
						// Normalize string content to the canonical content-array form the
						// loop persists for real messages (provider layer maps over arrays).
						const content: (TextContent | ImageContent)[] =
							typeof input.content === "string" ? [{ type: "text", text: input.content }] : input.content;
						// Seeded messages carry only role/content/timestamp; the full
						// Message type additionally requires model-output fields
						// (api/provider/model) that do not apply here.
						const appMessage = {
							role: input.role,
							content,
							timestamp: Date.now(),
						} as unknown as Message;
						this.agent.state.messages.push(appMessage);
						this.sessionManager.appendMessage(appMessage);
						this._emit({ type: "message_start", message: appMessage });
						this._emit({ type: "message_end", message: appMessage });
						return;
					}
					const entryId = this.sessionManager.appendCustomEntry(typeOrCustomType, data);
					const entry = this.sessionManager.getEntry(entryId);
					if (entry) {
						this._emit({ type: "entry_appended", entry });
					}
				},
				setSessionName: (name) => {
					this.setSessionName(name);
				},
				getSessionName: () => {
					return this.sessionManager.getSessionName();
				},
				setLabel: (entryId, label) => {
					this.sessionManager.appendLabelChange(entryId, label);
				},
				getActiveTools: () => this.getActiveToolNames(),
				getAllTools: () => this.getAllTools(),
				setActiveTools: (toolNames) => {
					this.setActiveToolsByName(toolNames);
					this._syncActiveToolPolicy();
				},
				refreshTools: () => this._refreshToolRegistry(),
				getCommands,
				setModel: async (model) => {
					if (!this._modelRuntime.hasConfiguredAuth(model.provider)) return false;
					await this.setModel(model);
					return true;
				},
				getThinkingLevel: () => this.thinkingLevel,
				setThinkingLevel: (level) => this.setThinkingLevel(level),
				getState: () => this._stateManager.snapshot(),
				subscribeState: (handler) => this._stateManager.subscribe(handler),
				updateState: (path, op, value) => {
					const validation = this._schemaValidator.validate(
						path,
						op,
						value as JsonValue,
						this._stateManager.snapshot() as Record<string, JsonValue>,
					);
					if (!validation.ok) {
						return { ok: false, reason: validation.reason ?? "validation failed" };
					}
					const effectiveValue = validation.correctedValue ?? value;
					const result = this._stateManager.apply(path, op, effectiveValue as JsonValue);
					// Persist immediately when idle (outside a turn); otherwise defer to turn_end
					// so a single turn with multiple writes produces one snapshot, not N.
					if (this.isIdle) {
						this.sessionManager.appendState(this._stateManager.snapshot());
						this._stateManager.clearDirty();
					}
					return { ok: true, path: result.path, newValue: result.newValue };
				},
			},
			{
				getModel: () => this.model,
				getScopedModels: () => this.scopedModels,
				isIdle: () => this.isIdle,
				isProjectTrusted: () => this.settingsManager.isProjectTrusted(),
				getSignal: () => this.agent.signal,
				abort: () => {
					if (this._extensionAbortHandler) {
						this._extensionAbortHandler();
						return;
					}
					void this.abort();
				},
				hasPendingMessages: () => this.pendingMessageCount > 0,
				shutdown: () => {
					this._extensionShutdownHandler?.();
				},
				getContextUsage: () => this.getContextUsage(),
				compact: (options) => {
					void (async () => {
						try {
							const result = await this.compact(options?.customInstructions);
							options?.onComplete?.(result);
						} catch (error) {
							const err = error instanceof Error ? error : new Error(String(error));
							options?.onError?.(err);
						}
					})();
				},
				getSystemPrompt: () => this.systemPrompt,
				getSystemPromptOptions: () => this._baseSystemPromptOptions,
				completeSideRequest: async ({
					model,
					context,
					maxTokens,
					thinkingLevel,
					signal,
					priority,
					label,
					timeoutMs,
				}) => {
					const m = model ?? this.model;
					if (!m) throw new Error("completeSideRequest: no model available");
					const streamFn: StreamFn | undefined = this._requestGateway
						? (mm, cc, oo) =>
								this._requestGateway!.streamSimple(
									mm,
									cc,
									oo,
									{ sessionId: "?", priority: priority ?? 0, label: label ?? "extension" },
									signal,
								)
						: undefined;
					const options: SimpleStreamOptions = { maxTokens, signal, timeoutMs };
					if (m.reasoning && thinkingLevel && thinkingLevel !== "off") {
						options.reasoning = thinkingLevel;
					}
					return completeSummarization(m, context, options, streamFn, this.settingsManager.getRetrySettings());
				},
				compilePreset: (presetId, runtime) => {
					const presets = this.getAllPresets();
					const loaded = presets.find((p) => p.preset.id === presetId);
					if (!loaded) {
						throw new Error(
							`Preset not found: ${presetId}. Available presets: ${presets.map((p) => p.preset.id).join(", ")}`,
						);
					}
					// Single pipeline run: compileMessages is the one compile path;
					// the system prompt is derived from its output, not re-compiled.
					const messages = compileMessages(loaded.preset, runtime);
					const system = deriveSystemPrompt(messages, loaded.preset, "");
					return {
						messages: messages.messages,
						systemPrompt: system.systemPrompt,
						diagnostics: [...messages.diagnostics, ...system.diagnostics],
					};
				},
				spawnAgent: (options) => spawnAgent(this, options),
			},
			{
				registerProvider: (name, config) => {
					this._modelRuntime.registerProvider(name, config);
					this._refreshCurrentModelFromRegistry();
				},
				registerNativeProvider: (provider) => {
					this._modelRuntime.registerNativeProvider(provider);
					this._refreshCurrentModelFromRegistry();
				},
				unregisterProvider: (name) => {
					this._modelRuntime.unregisterProvider(name);
					this._refreshCurrentModelFromRegistry();
				},
			},
		);
	}

	private _refreshToolRegistry(options?: { activeToolNames?: string[]; includeAllExtensionTools?: boolean }): void {
		const previousRegistryNames = new Set(this._toolRegistry.keys());
		const previousActiveToolNames = this.getActiveToolNames();
		const allowedToolNames = this._allowedToolNames;
		const excludedToolNames = this._excludedToolNames;
		const isAllowedTool = (name: string): boolean =>
			(!allowedToolNames || allowedToolNames.has(name)) && !excludedToolNames?.has(name);

		const registeredTools = this._extensionRunner.getAllRegisteredTools();
		const allCustomTools = [
			...registeredTools,
			...this._customTools.map((definition) => ({
				definition,
				sourceInfo: createSyntheticSourceInfo(`<sdk:${definition.name}>`, { source: "sdk" }),
			})),
		].filter((tool) => isAllowedTool(tool.definition.name));
		const definitionRegistry = new Map<string, ToolDefinitionEntry>(
			Array.from(this._baseToolDefinitions.entries())
				.filter(([name]) => isAllowedTool(name))
				.map(([name, definition]) => [
					name,
					{
						definition,
						sourceInfo: createSyntheticSourceInfo(`<builtin:${name}>`, { source: "builtin" }),
					},
				]),
		);
		for (const tool of allCustomTools) {
			definitionRegistry.set(tool.definition.name, {
				definition: tool.definition,
				sourceInfo: tool.sourceInfo,
			});
		}
		this._toolDefinitions = definitionRegistry;
		this._toolPromptSnippets = new Map(
			Array.from(definitionRegistry.values())
				.map(({ definition }) => {
					const snippet = this._normalizePromptSnippet(definition.promptSnippet);
					return snippet ? ([definition.name, snippet] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string] => entry !== undefined),
		);
		this._toolPromptGuidelines = new Map(
			Array.from(definitionRegistry.values())
				.map(({ definition }) => {
					const guidelines = this._normalizePromptGuidelines(definition.promptGuidelines);
					return guidelines.length > 0 ? ([definition.name, guidelines] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string[]] => entry !== undefined),
		);
		const runner = this._extensionRunner;
		const wrappedExtensionTools = wrapRegisteredTools(allCustomTools, runner);
		const wrappedBuiltInTools = wrapRegisteredTools(
			Array.from(this._baseToolDefinitions.values())
				.filter((definition) => isAllowedTool(definition.name))
				.map((definition) => ({
					definition,
					sourceInfo: createSyntheticSourceInfo(`<builtin:${definition.name}>`, { source: "builtin" }),
				})),
			runner,
		);

		const toolRegistry = new Map(wrappedBuiltInTools.map((tool) => [tool.name, tool]));
		for (const tool of wrappedExtensionTools as AgentTool[]) {
			toolRegistry.set(tool.name, tool);
		}
		this._toolRegistry = toolRegistry;

		const nextActiveToolNames = (
			options?.activeToolNames ? [...options.activeToolNames] : [...previousActiveToolNames]
		).filter((name) => isAllowedTool(name));

		if (allowedToolNames) {
			for (const toolName of this._toolRegistry.keys()) {
				if (allowedToolNames.has(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		} else if (options?.includeAllExtensionTools) {
			for (const tool of wrappedExtensionTools) {
				nextActiveToolNames.push(tool.name);
			}
		} else if (!options?.activeToolNames) {
			for (const toolName of this._toolRegistry.keys()) {
				if (!previousRegistryNames.has(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		}

		this.setActiveToolsByName([...new Set(nextActiveToolNames)]);
	}

	private _buildRuntime(options: {
		activeToolNames?: string[];
		flagValues?: Map<string, boolean | string>;
		includeAllExtensionTools?: boolean;
	}): void {
		const autoResizeImages = this.settingsManager.getImageAutoResize();
		const shellCommandPrefix = this.settingsManager.getShellCommandPrefix();
		const shellPath = this.settingsManager.getShellPath();
		const baseToolDefinitions = this._baseToolsOverride
			? Object.fromEntries(
					Object.entries(this._baseToolsOverride).map(([name, tool]) => [
						name,
						createToolDefinitionFromAgentTool(tool),
					]),
				)
			: createAllToolDefinitions(this._cwd, {
					read: { autoResizeImages },
					bash: { commandPrefix: shellCommandPrefix, shellPath },
				});

		this._baseToolDefinitions = new Map(
			Object.entries(baseToolDefinitions).map(([name, tool]) => [name, tool as ToolDefinition]),
		);

		// Load schema definitions and custom validators (sync — jiti supports sync import)
		const schemaResult = loadSchemaDefs(this._cwd, getAgentDir());
		this._loadedSchemaDefs = schemaResult.schemas;
		this._loadedCustomValidators = loadCustomValidators(this._cwd, getAgentDir());
		this._schemaValidator.setCustomValidators(this._loadedCustomValidators);
		// Re-apply loaded schemas and strict mode from session entries so
		// /reload picks up file changes (clears stale, replays schema_change
		// + strict_change entries with the freshly loaded schema defs).
		this._restoreSchemasFromEntries(this.sessionManager.buildContextEntries());

		// Add state_update and get_state tools
		this._baseToolDefinitions.set(
			"state_update",
			createStateUpdateToolDefinition(this._stateManager, this._schemaValidator),
		);
		this._baseToolDefinitions.set("get_state", createGetStateToolDefinition(this._stateManager));
		this._baseToolDefinitions.set("subagent_profiles", createSubagentProfilesToolDefinition(this));
		this._baseToolDefinitions.set("subagent", createSubagentToolDefinition(this));
		const extensionsResult = this._resourceLoader.getExtensions();
		if (options.flagValues) {
			for (const [name, value] of options.flagValues) {
				extensionsResult.runtime.flagValues.set(name, value);
			}
		}

		this._extensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			this._cwd,
			this.sessionManager,
			new ModelRegistry(this._modelRuntime),
			this.settingsManager,
		);
		if (this._extensionRunnerRef) {
			this._extensionRunnerRef.current = this._extensionRunner;
		}
		this._bindExtensionCore(this._extensionRunner);
		this._applyExtensionBindings(this._extensionRunner);
		// Ensure builtin command entries are registered, then mirror extension
		// commands into the command registry (re-registered on every rebuild,
		// so a reload drops stale entries).
		registerBuiltinCommandEntries();
		syncExtensionCommands(this._extensionRunner);

		const defaultActiveToolNames = this._baseToolsOverride
			? Object.keys(this._baseToolsOverride)
			: ["read", "bash", "edit", "write", "state_update", "get_state", "subagent_profiles", "subagent"];
		const baseActiveToolNames = options.activeToolNames ?? defaultActiveToolNames;
		this._refreshToolRegistry({
			activeToolNames: baseActiveToolNames,
			includeAllExtensionTools: options.includeAllExtensionTools,
		});

		// Apply the restored/active preset's tools policy after re-registering tools,
		// so extension tools added by includeAllExtensionTools are also filtered.
		this._syncActiveToolPolicy();
	}

	/**
	 * 窄重载：只重扫 prompt 模板（不重载扩展/runtime/事件），并广播
	 * resources_discover(reason:"reload") 供宿主（handoff 等）转发给关联子进程。
	 * 安装/编辑命令后调用，无需重启会话即生效。
	 */
	async reloadPromptTemplates(): Promise<void> {
		this._resourceLoader.reloadPromptTemplates();
		await this.extendResourcesFromExtensions("reload");
	}

	async reload(options?: { beforeSessionStart?: () => void | Promise<void> }): Promise<void> {
		const oldRunner = this._extensionRunner;
		const previousFlagValues = oldRunner.getFlagValues();
		await emitSessionShutdownEvent(oldRunner, { type: "session_shutdown", reason: "reload" });
		oldRunner.invalidate();
		await this.settingsManager.reload();
		this._stateManager.detachStore();
		this.syncQueueModesFromSettings();
		resetApiProviders();
		await this._resourceLoader.reload();
		this.reloadPresets();
		this._buildRuntime({
			activeToolNames: this.getActiveToolNames(),
			flagValues: previousFlagValues,
			includeAllExtensionTools: true,
		});
		this._initStateStore();

		const hasBindings =
			this._extensionUIContext ||
			this._extensionCommandContextActions ||
			this._extensionShutdownHandler ||
			this._extensionErrorListener;
		if (hasBindings) {
			await options?.beforeSessionStart?.();
			await this._extensionRunner.emit({ type: "session_start", reason: "reload" });
			await this.extendResourcesFromExtensions("reload");
		}
	}
	// =========================================================================
	// Auto-Retry
	// =========================================================================

	/**
	 * Check if an error is retryable (overloaded, rate limit, server errors).
	 * Context overflow errors are NOT retryable (handled by compaction instead).
	 */
	private _isRetryableError(message: AssistantMessage): boolean {
		// Context overflow is handled by compaction, not retry.
		if (isContextOverflow(message, this.model?.contextWindow ?? 0)) return false;
		return isRetryableAssistantError(message);
	}

	/**
	 * Retry policy + callbacks shared by compaction and branch-summary summarization calls.
	 * Uses the same `settings.retry` budget/backoff as agent-turn retries so a single transient
	 * stream drop no longer fails the whole operation. `source` carries the context
	 * the TUI needs to render the retry and recreate the underlying indicator.
	 */
	private _summarizationRetryCallbacks(
		source: { source: "branchSummary" } | { source: "compaction"; reason: "manual" | "threshold" | "overflow" },
	): RetryCallbacks {
		return {
			onRetryScheduled: (attempt, maxAttempts, delayMs, errorMessage) => {
				this._emit({
					type: "summarization_retry_scheduled",
					attempt,
					maxAttempts,
					delayMs,
					errorMessage,
				});
			},
			onRetryAttemptStart: () => {
				this._emit({
					type: "summarization_retry_attempt_start",
					...source,
				});
			},
			onRetryFinished: () => {
				this._emit({ type: "summarization_retry_finished" });
			},
		};
	}

	/**
	 * Prepare a retryable error for continuation with exponential backoff.
	 * @returns true if the caller should continue the agent, false otherwise
	 */
	private async _prepareRetry(message: AssistantMessage): Promise<boolean> {
		const settings = this.settingsManager.getRetrySettings();
		if (!settings.enabled) {
			return false;
		}

		this._retryAttempt++;

		if (this._retryAttempt > settings.maxRetries) {
			// Preserve the completed attempt count so post-run handling can emit the final failure.
			this._retryAttempt--;
			return false;
		}

		const delayMs = settings.baseDelayMs * 2 ** (this._retryAttempt - 1);

		this._emit({
			type: "auto_retry_start",
			attempt: this._retryAttempt,
			maxAttempts: settings.maxRetries,
			delayMs,
			errorMessage: message.errorMessage || "Unknown error",
		});

		// Remove error message from agent state (keep in session for history)
		const messages = this.agent.state.messages;
		if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
			this.agent.state.messages = messages.slice(0, -1);
		}

		// Wait with exponential backoff (abortable)
		this._retryAbortController = new AbortController();
		try {
			await sleep(delayMs, this._retryAbortController.signal);
		} catch {
			// Aborted during sleep - emit end event so UI can clean up
			const attempt = this._retryAttempt;
			this._retryAttempt = 0;
			this._emit({
				type: "auto_retry_end",
				success: false,
				attempt,
				finalError: "Retry cancelled",
			});
			return false;
		} finally {
			this._retryAbortController = undefined;
		}

		return true;
	}

	/**
	 * Cancel in-progress retry.
	 */
	abortRetry(): void {
		this._retryAbortController?.abort();
	}

	/** Whether auto-retry is currently in progress */
	get isRetrying(): boolean {
		return this._retryAbortController !== undefined;
	}

	/** Whether auto-retry is enabled */
	get autoRetryEnabled(): boolean {
		return this.settingsManager.getRetryEnabled();
	}

	/**
	 * Toggle auto-retry setting.
	 */
	setAutoRetryEnabled(enabled: boolean): void {
		this.settingsManager.setRetryEnabled(enabled);
	}

	// =========================================================================
	// Bash Execution
	// =========================================================================

	/**
	 * Execute a bash command.
	 * Adds result to agent context and session.
	 * @param command The bash command to execute
	 * @param onChunk Optional streaming callback for output
	 * @param options.excludeFromContext If true, command output won't be sent to LLM (!! prefix)
	 * @param options.operations Custom BashOperations for remote execution
	 */
	async executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean; id?: string; operations?: BashOperations },
	): Promise<BashResult> {
		const abortController = new AbortController();
		this._bashAbortControllers.add(abortController);

		const prefix = this.settingsManager.getShellCommandPrefix();
		const shellPath = this.settingsManager.getShellPath();
		const resolvedCommand = prefix ? `${prefix}\n${command}` : command;

		try {
			const result = await executeBashWithOperations(
				resolvedCommand,
				this.sessionManager.getCwd(),
				options?.operations ?? createLocalBashOperations({ shellPath }),
				{
					onChunk: (delta) => {
						onChunk?.(delta);
						this._emit({ type: "bash_execution_update", id: options?.id, delta });
					},
					signal: abortController.signal,
				},
			);

			this.recordBashResult(command, result, options);
			return result;
		} finally {
			this._bashAbortControllers.delete(abortController);
		}
	}

	/**
	 * Record a bash execution result in session history.
	 * Used by executeBash and by extensions that handle bash execution themselves.
	 */
	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
		const bashMessage: BashExecutionMessage = {
			role: "bashExecution",
			command,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			fullOutputPath: result.fullOutputPath,
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		};

		// If agent is streaming, defer adding to avoid breaking tool_use/tool_result ordering
		if (this.isStreaming) {
			// Queue for later - will be flushed on agent_end
			this._pendingBashMessages.push(bashMessage);
		} else {
			// Add to agent state immediately
			this.agent.state.messages.push(bashMessage);

			// Save to session
			this.sessionManager.appendMessage(bashMessage);
		}
	}

	/**
	 * Cancel running bash command.
	 */
	abortBash(): void {
		for (const abortController of [...this._bashAbortControllers]) {
			abortController.abort();
		}
	}

	/** Whether a bash command is currently running */
	get isBashRunning(): boolean {
		return this._bashAbortControllers.size > 0;
	}

	/** Whether there are pending bash messages waiting to be flushed */
	get hasPendingBashMessages(): boolean {
		return this._pendingBashMessages.length > 0;
	}

	/**
	 * Flush pending bash messages to agent state and session.
	 * Called after agent turn completes to maintain proper message ordering.
	 */
	private _flushPendingBashMessages(): void {
		if (this._pendingBashMessages.length === 0) return;

		for (const bashMessage of this._pendingBashMessages) {
			// Add to agent state
			this.agent.state.messages.push(bashMessage);

			// Save to session
			this.sessionManager.appendMessage(bashMessage);
		}

		this._pendingBashMessages = [];
	}

	// =========================================================================
	// Session Management
	// =========================================================================

	/**
	 * Set a display name for the current session.
	 */
	setSessionName(name: string): void {
		this.sessionManager.appendSessionInfo(name);
		const event = { type: "session_info_changed", name: this.sessionManager.getSessionName() } as const;
		this._emit(event);
		void this._extensionRunner.emit(event);
	}

	// =========================================================================
	// Tree Navigation
	// =========================================================================

	/**
	 * Navigate to a different node in the session tree.
	 * Unlike fork() which creates a new session file, this stays in the same file.
	 *
	 * @param targetId The entry ID to navigate to
	 * @param options.summarize Whether user wants to summarize abandoned branch
	 * @param options.customInstructions Custom instructions for summarizer
	 * @param options.replaceInstructions If true, customInstructions replaces the default prompt
	 * @param options.label Label to attach to the branch summary entry
	 * @returns Result with editorText (if user message) and cancelled status
	 */
	async navigateTree(
		targetId: string,
		options: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string } = {},
	): Promise<{ editorText?: string; cancelled: boolean; aborted?: boolean; summaryEntry?: BranchSummaryEntry }> {
		if (this.isStreaming) {
			throw new Error("Wait for the current response to finish before navigating the session tree.");
		}

		const oldLeafId = this.sessionManager.getLeafId();

		// No-op if already at target
		if (targetId === oldLeafId) {
			return { cancelled: false };
		}

		// Model required for summarization
		if (options.summarize && !this.model) {
			throw new Error("No model available for summarization");
		}

		const targetEntry = this.sessionManager.getEntry(targetId);
		if (!targetEntry) {
			throw new Error(`Entry ${targetId} not found`);
		}

		// Collect entries to summarize (from old leaf to common ancestor)
		const { entries: entriesToSummarize, commonAncestorId } = collectEntriesForBranchSummary(
			this.sessionManager,
			oldLeafId,
			targetId,
		);

		// Prepare event data - mutable so extensions can override
		let customInstructions = options.customInstructions;
		let replaceInstructions = options.replaceInstructions;
		let label = options.label;

		const preparation: TreePreparation = {
			targetId,
			oldLeafId,
			commonAncestorId,
			entriesToSummarize,
			userWantsSummary: options.summarize ?? false,
			customInstructions,
			replaceInstructions,
			label,
		};

		// Set up abort controller for summarization
		this._branchSummaryAbortController = new AbortController();

		try {
			let extensionSummary: { summary: string; details?: unknown; usage?: Usage } | undefined;
			let fromExtension = false;

			// Emit session_before_tree event
			if (this._extensionRunner.hasHandlers("session_before_tree")) {
				const result = (await this._extensionRunner.emit({
					type: "session_before_tree",
					preparation,
					signal: this._branchSummaryAbortController.signal,
				})) as SessionBeforeTreeResult | undefined;

				if (result?.cancel) {
					return { cancelled: true };
				}

				if (result?.summary && options.summarize) {
					extensionSummary = result.summary;
					fromExtension = true;
				}

				// Allow extensions to override instructions and label
				if (result?.customInstructions !== undefined) {
					customInstructions = result.customInstructions;
				}
				if (result?.replaceInstructions !== undefined) {
					replaceInstructions = result.replaceInstructions;
				}
				if (result?.label !== undefined) {
					label = result.label;
				}
			}

			// Run default summarizer if needed
			let summaryText: string | undefined;
			let summaryDetails: unknown;
			let summaryUsage: Usage | undefined;
			if (options.summarize && entriesToSummarize.length > 0 && !extensionSummary) {
				const model = this.model!;
				const { model: requestModel, apiKey, headers, env } = await this._getSummarizationRequestAuth(model);
				const branchSummarySettings = this.settingsManager.getBranchSummarySettings();
				const result = await generateBranchSummary(entriesToSummarize, {
					model: requestModel,
					apiKey,
					headers,
					env,
					signal: this._branchSummaryAbortController.signal,
					customInstructions,
					replaceInstructions,
					reserveTokens: branchSummarySettings.reserveTokens,
					streamFn: this.agent.streamFunction,
					retry: this.settingsManager.getRetrySettings(),
					callbacks: this._summarizationRetryCallbacks({ source: "branchSummary" }),
					promptOverride: (this._activePreset.hiddenOverrides?.compaction as CompactionPromptOverrides | undefined)
						?.branchSummaryPrompt,
					preset:
						this._activePreset !== defaultPreset && this._activePreset.id !== "pi-default"
							? this._activePreset
							: undefined,
					resolveCustomType: (customType) => this._extensionRunner.getCustomTypePolicy(customType),
				});
				if (result.aborted) {
					return { cancelled: true, aborted: true };
				}
				if (result.error) {
					throw new Error(result.error);
				}
				summaryText = result.summary;
				summaryUsage = result.usage;
				summaryDetails = {
					readFiles: result.readFiles || [],
					modifiedFiles: result.modifiedFiles || [],
				};
			} else if (extensionSummary) {
				summaryText = extensionSummary.summary;
				summaryDetails = extensionSummary.details;
				summaryUsage = extensionSummary.usage;
			}

			// Determine the new leaf position based on target type
			let newLeafId: string | null;
			let editorText: string | undefined;

			if (targetEntry.type === "message" && targetEntry.message.role === "user") {
				// User message: leaf = parent (null if root), text goes to editor
				newLeafId = targetEntry.parentId;
				editorText = contentText(targetEntry.message.content, "");
			} else if (targetEntry.type === "custom_message") {
				// Custom message: leaf = parent (null if root), text goes to editor
				newLeafId = targetEntry.parentId;
				editorText = contentText(targetEntry.content, "");
			} else {
				// Non-user message: leaf = selected node
				newLeafId = targetId;
			}

			// Switch leaf (with or without summary) and roll back agent state,
			// StateManager state, and schemas to the target branch.
			// Summary is attached at the navigation target position (newLeafId), not the old branch.
			let summaryEntry: BranchSummaryEntry | undefined;
			const summaryId = this._moveLeafAndRestoreState(newLeafId, {
				...(summaryText ? { summaryText, summaryDetails, fromExtension, summaryUsage } : {}),
			});
			if (summaryId) {
				summaryEntry = this.sessionManager.getEntry(summaryId) as BranchSummaryEntry;

				// Attach label to the summary entry
				if (label) {
					this.sessionManager.appendLabelChange(summaryId, label);
				}
			}

			// Attach label to target entry when not summarizing (no summary entry to label)
			if (label && !summaryText) {
				this.sessionManager.appendLabelChange(targetId, label);
			}

			// Notify session listeners + extensions that the leaf moved (after
			// mutation + state/schema restore completes).
			this._emitSessionEvent({
				type: "leaf_changed",
				newLeafId: this.sessionManager.getLeafId(),
				oldLeafId,
			});

			// Emit session_tree event (extension-only; retires in a later cycle)
			await this._extensionRunner.emit({
				type: "session_tree",
				newLeafId: this.sessionManager.getLeafId(),
				oldLeafId,
				summaryEntry,
				fromExtension: summaryText ? fromExtension : undefined,
			});

			// Emit to custom tools

			return { editorText, cancelled: false, summaryEntry };
		} finally {
			this._branchSummaryAbortController = undefined;
		}
	}

	/**
	 * Get all user messages from session for fork selector.
	 */
	getUserMessagesForForking(): Array<{ entryId: string; text: string }> {
		const entries = this.sessionManager.getEntries();
		const result: Array<{ entryId: string; text: string }> = [];

		for (const entry of entries) {
			if (entry.type !== "message") continue;
			if (entry.message.role !== "user") continue;

			const text = contentText(entry.message.content, "");
			if (text) {
				result.push({ entryId: entry.id, text });
			}
		}

		return result;
	}

	/**
	 * Get session statistics. Aggregates over ALL session entries (including
	 * history that was compacted away), so token/cost totals reflect what was
	 * actually billed across the session.
	 */
	getSessionStats(): SessionStats {
		let userMessages = 0;
		let assistantMessages = 0;
		let toolResults = 0;
		let totalMessages = 0;
		let toolCalls = 0;
		const usageTotals = createUsageTotals();

		for (const entry of this.sessionManager.getEntries()) {
			if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
				addUsageToTotals(usageTotals, entry.usage);
			}
			if (entry.type !== "message") continue;
			totalMessages++;
			const message = entry.message;
			if (message.role === "user") {
				userMessages++;
			} else if (message.role === "toolResult") {
				toolResults++;
				if (message.usage) {
					addUsageToTotals(usageTotals, message.usage);
				}
			} else if (message.role === "assistant") {
				assistantMessages++;
				const assistantMsg = message as AssistantMessage;
				if (Array.isArray(assistantMsg.content)) {
					toolCalls += assistantMsg.content.filter((c) => c.type === "toolCall").length;
				}
				addUsageToTotals(usageTotals, assistantMsg.usage);
			}
		}

		return {
			sessionFile: this.sessionFile,
			sessionId: this.sessionId,
			userMessages,
			assistantMessages,
			toolCalls,
			toolResults,
			totalMessages,
			tokens: {
				input: usageTotals.input,
				output: usageTotals.output,
				cacheRead: usageTotals.cacheRead,
				cacheWrite: usageTotals.cacheWrite,
				total: usageTotals.input + usageTotals.output + usageTotals.cacheRead + usageTotals.cacheWrite,
			},
			cost: usageTotals.cost,
			contextUsage: this.getContextUsage(),
		};
	}

	getContextUsage(): ContextUsage | undefined {
		const model = this.model;
		if (!model) return undefined;

		const contextWindow = model.contextWindow ?? 0;
		if (contextWindow <= 0) return undefined;

		// After compaction, the last assistant usage reflects pre-compaction context size.
		// We can only trust usage from an assistant that responded after the latest compaction.
		// If no such assistant exists, context token count is unknown until the next LLM response.
		const branchEntries = this.sessionManager.getBranch();
		const latestCompaction = getLatestCompactionEntry(branchEntries);

		if (latestCompaction) {
			// Check if there's a valid assistant usage after the compaction boundary
			const compactionIndex = branchEntries.lastIndexOf(latestCompaction);
			let hasPostCompactionUsage = false;
			for (let i = branchEntries.length - 1; i > compactionIndex; i--) {
				const entry = branchEntries[i];
				if (entry.type === "message" && entry.message.role === "assistant") {
					const assistant = entry.message;
					if (assistant.stopReason !== "aborted" && assistant.stopReason !== "error") {
						const contextTokens = assistant.usage ? calculateContextTokens(assistant.usage) : 0;
						if (contextTokens > 0) {
							hasPostCompactionUsage = true;
							break;
						}
					}
				}
			}

			if (!hasPostCompactionUsage) {
				return { tokens: null, contextWindow, percent: null };
			}
		}

		const estimate = estimateContextTokens(this.messages);
		const percent = (estimate.tokens / contextWindow) * 100;

		return {
			tokens: estimate.tokens,
			contextWindow,
			percent,
		};
	}

	/**
	 * Export session to HTML.
	 * @param outputPath Optional output path (defaults to session directory)
	 * @param options Optional export presentation settings
	 * @returns Path to exported file
	 */
	async exportToHtml(outputPath?: string, options: { themeName?: string } = {}): Promise<string> {
		const themeName = [options.themeName, this.settingsManager.getTheme()].find(
			(candidate) => candidate !== undefined && getThemeByName(candidate) !== undefined,
		);

		// Create tool renderer if we have an extension runner (for custom tool HTML rendering)
		const toolRenderer: ToolHtmlRenderer = createToolHtmlRenderer({
			getToolDefinition: (name) => this.getToolDefinition(name),
			theme,
			cwd: this.sessionManager.getCwd(),
		});

		return await exportSessionToHtml(this.sessionManager, this.state, {
			outputPath,
			themeName,
			toolRenderer,
			preset:
				this._activePreset !== defaultPreset && this._activePreset.id !== "pi-default"
					? this._activePreset
					: undefined,
		});
	}

	/**
	 * Export the current session branch to a JSONL file.
	 * Writes the session header followed by all entries on the current branch path.
	 * @param outputPath Target file path. If omitted, generates a timestamped file in cwd.
	 * @returns The resolved output file path.
	 */
	exportToJsonl(outputPath?: string): string {
		const filePath = resolvePath(
			outputPath ?? `session-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
			process.cwd(),
		);
		const dir = dirname(filePath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: this.sessionManager.getSessionId(),
			timestamp: new Date().toISOString(),
			cwd: this.sessionManager.getCwd(),
		};

		const branchEntries = this.sessionManager.getBranch();
		const lines = [JSON.stringify(header)];

		// Re-chain parentIds to form a linear sequence
		let prevId: string | null = null;
		for (const entry of branchEntries) {
			const linear = { ...entry, parentId: prevId };
			lines.push(JSON.stringify(linear));
			prevId = entry.id;
		}

		writeFileSync(filePath, `${lines.join("\n")}\n`);
		return filePath;
	}

	// =========================================================================
	// Utilities
	// =========================================================================

	/**
	 * Get text content of last assistant message.
	 * Useful for /copy command.
	 * @returns Text content, or undefined if no assistant message exists
	 */
	getLastAssistantText(): string | undefined {
		const lastAssistant = this.messages
			.slice()
			.reverse()
			.find((m) => {
				if (m.role !== "assistant") return false;
				const msg = m as AssistantMessage;
				// Skip aborted messages with no content
				if (msg.stopReason === "aborted" && (!msg.content || msg.content.length === 0)) return false;
				return true;
			});

		if (!lastAssistant) return undefined;

		let text = "";
		const lastMsg = lastAssistant as AssistantMessage;
		if (!Array.isArray(lastMsg.content)) return undefined;
		for (const content of lastMsg.content) {
			if (content.type === "text") {
				text += content.text;
			}
		}

		return text.trim() || undefined;
	}

	// =========================================================================
	// Extension System
	// =========================================================================

	createReplacedSessionContext(): ReplacedSessionContext {
		const context = Object.defineProperties(
			{},
			Object.getOwnPropertyDescriptors(this._extensionRunner.createCommandContext()),
		) as ReplacedSessionContext;
		context.sendMessage = (message, options) => this.sendCustomMessage(message, options);
		context.sendUserMessage = (content, options) => this.sendUserMessage(content, options);
		return context;
	}

	/**
	 * Check if extensions have handlers for a specific event type.
	 */
	hasExtensionHandlers(eventType: string): boolean {
		return this._extensionRunner.hasHandlers(eventType);
	}

	/**
	 * Get the extension runner (for setting UI context and error handlers).
	 */
	get extensionRunner(): ExtensionRunner {
		return this._extensionRunner;
	}
}
