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

// SillyTavern-style variable macros (non-static, each turn may use different values)
registerMacro(
	{
		name: "setvar",
		description: "Set a session variable. Usage: {{setvar::key::value}}",
		render: (ctx) => {
			if (!ctx.params) return "";
			const stripped = ctx.params.startsWith(":") ? ctx.params.slice(1) : ctx.params;
			const sep = stripped.includes("::") ? "::" : ":";
			const idx = stripped.indexOf(sep);
			if (idx === -1) return "";
			const value = stripped.slice(idx + sep.length);
			ctx.runtime.variables[stripped.slice(0, idx)] = value;
			return "";
		},
	},
	true,
);

registerMacro(
	{
		name: "addvar",
		description: "Append to a session variable. Usage: {{addvar::key::value}}",
		render: (ctx) => {
			if (!ctx.params) return "";
			const stripped = ctx.params.startsWith(":") ? ctx.params.slice(1) : ctx.params;
			const sep = stripped.includes("::") ? "::" : ":";
			const idx = stripped.indexOf(sep);
			if (idx === -1) return "";
			const key = stripped.slice(0, idx);
			const value = stripped.slice(idx + sep.length);
			ctx.runtime.variables[key] = (ctx.runtime.variables[key] ?? "") + value;
			return "";
		},
	},
	true,
);

registerMacro(
	{
		name: "getvar",
		description: "Get a session variable. Usage: {{getvar::key}}",
		render: (ctx) => {
			if (!ctx.params) return "";
			const key = ctx.params.startsWith(":") ? ctx.params.slice(1) : ctx.params;
			return ctx.variables[key] ?? "";
		},
	},
	true,
);

const TRIM_MARKER = "\uE000TRIM\uE000";

registerMacro(
	{
		name: "trim",
		description: "Removes leading/trailing whitespace from adjacent content.",
		render: () => TRIM_MARKER,
	},
	true,
);

registerMacro(
	{
		name: "user",
		description: "The user's display name (from settings.userName).",
		render: (ctx) => ctx.variables["user"] ?? "user",
	},
	true,
);

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
 * SillyTavern-style {{//comments}} are stripped.
 *
 * Note: Uses a depth-tracking state machine for inside-out recursive parsing
 * to safely handle deeply nested macros (e.g., {{setvar::key::{{user}}}}).
 */
export function expandMacros(text: string, runtime: PromptRuntime, _options?: ExpandMacrosOptions): string {
	const variables = runtime.variables ?? {};
	const options: ExpandMacrosOptions = { mode: "all", ..._options };

	function processText(input: string): string {
		let result = "";
		let i = 0;

		while (i < input.length) {
			if (input.startsWith("{{", i)) {
				let depth = 1;
				let j = i + 2;

				while (j < input.length && depth > 0) {
					if (input.startsWith("{{", j)) {
						depth++;
						j += 2;
					} else if (input.startsWith("}}", j)) {
						depth--;
						if (depth === 0) break;
						j += 2;
					} else {
						j++;
					}
				}

				if (depth === 0) {
					const rawContent = input.slice(i + 2, j);
					const expandedContent = processText(rawContent);

					if (expandedContent.startsWith("//")) {
						i = j + 2;
						continue;
					}

					const match = expandedContent.match(/^(\w[\w.]*)(?::([\s\S]*))?$/);
					if (match) {
						const name = match[1];
						const params = match[2];

						const macro = getMacro(name);
						if (macro) {
							const isStatic = macro.static === true;
							const shouldExpand =
								options.mode === "all" ||
								(options.mode === "static" && isStatic) ||
								(options.mode === "dynamic" && !isStatic);

							if (shouldExpand) {
								result += macro.render({ runtime, variables, params });
							} else {
								result += `{{${expandedContent}}}`;
							}
						} else if (name in variables) {
							result += String(variables[name]);
						} else {
							result += `{{${expandedContent}}}`;
						}
					} else {
						result += `{{${expandedContent}}}`;
					}
					i = j + 2;
				} else {
					result += "{{";
					i += 2;
				}
			} else {
				result += input[i];
				i++;
			}
		}
		return result;
	}

	return processText(text).replace(new RegExp(`\\s*${TRIM_MARKER}\\s*`, "g"), "");
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
