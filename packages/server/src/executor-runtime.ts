import { randomUUID } from "node:crypto";
import {
	DEFAULT_MAX_FRAME_LENGTH,
	EXECUTOR_PROTOCOL_VERSION,
	ExecutorProtocolValidationError,
	type ExecutorRuntimeCommand,
	type ExecutorToHost,
	ExecutorToHostDecoder,
	encodeHostToExecutor,
	encodeServerMessage,
	type HostToExecutor,
	MAX_EXECUTOR_INBOUND_CHUNK_BYTES,
	MIN_ABORT_CONTROL_BYTES,
	type SessionSnapshot,
	type SnapshotData,
	type TranscriptProgress,
} from "@earendil-works/pi-protocol";
import {
	applyTranscriptProgress,
	applyTranscriptSnapshot,
	createTranscriptState,
	selectTranscript,
	type TranscriptState,
} from "@earendil-works/pi-session-protocol";
import type { ByteConnection, ByteConnectionHandler } from "./connection.ts";
import { InternalServerError, PiServerError } from "./errors.ts";
import type { PiSessionRuntime, PiSessionRuntimeEvent } from "./types.ts";
export { MAX_EXECUTOR_INBOUND_CHUNK_BYTES, MIN_ABORT_CONTROL_BYTES };
export type { ByteConnection, ByteConnectionHandler } from "./connection.ts";

export interface ExecutorSessionTimeouts {
	readonly helloTimeoutMs?: number;
	readonly bootstrapTimeoutMs?: number;
}
export interface ExecutorSessionBridgeOptions {
	readonly sessionId: string;
	readonly bindingId: string;
	readonly maxPendingCommands: number;
	readonly maxQueuedOutboundBytes: number;
	readonly maxParticipantFrameLength?: number;
	readonly timeouts?: ExecutorSessionTimeouts;
	readonly onError?: (error: Error) => void;
	readonly maxAbortControlBytes: number;
}
export interface ExecutorSessionBridge {
	acquireRuntime(): Promise<PiSessionRuntime>;
	attachTransport(connection: ByteConnection): ByteConnectionHandler;
	dispose(): Promise<void>;
}
export class ExecutorSessionTimeoutError extends PiServerError {
	readonly stage: "hello" | "bootstrap";
	constructor(stage: "hello" | "bootstrap") {
		super("invalid_request", `Executor ${stage} timeout`);
		this.name = "ExecutorSessionTimeoutError";
		this.stage = stage;
	}
}
export class ExecutorSessionClosedError extends PiServerError {
	readonly reason: "disconnected" | "disposed" | "replaced";
	constructor(reason: "disconnected" | "disposed" | "replaced") {
		super("session_locked", `Executor session ${reason}`);
		this.name = "ExecutorSessionClosedError";
		this.reason = reason;
	}
}
const DEFAULT_HELLO_TIMEOUT = 5_000;
const DEFAULT_BOOTSTRAP_TIMEOUT = 30_000;
const MAX_TIMER_DELAY = 2_147_483_647;
type Pending = { resolve(snapshot: SnapshotData): void; reject(error: Error): void; reserved: boolean };
type Listener = (event: PiSessionRuntimeEvent) => void;

class BoundedWriter {
	private queued: Array<{
		frame: Uint8Array;
		reserved: boolean;
		resolve: () => void;
		reject: (error: Error) => void;
	}> = [];
	private bytes = 0;
	private running = false;
	private closed = false;
	private readonly connection: ByteConnection;
	private readonly limit: number;
	private readonly reserve: number;
	constructor(connection: ByteConnection, limit: number, reserve: number) {
		this.connection = connection;
		this.limit = limit;
		this.reserve = reserve;
	}
	send(frame: Uint8Array, reserved = false): Promise<void> {
		if (this.closed) return Promise.reject(new Error("Executor connection is closed"));
		if (
			frame.byteLength > (reserved ? this.reserve : this.limit - this.reserve) ||
			this.bytes + frame.byteLength > (reserved ? this.limit : this.limit - this.reserve)
		) {
			return Promise.reject(new PiServerError("busy", "Executor outbound queue is full"));
		}
		this.bytes += frame.byteLength;
		const queued = Promise.withResolvers<void>();
		this.queued.push({ frame, reserved, resolve: queued.resolve, reject: queued.reject });
		void this.drain();
		return queued.promise;
	}
	close(error: Error): void {
		if (this.closed) return;
		this.closed = true;
		for (const item of this.queued.splice(0)) {
			this.bytes -= item.frame.byteLength;
			item.reject(error);
		}
	}
	private async drain(): Promise<void> {
		if (this.running || this.closed) return;
		this.running = true;
		try {
			while (!this.closed && this.queued.length) {
				const item = this.queued.shift()!;
				try {
					await this.connection.send(item.frame);
					item.resolve();
				} catch (error) {
					item.reject(error instanceof Error ? error : new Error(String(error)));
					this.close(new Error("Executor connection send failed"));
				} finally {
					this.bytes -= item.frame.byteLength;
				}
			}
		} finally {
			this.running = false;
		}
	}
}

export function createExecutorSessionBridge(options: ExecutorSessionBridgeOptions): ExecutorSessionBridge {
	validateOptions(options);
	let disposed = false;
	let generation = 0;
	let generationId: string | undefined;
	let connection: ByteConnection | undefined;
	let writer: BoundedWriter | undefined;
	let decoder: ExecutorToHostDecoder | undefined;
	let bootstrap: SnapshotData | undefined;
	let bootstrapped = false;
	let state: TranscriptState | undefined;
	let revision = 0;
	let helloTimer: ReturnType<typeof setTimeout> | undefined;
	let bootstrapTimer: ReturnType<typeof setTimeout> | undefined;
	const bootstrapWaiters: Array<{ resolve(snapshot: SnapshotData): void; reject(error: Error): void }> = [];
	const pending = new Map<string, Pending>();
	const listeners = new Set<Listener>();
	let ordinaryPending = 0;
	let abortPending = false;

	const report = (error: unknown): void => {
		try {
			options.onError?.(error instanceof Error ? error : new Error(String(error)));
		} catch {
			/* Observers cannot interrupt runtime state. */
		}
	};
	const failGeneration = (error: Error, close = true): void => {
		generation += 1;
		if (helloTimer) clearTimeout(helloTimer);
		if (bootstrapTimer) clearTimeout(bootstrapTimer);
		helloTimer = bootstrapTimer = undefined;
		bootstrapped = false;
		for (const waiter of bootstrapWaiters.splice(0)) waiter.reject(error);
		for (const item of pending.values()) item.reject(error);
		pending.clear();
		ordinaryPending = 0;
		abortPending = false;
		writer?.close(error);
		writer = undefined;
		const old = connection;
		connection = undefined;
		decoder = undefined;
		generationId = undefined;
		if (close && old && !old.closed) void Promise.resolve(old.close()).catch(report);
	};
	const frameLength = options.maxParticipantFrameLength ?? DEFAULT_MAX_FRAME_LENGTH;
	const materialize = (data: SnapshotData): SessionSnapshot => ({
		...data,
		id: options.sessionId,
		attached: false,
		locked: true,
		revision,
		transcript: state ? [...selectTranscript(state)] : [...data.transcript],
	});
	const sendControl = (message: HostToExecutor, reserved = false): Promise<void> => {
		if (!writer) return Promise.reject(new Error("Executor is disconnected"));
		try {
			return writer.send(encodeHostToExecutor(message), reserved);
		} catch (error) {
			return Promise.reject(error);
		}
	};
	const emitSnapshot = (): void => {
		for (const listener of listeners) {
			try {
				listener({ type: "snapshot" });
			} catch (error) {
				report(error);
			}
		}
	};
	const emitProgress = (progress: TranscriptProgress): void => {
		for (const listener of listeners) {
			try {
				listener({ type: "progress", progress });
			} catch (error) {
				report(error);
			}
		}
	};
	const receiveMessage = (message: ExecutorToHost, thisGeneration: number): void => {
		if (thisGeneration !== generation) return;
		if (message.type === "executor_hello") {
			if (
				message.sessionId !== options.sessionId ||
				message.version !== EXECUTOR_PROTOCOL_VERSION ||
				generationId !== undefined
			) {
				const error = new PiServerError(
					"invalid_request",
					message.version !== EXECUTOR_PROTOCOL_VERSION
						? "Executor protocol version mismatch"
						: "Executor handshake identity mismatch",
				);
				generationId = message.generationId;
				const reject: HostToExecutor = {
					type: "executor_reject",
					version: EXECUTOR_PROTOCOL_VERSION,
					stage: "hello",
					sessionId: options.sessionId,
					generationId,
					code: message.version !== EXECUTOR_PROTOCOL_VERSION ? "version" : "invalid_request",
					message: error.message,
				};
				void sendControl(reject)
					.finally(() => failGeneration(error))
					.catch(report);
				return;
			}
			generationId = message.generationId;
			if (helloTimer) clearTimeout(helloTimer);
			helloTimer = undefined;
			bootstrapTimer = setTimeout(
				() => failGeneration(new ExecutorSessionTimeoutError("bootstrap")),
				options.timeouts?.bootstrapTimeoutMs ?? DEFAULT_BOOTSTRAP_TIMEOUT,
			);
			void sendControl({
				type: "executor_ready",
				version: EXECUTOR_PROTOCOL_VERSION,
				sessionId: options.sessionId,
				bindingId: options.bindingId,
				generationId,
			}).catch((error: unknown) => failGeneration(error instanceof Error ? error : new Error(String(error))));
			return;
		}
		if (message.generationId !== generationId) return;
		if (message.sessionId !== options.sessionId || message.bindingId !== options.bindingId) {
			failGeneration(new PiServerError("invalid_request", "Executor binding identity mismatch"));
			return;
		}
		if (message.type === "runtime_snapshot") {
			if (message.snapshot.id !== options.sessionId) {
				rejectSnapshot(new PiServerError("invalid_request", "Executor snapshot session ID mismatch"));
				return;
			}
			const candidate = { ...message.snapshot, attached: false, locked: true, revision };
			const candidateState = state ? applyTranscriptSnapshot(state, candidate) : createTranscriptState(candidate);
			const snapshot: SessionSnapshot = { ...candidate, transcript: [...selectTranscript(candidateState)] };
			try {
				encodeServerMessage(
					{ type: "event", event: { type: "session_snapshot", snapshot } },
					{ maxFrameLength: frameLength },
				);
			} catch (error) {
				rejectSnapshot(error);
				return;
			}
			const isBootstrap = bootstrap === undefined;
			state = candidateState;
			bootstrap = message.snapshot;
			revision += 1;
			if (isBootstrap) {
				clearTimeout(bootstrapTimer);
				bootstrapTimer = undefined;
				void sendControl({
					type: "bootstrap_ack",
					sessionId: options.sessionId,
					bindingId: options.bindingId,
					generationId: generationId!,
				}).then(
					() => {
						if (thisGeneration !== generation) return;
						bootstrapped = true;
						for (const waiter of bootstrapWaiters.splice(0)) waiter.resolve(message.snapshot);
					},
					(error: unknown) => failGeneration(error instanceof Error ? error : new Error(String(error))),
				);
			}
			emitSnapshot();
			return;
		}
		if (message.type === "runtime_progress") {
			if (state) state = applyTranscriptProgress(state, message.progress);
			revision += 1;
			emitProgress(message.progress);
			return;
		}
		if (message.type === "runtime_command_result") {
			const item = pending.get(message.commandId);
			if (!item) return;
			pending.delete(message.commandId);
			if (item.reserved) abortPending = false;
			else ordinaryPending -= 1;
			if (!message.ok) {
				item.reject(
					message.error.code === "internal_error"
						? new InternalServerError(message.error.message)
						: new PiServerError(message.error.code, message.error.message),
				);
				return;
			}
			if (message.snapshot.id !== options.sessionId) {
				item.reject(new PiServerError("invalid_request", "Executor command result session ID mismatch"));
				failGeneration(new PiServerError("invalid_request", "Executor command result session ID mismatch"));
				return;
			}
			const candidate = { ...message.snapshot, attached: false, locked: true, revision };
			const candidateState = state ? applyTranscriptSnapshot(state, candidate) : createTranscriptState(candidate);
			const resultSnapshot: SessionSnapshot = { ...candidate, transcript: [...selectTranscript(candidateState)] };
			try {
				encodeServerMessage(
					{ type: "event", event: { type: "session_snapshot", snapshot: resultSnapshot } },
					{ maxFrameLength: frameLength },
				);
			} catch {
				item.reject(
					new PiServerError(
						"invalid_request",
						"Executor command completed, but its snapshot exceeds the participant frame limit",
					),
				);
				return;
			}
			state = candidateState;
			bootstrap = message.snapshot;
			revision += 1;
			item.resolve(message.snapshot);
			emitSnapshot();
			return;
		}
		if (message.type === "executor_snapshot_rejected") {
			if (message.scope === "command_result") {
				const item = pending.get(message.commandId);
				if (item) {
					pending.delete(message.commandId);
					if (item.reserved) abortPending = false;
					else ordinaryPending -= 1;
					item.reject(
						new PiServerError("invalid_request", "Executor command snapshot exceeds participant frame limit"),
					);
				}
			} else
				rejectSnapshot(new PiServerError("invalid_request", "Executor snapshot exceeds participant frame limit"));
			return;
		}
		if (message.type === "runtime_error") {
			report(new Error(message.error.message));
			if (message.error.code === "internal_error") failGeneration(new Error(message.error.message));
		}
		if (message.type === "executor_close")
			failGeneration(new PiServerError("session_locked", "Executor closed the session"));
	};
	const rejectSnapshot = (error: unknown): void => {
		const cause = error instanceof Error ? error : new Error(String(error));
		const id = generationId;
		if (id) {
			const reject: HostToExecutor = {
				type: "executor_reject",
				version: EXECUTOR_PROTOCOL_VERSION,
				stage: bootstrap ? "snapshot" : "bootstrap",
				sessionId: options.sessionId,
				bindingId: options.bindingId,
				generationId: id,
				code: "invalid_request",
				reason: "invalid_snapshot",
				message: "Executor snapshot exceeds participant frame limit",
			};
			void sendControl(reject)
				.finally(() => failGeneration(cause))
				.catch(report);
		} else failGeneration(cause);
	};

	const bridge: ExecutorSessionBridge = {
		acquireRuntime(): Promise<PiSessionRuntime> {
			if (bootstrapped && bootstrap && connection && generationId) return Promise.resolve(createFacade());
			const { promise, resolve, reject } = Promise.withResolvers<PiSessionRuntime>();
			const timeout = setTimeout(() => {
				const index = bootstrapWaiters.indexOf(waiter);
				if (index >= 0) bootstrapWaiters.splice(index, 1);
				reject(new ExecutorSessionTimeoutError("bootstrap"));
			}, options.timeouts?.bootstrapTimeoutMs ?? DEFAULT_BOOTSTRAP_TIMEOUT);
			const waiter = {
				resolve: (_snapshot: SnapshotData) => {
					clearTimeout(timeout);
					resolve(createFacade());
				},
				reject: (error: Error) => {
					clearTimeout(timeout);
					reject(error);
				},
			};
			bootstrapWaiters.push(waiter);
			return promise;
		},
		attachTransport(raw): ByteConnectionHandler {
			if (disposed) {
				void raw.close();
				return { onData() {}, onClose() {}, onError: report };
			}
			if (connection || writer || generationId) failGeneration(new ExecutorSessionClosedError("replaced"));
			generation += 1;
			const current = generation;
			generationId = undefined;
			connection = raw;
			decoder = new ExecutorToHostDecoder();
			writer = new BoundedWriter(raw, options.maxQueuedOutboundBytes, options.maxAbortControlBytes);
			bootstrap = undefined;
			helloTimer = setTimeout(
				() => failGeneration(new ExecutorSessionTimeoutError("hello")),
				options.timeouts?.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT,
			);
			return {
				onData: (chunk) => {
					if (current !== generation || !decoder) return;
					if (chunk.byteLength > MAX_EXECUTOR_INBOUND_CHUNK_BYTES) {
						failGeneration(new PiServerError("invalid_request", "Executor inbound chunk exceeds maximum"));
						return;
					}
					try {
						decoder.pushEach(chunk, (message) => receiveMessage(message, current));
					} catch (error) {
						report(error);
						failGeneration(new PiServerError("invalid_request", "Invalid executor protocol frame"));
					}
				},
				onClose: () => {
					if (current === generation) failGeneration(new ExecutorSessionClosedError("disconnected"), false);
				},
				onError: (error) => {
					report(error);
					if (current === generation) failGeneration(error);
				},
			};
		},
		async dispose() {
			if (disposed) return;
			disposed = true;
			failGeneration(new ExecutorSessionClosedError("disposed"));
			listeners.clear();
		},
	};

	function createFacade(): PiSessionRuntime {
		let released = false;
		const assertCurrent = (): void => {
			if (released || disposed || !bootstrapped || !connection || !generationId || !bootstrap) {
				throw new PiServerError("session_locked", "Executor runtime is no longer available");
			}
		};
		const snapshot = (): SessionSnapshot => {
			assertCurrent();
			if (!bootstrap || !bootstrapped) throw new PiServerError("session_locked", "Executor snapshot is unavailable");
			return materialize(bootstrap);
		};
		const command = async (runtimeCommand: ExecutorRuntimeCommand, reserved = false): Promise<void> => {
			assertCurrent();
			const commandGenerationId = generationId;
			const commandGeneration = generation;
			const commandWriter = writer;
			if (!commandGenerationId || !commandWriter)
				throw new PiServerError("session_locked", "Executor is not bootstrapped");
			if (reserved && abortPending) throw new PiServerError("busy", "Executor abort is already pending");
			if (!reserved && ordinaryPending >= options.maxPendingCommands)
				throw new PiServerError("busy", "Executor command limit reached");
			const commandId = randomUUID();
			const message: HostToExecutor = {
				type: "runtime_command",
				sessionId: options.sessionId,
				bindingId: options.bindingId,
				generationId: commandGenerationId,
				commandId,
				command: runtimeCommand,
			};
			let frame: Uint8Array;
			try {
				frame = encodeHostToExecutor(message);
			} catch (error) {
				if (error instanceof ExecutorProtocolValidationError) {
					throw new PiServerError("invalid_request", "Executor command exceeds the maximum frame size");
				}
				throw error;
			}
			const result = Promise.withResolvers<SnapshotData>();
			pending.set(commandId, { resolve: result.resolve, reject: result.reject, reserved });
			if (reserved) abortPending = true;
			else ordinaryPending += 1;
			void commandWriter.send(frame, reserved).catch((error: unknown) => {
				if (error instanceof PiServerError && error.code === "busy") {
					const entry = pending.get(commandId);
					if (entry) {
						pending.delete(commandId);
						if (reserved) abortPending = false;
						else ordinaryPending -= 1;
						entry.reject(error);
					}
					return;
				}
				if (commandGeneration === generation) failGeneration(new ExecutorSessionClosedError("disconnected"));
			});
			await result.promise;
		};
		return {
			snapshot,
			getPhase: () => snapshot().phase,
			prompt: (input) => command({ command: "prompt", text: input.text }),
			steer: (input) => command({ command: "steer", text: input.text }),
			abort: () => command({ command: "abort" }, true),
			setModel: (model) => command({ command: "set_model", model }),
			setThinking: (thinkingLevel) => command({ command: "set_thinking", thinkingLevel }),
			subscribe(listener) {
				assertCurrent();
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			async dispose() {
				if (released) return;
				released = true;
			},
		};
	}
	return bridge;
}

function validateOptions(options: ExecutorSessionBridgeOptions): void {
	if (!options.sessionId || new TextEncoder().encode(options.sessionId).byteLength > 128)
		throw new TypeError("sessionId must be 1–128 UTF-8 bytes");
	if (!options.bindingId || new TextEncoder().encode(options.bindingId).byteLength > 128)
		throw new TypeError("bindingId must be 1–128 UTF-8 bytes");
	if (!Number.isSafeInteger(options.maxPendingCommands) || options.maxPendingCommands < 2)
		throw new TypeError("maxPendingCommands must be an integer >= 2");
	if (!Number.isSafeInteger(options.maxAbortControlBytes) || options.maxAbortControlBytes < MIN_ABORT_CONTROL_BYTES)
		throw new TypeError(`maxAbortControlBytes must be >= ${MIN_ABORT_CONTROL_BYTES}`);
	if (
		!Number.isSafeInteger(options.maxQueuedOutboundBytes) ||
		options.maxQueuedOutboundBytes < MAX_EXECUTOR_INBOUND_CHUNK_BYTES + options.maxAbortControlBytes
	)
		throw new TypeError("maxQueuedOutboundBytes is below the protocol minimum");
	const maxFrame = options.maxParticipantFrameLength ?? DEFAULT_MAX_FRAME_LENGTH;
	if (!Number.isSafeInteger(maxFrame) || maxFrame <= 0 || maxFrame > DEFAULT_MAX_FRAME_LENGTH)
		throw new TypeError("maxParticipantFrameLength is invalid");
	for (const timeout of [
		options.timeouts?.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT,
		options.timeouts?.bootstrapTimeoutMs ?? DEFAULT_BOOTSTRAP_TIMEOUT,
	]) {
		if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > MAX_TIMER_DELAY)
			throw new TypeError("Executor timeout is invalid");
	}
}
