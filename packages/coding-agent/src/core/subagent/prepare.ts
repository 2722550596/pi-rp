import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai/compat";
import type { AgentSession } from "../agent-session.ts";
import { DEFAULT_THINKING_LEVEL } from "../defaults.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { findExactModelReferenceMatch } from "../model-resolver.ts";
import type { ModelRuntime } from "../model-runtime.ts";
import { compileMessages } from "../prompt-preset/compiler.ts";
import type { PromptPreset, PromptRuntime } from "../prompt-preset/index.ts";
import { defaultPreset } from "../prompt-preset/index.ts";
import { isDisabledPromptPresetId, loadPromptPresets } from "../prompt-preset/loader.ts";
import { applyResourcePolicy } from "../prompt-preset/policy.ts";
import { getDefaultSessionDir } from "../session-manager.ts";
import type { Skill } from "../skills.ts";
import type { BuildSystemPromptOptions } from "../system-prompt.ts";

// =========================================================================
// Types
// =========================================================================

export interface PrepareSubagentOptions {
	/** Working directory for preset discovery */
	cwd: string;
	/** Preset profile ID to use */
	profileId: string;
	/** Task text to send to the subagent */
	task: string;
	/** Parent model runtime to reuse */
	modelRuntime: ModelRuntime;
	/** Optional model reference override (e.g. "anthropic/claude-sonnet-4") */
	modelRef?: string;
	/** Thinking level override. Falls back to preset's level, then "medium". */
	thinkingLevel?: ThinkingLevel;
	tools?: string[];
	/** Number of parent messages to seed as chat history. Requires `session`. */
	inheritHistory?: number;
	/** Parent session for peer-completion (preset discovery, state, history, options). */
	session?: AgentSession;
	/** State schema IDs for the subagent session. Falls back to preset.schemas. */
	schemas?: string[];
	/** Explicit chat history input (runtime.messages for the chat-history slot). Takes precedence over inheritHistory. */
	inheritMessages?: AgentMessage[];
	/** Only feed these top-level state namespaces to the subagent (state slot + seeding). Default: all. */
	stateNamespaces?: string[];
	/** Inherit the parent session's extension tools (customTools). Default true (existing behavior); spawnAgent passes false. */
	inheritExtensionTools?: boolean;
	/** Explicit custom tool definitions for the subagent session; wins over inherited extension tools. */
	customTools?: ToolDefinition[];
	/** Explicit model object (takes precedence over modelRef/preset.model/first available). */
	model?: Model<any>;
}

export interface SubagentPreparation {
	/** Compiled preset messages (system + preset items + task as user) */
	messages: AgentMessage[];
	/** Model to use for execution */
	model: Model<any>;
	/** Thinking level */
	thinkingLevel: ThinkingLevel;
	/** Effective tool names */
	effectiveTools: string[];
	/** The resolved preset profile */
	profile: PromptPreset;
	/** Schema IDs to load into the subagent session (from options or preset). */
	schemas?: string[];
	/** Extension/custom tool definitions inherited from the parent session,
	 *  so the subagent can execute them. Empty when no parent session. */
	customTools?: ToolDefinition[];
}

export interface PrepareSubagentError {
	ok: false;
	error: string;
	availablePresets: string[];
}

export type PrepareSubagentResult = SubagentPreparation | PrepareSubagentError;

// =========================================================================
// Helpers
// =========================================================================

/** Top-level namespace filter: keep only the given keys of a state snapshot. */
export function pick(obj: Record<string, unknown>, namespaces: string[]): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const ns of namespaces) {
		if (ns in obj) out[ns] = obj[ns];
	}
	return out;
}

// =========================================================================
// prepareSubagentConversation
// =========================================================================

/**
 * Prepare a subagent conversation by loading the preset, compiling the
 * prompt messages, and appending the task as the last user message.
 *
 * This does NOT create an AgentSession - it calls compileMessages directly
 * with a minimal PromptRuntime, avoiding extension/tool/loader overhead.
 *
 * When a parent `session` is supplied (peer-completion), the runtime is
 * built from the parent's live context: in-memory presets, state snapshot,
 * conversation history (up to `inheritHistory`), and full system-prompt
 * options. Without a session, a minimal empty runtime is used.
 */
export async function prepareSubagentConversation(options: PrepareSubagentOptions): Promise<PrepareSubagentResult> {
	const { cwd, profileId, task, modelRuntime, modelRef, thinkingLevel } = options;

	// Preset discovery: parent session presets first (in-memory, up-to-date),
	// then disk fallback (handles presets added after session creation).
	const sessionPresets = options.session ? options.session.getAllPresets() : [];
	const foundInSession = sessionPresets.find((p) => p.preset.id === profileId);
	const allPresets = foundInSession ? sessionPresets : loadPromptPresets(cwd, getDefaultSessionDir(cwd));
	const foundPreset = foundInSession ?? allPresets.find((p) => p.preset.id === profileId);
	if (!foundPreset && !isDisabledPromptPresetId(profileId)) {
		return {
			ok: false,
			error: `Subagent preset "${profileId}" not found.`,
			availablePresets: allPresets.map((p) => p.preset.id),
		};
	}
	const preset = foundPreset?.preset ?? defaultPreset;

	// Resolve model: explicit model object > modelRef > preset.model > first available.
	const availableModels = [...modelRuntime.getModels()];
	let model: Model<any> | undefined;
	if (options.model) {
		model = options.model;
	} else if (modelRef) {
		model = findExactModelReferenceMatch(modelRef, availableModels);
		if (!model) {
			return {
				ok: false,
				error: `Model "${modelRef}" not found for subagent preset "${profileId}".`,
				availablePresets: allPresets.map((p) => p.preset.id),
			};
		}
	} else if (preset.model) {
		model = findExactModelReferenceMatch(preset.model, availableModels);
	}
	if (!model) {
		model = availableModels[0];
		if (!model) {
			return {
				ok: false,
				error: `No model available for subagent preset "${profileId}".`,
				availablePresets: allPresets.map((p) => p.preset.id),
			};
		}
	}

	// Resolve thinking level: explicit > preset field > medium
	const effectiveThinkingLevel =
		thinkingLevel ?? (preset.thinkingLevel as ThinkingLevel | undefined) ?? DEFAULT_THINKING_LEVEL;

	// Effective tools: explicit option wins; otherwise the read-only default
	// plus the parent session's extension tools (peer-completion). Resolved
	// before runtime construction so buildPeerOptions can apply the preset's
	// tool policy.
	const extensionTools =
		options.session && options.inheritExtensionTools !== false
			? options.session.extensionRunner.getAllRegisteredTools()
			: [];
	const effectiveTools = options.tools
		? [...options.tools]
		: [...["read", "grep", "find", "ls", "bash"], ...extensionTools.map((t) => t.definition.name)];

	// Build the PromptRuntime for compileMessages. With a parent session,
	// build a peer-context runtime (state, history, options); otherwise minimal.
	// History seeding: explicit option > preset-level field > none.
	const inheritHistory = options.inheritHistory ?? preset.inheritHistory ?? 0;
	let runtime: PromptRuntime;
	if (options.session) {
		runtime = {
			options: buildPeerOptions(options.session, effectiveTools, preset),
			messages:
				options.inheritMessages ??
				(inheritHistory > 0 ? options.session.agent.state.messages.slice(-inheritHistory) : []),
			latestUserMessage: undefined,
			now: new Date(),
			// Preset statics first, then the parent's session facts: a subagent
			// preset writing {{user}} must resolve to the same display name the
			// parent session shows, not the `user` fallback baked into the macro.
			variables: { ...preset.variables, user: options.session.settingsManager.getUserName() },
			skills: options.session.systemPromptOptions.skills ?? [],
			state: options.stateNamespaces
				? pick(options.session.stateManager.snapshot(), options.stateNamespaces)
				: options.session.stateManager.snapshot(),
			// The subagent's own resolved model (may differ from the parent's via
			// preset.model), so macros/slots see the model that will answer.
			model,
			thinkingLevel: effectiveThinkingLevel,
		};
	} else {
		const systemPromptOptions: BuildSystemPromptOptions = {
			cwd,
			skills: [] as Skill[],
			contextFiles: [],
			customPrompt: undefined,
			appendSystemPrompt: undefined,
			selectedTools: [],
			toolSnippets: {},
			promptGuidelines: [],
		};
		runtime = {
			options: systemPromptOptions,
			messages: [],
			latestUserMessage: undefined,
			now: new Date(),
			// No parent session: only the preset's own statics are available.
			variables: { ...preset.variables },
			skills: [],
			model,
			thinkingLevel: effectiveThinkingLevel,
		};
	}

	// Compile preset messages (system prompt + preset items + chat history)
	const compiled = await compileMessages(preset, runtime);
	if (compiled.diagnostics.some((d) => d.level === "error")) {
		const errors = compiled.diagnostics
			.filter((d) => d.level === "error")
			.map((d) => d.message)
			.join("; ");
		return {
			ok: false,
			error: `Preset "${profileId}" has compilation errors: ${errors}`,
			availablePresets: allPresets.map((p) => p.preset.id),
		};
	}

	// Append task as the last user message
	const taskMessage: AgentMessage = {
		role: "user",
		content: [{ type: "text", text: task }],
		timestamp: Date.now(),
	};
	const fullMessages = [...compiled.messages, taskMessage];

	// Schemas: explicit option wins, then preset-declared schemas.
	const schemas = options.schemas ?? preset.schemas;

	return {
		messages: fullMessages,
		model,
		thinkingLevel: effectiveThinkingLevel,
		effectiveTools,
		profile: preset,
		schemas,
		customTools:
			options.customTools ?? (extensionTools.length > 0 ? extensionTools.map((t) => t.definition) : undefined),
	};
}

/**
 * Build peer-context system-prompt options for a subagent by spreading the
 * parent session's options and overriding `selectedTools` / `toolSnippets`
 * with the subagent's post-policy tool set. The parent's options are never
 * mutated — spreading copies the top level. The tool policy applied here
 * mirrors setActivePreset's later application (idempotent), so the snippets
 * and selectedTools reflect exactly what the subagent session will use.
 */
function buildPeerOptions(
	session: AgentSession,
	effectiveTools: string[],
	preset: PromptPreset,
): BuildSystemPromptOptions {
	const parent = session.systemPromptOptions;
	const policyTools = applyResourcePolicy(effectiveTools, preset.tools);

	// Filter toolSnippets to only tools the subagent actually has.
	const filteredToolSnippets: Record<string, string> = {};
	const toolSet = new Set(policyTools);
	for (const [name, snippet] of Object.entries(parent.toolSnippets ?? {})) {
		if (toolSet.has(name)) filteredToolSnippets[name] = snippet;
	}

	return {
		...parent,
		selectedTools: policyTools,
		toolSnippets: filteredToolSnippets,
	};
}

/** Check if a preparation result is an error */
export function isPrepareError(result: PrepareSubagentResult): result is PrepareSubagentError {
	return "ok" in result && result.ok === false;
}
