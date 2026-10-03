import { estimateToolsTokens } from "@earendil-works/pi-ai";
import type { ToolSearchEntry } from "./tool-search/manager.ts";
import { allToolNames, type ToolName } from "./tools/index.ts";

/** Fallback auto-mode threshold when the configured thresholdPercent is invalid. */
export const DEFAULT_TOOL_SEARCH_THRESHOLD_PERCENT = 10;
/**
 * Auto-mode estimates only direct-exposure tools that remain eligible for
 * folding after reserved and allow-list exclusions.
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
	// Map to wire `Tool` shape (name/description/parameters); namespace metadata
	// is search-only and does not affect the token estimate.
	const estimatedTokens = estimateToolsTokens(
		input.tools
			.filter(
				(tool) =>
					tool.exposure === "direct" && !allToolNames.has(tool.name as ToolName) && !reserved.has(tool.name),
			)
			.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
	);
	return estimatedTokens >= (thresholdPercent / 100) * input.contextWindow;
}
