import { describe, expect, it, vi } from "vitest";
import { registerBuiltinCommandEntries } from "../src/commands/builtins.ts";
import type { CommandContext } from "../src/core/slash-commands.ts";
import { getCommandEntry } from "../src/core/slash-commands.ts";

// Register the builtin entries so the registry is populated for this test
// process (idempotent — Map.set).
registerBuiltinCommandEntries();

type CloneSession = {
	sessionManager: { getLeafId: () => string | null };
	extensionRunner: {
		createCommandContext: () => {
			fork: (entryId: string, options?: { position?: "before" | "at" }) => Promise<{ cancelled: boolean }>;
		};
	};
};

type CloneView = {
	showStatus: (message: string, severity?: "info" | "warning" | "error") => void;
};

function makeCtx(session: CloneSession, view: CloneView): CommandContext {
	return { args: [], session: session as never, view: view as never } as CommandContext;
}

describe("InteractiveMode /clone", () => {
	it("clones the current leaf into a new session", async () => {
		const fork = vi.fn(async () => ({ cancelled: false }));
		const showStatus = vi.fn();
		const ctx = makeCtx(
			{
				sessionManager: { getLeafId: () => "leaf-123" },
				extensionRunner: { createCommandContext: () => ({ fork }) },
			},
			{ showStatus },
		);

		await getCommandEntry("clone")!.execute(ctx);

		expect(fork).toHaveBeenCalledWith("leaf-123", { position: "at" });
		expect(showStatus).toHaveBeenCalledWith("Cloned to new session");
	});

	it("shows a status message when there is nothing to clone", async () => {
		const fork = vi.fn(async () => ({ cancelled: false }));
		const showStatus = vi.fn();
		const ctx = makeCtx(
			{
				sessionManager: { getLeafId: () => null },
				extensionRunner: { createCommandContext: () => ({ fork }) },
			},
			{ showStatus },
		);

		await getCommandEntry("clone")!.execute(ctx);

		expect(fork).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith("Nothing to clone yet");
	});
});
