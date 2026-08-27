import { stringify } from "yaml";
import { getDocsPath, getExamplesPath, getReadmePath } from "../../config.ts";
import { formatSkillsForPrompt } from "../skills.ts";
import { applyResourcePolicy } from "./policy.ts";
import type {
	PromptPreset,
	PromptPresetDiagnostic,
	PromptPresetItem,
	PromptPresetSlotItem,
	PromptRuntime,
	SlotDefinition,
	SlotRenderContext,
} from "./types.ts";

// =========================================================================
// Slot Registry
// =========================================================================

const builtInSlots = new Map<string, SlotDefinition>();
const customSlots = new Map<string, SlotDefinition>();

export function registerSlot(definition: SlotDefinition, isBuiltIn = false): void {
	const registry = isBuiltIn ? builtInSlots : customSlots;
	registry.set(definition.name, definition);
}

export function getSlot(name: string): SlotDefinition | undefined {
	return builtInSlots.get(name) ?? customSlots.get(name);
}

export function getAllSlots(): SlotDefinition[] {
	return [...builtInSlots.values(), ...customSlots.values()];
}

/**
 * True when the item is a slot whose registered definition marks the
 * chat-history position. The compiler dispatches on position, so a custom
 * slot registered with `position: "chat-history"` is the insertion point
 * regardless of its name.
 */
export function isChatHistoryPosition(item: PromptPresetItem): boolean {
	return item.kind === "slot" && getSlot(item.slot)?.position === "chat-history";
}

/** Set of built-in slot names for validation. */
export const SUPPORTED_SLOTS = new Set<string>([
	"chat-history",
	"tools",
	"tool-guidelines",
	"skills",
	"project-context",
	"append-system-prompt",
	"date",
	"cwd",
	"date-cwd",
	"active-model",
	"pi-docs",
	"variables",
	"state",
]);

// =========================================================================
// Render Helpers
// =========================================================================

function getToolGuidelines(selectedTools: string[] | undefined, customGuidelines: string[] | undefined): string[] {
	const guidelinesList: string[] = [];
	const guidelinesSet = new Set<string>();
	const addGuideline = (guideline: string): void => {
		if (guidelinesSet.has(guideline)) return;
		guidelinesSet.add(guideline);
		guidelinesList.push(guideline);
	};

	const tools = selectedTools ?? ["read", "bash", "edit", "write"];
	const hasBash = tools.includes("bash");
	const hasGrep = tools.includes("grep");
	const hasFind = tools.includes("find");
	const hasLs = tools.includes("ls");

	if (hasBash && !hasGrep && !hasFind && !hasLs) {
		addGuideline("Use bash for file operations like ls, rg, find");
	}

	for (const guideline of customGuidelines ?? []) {
		const normalized = guideline.trim();
		if (normalized.length > 0) addGuideline(normalized);
	}

	addGuideline("Be concise in your responses");
	addGuideline("Show file paths clearly when working with files");

	return guidelinesList;
}

// =========================================================================
// Built-in Slot Renderers
// =========================================================================

registerSlot(
	{
		name: "tools",
		description: "Available tools with snippets.",
		render: (ctx: SlotRenderContext): string => {
			const { selectedTools, toolSnippets } = ctx.runtime.options;
			const tools = applyResourcePolicy(selectedTools ?? ["read", "bash", "edit", "write"], ctx.preset.tools);
			const onlyWithSnippets = ctx.item.options?.onlyWithSnippets !== false;
			const visibleTools = onlyWithSnippets ? tools.filter((name) => !!toolSnippets?.[name]) : tools;
			return visibleTools.length > 0
				? visibleTools.map((name) => `- ${name}: ${toolSnippets![name]}`).join("\n")
				: "(none)";
		},
	},
	true,
);

registerSlot(
	{
		name: "tool-guidelines",
		description: "Guidelines for tool usage.",
		render: (ctx: SlotRenderContext): string => {
			const { selectedTools, promptGuidelines } = ctx.runtime.options;
			const tools = applyResourcePolicy(selectedTools ?? ["read", "bash", "edit", "write"], ctx.preset.tools);
			const includeDefault = ctx.item.options?.includePiDefaultGuidelines !== false;
			const heading = ctx.item.options?.heading ?? "Guidelines:";
			const guidelines = includeDefault ? getToolGuidelines(tools, promptGuidelines) : (promptGuidelines ?? []);
			if (guidelines.length === 0) return "";
			return `${heading}\n${guidelines.map((g) => `- ${g}`).join("\n")}`;
		},
	},
	true,
);

registerSlot(
	{
		name: "pi-docs",
		description: "Pi documentation guidance.",
		render: (_ctx: SlotRenderContext): string => {
			const readmePath = getReadmePath();
			const docsPath = getDocsPath();
			const examplesPath = getExamplesPath();
			return `Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: ${readmePath}
- Additional docs: ${docsPath}
- Examples: ${examplesPath} (extensions, custom tools, SDK)
- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md)
- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing
- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)`;
		},
	},
	true,
);

registerSlot(
	{
		name: "append-system-prompt",
		description: "User appended system prompt text.",
		render: (ctx: SlotRenderContext): string => {
			return ctx.runtime.options.appendSystemPrompt ?? "";
		},
	},
	true,
);

registerSlot(
	{
		name: "project-context",
		description: "Project context files.",
		render: (ctx: SlotRenderContext): string => {
			const contextFiles = ctx.runtime.options.contextFiles ?? [];
			if (contextFiles.length === 0) return "";
			const parts: string[] = ["<project_context>\n"];
			parts.push("Project-specific instructions and guidelines:\n");
			for (const { path: filePath, content } of contextFiles) {
				parts.push(`<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n`);
			}
			parts.push("</project_context>");
			return parts.join("\n");
		},
	},
	true,
);

registerSlot(
	{
		name: "skills",
		description: "Available skills.",
		render: (ctx: SlotRenderContext): string => {
			const { selectedTools, skills } = ctx.runtime.options;
			const requireRead = ctx.item.options?.requireReadTool !== false;
			const hasRead = !selectedTools || selectedTools.includes("read");
			if (requireRead && !hasRead) return "";
			const filteredSkills = (skills ?? [])
				.filter((s) => !s.disableModelInvocation)
				.filter((s) => applyResourcePolicy([s.name], ctx.preset.skills).length > 0);
			return formatSkillsForPrompt(filteredSkills);
		},
	},
	true,
);

registerSlot(
	{
		name: "date-cwd",
		description: "Current date and working directory.",
		render: (ctx: SlotRenderContext): string => {
			const now = ctx.runtime.now;
			const y = now.getFullYear();
			const m = String(now.getMonth() + 1).padStart(2, "0");
			const d = String(now.getDate()).padStart(2, "0");
			const cwd = ctx.runtime.options.cwd.replace(/\\/g, "/");
			return `Current date: ${y}-${m}-${d}\nCurrent working directory: ${cwd}`;
		},
	},
	true,
);

registerSlot(
	{
		name: "date",
		description: "Current date.",
		render: (ctx: SlotRenderContext): string => {
			const now = ctx.runtime.now;
			const y = now.getFullYear();
			const m = String(now.getMonth() + 1).padStart(2, "0");
			const d = String(now.getDate()).padStart(2, "0");
			let text = `Current date: ${y}-${m}-${d}`;
			if (ctx.item.options?.includeTime) {
				const h = String(now.getHours()).padStart(2, "0");
				const min = String(now.getMinutes()).padStart(2, "0");
				const s = String(now.getSeconds()).padStart(2, "0");
				text += `\nCurrent time: ${h}:${min}:${s}`;
			}
			return text;
		},
	},
	true,
);

registerSlot(
	{
		name: "cwd",
		description: "Current working directory.",
		render: (ctx: SlotRenderContext): string => {
			return `Current working directory: ${ctx.runtime.options.cwd.replace(/\\/g, "/")}`;
		},
	},
	true,
);

registerSlot(
	{
		name: "active-model",
		description: "Current model provider/id.",
		render: (ctx: SlotRenderContext): string => {
			const model = ctx.runtime.model;
			if (!model) return "";
			return `${model.provider}/${model.id}`;
		},
	},
	true,
);

registerSlot(
	{
		name: "chat-history",
		description: "Conversation history insertion point.",
		position: "chat-history",
		render: (_ctx: SlotRenderContext): string => {
			return "";
		},
	},
	true,
);

registerSlot(
	{
		name: "variables",
		description: "Template variables.",
		render: (ctx: SlotRenderContext): string => {
			const variables = ctx.runtime.variables ?? {};
			const keys = Object.keys(variables);
			if (keys.length === 0) return "";
			return keys.map((key) => `${key}: ${variables[key]}`).join("\n");
		},
	},
	true,
);

registerSlot(
	{
		name: "state",
		description: "Current conversation state.",
		render: (ctx: SlotRenderContext): string => {
			const rawState = ctx.runtime.state;
			if (!rawState || Object.keys(rawState).length === 0) return "";
			const options = ctx.item.options ?? {};
			const filtered = filterNamespaces(rawState, options.allowNamespace);
			if (Object.keys(filtered).length === 0) return "";
			const state = options.omitNamespace === true ? unwrapNamespaces(filtered) : filtered;
			const format = options.format ?? "key-value";
			if (format === "json") return JSON.stringify(state, null, 2);
			if (format === "yaml") return stringify(state);
			return formatStateKeyValue(state);
		},
	},
	true,
);

/**
 * Keep only the top-level namespaces listed in `allow`. Undefined or an empty
 * array means no filtering (all namespaces render), matching chat-history
 * `roles` semantics. Namespaces not listed are dropped.
 */
function filterNamespaces(state: Record<string, unknown>, allow?: string[]): Record<string, unknown> {
	if (!allow || allow.length === 0) return state;
	const allowed = new Set(allow);
	const filtered: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(state)) {
		if (allowed.has(key)) filtered[key] = value;
	}
	return filtered;
}

/**
 * Drop the top-level namespace prefix by merging each object-typed namespace's
 * entries into the root. Scalar top-level values keep their key (there is no
 * namespace level to omit). Identical inner keys from different namespaces
 * overwrite each other (last namespace wins).
 */
function unwrapNamespaces(state: Record<string, unknown>): Record<string, unknown> {
	const merged: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(state)) {
		if (value !== null && typeof value === "object" && !Array.isArray(value)) {
			Object.assign(merged, value);
		} else {
			merged[key] = value;
		}
	}
	return merged;
}

/** Recursively format state as indented key-value text. */
function formatStateKeyValue(obj: Record<string, unknown>, prefix = "", depth = 0, maxDepth = 5): string {
	if (depth >= maxDepth) return `${prefix}: [max depth]`;
	const lines: string[] = [];
	for (const [key, value] of Object.entries(obj)) {
		const fullKey = prefix ? `${prefix}.${key}` : key;
		if (value === null || value === undefined) {
			lines.push(`${fullKey}: null`);
		} else if (typeof value === "object" && !Array.isArray(value)) {
			lines.push(formatStateKeyValue(value as Record<string, unknown>, fullKey, depth + 1, maxDepth));
		} else if (Array.isArray(value)) {
			if (value.length === 0) {
				lines.push(`${fullKey}: []`);
			} else {
				lines.push(`${fullKey}:`);
				for (const item of value) {
					lines.push(`  - ${JSON.stringify(item)}`);
				}
			}
		} else {
			lines.push(`${fullKey}: ${JSON.stringify(value)}`);
		}
	}
	return lines.join("\n");
}

// =========================================================================
// Slot Rendering
// =========================================================================

export function renderSlot(
	item: PromptPresetSlotItem,
	preset: PromptPreset,
	runtime: PromptRuntime,
	diagnostics: PromptPresetDiagnostic[],
): string {
	const slotDef = getSlot(item.slot);
	if (!slotDef) {
		diagnostics.push({
			level: "warning",
			message: `Unknown slot "${item.slot}"`,
			itemId: item.id,
		});
		return `[unknown slot: ${item.slot}]`;
	}

	const ctx: SlotRenderContext = { runtime, preset, item, diagnostics };
	return slotDef.render(ctx);
}
