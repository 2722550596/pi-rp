/**
 * TEMP auto-tidy runner (docs/design/temp-autotidy/01-memory侧-TidyRunner与触发.md).
 *
 * A headless整理 agent driven by pi-agent-core agentLoop: the full 12-tool set
 * bound to an isolated tidyCtx (modelId "temp-tidy", no session anchors), fired
 * fire-and-forget from the module's TEMP threshold check (D10 — NOT runSubagent:
 * that would mount the memory module in a child session and pollute raw_log).
 * Everything folds into a TidyOutcome — runTidy NEVER rejects; the caller adds a
 * defensive .catch that audits temp_tidy_crash as the last line of defense.
 *
 * Cross-process mutual exclusion rides memory_kv ("temp-tidy-lock", 契约 §2.7
 * frozen shape) with heartbeat/stale-reclaim; "temp-tidy-last-finish" backs the
 * retry cooldown (01 §2.7 备案).
 */
import { type AgentMessage, type AgentTool, agentLoop, type StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message, Model } from "@earendil-works/pi-ai";
import type { AutoTidySettings } from "./config.ts";
import type { MemoryStore } from "./store.ts";
import {
	type ActiveTempRow,
	DEFAULT_TEMP_THRESHOLD,
	listActiveTempRows,
	RP_NOTIFY_TYPE,
	TEMP_TIDY_GUIDE_LINES,
} from "./temp-notify.ts";
import { renderTidyTaskPrompt } from "./tidy-prompts.ts";
import { createMemoryTools, type MemoryToolContext, type MemoryToolDef } from "./tools.ts";

// ── Constants (01 §2.4 — 缺省值与依据) ───────────────────────────────────────

/** 10 条草稿全流程 ≈ 读+写 ~25 回合 + 索引/底册/收尾；同时是绝对成本天花板. */
export const DEFAULT_TIDY_MAX_TURNS = 30;
/** 30 轮 × side 通道 15~20s ≈ 7.5~10min；心跳 30s × 20 拍仍在锁存活窗口内. */
export const DEFAULT_TIDY_TIMEOUT_MS = 600_000;
/** 契约 §2.7 建议：30s 一次 UPDATE，开销可忽略. */
export const TIDY_HEARTBEAT_MS = 30_000;
/** 契约 §2.7 建议：= 10 个心跳周期；进程死亡后最多 5min 全库恢复可整理. */
export const TIDY_LOCK_STALE_MS = 300_000;
/** 一次 tidy 结束后抑制其他已武装会话立即重试的冷却窗（= 一个"锁代际"）. */
export const TIDY_RETRY_COOLDOWN_MS = 300_000;
/** 契约 §2.4：rp-notify 是角色上下文常驻负载——500 字符 ≈ 数百 token；全文落 audit. */
export const TIDY_BRIEFING_MAX_CHARS = 500;
/** {temp_list} 单页上限，超出截断加"另有 N 条"尾行（契约 §7-01-6）. */
export const TIDY_TEMP_LIST_MAX_ENTRIES = 200;

/** memory_kv keys（契约 §2.7 冻结 + 01 §2.7 备案）. */
export const TIDY_LOCK_KEY = "temp-tidy-lock";
export const TIDY_LAST_FINISH_KEY = "temp-tidy-last-finish";

/** tidy 工具署名（契约 §2.5 冻结）：落 audit 的 model 列 / 修订史 editor_model，天然可辨. */
export const TIDY_MODEL_ID = "temp-tidy";

/** Browser-safe pid read (§6.7 — temp-tidy.ts must not import node:-only modules). */
function getPid(): number {
	return typeof process !== "undefined" && typeof process.pid === "number" ? process.pid : 0;
}

function errText(error: unknown): string {
	return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

// ── Settings parsing (01 §2.3 — 字段级忽略 + 缺省，绝不 throw) ───────────────

export interface ParsedAutoTidy {
	enabled: boolean;
	modelRef?: string;
	maxTurns: number;
	timeoutMs: number;
}

/** 非法值字段级忽略落缺省：`enabled: 0` 这类笔误落 true 是接受的容错代价（§12-01-7）. */
export function parseAutoTidySettings(raw: AutoTidySettings | undefined): ParsedAutoTidy {
	const enabled = typeof raw?.enabled === "boolean" ? raw.enabled : true;
	const modelRef = typeof raw?.model === "string" && raw.model.trim() !== "" ? raw.model : undefined;
	const maxTurns =
		typeof raw?.maxTurns === "number" && Number.isInteger(raw.maxTurns) && raw.maxTurns >= 1 && raw.maxTurns <= 200
			? raw.maxTurns
			: DEFAULT_TIDY_MAX_TURNS;
	const timeoutMs =
		typeof raw?.timeoutMs === "number" && Number.isInteger(raw.timeoutMs) && raw.timeoutMs >= 1000
			? raw.timeoutMs
			: DEFAULT_TIDY_TIMEOUT_MS;
	return { enabled, modelRef, maxTurns, timeoutMs };
}

// ── {temp_list} rendering (01 §3.5) ─────────────────────────────────────────

/** 每行 `- {uri}（{source}）{首行 ≤80 字符}`；> TIDY_TEMP_LIST_MAX_ENTRIES 截断加尾行；
 * 空清单渲染字面 "（空）"（03 §2.1 措辞）. */
export function renderTempList(rows: ActiveTempRow[], maxEntries = TIDY_TEMP_LIST_MAX_ENTRIES): string {
	if (rows.length === 0) return "（空）";
	const lines = rows.slice(0, maxEntries).map((r) => {
		const head = (r.content.split("\n", 1)[0] ?? "").trim().slice(0, 80);
		return `- ${r.uri}（${r.source}）${head}`;
	});
	if (rows.length > maxEntries) lines.push(`…另有 ${rows.length - maxEntries} 条`);
	return lines.join("\n");
}

// ── Cross-process mutex (契约 §2.7 frozen shape; 01 §2.2) ───────────────────

export interface TidyLockValue {
	startedAt: string;
	heartbeatAt: string;
	pid?: number;
	sessionHint?: string;
}

export interface TidyLockHandle {
	owner: { pid: number; startedAt: string };
}

function parseLockRow(raw: string): TidyLockValue | null {
	try {
		const v = JSON.parse(raw) as TidyLockValue;
		if (typeof v?.startedAt === "string" && typeof v?.heartbeatAt === "string") return v;
	} catch {
		// 外部脏数据 — treated as un-stealable below (§6.2 已知接受).
	}
	return null;
}

export function readTidyLock(store: MemoryStore): TidyLockValue | null {
	const raw = store.getKv(TIDY_LOCK_KEY);
	return raw === null ? null : parseLockRow(raw);
}

/**
 * 原子"不存在或 heartbeatAt 已僵死才写入"：单条条件 UPSERT，changes = 抢锁结果。
 * 脏行（heartbeatAt 非法时间戳）julianday 为 NULL → 条件为假 → 永远抢不过（§6.2）。
 * busy 抛错 → 视同让路（§6.1：瞬态冲突，静默 return 保持武装）。
 */
export function tryAcquireTidyLock(store: MemoryStore, sessionHint?: string): TidyLockHandle | null {
	const now = new Date().toISOString();
	const value: TidyLockValue = { startedAt: now, heartbeatAt: now, pid: getPid(), sessionHint };
	try {
		const res = store.db
			.prepare(
				`INSERT INTO memory_kv (key, value, updated_at) VALUES (?, ?, ?)
				 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
				 WHERE julianday(json_extract(memory_kv.value, '$.heartbeatAt')) IS NOT NULL
				   AND julianday(json_extract(memory_kv.value, '$.heartbeatAt')) < julianday(?)`,
			)
			.run(TIDY_LOCK_KEY, JSON.stringify(value), now, new Date(Date.now() - TIDY_LOCK_STALE_MS).toISOString());
		return res.changes > 0 ? { owner: { pid: getPid(), startedAt: now } } : null;
	} catch {
		return null;
	}
}

/**
 * Heartbeat: CAS on the exact previous row value — a stolen lock (fencing
 * failure) leaves changes 0 → false. Transient busy → true (skip this beat;
 * the stale threshold is 10 heartbeats wide, §6.1).
 */
export function refreshTidyLock(store: MemoryStore, owner: TidyLockHandle["owner"]): boolean {
	try {
		const raw = store.getKv(TIDY_LOCK_KEY);
		if (raw === null) return false;
		const parsed = parseLockRow(raw);
		if (!parsed || parsed.pid !== owner.pid || parsed.startedAt !== owner.startedAt) return false;
		const next: TidyLockValue = { ...parsed, heartbeatAt: new Date().toISOString() };
		const res = store.db
			.prepare("UPDATE memory_kv SET value = ?, updated_at = ? WHERE key = ? AND value = ?")
			.run(JSON.stringify(next), next.heartbeatAt, TIDY_LOCK_KEY, raw);
		return res.changes > 0;
	} catch {
		return true; // transient busy — skip this beat (§6.1)
	}
}

/** Owner-conditional delete — mismatched/foreign locks are left untouched. */
export function releaseTidyLock(store: MemoryStore, owner: TidyLockHandle["owner"]): void {
	try {
		const raw = store.getKv(TIDY_LOCK_KEY);
		if (raw === null) return;
		const parsed = parseLockRow(raw);
		if (!parsed || parsed.pid !== owner.pid || parsed.startedAt !== owner.startedAt) return;
		store.db.prepare("DELETE FROM memory_kv WHERE key = ? AND value = ?").run(TIDY_LOCK_KEY, raw);
	} catch {
		// release failure is covered by the 5min stale reclaim (§6.1).
	}
}

// ── Briefing extraction & delivery shapes (01 §3.3, 契约 §2.6) ──────────────

export type TidyFailureReason =
	| "no-model"
	| "timeout"
	| "aborted-dispose"
	| "max-turns"
	| "error-stop"
	| "empty-briefing"
	| "lock-lost"
	| "loop-throw";

export type TidyOutcome =
	| { status: "completed"; briefing: string; turnCount: number }
	| { status: "failed"; reason: TidyFailureReason; error?: string };

export type BriefingExtraction = { ok: true; briefing: string } | { ok: false; reason: TidyFailureReason };

/**
 * E1-E5: take the LAST assistant message (no look-back — earlier assistant
 * texts inside a loop are mid-execution narration, never briefings); a max-turns
 * cutoff wins over any text the final message happens to carry (cutoff lands
 * after a tool batch, where the trailing text is narration); non-"stop" stop
 * reasons map to failures ("length" → error-stop: a half-sentence briefing
 * misleads); empty text → empty-briefing.
 */
export function extractBriefing(messages: AgentMessage[], opts: { capped: boolean }): BriefingExtraction {
	let last: AssistantMessage | undefined;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m?.role === "assistant") {
			last = m;
			break;
		}
	}
	if (!last) return { ok: false, reason: "empty-briefing" };
	if (opts.capped) return { ok: false, reason: "max-turns" };
	if (last.stopReason === "aborted") return { ok: false, reason: "timeout" };
	if (last.stopReason !== "stop") return { ok: false, reason: "error-stop" };
	const text = last.content
		.filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
		.map((b) => b.text)
		.join("\n")
		.trim();
	if (text === "") return { ok: false, reason: "empty-briefing" };
	return { ok: true, briefing: text };
}

/** 码点截断（防 emoji/生僻字代理对劈半），超长时给出 agent 可直接调用的全文入口。 */
export function truncateBriefing(text: string, max = TIDY_BRIEFING_MAX_CHARS, auditId?: number): string {
	const chars = [...text];
	if (chars.length <= max) return text;
	const auditUri = auditId === undefined ? "MEM://audit/temp_tidy_complete/1" : `MEM://audit/id/${auditId}`;
	return `${chars.slice(0, max).join("")}\n…（简报超长，已截断；全文：recall(uri="${auditUri}")）`;
}

const TIDY_FAILURE_REASON_LABELS: Record<TidyFailureReason, string> = {
	"no-model": "模型不可用",
	timeout: "超时",
	"aborted-dispose": "运行中被中止",
	"max-turns": "轮数用尽",
	"error-stop": "模型错误终止",
	"empty-briefing": "未产出简报",
	"lock-lost": "整理锁易主",
	"loop-throw": "内部异常",
};

/** D1 兜底通知：头两行陈述失败 + 共享整理指引段（TEMP_TIDY_GUIDE_LINES 防漂移）. */
export function buildTidyFailureContent(reason: TidyFailureReason, count: number, threshold: number): string {
	return [
		`<temp-notify>`,
		`自动整理（temp-tidy）未能完成（原因：${TIDY_FAILURE_REASON_LABELS[reason] ?? reason}）。`,
		`TEMP 现有 ${count} 条草稿（阈值 ${threshold}）。`,
		...TEMP_TIDY_GUIDE_LINES,
		`</temp-notify>`,
	].join("\n");
}

// ── The runner (01 §3.2 R1-R9) ──────────────────────────────────────────────

/** runTidy 只消费 host 的两个原语（契约 §2.3/§2.4）——结构化最小面，headless 可注入. */
export interface SideStreamHandle {
	/** host 闭包内已 pin 死解析结果；agentLoop 以 config.model 回调首参，runner 忽略之. */
	streamFn: StreamFn;
	/** host 解析后的真 Model 实例（J7）——直接填 AgentLoopConfig.model. */
	model: Model<any>;
}

export interface TidyHost {
	sideStreamFn(options: { modelRef?: string; signal?: AbortSignal }): Promise<SideStreamHandle>;
	sendCustomMessage(
		message: { customType: string; content: string; display: false; details?: unknown },
		options?: { triggerTurn?: boolean },
	): void;
}

export interface TidyRunnerOptions {
	store: MemoryStore;
	host: TidyHost;
	/** 已解析（覆写或内置默认，module T3）. */
	systemPrompt: string;
	/** 已解析，含 {temp_list} 占位（可不含，L4 audit 留痕）. */
	taskTemplate: string;
	/** settings.memory.temp.autoTidy.model 原样透传. */
	modelRef?: string;
	maxTurns: number;
	timeoutMs: number;
	/** module dispose 联动（module.ts dispose aborts this). */
	parentSignal?: AbortSignal;
	/** 配置阈值（失败通知展示用；缺省 DEFAULT_TEMP_THRESHOLD）。01 §2.1 冻结八字段之外
	 * 的最小补充——§3.3 失败通知规格需要 count+threshold 两个数字. */
	threshold?: number;
}

/** ToolDefinition（memory MemoryToolDef）→ pi-agent-core AgentTool adapter（01 §3.2 R5 表）. */
function toAgentTool(def: MemoryToolDef): AgentTool {
	return {
		name: def.name,
		label: def.label,
		description: def.description,
		// TypeBox schema passed through — the loop validates arguments itself
		// (agent-loop.ts validateToolArguments).
		parameters: def.parameters,
		// Signature narrowing: memory tools are synchronous SQLite operations —
		// no abort seam, no partial updates, so signal/onUpdate are dropped.
		execute: async (toolCallId: string, params: unknown) => {
			const result = await def.execute(toolCallId, params as Record<string, unknown>);
			return { content: result.content, details: result.details };
		},
		// promptGuidelines deliberately STRIPPED (契约 §9-J5): tidy is a system
		// agent; the engine's forced disclosure appendix would break E5
		// overwrite integrity — an overwritten systemPrompt takes effect verbatim.
	};
}

/** 永不 reject：一切失败都折算成 TidyOutcome；调用方 void + 防御性 .catch. */
export function runTidy(opts: TidyRunnerOptions): Promise<TidyOutcome> {
	return runTidyInner(opts).catch(
		(error): TidyOutcome => ({ status: "failed", reason: "loop-throw", error: errText(error) }),
	);
}

async function runTidyInner(opts: TidyRunnerOptions): Promise<TidyOutcome> {
	const { store, host, systemPrompt, taskTemplate, modelRef, maxTurns, timeoutMs, parentSignal, threshold } = opts;

	// Owner identity: the caller acquired the lock (module T4); re-read the row
	// and adopt it when it carries our pid. A foreign/absent row at this point
	// means the lock was stolen between acquire and start — fencing failure.
	const pid = getPid();
	const held = readTidyLock(store);
	if (!held || held.pid !== pid) return { status: "failed", reason: "lock-lost" };
	const owner = { pid, startedAt: held.startedAt };

	const controller = new AbortController();
	let lockLost = false;
	let outcome: TidyOutcome = { status: "failed", reason: "loop-throw", error: "unclassified" };
	const meta = { turnCount: 0, beforeCount: 0 };
	let completionAuditId: number | undefined;
	// Abort-source disambiguation (§3.3 E3): the signal that killed the run
	// decides the failure reason — dispose wins over fencing wins over timeout.
	const abortOutcome = (): TidyOutcome =>
		parentSignal?.aborted
			? { status: "failed", reason: "aborted-dispose" }
			: lockLost
				? { status: "failed", reason: "lock-lost" }
				: { status: "failed", reason: "timeout" };

	// R1 — heartbeat: losing the lock (stolen after stale reclaim) aborts the
	// run so a presumed-dead owner can never wake up and keep writing nodes.
	const heartbeat = setInterval(() => {
		if (!refreshTidyLock(store, owner)) {
			lockLost = true;
			controller.abort();
		}
	}, TIDY_HEARTBEAT_MS);
	heartbeat.unref?.();
	// R3 — timeout: the absolute cost ceiling; aborts the combined signal.
	// (No timedOut flag: abortOutcome() derives "timeout" by exclusion —
	// dispose and lock-lost each have their own branch, so reaching the
	// final arm means the timer fired.)
	const timer = setTimeout(() => {
		controller.abort();
	}, timeoutMs);
	timer.unref?.();
	const onParentAbort = () => controller.abort();
	parentSignal?.addEventListener("abort", onParentAbort, { once: true });

	try {
		if (parentSignal?.aborted) {
			outcome = { status: "failed", reason: "aborted-dispose" };
		} else {
			// R2 — model resolution happens host-side; throw → "no-model".
			let streamed: SideStreamHandle | undefined;
			try {
				streamed = await host.sideStreamFn({ modelRef, signal: controller.signal });
			} catch (error) {
				outcome = { status: "failed", reason: "no-model", error: errText(error) };
			}
			if (streamed) {
				// The controller may already be dead here (dispose/timeout/lock-lost
				// fired while awaiting the side stream). Never enter the loop with an
				// aborted signal: streamFns register abort listeners that no longer
				// fire on an already-aborted signal — the run would hang to timeout.
				if (controller.signal.aborted) {
					outcome = abortOutcome();
				} else {
					// R4 — {temp_list} 底册快照 + renderTidyTaskPrompt 单点渲染（J2 函数式替换）.
					const rows = listActiveTempRows(store);
					meta.beforeCount = rows.length;
					const taskPrompt = renderTidyTaskPrompt(taskTemplate, {
						tempList: renderTempList(rows),
						maxTurns,
					});
					// R5 — tidyCtx (契约 §2.5 冻结四字段): no session anchors → writes are
					// branch-independent, recall sees the whole library, audit turn stays null.
					const tidyCtx: MemoryToolContext = { modelId: TIDY_MODEL_ID };
					const tidyTools = createMemoryTools(store, tidyCtx).map(toAgentTool);

					// R6 — agentLoop; no native maxTurns (grep-verified) → shouldStopAfterTurn seam.
					let turnCount = 0;
					let capped = false;
					try {
						const stream = agentLoop(
							[{ role: "user", content: [{ type: "text", text: taskPrompt }], timestamp: Date.now() }],
							{ systemPrompt, messages: [], tools: tidyTools },
							{
								// J7: real Model instance from the host — no placeholder stub.
								model: streamed.model,
								// Identity: tidy only produces user/assistant/toolResult roles.
								convertToLlm: (messages) => messages as unknown as Message[],
								// The only legal maxTurns seam; true → graceful agent_end after
								// the turn; capped wins over briefing text (§3.3 E2).
								shouldStopAfterTurn: () => {
									capped = ++turnCount >= maxTurns;
									return capped;
								},
								// Writes shared nodes (consolidate/revise read-then-write) —
								// sequential keeps the batch deterministic.
								toolExecution: "sequential",
							},
							controller.signal,
							streamed.streamFn,
						);
						const messages: AgentMessage[] = await stream.result();
						meta.turnCount = turnCount;
						// Abort-source disambiguation precedes briefing extraction (§3.3 E3).
						if (controller.signal.aborted) outcome = abortOutcome();
						else {
							const extracted = extractBriefing(messages, { capped });
							outcome = extracted.ok
								? { status: "completed", briefing: extracted.briefing, turnCount }
								: { status: "failed", reason: extracted.reason };
						}
					} catch (error) {
						outcome = { status: "failed", reason: "loop-throw", error: errText(error) };
					}
				}
			}
		}
	} finally {
		// R8 — finalize, fixed order: timers → lock → last-finish → audit.
		clearInterval(heartbeat);
		clearTimeout(timer);
		parentSignal?.removeEventListener("abort", onParentAbort);
		releaseTidyLock(store, owner); // lock-lost → owner mismatch → idempotent no-op
		const disposed = outcome.status === "failed" && outcome.reason === "aborted-dispose";
		if (!disposed) store.setKv(TIDY_LAST_FINISH_KEY, new Date().toISOString());
		if (outcome.status === "completed") {
			completionAuditId = store.logAudit("temp_tidy_complete", {
				model: TIDY_MODEL_ID,
				details: JSON.stringify({
					turns: outcome.turnCount,
					briefingChars: [...outcome.briefing].length,
					beforeCount: meta.beforeCount,
					model: modelRef ?? "session-default",
					briefing: outcome.briefing,
				}),
			});
		} else {
			store.logAudit("temp_tidy_failed", {
				model: TIDY_MODEL_ID,
				details: JSON.stringify({ reason: outcome.reason, error: outcome.error, beforeCount: meta.beforeCount }),
			});
		}
	}

	// R9 — delivery: the briefing never wakes the role (D9); a failure (except
	// dispose, where the host is already being torn down) falls back to the
	// manual notify with default triggerTurn (D1).
	if (outcome.status === "completed") {
		const afterCount = listActiveTempRows(store).length;
		host.sendCustomMessage(
			{
				customType: RP_NOTIFY_TYPE,
				content: truncateBriefing(outcome.briefing, TIDY_BRIEFING_MAX_CHARS, completionAuditId),
				display: false,
				details: {
					kind: "temp-tidy-report",
					model: modelRef ?? "session-default",
					turnCount: outcome.turnCount,
					beforeCount: meta.beforeCount,
					afterCount,
				},
			},
			{ triggerTurn: false },
		);
	} else if (outcome.reason !== "aborted-dispose") {
		const count = listActiveTempRows(store).length;
		host.sendCustomMessage({
			customType: RP_NOTIFY_TYPE,
			content: buildTidyFailureContent(outcome.reason, count, threshold ?? DEFAULT_TEMP_THRESHOLD),
			display: false,
			details: {
				kind: "temp-tidy-failure",
				reason: outcome.reason,
				count,
				threshold: threshold ?? DEFAULT_TEMP_THRESHOLD,
			},
		});
	}
	return outcome;
}
