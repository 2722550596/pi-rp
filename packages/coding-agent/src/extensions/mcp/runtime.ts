import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	type AuthProvider,
	type CallToolResult,
	JSON_RPC_ERROR_CODES,
	type ListResourcesResult,
	type ListResourceTemplatesResult,
	McpClient,
	McpError,
	McpHttpError,
	type McpRequestOptions,
	McpSessionExpiredError,
	type Tool as McpTool,
	type McpTransport,
	type ReadResourceResult,
	type Resource,
	type ResourceTemplate,
	StdioTransport,
	StreamableHttpTransport,
} from "@earendil-works/pi-mcp";
import type { OAuthChallenge } from "@earendil-works/pi-mcp/oauth";
import { McpOAuthAuthorizationRequiredError } from "@earendil-works/pi-mcp/oauth";
import { VERSION } from "../../config.ts";
import { resolveConfigValueOrThrow, resolveHeadersOrThrow } from "../../core/resolve-config-value.ts";
import type { McpServerEntry } from "./config.ts";
import { createMcpAuthProvider, type McpOAuthCredentialStore, type McpOAuthSettings } from "./oauth.ts";
import type { McpResourceServer } from "./resources.ts";
import type { McpToolCaller } from "./tools.ts";

const DEFAULT_TIMEOUT_SECONDS = 60;
const RETRY_DELAYS = [250, 1_000];
export type McpTransportFactory = (entry: McpServerEntry, cwd: string, authProvider?: AuthProvider) => McpTransport;
type McpConnectionAuthProvider = AuthProvider & { settled?: () => Promise<void> };
export type McpServerState = "connecting" | "connected" | "disconnected" | "needs-auth" | "failed" | "closed";
const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));
function sleep(ms: number): Promise<void> {
	const { promise, resolve: finish } = Promise.withResolvers<void>();
	setTimeout(finish, ms);
	return promise;
}
function transient(error: unknown): boolean {
	return (
		error instanceof TypeError ||
		(error instanceof McpHttpError &&
			(error.status === 408 || error.status === 429 || (error.status >= 500 && error.status !== 501)))
	);
}
function expandHome(value: string): string {
	if (value === "~") return homedir();
	if (value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\")))
		return join(homedir(), value.slice(2));
	return value;
}
export function createDefaultTransport(entry: McpServerEntry, cwd: string, authProvider?: AuthProvider): McpTransport {
	if ("url" in entry.config)
		return new StreamableHttpTransport({
			url: entry.config.url,
			headers: resolveHeadersOrThrow(entry.config.headers, `MCP server "${entry.name}"`),
			authProvider,
		});
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(entry.config.env ?? {}))
		env[key] = resolveConfigValueOrThrow(value, `MCP server "${entry.name}" env "${key}"`);
	return new StdioTransport({
		command: expandHome(entry.config.command),
		args: entry.config.args?.map(expandHome),
		cwd: resolve(cwd, expandHome(entry.config.cwd ?? ".")),
		env,
		stderr: "pipe",
	});
}
async function optionalTemplates<T>(call: () => Promise<T>, empty: T): Promise<T> {
	try {
		return await call();
	} catch (error) {
		if (error instanceof McpError && error.code === JSON_RPC_ERROR_CODES.methodNotFound) return empty;
		throw error;
	}
}

/** One configured server connection. Calls lazily reconnect after disconnect; side-effecting tools are never retried. */
export class McpServerConnection implements McpToolCaller, McpResourceServer {
	readonly entry: McpServerEntry;
	state: McpServerState = "connecting";
	error: string | undefined;
	tools: McpTool[] = [];
	resources: Resource[] = [];
	resourceTemplates: ResourceTemplate[] = [];
	hasResources = false;
	instructions: string | undefined;
	private client: McpClient | undefined;
	private opening: Promise<McpClient> | undefined;
	private closed = false;
	private readonly cwd: string;
	private readonly transportFactory: McpTransportFactory;
	private readonly authProvider: McpConnectionAuthProvider | undefined;
	private challenge: OAuthChallenge | undefined;
	private readonly onChange: (connection: McpServerConnection) => void;
	private readonly onTools: (connection: McpServerConnection) => void;
	constructor(options: {
		entry: McpServerEntry;
		cwd: string;
		createTransport?: McpTransportFactory;
		providerToken?: (provider: string) => Promise<string | undefined>;
		onChange?: (connection: McpServerConnection) => void;
		onTools: (connection: McpServerConnection) => void;
		credentials?: McpOAuthCredentialStore;
		authProvider?: McpConnectionAuthProvider;
	}) {
		this.entry = options.entry;
		this.cwd = options.cwd;
		this.transportFactory = options.createTransport ?? createDefaultTransport;
		this.onChange = options.onChange ?? (() => {});
		this.onTools = options.onTools;
		const config = this.entry.config;
		const provider = "url" in config ? config.auth?.provider : undefined;
		const oauth =
			"url" in config &&
			!config.auth &&
			!Object.keys(config.headers ?? {}).some((header) => header.toLowerCase() === "authorization");
		this.authProvider =
			options.authProvider ??
			(oauth && "url" in config && options.credentials
				? createMcpAuthProvider({
						serverUrl: config.url,
						store: options.credentials.forServer(this.entry.name, config.url),
						settings: () => {
							const settings = config.oauth;
							return {
								...settings,
								clientSecret:
									settings?.clientSecret === undefined
										? undefined
										: resolveConfigValueOrThrow(
												settings.clientSecret,
												`MCP server "${this.entry.name}" oauth.clientSecret`,
											),
								authServerMetadataUrl: settings?.authServerMetadataUrl
									? new URL(settings.authServerMetadataUrl)
									: undefined,
							} satisfies McpOAuthSettings;
						},
						onChallenge: (challenge) => {
							this.challenge = challenge;
						},
					})
				: provider
					? { token: async () => options.providerToken?.(provider), settled: async () => {} }
					: undefined);
	}
	get name(): string {
		return this.entry.name;
	}
	get oauthUrl(): string | undefined {
		if (!("url" in this.entry.config) || this.entry.config.auth) return undefined;
		return Object.keys(this.entry.config.headers ?? {}).some((header) => header.toLowerCase() === "authorization")
			? undefined
			: this.entry.config.url;
	}
	get oauthSettings(): McpOAuthSettings {
		if (!("url" in this.entry.config)) return {};
		const oauth = this.entry.config.oauth;
		return {
			...oauth,
			clientSecret:
				oauth?.clientSecret === undefined
					? undefined
					: resolveConfigValueOrThrow(oauth.clientSecret, `MCP server "${this.name}" oauth.clientSecret`),
			authServerMetadataUrl: oauth?.authServerMetadataUrl ? new URL(oauth.authServerMetadataUrl) : undefined,
		};
	}
	get oauthChallenge(): OAuthChallenge | undefined {
		return this.challenge;
	}
	get timeoutMs(): number {
		return (this.entry.config.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
	}
	getClient(): Promise<McpClient> {
		if (this.closed) return Promise.reject(new Error(`MCP server "${this.name}" is shut down`));
		if (this.client?.connectionState === "connected") return Promise.resolve(this.client);
		this.opening ??= this.open().finally(() => {
			this.opening = undefined;
		});
		return this.opening;
	}
	async waitUntilReady(): Promise<void> {
		await this.getClient();
	}
	callTool(name: string, args: Record<string, unknown>, options: McpRequestOptions): Promise<CallToolResult> {
		return this.withClient((client) => client.callTool(name, args, options));
	}
	readResource(uri: string, options: McpRequestOptions): Promise<ReadResourceResult> {
		return this.withClient((client) => client.readResource(uri, options), true);
	}
	resourcesPage(cursor: string | undefined, options: McpRequestOptions): Promise<ListResourcesResult> {
		return this.withClient((client) => client.listResourcesPage(cursor, options), true);
	}
	resourceTemplatesPage(cursor: string | undefined, options: McpRequestOptions): Promise<ListResourceTemplatesResult> {
		return this.withClient(
			(client) =>
				optionalTemplates(() => client.listResourceTemplatesPage(cursor, options), { resourceTemplates: [] }),
			true,
		);
	}
	allResources(options: McpRequestOptions): Promise<Resource[]> {
		return this.withClient((client) => client.listResources(options), true);
	}
	allResourceTemplates(options: McpRequestOptions): Promise<ResourceTemplate[]> {
		return this.withClient((client) => optionalTemplates(() => client.listResourceTemplates(options), []), true);
	}
	private async withClient<T>(run: (client: McpClient) => Promise<T>, readOnly = false): Promise<T> {
		for (let attempt = 1; ; attempt++) {
			const client = await this.getClient();
			try {
				return await run(client);
			} catch (error) {
				if (error instanceof McpOAuthAuthorizationRequiredError) {
					this.markNeedsAuth();
					throw new Error(`MCP server "${this.name}" requires sign-in. Run /mcp login ${this.name}.`);
				}
				if (error instanceof McpSessionExpiredError && attempt === 1) {
					if (this.client === client) this.client = undefined;
					continue;
				}
				if (readOnly && attempt === 1 && transient(error)) {
					await sleep(RETRY_DELAYS[0]);
					continue;
				}
				throw error;
			}
		}
	}
	private markNeedsAuth(): void {
		this.state = "needs-auth";
		this.error = undefined;
		this.onChange(this);
	}
	async reconnect(): Promise<void> {
		await this.opening?.catch(() => undefined);
		if (this.client) await this.client.close().catch(() => undefined);
		this.client = undefined;
		await this.getClient();
	}
	async disconnect(): Promise<void> {
		await this.opening?.catch(() => undefined);
		const client = this.client;
		this.client = undefined;
		await client?.close().catch(() => undefined);
		if (!this.closed) {
			this.state = "disconnected";
			this.onChange(this);
		}
	}
	async close(): Promise<void> {
		this.closed = true;
		this.state = "closed";
		const client = this.client;
		this.client = undefined;
		await client?.close().catch(() => undefined);
		await this.authProvider?.settled?.();
		this.onChange(this);
	}
	private async open(): Promise<McpClient> {
		this.state = "connecting";
		this.error = undefined;
		this.onChange(this);
		for (let attempt = 0; ; attempt++) {
			try {
				return await this.connectOnce();
			} catch (error) {
				if (error instanceof McpOAuthAuthorizationRequiredError) {
					this.markNeedsAuth();
					throw new Error(`MCP server "${this.name}" requires sign-in. Run /mcp login ${this.name}.`);
				}
				const delay = "url" in this.entry.config ? RETRY_DELAYS[attempt] : undefined;
				if (this.closed || delay === undefined || !transient(error)) {
					this.state = this.closed ? "closed" : "failed";
					this.error = errorMessage(error);
					this.onChange(this);
					throw new Error(`MCP server "${this.name}" failed to connect: ${this.error}`);
				}
				await sleep(delay);
			}
		}
	}
	private async connectOnce(): Promise<McpClient> {
		const client = new McpClient({
			name: "pi",
			version: VERSION,
			requestTimeoutMs: this.timeoutMs,
			roots: [{ uri: pathToFileURL(this.cwd).href, name: basename(this.cwd) }],
		});
		let transport: McpTransport | undefined;
		try {
			transport = this.transportFactory(this.entry, this.cwd, this.authProvider);
			await client.connect(transport);
			client.onNotification("notifications/tools/list_changed", () => {
				void this.refreshTools(client);
			});
			client.onNotification("notifications/resources/list_changed", () => {
				void this.refreshResources(client);
			});
			client.onClose(() => {
				if (this.client !== client || this.closed) return;
				this.client = undefined;
				this.state = "disconnected";
				this.error = "Connection closed";
				this.onChange(this);
			});
			const hasResources = client.serverCapabilities?.resources !== undefined;
			const [tools, resources, templates] = await Promise.all([
				client.serverCapabilities?.tools ? client.listTools() : Promise.resolve([]),
				hasResources ? client.listResources().catch(() => []) : Promise.resolve([]),
				hasResources
					? optionalTemplates(() => client.listResourceTemplates(), []).catch(() => [])
					: Promise.resolve([]),
			]);
			if (this.closed || client.connectionState !== "connected") throw new Error("connection closed during setup");
			this.client = client;
			this.tools = tools;
			this.resources = resources;
			this.resourceTemplates = templates;
			this.hasResources = hasResources;
			this.instructions = client.instructions?.trim() || undefined;
			this.state = "connected";
			this.onTools(this);
			this.onChange(this);
			return client;
		} catch (error) {
			await client.close().catch(() => undefined);
			if (transport instanceof StdioTransport && transport.stderr.trim())
				this.error = transport.stderr.trim().slice(-2000);
			throw error;
		}
	}
	private async refreshTools(client: McpClient): Promise<void> {
		try {
			const tools = await client.listTools();
			if (this.client !== client || this.closed) return;
			this.tools = tools;
			this.onTools(this);
		} catch (error) {
			this.error = `Failed to refresh tools: ${errorMessage(error)}`;
		}
		this.onChange(this);
	}
	private async refreshResources(client: McpClient): Promise<void> {
		const [resources, templates] = await Promise.all([
			client.listResources().catch(() => []),
			optionalTemplates(() => client.listResourceTemplates(), []).catch(() => []),
		]);
		if (this.client !== client || this.closed) return;
		this.resources = resources;
		this.resourceTemplates = templates;
		this.onTools(this);
		this.onChange(this);
	}
}
