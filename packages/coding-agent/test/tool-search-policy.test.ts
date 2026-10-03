import { estimateToolsTokens } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { ToolSearchEntry } from "../src/core/tool-search/manager.ts";
import { shouldActivateToolSearch, type ToolSearchActivationInput } from "../src/core/tool-search-policy.ts";

function entry(name: string, description: string, exposure: ToolSearchEntry["exposure"] = "direct"): ToolSearchEntry {
	return { name, description, parameters: Type.Object({}), exposure };
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
		const tools = [entry("big_tool", "x".repeat(4000))];
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
		const tools = [entry("big_tool", "x".repeat(8000))];
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
		const tools = [entry("tool", "y".repeat(2000))];
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

	it("counts non-direct tools as zero foldable burden", () => {
		const tools = [entry("forced_tool", "x".repeat(8000), "codemode")];
		expect(shouldActivateToolSearch(autoInput({ contextWindow: 10_000, tools }))).toBe(false);
	});

	it("reserved tools are excluded from the estimation set (potential folding set semantics)", () => {
		const reserved = entry("reserved_tool", "x".repeat(4000));
		const small = entry("small_tool", "tiny");
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
