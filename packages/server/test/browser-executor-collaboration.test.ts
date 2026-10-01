import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import {
	MAX_EXECUTOR_INBOUND_CHUNK_BYTES,
	MIN_ABORT_CONTROL_BYTES,
	type ServerEvent,
} from "@earendil-works/pi-protocol";
import { describe, expect, test, vi } from "vitest";
import type { PiHarness } from "../../browser-engine/src/assemble.ts";
import { type BrowserExecutor, startBrowserExecutor } from "../../browser-engine/src/executor.ts";
import { PiClient } from "../../client/src/index.ts";
import type { SessionHandle } from "../../client/src/session-handle.ts";
import type { ByteTransport, ByteTransportHandlers } from "../../client/src/transport.ts";
import type { AgentSession, AgentSessionEvent } from "../../coding-agent/src/core/agent-session.ts";
import type { SessionEntry } from "../../coding-agent/src/core/session-manager.ts";
import type { ByteConnection, ByteConnectionHandler } from "../src/connection.ts";
import type { ExecutorSessionBridge } from "../src/executor-runtime.ts";
import { createExecutorSessionBridge, PiServer } from "../src/index.ts";
import { TEST_MODEL, TestServerService } from "../src/testing/index.ts";
import type { PiServerService } from "../src/types.ts";

const timestamp = "2026-10-01T12:00:00.000Z";
const abortControlBudget = MAX_EXECUTOR_INBOUND_CHUNK_BYTES + MIN_ABORT_CONTROL_BYTES;
const flowControl = {
	maxPendingCommands: 4,
	maxAbortControlBytes: abortControlBudget,
	maxQueuedOutboundBytes: MAX_EXECUTOR_INBOUND_CHUNK_BYTES + abortControlBudget,
} as const;
const bridgeFlowControl = {
	maxPendingCommands: 4,
	maxAbortControlBytes: MIN_ABORT_CONTROL_BYTES,
	maxQueuedOutboundBytes: MAX_EXECUTOR_INBOUND_CHUNK_BYTES + MIN_ABORT_CONTROL_BYTES,
} as const;
const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

class ServerSideConnection implements ByteConnection {
	closed = false;
	handler: ByteConnectionHandler | undefined;
	private readonly handlers: ByteTransportHandlers;
	constructor(handlers: ByteTransportHandlers) {
		this.handlers = handlers;
	}
	send(chunk: Uint8Array): Promise<void> {
		if (!this.closed) this.handlers.onData(chunk.slice());
		return Promise.resolve();
	}
	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.handler?.onClose();
		this.handlers.onClose();
	}
}

class BrowserSideTransport implements ByteTransport {
	private readonly connection: ServerSideConnection;
	constructor(connection: ServerSideConnection) {
		this.connection = connection;
	}
	send(chunk: Uint8Array): Promise<void> {
		if (this.connection.closed || !this.connection.handler)
			return Promise.reject(new Error("Executor channel is closed"));
		this.connection.handler.onData(chunk.slice());
		return Promise.resolve();
	}
	close(): void {
		this.connection.close();
	}
}

class ParticipantServerConnection implements ByteConnection {
	closed = false;
	handler: ByteConnectionHandler | undefined;
	private readonly handlers: ByteTransportHandlers;
	constructor(handlers: ByteTransportHandlers) {
		this.handlers = handlers;
	}
	send(chunk: Uint8Array): Promise<void> {
		if (!this.closed) this.handlers.onData(chunk.slice());
		return Promise.resolve();
	}
	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.handler?.onClose();
		this.handlers.onClose();
	}
}

class ParticipantTransport implements ByteTransport {
	private readonly connection: ParticipantServerConnection;
	constructor(connection: ParticipantServerConnection) {
		this.connection = connection;
	}
	send(chunk: Uint8Array): Promise<void> {
		if (this.connection.closed || !this.connection.handler)
			return Promise.reject(new Error("Participant connection is closed"));
		this.connection.handler.onData(chunk.slice());
		return Promise.resolve();
	}
	close(): void {
		this.connection.close();
	}
}

function createSessionFixture() {
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	const entries: SessionEntry[] = [];
	const model = { provider: TEST_MODEL.provider, id: TEST_MODEL.id };
	let sessionId = "unassigned";
	let streaming = false;
	let thinkingLevel: "off" | "low" = "off";
	let promptNumber = 0;
	const agentState: { streamingMessage?: AssistantMessage; pendingToolCalls: Set<string> } = {
		pendingToolCalls: new Set(),
	};
	const emit = (event: AgentSessionEvent): void => {
		for (const listener of listeners) listener(event);
	};
	const assistantMessage = (text: string, stopReason: AssistantMessage["stopReason"]): AssistantMessage => ({
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: model.provider,
		model: model.id,
		usage,
		stopReason,
		timestamp: Date.now(),
	});
	const session = {
		get sessionId() {
			return sessionId;
		},
		set sessionId(value: string) {
			sessionId = value;
		},
		sessionManager: {
			getHeader: () => ({ timestamp }),
			buildContextEntries: () => entries,
			getSessionName: () => "Shared browser session",
			getCwd: () => "/workspace",
		},
		agent: { state: agentState },
		model,
		modelRuntime: { getModel: () => model },
		get thinkingLevel() {
			return thinkingLevel;
		},
		get isStreaming() {
			return streaming;
		},
		isCompacting: false,
		isRetrying: false,
		retryAttempt: 0,
		getSteeringMessages: () => [] as string[],
		getAvailableThinkingLevels: () => ["off", "low"] as const,
		setThinkingLevel: (value: "off" | "low") => {
			thinkingLevel = value;
		},
		setModel: async () => {},
		steer: async () => {},
		abort: async () => {
			streaming = false;
			agentState.streamingMessage = undefined;
			emit({ type: "agent_settled" });
		},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		prompt: async (text: string, options?: { preflightResult?: (accepted: boolean) => void }) => {
			options?.preflightResult?.(true);
			promptNumber++;
			const user: UserMessage = { role: "user", content: text, timestamp: Date.now() };
			const userEntryId = `user-${promptNumber}`;
			const assistantEntryId = `assistant-${promptNumber}`;
			const pending = assistantMessage("", "pending");
			const final = assistantMessage("shared reply", "stop");
			streaming = true;
			agentState.streamingMessage = pending;
			emit({ type: "message_start", message: user });
			emit({ type: "message_end", message: user });
			emit({ type: "message_start", message: pending });
			emit({
				type: "message_update",
				message: assistantMessage("shared reply", "pending"),
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "shared reply" },
			});
			emit({ type: "message_end", message: final });
			entries.push(
				{ type: "message", id: userEntryId, parentId: null, timestamp, message: user },
				{ type: "message", id: assistantEntryId, parentId: userEntryId, timestamp, message: final },
			);
			streaming = false;
			agentState.streamingMessage = undefined;
			emit({ type: "agent_settled" });
		},
	};
	return { session: session as unknown as AgentSession };
}

describe("browser executor collaboration", () => {
	test("two PiClients receive progress and final transcript from one browser runtime", async () => {
		const fixture = createSessionFixture();
		const metadata = new TestServerService();
		let bridge: ExecutorSessionBridge | undefined;
		let executor: BrowserExecutor | undefined;
		let activeSessionId: string | undefined;
		const service: PiServerService = {
			listSessions: () => metadata.listSessions(),
			listModels: () => metadata.listModels(),
			async createSession(options) {
				activeSessionId = options.id;
				fixture.session.sessionId = options.id;
				metadata.seed(
					options.id,
					options.name ?? `Session ${options.id}`,
					options.cwd ?? "/workspace",
					options.model ?? { provider: TEST_MODEL.provider, id: TEST_MODEL.id },
					options.thinkingLevel ?? "off",
				);
				bridge = createExecutorSessionBridge({
					sessionId: options.id,
					bindingId: "browser-binding",
					...bridgeFlowControl,
				});
				executor = startBrowserExecutor({
					harness: { session: fixture.session } as unknown as PiHarness,
					sessionId: options.id,
					flowControl,
					transportFactory: (handlers) => {
						const connection = new ServerSideConnection(handlers);
						connection.handler = bridge!.attachTransport(connection);
						return new BrowserSideTransport(connection);
					},
				});
				return bridge.acquireRuntime();
			},
			async openSession(sessionId) {
				if (sessionId !== activeSessionId || !bridge) throw new Error("Unknown shared session");
				return bridge.acquireRuntime();
			},
		};
		const server = new PiServer(service, { listeners: [] });
		const createClient = (): PiClient =>
			new PiClient({
				transportFactory: (handlers) => {
					const connection = new ParticipantServerConnection(handlers);
					connection.handler = server.accept(connection);
					return new ParticipantTransport(connection);
				},
			});
		const firstClient = createClient();
		const secondClient = createClient();
		let firstSession: SessionHandle | undefined;
		let secondSession: SessionHandle | undefined;
		try {
			await Promise.all([firstClient.connect(), secondClient.connect()]);
			firstSession = await firstClient.createSession({ cwd: "/workspace" });
			secondSession = await secondClient.attachSession(firstSession.snapshot!.id);
			await executor!.ready;
			const firstEvents: ServerEvent[] = [];
			const secondEvents: ServerEvent[] = [];
			firstSession.onEvent((event) => firstEvents.push(event));
			secondSession.onEvent((event) => secondEvents.push(event));
			await firstSession.prompt("shared prompt");
			await vi.waitFor(() => {
				const sawReply = (events: ServerEvent[]) =>
					events.some(
						(event) =>
							event.type === "session_progress" &&
							event.progress.type === "assistant_delta" &&
							event.progress.kind === "text" &&
							event.progress.delta === "shared reply",
					);
				expect(sawReply(firstEvents)).toBe(true);
				expect(sawReply(secondEvents)).toBe(true);
				expect(
					firstSession?.snapshot?.transcript.some(
						(item) =>
							item.role === "assistant" &&
							item.content.some((part) => part.type === "text" && part.text === "shared reply"),
					),
				).toBe(true);
				expect(
					secondSession?.snapshot?.transcript.some(
						(item) =>
							item.role === "assistant" &&
							item.content.some((part) => part.type === "text" && part.text === "shared reply"),
					),
				).toBe(true);
			});
		} finally {
			await firstSession?.dispose();
			await secondSession?.dispose();
			await firstClient.dispose();
			await secondClient.dispose();
			await server.close();
			await executor?.dispose();
			await bridge?.dispose();
		}
	});
});
