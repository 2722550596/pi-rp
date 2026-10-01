/**
 * Prompt-preset slot registry.
 *
 * Pure registration table, split out of slot-renderers.ts so profiles without Node fs (which slot-renderers.ts needs
 * for its docs/examples loading) can register and resolve slot definitions. Registration behavior is unchanged; this
 * module must stay free of Node imports (extension assembly core depends on it).
 */
import type { PromptRegistryReader, PromptRegistryScope } from "./registry-scope.ts";
import type { SlotDefinition } from "./types.ts";

const builtInSlots = new Map<string, SlotDefinition>();
const customSlots = new Map<string, SlotDefinition>();

export function registerSlot(definition: SlotDefinition, isBuiltIn = false, scope?: PromptRegistryScope): void {
	if (scope) {
		scope.registerSlot(definition, isBuiltIn);
		return;
	}
	const registry = isBuiltIn ? builtInSlots : customSlots;
	registry.set(definition.name, definition);
}

export function getSlot(name: string, scope?: PromptRegistryReader): SlotDefinition | undefined {
	if (!scope) return builtInSlots.get(name) ?? customSlots.get(name);
	return scope.getBuiltInSlot(name) ?? builtInSlots.get(name) ?? scope.getCustomSlot(name);
}

export function getAllSlots(scope?: PromptRegistryReader): SlotDefinition[] {
	return scope
		? [...builtInSlots.values(), ...scope.getAllSlots()]
		: [...builtInSlots.values(), ...customSlots.values()];
}

/** Set of built-in slot names for validation. */
export const SUPPORTED_SLOTS = new Set<string>([
	"chat-history",
	"tools",
	"tool-guidelines",
	"skills",
	"project-context",
	"append-system-prompt",
	"date",
	"cwd",
	"date-cwd",
	"active-model",
	"pi-docs",
	"variables",
	"state",
	"file",
	"awaken",
	"recent",
	"index",
]);
