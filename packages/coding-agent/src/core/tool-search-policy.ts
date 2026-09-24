import { estimateToolsTokens } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "./extensions/types.ts";
import type { SourceInfo } from "./source-info.ts";
import type { ToolSearchEntry } from "./tool-search/manager.ts";
import { allToolNames, type ToolName } from "./tools/index.ts";

/** Fallback auto-mode threshold when the configured thresholdPercent is not a finite non-negative number. */
export const DEFAULT_TOOL_SEARCH_THRESHOLD_PERCENT = 10;

/**
 * Collapse a tool's `deferrable` declaration to a boolean (R5/D8).
 *
 * Must run once per tool name at registry build time, after the final
 * built-in/extension/SDK override merge and before `wrapRegisteredTools`.
 * Native tools never fold, even when the author declares `deferrable: true`
 * (code-level backstop required by R5). Extension and SDK custom tools default
 * to foldable; an explicit `deferrable` declaration on the definition always wins.
 *
 * NOTE (2026-09-26, D23 follow-up): the R5 forced-eager list is the native-7
 * NAME set (+ tool_search itself + reservedTools + allow), NOT the synthetic
 * `builtin` source marker — engine-synthesized extensions like `<memory>` reuse
 * that marker for their 12 low-frequency tools and MUST stay foldable. The
 * name-set check below is the only native guard; `tool_search` itself is
 * backstopped by the manager's eager union.
 */
export function normalizeDeferrable(definition: ToolDefinition, _sourceInfo: SourceInfo): boolean {
	if (allToolNames.has(definition.name as ToolName)) {
		return false;
	}
	return definition.deferrable ?? true;
}

/**
 * M5 activation-judgment input. The estimation target is the POTENTIAL FOLDING
 * SET: tools whose normalized `deferrable` is true that would actually fold.
 * Forced-eager members never fold and save nothing, so they are excluded:
 * `reservedTools` are subtracted here by name, and the caller must exclude
 * allow-whitelist names from `tools` as well (allow names are not part of this
 * frozen input; native tools are already excluded by `deferrable: false`).
 */
export interface ToolSearchActivationInput {
	enabled: boolean;
	mode: "on" | "off" | "auto";
	thresholdPercent: number;
	/** Context window of the CURRENT model; invalid (missing/<= 0) keeps auto inactive. */
	contextWindow: number;
	/** Forced-eager names subtracted from the estimation set. */
	reservedTools: readonly string[];
	tools: readonly ToolSearchEntry[];
}

/** Receives diagnosable activation decisions (e.g. invalid context window). */
export type ToolSearchDiagnostic = (message: string) => void;

/**
 * Pure activation judgment (M5 §2). `mode: "on"` forces activation (still gated
 * by `enabled`); `"off"` or `enabled: false` never activates; `"auto"` (and any
 * unknown mode, per the safe-default rule) activates when the estimated token
 * footprint of the potential folding set reaches `thresholdPercent%` of the
 * model context window (`>=`, so an exact boundary activates). An invalid
 * context window conservatively keeps auto inactive and reports a diagnostic.
 */
export function shouldActivateToolSearch(
	input: ToolSearchActivationInput,
	onDiagnostic?: ToolSearchDiagnostic,
): boolean {
	if (!input.enabled) return false;
	if (input.mode === "off") return false;
	if (input.mode === "on") return true;

	if (!Number.isFinite(input.contextWindow) || input.contextWindow <= 0) {
		onDiagnostic?.(
			`tool search auto mode stays inactive: model contextWindow is invalid (${String(input.contextWindow)})`,
		);
		return false;
	}
	const thresholdPercent =
		Number.isFinite(input.thresholdPercent) && input.thresholdPercent >= 0
			? input.thresholdPercent
			: DEFAULT_TOOL_SEARCH_THRESHOLD_PERCENT;
	const reserved = new Set(input.reservedTools);
	// Map to the wire `Tool` shape (name/description/parameters): non-request fields such as
	// promptSnippet/deferrable are not part of the token burden.
	const estimatedTokens = estimateToolsTokens(
		input.tools
			.filter((tool) => tool.deferrable && !reserved.has(tool.name))
			.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
	);
	return estimatedTokens >= (thresholdPercent / 100) * input.contextWindow;
}
