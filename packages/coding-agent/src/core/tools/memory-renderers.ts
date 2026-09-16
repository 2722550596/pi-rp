/**
 * Renderers for the memory tools (memorize / revise).
 *
 * `createMemoryToolRenderers(store)` is called by agent-session's memory-module
 * host, which passes the session's MemoryStore singleton: the memory package
 * stays headless (packages/memory must not depend on coding-agent, slots.ts:17),
 * so render — a pure TUI concern — lives here, while the store comes in by
 * injection (never re-derived from context.cwd: that would open a second, empty
 * library — extensions/memories/index.ts:9-11).
 *
 * Deliberately does NOT reuse write's highlighter: memory bodies are prose, and
 * the path→language lookup treats a memory URI as a file path (asking it about
 * "core://a/b.json" answers "json", measured), so highlighting would mislabel
 * Chinese prose as source code. Only `theme.fg` styling is used here.
 */
import { computeRevisedContent, generateDiffString, type MemoryStore } from "@earendil-works/pi-memory";
import { Text } from "@earendil-works/pi-tui";
import { renderDiff } from "../../modes/interactive/components/diff.ts";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolDefinition, ToolRenderContext, ToolRenderResultOptions } from "../extensions/types.ts";
import { getTextOutput, str } from "./render-utils.ts";

/** Collapsed body cap for the call side, mirroring write.ts:158. */
const MAX_CALL_LINES = 10;
/** Collapsed result cap, mirroring grep.ts:106. */
const MAX_RESULT_LINES = 15;

/**
 * The two render slots of ToolDefinition, borrowed so the memory package never
 * has to describe TUI types.
 */
export type MemoryRenderer = Pick<ToolDefinition, "renderCall" | "renderResult">;

/** memorize args, read field-by-field through `str` (streaming args are partial). */
interface MemorizeArgs {
	uri?: unknown;
	content?: unknown;
}

/** revise args; `batch` entries carry the same edit fields as the single form. */
interface ReviseArgs {
	uri?: unknown;
	batch?: unknown;
}

interface ReviseMod {
	uri?: unknown;
	old_text?: unknown;
	new_text?: unknown;
	append?: unknown;
	line?: unknown;
	line_content?: unknown;
	importance?: unknown;
	when?: unknown;
	time?: unknown;
}

/** The body-editing subset of a revise mod: exactly what computeRevisedContent takes. */
interface BodyEdit {
	old_text?: string;
	new_text?: string;
	append?: string;
	line?: number;
	line_content?: string;
}

/** A rendered diff segment as it comes back from `details.diffs`. */
interface DiffSegment {
	uri: string;
	diff: string;
	firstChangedLine?: number;
}

/** Preview cache held in `context.state` for the life of one tool call. */
interface RevisePreviewState {
	previewKey?: string;
	/** Flattened preview lines: a segment header followed by its diff lines. */
	preview?: string[];
}

/** Narrow a raw streaming arg to a revise mod; `null` when it is not an object. */
function asMod(value: unknown): ReviseMod | null {
	// All ReviseMod fields are optional and read through `typeof`, so the raw
	// record satisfies it without any field being trusted.
	return typeof value === "object" && value !== null ? value : null;
}

/** Pull the body-editing fields out of a raw mod, dropping every other field. */
function bodyEditOf(m: ReviseMod): BodyEdit {
	const out: BodyEdit = {};
	if (typeof m.old_text === "string") out.old_text = m.old_text;
	if (typeof m.new_text === "string") out.new_text = m.new_text;
	if (typeof m.append === "string") out.append = m.append;
	if (typeof m.line === "number") out.line = m.line;
	if (typeof m.line_content === "string") out.line_content = m.line_content;
	return out;
}

/**
 * Append the "N more lines" hint and cut to `max` unless expanded.
 * Caller guarantees no line contains ANSI that this would break.
 */
function truncate(theme: Theme, lines: string[], max: number, expanded: boolean): string {
	const shown = expanded ? lines : lines.slice(0, max);
	let text = shown.map((l) => theme.fg("toolOutput", l)).join("\n");
	const remaining = lines.length - shown.length;
	if (remaining > 0) {
		text += `${theme.fg("muted", `\n... (${remaining} more lines, ${lines.length} total,`)} ${keyHint(
			"app.tools.expand",
			"to expand",
		)}${theme.fg("muted", ")")}`;
	}
	return text;
}

/**
 * memorize ≈ write: header + streaming body.
 *
 * Never throws: any malformed arg degrades to a placeholder. An exception here
 * would fall back to the bare-name renderer and poison `lastComponent` (§10.5).
 */
export function renderMemorizeCall(args: unknown, theme: Theme, context: ToolRenderContext): Text {
	const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
	// renderCall args arrive as `unknown` (Static<TSchema>); tolerate the
	// pre-stream window where the message_update carries {} or undefined (F1).
	const a = (typeof args === "object" && args !== null ? args : {}) as MemorizeArgs;
	const uri = str(a.uri);
	const body = str(a.content);
	// Fall back to "…" rather than a bare trailing space before uri arrives (F5).
	let text = `${theme.fg("toolTitle", theme.bold("memorize"))} ${theme.fg(
		"accent",
		uri === null || uri === "" ? "…" : uri,
	)}`;
	if (body) {
		text += `\n\n${truncate(theme, body.replace(/\r/g, "").split("\n"), MAX_CALL_LINES, context.expanded)}`;
	} else if (!context.argsComplete) {
		text += theme.fg("muted", "\n(写入中…)");
	}
	component.setText(text);
	return component;
}

/** Per-mod summary line for the revise call view. Never throws. */
function describeMod(m: ReviseMod, theme: Theme): string {
	if (typeof m.old_text === "string") {
		// "->" not U+21C4: that codepoint is East Asian Ambiguous width (§7.4).
		return theme.fg("toolOutput", `替换「${m.old_text}」->「${typeof m.new_text === "string" ? m.new_text : ""}」`);
	}
	if (typeof m.append === "string") return theme.fg("toolOutput", `＋追加「${m.append}」`);
	if (typeof m.line === "number") {
		return theme.fg("toolOutput", `行 ${m.line} ← 「${typeof m.line_content === "string" ? m.line_content : ""}」`);
	}
	if (typeof m.importance === "number") return theme.fg("toolOutput", `★重要度 → ${m.importance}`);
	// `""` reaches the preview un-normalised (applyReviseMod normalises it to NULL
	// at execute time), so it means "clear", never "set to an empty condition".
	if (typeof m.when === "string") {
		return theme.fg("toolOutput", m.when === "" ? "想起条件 → (清除)" : `想起条件 → 「${m.when}」`);
	}
	if (typeof m.time === "string") return theme.fg("toolOutput", `世界时间 → ${m.time || "(清除)"}`);
	return theme.fg("muted", "（无内容改动）");
}

/**
 * Pre-edit body preview for one revise mod (Path B).
 *
 * Uses the same edit rules as execute (`computeRevisedContent` is the pure core
 * applyReviseMod delegates to), so the preview cannot promise an edit execute
 * would reject — that would be a fake diff. Returns undefined when the mod
 * touches no body, the uri is unknown, or the edit is a no-op.
 */
function computeModPreview(store: MemoryStore, m: ReviseMod): string | undefined {
	const uri = str(m.uri);
	if (!uri) return undefined;
	const node = store.resolveUri(uri);
	if (!node) return undefined;
	const outcome = computeRevisedContent(node.content, bodyEditOf(m));
	if (!outcome.ok || outcome.content === node.content) return undefined;
	const { diff } = generateDiffString(node.content, outcome.content);
	return diff === "" ? undefined : diff;
}

/**
 * revise ≈ edit: a per-mod summary, plus the read-only pre-edit preview diff.
 *
 * `store` is injected by `createMemoryToolRenderers` and must be the session's
 * instance; without it the render degrades to the summary. The preview reads
 * once per distinct arg fingerprint (path B re-runs on every updateDisplay,
 * tool-execution.ts:264-286) and only pure point reads — never search/recall
 * (contract §6.3 hard constraint 5).
 */
export function renderReviseCall(args: unknown, theme: Theme, context: ToolRenderContext, store?: MemoryStore): Text {
	const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
	const a = (typeof args === "object" && args !== null ? args : {}) as ReviseArgs;
	const uri = str(a.uri);
	// Batch form, or the single-uri form promoted to a one-element batch.
	const raw: unknown[] = Array.isArray(a.batch) ? a.batch : uri ? [{ ...a, uri }] : [];
	const mods = raw.map((entry) => asMod(entry) ?? {});
	const lines = mods.map((m) => {
		const shown = typeof m.uri === "string" && m.uri ? m.uri : "…";
		return `${theme.fg("accent", shown)}  ${describeMod(m, theme)}`;
	});
	let text = theme.fg("toolTitle", theme.bold("revise"));
	if (lines.length > 0) {
		text += `\n${truncate(theme, lines, MAX_CALL_LINES, context.expanded)}`;
	}
	// Path B: only after the args are final (message_end), which is always before
	// tool_execution_start — so the read still sees the pre-edit body.
	if (store && context.argsComplete && mods.length > 0) {
		try {
			const state = context.state as RevisePreviewState;
			// Fingerprint over the fields that shape the diff: a batch with the
			// same body edit on a different uri must NOT reuse the previous
			// preview. importance/when/time stay out — they never change the body,
			// so including them would re-read the DB for nothing.
			const key = JSON.stringify(mods.map((m) => ({ u: m.uri, ...bodyEditOf(m) })));
			if (state.previewKey !== key) {
				state.previewKey = key;
				const preview: string[] = [];
				for (const m of mods) {
					const diff = computeModPreview(store, m);
					if (diff === undefined) continue;
					preview.push(theme.fg("accent", str(m.uri) ?? "…"), ...renderDiff(diff).split("\n"));
				}
				state.preview = preview;
			}
			const preview = state.preview ?? [];
			if (preview.length > 0) {
				text += `\n${truncate(theme, preview, MAX_CALL_LINES, context.expanded)}`;
			}
		} catch {
			// A locked or deleted DB must degrade to the summary, not kill the row
			// (tool-execution.ts:290 swallows a throw and the tool name disappears).
		}
	}
	component.setText(text);
	return component;
}

/** The tool's own confirmation text, error-coloured on failure; "" when empty. */
function formatResultBody(
	result: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> },
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ToolRenderContext,
): string {
	const raw = getTextOutput(result, false).trim();
	if (!raw) return "";
	const body = truncate(theme, raw.split("\n"), MAX_RESULT_LINES, options.expanded);
	return context.isError ? theme.fg("error", body) : body;
}

/**
 * memorize ≈ write: the call slot already shows uri + body, so a successful
 * result renders nothing — an EMPTY Text, never `undefined`: `undefined` is
 * addChild'ed and thrown on by the next render() with no catch (§10.4).
 */
function renderMemorizeResult(
	result: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> },
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ToolRenderContext,
): Text {
	const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
	if (!context.isError) {
		component.setText("");
		return component;
	}
	const body = formatResultBody(result, options, theme, context);
	component.setText(body ? `\n${body}` : "");
	return component;
}

/**
 * Tolerant shape guard for `details.diffs`. `details` round-trips through the
 * session JSONL and an afterToolCall hook can replace it wholesale
 * (agent-session.ts:809-814), so unknown extra keys — including the optional
 * `truncated` / `diffsTruncated` flags — are tolerated and only `diffs` is
 * validated. Sessions written before this change carry no `diffs` → undefined.
 */
function readDiffDetails(details: unknown): DiffSegment[] | undefined {
	if (typeof details !== "object" || details === null || !("diffs" in details)) return undefined;
	if (!Array.isArray(details.diffs)) return undefined;
	const segments: DiffSegment[] = [];
	for (const item of details.diffs) {
		if (typeof item !== "object" || item === null || !("uri" in item) || !("diff" in item)) return undefined;
		if (typeof item.uri !== "string" || typeof item.diff !== "string") return undefined;
		segments.push({
			uri: item.uri,
			diff: item.diff,
			firstChangedLine:
				"firstChangedLine" in item && typeof item.firstChangedLine === "number" ? item.firstChangedLine : undefined,
		});
	}
	return segments;
}

/**
 * revise ≈ edit: the confirmation line plus the authoritative per-mod diffs
 * from `details` (Path A).
 *
 * No de-duplication against the call slot's preview. The two slots are separate
 * containers rendering to different places (tool-execution.ts:286 vs :307), so
 * they cannot duplicate each other; copying edit.ts:232-234 — where call and
 * result DO share one component (edit.ts:397) — would blank the result slot on
 * the common path where preview and authoritative diff are equal.
 */
function renderReviseResult(
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: unknown;
	},
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ToolRenderContext,
): Text {
	const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
	const body = formatResultBody(result, options, theme, context);
	let text = body ? `\n${body}` : "";
	if (!context.isError) {
		const segments = readDiffDetails(result.details);
		if (segments) {
			const drawn = segments
				.filter((s) => s.diff !== "")
				.map((s) => `${theme.fg("accent", s.uri)}\n${renderDiff(s.diff)}`);
			if (drawn.length > 0) text += `\n${truncate(theme, drawn, MAX_RESULT_LINES, options.expanded)}`;
		}
	}
	component.setText(text);
	return component;
}

/**
 * Bind the memory tool renderers to the session's store instance.
 *
 * Built once per runtime build in `_createMemoryModuleHost` — the renderers are
 * bound to the store, not to a tool, so registering per tool would rebuild them
 * 12 times.
 */
export function createMemoryToolRenderers(store: MemoryStore): Readonly<Record<string, MemoryRenderer>> {
	return {
		memorize: { renderCall: renderMemorizeCall, renderResult: renderMemorizeResult },
		revise: {
			renderCall: (args, theme, context) => renderReviseCall(args, theme, context, store),
			renderResult: renderReviseResult,
		},
	};
}
