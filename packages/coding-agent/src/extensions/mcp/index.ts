import { resolve } from "node:path";
import type { TSchema } from "typebox";
import { ENV_SETTINGS_FILE, getAgentDir, getProjectConfigDirFor } from "../../config.ts";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
	ToolDefinition,
} from "../../core/extensions/types.ts";
import type { McpExposure, McpServerConfig, RegisteredMcpServer } from "../../core/mcp-servers.ts";
import { getMcpToolExposure, validateMcpServerConfig } from "../../core/mcp-servers.ts";
import { TOOL_SEARCH_TOOL_NAME } from "../../core/tool-search/tool-search-definition.ts";
import { openBrowser } from "../../utils/open-browser.ts";
import { type LoadedMcpConfig, loadMcpConfig, type McpServerEntry, updateMcpServerConfig } from "./config.ts";
import { McpOAuthCredentialStore, McpSignInCancelledError, signInMcpServer } from "./oauth.ts";
import { createMcpResourceToolDefinitions } from "./resources.ts";
import { McpServerConnection, type McpTransportFactory } from "./runtime.ts";
import { createMcpToolDefinition, createMcpToolName, type McpToolDetails } from "./tools.ts";

export interface McpExtensionOptions {
	agentDir?: string;
	configDir?: string;
	settingsFile?: string;
	globalConfigPath?: string;
	projectConfigPath?: string;
	loadConfig?: (ctx: ExtensionContext, projectTrusted: boolean) => LoadedMcpConfig;
	createTransport?: McpTransportFactory;
	providerToken?: (provider: string) => Promise<string | undefined>;
	openUrl?: (url: string) => void;
	startupWaitMs?: number;
}
function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
function extensionEntry(server: RegisteredMcpServer): McpServerEntry {
	const config = validateMcpServerConfig(server.name, server.config);
	if (typeof config === "string") throw new Error(`Invalid MCP server "${server.name}": ${config}`);
	return { name: server.name, config, source: server.extensionPath, scope: "extension" };
}
function registrationFingerprint(config: McpServerConfig): string {
	return JSON.stringify(config);
}

/** The built-in MCP host; config loading is trust-gated and path roots may be injected per session. */
export function createMcpExtension(options: McpExtensionOptions = {}): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		const servers = new Map<string, McpServerConnection>();
		const toolsByServer = new Map<string, Set<string>>();
		const definitions = new Map<string, ToolDefinition<TSchema, McpToolDetails>>();
		const usedNames = new Map<string, string>();
		let credentials: McpOAuthCredentialStore | undefined;
		let entries: McpServerEntry[] = [];
		let startup: Promise<void> | undefined;
		let active = false;
		let cwd = "";
		let agentDir = options.agentDir ?? "";
		let projectConfigPath: string | undefined;
		let startupWaited = false;
		let autoEnableCodemode = true;
		let resourceToolsExposure: McpExposure | undefined;
		let sessionContext: ExtensionContext | undefined;
		const warnedUnavailable = new Set<McpExposure>();
		let syncResourceTools: () => void = () => {};
		const hideServerTools = (name: string) => {
			for (const toolName of toolsByServer.get(name) ?? []) {
				const definition = definitions.get(toolName);
				if (!definition) continue;
				const hidden = { ...definition, exposure: "hidden" as const };
				definitions.set(toolName, hidden);
				pi.registerTool(hidden);
			}
			toolsByServer.delete(name);
		};
		const registerConnectionTools = (connection: McpServerConnection) => {
			const previous = toolsByServer.get(connection.name) ?? new Set<string>();
			const current = new Set<string>();
			for (const tool of connection.tools) {
				const owner = `${connection.name}/${tool.name}`;
				const name = createMcpToolName(connection.name, tool.name, (candidate) => {
					const existing = usedNames.get(candidate);
					return existing !== undefined && existing !== owner;
				});
				usedNames.set(name, owner);
				const definition = createMcpToolDefinition({
					server: connection.name,
					tool,
					name,
					exposure: getMcpToolExposure(connection.entry.config, tool.name),
					timeoutMs: connection.timeoutMs,
					getClient: async () => connection,
				});
				definitions.set(name, definition);
				pi.registerTool(definition);
				current.add(name);
			}
			for (const old of previous) {
				if (current.has(old)) continue;
				const definition = definitions.get(old);
				if (definition) {
					const hidden = { ...definition, exposure: "hidden" as const };
					definitions.set(old, hidden);
					pi.registerTool(hidden);
				}
			}
			activateIndirectTools();
		};
		const effectiveEntries = (configured: McpServerEntry[], registered: RegisteredMcpServer[]) => {
			const names = new Set(configured.map((entry) => entry.name));
			return [...configured, ...registered.filter((server) => !names.has(server.name)).map(extensionEntry)];
		};
		const activateIndirectTools = () => {
			const enabledEntries = effectiveEntries(entries, pi.getMcpServers()).filter(
				(entry) => entry.config.enabled !== false,
			);
			const exposures = new Set(
				enabledEntries.flatMap((entry) => [
					entry.config.exposure ?? "codemode",
					...Object.values(entry.config.toolExposure ?? {}),
				]),
			);
			const needsCodemode = exposures.has("codemode");
			const needsToolSearch = exposures.has("deferred");
			const available = new Set(pi.getAllTools().map((tool) => tool.name));
			const additions = [
				...(autoEnableCodemode && needsCodemode ? ["codemode"] : []),
				...(needsToolSearch ? [TOOL_SEARCH_TOOL_NAME] : []),
			].filter((name) => available.has(name));
			const activeTools = new Set(pi.getActiveTools());
			const next = [...activeTools, ...additions.filter((name) => !activeTools.has(name))];
			if (next.length !== activeTools.size) pi.setActiveTools(next);

			const active = new Set(next);
			const unavailable: Array<[McpExposure, string]> = [];
			if (needsCodemode && (!available.has("codemode") || !active.has("codemode"))) {
				unavailable.push(["codemode", autoEnableCodemode ? "codemode" : "codemode (autoEnableCodemode is false)"]);
			}
			if (needsToolSearch && (!available.has(TOOL_SEARCH_TOOL_NAME) || !active.has(TOOL_SEARCH_TOOL_NAME))) {
				unavailable.push(["deferred", TOOL_SEARCH_TOOL_NAME]);
			}
			if (![...servers.values()].some((server) => server.state === "connected")) return;
			for (const [exposure, toolName] of unavailable) {
				if (warnedUnavailable.has(exposure)) continue;
				warnedUnavailable.add(exposure);
				sessionContext?.ui.notify(
					`MCP tools configured for ${exposure} exposure are not reachable: required discovery tool "${toolName}" is missing or inactive.`,
					"warning",
				);
			}
			for (const exposure of exposures) {
				if (exposure === "codemode" || exposure === "deferred") {
					if (!unavailable.some(([missing]) => missing === exposure)) warnedUnavailable.delete(exposure);
				}
			}
		};
		const reconnectEntry = async (entry: McpServerEntry) => {
			if (entry.config.enabled === false) return;
			const previous = servers.get(entry.name);
			if (previous && registrationFingerprint(previous.entry.config) === registrationFingerprint(entry.config))
				return;
			if (previous) {
				hideServerTools(entry.name);
				await previous.close();
				servers.delete(entry.name);
			}
			const connection = new McpServerConnection({
				entry,
				cwd,
				createTransport: options.createTransport,
				providerToken: options.providerToken,
				credentials,
				onTools: registerConnectionTools,
				onChange: syncResourceTools,
			});
			servers.set(entry.name, connection);
			void connection.getClient().catch(() => undefined);
		};
		const reloadRegistrations = async (registered: RegisteredMcpServer[]) => {
			if (!active) return;
			const next = effectiveEntries(entries, registered);
			const names = new Set(next.filter((entry) => entry.config.enabled !== false).map((entry) => entry.name));
			for (const [name, connection] of servers) {
				if (names.has(name)) continue;
				hideServerTools(name);
				await connection.close();
				servers.delete(name);
			}
			await Promise.all(next.map(reconnectEntry));
			activateIndirectTools();
		};
		const resourceServers = () =>
			[...servers.values()].filter(
				(server) =>
					server.state === "connected" &&
					server.hasResources &&
					server.entry.config.enabled !== false &&
					server.entry.config.exposure !== "hidden",
			);
		syncResourceTools = () => {
			const exposures = new Set(resourceServers().map((server) => server.entry.config.exposure ?? "codemode"));
			const exposure =
				(["direct", "codemode", "deferred"] as const).find((candidate) => exposures.has(candidate)) ?? "hidden";
			if (exposure === resourceToolsExposure) return;
			resourceToolsExposure = exposure;
			for (const definition of createMcpResourceToolDefinitions({ exposure, servers: resourceServers })) {
				definitions.set(definition.name, definition);
				pi.registerTool(definition);
			}
		};
		const trustedForSession = (ctx: ExtensionContext) => ctx.isProjectTrusted();
		const readConfig = (ctx: ExtensionContext, trusted: boolean): LoadedMcpConfig => {
			const settingsFile = options.settingsFile ?? process.env[ENV_SETTINGS_FILE];
			return (
				options.loadConfig?.(ctx, trusted) ??
				loadMcpConfig({
					agentDir,
					cwd: ctx.cwd,
					projectTrusted: trusted,
					globalConfigPath: options.globalConfigPath,
					projectConfigPath:
						options.projectConfigPath ?? getProjectConfigDirFor(ctx.cwd, options.configDir, "mcp.json"),
					settingsFile: settingsFile ? resolve(ctx.cwd, settingsFile) : undefined,
				})
			);
		};
		const start = async (ctx: ExtensionContext) => {
			active = true;
			sessionContext = ctx;
			warnedUnavailable.clear();
			const trusted = trustedForSession(ctx);
			cwd = ctx.cwd;
			agentDir = options.agentDir ?? getAgentDir();
			const loaded = readConfig(ctx, trusted);
			entries = loaded.servers;
			autoEnableCodemode = loaded.autoEnableCodemode ?? true;
			projectConfigPath = loaded.projectConfig;
			credentials = new McpOAuthCredentialStore(agentDir);
			startupWaited = false;
			syncResourceTools();
			await reloadRegistrations(pi.getMcpServers());
			if (loaded.errors.length) ctx.ui.notify(loaded.errors.join("\n"), "warning");
		};
		pi.on("session_start", (_event, ctx) => {
			startup = start(ctx).catch((error) => ctx.ui.notify(`MCP host startup failed: ${errorText(error)}`, "error"));
			return startup;
		});
		pi.on("mcp_servers_change", (event) => {
			if (active) void reloadRegistrations(event.servers);
		});
		pi.on("before_agent_start", async () => {
			if (startup) await startup;
			if (startupWaited) return;
			startupWaited = true;
			const direct = [...servers.values()].filter((server) => {
				if (server.entry.config.enabled === false) return false;
				return [
					server.entry.config.exposure ?? "codemode",
					...Object.values(server.entry.config.toolExposure ?? {}),
				].includes("direct");
			});
			if (direct.length === 0) return;
			const connected = Promise.allSettled(direct.map((server) => server.waitUntilReady()));
			const { promise: timeout, resolve: finishTimeout } = Promise.withResolvers<void>();
			const timer = setTimeout(finishTimeout, options.startupWaitMs ?? 10_000);
			timer.unref?.();
			await Promise.race([connected, timeout]);
			clearTimeout(timer);
		});
		pi.on("session_shutdown", async () => {
			active = false;
			sessionContext = undefined;
			warnedUnavailable.clear();
			await startup?.catch(() => undefined);
			for (const [name, connection] of servers) {
				hideServerTools(name);
				await connection.close();
			}
			servers.clear();
		});
		pi.registerCommand("mcp", {
			description: "Manage MCP servers",
			async handler(args: string, ctx: ExtensionCommandContext) {
				const [action, target] = args.trim().split(/\s+/, 2);
				if (!action || action === "status" || action === "list") {
					const rows = entries.map((entry) => {
						const server = servers.get(entry.name);
						return `${entry.name}: ${server?.state ?? (entry.config.enabled === false ? "disabled" : "starting")}${server?.error ? ` — ${server.error}` : ""}`;
					});
					ctx.ui.notify(rows.join("\n") || "No MCP servers configured", "info");
					return;
				}
				if (action === "reconnect") {
					const selected = target
						? [servers.get(target)].filter((server): server is McpServerConnection => !!server)
						: [...servers.values()];
					await Promise.all(
						selected.map((server) =>
							server.reconnect().catch((error) => ctx.ui.notify(errorText(error), "error")),
						),
					);
					return;
				}
				if (action === "enable" || action === "disable" || action === "exposure") {
					const entry = entries.find((candidate) => candidate.name === target);
					if (!entry) {
						ctx.ui.notify(`Unknown MCP server "${target ?? ""}".`, "warning");
						return;
					}
					if (entry.scope === "extension") {
						ctx.ui.notify(
							`MCP server "${entry.name}" is registered by an extension; edit its registration to change it.`,
							"warning",
						);
						return;
					}
					const trusted = ctx.isProjectTrusted();
					const path =
						entry.override ??
						(entry.scope === "global" && trusted && projectConfigPath ? projectConfigPath : entry.source);
					const patch =
						action === "enable" ? { enabled: true } : action === "disable" ? { enabled: false } : undefined;
					if (patch) {
						updateMcpServerConfig(path, entry.name, patch, { override: entry.scope === "global" && trusted });
					} else {
						const exposure = args.trim().split(/\s+/)[2];
						if (!exposure || !["direct", "deferred", "codemode", "hidden"].includes(exposure)) {
							ctx.ui.notify("Usage: /mcp exposure <server> <direct|deferred|codemode|hidden>", "warning");
							return;
						}
						updateMcpServerConfig(
							path,
							entry.name,
							{ exposure: exposure as McpExposure },
							{ override: entry.scope === "global" && trusted },
						);
					}
					const loaded = readConfig(ctx, trusted);
					entries = loaded.servers;
					await reloadRegistrations(pi.getMcpServers());
					return;
				}
				if (action === "login" || action === "logout") {
					const server = target ? servers.get(target) : undefined;
					if (!server?.oauthUrl) {
						ctx.ui.notify(
							target
								? `MCP server "${target}" does not use OAuth.`
								: `Specify an OAuth server: /mcp ${action} <server>.`,
							"warning",
						);
						return;
					}
					if (!credentials) throw new Error("MCP OAuth credentials are unavailable");
					const store = credentials.forServer(server.name, server.oauthUrl);
					if (action === "logout") {
						credentials.remove(server.name, server.oauthUrl);
						await server.disconnect();
						ctx.ui.notify(`Signed out from ${server.name}.`, "info");
						return;
					}
					const prompt = {
						showAuthorizationUrl: (url: URL) => {
							ctx.ui.notify(`Open this MCP sign-in URL: ${url.href}`, "info");
							(options.openUrl ?? openBrowser)(url.href);
						},
						promptForRedirectUrl: async (signal: AbortSignal) =>
							signal.aborted
								? undefined
								: ctx.ui.input("MCP sign-in", "Paste the full redirect URL from your browser address bar"),
					};
					try {
						await signInMcpServer({
							serverUrl: server.oauthUrl,
							store,
							settings: server.oauthSettings,
							challenge: server.oauthChallenge,
							prompt,
						});
						await server.reconnect();
						ctx.ui.notify(`Signed in to ${server.name}.`, "info");
					} catch (error) {
						if (!(error instanceof McpSignInCancelledError)) ctx.ui.notify(errorText(error), "error");
					}
					return;
				}
				ctx.ui.notify("Usage: /mcp [status|reconnect [server]|login <server>|logout <server>]", "warning");
			},
		});
	};
}
