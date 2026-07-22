import { contentToText } from "./content-utils.ts";
import type { MacroDefinition, PromptRuntime } from "./types.ts";

// =========================================================================
// Macro Registry
// =========================================================================

const builtInMacros = new Map<string, MacroDefinition>();
const customMacros = new Map<string, MacroDefinition>();

/** Register a built-in or custom macro definition. */
export function registerMacro(definition: MacroDefinition, isBuiltIn = false): void {
	const registry = isBuiltIn ? builtInMacros : customMacros;
	registry.set(definition.name, definition);
}

/** Get all registered macros. */
export function getAllMacros(): MacroDefinition[] {
	return [...builtInMacros.values(), ...customMacros.values()];
}

/** Get a registered macro by name. */
export function getMacro(name: string): MacroDefinition | undefined {
	return builtInMacros.get(name) ?? customMacros.get(name);
}

// =========================================================================
// Built-in Macro Definitions
// =========================================================================

function formatDate(date: Date): string {
	const y = date.getFullYear();
	const m = String(date.getMonth() + 1).padStart(2, "0");
	const d = String(date.getDate()).padStart(2, "0");
	return `${y}-${m}-${d}`;
}

function formatTime(date: Date): string {
	const h = String(date.getHours()).padStart(2, "0");
	const m = String(date.getMinutes()).padStart(2, "0");
	const s = String(date.getSeconds()).padStart(2, "0");
	return `${h}:${m}:${s}`;
}

registerMacro(
	{
		name: "date",
		description: "Current date (YYYY-MM-DD).",
		render: (ctx) => formatDate(ctx.runtime.now),
		static: true,
	},
	true,
);

registerMacro(
	{
		name: "time",
		description: "Current time (HH:MM:SS).",
		render: (ctx) => formatTime(ctx.runtime.now),
		static: true,
	},
	true,
);

registerMacro(
	{
		name: "cwd",
		description: "Current working directory.",
		render: (ctx) => ctx.runtime.options.cwd.replace(/\\/g, "/"),
		static: true,
	},
	true,
);

registerMacro(
	{
		name: "lastUserMessage",
		description: "The user's latest message.",
		render: (ctx) => ctx.runtime.latestUserMessage ?? "",
		static: true,
	},
	true,
);

registerMacro(
	{
		name: "tools",
		description: "Comma-separated active tool names.",
		render: (ctx) => (ctx.runtime.options.selectedTools ?? []).join(", "),
		static: true,
	},
	true,
);

registerMacro(
	{
		name: "selectedTools",
		description: "Alias for tools.",
		render: (ctx) => (ctx.runtime.options.selectedTools ?? []).join(", "),
		static: true,
	},
	true,
);

registerMacro(
	{
		name: "activeModel",
		description: "Current model provider/id.",
		render: () => "",
		static: true,
	},
	true,
);

// =========================================================================
// Macro Expansion
// =========================================================================

const MACRO_PATTERN = /\{\{(\w[\w.]*)(?::([^}]*))?\}\}/g;

export interface ExpandMacrosOptions {
	resolveVariable?: (name: string) => string | undefined;
	unresolvedPolicy?: "warn" | "keep" | "error";
	/**
	 * "all" (default): expand every macro.
	 * "static": only expand macros with `static: true` in their definition.
	 * "dynamic": only expand macros without `static: true`.
	 */
	mode?: "all" | "static" | "dynamic";
}

/**
 * Expand {{macros}} in the given text.
 * Built-in macros take precedence, then stack variables, then registered custom macros.
 * Supports {{name:params}} syntax — params is passed to the macro's render context.
 */
export function expandMacros(text: string, runtime: PromptRuntime, _options?: ExpandMacrosOptions): string {
	const variables = runtime.variables ?? {};
	const options: ExpandMacrosOptions = { mode: "all", ..._options };

	return text.replace(MACRO_PATTERN, (_match: string, name: string, params?: string) => {
		// 1. Built-in macro
		const macro = getMacro(name);
		if (macro) {
			const isStatic = macro.static === true;
			const shouldExpand =
				options.mode === "all" ||
				(options.mode === "static" && isStatic) ||
				(options.mode === "dynamic" && !isStatic);
			if (shouldExpand) {
				return macro.render({ runtime, variables, params });
			}
			return _match;
		}

		// 2. Stack variable (always expanded)
		if (name in variables) {
			return String(variables[name]);
		}

		// 3. Unresolved — return as-is
		return _match;
	});
}

/** Expand macros in a multi-item content value (string or content array). */
export function expandContentMacros(
	content: string | unknown[],
	runtime: PromptRuntime,
	options?: ExpandMacrosOptions,
): string {
	if (typeof content === "string") {
		return expandMacros(content, runtime, options);
	}
	return expandMacros(contentToText(content as { type: string; text?: string }[]), runtime, options);
}
