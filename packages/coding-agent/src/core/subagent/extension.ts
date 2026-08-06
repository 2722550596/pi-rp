import { Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import type { AgentSession } from "../agent-session.ts";
import { prepareSubagentConversation, isPrepareError } from "./prepare.ts";
import { runSubagent } from "./run.ts";
import type { LoadedPromptPreset } from "../prompt-preset/index.ts";

// =========================================================================
// Helpers
// =========================================================================

/** Get delegatable presets from the session */
export function getDelegatablePresets(session: AgentSession): LoadedPromptPreset[] {
	return session.getAllPresets().filter((p) => p.preset.delegatable === true);
}

/** Check if a preset is delegatable */
export function isDelegatable(session: AgentSession, profileId: string): boolean {
	return session.getAllPresets().some((p) => p.preset.id === profileId && p.preset.delegatable === true);
}

// =========================================================================
// Tool Definition Factories
// =========================================================================

const profilesToolParams = Type.Object({});

/**
 * Create the subagent_profiles tool definition.
 * Like state_update/get_state, this is a core tool registered in _buildRuntime.
 * The session is captured via closure (same pattern as createStateUpdateToolDefinition).
 */
export function createSubagentProfilesToolDefinition(
	session: AgentSession,
): ToolDefinition<typeof profilesToolParams> {
	return {
		name: "subagent_profiles",
		label: "Subagent Profiles",
		description:
			"List available subagent profiles (delegatable prompt presets). Each profile has a preset system prompt, model, and tool set. Use this to discover which subagents can be delegated to.",
		parameters: profilesToolParams,
		promptSnippet: "subagent_profiles: list delegatable subagent profiles",
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			const presets = getDelegatablePresets(session);
			if (presets.length === 0) {
				return {
					content: [{ type: "text", text: "No delegatable subagent profiles are configured." }],
					details: undefined,
				};
			}
			const lines = presets.map((p) => {
				const preset = p.preset;
				const model = preset.model ?? "(inherits session model)";
				const thinking = preset.thinkingLevel ?? "(inherits)";
				const tools = preset.tools
					? "allow" in preset.tools && preset.tools.allow
						? preset.tools.allow.join(",")
						: "deny" in preset.tools && preset.tools.deny
							? `deny:${preset.tools.deny.join(",")}`
							: "(all)"
					: "(all)";
				return `- id: ${preset.id}\n  name: ${preset.name ?? preset.id}\n  description: ${preset.description ?? "(none)"}\n  model: ${model}\n  thinking: ${thinking}\n  tools: ${tools}`;
			});
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: undefined,
			};
		},
	};
}

const subagentToolParams = Type.Object({
	profileId: Type.String({ description: "ID of the delegatable subagent profile to use" }),
	task: Type.String({ description: "The task to delegate to the subagent" }),
});

/**
 * Create the subagent tool definition.
 * Registered in _buildRuntime alongside state_update/get_state.
 */
export function createSubagentToolDefinition(
	session: AgentSession,
): ToolDefinition<typeof subagentToolParams> {
	return {
		name: "subagent",
		label: "Subagent",
		description:
			"Delegate a task to a subagent running with a specific profile (preset). The subagent runs in-process with a read-only tool set and returns its result text. Use subagent_profiles first to see available profiles.",
		parameters: subagentToolParams,
		promptSnippet: "subagent: delegate a task to a subagent by profileId",
		promptGuidelines: [
			"Use the subagent tool to delegate self-contained tasks to specialist profiles.",
			"Always check subagent_profiles first to find valid profileIds.",
		],
		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			// Authorization: preset must be delegatable
			if (!isDelegatable(session, params.profileId)) {
				return {
					content: [
						{
							type: "text",
							text: `Error: Profile "${params.profileId}" is not delegatable. Use subagent_profiles to list available profiles.`,
						},
					],
					details: undefined,
				};
			}

			// Prepare the subagent conversation
			const preparation = await prepareSubagentConversation({
				cwd: session.sessionManager.getCwd(),
				profileId: params.profileId,
				task: params.task,
				modelRuntime: session.modelRuntime,
			});

			if (isPrepareError(preparation)) {
				return {
					content: [
						{
							type: "text",
							text: `Error: Subagent preparation failed: ${preparation.error}\nAvailable presets: ${preparation.availablePresets.join(", ")}`,
						},
					],
					details: undefined,
				};
			}

			// Execute the subagent
			const result = await runSubagent(preparation, session.modelRuntime, { signal });

			const statusLabel = result.status === "completed" ? "" : ` [${result.status}]`;
			const errorLabel = result.error ? `\nError: ${result.error}` : "";
			const text = `${result.text}${statusLabel}${errorLabel}`;

			return {
				content: [{ type: "text", text }],
				details: undefined,
			};
		},
	};
}