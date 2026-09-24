/**
 * Pure retrieval algorithm for the synthetic `tool_search` tool (design doc
 * `plan/tool-search/30-搜索实现.md`).
 *
 * No IO, no global caches, no registry mutation: `searchTools` matches a fixed
 * snapshot and returns a typed outcome. The synthetic tool's execute adapter
 * (`tool-search-definition.ts`) maps the outcome onto an `AgentToolResult` and
 * routes new names through `ToolSearchManager.filterNewNames` only (D3 —
 * execute never calls `discover`; registration and the active-set refresh
 * happen exclusively in the D1 `onToolBatchCompleted` callback).
 */

/** A single parameter of a searchable tool, flattened for matching (M3 §2). */
export interface SearchableToolParameter {
	name: string;
	description?: string;
}

/** Immutable per-search view of a foldable, not-yet-discovered tool (M3 §2). */
export interface SearchableTool {
	name: string;
	description: string;
	promptSnippet?: string;
	parameters: readonly SearchableToolParameter[];
	deferrable: boolean;
}

/** Parameters of a `tool_search` call (schema frozen in M1 §3.4). */
export interface ToolSearchRequest {
	pattern?: string;
	keywords?: string[];
	limit?: number;
}

/** Structured details of a `tool_search` execution (M3 §2); for logs/UI, not a second model protocol. */
export interface ToolSearchDetails {
	matchedToolNames: string[];
	addedToolNames: string[];
}

// --- Budgets and guard constants (D10: structure rejection + length caps are risk
// --- mitigation, not a guarantee that arbitrary regex can be interrupted) ---

/** Maximum accepted `pattern` length in UTF-16 code units (M3 §3 step 3). */
export const TOOL_SEARCH_PATTERN_MAX_LENGTH = 200;
/** Maximum accepted length of a single keyword in UTF-16 code units (M3 §7 "keyword 空/过长"). */
export const TOOL_SEARCH_KEYWORD_MAX_LENGTH = 200;
export const TOOL_SEARCH_LIMIT_MIN = 1;
export const TOOL_SEARCH_LIMIT_MAX = 100;
/** Default result cap, aligned with Anthropic (M3 §3 step 9). */
export const TOOL_SEARCH_LIMIT_DEFAULT = 5;
/** Hard wall-clock budget for one search; breach rejects the query, never reorders results (M3 §9). */
export const TOOL_SEARCH_HARD_BUDGET_MS = 20;
/** First-sentence excerpt cap per result line, in UTF-16 code units (M3 §3 step 10). */
export const TOOL_SEARCH_SNIPPET_MAX_LENGTH = 240;
/** Maximum quantifier bound accepted in a pattern; higher bounds are rejected (M3 §3 step 3). */
export const TOOL_SEARCH_REGEX_MAX_QUANTIFIER_BOUND = 100;

/**
 * Empty-snapshot guidance (D15: unified wording, M1 §3.5 authoritative).
 * Returned when every foldable tool is already discovered (or none exist).
 */
export const TOOL_SEARCH_ALL_LOADED_MESSAGE = "All folded tools are already loaded.";
/** Valid query with zero hits (M3 §3 step 12). */
export const TOOL_SEARCH_NO_MATCH_MESSAGE = "No matching tools found. Try different keywords or a broader pattern.";

/**
 * Typed outcome of a pure search. `invalid` carries a parameter-error reason;
 * the execute adapter turns it into the existing tool parameter-error semantics
 * (throw → error tool result, normal control flow).
 */
export type SearchToolsOutcome =
	| { status: "ok"; matchedToolNames: string[]; text: string }
	| { status: "all-loaded"; text: string }
	| { status: "no-match"; text: string }
	| { status: "invalid"; reason: string };

// --- Explainable scoring bands (M3 §3 step 8; no BM25) ---

const FIELD_SCORE_NAME_EXACT = 100;
const FIELD_SCORE_NAME_PREFIX = 70;
const FIELD_SCORE_NAME_SUBSTRING = 50;
const FIELD_SCORE_DESCRIPTION = 30;
const FIELD_SCORE_PARAM_NAME = 25;
const FIELD_SCORE_PARAM_DESCRIPTION = 15;
const REGEX_BONUS = 20;

const SENTENCE_TERMINATORS: Record<string, true> = {
	".": true,
	"?": true,
	"!": true,
	"。": true,
	"！": true,
	"？": true,
};

interface NormalizedFields {
	tool: SearchableTool;
	name: string;
	description: string;
	promptSnippet: string | undefined;
	paramNames: string[];
	paramDescriptions: string[];
}

function normalizeText(value: string): string {
	return value.toLocaleLowerCase("en-US");
}

function normalizeFields(tool: SearchableTool): NormalizedFields {
	return {
		tool,
		name: normalizeText(tool.name),
		description: normalizeText(tool.description),
		promptSnippet: tool.promptSnippet === undefined ? undefined : normalizeText(tool.promptSnippet),
		paramNames: tool.parameters.map((parameter) => normalizeText(parameter.name)),
		paramDescriptions: tool.parameters
			.map((parameter) => parameter.description)
			.filter((description): description is string => description !== undefined)
			.map(normalizeText),
	};
}

/**
 * Highest field score for one literal query token, or 0 when the token matches
 * no field ("每个匹配查询 token 只计最高字段分"). Field priority:
 * name exact > name prefix > name substring > description/promptSnippet >
 * parameter name > parameter description.
 */
function literalFieldScore(fields: NormalizedFields, token: string): number {
	if (fields.name === token) return FIELD_SCORE_NAME_EXACT;
	if (fields.name.startsWith(token)) return FIELD_SCORE_NAME_PREFIX;
	if (fields.name.includes(token)) return FIELD_SCORE_NAME_SUBSTRING;
	if (fields.description.includes(token)) return FIELD_SCORE_DESCRIPTION;
	if (fields.promptSnippet?.includes(token)) return FIELD_SCORE_DESCRIPTION;
	if (fields.paramNames.some((name) => name.includes(token))) return FIELD_SCORE_PARAM_NAME;
	if (fields.paramDescriptions.some((description) => description.includes(token)))
		return FIELD_SCORE_PARAM_DESCRIPTION;
	return 0;
}

function regexHitsFields(regex: RegExp, fields: NormalizedFields): boolean {
	return (
		regex.test(fields.tool.name) ||
		regex.test(fields.tool.description) ||
		(fields.tool.promptSnippet !== undefined && regex.test(fields.tool.promptSnippet)) ||
		fields.tool.parameters.some(
			(parameter) =>
				regex.test(parameter.name) || (parameter.description !== undefined && regex.test(parameter.description)),
		)
	);
}

/**
 * First non-empty prefix before the first sentence terminator (`.?!。！？`),
 * else the whole trimmed description; capped at 240 UTF-16 code units (M3 §3
 * step 10 and §12: CJK terminators supported, no truncation marker added).
 */
export function firstSentence(description: string): string {
	const trimmed = description.trim();
	for (let index = 0; index < trimmed.length; index++) {
		if (!SENTENCE_TERMINATORS[trimmed[index]]) continue;
		const prefix = trimmed.slice(0, index).trim();
		if (prefix.length > 0)
			return prefix.length <= TOOL_SEARCH_SNIPPET_MAX_LENGTH
				? prefix
				: prefix.slice(0, TOOL_SEARCH_SNIPPET_MAX_LENGTH);
	}
	return trimmed.length <= TOOL_SEARCH_SNIPPET_MAX_LENGTH ? trimmed : trimmed.slice(0, TOOL_SEARCH_SNIPPET_MAX_LENGTH);
}

/**
 * Reject patterns with potentially high-cost structures (M3 §3 step 3):
 * lookbehind, backreferences (numeric and named), and quantifier bounds above
 * 100. Escape-aware so literal-text lookalikes (e.g. `\(?<=`) pass.
 *
 * @returns a human-readable rejection reason, or undefined when allowed.
 */
export function findForbiddenRegexConstruct(pattern: string): string | undefined {
	let escaped = false;
	for (let index = 0; index < pattern.length; index++) {
		const char = pattern[index];
		if (escaped) {
			escaped = false;
			if (char >= "1" && char <= "9") return `backreference \\${char}`;
			if (char === "k" && pattern[index + 1] === "<") return "named backreference \\k<";
			continue;
		}
		if (char === "\\") {
			escaped = true;
			continue;
		}
		if (char === "(" && (pattern.startsWith("(?<=", index) || pattern.startsWith("(?<!", index))) {
			return "lookbehind";
		}
		if (char === "{") {
			const reason = checkQuantifierBound(pattern.slice(index));
			if (reason !== undefined) return reason;
		}
	}
	return undefined;
}

function checkQuantifierBound(rest: string): string | undefined {
	// Matches {n}, {n,}, {n,m} starting at rest[0]; anything else is not a quantifier.
	const match = /^\{(\d+)(,(\d*))?\}/.exec(rest);
	if (!match) return undefined;
	const lower = Number(match[1]);
	const openEnded = match[2] !== undefined && match[3] === undefined;
	const upper = match[3] !== undefined && match[3] !== "" ? Number(match[3]) : undefined;
	// {n}: exact bound. {n,m}: explicit upper bound. {n,}: open-ended; a lower
	// bound above the cap implies a degenerate unbounded repetition requirement.
	const effectiveUpper = openEnded ? lower : (upper ?? lower);
	if (effectiveUpper > TOOL_SEARCH_REGEX_MAX_QUANTIFIER_BOUND) {
		return `quantifier bound ${match[0]} exceeds ${TOOL_SEARCH_REGEX_MAX_QUANTIFIER_BOUND}`;
	}
	return undefined;
}

function invalidRequest(reason: string): SearchToolsOutcome {
	return { status: "invalid", reason: `Invalid tool_search input: ${reason}` };
}

function clampLimit(limit: number | undefined): number {
	if (limit === undefined || !Number.isFinite(limit)) return TOOL_SEARCH_LIMIT_DEFAULT;
	return Math.min(TOOL_SEARCH_LIMIT_MAX, Math.max(TOOL_SEARCH_LIMIT_MIN, Math.trunc(limit)));
}

/**
 * Run one search over a fixed, already allow/deny-filtered snapshot (M3 §3).
 * Sorts by explainable score before applying `limit`; never mutates the snapshot.
 */
export function searchTools(snapshot: readonly SearchableTool[], request: ToolSearchRequest): SearchToolsOutcome {
	if (snapshot.length === 0) {
		return { status: "all-loaded", text: TOOL_SEARCH_ALL_LOADED_MESSAGE };
	}

	// Defensive request shaping for non-schema callers; schema-validated calls
	// already guarantee these shapes (M3 §2: invalid types go to parameter validation).
	const pattern = typeof request.pattern === "string" ? request.pattern : undefined;
	const rawKeywords = Array.isArray(request.keywords) ? request.keywords : undefined;
	const hasPattern = pattern !== undefined && pattern.length > 0; // empty pattern ≡ not provided (M3 §3 step 3)

	if (rawKeywords !== undefined) {
		for (const keyword of rawKeywords) {
			if (typeof keyword !== "string" || keyword.trim().length === 0) {
				return invalidRequest("keywords must be non-empty strings");
			}
			if (keyword.length > TOOL_SEARCH_KEYWORD_MAX_LENGTH) {
				return invalidRequest(`keyword exceeds ${TOOL_SEARCH_KEYWORD_MAX_LENGTH} characters`);
			}
		}
	}
	const keywords = (rawKeywords ?? []).map((keyword) => normalizeText(keyword.trim()));

	if (!hasPattern && keywords.length === 0) {
		return invalidRequest("provide at least one of `pattern` or `keywords`");
	}
	if (pattern !== undefined && pattern.length > TOOL_SEARCH_PATTERN_MAX_LENGTH) {
		return invalidRequest(`pattern exceeds ${TOOL_SEARCH_PATTERN_MAX_LENGTH} characters`);
	}

	let regex: RegExp | undefined;
	if (hasPattern && pattern !== undefined) {
		const forbidden = findForbiddenRegexConstruct(pattern);
		if (forbidden !== undefined) {
			return invalidRequest(`pattern rejected: ${forbidden} is not allowed`);
		}
		try {
			regex = new RegExp(pattern, "iu");
		} catch (error) {
			return invalidRequest(`invalid regular expression: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	const fields = snapshot.map(normalizeFields);
	const startedAt = Date.now();
	const scored: { index: number; score: number }[] = [];

	for (let index = 0; index < fields.length; index++) {
		const field = fields[index];
		if (regex !== undefined && !regexHitsFields(regex, field)) continue;

		let score = 0;
		let allKeywordsMatched = true;
		for (const keyword of keywords) {
			const keywordScore = literalFieldScore(field, keyword);
			if (keywordScore === 0) {
				allKeywordsMatched = false;
				break;
			}
			score += keywordScore;
		}
		if (!allKeywordsMatched) continue;

		if (hasPattern && pattern !== undefined) {
			// The pattern also contributes its highest literal field score; the
			// regex channel itself adds a flat bonus exactly once (M3 §3 step 8).
			score += literalFieldScore(field, normalizeText(pattern)) + REGEX_BONUS;
		}
		scored.push({ index, score });

		if (Date.now() - startedAt > TOOL_SEARCH_HARD_BUDGET_MS) {
			return invalidRequest("search exceeded its execution budget; simplify the pattern or narrow the keywords");
		}
	}

	if (scored.length === 0) {
		return { status: "no-match", text: TOOL_SEARCH_NO_MATCH_MESSAGE };
	}

	// Score descending; ties break by original tool name in Unicode code-unit
	// order (deliberately not locale compare), then by snapshot order.
	scored.sort(
		(a, b) =>
			b.score - a.score ||
			(fields[a.index].tool.name === fields[b.index].tool.name
				? 0
				: fields[a.index].tool.name < fields[b.index].tool.name
					? -1
					: 1) ||
			a.index - b.index,
	);

	const matched = scored.slice(0, clampLimit(request.limit));
	const matchedToolNames = matched.map((match) => fields[match.index].tool.name);
	const text = matched.map((match) => {
		const tool = fields[match.index].tool;
		return `${tool.name} — ${firstSentence(tool.description)}`;
	});

	return { status: "ok", matchedToolNames, text: text.join("\n") };
}
