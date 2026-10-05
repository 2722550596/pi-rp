import type { Provider } from "@earendil-works/pi-ai";
import type { ProviderConfig } from "./extensions/types.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import { PromptRegistryScope } from "./prompt-preset/registry-scope.ts";
import type { SlotDefinition } from "./prompt-preset/types.ts";

/** Nonpersistent provider-request context, rendered once per AgentSession scope. */
export interface RuntimeContextSlot {
	readonly id: string;
	render(): string | Promise<string>;
	readonly inheritToSubagents?: boolean;
}

type ProviderRegistration =
	| { kind: "config"; extensionPath: string; id: string; config: ProviderConfig }
	| { kind: "native"; extensionPath: string; id: string; provider: Provider };

type ManagedRegistration = {
	registration: ProviderRegistration;
	refs: Map<symbol, ProviderRegistration>;
};

export type AgentSessionScopeErrorCode =
	| "SESSION_REPLACEMENT_UNSUPPORTED"
	| "PROVIDER_REGISTRATION_CONFLICT"
	| "SESSION_SCOPE_DISPOSED";

/** Typed failures for Host-scoped AgentSession policies. */
export class AgentSessionScopeError extends Error {
	readonly code: AgentSessionScopeErrorCode;

	constructor(code: AgentSessionScopeErrorCode, message: string) {
		super(message);
		this.name = "AgentSessionScopeError";
		this.code = code;
	}
}

const functionIdentities = new WeakMap<object, number>();
let nextFunctionIdentity = 1;

function canonicalValue(value: unknown, seen: Set<object>): string | undefined {
	if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
	if (typeof value === "number") return Number.isFinite(value) ? String(value) : undefined;
	if (typeof value === "undefined") return "undefined";
	if (typeof value === "function") {
		let identity = functionIdentities.get(value);
		if (identity === undefined) {
			identity = nextFunctionIdentity++;
			functionIdentities.set(value, identity);
		}
		return `function:${identity}`;
	}
	if (typeof value !== "object" || seen.has(value)) return undefined;
	seen.add(value);
	let result: string | undefined;
	if (Array.isArray(value)) {
		const parts = value.map((entry) => canonicalValue(entry, seen));
		result = parts.some((part) => part === undefined) ? undefined : `[${parts.join(",")}]`;
	} else if (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) {
		const parts: string[] = [];
		let valid = true;
		for (const key of Object.keys(value).sort()) {
			const entry = (value as Record<string, unknown>)[key];
			if (entry === undefined) continue;
			const encoded = canonicalValue(entry, seen);
			if (encoded === undefined) {
				valid = false;
				break;
			}
			parts.push(`${JSON.stringify(key)}:${encoded}`);
		}
		if (valid) result = `{${parts.join(",")}}`;
	}
	seen.delete(value);
	return result;
}

function copyProviderConfig(value: unknown, seen = new Map<object, unknown>()): unknown {
	if (value === null || typeof value !== "object") return value;
	const existing = seen.get(value);
	if (existing !== undefined) return existing;
	if (Array.isArray(value)) {
		const copy: unknown[] = [];
		seen.set(value, copy);
		for (const item of value) copy.push(copyProviderConfig(item, seen));
		return copy;
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return value;
	const copy = Object.create(prototype) as Record<string, unknown>;
	seen.set(value, copy);
	for (const [key, entry] of Object.entries(value)) {
		if (entry !== undefined) copy[key] = copyProviderConfig(entry, seen);
	}
	return copy;
}

function stableRegistration(registration: ProviderRegistration): ProviderRegistration {
	return registration.kind === "config"
		? { ...registration, config: copyProviderConfig(registration.config) as ProviderConfig }
		: registration;
}

function sameRegistration(a: ProviderRegistration, b: ProviderRegistration): boolean {
	if (a.kind !== b.kind || a.extensionPath !== b.extensionPath || a.id !== b.id) return false;
	if (a.kind === "native" && b.kind === "native") return a.provider === b.provider;
	if (a.kind === "config" && b.kind === "config") {
		if (a.config === b.config) return true;
		const aValue = canonicalValue(a.config, new Set());
		return aValue !== undefined && aValue === canonicalValue(b.config, new Set());
	}
	return false;
}

class ProviderRegistrationCoordinator {
	private readonly registrations = new Map<string, ManagedRegistration>();
	private readonly runtime: ModelRuntime;

	constructor(runtime: ModelRuntime) {
		this.runtime = runtime;
	}

	reconcile(
		scopeId: symbol,
		previous: Map<string, ProviderRegistration>,
		next: Map<string, ProviderRegistration>,
	): void {
		for (const [id, registration] of next) {
			const managed = this.registrations.get(id);
			if (managed) {
				if (managed.registration.extensionPath !== registration.extensionPath) {
					throw new AgentSessionScopeError(
						"PROVIDER_REGISTRATION_CONFLICT",
						`Provider "${id}" is already owned by extension "${managed.registration.extensionPath}"; "${registration.extensionPath}" cannot replace it.`,
					);
				}
				if (
					!sameRegistration(managed.registration, registration) &&
					[...managed.refs.keys()].some((owner) => owner !== scopeId)
				) {
					throw new AgentSessionScopeError(
						"PROVIDER_REGISTRATION_CONFLICT",
						`Provider "${id}" changed while another AgentSession still owns extension "${registration.extensionPath}".`,
					);
				}
			} else if (
				this.runtime.getRegisteredProviderConfig(id) !== undefined ||
				this.runtime.getRegisteredNativeProvider(id) !== undefined
			) {
				throw new AgentSessionScopeError(
					"PROVIDER_REGISTRATION_CONFLICT",
					`Provider "${id}" already has an unmanaged extension registration; refusing to overwrite it.`,
				);
			}
		}

		const ids = new Set([...previous.keys(), ...next.keys()]);
		const changed: Array<{ id: string; old?: ProviderRegistration }> = [];
		try {
			for (const id of ids) {
				const managed = this.registrations.get(id);
				const desired = next.get(id);
				const isSame = !!managed && !!desired && sameRegistration(managed.registration, desired);
				const isLastRef = !!managed && managed.refs.size === 1 && managed.refs.has(scopeId);
				if ((!desired && isLastRef) || (desired && !isSame && (!managed || isLastRef))) {
					changed.push({ id, old: managed?.registration });
					if (managed) this.runtime.unregisterProvider(id);
					if (desired) this.apply(desired);
				}
			}
		} catch (error) {
			const rollbackErrors: unknown[] = [];
			for (const { id, old } of changed.reverse()) {
				try {
					this.runtime.unregisterProvider(id);
					if (old) this.apply(old);
				} catch (rollbackError) {
					rollbackErrors.push(rollbackError);
				}
			}
			if (rollbackErrors.length > 0) {
				throw new AggregateError(
					[error, ...rollbackErrors],
					"Provider registration failed and rollback could not fully restore the previous runtime state",
				);
			}
			throw error;
		}

		for (const id of ids) {
			const managed = this.registrations.get(id);
			const desired = next.get(id);
			const same = !!managed && !!desired && sameRegistration(managed.registration, desired);
			if (same) {
				managed.refs.set(scopeId, desired!);
				continue;
			}
			if (managed) {
				managed.refs.delete(scopeId);
				if (managed.refs.size === 0) this.registrations.delete(id);
			}
			if (desired) {
				const replacement = this.registrations.get(id);
				if (replacement) {
					replacement.refs.set(scopeId, desired);
				} else {
					this.registrations.set(id, { registration: desired, refs: new Map([[scopeId, desired]]) });
				}
			}
		}
	}

	private apply(registration: ProviderRegistration): void {
		if (registration.kind === "native") this.runtime.registerNativeProvider(registration.provider);
		else this.runtime.registerProvider(registration.id, copyProviderConfig(registration.config) as ProviderConfig);
	}
}
const providerCoordinators = new WeakMap<ModelRuntime, ProviderRegistrationCoordinator>();

function coordinatorFor(runtime: ModelRuntime): ProviderRegistrationCoordinator {
	let coordinator = providerCoordinators.get(runtime);
	if (!coordinator) {
		coordinator = new ProviderRegistrationCoordinator(runtime);
		providerCoordinators.set(runtime, coordinator);
	}
	return coordinator;
}

/**
 * Explicit per-AgentSession scope for prompt definitions and supported ExtensionAPI provider registrations.
 * Raw `pi-ai/compat` registry calls and arbitrary extension module/process globals are not intercepted.
 * Host callers must use curated trusted extensions and dispose the scope after the AgentSession, including failed construction.
 */
export interface AgentSessionScopeOptions {
	readonly rejectSessionReplacement?: boolean;
	/** Host-owned prompt slots explicitly safe and required in delegated subagent sessions. */
	readonly subagentPromptSlots?: readonly SlotDefinition[];
	/** Runtime-only provider context; child scopes receive explicit inheritToSubagents entries only. */
	readonly runtimeContextSlots?: readonly RuntimeContextSlot[];
}

export class AgentSessionScope {
	readonly promptRegistry = new PromptRegistryScope();
	private readonly id = Symbol("AgentSessionScope");
	private readonly rejectReplacement: boolean;
	private readonly subagentPromptSlots: readonly SlotDefinition[];
	private runtime?: ModelRuntime;
	private readonly runtimeSlots: RuntimeContextSlot[];
	private runtimeContextContents = new Map<string, string>();
	private runtimeContextGeneration = 0;
	private runtimeContextPromise?: Promise<string>;
	private activeProviders = new Map<string, ProviderRegistration>();
	private stagedProviders?: Map<string, ProviderRegistration>;
	private stagedProviderError?: AgentSessionScopeError;
	private disposed = false;

	constructor(options: AgentSessionScopeOptions = {}) {
		this.rejectReplacement = options.rejectSessionReplacement ?? false;
		this.subagentPromptSlots = options.subagentPromptSlots ?? [];
		this.runtimeSlots = [...(options.runtimeContextSlots ?? [])];
		for (const slot of this.subagentPromptSlots) this.promptRegistry.registerSlot(slot);
	}

	getRuntimeContext(): Promise<string> {
		this.assertActive();
		if (!this.runtimeContextPromise) {
			const generation = this.runtimeContextGeneration;
			this.runtimeContextPromise = Promise.all(
				this.runtimeSlots.map(async (slot) => [slot.id, await slot.render()] as const),
			).then((rendered) => {
				if (generation === this.runtimeContextGeneration) {
					for (const [id, content] of rendered) this.runtimeContextContents.set(id, content);
				}
				return this.renderRuntimeContext();
			});
		}
		return this.runtimeContextPromise;
	}

	invalidateRuntimeContext(): void {
		this.runtimeContextGeneration++;
		this.runtimeContextContents.clear();
		this.runtimeContextPromise = undefined;
	}
	addRuntimeContextSlots(slots: readonly RuntimeContextSlot[]): void {
		this.assertActive();
		const existingIds = new Set(this.runtimeSlots.map((slot) => slot.id));
		let changed = false;
		for (const slot of slots) {
			if (existingIds.has(slot.id)) continue;
			existingIds.add(slot.id);
			this.runtimeSlots.push(slot);
			changed = true;
		}
		if (changed) this.invalidateRuntimeContext();
	}

	/** Apply pre-rendered compact replacements without re-running slot renderers. */
	replaceRuntimeContextSlots(replacements: readonly { readonly slotId: string; readonly content: string }[]): void {
		const runtimeSlotIds = new Set(this.runtimeSlots.map((slot) => slot.id));
		const nextContents = new Map(this.runtimeContextContents);
		let replaced = false;
		for (const replacement of replacements) {
			if (!runtimeSlotIds.has(replacement.slotId)) continue;
			nextContents.set(replacement.slotId, replacement.content);
			replaced = true;
		}
		if (!replaced) return;
		this.runtimeContextGeneration++;
		this.runtimeContextContents = nextContents;
		this.runtimeContextPromise = Promise.resolve(this.renderRuntimeContext());
	}

	private renderRuntimeContext(): string {
		return this.runtimeSlots
			.map((slot) => this.runtimeContextContents.get(slot.id) ?? "")
			.filter((part) => part.length > 0)
			.join("\n\n");
	}

	get rejectSessionReplacement(): boolean {
		return this.rejectReplacement;
	}

	/** Create an isolated child scope with only host-whitelisted prompt/runtime slots. */
	createSubagentScope(): AgentSessionScope {
		this.assertActive();
		return createAgentSessionScope({
			rejectSessionReplacement: true,
			subagentPromptSlots: this.subagentPromptSlots,
			runtimeContextSlots: this.runtimeSlots.filter((slot) => slot.inheritToSubagents === true),
		});
	}

	bindModelRuntime(runtime: ModelRuntime): void {
		this.assertActive();
		if (this.runtime === runtime) throw new Error("AgentSession scope is already attached to an AgentSession");
		if (this.runtime) throw new Error("AgentSession scope cannot be rebound to another ModelRuntime");
		this.runtime = runtime;
		coordinatorFor(runtime);
	}

	assertReplacementAllowed(): void {
		this.assertActive();
		if (this.rejectReplacement) {
			throw new AgentSessionScopeError(
				"SESSION_REPLACEMENT_UNSUPPORTED",
				"Session replacement (new, fork, switch, or import) is not supported by this Host session.",
			);
		}
	}

	beginUpdate(): { commit(): void; rollback(): void } {
		this.assertActive();
		if (this.stagedProviders) throw new Error("AgentSession scope update already in progress");
		this.promptRegistry.beginUpdate();
		for (const slot of this.subagentPromptSlots) this.promptRegistry.registerSlot(slot);
		this.stagedProviders = new Map();
		this.stagedProviderError = undefined;
		let finished = false;
		return {
			commit: () => {
				if (finished) return;
				this.assertActive();
				if (this.stagedProviderError) throw this.stagedProviderError;
				if (this.runtime) {
					this.providerCoordinator().reconcile(this.id, this.activeProviders, this.stagedProviders!);
				} else if (this.activeProviders.size > 0 || this.stagedProviders!.size > 0) {
					throw new Error("AgentSession scope must be bound to a ModelRuntime before provider registration");
				}
				this.activeProviders = this.stagedProviders!;
				this.stagedProviders = undefined;
				this.promptRegistry.commitUpdate();
				finished = true;
			},
			rollback: () => {
				if (finished) return;
				this.stagedProviders = undefined;
				this.stagedProviderError = undefined;
				this.promptRegistry.rollbackUpdate();
				finished = true;
			},
		};
	}

	registerProvider(extensionPath: string, id: string, config: ProviderConfig): void {
		this.addProvider({ kind: "config", extensionPath, id, config });
	}

	registerNativeProvider(extensionPath: string, provider: Provider): void {
		this.addProvider({ kind: "native", extensionPath, id: provider.id, provider });
	}

	unregisterProvider(extensionPath: string, id: string): void {
		this.assertActive();
		const current = this.stagedProviders ?? this.activeProviders;
		const previous = current.get(id);
		if (!previous || previous.extensionPath !== extensionPath) return;
		const next = new Map(current);
		next.delete(id);
		if (this.stagedProviders) this.stagedProviders = next;
		else {
			this.providerCoordinator().reconcile(this.id, this.activeProviders, next);
			this.activeProviders = next;
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.stagedProviders = undefined;
		this.stagedProviderError = undefined;
		this.promptRegistry.rollbackUpdate();
		if (this.runtime) this.providerCoordinator().reconcile(this.id, this.activeProviders, new Map());
		this.activeProviders.clear();
		this.promptRegistry.dispose();
		this.invalidateRuntimeContext();
		this.runtimeSlots.length = 0;
		this.disposed = true;
	}

	private addProvider(registration: ProviderRegistration): void {
		this.assertActive();
		const current = this.stagedProviders ?? this.activeProviders;
		const existing = current.get(registration.id);
		if (existing && existing.extensionPath !== registration.extensionPath) {
			const error = new AgentSessionScopeError(
				"PROVIDER_REGISTRATION_CONFLICT",
				`Provider "${registration.id}" is registered by both "${existing.extensionPath}" and "${registration.extensionPath}" in one AgentSession.`,
			);
			if (this.stagedProviders) this.stagedProviderError = error;
			throw error;
		}
		if (existing?.kind === "config" && registration.kind === "config") {
			const config: ProviderConfig = { ...existing.config };
			for (const [key, value] of Object.entries(registration.config)) {
				if (value !== undefined) (config as Record<string, unknown>)[key] = value;
			}
			registration = { ...registration, config };
		}
		const next = new Map(current);
		next.set(registration.id, stableRegistration(registration));
		if (this.stagedProviders) this.stagedProviders = next;
		else {
			this.providerCoordinator().reconcile(this.id, this.activeProviders, next);
			this.activeProviders = next;
		}
	}

	private providerCoordinator(): ProviderRegistrationCoordinator {
		if (!this.runtime) throw new Error("AgentSession scope has not been bound to a ModelRuntime");
		return coordinatorFor(this.runtime);
	}

	private assertActive(): void {
		if (this.disposed) {
			throw new AgentSessionScopeError("SESSION_SCOPE_DISPOSED", "AgentSession scope has been disposed");
		}
	}
}

export function createAgentSessionScope(options: AgentSessionScopeOptions = {}): AgentSessionScope {
	return new AgentSessionScope(options);
}
