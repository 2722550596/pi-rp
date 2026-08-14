import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { getMacro } from "../src/core/prompt-preset/macro-engine.ts";
import { getSlot } from "../src/core/prompt-preset/slot-renderers.ts";
import type {
	MacroDefinition,
	MacroRenderContext,
	SlotDefinition,
	SlotRenderContext,
} from "../src/core/prompt-preset/types.ts";
import { createHarnessWithExtensions, type Harness } from "./test-harness.ts";

function slotContext(state: Record<string, unknown> = {}): SlotRenderContext {
	return {
		runtime: {
			options: { cwd: "" },
			messages: [],
			now: new Date(),
			variables: {},
			skills: [],
			state,
		},
		item: { kind: "slot", id: "test", slot: "custom-slot" },
		preset: { schemaVersion: 1, id: "test", items: [] },
		diagnostics: [],
	};
}

function macroContext(opts: { params?: string; variables?: Record<string, string> } = {}): MacroRenderContext {
	return {
		runtime: {
			options: { cwd: "" },
			messages: [],
			now: new Date(),
			variables: opts.variables ?? {},
			skills: [],
			state: {},
		},
		variables: opts.variables ?? {},
		...(opts.params !== undefined ? { params: opts.params } : {}),
	};
}

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

			expect(slot!.render(slotContext())).toBe("custom slot content");
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

			expect(slot!.render(slotContext({ testValue: "hello" }))).toBe("state value: hello");
			expect(slot!.render(slotContext())).toBe("state value: empty");
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
			expect(slot!.render(slotContext())).toBe("persisted");
		});

		it("overwrites existing custom slot with same name", async () => {
			const { harness: _harness, pi } = await setup();

			pi.registerSlot({
				name: "overwrite-slot",
				description: "First",
				render: () => "first",
			});

			let slot = getSlot("overwrite-slot");
			expect(slot!.render(slotContext())).toBe("first");

			pi.registerSlot({
				name: "overwrite-slot",
				description: "Second",
				render: () => "second",
			});

			slot = getSlot("overwrite-slot");
			expect(slot!.render(slotContext())).toBe("second");
		});

		it("custom slot can opt into the chat-history position without changing the registerSlot signature", async () => {
			const { harness: _harness, pi } = await setup();

			pi.registerSlot({
				name: "positioned-history",
				description: "A custom history insertion point",
				position: "chat-history",
				render: () => "should not render",
			});

			const slot = getSlot("positioned-history");
			expect(slot).toBeDefined();
			expect(slot!.position).toBe("chat-history");

			// The built-in chat-history slot keeps its name and position.
			const builtIn = getSlot("chat-history");
			expect(builtIn).toBeDefined();
			expect(builtIn!.position).toBe("chat-history");
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

			expect(macro!.render(macroContext())).toBe("custom macro content");
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

			expect(macro!.render(macroContext({ params: "test-param", variables: { testVar: "var-value" } }))).toBe(
				"param: test-param, var: var-value",
			);
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
			expect(macro!.render(macroContext())).toBe("first");

			pi.registerMacro({
				name: "overwrite-macro",
				description: "Second",
				render: () => "second",
			});

			macro = getMacro("overwrite-macro");
			expect(macro!.render(macroContext())).toBe("second");
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
			expect(slot!.render(slotContext())).toBe("slot content");
			expect(macro!.render(macroContext())).toBe("macro content");
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
