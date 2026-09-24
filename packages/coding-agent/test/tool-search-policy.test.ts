import { estimateToolsTokens } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { createSyntheticSourceInfo, type SourceInfo } from "../src/core/source-info.ts";
import type { ToolSearchEntry } from "../src/core/tool-search/manager.ts";
import {
	normalizeDeferrable,
	shouldActivateToolSearch,
	type ToolSearchActivationInput,
} from "../src/core/tool-search-policy.ts";

function definition(name: string, overrides: Partial<ToolDefinition> = {}): ToolDefinition {
	return {
		name,
		label: name,
		description: "test tool",
		parameters: Type.Object({}),
		execute: async () => ({ content: [], details: undefined }),
		...overrides,
	};
}

function source(source: string): SourceInfo {
	return createSyntheticSourceInfo(`<${source}:x>`, { source });
}

function entry(name: string, description: string, deferrable: boolean): ToolSearchEntry {
	return { name, description, parameters: Type.Object({}), deferrable };
}

function autoInput(overrides: Partial<ToolSearchActivationInput>): ToolSearchActivationInput {
	return {
		enabled: true,
		mode: "auto",
		thresholdPercent: 10,
		contextWindow: 1_000_000,
		reservedTools: [],
		tools: [],
		...overrides,
	};
}

describe("normalizeDeferrable", () => {
	it("returns false for native tools regardless of declaration", () => {
		// Native 7 never fold, even when the author mis-declares deferrable: true (R5 backstop).
		for (const name of ["read", "bash", "edit", "write", "grep", "find", "ls"]) {
			expect(normalizeDeferrable(definition(name, { deferrable: true }), source("builtin"))).toBe(false);
			// Name-based backstop even if the source marker were not "builtin".
			expect(normalizeDeferrable(definition(name), source("package"))).toBe(false);
		}
	});

	it("defaults extension tools to foldable", () => {
		expect(normalizeDeferrable(definition("my_tool"), source("package"))).toBe(true);
		expect(normalizeDeferrable(definition("my_tool"), source("top-level"))).toBe(true);
	});

	it("folds engine-synthesized builtin-source tools that are not native-7 (D23 follow-up: <memory> tools)", () => {
		// The <memory> synthetic extension reuses source "builtin" for 12
		// low-frequency tools; only the native-7 NAME set is forced eager (R5).
		expect(normalizeDeferrable(definition("recall", { deferrable: true }), source("builtin"))).toBe(true);
		expect(normalizeDeferrable(definition("awaken"), source("builtin"))).toBe(true);
		expect(normalizeDeferrable(definition("recall", { deferrable: false }), source("builtin"))).toBe(false);
	});

	it("defaults SDK custom tools to foldable", () => {
		expect(normalizeDeferrable(definition("sdk_tool"), source("sdk"))).toBe(true);
	});

	it("explicit declaration wins for non-native tools", () => {
		expect(normalizeDeferrable(definition("my_tool", { deferrable: false }), source("package"))).toBe(false);
		expect(normalizeDeferrable(definition("my_tool", { deferrable: true }), source("sdk"))).toBe(true);
		expect(normalizeDeferrable(definition("my_tool", { deferrable: false }), source("sdk"))).toBe(false);
	});
});

/** Mirrors the wire-tool mapping used inside shouldActivateToolSearch (name/description/parameters only). */
function wireEstimate(tools: ToolSearchEntry[]): number {
	return estimateToolsTokens(
		tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
	);
}

describe("shouldActivateToolSearch", () => {
	it("enabled=false never activates, even in on mode", () => {
		expect(shouldActivateToolSearch(autoInput({ enabled: false, mode: "on" }))).toBe(false);
	});

	it("mode=off never activates", () => {
		expect(shouldActivateToolSearch(autoInput({ mode: "off" }))).toBe(false);
	});

	it("mode=on activates regardless of token threshold", () => {
		expect(shouldActivateToolSearch(autoInput({ mode: "on", thresholdPercent: 100, tools: [] }))).toBe(true);
	});

	it("auto applies the >= boundary: estimate below, equal to, and above the threshold", () => {
		const tools = [entry("big_tool", "x".repeat(4000), true)];
		const estimated = wireEstimate(tools);
		// thresholdPercent=50 keeps the math exact: the threshold amount is 0.5 * contextWindow.
		// estimate < threshold -> false
		expect(
			shouldActivateToolSearch(autoInput({ thresholdPercent: 50, contextWindow: estimated * 2 + 2, tools })),
		).toBe(false);
		// estimate == threshold (boundary activates, M5 §3.6) -> true
		expect(shouldActivateToolSearch(autoInput({ thresholdPercent: 50, contextWindow: estimated * 2, tools }))).toBe(
			true,
		);
		// estimate > threshold -> true
		expect(shouldActivateToolSearch(autoInput({ thresholdPercent: 50, contextWindow: estimated, tools }))).toBe(true);
	});

	it("auto stays inactive when the context window is invalid and reports a diagnostic", () => {
		const diagnostics: string[] = [];
		const tools = [entry("big_tool", "x".repeat(8000), true)];
		for (const contextWindow of [0, -5, Number.NaN]) {
			expect(
				shouldActivateToolSearch(autoInput({ contextWindow, tools }), (message) => diagnostics.push(message)),
			).toBe(false);
		}
		expect(diagnostics).toHaveLength(3);
		expect(diagnostics[0]).toContain("contextWindow");
	});

	it("auto falls back to the default threshold when thresholdPercent is invalid", () => {
		// Fallback threshold 10%: inactive when contextWindow > 10 * estimated, while a raw
		// threshold of -5 would produce a negative boundary and (wrongly) activate.
		const tools = [entry("tool", "y".repeat(2000), true)];
		const estimated = wireEstimate(tools);
		for (const thresholdPercent of [Number.NaN, -5]) {
			expect(
				shouldActivateToolSearch(autoInput({ thresholdPercent, contextWindow: estimated * 10 + 4, tools })),
			).toBe(false);
		}
		expect(shouldActivateToolSearch(autoInput({ thresholdPercent: -5, contextWindow: estimated * 5, tools }))).toBe(
			true,
		);
	});

	it("counts non-deferrable tools as zero foldable burden", () => {
		const tools = [entry("forced_tool", "x".repeat(8000), false)];
		expect(shouldActivateToolSearch(autoInput({ contextWindow: 10_000, tools }))).toBe(false);
	});

	it("reserved tools are excluded from the estimation set (potential folding set semantics)", () => {
		const reserved = entry("reserved_tool", "x".repeat(4000), true);
		const small = entry("small_tool", "tiny", true);
		const withReserved = wireEstimate([reserved, small]);
		const withoutReserved = wireEstimate([small]);
		expect(withReserved).toBeGreaterThan(withoutReserved);
		// thresholdPercent=50 puts the boundary exactly at withReserved: counting the forced-eager
		// reserved tool would cross it and activate; the ruling (estimate = potential folding set)
		// excludes it, so the small remainder stays inactive.
		const contextWindow = withReserved * 2;
		expect(
			shouldActivateToolSearch(
				autoInput({
					thresholdPercent: 50,
					contextWindow,
					reservedTools: ["reserved_tool"],
					tools: [reserved, small],
				}),
			),
		).toBe(false);
		expect(
			shouldActivateToolSearch(autoInput({ thresholdPercent: 50, contextWindow, tools: [reserved, small] })),
		).toBe(true);
	});
});
