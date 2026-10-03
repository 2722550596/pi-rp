export type { CompileMessageSource, CompileMessagesResult, CompileSystemPromptResult } from "./compiler.ts";
export {
	compileMessages,
	compileMessagesSync,
	compileSystemPrompt,
	presetHasAsyncHistoryOps,
	presetHasAsyncSlots,
} from "./compiler.ts";
export { defaultPreset } from "./default-stack.ts";
export type { ExpandMacrosOptions } from "./macro-engine.ts";

export {
	expandContentMacros,
	expandMacros,
	getAllMacros,
	getMacro,
	registerMacro,
} from "./macro-engine.ts";
export { getAllSlots, getSlot, registerSlot, SUPPORTED_SLOTS } from "./slot-registry.ts";
export type {
	HistoryHostDataProvider,
	HistoryHostDataValue,
	HistoryInsertOp,
	HistoryOp,
	HistoryOpContext,
	HistoryOpOrigin,
	HistoryRegisteredOp,
	LoadedPromptPreset,
	LoadedPromptPresetSource,
	MacroDefinition,
	MacroRenderContext,
	MacroRenderer,
	PromptPreset,
	PromptPresetBlockItem,
	PromptPresetDefaults,
	PromptPresetDiagnostic,
	PromptPresetDiagnosticLevel,
	PromptPresetHiddenOverrides,
	PromptPresetHistoryItem,
	PromptPresetItem,
	PromptPresetRegexConfig,
	PromptPresetRegexRule,
	PromptPresetRole,
	PromptPresetSlot,
	PromptPresetSlotItem,
	PromptPresetSlotOptions,
	PromptRegexEffect,
	PromptRegexStage,
	PromptRegexTarget,
	PromptRuntime,
	SlotDefinition,
	SlotRenderContext,
	SlotRenderer,
} from "./types.ts";
