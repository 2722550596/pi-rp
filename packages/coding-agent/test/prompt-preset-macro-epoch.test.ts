import { describe, expect, it, vi } from "vitest";
import { compileMessages } from "../src/core/prompt-preset/compiler.ts";
import { expandContentMacros, expandMacros } from "../src/core/prompt-preset/macro-engine.ts";
import { PromptRegistryScope } from "../src/core/prompt-preset/registry-scope.ts";
import type { PromptPreset, PromptPresetDiagnostic, PromptRuntime } from "../src/core/prompt-preset/types.ts";
import { createAgentSessionScope } from "../src/core/session-scope.ts";
import { getMessageText } from "./suite/harness.ts";

function fixture() {
	const scope = createAgentSessionScope();
	let value = "initial";
	const render = vi.fn(() => value);
	scope.promptRegistry.registerMacro({ name: "epoch", description: "test", static: true, render });
	const runtime = (): PromptRuntime => ({
		options: { cwd: "/first", selectedTools: ["read"] },
		messages: [],
		now: new Date(0),
		variables: {},
		skills: [],
		promptRegistry: scope.promptRegistry,
		macroSnapshot: scope.macroSnapshot,
	});
	return {
		scope,
		render,
		runtime,
		setValue(next: string) {
			value = next;
		},
	};
}

function preset(items: PromptPreset["items"]): PromptPreset {
	return { schemaVersion: 1, id: "epoch", items };
}

describe("static macro epoch expansion", () => {
	it.each(["heading", "ending"] as const)("snapshots a macro appearing only in %s", async (position) => {
		const f = fixture();
		const p = preset([{ kind: "block", id: "body", content: "body", [position]: "{{epoch}}" }]);
		const expected = position === "heading" ? "initial\nbody" : "body\ninitial";
		expect((await compileMessages(p, f.runtime())).messages.map(getMessageText)).toEqual([expected]);
		f.setValue("changed");
		expect((await compileMessages(p, f.runtime())).messages.map(getMessageText)).toEqual([expected]);
		expect(f.render).toHaveBeenCalledTimes(1);
		f.scope.invalidateMacroEpoch();
		expect((await compileMessages(p, f.runtime())).messages.map(getMessageText)).toEqual([
			position === "heading" ? "changed\nbody" : "body\nchanged",
		]);
		expect(f.render).toHaveBeenCalledTimes(2);
		f.scope.dispose();
	});

	it("reuses calls across items, slot output, slot options, and message content", async () => {
		const f = fixture();
		f.scope.promptRegistry.registerSlot({ name: "epoch-slot", description: "test", render: () => "{{epoch}}" });
		f.scope.promptRegistry.registerSlot({
			name: "epoch-options",
			description: "test",
			render: (ctx) => String(ctx.item.options?.path),
		});
		const p = preset([
			{ kind: "block", id: "a", content: "{{epoch}}", role: "system" },
			{ kind: "block", id: "b", content: "{{epoch}}", role: "user" },
			{ kind: "slot", id: "c", slot: "epoch-slot", role: "assistant" },
			{ kind: "slot", id: "d", slot: "epoch-options", role: "user", options: { path: "{{epoch}}" } },
		]);
		expect((await compileMessages(p, f.runtime())).messages.map(getMessageText)).toEqual([
			"initial",
			"initial",
			"initial",
			"initial",
		]);
		f.setValue("changed");
		expect(expandContentMacros([{ type: "text", text: "{{epoch}}" }], f.runtime())).toBe("initial");
		expect(f.render).toHaveBeenCalledTimes(1);
		f.scope.dispose();
	});

	it("does not cache unknown calls before a late registration", () => {
		const f = fixture();
		expect(expandMacros("{{late}}", f.runtime())).toBe("{{late}}");
		const render = vi.fn(() => "registered");
		f.scope.promptRegistry.registerMacro({ name: "late", description: "test", static: true, render });
		expect(expandMacros("{{late}} {{late}}", f.runtime())).toBe("registered registered");
		expect(render).toHaveBeenCalledTimes(1);
		f.scope.dispose();
	});

	it("preserves unsupported nested static calls and warns without running nested side effects", () => {
		const f = fixture();
		const current = f.runtime();
		const diagnostics: PromptPresetDiagnostic[] = [];
		const text = "{{epoch:{{setvar::x::changed}}}}";
		expect(expandMacros(text, current, { diagnostics })).toBe(text);
		expect(diagnostics.map((d) => d.level)).toEqual(["warning"]);
		expect(current.variables).toEqual({});
		expect(f.render).toHaveBeenCalledTimes(0);
		expect(expandMacros("{{epoch}}", current)).toBe("initial");
		expect(f.render).toHaveBeenCalledTimes(1);
		f.scope.dispose();
	});

	it("distinguishes parameters, empty parameters, and empty rendered values", () => {
		const registry = new PromptRegistryScope();
		const render = vi.fn(({ params }: { params?: string }) => (params === undefined ? "none" : params));
		registry.registerMacro({ name: "param", description: "test", static: true, render });
		const f = fixture();
		const current = { ...f.runtime(), promptRegistry: registry };
		expect(expandMacros("{{param}}|{{param:}}|{{param:a}}|{{param:}}|{{param:a}}", current)).toBe("none||a||a");
		expect(render).toHaveBeenCalledTimes(3);
		f.scope.dispose();
	});

	it("preserves parser order and never rescans rendered values, including cache hits", () => {
		const f = fixture();
		f.setValue("{{getvar::x}}");
		const current = f.runtime();
		const text = "{{setvar::x::one}}{{epoch}}|{{getvar::x}}|{{setvar::x::two}}{{epoch}}|{{getvar::x}}";
		expect(expandMacros(text, current)).toBe("{{getvar::x}}|one|{{getvar::x}}|two");
		expect(f.render).toHaveBeenCalledTimes(1);
		f.scope.dispose();
	});

	it("does not render deferred static calls or calls in skipped compilation", async () => {
		const f = fixture();
		expect(expandMacros("{{epoch}}", f.runtime(), { mode: "dynamic" })).toBe("{{epoch}}");
		const p = preset([{ kind: "block", id: "a", content: "{{epoch}}" }]);
		expect(
			(await compileMessages(p, { ...f.runtime(), skipMacroExpansion: true })).messages.map(getMessageText),
		).toEqual(["{{epoch}}"]);
		expect(f.render).toHaveBeenCalledTimes(0);
		expect(expandMacros("{{epoch}}", f.runtime(), { mode: "static" })).toBe("initial");
		f.setValue("changed");
		expect(expandMacros("{{epoch}}", f.runtime())).toBe("initial");
		expect(f.render).toHaveBeenCalledTimes(1);
		f.scope.dispose();
	});
});
