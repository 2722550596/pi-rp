import type { MacroDefinition, SlotDefinition } from "./types.ts";

export interface PromptRegistryReader {
	getBuiltInSlot(name: string): SlotDefinition | undefined;
	getCustomSlot(name: string): SlotDefinition | undefined;
	getAllSlots(): SlotDefinition[];
	getMacro(name: string): MacroDefinition | undefined;
	getAllMacros(): MacroDefinition[];
	getContextSlotContent?(slotId: string): string | undefined;
}
export class PromptRegistryScope implements PromptRegistryReader {
	private live = {
		slots: new Map<string, SlotDefinition>(),
		builtInSlots: new Map<string, SlotDefinition>(),
		macros: new Map<string, MacroDefinition>(),
	};
	private contextSlotContents = new Map<string, string>();
	private staged?: {
		slots: Map<string, SlotDefinition>;
		builtInSlots: Map<string, SlotDefinition>;
		macros: Map<string, MacroDefinition>;
	};
	private disposed = false;

	private get current() {
		return this.staged ?? this.live;
	}

	private assertActive(): void {
		if (this.disposed) throw new Error("AgentSession prompt scope has been disposed");
	}

	beginUpdate(): void {
		this.assertActive();
		if (this.staged) throw new Error("Prompt registry update already in progress");
		this.staged = { slots: new Map(), builtInSlots: new Map(), macros: new Map() };
	}

	commitUpdate(): void {
		this.assertActive();
		if (!this.staged) throw new Error("No prompt registry update in progress");
		this.live = this.staged;
		this.staged = undefined;
	}

	rollbackUpdate(): void {
		this.staged = undefined;
	}

	registerSlot(definition: SlotDefinition, isBuiltIn = false): void {
		this.assertActive();
		(isBuiltIn ? this.current.builtInSlots : this.current.slots).set(definition.name, definition);
	}

	replaceContextSlots(replacements: readonly { readonly slotId: string; readonly content: string }[]): void {
		this.assertActive();
		if (replacements.length === 0) return;
		const next = new Map(this.contextSlotContents);
		for (const replacement of replacements) {
			next.set(replacement.slotId, replacement.content);
		}
		this.contextSlotContents = next;
	}

	getContextSlotContent(slotId: string): string | undefined {
		return this.contextSlotContents.get(slotId);
	}

	getBuiltInSlot(name: string): SlotDefinition | undefined {
		return this.current.builtInSlots.get(name);
	}

	getCustomSlot(name: string): SlotDefinition | undefined {
		return this.current.slots.get(name);
	}

	getAllSlots(): SlotDefinition[] {
		return [...this.current.builtInSlots.values(), ...this.current.slots.values()];
	}

	registerMacro(definition: MacroDefinition): void {
		this.assertActive();
		this.current.macros.set(definition.name, definition);
	}

	getMacro(name: string): MacroDefinition | undefined {
		return this.current.macros.get(name);
	}

	getAllMacros(): MacroDefinition[] {
		return [...this.current.macros.values()];
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.staged = undefined;
		this.live.slots.clear();
		this.live.builtInSlots.clear();
		this.live.macros.clear();
		this.contextSlotContents.clear();
	}
}
