import { APP_NAME } from "../config.ts";
import type { AgentSession } from "./agent-session.ts";
import type { SourceInfo } from "./source-info.ts";

export type SlashCommandSource = "extension" | "prompt" | "skill";

export interface SlashCommandInfo {
	name: string;
	description?: string;
	source: SlashCommandSource;
	sourceInfo: SourceInfo;
}

export interface BuiltinSlashCommand {
	name: string;
	description: string;
	argumentHint?: string;
}

export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	{ name: "settings", description: "Open settings menu" },
	{ name: "model", description: "Select model (opens selector UI)", argumentHint: "<provider/model>" },
	{ name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling" },
	{ name: "export", description: "Export session (HTML default, or specify path: .html/.jsonl)" },
	{ name: "import", description: "Import and resume a session from a JSONL file" },
	{ name: "share", description: "Share session as a secret GitHub gist" },
	{ name: "copy", description: "Copy last agent message to clipboard" },
	{ name: "name", description: "Set session display name" },
	{ name: "session", description: "Show session info and stats" },
	{ name: "state", description: "Show conversation state (game stats, inventory, flags)", argumentHint: "<path>" },
	{ name: "schema", description: "Manage state schemas: /schema [list|load <id>|unload <ns>|strict [off]]" },
	{ name: "validator", description: "List loaded custom validators" },
	{ name: "changelog", description: "Show changelog entries" },
	{ name: "hotkeys", description: "Show all keyboard shortcuts" },
	{ name: "fork", description: "Create a new fork from a previous user message" },
	{ name: "clone", description: "Duplicate the current session at the current position" },
	{ name: "tree", description: "Navigate session tree (switch branches)" },
	{ name: "trust", description: "Save project trust decision for future sessions" },
	{ name: "prompt", description: "Show the compiled system prompt", argumentHint: "<tools|messages>" },
	{ name: "login", description: "Configure provider authentication", argumentHint: "<provider>" },
	{ name: "logout", description: "Remove provider authentication" },
	{ name: "new", description: "Start a new session" },
	{ name: "compact", description: "Manually compact the session context" },
	{ name: "continue", description: "Make the agent continue generating" },
	{ name: "reload", description: "Reload keybindings, extensions, skills, prompts, themes, and context files" },
	{ name: "reroll", description: "Regenerate the last assistant response" },
	{ name: "resume", description: "Resume a different session" },
	{ name: "preset", description: "Manage prompt presets: /preset to list, /preset <id|none> to activate" },
	{ name: "subagent", description: "List subagent profiles or run a task: /subagent [list|<profileId> <task>]" },
	{ name: "quit", description: `Quit ${APP_NAME}` },
];

// ============================================================================
// Command registry
//
// Single seam for slash-command dispatch and autocomplete. Builtin commands
// register at module load (see src/commands/); extension commands register at
// extension load via syncExtensionCommands() (see src/commands/extension.ts).
// The extension registerCommand() contract is unchanged — the runner's
// resolved commands (with conflict-suffixed invocation names) are mirrored
// into this registry.
// ============================================================================

/**
 * Narrow view surface command bodies receive. Implemented by InteractiveMode
 * and by the RPC responder (reroll). Command bodies must NOT import TUI
 * internals; they only use ctx.session + ctx.view, so the same bodies work
 * headless.
 */
export interface CommandView {
	/** Render a text (default) or markdown message into the chat area. */
	renderMessage(content: string, options?: { markdown?: boolean }): void;
	/**
	 * Open a modal selector. `kind` identifies the selector, `payload` is
	 * selector-specific. Selectors are a TUI concern; the RPC adapter is a
	 * documented no-op stub.
	 */
	showSelector(kind: string, payload?: unknown): void;
	/** Show a status message. Severity maps to status/error/warning styling. */
	showStatus(message: string, severity?: "info" | "warning" | "error"): void;
	/**
	 * Show a transient confirmation. The TUI flashes it in fullscreen mode and
	 * falls back to a status line in regular mode; headless adapters no-op.
	 */
	flash(message: string): void;
	/** Force the footer to re-render. */
	invalidateFooter(): void;
	/** Re-evaluate the editor border color (bash mode / thinking / preset). */
	updateEditorBorder(): void;
}

export interface CommandContext {
	/** Command arguments (everything after the command name, whitespace-split). */
	args: string[];
	session: AgentSession;
	view: CommandView;
}

/**
 * A completion suggestion. `value` is inserted on accept; `label` and
 * `description` enrich the suggestion row when the view supports them.
 */
export interface CommandCompletion {
	value: string;
	label?: string;
	description?: string;
}

/**
 * A registered slash command.
 *
 * `autocomplete` receives the argument prefix and the command context
 * (session-dependent completions — model names, presets, state paths — need
 * the live session). Returns completion strings (or enriched suggestions),
 * or null/undefined when no argument completion is available. May be async
 * (extension commands wrap the runner's async getArgumentCompletions).
 */
export interface CommandEntry {
	execute(ctx: CommandContext): void | Promise<void>;
	autocomplete?(
		prefix: string,
		ctx: CommandContext,
	):
		| Array<string | CommandCompletion>
		| null
		| undefined
		| Promise<Array<string | CommandCompletion> | null | undefined>;
	/** Usage line shown in command listings (e.g. "/schema [list|load <id>...]"). */
	usage: string;
	argHint?: string;
}

const builtinCommands = new Map<string, CommandEntry>();
const extensionCommands = new Map<string, CommandEntry>();

/** Register a builtin command. Called at module load from src/commands/. */
export function registerBuiltinCommand(name: string, entry: CommandEntry): void {
	builtinCommands.set(name, entry);
}

/** Register an extension command under its resolved invocation name. */
export function registerExtensionCommand(name: string, entry: CommandEntry): void {
	extensionCommands.set(name, entry);
}

/** Drop all extension commands (before re-registering on extension reload). */
export function clearExtensionCommands(): void {
	extensionCommands.clear();
}

/** Look up a command by name. Extension commands shadow nothing: a builtin
 *  wins, and conflicting extension commands use suffixed invocation names
 *  ("name:1"), so names never collide. */
export function getCommandEntry(name: string): CommandEntry | undefined {
	return builtinCommands.get(name) ?? extensionCommands.get(name);
}

/** Whether the name is a builtin command (not an extension command). */
export function isBuiltinCommandName(name: string): boolean {
	return builtinCommands.has(name);
}

/** All registered commands (builtins first, then extension commands). */
export function getCommandEntries(): Array<{ name: string; entry: CommandEntry }> {
	return [...builtinCommands.entries(), ...extensionCommands.entries()].map(([name, entry]) => ({ name, entry }));
}
