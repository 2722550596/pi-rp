/**
 * autoretain — engine-side background memory generation (docs/memory-system.md §5).
 *
 * Task-registry design: each task = { name, everyNTurns, promptTemplate,
 * landing, modelRole }. Multiple tasks share one turn counter, each firing on
 * its own cadence. The side LLM call runs through the host's side-request
 * primitive with a strict JSON output contract; failures are silently skipped
 * (next turn retries the same window — raw_log never loses the source text).
 * Products land via the store's put() with source:"auto" and a fresh anchor.
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
}

export const DEFAULT_AUTORETAIN_EVERY_N_TURNS = 4;

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
	/** Side LLM request: one-shot, outside the main loop. Returns the text. */
	completeSideRequest(prompt: string): Promise<string>;
	/** Session info for provenance stamping. */
	getSessionInfo(): { modelId?: string; leafId?: string | null };
	/** World time (the store holds it, but the host is the single read point). */
	getWorldTime?(): string | null;
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
 * Fire one task against a raw_log window. Silently skips on any failure
 * (docs §5: 失败静默跳过——下轮重试同一窗口). Returns the outcome for tests
 * and audit.
 */
export async function runAutoretainTask(
	store: MemoryStore,
	task: AutoretainTask,
	window: Array<{ role: string; text: string; raw_id: number }>,
	host: AutoretainHost,
): Promise<AutoretainOutcome> {
	if (window.length === 0) return { task: task.name, ok: false, error: "empty window" };
	const transcript = window.map((m) => `[${m.raw_id}] ${m.role}: ${m.text}`).join("\n");
	const prompt = task.promptTemplate.replace(/\{window\}/gu, transcript).replace(/\{domain\}/gu, task.landing.domain);
	try {
		const raw = await host.completeSideRequest(prompt);
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
		// anchor/model auto-stamped from the session (docs §6).
		const node = store.put({
			uri,
			content,
			parent_uri: task.landing.strategy === "underParent" && task.landing.parentUri ? task.landing.parentUri : null,
			disclosure: parsed.disclosure ?? null,
			source: "auto",
			model: info.modelId ?? null,
			anchor_entry_id: info.leafId ?? null,
		});
		store.logAudit("autoretain_product", {
			object: node.uri,
			source: "auto",
			model: info.modelId ?? undefined,
			details: task.name,
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
