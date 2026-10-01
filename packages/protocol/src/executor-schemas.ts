import Type, { type Static } from "typebox";
import { ModelRefSchema, SessionSnapshotSchema, ThinkingLevelSchema, TranscriptProgressSchema } from "./schemas.ts";

export const EXECUTOR_PROTOCOL_VERSION = 1 as const;
const StrictObject = <const T extends Parameters<typeof Type.Object>[0]>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });
const IdSchema = Type.String({ minLength: 1, maxLength: 128 });
const UuidSchema = Type.String({
	pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
});
const ErrorMessageSchema = Type.String({ minLength: 1, maxLength: 500 });
const RuntimeErrorCodeSchema = Type.Union([
	Type.Literal("busy"),
	Type.Literal("session_locked"),
	Type.Literal("not_found"),
	Type.Literal("invalid_request"),
	Type.Literal("not_implemented"),
	Type.Literal("internal_error"),
]);
const RuntimeErrorSchema = StrictObject({ code: RuntimeErrorCodeSchema, message: ErrorMessageSchema });
export const ExecutorRuntimeCommandSchema = Type.Union([
	StrictObject({ command: Type.Literal("prompt"), text: Type.String() }),
	StrictObject({ command: Type.Literal("steer"), text: Type.String() }),
	StrictObject({ command: Type.Literal("abort") }),
	StrictObject({ command: Type.Literal("set_model"), model: ModelRefSchema }),
	StrictObject({ command: Type.Literal("set_thinking"), thinkingLevel: ThinkingLevelSchema }),
]);
export type ExecutorRuntimeCommand = Static<typeof ExecutorRuntimeCommandSchema>;

export const ExecutorHelloSchema = StrictObject({
	type: Type.Literal("executor_hello"),
	version: Type.Integer(),
	sessionId: IdSchema,
	generationId: UuidSchema,
});
export type ExecutorHello = Static<typeof ExecutorHelloSchema>;
export const ExecutorReadySchema = StrictObject({
	type: Type.Literal("executor_ready"),
	version: Type.Literal(EXECUTOR_PROTOCOL_VERSION),
	sessionId: IdSchema,
	bindingId: IdSchema,
	generationId: UuidSchema,
});
export type ExecutorReady = Static<typeof ExecutorReadySchema>;
const HelloRejectSchema = StrictObject({
	type: Type.Literal("executor_reject"),
	version: Type.Literal(EXECUTOR_PROTOCOL_VERSION),
	stage: Type.Literal("hello"),
	sessionId: IdSchema,
	generationId: UuidSchema,
	code: Type.Union([Type.Literal("version"), Type.Literal("invalid_request"), Type.Literal("session_locked")]),
	reason: Type.Optional(Type.Literal("timeout")),
	message: ErrorMessageSchema,
});
const BootstrapRejectSchema = StrictObject({
	type: Type.Literal("executor_reject"),
	version: Type.Literal(EXECUTOR_PROTOCOL_VERSION),
	stage: Type.Literal("bootstrap"),
	sessionId: IdSchema,
	bindingId: IdSchema,
	generationId: UuidSchema,
	code: Type.Union([Type.Literal("invalid_request"), Type.Literal("session_locked")]),
	reason: Type.Union([Type.Literal("invalid_snapshot"), Type.Literal("timeout")]),
	message: ErrorMessageSchema,
});
const SnapshotRejectSchema = StrictObject({
	type: Type.Literal("executor_reject"),
	version: Type.Literal(EXECUTOR_PROTOCOL_VERSION),
	stage: Type.Literal("snapshot"),
	sessionId: IdSchema,
	bindingId: IdSchema,
	generationId: UuidSchema,
	code: Type.Literal("invalid_request"),
	reason: Type.Literal("invalid_snapshot"),
	message: ErrorMessageSchema,
});
export const ExecutorRejectSchema = Type.Union([HelloRejectSchema, BootstrapRejectSchema, SnapshotRejectSchema]);
export type ExecutorReject = Static<typeof ExecutorRejectSchema>;

export type SnapshotData = Omit<Static<typeof SessionSnapshotSchema>, "attached" | "locked" | "revision">;
const SnapshotDataSchema = StrictObject({
	id: SessionSnapshotSchema.properties.id,
	cwd: SessionSnapshotSchema.properties.cwd,
	name: Type.Optional(SessionSnapshotSchema.properties.name),
	createdAt: SessionSnapshotSchema.properties.createdAt,
	updatedAt: SessionSnapshotSchema.properties.updatedAt,
	phase: SessionSnapshotSchema.properties.phase,
	model: SessionSnapshotSchema.properties.model,
	thinkingLevel: SessionSnapshotSchema.properties.thinkingLevel,
	transcript: SessionSnapshotSchema.properties.transcript,
	queuedSteer: SessionSnapshotSchema.properties.queuedSteer,
	queuedSteerCount: SessionSnapshotSchema.properties.queuedSteerCount,
});
const RuntimeIdentity = { sessionId: IdSchema, bindingId: IdSchema, generationId: UuidSchema } as const;
const SnapshotRejectedBase = {
	type: Type.Literal("executor_snapshot_rejected"),
	...RuntimeIdentity,
	code: Type.Literal("invalid_snapshot"),
	encodedPayloadBytes: Type.Integer({ minimum: 0 }),
	maxPayloadBytes: Type.Integer({ minimum: 0 }),
	message: ErrorMessageSchema,
} as const;
export const ExecutorToHostSchema = Type.Union([
	ExecutorHelloSchema,
	StrictObject({ type: Type.Literal("runtime_snapshot"), ...RuntimeIdentity, snapshot: SnapshotDataSchema }),
	StrictObject({ type: Type.Literal("runtime_progress"), ...RuntimeIdentity, progress: TranscriptProgressSchema }),
	StrictObject({
		type: Type.Literal("runtime_command_result"),
		...RuntimeIdentity,
		commandId: UuidSchema,
		ok: Type.Literal(true),
		snapshot: SnapshotDataSchema,
	}),
	StrictObject({
		type: Type.Literal("runtime_command_result"),
		...RuntimeIdentity,
		commandId: UuidSchema,
		ok: Type.Literal(false),
		error: RuntimeErrorSchema,
	}),
	StrictObject({
		type: Type.Literal("runtime_error"),
		...RuntimeIdentity,
		error: StrictObject({
			code: Type.Union([Type.Literal("invalid_snapshot"), Type.Literal("internal_error")]),
			message: ErrorMessageSchema,
		}),
	}),
	StrictObject({
		...SnapshotRejectedBase,
		scope: Type.Union([Type.Literal("bootstrap"), Type.Literal("runtime_snapshot")]),
	}),
	StrictObject({ ...SnapshotRejectedBase, scope: Type.Literal("command_result"), commandId: UuidSchema }),
	StrictObject({
		type: Type.Literal("executor_close"),
		...RuntimeIdentity,
		reason: Type.Union([Type.Literal("disposed"), Type.Literal("session_changed")]),
	}),
]);
export type ExecutorToHost = Static<typeof ExecutorToHostSchema>;
export const HostToExecutorSchema = Type.Union([
	ExecutorReadySchema,
	ExecutorRejectSchema,
	StrictObject({ type: Type.Literal("bootstrap_ack"), ...RuntimeIdentity }),
	StrictObject({
		type: Type.Literal("runtime_command"),
		...RuntimeIdentity,
		commandId: UuidSchema,
		command: ExecutorRuntimeCommandSchema,
	}),
	StrictObject({
		type: Type.Literal("runtime_close"),
		...RuntimeIdentity,
		reason: Type.Union([Type.Literal("replaced"), Type.Literal("disposed")]),
	}),
]);
export type HostToExecutor = Static<typeof HostToExecutorSchema>;
