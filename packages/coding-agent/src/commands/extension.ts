/**
 * Mirror extension-registered commands into the command registry.
 *
 * Called at extension load (AgentSession._buildRuntime — construction and
 * reload). The runner resolves conflicts by suffixing invocation names
 * ("name:1"); those resolved names become the registry keys, preserving the
 * existing conflict diagnostics. The extension registerCommand() contract is
 * unchanged.
 */

import type { ExtensionRunner } from "../core/extensions/runner.ts";
import type { CommandContext } from "../core/slash-commands.ts";
import { clearExtensionCommands, registerExtensionCommand } from "../core/slash-commands.ts";

/** Drop stale entries and re-register all commands from the runner. */
export function syncExtensionCommands(runner: ExtensionRunner): void {
	const commands = runner.getRegisteredCommands();
	if (commands.length === 0) {
		// Extension-less sessions (subagents, tests) must not wipe the shared
		// registry: extension commands belong to the extension-bearing session.
		return;
	}
	clearExtensionCommands();
	for (const command of commands) {
		registerExtensionCommand(command.invocationName, {
			execute: async (ctx: CommandContext) => {
				const extCtx = runner.createCommandContext();
				const argsString = ctx.args.join(" ");
				try {
					await command.handler(argsString, extCtx);
				} catch (err) {
					// Mirror session.prompt()'s extension-command error path.
					runner.emitError({
						extensionPath: `command:${command.invocationName}`,
						event: "command",
						error: err instanceof Error ? err.message : String(err),
					});
				}
			},
			autocomplete: async (prefix) => {
				const items = await command.getArgumentCompletions?.(prefix);
				if (!items) return null;
				return items.map((item) => ({
					value: item.value,
					label: item.label,
					...(item.description && { description: item.description }),
				}));
			},
			usage: `/${command.invocationName}`,
		});
	}
}
