import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { getModel, type Message } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { defaultPreset } from "../src/core/prompt-preset/index.ts";
import { getSlot, type SlotRenderContext } from "../src/core/prompt-preset/slot-renderers.ts";
import { type SessionEntry, SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { ToolSearchManager } from "../src/core/tool-search/manager.ts";
import type { SearchableTool } from "../src/core/tool-search/search.ts";
import { TOOL_SEARCH_TOOL_NAME, toolSearchParameters } from "../src/core/tool-search/tool-search-definition.ts";
import {
	scanBranchForToolSearchDiscovery,
	type ToolSearchBranchScan,
	type ToolSearchCompactionDetails,
	type ToolSearchManagerContract,
} from "../src/core/tool-search-recovery.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

type ToolResultAgentMessage = Extract<Message, { role: "toolResult" }>;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function deferrableTool(name: string, description = `${name} does things. Second sentence.`): ToolDefinition {
	return {
		name,
		label: name,
		description,
		promptSnippet: `Run ${name}`,
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
	};
}

function toolResultMessage(toolName: string, toolCallId: string, addedToolNames?: string[]): ToolResultAgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp: Date.now(),
		...(addedToolNames ? { addedToolNames } : {}),
	};
}

function searchable(name: string, description = `${name} searches things. More text.`): SearchableTool {
	return { name, description, parameters: [], deferrable: true };
}

function entry(id: string, parentId: string | null, message: Message): SessionEntry {
	return { type: "message", id, parentId, timestamp: new Date().toISOString(), message };
}

/**
 * Deterministic stand-in for ToolSearchManager: echo recompute with recording,
 * so gate/delta/discovery semantics can be asserted precisely.
 */
class FakeToolSearchManager implements ToolSearchManagerContract {
	discovered = new Set<string>();
	searchable: SearchableTool[] = [];
	advertised: string[] = [];
	recomputeCalls: Array<{ active: boolean; tools: readonly string[]; reservedTools: readonly string[] }> = [];
	restoreCalls: string[][] = [];
	discoverCalls: string[][] = [];
	restoreError: Error | undefined;
	failResolver = false;

	private lastTools: readonly { name: string; deferrable: boolean }[] = [];
	private lastActive = false;
	private lastActiveToolNames: readonly string[] = [];

	private computeActiveNames(active: boolean, tools: readonly { name: string; deferrable: boolean }[]): string[] {
		if (!active) return tools.map((tool) => tool.name);
		const names = tools.map((tool) => tool.name);
		const anyFolded = tools.some((tool) => tool.deferrable && !this.discovered.has(tool.name));
		return anyFolded ? [...names, TOOL_SEARCH_TOOL_NAME] : names;
	}

	recompute(input: {
		tools: readonly { name: string; deferrable: boolean }[];
		active: boolean;
		reservedTools?: readonly string[];
	}): { activeToolNames: readonly string[]; activated: boolean; changed: boolean } {
		this.recomputeCalls.push({
			active: input.active,
			tools: input.tools.map((tool) => tool.name),
			reservedTools: input.reservedTools ?? [],
		});
		this.lastTools = input.tools;
		this.lastActive = input.active;
		this.lastActiveToolNames = this.computeActiveNames(input.active, input.tools);
		return { activeToolNames: this.lastActiveToolNames, activated: input.active, changed: false };
	}

	discover(names: readonly string[]): {
		newNames: readonly string[];
		alreadyDiscovered: readonly string[];
		changed: boolean;
	} {
		this.discoverCalls.push([...names]);
		const newNames = names.filter((name) => !this.discovered.has(name));
		for (const name of newNames) this.discovered.add(name);
		// M1 §3.2: discovery immediately recomputes the in-memory active names.
		this.lastActiveToolNames = this.computeActiveNames(this.lastActive, this.lastTools);
		return {
			newNames,
			alreadyDiscovered: names.filter((name) => !newNames.includes(name)),
			changed: newNames.length > 0,
		};
	}

	restore(names: readonly string[]): void {
		this.restoreCalls.push([...names]);
		for (const name of names) this.discovered.add(name);
		if (this.restoreError) throw this.restoreError;
	}

	reset(): void {
		this.discovered.clear();
		this.advertised = [];
		this.lastTools = [];
		this.lastActive = false;
		this.lastActiveToolNames = [];
	}

	getSearchableTools(): readonly SearchableTool[] {
		return this.searchable.filter((tool) => !this.discovered.has(tool.name));
	}

	getActiveToolNames(): readonly string[] {
		return this.lastActiveToolNames;
	}

	isFoldedAndUndiscovered(name: string): boolean {
		if (this.failResolver) throw new Error("resolver boom");
		return this.searchable.some((tool) => tool.name === name) && !this.discovered.has(name);
	}

	getGuidance(name: string): string | undefined {
		return `Tool '${name}' is available but not yet loaded. Call tool_search with query "${name}" to load it.`;
	}

	filterNewNames(names: readonly string[]): readonly string[] {
		return names.filter((name) => !this.discovered.has(name));
	}

	hasDiscovered(name: string): boolean {
		return this.discovered.has(name);
	}

	discoveredSnapshot(): readonly string[] {
		return [...this.discovered];
	}

	getToolSearchDefinition(): ToolDefinition {
		return {
			name: TOOL_SEARCH_TOOL_NAME,
			label: TOOL_SEARCH_TOOL_NAME,
			description: "Search unloaded tools.",
			parameters: toolSearchParameters,
			execute: async () => ({ content: [{ type: "text", text: "" }], details: {} }),
		};
	}

	lastAdvertisedCatalog(): readonly string[] {
		return [...this.advertised];
	}

	markCatalogAdvertised(names: readonly string[]): void {
		this.advertised = [...new Set(names)];
	}

	buildCompactionDetailsSnapshot(extensionAddedNames: readonly string[] = []): ToolSearchCompactionDetails {
		const merged = [...new Set([...this.discovered, ...extensionAddedNames])];
		return {
			toolSearch: { version: 1, discoveredToolNames: merged },
			deferred: { version: 1, addedToolNames: merged },
		};
	}
}

type SessionHooks = {
	_buildRuntimePromise: Promise<void>;
	_restoreToolSearchState(signal?: AbortSignal): Promise<void>;
	_buildToolSearchCompactionDetails(existingDetails: unknown): unknown;
};

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("tool-search session wiring", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-tool-search-wiring-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	async function buildSession(options?: {
		seed?: (sessionManager: SessionManager) => void;
		toolSearchManager?: ToolSearchManagerContract;
		customTools?: ToolDefinition[];
		mode?: "on" | "off" | "auto";
		systemPrompt?: string;
	}): Promise<AgentSession> {
		const sessionManager = SessionManager.inMemory();
		options?.seed?.(sessionManager);
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		settingsManager.applyOverrides({
			toolSearch: { enabled: true, mode: options?.mode ?? "auto", thresholdPercent: 10, reservedTools: [] },
		});
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: () => {
				throw new Error("no LLM calls expected in tool-search wiring tests");
			},
		});
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = await createModelRegistry(authStorage, tempDir);
		const baseLoader = createTestResourceLoader();
		const resourceLoader = options?.systemPrompt
			? { ...baseLoader, getSystemPrompt: () => options.systemPrompt }
			: baseLoader;

		const session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader,
			customTools: options?.customTools,
			toolSearchManager: options?.toolSearchManager,
		});
		await (session as unknown as SessionHooks)._buildRuntimePromise;
		return session;
	}

	it("restore recovers discovered names as a transcript superset, then recomputes (R6/D7)", async () => {
		const manager = new ToolSearchManager();
		const session = await buildSession({
			toolSearchManager: manager,
			mode: "on",
			customTools: [deferrableTool("ext_alpha"), deferrableTool("ext_beta")],
			seed: (sessionManager) => {
				sessionManager.appendMessage({ role: "user", content: "hi", timestamp: 1 });
				sessionManager.appendMessage(toolResultMessage("ext_alpha", "call-1", ["ext_alpha", "ghost_from_history"]));
			},
		});

		// Superset: history-only names stay discovered even though unregistered (C1).
		expect(manager.discoveredSnapshot()).toEqual(["ext_alpha", "ghost_from_history"]);
		const activeNames = session.agent.state.tools.map((tool) => tool.name);
		// Restored ∧ available tools are active — recompute ran AFTER restore (M4 §3.2).
		expect(activeNames).toContain("ext_alpha");
		expect(activeNames).not.toContain("ext_beta");
		expect(activeNames).not.toContain("ghost_from_history");
		// Still-folded tools keep the synthetic tool advertised (D13).
		expect(activeNames).toContain(TOOL_SEARCH_TOOL_NAME);
		session.dispose();
	});

	it("resume seeds the advertised baseline with the restored catalog so the first sync stays silent (D5)", async () => {
		const manager = new ToolSearchManager();
		const session = await buildSession({
			toolSearchManager: manager,
			mode: "on",
			customTools: [deferrableTool("ext_alpha"), deferrableTool("ext_beta")],
			seed: (sessionManager) => {
				sessionManager.appendMessage(toolResultMessage("ext_alpha", "call-1", ["ext_alpha"]));
			},
		});

		// Baseline = post-restore searchable catalog (deferrable − restored):
		// ext_alpha is known to the model, ext_beta is still searchable. Engine
		// synthetic <memory> tools are foldable too (D23 follow-up), so the
		// catalog is larger than the fixture's ext tools — assert on the
		// contract, not the full set.
		const baseline = manager.lastAdvertisedCatalog();
		expect(baseline).toContain("ext_beta");
		expect(baseline).not.toContain("ext_alpha");
		session.syncToolSearchState();
		expect(session.getSteeringMessages()).toEqual([]);
		session.dispose();
	});

	it("D1 batch seam: discovery refreshes the active set, keeps tool_search while folding remains, and is idempotent", async () => {
		const manager = new ToolSearchManager();
		const session = await buildSession({
			toolSearchManager: manager,
			mode: "on",
			customTools: [deferrableTool("ext_alpha"), deferrableTool("ext_beta")],
		});

		let activeNames = session.agent.state.tools.map((tool) => tool.name);
		expect(activeNames).not.toContain("ext_alpha");
		expect(activeNames).toContain(TOOL_SEARCH_TOOL_NAME);

		await session.onToolBatchCompleted([toolResultMessage("tool_search", "call-1", ["ext_alpha"])]);

		activeNames = session.agent.state.tools.map((tool) => tool.name);
		expect(activeNames).toContain("ext_alpha");
		expect(activeNames).toContain(TOOL_SEARCH_TOOL_NAME); // ext_beta still folded

		// Idempotent replay: no state change, no duplicate refresh.
		await session.onToolBatchCompleted([toolResultMessage("tool_search", "call-2", ["ext_alpha"])]);
		expect(session.agent.state.tools.map((tool) => tool.name)).toEqual(activeNames);

		// Drain the ENTIRE remaining folded set — engine synthetic <memory>
		// tools are foldable too (D23 follow-up), so discovering only the ext
		// fixtures no longer empties the catalog.
		const rest = manager.getSearchableTools().map((tool) => tool.name);
		expect(rest).toContain("ext_beta");
		await session.onToolBatchCompleted([toolResultMessage("tool_search", "call-3", rest)]);
		activeNames = session.agent.state.tools.map((tool) => tool.name);
		expect(activeNames).toContain("ext_beta");
		expect(activeNames).not.toContain(TOOL_SEARCH_TOOL_NAME); // nothing folded anymore
		session.dispose();
	});

	it("restore gate (D11): restore failure deactivates tool search, records diagnostics, keeps partial restores", async () => {
		const fake = new FakeToolSearchManager();
		// Models a crash mid-restore: the name is applied, then the bulk entry throws.
		fake.restoreError = new Error("restore boom");
		const session = await buildSession({
			toolSearchManager: fake,
			mode: "on",
			customTools: [deferrableTool("ext_alpha")],
			seed: (sessionManager) => {
				sessionManager.appendMessage(toolResultMessage("ext_alpha", "call-1", ["part_a"]));
			},
		});

		expect(fake.restoreCalls).toEqual([["part_a"]]);
		expect(fake.discovered.has("part_a")).toBe(true); // partial restore kept
		expect(session.toolSearchDiagnostics.some((line) => line.includes("restore failed"))).toBe(true);
		// Deactivated: every recompute after the failure runs with active=false.
		expect(fake.recomputeCalls.length).toBeGreaterThan(0);
		expect(fake.recomputeCalls.every((call) => call.active === false)).toBe(true);
		// Session stays functional: the eager set (incl. the deferrable tool) is active.
		const activeNames = session.agent.state.tools.map((tool) => tool.name);
		expect(activeNames).toContain("ext_alpha");
		expect(activeNames).not.toContain(TOOL_SEARCH_TOOL_NAME);
		session.dispose();
	});

	it("restore gate (D11): abort cancels the remaining restore and deactivates while keeping restored names", async () => {
		const fake = new FakeToolSearchManager();
		const session = await buildSession({
			toolSearchManager: fake,
			mode: "on",
			customTools: [deferrableTool("ext_alpha")],
			seed: (sessionManager) => {
				sessionManager.appendMessage(toolResultMessage("ext_alpha", "call-1", ["part_a"]));
			},
		});
		expect(fake.restoreCalls).toEqual([["part_a"]]);

		const hooks = session as unknown as SessionHooks;
		await hooks._restoreToolSearchState(AbortSignal.abort());

		expect(fake.restoreCalls).toEqual([["part_a"]]); // cancelled: no second restore
		expect(fake.discovered.has("part_a")).toBe(true);
		expect(session.toolSearchDiagnostics.some((line) => line.includes("aborted"))).toBe(true);
		session.syncToolSearchState();
		expect(fake.recomputeCalls.at(-1)?.active).toBe(false);
		session.dispose();
	});

	it("compaction details merge (D6): branch scan and manager discovered merge into one checkpoint without losing legacy details", async () => {
		const fake = new FakeToolSearchManager();
		const session = await buildSession({
			toolSearchManager: fake,
			mode: "on",
			customTools: [deferrableTool("ext_alpha")],
			seed: (sessionManager) => {
				sessionManager.appendMessage(toolResultMessage("ext_alpha", "call-1", ["ext_scan"]));
			},
		});
		// Manager-side discovered fact (e.g. from an earlier restore) — preload
		// after build: restore now resets derived state first (D22).
		fake.discovered.add("ext_disc");

		const hooks = session as unknown as SessionHooks;
		const merged = hooks._buildToolSearchCompactionDetails({ readFiles: ["a.txt"], legacy: 1 }) as Record<
			string,
			unknown
		>;
		expect(merged.toolSearch).toEqual({ version: 1, discoveredToolNames: ["ext_scan", "ext_disc"] });
		expect(merged.deferred).toEqual({ version: 1, addedToolNames: ["ext_scan", "ext_disc"] });
		expect(merged.readFiles).toEqual(["a.txt"]);
		expect(merged.legacy).toBe(1);

		// Non-object legacy details degrade to the checkpoint-only shape.
		const fallback = hooks._buildToolSearchCompactionDetails("legacy-string") as Record<string, unknown>;
		expect(Object.keys(fallback).sort()).toEqual(["deferred", "toolSearch"]);
		session.dispose();
	});

	it("catalog delta (D4/D5): announced once, deduped after baseline update, discovery removals suppressed", async () => {
		const fake = new FakeToolSearchManager();
		fake.searchable = [searchable("ext_gamma"), searchable("ext_delta")];
		const session = await buildSession({
			toolSearchManager: fake,
			mode: "on",
			customTools: [deferrableTool("ext_gamma"), deferrableTool("ext_delta")],
		});
		// Restore initialized the baseline with the current searchable catalog.
		expect(fake.advertised).toEqual(["ext_gamma", "ext_delta"]);

		session.syncToolSearchState();
		expect(session.getSteeringMessages()).toEqual([]);
		session.syncToolSearchState();
		expect(session.getSteeringMessages()).toEqual([]); // dedup: same state, no re-announce

		fake.searchable.push(searchable("ext_eta"));
		session.syncToolSearchState();
		expect(session.getSteeringMessages()).toEqual(["Tools added: ext_eta"]);

		// A searchable tool vanishing is announced; a name that merely became
		// discovered is loaded, not "removed" (M4 §3.4 step 3).
		fake.discovered.add("ext_gamma");
		fake.searchable = [searchable("ext_delta")];
		session.syncToolSearchState();
		expect(session.getSteeringMessages().at(-1)).toBe("Tools removed: ext_eta");
		session.dispose();
	});

	it("R9 category section: follows the searchable catalog and rebuilds through the active-set refresh", async () => {
		const fake = new FakeToolSearchManager();
		fake.searchable = [searchable("ext_gamma", "Searches things. Second sentence.")];
		const session = await buildSession({
			toolSearchManager: fake,
			mode: "on",
			customTools: [deferrableTool("ext_gamma")],
		});

		expect(session.systemPromptOptions.toolSearchCategories).toEqual([
			{ name: "ext_gamma", description: "Searches things." },
		]);

		await session.onToolBatchCompleted([toolResultMessage("tool_search", "call-1", ["ext_gamma"])]);
		expect(session.systemPromptOptions.toolSearchCategories).toEqual([]);
		session.dispose();
	});

	it("R9 custom-prompt path renders the section and the static cache invalidates on category changes", async () => {
		const fake = new FakeToolSearchManager();
		fake.searchable = [searchable("ext_gamma", "Searches things.")];
		const session = await buildSession({
			toolSearchManager: fake,
			mode: "on",
			customTools: [deferrableTool("ext_gamma")],
			systemPrompt: "Custom system prompt.",
		});

		expect(session.agent.state.systemPrompt).toContain("- ext_gamma — Searches things.");

		fake.searchable = [searchable("ext_delta", "Digs holes.")];
		session.syncToolSearchState();
		const prompt = session.agent.state.systemPrompt;
		expect(prompt).toContain("- ext_delta — Digs holes.");
		expect(prompt).not.toContain("ext_gamma");
		session.dispose();
	});

	it("availability resolver: guidance for folded-undiscovered, undefined otherwise, diagnostics on failure (R8/D18)", async () => {
		const fake = new FakeToolSearchManager();
		fake.searchable = [searchable("ext_gamma")];
		const session = await buildSession({
			toolSearchManager: fake,
			mode: "on",
			customTools: [deferrableTool("ext_gamma")],
		});

		expect(session.resolveToolSearchGuidance("ext_gamma")).toBe(
			`Tool 'ext_gamma' is available but not yet loaded. Call tool_search with query "ext_gamma" to load it.`,
		);
		expect(session.resolveToolSearchGuidance("read")).toBeUndefined();
		expect(session.resolveToolSearchGuidance("no_such_tool")).toBeUndefined();

		fake.failResolver = true;
		expect(session.resolveToolSearchGuidance("ext_gamma")).toBeUndefined();
		expect(session.toolSearchDiagnostics.some((line) => line.includes("resolver failed"))).toBe(true);
		session.dispose();
	});

	it("branch scan (D16/R6): pairs tool_search calls with results, unions addedToolNames, reads the latest checkpoint, skips malformed", () => {
		const branch: SessionEntry[] = [
			entry("e1", null, { role: "user", content: "hi", timestamp: 1 }),
			entry("e2", "e1", {
				role: "assistant",
				content: [
					{ type: "text", text: "searching" },
					{ type: "toolCall", id: "tc-1", name: TOOL_SEARCH_TOOL_NAME, arguments: {} },
					{ type: "toolCall", id: "tc-2", name: "other_tool", arguments: {} },
				],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "m",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 2,
			}),
			entry("e3", "e2", toolResultMessage("other_tool", "tc-2", ["ext_via_wrapper"])),
			entry("e4", "e3", {
				...toolResultMessage(TOOL_SEARCH_TOOL_NAME, "tc-1", ["ext_from_field"]),
				content: [
					{ type: "text", text: JSON.stringify({ tools: [{ name: "ext_from_payload" }, "ext_from_field"] }) },
				],
			}),
			{
				type: "compaction",
				id: "e5",
				parentId: "e4",
				timestamp: new Date().toISOString(),
				summary: "s",
				firstKeptEntryId: "e1",
				tokensBefore: 100,
				details: {
					toolSearch: { version: 1, discoveredToolNames: ["cp_tool"] },
					deferred: { version: 1, addedToolNames: ["cp_tool", "ext_via_wrapper"] },
				},
			},
			entry("e6", "e5", {
				...toolResultMessage("x", "bad", ["valid_after_bad"]),
				// Corrupt persisted data must be skipped, not fail the resume.
				addedToolNames: ["", 42, "valid_after_bad"] as unknown as string[],
			}),
		];

		const scan: ToolSearchBranchScan = scanBranchForToolSearchDiscovery(branch);
		// First-seen order; both sources contribute; malformed entries skipped.
		expect(scan.discoveredNames).toEqual([
			"ext_via_wrapper",
			"ext_from_field",
			"ext_from_payload",
			"valid_after_bad",
		]);
		// Only the latest checkpoint on the branch contributes.
		expect(scan.latestCheckpointNames).toEqual(["cp_tool", "ext_via_wrapper"]);
	});

	it("branch switch (D22/M4 §3.5): sibling-branch discoveries do not leak — X folds back and must be re-searched", async () => {
		let _branchAUserId = "";
		let branchALeafId = "";
		const session = await buildSession({
			mode: "on",
			customTools: [deferrableTool("ext_x"), deferrableTool("ext_y")],
			seed: (sessionManager) => {
				// Branch A: user -> tool result discovering ext_x.
				_branchAUserId = sessionManager.appendMessage({ role: "user", content: "on branch A", timestamp: 1 });
				branchALeafId = sessionManager.appendMessage(toolResultMessage("tool_search", "call-a", ["ext_x"]));
			},
		});

		let activeNames = session.agent.state.tools.map((tool) => tool.name);
		expect(activeNames).toContain("ext_x"); // restored on branch A
		expect(activeNames).not.toContain("ext_y");

		// Branch B: from the root, siblings without the ext_x discovery.
		const sessionManager = session.sessionManager;
		sessionManager.resetLeaf();
		const q2 = sessionManager.appendMessage({ role: "user", content: "on branch B", timestamp: 2 });
		sessionManager.resetLeaf();
		const q3 = sessionManager.appendMessage({ role: "user", content: "another branch B leaf", timestamp: 3 });
		expect(q2).toBeTruthy();
		expect(q3).toBeTruthy();

		const result = await session.navigateTree(q3, { summarize: false });
		expect(result.cancelled).toBe(false);

		activeNames = session.agent.state.tools.map((tool) => tool.name);
		expect(activeNames).not.toContain("ext_x"); // folded again on branch B
		expect(activeNames).toContain(TOOL_SEARCH_TOOL_NAME); // searchable set non-empty again
		expect(activeNames).not.toContain("ext_y");

		// Navigating back to branch A's leaf restores the fact.
		const back = await session.navigateTree(branchALeafId, { summarize: false });
		expect(back.cancelled).toBe(false);
		expect(session.agent.state.tools.map((tool) => tool.name)).toContain("ext_x");
		session.dispose();
	});

	it("R9 preset path: the tools slot renders the category section (and nothing when empty)", () => {
		const slot = getSlot("tools");
		expect(slot).toBeDefined();

		const baseRuntime = {
			messages: [],
			latestUserMessage: undefined,
			now: new Date(),
			variables: {},
			skills: [],
		} as const;
		const renderWith = (categories: readonly ToolSearchCategory[] | undefined): string => {
			const ctx = {
				runtime: {
					...baseRuntime,
					options: {
						cwd: tempDir,
						selectedTools: ["read"],
						toolSnippets: { read: "Read files." },
						toolSearchCategories: categories,
					},
				},
				preset: defaultPreset,
				item: { kind: "slot", slot: "tools" },
				diagnostics: [],
			} as unknown as SlotRenderContext;
			return slot!.render(ctx) as string;
		};

		const withCategories = renderWith([{ name: "ext_gamma", description: "Searches things." }]);
		expect(withCategories).toContain("- read: Read files.");
		expect(withCategories).toContain("- ext_gamma — Searches things.");

		expect(renderWith([])).not.toContain("ext_gamma");
		expect(renderWith(undefined)).not.toContain("tool_search");
	});

	it("mode=off keeps the legacy path: no tool_search, no folding, no notifications", async () => {
		const session = await buildSession({
			mode: "off",
			customTools: [deferrableTool("ext_alpha")],
		});
		const activeNames = session.agent.state.tools.map((tool) => tool.name);
		expect(activeNames).toContain("ext_alpha");
		expect(activeNames).not.toContain(TOOL_SEARCH_TOOL_NAME);
		expect(session.getSteeringMessages()).toEqual([]);
		// Undefined/[] both mean "render nothing" (zero overhead).
		expect(session.systemPromptOptions.toolSearchCategories ?? []).toEqual([]);
		session.dispose();
	});
});
