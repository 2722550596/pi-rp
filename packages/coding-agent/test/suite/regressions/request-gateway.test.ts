import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api } from "@earendil-works/pi-ai";
import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type Model,
} from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterAll, describe, expect, it } from "vitest";
import type { ModelRuntime } from "../../../src/core/model-runtime.ts";
import { RequestGateway } from "../../../src/core/request-gateway.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { InMemorySettingsStorage, SettingsManager } from "../../../src/core/settings-manager.ts";

/** Flush pending microtasks (acquire/resume/promote chains) plus one macrotask. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function createFakeRuntime() {
	const streams: AssistantMessageEventStream[] = [];
	const started: Model<Api>[] = [];
	const runtime = {
		streamSimple: (requestModel: Model<Api>) => {
			started.push(requestModel);
			const stream = createAssistantMessageEventStream();
			streams.push(stream);
			return stream;
		},
	} as unknown as ModelRuntime;
	return { runtime, streams, started };
}

function createFakeCompleteRuntime() {
	const pending: Array<(message: AssistantMessage) => void> = [];
	const calls: string[] = [];
	const runtime = {
		completeSimple: () =>
			new Promise<AssistantMessage>((resolve) => {
				calls.push("start");
				pending.push(resolve);
			}),
	} as unknown as ModelRuntime;
	return { runtime, pending, calls };
}

const doneEvent = (message: AssistantMessage) => ({ type: "done" as const, reason: "stop" as const, message });
const abortedEvent = {
	type: "error" as const,
	reason: "aborted" as const,
	error: fauxAssistantMessage("aborted", { stopReason: "aborted", errorMessage: "The operation was aborted" }),
};

describe("request gateway", () => {
	const faux = registerFauxProvider({});
	const model = faux.getModel();
	const context: Context = { messages: [] };

	afterAll(() => {
		faux.unregister();
	});

	it("gates concurrent streamSimple requests per provider", async () => {
		const { runtime, streams } = createFakeRuntime();
		const gateway = new RequestGateway(runtime, { providers: { faux: { maxConcurrency: 1 } } });
		const s1 = gateway.streamSimple(model, context);
		const s2 = gateway.streamSimple(model, context);
		await flush();
		expect(streams).toHaveLength(1); // only the first request started

		streams[0].push(doneEvent(fauxAssistantMessage("ok")));
		await flush();
		expect(streams).toHaveLength(2); // second started only after the first completed

		streams[1].push(doneEvent(fauxAssistantMessage("ok")));
		await expect(s1.result()).resolves.toMatchObject({ stopReason: "stop" });
		await expect(s2.result()).resolves.toMatchObject({ stopReason: "stop" });
	});

	it("does not gate when maxConcurrency is unset", async () => {
		const { runtime, streams } = createFakeRuntime();
		const gateway = new RequestGateway(runtime);
		const s1 = gateway.streamSimple(model, context);
		const s2 = gateway.streamSimple(model, context);
		await flush();
		expect(streams).toHaveLength(2); // both started concurrently

		streams[0].push(doneEvent(fauxAssistantMessage("ok")));
		streams[1].push(doneEvent(fauxAssistantMessage("ok")));
		await expect(s1.result()).resolves.toMatchObject({ stopReason: "stop" });
		await expect(s2.result()).resolves.toMatchObject({ stopReason: "stop" });
	});

	it("starts a queued request after the active one is aborted", async () => {
		const { runtime, streams } = createFakeRuntime();
		const gateway = new RequestGateway(runtime, { providers: { faux: { maxConcurrency: 1 } } });
		const s1 = gateway.streamSimple(model, context);
		const s2 = gateway.streamSimple(model, context);
		await flush();
		expect(streams).toHaveLength(1);

		// Aborting the active request terminates its stream; release() promotes the queued one.
		streams[0].push(abortedEvent);
		await flush();
		expect(streams).toHaveLength(2);
		await expect(s1.result()).resolves.toMatchObject({ stopReason: "aborted" });

		streams[1].push(doneEvent(fauxAssistantMessage("ok")));
		await expect(s2.result()).resolves.toMatchObject({ stopReason: "stop" });
	});

	it("removes an aborted queued request and never starts it", async () => {
		const { runtime, streams } = createFakeRuntime();
		const gateway = new RequestGateway(runtime, { providers: { faux: { maxConcurrency: 1 } } });
		const abortController = new AbortController();
		gateway.streamSimple(model, context);
		const s2 = gateway.streamSimple(model, context, undefined, undefined, abortController.signal);
		await flush();
		expect(streams).toHaveLength(1);

		abortController.abort();
		await expect(s2.result()).resolves.toMatchObject({
			stopReason: "error",
			errorMessage: "The operation was aborted",
		});
		expect(streams).toHaveLength(1); // the aborted request never reached the runtime

		// The slot is freed for the next request instead of being handed to the aborted one.
		streams[0].push(doneEvent(fauxAssistantMessage("ok")));
		await flush();
		const s3 = gateway.streamSimple(model, context);
		await flush();
		expect(streams).toHaveLength(2);
		streams[1].push(doneEvent(fauxAssistantMessage("ok")));
		await expect(s3.result()).resolves.toMatchObject({ stopReason: "stop" });
	});

	it("serves queued requests highest priority first", async () => {
		const { runtime, streams, started } = createFakeRuntime();
		const gateway = new RequestGateway(runtime, { providers: { faux: { maxConcurrency: 1 } } });
		const modelA = { ...model };
		const modelB = { ...model };
		const modelC = { ...model };
		const sA = gateway.streamSimple(modelA, context, undefined, { sessionId: "?", priority: 2, label: "main" });
		const sB = gateway.streamSimple(modelB, context, undefined, { sessionId: "?", priority: 0, label: "subagent" });
		const sC = gateway.streamSimple(modelC, context, undefined, { sessionId: "?", priority: 2, label: "main" });
		await flush();
		expect(streams).toHaveLength(1);
		expect(started[0]).toBe(modelA);

		streams[0].push(doneEvent(fauxAssistantMessage("ok")));
		await flush();
		expect(streams).toHaveLength(2);
		expect(started[1]).toBe(modelC); // priority 2 (main) jumped ahead of priority 0 (subagent)

		streams[1].push(doneEvent(fauxAssistantMessage("ok")));
		await flush();
		expect(streams).toHaveLength(3);
		expect(started[2]).toBe(modelB);

		streams[2].push(doneEvent(fauxAssistantMessage("ok")));
		await expect(sA.result()).resolves.toMatchObject({ stopReason: "stop" });
		await expect(sB.result()).resolves.toMatchObject({ stopReason: "stop" });
		await expect(sC.result()).resolves.toMatchObject({ stopReason: "stop" });
	});

	it("gates completeSimple calls too", async () => {
		const { runtime, pending, calls } = createFakeCompleteRuntime();
		const gateway = new RequestGateway(runtime, { providers: { faux: { maxConcurrency: 1 } } });
		const p1 = gateway.completeSimple(model, context);
		const p2 = gateway.completeSimple(model, context);
		await flush();
		expect(calls).toHaveLength(1);

		pending[0](fauxAssistantMessage("ok"));
		await flush();
		expect(calls).toHaveLength(2); // second started only after the first resolved

		pending[1](fauxAssistantMessage("ok"));
		await expect(p1).resolves.toMatchObject({ stopReason: "stop" });
		await expect(p2).resolves.toMatchObject({ stopReason: "stop" });
	});

	it("reuses a passed request gateway instance", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-gw-"));
		try {
			const { runtime } = createFakeRuntime();
			const gateway = new RequestGateway(runtime, { providers: {}, defaultMaxConcurrency: undefined });
			const { session } = await createAgentSession({
				cwd: tempDir,
				agentDir: tempDir,
				model,
				sessionManager: SessionManager.inMemory(tempDir),
				modelRuntime: runtime,
				requestGateway: gateway,
			});
			expect(session.requestGateway).toBe(gateway);
			session.dispose();
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});

describe("request gateway settings", () => {
	it("reads per-provider limits and the default from settings", () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () =>
			JSON.stringify({
				providers: {
					anthropic: { maxConcurrency: 2 },
					faux: {},
				},
				requestGateway: { defaultMaxConcurrency: 4 },
			}),
		);
		storage.withLock("project", () => undefined);

		const settingsManager = SettingsManager.fromStorage(storage);

		expect(settingsManager.getRequestGatewayConfig()).toEqual({
			providers: { anthropic: { maxConcurrency: 2 } }, // faux has no explicit limit, so it is omitted
			defaultMaxConcurrency: 4,
		});
	});

	it("returns empty config when no request gateway settings exist", () => {
		const settingsManager = SettingsManager.inMemory({});
		expect(settingsManager.getRequestGatewayConfig()).toEqual({
			providers: {},
			defaultMaxConcurrency: undefined,
		});
	});
});
