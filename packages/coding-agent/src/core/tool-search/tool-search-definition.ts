import { Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { type SearchableTool, searchTools, type ToolSearchDetails } from "./search.ts";

/** Model-visible name of the synthetic tool (R4, frozen). */
export const TOOL_SEARCH_TOOL_NAME = "tool_search";

/**
 * Frozen parameter schema of the synthetic `tool_search` tool (M1 §3.4 — the
 * single source of truth; search code and tests must reference this object and
 * never restate it). It contains no string|array unions; if one is ever
 * introduced, the array-first rule from `read.ts` applies.
 */
export const toolSearchParameters = Type.Object({
	pattern: Type.Optional(
		Type.String({ description: "Regular-expression pattern for tool name or description matching." }),
	),
	keywords: Type.Optional(
		Type.Array(Type.String(), { description: "Keywords matched against tool names and descriptions." }),
	),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});

/**
 * Read-only manager seam consumed by the synthetic tool's execute (M3 §2).
 * Deliberately narrower than `ToolSearchManager` so the adapter cannot reach
 * mutating state.
 */
export interface ToolSearchExecutor {
	getSearchableTools(): readonly SearchableTool[];
	filterNewNames(names: readonly string[]): readonly string[];
}

/**
 * Build the synthetic `tool_search` ToolDefinition (M1 §3.4 / M3).
 *
 * `execute` is a thin adapter: it runs the pure search over an immutable
 * snapshot and computes `addedToolNames` through `filterNewNames` only (D3).
 * Registration of discovered tools and the active-set refresh happen
 * exclusively in the D1 `onToolBatchCompleted` batch callback — never here.
 */
export function createToolSearchDefinition(executor: ToolSearchExecutor): ToolDefinition {
	return {
		name: TOOL_SEARCH_TOOL_NAME,
		label: "Tool Search",
		description:
			"Search for tools that are registered but not yet loaded. Matches unloaded tools by a regular-expression " +
			"pattern and/or keywords against tool names, descriptions, prompt snippets, and parameter documentation. " +
			"Provide `pattern` and/or `keywords` (all keywords must match) with an optional `limit` (1-100, default 5). " +
			"Returns matching tool names with a one-line description; matched tools become fully callable on the next turn.",
		parameters: toolSearchParameters,
		execute: async (_toolCallId, params) => {
			const request = (params ?? {}) as { pattern?: string; keywords?: string[]; limit?: number };
			const outcome = searchTools(executor.getSearchableTools(), request);
			switch (outcome.status) {
				case "invalid":
					// Existing tool parameter-error convention (cf. read.ts): throw so
					// the agent loop converts this into an error tool result — normal
					// control flow, the loop keeps running (M1 §7).
					throw new Error(outcome.reason);
				case "all-loaded":
				case "no-match":
					return {
						content: [{ type: "text", text: outcome.text }],
						details: { matchedToolNames: [], addedToolNames: [] } satisfies ToolSearchDetails,
					};
				case "ok": {
					// D3: read-only filtering of names listed in the body — never
					// discover/register here (R3 pairing: addedToolNames ⊆ body ∩ folded).
					const addedToolNames = [...executor.filterNewNames(outcome.matchedToolNames)];
					return {
						content: [{ type: "text", text: outcome.text }],
						details: { matchedToolNames: [...outcome.matchedToolNames], addedToolNames },
						addedToolNames,
					};
				}
			}
		},
	};
}
