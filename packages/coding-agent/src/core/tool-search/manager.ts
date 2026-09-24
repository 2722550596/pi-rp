import type { TSchema } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import type { SearchableTool, SearchableToolParameter } from "./search.ts";
import { createToolSearchDefinition, TOOL_SEARCH_TOOL_NAME } from "./tool-search-definition.ts";

/**
 * `ToolSearchManager` — the coding-agent layer's pure logic state machine
 * (design doc `plan/tool-search/10-ToolSearchManager核心状态机.md`).
 *
 * On top of an already allow/deny-filtered registry snapshot it maintains the
 * "foldable but not yet discovered" set and the discovered set, and computes
 * the active tool set for the next turn. It holds no session, never reads the
 * transcript, never executes searches, and never calls `setActiveToolsByName`
 * — the session wiring (M2/M4) applies the computed names. Instances are
 * per-session; the constructor takes no arguments and the first `recompute`
 * builds the catalog.
 */

/** One allow/deny-filtered registry tool as consumed by the manager (M1 §2.1). */
export interface ToolSearchEntry {
	name: string;
	description: string;
	promptSnippet?: string;
	parameters: TSchema;
	/** Already normalized by the registry build point (M5 `normalizeDeferrable`); the manager never reads sourceInfo. */
	deferrable: boolean;
}

export interface ToolSearchManagerInput {
	/** allow/deny 后仍可见的注册工具；不得传入 deny 工具。 */
	tools: readonly ToolSearchEntry[];
	/** R5 已由 M5 判定的激活结果；manager 不重复实现 token 估算。 */
	active: boolean;
	/** R5 追加强制 eager 的工具名（`toolSearch.reservedTools`）；与声明正交，只参与 eager 并集。 */
	reservedTools?: readonly string[];
}

export interface DiscoverResult {
	newNames: readonly string[];
	alreadyDiscovered: readonly string[];
	changed: boolean;
}

export interface ActiveToolsResult {
	activeToolNames: readonly string[];
	activated: boolean;
	changed: boolean;
}

/**
 * details payload written to compaction entries (D6/M4 §3.3). This manager
 * method is the single builder; both arrays are the same merged
 * dedupe(discovered ∪ extension addedToolNames) snapshot.
 */
export interface ToolSearchCompactionDetails {
	toolSearch: { version: 1; discoveredToolNames: string[] };
	deferred: { version: 1; addedToolNames: string[] };
}

/**
 * Native tools that are always eager, even when misdeclared `deferrable: true`
 * (R5 code-level backstop — the manager must not rely on author types alone).
 */
const NATIVE_EAGER_TOOL_NAMES: Record<string, true> = {
	read: true,
	bash: true,
	edit: true,
	write: true,
	grep: true,
	find: true,
	ls: true,
};

/** Order-preserving dedupe that also drops non-string/empty entries (M4 §3.1 step 4). */
function dedupeNames(names: readonly unknown[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const name of names) {
		if (typeof name !== "string" || name.length === 0 || seen.has(name)) continue;
		seen.add(name);
		result.push(name);
	}
	return result;
}

/** Element-wise equality of two deterministically ordered name lists. */
function sameNameList(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) return false;
	for (let index = 0; index < a.length; index++) {
		if (a[index] !== b[index]) return false;
	}
	return true;
}

/** Flatten a TypeBox object schema into searchable parameter descriptors (M3 §2). */
function extractSearchableParameters(schema: TSchema): SearchableToolParameter[] {
	const properties = (schema as { properties?: unknown }).properties;
	if (properties === undefined || typeof properties !== "object") return [];
	const result: SearchableToolParameter[] = [];
	for (const [name, value] of Object.entries(properties as Record<string, unknown>)) {
		const description = (value as { description?: unknown } | undefined)?.description;
		result.push({ name, description: typeof description === "string" ? description : undefined });
	}
	return result;
}

export class ToolSearchManager {
	/** Current allow/deny-filtered catalog in registry order. */
	private catalog = new Map<string, ToolSearchEntry>();
	private searchableParameters = new Map<string, SearchableToolParameter[]>();
	/** Fold-eligible: deferrable ∧ not native-eager ∧ not tool_search ∧ not reserved (R5). */
	private foldableNames = new Set<string>();
	/**
	 * Advertised/searchable set: foldable ∧ undiscovered; empty whenever tool
	 * search is not activated (M1 §3.1 step 3). Gates discovery, searchability
	 * and the synthetic tool's advertisement alike.
	 */
	private foldedNames = new Set<string>();
	/**
	 * Transcript fact superset — may contain names outside the current catalog
	 * (R6/C1). Every downstream use goes through the current catalog / folded
	 * set, so unavailable names never leak into active/catalog/search (R7).
	 */
	private discoveredNames = new Set<string>();
	private activeNames: string[] = [];
	/** Normalized activation: requested active ∧ undiscovered foldable tools exist (M1 §7). */
	private activated = false;
	/** D5 comparison baseline for catalog delta notifications. */
	private advertisedCatalog: string[] = [];
	private cachedDefinition: ToolDefinition | undefined;

	/**
	 * Rebuild the catalog and recompute the active set (M1 §3.1). The caller
	 * must apply allow/deny before passing tools; deny tools must never be
	 * part of the input.
	 */
	recompute(input: ToolSearchManagerInput): ActiveToolsResult {
		const previousActivated = this.activated;
		const previousActiveNames = this.activeNames;

		this.catalog = new Map();
		this.searchableParameters = new Map();
		for (const tool of input.tools) {
			this.catalog.set(tool.name, { ...tool });
			this.searchableParameters.set(tool.name, extractSearchableParameters(tool.parameters));
		}

		const reserved = new Set(input.reservedTools ?? []);
		this.foldableNames = new Set();
		for (const [name, tool] of this.catalog) {
			if (!tool.deferrable) continue;
			if (NATIVE_EAGER_TOOL_NAMES[name]) continue;
			if (name === TOOL_SEARCH_TOOL_NAME) continue;
			if (reserved.has(name)) continue;
			this.foldableNames.add(name);
		}

		const foldedUndiscovered = [...this.foldableNames].filter((name) => !this.discoveredNames.has(name));
		this.activated = input.active === true && foldedUndiscovered.length > 0;
		this.foldedNames = this.activated ? new Set(foldedUndiscovered) : new Set<string>();
		this.activeNames = this.computeActiveToolNames();

		const changed = previousActivated !== this.activated || !sameNameList(previousActiveNames, this.activeNames);
		return { activeToolNames: [...this.activeNames], activated: this.activated, changed };
	}

	/**
	 * Runtime discovery (M1 §3.2). Only names currently in `foldedNames` are
	 * processed; unknown, non-foldable and deny-invisible names are ignored.
	 * Duplicate hits land in `alreadyDiscovered` and never re-emit
	 * `addedToolNames` nor trigger an active refresh.
	 */
	discover(names: readonly string[]): DiscoverResult {
		const newNames: string[] = [];
		const alreadyDiscovered: string[] = [];
		const seen = new Set<string>();
		for (const name of names) {
			if (seen.has(name)) continue;
			seen.add(name);
			if (this.foldedNames.has(name)) {
				this.discoveredNames.add(name);
				this.foldedNames.delete(name);
				newNames.push(name);
			} else if (this.foldableNames.has(name) && this.discoveredNames.has(name)) {
				alreadyDiscovered.push(name);
			}
		}
		if (newNames.length > 0) {
			// Immediate in-memory active refresh (M1 §3.2): discovered tools enter
			// active; the synthetic tool's ad is dropped once nothing remains folded.
			if (this.activated && this.foldedNames.size === 0) this.activated = false;
			this.activeNames = this.computeActiveToolNames();
		}
		return { newNames, alreadyDiscovered, changed: newNames.length > 0 };
	}

	/**
	 * Unique recovery entry point (R6/D7): accepts the transcript superset,
	 * including names outside the current catalog and denied names; they are
	 * kept as facts but cannot surface until a future registry re-adds them.
	 * The caller (M4) must `recompute` afterwards — restore deliberately does
	 * not touch the active state.
	 */
	restore(names: readonly string[]): void {
		for (const name of names) {
			if (typeof name === "string" && name.length > 0) this.discoveredNames.add(name);
		}
	}

	/**
	 * Drop all transcript-derived in-memory state (D22): cleared are
	 * `discoveredNames`, `lastAdvertisedCatalog` and every derived set (folded,
	 * active, activation flag); the recompute-provided catalog/配置 is kept.
	 * Semantic: the truth source (current branch transcript) has switched, so
	 * in-memory state rebuilds wholesale — checkout flow is `reset()` → branch
	 * scan → `restore(targetNames)` → `recompute`, then re-initialize the D5
	 * baseline via `markCatalogAdvertised`. `restore` keeps its union semantics;
	 * resume composes reset + a single restore call into the equivalent union.
	 */
	reset(): void {
		this.foldableNames = new Set();
		this.foldedNames = new Set();
		this.discoveredNames = new Set();
		this.activeNames = [];
		this.activated = false;
		this.advertisedCatalog = [];
	}

	/**
	 * Read-only filter for the synthetic tool's execute (D3): returns the
	 * deduplicated subset of `names` that is currently folded-and-undiscovered,
	 * preserving input order. Never mutates state.
	 */
	filterNewNames(names: readonly string[]): readonly string[] {
		const seen = new Set<string>();
		const result: string[] = [];
		for (const name of names) {
			if (seen.has(name)) continue;
			seen.add(name);
			if (this.foldedNames.has(name)) result.push(name);
		}
		return result;
	}

	/** Stable snapshot of the discovered fact superset (R6). */
	discoveredSnapshot(): readonly string[] {
		return [...this.discoveredNames];
	}

	hasDiscovered(name: string): boolean {
		return this.discoveredNames.has(name);
	}

	/** Stable snapshot of the most recent active computation (M1 §3.3). */
	getActiveToolNames(): readonly string[] {
		return [...this.activeNames];
	}

	isFoldedAndUndiscovered(name: string): boolean {
		return this.foldedNames.has(name);
	}

	/**
	 * Immutable snapshot of searchable tools: folded ∧ undiscovered catalog
	 * entries in registry order (M3 §2 seam). Deny tools cannot appear — they
	 * never entered the catalog (deny closure, 00 §5 invariant 3).
	 */
	getSearchableTools(): readonly SearchableTool[] {
		const result: SearchableTool[] = [];
		for (const [name, entry] of this.catalog) {
			if (!this.foldedNames.has(name)) continue;
			result.push({
				name: entry.name,
				description: entry.description,
				promptSnippet: entry.promptSnippet,
				parameters: (this.searchableParameters.get(name) ?? []).map((parameter) => ({ ...parameter })),
				deferrable: entry.deferrable,
			});
		}
		return result;
	}

	/**
	 * R8 guidance for a folded-and-undiscovered tool; `undefined` preserves the
	 * current `Tool X not found` behavior for genuinely unknown names (M1 §3.5).
	 */
	getGuidance(name: string): string | undefined {
		if (!this.foldedNames.has(name)) return undefined;
		// Display name is single-quote wrapped with `'` escaped; the query
		// suggestion is a JSON-safe double-quoted string (`"` and `\` escaped).
		const display = name.replace(/'/g, "\\'");
		const query = name.replace(/["\\]/g, "\\$&");
		return `Tool '${display}' is available but not yet loaded. Call tool_search with query "${query}" to load it.`;
	}

	/** Synthetic `tool_search` ToolDefinition; the parameters schema is frozen in tool-search-definition.ts (M1 §3.4). */
	getToolSearchDefinition(): ToolDefinition {
		this.cachedDefinition ??= createToolSearchDefinition({
			getSearchableTools: () => this.getSearchableTools(),
			filterNewNames: (names) => this.filterNewNames(names),
		});
		return this.cachedDefinition;
	}

	/** D5 notification baseline; empty until first initialized/resumed. */
	lastAdvertisedCatalog(): readonly string[] {
		return [...this.advertisedCatalog];
	}

	/**
	 * One-shot baseline update (D5): used for resume initialization with the
	 * restored catalog, and immediately after a catalog delta is enqueued.
	 */
	markCatalogAdvertised(names: readonly string[]): void {
		this.advertisedCatalog = dedupeNames(names);
	}

	/**
	 * Single compaction details builder (D6): merges the discovered fact set
	 * with the extension `addedToolNames` the caller scanned from the current
	 * branch (same scan source as restore; the manager itself stays
	 * transcript-free). Always returns a stable structure, empty when no names.
	 */
	buildCompactionDetailsSnapshot(extensionAddedNames: readonly string[] = []): ToolSearchCompactionDetails {
		const merged = dedupeNames([...this.discoveredNames, ...extensionAddedNames]);
		return {
			toolSearch: { version: 1, discoveredToolNames: merged },
			deferred: { version: 1, addedToolNames: merged },
		};
	}

	/**
	 * Active formula (M1 §3.3): eager tools plus already-discovered foldable
	 * tools in registry order, with the synthetic tool appended last — and only
	 * — while undiscovered foldable tools exist. `activated` false ⇒ the whole
	 * catalog is active and nothing is folded (zero-overhead, M1 §3.1 step 3).
	 */
	private computeActiveToolNames(): string[] {
		const names: string[] = [];
		for (const name of this.catalog.keys()) {
			if (this.activated && this.foldedNames.has(name)) continue;
			names.push(name);
		}
		if (this.activated && !names.includes(TOOL_SEARCH_TOOL_NAME)) {
			names.push(TOOL_SEARCH_TOOL_NAME);
		}
		return names;
	}
}
