import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getProjectConfigDir } from "../../config.ts";
import { validateRegexConfig } from "./regex-engine.ts";
import { SUPPORTED_SLOTS } from "./slot-renderers.ts";
import type {
	LoadedPromptPreset,
	PromptPreset,
	PromptPresetDiagnostic,
	PromptPresetHiddenOverrides,
	PromptPresetItem,
	PromptPresetRegexConfig,
	PromptPresetRole,
	PromptPresetSlot,
	PromptResourcePolicy,
} from "./types.ts";

const PROMPT_PRESET_DIR = "prompt-presets";

const VALID_ROLES = new Set(["system", "user", "assistant", "custom"]);

// =========================================================================
// Public API
// =========================================================================

export function promptPresetsDir(parentDir: string): string {
	return join(parentDir, PROMPT_PRESET_DIR);
}

export function promptPresetsProjectDir(cwd: string): string {
	return getProjectConfigDir(cwd, PROMPT_PRESET_DIR);
}

export function loadPromptPresets(cwd: string, agentDir?: string): LoadedPromptPreset[] {
	const dirs: string[] = [];
	if (agentDir) dirs.push(join(agentDir, PROMPT_PRESET_DIR));
	dirs.push(getProjectConfigDir(cwd, PROMPT_PRESET_DIR));

	const presets: LoadedPromptPreset[] = [];
	for (const dir of dirs) {
		if (!existsSync(dir)) continue;
		const files = readdirSync(dir)
			.filter((f) => f.endsWith(".json"))
			.map((f) => join(dir, f));
		for (const filePath of files) {
			const loaded = loadPromptPresetFile(filePath);
			// Project presets override global ones with the same ID
			const existing = presets.findIndex((p) => p.preset.id === loaded.preset.id);
			if (existing !== -1) {
				presets[existing] = loaded;
			} else {
				presets.push(loaded);
			}
		}
	}

	annotateDuplicatePresetIds(presets);
	return presets;
}

export function chooseDefaultPreset(
	presets: LoadedPromptPreset[],
	preferredId?: string,
): LoadedPromptPreset | undefined {
	if (preferredId && preferredId !== "none" && preferredId !== "off") {
		const preferred = presets.find(
			(p) => p.preset.id === preferredId && !p.diagnostics.some((d) => d.level === "error"),
		);
		if (preferred) return preferred;
	}

	for (const p of presets) {
		if (p.diagnostics.some((d) => d.level === "error")) continue;
		if (p.preset.autoActivate !== false) return p;
	}

	// Every usable preset opted out of auto-activation (or none loaded):
	// return nothing so callers fall back to the built-in default stack.
	return undefined;
}

export function isUsablePromptPreset(loaded: LoadedPromptPreset): boolean {
	return !loaded.diagnostics.some((d) => d.level === "error");
}

export function isDisabledPromptPresetId(id: string | undefined): boolean {
	return id === "none" || id === "off" || id === "default";
}

// =========================================================================
// Internal
// =========================================================================

function loadPromptPresetFile(filePath: string): LoadedPromptPreset {
	const diagnostics: PromptPresetDiagnostic[] = [];
	let raw: unknown;

	try {
		const content = readFileSync(filePath, "utf-8");
		raw = JSON.parse(content);
	} catch (error) {
		return {
			preset: fallbackPreset(filePath),
			filePath,
			diagnostics: [
				{
					level: "error",
					message: `Failed to parse preset file: ${error instanceof Error ? error.message : String(error)}`,
				},
			],
		};
	}

	const preset = normalizePreset(raw, filePath, diagnostics);
	return { preset, filePath, diagnostics };
}

function fallbackPreset(filePath: string): PromptPreset {
	const id =
		filePath
			.replace(/\.json$/, "")
			.split("/")
			.pop() ?? "unknown";
	return { schemaVersion: 1, id, items: [] };
}

function annotateDuplicatePresetIds(presets: LoadedPromptPreset[]): void {
	const seen = new Map<string, number>();
	for (const p of presets) {
		const count = (seen.get(p.preset.id) ?? 0) + 1;
		seen.set(p.preset.id, count);
	}
	for (const p of presets) {
		if ((seen.get(p.preset.id) ?? 0) > 1) {
			p.diagnostics.push({
				level: "error",
				message: `Duplicate preset id "${p.preset.id}". Only the first one with a given id is used.`,
			});
		}
	}
}

// =========================================================================
// Normalization
// =========================================================================

function normalizePreset(raw: unknown, filePath: string, diagnostics: PromptPresetDiagnostic[]): PromptPreset {
	if (!isPlainObject(raw)) {
		diagnostics.push({ level: "error", message: "Preset must be a JSON object." });
		return fallbackPreset(filePath);
	}

	const obj = raw as Record<string, unknown>;
	const id = normalizeId(obj.id, filePath);

	if (obj.schemaVersion !== 1) {
		diagnostics.push({
			level: "error",
			message: `Unsupported schemaVersion "${String(obj.schemaVersion)}". Only schemaVersion 1 is supported.`,
		});
		return { schemaVersion: 1, id, items: [] };
	}

	const variables = normalizeStringRecord(obj.variables);
	const items = normalizeItems(obj.items, diagnostics);

	const preset: PromptPreset = { schemaVersion: 1, id, items };
	if (typeof obj.name === "string") preset.name = obj.name;
	if (typeof obj.description === "string") preset.description = obj.description;
	if (obj.autoActivate === false) preset.autoActivate = false;
	if (typeof obj.model === "string" && obj.model.trim().length > 0) {
		preset.model = obj.model;
	}
	if (variables) preset.variables = variables;
	if (obj.delegatable === true) preset.delegatable = true;
	if (typeof obj.thinkingLevel === "string" && obj.thinkingLevel.trim().length > 0) {
		preset.thinkingLevel = obj.thinkingLevel.trim();
	}
	if (typeof obj.inheritHistory === "number" && Number.isFinite(obj.inheritHistory) && obj.inheritHistory > 0) {
		preset.inheritHistory = Math.floor(obj.inheritHistory);
	}
	if (isPlainObject(obj.defaults)) {
		const d = obj.defaults as Record<string, unknown>;
		preset.defaults = {};
		if (typeof d.unresolvedMacroPolicy === "string") {
			preset.defaults.unresolvedMacroPolicy = d.unresolvedMacroPolicy as "warn" | "keep" | "error";
		}
	}

	// Normalize tools and skills resource policies
	if (obj.tools !== undefined) {
		preset.tools = normalizeResourcePolicy(obj.tools, "tools", diagnostics);
	}
	if (obj.skills !== undefined) {
		preset.skills = normalizeResourcePolicy(obj.skills, "skills", diagnostics);
	}
	// Normalize state schema IDs
	if (Array.isArray(obj.schemas)) {
		preset.schemas = obj.schemas.filter((s): s is string => typeof s === "string");
	}

	// Validate and copy regex config
	if (obj.regex !== undefined) {
		const regexDiags = validateRegexConfig(obj.regex);
		diagnostics.push(...regexDiags);
		preset.regex = obj.regex as PromptPresetRegexConfig;
	}

	// Copy hidden prompt overrides
	if (isPlainObject(obj.hiddenOverrides)) {
		const ho = obj.hiddenOverrides as Record<string, unknown>;
		const overrides: PromptPreset["hiddenOverrides"] = {};
		if (typeof ho.continueText === "string") {
			overrides.continueText = ho.continueText;
		}
		if (isPlainObject(ho.compaction)) {
			const c = ho.compaction as Record<string, unknown>;
			const compaction: NonNullable<typeof overrides.compaction> = {};
			if (typeof c.systemPrompt === "string") compaction.systemPrompt = c.systemPrompt;
			if (typeof c.initialPrompt === "string") compaction.initialPrompt = c.initialPrompt;
			if (typeof c.updatePrompt === "string") compaction.updatePrompt = c.updatePrompt;
			if (typeof c.turnPrefixPrompt === "string") compaction.turnPrefixPrompt = c.turnPrefixPrompt;
			if (typeof c.branchSummaryPrompt === "string") compaction.branchSummaryPrompt = c.branchSummaryPrompt;
			if (Object.keys(compaction).length > 0) overrides.compaction = compaction;
		}
		if (Object.keys(overrides).length > 0) {
			preset.hiddenOverrides = overrides as PromptPresetHiddenOverrides;
		}
	}

	return preset;
}

function normalizeItems(raw: unknown, diagnostics: PromptPresetDiagnostic[]): PromptPresetItem[] {
	if (!Array.isArray(raw)) {
		diagnostics.push({ level: "warning", message: "Preset items must be an array." });
		return [];
	}

	const items: PromptPresetItem[] = [];
	for (let i = 0; i < raw.length; i++) {
		const item = normalizeItem(raw[i], i, diagnostics);
		if (item) items.push(item);
	}
	return items;
}

function normalizeItem(
	raw: unknown,
	index: number,
	diagnostics: PromptPresetDiagnostic[],
): PromptPresetItem | undefined {
	if (!isPlainObject(raw)) {
		diagnostics.push({ level: "error", message: `Item at index ${index} must be a JSON object.` });
		return undefined;
	}

	const obj = raw as Record<string, unknown>;
	const kind = obj.kind;

	if (kind !== "block" && kind !== "slot") {
		diagnostics.push({ level: "error", message: `Item at index ${index} has invalid kind "${String(kind)}".` });
		return undefined;
	}

	const base: { kind: "block" | "slot"; id: string; name?: string; enabled?: boolean; role?: PromptPresetRole } = {
		kind: kind as "block" | "slot",
		id: normalizeId(obj.id, `item[${index}]`),
	};
	if (typeof obj.name === "string") base.name = obj.name;
	if (obj.enabled === false) base.enabled = false;
	if (typeof obj.role === "string" && (VALID_ROLES as Set<string>).has(obj.role)) {
		base.role = obj.role as PromptPresetRole;
	}

	if (kind === "block") {
		if (typeof obj.content !== "string") {
			diagnostics.push({
				level: "error",
				message: `Block item "${base.id}" is missing required string field "content".`,
				itemId: base.id,
			});
			return undefined;
		}
		return { ...base, kind: "block", content: obj.content };
	}

	// slot
	const slot = String(obj.slot ?? "");
	if (!slot) {
		diagnostics.push({
			level: "error",
			message: `Slot item "${base.id}" is missing required field "slot".`,
			itemId: base.id,
		});
		return undefined;
	}

	const isBuiltIn = SUPPORTED_SLOTS.has(slot as PromptPresetSlot);
	if (!isBuiltIn) {
		diagnostics.push({
			level: "warning",
			message: `Unknown slot "${slot}" in item "${base.id}". Custom slots must be registered before use.`,
			itemId: base.id,
		});
	}

	const options = isPlainObject(obj.options) ? (obj.options as Record<string, unknown>) : undefined;
	return {
		...base,
		kind: "slot",
		slot,
		options: options ? normalizeSlotOptions(options) : undefined,
	};
}

function normalizeSlotOptions(options: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	if (typeof options.format === "string") result.format = options.format;
	if (typeof options.heading === "string") result.heading = options.heading;
	if (options.includePiDefaultGuidelines === true) result.includePiDefaultGuidelines = true;
	if (options.omitNamespace === true) result.omitNamespace = true;
	if (Array.isArray(options.allowNamespace)) {
		result.allowNamespace = options.allowNamespace.filter((n): n is string => typeof n === "string");
	}
	if (options.onlyWithSnippets === false) result.onlyWithSnippets = false;
	if (options.requireReadTool === false) result.requireReadTool = false;
	if (options.includeTime === true) result.includeTime = true;
	if (typeof options.omitLatestUser === "boolean") result.omitLatestUser = options.omitLatestUser;
	if (typeof options.maxMessages === "number") result.maxMessages = options.maxMessages;
	if (typeof options.maxChars === "number") result.maxChars = options.maxChars;
	if (options.stripAssistantThinking === true || options.stripAssistantThinking === "previous-traces") {
		result.stripAssistantThinking = options.stripAssistantThinking;
	}
	if (Array.isArray(options.roles)) result.roles = options.roles.filter((r): r is string => typeof r === "string");
	if (options.toolMode === "drop") result.toolMode = "drop";
	if (options.includeSummaries === false) result.includeSummaries = false;

	// Pass through unknown keys so custom slots (registered by extensions) can
	// receive their own options without modifying the built-in normalize function.
	const knownKeys = new Set<string>([
		"format",
		"heading",
		"includePiDefaultGuidelines",
		"onlyWithSnippets",
		"requireReadTool",
		"includeTime",
		"omitNamespace",
		"allowNamespace",
		"omitLatestUser",
		"maxMessages",
		"maxChars",
		"stripAssistantThinking",
		"roles",
		"toolMode",
		"includeSummaries",
	]);
	for (const key of Object.keys(options)) {
		if (!knownKeys.has(key)) {
			result[key] = options[key];
		}
	}

	return result;
}

// =========================================================================
// Helpers
// =========================================================================

function normalizeId(value: unknown, fallback: string): string {
	if (typeof value === "string" && value.trim().length > 0) return value.trim();
	return fallback.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function normalizeStringRecord(value: unknown): Record<string, string> | undefined {
	if (!isPlainObject(value)) return undefined;
	const obj = value as Record<string, unknown>;
	const result: Record<string, string> = {};
	for (const [key, val] of Object.entries(obj)) {
		if (typeof val === "string") result[key] = val;
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeResourcePolicy(
	value: unknown,
	label: string,
	diagnostics: PromptPresetDiagnostic[],
): PromptResourcePolicy | undefined {
	if (value === undefined) return undefined;
	if (!isPlainObject(value)) {
		diagnostics.push({ level: "error", message: `${label} policy must be an object when provided.` });
		return undefined;
	}
	const objValue = value as Record<string, unknown>;
	const allow = normalizePolicyPatterns(objValue.allow, `${label}.allow`, diagnostics);
	const deny = normalizePolicyPatterns(objValue.deny, `${label}.deny`, diagnostics);
	if (allow && deny) {
		diagnostics.push({ level: "error", message: `${label} policy must use either allow or deny, not both.` });
		return { allow };
	}
	if (allow) return { allow };
	if (deny) return { deny };
	return {};
}

function normalizePolicyPatterns(
	value: unknown,
	label: string,
	diagnostics: PromptPresetDiagnostic[],
): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		diagnostics.push({ level: "error", message: `${label} must be an array of strings when provided.` });
		return undefined;
	}
	const patterns: string[] = [];
	for (const [index, item] of value.entries()) {
		if (typeof item !== "string") {
			diagnostics.push({ level: "error", message: `${label}[${index}] must be a string.` });
			continue;
		}
		patterns.push(item.trim());
	}
	return patterns.length > 0 ? patterns : Array.isArray(value) && value.length === 0 ? [] : undefined;
}
