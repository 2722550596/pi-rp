import { Check } from "typebox/value";
import { decodeCbor, encodeCbor } from "./cbor/index.ts";
import {
	type ExecutorToHost,
	ExecutorToHostSchema,
	type HostToExecutor,
	HostToExecutorSchema,
} from "./executor-schemas.ts";
import { DEFAULT_MAX_FRAME_LENGTH, encodeFrame, FrameDecoder, type FrameDecoderOptions } from "./framing.ts";

export const MAX_EXECUTOR_INBOUND_CHUNK_BYTES = DEFAULT_MAX_FRAME_LENGTH + 4;
export class ExecutorProtocolValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ExecutorProtocolValidationError";
	}
}
const utf8Encoder = new TextEncoder();
function protocolValue(value: unknown, optional = false, ancestors = new Set<object>()): boolean {
	if (value === undefined) return optional;
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (typeof value !== "object" || ancestors.has(value)) return false;
	ancestors.add(value);
	try {
		if (Array.isArray(value)) return value.every((item) => protocolValue(item, false, ancestors));
		if (Object.getPrototypeOf(value) !== Object.prototype) return false;
		return Object.values(value).every((item) => protocolValue(item, true, ancestors));
	} finally {
		ancestors.delete(value);
	}
}
function hasBoundedIdentity(value: unknown): boolean {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return true;
	const record = value as Record<string, unknown>;
	for (const key of ["sessionId", "bindingId"]) {
		const entry = record[key];
		if (entry !== undefined && (typeof entry !== "string" || utf8Encoder.encode(entry).byteLength > 128))
			return false;
	}
	return true;
}
export function parseExecutorToHost(value: unknown): ExecutorToHost {
	if (!protocolValue(value) || !hasBoundedIdentity(value) || !Check(ExecutorToHostSchema, value))
		throw new ExecutorProtocolValidationError("Invalid executor-to-host message");
	return value;
}
export function parseHostToExecutor(value: unknown): HostToExecutor {
	if (!protocolValue(value) || !hasBoundedIdentity(value) || !Check(HostToExecutorSchema, value))
		throw new ExecutorProtocolValidationError("Invalid host-to-executor message");
	return value;
}
function encode<T>(value: T, parse: (input: unknown) => T, kind: string, options?: FrameDecoderOptions): Uint8Array {
	const message = parse(value);
	const max = options?.maxFrameLength ?? DEFAULT_MAX_FRAME_LENGTH;
	try {
		const frame = encodeFrame(encodeCbor(message, { maxByteLength: max }));
		if (frame.byteLength > max + 4) throw new Error("frame exceeds limit");
		return frame;
	} catch {
		throw new ExecutorProtocolValidationError(`Unable to encode ${kind}`);
	}
}
export function encodeExecutorToHost(message: ExecutorToHost, options?: FrameDecoderOptions): Uint8Array {
	return encode(message, parseExecutorToHost, "executor-to-host message", options);
}
export function encodeHostToExecutor(message: HostToExecutor, options?: FrameDecoderOptions): Uint8Array {
	return encode(message, parseHostToExecutor, "host-to-executor message", options);
}
function boundedMessage(error: unknown): string {
	return error instanceof Error ? error.message.slice(0, 500) : "unknown codec error";
}
class ExecutorDecoder<T> {
	private failed = false;
	private readonly frames: FrameDecoder;
	private readonly maxFrameLength: number;
	private readonly kind: string;
	private readonly parse: (value: unknown) => T;
	constructor(kind: string, parse: (value: unknown) => T, options?: FrameDecoderOptions) {
		this.kind = kind;
		this.parse = parse;
		this.frames = new FrameDecoder(options);
		this.maxFrameLength = options?.maxFrameLength ?? DEFAULT_MAX_FRAME_LENGTH;
	}
	push(chunk: Uint8Array): T[] {
		const values: T[] = [];
		this.pushEach(chunk, (value) => values.push(value));
		return values;
	}

	pushEach(chunk: Uint8Array, onMessage: (message: T) => void): void {
		if (this.failed) throw new ExecutorProtocolValidationError(`${this.kind} decoder has failed`);
		if (chunk.byteLength > MAX_EXECUTOR_INBOUND_CHUNK_BYTES) {
			this.failed = true;
			throw new ExecutorProtocolValidationError("Executor inbound chunk exceeds configured limit");
		}
		try {
			this.frames.pushEach(chunk, (frame) => {
				let decoded: T;
				try {
					decoded = this.parse(decodeCbor(frame, { maxByteLength: this.maxFrameLength }));
				} catch {
					throw new ExecutorProtocolValidationError(`Invalid ${this.kind} message`);
				}
				onMessage(decoded);
			});
		} catch (error) {
			this.failed = true;
			throw error instanceof ExecutorProtocolValidationError
				? error
				: new ExecutorProtocolValidationError(`Invalid ${this.kind} framing`);
		}
	}
	end(): void {
		if (this.failed) throw new ExecutorProtocolValidationError(`${this.kind} decoder has failed`);
		try {
			this.frames.end();
		} catch (error) {
			this.failed = true;
			throw new ExecutorProtocolValidationError(`Invalid ${this.kind} framing: ${boundedMessage(error)}`);
		}
	}
}
export class ExecutorToHostDecoder extends ExecutorDecoder<ExecutorToHost> {
	constructor(options?: FrameDecoderOptions) {
		super("executor-to-host", parseExecutorToHost, options);
	}
}
export class HostToExecutorDecoder extends ExecutorDecoder<HostToExecutor> {
	constructor(options?: FrameDecoderOptions) {
		super("host-to-executor", parseHostToExecutor, options);
	}
}

function utf8BoundedString(maxBytes: number): string {
	let value = "a".repeat(maxBytes);
	while (new TextEncoder().encode(value).byteLength > maxBytes) value = value.slice(0, -1);
	return value;
}
const boundId = utf8BoundedString(128);
const boundUuid = "00000000-0000-4000-8000-000000000000";
const abortControl: HostToExecutor = {
	type: "runtime_command",
	sessionId: boundId,
	bindingId: boundId,
	generationId: boundUuid,
	commandId: boundUuid,
	command: { command: "abort" },
};
const snapshotRejectedControl: ExecutorToHost = {
	type: "executor_snapshot_rejected",
	sessionId: boundId,
	bindingId: boundId,
	generationId: boundUuid,
	scope: "command_result",
	commandId: boundUuid,
	code: "invalid_snapshot",
	encodedPayloadBytes: DEFAULT_MAX_FRAME_LENGTH + 1,
	maxPayloadBytes: DEFAULT_MAX_FRAME_LENGTH,
	message: "Snapshot exceeds the executor frame limit",
};
const runtimeErrorControl: ExecutorToHost = {
	type: "runtime_error",
	sessionId: boundId,
	bindingId: boundId,
	generationId: boundUuid,
	error: { code: "invalid_snapshot", message: "x".repeat(500) },
};
export const MIN_ABORT_CONTROL_BYTES = Math.max(
	encodeHostToExecutor(abortControl).byteLength,
	encodeExecutorToHost(snapshotRejectedControl).byteLength,
	encodeExecutorToHost(runtimeErrorControl).byteLength,
);
