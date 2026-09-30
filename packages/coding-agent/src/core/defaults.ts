import type { Capabilities, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ToolName } from "./tools/index.ts";

export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";

/**
 * Session-level tool names that are not part of the built-in file-tool set
 * (`ToolName`) but participate in the default active tool face.
 */
export type SessionToolName = ToolName | "state_update" | "get_state" | "subagent_profiles" | "subagent";

/**
 * Tools that stay active on every profile regardless of shell availability
 * (session bookkeeping + the subagent mechanism).
 */
const RESIDENT_ACTIVE_TOOL_NAMES = ["state_update", "get_state", "subagent_profiles", "subagent"] as const;

/**
 * Default active tool face for profiles with a shell (node/hosted).
 * grep/find/ls stay registered but are not activated: bash covers them
 * (能力→工具开关总表, 契约 §5).
 */
export const SHELL_DEFAULT_ACTIVE_TOOL_NAMES: SessionToolName[] = [
	"read",
	"bash",
	"edit",
	"write",
	...RESIDENT_ACTIVE_TOOL_NAMES,
];

/**
 * Default active tool face for profiles without a shell (browser).
 * bash is negotiated absent, so its substitutes (grep/find/ls) activate by
 * default — the bash 互补开关 (14-E §3 步骤 3A). Explicit declarations
 * (settings `defaultTools`, SDK `tools`, preset tools, `setActiveTools`)
 * always take precedence over these profile defaults.
 */
export const SHELL_FREE_DEFAULT_ACTIVE_TOOL_NAMES: SessionToolName[] = [
	"read",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
	...RESIDENT_ACTIVE_TOOL_NAMES,
];

/**
 * The bash 互补开关: the default active tool face as a function of shell
 * availability. grep/find/ls default activation is the inverse of bash
 * availability. This is the ONLY place that mapping is spelled out; it is
 * consumed exclusively at harness assembly entry points (e.g. sdk.ts).
 */
export function bashComplementDefaultTools(capabilities: { readonly shell: boolean }): SessionToolName[] {
	return capabilities.shell ? [...SHELL_DEFAULT_ACTIVE_TOOL_NAMES] : [...SHELL_FREE_DEFAULT_ACTIVE_TOOL_NAMES];
}

/**
 * Capability→registry switch table (契约 §5, ❌ = negotiated absence): tools
 * that MUST NOT be registered at all when the capability is missing. Returned
 * names merge into the assembly entry's `excludeTools`, which flows through
 * `excludedToolNames` → `isAllowedTool` (registry, prompt, and schema all
 * derive from the filtered registry — no per-layer special cases).
 */
export function negotiatedAbsentToolNames(capabilities: Capabilities | undefined): string[] {
	return capabilities && !capabilities.shell ? ["bash"] : [];
}
