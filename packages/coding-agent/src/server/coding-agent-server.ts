import { randomUUID } from "node:crypto";
import { dirname, relative, resolve } from "node:path";
import type { Api, AssistantMessage, Model, ToolCall, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import {
	type ModelMetadata,
	parseServerMessage,
	type SessionMetadata,
	type SessionSnapshot,
	type SessionTreeEntryProjection,
	type SessionTreeNodeKind,
	type ThinkingLevel,
	type ToolTranscriptItem,
	type TranscriptItem,
	type TranscriptProgress,
} from "@earendil-works/pi-protocol";
import {
	type CreateSessionOptions,
	PiServer,
	PiServerError,
	type PiServerListener,
	type PiServerOptions,
	type PiSessionRuntime,
	type PiSessionRuntimeEvent,
	type PromptInput,
	SessionBusyError,
	SessionLockedError,
	SessionNotFoundError,
	type SteerInput,
	toProtocolModelMetadata,
} from "@earendil-works/pi-server";
import {
	summaryToUserMessage,
	toProtocolAssistantMessage,
	toProtocolCustomMessage,
	toProtocolJsonValue,
	toProtocolToolResultMessage,
	toProtocolUserMessage,
} from "@earendil-works/pi-session-protocol";
import type { AgentSession, AgentSessionEvent } from "../core/agent-session.ts";
import { ModelRuntime } from "../core/model-runtime.ts";
import { assertValidRequestGatewayConfig, RequestGateway, type RequestGatewayConfig } from "../core/request-gateway.ts";
import { type CreateAgentSessionOptions, createAgentSession } from "../core/sdk.ts";
import type { SessionEntry, SessionManager } from "../core/session-manager.ts";
import { createAgentSessionScope } from "../core/session-scope.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import {
	type CodingAgentServerSessionStore,
	FileCodingAgentServerSessionStore,
	HostRootOwnedError,
	SessionStoreError,
} from "./session-store.ts";

/** Caller-provided per-session setup. Host-owned identity and storage options are excluded. */
export type SessionAgentOptions = Omit<
	CreateAgentSessionOptions,
	| "cwd"
	| "configDir"
	| "agentDir"
	| "modelRuntime"
	| "requestGateway"
	| "requestIdentity"
	| "sessionManager"
	| "settingsManager"
	| "scope"
	| "model"
	| "thinkingLevel"
	| "initialMessages"
	| "sessionStartEvent"
>;

interface CodingAgentPiServerOptionsBase {
	listeners: readonly PiServerListener[];
	maxActiveRuntimes: number;
	requestGatewayConfig: RequestGatewayConfig;
	modelRuntime?: ModelRuntime;
	agentDir?: string;
	/** Called for each session: return fresh session-bound tools/loaders/stores from curated trusted resources. No JS sandbox. */
	sessionOptionsForSession?: (session: CreateSessionOptions) => SessionAgentOptions;
	serverOptions?: Omit<PiServerOptions, "listeners">;
}

export type CodingAgentPiServerOptions =
	| (CodingAgentPiServerOptionsBase & { sessionStorageDir: string; sessionStore?: never })
	| (CodingAgentPiServerOptionsBase & { sessionStorageDir?: never; sessionStore: CodingAgentServerSessionStore });

export interface CodingAgentPiServerHandle {
	readonly server: PiServer;
	start(): Promise<PiServer>;
	close(): Promise<void>;
}

type Acquired = { sessionManager: SessionManager; metadata: SessionMetadata; sessionOptions: CreateSessionOptions };

export async function createCodingAgentPiServer(
	options: CodingAgentPiServerOptions,
): Promise<CodingAgentPiServerHandle> {
	if (!options || !Array.isArray(options.listeners)) throw new TypeError("listeners must be an array");
	if (!Number.isSafeInteger(options.maxActiveRuntimes) || options.maxActiveRuntimes <= 0)
		throw new TypeError("maxActiveRuntimes must be a positive safe integer");
	assertValidRequestGatewayConfig(options.requestGatewayConfig);
	if ((options.sessionStorageDir === undefined) === (options.sessionStore === undefined))
		throw new TypeError("Specify exactly one of sessionStorageDir or sessionStore");
	if (
		options.sessionStorageDir !== undefined &&
		(typeof options.sessionStorageDir !== "string" || options.sessionStorageDir.trim().length === 0)
	)
		throw new TypeError("sessionStorageDir must be a non-empty path");
	const ownedStoreInstance =
		options.sessionStore === undefined
			? new FileCodingAgentServerSessionStore(options.sessionStorageDir!)
			: undefined;
	const store: CodingAgentServerSessionStore = options.sessionStore ?? ownedStoreInstance!;
	let modelRuntime: ModelRuntime | undefined = options.modelRuntime;
	let ownedRuntimePromise: Promise<ModelRuntime> | undefined;
	let server: PiServer | undefined;
	const getModelRuntime = async () => {
		if (modelRuntime) return modelRuntime;
		ownedRuntimePromise ??= ModelRuntime.create({
			...(options.agentDir
				? { authPath: resolve(options.agentDir, "auth.json"), modelsPath: resolve(options.agentDir, "models.json") }
				: {}),
		});
		modelRuntime = await ownedRuntimePromise;
		return modelRuntime;
	};
	try {
		// Lock the durable store before any listener can start.
		await store.acquire();
		const sharedModelRuntime = await getModelRuntime();
		const gateway = new RequestGateway(sharedModelRuntime, options.requestGatewayConfig);
		const runtimes = new Set<CodingAgentRuntime>();
		let reserved = 0;
		const reserveCapacity = () => {
			if (runtimes.size + reserved >= options.maxActiveRuntimes)
				throw new SessionBusyError("Active runtime capacity reached", { reason: "active_runtime_limit" });
			reserved++;
		};
		const releaseReservation = () => {
			reserved--;
		};
		const acquireRuntime = async (
			sessionOptions: CreateSessionOptions,
			acquired: Acquired,
			creating = false,
		): Promise<CodingAgentRuntime> => {
			const scope = createAgentSessionScope({ rejectSessionReplacement: true });
			let agentSession: AgentSession | undefined;
			let runtime: CodingAgentRuntime | undefined;
			try {
				const runtimeModel = await getModelRuntime();
				const cwd = acquired.sessionManager.getCwd();
				const sessionRoot = dirname(acquired.sessionManager.getSessionFile()!);
				// Per-session settings and resource discovery prevent project/global writes and unvetted cwd extensions.
				const agentDir = resolve(sessionRoot, "host-settings");
				const configDir = relative(cwd, resolve(sessionRoot, "host-config"));
				const settingsManager = SettingsManager.create(cwd, agentDir, { configDir });
				const extra = options.sessionOptionsForSession?.(sessionOptions) ?? {};
				const selectedModel = sessionOptions.model ? availableModel(runtimeModel, sessionOptions.model) : undefined;
				if (sessionOptions.model && !selectedModel)
					throw new PiServerError("invalid_request", "Unknown or unavailable model");
				agentSession = (
					await createAgentSession({
						...extra,
						cwd,
						configDir,
						agentDir,
						modelRuntime: runtimeModel,
						requestGateway: gateway,
						requestIdentity: { sessionId: sessionOptions.id, priority: 2, label: "main" },
						sessionManager: acquired.sessionManager,
						settingsManager,
						scope,
						model: selectedModel,
						thinkingLevel: sessionOptions.thinkingLevel,
						resourceLoader: extra.resourceLoader,
						customTools: extra.customTools ? [...extra.customTools] : undefined,
					})
				).session;
				if (!agentSession.model || !availableModel(runtimeModel, agentSession.model)) {
					throw new PiServerError("invalid_request", "Session model is unknown or unavailable");
				}
				runtime = new CodingAgentRuntime(
					sessionOptions.id,
					acquired.metadata,
					agentSession,
					runtimeModel,
					async () => {
						const cleanupErrors: unknown[] = [];
						try {
							await agentSession?.dispose();
						} catch (error) {
							cleanupErrors.push(error);
						}
						try {
							scope.dispose();
						} catch (error) {
							cleanupErrors.push(error);
						}
						try {
							await store.release(sessionOptions.id);
						} catch (error) {
							cleanupErrors.push(error);
						}
						runtimes.delete(runtime!);
						if (cleanupErrors.length > 0)
							throw new AggregateError(cleanupErrors, "Failed to dispose coding-agent session runtime");
					},
				);
				parseServerMessage({ type: "event", event: { type: "session_snapshot", snapshot: runtime.snapshot() } });
				const effectiveModel = agentSession.model;
				const effectiveName =
					agentSession.sessionManager.getSessionName() ?? sessionOptions.name ?? acquired.metadata.sessionName;
				if (creating) {
					await store.commitCreate(sessionOptions.id, {
						id: sessionOptions.id,
						cwd: agentSession.sessionManager.getCwd(),
						...(effectiveName === undefined ? {} : { name: effectiveName }),
						model: { provider: effectiveModel.provider, id: effectiveModel.id },
						thinkingLevel: agentSession.thinkingLevel,
					});
				}
				runtimes.add(runtime);
				releaseReservation();
				return runtime;
			} catch (error) {
				const cleanupErrors: unknown[] = [];
				if (runtime) {
					try {
						await runtime.dispose();
					} catch (cleanupError) {
						cleanupErrors.push(cleanupError);
					}
				} else {
					try {
						await agentSession?.dispose();
					} catch (cleanupError) {
						cleanupErrors.push(cleanupError);
					}
					try {
						scope.dispose();
					} catch (cleanupError) {
						cleanupErrors.push(cleanupError);
					}
				}
				if (cleanupErrors.length > 0)
					throw new AggregateError(
						[error, ...cleanupErrors],
						"Session runtime initialization and cleanup failed",
						{ cause: error },
					);
				throw error;
			}
		};
		const service = {
			listSessions: () => store.listSessions(),
			listModels: async (): Promise<ModelMetadata[]> => modelsForRuntime(await getModelRuntime()),
			createSession: async (sessionOptions: CreateSessionOptions): Promise<PiSessionRuntime> => {
				reserveCapacity();
				let acquired: Acquired | undefined;
				try {
					acquired = await store.create(sessionOptions);
					return await acquireRuntime(sessionOptions, acquired, true);
				} catch (error) {
					releaseReservation();
					const cleanupErrors: unknown[] = [];
					if (acquired) {
						try {
							await store.discardFailedCreate(sessionOptions.id);
						} catch (cleanupError) {
							cleanupErrors.push(cleanupError);
						}
						try {
							await store.release(sessionOptions.id);
						} catch (cleanupError) {
							cleanupErrors.push(cleanupError);
						}
					}
					if (cleanupErrors.length > 0)
						throw new AggregateError(
							[error, ...cleanupErrors],
							"Create failed and durable-session cleanup failed",
							{ cause: error },
						);
					throw mapStoreError(error);
				}
			},
			openSession: async (id: string): Promise<PiSessionRuntime> => {
				reserveCapacity();
				let acquired: Acquired | undefined;
				try {
					acquired = await store.open(id);
					if (acquired.sessionOptions.id !== id)
						throw new PiServerError("invalid_request", "Stored session identity does not match its catalog ID");
					return await acquireRuntime(acquired.sessionOptions, acquired);
				} catch (error) {
					releaseReservation();
					const cleanupErrors: unknown[] = [];
					if (acquired) {
						try {
							await store.release(id);
						} catch (cleanupError) {
							cleanupErrors.push(cleanupError);
						}
					}
					if (cleanupErrors.length > 0)
						throw new AggregateError([error, ...cleanupErrors], "Open failed and session lease cleanup failed", {
							cause: error,
						});
					throw mapStoreError(error);
				}
			},
		};
		server = new PiServer(service, { ...options.serverOptions, listeners: options.listeners });
		const hostServer = server;
		let startPromise: Promise<PiServer> | undefined;
		let closePromise: Promise<void> | undefined;
		let closing = false;
		const closeHost = (): Promise<void> => {
			closing = true;
			closePromise ??= (async () => {
				const shutdownErrors: unknown[] = [];
				const stoppingRuntimes = [...runtimes];
				try {
					await hostServer.close();
				} catch (error) {
					shutdownErrors.push(error);
				}
				const disposalResults = await Promise.allSettled(stoppingRuntimes.map((runtime) => runtime.dispose()));
				for (const result of disposalResults) if (result.status === "rejected") shutdownErrors.push(result.reason);
				if (reserved !== 0)
					shutdownErrors.push(new Error(`Host shutdown left ${reserved} runtime reservations active`));
				if (runtimes.size !== 0)
					shutdownErrors.push(new Error(`Host shutdown left ${runtimes.size} active runtimes`));
				if (shutdownErrors.length > 0)
					throw new AggregateError(shutdownErrors, "Host shutdown failed; durable root remains locked", {
						cause: shutdownErrors[0],
					});
				if (ownedStoreInstance) await ownedStoreInstance.close();
			})();
			return closePromise;
		};
		return {
			server: hostServer,
			start: () => {
				if (closing) return Promise.reject(new Error("Coding-agent PiServer Host is closing or closed"));
				startPromise ??= hostServer.start().catch(async (error: unknown) => {
					try {
						await closeHost();
					} catch (cleanupError) {
						throw new AggregateError(
							[error, cleanupError],
							"Server startup and rollback both failed; durable root remains locked",
							{ cause: error },
						);
					}
					throw error;
				});
				return startPromise;
			},
			close: closeHost,
		};
	} catch (error) {
		if (server) await server.close().catch(() => undefined);
		if (ownedStoreInstance) await ownedStoreInstance.close().catch(() => undefined);
		if (error instanceof HostRootOwnedError)
			throw new SessionBusyError("Session storage root is already owned", { reason: "root_owned" });
		throw error;
	}
}

export class CodingAgentRuntime implements PiSessionRuntime {
	private readonly id: string;
	private readonly metadata: SessionMetadata;
	private readonly session: AgentSession;
	private readonly modelRuntime: ModelRuntime;
	private readonly onDispose: () => Promise<void>;
	private readonly listeners = new Set<(event: PiSessionRuntimeEvent) => void>();
	private readonly unsubscribe: () => void;
	private readonly activeCalls = new Map<string, ToolCall>();
	private readonly liveTools = new Map<string, string>();
	private readonly finishedToolCalls = new Set<string>();
	private queuedSteerProjection: Array<{ text: string; id: string; timestamp: number }> = [];
	private revision = 0;
	private disposed = false;

	constructor(
		id: string,
		metadata: SessionMetadata,
		session: AgentSession,
		modelRuntime: ModelRuntime,
		onDispose: () => Promise<void>,
	) {
		this.id = id;
		this.metadata = metadata;
		this.session = session;
		this.modelRuntime = modelRuntime;
		this.onDispose = onDispose;
		this.revision = session.sessionManager.getEntries().length;
		this.unsubscribe = session.subscribe((event) => this.onSessionEvent(event));
	}
	getPhase() {
		if (this.session.isRetrying || this.session.retryAttempt > 0) return "retry" as const;
		if (this.session.isBranchSummarizing) return "branch_summary" as const;
		if (this.session.isCompacting) return "compaction" as const;
		return this.session.isStreaming ? ("turn" as const) : ("idle" as const);
	}

	snapshot(): SessionSnapshot {
		const manager = this.session.sessionManager;
		const header = manager.getHeader();
		if (!header || manager.getSessionId() !== this.id) throw new Error("Session identity or header is invalid");
		const entries = manager.buildContextEntries();
		const transcript: TranscriptItem[] = [];
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
					if (!call) throw new TypeError("Tool result has no preceding assistant tool call");
					transcript.push(toProtocolToolResultMessage(message, { id: entry.id, call }));
				}
			} else if (entry.type === "custom_message") {
				// display:false stays invisible to remote clients, matching TUI semantics.
				if (entry.display) {
					transcript.push(
						toProtocolCustomMessage(
							{ content: entry.content ?? [] },
							{
								id: entry.id,
								customType: entry.customType,
								timestamp: parseTimestamp(entry.timestamp),
							},
						),
					);
				}
			} else if (entry.type === "compaction" || entry.type === "branch_summary") {
				transcript.push(
					summaryToUserMessage({
						id: entry.id,
						timestamp: parseTimestamp(entry.timestamp),
						kind: entry.type === "compaction" ? "compaction" : "branch",
						summary: entry.summary,
					}),
				);
			}
		}
		const model = this.session.model;
		if (!model) throw new Error("Session has no active model");
		const queued = this.session.getSteeringMessages();
		return {
			id: this.id,
			...((manager.getSessionName() ?? this.metadata.sessionName)
				? { name: manager.getSessionName() ?? this.metadata.sessionName }
				: {}),
			cwd: manager.getCwd(),
			createdAt: parseTimestamp(header.timestamp),
			updatedAt: entries.length
				? parseTimestamp(entries[entries.length - 1]!.timestamp)
				: (this.metadata.updatedAt ?? this.metadata.createdAt),
			phase: this.getPhase(),
			model: { provider: model.provider, id: model.id },
			thinkingLevel: this.session.thinkingLevel,
			attached: false,
			locked: true,
			revision: this.revision,
			transcript,
			queuedSteer: this.projectQueuedSteer(queued),
			queuedSteerCount: queued.length,
		};
	}

	async prompt(input: PromptInput) {
		await this.session.prompt(input.text);
	}
	async steer(input: SteerInput) {
		await this.session.steer(input.text);
	}
	async abort() {
		await this.session.abort();
	}
	async setModel(ref: { provider: string; id: string }) {
		const model = availableModel(this.modelRuntime, ref);
		if (!model) throw new PiServerError("invalid_request", "Unknown or unavailable model");
		await this.session.setModel(model, false);
	}
	async setThinking(level: ThinkingLevel) {
		this.session.setThinkingLevel(level, false);
	}
	/** Branch to the last rerollable turn, then fire-and-forget the regeneration run (07 review ruling 1). */
	async reroll(): Promise<boolean> {
		const ok = await this.session.reroll();
		if (ok) {
			this.revision += 1;
			void this.session.startRerollRun().catch(() => undefined);
		}
		return ok;
	}
	async editMessage(entryId: string, text: string): Promise<void> {
		if (!this.session.editMessage(entryId, text)) {
			throw new PiServerError("invalid_request", `Entry is not editable: ${entryId}`);
		}
		this.revision += 1;
	}
	async getTree(): Promise<{ entries: SessionTreeEntryProjection[]; leafId: string }> {
		const manager = this.session.sessionManager;
		return {
			entries: manager.getEntries().map((entry) => projectTreeEntry(entry, manager.getLabel(entry.id))),
			leafId: manager.getLeafId() ?? "",
		};
	}
	async navigateTree(targetId: string): Promise<{ cancelled: boolean; editorText?: string }> {
		const result = await this.session.navigateTree(targetId, { summarize: false });
		const cancelled = result.cancelled ?? false;
		if (!cancelled) this.revision += 1;
		return {
			cancelled,
			...(result.editorText !== undefined ? { editorText: result.editorText } : {}),
		};
	}
	subscribe(listener: (event: PiSessionRuntimeEvent) => void) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	async dispose() {
		if (this.disposed) return;
		this.disposed = true;
		this.unsubscribe();
		this.listeners.clear();
		await this.onDispose();
	}
	private onSessionEvent(event: AgentSessionEvent) {
		if (event.type === "message_start") {
			if (event.message.role === "user") {
				this.publishProgress({
					type: "item_started",
					item: toProtocolUserMessage(event.message, { id: `live-${randomUUID()}` }),
				});
			} else if (event.message.role === "assistant") {
				this.currentAssistantId = `live-${randomUUID()}`;
				this.updateCalls(event.message);
				this.publishProgress({
					type: "item_started",
					item: toProtocolAssistantMessage(
						{ ...event.message, stopReason: "pending" },
						{ id: this.currentAssistantId },
					),
				});
			}
			return;
		}
		if (event.type === "message_update" && event.message.role === "assistant") {
			this.currentAssistantId ??= `live-${randomUUID()}`;
			this.updateCalls(event.message);
			const update = event.assistantMessageEvent;
			if (update.type === "text_delta" || update.type === "thinking_delta" || update.type === "toolcall_delta") {
				const kind =
					update.type === "text_delta" ? "text" : update.type === "thinking_delta" ? "thinking" : "toolCall";
				this.publishProgress({
					type: "assistant_delta",
					messageId: this.currentAssistantId,
					contentIndex: update.contentIndex,
					kind,
					delta: update.delta,
				});
			} else {
				this.publishProgress({
					type: "item_updated",
					item: toProtocolAssistantMessage(
						{ ...event.message, stopReason: "pending" },
						{ id: this.currentAssistantId },
					),
				});
			}
			return;
		}
		if (event.type === "message_end") {
			if (event.message.role === "assistant") {
				this.currentAssistantId ??= `live-${randomUUID()}`;
				this.updateCalls(event.message);
				const item = toProtocolAssistantMessage(event.message, { id: this.currentAssistantId });
				if (item.status === "streaming") throw new TypeError("Finished assistant message is still streaming");
				this.publishProgress({ type: "item_finished", item });
				this.currentAssistantId = undefined;
			} else if (event.message.role === "toolResult") {
				try {
					if (!this.finishedToolCalls.has(event.message.toolCallId)) this.finishTool(event.message);
				} finally {
					this.activeCalls.delete(event.message.toolCallId);
					this.liveTools.delete(event.message.toolCallId);
					this.finishedToolCalls.delete(event.message.toolCallId);
				}
			}
		}
		if (event.type === "tool_execution_start") {
			const call = this.activeCalls.get(event.toolCallId);
			if (!call || call.name !== event.toolName)
				throw new TypeError("Tool execution has no matching assistant tool call");
			const item: ToolTranscriptItem = {
				id: `tool-${randomUUID()}`,
				role: "tool",
				toolCallId: call.id,
				toolName: call.name,
				input: toProtocolJsonValue(call.arguments),
				content: [],
				timestamp: Date.now(),
				status: "running",
				isError: false,
			};
			this.liveTools.set(call.id, item.id);
			this.publishProgress({ type: "item_started", item });
			return;
		}
		if (event.type === "tool_execution_end") {
			if (this.finishedToolCalls.has(event.toolCallId)) return;
			const call = this.activeCalls.get(event.toolCallId);
			if (!call || call.name !== event.toolName)
				throw new TypeError("Tool result has no matching assistant tool call");
			const result: ToolResultMessage = {
				role: "toolResult",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				content: event.result.content ?? [],
				details: event.result.details,
				usage: event.result.usage,
				isError: event.isError,
				timestamp: Date.now(),
			};
			this.finishTool(result);
			return;
		}
		if (event.type === "agent_end") {
			this.currentAssistantId = undefined;
			this.activeCalls.clear();
			this.liveTools.clear();
			this.finishedToolCalls.clear();
		}
		if (event.type === "entry_appended") {
			// Monotonic counter (07 review ruling 8): never assign entry counts directly, so
			// in-place edits and branch moves cannot share a revision with an older snapshot.
			this.revision += 1;
			this.publishSnapshot();
			return;
		}
		if (
			event.type === "queue_update" ||
			event.type === "session_info_changed" ||
			event.type === "thinking_level_changed" ||
			event.type === "agent_start" ||
			event.type === "agent_end" ||
			event.type === "agent_settled" ||
			event.type === "compaction_start" ||
			event.type === "compaction_end" ||
			event.type === "auto_retry_start" ||
			event.type === "auto_retry_end"
		) {
			this.publishSnapshot();
		}
	}

	private currentAssistantId: string | undefined;

	private updateCalls(message: AssistantMessage) {
		for (const part of message.content) if (part.type === "toolCall") this.activeCalls.set(part.id, part);
	}

	private finishTool(message: ToolResultMessage) {
		const call = this.activeCalls.get(message.toolCallId);
		if (!call) throw new TypeError("Tool result has no preceding assistant tool call");
		const id = this.liveTools.get(message.toolCallId) ?? `tool-${randomUUID()}`;
		const item = toProtocolToolResultMessage(message, { id, call });
		this.liveTools.delete(message.toolCallId);
		this.finishedToolCalls.add(message.toolCallId);
		this.publishProgress({ type: "item_finished", item });
	}

	private publishProgress(progress: TranscriptProgress) {
		for (const listener of this.listeners) listener({ type: "progress", progress });
	}

	private publishSnapshot() {
		for (const listener of this.listeners) listener({ type: "snapshot" });
	}
	private projectQueuedSteer(queued: readonly string[]): SessionSnapshot["queuedSteer"] {
		const previous = this.queuedSteerProjection;
		const appends =
			queued.length >= previous.length && previous.every((entry, index) => entry.text === queued[index]);
		const drains =
			queued.length <= previous.length &&
			queued.every((text, index) => text === previous[previous.length - queued.length + index]?.text);
		if (appends) {
			this.queuedSteerProjection = [
				...previous,
				...queued
					.slice(previous.length)
					.map((text) => ({ text, id: `queued-${randomUUID()}`, timestamp: Date.now() })),
			];
		} else if (drains) {
			this.queuedSteerProjection = previous.slice(previous.length - queued.length);
		} else {
			this.queuedSteerProjection = queued.map((text) => ({
				text,
				id: `queued-${randomUUID()}`,
				timestamp: Date.now(),
			}));
		}
		return this.queuedSteerProjection.map(({ text, id, timestamp }) => ({
			id,
			role: "user",
			content: [{ type: "text", text }],
			timestamp,
		}));
	}
}

function parseTimestamp(timestamp: string): number {
	const value = Date.parse(timestamp);
	if (!Number.isFinite(value)) throw new TypeError("Invalid session timestamp");
	return value;
}

function normalizeSummaryText(text: string): string {
	return text.replace(/[\n\t]+/g, " ").trim();
}

function truncateSummary(text: string, max: number): string {
	const normalized = normalizeSummaryText(text);
	return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}

function textOfMessageContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => {
			if (typeof part !== "object" || part === null) return false;
			const candidate = part as { type?: unknown; text?: unknown };
			return candidate.type === "text" && typeof candidate.text === "string";
		})
		.map((part) => part.text)
		.join(" ");
}

const TREE_SUMMARY_MAX_LENGTH = 200;

/**
 * Remote-safe flat tree projection (10-flat-tree-export-layout): identity,
 * parent link, kind, label, and a plain-text summary per entry.
 */
function projectTreeEntry(entry: SessionEntry, label: string | undefined): SessionTreeEntryProjection {
	let kind: SessionTreeNodeKind;
	let customType: string | undefined;
	let summary: string;
	if (entry.type === "message") {
		const role = entry.message.role;
		if (role === "user") {
			kind = "user";
			summary = truncateSummary(
				textOfMessageContent((entry.message as UserMessage).content),
				TREE_SUMMARY_MAX_LENGTH,
			);
		} else if (role === "assistant") {
			kind = "assistant";
			summary = truncateSummary(
				textOfMessageContent((entry.message as AssistantMessage).content),
				TREE_SUMMARY_MAX_LENGTH,
			);
		} else {
			kind = "tool";
			const toolResult = entry.message as ToolResultMessage;
			summary = truncateSummary(
				`${toolResult.toolName}: ${textOfMessageContent(toolResult.content)}`,
				TREE_SUMMARY_MAX_LENGTH,
			);
		}
	} else if (entry.type === "custom_message") {
		kind = "custom";
		customType = entry.customType;
		summary = truncateSummary(textOfMessageContent(entry.content ?? []), TREE_SUMMARY_MAX_LENGTH);
	} else if (entry.type === "compaction" || entry.type === "branch_summary") {
		kind = entry.type;
		summary = truncateSummary(entry.summary ?? "", TREE_SUMMARY_MAX_LENGTH);
	} else {
		kind = "other";
		summary = entry.type.replace(/_/g, " ");
	}
	return {
		id: entry.id,
		parentId: entry.parentId,
		kind,
		...(customType !== undefined ? { customType } : {}),
		...(label !== undefined ? { label } : {}),
		summary: summary.length > 0 ? summary : "(empty)",
		timestamp: parseTimestamp(entry.timestamp),
	};
}

function availableModel(runtime: ModelRuntime, ref: { provider: string; id: string }): Model<Api> | undefined {
	return runtime
		.getAvailableSnapshot()
		.find((candidate) => candidate.provider === ref.provider && candidate.id === ref.id);
}
export function modelsForRuntime(runtime: ModelRuntime): ModelMetadata[] {
	return runtime
		.getAvailableSnapshot()
		.map((model) => toProtocolModelMetadata(model, runtime.hasConfiguredAuth(model.provider)));
}

function mapStoreError(error: unknown): unknown {
	if (error instanceof SessionStoreError) {
		if (error.code === "not_found") return new SessionNotFoundError(error.message);
		if (error.code === "session_locked") return new SessionLockedError(error.message);
		if (error.code === "invalid_request") return new PiServerError("invalid_request", error.message);
	}
	return error;
}
