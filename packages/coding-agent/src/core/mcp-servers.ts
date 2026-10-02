/** MCP server configuration and extension-owned registrations. */

export type McpExposure = "codemode" | "deferred" | "direct" | "hidden";
export type MCPExposure = McpExposure;
const EXPOSURES: Record<string, true> = { codemode: true, deferred: true, direct: true, hidden: true };
const ALIASES: Readonly<Record<string, McpExposure>> = { "codemode-deferred": "codemode" };
const SERVER_NAME = /^[A-Za-z0-9_-]+$/;
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

export interface McpOAuthConfig {
	clientId?: string;
	clientSecret?: string;
	callbackPort?: number;
	callbackUrl?: string;
	scope?: string;
	clientName?: string;
	clientRegistration?: "dcr" | "cimd";
	authServerMetadataUrl?: string;
}

interface McpServerConfigBase {
	exposure?: McpExposure;
	description?: string;
	toolExposure?: Record<string, McpExposure>;
	enabled?: boolean;
	timeout?: number;
}
export interface McpStdioServerConfig extends McpServerConfigBase {
	type?: "stdio";
	command: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
}
export interface McpHttpServerConfig extends McpServerConfigBase {
	type?: "http";
	url: string;
	headers?: Record<string, string>;
	oauth?: McpOAuthConfig;
	auth?: { provider: string };
}
export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

export function mcpNamespace(server: string): string {
	return `mcp__${server.replace(/-/g, "_")}`;
}

export function isLoopbackRedirectUri(value: string): boolean {
	if (!URL.canParse(value)) return false;
	const url = new URL(value);
	return url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname) && !url.search && !url.hash;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isStringRecord(value: unknown): value is Record<string, string> {
	return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}
function resolveAlias(value: unknown): unknown {
	return typeof value === "string" ? (ALIASES[value] ?? value) : value;
}
function validateOAuth(value: unknown): string | undefined {
	if (value === undefined) return;
	if (!isRecord(value)) return "oauth must be an object";
	if (value.clientId !== undefined && typeof value.clientId !== "string") return "oauth.clientId must be a string";
	if (value.clientSecret !== undefined && typeof value.clientSecret !== "string")
		return "oauth.clientSecret must be a string";
	const port = value.callbackPort;
	if (port !== undefined && (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535))
		return "oauth.callbackPort must be a port number";
	if (value.callbackUrl !== undefined) {
		if (typeof value.callbackUrl !== "string" || !isLoopbackRedirectUri(value.callbackUrl))
			return "oauth.callbackUrl must be an http URI on localhost, 127.0.0.1, or [::1] without query or fragment";
		const urlPort = new URL(value.callbackUrl).port;
		if (urlPort && port !== undefined && Number(urlPort) !== port)
			return "oauth.callbackUrl and oauth.callbackPort name different ports";
	}
	if (value.scope !== undefined && typeof value.scope !== "string") return "oauth.scope must be a string";
	if (value.clientName !== undefined && (typeof value.clientName !== "string" || !value.clientName.trim()))
		return "oauth.clientName must be a non-empty string";
	if (
		value.clientRegistration !== undefined &&
		value.clientRegistration !== "dcr" &&
		value.clientRegistration !== "cimd"
	)
		return 'oauth.clientRegistration must be "dcr" or "cimd"';
	if (value.clientRegistration === "cimd") {
		if (value.clientId !== undefined || value.clientName !== undefined)
			return 'oauth.clientRegistration "cimd" cannot be combined with oauth.clientId or oauth.clientName';
		if (typeof value.callbackUrl === "string") {
			const callback = new URL(value.callbackUrl);
			if (callback.hostname === "[::1]" || callback.pathname !== "/callback")
				return 'oauth.clientRegistration "cimd" requires oauth.callbackUrl on localhost or 127.0.0.1 with path /callback';
		}
	}
	if (value.authServerMetadataUrl !== undefined) {
		const url =
			typeof value.authServerMetadataUrl === "string" && URL.canParse(value.authServerMetadataUrl)
				? new URL(value.authServerMetadataUrl)
				: undefined;
		if (!url || !(url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname))))
			return "oauth.authServerMetadataUrl must be an https URL, or http on localhost, 127.0.0.1, or [::1]";
	}
}

function toolPatternRegExp(pattern: string): RegExp {
	return new RegExp(
		`^${pattern
			.split("*")
			.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
			.join(".*")}$`,
	);
}

export function getMcpToolExposure(config: McpServerConfig, toolName: string): McpExposure {
	const overrides = config.toolExposure ?? {};
	if (overrides[toolName] !== undefined) return overrides[toolName];
	for (const [pattern, exposure] of Object.entries(overrides)) {
		if (pattern.includes("*") && toolPatternRegExp(pattern).test(toolName)) return exposure;
	}
	return config.exposure ?? "codemode";
}

/** Validate one mcpServers entry, returning a canonical copy or a diagnostic string. */
export function validateMcpServerConfig(name: string, raw: unknown): McpServerConfig | string {
	if (!SERVER_NAME.test(name)) return `invalid server name "${name}" (use letters, digits, "_" and "-")`;
	if (!isRecord(raw)) return `server "${name}" must be an object`;
	const value: Record<string, unknown> = { ...raw };
	if (value.exposure !== undefined) value.exposure = resolveAlias(value.exposure);
	if (isRecord(value.toolExposure))
		value.toolExposure = Object.fromEntries(
			Object.entries(value.toolExposure).map(([tool, exposure]) => [tool, resolveAlias(exposure)]),
		);
	const { type, exposure, enabled, timeout, toolExposure, description } = value;
	const choices = Object.keys(EXPOSURES)
		.map((entry) => `"${entry}"`)
		.join(", ");
	if (exposure !== undefined && (typeof exposure !== "string" || EXPOSURES[exposure] !== true))
		return `server "${name}": exposure must be one of ${choices}`;
	if (toolExposure !== undefined) {
		if (!isRecord(toolExposure)) return `server "${name}": toolExposure must map tool names to exposures`;
		for (const [tool, candidate] of Object.entries(toolExposure))
			if (typeof candidate !== "string" || EXPOSURES[candidate] !== true)
				return `server "${name}": toolExposure "${tool}" must be one of ${choices}`;
	}
	if (enabled !== undefined && typeof enabled !== "boolean") return `server "${name}": enabled must be a boolean`;
	if (description !== undefined && typeof description !== "string")
		return `server "${name}": description must be a string`;
	if (timeout !== undefined && (typeof timeout !== "number" || !(timeout > 0)))
		return `server "${name}": timeout must be a positive number of seconds`;
	if (type === "sse") return `server "${name}": legacy SSE transport is not supported; use the streamable HTTP URL`;
	if (typeof value.url === "string" && (type === undefined || type === "http" || type === "streamable-http")) {
		if (!URL.canParse(value.url) || !/^https?:$/.test(new URL(value.url).protocol))
			return `server "${name}": url must be an http or https URL`;
		if (value.headers !== undefined && !isStringRecord(value.headers))
			return `server "${name}": headers must map names to strings`;
		const oauthError = validateOAuth(value.oauth);
		if (oauthError) return `server "${name}": ${oauthError}`;
		if (value.auth !== undefined) {
			if (!isRecord(value.auth) || typeof value.auth.provider !== "string" || !value.auth.provider)
				return `server "${name}": auth.provider must be a provider name`;
			const url = new URL(value.url);
			if (url.protocol !== "https:" && !LOOPBACK_HOSTS.includes(url.hostname))
				return `server "${name}": auth requires an https URL, or http on localhost, 127.0.0.1, or [::1]`;
		}
		return value as unknown as McpHttpServerConfig;
	}
	if (typeof value.command === "string" && (type === undefined || type === "stdio")) {
		if (
			value.args !== undefined &&
			!(Array.isArray(value.args) && value.args.every((arg) => typeof arg === "string"))
		)
			return `server "${name}": args must be an array of strings`;
		if (value.env !== undefined && !isStringRecord(value.env))
			return `server "${name}": env must map names to strings`;
		if (value.cwd !== undefined && typeof value.cwd !== "string") return `server "${name}": cwd must be a string`;
		return value as unknown as McpStdioServerConfig;
	}
	return `server "${name}" needs either "command" (stdio) or "url" (streamable HTTP)`;
}

export interface RegisteredMcpServer {
	name: string;
	config: McpServerConfig;
	extensionPath: string;
}

/** Registrations owned by one extension runtime. */
export class McpServerRegistry {
	private readonly servers = new Map<string, RegisteredMcpServer>();
	private changeListener: (() => void) | undefined;
	register(server: RegisteredMcpServer): void {
		this.servers.set(server.name, { ...server, config: structuredClone(server.config) });
		this.changeListener?.();
	}
	unregister(name: string, extensionPath: string): void {
		if (this.servers.get(name)?.extensionPath !== extensionPath) return;
		this.servers.delete(name);
		this.changeListener?.();
	}
	get(name: string): RegisteredMcpServer | undefined {
		const server = this.servers.get(name);
		return server ? { ...server, config: structuredClone(server.config) } : undefined;
	}
	list(): RegisteredMcpServer[] {
		return [...this.servers.values()].map((server) => ({ ...server, config: structuredClone(server.config) }));
	}
	setChangeListener(listener: (() => void) | undefined): void {
		this.changeListener = listener;
	}
}
