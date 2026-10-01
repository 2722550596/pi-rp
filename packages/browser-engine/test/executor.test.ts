import type { AssistantMessage, ToolCall, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { ByteTransport, ByteTransportFactory, ByteTransportHandlers } from "@earendil-works/pi-client";
import {
	EXECUTOR_PROTOCOL_VERSION,
	type ExecutorRuntimeCommand,
	type ExecutorToHost,
	ExecutorToHostDecoder,
	encodeHostToExecutor,
	type HostToExecutor,
	MAX_EXECUTOR_INBOUND_CHUNK_BYTES,
	MIN_ABORT_CONTROL_BYTES,
} from "@earendil-works/pi-protocol";
import { describe, expect, test, vi } from "vitest";
import type { AgentSession, AgentSessionEvent } from "../../coding-agent/src/core/agent-session.ts";
import type { SessionEntry } from "../../coding-agent/src/core/session-manager.ts";
import type { PiHarness } from "../src/assemble.ts";
import { type BrowserExecutorOptions, type ExecutorBootstrapError, startBrowserExecutor } from "../src/executor.ts";

const SESSION_ID = "browser-session";
const BINDING_ID = "browser-binding";
const COMMAND_ID = "00000000-0000-4000-8000-000000000001";
const abortControlBudget = MAX_EXECUTOR_INBOUND_CHUNK_BYTES + MIN_ABORT_CONTROL_BYTES;
const FLOW = {
	maxPendingCommands: 4,
	maxQueuedOutboundBytes: MAX_EXECUTOR_INBOUND_CHUNK_BYTES + abortControlBudget,
	maxAbortControlBytes: abortControlBudget,
} as const;
const timestamp = "2026-10-01T12:00:00.000Z";

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(error: Error): void;
}
function deferred<T>(): Deferred<T> {
	const { promise, resolve, reject } = Promise.withResolvers<T>();
	return { promise, resolve, reject };
}
const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
function assistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "pending",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "test-provider",
		model: "test-model",
		usage: zeroUsage,
		stopReason,
		timestamp: Date.now(),
	};
}
function userMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}
function messageEntry(id: string, message: AssistantMessage | ToolResultMessage | UserMessage): SessionEntry {
	return { type: "message", id, parentId: null, timestamp, message };
}

interface SessionFixture {
	session: AgentSession;
	readonly entries: SessionEntry[];
	readonly promptCalls: string[];
	readonly steerCalls: string[];
	readonly listeners: Set<(event: AgentSessionEvent) => void>;
	readonly pendingToolCalls: Set<string>;
	journalCallbacks: number;
	abortCalls: number;
	streaming: boolean;
	streamingMessage?: AssistantMessage;
	releasePrompt(): void;
	setStreamingMessage(message: AssistantMessage | undefined): void;
	emit(event: AgentSessionEvent): void;
}
function createSession(): SessionFixture {
	const entries: SessionEntry[] = [];
	const promptCalls: string[] = [];
	const steerCalls: string[] = [];
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	const pendingToolCalls = new Set<string>();
	const steering: string[] = [];
	const model = { provider: "test-provider", id: "test-model" };
	let streaming = false;
	let streamingMessage: AssistantMessage | undefined;
	let resolvePrompt: (() => void) | undefined;
	let thinkingLevel = "off";
	let journalCallbacks = 0;
	let abortCalls = 0;
	const fixture: SessionFixture = {
		session: undefined as unknown as AgentSession,
		entries,
		promptCalls,
		steerCalls,
		listeners,
		pendingToolCalls,
		journalCallbacks,
		abortCalls,
		get streaming() {
			return streaming;
		},
		set streaming(value: boolean) {
			streaming = value;
		},
		get streamingMessage() {
			return streamingMessage;
		},
		set streamingMessage(value: AssistantMessage | undefined) {
			streamingMessage = value;
		},
		releasePrompt() {
			const resolve = resolvePrompt;
			resolvePrompt = undefined;
			if (!resolve) return;
			streaming = false;
			fixture.emit({ type: "agent_settled" });
			resolve();
		},
		setStreamingMessage(message) {
			streamingMessage = message;
		},
		emit(event) {
			for (const listener of [...listeners]) listener(event);
			journalCallbacks++;
			fixture.journalCallbacks = journalCallbacks;
		},
	};
	const rawSession = {
		sessionId: SESSION_ID,
		sessionManager: {
			getHeader: () => ({ type: "session", id: SESSION_ID, timestamp, cwd: "/workspace" }),
			buildContextEntries: () => entries,
			getSessionName: () => "fixture",
			getCwd: () => "/workspace",
		},
		agent: {
			state: {
				get streamingMessage() {
					return streamingMessage;
				},
				pendingToolCalls,
			},
		},
		get model() {
			return model;
		},
		modelRuntime: {
			getModel: (provider: string, id: string) =>
				provider === model.provider && id === model.id ? model : undefined,
		},
		get thinkingLevel() {
			return thinkingLevel;
		},
		get isStreaming() {
			return streaming;
		},
		get isCompacting() {
			return false;
		},
		subscribe(listener: (event: AgentSessionEvent) => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		prompt(text: string, options?: { preflightResult?: (accepted: boolean) => void }) {
			promptCalls.push(text);
			streaming = true;
			const pending = Promise.withResolvers<void>();
			resolvePrompt = pending.resolve;
			queueMicrotask(() => options?.preflightResult?.(true));
			return pending.promise;
		},
		async steer(text: string) {
			steerCalls.push(text);
			steering.push(text);
			fixture.emit({ type: "queue_update", steering: [...steering], followUp: [] });
		},
		async abort() {
			abortCalls++;
			fixture.abortCalls = abortCalls;
			fixture.releasePrompt();
			streaming = false;
		},
		async setModel(nextModel: { provider: string; id: string }) {
			Object.assign(model, nextModel);
		},
		getAvailableThinkingLevels: () => ["off", "low"],
		setThinkingLevel(level: string) {
			thinkingLevel = level;
		},
		getSteeringMessages: () => steering,
	};
	fixture.session = rawSession as unknown as AgentSession;
	return fixture;
}

interface HostOptions {
	readonly ready?: boolean;
	readonly bootstrapAck?: boolean;
}
class FakeExecutorTransport implements ByteTransport {
	readonly sent: ExecutorToHost[] = [];
	readonly decoder = new ExecutorToHostDecoder();
	closed = false;
	blockNextSend = false;
	private unblockSend?: () => void;
	private bootstrapAcknowledged = false;
	generationId = "";

	constructor(
		private readonly handlers: ByteTransportHandlers,
		private readonly options: HostOptions,
	) {}

	send(chunk: Uint8Array): Promise<void> {
		this.decoder.pushEach(chunk, (message) => {
			this.sent.push(message);
			if (message.type === "executor_hello") {
				this.generationId = message.generationId;
				if (this.options.ready !== false) {
					this.hostMessage({
						type: "executor_ready",
						version: EXECUTOR_PROTOCOL_VERSION,
						sessionId: message.sessionId,
						bindingId: BINDING_ID,
						generationId: message.generationId,
					});
				}
			} else if (
				message.type === "runtime_snapshot" &&
				!this.bootstrapAcknowledged &&
				this.options.bootstrapAck !== false
			) {
				this.bootstrapAcknowledged = true;
				const acknowledgement: HostToExecutor = {
					type: "bootstrap_ack",
					sessionId: message.sessionId,
					bindingId: message.bindingId,
					generationId: message.generationId,
				};
				this.hostMessage(acknowledgement);
			}
		});
		if (this.blockNextSend) {
			this.blockNextSend = false;
			const blocked = Promise.withResolvers<void>();
			this.unblockSend = blocked.resolve;
			return blocked.promise;
		}
		return Promise.resolve();
	}

	close(): void {
		this.closed = true;
	}

	hostMessage(message: HostToExecutor): void {
		this.handlers.onData(encodeHostToExecutor(message));
	}

	releaseBlockedSend(): void {
		const release = this.unblockSend;
		this.unblockSend = undefined;
		release?.();
	}

	disconnect(): void {
		this.handlers.onClose();
	}
}
class FakeHost {
	readonly links: FakeExecutorTransport[] = [];
	readonly factory: ByteTransportFactory = (handlers) => {
		const link = new FakeExecutorTransport(handlers, this.options);
		this.links.push(link);
		return link;
	};
	constructor(private readonly options: HostOptions = {}) {}
}
function createExecutor(fixture: SessionFixture, host: FakeHost, overrides: Partial<BrowserExecutorOptions> = {}) {
	return startBrowserExecutor({
		transportFactory: host.factory,
		sessionId: SESSION_ID,
		harness: { session: fixture.session } as unknown as PiHarness,
		flowControl: FLOW,
		timeouts: { connectTimeoutMs: 100, helloTimeoutMs: 100, bootstrapTimeoutMs: 100 },
		...overrides,
	});
}
async function eventually<T>(find: () => T | undefined): Promise<T> {
	for (let attempt = 0; attempt < 1_000; attempt++) {
		const value = find();
		if (value !== undefined) return value;
		await Promise.resolve();
	}
	throw new Error("Expected executor event was not observed");
}
function hostRuntimeCommand(
	link: FakeExecutorTransport,
	command: ExecutorRuntimeCommand,
	commandId = COMMAND_ID,
	identity: { sessionId?: string; bindingId?: string; generationId?: string } = {},
): void {
	link.hostMessage({
		type: "runtime_command",
		sessionId: identity.sessionId ?? SESSION_ID,
		bindingId: identity.bindingId ?? BINDING_ID,
		generationId: identity.generationId ?? link.generationId,
		commandId,
		command,
	});
}

describe("BrowserExecutor", () => {
	test("becomes ready only after hello and bootstrap and projects context entry IDs", async () => {
		const fixture = createSession();
		fixture.entries.push(messageEntry("stable-user", userMessage("hello")));
		const host = new FakeHost();
		const executor = createExecutor(fixture, host);
		await executor.ready;
		const snapshot = host.links[0]!.sent.find((message) => message.type === "runtime_snapshot");
		expect(snapshot).toMatchObject({
			type: "runtime_snapshot",
			snapshot: { id: SESSION_ID, transcript: [{ id: "stable-user", role: "user" }] },
		});
		expect(host.links[0]!.sent[0]).toMatchObject({
			type: "executor_hello",
			version: EXECUTOR_PROTOCOL_VERSION,
			sessionId: SESSION_ID,
		});
		await executor.dispose();
	});

	test("bounds transport, hello, and bootstrap waits and closes a factory result that arrives late", async () => {
		vi.useFakeTimers();
		try {
			const connectFixture = createSession();
			const lateTransport = deferred<ByteTransport>();
			const transportHandlers = deferred<ByteTransportHandlers>();
			const connectExecutor = startBrowserExecutor({
				transportFactory: (handlers) => {
					transportHandlers.resolve(handlers);
					return lateTransport.promise;
				},
				sessionId: SESSION_ID,
				harness: { session: connectFixture.session } as unknown as PiHarness,
				flowControl: FLOW,
				timeouts: { connectTimeoutMs: 10, helloTimeoutMs: 50, bootstrapTimeoutMs: 50 },
			});
			const connectReady = connectExecutor.ready;
			await vi.advanceTimersByTimeAsync(11);
			await expect(connectReady).rejects.toMatchObject({
				stage: "transport",
				reason: "timeout",
			} satisfies Partial<ExecutorBootstrapError>);
			const lateLink = new FakeExecutorTransport(await transportHandlers.promise, {});
			lateTransport.resolve(lateLink);
			await Promise.resolve();
			await Promise.resolve();
			expect(lateLink.closed).toBe(true);
			await connectExecutor.dispose();

			const helloExecutor = createExecutor(createSession(), new FakeHost({ ready: false }), {
				timeouts: { connectTimeoutMs: 50, helloTimeoutMs: 10, bootstrapTimeoutMs: 50 },
			});
			const helloReady = helloExecutor.ready;
			await vi.advanceTimersByTimeAsync(11);
			await expect(helloReady).rejects.toMatchObject({
				stage: "hello",
				reason: "timeout",
			} satisfies Partial<ExecutorBootstrapError>);
			await helloExecutor.dispose();

			const bootstrapExecutor = createExecutor(createSession(), new FakeHost({ bootstrapAck: false }), {
				timeouts: { connectTimeoutMs: 50, helloTimeoutMs: 50, bootstrapTimeoutMs: 10 },
			});
			const bootstrapReady = bootstrapExecutor.ready;
			await vi.advanceTimersByTimeAsync(11);
			await expect(bootstrapReady).rejects.toMatchObject({
				stage: "bootstrap",
				reason: "timeout",
			} satisfies Partial<ExecutorBootstrapError>);
			await bootstrapExecutor.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	test("accepts a matching host bootstrap rejection as a bootstrap error", async () => {
		const fixture = createSession();
		const host = new FakeHost({ bootstrapAck: false });
		const executor = createExecutor(fixture, host);
		const link = await eventually(() => host.links[0]);
		await eventually(() => link.sent.find((message) => message.type === "runtime_snapshot"));
		link.hostMessage({
			type: "executor_reject",
			version: EXECUTOR_PROTOCOL_VERSION,
			stage: "bootstrap",
			sessionId: SESSION_ID,
			bindingId: BINDING_ID,
			generationId: link.generationId,
			code: "invalid_request",
			reason: "invalid_snapshot",
			message: "Snapshot rejected",
		});
		await expect(executor.ready).rejects.toMatchObject({
			stage: "bootstrap",
			reason: "invalid_snapshot",
		} satisfies Partial<ExecutorBootstrapError>);
		expect(link.closed).toBe(true);
		await executor.dispose();
	});

	test("rejects mismatched binding identity and reconnects with a fresh generation", async () => {
		const fixture = createSession();
		const host = new FakeHost();
		const executor = createExecutor(fixture, host);
		await executor.ready;
		const first = host.links[0]!;
		first.disconnect();
		await executor.reconnect();
		const second = host.links[1]!;
		expect(second.generationId).not.toBe(first.generationId);
		expect(second.sent.map((message) => message.type)).toEqual(["executor_hello", "runtime_snapshot"]);
		hostRuntimeCommand(second, { command: "steer", text: "wrong binding" }, COMMAND_ID, {
			bindingId: "other-binding",
		});
		expect(second.closed).toBe(true);
		await expect(executor.reconnect()).rejects.toMatchObject({ code: "session_locked" });
		await executor.dispose();
	});

	test("shares prompt preflight, steer FIFO, and abort arbitration between local and remote writes", async () => {
		const fixture = createSession();
		const host = new FakeHost();
		const executor = createExecutor(fixture, host);
		await executor.ready;
		const localPrompt = executor.commands.prompt("local prompt");
		const conflictingPrompt = executor.commands.prompt("conflict");
		const preflightAbort = executor.commands.abort();
		await expect(conflictingPrompt).rejects.toMatchObject({ code: "busy" });
		await expect(preflightAbort).rejects.toMatchObject({ code: "busy" });
		expect(fixture.abortCalls).toBe(0);
		hostRuntimeCommand(host.links[0]!, { command: "prompt", text: "remote conflict" });
		const busyResult = await eventually(() =>
			host.links[0]!.sent.find(
				(message) => message.type === "runtime_command_result" && message.commandId === COMMAND_ID,
			),
		);
		expect(busyResult).toMatchObject({ ok: false, error: { code: "busy" } });
		await Promise.resolve();
		await executor.commands.abort();
		await localPrompt;
		expect(fixture.promptCalls).toEqual(["local prompt"]);
		expect(fixture.abortCalls).toBe(1);
		await Promise.all([executor.commands.steer("first"), executor.commands.steer("second")]);
		expect(fixture.steerCalls).toEqual(["first", "second"]);
		const firstQueueSnapshot = await eventually(() =>
			host.links[0]!.sent.find(
				(message) => message.type === "runtime_snapshot" && message.snapshot.queuedSteerCount === 2,
			),
		);
		expect(firstQueueSnapshot).toMatchObject({ snapshot: { queuedSteerCount: 2 } });
		if (firstQueueSnapshot.type !== "runtime_snapshot") throw new Error("Expected queued-steer snapshot");
		expect(
			firstQueueSnapshot.snapshot.queuedSteer?.map((item) =>
				item.content[0]?.type === "text" ? item.content[0].text : "",
			),
		).toEqual(["first", "second"]);
		const queueIds = firstQueueSnapshot.snapshot.queuedSteer?.map((item) => item.id);
		const previousSnapshotCount = host.links[0]!.sent.filter((message) => message.type === "runtime_snapshot").length;
		fixture.emit({ type: "queue_update", steering: ["first", "second"], followUp: [] });
		const repeatedQueueSnapshot = await eventually(() => {
			const snapshots = host.links[0]!.sent.filter(
				(message): message is Extract<ExecutorToHost, { type: "runtime_snapshot" }> =>
					message.type === "runtime_snapshot",
			);
			return snapshots.length > previousSnapshotCount ? snapshots[snapshots.length - 1] : undefined;
		});
		expect(repeatedQueueSnapshot.snapshot.queuedSteer?.map((item) => item.id)).toEqual(queueIds);
		await executor.dispose();
	});

	test("maps unavailable model and thinking choices to safe invalid_request results", async () => {
		const fixture = createSession();
		const host = new FakeHost();
		const executor = createExecutor(fixture, host);
		await executor.ready;
		hostRuntimeCommand(
			host.links[0]!,
			{ command: "set_model", model: { provider: "missing", id: "model" } },
			"00000000-0000-4000-8000-000000000002",
		);
		const modelResult = await eventually(() =>
			host.links[0]!.sent.find(
				(message) =>
					message.type === "runtime_command_result" &&
					message.commandId === "00000000-0000-4000-8000-000000000002",
			),
		);
		expect(modelResult).toMatchObject({ ok: false, error: { code: "invalid_request", message: expect.any(String) } });
		hostRuntimeCommand(
			host.links[0]!,
			{ command: "set_thinking", thinkingLevel: "high" },
			"00000000-0000-4000-8000-000000000003",
		);
		const thinkingResult = await eventually(() =>
			host.links[0]!.sent.find(
				(message) =>
					message.type === "runtime_command_result" &&
					message.commandId === "00000000-0000-4000-8000-000000000003",
			),
		);
		expect(thinkingResult).toMatchObject({
			ok: false,
			error: { code: "invalid_request", message: expect.any(String) },
		});
		await executor.dispose();
	});

	test("forwards text, thinking, and tool progress then reconciles transient IDs at settled", async () => {
		const fixture = createSession();
		const host = new FakeHost();
		const executor = createExecutor(fixture, host);
		await executor.ready;
		fixture.streaming = true;
		const call: ToolCall = { type: "toolCall", id: "call-1", name: "lookup", arguments: { key: "x" } };
		const partial = assistantMessage([{ type: "text", text: "" }, { type: "thinking", thinking: "" }, call]);
		fixture.setStreamingMessage(partial);
		fixture.emit({ type: "message_start", message: partial });
		fixture.emit({
			type: "message_update",
			message: assistantMessage([{ type: "text", text: "hello" }, { type: "thinking", thinking: "" }, call]),
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta: "hello",
				partial: assistantMessage([{ type: "text", text: "hello" }, { type: "thinking", thinking: "" }, call]),
			},
		});
		fixture.emit({
			type: "message_update",
			message: assistantMessage([{ type: "text", text: "hello" }, { type: "thinking", thinking: "plan" }, call]),
			assistantMessageEvent: {
				type: "thinking_delta",
				contentIndex: 1,
				delta: "plan",
				partial: assistantMessage([{ type: "text", text: "hello" }, { type: "thinking", thinking: "plan" }, call]),
			},
		});
		const finalAssistant = assistantMessage(
			[{ type: "text", text: "hello" }, { type: "thinking", thinking: "plan" }, call],
			"toolUse",
		);
		fixture.emit({ type: "message_end", message: finalAssistant });
		fixture.emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments });
		fixture.emit({
			type: "tool_execution_update",
			toolCallId: call.id,
			toolName: call.name,
			args: call.arguments,
			partialResult: { content: [{ type: "text", text: "working" }], details: {} },
		});
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: call.id,
			toolName: call.name,
			content: [{ type: "text", text: "found" }],
			details: {},
			isError: false,
			timestamp: Date.now(),
		};
		fixture.emit({
			type: "tool_execution_end",
			toolCallId: call.id,
			toolName: call.name,
			result: { content: result.content, details: result.details },
			isError: false,
		});
		fixture.emit({ type: "message_end", message: result });
		fixture.entries.push(messageEntry("assistant-final", finalAssistant), messageEntry("tool-final", result));
		fixture.streaming = false;
		fixture.emit({ type: "agent_settled" });
		const link = host.links[0]!;
		const progress = await eventually(() => {
			const current = link.sent.filter(
				(message): message is Extract<ExecutorToHost, { type: "runtime_progress" }> =>
					message.type === "runtime_progress",
			);
			const started = current.some(
				(message) => message.progress.type === "item_started" && message.progress.item.role === "tool",
			);
			const finished = current.some(
				(message) => message.progress.type === "item_finished" && message.progress.item.role === "tool",
			);
			const hasText = current.some(
				(message) =>
					message.progress.type === "assistant_delta" &&
					message.progress.kind === "text" &&
					message.progress.delta === "hello",
			);
			const hasThinking = current.some(
				(message) =>
					message.progress.type === "assistant_delta" &&
					message.progress.kind === "thinking" &&
					message.progress.delta === "plan",
			);
			return started && finished && hasText && hasThinking ? current : undefined;
		});
		expect(
			progress.some(
				(message) =>
					message.progress.type === "assistant_delta" &&
					message.progress.kind === "text" &&
					message.progress.delta === "hello",
			),
		).toBe(true);
		expect(
			progress.some(
				(message) =>
					message.progress.type === "assistant_delta" &&
					message.progress.kind === "thinking" &&
					message.progress.delta === "plan",
			),
		).toBe(true);
		const startedTool = progress.find(
			(message) => message.progress.type === "item_started" && message.progress.item.role === "tool",
		);
		const finishedTool = progress.find(
			(message) => message.progress.type === "item_finished" && message.progress.item.role === "tool",
		);
		expect(
			startedTool &&
				finishedTool &&
				startedTool.progress.type === "item_started" &&
				finishedTool.progress.type === "item_finished" &&
				startedTool.progress.item.id === finishedTool.progress.item.id,
		).toBe(true);
		expect(
			progress.some((message) => message.progress.type === "item_updated" && message.progress.item.role === "tool"),
		).toBe(false);
		const settledSnapshot = await eventually(() =>
			[...link.sent]
				.reverse()
				.find(
					(message) =>
						message.type === "runtime_snapshot" &&
						message.snapshot.phase === "idle" &&
						message.snapshot.transcript.some((item) => item.id === "assistant-final") &&
						message.snapshot.transcript.some((item) => item.id === "tool-final"),
				),
		);
		expect(settledSnapshot).toMatchObject({
			snapshot: {
				phase: "idle",
				transcript: expect.arrayContaining([
					expect.objectContaining({ id: "assistant-final" }),
					expect.objectContaining({ id: "tool-final" }),
				]),
			},
		});
		await executor.dispose();
	});

	test("seeds a fresh driver with the current assistant and pending tool execution", async () => {
		const fixture = createSession();
		const call: ToolCall = { type: "toolCall", id: "pending-call", name: "lookup", arguments: { key: "active" } };
		const persistedAssistant = assistantMessage([call], "toolUse");
		fixture.entries.push(messageEntry("stable-assistant", persistedAssistant));
		fixture.pendingToolCalls.add(call.id);
		fixture.streaming = true;
		fixture.setStreamingMessage(assistantMessage([{ type: "text", text: "partial" }]));
		const host = new FakeHost();
		const executor = createExecutor(fixture, host);
		await executor.ready;
		const bootstrap = host.links[0]!.sent.find((message) => message.type === "runtime_snapshot");
		if (!bootstrap || bootstrap.type !== "runtime_snapshot") throw new Error("Expected bootstrap snapshot");
		expect(bootstrap.snapshot.transcript).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "stable-assistant", role: "assistant" }),
				expect.objectContaining({
					role: "assistant",
					status: "streaming",
					content: [{ type: "text", text: "partial" }],
				}),
				expect.objectContaining({ role: "tool", toolCallId: call.id, status: "running" }),
			]),
		);
		await executor.dispose();
	});

	test("command results materialize the same early assistant overlay as live progress", async () => {
		const fixture = createSession();
		const host = new FakeHost();
		const executor = createExecutor(fixture, host);
		await executor.ready;
		fixture.streaming = true;
		const partial = assistantMessage([{ type: "text", text: "" }]);
		fixture.setStreamingMessage(partial);
		fixture.emit({ type: "message_start", message: partial });
		fixture.emit({
			type: "message_update",
			message: assistantMessage([{ type: "text", text: "early output" }]),
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta: "early output",
				partial: assistantMessage([{ type: "text", text: "early output" }]),
			},
		});
		hostRuntimeCommand(host.links[0]!, { command: "steer", text: "continue" });
		const result = await eventually(() =>
			host.links[0]!.sent.find(
				(message) => message.type === "runtime_command_result" && message.commandId === COMMAND_ID,
			),
		);
		expect(result).toMatchObject({
			ok: true,
			snapshot: {
				phase: "turn",
				transcript: expect.arrayContaining([
					expect.objectContaining({ role: "assistant", content: [{ type: "text", text: "early output" }] }),
				]),
			},
		});
		await executor.dispose();
	});

	test("command-result snapshot rejection retains the matching command ID", async () => {
		const fixture = createSession();
		const host = new FakeHost();
		const executor = createExecutor(fixture, host);
		await executor.ready;
		fixture.entries.push(messageEntry("large-user", userMessage("x".repeat(MAX_EXECUTOR_INBOUND_CHUNK_BYTES))));
		hostRuntimeCommand(host.links[0]!, { command: "steer", text: "accepted" });
		const rejected = await eventually(() =>
			host.links[0]!.sent.find(
				(message) => message.type === "executor_snapshot_rejected" && message.scope === "command_result",
			),
		);
		expect(rejected).toMatchObject({ scope: "command_result", commandId: COMMAND_ID, code: "invalid_snapshot" });
		await executor.dispose();
	});

	test("isolates converter and error-handler failures from session listener journal writes", async () => {
		const fixture = createSession();
		const host = new FakeHost();
		const executor = createExecutor(fixture, host, {
			onError: () => {
				throw new Error("reporter failed");
			},
		});
		await executor.ready;
		fixture.emit({ type: "message_end", message: assistantMessage([{ type: "text", text: "bad" }], "deferred") });
		expect(fixture.journalCallbacks).toBe(1);
		await eventually(() => (host.links[0]!.closed ? true : undefined));
		await executor.dispose();
	});

	test("discards old-generation queued progress after physical disconnect", async () => {
		const fixture = createSession();
		const host = new FakeHost();
		const executor = createExecutor(fixture, host);
		await executor.ready;
		const oldLink = host.links[0]!;
		oldLink.blockNextSend = true;
		fixture.emit({ type: "message_start", message: userMessage("queued before disconnect") });
		await eventually(() => (oldLink.sent.some((message) => message.type === "runtime_progress") ? true : undefined));
		oldLink.disconnect();
		await executor.reconnect();
		const newLink = host.links[1]!;
		expect(newLink.sent.map((message) => message.type)).toEqual(["executor_hello", "runtime_snapshot"]);
		oldLink.releaseBlockedSend();
		expect(newLink.sent.some((message) => message.type === "runtime_progress")).toBe(false);
		await executor.dispose();
	});

	test("bounds queued plus in-flight bytes without interrupting local journal callbacks", async () => {
		const fixture = createSession();
		const host = new FakeHost();
		const executor = createExecutor(fixture, host);
		await executor.ready;
		const link = host.links[0]!;
		link.blockNextSend = true;
		const large = "x".repeat(8 * 1024 * 1024);
		fixture.emit({ type: "message_start", message: userMessage(large) });
		await eventually(() => (link.sent.some((message) => message.type === "runtime_progress") ? true : undefined));
		fixture.emit({ type: "message_start", message: userMessage(large) });
		expect(fixture.journalCallbacks).toBe(2);
		expect(link.closed).toBe(true);
		link.releaseBlockedSend();
		await executor.dispose();
	});
	test("disposal closes a stalled transport without waiting for its in-flight write", async () => {
		const fixture = createSession();
		const host = new FakeHost();
		const executor = createExecutor(fixture, host);
		await executor.ready;
		const link = host.links[0]!;
		link.blockNextSend = true;
		fixture.emit({ type: "message_start", message: userMessage("stalled progress") });
		await eventually(() => (link.sent.some((message) => message.type === "runtime_progress") ? true : undefined));

		const disposal = executor.dispose();
		const closedBeforeRelease = link.closed;
		link.releaseBlockedSend();
		await disposal;
		expect(closedBeforeRelease).toBe(true);
	});
});
