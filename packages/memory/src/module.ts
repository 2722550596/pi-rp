/**
 * Memory module — session-bound layer (docs/memory-system.md §8/§9/§15.3).
 *
 * createMemoryModule(store, opts) wires the pure MemoryStore onto a coding
 * agent session host:
 * - registerSession(host): 12 tools, 3 prompt slots, rp-memories custom type,
 *   before_agent_start auto-recall injection (function-level port of
 *   ~/.pi/agent/extensions/nocturne-memory-recall.ts 92-114/554-681/700-832).
 *   Called once per engine runtime build (every reload gets a fresh host) —
 *   must stay idempotent.
 * - onLeafChange(): rollback coupling (§8: anchor visibility recompute + raw
 *   mirror reconciliation for THIS session only — other sessions' rows are
 *   never touched) + in-flight recall cancellation (a branch switch makes
 *   stale async results meaningless).
 * - onTurnEnd(): raw_log incremental upsert for this turn, single pass in the
 *   original message order (§4/§15.3), then autoretain / TEMP checks. The
 *   engine calls this directly after the turn_end extension emit.
 * - dispose(): aborts in-flight recall/autoretain side work for this module.
 *
 * packages/memory never imports coding-agent: the host is a minimal
 * structural interface the engine satisfies.
 */
import { createHash } from "node:crypto";
import { type AutoretainTask, DEFAULT_AUTORETAIN_TASKS, dueTasks, runAutoretainTask } from "./autoretain.ts";
import type { MemorySettings } from "./config.ts";
import { EmbeddingClient, resolveEmbeddingsConfig } from "./embeddings.ts";
import { type RecalledItem, type RecallMode, search, toEpochDays } from "./recall.ts";
import { createMemorySlots, type MemorySlotDefinition } from "./slots.ts";
import type { MemoryNode, MemoryStore, RawEntry } from "./store.ts";
import { checkTempThreshold, countActiveTempNodes, DEFAULT_TEMP_THRESHOLD, RP_NOTIFY_TYPE } from "./temp-notify.ts";
import { createMemoryTools } from "./tools.ts";

// ── Host interface (structural mirror of the coding-agent ExtensionAPI) ─────

/** Live session facts the module reads per prompt / per hook. */
export interface MemoryModuleSessionInfo {
	modelId?: string;
	leafId?: string | null;
	/** Session that owns this module — scopes raw mirror + auto visibility. */
	sessionId: string;
	/** Current turn counter (audit turn column, autoretain cadence check). */
	turn: number;
}

/** Snapshot of the active session path (compaction-aware). */
export interface MemoryBranchSnapshot {
	/** Entry ids on the active path, leaf → root. */
	entryIds: string[];
	/**
	 * Context entries in LLM order (SessionManager.buildContextEntries()).
	 * Single source of truth for dedup rebuild and raw_log reconciliation
	 * (docs §16 risk table).
	 */
	entries: Array<Record<string, unknown>>;
}

/** One message destined for raw_log at turn end (§4 batched append). */
export interface MemoryTurnMessage {
	role: string;
	text: string;
	/** Session entry id the message was persisted under. */
	entryId: string;
	/** Original wall timestamp of the session entry (raw_log preservation). */
	timestamp: string;
	/** Present on custom_message entries (§15.3 capture switch). */
	customType?: string;
	display?: boolean;
}

export interface MemoryModuleHost {
	/** Register a tool the LLM can call (engine adapts the TypeBox schema). */
	registerTool(tool: {
		name: string;
		label: string;
		description: string;
		promptSnippet?: string;
		parameters: unknown;
		execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
	}): void;
	/** Register a prompt-preset slot (engine bridges MemorySlotDefinition). */
	registerSlot(definition: MemorySlotDefinition): void;
	/** Declare the custom-message policy for rp-memories injections. */
	registerCustomType(
		customType: string,
		policy: { context: "include" | "exclude"; llmRole: "user" | "assistant"; compaction: "include" | "exclude" },
	): void;
	/** Subscribe to a session event. Event/context payloads are host-owned. */
	on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void;
	/** Live session info (model id, current leaf, session id, turn). */
	getSessionInfo(): MemoryModuleSessionInfo;
	/** Active-path snapshot (engine rebuilds from SessionManager per call). */
	getBranchSnapshot(): MemoryBranchSnapshot;
	/** This turn's new messages for raw_log (engine reads the branch tail). */
	getTurnMessages(): MemoryTurnMessage[];
	/**
	 * ALL messages on the active branch, root → leaf (LLM order) — the full
	 * raw mirror for reconciliation/backfill, including resumed or
	 * merely-browsed paths.
	 */
	getActiveBranchMessages(): MemoryTurnMessage[];
	/**
	 * System→role directed message (§7 notify primitive): display:false +
	 * triggerTurn custom message, compaction-excluded by the type policy.
	 */
	sendCustomMessage(message: { customType: string; content: string; display: false; details?: unknown }): void;
	/**
	 * One-shot side LLM request outside the main loop (§5 autoretain engine).
	 * The engine implementation is completeSideRequest — gateway attribution +
	 * session-scoped abort; the module passes task model role / maxTokens /
	 * label through.
	 */
	completeSideRequest(
		prompt: string,
		options: { modelRole?: "smol" | "default"; maxTokens?: number; signal?: AbortSignal; label: string },
	): Promise<string>;
}

export interface MemoryModuleOptions {
	/** memory.* settings (§15.3 switches, §9 recall params). */
	settings?: MemorySettings;
	/**
	 * Embedding client override. Defaults to one built from
	 * settings.memory.embeddings + the env key; downstream consumers (and
	 * tests) can supply their own provider or a stub.
	 */
	embeddings?: EmbeddingClient;
}

export interface MemoryModule {
	/** Register tools/slot/customType/hooks onto the session host. */
	registerSession(host: MemoryModuleHost): void;
	/** Rollback coupling (§8): anchor visibility recompute + raw mirror reconcile. */
	onLeafChange(): Promise<void>;
	/** raw_log write-through (§4/§15.3): upsert this turn's messages. */
	onTurnEnd(): Promise<void>;
	/** Cancel in-flight recall/autoretain work. Call before dropping the module. */
	dispose(): void;
}

// ── Recall tuning (port of nocturne-memory-recall.ts 92-114; §9 fixed) ──────

export const RECALL_TOP_K = 3;
export const RECALL_MIN_SCORE = 0.35;
/** Keyword-mode injection floor (§5.9 — keyword-only auto-recall needs its own bar). */
export const RECALL_KEYWORD_MIN_SCORE = 0.12;
/** Anchor threshold: only the top item earns "高度相关" above this absolute score. */
export const RECALL_HIGH_CONFIDENCE = 0.55;
/** Recent conversation messages forming the second recall query. */
const PRIOR_CONTEXT_MESSAGES = 6;
/** Raw rows forming one autoretain 纪要窗口 (§5: token 预算 guard). */
const AUTORETAIN_WINDOW_ROWS = 80;
/** Custom message type carrying the injected memories block. */
export const RP_MEMORIES_TYPE = "rp-memories";
/** Maintenance-type domains excluded from autorecall by default (TEMP stays recalleable, §9). */
export const DEFAULT_DOMAIN_BLOCKLIST = ["maintenance", "history_raw"];

/** The 12 tool names (engine default-active list; docs §10). */
export const MEMORY_TOOL_NAMES = [
	"recall",
	"retrieve",
	"memorize",
	"revise",
	"forget",
	"relocate",
	"associate",
	"trigger",
	"consolidate",
	"retrace",
	"set_time",
	"awaken",
] as const;

/** details payload carried on rp-memories custom messages (dedup state). */
export interface InjectedDetail {
	ids: string[];
	hashes: Record<string, string>;
	mode: RecallMode;
}

function md5(text: string): string {
	return createHash("md5").update(text, "utf-8").digest("hex");
}

// ── Injection format (port of nocturne-memory-recall.ts 685-698) ────────────

export function buildMemoriesBlock(items: RecalledItem[]): string {
	const lines: string[] = ["<memories>"];
	items.forEach((item, i) => {
		const anchor = i === 0 && item.score >= RECALL_HIGH_CONFIDENCE ? " [高度相关，建议读取]" : "";
		lines.push(`\n${i + 1}. ${item.uri}${anchor}`);
		if (item.disclosure) lines.push(`   想起条件: ${item.disclosure}`);
		lines.push(`   摘要: ${item.summary}`);
	});
	lines.push("\n如果你想起了什么，主动用 recall 读取原文试试吧。", "</memories>");
	return lines.join("\n");
}

// ── Dedup map rebuilt from the active branch (port of 710-737) ──────────────

/**
 * Rebuild uri → content-hash of the last injected version from the session's
 * ACTIVE path entries (rp-memories custom_message entries). Entries abandoned
 * by rollback do not count — the caller passes buildContextEntries() output.
 */
export function rebuildInjectedFromEntries(
	entries: Array<{ type?: unknown; customType?: unknown; details?: unknown }>,
): Map<string, string> {
	const injected = new Map<string, string>();
	for (const e of entries) {
		if (e.type !== "custom_message" || e.customType !== RP_MEMORIES_TYPE) continue;
		const details = e.details as Partial<InjectedDetail> | undefined;
		if (details?.hashes) {
			for (const uri of Object.keys(details.hashes)) injected.set(uri, details.hashes[uri]);
		} else if (details?.ids) {
			// Legacy entries without per-uri hashes: uri-only key so the same
			// content is not re-injected verbatim.
			for (const uri of details.ids) injected.set(uri, `legacy:${uri}`);
		}
	}
	return injected;
}

/** Extract message texts for the Prior-context query (port of 779-799). */
export function collectPriorContext(entries: Array<Record<string, unknown>>, limit = PRIOR_CONTEXT_MESSAGES): string[] {
	const msgs: string[] = [];
	for (let i = entries.length - 1; i >= 0 && msgs.length < limit; i--) {
		const e = entries[i] as { type?: unknown; message?: { role?: unknown; content?: unknown } };
		if (e.type !== "message" || !e.message || typeof e.message.role !== "string") continue;
		const content = e.message.content;
		const text =
			typeof content === "string"
				? content
				: Array.isArray(content)
					? content
							.map((b: { text?: unknown }) => (typeof b?.text === "string" ? b.text : ""))
							.join(" ")
							.trim()
					: "";
		if (!text || text.includes("<memories>")) continue;
		msgs.unshift(`${e.message.role}: ${text}`);
	}
	return msgs;
}

// ── raw_log capture switch (§15.3) ───────────────────────────────────────────

export function shouldCaptureCustomType(
	customType: string,
	display: boolean,
	mode: "all-display-true" | "none" | string[],
): boolean {
	if (mode === "none") return false;
	if (mode === "all-display-true") return display;
	return mode.includes(customType);
}

// ── The module ───────────────────────────────────────────────────────────────

export function createMemoryModule(store: MemoryStore, opts: MemoryModuleOptions = {}): MemoryModule {
	const settings = opts.settings ?? {};
	const recallCfg = settings.recall ?? {};
	const topK = recallCfg.topK ?? RECALL_TOP_K;
	const minScore = recallCfg.minScore ?? RECALL_MIN_SCORE;
	const keywordMinScore = recallCfg.keywordMinScore ?? RECALL_KEYWORD_MIN_SCORE;
	const blocklist = recallCfg.blocklist ?? DEFAULT_DOMAIN_BLOCKLIST;
	const rawLogCustomTypes = settings.rawLog?.customTypes ?? "all-display-true";
	// §9 vector channel: API mode only, key from env. `mode: "off"` (the
	// privacy-first default), a missing key or any request failure degrades to
	// keyword scoring (recall.ts).
	const embeddings = opts.embeddings ?? new EmbeddingClient(resolveEmbeddingsConfig(settings.embeddings));
	const tempThreshold = settings.temp?.threshold ?? DEFAULT_TEMP_THRESHOLD;
	// §5 task registry: core defaults, downstream may register/override.
	// memory.autoretain.everyNTurns (§9) seeds the cadence of the CORE DEFAULT
	// tasks only (matched by name) — user-registered tasks always keep the
	// cadence they pinned, even when it happens to equal the default (4).
	//
	// Autoretain is NOT on by default: it consumes side-request model tokens
	// every N turns, so a bare session (no memory.autoretain declared) stays
	// zero-cost — the same privacy/opt-in posture as the embeddings default
	// (§27.1). Explicitly configuring either the cadence or the task list
	// opts in; the core default tasks fill in when only the cadence is given.
	const autoretainOptedIn = settings.autoretain !== undefined;
	const coreDefaultNames = new Set(DEFAULT_AUTORETAIN_TASKS.map((t) => t.name));
	const autoretainTasks: AutoretainTask[] = autoretainOptedIn
		? [...(settings.autoretain?.tasks ?? DEFAULT_AUTORETAIN_TASKS)].map((t) =>
				coreDefaultNames.has(t.name) && settings.autoretain?.everyNTurns
					? { ...t, everyNTurns: settings.autoretain.everyNTurns }
					: t,
			)
		: [];
	// §5: multiple tasks share ONE turn counter.
	let autoretainTurnCounter = 0;
	// §7 hysteresis: do not re-notify until the zone was cleaned below threshold.
	let tempNotified = false;

	// auto nodes hidden by rollback — recomputed on every prompt / leaf change.
	let hiddenAutoNodeIds = new Set<string>();
	// Per-recall cancellation: a new recall or a leaf change supersedes the
	// in-flight one; dispose() cancels everything.
	let recallAbort: AbortController | undefined;
	// Autoretain side requests ride one controller, aborted at dispose().
	const autoretainAbort = new AbortController();
	let disposed = false;

	// Current host binding — refreshed by registerSession on every reload.
	let host: MemoryModuleHost | undefined;

	function getAwakenUriSet(): Set<string> {
		try {
			const raw = store.getKv("awaken_uris");
			const list = raw ? (JSON.parse(raw) as unknown) : [];
			return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : []);
		} catch {
			return new Set<string>();
		}
	}

	/** Visibility predicate (§8): auto nodes hidden when their anchor left the path. */
	function isVisible(node: MemoryNode): boolean {
		if (node.source !== "auto") return true;
		return !hiddenAutoNodeIds.has(node.node_id);
	}

	/**
	 * Anchor visibility recompute (§8, v5.5 session rules):
	 * - manual/import nodes are always visible;
	 * - auto nodes without BOTH anchor_session_id and anchor_entry_id are
	 *   hidden (no provenance to walk back to);
	 * - auto nodes from ANOTHER session are visible (B's reroll must never
	 *   hide A's products);
	 * - auto nodes from THIS session are visible only while their anchor
	 *   entry is on the active path.
	 */
	function recomputeAnchorVisibility(entryIds: string[]): Set<string> {
		const active = new Set(entryIds);
		const currentSession = host?.getSessionInfo().sessionId;
		const hidden = new Set<string>();
		for (const node of store.listNodes()) {
			if (node.source !== "auto") continue;
			if (!node.anchor_session_id || !node.anchor_entry_id) {
				hidden.add(node.node_id);
				continue;
			}
			if (currentSession && node.anchor_session_id !== currentSession) continue;
			if (!active.has(node.anchor_entry_id)) hidden.add(node.node_id);
		}
		return hidden;
	}

	/** Map a session message to a raw entry (wall_ts = original timestamp). */
	function toRawEntry(m: MemoryTurnMessage, sessionId: string, worldTs: string | null): RawEntry {
		return {
			role: m.customType ?? m.role,
			text: m.text,
			entry_id: m.entryId,
			session_id: sessionId,
			wall_ts: m.timestamp,
			world_ts: worldTs,
		};
	}

	/**
	 * Hybrid recall over the tree pool (§9). Delegates to the shared scorer in
	 * recall.ts — the same code path the retrieve tool uses — so injection and
	 * explicit search can never drift apart again. Vector scoring runs when an
	 * embedding client is configured and reachable; otherwise the mode falls
	 * back to keyword and HIGH_CONFIDENCE stays out of reach by design.
	 */
	async function recallForQueries(queries: string[]): Promise<{ items: RecalledItem[]; mode: RecallMode }> {
		if (queries.length === 0) return { items: [], mode: "keyword" };
		// A newer prompt / leaf change makes the in-flight recall stale — cancel it.
		recallAbort?.abort();
		const ctrl = new AbortController();
		recallAbort = ctrl;
		try {
			const nowDays = toEpochDays(store.getWorldTime() ?? new Date().toISOString().slice(0, 10)) ?? 0;
			// awaken uris already live in the preset slot — never inject them twice
			// (§9); TEMP is NOT blocklisted (dynamic zone stays recalleable).
			return await search(
				store,
				embeddings,
				{
					queries,
					domainBlocklist: blocklist,
					excludeUris: getAwakenUriSet(),
					isVisible,
					topK,
					minScore,
					keywordMinScore,
					nowDays,
				},
				ctrl.signal,
			);
		} finally {
			if (recallAbort === ctrl) recallAbort = undefined;
		}
	}

	/** before_agent_start handler: dual-query recall + dedup + injection. */
	async function handleBeforeAgentStart(event: unknown): Promise<{ message: Record<string, unknown> } | undefined> {
		const prompt = (event as { prompt?: unknown } | null)?.prompt;
		if (typeof prompt !== "string") return;
		const trimmed = prompt.trim();
		// Skip slash-command expansions and empty prompts.
		if (!trimmed || trimmed.startsWith("/") || trimmed.startsWith("\\")) return;

		const snapshot = host?.getBranchSnapshot();
		if (!snapshot) return;

		// Rebuild on every prompt: the active path may have changed via /tree,
		// /resume, /fork or compaction between prompts. This also covers
		// --resume paths that never fire a leaf change.
		hiddenAutoNodeIds = recomputeAnchorVisibility(snapshot.entryIds);
		const injected = rebuildInjectedFromEntries(snapshot.entries);

		// Dual query: [current prompt (retrieval intent), "Prior context:"]
		// recent message turns (declarative text) — port of 773-802.
		const queries: string[] = [trimmed];
		const prior = collectPriorContext(snapshot.entries);
		if (prior.length > 0) queries.push(`Prior context:\n${prior.join("\n")}`);

		let items: RecalledItem[];
		let mode: RecallMode;
		try {
			({ items, mode } = await recallForQueries(queries));
		} catch {
			// Recall must never break the turn: no memories this prompt.
			// (Abort mid-flight is the normal supersede path — same outcome.)
			return;
		}
		if (items.length === 0) return;

		// Dedup against previously injected (same content version). The hash
		// covers the FULL body: a content edit invalidates the marker so the
		// updated memory gets re-injected.
		const fresh: RecalledItem[] = [];
		const hashes: Record<string, string> = {};
		for (const it of items) {
			const hash = md5(`${it.uri}|${it.content}`);
			if (injected.get(it.uri) === hash) continue;
			fresh.push(it);
			hashes[it.uri] = hash;
		}
		if (fresh.length === 0) return;

		// §12 audit: only an actual fresh injection leaves a trace.
		store.logAudit("inject", {
			details: JSON.stringify({ uris: fresh.map((i) => i.uri), mode }),
			turn: host?.getSessionInfo().turn,
		});

		const details: InjectedDetail = { ids: fresh.map((i) => i.uri), hashes, mode };
		return {
			message: {
				customType: RP_MEMORIES_TYPE,
				content: buildMemoriesBlock(fresh),
				display: false,
				details,
			},
		};
	}

	/**
	 * Phase 3 turn-end extensions (called from onTurnEnd after the raw_log
	 * write): autoretain task firing (§5) + TEMP threshold check (§7).
	 */
	async function handleAutoretainAndTemp(): Promise<void> {
		// ── autoretain (§5): shared turn counter, per-task cadence ──────────
		autoretainTurnCounter++;
		const due = dueTasks(autoretainTasks, autoretainTurnCounter);
		const sessionId = host?.getSessionInfo().sessionId;
		for (const task of due) {
			if (!sessionId) continue;
			// Per-session, per-task window (§18 fix): consume exactly the rows
			// of THIS session's active branch this task has not processed yet.
			// Off-branch rows stay unprocessed (not invisible) — switching
			// back re-enables them; other tasks never eat this window.
			const window = store.listUnprocessedActiveRaw(sessionId, task.name, AUTORETAIN_WINDOW_ROWS);
			if (window.length === 0) continue;
			if (!host?.completeSideRequest) continue; // no side-request primitive → silently skip
			const outcome = await runAutoretainTask(
				store,
				task,
				window,
				{
					completeSideRequest: (prompt, sideOpts) =>
						(host as MemoryModuleHost).completeSideRequest(prompt, sideOpts),
					getSessionInfo: () => host?.getSessionInfo() ?? ({} as MemoryModuleSessionInfo),
				},
				autoretainAbort.signal,
			);
			if (outcome.ok) {
				// Consumed marker only on success — failures retry the same
				// window next round (docs §5 失败静默跳过).
				store.markAutoretainProcessed(
					sessionId,
					task.name,
					window.map((w) => w.entry_id),
				);
			}
			// §12 audit: failures are recorded too — silent skips must stay
			// discoverable (cheap-model JSON contract violations, etc.).
			store.logAudit("autoretain_task", {
				task: task.name,
				turn: host?.getSessionInfo().turn,
				details: outcome.ok ? `${task.name} ok` : `${task.name} failed: ${outcome.error ?? "unknown"}`,
			});
		}

		// ── TEMP dynamic zone (§7): threshold check after write paths ───────
		const isVisibleLocal = (node: { source: string; node_id: string }): boolean =>
			node.source !== "auto" || !hiddenAutoNodeIds.has(node.node_id);
		if (countActiveTempNodes(store, isVisibleLocal) < tempThreshold) {
			tempNotified = false; // cleaned below threshold — re-arm
			return;
		}
		if (tempNotified) return;
		const notify = checkTempThreshold(store, { threshold: tempThreshold, isVisible: isVisibleLocal });
		if (notify) {
			tempNotified = true;
			host?.sendCustomMessage(notify);
		}
	}

	return {
		registerSession(newHost: MemoryModuleHost): void {
			host = newHost;
			// 1. Tools (12) — provenance (model id / leaf id / session / turn)
			// is read lazily at execute time via host.getSessionInfo(), so
			// signatures stay live across turns without re-registering.
			const toolCtx = {
				get modelId() {
					return host?.getSessionInfo().modelId;
				},
				get leafId() {
					return host?.getSessionInfo().leafId ?? null;
				},
				get sessionId() {
					return host?.getSessionInfo().sessionId;
				},
				get turn() {
					return host?.getSessionInfo().turn;
				},
				// Live visibility predicate — hidden auto nodes never leak into
				// recall/retrieve/views/slots (§5.7).
				get isVisible() {
					return isVisible;
				},
				// retrieve(semantic) shares the injection client — one cache, one
				// failure latch, one model.
				embeddings,
			};
			for (const tool of createMemoryTools(store, toolCtx)) {
				newHost.registerTool({
					name: tool.name,
					label: tool.label,
					description: tool.description,
					promptSnippet: tool.description.split("\n")[0],
					parameters: tool.parameters,
					execute: async (toolCallId, params) => tool.execute(toolCallId, params),
				});
			}
			// 2. Slots (3). Engine-side static registration (registerSlot(def,
			// true)) reuses these definitions; via the host they register as
			// custom slots. Visibility filtering rides the live predicate.
			for (const slot of createMemorySlots(store, { isVisible })) {
				newHost.registerSlot(slot);
			}
			// 3. Custom type policy: LLM-visible, TUI-hidden, compaction-excluded.
			newHost.registerCustomType(RP_MEMORIES_TYPE, {
				context: "include",
				llmRole: "user",
				compaction: "exclude",
			});
			// 3b. rp-notify: TEMP 整理通知（§7）与 autoretain 反思提示共用
			// "系统→角色定向消息"原语——display:false + triggerTurn, compaction 排除.
			newHost.registerCustomType(RP_NOTIFY_TYPE, {
				context: "include",
				llmRole: "user",
				compaction: "exclude",
			});
			// 4. before_agent_start hook — auto-recall injection. turn_end is
			// deliberately NOT subscribed: the engine calls onTurnEnd() directly
			// after the extension emit (double-write guard).
			newHost.on("before_agent_start", (event: unknown) => handleBeforeAgentStart(event));
		},

		async onLeafChange(): Promise<void> {
			try {
				const snapshot = host?.getBranchSnapshot();
				// ① anchor visibility recompute (§8 ①) — session-aware rules
				hiddenAutoNodeIds = recomputeAnchorVisibility(snapshot ? snapshot.entryIds : []);
				// A branch switch makes in-flight recall stale — cancel it so
				// superseded results never inject (§4.8).
				recallAbort?.abort();
				// ② raw mirror reconciliation (§8 ②, v5.5): upsert the FULL
				// active branch then mark THIS session's orphaned rows inactive.
				// Other sessions' rows are never read or written. This also
				// backfills resumed / merely-browsed branches immediately —
				// no waiting for the next turn.
				const sessionId = host?.getSessionInfo().sessionId;
				const active = host?.getActiveBranchMessages();
				if (sessionId && active) {
					const worldTs = store.getWorldTime();
					store.syncRawBranch(
						sessionId,
						active.map((m) => toRawEntry(m, sessionId, worldTs)),
					);
				}
			} catch {
				// Never break the engine path-change flow; zero-cost when no store.
			}
		},

		async onTurnEnd(): Promise<void> {
			try {
				const messages = host?.getTurnMessages() ?? [];
				const worldTs = store.getWorldTime();
				const sessionId = host?.getSessionInfo().sessionId;
				// §15.3 + §22 fix: ONE pass in the original message order —
				// user/assistant and captured custom messages interleave exactly
				// as they happened. Each row uses its OWN entry timestamp as the
				// wall clock (§12 fix); new rows get the current world clock.
				const rows: RawEntry[] = [];
				if (sessionId) {
					for (const m of messages) {
						if (m.customType && !shouldCaptureCustomType(m.customType, m.display ?? false, rawLogCustomTypes)) {
							continue;
						}
						rows.push(toRawEntry(m, sessionId, worldTs));
					}
				}
				if (rows.length > 0) store.appendRaw(rows);
				// Phase 3: autoretain firing (§5) + TEMP threshold check (§7),
				// after the raw_log write so the window includes this turn.
				if (!disposed) await handleAutoretainAndTemp();
			} catch {
				// raw_log failures never fail the turn.
			}
		},

		dispose(): void {
			disposed = true;
			recallAbort?.abort();
			recallAbort = undefined;
			autoretainAbort.abort();
		},
	};
}
