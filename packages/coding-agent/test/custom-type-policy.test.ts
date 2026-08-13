import { describe, expect, test } from "vitest";
import { createExtensionRuntime } from "../src/core/extensions/loader.ts";
import { DEFAULT_CUSTOM_TYPE_POLICY } from "../src/core/messages.ts";

describe("custom type registry (ExtensionRuntime)", () => {
	test("undeclared types resolve to the default policy", () => {
		const runtime = createExtensionRuntime();
		expect(runtime.getCustomTypePolicy("anything")).toEqual(DEFAULT_CUSTOM_TYPE_POLICY);
	});

	test("registerCustomType stores the declared policy", () => {
		const runtime = createExtensionRuntime();
		runtime.registerCustomType("notice", { context: "exclude", llmRole: "user" });
		expect(runtime.getCustomTypePolicy("notice")).toEqual({ context: "exclude", llmRole: "user" });
	});

	test("first declaration per type wins; later declarations are ignored", () => {
		const runtime = createExtensionRuntime();
		runtime.registerCustomType("x", { context: "exclude", llmRole: "user" });
		runtime.registerCustomType("x", { context: "include", llmRole: "assistant" });
		expect(runtime.getCustomTypePolicy("x")).toEqual({ context: "exclude", llmRole: "user" });
	});

	test("registrations are isolated between runtimes", () => {
		const a = createExtensionRuntime();
		const b = createExtensionRuntime();
		a.registerCustomType("x", { context: "exclude", llmRole: "user" });
		expect(b.getCustomTypePolicy("x")).toEqual(DEFAULT_CUSTOM_TYPE_POLICY);
	});
});
