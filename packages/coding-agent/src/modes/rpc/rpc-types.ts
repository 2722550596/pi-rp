/**
 * RPC protocol types for headless operation.
 *
 * Commands are sent as JSON lines on stdin.
 * Responses and events are emitted as JSON lines on stdout.
 */

import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ImageContent, Model, TextContent } from "@earendil-works/pi-ai";
import type { SessionStats } from "../../core/agent-session.ts";
import type { BashResult } from "../../core/bash-executor.ts";
import type { CompactionResult } from "../../core/compaction/index.ts";
import type { OrchestrationAck } from "../../core/extensions/types.ts";
import type { SessionEntry, SessionTreeNode } from "../../core/session-manager.ts";
import type { SourceInfo } from "../../core/source-info.ts";

// ============================================================================
// RPC Commands (stdin)
// ============================================================================

export type RpcCommand =
	// Prompting
	| { id?: string; type: "prompt"; message: string; images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" }
	| { id?: string; type: "steer"; message: string; images?: ImageContent[] }
	| { id?: string; type: "follow_up"; message: string; images?: ImageContent[] }
	| { id?: string; type: "abort" }
	| { id?: string; type: "new_session"; parentSession?: string }

	// State
	| { id?: string; type: "get_state"; ifVersion?: number; path?: string }
	| { id?: string; type: "update_state"; path: string; op: "add" | "remove" | "replace" | "merge"; value?: unknown }
	| { id?: string; type: "watch_state"; path?: string; ifVersion?: number }

	// Model
	| { id?: string; type: "set_model"; provider: string; modelId: string; persistSettings?: boolean }
	| { id?: string; type: "cycle_model" }
	| { id?: string; type: "get_available_models" }

	// Thinking
	| { id?: string; type: "set_thinking_level"; level: ThinkingLevel; persistSettings?: boolean }
	| { id?: string; type: "cycle_thinking_level" }
	| { id?: string; type: "get_available_thinking_levels" }

	// Presets
	| { id?: string; type: "set_preset"; presetId: string }

	// Queue modes
	| { id?: string; type: "set_steering_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "set_follow_up_mode"; mode: "all" | "one-at-a-time" }

	// Compaction
	| { id?: string; type: "compact"; customInstructions?: string }
	| { id?: string; type: "set_auto_compaction"; enabled: boolean }

	// Retry
	| { id?: string; type: "set_auto_retry"; enabled: boolean }
	| { id?: string; type: "abort_retry" }

	// Bash
	| { id?: string; type: "bash"; command: string; excludeFromContext?: boolean }
	| { id?: string; type: "abort_bash" }

	// Session
	| { id?: string; type: "get_session_stats" }
	| { id?: string; type: "export_html"; outputPath?: string }
	| { id?: string; type: "switch_session"; sessionPath: string }
	| { id?: string; type: "fork"; entryId: string }
	| { id?: string; type: "clone" }
	| { id?: string; type: "reroll" }
	| { id?: string; type: "get_fork_messages" }
	| { id?: string; type: "get_entries"; since?: string }
	| { id?: string; type: "get_tree" }
	| { id?: string; type: "navigate_tree"; targetId: string; label?: string }
	| { id?: string; type: "get_last_assistant_text" }
	| { id?: string; type: "set_session_name"; name: string }

	// Affiliated session (parent↔child coordination)
	| {
			id?: string;
			type: "init_context";
			/** 出生继承：父会话历史切片（LLM 消息），首次 prompt 前播种进本会话 agent state。 */
			history?: AgentMessage[];
			/** 出生继承：父会话 state 命名空间子集快照，load 进本会话 stateManager。 */
			state?: Record<string, unknown>;
	  }
	| {
			id?: string;
			type: "context_response";
			/** 对应子进程发出的 context_request.requestId。 */
			requestId: string;
			/** 父进程扩展过滤后的 LLM 消息（投影方向策略由父扩展决定）。 */
			messages?: Array<{ role: string; content: unknown }>;
			/** 父进程 state 快照（请求携带 namespaces 白名单时按需返回）。 */
			state?: Record<string, unknown>;
			/** 父进程无法提供时的错误（子进程侧快速失败，不走超时）。 */
			error?: string;
	  }
	| {
			id?: string;
			type: "orchestration_response";
			/** 对应子进程发出的 orchestration_request.requestId。 */
			requestId: string;
			/** 父进程扩展的编排裁决（approved/blocked）或 error（子进程侧快速失败）。 */
			ack: OrchestrationAck;
	  }

	// Messages
	| { id?: string; type: "get_messages" }
	| {
			id?: string;
			type: "append_message";
			/** 扩展自定义消息类型（customType），policy 由进程扩展注册或沿用默认语义。 */
			customType: string;
			/** 消息内容（string 或 content 块数组）。 */
			content: string | (TextContent | ImageContent)[];
			/** 是否在 TUI 显示；false = 仅进上下文/持久化（默认 false）。 */
			display?: boolean;
			/** 扩展专用元数据（不进 LLM 上下文）。 */
			details?: unknown;
	  }

	// Commands (available for invocation via prompt)
	| { id?: string; type: "get_commands" }

	// Narrow hot reload: re-scan prompt templates only (no extension/runtime restart)
	| { id?: string; type: "reload_prompts" };

// ============================================================================
// RPC Slash Command (for get_commands response)
// ============================================================================

/** A command available for invocation via prompt */
export interface RpcSlashCommand {
	/** Command name (without leading slash) */
	name: string;
	/** Human-readable description */
	description?: string;
	/** Argument placeholder hint (e.g. "[时长]") — prompt templates only */
	argumentHint?: string;
	/** What kind of command this is */
	source: "extension" | "prompt" | "skill";
	/** Source metadata for the owning resource */
	sourceInfo: SourceInfo;
}

// ============================================================================
// RPC State
// ============================================================================

export interface RpcSessionState {
	model?: Model<any>;
	thinkingLevel: ThinkingLevel;
	isStreaming: boolean;
	isCompacting: boolean;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	sessionFile?: string;
	sessionId: string;
	sessionName?: string;
	/** Active prompt preset id (e.g. "pi-default"); undefined when no preset is active. */
	activePresetId?: string;
	autoCompactionEnabled: boolean;
	messageCount: number;
	pendingMessageCount: number;
	/** Monotonic state revision; state snapshot omitted when it matches the caller's ifVersion. */
	stateRevision: number;
	/** Requested subtree path (echo of the get_state request); full snapshot when omitted. */
	path?: string;
	/** Full stateManager snapshot (all namespaces), for peer state sync back to the parent. */
	state?: Record<string, unknown>;
}

// ============================================================================
// RPC Responses (stdout)
// ============================================================================

// Success responses with data
export type RpcResponse =
	// Prompting (async - events follow)
	| { id?: string; type: "response"; command: "prompt"; success: true }
	| { id?: string; type: "response"; command: "steer"; success: true }
	| { id?: string; type: "response"; command: "follow_up"; success: true }
	| { id?: string; type: "response"; command: "abort"; success: true }
	| { id?: string; type: "response"; command: "new_session"; success: true; data: { cancelled: boolean } }

	// State
	| { id?: string; type: "response"; command: "get_state"; success: true; data: RpcSessionState }
	| {
			id?: string;
			type: "response";
			command: "update_state";
			success: true;
			data: { path: string; newValue: unknown };
	  }
	| {
			id?: string;
			type: "response";
			command: "watch_state";
			success: true;
			data: { stateRevision: number; path?: string; value?: Record<string, unknown> | undefined };
	  }

	// Model
	| {
			id?: string;
			type: "response";
			command: "set_model";
			success: true;
			data: Model<any>;
	  }
	| {
			id?: string;
			type: "response";
			command: "cycle_model";
			success: true;
			data: { model: Model<any>; thinkingLevel: ThinkingLevel; isScoped: boolean } | null;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_available_models";
			success: true;
			data: { models: Model<any>[] };
	  }

	// Thinking
	| { id?: string; type: "response"; command: "set_thinking_level"; success: true }
	| {
			id?: string;
			type: "response";
			command: "cycle_thinking_level";
			success: true;
			data: { level: ThinkingLevel } | null;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_available_thinking_levels";
			success: true;
			data: { levels: ThinkingLevel[] };
	  }

	// Queue modes
	| { id?: string; type: "response"; command: "set_steering_mode"; success: true }
	| { id?: string; type: "response"; command: "set_follow_up_mode"; success: true }

	// Compaction
	| { id?: string; type: "response"; command: "compact"; success: true; data: CompactionResult }
	| { id?: string; type: "response"; command: "set_auto_compaction"; success: true }

	// Retry
	| { id?: string; type: "response"; command: "set_auto_retry"; success: true }
	| { id?: string; type: "response"; command: "abort_retry"; success: true }

	// Bash
	| { id?: string; type: "response"; command: "bash"; success: true; data: BashResult }
	| { id?: string; type: "response"; command: "abort_bash"; success: true }

	// Session
	| { id?: string; type: "response"; command: "get_session_stats"; success: true; data: SessionStats }
	| { id?: string; type: "response"; command: "export_html"; success: true; data: { path: string } }
	| { id?: string; type: "response"; command: "switch_session"; success: true; data: { cancelled: boolean } }
	| { id?: string; type: "response"; command: "fork"; success: true; data: { text: string; cancelled: boolean } }
	| { id?: string; type: "response"; command: "clone"; success: true; data: { cancelled: boolean } }
	| { id?: string; type: "response"; command: "reroll"; success: true }
	| {
			id?: string;
			type: "response";
			command: "get_fork_messages";
			success: true;
			data: { messages: Array<{ entryId: string; text: string }> };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_entries";
			success: true;
			data: { entries: SessionEntry[]; leafId: string | null };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_tree";
			success: true;
			data: { tree: SessionTreeNode[]; leafId: string | null };
	  }
	| {
			id?: string;
			type: "response";
			command: "navigate_tree";
			success: true;
			data: { cancelled: boolean; editorText?: string };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_last_assistant_text";
			success: true;
			data: { text: string | null };
	  }
	| { id?: string; type: "response"; command: "set_session_name"; success: true }

	// Affiliated session
	| { id?: string; type: "response"; command: "init_context"; success: true; data: { ok: boolean } }
	| { id?: string; type: "response"; command: "context_response"; success: true }
	| { id?: string; type: "response"; command: "orchestration_response"; success: true }

	// Messages
	| { id?: string; type: "response"; command: "get_messages"; success: true; data: { messages: AgentMessage[] } }
	| {
			id?: string;
			type: "response";
			command: "append_message";
			success: true;
			data: { entryId: string };
	  }

	// Commands
	| {
			id?: string;
			type: "response";
			command: "get_commands";
			success: true;
			data: { commands: RpcSlashCommand[] };
	  }
	| { id?: string; type: "response"; command: "reload_prompts"; success: true }

	// Error response (any command can fail)
	| { id?: string; type: "response"; command: string; success: false; error: string };

// ============================================================================
// Extension UI Events (stdout)
// ============================================================================

/** Pushed to `watch_state` subscribers when the StateManager revision changes. */
export interface RpcStateChangedEvent {
	type: "state_changed";
	stateRevision: number;
	/** Watched path (echo of the watch_state request); full snapshot when omitted. */
	path?: string;
	/** Value at the watched path (subtree when path given, full snapshot otherwise). */
	value?: Record<string, unknown> | undefined;
}

/**
 * Emitted by a child process when its extension requests the parent session's
 * current context (affiliated-session "B 活体读取"). The parent serves the
 * request via `context_response` (过滤规则是父进程扩展的责任，pi-rp 只做路由)。
 */
export interface RpcContextRequestEvent {
	type: "context_request";
	requestId: string;
	/** 父会话锚点 entry id：只取它之后的历史（P2 锚点语义）；省略 = 全分支。 */
	since?: string;
	/** 需要的 state 命名空间白名单；省略 = 不要求 state。 */
	namespaces?: string[];
}

// OrchestrationAck 的规范定义在 core/extensions/types.ts（扩展 ctx 与 RPC 协议共用）；
// 此处 re-export 保持协议类型的既有消费路径。
export type { OrchestrationAck } from "../../core/extensions/types.ts";

/**
 * Emitted by a child process when its extension requests orchestration from the
 * parent session (pass_mic：角色把话筒递给另一个角色或玩家)。父进程经
 * `orchestration_response` 应答（编排策略是父进程扩展的责任，pi-rp 只做路由）。
 */
export interface RpcOrchestrationRequestEvent {
	type: "orchestration_request";
	requestId: string;
	/** 编排类别。 */
	kind: "pass_mic";
	/** 发起请求的子进程角色 id。 */
	from: string;
	/** 目标角色 id，或字面量 "player"。 */
	target: string;
}

/** Emitted when an extension needs user input */
export type RpcExtensionUIRequest =
	| { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number }
	| { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
	| {
			type: "extension_ui_request";
			id: string;
			method: "input";
			title: string;
			placeholder?: string;
			timeout?: number;
	  }
	| { type: "extension_ui_request"; id: string; method: "editor"; title: string; prefill?: string }
	| {
			type: "extension_ui_request";
			id: string;
			method: "notify";
			message: string;
			notifyType?: "info" | "warning" | "error";
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setStatus";
			statusKey: string;
			statusText: string | undefined;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setWidget";
			widgetKey: string;
			widgetLines: string[] | undefined;
			widgetPlacement?: "aboveEditor" | "belowEditor";
	  }
	| { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
	| { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string };

// ============================================================================
// Extension UI Commands (stdin)
// ============================================================================

/** Response to an extension UI request */
export type RpcExtensionUIResponse =
	| { type: "extension_ui_response"; id: string; value: string }
	| { type: "extension_ui_response"; id: string; confirmed: boolean }
	| { type: "extension_ui_response"; id: string; cancelled: true };

// ============================================================================
// Helper type for extracting command types
// ============================================================================

export type RpcCommandType = RpcCommand["type"];
