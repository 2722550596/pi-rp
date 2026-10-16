import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { registerMacro } from "../src/core/prompt-preset/macro-engine.ts";
import type { PromptPreset } from "../src/core/prompt-preset/types.ts";
import { type AgentSessionScope, createAgentSessionScope } from "../src/core/session-scope.ts";
import { createHarness, getMessageText, type Harness } from "./suite/harness.ts";

const harnesses: Harness[] = [];
const scopes: AgentSessionScope[] = [];
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	while (harnesses.length) harnesses.pop()!.cleanup();
	while (scopes.length) scopes.pop()!.dispose();
});

async function fixture(scoped = true) {
	const scope = scoped ? createAgentSessionScope() : undefined;
	if (scope) scopes.push(scope);
	const name = scoped ? "epochValue" : "localEpochValue";
	const preset: PromptPreset = {
		schemaVersion: 1,
		id: "macro-epoch",
		autoActivate: true,
		items: [{ kind: "block", id: "snapshot", content: `{{${name}}}` }],
	};
	const h = await createHarness({
		scope,
		models: [{ id: "one" }, { id: "two" }],
		inlinePresets: [
			{ preset, filePath: "inline:macro-epoch", diagnostics: [] },
			{
				preset: { ...preset, id: "other-epoch", autoActivate: false },
				filePath: "inline:other-epoch",
				diagnostics: [],
			},
		],
	});
	harnesses.push(h);
	let value = "initial";
	const render = vi.fn(() => value);
	registerMacro({ name, description: "test", static: true, render }, false, scope?.promptRegistry);
	return {
		h,
		scope,
		preset: h.session.activePreset,
		render,
		setValue(next: string) {
			value = next;
		},
	};
}

async function output(session: AgentSession): Promise<string> {
	return (await session.getPresetInjectMessages()).map(getMessageText).join("\n");
}

/** Text of the leading preset block only; compacted history is appended after it. */
async function blockOutput(session: AgentSession): Promise<string> {
	return getMessageText((await session.getPresetInjectMessages())[0]);
}

async function assertRefresh(change: (h: Harness) => Promise<unknown> | unknown) {
	const f = await fixture();
	expect(await output(f.h.session)).toBe("initial");
	f.setValue("changed");
	expect(await output(f.h.session)).toBe("initial");
	await change(f.h);
	expect(await output(f.h.session)).toBe("changed");
	expect(await output(f.h.session)).toBe("changed");
	expect(f.render).toHaveBeenCalledTimes(2);
}

describe("AgentSession macro epochs", () => {
	it.each([true, false])("memoizes request and /prompt output with scope=%s", async (scoped) => {
		const f = await fixture(scoped);
		f.preset.items.push({ kind: "block", id: "builtins", content: "{{cwd}}|{{tools}}", role: "user" });
		const first = await output(f.h.session);
		f.setValue("changed");
		expect(await output(f.h.session)).toBe(first);
		expect(await f.h.session.compileSystemPrompt()).toBe("initial");
		expect(f.render).toHaveBeenCalledTimes(1);
	});

	it("keeps dynamic date, time, and latest user message fresh in one epoch", async () => {
		const f = await fixture();
		f.preset.items.push({
			kind: "block",
			id: "dynamic",
			content: "{{date}}|{{time}}|{{lastUserMessage}}",
			role: "user",
		});
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date(2026, 9, 16, 10, 20, 30));
		f.h.session.agent.state.messages = [{ role: "user", content: "first", timestamp: 0 }];
		expect(await output(f.h.session)).toBe("initial\n2026-10-16|10:20:30|first");
		f.setValue("changed");
		vi.setSystemTime(new Date(2026, 9, 17, 11, 21, 31));
		f.h.session.agent.state.messages.push({ role: "user", content: "latest", timestamp: 1 });
		expect(await output(f.h.session)).toBe("initial\n2026-10-17|11:21:31|latest");
		expect(f.render).toHaveBeenCalledTimes(1);
	});

	it("refreshes after a direct preset assignment", async () => {
		await assertRefresh((h) => {
			const internal = h.session as unknown as { _activePreset: PromptPreset };
			internal._activePreset = { ...h.session.activePreset };
		});
	});

	it("refreshes after changing the active tool set", async () => {
		await assertRefresh((h) => {
			const names = h.session.getActiveToolNames();
			h.session.setActiveToolsByName(names.length ? [] : ["read"]);
		});
	});

	it("refreshes after setModel", async () => {
		await assertRefresh((h) => h.session.setModel(h.getModel("two")!));
	});

	it.each([false, true])("refreshes after cycleModel scoped=%s", async (scoped) => {
		await assertRefresh(async (h) => {
			if (scoped) h.session.setScopedModels(h.models.map((model) => ({ model })));
			await h.session.cycleModel();
		});
	});

	it("does not refresh when the registry replaces a model with the same provider/id", async () => {
		const f = await fixture();
		expect(await output(f.h.session)).toBe("initial");
		f.setValue("changed");
		f.h.session.agent.state.model = { ...f.h.getModel() };
		const internal = f.h.session as unknown as { _refreshCurrentModelFromRegistry(): void };
		internal._refreshCurrentModelFromRegistry();
		expect(await output(f.h.session)).toBe("initial");
		expect(f.render).toHaveBeenCalledTimes(1);
	});

	it("shares static rebuild and request snapshots and invalidates the static prompt cache", async () => {
		const f = await fixture(false);
		const internal = f.h.session as unknown as { _rebuildSystemPrompt(names: string[]): string };
		expect(internal._rebuildSystemPrompt(f.h.session.getActiveToolNames())).toBe("initial");
		f.setValue("changed");
		expect(await output(f.h.session)).toBe("initial");
		expect(internal._rebuildSystemPrompt(f.h.session.getActiveToolNames())).toBe("initial");
		await f.h.session.setModel(f.h.getModel("two")!);
		expect(internal._rebuildSystemPrompt(f.h.session.getActiveToolNames())).toBe("changed");
		expect(await output(f.h.session)).toBe("changed");
		expect(f.render).toHaveBeenCalledTimes(2);
	});

	it("keeps another session's process-level memory macro out of a scoped static rebuild", async () => {
		// A scope-less session registers memory.* process-wide; a scoped session in the same
		// process must render from its own registry on both paths, which share one snapshot.
		registerMacro({ name: "memory.awaken", description: "foreign", static: true, render: () => "foreign" });
		const f = await fixture();
		f.preset.items = [{ kind: "block", id: "memory", content: "{{memory.awaken}}" }];
		const internal = f.h.session as unknown as { _rebuildSystemPrompt(names: string[]): string };
		const rebuilt = internal._rebuildSystemPrompt(f.h.session.getActiveToolNames());
		expect(rebuilt).not.toContain("foreign");
		expect(await output(f.h.session)).toBe(rebuilt);
	});

	it.each(["manual", "auto"] as const)("refreshes after %s compaction", async (mode) => {
		const f = await fixture();
		f.h.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
		f.h.sessionManager.appendMessage({ role: "user", content: "old user text", timestamp: 0 });
		f.h.sessionManager.appendMessage(fauxAssistantMessage("old assistant text"));
		f.h.session.agent.state.messages = f.h.sessionManager.buildSessionContext().messages;
		f.h.setResponses([fauxAssistantMessage("compacted summary")]);
		expect(await blockOutput(f.h.session)).toBe("initial");
		f.setValue("changed");
		if (mode === "manual") await f.h.session.compact();
		else {
			const internal = f.h.session as unknown as {
				_runAutoCompaction(reason: "threshold", retry: boolean): Promise<boolean>;
			};
			// The return value means "continue with queued messages", not "compacted".
			await internal._runAutoCompaction("threshold", false);
			expect(f.h.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(true);
		}
		expect(await blockOutput(f.h.session)).toBe("changed");
		expect(await blockOutput(f.h.session)).toBe("changed");
		expect(f.render).toHaveBeenCalledTimes(2);
	});

	it("refreshes after reloadPresets reparses the active preset", async () => {
		await assertRefresh((h) => h.session.reloadPresets());
	});

	it("refreshes after successful reload on the same scope", async () => {
		const f = await fixture();
		expect(await output(f.h.session)).toBe("initial");
		f.setValue("changed");
		await f.h.session.reload();
		registerMacro(
			{ name: "epochValue", description: "test", static: true, render: f.render },
			false,
			f.scope!.promptRegistry,
		);
		expect(await output(f.h.session)).toBe("changed");
		expect(await output(f.h.session)).toBe("changed");
		expect(f.render).toHaveBeenCalledTimes(2);
	});

	it("keeps snapshots after a failed runtime update rolls back", async () => {
		const f = await fixture();
		expect(await output(f.h.session)).toBe("initial");
		f.setValue("changed");
		const internal = f.h.session as unknown as {
			_buildRuntimeCore(options: object): Promise<void>;
			_buildRuntime(options: object): Promise<void>;
		};
		vi.spyOn(internal, "_buildRuntimeCore").mockRejectedValueOnce(new Error("failed update"));
		await expect(internal._buildRuntime({})).rejects.toThrow("failed update");
		expect(await output(f.h.session)).toBe("initial");
		expect(f.render).toHaveBeenCalledTimes(1);
	});

	it("refreshes after setActivePreset", async () => {
		await assertRefresh(async (h) => {
			expect((await h.session.setActivePreset("other-epoch")).ok).toBe(true);
		});
	});

	it("invalidates a static prompt cache when only the successful runtime generation changes", async () => {
		const f = await fixture(false);
		const internal = f.h.session as unknown as {
			_rebuildSystemPrompt(names: string[]): string;
			_buildRuntimeCore(options: object): Promise<void>;
			_buildRuntime(options: object): Promise<void>;
		};
		const names = f.h.session.getActiveToolNames();
		expect(internal._rebuildSystemPrompt(names)).toBe("initial");
		f.setValue("changed");
		vi.spyOn(internal, "_buildRuntimeCore").mockResolvedValueOnce();
		await internal._buildRuntime({});
		expect(internal._rebuildSystemPrompt(names)).toBe("changed");
		expect(await output(f.h.session)).toBe("changed");
		expect(f.render).toHaveBeenCalledTimes(2);
	});

	it("rejects attaching a second session to an already bound external scope", async () => {
		const f = await fixture();
		expect(() => f.scope!.bindModelRuntime(f.h.session.modelRuntime)).toThrow(/already attached/);
	});

	it("drops scope snapshots at disposal", async () => {
		const f = await fixture();
		expect(await output(f.h.session)).toBe("initial");
		const snapshot = f.scope!.macroSnapshot;
		f.scope!.dispose();
		expect(snapshot.entries.size).toBe(0);
	});
});
