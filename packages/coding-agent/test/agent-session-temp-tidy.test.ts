/**
 * Tests for the TEMP auto-tidy host primitives (docs/design/temp-autotidy/02):
 * - sideStreamFn: model resolution chain (T2), stream closure identity/pinning
 *   and per-invocation side-request lifecycle (T3), gateway-missing error face
 * - sendCustomMessage: triggerTurn options forwarding and default completion
 *   (T5 compatibility regression)
 * - getTempTidyPromptOverrides: pull-model live read across preset hot swap,
 *   without a runtime reload on same-dbPath switches (T6)
 */

import type { AssistantMessage, AssistantMessageEventStream, Context, Model } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { MemoryStore } from "@earendil-works/pi-memory";
import { openMemoryStore } from "@earendil-works/pi-memory";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { PromptPreset } from "../src/core/prompt-preset/types.ts";
import { RequestGateway } from "../src/core/request-gateway.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";
import { createHarness, fauxModel, type Harness } from "./test-harness.ts";

const FAUX2: Model<"anthropic-messages"> = { ...fauxModel, id: "faux-2", name: "Faux Model 2" };

interface TidyHost {
	sideStreamFn(options: { modelRef?: string; signal?: AbortSignal }): Promise<{
		streamFn: (model: Model<any>, context: Context, options?: unknown) => AssistantMessageEventStream;
		model: Model<any>;
	}>;
	getTempTidyPromptOverrides(): { systemPrompt?: string; taskPrompt?: string } | undefined;
	sendCustomMessage(
		message: { customType: string; content: string; display: false; details?: unknown },
		options?: { triggerTurn?: boolean },
	): void;
}

/** Build a memory module host against a throwaway in-memory store. */
async function getTidyHost(harness: Harness): Promise<TidyHost> {
	const store: MemoryStore = await openMemoryStore(":memory:");
	const session = harness.session as unknown as {
		_createMemoryModuleHost(store: MemoryStore): TidyHost;
	};
	return session._createMemoryModuleHost(store);
}

/** Register faux-2 alongside faux-1 on the harness's catalogue-only provider. */
function registerSecondModel(harness: Harness): void {
	harness.session.modelRuntime.registerProvider("faux", {
		baseUrl: fauxModel.baseUrl,
		api: fauxModel.api,
		models: [
			{
				id: fauxModel.id,
				name: fauxModel.name,
				api: fauxModel.api,
				reasoning: fauxModel.reasoning,
				input: fauxModel.input,
				cost: fauxModel.cost,
				contextWindow: fauxModel.contextWindow,
				maxTokens: fauxModel.maxTokens,
				baseUrl: fauxModel.baseUrl,
			},
			{
				id: FAUX2.id,
				name: FAUX2.name,
				api: FAUX2.api,
				reasoning: FAUX2.reasoning,
				input: FAUX2.input,
				cost: FAUX2.cost,
				contextWindow: FAUX2.contextWindow,
				maxTokens: FAUX2.maxTokens,
				baseUrl: FAUX2.baseUrl,
			},
		],
	});
}

/** Inject a real gateway into the harness session (the sdk path always has one). */
function injectGateway(harness: Harness): RequestGateway {
	const gateway = new RequestGateway(harness.session.modelRuntime, {});
	(harness.session as unknown as { _requestGateway: RequestGateway | undefined })._requestGateway = gateway;
	return gateway;
}

/** Terminal "stop" stream for a stubbed gateway.streamSimple. */
function doneStream(text: string): AssistantMessageEventStream {
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "faux",
		model: "faux-2",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
	const stream = createAssistantMessageEventStream();
	stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } as AssistantMessage });
	stream.push({ type: "done", reason: "stop", message });
	return stream;
}

function sideRequestCount(session: AgentSession): number {
	return (session as unknown as { _sideRequestAbortControllers: Set<unknown> })._sideRequestAbortControllers.size;
}

function notifyMessage(content: string): { customType: string; content: string; display: false; details?: unknown } {
	return { customType: "rp-notify", content, display: false, details: { kind: "temp-tidy-report" } };
}

function customContents(entries: SessionEntry[]): unknown[] {
	return entries
		.filter((e): e is SessionEntry & { type: "custom_message"; content: unknown } => e.type === "custom_message")
		.map((e) => e.content);
}

function hasAssistantEntry(entries: SessionEntry[]): boolean {
	return entries.some(
		(e) => e.type === "message" && (e as { message: { role: string } }).message.role === "assistant",
	);
}

const cleanups: Array<() => void> = [];

afterEach(() => {
	while (cleanups.length) cleanups.pop()!();
});

describe("memory host sideStreamFn (temp-tidy)", () => {
	it("resolves modelRef from the catalogue and pins it in the stream closure (T2)", async () => {
		const harness = await createHarness();
		cleanups.push(harness.cleanup);
		registerSecondModel(harness);
		const gateway = injectGateway(harness);
		const spy = vi.spyOn(gateway, "streamSimple").mockImplementation((() => doneStream("ok")) as never);
		const host = await getTidyHost(harness);

		const { streamFn, model } = await host.sideStreamFn({ modelRef: "faux/faux-2" });
		expect(model.id).toBe("faux-2");

		// The closure pins the resolved model: even a drifted first argument
		// (what agentLoop passes is config.model) must not move the request.
		streamFn(FAUX2, { systemPrompt: "", messages: [] });
		expect(spy.mock.calls[0][0].id).toBe("faux-2");
	});

	it("falls back to the session model on missing or blank modelRef (T2/D5)", async () => {
		const harness = await createHarness();
		cleanups.push(harness.cleanup);
		registerSecondModel(harness);
		const gateway = injectGateway(harness);
		const spy = vi.spyOn(gateway, "streamSimple").mockImplementation((() => doneStream("ok")) as never);
		const host = await getTidyHost(harness);

		const defaulted = await host.sideStreamFn({});
		expect(defaulted.model.id).toBe("faux-1");
		const blank = await host.sideStreamFn({ modelRef: "   " });
		expect(blank.model.id).toBe("faux-1");

		defaulted.streamFn(FAUX2, { systemPrompt: "", messages: [] });
		expect(spy.mock.calls[0][0].id).toBe("faux-1");
	});

	it("rejects an unknown modelRef verbatim (config errors must be loud, T2)", async () => {
		const harness = await createHarness();
		cleanups.push(harness.cleanup);
		const host = await getTidyHost(harness);
		await expect(host.sideStreamFn({ modelRef: "missing-model" })).rejects.toThrow(
			'Tidy model "missing-model" not found.',
		);
	});

	it("keeps completeSideRequest's autoretain chain and messages after the helper refactor", async () => {
		const harness = await createHarness({
			settings: { memory: { autoretain: { models: { smol: "claude-haiku" } } } } as never,
		});
		cleanups.push(harness.cleanup);
		const host = await getTidyHost(harness);
		// A configured-but-unregistered role reference is a hard error with the
		// verbatim pre-refactor message (thrown before any LLM call).
		await expect(host.completeSideRequest("summarize", { label: "autoretain", modelRole: "smol" })).rejects.toThrow(
			'Autoretain model "claude-haiku" not found.',
		);
	});

	it("rejects when no model is available at all", async () => {
		const harness = await createHarness();
		cleanups.push(harness.cleanup);
		const host = await getTidyHost(harness);
		(harness.agent.state as unknown as { model: unknown }).model = undefined;
		await expect(host.sideStreamFn({})).rejects.toThrow("sideStreamFn: no model available");
	});

	it("rejects when the session has no request gateway (defensive, §6.3)", async () => {
		// The harness builds its session without a gateway; the sdk path always
		// creates one, so this branch is theoretical — fail fast, not silently.
		const harness = await createHarness();
		cleanups.push(harness.cleanup);
		const host = await getTidyHost(harness);
		await expect(host.sideStreamFn({})).rejects.toThrow("no request gateway available");
	});

	it("stamps identity { sessionId:'?', priority:0, label:'temp-tidy' } and forwards the caller signal (T3)", async () => {
		const harness = await createHarness();
		cleanups.push(harness.cleanup);
		const gateway = injectGateway(harness);
		const controller = new AbortController();
		const spy = vi.spyOn(gateway, "streamSimple").mockImplementation((() => doneStream("ok")) as never);
		const host = await getTidyHost(harness);

		const { streamFn } = await host.sideStreamFn({ modelRef: "faux-1", signal: controller.signal });
		streamFn(FAUX2, { systemPrompt: "", messages: [] });
		const call = spy.mock.calls[0] as unknown as [
			Model<any>,
			Context,
			unknown,
			{ sessionId: string; priority: number; label: string },
			AbortSignal,
		];
		expect(call[3]).toEqual({ sessionId: "?", priority: 0, label: "temp-tidy" });
		// The per-round controller forwards the caller's signal: cancelling the
		// sideStreamFn signal must abort the in-flight round.
		controller.abort();
		await vi.waitFor(() => expect(call[4].aborted).toBe(true));
	});

	it("unregisters the per-invocation controller when the round stream settles (T3)", async () => {
		const harness = await createHarness();
		cleanups.push(harness.cleanup);
		const gateway = injectGateway(harness);
		vi.spyOn(gateway, "streamSimple").mockImplementation((() => doneStream("ok")) as never);
		const host = await getTidyHost(harness);

		const { streamFn } = await host.sideStreamFn({ modelRef: "faux-1" });
		expect(sideRequestCount(harness.session)).toBe(0);
		const stream = streamFn(FAUX2, { systemPrompt: "", messages: [] });
		expect(sideRequestCount(harness.session)).toBe(1);
		await stream.result();
		await vi.waitFor(() => expect(sideRequestCount(harness.session)).toBe(0));
	});

	it("aborts an in-flight round when the session is disposed (T3, side work dies with the session)", async () => {
		const harness = await createHarness();
		cleanups.push(harness.cleanup);
		const gateway = injectGateway(harness);
		const signals: AbortSignal[] = [];
		vi.spyOn(gateway, "streamSimple").mockImplementation(((
			_model: Model<any>,
			_ctx: Context,
			_opts: unknown,
			_id: unknown,
			signal?: AbortSignal,
		) => {
			const stream = createAssistantMessageEventStream();
			if (signal) signals.push(signal);
			return stream; // never settles on its own
		}) as never);
		const host = await getTidyHost(harness);

		const { streamFn } = await host.sideStreamFn({ modelRef: "faux-1" });
		streamFn(FAUX2, { systemPrompt: "", messages: [] });
		expect(signals.length).toBe(1);
		expect(signals[0].aborted).toBe(false);

		harness.session.dispose();
		await vi.waitFor(() => expect(signals[0].aborted).toBe(true));
	});
});

describe("memory host sendCustomMessage triggerTurn options (T5)", () => {
	it("defaults a single-param call to triggerTurn:true — idle: starts a turn (compat regression)", async () => {
		const harness = await createHarness();
		cleanups.push(harness.cleanup);
		const host = await getTidyHost(harness);

		host.sendCustomMessage(notifyMessage("tidy failed, check TEMP"));

		await vi.waitFor(() => expect(harness.session.isStreaming).toBe(true));
		await harness.session.waitForIdle();
		const entries = harness.sessionManager.getEntries();
		expect(customContents(entries)).toContain("tidy failed, check TEMP");
		expect(hasAssistantEntry(entries)).toBe(true);
	});

	it("explicit triggerTurn:false while idle: persists without waking a turn (D9)", async () => {
		const harness = await createHarness();
		cleanups.push(harness.cleanup);
		const host = await getTidyHost(harness);

		host.sendCustomMessage(notifyMessage("tidy report"), { triggerTurn: false });

		await vi.waitFor(() => {
			expect(customContents(harness.sessionManager.getEntries())).toContain("tidy report");
		});
		expect(harness.session.isStreaming).toBe(false);
		expect(hasAssistantEntry(harness.sessionManager.getEntries())).toBe(false);
	});

	it("single-param call while streaming: steers the running turn (compat regression)", async () => {
		const harness = await createHarness({ responses: [{ text: "first", delayMs: 60 }] });
		cleanups.push(harness.cleanup);
		const host = await getTidyHost(harness);

		const prompt = harness.session.prompt("hello");
		await vi.waitFor(() => expect(harness.session.isStreaming).toBe(true));
		host.sendCustomMessage(notifyMessage("steered notify"));
		await prompt;

		const entries = harness.sessionManager.getEntries();
		expect(customContents(entries)).toContain("steered notify");
		// The steer extends the run: one round for "hello", one for the message.
		expect(harness.faux.callCount).toBe(2);
	});

	it("triggerTurn:false while streaming: queues and flushes at turn end without a new round (D9)", async () => {
		const harness = await createHarness({ responses: [{ text: "only", delayMs: 60 }] });
		cleanups.push(harness.cleanup);
		const host = await getTidyHost(harness);

		const prompt = harness.session.prompt("hello");
		await vi.waitFor(() => expect(harness.session.isStreaming).toBe(true));
		host.sendCustomMessage(notifyMessage("queued report"), { triggerTurn: false });
		await prompt;

		const entries = harness.sessionManager.getEntries();
		const customIndex = entries.findIndex((e) => e.type === "custom_message");
		const assistantIndexes = entries
			.map((e, i) =>
				e.type === "message" && (e as { message: { role: string } }).message.role === "assistant" ? i : -1,
			)
			.filter((i) => i >= 0);
		expect(customIndex).toBeGreaterThan(assistantIndexes[assistantIndexes.length - 1]);
		// No extra LLM round for the deferred message.
		expect(harness.faux.callCount).toBe(1);
	});
});

describe("memory host getTempTidyPromptOverrides (T6 pull model)", () => {
	it("live-reads the active preset across a same-dbPath hot swap without reload", async () => {
		const harness = await createHarness();
		cleanups.push(harness.cleanup);
		const host = await getTidyHost(harness);
		const session = harness.session;

		expect(host.getTempTidyPromptOverrides()).toBeUndefined();

		const reloadSpy = vi.spyOn(session, "requestReload");
		const presetB: PromptPreset = {
			schemaVersion: 1,
			id: "with-tidy-overrides",
			items: [],
			hiddenOverrides: { tempTidy: { systemPrompt: "S", taskPrompt: "T" } },
		};
		const presetA: PromptPreset = { schemaVersion: 1, id: "plain", items: [] };
		(session as unknown as { _loadedPresets: unknown[] })._loadedPresets = [
			{ preset: presetA, filePath: "/tmp/a.json", diagnostics: [] },
			{ preset: presetB, filePath: "/tmp/b.json", diagnostics: [] },
		];

		const activated = await session.setActivePreset("with-tidy-overrides");
		expect(activated.ok).toBe(true);
		// Live read: the getter serves the NEW preset's values with no push step.
		expect(host.getTempTidyPromptOverrides()).toEqual({ systemPrompt: "S", taskPrompt: "T" });
		// Same memory dbPath → hot swap must NOT rebuild the runtime.
		expect(reloadSpy).not.toHaveBeenCalled();

		await session.setActivePreset("plain");
		expect(host.getTempTidyPromptOverrides()).toBeUndefined();
		expect(reloadSpy).not.toHaveBeenCalled();
	});
});
