/**
 * Command registry entry point.
 *
 * Importing this module does NOT register builtins (module-load side effects
 * are unsafe in the agent-session import cycle — agent-session registers at
 * runtime via registerBuiltinCommandEntries). It exposes the shared dispatch
 * helper used by InteractiveMode and the RPC responder.
 */

import type { AgentSession } from "../core/agent-session.ts";
import type { CommandContext, CommandView } from "../core/slash-commands.ts";
import { getCommandEntry } from "../core/slash-commands.ts";

export { registerBuiltinCommandEntries } from "./builtins.ts";
export { syncExtensionCommands } from "./extension.ts";

/**
 * Execute a registered command by name.
 *
 * Returns true when the command was found and executed (errors propagate to
 * the caller), false when the name is not registered (caller falls through
 * to normal user-message handling).
 */
export async function dispatchCommand(
	name: string,
	args: string[],
	session: AgentSession,
	view: CommandView,
): Promise<boolean> {
	const entry = getCommandEntry(name);
	if (!entry) return false;
	await entry.execute({ args, session, view } satisfies CommandContext);
	return true;
}
