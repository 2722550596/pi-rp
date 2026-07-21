import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Skill } from "../skills.ts";
import type { BuildSystemPromptOptions } from "../system-prompt.ts";

// =========================================================================
// Prompt Stack
// =========================================================================

export type PromptPresetMode = "replace" | "append" | "prepend";

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
	| "variables";

export type PromptPresetSlotFormat = "xml" | "json" | "plain";

export interface PromptPresetBaseItem {
	kind: "block" | "slot";
	id: string;
	name?: string;
	enabled?: boolean;
	role?: PromptPresetRole;
}

export interface PromptPresetBlockItem extends PromptPresetBaseItem {
	kind: "block";
	content: string;
}

export interface VariablesSlotOptions {
	includeStatic?: boolean;
	includeSession?: boolean;
	includeTurn?: boolean;
}

export interface PromptPresetSlotOptions {
	format?: PromptPresetSlotFormat;
	heading?: string;
	includePiDefaultGuidelines?: boolean;
	onlyWithSnippets?: boolean;
	requireReadTool?: boolean;
	includeTime?: boolean;
	variables?: VariablesSlotOptions;
	/** Chat-history: max recent messages to include. */
	maxMessages?: number;
	/** Chat-history: approximate max character count to include. */
	maxChars?: number;
	/** Chat-history: if true, skip the latest user message in history (for re-insertion via {{lastUserMessage}}). */
	omitLatestUser?: boolean;
}

export interface PromptPresetSlotItem extends PromptPresetBaseItem {
	kind: "slot";
	slot: PromptPresetSlot | string;
	options?: PromptPresetSlotOptions;
}

export type PromptPresetItem = PromptPresetBlockItem | PromptPresetSlotItem;

export interface PromptPresetDefaults {
	syntheticMessagesVisible?: boolean;
	unresolvedMacroPolicy?: "warn" | "keep" | "error";
}

export interface PromptPreset {
	schemaVersion: 1;
	type?: "pi-forge.prompt-preset";
	id: string;
	name?: string;
	description?: string;
	autoActivate?: boolean;
	mode?: PromptPresetMode;
	defaults?: PromptPresetDefaults;
	variables?: Record<string, string>;
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
	render: SlotRenderer;
}

export interface MacroRenderContext {
	runtime: PromptRuntime;
	variables: Record<string, string>;
}

export type MacroRenderer = (context: MacroRenderContext) => string;

export interface MacroDefinition {
	name: string;
	description: string;
	render: MacroRenderer;
}
