import { describe, expect, it, vi } from "vitest";
import { getPathArg, registerBuiltinCommandEntries } from "../src/commands/builtins.ts";
import { dispatchCommand } from "../src/commands/index.ts";
import { getCommandEntry } from "../src/core/slash-commands.ts";

// Register the builtin entries so the registry is populated for this test
// process (idempotent — Map.set).
registerBuiltinCommandEntries();

describe("InteractiveMode /import parsing", () => {
	it("strips quotes from /import path arguments", () => {
		expect(getPathArg(['"path/to/session.jsonl"'])).toBe("path/to/session.jsonl");
		expect(getPathArg(['"path', "with", 'spaces/session.jsonl"'])).toBe("path with spaces/session.jsonl");
	});

	it("preserves apostrophes in unquoted /import path arguments", () => {
		expect(getPathArg(["it's-a-session.jsonl"])).toBe("it's-a-session.jsonl");
	});

	it("enforces command token boundaries", async () => {
		const session = { prompt: vi.fn(async () => true) };
		const view = {};
		// "importish" is not a registered command: dispatch must not run it and
		// must report not-dispatched so the submit handler falls through.
		expect(await dispatchCommand("importish", [], session as never, view as never)).toBe(false);
	});

	it("dispatches the parsed path to the import view", async () => {
		const showSelector = vi.fn();
		const ctx = {
			args: ['"path', "with", 'spaces/session.jsonl"'],
			session: {} as never,
			view: { showSelector },
		};

		await getCommandEntry("import")!.execute(ctx as never);

		expect(showSelector).toHaveBeenCalledWith("import", { path: "path with spaces/session.jsonl" });
	});
});
