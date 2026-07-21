import type { PromptPreset } from "./types.ts";

/**
 * Built-in default prompt stack that mirrors the behavior of buildSystemPrompt().
 * The items are ordered to produce exactly the same system prompt string.
 */
export const defaultPreset: PromptPreset = {
	schemaVersion: 1,
	type: "pi-forge.prompt-preset",
	id: "pi-default",
	name: "Pi Default Prompt",
	description: "Built-in prompt stack that mirrors Pi's default system prompt behavior.",
	autoActivate: true,
	mode: "replace",
	defaults: {
		syntheticMessagesVisible: false,
		unresolvedMacroPolicy: "keep",
	},
	items: [
		{
			kind: "block",
			id: "main-role",
			name: "Pi Default Role",
			enabled: true,
			role: "system",
			content:
				"You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.",
		},
		{
			kind: "slot",
			id: "tools",
			name: "Available Tools",
			enabled: true,
			role: "system",
			slot: "tools",
			options: {
				format: "plain",
				onlyWithSnippets: true,
			},
		},
		{
			kind: "block",
			id: "custom-tools-note",
			name: "Custom Tools Note",
			enabled: true,
			role: "system",
			content: "In addition to the tools above, you may have access to other custom tools depending on the project.",
		},
		{
			kind: "slot",
			id: "tool-guidelines",
			name: "Guidelines",
			enabled: true,
			role: "system",
			slot: "tool-guidelines",
			options: {
				format: "plain",
				heading: "Guidelines:",
				includePiDefaultGuidelines: true,
			},
		},
		{
			kind: "slot",
			id: "pi-docs",
			name: "Pi Documentation Guidance",
			enabled: true,
			role: "system",
			slot: "pi-docs",
		},
		{
			kind: "slot",
			id: "append-system-prompt",
			name: "User Append System Prompt",
			enabled: true,
			role: "system",
			slot: "append-system-prompt",
		},
		{
			kind: "slot",
			id: "project-context",
			name: "Project Context",
			enabled: true,
			role: "system",
			slot: "project-context",
		},
		{
			kind: "slot",
			id: "skills",
			name: "Available Skills",
			enabled: true,
			role: "system",
			slot: "skills",
			options: {
				requireReadTool: true,
			},
		},
		{
			kind: "slot",
			id: "date-cwd",
			name: "Date and Working Directory",
			enabled: true,
			role: "system",
			slot: "date-cwd",
		},
		{
			kind: "slot",
			id: "chat-history",
			name: "Chat History",
			enabled: true,
			slot: "chat-history",
		},
	],
};
