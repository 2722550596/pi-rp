import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai/compat";
import { DEFAULT_THINKING_LEVEL } from "../defaults.ts";
import { findExactModelReferenceMatch } from "../model-resolver.ts";
import type { ModelRuntime } from "../model-runtime.ts";
import { compileMessages } from "../prompt-preset/compiler.ts";
import type { PromptPreset, PromptRuntime } from "../prompt-preset/index.ts";
import { defaultPreset } from "../prompt-preset/index.ts";
import { isDisabledPromptPresetId, loadPromptPresets } from "../prompt-preset/loader.ts";
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
	/** Reserved for Phase 4: number of parent conversation messages to seed as history. */
	inheritHistory?: number;
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
}

export interface PrepareSubagentError {
	ok: false;
	error: string;
	availablePresets: string[];
}

export type PrepareSubagentResult = SubagentPreparation | PrepareSubagentError;

// =========================================================================
// prepareSubagentConversation
// =========================================================================

/**
 * Prepare a subagent conversation by loading the preset, compiling the
 * prompt messages, and appending the task as the last user message.
 *
 * This does NOT create an AgentSession - it calls compileMessages directly
 * with a minimal PromptRuntime, avoiding extension/tool/loader overhead.
 */
export function prepareSubagentConversation(options: PrepareSubagentOptions): PrepareSubagentResult {
	const { cwd, profileId, task, modelRuntime, modelRef, thinkingLevel } = options;

	// Load presets
	const allPresets = loadPromptPresets(cwd, getDefaultSessionDir(cwd));
	const foundPreset = allPresets.find((p) => p.preset.id === profileId);
	if (!foundPreset && !isDisabledPromptPresetId(profileId)) {
		return {
			ok: false,
			error: `Subagent preset "${profileId}" not found.`,
			availablePresets: allPresets.map((p) => p.preset.id),
		};
	}

	const preset = foundPreset?.preset ?? defaultPreset;

	// Resolve model
	const availableModels = [...modelRuntime.getModels()];
	let model: Model<any> | undefined;
	if (modelRef) {
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

	// Build a minimal PromptRuntime for compileMessages
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
	const runtime: PromptRuntime = {
		options: systemPromptOptions,
		messages: [],
		latestUserMessage: undefined,
		now: new Date(),
		variables: {},
		skills: [],
	};

	// Compile preset messages (system prompt + preset items, no conversation history)
	const compiled = compileMessages(preset, runtime);
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

	// Effective tools: from options, or read-only default
	const effectiveTools = options.tools ?? ["read", "grep", "find", "ls", "bash"];

	return {
		messages: fullMessages,
		model,
		thinkingLevel: effectiveThinkingLevel,
		effectiveTools,
		profile: preset,
	};
}

/** Check if a preparation result is an error */
export function isPrepareError(result: PrepareSubagentResult): result is PrepareSubagentError {
	return "ok" in result && result.ok === false;
}
