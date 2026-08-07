import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { SchemaValidator } from "../../state/schema-validator.ts";
import type { JsonValue, StateDiffResult, StateManager, StateOp } from "../../state/state-manager.ts";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

// Schema - single object; op is a string enum (not a nested anyOf of literals, which
// strict OpenAI-compatible backends reject). path/value are optional so add/remove/replace
// and merge share one shape, exactly the fields `execute` reads.
const StateUpdateParameters = Type.Object({
	op: StringEnum(["add", "remove", "replace", "merge"], {
		description:
			"add=set/delta (numbers add, non-numbers replace, arrays append); remove=delete path; replace=force-set; merge=RFC 7396 deep merge (null deletes keys)",
	}),
	path: Type.Optional(
		Type.String({
			description:
				"Dot notation or JSON Pointer (e.g. character.hp, /character/hp). Required for add/remove/replace; ignored for merge.",
		}),
	),
	value: Type.Optional(Type.Any({ description: "Value to set/merge. Required for add/replace/merge." })),
});

type StateUpdateParams = Static<typeof StateUpdateParameters>;

export function createStateUpdateToolDefinition(
	stateManager: StateManager,
	schemaValidator: SchemaValidator,
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

		// op is a flat enum in the schema (no anyOf), so path is optional at the type
		// level; but add/remove/replace require a path (the old Union enforced it).
		if (p.op !== "merge" && (p.path === undefined || p.path === "")) {
			return {
				content: [{ type: "text", text: `state_update rejected: path is required for op "${p.op}"` }],
				details: undefined,
			};
		}

		// StringEnum's Static widens to `string`; narrow to StateOp (matches state-manager.ts).
		const op = p.op as StateOp;
		const fullPath: string = op === "merge" ? "" : (p.path as string);

		// Validate against schema + custom validators
		const validation = schemaValidator.validate(
			fullPath,
			op,
			p.value as JsonValue,
			stateManager.snapshot() as Record<string, JsonValue>,
		);

		if (!validation.ok) {
			return {
				content: [{ type: "text", text: `state_update rejected: ${validation.reason}` }],
				details: undefined,
			};
		}

		// Use corrected value if a custom validator modified it
		const effectiveValue = validation.correctedValue ?? p.value;

		if (op === "merge") {
			result = stateManager.apply({ op: "merge", value: effectiveValue as JsonValue });
		} else {
			result = stateManager.apply(fullPath, op, effectiveValue as JsonValue);
		}
		const text = `state: ${result.path} -> ${JSON.stringify(result.newValue)}`;
		return { content: [{ type: "text", text }], details: undefined };
		},
	};
}

// Schema for get_state — no parameters, just returns full state
const GetStateParameters = Type.Object({});

export function createGetStateToolDefinition(stateManager: StateManager): ToolDefinition<typeof GetStateParameters> {
	return {
		name: "get_state",
		label: "Get State",
		description:
			"Returns a JSON object representing all stored variables and their current values. " +
			"Use this to inspect state before making changes with state_update.",
		parameters: GetStateParameters,
		promptSnippet: "get_state: read full conversation state as JSON",
		promptGuidelines: [
			"Use get_state to inspect the full current state before making changes",
			"Returns all stored variables as a JSON object",
			"Use state_update to modify state after inspection",
		],
		execute: async (): Promise<AgentToolResult<undefined>> => {
			const state = stateManager.snapshot();
			const text = JSON.stringify(state, null, 2);
			return { content: [{ type: "text", text }], details: undefined };
		},
	};
}

export function createStateUpdateTool(stateManager: StateManager, schemaValidator: SchemaValidator) {
	const definition = createStateUpdateToolDefinition(stateManager, schemaValidator);
	return wrapToolDefinition(definition);
}
