import { contentText } from "@earendil-works/pi-ai";
import type { JsonValue } from "../../state/state-manager.ts";
import type { AgentSession } from "../agent-session.ts";
import { createExtensionRuntime } from "../extensions/loader.ts";
import type { ModelRuntime } from "../model-runtime.ts";
import type { RequestGateway } from "../request-gateway.ts";
import { createAgentSession } from "../sdk.ts";
import { SessionManager } from "../session-manager.ts";
import { truncateTail } from "../tools/truncate.ts";
import type { SubagentPreparation } from "./prepare.ts";

export type SubagentResultStatus = "completed" | "failed" | "cancelled" | "timed-out";

export interface SubagentResult {
	status: SubagentResultStatus;
	/** Truncated assistant response text */
	text: string;
	/** Full result before truncation */
	rawText?: string;
	/** Error message if failed/cancelled/timed-out */
	error?: string;
}

export interface RunSubagentOptions {
	/** Maximum time in milliseconds before aborting */
	timeoutMs?: number;
	/** AbortSignal to cancel the run */
	signal?: AbortSignal;
	/** Parent session's gateway to share for per-provider concurrency control. */
	requestGateway?: RequestGateway;
	/** Seed the subagent's state manager (loaded after schema defaults, whole-table replace). */
	seedState?: Record<string, JsonValue>;
	/** Enable schema strict mode in the subagent session (writes to namespaces without a loaded schema are rejected). */
	strict?: boolean;
	/** Callback after the subagent session is created, before the run starts (spawnAgent subscribes to tool execution events here). */
	onSessionCreated?: (session: AgentSession) => void;
}

export async function runSubagent(
	preparation: SubagentPreparation,
	modelRuntime: ModelRuntime,
	options: RunSubagentOptions = {},
): Promise<SubagentResult> {
	const { timeoutMs, signal } = options;
	if (preparation.messages.length === 0) {
		return { status: "failed", text: "", error: "No messages to send." };
	}

	// setInitialMessages 要求播种消息以 user 结尾（agent-session.ts 的硬契约）。
	// prepare.ts 已把 task 追加为最后一条 user 消息——播种消息必须**包含**它：
	// 剥出会让末尾退回 compileMessages 的原末尾，而 chat-history slot 渲染的继承
	// 历史常以 assistant 结尾，会触发 "Initial messages must end with a user message"。
	const initialMessages = preparation.messages;

	// In-memory session manager: no disk I/O, nothing to clean up.
	const sessionManager = SessionManager.inMemory(process.cwd());

	const { session } = await createAgentSession({
		cwd: process.cwd(),
		modelRuntime,
		requestGateway: options.requestGateway,
		requestIdentity: { sessionId: "?", priority: 0, label: "subagent" },
		model: preparation.model,
		sessionManager,
		initialMessages,
		tools: preparation.effectiveTools,
		noTools: "builtin",
		preset: preparation.profile.id,
		schemas: preparation.schemas,
		thinkingLevel: preparation.thinkingLevel,
		strict: options.strict,
		customTools: preparation.customTools,
		// In-memory session: must not write the shared state store (would
		// conflict with the main session's CAS commits).
		attachStateStore: false,
		// Omit extensions to fulfill "no extensions"
		resourceLoader: {
			getExtensions: () => ({
				extensions: [],
				errors: [],
				runtime: createExtensionRuntime(),
			}),
			getSkills: () => ({ skills: [], diagnostics: [] }),
			getPrompts: () => ({ prompts: [], diagnostics: [] }),
			getThemes: () => ({ themes: [], diagnostics: [] }),
			getAgentsFiles: () => ({ agentsFiles: [] }),
			getSystemPrompt: () => undefined,
			getSystemPromptSource: () => undefined,
			getAppendSystemPrompt: () => [],
			getAppendSystemPromptSources: () => [],
			extendResources: () => {},
			reloadPromptTemplates: () => {},
			reload: async () => {},
		},
	});

	const controller = new AbortController();
	const combinedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;

	let timeoutId: NodeJS.Timeout | undefined;
	if (timeoutMs && timeoutMs > 0) {
		timeoutId = setTimeout(() => controller.abort(), timeoutMs);
	}

	const signalHandler = (): void => session.agent.abort();
	combinedSignal.addEventListener("abort", signalHandler);

	// Seed state after schema loading (createAgentSession), before the run starts.
	// onSessionCreated fires here so subscriptions capture every tool execution event.
	if (options.seedState) session.stateManager.load(options.seedState);
	options.onSessionCreated?.(session);

	try {
		// 播种消息已含 task（最后一条 user 消息），直接 continue() 触发 run——
		// 再 prompt(task) 会双份发送。continue() 要求上下文以 user/toolResult 结尾，
		// 播种后的末尾正是 task。
		//
		// Race continue() against the combined signal: aborting a cooperative provider
		// ends the run gracefully, but a non-cooperative one (hanging stream) never
		// settles — without this race the timeout/cancel would hang forever instead of
		// returning timed-out/cancelled. The losing continue promise is abandoned; the
		// finally block aborts and disposes the in-memory session.
		const continuePromise = session.agent.continue();
		const abortPromise = new Promise<never>((_, reject) => {
			if (combinedSignal.aborted) {
				reject(new Error("aborted"));
				return;
			}
			combinedSignal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
		});
		await Promise.race([continuePromise, abortPromise]);
		await session.waitForIdle();

		const lastAssistant = [...session.agent.state.messages].reverse().find((m) => m.role === "assistant");
		const rawText = lastAssistant && "content" in lastAssistant ? contentText(lastAssistant.content, "") : "";
		const truncationResult = truncateTail(rawText);

		return {
			status: "completed",
			text: truncationResult.content,
			rawText,
		};
	} catch (error) {
		const isCancelled = signal?.aborted ?? false;
		const isTimeout = timeoutId !== undefined && !signal?.aborted;

		return {
			status: isCancelled ? "cancelled" : isTimeout ? "timed-out" : "failed",
			text: "",
			error: error instanceof Error ? error.message : String(error),
		};
	} finally {
		clearTimeout(timeoutId);
		combinedSignal.removeEventListener("abort", signalHandler);
		session.agent.abort();
		await session.waitForIdle().catch(() => {});
		session.dispose();
	}
}
