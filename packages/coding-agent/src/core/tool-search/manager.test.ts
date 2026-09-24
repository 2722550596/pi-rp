import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import { type ToolSearchEntry, ToolSearchManager } from "./manager.ts";
import type { SearchableTool } from "./search.ts";
import { TOOL_SEARCH_TOOL_NAME, toolSearchParameters } from "./tool-search-definition.ts";

const NATIVE_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;

const emptyParams = Type.Object({});

function entry(name: string, deferrable: boolean, overrides: Partial<ToolSearchEntry> = {}): ToolSearchEntry {
	return { name, description: `${name} description`, parameters: emptyParams, deferrable, ...overrides };
}

function build(tools: ToolSearchEntry[], active: boolean, reserved?: readonly string[]) {
	const manager = new ToolSearchManager();
	const result = manager.recompute({ tools, active, reservedTools: reserved });
	return { manager, result };
}

describe("ToolSearchManager folding sets", () => {
	it("keeps misdeclared native tools eager (R5 code-level backstop)", () => {
		const tools = [
			...NATIVE_TOOL_NAMES.map((name) => entry(name, true)),
			entry("ext-A", true),
			entry("ext-B", false),
		];
		const { manager, result } = build(tools, true);
		expect(result.activated).toBe(true);
		expect(result.activeToolNames).toEqual([...NATIVE_TOOL_NAMES, "ext-B", TOOL_SEARCH_TOOL_NAME]);
		expect(manager.getSearchableTools().map((tool) => tool.name)).toEqual(["ext-A"]);
	});

	it("honors normalized deferrable booleans from the registry build point", () => {
		const tools = [entry("ext-on", true), entry("ext-off", false), entry("read", true)];
		const { manager, result } = build(tools, true);
		expect(result.activeToolNames).toEqual(["ext-off", "read", TOOL_SEARCH_TOOL_NAME]);
		expect(manager.getSearchableTools().map((tool) => tool.name)).toEqual(["ext-on"]);
	});

	it("never activates or advertises tool_search without foldable tools", () => {
		const tools = [entry("read", false), entry("custom", false)];
		const { result } = build(tools, true);
		expect(result.activated).toBe(false);
		expect(result.activeToolNames).toEqual(["read", "custom"]);
		expect(result.activeToolNames).not.toContain(TOOL_SEARCH_TOOL_NAME);
	});

	it("appends tool_search last only while undiscovered foldable tools exist", () => {
		const tools = [entry("read", false), entry("ext-1", true), entry("ext-2", true)];
		const { manager } = build(tools, true);
		expect(manager.getActiveToolNames()).toEqual(["read", TOOL_SEARCH_TOOL_NAME]);
		manager.discover(["ext-1"]);
		expect(manager.getActiveToolNames()).toEqual(["read", "ext-1", TOOL_SEARCH_TOOL_NAME]);
		manager.discover(["ext-2"]);
		expect(manager.getActiveToolNames()).toEqual(["read", "ext-1", "ext-2"]);
		expect(manager.getActiveToolNames()).not.toContain(TOOL_SEARCH_TOOL_NAME);
	});

	it("deactivating keeps discovered tools loaded and only unloads tool_search", () => {
		const tools = [entry("read", false), entry("ext-1", true), entry("ext-2", true)];
		const { manager } = build(tools, true);
		manager.discover(["ext-1"]);
		const deactivated = manager.recompute({ tools, active: false });
		expect(deactivated.activated).toBe(false);
		expect(deactivated.activeToolNames).toEqual(["read", "ext-1", "ext-2"]);
		expect(manager.discoveredSnapshot()).toEqual(["ext-1"]);

		const reactivated = manager.recompute({ tools, active: true });
		expect(reactivated.activeToolNames).toEqual(["read", "ext-1", TOOL_SEARCH_TOOL_NAME]);
		expect(manager.getSearchableTools().map((tool) => tool.name)).toEqual(["ext-2"]);
	});

	it("forces reservedTools eager (R5 eager union)", () => {
		const tools = [entry("mcp-a", true), entry("mcp-b", true)];
		const { manager, result } = build(tools, true, ["mcp-a"]);
		expect(result.activeToolNames).toEqual(["mcp-a", TOOL_SEARCH_TOOL_NAME]);
		expect(manager.getSearchableTools().map((tool) => tool.name)).toEqual(["mcp-b"]);
	});
});

describe("ToolSearchManager discovery and recovery", () => {
	it("discover ignores duplicates, unknown, eager and deny-invisible names", () => {
		const tools = [entry("read", false), entry("ext-1", true), entry("ext-2", true)];
		const { manager } = build(tools, true);
		const first = manager.discover(["ext-1", "ext-1", "unknown", "read", "ext-2"]);
		expect(first).toEqual({ newNames: ["ext-1", "ext-2"], alreadyDiscovered: [], changed: true });
		expect(manager.discoveredSnapshot()).toEqual(["ext-1", "ext-2"]);
	});

	it("discover reports duplicates as alreadyDiscovered without state changes", () => {
		const tools = [entry("ext-1", true)];
		const { manager } = build(tools, true);
		manager.discover(["ext-1"]);
		const activeBefore = manager.getActiveToolNames();
		const second = manager.discover(["ext-1", "ext-1"]);
		expect(second).toEqual({ newNames: [], alreadyDiscovered: ["ext-1"], changed: false });
		expect(manager.getActiveToolNames()).toEqual(activeBefore);
	});

	it("filterNewNames returns each folded name once without mutating state", () => {
		const tools = [entry("read", false), entry("ext-1", true), entry("ext-2", true)];
		const { manager } = build(tools, true);
		const before = manager.discoveredSnapshot();
		expect(manager.filterNewNames(["ext-1", "ext-1", "read", "unknown", "ext-2"])).toEqual(["ext-1", "ext-2"]);
		expect(manager.discoveredSnapshot()).toEqual(before);
		expect(manager.filterNewNames(["ext-1"])).toEqual(["ext-1"]);
	});

	it("restore accepts the transcript superset and never leaks unavailable names", () => {
		const tools = [entry("read", false), entry("ext-1", true), entry("ext-2", true)];
		const { manager } = build(tools, true);
		manager.restore(["ghost", "ext-1", ""]);
		expect(manager.discoveredSnapshot()).toEqual(["ghost", "ext-1"]);

		const result = manager.recompute({ tools, active: true });
		expect(result.activeToolNames).toEqual(["read", "ext-1", TOOL_SEARCH_TOOL_NAME]);
		expect(manager.getSearchableTools().map((tool) => tool.name)).toEqual(["ext-2"]);
		expect(result.activeToolNames).not.toContain("ghost");

		// Hot reload: the registry re-adds a formerly discovered name and it
		// becomes active again without a new search.
		const reloaded = manager.recompute({ tools: [...tools, entry("ghost", true)], active: true });
		expect(reloaded.activeToolNames).toEqual(["read", "ext-1", "ghost", TOOL_SEARCH_TOOL_NAME]);
		expect(manager.getSearchableTools().map((tool) => tool.name)).toEqual(["ext-2"]);
	});

	it("recompute is idempotent for identical input (changed only on transitions)", () => {
		const manager = new ToolSearchManager();
		const tools = [entry("read", false), entry("ext-a", true), entry("ext-b", true)];
		const first = manager.recompute({ tools, active: true });
		expect(first.changed).toBe(true);
		const second = manager.recompute({ tools, active: true });
		expect(second).toEqual({ ...first, changed: false });
		manager.discover(["ext-a"]);
		const third = manager.recompute({ tools, active: true });
		expect(third.changed).toBe(false);
		expect(third.activeToolNames).toEqual(["read", "ext-a", TOOL_SEARCH_TOOL_NAME]);
		// Deactivating while tools remain folded reshapes the active set.
		const fourth = manager.recompute({ tools, active: false });
		expect(fourth.changed).toBe(true);
		expect(fourth.activated).toBe(false);
		expect(fourth.activeToolNames).toEqual(["read", "ext-a", "ext-b"]);
		// Deactivating after everything is discovered (via the restore superset
		// path) is an active-set no-op.
		manager.restore(["ext-b"]);
		const fifth = manager.recompute({ tools, active: true });
		expect(fifth.changed).toBe(false);
		const sixth = manager.recompute({ tools, active: false });
		expect(sixth.changed).toBe(false);
	});
});

describe("ToolSearchManager snapshots and boundaries", () => {
	it("returned snapshots never alias internal state", () => {
		const tools = [entry("read", false), entry("ext-1", true)];
		const { manager } = build(tools, true);
		const active = manager.getActiveToolNames();
		(active as string[]).push("ghost-active");
		const discovered = manager.discoveredSnapshot();
		(discovered as string[]).push("ghost-discovered");
		const searchable = manager.getSearchableTools() as SearchableTool[];
		searchable.push({ name: "ghost-searchable", description: "", parameters: [], deferrable: true });
		const mutableParams = searchable[0]?.parameters as { name: string }[];
		mutableParams.push({ name: "ghost-param" });

		expect(manager.getActiveToolNames()).toEqual(["read", TOOL_SEARCH_TOOL_NAME]);
		expect(manager.discoveredSnapshot()).toEqual([]);
		expect(manager.getSearchableTools()).toHaveLength(1);
		expect(manager.getSearchableTools()[0]?.parameters).toEqual([]);
	});

	it("exposes guidance only for folded-and-undiscovered tools (R8)", () => {
		const trickyName = `we"ird\\name'x`;
		const { manager } = build([entry(trickyName, true), entry("read", false)], true);
		expect(manager.getGuidance("read")).toBeUndefined();
		expect(manager.getGuidance("unknown-name")).toBeUndefined();
		expect(manager.getGuidance(trickyName)).toBe(
			"Tool 'we\"ird\\name\\'x' is available but not yet loaded. Call tool_search with query \"we\\\"ird\\\\name'x\" to load it.",
		);
		manager.discover([trickyName]);
		expect(manager.getGuidance(trickyName)).toBeUndefined();
	});

	it("never exposes names outside the provided catalog (deny closure)", () => {
		const { manager } = build([entry("read", false), entry("ext", true)], true);
		manager.discover(["deny-target", "ext"]);
		manager.restore(["deny-target"]);
		expect(manager.hasDiscovered("deny-target")).toBe(true); // fact superset
		expect(manager.getActiveToolNames()).not.toContain("deny-target");
		expect(manager.getSearchableTools().map((tool) => tool.name)).not.toContain("deny-target");
		expect(manager.filterNewNames(["deny-target"])).toEqual([]);
	});

	it("stores the advertised catalog baseline as copies (D5)", () => {
		const { manager } = build([entry("read", false)], false);
		expect(manager.lastAdvertisedCatalog()).toEqual([]);
		manager.markCatalogAdvertised(["read", "read", "other"]);
		expect(manager.lastAdvertisedCatalog()).toEqual(["read", "other"]);
		const snapshot = manager.lastAdvertisedCatalog();
		(snapshot as string[]).push("ghost");
		expect(manager.lastAdvertisedCatalog()).toEqual(["read", "other"]);
	});

	it("reset drops all in-memory state for branch-switch re-recovery (M4 §3.5)", () => {
		const tools = [entry("read", false), entry("ext-1", true), entry("ext-2", true)];
		const { manager } = build(tools, true);
		manager.discover(["ext-1"]);
		manager.markCatalogAdvertised(["read", "ext-1", TOOL_SEARCH_TOOL_NAME]);

		manager.reset();
		expect(manager.discoveredSnapshot()).toEqual([]);
		expect(manager.getActiveToolNames()).toEqual([]);
		expect(manager.getSearchableTools()).toEqual([]);
		expect(manager.lastAdvertisedCatalog()).toEqual([]);
		expect(manager.getGuidance("ext-2")).toBeUndefined();

		// D22: the catalog survives reset — a recompute with the same input is
		// coherent again without repassing the registry.
		const rechained = manager.recompute({ tools, active: true });
		expect(rechained.activeToolNames).toEqual(["read", TOOL_SEARCH_TOOL_NAME]);

		// Checkout to a sibling branch: only the target branch's facts survive.
		manager.reset();
		manager.restore(["ext-2", "sibling-fact"]);
		const switched = manager.recompute({ tools, active: true });
		expect(switched.activeToolNames).toEqual(["read", "ext-2", TOOL_SEARCH_TOOL_NAME]);
		expect(manager.hasDiscovered("ext-1")).toBe(false);
		expect(manager.hasDiscovered("sibling-fact")).toBe(true);
		expect(manager.getSearchableTools().map((tool) => tool.name)).toEqual(["ext-1"]);
	});

	it("builds merged compaction details with a stable empty structure (D6)", () => {
		const manager = new ToolSearchManager();
		expect(manager.buildCompactionDetailsSnapshot()).toEqual({
			toolSearch: { version: 1, discoveredToolNames: [] },
			deferred: { version: 1, addedToolNames: [] },
		});
		manager.restore(["a"]);
		const junk = 42 as unknown as string;
		const details = manager.buildCompactionDetailsSnapshot(["b", "a", "", junk]);
		expect(details.toolSearch).toEqual({ version: 1, discoveredToolNames: ["a", "b"] });
		expect(details.deferred).toEqual({ version: 1, addedToolNames: ["a", "b"] });
	});
});

describe("tool_search schema (M1 §3.4, D19)", () => {
	it("compiles and enforces the frozen parameter shapes", () => {
		const compiled = Compile(toolSearchParameters);
		expect(compiled.Check({ keywords: ["db"] })).toBe(true);
		expect(compiled.Check({ pattern: "db", limit: 100 })).toBe(true);
		expect(compiled.Check({ keywords: "db" })).toBe(false);
		expect(compiled.Check({ pattern: "db", limit: 0 })).toBe(false);
		expect(compiled.Check({ pattern: "db", limit: 101 })).toBe(false);
	});

	it("contains no string|array unions (D19a)", () => {
		for (const property of Object.values(toolSearchParameters.properties)) {
			expect(Object.keys(property).includes("anyOf")).toBe(false);
		}
	});
});
