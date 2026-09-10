/**
 * autoretain — engine-side background memory generation (docs/memory-system.md §5).
 *
 * Task-registry design: each task = { name, everyNTurns, promptTemplate,
 * landing, modelRole }. Multiple tasks share one turn counter, each firing on
 * its own cadence, but each task tracks its OWN consumed window per session
 * (autoretain_progress table) — differently-cadenced tasks never eat each
 * other's rows and off-branch rows are never permanently skipped.
 *
 * The side LLM call runs through the host's side-request primitive with a
 * strict JSON output contract; failures are silently skipped (next turn
 * retries the same window — raw_log never loses the source text). Products
 * land via the store's put() with source:"auto", a fresh anchor AND the raw
 * window's first/last raw_id (§4 consumption path).
 */
import type { MemoryStore } from "./store.ts";

/** Where an autoretain product lands. */
export interface AutoretainLanding {
	/** Target domain (tree root), e.g. "history" or "meta". */
	domain: string;
	/**
	 * append: unique child uri under the domain root (default).
	 * underParent: parent under an explicit uri (created as stub if missing).
	 * replaceStale: overwrite the newest existing node under the landing
	 * pattern instead of growing a new one.
	 */
	strategy: "append" | "underParent" | "replaceStale";
	/** For underParent / replaceStale: the parent or target uri pattern. */
	parentUri?: string;
}

/** One registered autoretain task (docs §5 task-registry). */
export interface AutoretainTask {
	name: string;
	everyNTurns: number;
	/**
	 * Prompt template. Placeholders:
	 *   {window}  — the raw_log transcript of the pending window
	 *   {domain}  — the landing domain
	 */
	promptTemplate: string;
	landing: AutoretainLanding;
	/** "smol" maps to the current session model until a role registry exists. */
	modelRole?: "smol" | "default";
	/** Max product length guard (chars). */
	maxContentLength?: number;
	/** Prompt window budget (chars, tail-first). Default 12000. */
	maxInputChars?: number;
	/** Side-request max output tokens. Default 800. */
	maxOutputTokens?: number;
	/** Redact bearer tokens / secret-looking assignments before prompting. Default true. */
	redact?: boolean;
}

export const DEFAULT_AUTORETAIN_EVERY_N_TURNS = 4;
export const DEFAULT_AUTORETAIN_MAX_INPUT_CHARS = 12_000;
export const DEFAULT_AUTORETAIN_MAX_OUTPUT_TOKENS = 800;

/** Bearer-token patterns in raw text. */
const REDACT_BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gu;

/**
 * Strict JSON output contract (docs §5: 廉模型 + strict JSON 输出契约).
 * The side model MUST answer with exactly this object.
 */
export const AUTORETAIN_JSON_CONTRACT = `输出必须是且仅是一个 JSON 对象，不要 markdown 代码围栏，格式：
{"uri": "<本产物建议的记忆 URI（可省略，省略则自动分配）>", "content": "<记忆正文，纯文本>", "disclosure": "<想起条件，可省略>"}`;

/** core default tasks (docs §5: 场景纪要 + 自我反思). */
export const DEFAULT_AUTORETAIN_TASKS: AutoretainTask[] = [
	{
		name: "scene-summary",
		everyNTurns: DEFAULT_AUTORETAIN_EVERY_N_TURNS,
		promptTemplate: `回顾以下对话窗口，提炼一份简短的场景纪要（发生了什么、关键事实、未尽事项）。纪要写入 ${"{domain}"} 域。\n\n{window}\n\n${AUTORETAIN_JSON_CONTRACT}`,
		landing: { domain: "history", strategy: "append" },
		modelRole: "smol",
	},
	{
		name: "self-reflection",
		everyNTurns: DEFAULT_AUTORETAIN_EVERY_N_TURNS,
		promptTemplate: `回顾以下对话窗口，以第一人称写一段简短的自我反思：我的行为模式、性格变化、或值得注意的倾向。写入 ${"{domain}"} 域。\n\n{window}\n\n${AUTORETAIN_JSON_CONTRACT}`,
		landing: { domain: "meta", strategy: "append" },
		modelRole: "smol",
	},
];

/** Host capability the autoretain engine needs (mirrors completeSideRequest). */
export interface AutoretainHost {
	/** One-shot side LLM request outside the main loop. Returns the text. */
	completeSideRequest(
		prompt: string,
		options: { modelRole?: "smol" | "default"; maxTokens?: number; signal?: AbortSignal; label: string },
	): Promise<string>;
	/** Session info for provenance stamping. */
	getSessionInfo(): { modelId?: string; leafId?: string | null; sessionId?: string };
}

/** Result of one task firing. */
export interface AutoretainOutcome {
	task: string;
	ok: boolean;
	uri?: string;
	nodeId?: string;
	error?: string;
}

/** Parse the strict JSON contract; returns null on any deviation. */
export function parseAutoretainJson(text: string): { uri?: string; content?: string; disclosure?: string } | null {
	const trimmed = text.trim();
	const unfenced = trimmed
		.replace(/^```(?:json)?\s*/u, "")
		.replace(/\s*```$/u, "")
		.trim();
	const start = unfenced.indexOf("{");
	const end = unfenced.lastIndexOf("}");
	if (start === -1 || end <= start) return null;
	try {
		const parsed = JSON.parse(unfenced.slice(start, end + 1)) as unknown;
		if (typeof parsed !== "object" || parsed === null) return null;
		const obj = parsed as Record<string, unknown>;
		if (obj.content !== undefined && typeof obj.content !== "string") return null;
		if (obj.uri !== undefined && typeof obj.uri !== "string") return null;
		if (obj.disclosure !== undefined && typeof obj.disclosure !== "string") return null;
		return {
			uri: typeof obj.uri === "string" ? obj.uri : undefined,
			content: typeof obj.content === "string" ? obj.content : undefined,
			disclosure: typeof obj.disclosure === "string" ? obj.disclosure : undefined,
		};
	} catch {
		return null;
	}
}

/** Deterministic per-window product uri under the landing domain. */
function landingUri(store: MemoryStore, task: AutoretainTask, windowKey: string): string {
	const domain = task.landing.domain;
	if (task.landing.strategy === "replaceStale" && task.landing.parentUri) return task.landing.parentUri;
	if (task.landing.strategy === "underParent" && task.landing.parentUri) {
		return `${task.landing.parentUri.replace(/\/$/, "")}/${windowKey}`;
	}
	// append: unique child of the domain root, named by task + window stamp.
	let i = 0;
	for (;;) {
		const candidate =
			i === 0 ? `${domain}://${task.name}-${windowKey}` : `${domain}://${task.name}-${windowKey}-${i}`;
		if (!store.resolveUri(candidate)) return candidate;
		i++;
	}
}

/**
 * Cut a transcript to the tail `maxChars` on a character boundary, then
 * deterministically redact secrets. raw_log rows themselves are never
 * modified — only the copy that goes into the prompt.
 */
export function buildTaskPrompt(
	task: AutoretainTask,
	window: Array<{ role: string; text: string; raw_id: number }>,
): string {
	const transcript = window.map((m) => `[${m.raw_id}] ${m.role}: ${m.text}`).join("\n");
	let body = transcript;
	const maxChars = task.maxInputChars ?? DEFAULT_AUTORETAIN_MAX_INPUT_CHARS;
	if (body.length > maxChars) {
		body = body.slice(Math.max(0, body.length - maxChars));
		// Trim back to the START of the current line so we never cut mid-message.
		const nl = body.indexOf("\n");
		if (nl > 0) body = body.slice(nl + 1);
	}
	if (task.redact !== false) {
		body = redactSecrets(body);
	}
	return task.promptTemplate.replace(/\{window\}/gu, body).replace(/\{domain\}/gu, task.landing.domain);
}

/** Deterministic [REDACTED] replacement: bearer tokens + secret-looking assignments. */
export function redactSecrets(text: string): string {
	let out = text.replace(REDACT_BEARER_RE, "Bearer [REDACTED]");
	out = out.replace(
		/(["']?)(api_key|apikey|token|secret|password|authorization)(["']?)\s*[:=]\s*(["']?)[^\s"',;}\]]+/giu,
		(_m, q1, key, q2, q3) => `${q1}${key}${q2}${q3 ? ":" : "="}${q3}[REDACTED]`,
	);
	// De-duplicate any value that survived the assignment regex verbatim.
	out = out.replace(/\b(Bearer\s+)?\w{40,}\b/gu, (_m, bearer) => (bearer ? `${bearer}[REDACTED]` : "[REDACTED]"));
	return out;
}

/**
 * Fire one task against a raw_log window. Silently skips on any failure
 * (docs §5: 失败静默跳过——下轮重试同一窗口). Returns the outcome for tests
 * and audit.
 */
export async function runAutoretainTask(
	store: MemoryStore,
	task: AutoretainTask,
	window: Array<{ role: string; text: string; raw_id: number; entry_id?: string }>,
	host: AutoretainHost,
	signal?: AbortSignal,
): Promise<AutoretainOutcome> {
	if (window.length === 0) return { task: task.name, ok: false, error: "empty window" };
	const prompt = buildTaskPrompt(task, window);
	try {
		const raw = await host.completeSideRequest(prompt, {
			modelRole: task.modelRole ?? "smol",
			maxTokens: task.maxOutputTokens ?? DEFAULT_AUTORETAIN_MAX_OUTPUT_TOKENS,
			signal,
			label: `memory-autoretain:${task.name}`,
		});
		const parsed = parseAutoretainJson(raw);
		if (!parsed?.content) return { task: task.name, ok: false, error: "JSON contract violation" };
		// Window key: first..last raw_id — deterministic, idempotent per window.
		const windowKey = `${window[0].raw_id}-${window[window.length - 1].raw_id}`;
		const uri = parsed.uri ?? landingUri(store, task, windowKey);
		const content =
			task.maxContentLength && parsed.content.length > task.maxContentLength
				? parsed.content.slice(0, task.maxContentLength)
				: parsed.content;
		const info = host.getSessionInfo();
		// memorize 内部路径: put() handles stub ancestors + FTS; source auto,
		// anchor/model auto-stamped from the session (docs §6). first/last
		// raw_id are written so retrace(uri) can walk back to the source
		// transcript (§4 consumption path, §11).
		const node = store.put({
			uri,
			content,
			parent_uri: task.landing.strategy === "underParent" && task.landing.parentUri ? task.landing.parentUri : null,
			disclosure: parsed.disclosure ?? null,
			source: "auto",
			model: info.modelId ?? null,
			anchor_entry_id: info.leafId ?? null,
			anchor_session_id: info.sessionId ?? null,
			first_raw_id: window[0].raw_id,
			last_raw_id: window[window.length - 1].raw_id,
		});
		store.logAudit("autoretain_product", {
			node_id: node.node_id,
			object: node.uri,
			source: "auto",
			model: info.modelId ?? undefined,
			task: task.name,
			anchor: info.leafId ?? undefined,
			details: `${window[0].raw_id}-${window[window.length - 1].raw_id}`,
		});
		return { task: task.name, ok: true, uri: node.uri, nodeId: node.node_id };
	} catch (error) {
		return { task: task.name, ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

/** Which tasks are due on turn N (shared counter, per-task cadence). */
export function dueTasks(tasks: AutoretainTask[], turnCount: number): AutoretainTask[] {
	return tasks.filter((t) => t.everyNTurns > 0 && turnCount > 0 && turnCount % t.everyNTurns === 0);
}
