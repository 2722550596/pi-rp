import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai/compat";
import type { Skill } from "../skills.ts";
import type { BuildSystemPromptOptions } from "../system-prompt.ts";
import type { PromptRegistryReader } from "./registry-scope.ts";

// =========================================================================
// Prompt Stack
// =========================================================================

export type PromptPresetRole = "system" | "user" | "assistant" | "custom";

export type PromptPresetSlot =
	| "chat-history"
	| "tools"
	| "tool-guidelines"
	| "skills"
	| "project-context"
	| "append-system-prompt"
	| "date"
	| "cwd"
	| "date-cwd"
	| "active-model"
	| "pi-docs"
	| "variables"
	| "state"
	| "file"
	| "awaken"
	| "recent"
	| "index";

// =========================================================================
// Resource Policy (tools/skills allow/deny)
// =========================================================================

export type PromptResourcePolicy = { allow?: string[]; deny?: string[] };

export type PromptPresetSlotFormat = "xml" | "json" | "plain" | "yaml";

/** Custom XML wrapping for a block or slot item's rendered text. */
export interface PromptPresetWrap {
	/** XML tag name, e.g. "context" renders `<context>…</context>`. */
	tag: string;
	/** Optional attributes on the opening tag, e.g. `{ "lang": "zh" }`. */
	attrs?: Record<string, string>;
}

export interface PromptPresetBaseItem {
	kind: "block" | "slot";
	id: string;
	name?: string;
	enabled?: boolean;
	role?: PromptPresetRole;
	/**
	 * Optional text inserted before the rendered item content (block `content`
	 * or slot output). Supports {{macro}} expansion like block content. Applies
	 * to both block and slot items. An item that renders empty content but has
	 * a heading is still rendered (the heading alone), so a declared heading is
	 * never silently dropped.
	 */
	heading?: string;
	/** Optional text appended after the rendered item content. Also supports
	 * {{macro}} expansion. */
	ending?: string;
	/** Wrap the rendered item text in a custom XML tag. */
	wrap?: string | PromptPresetWrap;
}

export interface PromptPresetBlockItem extends PromptPresetBaseItem {
	kind: "block";
	content: string;
}

export interface PromptPresetSlotItem extends PromptPresetBaseItem {
	kind: "slot";
	slot: PromptPresetSlot | string;
	options?: PromptPresetSlotOptions;
}

export interface PromptPresetHistoryItem {
	kind: "history";
	id: string;
	enabled?: boolean;
	/** Legacy chat-history filtering options, retained without normalization loss. */
	options?: PromptPresetSlotOptions;
	ops: HistoryOp[];
}

export type PromptPresetItem = PromptPresetBlockItem | PromptPresetSlotItem | PromptPresetHistoryItem;

export type HistoryOpOrigin =
	| { kind: "preset"; presetId: string; itemId: string; opIndex: number }
	| { kind: "extension"; extensionId: string; opId: string };

export interface HistoryOpContext {
	/** Immutable windowed history snapshot; never includes insert output. */
	readonly messages: readonly AgentMessage[];
	readonly runtime: PromptRuntime;
	/** Host data grouped by explicit provider namespace and key. */
	readonly hostData: Readonly<Record<string, Readonly<Record<string, HistoryHostDataValue>>>>;
	readonly signal: AbortSignal;
}

export interface HistoryHostDataValue {
	readonly value: unknown;
	readonly version?: string | number;
}

export interface HistoryInsertOp {
	readonly op: "insert";
	readonly id: string;
	readonly depth: number;
	/** Preset JSON inserts use content; runtime-registered inserts use render. */
	readonly content?: string;
	readonly async?: boolean;
	render?: (context: HistoryOpContext) => readonly AgentMessage[] | Promise<readonly AgentMessage[]>;
	readonly hostData?: readonly { readonly namespace: string; readonly key: string }[];
}

export type HistoryRegisteredOp = {
	readonly op: HistoryOp;
	readonly origin: HistoryOpOrigin;
	readonly order: number;
};

export interface HistoryHostDataProvider {
	readonly namespace: string;
	readonly get: (key: string, context: PromptRuntime) => unknown | Promise<unknown>;
	readonly version?: (key: string) => string | number | undefined;
}

export type HistoryOp =
	| HistoryInsertOp
	| { readonly op: "keep"; readonly tokens?: number; readonly traces?: number }
	| { readonly op: "reduce"; readonly as: "summary" | "hide" };

export interface VariablesSlotOptions {
	includeStatic?: boolean;
	includeSession?: boolean;
	includeTurn?: boolean;
}

export interface PromptPresetSlotOptions {
	// Shared: tools, tool-guidelines, skills, project-context, variables, state
	format?: PromptPresetSlotFormat;

	// tools slot
	onlyWithSnippets?: boolean;

	// tool-guidelines slot
	heading?: string;
	includePiDefaultGuidelines?: boolean;

	// skills slot
	requireReadTool?: boolean;

	// date / date-cwd slot
	includeTime?: boolean;

	// variables slot
	variables?: VariablesSlotOptions;

	// state slot
	/** Only render these top-level namespaces; empty/unset renders all. */
	allowNamespace?: string[];
	/** Drop the top-level namespace prefix in rendered paths (key-value/yaml/json). */
	omitNamespace?: boolean;

	// chat-history slot
	/** Keep only the most recent N messages (after other filtering). */
	maxMessages?: number;
	/** Keep only the most recent messages within an approximate character budget. */
	maxChars?: number;
	/** If true, skip the latest user message in history (for re-insertion via {{lastUserMessage}}). */
	omitLatestUser?: boolean;
	/**
	 * Remove assistant thinking content blocks from inserted history.
	 * `true` strips thinking from every assistant message; `"previous-traces"`
	 * strips thinking only from assistant messages in traces (agent start to
	 * agent end) that completed before the current trace, keeping the current
	 * trace's thinking intact.
	 */
	stripAssistantThinking?: boolean | "previous-traces";
	/** Filter history to only these roles. */
	roles?: string[];
	/** Keep or drop prior tool call/result messages. */
	toolMode?: "keep" | "drop";
	/**
	 * 与 `toolMode: "drop"` 配合：仅删除名单内工具的历史（assistant 消息里的
	 * toolCall 块 + 对应 toolResult 消息），其余工具历史保留；缺省/空数组 =
	 * 删除全部工具历史（向后兼容现状）。
	 */
	dropToolNames?: string[];
	/** Include Pi branch/compaction summary messages. */
	includeSummaries?: boolean;

	// file slot
	/** File path(s) or glob pattern. */
	path?: string | string[];
	/** Treat path as a glob pattern. */
	glob?: boolean;
	/** Relative path base (cwd or explicit directory). */
	baseDir?: string;
	/** Wrap each file in `<tag path="...">`. */
	xml?: boolean | { tag?: string; attrs?: Record<string, string> };
	/** Strip `---\n...\n---` YAML frontmatter. */
	stripFrontmatter?: boolean;
	/** Only output frontmatter, discard body. */
	onlyFrontmatter?: boolean;
	/** Behavior when a file is missing. */
	onMissing?: "skip" | "error" | "placeholder";
	/** Placeholder text when onMissing is "placeholder". */
	missingText?: string;
	/** Escape `{{` in file content to prevent macro expansion. */
	noMacros?: boolean;
	/** Truncate each file's content to this many chars. */
	maxContentChars?: number;
	/** Reject files larger than this many bytes (default 1 MiB). */
	maxBytes?: number;
	/** Maximum files from a glob match. */
	maxFiles?: number;
	/** Sort glob results by path. */
	sort?: boolean;
	/** Separator between multiple files. */
	separator?: string;
	/** Allow files containing NUL bytes. */
	allowBinary?: boolean;
	/** File read encoding (default "utf-8"). */
	encoding?: string;
}

export interface PromptPresetDefaults {
	/** Default format for slot items. */
	slotFormat?: string;
	/** Whether synthetic messages (branch/continue) are visible in chat-history. */
	syntheticMessagesVisible?: boolean;
	/** How to handle unresolved macros. */
	unresolvedMacroPolicy?: "warn" | "keep" | "error";
}

// =========================================================================
// Hidden Prompt Overrides
// =========================================================================

export interface PromptPresetHiddenOverrides {
	continueText?: string;
	compaction?: {
		systemPrompt?: string;
		initialPrompt?: string;
		updatePrompt?: string;
		turnPrefixPrompt?: string;
		branchSummaryPrompt?: string;
	};
	/**
	 * TEMP 自动整理（autoTidy）提示词覆写。字段语义见
	 * docs/design/temp-autotidy/02（机制）/03（默认文案）。
	 * 恰好两面：tidy 一次运行 = 一个 systemPrompt + 一条任务 user 消息。
	 */
	tempTidy?: {
		/** tidy agent 持久规则（人格、简报风格禁令、任意内容判断框架）。 */
		systemPrompt?: string;
		/** 一次性任务模板（使命表述 + {temp_list} 保留变量）。 */
		taskPrompt?: string;
	};
}
// =========================================================================
// Regex Rules
// =========================================================================

export type PromptRegexStage = "history" | "compiled";

export type PromptRegexEffect = "outgoing" | "display" | "both" | "finalize";

export type PromptRegexTarget = "system" | "messages";

export interface PromptPresetRegexRule {
	id: string;
	name?: string;
	enabled?: boolean;
	stage: PromptRegexStage;
	effect?: PromptRegexEffect;
	pattern: string;
	flags?: string;
	replace?: string;
	trimStrings?: string[];
	roles?: string[];
	targets?: PromptRegexTarget[];
	maxMessages?: number;
	maxChars?: number;
	minDepth?: number;
	maxDepth?: number;
}

export interface PromptPresetRegexConfig {
	schemaVersion?: 1;
	rules: PromptPresetRegexRule[];
}

// =========================================================================
// Runtime
// =========================================================================

export interface PromptPreset {
	schemaVersion: 1;
	type?: "pi-forge.prompt-preset";
	id: string;
	name?: string;
	description?: string;
	/** If true, this preset is auto-activated as the main preset for new sessions. Presets that omit this flag (or set it to false) are never auto-activated; sessions fall back to the built-in default stack. */
	autoActivate?: boolean;
	/** Model to switch to when this preset is activated, in "provider/model" format. */
	model?: string;
	/** If true, this preset can be used as a subagent delegate. */
	delegatable?: boolean;
	/** Default thinking level for subagent delegation. */
	thinkingLevel?: string;
	/** Number of parent conversation messages to seed as chat history when this preset is delegated. */
	inheritHistory?: number;
	/**
	 * Tool-only agent: drop assistant text/thinking content (loop emits no text
	 * deltas; finalized messages keep only toolCall blocks). For two-pass
	 * orchestration where user-visible prose comes from side requests.
	 */
	suppressAssistantText?: boolean;
	/**
	 * Force tool choice on every LLM request while this preset is active (e.g.
	 * `"required"` for a tool-only planner preset: the API rejects a turn that
	 * produces no tool call, instead of relying on prompt discipline).
	 */
	toolChoice?: "auto" | "none" | "required" | { type: "tool"; name: string };
	defaults?: PromptPresetDefaults;
	tools?: PromptResourcePolicy;
	skills?: PromptResourcePolicy;

	/** State schema IDs to load into a subagent session using this preset. */
	schemas?: string[];
	regex?: PromptPresetRegexConfig;
	hiddenOverrides?: PromptPresetHiddenOverrides;
	variables?: Record<string, string>;
	/** Generic extension-owned metadata, isolated by namespace and not rendered into prompts. */
	extensions?: Record<string, Record<string, unknown>>;
	/** Memory-system declaration: preset-level dbPath (lowest precedence in
	 *  the CLI > settings > preset > default chain, docs memory-system §2). */
	memory?: { dbPath?: string };
	items: PromptPresetItem[];
}

// =========================================================================
// Runtime
// =========================================================================

export interface PromptRuntime {
	options: BuildSystemPromptOptions;
	messages: AgentMessage[];
	latestUserMessage?: string;
	now: Date;
	variables: Record<string, string>;
	skills: Skill[];
	/**
	 * Currently selected model, if one is set. Live value: reflects mid-session
	 * model switches, so dynamic macros/slots re-rendered each turn see the
	 * model that will actually answer the current turn.
	 */
	model?: Model<any>;
	/** Current thinking level ("off" when reasoning is disabled). */
	thinkingLevel?: ThinkingLevel;
	/**
	 * Index into `messages` where the current trace (agent start to agent end) begins.
	 * Used by chat-history `stripAssistantThinking: "previous-traces"` to decide which
	 * assistant thinking blocks are historical. When unset, every message is treated
	 * as previous.
	 */
	currentTraceStartIndex?: number;
	/** Current conversation state (game stats, inventory, flags) */
	state?: Record<string, unknown>;
	/** If true, {{macros}} are left unexpanded in the compiled output. */
	skipMacroExpansion?: boolean;
	/** Session-owned slot/macro definitions; omitted for legacy process-global behavior. */
	promptRegistry?: PromptRegistryReader;
	/** Session-scoped dynamic history ops, snapshotted at compile start. */
	historyOps?: readonly HistoryRegisteredOp[];
	/** Host-owned, namespaced history data providers. */
	historyHostData?: readonly HistoryHostDataProvider[];
	/** Cancellation for a live compile / dynamic operation render. */
	signal?: AbortSignal;
}

// =========================================================================
// Compilation Results
// =========================================================================

export type PromptPresetDiagnosticLevel = "error" | "warning" | "info";

export interface PromptPresetDiagnostic {
	level: PromptPresetDiagnosticLevel;
	message: string;
	itemId?: string;
	code?: string;
	origin?: HistoryOpOrigin;
}

export interface CompileSystemPromptResult {
	systemPrompt: string;
	diagnostics: PromptPresetDiagnostic[];
}

export type CompileMessageSourceKind = "preset-item" | "chat-history" | "implicit-history" | "history-op";

export interface CompileMessageSource {
	kind: CompileMessageSourceKind;
	itemId?: string;
	itemName?: string;
	slot?: string;
	opId?: string;
	origin?: HistoryOpOrigin;
}

export interface CompileMessagesResult {
	messages: AgentMessage[];
	sources: CompileMessageSource[];
	diagnostics: PromptPresetDiagnostic[];
}

// =========================================================================
// Slot and Macro Registration (used by ExtensionAPI)
// =========================================================================

export interface LoadedPromptPreset {
	preset: PromptPreset;
	filePath: string;
	diagnostics: PromptPresetDiagnostic[];
	/**
	 * 溯源串（契约 §4）：`inline:<id>` / `opfs:<path>` / `host:<path>`（hosted host-fs）。
	 * node 扫描面不设置（对象形状与 JSON 序列化零差异）；内联通道恒设置。
	 */
	source?: string;
}

/** 内联打包通道的源形状 = loader 返回形状；filePath 允许合成值（如 "inline:cold-open"）。 */
export type LoadedPromptPresetSource = LoadedPromptPreset & { source?: string };

export interface SlotRenderContext {
	runtime: PromptRuntime;
	preset: PromptPreset;
	item: PromptPresetSlotItem;
	diagnostics: PromptPresetDiagnostic[];
}

export type SlotRenderer = (context: SlotRenderContext) => string | Promise<string>;

export interface SlotDefinition {
	name: string;
	description: string;
	/**
	 * Where the slot participates in the compiled output.
	 * - `"chat-history"` marks the conversation insertion point: the compiler
	 *   injects `runtime.messages` at this slot's position instead of rendering
	 *   the slot. The built-in `chat-history` slot uses this.
	 * - `"content"` (default) renders normally via `render`.
	 * The compiler dispatches on this field, not on the slot name.
	 */
	position?: "chat-history" | "content";
	render: SlotRenderer;
	/**
	 * Set to `true` when `render` returns a Promise (async slot). The compiler
	 * then uses the async compile path (parallel rendering) for presets that
	 * include this slot. Async slots are skipped by the synchronous fast path
	 * (`compileMessagesSync` / static system-prompt rebuilds), which renders
	 * them as empty — callers that need their content must use the async
	 * `compileMessages`. Mandatory for async renderers so the sync fast path
	 * never receives an unawaited Promise.
	 */
	async?: boolean;
}

export interface MacroRenderContext {
	runtime: PromptRuntime;
	variables: Record<string, string>;
	/** Optional parameter string from {{name:params}} syntax. */
	params?: string;
}

export type MacroRenderer = (context: MacroRenderContext) => string;

export interface MacroDefinition {
	name: string;
	description: string;
	render: MacroRenderer;
	/** If true, expanded once at system-prompt build time and baked into the template.
	 *  If false (default), the {{macro}} placeholder is preserved and re-expanded each turn. */
	static?: boolean;
}
