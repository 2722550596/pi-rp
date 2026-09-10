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
 * - onLeafChange(): rollback coupling — auto-node anchor visibility recompute
 *   + raw_log reconciliation (§8: physical delete of rows whose entry_id left
 *   the active path). Engine calls this directly at the tail of
 *   _moveLeafAndRestoreState; fire-and-forget, never throws.
 * - onTurnEnd(): raw_log batch append for this turn (§4/§15.3). Engine calls
 *   this directly after the turn_end extension emit — do NOT also subscribe
 *   to turn_end via host.on (double write).
 *
 * packages/memory never imports coding-agent: the host is a minimal
 * structural interface the engine satisfies.
 */
import { createHash } from "node:crypto";
import {
	type AutoretainTask,
	DEFAULT_AUTORETAIN_EVERY_N_TURNS,
	DEFAULT_AUTORETAIN_TASKS,
	dueTasks,
	runAutoretainTask,
} from "./autoretain.ts";
import type { MemorySettings } from "./config.ts";
import { createMemorySlots, type MemorySlotDefinition } from "./slots.ts";
import type { MemoryNode, MemoryStore } from "./store.ts";
import { checkTempThreshold, countActiveTempNodes, DEFAULT_TEMP_THRESHOLD, RP_NOTIFY_TYPE } from "./temp-notify.ts";
import { tokenizeForMatch } from "./tokenize.ts";
import { createMemoryTools } from "./tools.ts";

// ── Host interface (structural mirror of the coding-agent ExtensionAPI) ─────

/** Live session facts the module reads per prompt / per hook. */
export interface MemoryModuleSessionInfo {
	modelId?: string;
	leafId?: string | null;
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
	/** Live session info (model id, current leaf). */
	getSessionInfo(): MemoryModuleSessionInfo;
	/** Active-path snapshot (engine rebuilds from SessionManager per call). */
	getBranchSnapshot(): MemoryBranchSnapshot;
	/** This turn's new messages for raw_log (engine reads the branch tail). */
	getTurnMessages(): MemoryTurnMessage[];
	/**
	 * System→role directed message (§7 notify primitive): display:false +
	 * triggerTurn custom message, compaction-excluded by the type policy.
	 */
	sendCustomMessage(message: { customType: string; content: string; display: false; details?: unknown }): void;
	/**
	 * One-shot side LLM request outside the main loop (§5 autoretain engine;
	 * engine implementation: completeSideRequest — gateway attribution +
	 * session-scoped abort).
	 */
	completeSideRequest?(prompt: string): Promise<string>;
}

export interface MemoryModuleOptions {
	/** memory.* settings (§15.3 switches, §9 recall params). */
	settings?: MemorySettings;
}

export interface MemoryModule {
	/** Register tools/slot/customType/hooks onto the session host. */
	registerSession(host: MemoryModuleHost): void;
	/** Rollback coupling (§8): anchor visibility recompute + raw_log reconciliation. */
	onLeafChange(): Promise<void>;
	/** raw_log write-through (§4/§15.3): append this turn's messages. */
	onTurnEnd(): Promise<void>;
}

// ── Recall tuning (port of nocturne-memory-recall.ts 92-114; §9 fixed) ──────

export const RECALL_TOP_K = 3;
export const RECALL_MIN_SCORE = 0.35;
/** Anchor threshold: only the top item earns "高度相关" above this absolute score. */
export const RECALL_HIGH_CONFIDENCE = 0.55;
/** doc-coverage keyword normalization alignment gain. */
const DOC_COVERAGE_GAIN = 1.4;
const MAX_SUMMARY_LEN = 80;
/** World-clock recency boost tiers (days delta → boost). */
const RECENCY_TIERS: Array<{ max: number; boost: number }> = [
	{ max: 7, boost: 0.08 },
	{ max: 30, boost: 0.04 },
	{ max: 90, boost: 0.02 },
];
const W_VECTOR = 0.55;
const W_KEYWORD = 0.3;
const W_PRIORITY = 0.15;
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
	mode: "keyword";
}

interface RecalledItem {
	uri: string;
	disclosure: string | null;
	summary: string;
	/** Full body: the dedup hash is version-sensitive. */
	content: string;
	score: number;
	kw: number;
}

function md5(text: string): string {
	return createHash("md5").update(text, "utf-8").digest("hex");
}

/** Flatten line breaks and take the first MAX_SUMMARY_LEN chars. */
function summarize(content: string): string {
	const flat = content.replace(/\r?\n+/g, " ").trim();
	return flat.length > MAX_SUMMARY_LEN ? `${flat.slice(0, MAX_SUMMARY_LEN)}……` : flat;
}

function toEpochDays(ts: string | null): number | null {
	if (!ts) return null;
	const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ts);
	if (!m) return null;
	return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000);
}

function priorityScore(priority: number): number {
	// 0 = most important → 1.0; 10 = trivia → 0.0.
	const p = Math.min(Math.max(priority, 0), 10);
	return 1 - p / 10;
}

function recencyBoost(docTs: string | null, nowDays: number): number {
	const days = toEpochDays(docTs);
	if (days == null) return 0;
	const delta = nowDays - days;
	if (delta < 0) return 0.08; // future-dated entries get the recent-tier boost
	for (const tier of RECENCY_TIERS) {
		if (delta <= tier.max) return tier.boost;
	}
	return 0;
}

function keywordScore(queryTokens: string[], doc: MemoryNode): number {
	if (queryTokens.length === 0) return 0;
	const docTokens = tokenizeForMatch(`${doc.uri} ${doc.disclosure ?? ""} ${doc.content}`);
	const docTokenSet = new Set(docTokens);
	let hits = 0;
	for (const t of queryTokens) if (docTokenSet.has(t)) hits++;
	let covered = 0;
	for (const t of docTokenSet) if (queryTokens.includes(t)) covered++;
	const byQuery = hits / queryTokens.length;
	const byDoc = docTokens.length > 0 ? Math.min(1, (covered / docTokens.length) * DOC_COVERAGE_GAIN) : 0;
	return Math.max(byQuery, byDoc);
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
	const blocklist = recallCfg.blocklist ?? DEFAULT_DOMAIN_BLOCKLIST;
	const rawLogCustomTypes = settings.rawLog?.customTypes ?? "all-display-true";
	const tempThreshold = settings.temp?.threshold ?? DEFAULT_TEMP_THRESHOLD;
	// §5 task registry: core defaults, downstream may register/override.
	// memory.autoretain.everyNTurns (§9) seeds the cadence of the CORE DEFAULT
	// tasks only (matched by name) — user-registered tasks always keep the
	// cadence they pinned, even when it happens to equal the default (4).
	const coreDefaultNames = new Set(DEFAULT_AUTORETAIN_TASKS.map((t) => t.name));
	const autoretainTasks: AutoretainTask[] = [...(settings.autoretain?.tasks ?? DEFAULT_AUTORETAIN_TASKS)].map((t) =>
		coreDefaultNames.has(t.name) && settings.autoretain?.everyNTurns
			? { ...t, everyNTurns: settings.autoretain.everyNTurns }
			: t,
	);
	// §5: multiple tasks share ONE turn counter.
	let autoretainTurnCounter = 0;
	// §7 hysteresis: do not re-notify until the zone was cleaned below threshold.
	let tempNotified = false;

	// auto nodes hidden by rollback — recomputed on every prompt / leaf change.
	let hiddenAutoNodeIds = new Set<string>();

	function getAwakenUriSet(): Set<string> {
		try {
			const raw = store.getKv("awaken_uris");
			const list = raw ? (JSON.parse(raw) as unknown) : [];
			return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : []);
		} catch {
			return new Set<string>();
		}
	}

	/** Visibility predicate (§8): auto nodes hidden when the anchor left the path. */
	function isVisible(node: MemoryNode): boolean {
		if (node.source !== "auto") return true;
		return !hiddenAutoNodeIds.has(node.node_id);
	}

	/**
	 * Anchor visibility recompute (§8): an auto node whose anchor_entry_id is
	 * not on the current active path becomes hidden; manual/import nodes never
	 * hide. Pure data recompute — rows stay, switching back revives the node.
	 */
	function recomputeAnchorVisibility(entryIds: string[]): Set<string> {
		const active = new Set(entryIds);
		const hidden = new Set<string>();
		for (const node of store.listNodes()) {
			if (node.source !== "auto") continue;
			if (!node.anchor_entry_id || !active.has(node.anchor_entry_id)) hidden.add(node.node_id);
		}
		return hidden;
	}

	/**
	 * Hybrid recall over the tree pool (function-level port of
	 * nocturne-memory-recall.ts recall() 554-681, keyword mode: the pure
	 * package carries no embedding client; the §9 weight blend is preserved
	 * with the vector weight folded into keyword so the score scale — and
	 * with it MIN_SCORE / HIGH_CONFIDENCE — stays comparable).
	 */
	function recallForQueries(queries: string[]): { items: RecalledItem[]; mode: "keyword" } {
		if (queries.length === 0) return { items: [], mode: "keyword" };
		const blockSet = new Set(blocklist);
		const nowDays = toEpochDays(store.getWorldTime() ?? new Date().toISOString().slice(0, 10)) ?? 0;
		// Deduplicate docs by uri; blocked domains drop first; boot/awaken uris
		// already live in the preset slot and are excluded from injection (§9);
		// TEMP is NOT blocklisted (§9: dynamic zone stays recalleable).
		const byUri = new Map<string, MemoryNode>();
		for (const node of store.listNodes()) {
			if (node.is_stub) continue;
			if (blockSet.has(node.domain)) continue;
			if (!isVisible(node)) continue;
			if (byUri.has(node.uri)) continue;
			byUri.set(node.uri, node);
		}
		const awakenUris = getAwakenUriSet();
		const pool: MemoryNode[] = [];
		for (const [uri, node] of byUri) {
			if (awakenUris.has(uri)) continue;
			pool.push(node);
		}
		if (pool.length === 0) return { items: [], mode: "keyword" };

		const queryTokensList = queries.map(tokenizeForMatch);
		const scored: RecalledItem[] = pool.map((doc) => {
			let kw = 0;
			for (const qTokens of queryTokensList) {
				const k = keywordScore(qTokens, doc);
				if (k > kw) kw = k;
			}
			const prio = priorityScore(doc.priority);
			let score = (W_VECTOR + W_KEYWORD) * kw + W_PRIORITY * prio;
			score += recencyBoost(doc.world_ts, nowDays);
			return {
				uri: doc.uri,
				disclosure: doc.disclosure,
				summary: summarize(doc.content),
				content: doc.content,
				score,
				kw,
			};
		});
		scored.sort((a, b) => b.score - a.score);
		const items = scored
			.filter((s) => s.score >= minScore)
			// Keyword mode: require at least one query-term hit, otherwise the
			// score can be gamed by priority alone (no semantic signal).
			.filter((s) => s.kw > 0)
			.slice(0, topK);
		return { items, mode: "keyword" };
	}

	/** before_agent_start handler: dual-query recall + dedup + injection. */
	function handleBeforeAgentStart(event: unknown): { message: Record<string, unknown> } | undefined {
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

		const { items, mode } = recallForQueries(queries);
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

	// Current host binding — refreshed by registerSession on every reload.
	let host: MemoryModuleHost | undefined;

	/**
	 * Phase 3 turn-end extensions (called from onTurnEnd after the raw_log
	 * write): autoretain task firing (§5) + TEMP threshold check (§7).
	 */
	async function handleAutoretainAndTemp(): Promise<void> {
		// ── autoretain (§5): shared turn counter, per-task cadence ──────────
		autoretainTurnCounter++;
		const due = dueTasks(autoretainTasks, autoretainTurnCounter);
		// 纪要窗口从 raw_log 取（§9 compaction 交互）：上次已消费 raw_id 之后
		// 的新增行（游标存 kv，跨触发不重叠；窗口上限 AUTORETAIN_WINDOW_ROWS）。
		const lastProcessed = Number(store.getKv("autoretain_last_raw_id") ?? "0") || 0;
		const maxRowRow = store.db.prepare("SELECT MAX(raw_id) AS m FROM raw_log").get() as
			| { m: number | null }
			| undefined;
		const maxRow = maxRowRow?.m ?? null;
		for (const task of due) {
			if (maxRow === null || maxRow <= lastProcessed) continue;
			const window = store.listRaw(lastProcessed + 1, Math.min(maxRow, lastProcessed + AUTORETAIN_WINDOW_ROWS));
			if (window.length === 0) continue;
			if (!host?.completeSideRequest) continue; // no side-request primitive → silently skip
			const outcome = await runAutoretainTask(store, task, window, {
				completeSideRequest: host.completeSideRequest,
				getSessionInfo: () => host?.getSessionInfo() ?? {},
			});
			if (outcome.ok) {
				// Only advance the cursor on success — failures retry the same
				// window next round (docs §5 失败静默跳过).
				const last = window[window.length - 1];
				store.setKv("autoretain_last_raw_id", String(last ? last.raw_id : lastProcessed));
			}
			// §12 audit: failures are recorded too — silent skips must stay
			// discoverable (cheap-model JSON contract violations, etc.).
			store.logAudit("autoretain_task", {
				details: outcome.ok ? `${task.name} ok` : `${task.name} failed: ${outcome.error ?? "unknown"}`,
			});
		}

		// ── TEMP dynamic zone (§7): threshold check after write paths ───────
		const isVisible = (node: { source: string; node_id: string }): boolean =>
			node.source !== "auto" || !hiddenAutoNodeIds.has(node.node_id);
		if (countActiveTempNodes(store, isVisible) < tempThreshold) {
			tempNotified = false; // cleaned below threshold — re-arm
			return;
		}
		if (tempNotified) return;
		const notify = checkTempThreshold(store, { threshold: tempThreshold, isVisible });
		if (notify) {
			tempNotified = true;
			host?.sendCustomMessage(notify);
		}
	}

	return {
		registerSession(newHost: MemoryModuleHost): void {
			host = newHost;
			// 1. Tools (12) — provenance (model id / leaf id) is read lazily at
			// execute time via host.getSessionInfo(), so signatures stay live
			// across turns without re-registering.
			const toolCtx = {
				get modelId() {
					return host?.getSessionInfo().modelId;
				},
				get leafId() {
					return host?.getSessionInfo().leafId ?? null;
				},
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
			// custom slots.
			for (const slot of createMemorySlots(store)) {
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
				// ① anchor visibility recompute (§8 ①)
				hiddenAutoNodeIds = recomputeAnchorVisibility(snapshot ? snapshot.entryIds : []);
				// ② raw_log reconciliation (§8 ②): physical delete of rows whose
				// entry_id left the active path. buildContextEntries()-derived ids
				// are the single source of truth (§16 risk table). No snapshot
				// capability → skip reconciliation (empty path would wipe the log).
				if (snapshot) store.reconcileRawLog(snapshot.entryIds);
			} catch {
				// Never break the engine path-change flow; zero-cost when no store.
			}
		},

		async onTurnEnd(): Promise<void> {
			try {
				const messages = host?.getTurnMessages() ?? [];
				const worldTs = store.getWorldTime();
				// §15.3: custom messages are captured only per the three-way
				// switch; user/assistant messages always append (§4 mirror).
				const rows = messages
					.filter((m) => !m.customType)
					.map((m) => ({
						role: m.role,
						text: m.text,
						entry_id: m.entryId,
						wall_ts: new Date().toISOString(),
						world_ts: worldTs,
					}));
				const captured = messages
					.filter(
						(m) => m.customType && shouldCaptureCustomType(m.customType, m.display ?? false, rawLogCustomTypes),
					)
					.map((m) => ({
						// Captured custom messages land as their own rows (role = customType).
						role: m.customType as string,
						text: m.text,
						entry_id: m.entryId,
						wall_ts: new Date().toISOString(),
						world_ts: worldTs,
					}));
				if (rows.length + captured.length > 0) store.appendRaw([...rows, ...captured]);
				// Phase 3: autoretain firing (§5) + TEMP threshold check (§7),
				// after the raw_log write so the window includes this turn.
				await handleAutoretainAndTemp();
			} catch {
				// raw_log failures never fail the turn.
			}
		},
	};
}
