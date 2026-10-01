import {
	DEFAULT_MAX_FRAME_LENGTH,
	EXECUTOR_PROTOCOL_VERSION,
	encodeClientMessage,
	encodeExecutorToHost,
	encodeServerMessage,
	HostToExecutorDecoder,
	MAX_EXECUTOR_INBOUND_CHUNK_BYTES,
	MIN_ABORT_CONTROL_BYTES,
	type ServerMessage,
	ServerMessageDecoder,
	type SessionSnapshot,
	type SnapshotData,
} from "@earendil-works/pi-protocol";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ByteConnection, ByteConnectionHandler } from "../src/connection.ts";
import { createExecutorSessionBridge, PiServer } from "../src/index.ts";
import { TestServerService } from "../src/testing/index.ts";

const SESSION = "shared-session";
const BINDING = "platform-binding";
const GENERATION = "00000000-0000-4000-8000-000000000001";
const SNAPSHOT: SnapshotData = {
	id: SESSION,
	cwd: "/workspace",
	createdAt: 1,
	updatedAt: 1,
	phase: "idle",
	model: { provider: "test", id: "small" },
	thinkingLevel: "off",
	transcript: [],
	queuedSteer: [],
	queuedSteerCount: 0,
};

class MemoryConnection implements ByteConnection {
	closed = false;
	readonly sent: Uint8Array[] = [];
	send(chunk: Uint8Array): Promise<void> {
		this.sent.push(chunk.slice());
		return Promise.resolve();
	}
	close(): void {
		this.closed = true;
	}
}

function bridgeOptions() {
	return {
		sessionId: SESSION,
		bindingId: BINDING,
		maxPendingCommands: 2,
		maxQueuedOutboundBytes: MAX_EXECUTOR_INBOUND_CHUNK_BYTES + MIN_ABORT_CONTROL_BYTES,
		maxAbortControlBytes: MIN_ABORT_CONTROL_BYTES,
		timeouts: { helloTimeoutMs: 100, bootstrapTimeoutMs: 100 },
	};
}

function feed(handler: ByteConnectionHandler, message: Parameters<typeof encodeExecutorToHost>[0]): void {
	handler.onData(encodeExecutorToHost(message));
}

function sentHostMessages(connection: MemoryConnection) {
	const decoder = new HostToExecutorDecoder();
	return connection.sent.flatMap((chunk) => decoder.push(chunk));
}

afterEach(() => vi.useRealTimers());

describe("ExecutorSessionBridge", () => {
	test("rejects unsupported versions and mismatched session identities", async () => {
		for (const hello of [
			{
				type: "executor_hello" as const,
				version: EXECUTOR_PROTOCOL_VERSION + 1,
				sessionId: SESSION,
				generationId: GENERATION,
			},
			{
				type: "executor_hello" as const,
				version: EXECUTOR_PROTOCOL_VERSION,
				sessionId: "other-session",
				generationId: GENERATION,
			},
		]) {
			const bridge = createExecutorSessionBridge(bridgeOptions());
			const acquire = bridge.acquireRuntime();
			const connection = new MemoryConnection();
			const handler = bridge.attachTransport(connection);
			feed(handler, hello);
			await vi.waitFor(() =>
				expect(sentHostMessages(connection)).toContainEqual(
					expect.objectContaining({ type: "executor_reject", stage: "hello" }),
				),
			);
			await expect(acquire).rejects.toThrow();
			await bridge.dispose();
		}
	});
	test("keeps pre-connect acquisition through synchronous bootstrap and acknowledges once", async () => {
		vi.useFakeTimers();
		const bridge = createExecutorSessionBridge({
			...bridgeOptions(),
			timeouts: { helloTimeoutMs: 100, bootstrapTimeoutMs: 10 },
		});
		const pendingRuntime = bridge.acquireRuntime();
		const connection = new MemoryConnection();
		const serverDecoder = new HostToExecutorDecoder();
		let handler: ByteConnectionHandler;
		connection.send = (chunk) => {
			connection.sent.push(chunk.slice());
			for (const message of serverDecoder.push(chunk)) {
				if (message.type === "executor_ready") {
					feed(handler, {
						type: "runtime_snapshot",
						sessionId: SESSION,
						bindingId: BINDING,
						generationId: message.generationId,
						snapshot: SNAPSHOT,
					});
				}
			}
			return Promise.resolve();
		};
		handler = bridge.attachTransport(connection);
		feed(handler, {
			type: "executor_hello",
			version: EXECUTOR_PROTOCOL_VERSION,
			sessionId: SESSION,
			generationId: GENERATION,
		});
		const runtime = await pendingRuntime;
		expect(runtime.snapshot().id).toBe(SESSION);
		feed(handler, {
			type: "runtime_snapshot",
			sessionId: SESSION,
			bindingId: BINDING,
			generationId: GENERATION,
			snapshot: { ...SNAPSHOT, updatedAt: 2 },
		});
		await vi.advanceTimersByTimeAsync(20);
		expect(sentHostMessages(connection).filter((message) => message.type === "bootstrap_ack")).toHaveLength(1);
		expect(runtime.snapshot().updatedAt).toBe(2);
		await runtime.dispose();
		await bridge.dispose();
	});

	test("existing facades recover after reconnect while stale generations remain fenced", async () => {
		const bridge = createExecutorSessionBridge(bridgeOptions());
		const firstConnection = new MemoryConnection();
		const firstHandler = bridge.attachTransport(firstConnection);
		const firstAcquire = bridge.acquireRuntime();
		feed(firstHandler, {
			type: "executor_hello",
			version: EXECUTOR_PROTOCOL_VERSION,
			sessionId: SESSION,
			generationId: GENERATION,
		});
		await vi.waitFor(() =>
			expect(sentHostMessages(firstConnection)).toContainEqual(
				expect.objectContaining({ type: "executor_ready", bindingId: BINDING }),
			),
		);
		feed(firstHandler, {
			type: "runtime_snapshot",
			sessionId: SESSION,
			bindingId: BINDING,
			generationId: GENERATION,
			snapshot: SNAPSHOT,
		});
		const first = await firstAcquire;
		expect(first.snapshot()).toMatchObject({ id: SESSION, locked: true, attached: false, phase: "idle" });
		firstHandler.onClose();
		expect(() => first.snapshot()).toThrow();

		const nextGeneration = "00000000-0000-4000-8000-000000000002";
		const secondConnection = new MemoryConnection();
		const secondHandler = bridge.attachTransport(secondConnection);
		feed(secondHandler, {
			type: "executor_hello",
			version: EXECUTOR_PROTOCOL_VERSION,
			sessionId: SESSION,
			generationId: nextGeneration,
		});
		feed(secondHandler, {
			type: "runtime_snapshot",
			sessionId: SESSION,
			bindingId: BINDING,
			generationId: nextGeneration,
			snapshot: SNAPSHOT,
		});
		const second = await bridge.acquireRuntime();
		expect(second).not.toBe(first);
		const resumedCommand = first.steer({ text: "continue after reconnect" });
		await vi.waitFor(() =>
			expect(sentHostMessages(secondConnection).some((message) => message.type === "runtime_command")).toBe(true),
		);
		const command = sentHostMessages(secondConnection).find((message) => message.type === "runtime_command");
		if (command?.type !== "runtime_command") throw new Error("Reconnected facade did not send its command");
		feed(secondHandler, {
			type: "runtime_command_result",
			sessionId: SESSION,
			bindingId: BINDING,
			generationId: nextGeneration,
			commandId: command.commandId,
			ok: true,
			snapshot: SNAPSHOT,
		});
		await resumedCommand;
		feed(firstHandler, {
			type: "runtime_snapshot",
			sessionId: SESSION,
			bindingId: BINDING,
			generationId: GENERATION,
			snapshot: { ...SNAPSHOT, cwd: "/stale" },
		});
		expect(second.snapshot()).toMatchObject({ id: SESSION, cwd: "/workspace" });
		expect(first.snapshot()).toMatchObject({ id: SESSION, cwd: "/workspace" });
		await bridge.dispose();
	});
	test("keeps an abort control slot beside the bounded ordinary command window", async () => {
		const bridge = createExecutorSessionBridge(bridgeOptions());
		const connection = new MemoryConnection();
		const handler = bridge.attachTransport(connection);
		const ready = bridge.acquireRuntime();
		feed(handler, {
			type: "executor_hello",
			version: EXECUTOR_PROTOCOL_VERSION,
			sessionId: SESSION,
			generationId: GENERATION,
		});
		await vi.waitFor(() =>
			expect(sentHostMessages(connection)).toContainEqual(expect.objectContaining({ type: "executor_ready" })),
		);
		feed(handler, {
			type: "runtime_snapshot",
			sessionId: SESSION,
			bindingId: BINDING,
			generationId: GENERATION,
			snapshot: SNAPSHOT,
		});
		const runtime = await ready;
		const first = runtime.prompt({ text: "one" });
		const second = runtime.setThinking("medium");
		await expect(runtime.setModel({ provider: "test", id: "small" })).rejects.toMatchObject({ code: "busy" });
		const abort = runtime.abort();
		await vi.waitFor(() =>
			expect(sentHostMessages(connection).filter((message) => message.type === "runtime_command")).toHaveLength(3),
		);
		const commands = sentHostMessages(connection).filter((message) => message.type === "runtime_command");
		for (const message of commands) {
			if (message.type !== "runtime_command") continue;
			feed(handler, {
				type: "runtime_command_result",
				sessionId: SESSION,
				bindingId: BINDING,
				generationId: GENERATION,
				commandId: message.commandId,
				ok: true,
				snapshot: SNAPSHOT,
			});
		}
		await Promise.all([first, second, abort]);
		await bridge.dispose();
	});

	test("expires bootstrap acquisition rather than leaving it pending", async () => {
		vi.useFakeTimers();
		const bridge = createExecutorSessionBridge({
			...bridgeOptions(),
			timeouts: { helloTimeoutMs: 100, bootstrapTimeoutMs: 5 },
		});
		const pending = bridge.acquireRuntime();
		const rejected = expect(pending).rejects.toThrow(/bootstrap timeout/i);
		await vi.advanceTimersByTimeAsync(5);
		await rejected;
		await bridge.dispose();
	});

	test("rejects unsafe queue and control-reserve limits at construction", () => {
		expect(() =>
			createExecutorSessionBridge({ ...bridgeOptions(), maxAbortControlBytes: MIN_ABORT_CONTROL_BYTES - 1 }),
		).toThrow(/maxAbortControlBytes/);
		expect(() =>
			createExecutorSessionBridge({ ...bridgeOptions(), maxQueuedOutboundBytes: DEFAULT_MAX_FRAME_LENGTH }),
		).toThrow(/maxQueuedOutboundBytes/);
	});
	test("attach preflight rejects an oversized snapshot without committing membership", async () => {
		const service = new TestServerService();
		service.seed("too-large");
		service.sessions.get("too-large")!.snapshot.transcript = [
			{
				id: "large-item",
				role: "user",
				content: [{ type: "text", text: "x".repeat(2_000) }],
				timestamp: 1,
			},
		] as SessionSnapshot["transcript"];
		const server = new PiServer(service, { listeners: [], maxFrameLength: 1_024 });
		const connection = new MemoryConnection();
		const handler = server.accept(connection);
		const decoder = new ServerMessageDecoder({ maxFrameLength: 1_024 });
		let readIndex = 0;
		const receiveNew = () => {
			const messages = connection.sent.slice(readIndex).flatMap((frame) => decoder.push(frame));
			readIndex = connection.sent.length;
			return messages;
		};
		handler.onData(encodeClientMessage({ type: "hello", version: 1 }));
		await vi.waitFor(() => expect(receiveNew().some((message) => message.type === "hello")).toBe(true));
		handler.onData(
			encodeClientMessage({
				type: "request",
				id: "attach-too-large",
				request: { command: "attach", sessionId: "too-large" },
			}),
		);
		let messages = receiveNew();
		await vi.waitFor(() => {
			messages = [...messages, ...receiveNew()];
			expect(messages.some((message) => message.type === "response" && message.id === "attach-too-large")).toBe(
				true,
			);
		});
		expect(messages).toContainEqual(
			expect.objectContaining({
				type: "response",
				id: "attach-too-large",
				ok: false,
				error: expect.objectContaining({ code: "invalid_request" }),
			}),
		);
		expect(messages.some((message) => message.type === "event" && message.event.type === "session_snapshot")).toBe(
			false,
		);
		await vi.waitFor(() => expect(service.latestRuntime("too-large").disposeCount).toBe(1));
		await server.close();
	});
	test("retries attach preflight when runtime progress changes the snapshot", async () => {
		class SnapshotRaceService extends TestServerService {
			override async openSession(sessionId: string) {
				const runtime = await super.openSession(sessionId);
				const originalSnapshot = runtime.snapshot.bind(runtime);
				let snapshotCalls = 0;
				runtime.snapshot = () => {
					const snapshot = originalSnapshot();
					snapshotCalls++;
					if (snapshotCalls === 2) {
						const item = {
							id: "during-prepare",
							role: "user" as const,
							content: [{ type: "text" as const, text: "included" }],
							timestamp: 2,
						};
						this.sessions.get(sessionId)!.snapshot = { ...snapshot, revision: 1, transcript: [item] };
						runtime.emitProgress({ type: "item_started", item });
					}
					return snapshot;
				};
				return runtime;
			}
		}
		const service = new SnapshotRaceService();
		service.seed("attach-race");
		const server = new PiServer(service, { listeners: [] });
		const connection = new MemoryConnection();
		const handler = server.accept(connection);
		const decoder = new ServerMessageDecoder();
		let readIndex = 0;
		const messages: ServerMessage[] = [];
		const receiveNew = () => {
			messages.push(...connection.sent.slice(readIndex).flatMap((frame) => decoder.push(frame)));
			readIndex = connection.sent.length;
			return messages;
		};
		handler.onData(encodeClientMessage({ type: "hello", version: 1 }));
		await vi.waitFor(() => expect(receiveNew().some((message) => message.type === "hello")).toBe(true));
		handler.onData(
			encodeClientMessage({
				type: "request",
				id: "attach-race-request",
				request: { command: "attach", sessionId: "attach-race" },
			}),
		);
		await vi.waitFor(() => {
			const attached = receiveNew();
			expect(attached.some((message) => message.type === "response" && message.id === "attach-race-request")).toBe(
				true,
			);
			expect(
				attached.some(
					(message) =>
						message.type === "event" &&
						message.event.type === "session_snapshot" &&
						message.event.snapshot.transcript.some((item) => item.id === "during-prepare"),
				),
			).toBe(true);
		});
		await server.close();
	});
	test("commits and sends byte-identical attach preflight frames", async () => {
		const service = new TestServerService();
		service.seed("attach-exact");
		const server = new PiServer(service, { listeners: [] });
		const connection = new MemoryConnection();
		const handler = server.accept(connection);
		const decoder = new ServerMessageDecoder();
		let readIndex = 0;
		const receiveNew = () => {
			const messages = connection.sent.slice(readIndex).flatMap((frame) => decoder.push(frame));
			readIndex = connection.sent.length;
			return messages;
		};
		handler.onData(encodeClientMessage({ type: "hello", version: 1 }));
		await vi.waitFor(() => expect(receiveNew().some((message) => message.type === "hello")).toBe(true));
		const requestId = "attach-exact-request";
		const session = {
			...service.sessions.get("attach-exact")!.snapshot,
			attached: true,
			locked: true,
		};
		const expectedEvent = encodeServerMessage({
			type: "event",
			event: { type: "session_snapshot", snapshot: session },
		});
		const expectedResponse = encodeServerMessage({
			type: "response",
			id: requestId,
			ok: true,
			result: { command: "attach", session },
		});
		handler.onData(
			encodeClientMessage({
				type: "request",
				id: requestId,
				request: { command: "attach", sessionId: "attach-exact" },
			}),
		);
		await vi.waitFor(() => {
			expect(connection.sent).toContainEqual(expectedEvent);
			expect(connection.sent).toContainEqual(expectedResponse);
		});
		const eventIndex = connection.sent.findIndex(
			(frame) =>
				frame.byteLength === expectedEvent.byteLength &&
				frame.every((byte, index) => byte === expectedEvent[index]),
		);
		const responseIndex = connection.sent.findIndex(
			(frame) =>
				frame.byteLength === expectedResponse.byteLength &&
				frame.every((byte, index) => byte === expectedResponse[index]),
		);
		expect(eventIndex).toBeGreaterThanOrEqual(0);
		expect(responseIndex).toBeGreaterThan(eventIndex);
		await server.close();
	});

	test("oversized command responses fail without blocking progress to other participants", async () => {
		const service = new TestServerService();
		service.seed("shared-live");
		const server = new PiServer(service, { listeners: [], maxFrameLength: 1_024 });
		const clients = await Promise.all(
			[0, 1].map(async () => {
				const connection = new MemoryConnection();
				const handler = server.accept(connection);
				const decoder = new ServerMessageDecoder({ maxFrameLength: 1_024 });
				let readIndex = 0;
				const receiveNew = () => {
					const messages = connection.sent.slice(readIndex).flatMap((frame) => decoder.push(frame));
					readIndex = connection.sent.length;
					return messages;
				};
				handler.onData(encodeClientMessage({ type: "hello", version: 1 }));
				const messages: ServerMessage[] = [];
				await vi.waitFor(() => {
					messages.push(...receiveNew());
					expect(messages.some((message) => message.type === "hello")).toBe(true);
				});
				return { connection, handler, receiveNew };
			}),
		);
		for (const [index, client] of clients.entries()) {
			client.handler.onData(
				encodeClientMessage({
					type: "request",
					id: `attach-${index}`,
					request: { command: "attach", sessionId: "shared-live" },
				}),
			);
			let messages = client.receiveNew();
			await vi.waitFor(() => {
				messages = [...messages, ...client.receiveNew()];
				expect(messages.some((message) => message.type === "response" && message.id === `attach-${index}`)).toBe(
					true,
				);
			});
		}

		service.sessions.get("shared-live")!.snapshot.transcript = [
			{
				id: "oversized",
				role: "user",
				content: [{ type: "text", text: "x".repeat(2_000) }],
				timestamp: 1,
			},
		] as SessionSnapshot["transcript"];
		clients[0]!.handler.onData(
			encodeClientMessage({
				type: "request",
				id: "oversized-command",
				request: { command: "set_thinking", sessionId: "shared-live", thinkingLevel: "medium" },
			}),
		);
		let response = clients[0]!.receiveNew();
		await vi.waitFor(() => {
			response = [...response, ...clients[0]!.receiveNew()];
			expect(response.some((message) => message.type === "response" && message.id === "oversized-command")).toBe(
				true,
			);
		});
		expect(response).toContainEqual(
			expect.objectContaining({
				type: "response",
				id: "oversized-command",
				ok: false,
				error: expect.objectContaining({ code: "invalid_request" }),
			}),
		);
		expect(service.sessions.get("shared-live")!.snapshot.thinkingLevel).toBe("medium");

		service.latestRuntime("shared-live").emitProgress({
			type: "item_started",
			item: {
				id: "progress-after-oversize",
				role: "user",
				content: [{ type: "text", text: "still live" }],
				timestamp: 2,
			},
		});
		for (const client of clients) {
			let messages = client.receiveNew();
			await vi.waitFor(() => {
				messages = [...messages, ...client.receiveNew()];
				expect(
					messages.some((message) => message.type === "event" && message.event.type === "session_progress"),
				).toBe(true);
			});
		}
		await server.close();
	});
});
