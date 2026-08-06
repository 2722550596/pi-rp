import { contentText } from "@earendil-works/pi-ai";
import { createExtensionRuntime } from "../extensions/loader.ts";
import type { ModelRuntime } from "../model-runtime.ts";
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

	// The last message in preparation is the task
	const taskMessage = preparation.messages[preparation.messages.length - 1];
	const initialMessages = preparation.messages.slice(0, -1);
	const task =
		"content" in taskMessage
			? typeof taskMessage.content === "string"
				? taskMessage.content
				: contentText(taskMessage.content, "")
			: "";

	// Create an in-memory session manager
	// (passing a non-existent temp path effectively makes it ephemeral)
	const sessionManager = SessionManager.create(process.cwd(), "/tmp/pi-subagent-ephemeral");

	const { session } = await createAgentSession({
		cwd: process.cwd(),
		modelRuntime,
		model: preparation.model,
		sessionManager,
		initialMessages,
		tools: preparation.effectiveTools,
		noTools: "builtin",
		preset: preparation.profile.id,
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

	try {
		await session.prompt(task);
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
