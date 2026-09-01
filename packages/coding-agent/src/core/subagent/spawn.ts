import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai/compat";
import type { JsonValue } from "../../state/state-manager.ts";
import type { AgentSession } from "../agent-session.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { isPrepareError, pick, prepareSubagentConversation } from "./prepare.ts";
import { runSubagent, type SubagentResultStatus } from "./run.ts";

// =========================================================================
// Types
// =========================================================================

/** A state_update tool call that succeeded in the spawned session (op/path/value as invoked). */
export interface SpawnedStateOp {
	op: "add" | "remove" | "replace" | "merge";
	/** Path for add/remove/replace; omitted for merge. */
	path?: string;
	value?: unknown;
}

export interface SpawnAgentOptions {
	/** Preset profile ID (compiled by the engine; must exist in parent session or on disk). */
	profileId: string;
	/** Last user message appended after the preset's own task block; default "" (preset task block already carries instructions). */
	task?: string;
	/** Explicit chat history (prepare inheritMessages). */
	inheritMessages?: AgentMessage[];
	/** Top-level state namespaces fed to the subagent (state slot + seed); default: all. */
	stateNamespaces?: string[];
	/** Schema IDs loaded into the subagent session; default: preset.schemas. */
	schemas?: string[];
	/** Tool names for the subagent; default ["state_update", "get_state"]. */
	tools?: string[];
	/** Custom tool definitions injected into the subagent session (e.g. extension-registered
	 *  tools). Names must also be listed in `tools` to be selectable. Without this, the
	 *  subagent only has built-in tools (spawnAgent does not inherit the parent's
	 *  extension tools). */
	customTools?: ToolDefinition[];
	/** Explicit model; default session.model. */
	model?: Model<any>;
	thinkingLevel?: ThinkingLevel;
	timeoutMs?: number;
	signal?: AbortSignal;
	/** Callback after the subagent session is created, before the run starts (tests/hooks). */
	onSessionCreated?: (session: AgentSession) => void;
}

export interface SpawnAgentResult {
	status: SubagentResultStatus; // completed | failed | cancelled | timed-out
	text: string;
	rawText?: string;
	error?: string;
	/** state_update calls that succeeded (tool_execution_end.isError=false) in the spawned session, in order;
	 *  always [] when status !== "completed". */
	stateOps: SpawnedStateOp[];
}

// =========================================================================
// spawnAgent
// =========================================================================

/**
 * Programmatic in-process subagent spawn (reuses the runSubagent engine).
 *
 * Unlike the `subagent` LLM tool, this path is not gated on the preset being
 * delegatable and does not inherit the parent's extension tools. State is
 * seeded from the parent snapshot (optionally namespace-filtered), and the
 * subagent runs in schema strict mode: writes to namespaces without a loaded
 * schema are rejected as tool errors, and the agent self-corrects.
 *
 * State write-back replays the successful state_update tool calls rather than
 * diffing the subagent's final state: tool call args carry the LLM's intent
 * (add = delta/append, replace = absolute, merge = deep merge), which stays
 * correct under concurrent parent-state changes, whereas a terminal-state
 * diff cannot distinguish "add +2" from "replace 7" (both end at 7 when the
 * seed is 5).
 */
export async function spawnAgent(session: AgentSession, options: SpawnAgentOptions): Promise<SpawnAgentResult> {
	const ops: SpawnedStateOp[] = [];

	const preparation = await prepareSubagentConversation({
		cwd: session.sessionManager.getCwd(),
		profileId: options.profileId,
		task: options.task ?? "",
		modelRuntime: session.modelRuntime,
		session,
		inheritMessages: options.inheritMessages,
		stateNamespaces: options.stateNamespaces,
		schemas: options.schemas,
		tools: options.tools ?? ["state_update", "get_state"],
		inheritExtensionTools: false,
		customTools: options.customTools,
		model: options.model ?? session.model,
		thinkingLevel: options.thinkingLevel,
	});
	if (isPrepareError(preparation)) {
		return { status: "failed", text: "", error: preparation.error, stateOps: [] };
	}

	const seedState = options.stateNamespaces
		? (pick(session.stateManager.snapshot(), options.stateNamespaces) as Record<string, JsonValue>)
		: (session.stateManager.snapshot() as Record<string, JsonValue>);

	const result = await runSubagent(preparation, session.modelRuntime, {
		timeoutMs: options.timeoutMs,
		signal: options.signal,
		requestGateway: session.requestGateway,
		strict: true,
		seedState,
		onSessionCreated: (sub) => {
			options.onSessionCreated?.(sub);
			subscribeStateOps(sub, ops);
		},
	});

	return {
		status: result.status,
		text: result.text,
		rawText: result.rawText,
		error: result.error,
		stateOps: result.status === "completed" ? ops : [],
	};
}

/**
 * Record successful state_update calls from the spawned session into `ops`.
 * Subscribes before the run starts (onSessionCreated fires pre-continue) so every
 * tool execution event is captured; tool_execution_end carries isError, so only
 * calls that actually applied are kept (schema rejections throw in the tool and
 * surface as errors).
 */
function subscribeStateOps(sub: AgentSession, ops: SpawnedStateOp[]): void {
	const pending = new Map<string, SpawnedStateOp>();
	sub.subscribe((e) => {
		if (e.type === "tool_execution_start" && e.toolName === "state_update") {
			pending.set(e.toolCallId, e.args as SpawnedStateOp);
		} else if (e.type === "tool_execution_end" && e.toolName === "state_update") {
			const op = pending.get(e.toolCallId);
			if (op && !e.isError) ops.push(op);
			pending.delete(e.toolCallId);
		}
	});
}
