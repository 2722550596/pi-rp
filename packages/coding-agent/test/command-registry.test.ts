import { describe, expect, it, vi } from "vitest";
import { registerBuiltinCommandEntries } from "../src/commands/builtins.ts";
import { syncExtensionCommands } from "../src/commands/extension.ts";
import { dispatchCommand } from "../src/commands/index.ts";
import type { ExtensionRunner } from "../src/core/extensions/runner.ts";
import {
	clearExtensionCommands,
	getCommandEntries,
	isBuiltinCommandName,
	registerExtensionCommand,
} from "../src/core/slash-commands.ts";

// Register the builtin entries so the registry is populated for this test
// process (idempotent — Map.set).
registerBuiltinCommandEntries();

/** A fake runner exposing only the surface syncExtensionCommands uses. */
function fakeRunner(commands: unknown[]): ExtensionRunner {
	return { getRegisteredCommands: () => commands } as unknown as ExtensionRunner;
}

describe("command registry", () => {
	it("dispatches a registered builtin command through the view", async () => {
		const showSelector = vi.fn();
		const dispatched = await dispatchCommand("hotkeys", [], {} as never, { showSelector } as never);
		expect(dispatched).toBe(true);
		expect(showSelector).toHaveBeenCalledWith("hotkeys");
	});

	it("reports not-dispatched for unknown names (submit handler falls through)", async () => {
		expect(await dispatchCommand("does-not-exist", [], {} as never, {} as never)).toBe(false);
	});

	it("dispatches extension commands and clears them on reload", async () => {
		clearExtensionCommands();
		registerExtensionCommand("ext-cmd", {
			execute: (ctx) => ctx.view.showStatus("ext ran"),
			usage: "/ext-cmd",
		});

		const showStatus = vi.fn();
		expect(await dispatchCommand("ext-cmd", [], {} as never, { showStatus } as never)).toBe(true);
		expect(showStatus).toHaveBeenCalledWith("ext ran");

		clearExtensionCommands();
		expect(await dispatchCommand("ext-cmd", [], {} as never, {} as never)).toBe(false);
	});

	it("distinguishes builtin names from extension names", () => {
		expect(isBuiltinCommandName("reroll")).toBe(true);
		expect(isBuiltinCommandName("ext-cmd")).toBe(false);
		expect(getCommandEntries().some(({ name }) => name === "reroll")).toBe(true);
	});

	it("an extension-less session (subagent) does not wipe extension commands from the shared registry", () => {
		clearExtensionCommands();
		registerExtensionCommand("parent-cmd", { execute: () => {}, usage: "/parent-cmd" });

		// Subagent sessions are built with no extensions (core/subagent/run.ts);
		// their _buildRuntime must not clear the parent session's commands.
		syncExtensionCommands(fakeRunner([]));

		expect(getCommandEntries().some(({ name }) => name === "parent-cmd")).toBe(true);

		// A runner WITH commands re-registers (reload semantics keep clearing).
		syncExtensionCommands(
			fakeRunner([
				{
					invocationName: "new-cmd",
					description: "new",
					handler: () => {},
					sourceInfo: {},
				},
			]),
		);
		expect(getCommandEntries().some(({ name }) => name === "new-cmd")).toBe(true);
		expect(getCommandEntries().some(({ name }) => name === "parent-cmd")).toBe(false);
	});
});
