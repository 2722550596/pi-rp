/**
 * Renderers for the memory tools (memorize / revise).
 *
 * Injected by name from agent-session's memory-module host: the memory package
 * stays headless (packages/memory must not depend on coding-agent, slots.ts:17),
 * so render — a pure TUI concern — lives here.
 *
 * Deliberately does NOT reuse write's highlighter: memory bodies are prose, and
 * the path→language lookup treats a memory URI as a file path (asking it about
 * "core://a/b.json" answers "json", measured), so highlighting would mislabel
 * Chinese prose as source code. Only `theme.fg` styling is used here.
 */
import { Text } from "@earendil-works/pi-tui";
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
	let text = `${theme.fg("toolTitle", theme.bold("铭刻记忆"))} ${theme.fg(
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
	if (typeof m.when === "string") return theme.fg("toolOutput", `想起条件 → 「${m.when}」`);
	if (typeof m.time === "string") return theme.fg("toolOutput", `世界时间 → ${m.time || "(清除)"}`);
	return theme.fg("muted", "（无内容改动）");
}

/** revise ≈ edit: a per-mod summary, NOT a diff (J5 — there is no before-body). */
export function renderReviseCall(args: unknown, theme: Theme, context: ToolRenderContext): Text {
	const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
	const a = (typeof args === "object" && args !== null ? args : {}) as ReviseArgs;
	const uri = str(a.uri);
	// Batch form, or the single-uri form promoted to a one-element batch.
	const raw: unknown[] = Array.isArray(a.batch) ? a.batch : uri ? [{ ...a, uri }] : [];
	const lines = raw.map((entry) => {
		const m = (typeof entry === "object" && entry !== null ? entry : {}) as ReviseMod;
		const shown = typeof m.uri === "string" && m.uri ? m.uri : "…";
		return `${theme.fg("accent", shown)}  ${describeMod(m, theme)}`;
	});
	let text = theme.fg("toolTitle", theme.bold("修订记忆"));
	if (lines.length > 0) {
		text += `\n${truncate(theme, lines, MAX_CALL_LINES, context.expanded)}`;
	}
	component.setText(text);
	return component;
}

/**
 * Shared result renderer: echo the tool's own confirmation text.
 *
 * MUST return a Component, never undefined: `undefined` is addChild'ed and then
 * thrown on by the next render() with no catch in the TUI pipeline (§10.4).
 */
export function renderMemoryResult(
	result: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> },
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ToolRenderContext,
): Text {
	const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
	const raw = getTextOutput(result, false).trim();
	if (!raw) {
		component.setText("");
		return component;
	}
	const body = truncate(theme, raw.split("\n"), MAX_RESULT_LINES, options.expanded);
	component.setText(`\n${context.isError ? theme.fg("error", body) : body}`);
	return component;
}

/** Injected by tool name in agent-session; unmapped memory tools fall back to the bare name. */
export const MEMORY_TOOL_RENDERERS: Readonly<Record<string, MemoryRenderer>> = {
	memorize: { renderCall: renderMemorizeCall, renderResult: renderMemoryResult },
	revise: { renderCall: renderReviseCall, renderResult: renderMemoryResult },
};
