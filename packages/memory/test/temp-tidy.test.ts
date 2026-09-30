/**
 * temp-tidy suite — TidyRunner + 触发接线 + 导航缺陷修复 N1-N4 + 提示词契约.
 *
 * 用例清单：docs/design/temp-autotidy/01-memory侧-TidyRunner与触发.md §9
 * （LLM mock = scriptable StreamFn 注入 runTidy 的 sideStreamFn seam）；
 * 导航修复 = 契约 §2.9 修订 v2 / 01 §3.4；提示词 = 03 §9 包内单测。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, type Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type MemoryDatabase, openDatabase } from "../src/driver.ts";
import { createMemoryModule, type MemoryModuleHost } from "../src/module.ts";
import { createSchema } from "../src/schema.ts";
import { MemoryStore } from "../src/store.ts";
import { countActiveTempNodes, listActiveTempRows, TEMP_TIDY_GUIDE_LINES } from "../src/temp-notify.ts";
import {
	buildTidyFailureContent,
	extractBriefing,
	parseAutoTidySettings,
	readTidyLock,
	refreshTidyLock,
	releaseTidyLock,
	renderTempList,
	runTidy,
	TIDY_HEARTBEAT_MS,
	TIDY_LAST_FINISH_KEY,
	TIDY_LOCK_KEY,
	TIDY_LOCK_STALE_MS,
	TIDY_TEMP_LIST_MAX_ENTRIES,
	type TidyHost,
	type TidyOutcome,
	type TidyRunnerOptions,
	truncateBriefing,
	tryAcquireTidyLock,
} from "../src/temp-tidy.ts";
import { DEFAULT_TIDY_SYSTEM_PROMPT, DEFAULT_TIDY_TASK_TEMPLATE, renderTidyTaskPrompt } from "../src/tidy-prompts.ts";
import { createMemoryTools, type MemoryToolContext } from "../src/tools.ts";

let db: MemoryDatabase;
let store: MemoryStore;

beforeEach(async () => {
	db = await openDatabase(":memory:");
	createSchema(db);
	store = new MemoryStore(db);
});

afterEach(() => {
	db.close();
});

// ── Scripted LLM (01 §9.1 — StreamFn 注入点即 seam) ─────────────────────────

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createModel(): Model<"openai-responses"> {
	return {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function assistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

function textMessage(text: string): AssistantMessage {
	return assistantMessage([{ type: "text", text }]);
}

function toolCallMessage(name: string, args: Record<string, unknown>): AssistantMessage {
	return assistantMessage([{ type: "toolCall", id: `call-${name}`, name, arguments: args }], "toolUse");
}

interface SideCapture {
	model: unknown;
	context: { systemPrompt: string; messages: Array<{ role: string; content: unknown }> };
}

/** 每次调用吐出脚本的下一条 assistant 消息；脚本耗尽时兜一条空操作简报。 */
function scriptedStreamFn(steps: AssistantMessage[], captures?: SideCapture[]): StreamFn {
	return (model, context) => {
		captures?.push({ model, context: context as SideCapture["context"] });
		const stream = new MockAssistantStream();
		const message = steps.shift() ?? textMessage("TEMP 为空，无操作。");
		queueMicrotask(() => {
			stream.push({ type: "start", partial: message });
			if (message.stopReason === "toolUse" || message.stopReason === "stop" || message.stopReason === "length") {
				stream.push({ type: "done", reason: message.stopReason, message });
			} else {
				stream.push({
					type: "error",
					reason: message.stopReason === "aborted" ? "aborted" : "error",
					error: message,
				});
			}
		});
		return stream;
	};
}

/** 挂起流：start 后不产出，直到 options.signal 中止（真 provider 的 abort 语义，
 * 含"调用时已中止"的入口检查——否则在已中止信号上挂 listener 永远不会触发）。 */
function hangingStreamFn(captures?: SideCapture[]): StreamFn {
	return (model, context, options) => {
		captures?.push({ model, context: context as SideCapture["context"] });
		const stream = new MockAssistantStream();
		const pending = assistantMessage([]);
		const aborted = (): void => {
			stream.push({ type: "error", reason: "aborted", error: { ...pending, stopReason: "aborted" } });
		};
		queueMicrotask(() => stream.push({ type: "start", partial: pending }));
		if (options?.signal?.aborted) {
			aborted();
			return stream;
		}
		options?.signal?.addEventListener("abort", aborted, { once: true });
		return stream;
	};
}

// ── Host stubs ───────────────────────────────────────────────────────────────

interface SentMessage {
	message: { customType: string; content: string; display: false; details?: unknown };
	options?: { triggerTurn?: boolean };
}

function createTidyHost(
	streamFn: StreamFn,
	opts: { rejectSide?: unknown; overrides?: { systemPrompt?: string; taskPrompt?: string } } = {},
): { host: TidyHost; sent: SentMessage[]; sideCalls: Array<{ modelRef?: string }> } {
	const sent: SentMessage[] = [];
	const sideCalls: Array<{ modelRef?: string }> = [];
	const host: TidyHost = {
		sideStreamFn: async (options) => {
			sideCalls.push({ modelRef: options.modelRef });
			if (opts.rejectSide !== undefined) throw opts.rejectSide;
			return { streamFn, model: createModel() };
		},
		sendCustomMessage: (message, options) => {
			sent.push({ message, options });
		},
	};
	void opts.overrides;
	return { host, sent, sideCalls };
}

const BASE_RUN: Pick<TidyRunnerOptions, "maxTurns" | "timeoutMs"> = { maxTurns: 30, timeoutMs: 600_000 };

async function runScripted(
	steps: AssistantMessage[],
	opts: Partial<TidyRunnerOptions> & { rejectSide?: unknown } = {},
): Promise<{
	outcome: TidyOutcome;
	sent: SentMessage[];
	captures: SideCapture[];
	sideCalls: Array<{ modelRef?: string }>;
}> {
	const captures: SideCapture[] = [];
	const { host, sent, sideCalls } = createTidyHost(scriptedStreamFn(steps, captures), { rejectSide: opts.rejectSide });
	const lock = tryAcquireTidyLock(store, "session-1");
	expect(lock).not.toBeNull();
	const outcome = await runTidy({
		store,
		host,
		systemPrompt: "SYS-PROMPT",
		taskTemplate: "TASK\n{temp_list}\n轮数：{max_turns}",
		...BASE_RUN,
		...opts,
	});
	return { outcome, sent, captures, sideCalls };
}

// ── 互斥锁（01 §9.2 互斥组） ─────────────────────────────────────────────────

describe("tidy lock (契约 §2.7)", () => {
	it("acquires on an empty store, refuses doubles, releases for re-acquire", () => {
		const first = tryAcquireTidyLock(store, "s1");
		expect(first).not.toBeNull();
		expect(tryAcquireTidyLock(store, "s2")).toBeNull();
		const held = readTidyLock(store);
		expect(held?.pid).toBe(process.pid);
		expect(held?.sessionHint).toBe("s1");
		releaseTidyLock(store, first!.owner);
		expect(readTidyLock(store)).toBeNull();
		expect(tryAcquireTidyLock(store)).not.toBeNull();
	});

	it("reclaims a stale lock (heartbeatAt older than the stale threshold)", () => {
		const first = tryAcquireTidyLock(store);
		expect(first).not.toBeNull();
		const stale = new Date(Date.now() - TIDY_LOCK_STALE_MS - 60_000).toISOString();
		const row = readTidyLock(store)!;
		store.setKv(TIDY_LOCK_KEY, JSON.stringify({ ...row, heartbeatAt: stale }));
		const second = tryAcquireTidyLock(store, "s2");
		// Takeover proven by the new hint + fresh heartbeat (startedAt may tie within the same ms).
		expect(second).not.toBeNull();
		expect(readTidyLock(store)?.sessionHint).toBe("s2");
		expect(readTidyLock(store)!.heartbeatAt >= stale).toBe(true);
	});

	it("fencing: a foreign owner cannot refresh or release", () => {
		const mine = tryAcquireTidyLock(store);
		const foreign = { pid: process.pid + 9999, startedAt: new Date().toISOString() };
		expect(refreshTidyLock(store, foreign)).toBe(false);
		releaseTidyLock(store, foreign);
		expect(readTidyLock(store)).not.toBeNull();
		const before = readTidyLock(store);
		expect(refreshTidyLock(store, mine!.owner)).toBe(true);
		expect(readTidyLock(store)!.heartbeatAt >= before!.heartbeatAt).toBe(true);
		// Fenced refresh also survives a mid-beat steal: value CAS.
		const stolen = JSON.stringify({ ...readTidyLock(store)!, pid: 1, startedAt: "2020-01-01T00:00:00.000Z" });
		store.setKv(TIDY_LOCK_KEY, stolen);
		expect(refreshTidyLock(store, mine!.owner)).toBe(false);
	});

	it("dirty lock rows are never stolen (§6.2 已知接受)", () => {
		store.setKv(TIDY_LOCK_KEY, "not-json{");
		expect(tryAcquireTidyLock(store)).toBeNull();
		expect(readTidyLock(store)).toBeNull(); // unreadable shape reads as null
	});

	it("two connections on one WAL file: exactly one winner", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tidy-lock-"));
		try {
			const path = join(dir, "mem.db");
			const dbA = await openDatabase(path);
			createSchema(dbA);
			const storeA = new MemoryStore(dbA);
			const dbB = await openDatabase(path);
			const storeB = new MemoryStore(dbB);
			const a = tryAcquireTidyLock(storeA, "A");
			expect(a).not.toBeNull();
			expect(tryAcquireTidyLock(storeB, "B")).toBeNull();
			releaseTidyLock(storeA, a!.owner);
			const b = tryAcquireTidyLock(storeB, "B");
			expect(b).not.toBeNull();
			dbA.close();
			dbB.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ── 配置解析（01 §2.3 字段级容错表） ─────────────────────────────────────────

describe("parseAutoTidySettings", () => {
	it("defaults: enabled true, main model, 30 turns, 10min timeout", () => {
		expect(parseAutoTidySettings(undefined)).toEqual({
			enabled: true,
			modelRef: undefined,
			maxTurns: 30,
			timeoutMs: 600_000,
		});
	});
	it("field-level tolerance: illegal values fall back per field", () => {
		expect(parseAutoTidySettings({ maxTurns: -5 })).toMatchObject({ maxTurns: 30 });
		expect(parseAutoTidySettings({ maxTurns: 201 })).toMatchObject({ maxTurns: 30 });
		expect(parseAutoTidySettings({ maxTurns: 3.5 })).toMatchObject({ maxTurns: 30 });
		expect(parseAutoTidySettings({ timeoutMs: 999 })).toMatchObject({ timeoutMs: 600_000 });
		expect(parseAutoTidySettings({ timeoutMs: 5000 })).toMatchObject({ timeoutMs: 5000 });
		expect(parseAutoTidySettings({ model: 42 as unknown as string })).toMatchObject({ modelRef: undefined });
		expect(parseAutoTidySettings({ model: "   " })).toMatchObject({ modelRef: undefined });
		expect(parseAutoTidySettings({ enabled: 0 as unknown as boolean })).toMatchObject({ enabled: true });
		expect(parseAutoTidySettings({ enabled: false, model: "p/m", maxTurns: 5, timeoutMs: 60_000 })).toEqual({
			enabled: false,
			modelRef: "p/m",
			maxTurns: 5,
			timeoutMs: 60_000,
		});
	});
});

// ── {temp_list} 直出与简报裁剪（01 §3.5 / §3.3） ─────────────────────────────

describe("renderTempList / truncateBriefing / buildTidyFailureContent", () => {
	it("renders one line per active row, uri-ordered, 全库口径 (J1)", () => {
		store.put({ uri: "TEMP://b", content: "草稿乙" });
		store.put({ uri: "TEMP://a/note", content: "草稿甲" });
		store.put({ uri: "TEMP://a/note", content: "改写" }); // dedupe by uri
		const rows = listActiveTempRows(store);
		const list = renderTempList(rows);
		expect(list).toBe("- TEMP://a/note（manual）改写\n- TEMP://b（manual）草稿乙");
	});

	it("renders （空） for an empty zone and truncates beyond the entry cap", () => {
		expect(renderTempList([])).toBe("（空）");
		const rows = Array.from({ length: TIDY_TEMP_LIST_MAX_ENTRIES + 3 }, (_, i) => ({
			node_id: `n${i}`,
			uri: `TEMP://d-${String(i).padStart(3, "0")}`,
			source: "manual",
			content: "c",
			world_ts: null,
		}));
		const list = renderTempList(rows);
		expect(list.split("\n")).toHaveLength(TIDY_TEMP_LIST_MAX_ENTRIES + 1);
		expect(list.endsWith("…另有 3 条")).toBe(true);
	});

	it("truncates by code points and gives the receiving agent an exact audit lookup", () => {
		const briefing = `${"a".repeat(499)}😀${"b".repeat(99)}`;
		expect([...briefing].length).toBe(599);
		const cut = truncateBriefing(briefing, 500, 42);
		const body = cut.slice(0, cut.lastIndexOf("\n"));
		expect([...body]).toHaveLength(500);
		expect(body.endsWith("😀")).toBe(true);
		expect(cut).toContain('recall(uri="MEM://audit/id/42")');
		expect(truncateBriefing("短简报")).toBe("短简报");
	});

	it("failure content carries the reason, count, threshold and shared guide lines", () => {
		const content = buildTidyFailureContent("max-turns", 7, 10);
		expect(content).toContain("自动整理（temp-tidy）未能完成（原因：轮数用尽）");
		expect(content).toContain("TEMP 现有 7 条草稿（阈值 10）");
		for (const line of TEMP_TIDY_GUIDE_LINES) expect(content).toContain(line);
	});
});

// ── TidyRunner（01 §9.2 runner 组） ──────────────────────────────────────────

describe("runTidy", () => {
	it("happy path: tools run under the tidy identity, briefing delivered without waking the role", async () => {
		store.put({ uri: "TEMP://draft-1", content: "旧草稿", source: "manual" });
		const { outcome, sent, captures } = await runScripted([
			toolCallMessage("memorize", { uri: "core://tidied-note", content: "归位后的内容" }),
			toolCallMessage("forget", { target: "TEMP://draft-1" }),
			textMessage("TEMP 整理：2 条草稿 → 归位 1、删除 1、未处理 0；TEMP 余 0。"),
		]);
		expect(outcome).toEqual({
			status: "completed",
			briefing: "TEMP 整理：2 条草稿 → 归位 1、删除 1、未处理 0；TEMP 余 0。",
			turnCount: 3,
		});
		// 工具真跑：落节点带 tidy 署名、无会话锚（契约 §2.5）。
		const node = store.resolveUri("core://tidied-note");
		expect(node?.model).toBe("temp-tidy");
		expect(node?.anchor_session_id).toBeNull();
		expect(node?.anchor_entry_id).toBeNull();
		expect(store.resolveUri("TEMP://draft-1")).toBeNull();
		// 审计链：insert_node 落账（store 惯例：insert 行不写 model 列——署名在节点行
		// 与修订史，上方已断言）→ temp_tidy_complete（全文简报 + beforeCount）。
		const insert = store.listAudit(50).find((a) => a.event === "insert_node");
		expect(insert?.node_id).toBe(node?.node_id);
		expect(insert?.turn ?? null).toBeNull();
		const complete = store.listAudit(50).find((a) => a.event === "temp_tidy_complete");
		const completeDetails = JSON.parse(complete?.details ?? "{}") as {
			briefing: string;
			beforeCount: number;
			afterCount?: number;
		};
		expect(completeDetails.briefing).toBe(outcome.status === "completed" ? outcome.briefing : "");
		expect(completeDetails.beforeCount).toBe(1);
		// 收尾：锁释放、last-finish 落盘。
		expect(readTidyLock(store)).toBeNull();
		expect(Number.isNaN(Date.parse(store.getKv(TIDY_LAST_FINISH_KEY) ?? ""))).toBe(false);
		// 投递：rp-notify + triggerTurn:false（D9）+ afterCount 重数。
		expect(sent).toHaveLength(1);
		expect(sent[0]?.message.customType).toBe("rp-notify");
		expect(sent[0]?.message.display).toBe(false);
		expect(sent[0]?.options).toEqual({ triggerTurn: false });
		expect(sent[0]?.message.details).toMatchObject({
			kind: "temp-tidy-report",
			model: "session-default",
			turnCount: 3,
			beforeCount: 1,
			afterCount: 0,
		});
		// 渲染面：首条 user 消息 = 渲染后的任务书（变量已替换）。
		const firstPrompt = captures[0]?.context.messages[0] as { role: string; content: Array<{ text?: string }> };
		const promptText = JSON.stringify(firstPrompt.content);
		expect(promptText).toContain("TEMP://draft-1");
		expect(promptText).not.toContain("{temp_list}");
		expect(promptText).toContain("轮数：30");
	});

	it("max-turns cutoff wins over trailing text (capped 优先于文本判定)", async () => {
		store.put({ uri: "TEMP://draft-1", content: "旧草稿" });
		const { outcome, sent } = await runScripted(
			[toolCallMessage("memorize", { uri: "core://x", content: "c" }), textMessage("TEMP 整理：都完成了。")],
			{ maxTurns: 1 },
		);
		expect(outcome).toMatchObject({ status: "failed", reason: "max-turns" });
		expect(sent).toHaveLength(1);
		expect(sent[0]?.message.details).toMatchObject({ kind: "temp-tidy-failure", reason: "max-turns" });
		expect(readTidyLock(store)).toBeNull();
	});

	it("timeout aborts a hanging stream and cleans up its timers", async () => {
		vi.useFakeTimers();
		try {
			const captures: SideCapture[] = [];
			const { host, sent } = createTidyHost(hangingStreamFn(captures));
			expect(tryAcquireTidyLock(store)).not.toBeNull();
			const pending = runTidy({ store, host, systemPrompt: "S", taskTemplate: "T", maxTurns: 30, timeoutMs: 50 });
			await vi.advanceTimersByTimeAsync(60);
			const outcome = await pending;
			expect(outcome).toMatchObject({ status: "failed", reason: "timeout" });
			expect(vi.getTimerCount()).toBe(0); // timeout + heartbeat 均已清理
			expect(sent[0]?.message.details).toMatchObject({ kind: "temp-tidy-failure", reason: "timeout" });
			expect(readTidyLock(store)).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it("pre-aborted parentSignal folds to aborted-dispose: no notify, no last-finish", async () => {
		const parent = new AbortController();
		parent.abort();
		const { host, sent } = createTidyHost(scriptedStreamFn([]));
		expect(tryAcquireTidyLock(store)).not.toBeNull();
		const outcome = await runTidy({
			store,
			host,
			systemPrompt: "S",
			taskTemplate: "T",
			maxTurns: 30,
			timeoutMs: 600_000,
			parentSignal: parent.signal,
		});
		expect(outcome).toMatchObject({ status: "failed", reason: "aborted-dispose" });
		expect(sent).toHaveLength(0);
		expect(store.getKv(TIDY_LAST_FINISH_KEY)).toBeNull();
		expect(readTidyLock(store)).toBeNull();
	});

	it("empty briefing fails WITHOUT look-back to earlier narration", async () => {
		store.put({ uri: "TEMP://draft-1", content: "c" });
		const { outcome, sent } = await runScripted([
			{
				...toolCallMessage("retrieve", { query: "x" }),
				content: [
					{ type: "toolCall", id: "c1", name: "retrieve", arguments: { query: "x" } },
					{ type: "text", text: "我先看看 TEMP 里有什么。" },
				],
			},
			textMessage(""),
		]);
		expect(outcome).toMatchObject({ status: "failed", reason: "empty-briefing" });
		expect(sent[0]?.message.details).toMatchObject({ kind: "temp-tidy-failure", reason: "empty-briefing" });
	});

	it("sideStreamFn rejection → no-model with fallback notify", async () => {
		const { outcome, sent } = await runScripted([], { rejectSide: new Error("模型解析失败") });
		expect(outcome).toMatchObject({ status: "failed", reason: "no-model" });
		expect(outcome.status === "failed" && outcome.error?.includes("模型解析失败")).toBe(true);
		expect(sent[0]?.message.details).toMatchObject({ kind: "temp-tidy-failure", reason: "no-model" });
		expect(readTidyLock(store)).toBeNull();
	});

	it("a truncated delivery points to the exact full briefing through the public recall tool", async () => {
		const long = "TEMP 整理：1 条草稿 → 删除 1、未处理 0；TEMP 余 0。";
		const briefing = long + "x".repeat(600);
		const { outcome, sent } = await runScripted([textMessage(briefing)]);
		expect(outcome).toMatchObject({ status: "completed" });
		const content = sent[0]?.message.content ?? "";
		expect([...content].length).toBeLessThan([...briefing].length);
		const auditUri = content.match(/MEM:\/\/audit\/id\/\d+/)?.[0];
		if (!auditUri) throw new Error(`截断通知没有可调用的精确审计 URI：${content}`);

		const recalled = await run("recall", { uri: auditUri });
		expect(recalled.text).toContain("temp_tidy_complete");
		expect(recalled.text).toContain(briefing);
	});

	it("lock already lost before start (foreign row) → silent yield, LLM untouched", async () => {
		store.setKv(
			TIDY_LOCK_KEY,
			JSON.stringify({ startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), pid: 999_999 }),
		);
		const captures: SideCapture[] = [];
		const { host, sent } = createTidyHost(scriptedStreamFn([], captures));
		const outcome = await runTidy({ store, host, systemPrompt: "S", taskTemplate: "T", ...BASE_RUN });
		// 入口即让路 = 契约 §2.7 抢锁失败静默语义（无通知）；他人在整理。
		expect(outcome).toMatchObject({ status: "failed", reason: "lock-lost" });
		expect(captures).toHaveLength(0);
		expect(sent).toHaveLength(0);
	});

	it("lock stolen mid-run (heartbeat fencing) → aborts and reports lock-lost", async () => {
		vi.useFakeTimers();
		try {
			const captures: SideCapture[] = [];
			const { host, sent } = createTidyHost(hangingStreamFn(captures));
			expect(tryAcquireTidyLock(store)).not.toBeNull();
			const pending = runTidy({ store, host, systemPrompt: "S", taskTemplate: "T", ...BASE_RUN });
			// 心跳前：他人回收僵死锁（把 heartbeatAt 回拨过僵死阈值后抢走）。
			await vi.advanceTimersByTimeAsync(TIDY_LOCK_STALE_MS + 1);
			store.setKv(
				TIDY_LOCK_KEY,
				JSON.stringify({ startedAt: "2020-01-01T00:00:00.000Z", heartbeatAt: new Date().toISOString(), pid: 1 }),
			);
			await vi.advanceTimersByTimeAsync(TIDY_HEARTBEAT_MS);
			const outcome = await pending;
			expect(outcome).toMatchObject({ status: "failed", reason: "lock-lost" });
			expect(captures).toHaveLength(1); // LLM 启动过，但被 fencing 中止
			// 运行中失败 → D1 兜底通知照发（R9）。
			expect(sent[0]?.message.details).toMatchObject({ kind: "temp-tidy-failure", reason: "lock-lost" });
		} finally {
			vi.useRealTimers();
		}
	});

	it("modelRef passes through to sideStreamFn and {temp_list} renders or is omitted per template", async () => {
		store.put({ uri: "TEMP://a", content: "甲" });
		const { sideCalls, captures } = await runScripted([textMessage("TEMP 为空，无操作。")], {
			modelRef: "prov/model-x",
		});
		expect(sideCalls[0]?.modelRef).toBe("prov/model-x");
		expect(JSON.stringify(captures[0]?.context.messages[0])).toContain("- TEMP://a（manual）甲");
		// 覆写模板不含 {temp_list}：不强插，audit 留痕 temp_list_in_task=false。
		const { host, sent } = createTidyHost(scriptedStreamFn([textMessage("TEMP 为空，无操作。")]));
		expect(tryAcquireTidyLock(store)).not.toBeNull();
		await runTidy({ store, host, systemPrompt: "S", taskTemplate: "无变量模板", ...BASE_RUN });
		const trigger = store.listAudit(50).find((a) => a.event === "temp_tidy_trigger");
		expect(trigger).toBeUndefined(); // trigger 行由 module 写，runner 直跑无此行
		expect(sent[0]?.message.content).toBe("TEMP 为空，无操作。");
	});
});

// ── 简报提取纯函数（01 §3.3 E1-E5 边界） ─────────────────────────────────────

describe("extractBriefing", () => {
	it("takes the LAST assistant message, joined text blocks, trimmed", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: "任务", timestamp: 1 },
			textMessage("中间叙述"),
			textMessage("第一行\n第二行 "),
		];
		expect(extractBriefing(messages, { capped: false })).toEqual({ ok: true, briefing: "第一行\n第二行" });
	});

	it("no assistant at all → empty-briefing", () => {
		expect(extractBriefing([{ role: "user", content: "x", timestamp: 1 }], { capped: false })).toMatchObject({
			ok: false,
			reason: "empty-briefing",
		});
	});

	it("capped beats text; non-stop reasons map to failures", () => {
		const withText = textMessage("看似简报");
		expect(extractBriefing([withText], { capped: true })).toMatchObject({ ok: false, reason: "max-turns" });
		expect(extractBriefing([{ ...withText, stopReason: "length" as const }], { capped: false })).toMatchObject({
			ok: false,
			reason: "error-stop",
		});
		expect(extractBriefing([{ ...withText, stopReason: "error" as const }], { capped: false })).toMatchObject({
			ok: false,
			reason: "error-stop",
		});
	});
});

// ── 触发接线（01 §3.1 T1-T5，走 createMemoryModule 全链路） ──────────────────

function createModuleHost(
	streamFn: StreamFn | undefined,
	opts: {
		rejectSide?: unknown;
		overrides?: { systemPrompt?: string; taskPrompt?: string };
		withoutSideStream?: boolean;
	} = {},
): { host: MemoryModuleHost; sent: SentMessage[] } {
	const sent: SentMessage[] = [];
	const host: MemoryModuleHost = {
		registerTool: () => {},
		registerSlot: () => {},
		registerCustomType: () => {},
		on: () => {},
		sendCustomMessage: (message, options) => {
			sent.push({ message, options });
		},
		getSessionInfo: () => ({ sessionId: "session-1", turn: 0 }),
		getBranchSnapshot: () => ({ entryIds: [], entries: [] }),
		getTurnMessages: () => [],
		getActiveBranchMessages: () => [],
		completeSideRequest: async () => "{}",
	};
	if (!opts.withoutSideStream) {
		host.sideStreamFn = async () => {
			if (opts.rejectSide !== undefined) throw opts.rejectSide;
			return {
				streamFn: (streamFn ?? scriptedStreamFn([textMessage("TEMP 为空，无操作。")])) as StreamFn,
				model: createModel(),
			};
		};
		host.getTempTidyPromptOverrides = () => opts.overrides;
	}
	return { host, sent };
}

async function seedToThreshold(n = 2): Promise<void> {
	for (let i = 1; i <= n; i++) store.put({ uri: `TEMP://draft-${i}`, content: `草稿${i}`, source: "manual" });
}

async function settle(check: () => void): Promise<void> {
	await vi.waitFor(check, { timeout: 2000, interval: 10 });
}

describe("autoTidy trigger wiring (module-level, default settings = tidy first)", () => {
	it("threshold hit → tidy runs, briefing delivered triggerTurn:false, generation owned", async () => {
		await seedToThreshold(2);
		const captures: SideCapture[] = [];
		const { host, sent } = createModuleHost(
			scriptedStreamFn(
				[
					toolCallMessage("forget", { target: "TEMP://draft-1" }),
					toolCallMessage("forget", { target: "TEMP://draft-2" }),
					textMessage("TEMP 整理：2 条草稿 → 删除 2、未处理 0；TEMP 余 0。"),
				],
				captures,
			),
		);
		const module = createMemoryModule(store, {
			settings: { temp: { threshold: 2 }, autoretain: { everyNTurns: 999 } },
		});
		module.registerSession(host);
		await module.onTurnEnd();
		await settle(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.message.details).toMatchObject({ kind: "temp-tidy-report" });
		expect(sent[0]?.options).toEqual({ triggerTurn: false });
		// 覆写 getter 未提供 → 内置默认 system prompt 原样生效。
		expect(captures[0]?.context.systemPrompt).toBe(DEFAULT_TIDY_SYSTEM_PROMPT);
		// 本代已归属：次轮不重触发。
		await module.onTurnEnd();
		expect(sent).toHaveLength(1);
		// tidy 完成清零后：count < threshold → re-arm（①分支正向）。
		await module.onTurnEnd();
		expect(countActiveTempNodes(store)).toBe(0);
		module.dispose();
	});

	it("prompt overrides are pulled fresh and blank fields fall back field-level", async () => {
		await seedToThreshold(2);
		const captures: SideCapture[] = [];
		const { host, sent } = createModuleHost(
			scriptedStreamFn([textMessage("TEMP 整理：2 条草稿 → 删除 2、未处理 0；TEMP 余 0。")], captures),
			{
				overrides: { systemPrompt: "OVR-SYS", taskPrompt: "OVR-TASK 底册：{temp_list}" },
			},
		);
		const module = createMemoryModule(store, { settings: { temp: { threshold: 2 } } });
		module.registerSession(host);
		await module.onTurnEnd();
		await settle(() => expect(sent).toHaveLength(1));
		expect(captures[0]?.context.systemPrompt).toBe("OVR-SYS");
		const prompt = JSON.stringify(captures[0]?.context.messages[0]);
		expect(prompt).toContain("OVR-TASK 底册：");
		expect(prompt).toContain("TEMP://draft-1");
		module.dispose();
	});

	it("T1 disabled → the legacy manual notify, byte-identical to pre-autoTidy (E9)", async () => {
		await seedToThreshold(2);
		const { host, sent } = createModuleHost(scriptedStreamFn([]));
		const module = createMemoryModule(store, {
			settings: { temp: { threshold: 2, autoTidy: { enabled: false } }, autoretain: { everyNTurns: 999 } },
		});
		module.registerSession(host);
		await module.onTurnEnd();
		expect(sent).toHaveLength(1);
		expect(sent[0]?.message.details).toMatchObject({ kind: "temp-notify" });
		expect(sent[0]?.message.content).toContain("TEMP 暂存区现有 2 条");
		expect(sent[0]?.options).toBeUndefined();
		module.dispose();
	});

	it("host without the side-stream primitive → D1 未配置 fallback to the manual notify", async () => {
		await seedToThreshold(2);
		const { host, sent } = createModuleHost(undefined, { withoutSideStream: true });
		const module = createMemoryModule(store, {
			settings: { temp: { threshold: 2 }, autoretain: { everyNTurns: 999 } },
		});
		module.registerSession(host);
		await module.onTurnEnd();
		expect(sent).toHaveLength(1);
		expect(sent[0]?.message.details).toMatchObject({ kind: "temp-notify" });
		module.dispose();
	});

	it("T4 foreign live lock → silent yield, stays armed, retries next turn", async () => {
		await seedToThreshold(2);
		store.setKv(
			TIDY_LOCK_KEY,
			JSON.stringify({ startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), pid: 999_999 }),
		);
		const captures: SideCapture[] = [];
		const { host, sent } = createModuleHost(scriptedStreamFn([], captures));
		const module = createMemoryModule(store, {
			settings: { temp: { threshold: 2 }, autoretain: { everyNTurns: 999 } },
		});
		module.registerSession(host);
		await module.onTurnEnd();
		expect(sent).toHaveLength(0);
		expect(captures).toHaveLength(0);
		// 让路会话保持武装：锁消失后下一轮自然接管（自愈）。
		store.db.prepare("DELETE FROM memory_kv WHERE key = ?").run(TIDY_LOCK_KEY);
		const takeoverCaptures: SideCapture[] = [];
		const takeover = createModuleHost(scriptedStreamFn([textMessage("TEMP 整理：接管。")], takeoverCaptures));
		module.registerSession(takeover.host);
		await module.onTurnEnd();
		await settle(() => expect(takeover.sent).toHaveLength(1));
		expect(takeover.sent[0]?.message.content).toBe("TEMP 整理：接管。");
		module.dispose();
	});

	it("T2 fresh last-finish → silent + generation owned (no re-trigger while cooling)", async () => {
		await seedToThreshold(2);
		store.setKv(TIDY_LAST_FINISH_KEY, new Date().toISOString());
		const captures: SideCapture[] = [];
		const { host, sent } = createModuleHost(scriptedStreamFn([], captures));
		const module = createMemoryModule(store, {
			settings: { temp: { threshold: 2 }, autoretain: { everyNTurns: 999 } },
		});
		module.registerSession(host);
		await module.onTurnEnd();
		expect(sent).toHaveLength(0);
		expect(captures).toHaveLength(0);
		await module.onTurnEnd(); // tempNotified 已置位 → 仍静默
		expect(sent).toHaveLength(0);
		module.dispose();
	});

	it("runner failure inside the module → D1 fallback notify (kind temp-tidy-failure)", async () => {
		await seedToThreshold(2);
		const { host, sent } = createModuleHost(undefined, { rejectSide: new Error("boom") });
		const module = createMemoryModule(store, {
			settings: { temp: { threshold: 2 }, autoretain: { everyNTurns: 999 } },
		});
		module.registerSession(host);
		await module.onTurnEnd();
		await settle(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.message.details).toMatchObject({ kind: "temp-tidy-failure", reason: "no-model" });
		expect(sent[0]?.message.content).toContain("自动整理（temp-tidy）未能完成");
		// trigger → failed 审计全链。
		const events = store.listAudit(50).map((a) => a.event);
		expect(events).toContain("temp_tidy_trigger");
		expect(events).toContain("temp_tidy_failed");
		module.dispose();
	});

	it("dispose aborts an in-flight tidy: aborted-dispose, no notify, no last-finish", async () => {
		await seedToThreshold(2);
		const { host, sent } = createModuleHost(hangingStreamFn());
		const module = createMemoryModule(store, {
			settings: { temp: { threshold: 2 }, autoretain: { everyNTurns: 999 } },
		});
		module.registerSession(host);
		await module.onTurnEnd();
		module.dispose(); // parentSignal.abort()
		await settle(() => expect(readTidyLock(store)).toBeNull());
		expect(sent).toHaveLength(0);
		expect(store.getKv(TIDY_LAST_FINISH_KEY)).toBeNull();
		const failed = store.listAudit(50).find((a) => a.event === "temp_tidy_failed");
		expect((JSON.parse(failed?.details ?? "{}") as { reason: string }).reason).toBe("aborted-dispose");
	});
});

// ── 导航缺陷修复（契约 §2.9 修订 v2 / 01 §3.4 N1-N4，全库通用语义） ────────────

function run(
	name: string,
	args: Record<string, unknown>,
	ctx: MemoryToolContext = {},
): Promise<{ text: string; details: Record<string, unknown> }> {
	const tool = createMemoryTools(store, ctx).find((t) => t.name === name);
	if (!tool) throw new Error(`tool ${name} missing`);
	return tool
		.execute("call-1", args)
		.then((r) => ({ text: r.content.map((c) => c.text).join(""), details: r.details }));
}

describe("N1 domain-root virtual view", () => {
	it("recall('TEMP://') lists top-level entries incl. stub categories, no access-time touch", async () => {
		store.put({ uri: "TEMP://scratch", content: "顶层便签" });
		store.put({ uri: "TEMP://cat/note-1", content: "嵌套草稿正文" });
		const r = await run("recall", { uri: "TEMP://" });
		expect(r.text).toContain("# [TEMP://]（域视图）");
		expect(r.text).toContain("- TEMP://scratch");
		expect(r.text).toContain("- TEMP://cat（类目）");
		// depth 0 = 顶层清单：嵌套草稿正文不渲染。
		expect(r.text).not.toContain("嵌套草稿正文");
		// 审计记 view:"domain"；浏览域不是"想起" → access time 不动。
		const audit = store.listAudit(5).find((a) => a.event === "recall");
		expect(audit?.details ?? "").toContain('"view":"domain"');
		expect(store.resolveUri("TEMP://scratch")?.last_accessed_at).toBeNull();
	});

	it("depth -1 renders the full domain register through stub categories", async () => {
		store.put({ uri: "TEMP://cat/note-1", content: "嵌套草稿正文" });
		store.put({ uri: "TEMP://cat/sub/leaf", content: "更深一层" });
		const r = await run("recall", { uri: "TEMP://", depth: -1 });
		expect(r.text).toContain("■ TEMP://cat（类目占位，无正文）");
		expect(r.text).toContain("TEMP://cat/note-1");
		expect(r.text).toContain("嵌套草稿正文");
		expect(r.text).toContain("更深一层");
	});

	it("an empty domain says so instead of 未找到记忆", async () => {
		const r = await run("recall", { uri: "TEMP://" });
		expect(r.text).toContain("（域 TEMP:// 下暂无记忆）");
	});
});

describe("N2 stub category recall renders its subtree", () => {
	it("replaces the early return with header + children and restores bookkeeping", async () => {
		store.put({ uri: "TEMP://cat/note-1", content: "草稿甲" });
		// depth 0（默认）= 直接子代 URI 清单（与普通节点语义一致）。
		const top = await run("recall", { uri: "TEMP://cat" });
		expect(top.text).toContain("# [TEMP://cat]（类目占位，无正文）");
		expect(top.text).toContain("- TEMP://cat/note-1");
		// depth -1 = 子树全文渲染。
		const r = await run("recall", { uri: "TEMP://cat", depth: -1 });
		expect(r.text).toContain("# [TEMP://cat]（类目占位，无正文）");
		expect(r.text).toContain("TEMP://cat/note-1");
		expect(r.text).toContain("草稿甲");
		const audit = store.listAudit(5).find((a) => a.event === "recall");
		expect(audit?.node_id).toBe(store.resolveUri("TEMP://cat")?.node_id);
		// 显式寻址子树 = "想起"：access time 恢复记账。
		expect(store.resolveUri("TEMP://cat/note-1")?.last_accessed_at).not.toBeNull();
	});

	it("nested stubs render their own subtrees at depth -1", async () => {
		store.put({ uri: "TEMP://cat/sub/leaf", content: "叶子" });
		const deep = await run("recall", { uri: "TEMP://cat", depth: -1 });
		expect(deep.text).toContain("■ TEMP://cat/sub（类目占位，无正文）");
		expect(deep.text).toContain("叶子");
	});
});

describe("N3 index view lists stub categories with child counts", () => {
	it("MEM://index/<domain> shows 类目 with direct non-stub child count; top-level rows unchanged", async () => {
		store.put({ uri: "TEMP://cat/note-1", content: "草稿甲" });
		store.put({ uri: "TEMP://cat/note-2", content: "草稿乙" });
		store.put({ uri: "TEMP://scratch", content: "顶层便签" });
		const r = await run("recall", { uri: "MEM://index/TEMP" });
		expect(r.text).toContain("■ TEMP://cat（类目，2 条）");
		expect(r.text).toContain("TEMP://scratch: 顶层便签");
	});
});

describe("N4 includeStubs defaults to false (rendering bytes unchanged)", () => {
	it("non-stub recall keeps excluding stub children exactly as before", async () => {
		// 真实父节点（非 stub 祖先占位——那样会走 N2 路径）。
		store.put({ uri: "core://parent", content: "父节点正文" });
		store.put({ uri: "core://parent/real", content: "真实子节点" });
		store.put({ uri: "core://parent/sub/leaf", content: "深层叶子" }); // core://parent/sub = stub
		const r = await run("recall", { uri: "core://parent", depth: -1 });
		expect(r.text).toContain("# [core://parent]");
		expect(r.text).toContain("父节点正文");
		expect(r.text).toContain("■ core://parent/real");
		expect(r.text).toContain("真实子节点");
		expect(r.text).not.toContain("core://parent/sub");
		expect(r.text).not.toContain("深层叶子");
	});
});

// ── 提示词契约（03 §9 包内单测） ─────────────────────────────────────────────

describe("renderTidyTaskPrompt (J2 函数式替换单点)", () => {
	it("replaces all occurrences of both variables, $ sequences survive", () => {
		const out = renderTidyTaskPrompt("A{temp_list}B{max_turns}C{temp_list}", {
			tempList: "- TEMP://x（manual）$& $$ $` 冻结",
			maxTurns: 7,
		});
		expect(out).toBe("A- TEMP://x（manual）$& $$ $` 冻结B7C- TEMP://x（manual）$& $$ $` 冻结");
	});

	it("empty/whitelist-only list renders literal （空）; absent maxTurns keeps the literal", () => {
		expect(renderTidyTaskPrompt("<{temp_list}>", { tempList: "" })).toBe("<（空）>");
		expect(renderTidyTaskPrompt("<{temp_list}>", { tempList: "  \n " })).toBe("<（空）>");
		expect(renderTidyTaskPrompt("轮数 {max_turns}", { tempList: "x" })).toBe("轮数 {max_turns}");
		expect(renderTidyTaskPrompt("无变量", { tempList: "x", maxTurns: 1 })).toBe("无变量");
	});

	it("default template renders with zero placeholder residue", () => {
		const out = renderTidyTaskPrompt(DEFAULT_TIDY_TASK_TEMPLATE, {
			tempList: "- TEMP://a（manual）草稿",
			maxTurns: 30,
		});
		expect(out).not.toContain("{temp_list}");
		expect(out).not.toContain("{max_turns}");
		expect(out).toContain("- TEMP://a（manual）草稿");
		expect(out).toContain("轮数上限：30。");
	});
});
