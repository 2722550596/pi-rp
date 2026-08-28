/**
 * RPC mode: Headless operation with JSON stdin/stdout protocol.
 *
 * Used for embedding the agent in other applications.
 * Receives commands as JSON on stdin, outputs events and responses as JSON on stdout.
 *
 * Protocol:
 * - Commands: JSON objects with `type` field, optional `id` for correlation
 * - Responses: JSON objects with `type: "response"`, `command`, `success`, and optional `data`/`error`
 * - Events: AgentSessionEvent objects streamed as they occur
 * - Extension UI: Extension UI requests are emitted, client responds with extension_ui_response
 */

import * as crypto from "node:crypto";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	WorkingIndicatorOptions,
} from "../../core/extensions/index.ts";
import {
	flushRawStdout,
	takeOverStdout,
	waitForRawStdoutBackpressure,
	writeRawStdout,
} from "../../core/output-guard.ts";
import type { JsonValue } from "../../state/state-manager.ts";
import { killTrackedDetachedChildren } from "../../utils/shell.ts";
import { type Theme, theme } from "../interactive/theme/theme.ts";
import { toJsonEvent } from "../json-event.ts";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.ts";
import type {
	OrchestrationAck,
	RpcCommand,
	RpcContextRequestEvent,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcOrchestrationRequestEvent,
	RpcResponse,
	RpcSessionState,
	RpcSlashCommand,
	RpcStateChangedEvent,
} from "./rpc-types.ts";

// Re-export types for consumers
export type {
	OrchestrationAck,
	RpcCommand,
	RpcContextRequestEvent,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcOrchestrationRequestEvent,
	RpcResponse,
	RpcSessionState,
	RpcStateChangedEvent,
} from "./rpc-types.ts";

/** A live `watch_state` subscription bound to a session's StateManager. */
interface WatchStateSubscription {
	path: string | undefined;
	notify: () => void;
	unsubscribe: () => void;
	timer: ReturnType<typeof setTimeout> | undefined;
}

/** 父进程经 context_response 返回的数据（affiliated-session B 活体读取）。 */
export interface RpcContextResponseData {
	messages?: Array<{ role: string; content: unknown }>;
	state?: Record<string, unknown>;
	error?: string;
}

/**
 * 子进程侧处理父进程 context_response 的纯逻辑（单测 seam，rpc-mode 闭包外）：
 * 解析挂起的 requestParentContext promise，并**回发 ack**——父侧 `send()` 依赖
 * 这个 ack 才 resolve，不回会让每次 context_request 在父进程挂满 30s 超时
 * （rpc-types 声明了 context_response 的 success 变体）。requestId 未知时照常 ack
 * （父侧总是在等待），只是没有 promise 可解析。
 */
export function handleParentContextResponse(
	parsed: unknown,
	pending: Map<string, { resolve: (value: RpcContextResponseData) => void; reject: (error: Error) => void }>,
	emit: (obj: RpcResponse) => void,
): void {
	if (typeof parsed !== "object" || parsed === null) return;
	const response = parsed as {
		id?: string;
		requestId?: string;
		messages?: Array<{ role: string; content: unknown }>;
		state?: Record<string, unknown>;
		error?: string;
	};
	const req = response.requestId ? pending.get(response.requestId) : undefined;
	if (req) {
		pending.delete(response.requestId!);
		if (response.error) req.reject(new Error(response.error));
		else req.resolve({ messages: response.messages, state: response.state });
	}
	emit({ id: response.id, type: "response", command: "context_response", success: true } as RpcResponse);
}

/** 父进程经 orchestration_response 返回的裁决（pass_mic 编排）。 */
export interface RpcOrchestrationAckData {
	ack: OrchestrationAck;
}

/**
 * 子进程侧处理父进程 orchestration_response 的纯逻辑（单测 seam，rpc-mode 闭包外）：
 * 解析挂起的 requestOrchestration promise，并**回发 ack**——父侧 `send()` 依赖
 * 这个 ack 才 resolve，不回会让每次 orchestration_request 在父进程挂满 30s 超时
 * （rpc-types 声明了 orchestration_response 的 success 变体）。requestId 未知时照常 ack
 * （父侧总是在等待），只是没有 promise 可解析。
 */
export function handleParentOrchestrationResponse(
	parsed: unknown,
	pending: Map<string, { resolve: (value: RpcOrchestrationAckData) => void; reject: (error: Error) => void }>,
	emit: (obj: RpcResponse) => void,
): void {
	if (typeof parsed !== "object" || parsed === null) return;
	const response = parsed as { id?: string; requestId?: string; ack?: OrchestrationAck };
	const req = response.requestId ? pending.get(response.requestId) : undefined;
	if (req) {
		pending.delete(response.requestId!);
		if (!response.ack) req.reject(new Error("orchestration_response missing ack"));
		else req.resolve({ ack: response.ack });
	}
	emit({ id: response.id, type: "response", command: "orchestration_response", success: true } as RpcResponse);
}

/**
 * Run in RPC mode.
 * Listens for JSON commands on stdin, outputs events and responses on stdout.
 */
export async function runRpcMode(runtimeHost: AgentSessionRuntime): Promise<never> {
	takeOverStdout();
	let session = runtimeHost.session;
	let unsubscribe: (() => void) | undefined;
	let unsubscribeBackpressure: (() => void) | undefined;

	/** Active `watch_state` subscriptions (unsubscribed on rebind/shutdown). */
	const watchSubscriptions: WatchStateSubscription[] = [];

	const output = (obj: RpcResponse | RpcExtensionUIRequest | RpcStateChangedEvent | object) => {
		writeRawStdout(serializeJsonLine(obj));
	};

	const success = <T extends RpcCommand["type"]>(
		id: string | undefined,
		command: T,
		data?: object | null,
	): RpcResponse => {
		if (data === undefined) {
			return { id, type: "response", command, success: true } as RpcResponse;
		}
		return { id, type: "response", command, success: true, data } as RpcResponse;
	};

	const error = (id: string | undefined, command: string, message: string): RpcResponse => {
		return { id, type: "response", command, success: false, error: message };
	};

	// Pending extension UI requests waiting for response
	const pendingExtensionRequests = new Map<
		string,
		{ resolve: (value: any) => void; reject: (error: Error) => void }
	>();

	// Pending parent-context requests (affiliated-session B) waiting for context_response
	const pendingContextRequests = new Map<
		string,
		{ resolve: (value: RpcContextResponseData) => void; reject: (error: Error) => void }
	>();
	const CONTEXT_REQUEST_TIMEOUT_MS = 10_000;

	// Pending orchestration requests (pass_mic) waiting for orchestration_response
	const pendingOrchestrationRequests = new Map<
		string,
		{ resolve: (value: RpcOrchestrationAckData) => void; reject: (error: Error) => void }
	>();
	const ORCHESTRATION_REQUEST_TIMEOUT_MS = 10_000;

	/**
	 * 子进程扩展调用的「活体读取父会话」：挂起 promise、向客户端发 context_request，
	 * 等 context_response（stdin 命令通道）回来解析。超时或父进程显式 error → reject
	 * （调用方按需回退，如世界线角色更新器回退磁盘解析）。
	 */
	function requestParentContext(request: { since?: string; namespaces?: string[] }): Promise<RpcContextResponseData> {
		const requestId = crypto.randomUUID();
		return new Promise<RpcContextResponseData>((resolve, reject) => {
			const timeoutId = setTimeout(() => {
				pendingContextRequests.delete(requestId);
				reject(new Error("context_request timeout: parent did not respond"));
			}, CONTEXT_REQUEST_TIMEOUT_MS);
			pendingContextRequests.set(requestId, {
				resolve: (value: RpcContextResponseData) => {
					clearTimeout(timeoutId);
					pendingContextRequests.delete(requestId);
					resolve(value);
				},
				reject: (error: Error) => {
					clearTimeout(timeoutId);
					pendingContextRequests.delete(requestId);
					reject(error);
				},
			});
			output({ type: "context_request", requestId, ...request } as RpcContextRequestEvent);
		});
	}

	/**
	 * 子进程扩展调用的「请求父会话编排」（pass_mic）：挂起 promise、向客户端发
	 * orchestration_request，等 orchestration_response（stdin 命令通道）回来解析。
	 * 超时或父进程显式 error → reject（调用方按需处理）。
	 */
	function requestOrchestration(request: {
		kind: "pass_mic";
		from: string;
		target: string;
	}): Promise<RpcOrchestrationAckData> {
		const requestId = crypto.randomUUID();
		const { promise, resolve, reject } = Promise.withResolvers<RpcOrchestrationAckData>();
		const timeoutId = setTimeout(() => {
			pendingOrchestrationRequests.delete(requestId);
			reject(new Error("orchestration_request timeout: parent did not respond"));
		}, ORCHESTRATION_REQUEST_TIMEOUT_MS);
		pendingOrchestrationRequests.set(requestId, {
			resolve: (value: RpcOrchestrationAckData) => {
				clearTimeout(timeoutId);
				pendingOrchestrationRequests.delete(requestId);
				resolve(value);
			},
			reject: (error: Error) => {
				clearTimeout(timeoutId);
				pendingOrchestrationRequests.delete(requestId);
				reject(error);
			},
		});
		output({ type: "orchestration_request", requestId, ...request } as RpcOrchestrationRequestEvent);
		return promise;
	}

	// Shutdown request flag
	let shutdownRequested = false;
	let shuttingDown = false;
	const signalCleanupHandlers: Array<() => void> = [];

	/** Helper for dialog methods with signal/timeout support */
	function createDialogPromise<T>(
		opts: ExtensionUIDialogOptions | undefined,
		defaultValue: T,
		request: Record<string, unknown>,
		parseResponse: (response: RpcExtensionUIResponse) => T,
	): Promise<T> {
		if (opts?.signal?.aborted) return Promise.resolve(defaultValue);

		const id = crypto.randomUUID();
		return new Promise((resolve, reject) => {
			let timeoutId: ReturnType<typeof setTimeout> | undefined;

			const cleanup = () => {
				if (timeoutId) clearTimeout(timeoutId);
				opts?.signal?.removeEventListener("abort", onAbort);
				pendingExtensionRequests.delete(id);
			};

			const onAbort = () => {
				cleanup();
				resolve(defaultValue);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			if (opts?.timeout) {
				timeoutId = setTimeout(() => {
					cleanup();
					resolve(defaultValue);
				}, opts.timeout);
			}

			pendingExtensionRequests.set(id, {
				resolve: (response: RpcExtensionUIResponse) => {
					cleanup();
					resolve(parseResponse(response));
				},
				reject,
			});
			output({ type: "extension_ui_request", id, ...request } as RpcExtensionUIRequest);
		});
	}

	/**
	 * Create an extension UI context that uses the RPC protocol.
	 */
	const createExtensionUIContext = (): ExtensionUIContext => ({
		select: (title, options, opts) =>
			createDialogPromise(opts, undefined, { method: "select", title, options, timeout: opts?.timeout }, (r) =>
				"cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined,
			),

		confirm: (title, message, opts) =>
			createDialogPromise(opts, false, { method: "confirm", title, message, timeout: opts?.timeout }, (r) =>
				"cancelled" in r && r.cancelled ? false : "confirmed" in r ? r.confirmed : false,
			),

		input: (title, placeholder, opts) =>
			createDialogPromise(opts, undefined, { method: "input", title, placeholder, timeout: opts?.timeout }, (r) =>
				"cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined,
			),

		notify(message: string, type?: "info" | "warning" | "error"): void {
			// Fire and forget - no response needed
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "notify",
				message,
				notifyType: type,
			} as RpcExtensionUIRequest);
		},

		onTerminalInput(): () => void {
			// Raw terminal input not supported in RPC mode
			return () => {};
		},

		setStatus(key: string, text: string | undefined): void {
			// Fire and forget - no response needed
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "setStatus",
				statusKey: key,
				statusText: text,
			} as RpcExtensionUIRequest);
		},

		setWorkingMessage(_message?: string): void {
			// Working message not supported in RPC mode - requires TUI loader access
		},

		setWorkingVisible(_visible: boolean): void {
			// Working visibility not supported in RPC mode - requires TUI loader access
		},

		setWorkingIndicator(_options?: WorkingIndicatorOptions): void {
			// Working indicator customization not supported in RPC mode - requires TUI loader access
		},

		setHiddenThinkingLabel(_label?: string): void {
			// Hidden thinking label not supported in RPC mode - requires TUI message rendering access
		},

		setWidget(key: string, content: unknown, options?: ExtensionWidgetOptions): void {
			// Only support string arrays in RPC mode - factory functions are ignored
			if (content === undefined || Array.isArray(content)) {
				output({
					type: "extension_ui_request",
					id: crypto.randomUUID(),
					method: "setWidget",
					widgetKey: key,
					widgetLines: content as string[] | undefined,
					widgetPlacement: options?.placement,
				} as RpcExtensionUIRequest);
			}
			// Component factories are not supported in RPC mode - would need TUI access
		},

		setFooter(_factory: unknown): void {
			// Custom footer not supported in RPC mode - requires TUI access
		},

		setHeader(_factory: unknown): void {
			// Custom header not supported in RPC mode - requires TUI access
		},

		setTitle(title: string): void {
			// Fire and forget - host can implement terminal title control
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "setTitle",
				title,
			} as RpcExtensionUIRequest);
		},

		async custom() {
			// Custom UI not supported in RPC mode
			return undefined as never;
		},

		pasteToEditor(text: string): void {
			// Paste handling not supported in RPC mode - falls back to setEditorText
			this.setEditorText(text);
		},

		setEditorText(text: string): void {
			// Fire and forget - host can implement editor control
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "set_editor_text",
				text,
			} as RpcExtensionUIRequest);
		},

		getEditorText(): string {
			// Synchronous method can't wait for RPC response
			// Host should track editor state locally if needed
			return "";
		},

		async editor(title: string, prefill?: string): Promise<string | undefined> {
			const id = crypto.randomUUID();
			return new Promise((resolve, reject) => {
				pendingExtensionRequests.set(id, {
					resolve: (response: RpcExtensionUIResponse) => {
						if ("cancelled" in response && response.cancelled) {
							resolve(undefined);
						} else if ("value" in response) {
							resolve(response.value);
						} else {
							resolve(undefined);
						}
					},
					reject,
				});
				output({ type: "extension_ui_request", id, method: "editor", title, prefill } as RpcExtensionUIRequest);
			});
		},

		addAutocompleteProvider(): void {
			// Autocomplete provider composition is not supported in RPC mode
		},

		setEditorComponent(): void {
			// Custom editor components not supported in RPC mode
		},

		getEditorComponent() {
			// Custom editor components not supported in RPC mode
			return undefined;
		},

		get theme() {
			return theme;
		},

		getAllThemes() {
			return [];
		},

		getTheme(_name: string) {
			return undefined;
		},

		setTheme(_theme: string | Theme) {
			// Theme switching not supported in RPC mode
			return { success: false, error: "Theme switching not supported in RPC mode" };
		},

		getToolsExpanded() {
			// Tool expansion not supported in RPC mode - no TUI
			return false;
		},

		setToolsExpanded(_expanded: boolean) {
			// Tool expansion not supported in RPC mode - no TUI
		},
	});

	runtimeHost.setRebindSession(async () => {
		await rebindSession();
	});

	const rebindSession = async (): Promise<void> => {
		session = runtimeHost.session;
		await session.bindExtensions({
			uiContext: createExtensionUIContext(),
			mode: "rpc",
			// 子进程扩展的「活体读取父会话」：RPC 通道实现（TUI/print 无父会话，不绑定）。
			parentContextRequest: requestParentContext,
			// 子进程扩展的「请求父会话编排」（pass_mic）：RPC 通道实现（TUI/print 无父会话，不绑定）。
			orchestrationRequest: requestOrchestration,
			commandContextActions: {
				waitForIdle: () => session.waitForIdle(),
				newSession: async (options) => runtimeHost.newSession(options),
				fork: async (entryId, forkOptions) => {
					const result = await runtimeHost.fork(entryId, forkOptions);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, options) => {
					const result = await session.navigateTree(targetId, {
						summarize: options?.summarize,
						customInstructions: options?.customInstructions,
						replaceInstructions: options?.replaceInstructions,
						label: options?.label,
					});
					return { cancelled: result.cancelled };
				},
				switchSession: async (sessionPath, options) => {
					return runtimeHost.switchSession(sessionPath, options);
				},
				reload: async () => {
					await session.reload();
				},
			},
			shutdownHandler: () => {
				shutdownRequested = true;
			},
			onError: (err) => {
				output({ type: "extension_error", extensionPath: err.extensionPath, event: err.event, error: err.error });
			},
		});

		unsubscribe?.();
		unsubscribeBackpressure?.();
		// Rebind watch subscriptions to the new session's StateManager; the
		// notify closures read the live `session` variable, so they now target
		// the new session automatically.
		for (const sub of watchSubscriptions) {
			clearTimeout(sub.timer);
			sub.unsubscribe();
			sub.timer = undefined;
			sub.unsubscribe = session.stateManager.subscribe(() => {
				clearTimeout(sub.timer);
				sub.timer = setTimeout(sub.notify, 100);
			});
		}
		unsubscribe = session.subscribe((event) => {
			output(toJsonEvent(event));
			if (event.type === "agent_settled") {
				void checkShutdownRequested();
			}
		});
		unsubscribeBackpressure = session.agent.subscribe(async () => {
			await waitForRawStdoutBackpressure();
		});
	};

	const registerSignalHandlers = (): void => {
		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const handler = () => {
				killTrackedDetachedChildren();
				void shutdown(signal === "SIGHUP" ? 129 : 143, signal);
			};
			process.on(signal, handler);
			signalCleanupHandlers.push(() => process.off(signal, handler));
		}
	};

	await rebindSession();
	registerSignalHandlers();

	// Handle a single command
	const handleCommand = async (command: RpcCommand): Promise<RpcResponse | undefined> => {
		const id = command.id;

		switch (command.type) {
			// =================================================================
			// Prompting
			// =================================================================

			case "prompt": {
				// Start prompt handling immediately, but emit the authoritative response only after
				// prompt preflight succeeds. Queued and immediately handled prompts also count as success.
				let preflightSucceeded = false;
				void session
					.prompt(command.message, {
						images: command.images,
						streamingBehavior: command.streamingBehavior,
						source: "rpc",
						preflightResult: (didSucceed) => {
							if (didSucceed) {
								preflightSucceeded = true;
								output(success(id, "prompt"));
							}
						},
					})
					.catch((e) => {
						if (!preflightSucceeded) {
							output(error(id, "prompt", e.message));
						}
					});
				return undefined;
			}

			case "steer": {
				await session.steer(command.message, command.images);
				return success(id, "steer");
			}

			case "follow_up": {
				await session.followUp(command.message, command.images);
				return success(id, "follow_up");
			}

			case "abort": {
				await session.abort();
				return success(id, "abort");
			}

			case "new_session": {
				const options = command.parentSession ? { parentSession: command.parentSession } : undefined;
				const result = await runtimeHost.newSession(options);
				if (!result.cancelled) {
					await rebindSession();
				}
				return success(id, "new_session", result);
			}

			// =================================================================
			// State
			// =================================================================

			case "get_state": {
				const revision = session.stateManager.revision;
				const value = command.path ? session.stateManager.get(command.path) : session.stateManager.snapshot();
				const state: RpcSessionState = {
					model: session.model,
					thinkingLevel: session.thinkingLevel,
					isStreaming: session.isStreaming,
					isCompacting: session.isCompacting,
					steeringMode: session.steeringMode,
					followUpMode: session.followUpMode,
					sessionFile: session.sessionFile,
					sessionId: session.sessionId,
					sessionName: session.sessionName,
					activePresetId: session.activePreset?.id,
					autoCompactionEnabled: session.autoCompactionEnabled,
					messageCount: session.messages.length,
					pendingMessageCount: session.pendingMessageCount,
					stateRevision: revision,
					path: command.path,
					// Path mode fetches a namespace subtree (an object); full mode returns the snapshot.
					state: command.ifVersion === revision ? undefined : (value as Record<string, unknown> | undefined),
				};
				return success(id, "get_state", state);
			}

			case "update_state": {
				const { path, op, value } = command;
				const validation = session.schemaValidator.validate(
					path,
					op,
					value as JsonValue | undefined,
					session.stateManager.snapshot() as Record<string, JsonValue>,
				);
				if (!validation.ok) {
					return error(id, "update_state", validation.reason ?? "validation failed");
				}
				const effectiveValue = validation.correctedValue ?? value;
				const result = session.stateManager.apply(path, op, effectiveValue as JsonValue);
				// Persist immediately when idle (mirrors AgentSession extension updateState),
				// so a peer can read the new state from the session file without waiting for turn_end.
				if (session.isIdle) {
					session.sessionManager.appendState(session.stateManager.snapshot());
					session.stateManager.clearDirty();
				}
				return success(id, "update_state", { path: result.path, newValue: result.newValue });
			}

			case "watch_state": {
				const watchPath = command.path;
				const record: WatchStateSubscription = {
					path: watchPath,
					notify: () => {
						clearTimeout(record.timer);
						record.timer = undefined;
						const value = watchPath ? session.stateManager.get(watchPath) : session.stateManager.snapshot();
						output({
							type: "state_changed",
							stateRevision: session.stateManager.revision,
							path: watchPath,
							value: value as Record<string, unknown> | undefined,
						});
					},
					unsubscribe: () => {},
					timer: undefined,
				};
				record.unsubscribe = session.stateManager.subscribe(() => {
					clearTimeout(record.timer);
					record.timer = setTimeout(record.notify, 100);
				});
				watchSubscriptions.push(record);
				// Response = initial push
				const initialValue = watchPath ? session.stateManager.get(watchPath) : session.stateManager.snapshot();
				return success(id, "watch_state", {
					stateRevision: session.stateManager.revision,
					path: watchPath,
					value: initialValue as Record<string, unknown> | undefined,
				});
			}

			// =================================================================
			// Model
			// =================================================================

			case "set_model": {
				const models = session.modelRuntime.getAvailableSnapshot();
				const model = models.find((m) => m.provider === command.provider && m.id === command.modelId);
				if (!model) {
					return error(id, "set_model", `Model not found: ${command.provider}/${command.modelId}`);
				}
				// persistSettings 默认 true（既有行为不变）；false = 只改内存态 + 会话
				// JSONL，不写全局 settings.json（共享 agent dir 的宿主用）。
				await session.setModel(model, command.persistSettings ?? true);
				return success(id, "set_model", model);
			}

			case "cycle_model": {
				const result = await session.cycleModel();
				if (!result) {
					return success(id, "cycle_model", null);
				}
				return success(id, "cycle_model", result);
			}

			case "get_available_models": {
				const models = session.modelRuntime.getAvailableSnapshot();
				return success(id, "get_available_models", { models });
			}

			// =================================================================
			// Thinking
			// =================================================================

			case "set_thinking_level": {
				session.setThinkingLevel(command.level, command.persistSettings ?? true);
				return success(id, "set_thinking_level");
			}

			case "cycle_thinking_level": {
				const level = session.cycleThinkingLevel();
				if (!level) {
					return success(id, "cycle_thinking_level", null);
				}
				return success(id, "cycle_thinking_level", { level });
			}

			case "get_available_thinking_levels": {
				const levels = session.getAvailableThinkingLevels();
				return success(id, "get_available_thinking_levels", { levels });
			}

			// =================================================================
			// Presets
			// =================================================================

			case "set_preset": {
				const result = await session.setActivePreset(command.presetId);
				if (!result.ok) {
					return error(id, "set_preset", `Prompt preset "${command.presetId}" not found.`);
				}
				return success(id, "set_preset", {
					presetId: command.presetId,
					...(result.model ? { model: { provider: result.model.provider, id: result.model.id } } : {}),
					...(result.error ? { error: result.error } : {}),
				});
			}

			// =================================================================
			// Queue Modes
			// =================================================================

			case "set_steering_mode": {
				session.setSteeringMode(command.mode);
				return success(id, "set_steering_mode");
			}

			case "set_follow_up_mode": {
				session.setFollowUpMode(command.mode);
				return success(id, "set_follow_up_mode");
			}

			// =================================================================
			// Compaction
			// =================================================================

			case "compact": {
				const result = await session.compact(command.customInstructions);
				return success(id, "compact", result);
			}

			case "set_auto_compaction": {
				session.setAutoCompactionEnabled(command.enabled);
				return success(id, "set_auto_compaction");
			}

			// =================================================================
			// Retry
			// =================================================================

			case "set_auto_retry": {
				session.setAutoRetryEnabled(command.enabled);
				return success(id, "set_auto_retry");
			}

			case "abort_retry": {
				session.abortRetry();
				return success(id, "abort_retry");
			}

			// =================================================================
			// Bash
			// =================================================================

			case "bash": {
				const eventResult = await session.extensionRunner.emitUserBash({
					type: "user_bash",
					command: command.command,
					excludeFromContext: command.excludeFromContext ?? false,
					cwd: session.sessionManager.getCwd(),
				});

				if (eventResult?.result) {
					session.recordBashResult(command.command, eventResult.result, {
						excludeFromContext: command.excludeFromContext,
					});
					return success(id, "bash", eventResult.result);
				}

				const result = await session.executeBash(command.command, undefined, {
					excludeFromContext: command.excludeFromContext,
					operations: eventResult?.operations,
				});
				return success(id, "bash", result);
			}

			case "abort_bash": {
				session.abortBash();
				return success(id, "abort_bash");
			}

			// =================================================================
			// Session
			// =================================================================

			case "get_session_stats": {
				const stats = session.getSessionStats();
				return success(id, "get_session_stats", stats);
			}

			case "export_html": {
				const path = await session.exportToHtml(command.outputPath);
				return success(id, "export_html", { path });
			}

			case "switch_session": {
				const result = await runtimeHost.switchSession(command.sessionPath);
				if (!result.cancelled) {
					await rebindSession();
				}
				return success(id, "switch_session", result);
			}

			case "fork": {
				const result = await runtimeHost.fork(command.entryId);
				if (!result.cancelled) {
					await rebindSession();
				}
				return success(id, "fork", { text: result.selectedText, cancelled: result.cancelled });
			}

			case "clone": {
				const leafId = session.sessionManager.getLeafId();
				if (!leafId) {
					return error(id, "clone", "Cannot clone session: no current entry selected");
				}
				const result = await runtimeHost.fork(leafId, { position: "at" });
				if (!result.cancelled) {
					await rebindSession();
				}
				return success(id, "clone", { cancelled: result.cancelled });
			}

			case "reroll": {
				// Fire-and-forget like "prompt": reroll() branches + restores
				// state synchronously (emitting leaf_changed); the regeneration
				// run afterwards streams agent events to stdout.
				void (async () => {
					try {
						const rerolled = await session.reroll();
						if (!rerolled) {
							output(error(id, "reroll", "Cannot reroll: session is busy or no user message to branch to"));
							return;
						}
						output(success(id, "reroll"));
					} catch (err) {
						output(error(id, "reroll", err instanceof Error ? err.message : String(err)));
						return;
					}
					// Run failures surface through agent events, not a second response.
					await session.startRerollRun().catch(() => {});
				})();
				return undefined;
			}

			case "get_fork_messages": {
				const messages = session.getUserMessagesForForking();
				return success(id, "get_fork_messages", { messages });
			}

			case "get_entries": {
				const sessionManager = session.sessionManager;
				let entries = sessionManager.getEntries();
				if (command.since !== undefined) {
					const sinceIndex = entries.findIndex((e) => e.id === command.since);
					if (sinceIndex === -1) {
						return error(id, "get_entries", `Entry not found: ${command.since}`);
					}
					entries = entries.slice(sinceIndex + 1);
				}
				return success(id, "get_entries", { entries, leafId: sessionManager.getLeafId() });
			}

			case "init_context": {
				// 出生继承（affiliated-session A）：spawn 后、首次 prompt 前，把父会话的
				// 历史切片（LLM 消息）与 state 命名空间子集播种进本会话。只影响 LLM 上下文
				// 与 stateManager，不写 session 文件——子进程自己的会话内容保持独立。
				if (command.history && command.history.length > 0) {
					session.agent.state.messages = [...command.history];
				}
				if (command.state) {
					session.stateManager.load(command.state);
				}
				return success(id, "init_context", { ok: true });
			}

			case "get_tree": {
				const sessionManager = session.sessionManager;
				return success(id, "get_tree", { tree: sessionManager.getTree(), leafId: sessionManager.getLeafId() });
			}

			case "navigate_tree": {
				// Move the session tree leaf to the target's rollback position
				// (no summarization: used by the writer process to rewind a
				// character session in lockstep with its own rollback).
				// editorText：目标为玩家输入条目时 = 该条目的文本（引擎语义
				// 「text goes to editor」），供前端跳转后回填输入框继续该分支。
				try {
					const result = await session.navigateTree(command.targetId, { summarize: false, label: command.label });
					return success(id, "navigate_tree", { cancelled: result.cancelled, editorText: result.editorText });
				} catch (err) {
					return error(id, "navigate_tree", err instanceof Error ? err.message : String(err));
				}
			}

			case "get_last_assistant_text": {
				const text = session.getLastAssistantText();
				return success(id, "get_last_assistant_text", { text });
			}

			case "set_session_name": {
				const name = command.name.trim();
				if (!name) {
					return error(id, "set_session_name", "Session name cannot be empty");
				}
				session.setSessionName(name);
				return success(id, "set_session_name");
			}

			// =================================================================
			// Messages
			// =================================================================

			case "get_messages": {
				return success(id, "get_messages", { messages: session.messages });
			}

			// =================================================================
			// Commands (available for invocation via prompt)
			// =================================================================

			case "get_commands": {
				const commands: RpcSlashCommand[] = [];

				for (const command of session.extensionRunner.getRegisteredCommands()) {
					commands.push({
						name: command.invocationName,
						description: command.description,
						source: "extension",
						sourceInfo: command.sourceInfo,
					});
				}

				for (const template of session.promptTemplates) {
					commands.push({
						name: template.name,
						description: template.description,
						...(template.argumentHint && { argumentHint: template.argumentHint }),
						source: "prompt",
						sourceInfo: template.sourceInfo,
					});
				}

				for (const skill of session.resourceLoader.getSkills().skills) {
					commands.push({
						name: `skill:${skill.name}`,
						description: skill.description,
						source: "skill",
						sourceInfo: skill.sourceInfo,
					});
				}

				return success(id, "get_commands", { commands });
			}

			case "reload_prompts": {
				// 窄重载：只重扫 prompt 模板（不碰扩展/runtime/事件）；rpc-mode 串行，
				// 若当前有回合在生成，本命令排在回合后执行，下一句输入即用新模板。
				await session.reloadPromptTemplates();
				return success(id, "reload_prompts");
			}

			default: {
				const unknownCommand = command as { type: string };
				return error(id, unknownCommand.type, `Unknown command: ${unknownCommand.type}`);
			}
		}
	};

	/**
	 * Check if shutdown was requested and perform shutdown if so.
	 * Called after handling each command when waiting for the next command.
	 */
	let detachInput = () => {};

	async function shutdown(exitCode = 0, signal?: NodeJS.Signals): Promise<never> {
		if (shuttingDown) {
			process.exit(exitCode);
		}
		shuttingDown = true;
		for (const cleanup of signalCleanupHandlers) {
			cleanup();
		}
		for (const sub of watchSubscriptions) {
			clearTimeout(sub.timer);
			sub.unsubscribe();
		}
		watchSubscriptions.length = 0;
		unsubscribe?.();
		unsubscribeBackpressure?.();
		await runtimeHost.dispose();
		detachInput();
		process.stdin.pause();
		if (signal !== "SIGTERM") {
			await flushRawStdout();
		}
		process.exit(exitCode);
	}

	async function checkShutdownRequested(): Promise<void> {
		if (!shutdownRequested) return;
		await shutdown();
	}

	const handleInputLine = async (line: string) => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (parseError: unknown) {
			output(
				error(
					undefined,
					"parse",
					`Failed to parse command: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
				),
			);
			await waitForRawStdoutBackpressure();
			return;
		}

		// Handle extension UI responses
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"type" in parsed &&
			parsed.type === "extension_ui_response"
		) {
			const response = parsed as RpcExtensionUIResponse;
			const pending = pendingExtensionRequests.get(response.id);
			if (pending) {
				pendingExtensionRequests.delete(response.id);
				pending.resolve(response);
			}
			return;
		}

		// Handle parent-context responses (affiliated-session B): resolve the
		// child extension's pending requestParentContext promise, and ack the
		// parent's send() — rpc-types 声明了 context_response 的 success 变体，
		// 不回 ack 会让父侧 send() 挂满 30s 超时（每次 context_request 烧一个僵尸 pending）。
		if (typeof parsed === "object" && parsed !== null && "type" in parsed && parsed.type === "context_response") {
			handleParentContextResponse(parsed, pendingContextRequests, (obj) => {
				output(obj);
			});
			await waitForRawStdoutBackpressure();
			return;
		}

		// Handle orchestration responses (pass_mic): resolve the child extension's
		// pending requestOrchestration promise, and ack the parent's send() —
		// rpc-types 声明了 orchestration_response 的 success 变体，不回 ack 会让
		// 父侧 send() 挂满 30s 超时（每次 orchestration_request 烧一个僵尸 pending）。
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"type" in parsed &&
			parsed.type === "orchestration_response"
		) {
			handleParentOrchestrationResponse(parsed, pendingOrchestrationRequests, (obj) => {
				output(obj);
			});
			await waitForRawStdoutBackpressure();
			return;
		}

		const command = parsed as RpcCommand;
		try {
			const response = await handleCommand(command);
			if (response) {
				output(response);
				await waitForRawStdoutBackpressure();
			}
			await checkShutdownRequested();
		} catch (commandError: unknown) {
			output(
				error(
					command.id,
					command.type,
					commandError instanceof Error ? commandError.message : String(commandError),
				),
			);
			await waitForRawStdoutBackpressure();
		}
	};

	const onInputEnd = () => {
		void shutdown();
	};
	process.stdin.on("end", onInputEnd);

	detachInput = (() => {
		const detachJsonl = attachJsonlLineReader(process.stdin, (line) => {
			void handleInputLine(line);
		});
		return () => {
			detachJsonl();
			process.stdin.off("end", onInputEnd);
		};
	})();

	// Keep process alive forever
	return new Promise(() => {});
}
