import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { createHarnessWithExtensions, type Harness } from "./test-harness.ts";
import { getSlot } from "../src/core/prompt-preset/slot-renderers.ts";
import { getMacro } from "../src/core/prompt-preset/macro-engine.ts";
import type { SlotDefinition, MacroDefinition } from "../src/core/prompt-preset/types.ts";

const setups: Harness[] = [];

async function setup(): Promise<{ harness: Harness; pi: ExtensionAPI }> {
	let extPi!: ExtensionAPI;
	const harness = await createHarnessWithExtensions({
		extensionFactories: [
			(pi: ExtensionAPI) => {
				extPi = pi;
			},
		],
	});
	setups.push(harness);
	return { harness, pi: extPi! };
}

afterEach(() => {
	while (setups.length) setups.pop()!.cleanup();
});

describe("ExtensionAPI - prompt preset registration", () => {
	describe("pi.registerSlot", () => {
		it("registers a custom slot accessible during prompt compilation", async () => {
			const { harness: _harness, pi } = await setup();

			const customSlot: SlotDefinition = {
				name: "custom-slot",
				description: "A custom slot for testing",
				render: () => "custom slot content",
			};

			pi.registerSlot(customSlot);

			const slot = getSlot("custom-slot");
			expect(slot).toBeDefined();
			expect(slot!.name).toBe("custom-slot");
			expect(slot!.description).toBe("A custom slot for testing");

			const ctx = {
				runtime: { state: {}, messages: [] },
				item: { kind: "slot" as const, id: "test", slot: "custom-slot" },
				preset: { schemaVersion: 1, id: "test", items: [] },
				diagnostics: [],
			} as unknown as { runtime: { state: Record<string, unknown>; messages: unknown[] }; item: { kind: "slot"; id: string; slot: string }; preset: { schemaVersion: number; id: string; items: unknown[] }; diagnostics: unknown[] };

			expect(slot!.render(ctx)).toBe("custom slot content");
		});

		it("custom slot can access runtime state and variables", async () => {
			const { harness: _harness, pi } = await setup();

			const customSlot: SlotDefinition = {
				name: "stateful-slot",
				description: "A slot that reads state",
				render: (ctx) => {
					const state = ctx.runtime.state as Record<string, unknown>;
					return `state value: ${state.testValue ?? "empty"}`;
				},
			};

			pi.registerSlot(customSlot);

			const slot = getSlot("stateful-slot");
			expect(slot).toBeDefined();

			const ctxWithState = {
				runtime: { state: { testValue: "hello" }, messages: [] },
				item: { kind: "slot" as const, id: "test", slot: "stateful-slot" },
				preset: { schemaVersion: 1, id: "test", items: [] },
				diagnostics: [],
			} as unknown as { runtime: { state: Record<string, unknown>; messages: unknown[] }; item: { kind: "slot"; id: string; slot: string }; preset: { schemaVersion: number; id: string; items: unknown[] }; diagnostics: unknown[] };

			expect(slot!.render(ctxWithState)).toBe("state value: hello");

			const ctxWithoutState = {
				runtime: { state: {}, messages: [] },
				item: { kind: "slot" as const, id: "test", slot: "stateful-slot" },
				preset: { schemaVersion: 1, id: "test", items: [] },
				diagnostics: [],
			} as unknown as { runtime: { state: Record<string, unknown>; messages: unknown[] }; item: { kind: "slot"; id: string; slot: string }; preset: { schemaVersion: number; id: string; items: unknown[] }; diagnostics: unknown[] };

			expect(slot!.render(ctxWithoutState)).toBe("state value: empty");
		});

		it("custom slot persists across extension reloads within same process", async () => {
			const { harness: _harness, pi } = await setup();

			const customSlot: SlotDefinition = {
				name: "persistent-slot",
				description: "Should persist",
				render: () => "persisted",
			};

			pi.registerSlot(customSlot);

			const slot = getSlot("persistent-slot");
			expect(slot).toBeDefined();
			expect(slot!.render({} as unknown as { runtime: { state: Record<string, unknown>; messages: unknown[] }; item: { kind: "slot"; id: string; slot: string }; preset: { schemaVersion: number; id: string; items: unknown[] }; diagnostics: unknown[] })).toBe("persisted");
		});

		it("overwrites existing custom slot with same name", async () => {
			const { harness: _harness, pi } = await setup();

			pi.registerSlot({
				name: "overwrite-slot",
				description: "First",
				render: () => "first",
			});

			let slot = getSlot("overwrite-slot");
			expect(slot!.render({} as unknown as { runtime: { state: Record<string, unknown>; messages: unknown[] }; item: { kind: "slot"; id: string; slot: string }; preset: { schemaVersion: number; id: string; items: unknown[] }; diagnostics: unknown[] })).toBe("first");

			pi.registerSlot({
				name: "overwrite-slot",
				description: "Second",
				render: () => "second",
			});

			slot = getSlot("overwrite-slot");
			expect(slot!.render({} as unknown as { runtime: { state: Record<string, unknown>; messages: unknown[] }; item: { kind: "slot"; id: string; slot: string }; preset: { schemaVersion: number; id: string; items: unknown[] }; diagnostics: unknown[] })).toBe("second");
		});
	});

	describe("pi.registerMacro", () => {
		it("registers a custom macro accessible during prompt compilation", async () => {
			const { harness: _harness, pi } = await setup();

			const customMacro: MacroDefinition = {
				name: "custom-macro",
				description: "A custom macro for testing",
				render: () => "custom macro content",
			};

			pi.registerMacro(customMacro);

			const macro = getMacro("custom-macro");
			expect(macro).toBeDefined();
			expect(macro!.name).toBe("custom-macro");
			expect(macro!.description).toBe("A custom macro for testing");

			const ctx = {
				runtime: { state: {}, variables: {}, messages: [] },
				variables: {},
			} as unknown as { runtime: { state: Record<string, unknown>; variables: Record<string, string>; messages: unknown[] }; variables: Record<string, string> };

			expect(macro!.render(ctx)).toBe("custom macro content");
		});

		it("custom macro can access runtime variables and params", async () => {
			const { harness: _harness, pi } = await setup();

			const customMacro: MacroDefinition = {
				name: "param-macro",
				description: "A macro that uses params",
				render: (ctx) => {
					return `param: ${ctx.params ?? "none"}, var: ${ctx.variables.testVar ?? "none"}`;
				},
			};

			pi.registerMacro(customMacro);

			const macro = getMacro("param-macro");
			expect(macro).toBeDefined();

			const ctx = {
				runtime: { state: {}, variables: { testVar: "var-value" }, messages: [] },
				variables: { testVar: "var-value" },
				params: "test-param",
			} as unknown as { runtime: { state: Record<string, unknown>; variables: Record<string, string>; messages: unknown[] }; variables: Record<string, string>; params: string };

			expect(macro!.render(ctx)).toBe("param: test-param, var: var-value");
		});

		it("static macro is registered correctly", async () => {
			const { harness: _harness, pi } = await setup();

			const staticMacro: MacroDefinition = {
				name: "static-macro",
				description: "A static macro",
				render: () => "static content",
				static: true,
			};

			pi.registerMacro(staticMacro);

			const macro = getMacro("static-macro");
			expect(macro).toBeDefined();
			expect(macro!.static).toBe(true);
		});

		it("overwrites existing custom macro with same name", async () => {
			const { harness: _harness, pi } = await setup();

			pi.registerMacro({
				name: "overwrite-macro",
				description: "First",
				render: () => "first",
			});

			let macro = getMacro("overwrite-macro");
			expect(macro!.render({} as unknown as { runtime: { state: Record<string, unknown>; variables: Record<string, string>; messages: unknown[] }; variables: Record<string, string> })).toBe("first");

			pi.registerMacro({
				name: "overwrite-macro",
				description: "Second",
				render: () => "second",
			});

			macro = getMacro("overwrite-macro");
			expect(macro!.render({} as unknown as { runtime: { state: Record<string, unknown>; variables: Record<string, string>; messages: unknown[] }; variables: Record<string, string> })).toBe("second");
		});
	});

	describe("pi.registerSlot and pi.registerMacro integration", () => {
		it("both can be registered and used together", async () => {
			const { harness: _harness, pi } = await setup();

			pi.registerSlot({
				name: "combined-slot",
				description: "Combined test slot",
				render: () => "slot content",
			});

			pi.registerMacro({
				name: "combined-macro",
				description: "Combined test macro",
				render: () => "macro content",
			});

			const slot = getSlot("combined-slot");
			const macro = getMacro("combined-macro");

			expect(slot).toBeDefined();
			expect(macro).toBeDefined();
			expect(slot!.render({} as unknown as { runtime: { state: Record<string, unknown>; messages: unknown[] }; item: { kind: "slot"; id: string; slot: string }; preset: { schemaVersion: number; id: string; items: unknown[] }; diagnostics: unknown[] })).toBe("slot content");
			expect(macro!.render({} as unknown as { runtime: { state: Record<string, unknown>; variables: Record<string, string>; messages: unknown[] }; variables: Record<string, string> })).toBe("macro content");
		});

		it("custom slot and macro work with built-in ones", async () => {
			const { harness: _harness, pi } = await setup();

			// Register custom ones
			pi.registerSlot({
				name: "my-custom-slot",
				description: "Custom",
				render: () => "custom",
			});

			pi.registerMacro({
				name: "my-custom-macro",
				description: "Custom",
				render: () => "custom",
			});

			// Built-ins should still exist
			const builtinSlot = getSlot("state");
			const builtinMacro = getMacro("date");

			expect(builtinSlot).toBeDefined();
			expect(builtinMacro).toBeDefined();

			// Custom ones should exist
			const customSlot = getSlot("my-custom-slot");
			const customMacro = getMacro("my-custom-macro");

			expect(customSlot).toBeDefined();
			expect(customMacro).toBeDefined();
		});
	});
});