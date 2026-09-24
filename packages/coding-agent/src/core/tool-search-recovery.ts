/**
 * Tool-search session wiring helpers (M4 orchestration side).
 *
 * `ToolSearchManager` (./tool-search/) is a pure in-memory state machine that
 * never reads the transcript. This module owns the transcript-facing side of
 * the feature: branch scanning for discovered tools (R6), catalog delta
 * computation against the advertised baseline (R10/D5), compaction `details`
 * checkpoint merging (D6), and the R9 category section text.
 *
 * Everything exported here is pure and unit-testable without a session.
 */
import type { ToolDefinition } from "./extensions/types.ts";
import type { SessionEntry } from "./session-manager.ts";
import type { ToolSearchEntry } from "./tool-search/manager.ts";
import type { SearchableTool } from "./tool-search/search.ts";
import { TOOL_SEARCH_TOOL_NAME } from "./tool-search/tool-search-definition.ts";

export { TOOL_SEARCH_TOOL_NAME };

/**
 * Compaction `details` checkpoint shape (M4 §2, versioned). Both arrays hold
 * the merged dedupe of (manager discovered ∪ branch addedToolNames); readers
 * prefer `deferred.addedToolNames`. Missing/legacy details read as an empty
 * checkpoint.
 */
export interface ToolSearchCompactionDetails {
	toolSearch: { version: 1; discoveredToolNames: string[] };
	deferred: { version: 1; addedToolNames: string[] };
}

/**
 * Structural contract of the manager surface consumed by AgentSession.
 * `ToolSearchManager` satisfies this; tests inject fakes against it.
 */
export interface ToolSearchManagerContract {
	recompute(input: { tools: readonly ToolSearchEntry[]; active: boolean; reservedTools?: readonly string[] }): {
		activeToolNames: readonly string[];
		activated: boolean;
		changed: boolean;
	};
	discover(names: readonly string[]): {
		newNames: readonly string[];
		alreadyDiscovered: readonly string[];
		changed: boolean;
	};
	/** Unique recovery entry point; accepts a transcript superset (C1). */
	restore(names: readonly string[]): void;
	/** D22: clears derived in-memory state (discovered, advertised baseline, active names) before a full recovery replay. */
	reset(): void;
	getSearchableTools(): readonly SearchableTool[];
	getActiveToolNames(): readonly string[];
	isFoldedAndUndiscovered(name: string): boolean;
	getGuidance(name: string): string | undefined;
	filterNewNames(names: readonly string[]): readonly string[];
	hasDiscovered(name: string): boolean;
	discoveredSnapshot(): readonly string[];
	getToolSearchDefinition(): ToolDefinition;
	/** D5 notification baseline (manager-owned memory state). */
	lastAdvertisedCatalog(): readonly string[];
	markCatalogAdvertised(names: readonly string[]): void;
	buildCompactionDetailsSnapshot(extensionAddedNames?: readonly string[]): ToolSearchCompactionDetails;
}

/** One R9 category-section row: tool name + description first sentence. */
export interface ToolSearchCategory {
	name: string;
	description: string;
}

/** Result of scanning a session branch for discovered-tool facts. */
export interface ToolSearchBranchScan {
	/**
	 * Discovered names in first-seen order: every `toolResult.addedToolNames`
	 * plus names parsed from paired `tool_search` results (R6/D16: both
	 * sources, missing either loses state).
	 */
	discoveredNames: string[];
	/**
	 * `deferred.addedToolNames` from the most recent compaction entry on the
	 * branch (unioned into the restore set; older/missing checkpoints are
	 * treated as empty, per M4 §3.1).
	 */
	latestCheckpointNames: string[];
}

/** Catalog delta between the current searchable set and the advertised baseline (R10). */
export interface ToolCatalogDelta {
	added: string[];
	removed: string[];
}

/** Collect string names, deduped in first-seen order; non-strings and empty names are ignored. */
function addValidNames(target: string[], seen: Set<string>, candidates: unknown): void {
	if (!Array.isArray(candidates)) return;
	for (const candidate of candidates) {
		if (typeof candidate !== "string" || candidate.length === 0 || seen.has(candidate)) continue;
		seen.add(candidate);
		target.push(candidate);
	}
}

/**
 * Extract tool names from a `tool_search` tool result. Prefers structured
 * `details` fields, then falls back to a JSON parse of the text content.
 * Anything malformed is skipped — a bad result must never fail a resume
 * (M4 §3.1 step 4 / §7).
 */
function parseToolSearchResultNames(result: {
	details?: unknown;
	content: { type: string; text?: string }[];
}): string[] {
	const collected: string[] = [];
	const seen = new Set<string>();
	// Persisted/JSON payload shapes are legacy-tolerant by contract (M4 §7):
	// assert the accepted container shape at this boundary, then validate the
	// fields we actually consume.
	const collectFrom = (value: unknown): void => {
		const payload = value as
			| { addedToolNames?: unknown; names?: unknown; tools?: Array<string | { name?: unknown }> }
			| null
			| undefined;
		if (!payload || typeof payload !== "object") return;
		for (const candidates of [payload.addedToolNames, payload.names, payload.tools]) {
			if (!Array.isArray(candidates)) continue;
			for (const candidate of candidates) {
				if (typeof candidate === "string") {
					if (candidate.length > 0 && !seen.has(candidate)) {
						seen.add(candidate);
						collected.push(candidate);
					}
				} else if (typeof candidate === "object" && candidate !== null && typeof candidate.name === "string") {
					// TanStack-style [{ name }] entries.
					if (candidate.name.length > 0 && !seen.has(candidate.name)) {
						seen.add(candidate.name);
						collected.push(candidate.name);
					}
				}
			}
		}
	};
	collectFrom(result.details);
	const text = result.content
		.map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : ""))
		.join("\n");
	const trimmed = text.trimStart();
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		try {
			collectFrom(JSON.parse(text) as unknown);
		} catch {
			// Prose content (R3 return format) — nothing structured to parse.
		}
	}
	return collected;
}

/** Read `deferred.addedToolNames` from a compaction details checkpoint; invalid/legacy shapes read as empty. */
function readCheckpointNames(details: unknown): string[] {
	const checkpoint = details as { deferred?: { addedToolNames?: unknown } } | null | undefined;
	const added = checkpoint?.deferred?.addedToolNames;
	if (!Array.isArray(added)) return [];
	return added.filter((name): name is string => typeof name === "string" && name.length > 0);
}

/**
 * Scan a full branch (SessionManager.getBranch(), not the compaction-pruned
 * context projection) for tool-search discovery facts (R6).
 */
export function scanBranchForToolSearchDiscovery(branch: readonly SessionEntry[]): ToolSearchBranchScan {
	const discoveredNames: string[] = [];
	const seen = new Set<string>();
	// tool_search toolCallIds awaiting their paired result (M4 §3.1 step 2).
	const pendingSearchCalls = new Set<string>();

	for (const entry of branch) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "assistant") {
			for (const part of message.content) {
				if (part.type === "toolCall" && part.name === TOOL_SEARCH_TOOL_NAME) {
					pendingSearchCalls.add(part.id);
				}
			}
		} else if (message.role === "toolResult") {
			// (b) unconditional: every addedToolNames feeds the shared deferred channel (I2).
			addValidNames(discoveredNames, seen, message.addedToolNames);
			// (a) paired tool_search result payload.
			if (pendingSearchCalls.delete(message.toolCallId) && !message.isError) {
				addValidNames(discoveredNames, seen, parseToolSearchResultNames(message));
			}
		}
	}

	let latestCheckpointNames: string[] = [];
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "compaction") {
			latestCheckpointNames = readCheckpointNames(entry.details);
			break;
		}
	}

	return { discoveredNames, latestCheckpointNames };
}

/** Restore set = branch scan ∪ latest compaction checkpoint, deduped in first-seen order. */
export function collectRestoredToolNames(scan: ToolSearchBranchScan): string[] {
	const seen = new Set<string>();
	const merged: string[] = [];
	addValidNames(merged, seen, scan.discoveredNames);
	addValidNames(merged, seen, scan.latestCheckpointNames);
	return merged;
}

/**
 * Delta between the current searchable catalog and the advertised baseline
 * (R10/D4/D5). Names that merely became discovered transitioned
 * searchable→loaded (the tool_search result already told the model) and are
 * therefore not announced as removed.
 */
export function computeToolCatalogDelta(
	current: readonly string[],
	advertised: readonly string[],
	isDiscovered: (name: string) => boolean,
): ToolCatalogDelta {
	const currentSet = new Set(current);
	const advertisedSet = new Set(advertised);
	const added: string[] = [];
	const addedSeen = new Set<string>();
	for (const name of current) {
		if (advertisedSet.has(name) || addedSeen.has(name)) continue;
		addedSeen.add(name);
		added.push(name);
	}
	const removed: string[] = [];
	const removedSeen = new Set<string>();
	for (const name of advertised) {
		if (currentSet.has(name) || isDiscovered(name) || removedSeen.has(name)) continue;
		removedSeen.add(name);
		removed.push(name);
	}
	return { added, removed };
}

/** Steering notification text (M4 §3.4 step 4); empty string when there is no delta. */
export function formatToolCatalogDeltaMessage(delta: ToolCatalogDelta): string {
	const lines: string[] = [];
	if (delta.added.length > 0) lines.push(`Tools added: ${delta.added.join(", ")}`);
	if (delta.removed.length > 0) lines.push(`Tools removed: ${delta.removed.join(", ")}`);
	return lines.join("\n");
}

/**
 * Merge the tool-search checkpoint into an existing compaction `details`
 * object (D6: single builder output, both call sites share this merge).
 * Non-object legacy details are preserved as-is when possible; checkpoint
 * keys win on collision.
 */
export function mergeToolSearchCompactionDetails(
	existing: unknown,
	snapshot: ToolSearchCompactionDetails,
): Record<string, unknown> {
	const existingRecord = existing as Record<string, unknown> | null | undefined;
	const merged =
		existingRecord && typeof existingRecord === "object" && !Array.isArray(existingRecord)
			? { ...existingRecord }
			: {};
	merged.toolSearch = snapshot.toolSearch;
	merged.deferred = snapshot.deferred;
	return merged;
}

/** First sentence of a description (newlines flattened); whole text when no terminator. */
export function firstSentence(text: string): string {
	const flattened = text.replace(/[\r\n]+/g, " ").trim();
	const match = flattened.match(/^(.*?[.!?])(?:\s|$)/);
	return (match ? match[1] : flattened).trim();
}

/** R9 category rows from the current searchable catalog. */
export function buildToolSearchCategories(
	entries: readonly {
		name: string;
		description: string;
	}[],
): ToolSearchCategory[] {
	return entries.map((entry) => ({ name: entry.name, description: firstSentence(entry.description) }));
}

/** Category section text; empty string when there is nothing to advertise (zero overhead). */
export function formatToolSearchCategorySection(categories: readonly ToolSearchCategory[]): string {
	if (categories.length === 0) return "";
	const lines = categories.map((category) => `- ${category.name} — ${category.description}`);
	return [
		"The following tools are registered but not yet loaded. Call tool_search to load the ones you need:",
		...lines,
	].join("\n");
}

/**
 * Build the manager catalog input from the allow/deny-filtered registry
 * definitions plus the D8-normalized deferrable flags. Tools missing from the
 * map default to `deferrable: false` (eager).
 */
export function toToolSearchEntries(
	definitions: Iterable<{ definition: ToolDefinition }>,
	deferrableByName: ReadonlyMap<string, boolean>,
): ToolSearchEntry[] {
	const entries: ToolSearchEntry[] = [];
	for (const { definition } of definitions) {
		entries.push({
			name: definition.name,
			description: definition.description,
			promptSnippet: definition.promptSnippet,
			parameters: definition.parameters,
			deferrable: deferrableByName.get(definition.name) ?? false,
		});
	}
	return entries;
}
