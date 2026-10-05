import { getSlot } from "../../coding-agent/src/core/prompt-preset/slot-registry.ts";
import type { SlotDefinition } from "../../coding-agent/src/core/prompt-preset/types.ts";
import type { AskBroker } from "./ask-broker.ts";
import type {
	CreatePiHarnessOptions as BaseCreatePiHarnessOptions,
	PiHarness as BasePiHarness,
	PiHarnessToolsOptions as BasePiHarnessToolsOptions,
} from "./assemble.ts";
import { createPiHarness as assemblePiHarness } from "./assemble.ts";
import {
	type BrowserCustomTool,
	type BrowserCustomTypePolicy,
	createBrowserCustomToolFactory,
} from "./custom-tools.ts";
import { type HarnessEventError, type HarnessEventListener, subscribeHarnessEvents } from "./harness-events.ts";
import type { BrowserSideRequestOptions } from "./side-request.ts";
import { completeBrowserSideRequest } from "./side-request.ts";

export interface BrowserHarnessToolsOptions extends BasePiHarnessToolsOptions {
	readonly custom?: readonly BrowserCustomTool[];
	readonly customTypes?: readonly BrowserCustomTypePolicy[];
}

export type CreateBrowserHarnessOptions = Omit<BaseCreatePiHarnessOptions, "tools"> & {
	readonly tools?: BrowserHarnessToolsOptions;
};

export interface BrowserPiHarness extends BasePiHarness {
	subscribe(listener: HarnessEventListener): () => void;
	registerPromptSlot(definition: SlotDefinition): void;
	completeSideRequest(prompt: string, options: BrowserSideRequestOptions): Promise<string>;
}

const BROWSER_TOOL_NAMES = new Set(["read", "write", "edit", "ls", "grep", "find", "bash"]);

export async function createPiHarnessWithTools(
	options: CreateBrowserHarnessOptions,
	params: { sessionId?: string; askBroker?: AskBroker; onEventError?: (error: HarnessEventError) => void } = {},
): Promise<BrowserPiHarness> {
	const { tools, ...baseOptions } = options;
	for (const custom of tools?.custom ?? []) {
		if (BROWSER_TOOL_NAMES.has(custom.definition.name)) {
			throw new Error(
				`pi-harness: custom tool name ${JSON.stringify(custom.definition.name)} conflicts with a built-in tool`,
			);
		}
	}
	const sessionId = params.sessionId ?? `browser-session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const customFactory = createBrowserCustomToolFactory(
		tools?.custom ?? [],
		tools?.customTypes ?? [],
		sessionId,
		params.askBroker,
	);
	const extensions = [...(baseOptions.extensions?.factories ?? []), customFactory];
	const harness = await assemblePiHarness({
		...baseOptions,
		tools: {
			enabled: tools?.enabled,
			disabled: tools?.disabled,
			operations: tools?.operations,
		},
		extensions: { factories: extensions },
	});
	const registerEvents = subscribeHarnessEvents(harness.session, sessionId, params.onEventError);
	const registeredSlots = new Set<string>();
	const eventUnsubscribers = new Set<() => void>();
	let disposed = false;
	return {
		...harness,
		subscribe(listener) {
			if (disposed) throw new Error("pi-harness: session is disposed");
			const unsubscribe = registerEvents(listener);
			eventUnsubscribers.add(unsubscribe);
			return () => {
				eventUnsubscribers.delete(unsubscribe);
				unsubscribe();
			};
		},
		registerPromptSlot(definition) {
			if (disposed) throw new Error("pi-harness: session is disposed");
			const scope = harness.session.promptRegistryScope;
			if (!scope) throw new Error("pi-harness: session has no prompt registry scope");
			if (!definition.name.trim()) throw new Error("pi-harness: prompt slot name must be non-empty");
			if (typeof definition.render !== "function") {
				throw new Error(`pi-harness: prompt slot ${JSON.stringify(definition.name)} requires a renderer`);
			}
			if (getSlot(definition.name, scope) || registeredSlots.has(definition.name)) {
				throw new Error(`pi-harness: prompt slot ${JSON.stringify(definition.name)} is already registered`);
			}
			scope.registerSlot(definition);
			registeredSlots.add(definition.name);
		},
		async completeSideRequest(prompt, requestOptions) {
			if (disposed) throw new Error("pi-harness: session is disposed");
			const extension = harness.session.extensionRunner.createContext();
			return completeBrowserSideRequest(extension, prompt, requestOptions);
		},
		async abort() {
			await harness.abort();
		},
		async dispose() {
			if (disposed) return;
			disposed = true;
			for (const unsubscribe of eventUnsubscribers) unsubscribe();
			eventUnsubscribers.clear();
			params.askBroker?.dispose("pi-harness: session disposed");
			await harness.dispose();
			harness.session.sessionScope?.dispose();
		},
	};
}

export const createPiHarness = createPiHarnessWithTools;
export type CreatePiHarnessOptions = CreateBrowserHarnessOptions;
export type PiHarness = BrowserPiHarness;
export type PiHarnessToolsOptions = BrowserHarnessToolsOptions;
