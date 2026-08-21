import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Skill } from "../skills.ts";
import type { BuildSystemPromptOptions } from "../system-prompt.ts";

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
	| "state";

// =========================================================================
// Resource Policy (tools/skills allow/deny)
// =========================================================================

export type PromptResourcePolicy = { allow?: string[]; deny?: never } | { allow?: never; deny?: string[] };

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
	 * Wrap the rendered item text in a custom XML tag — a shorthand for
	 * `<tag>…</tag>` (with optional `attrs`) around a block or slot. Applied
	 * after macro expansion; skipped when the item renders empty.
	 */
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

export type PromptPresetItem = PromptPresetBlockItem | PromptPresetSlotItem;

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
	/** Include Pi branch/compaction summary messages. */
	includeSummaries?: boolean;
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
	autoActivate?: boolean;
	/** Model to switch to when this preset is activated, in "provider/model" format. */
	model?: string;
	/** If true, this preset can be used as a subagent delegate. */
	delegatable?: boolean;
	/** Default thinking level for subagent delegation. */
	thinkingLevel?: string;
	/** Number of parent conversation messages to seed as chat history when this preset is delegated. */
	inheritHistory?: number;
	defaults?: PromptPresetDefaults;
	tools?: PromptResourcePolicy;
	skills?: PromptResourcePolicy;

	/** State schema IDs to load into a subagent session using this preset. */
	schemas?: string[];
	regex?: PromptPresetRegexConfig;
	hiddenOverrides?: PromptPresetHiddenOverrides;
	variables?: Record<string, string>;
	items: PromptPresetItem[];
}

// =========================================================================
// Runtime
// =========================================================================

export interface PromptRuntime {
	options: BuildSystemPromptOptions;
	messages: AgentMessage[];
	now: Date;
	variables: Record<string, string>;
	skills: Skill[];
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
}

// =========================================================================
// Compilation Results
// =========================================================================

export type PromptPresetDiagnosticLevel = "error" | "warning" | "info";

export interface PromptPresetDiagnostic {
	level: PromptPresetDiagnosticLevel;
	message: string;
	itemId?: string;
}

export interface CompileSystemPromptResult {
	systemPrompt: string;
	diagnostics: PromptPresetDiagnostic[];
}

export type CompileMessageSourceKind = "preset-item" | "chat-history" | "implicit-history";

export interface CompileMessageSource {
	kind: CompileMessageSourceKind;
	itemId?: string;
	itemName?: string;
	slot?: string;
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
}

export interface SlotRenderContext {
	runtime: PromptRuntime;
	preset: PromptPreset;
	item: PromptPresetSlotItem;
	diagnostics: PromptPresetDiagnostic[];
}

export type SlotRenderer = (context: SlotRenderContext) => string;

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
