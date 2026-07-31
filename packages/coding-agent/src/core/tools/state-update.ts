import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import type { JsonValue, StateDiffResult, StateManager } from "../../state/state-manager.ts";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import type { SessionManager } from "../session-manager.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

// Schema — oneof for patch vs merge
const StateUpdateParameters = Type.Union([
	Type.Object({
		op: Type.Union([Type.Literal("add"), Type.Literal("remove"), Type.Literal("replace")]),
		path: Type.String({ description: "Dot notation or JSON Pointer (e.g. character.hp, /character/hp)" }),
		value: Type.Optional(Type.Any()),
	}),
	Type.Object({
		op: Type.Literal("merge"),
		value: Type.Record(Type.String(), Type.Any()),
	}),
]);

type StateUpdateParams = Static<typeof StateUpdateParameters>;

export function createStateUpdateToolDefinition(
	sessionManager: SessionManager,
	stateManager: StateManager,
): ToolDefinition<typeof StateUpdateParameters> {
	return {
		name: "state_update",
		label: "State Update",
		description:
			"Read or modify persistent conversation state. " +
			"Use 'add' to set values (numbers add as delta, non-numbers replace, arrays append). " +
			"Use 'remove' to delete a path. Use 'replace' to force-set without delta. " +
			"Use 'merge' with an object for RFC 7396 deep merge (null values delete keys). " +
			"Paths use dot notation: 'character.hp' or JSON Pointer: '/character/hp'. " +
			"Read current state with /state.",
		parameters: StateUpdateParameters,
		promptSnippet: "state: read/write conversation variables, paths in dot notation",
		promptGuidelines: [
			"Use state_update to persist game state, character stats, inventory, and flags",
			"Prefer 'add' for numeric changes (HP -= 5 => op:add, path:character.hp, value:-5)",
			"Use 'merge' for bulk updates (multiple fields at once)",
			"Use 'remove' to delete state keys",
			"Read current state explicitly with /state (not shown in prompt by default)",
		],
		execute: async (
			_toolCallId,
			params,
			_signal,
			_onUpdate,
			_ctx: ExtensionContext,
		): Promise<AgentToolResult<undefined>> => {
			let result: StateDiffResult;
			const p = params as StateUpdateParams;
			if (p.op === "merge") {
				result = stateManager.apply("", "merge", p.value as JsonValue);
			} else {
				result = stateManager.apply(p.path, p.op, p.value as JsonValue);
			}
			// Write full-state snapshot to session
			sessionManager.appendState(stateManager.snapshot());
			const text = `state: ${result.path} -> ${JSON.stringify(result.newValue)}`;
			return { content: [{ type: "text", text }], details: undefined };
		},
	};
}

export function createStateUpdateTool(sessionManager: SessionManager, stateManager: StateManager) {
	const definition = createStateUpdateToolDefinition(sessionManager, stateManager);
	return wrapToolDefinition(definition);
}
