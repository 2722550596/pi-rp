import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "../extensions/types.ts";
import { ToolSearchManager } from "./manager.ts";
import {
	firstSentence,
	type SearchableTool,
	searchTools,
	TOOL_SEARCH_ALL_LOADED_MESSAGE,
	TOOL_SEARCH_HARD_BUDGET_MS,
	TOOL_SEARCH_NO_MATCH_MESSAGE,
	TOOL_SEARCH_PATTERN_MAX_LENGTH,
	type ToolSearchDetails,
} from "./search.ts";
import { TOOL_SEARCH_TOOL_NAME } from "./tool-search-definition.ts";

function tool(name: string, overrides: Partial<SearchableTool> = {}): SearchableTool {
	return {
		name,
		description: `${name} tool`,
		parameters: [],
		deferrable: true,
		...overrides,
	};
}

/** Narrow helper for asserting an "ok" outcome's ordered matches. */
function matchedNames(outcome: ReturnType<typeof searchTools>): string[] {
	if (outcome.status !== "ok") {
		const detail = outcome.status === "invalid" ? outcome.reason : outcome.text;
		throw new Error(`expected ok outcome, got ${outcome.status}: ${detail}`);
	}
	return outcome.matchedToolNames;
}

describe("searchTools field coverage", () => {
	it("matches each of the four field categories", () => {
		const snapshot = [
			tool("alpha-runner", { description: "Runs jobs fast" }),
			tool("zeta", { description: "manages kubernetes pods" }),
			tool("gamma", { description: "Deploy helper", promptSnippet: "Deploys to kubernetes clusters" }),
			tool("delta", { description: "Cloud utility", parameters: [{ name: "region" }] }),
			tool("epsilon", {
				description: "Storage",
				parameters: [{ name: "bucket", description: "s3 bucket region selector" }],
			}),
		];
		expect(matchedNames(searchTools(snapshot, { keywords: ["alpha"] }))).toEqual(["alpha-runner"]);
		expect(matchedNames(searchTools(snapshot, { keywords: ["kubernetes"] }))).toEqual(["gamma", "zeta"]);
		expect(matchedNames(searchTools(snapshot, { keywords: ["region"] }))).toEqual(["delta", "epsilon"]);
	});

	it("matches case-insensitively but returns original-case names", () => {
		const snapshot = [tool("MyTool", { description: "DATABASE helper" })];
		expect(matchedNames(searchTools(snapshot, { keywords: ["database"] }))).toEqual(["MyTool"]);
		expect(matchedNames(searchTools(snapshot, { keywords: ["MYTOOL"] }))).toEqual(["MyTool"]);
		expect(matchedNames(searchTools(snapshot, { pattern: "mytool" }))).toEqual(["MyTool"]);
	});

	it("omits promptSnippet from matching when absent", () => {
		const snapshot = [tool("plain", { description: "plain tool" })];
		expect(searchTools(snapshot, { keywords: ["snippet"] }).status).toBe("no-match");
	});
});

describe("searchTools query combination", () => {
	it("ANDs keywords across fields with OR within a field set", () => {
		const snapshot = [
			tool("both", { description: "database migration guide" }),
			tool("only-database", { description: "database helper" }),
			tool("only-migration", { description: "migration helper" }),
		];
		expect(matchedNames(searchTools(snapshot, { keywords: ["database", "migration"] }))).toEqual(["both"]);
	});

	it("ANDs pattern and keywords when both are provided", () => {
		const snapshot = [
			tool("a-tool", { description: "kubernetes database tools" }),
			tool("b-tool", { description: "kubernetes file tools" }),
			tool("c-tool", { description: "local database tools" }),
		];
		expect(matchedNames(searchTools(snapshot, { pattern: "kub.*net", keywords: ["database"] }))).toEqual(["a-tool"]);
	});

	it("supports regex-only matches and adds the regex bonus once", () => {
		const snapshot = [
			tool("deployer", { description: "ships to kubernetes clusters" }),
			tool("unrelated", { description: "nothing here" }),
		];
		const outcome = searchTools(snapshot, { pattern: "kub.*net" });
		expect(matchedNames(outcome)).toEqual(["deployer"]);
	});
});

describe("searchTools scoring, ordering and limit", () => {
	it("ranks by the explainable score bands (M3 §3 step 8)", () => {
		const snapshot = [
			tool("zeta", { description: "database helper" }),
			tool("mydatabase", { description: "misc" }),
			tool("database", { description: "misc" }),
			tool("database-migrator", { description: "misc" }),
			tool("other", { parameters: [{ name: "database" }] }),
			tool("aardvark", { description: "misc", parameters: [{ name: "x", description: "the database field" }] }),
		];
		expect(matchedNames(searchTools(snapshot, { keywords: ["database"], limit: 10 }))).toEqual([
			"database", // name exact = 100
			"database-migrator", // name prefix = 70
			"mydatabase", // name substring = 50
			"zeta", // description = 30
			"other", // parameter name = 25
			"aardvark", // parameter description = 15
		]);
	});

	it("adds scores across keywords and breaks ties by name then snapshot order", () => {
		const snapshot = [
			tool("mzz", { description: "database migration helper" }),
			tool("maa", { description: "database migration helper" }),
			tool("sub", { description: "misc" }),
		];
		expect(matchedNames(searchTools(snapshot, { keywords: ["database", "migration"] }))).toEqual(["maa", "mzz"]);
		// maa/mzz: 30 + 30 = 60 each, tie → name order. sub misses "migration" → excluded.
	});

	it("defaults limit to 5, clamps out-of-range values, and truncates only after sorting", () => {
		const snapshot = ["t6", "t1", "t2", "t3", "t4", "t5", "t0"].map((name) => tool(name));
		expect(matchedNames(searchTools(snapshot, { keywords: ["t"] }))).toEqual(["t0", "t1", "t2", "t3", "t4"]);
		expect(matchedNames(searchTools(snapshot, { keywords: ["t"], limit: 1 }))).toEqual(["t0"]);
		expect(matchedNames(searchTools(snapshot, { keywords: ["t"], limit: 999 }))).toHaveLength(7);
		expect(matchedNames(searchTools(snapshot, { keywords: ["t"], limit: 0 }))).toHaveLength(1);

		const scored = [tool("aaa", { description: "misc" }), tool("database", { description: "misc" })];
		expect(matchedNames(searchTools(scored, { keywords: ["database"], limit: 1 }))).toEqual(["database"]);
	});
});

describe("searchTools input boundaries (D10)", () => {
	const snapshot = [tool("anything", { description: "text" })];

	function invalidReason(request: { pattern?: string; keywords?: string[] }): string {
		const outcome = searchTools(snapshot, request);
		if (outcome.status !== "invalid") throw new Error(`expected invalid outcome, got ${outcome.status}`);
		return outcome.reason;
	}

	it("rejects oversized, malformed and dangerous patterns", () => {
		expect(invalidReason({ pattern: "a".repeat(TOOL_SEARCH_PATTERN_MAX_LENGTH + 1) })).toContain("exceeds 200");
		expect(invalidReason({ pattern: "(" })).toContain("invalid regular expression");
		expect(invalidReason({ pattern: "[a-" })).toContain("invalid regular expression");
		expect(invalidReason({ pattern: "(a)\\1" })).toContain("backreference");
		expect(invalidReason({ pattern: "(?<n>a)\\k<n>" })).toContain("backreference");
		expect(invalidReason({ pattern: "(?<=a)b" })).toContain("lookbehind");
		expect(invalidReason({ pattern: "(?<!a)b" })).toContain("lookbehind");
		expect(invalidReason({ pattern: "x{101}" })).toContain("quantifier");
		expect(invalidReason({ pattern: "x{101,}" })).toContain("quantifier");
		expect(invalidReason({ pattern: "x{50,101}" })).toContain("quantifier");
	});

	it("accepts the allowed grammar", () => {
		expect(searchTools(snapshot, { pattern: "x{100}|text" }).status).toBe("ok");
		expect(searchTools(snapshot, { pattern: "x{2,}|text" }).status).toBe("ok");
		// Escape-aware guard: the paren is escaped, so this is literal text, not a lookbehind.
		expect(searchTools(snapshot, { pattern: "\\(?<=a|text" }).status).toBe("ok");
	});

	it("rejects empty queries and empty keywords; empty pattern counts as absent", () => {
		expect(searchTools(snapshot, {}).status).toBe("invalid");
		expect(searchTools(snapshot, { keywords: [] }).status).toBe("invalid");
		expect(searchTools(snapshot, { keywords: [""] }).status).toBe("invalid");
		expect(searchTools(snapshot, { keywords: ["   "] }).status).toBe("invalid");
		expect(searchTools(snapshot, { pattern: "" }).status).toBe("invalid");
		expect(searchTools(snapshot, { pattern: "", keywords: ["text"] }).status).toBe("ok");
	});
});

describe("searchTools empty results", () => {
	it("distinguishes all-loaded from no-match without leaking names", () => {
		expect(searchTools([], { keywords: ["x"] })).toEqual({
			status: "all-loaded",
			text: TOOL_SEARCH_ALL_LOADED_MESSAGE,
		});
		expect(searchTools([tool("known", { description: "present" })], { keywords: ["absent"] })).toEqual({
			status: "no-match",
			text: TOOL_SEARCH_NO_MATCH_MESSAGE,
		});
	});
});

describe("searchTools result text", () => {
	it("renders one line per hit with the first sentence only (R3)", () => {
		const snapshot = [
			tool("alpha", { description: "Deploys tools fast. Second sentence! Third? more" }),
			tool("beta", { description: "No terminator at all but mentions tools" }),
			tool("gamma", { description: "中文描述。第二句提到 tools" }),
		];
		const outcome = searchTools(snapshot, { keywords: ["tools"], limit: 10 });
		expect(outcome.status === "ok" && outcome.text).toBe(
			"alpha — Deploys tools fast\nbeta — No terminator at all but mentions tools\ngamma — 中文描述",
		);
	});

	it("caps the first-sentence excerpt at 240 code units", () => {
		expect(firstSentence("x".repeat(300))).toHaveLength(240);
		expect(firstSentence("short. rest")).toBe("short");
		expect(firstSentence(".leading")).toBe(".leading"); // empty prefix skipped, whole text kept
	});
});

describe("tool_search execute adapter (R3/D3/D15)", () => {
	function buildActiveManager(): ToolSearchManager {
		const manager = new ToolSearchManager();
		manager.recompute({
			tools: [
				{ name: "read", description: "native read tool", parameters: Type.Object({}), deferrable: false },
				{
					name: "alpha-tool",
					description: "Alpha tool for alpha things",
					parameters: Type.Object({}),
					deferrable: true,
				},
				{
					name: "beta-tool",
					description: "Beta tool for beta things",
					parameters: Type.Object({}),
					deferrable: true,
				},
				{
					name: "gamma-tool",
					description: "Gamma tool for gamma things",
					parameters: Type.Object({}),
					deferrable: true,
				},
			],
			active: true,
		});
		return manager;
	}

	const stubContext = {} as ExtensionContext;

	async function runToolSearch(manager: ToolSearchManager, callId: string, params: unknown) {
		const definition = manager.getToolSearchDefinition();
		expect(definition.name).toBe(TOOL_SEARCH_TOOL_NAME);
		return definition.execute(callId, params, undefined, undefined, stubContext);
	}

	function bodyText(result: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
		return result.content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("");
	}

	it("lists body names, sets addedToolNames ⊆ body, and never registers inside execute", async () => {
		const manager = buildActiveManager();
		const first = await runToolSearch(manager, "call-1", { keywords: ["tool"], limit: 1 });
		expect(bodyText(first)).toBe("alpha-tool — Alpha tool for alpha things");
		expect(first.addedToolNames).toEqual(["alpha-tool"]);
		const details = first.details as ToolSearchDetails;
		expect(details.matchedToolNames).toEqual(["alpha-tool"]);
		expect(details.addedToolNames).toEqual(["alpha-tool"]);
		// D3: execute must not have registered the discovery itself.
		expect(manager.hasDiscovered("alpha-tool")).toBe(false);

		// limit=1: addedToolNames only contains the single body-listed tool even
		// though beta/gamma also matched.
		expect(first.addedToolNames).not.toContain("beta-tool");
	});

	it("repeats of the same query add nothing once everything is discovered", async () => {
		const manager = buildActiveManager();
		const first = await runToolSearch(manager, "call-1", { keywords: ["tool"] });
		expect(first.addedToolNames).toEqual(["alpha-tool", "beta-tool", "gamma-tool"]);
		// D1 batch callback registers the names outside execute (D3).
		expect(manager.discover(first.addedToolNames ?? []).newNames).toEqual(["alpha-tool", "beta-tool", "gamma-tool"]);

		const second = await runToolSearch(manager, "call-2", { keywords: ["tool"] });
		expect(bodyText(second)).toBe(TOOL_SEARCH_ALL_LOADED_MESSAGE);
		expect(second.addedToolNames ?? []).toEqual([]);
		expect((second.details as ToolSearchDetails).addedToolNames).toEqual([]);
	});

	it("continues discovery across paginated queries without re-adding (limit=1)", async () => {
		const manager = buildActiveManager();
		const first = await runToolSearch(manager, "call-1", { keywords: ["tool"], limit: 1 });
		expect(bodyText(first)).toBe("alpha-tool — Alpha tool for alpha things");
		expect(first.addedToolNames).toEqual(["alpha-tool"]);
		manager.discover(first.addedToolNames ?? []);

		const second = await runToolSearch(manager, "call-2", { keywords: ["tool"], limit: 1 });
		expect(bodyText(second)).toBe("beta-tool — Beta tool for beta things");
		expect(second.addedToolNames).toEqual(["beta-tool"]); // next undiscovered slice, added exactly once

		const repeat = await runToolSearch(manager, "call-3", { keywords: ["tool"], limit: 1 });
		expect(bodyText(repeat)).toBe("beta-tool — Beta tool for beta things"); // stale D1 registration pending
		manager.discover(["beta-tool"]); // callback lands
		const after = await runToolSearch(manager, "call-4", { keywords: ["tool"], limit: 1 });
		expect(bodyText(after)).toBe("gamma-tool — Gamma tool for gamma things");
		expect(after.addedToolNames).toEqual(["gamma-tool"]);
	});

	it("keeps eager tools unsearchable and unreachable via addedToolNames", async () => {
		const manager = buildActiveManager();
		const outcome = await runToolSearch(manager, "call-3", { keywords: ["native"] });
		expect(bodyText(outcome)).toBe(TOOL_SEARCH_NO_MATCH_MESSAGE);
		expect(outcome.addedToolNames ?? []).toEqual([]);
	});

	it("answers hallucinated calls on an empty snapshot with the D15 wording", async () => {
		const manager = buildActiveManager();
		manager.discover(["alpha-tool", "beta-tool", "gamma-tool"]);
		expect(manager.getSearchableTools()).toEqual([]); // snapshot exhausted
		const outcome = await runToolSearch(manager, "call-4", { keywords: ["tool"] });
		expect(bodyText(outcome)).toBe(TOOL_SEARCH_ALL_LOADED_MESSAGE);
		expect(outcome.addedToolNames ?? []).toEqual([]);
	});

	it("surfaces invalid input as a thrown parameter error (existing error semantics)", async () => {
		const manager = buildActiveManager();
		await expect(runToolSearch(manager, "call-5", { pattern: "(a)\\1" })).rejects.toThrow(/backreference/);
		await expect(runToolSearch(manager, "call-6", {})).rejects.toThrow(/at least one/);
	});
});

describe("searchTools performance budget (M3 §9)", () => {
	it("searches a 200-tool catalog with realistic corpus within the hard budget", () => {
		const snapshot: SearchableTool[] = [];
		for (let index = 0; index < 200; index++) {
			snapshot.push({
				name: `mcp-server-${index}-tool`,
				description:
					`Tool number ${index} handles file operations, database queries, and deployments. ` +
					"Padding text for a realistic corpus size across repeated lines. ".repeat(10),
				promptSnippet: `Snippet for tool ${index} with kubernetes hints`,
				parameters: Array.from({ length: 8 }, (_, param) => ({
					name: `param_${param}_${index}`,
					description: `Parameter ${param} description covering region handling for tool ${index}`,
				})),
				deferrable: true,
			});
		}
		const request = { pattern: "data.*base", keywords: ["kubernetes", "region"], limit: 20 };
		searchTools(snapshot, request); // JIT warm-up
		const startedAt = performance.now();
		const outcome = searchTools(snapshot, request);
		const elapsed = performance.now() - startedAt;
		expect(outcome.status).toBe("ok");
		expect(elapsed).toBeLessThan(TOOL_SEARCH_HARD_BUDGET_MS);
	});
});
