import type { AssistantMessage, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { ByteTransport, ByteTransportFactory } from "@earendil-works/pi-client";
import type {
	ExecutorRuntimeCommand,
	ExecutorToHost,
	HostToExecutor,
	ModelRef,
	SessionSnapshot,
	SnapshotData,
	ThinkingLevel,
	ToolTranscriptItem,
	TranscriptItem,
	TranscriptProgress,
	UserTranscriptItem,
} from "@earendil-works/pi-protocol";
import {
	EXECUTOR_PROTOCOL_VERSION,
	ExecutorProtocolValidationError,
	encodeExecutorToHost,
	HostToExecutorDecoder,
	MAX_EXECUTOR_INBOUND_CHUNK_BYTES,
	MIN_ABORT_CONTROL_BYTES,
	parseExecutorToHost,
} from "@earendil-works/pi-protocol";
import {
	applyTranscriptProgress,
	applyTranscriptSnapshot,
	createTranscriptState,
	selectTranscript,
	summaryToUserMessage,
	type TranscriptState,
	toProtocolAssistantMessage,
	toProtocolJsonValue,
	toProtocolToolResultMessage,
	toProtocolUserMessage,
} from "@earendil-works/pi-session-protocol";
import type { AgentSession, AgentSessionEvent } from "../../coding-agent/src/core/agent-session.ts";
import type { SessionEntry } from "../../coding-agent/src/core/session-manager.ts";
import type { PiHarness } from "./assemble.ts";

export interface ExecutorSessionTimeouts {
	readonly connectTimeoutMs?: number;
	readonly helloTimeoutMs?: number;
	readonly bootstrapTimeoutMs?: number;
}
export interface BrowserExecutorOptions {
	readonly transportFactory: ByteTransportFactory;
	readonly sessionId: string;
	readonly harness: PiHarness;
	readonly flowControl: {
		readonly maxPendingCommands: number;
		readonly maxQueuedOutboundBytes: number;
		readonly maxAbortControlBytes: number;
	};
	readonly timeouts?: ExecutorSessionTimeouts;
	readonly onError?: (error: Error) => void;
}
export interface BrowserSessionCommands {
	prompt(text: string): Promise<void>;
	steer(text: string): Promise<void>;
	abort(): Promise<void>;
	setModel(model: ModelRef): Promise<void>;
	setThinking(level: ThinkingLevel): Promise<void>;
}
export interface BrowserExecutor {
	readonly commands: BrowserSessionCommands;
	readonly ready: Promise<void>;
	reconnect(): Promise<void>;
	dispose(): Promise<void>;
}

export class ExecutorBootstrapError extends Error {
	readonly stage: "transport" | "hello" | "bootstrap" | "snapshot";
	readonly code: "version" | "invalid_request" | "session_locked";
	readonly reason?: "invalid_snapshot" | "timeout";

	constructor(
		stage: ExecutorBootstrapError["stage"],
		code: ExecutorBootstrapError["code"],
		message: string,
		reason?: ExecutorBootstrapError["reason"],
	) {
		super(message);
		this.name = "ExecutorBootstrapError";
		this.stage = stage;
		this.code = code;
		this.reason = reason;
	}
}
class ExecutorCommandError extends Error {
	readonly code: "busy" | "session_locked" | "invalid_request" | "internal_error";
	constructor(code: "busy" | "session_locked" | "invalid_request" | "internal_error", message: string) {
		super(message);
		this.name = "ExecutorCommandError";
		this.code = code;
	}
}
class FrameLimitError extends Error {
	readonly encodedPayloadBytes: number;
	constructor(encodedPayloadBytes: number) {
		super("Encoded executor frame exceeds the protocol frame limit");
		this.name = "FrameLimitError";
		this.encodedPayloadBytes = encodedPayloadBytes;
	}
}

interface OutboundFrame {
	readonly frame: Uint8Array;
	readonly resolve: () => void;
	readonly reject: (error: Error) => void;
}
interface Generation {
	readonly id: string;
	readonly decoder: HostToExecutorDecoder;
	readonly queue: Array<OutboundFrame | undefined>;
	readonly activation: Promise<void>;
	readonly resolveActivation: () => void;
	readonly rejectActivation: (error: Error) => void;
	readonly pendingCommandIds: Set<string>;
	state: "connecting" | "hello" | "bootstrap" | "active" | "closed";
	transport?: ByteTransport;
	rejectOpen?: (error: Error) => void;
	bindingId: string;
	bootstrapSnapshotSent: boolean;
	queuedBytes: number;
	queueHead: number;
	draining: boolean;
	inFlight?: OutboundFrame;
	closed: boolean;
	connectTimer?: ReturnType<typeof setTimeout>;
	helloTimer?: ReturnType<typeof setTimeout>;
	bootstrapTimer?: ReturnType<typeof setTimeout>;
}
interface LiveAssistant {
	readonly id: string;
}
interface LiveTool {
	readonly id: string;
}
interface QueueProjection {
	readonly text: string;
	readonly id: string;
	readonly timestamp: number;
}

const MAX_FRAME_BYTES = MAX_EXECUTOR_INBOUND_CHUNK_BYTES;
const MAX_FRAME_PAYLOAD_BYTES = MAX_FRAME_BYTES - 4;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const asError = (value: unknown): Error => (value instanceof Error ? value : new Error(String(value)));
function makeUuid(): string {
	const randomUUID = globalThis.crypto?.randomUUID;
	if (!randomUUID) throw new Error("BrowserExecutor requires crypto.randomUUID");
	return randomUUID.call(globalThis.crypto);
}
function parseTimestamp(value: string): number {
	const timestamp = Date.parse(value);
	if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new TypeError("Session timestamp is invalid");
	return timestamp;
}
function hasOversizedString(value: unknown, maximumLength: number): boolean {
	if (typeof value === "string") return value.length > maximumLength;
	if (Array.isArray(value)) {
		for (const entry of value as readonly unknown[]) {
			if (hasOversizedString(entry, maximumLength)) return true;
		}
		return false;
	}
	if (typeof value !== "object" || value === null) return false;
	for (const key in value as Record<string, unknown>) {
		if (Object.hasOwn(value, key) && hasOversizedString((value as Record<string, unknown>)[key], maximumLength))
			return true;
	}
	return false;
}
function isAssistantMessage(message: unknown): message is AssistantMessage {
	return typeof message === "object" && message !== null && "role" in message && message.role === "assistant";
}
function sessionSnapshot(data: SnapshotData): SessionSnapshot {
	return { ...data, attached: false, locked: true, revision: 0 };
}
function publicError(error: unknown): {
	code: "busy" | "session_locked" | "invalid_request" | "internal_error";
	message: string;
} {
	if (error instanceof ExecutorCommandError)
		return { code: error.code, message: error.message.slice(0, 500) || "Command failed" };
	return { code: "internal_error", message: "Command failed" };
}

/** Connects one local AgentSession to the Pi-rp executor wire protocol. */
export function startBrowserExecutor(options: BrowserExecutorOptions): BrowserExecutor {
	const session: AgentSession = options.harness.session;
	if (session.sessionId !== options.sessionId)
		throw new Error("BrowserExecutor sessionId must match the harness session");
	if (options.sessionId.length === 0 || new TextEncoder().encode(options.sessionId).byteLength > 128) {
		throw new RangeError("BrowserExecutor sessionId must be between 1 and 128 UTF-8 bytes");
	}
	const { maxPendingCommands, maxQueuedOutboundBytes, maxAbortControlBytes } = options.flowControl;
	if (
		!Number.isSafeInteger(maxPendingCommands) ||
		maxPendingCommands < 2 ||
		!Number.isSafeInteger(maxAbortControlBytes) ||
		maxAbortControlBytes < MAX_FRAME_BYTES + MIN_ABORT_CONTROL_BYTES ||
		!Number.isSafeInteger(maxQueuedOutboundBytes) ||
		maxQueuedOutboundBytes < MAX_FRAME_BYTES + maxAbortControlBytes
	)
		throw new RangeError("Invalid BrowserExecutor flow-control bounds");
	const timeouts = {
		connect: options.timeouts?.connectTimeoutMs ?? 5_000,
		hello: options.timeouts?.helloTimeoutMs ?? 5_000,
		bootstrap: options.timeouts?.bootstrapTimeoutMs ?? 30_000,
	};
	if (
		Object.values(timeouts).some((value) => !Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMER_DELAY_MS)
	) {
		throw new RangeError("Executor timeouts must be positive timer-safe integers");
	}

	let current: Generation | undefined;
	let connectPromise: Promise<void> | undefined;
	let disposed = false;
	let terminal = false;
	let promptPreflight = false;
	let activePrompt = false;
	let extensionBusy = false;
	let abortInFlight = false;
	let ordinaryInFlight = 0;
	let configurationInFlight = false;
	let transcriptState: TranscriptState | undefined;
	let retrying = false;
	let currentAssistant: LiveAssistant | undefined;
	let activeAssistantCalls = new Map<string, ToolCall>();
	let queuedSteerProjection: QueueProjection[] = [];
	const liveTools = new Map<string, LiveTool>();
	const finishedToolCalls = new Set<string>();
	let readySettled = false;
	const readyResolvers = Promise.withResolvers<void>();
	const ready = readyResolvers.promise;
	void ready.catch(() => {});

	const report = (error: unknown): void => {
		try {
			options.onError?.(asError(error));
		} catch {
			/* AgentSession listeners must never leak reporter exceptions. */
		}
	};
	const settleReady = (error?: Error): void => {
		if (readySettled) return;
		readySettled = true;
		if (error) readyResolvers.reject(error);
		else readyResolvers.resolve();
	};
	const clearTimers = (generation: Generation): void => {
		clearTimeout(generation.connectTimer);
		clearTimeout(generation.helloTimer);
		clearTimeout(generation.bootstrapTimer);
		generation.connectTimer = undefined;
		generation.helloTimer = undefined;
		generation.bootstrapTimer = undefined;
	};
	const connectionError = (generation: Generation, message: string): ExecutorBootstrapError =>
		new ExecutorBootstrapError(
			generation.state === "connecting" ? "transport" : generation.state === "hello" ? "hello" : "bootstrap",
			"invalid_request",
			message,
		);
	const closeTransport = (transport: ByteTransport | undefined): void => {
		if (!transport) return;
		try {
			transport.close();
		} catch (error) {
			report(error);
		}
	};
	const failGeneration = (
		generation: Generation,
		error: Error,
		opts: { terminal?: boolean; report?: boolean } = {},
	): void => {
		if (generation.closed) return;
		generation.closed = true;
		generation.state = "closed";
		clearTimers(generation);
		if (current === generation) current = undefined;
		generation.rejectOpen?.(error);
		generation.rejectOpen = undefined;
		generation.queuedBytes = 0;
		const pending: OutboundFrame[] = [];
		for (let index = generation.queueHead; index < generation.queue.length; index++) {
			const frame = generation.queue[index];
			if (frame) pending.push(frame);
		}
		generation.queue.length = 0;
		generation.queueHead = 0;
		if (generation.inFlight) pending.push(generation.inFlight);
		generation.inFlight = undefined;
		for (const frame of pending) frame.reject(error);
		generation.pendingCommandIds.clear();
		closeTransport(generation.transport);
		generation.transport = undefined;
		generation.rejectActivation(error);
		if (!readySettled) settleReady(error);
		if (opts.terminal) terminal = true;
		if (opts.report !== false) report(error);
	};
	const verifyLogicalSession = (): void => {
		if (session.sessionId === options.sessionId) return;
		const error = new ExecutorBootstrapError("snapshot", "session_locked", "Browser session identity changed");
		if (current && !current.closed) failGeneration(current, error, { terminal: true });
		else terminal = true;
		throw error;
	};
	const verifySession = (generation: Generation, allowChangedClose = false): void => {
		if (session.sessionId === options.sessionId || allowChangedClose) return;
		const error = new ExecutorBootstrapError("snapshot", "session_locked", "Browser session identity changed");
		failGeneration(generation, error, { terminal: true });
		throw error;
	};
	const currentIdentity = (generation: Generation, allowChangedClose = false) => {
		verifySession(generation, allowChangedClose);
		return { sessionId: options.sessionId, bindingId: generation.bindingId, generationId: generation.id };
	};
	const reconcileQueuedSteer = (queued: readonly string[]): UserTranscriptItem[] => {
		const previous = queuedSteerProjection;
		const appends = queued.length >= previous.length && previous.every((item, index) => item.text === queued[index]);
		const drains =
			queued.length <= previous.length &&
			queued.every((text, index) => text === previous[previous.length - queued.length + index]?.text);
		if (appends) {
			queuedSteerProjection = [
				...previous,
				...queued
					.slice(previous.length)
					.map((text) => ({ text, id: `queued-${makeUuid()}`, timestamp: Date.now() })),
			];
		} else if (drains) {
			queuedSteerProjection = previous.slice(previous.length - queued.length);
		} else {
			queuedSteerProjection = queued.map((text) => ({ text, id: `queued-${makeUuid()}`, timestamp: Date.now() }));
		}
		return queuedSteerProjection.map(({ text, id, timestamp }) => ({
			id,
			role: "user" as const,
			content: [{ type: "text" as const, text }],
			timestamp,
		}));
	};
	const sessionRetrying = (): boolean => retrying || session.isRetrying || session.retryAttempt > 0;
	const projectContext = (): { data: SnapshotData; calls: Map<string, ToolCall> } => {
		verifyLogicalSession();
		const header = session.sessionManager.getHeader();
		if (!header) throw new TypeError("Session header is missing");
		const entries = session.sessionManager.buildContextEntries();
		const transcript: TranscriptItem[] = [];
		// Protocol v1 omits custom/extension messages, bash entries, and other local-only journal records.
		const calls = new Map<string, ToolCall>();
		for (const entry of entries) {
			if (entry.type === "message") {
				const message = entry.message;
				if (message.role === "user") transcript.push(toProtocolUserMessage(message, { id: entry.id }));
				else if (message.role === "assistant") {
					transcript.push(toProtocolAssistantMessage(message, { id: entry.id }));
					for (const part of message.content) if (part.type === "toolCall") calls.set(part.id, part);
				} else if (message.role === "toolResult") {
					const call = calls.get(message.toolCallId);
					if (!call) throw new TypeError("Tool result has no preceding active-context assistant call");
					transcript.push(toProtocolToolResultMessage(message, { id: entry.id, call }));
				}
			} else if (entry.type === "compaction") {
				transcript.push(
					summaryToUserMessage({
						id: entry.id,
						timestamp: parseTimestamp(entry.timestamp),
						kind: "compaction",
						summary: entry.summary,
					}),
				);
			} else if (entry.type === "branch_summary") {
				transcript.push(
					summaryToUserMessage({
						id: entry.id,
						timestamp: parseTimestamp(entry.timestamp),
						kind: "branch",
						summary: entry.summary,
					}),
				);
			}
		}
		const model = session.model;
		if (!model) throw new TypeError("Session has no active model");
		const queuedSteer = session.getSteeringMessages();
		const lastEntry: SessionEntry | undefined = entries.at(-1);
		return {
			data: {
				id: options.sessionId,
				name: session.sessionManager.getSessionName(),
				cwd: session.sessionManager.getCwd(),
				createdAt: parseTimestamp(header.timestamp),
				updatedAt: lastEntry ? parseTimestamp(lastEntry.timestamp) : parseTimestamp(header.timestamp),
				phase: sessionRetrying()
					? "retry"
					: session.isCompacting
						? "compaction"
						: session.isStreaming
							? "turn"
							: "idle",
				model: { provider: model.provider, id: model.id },
				thinkingLevel: session.thinkingLevel,
				transcript,
				queuedSteer: reconcileQueuedSteer(queuedSteer),
				queuedSteerCount: queuedSteer.length,
			},
			calls,
		};
	};
	const snapshotWithLocalFlags = (data: SnapshotData): SessionSnapshot => ({
		...data,
		attached: false,
		locked: true,
		revision: 0,
	});
	const createLiveToolItem = (call: ToolCall, id: string): ToolTranscriptItem => ({
		id,
		role: "tool",
		toolCallId: call.id,
		toolName: call.name,
		input: toProtocolJsonValue(call.arguments),
		content: [],
		timestamp: Date.now(),
		status: "running",
		isError: false,
	});
	const initializeTranscriptState = (): void => {
		const { data, calls } = projectContext();
		let nextState = createTranscriptState(snapshotWithLocalFlags(data));
		const nextCalls = new Map(calls);
		let nextAssistant: LiveAssistant | undefined;
		const partial = session.agent.state.streamingMessage;
		if (isAssistantMessage(partial)) {
			const id = `live-${makeUuid()}`;
			nextAssistant = { id };
			nextState = applyTranscriptProgress(nextState, {
				type: "item_started",
				item: toProtocolAssistantMessage({ ...partial, stopReason: "pending" }, { id }),
			});
			for (const part of partial.content) if (part.type === "toolCall") nextCalls.set(part.id, part);
		}
		const nextTools = new Map<string, LiveTool>();
		for (const callId of session.agent.state.pendingToolCalls) {
			const call = nextCalls.get(callId);
			if (!call) throw new TypeError("Pending tool call has no preceding assistant tool call");
			const id = `tool-${makeUuid()}`;
			nextState = applyTranscriptProgress(nextState, { type: "item_started", item: createLiveToolItem(call, id) });
			nextTools.set(callId, { id });
		}
		transcriptState = nextState;
		activeAssistantCalls = nextCalls;
		currentAssistant = nextAssistant;
		liveTools.clear();
		for (const [callId, tool] of nextTools) liveTools.set(callId, tool);
		finishedToolCalls.clear();
	};
	const materializeSnapshot = (): SnapshotData => {
		verifyLogicalSession();
		if (!transcriptState) initializeTranscriptState();
		const { data } = projectContext();
		if (session.isStreaming || session.isCompacting || sessionRetrying()) {
			// Refresh snapshot fields while preserving the reducer overlay and partial tool JSON buffers.
			transcriptState = {
				...transcriptState!,
				snapshot: { ...snapshotWithLocalFlags(data), transcript: transcriptState!.snapshot.transcript },
			};
		} else {
			transcriptState = applyTranscriptSnapshot(transcriptState!, snapshotWithLocalFlags(data));
		}
		return { ...data, transcript: [...selectTranscript(transcriptState!)] };
	};

	const createGeneration = (): Generation => {
		const {
			promise: activation,
			resolve: resolveActivation,
			reject: rejectActivation,
		} = Promise.withResolvers<void>();
		void activation.catch(() => {});
		return {
			id: makeUuid(),
			decoder: new HostToExecutorDecoder(),
			queue: [],
			queueHead: 0,
			activation,
			resolveActivation,
			rejectActivation,
			pendingCommandIds: new Set(),
			state: "connecting",
			bindingId: "",
			queuedBytes: 0,
			draining: false,
			closed: false,
			bootstrapSnapshotSent: false,
		};
	};
	const drainWrites = (generation: Generation): void => {
		if (generation.draining || generation.closed || !generation.transport) return;
		generation.draining = true;
		void (async () => {
			try {
				while (!generation.closed && generation.transport && generation.queueHead < generation.queue.length) {
					const queueIndex = generation.queueHead++;
					const entry = generation.queue[queueIndex]!;
					generation.queue[queueIndex] = undefined;
					generation.inFlight = entry;
					try {
						await generation.transport.send(entry.frame);
						if (!generation.closed) entry.resolve();
					} catch (error) {
						entry.reject(asError(error));
						failGeneration(generation, asError(error));
						return;
					} finally {
						if (generation.inFlight === entry) generation.inFlight = undefined;
						if (!generation.closed) generation.queuedBytes -= entry.frame.byteLength;
					}
				}
			} finally {
				if (generation.queueHead === generation.queue.length) {
					generation.queue.length = 0;
					generation.queueHead = 0;
				}
				generation.draining = false;
				if (!generation.closed && generation.queueHead < generation.queue.length) drainWrites(generation);
			}
		})();
	};
	const enqueue = (
		generation: Generation,
		message: ExecutorToHost,
		control = false,
		allowDisposing = false,
	): Promise<void> => {
		if (generation.closed || current !== generation || (!allowDisposing && disposed)) {
			throw new ExecutorCommandError("session_locked", "Executor transport is unavailable");
		}
		if (!(message.type === "executor_close" && message.reason === "session_changed")) {
			verifySession(generation, allowDisposing && message.type === "executor_close");
		}
		parseExecutorToHost(message);
		if (hasOversizedString(message, MAX_FRAME_PAYLOAD_BYTES)) throw new FrameLimitError(MAX_FRAME_PAYLOAD_BYTES + 1);
		let frame: Uint8Array;
		try {
			frame = encodeExecutorToHost(message, { maxFrameLength: MAX_FRAME_PAYLOAD_BYTES });
		} catch (error) {
			if (error instanceof ExecutorProtocolValidationError) throw new FrameLimitError(MAX_FRAME_PAYLOAD_BYTES + 1);
			throw error;
		}
		const maxFrameBytes = Math.min(MAX_FRAME_BYTES, maxQueuedOutboundBytes);
		if (frame.byteLength > maxFrameBytes) throw new FrameLimitError(frame.byteLength - 4);
		const ordinaryLimit = maxQueuedOutboundBytes - maxAbortControlBytes;
		if (
			generation.queuedBytes > maxQueuedOutboundBytes - frame.byteLength ||
			(!control && generation.queuedBytes > ordinaryLimit - frame.byteLength)
		) {
			throw new ExecutorCommandError("busy", "Executor outbound queue is full");
		}
		generation.queuedBytes += frame.byteLength;
		const write = Promise.withResolvers<void>();
		generation.queue.push({ frame, resolve: write.resolve, reject: write.reject });
		drainWrites(generation);
		return write.promise;
	};
	const sendControlMessage = async (generation: Generation, message: ExecutorToHost): Promise<void> => {
		await enqueue(generation, message, true);
	};
	const rejectOversizedSnapshot = async (
		generation: Generation,
		scope: "bootstrap" | "runtime_snapshot" | "command_result",
		commandId?: string,
		error?: FrameLimitError,
	): Promise<void> => {
		const rejection = {
			type: "executor_snapshot_rejected" as const,
			...currentIdentity(generation),
			code: "invalid_snapshot" as const,
			encodedPayloadBytes: error?.encodedPayloadBytes ?? MAX_FRAME_PAYLOAD_BYTES + 1,
			maxPayloadBytes: MAX_FRAME_PAYLOAD_BYTES,
			message: "Snapshot exceeds the executor frame limit",
		};
		if (scope === "command_result") {
			if (!commandId) throw new TypeError("Command snapshot rejection requires a command ID");
			await sendControlMessage(generation, { ...rejection, scope, commandId });
		} else {
			await sendControlMessage(generation, { ...rejection, scope });
		}
		if (scope === "bootstrap") {
			failGeneration(
				generation,
				new ExecutorBootstrapError("bootstrap", "invalid_request", rejection.message, "invalid_snapshot"),
				{ report: false },
			);
		}
	};
	const sendRuntimeError = async (generation: Generation, cause: unknown): Promise<void> => {
		report(cause);
		const bootstrapFailure =
			generation.state === "connecting" || generation.state === "hello" || generation.state === "bootstrap";
		if (generation.state === "bootstrap" || generation.state === "active") {
			try {
				await sendControlMessage(generation, {
					type: "runtime_error",
					...currentIdentity(generation),
					error: {
						code: "invalid_snapshot",
						message:
							cause instanceof FrameLimitError
								? "Transcript progress exceeds the executor frame limit"
								: "The active session state cannot be projected",
					},
				});
			} catch (sendError) {
				report(sendError);
			}
		}
		const failure = bootstrapFailure
			? new ExecutorBootstrapError(
					"bootstrap",
					"invalid_request",
					"Initial session snapshot is invalid",
					"invalid_snapshot",
				)
			: asError(cause);
		failGeneration(generation, failure, { report: false });
	};
	const handleWriteFailure = (generation: Generation, error: unknown): void => {
		report(error);
		if (!generation.closed) failGeneration(generation, asError(error), { report: false });
	};
	const sendProgress = (progress: TranscriptProgress): void => {
		if (!transcriptState) return;
		transcriptState = applyTranscriptProgress(transcriptState, progress);
		const generation = current;
		if (!generation || generation.closed || (generation.state !== "bootstrap" && generation.state !== "active"))
			return;
		try {
			void enqueue(generation, { type: "runtime_progress", ...currentIdentity(generation), progress }).catch(
				(error: unknown) => {
					if (error instanceof FrameLimitError) {
						void sendRuntimeError(generation, error).catch((sendError: unknown) =>
							handleWriteFailure(generation, sendError),
						);
					} else handleWriteFailure(generation, error);
				},
			);
		} catch (error) {
			if (error instanceof FrameLimitError) {
				void sendRuntimeError(generation, error).catch((sendError: unknown) =>
					handleWriteFailure(generation, sendError),
				);
			} else handleWriteFailure(generation, error);
		}
	};
	const publishSnapshot = async (
		generation: Generation,
		scope: "bootstrap" | "runtime_snapshot" = "runtime_snapshot",
	): Promise<void> => {
		if (generation.closed || current !== generation) return;
		let snapshot: SnapshotData;
		try {
			verifySession(generation);
			snapshot = materializeSnapshot();
		} catch (error) {
			await sendRuntimeError(generation, error);
			return;
		}
		const message: ExecutorToHost = { type: "runtime_snapshot", ...currentIdentity(generation), snapshot };
		try {
			if (scope === "bootstrap") generation.bootstrapSnapshotSent = true;
			await enqueue(generation, message);
		} catch (error) {
			if (error instanceof FrameLimitError) await rejectOversizedSnapshot(generation, scope, undefined, error);
			else throw error;
		}
	};

	const updateAssistantCalls = (message: AssistantMessage): void => {
		for (const part of message.content) if (part.type === "toolCall") activeAssistantCalls.set(part.id, part);
	};
	const streamingAssistantItem = (message: AssistantMessage, id: string) =>
		toProtocolAssistantMessage({ ...message, stopReason: "pending" }, { id });
	const startLiveTool = (call: ToolCall): void => {
		if (!transcriptState || liveTools.has(call.id)) return;
		const id = `tool-${makeUuid()}`;
		const item: ToolTranscriptItem = {
			id,
			role: "tool",
			toolCallId: call.id,
			toolName: call.name,
			input: toProtocolJsonValue(call.arguments),
			content: [],
			timestamp: Date.now(),
			status: "running",
			isError: false,
		};
		liveTools.set(call.id, { id });
		sendProgress({ type: "item_started", item });
	};
	const finishLiveTool = (message: ToolResultMessage): void => {
		if (!transcriptState) return;
		const call = activeAssistantCalls.get(message.toolCallId);
		if (!call) throw new TypeError("Tool result has no preceding assistant tool call");
		const live = liveTools.get(message.toolCallId);
		const item = toProtocolToolResultMessage(message, { id: live?.id ?? `tool-${makeUuid()}`, call });
		liveTools.delete(message.toolCallId);
		finishedToolCalls.add(message.toolCallId);
		sendProgress({ type: "item_finished", item });
	};
	const publishIfConnected = (
		generation: Generation | undefined,
		scope: "bootstrap" | "runtime_snapshot" = "runtime_snapshot",
	): void => {
		if (!generation || generation.closed || (generation.state !== "active" && generation.state !== "bootstrap"))
			return;
		void publishSnapshot(generation, scope).catch((error: unknown) => handleWriteFailure(generation, error));
	};
	const emitAgentEvent = (event: AgentSessionEvent): void => {
		try {
			if (disposed || terminal) return;
			verifyLogicalSession();
			if (!transcriptState) initializeTranscriptState();
			if (event.type === "message_start") {
				if (event.message.role === "user") {
					sendProgress({
						type: "item_started",
						item: toProtocolUserMessage(event.message, { id: `user-${makeUuid()}` }),
					});
				} else if (event.message.role === "assistant") {
					const id = `live-${makeUuid()}`;
					currentAssistant = { id };
					activeAssistantCalls = new Map();
					updateAssistantCalls(event.message);
					sendProgress({ type: "item_started", item: streamingAssistantItem(event.message, id) });
				}
				return;
			}
			if (event.type === "message_update" && isAssistantMessage(event.message)) {
				if (!currentAssistant) currentAssistant = { id: `live-${makeUuid()}` };
				updateAssistantCalls(event.message);
				const update = event.assistantMessageEvent;
				if (update.type === "text_delta") {
					sendProgress({
						type: "assistant_delta",
						messageId: currentAssistant.id,
						contentIndex: update.contentIndex,
						kind: "text",
						delta: update.delta,
					});
				} else if (update.type === "thinking_delta") {
					sendProgress({
						type: "assistant_delta",
						messageId: currentAssistant.id,
						contentIndex: update.contentIndex,
						kind: "thinking",
						delta: update.delta,
					});
				} else if (update.type === "toolcall_delta") {
					sendProgress({
						type: "assistant_delta",
						messageId: currentAssistant.id,
						contentIndex: update.contentIndex,
						kind: "toolCall",
						delta: update.delta,
					});
				} else {
					sendProgress({ type: "item_updated", item: streamingAssistantItem(event.message, currentAssistant.id) });
				}
				return;
			}
			if (event.type === "message_end") {
				if (isAssistantMessage(event.message)) {
					if (!currentAssistant) currentAssistant = { id: `live-${makeUuid()}` };
					updateAssistantCalls(event.message);
					const item = toProtocolAssistantMessage(event.message, { id: currentAssistant.id });
					if (item.status === "streaming") throw new TypeError("Finished assistant message is still streaming");
					sendProgress({ type: "item_finished", item });
					currentAssistant = undefined;
				} else if (event.message.role === "toolResult" && !finishedToolCalls.has(event.message.toolCallId)) {
					finishLiveTool(event.message);
				}
				return;
			}
			if (event.type === "tool_execution_start") {
				const call = activeAssistantCalls.get(event.toolCallId);
				if (!call || call.name !== event.toolName)
					throw new TypeError("Tool execution has no matching assistant tool call");
				startLiveTool(call);
				return;
			}
			if (event.type === "tool_execution_update") {
				// Updates are cumulative AgentToolResult payloads; protocol v1 has no tool-content delta.
				return;
			}
			if (event.type === "tool_execution_end") {
				if (finishedToolCalls.has(event.toolCallId)) return;
				const call = activeAssistantCalls.get(event.toolCallId);
				if (!call || call.name !== event.toolName)
					throw new TypeError("Tool result has no matching assistant tool call");
				const message: ToolResultMessage = {
					role: "toolResult",
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					content: event.result.content ?? [],
					details: event.result.details,
					usage: event.result.usage,
					isError: event.isError,
					timestamp: Date.now(),
				};
				finishLiveTool(message);
				return;
			}
			if (event.type === "agent_end") retrying = event.willRetry;
			else if (
				event.type === "auto_retry_start" ||
				event.type === "summarization_retry_scheduled" ||
				event.type === "summarization_retry_attempt_start"
			)
				retrying = true;
			else if (
				event.type === "auto_retry_end" ||
				event.type === "summarization_retry_finished" ||
				event.type === "agent_settled"
			)
				retrying = false;
			if (event.type === "agent_settled") {
				currentAssistant = undefined;
				activeAssistantCalls.clear();
				liveTools.clear();
				finishedToolCalls.clear();
				const generation = current;
				if (generation && !generation.closed) publishIfConnected(generation);
				else {
					const snapshot = sessionSnapshot(projectContext().data);
					transcriptState = transcriptState
						? applyTranscriptSnapshot(transcriptState, snapshot)
						: createTranscriptState(snapshot);
				}
				return;
			}
			if (
				event.type === "queue_update" ||
				event.type === "entry_appended" ||
				event.type === "entry_edited" ||
				event.type === "session_info_changed" ||
				event.type === "thinking_level_changed" ||
				event.type === "compaction_start" ||
				event.type === "compaction_end" ||
				event.type === "leaf_changed" ||
				event.type === "turn_start" ||
				event.type === "turn_end" ||
				event.type === "agent_start" ||
				event.type === "agent_end" ||
				event.type === "auto_retry_start" ||
				event.type === "auto_retry_end" ||
				event.type === "summarization_retry_scheduled" ||
				event.type === "summarization_retry_attempt_start" ||
				event.type === "summarization_retry_finished"
			) {
				const generation = current;
				if (generation && !generation.closed) publishIfConnected(generation);
				else if (!session.isStreaming && !session.isCompacting && !sessionRetrying()) {
					const { data } = projectContext();
					if (transcriptState) transcriptState = applyTranscriptSnapshot(transcriptState, sessionSnapshot(data));
				}
			}
		} catch (error) {
			const generation = current;
			if (generation && !generation.closed) {
				void sendRuntimeError(generation, error).catch((sendError: unknown) => {
					report(sendError);
					failGeneration(generation, asError(error), { report: false });
				});
			} else {
				report(error);
				if (!session.isStreaming && !session.isCompacting && !sessionRetrying()) {
					try {
						const { data } = projectContext();
						if (transcriptState)
							transcriptState = applyTranscriptSnapshot(transcriptState, sessionSnapshot(data));
					} catch (projectionError) {
						report(projectionError);
					}
				}
			}
		}
	};

	const ensureUsable = (): void => {
		if (disposed || terminal) throw new ExecutorCommandError("session_locked", "BrowserExecutor is not available");
		if (session.sessionId !== options.sessionId) {
			const generation = current;
			if (generation && !generation.closed)
				failGeneration(generation, new Error("Browser session identity changed"), { terminal: true });
			else terminal = true;
			throw new ExecutorCommandError("session_locked", "Browser session identity changed");
		}
	};
	const reserveOrdinary = (): void => {
		ensureUsable();
		if (ordinaryInFlight >= maxPendingCommands)
			throw new ExecutorCommandError("busy", "Too many pending executor commands");
		ordinaryInFlight++;
	};
	const runPrompt = async (text: string): Promise<void> => {
		reserveOrdinary();
		if (
			promptPreflight ||
			activePrompt ||
			extensionBusy ||
			configurationInFlight ||
			session.isStreaming ||
			session.isCompacting ||
			sessionRetrying()
		) {
			ordinaryInFlight--;
			throw new ExecutorCommandError("busy", "A prompt is already active or the session is not idle");
		}
		promptPreflight = true;
		let accepted = false;
		const extensionCandidate = text.trimStart().startsWith("/");
		try {
			await session.prompt(text, {
				preflightResult: (ok: boolean) => {
					if (!ok) return;
					accepted = true;
					promptPreflight = false;
					activePrompt = true;
					if (extensionCandidate) extensionBusy = true;
				},
			});
			if (!accepted) throw new ExecutorCommandError("invalid_request", "Prompt was not accepted by the session");
		} finally {
			promptPreflight = false;
			activePrompt = false;
			if (extensionCandidate) extensionBusy = false;
			ordinaryInFlight--;
		}
	};
	const runSteer = async (text: string): Promise<void> => {
		reserveOrdinary();
		try {
			ensureUsable();
			await session.steer(text);
		} finally {
			ordinaryInFlight--;
		}
	};
	const runAbort = async (): Promise<void> => {
		ensureUsable();
		if (abortInFlight || promptPreflight || extensionBusy) {
			throw new ExecutorCommandError(
				"busy",
				"Abort is unavailable during prompt preflight or a non-cancellable extension command",
			);
		}
		abortInFlight = true;
		try {
			await session.abort();
		} finally {
			abortInFlight = false;
		}
	};
	const runSetModel = async (modelRef: ModelRef): Promise<void> => {
		reserveOrdinary();
		let ownsConfigurationSlot = false;
		try {
			if (
				configurationInFlight ||
				promptPreflight ||
				activePrompt ||
				extensionBusy ||
				session.isStreaming ||
				session.isCompacting ||
				sessionRetrying()
			) {
				throw new ExecutorCommandError("busy", "Model cannot be changed while the session is active");
			}
			const model = session.modelRuntime.getModel(modelRef.provider, modelRef.id);
			if (!model) throw new ExecutorCommandError("invalid_request", "Requested model is not available");
			configurationInFlight = true;
			ownsConfigurationSlot = true;
			await session.setModel(model, false);
		} finally {
			if (ownsConfigurationSlot) configurationInFlight = false;
			ordinaryInFlight--;
		}
	};
	const runSetThinking = async (level: ThinkingLevel): Promise<void> => {
		reserveOrdinary();
		let ownsConfigurationSlot = false;
		try {
			if (
				configurationInFlight ||
				promptPreflight ||
				activePrompt ||
				extensionBusy ||
				session.isStreaming ||
				session.isCompacting ||
				sessionRetrying()
			) {
				throw new ExecutorCommandError("busy", "Thinking level cannot be changed while the session is active");
			}
			if (!session.getAvailableThinkingLevels().includes(level))
				throw new ExecutorCommandError("invalid_request", "Thinking level is not available");
			configurationInFlight = true;
			ownsConfigurationSlot = true;
			session.setThinkingLevel(level, false);
		} finally {
			if (ownsConfigurationSlot) configurationInFlight = false;
			ordinaryInFlight--;
		}
	};
	const runRuntimeCommand = (command: ExecutorRuntimeCommand): Promise<void> => {
		switch (command.command) {
			case "prompt":
				return runPrompt(command.text);
			case "steer":
				return runSteer(command.text);
			case "abort":
				return runAbort();
			case "set_model":
				return runSetModel(command.model);
			case "set_thinking":
				return runSetThinking(command.thinkingLevel);
		}
	};
	const sendCommandFailure = async (
		generation: Generation,
		commandId: string,
		cause: unknown,
		control: boolean,
	): Promise<void> => {
		const result: ExecutorToHost = {
			type: "runtime_command_result",
			...currentIdentity(generation),
			commandId,
			ok: false,
			error: publicError(cause),
		};
		await enqueue(generation, result, control);
	};
	const handleRuntimeCommand = (generation: Generation, commandId: string, command: ExecutorRuntimeCommand): void => {
		if (generation.closed || current !== generation) return;
		if (generation.pendingCommandIds.has(commandId)) {
			failGeneration(generation, new Error("Executor commandId was reused while pending"), { terminal: true });
			return;
		}
		generation.pendingCommandIds.add(commandId);
		const abortControl = command.command === "abort";
		void (async () => {
			try {
				await runRuntimeCommand(command);
				if (generation.closed || current !== generation || generation.state !== "active") return;
				const snapshot = materializeSnapshot();
				const result: ExecutorToHost = {
					type: "runtime_command_result",
					...currentIdentity(generation),
					commandId,
					ok: true,
					snapshot,
				};
				try {
					await enqueue(generation, result, abortControl);
				} catch (error) {
					if (error instanceof FrameLimitError)
						await rejectOversizedSnapshot(generation, "command_result", commandId, error);
					else throw error;
				}
			} catch (error) {
				if (!generation.closed && current === generation)
					await sendCommandFailure(generation, commandId, error, abortControl);
			} finally {
				generation.pendingCommandIds.delete(commandId);
			}
		})().catch((error: unknown) => {
			report(error);
			if (!generation.closed) failGeneration(generation, asError(error));
		});
	};

	const handleMessage = (generation: Generation, message: HostToExecutor): void => {
		if (generation.closed || current !== generation) return;
		if (message.type === "executor_ready") {
			if (
				generation.state !== "hello" ||
				message.sessionId !== options.sessionId ||
				message.generationId !== generation.id
			) {
				failGeneration(
					generation,
					new ExecutorBootstrapError(
						"hello",
						"invalid_request",
						"Invalid executor_ready identity or handshake stage",
					),
					{ terminal: true },
				);
				return;
			}
			verifySession(generation);
			generation.bindingId = message.bindingId;
			generation.state = "bootstrap";
			clearTimeout(generation.helloTimer);
			generation.bootstrapTimer = setTimeout(() => {
				failGeneration(
					generation,
					new ExecutorBootstrapError("bootstrap", "invalid_request", "Executor bootstrap timed out", "timeout"),
					{ report: false },
				);
			}, timeouts.bootstrap);
			publishIfConnected(generation, "bootstrap");
			return;
		}
		if (message.type === "executor_reject") {
			const invalidStage =
				(message.stage === "hello" && generation.state !== "hello") ||
				(message.stage === "bootstrap" &&
					(generation.state !== "bootstrap" || message.bindingId !== generation.bindingId)) ||
				(message.stage === "snapshot" &&
					((generation.state !== "bootstrap" && generation.state !== "active") ||
						message.bindingId !== generation.bindingId));
			if (message.sessionId !== options.sessionId || message.generationId !== generation.id || invalidStage) {
				failGeneration(generation, new Error("Invalid executor_reject identity or stage"), { terminal: true });
				return;
			}
			const stage = message.stage === "hello" ? "hello" : message.stage === "bootstrap" ? "bootstrap" : "snapshot";
			failGeneration(generation, new ExecutorBootstrapError(stage, message.code, message.message, message.reason), {
				terminal: message.code === "version",
				report: false,
			});
			return;
		}
		if (message.type === "bootstrap_ack") {
			if (
				generation.state !== "bootstrap" ||
				!generation.bootstrapSnapshotSent ||
				message.sessionId !== options.sessionId ||
				message.bindingId !== generation.bindingId ||
				message.generationId !== generation.id
			) {
				failGeneration(
					generation,
					new ExecutorBootstrapError("bootstrap", "invalid_request", "Invalid bootstrap_ack identity or stage"),
					{ terminal: true },
				);
				return;
			}
			verifySession(generation);
			clearTimeout(generation.bootstrapTimer);
			generation.state = "active";
			generation.resolveActivation();
			settleReady();
			return;
		}
		if (message.type === "runtime_command") {
			if (
				message.sessionId !== options.sessionId ||
				message.bindingId !== generation.bindingId ||
				message.generationId !== generation.id
			) {
				failGeneration(generation, new Error("Invalid runtime_command identity"), { terminal: true });
				return;
			}
			if (generation.state !== "active") {
				failGeneration(generation, new Error("runtime_command received before bootstrap completed"), {
					terminal: true,
				});
				return;
			}
			handleRuntimeCommand(generation, message.commandId, message.command);
			return;
		}
		if (message.type === "runtime_close") {
			if (
				message.sessionId !== options.sessionId ||
				message.bindingId !== generation.bindingId ||
				message.generationId !== generation.id
			) {
				failGeneration(generation, new Error("Invalid runtime_close identity"), { terminal: true });
				return;
			}
			failGeneration(generation, new Error(`Executor binding closed: ${message.reason}`), {
				terminal: true,
				report: false,
			});
		}
	};
	const handleChunk = (generation: Generation, chunk: Uint8Array): void => {
		if (generation.closed || current !== generation || chunk.byteLength === 0) return;
		if (chunk.byteLength > MAX_FRAME_BYTES) {
			failGeneration(generation, connectionError(generation, "Executor input chunk exceeds the protocol limit"));
			return;
		}
		if (generation.state === "connecting") {
			failGeneration(
				generation,
				connectionError(generation, "Executor transport delivered data before the hello handshake"),
				{ terminal: true },
			);
			return;
		}
		try {
			generation.decoder.pushEach(chunk, (message) => handleMessage(generation, message));
		} catch (error) {
			const failure =
				generation.state === "active"
					? asError(error)
					: connectionError(generation, "Executor protocol message was invalid");
			failGeneration(generation, failure, { terminal: true });
		}
	};
	const beginConnect = async (): Promise<void> => {
		if (disposed || terminal) throw new ExecutorCommandError("session_locked", "BrowserExecutor cannot reconnect");
		verifyLogicalSession();
		const generation = createGeneration();
		current = generation;
		const openResolvers = Promise.withResolvers<ByteTransport>();
		const open = openResolvers.promise;
		generation.rejectOpen = openResolvers.reject;
		const handlers = {
			onData: (chunk: Uint8Array) => handleChunk(generation, chunk),
			onClose: () => {
				const error =
					generation.state === "active"
						? new Error("Executor transport closed")
						: connectionError(generation, "Executor transport closed");
				failGeneration(generation, error, { report: false });
			},
			onError: (error: Error) => {
				report(error);
				const failure =
					generation.state === "active" ? error : connectionError(generation, "Executor transport failed");
				failGeneration(generation, failure, { report: false });
			},
		};
		generation.connectTimer = setTimeout(() => {
			const error = new ExecutorBootstrapError(
				"transport",
				"invalid_request",
				"Executor transport connection timed out",
				"timeout",
			);
			openResolvers.reject(error);
			failGeneration(generation, error, { report: false });
		}, timeouts.connect);
		let factoryPromise: Promise<ByteTransport>;
		try {
			factoryPromise = Promise.resolve(options.transportFactory(handlers));
		} catch (error) {
			factoryPromise = Promise.reject(error);
		}
		void factoryPromise
			.then((transport) => {
				if (generation.closed || current !== generation || disposed) {
					closeTransport(transport);
					return;
				}
				generation.transport = transport;
				clearTimeout(generation.connectTimer);
				generation.connectTimer = undefined;
				generation.state = "hello";
				generation.helloTimer = setTimeout(() => {
					failGeneration(
						generation,
						new ExecutorBootstrapError("hello", "invalid_request", "Executor hello timed out", "timeout"),
						{ report: false },
					);
				}, timeouts.hello);
				generation.rejectOpen = undefined;
				openResolvers.resolve(transport);
				const hello: ExecutorToHost = {
					type: "executor_hello",
					version: EXECUTOR_PROTOCOL_VERSION,
					sessionId: options.sessionId,
					generationId: generation.id,
				};
				try {
					void enqueue(generation, hello).catch((error: unknown) => failGeneration(generation, asError(error)));
				} catch (error) {
					failGeneration(generation, asError(error), { terminal: true });
				}
			})
			.catch((error: unknown) => {
				const failure = new ExecutorBootstrapError(
					"transport",
					"invalid_request",
					"Executor transport could not be created",
				);
				openResolvers.reject(failure);
				failGeneration(generation, failure, { report: false });
				report(error);
			});
		await open;
		return generation.activation;
	};
	const connect = (): Promise<void> => {
		if (disposed || terminal)
			return Promise.reject(new ExecutorCommandError("session_locked", "BrowserExecutor cannot reconnect"));
		try {
			verifyLogicalSession();
		} catch (error) {
			return Promise.reject(asError(error));
		}
		if (current && !current.closed && current.state === "active") return Promise.resolve();
		if (connectPromise && current && !current.closed) return connectPromise;
		let wrapped!: Promise<void>;
		wrapped = beginConnect().finally(() => {
			if (connectPromise === wrapped) connectPromise = undefined;
		});
		connectPromise = wrapped;
		return wrapped;
	};

	const unsubscribe = session.subscribe(emitAgentEvent);
	if (!transcriptState) {
		try {
			initializeTranscriptState();
		} catch (error) {
			report(error);
		}
	}

	const commands: BrowserSessionCommands = {
		prompt: (text) => runPrompt(text),
		steer: (text) => runSteer(text),
		abort: () => runAbort(),
		setModel: async (model) => {
			await runSetModel(model);
			publishIfConnected(current);
		},
		setThinking: (level) => runSetThinking(level),
	};
	void connect().catch((error: unknown) => {
		const normalized = asError(error);
		report(normalized);
		settleReady(normalized);
	});

	return {
		commands,
		ready,
		reconnect: () => connect(),
		dispose: async () => {
			if (disposed) return;
			disposed = true;
			try {
				unsubscribe();
			} catch (error) {
				report(error);
			}
			const generation = current;
			if (generation && !generation.closed && generation.state === "active" && generation.bindingId) {
				try {
					void enqueue(
						generation,
						{
							type: "executor_close",
							...currentIdentity(generation, true),
							reason: session.sessionId === options.sessionId ? "disposed" : "session_changed",
						},
						true,
						true,
					).catch((error: unknown) => {
						if (!generation.closed) report(error);
					});
				} catch (error) {
					report(error);
				}
			}
			if (generation && !generation.closed)
				failGeneration(generation, new Error("BrowserExecutor disposed"), { report: false });
			terminal = true;
		},
	};
}
