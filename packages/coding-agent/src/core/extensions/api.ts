/**
 * Extension assembly core — the profile-independent half of the extension loader.
 *
 * Both extension channels run their factories through the machinery in this module and produce the same `Extension`
 * shape; that structural shared core is the guarantee behind invariant I5 (loading the same extension source through
 * the disk channel and the bundled channel behaves identically). The bundled channel (ESM default-export factories
 * injected via `extensionFactories`) is the primary consumer on browser/hosted profiles; the node profile reaches the
 * same core through `./loader.ts`, which wraps the constructors here with node defaults (jiti loading, disk discovery,
 * the path-keyed module cache, `execCommand` as the `pi.exec` implementation).
 *
 * Hard constraint: PURE TypeScript — no `node:` imports, no jiti, no Node-only transitive imports, so browser bundles
 * can import this module directly (12-C §9 seam 1). `cwd` arguments are taken as-is and must already be canonical at
 * the assembly point (the node wrapper applies resolvePath; browser assembly passes the virtual workspace path).
 */
import type { Capabilities } from "@earendil-works/pi-agent-core";
import type { Provider } from "@earendil-works/pi-ai";
import type { KeyId } from "@earendil-works/pi-tui";
import type { EventBus } from "../event-bus.ts";
import { createMemoryEventBus } from "../event-bus-memory.ts";
import type { ExecOptions } from "../exec.ts";
import { McpServerRegistry, type RegisteredMcpServer } from "../mcp-servers.ts";
import { type CustomTypePolicy, DEFAULT_CUSTOM_TYPE_POLICY } from "../messages.ts";
import { createSyntheticSourceInfo } from "../source-info.ts";
import { time } from "../timings.ts";
import { refusalExec } from "./exec-impl.ts";
import type {
	EntryRenderer,
	Extension,
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	ExtensionRuntime,
	ExtensionRuntimeOptions,
	InlineExtension,
	LoadExtensionsResult,
	MarkdownTransformer,
	MessageContentTransformer,
	MessageRenderer,
	ProviderConfig,
	RegisteredCommand,
	ToolDefinition,
} from "./types.ts";

type HandlerFn = (...args: unknown[]) => Promise<unknown>;

/**
 * Create a runtime with throwing stubs for action methods.
 * Runner.bindCore() replaces these with real implementations.
 *
 * `options.exec` selects the implementation backing `pi.exec`; the default is the structured shell refusal (the safe
 * negotiated absence — the node loader wrapper injects `execCommand`, so node behavior is unchanged). `options.capabilities`
 * carries the assembly point's negotiated capabilities to the registration boundary (registerTool `requires` gating)
 * and onto ExtensionContext; without it nothing is gated (legacy full-capability runtimes).
 */
export function createExtensionRuntime(options?: ExtensionRuntimeOptions): ExtensionRuntime {
	const notInitialized = () => {
		throw new Error("Extension runtime not initialized. Action methods cannot be called during extension loading.");
	};
	const state: { staleMessage?: string } = {};
	const eventBusUnsubscribers = new Set<() => void>();
	const customTypePolicies = new Map<string, CustomTypePolicy>();
	const assertActive = () => {
		if (state.staleMessage) {
			throw new Error(state.staleMessage);
		}
	};

	const runtime: ExtensionRuntime = {
		mcpServers: new McpServerRegistry(),
		sendMessage: notInitialized,
		emitActivity: notInitialized,
		sendUserMessage: notInitialized,
		startLiveMessage: notInitialized,
		appendEntry: notInitialized,
		setSessionName: notInitialized,
		getSessionName: notInitialized,
		setLabel: notInitialized,
		getActiveTools: notInitialized,
		getAllTools: notInitialized,
		setActiveTools: notInitialized,
		// registerTool() is valid during extension load; refresh is only needed post-bind.
		refreshTools: () => {},
		getCommands: notInitialized,
		setModel: () => Promise.reject(new Error("Extension runtime not initialized")),
		getThinkingLevel: notInitialized,
		setThinkingLevel: notInitialized,
		getState: notInitialized,
		subscribeState: notInitialized,
		updateState: notInitialized,
		registerSlot: (definition) => runtime.pendingSlotRegistrations.push(definition),
		registerMacro: (definition) => runtime.pendingMacroRegistrations.push(definition),
		registerCustomType: (customType, policy) => {
			if (!customTypePolicies.has(customType)) {
				customTypePolicies.set(customType, policy);
			}
		},
		getCustomTypePolicy: (customType) => customTypePolicies.get(customType) ?? DEFAULT_CUSTOM_TYPE_POLICY,
		flagValues: new Map(),
		execImpl: options?.exec ?? refusalExec(),
		capabilities: options?.capabilities,
		pendingRegistrationWarnings: [],
		pendingProviderRegistrations: [],
		pendingNativeProviderRegistrations: [],
		pendingSlotRegistrations: [],
		pendingMacroRegistrations: [],
		assertActive,
		invalidate: (message) => {
			if (state.staleMessage) return;
			for (const server of runtime.mcpServers.list()) {
				runtime.mcpServers.unregister(server.name, server.extensionPath);
			}
			runtime.mcpServers.setChangeListener(undefined);
			state.staleMessage =
				message ??
				"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().";
			for (const unsubscribe of eventBusUnsubscribers) unsubscribe();
			eventBusUnsubscribers.clear();
		},
		trackEventBusSubscription: (unsubscribe) => {
			let active = true;
			const trackedUnsubscribe = () => {
				if (!active) return;
				active = false;
				eventBusUnsubscribers.delete(trackedUnsubscribe);
				unsubscribe();
			};
			eventBusUnsubscribers.add(trackedUnsubscribe);
			return trackedUnsubscribe;
		},
		// Pre-bind: queue registrations so bindCore() can flush them once the
		// model registry is available. bindCore() replaces both with direct calls.
		registerProvider: (name, config, extensionPath = "<unknown>") => {
			runtime.pendingProviderRegistrations.push({ name, config, extensionPath });
		},
		registerNativeProvider: (provider, extensionPath = "<unknown>") => {
			runtime.pendingNativeProviderRegistrations.push({ provider, extensionPath });
		},
		unregisterProvider: (name, extensionPath = "<unknown>") => {
			runtime.pendingProviderRegistrations = runtime.pendingProviderRegistrations.filter(
				(registration) => registration.name !== name || registration.extensionPath !== extensionPath,
			);
			runtime.pendingNativeProviderRegistrations = runtime.pendingNativeProviderRegistrations.filter(
				(registration) => registration.provider.id !== name || registration.extensionPath !== extensionPath,
			);
		},
	};

	return runtime;
}

type ToolCapabilityKey = NonNullable<ToolDefinition["requires"]>[number];

/**
 * Registration-boundary capability check (12-C §4.9): a tool whose `requires` declaration is not covered by the
 * negotiated capabilities is refused registration (negotiated absence, never a runtime throw). Runtimes assembled
 * without capabilities gate nothing — the node profile negotiates every capability true.
 */
function findMissingCapability(
	requires: ToolDefinition["requires"],
	capabilities: Capabilities | undefined,
): ToolCapabilityKey | null {
	if (!requires?.length || !capabilities) return null;
	for (const key of requires) {
		if (!capabilities[key]) return key;
	}
	return null;
}

/**
 * Create the ExtensionAPI for an extension.
 * Registration methods write to the extension object.
 * Action methods delegate to the shared runtime.
 */
export function createExtensionAPI(
	extension: Extension,
	runtime: ExtensionRuntime,
	cwd: string,
	eventBus: EventBus,
): ExtensionAPI {
	const api = {
		// Registration methods - write to extension
		on(event: string, handler: HandlerFn): void {
			runtime.assertActive();
			const list = extension.handlers.get(event) ?? [];
			list.push(handler);
			extension.handlers.set(event, list);
		},

		registerTool(tool: ToolDefinition): void {
			runtime.assertActive();
			const missingCapability = findMissingCapability(tool.requires, runtime.capabilities);
			if (missingCapability) {
				runtime.pendingRegistrationWarnings.push({
					path: extension.path,
					error: `tool "${tool.name}" requires capability "${missingCapability}" not available in this profile; registration skipped`,
				});
				return;
			}
			extension.tools.set(tool.name, {
				definition: tool,
				sourceInfo: extension.sourceInfo,
			});
			runtime.refreshTools();
		},

		registerMcpServer(name: string, config: RegisteredMcpServer["config"]): void {
			runtime.assertActive();
			if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`Invalid MCP server name "${name}"`);
			const existing = runtime.mcpServers.get(name);
			if (existing && existing.extensionPath !== extension.path) {
				throw new Error(`MCP server "${name}" is already registered by extension "${existing.extensionPath}"`);
			}
			runtime.mcpServers.register({ name, config, extensionPath: extension.path });
		},

		unregisterMcpServer(name: string): void {
			runtime.assertActive();
			runtime.mcpServers.unregister(name, extension.path);
		},

		getMcpServers() {
			runtime.assertActive();
			return runtime.mcpServers.list();
		},

		registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void {
			runtime.assertActive();
			extension.commands.set(name, {
				name,
				sourceInfo: extension.sourceInfo,
				...options,
			});
		},

		registerShortcut(
			shortcut: KeyId,
			options: {
				description?: string;
				handler: (ctx: ExtensionContext) => Promise<void> | void;
			},
		): void {
			runtime.assertActive();
			extension.shortcuts.set(shortcut, { shortcut, extensionPath: extension.path, ...options });
		},

		registerFlag(
			name: string,
			options: { description?: string; type: "boolean" | "string"; default?: boolean | string },
		): void {
			runtime.assertActive();
			extension.flags.set(name, { name, extensionPath: extension.path, ...options });
			if (options.default !== undefined && !runtime.flagValues.has(name)) {
				runtime.flagValues.set(name, options.default);
			}
		},

		registerMessageRenderer<T>(customType: string, renderer: MessageRenderer<T>): void {
			runtime.assertActive();
			extension.messageRenderers.set(customType, renderer as MessageRenderer);
		},

		registerEntryRenderer<T>(customType: string, renderer: EntryRenderer<T>): void {
			runtime.assertActive();
			extension.entryRenderers ??= new Map();
			extension.entryRenderers.set(customType, renderer as EntryRenderer);
		},

		registerMarkdownTransformer(transformer: MarkdownTransformer): void {
			runtime.assertActive();
			extension.markdownTransformer = transformer;
		},

		registerMessageContentTransformer(transformer: MessageContentTransformer): void {
			runtime.assertActive();
			extension.messageContentTransformer = transformer;
		},

		// Flag access - checks extension registered it, reads from runtime
		getFlag(name: string): boolean | string | undefined {
			runtime.assertActive();
			if (!extension.flags.has(name)) return undefined;
			return runtime.flagValues.get(name);
		},

		// Action methods - delegate to shared runtime
		sendMessage(message, options): void {
			runtime.assertActive();
			runtime.sendMessage(message, options);
		},

		emitActivity(event): void {
			runtime.assertActive();
			runtime.emitActivity(event);
		},

		sendUserMessage(content, options): void {
			runtime.assertActive();
			runtime.sendUserMessage(content, options);
		},

		startLiveMessage(message) {
			runtime.assertActive();
			return runtime.startLiveMessage(message);
		},

		appendEntry(customType: string, data?: unknown): void {
			runtime.assertActive();
			runtime.appendEntry(customType, data);
		},

		setSessionName(name: string): void {
			runtime.assertActive();
			runtime.setSessionName(name);
		},

		getSessionName(): string | undefined {
			runtime.assertActive();
			return runtime.getSessionName();
		},

		setLabel(entryId: string, label: string | undefined): void {
			runtime.assertActive();
			runtime.setLabel(entryId, label);
		},

		exec(command: string, args: string[], options?: ExecOptions) {
			runtime.assertActive();
			return runtime.execImpl(command, args, options?.cwd ?? cwd, options);
		},

		getActiveTools(): string[] {
			runtime.assertActive();
			return runtime.getActiveTools();
		},

		getAllTools() {
			runtime.assertActive();
			return runtime.getAllTools();
		},

		setActiveTools(toolNames: string[]): void {
			runtime.assertActive();
			runtime.setActiveTools(toolNames);
		},

		getCommands() {
			runtime.assertActive();
			return runtime.getCommands();
		},

		setModel(model) {
			runtime.assertActive();
			return runtime.setModel(model);
		},

		getThinkingLevel() {
			runtime.assertActive();
			return runtime.getThinkingLevel();
		},

		setThinkingLevel(level) {
			runtime.assertActive();
			runtime.setThinkingLevel(level);
		},

		registerSlot(definition) {
			runtime.assertActive();
			runtime.registerSlot(definition);
		},

		registerMacro(definition) {
			runtime.assertActive();
			runtime.registerMacro(definition);
		},

		registerCustomType(customType, policy) {
			runtime.assertActive();
			runtime.registerCustomType(customType, { ...DEFAULT_CUSTOM_TYPE_POLICY, ...policy });
		},

		getCustomTypePolicy(customType) {
			runtime.assertActive();
			return runtime.getCustomTypePolicy(customType);
		},

		getState() {
			runtime.assertActive();
			return runtime.getState();
		},

		onStateChange(handler: (state: Record<string, unknown>) => void) {
			runtime.assertActive();
			return runtime.subscribeState(handler);
		},

		updateState(path, op, value) {
			runtime.assertActive();
			return runtime.updateState(path, op, value);
		},

		registerProvider(providerOrName: Provider | string, config?: ProviderConfig) {
			runtime.assertActive();
			if (typeof providerOrName === "string") {
				if (!config) throw new Error("Provider config is required when registering by name");
				runtime.registerProvider(providerOrName, config, extension.path);
				return;
			}
			runtime.registerNativeProvider(providerOrName, extension.path);
		},

		unregisterProvider(name: string) {
			runtime.assertActive();
			runtime.unregisterProvider(name, extension.path);
		},

		events: {
			emit(channel, data) {
				runtime.assertActive();
				eventBus.emit(channel, data);
			},
			on(channel, handler) {
				runtime.assertActive();
				return runtime.trackEventBusSubscription(eventBus.on(channel, handler));
			},
		},
	} as ExtensionAPI;

	return api;
}

/**
 * Create an Extension object with empty collections.
 *
 * `baseDir` is derived from real paths and therefore supplied by the caller: only the disk channel has one (computed
 * from the resolved file path); bundled-channel factories always carry `<inline:...>` paths whose baseDir is undefined.
 */
export function createExtension(extensionPath: string, resolvedPath: string, baseDir?: string): Extension {
	const source =
		extensionPath.startsWith("<") && extensionPath.endsWith(">")
			? extensionPath.slice(1, -1).split(":")[0] || "temporary"
			: "local";

	return {
		path: extensionPath,
		resolvedPath,
		sourceInfo: createSyntheticSourceInfo(extensionPath, { source, baseDir }),
		handlers: new Map(),
		tools: new Map(),
		messageRenderers: new Map(),
		entryRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	};
}

/**
 * Create an Extension from an inline factory function — the bundled channel's load primitive.
 */
export async function loadExtensionFromFactory(
	factory: ExtensionFactory,
	cwd: string,
	eventBus: EventBus,
	runtime: ExtensionRuntime,
	extensionPath = "<inline>",
): Promise<Extension> {
	const extension = createExtension(extensionPath, extensionPath);
	const api = createExtensionAPI(extension, runtime, cwd, eventBus);
	await factory(api);
	time(`${extensionPath} factory`, "extensions");
	return extension;
}

/**
 * Take all pending registration warnings, leaving the runtime ready for a fresh load pass (draining instead of
 * copying keeps multi-pass loads — e.g. the trust-guided double pass — free of duplicate diagnostics).
 */
function drainRegistrationWarnings(runtime: ExtensionRuntime): Array<{ path: string; error: string }> {
	return runtime.pendingRegistrationWarnings.splice(0);
}

/**
 * Load a list of inline factories — the bundled channel's bulk entry, shared by node assembly
 * (DefaultResourceLoader's `extensionFactories` option) and browser assembly. Signature mirrors loadExtensions.
 *
 * Per-factory failures become `errors` entries and never interrupt the remaining factories. Registration-time
 * capability warnings accumulated on the runtime are drained into the result (12-C §9 seam 6).
 */
export async function loadExtensionsFromFactories(
	factories: InlineExtension[],
	cwd: string,
	eventBus?: EventBus,
	runtime?: ExtensionRuntime,
): Promise<LoadExtensionsResult> {
	const resolvedEventBus = eventBus ?? createMemoryEventBus();
	const resolvedRuntime = runtime ?? createExtensionRuntime();
	const extensions: Extension[] = [];
	const errors: Array<{ path: string; error: string }> = [];

	for (const [index, input] of factories.entries()) {
		const isNamed = typeof input !== "function";
		const factory = isNamed ? input.factory : input;
		const extensionPath = `<inline:${isNamed ? input.name : index + 1}>`;
		try {
			const extension = await loadExtensionFromFactory(
				factory,
				cwd,
				resolvedEventBus,
				resolvedRuntime,
				extensionPath,
			);
			extension.hidden = isNamed && input.hidden;
			extensions.push(extension);
		} catch (error) {
			const message = error instanceof Error ? error.message : "failed to load extension";
			errors.push({ path: extensionPath, error: message });
		}
	}

	errors.push(...drainRegistrationWarnings(resolvedRuntime));

	return { extensions, errors, runtime: resolvedRuntime };
}

/**
 * Disk-channel cache stub — the path-keyed module cache is a node-only concern (jiti de-duplication, see
 * ./loader.ts). The bundled channel's cache is the language-level module singleton, so there is nothing to clear;
 * kept as a no-op so callers can invoke it profile-agnostically (12-C §4.7).
 */
export function clearExtensionCache(): void {}
