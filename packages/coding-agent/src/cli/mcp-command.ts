import { resolve } from "node:path";
import { ENV_SETTINGS_FILE, getAgentDir, getProjectConfigDirFor } from "../config.ts";
import type { McpServerConfig } from "../core/mcp-servers.ts";
import { resolveConfigValueOrThrow } from "../core/resolve-config-value.ts";
import { loadMcpConfig } from "../extensions/mcp/config.ts";
import {
	McpOAuthCredentialStore,
	type McpOAuthSettings,
	McpSignInCancelledError,
	type McpSignInPrompt,
	signInMcpServer,
} from "../extensions/mcp/oauth.ts";

export type McpCommandAction = "help" | "list" | "login" | "logout";
export interface McpCommand {
	action: McpCommandAction;
	server?: string;
	json: boolean;
}
export class McpCommandError extends Error {}
const USAGE = "Usage: pi mcp list [--json] | pi mcp login <server> | pi mcp logout <server>";

/** Returns undefined for non-mcp invocations; malformed mcp invocations throw a usage error. */
export function parseMcpCommand(args: string[]): McpCommand | undefined {
	if (args[0] !== "mcp") return undefined;
	const rest = args.slice(1);
	if (rest.length === 0 || rest[0] === "help" || rest.includes("--help") || rest.includes("-h"))
		return { action: "help", json: false };
	const [action, server, ...extra] = rest;
	if (action === "list") {
		if (extra.some((arg) => arg !== "--json") || (server !== undefined && server !== "--json"))
			throw new McpCommandError(USAGE);
		return { action, json: server === "--json" || extra.includes("--json") };
	}
	if (action !== "login" && action !== "logout") throw new McpCommandError(USAGE);
	if (!server || server.startsWith("-") || extra.length > 0) throw new McpCommandError(USAGE);
	return { action, server, json: false };
}
export function printMcpCommandHelp(): void {
	console.log(USAGE);
}

export interface RunMcpCommandOptions {
	agentDir?: string;
	configDir?: string;
	cwd: string;
	projectTrusted: boolean;
	globalConfigPath?: string;
	projectConfigPath?: string;
	settingsFile?: string;
	prompt?: McpSignInPrompt;
	write?: (text: string) => void;
}
function oauthSettings(config: Extract<McpServerConfig, { url: string }>): McpOAuthSettings {
	const oauth = config.oauth;
	return {
		...oauth,
		clientSecret:
			oauth?.clientSecret === undefined
				? undefined
				: resolveConfigValueOrThrow(oauth.clientSecret, "MCP oauth.clientSecret"),
		authServerMetadataUrl: oauth?.authServerMetadataUrl ? new URL(oauth.authServerMetadataUrl) : undefined,
	};
}

/** Executes MCP list/login/logout from explicit session paths, with an injectable OAuth prompt. */
export async function runMcpCommand(command: McpCommand, options: RunMcpCommandOptions): Promise<void> {
	const write = options.write ?? console.log;
	if (command.action === "help") {
		write(USAGE);
		return;
	}
	const agentDir = options.agentDir ?? getAgentDir();
	const settingsFile = options.settingsFile ?? process.env[ENV_SETTINGS_FILE];
	const config = loadMcpConfig({
		agentDir,
		cwd: options.cwd,
		projectTrusted: options.projectTrusted,
		globalConfigPath: options.globalConfigPath,
		projectConfigPath:
			options.projectConfigPath ?? getProjectConfigDirFor(options.cwd, options.configDir, "mcp.json"),
		settingsFile: settingsFile ? resolve(options.cwd, settingsFile) : undefined,
	});
	const credentials = new McpOAuthCredentialStore(agentDir);
	if (command.action === "list") {
		const rows = config.servers.map(({ name, config: server }) => ({
			name,
			type: "url" in server ? "http" : "stdio",
			endpoint: "url" in server ? server.url : [server.command, ...(server.args ?? [])].join(" "),
			enabled: server.enabled !== false,
			exposure: server.exposure ?? "codemode",
		}));
		write(
			command.json
				? JSON.stringify({ servers: rows, errors: config.errors }, null, 2)
				: [
						...rows.map(
							(row) => `${row.name}: ${row.enabled ? row.type : "disabled"} · ${row.exposure} · ${row.endpoint}`,
						),
						...config.errors.map((error) => `error: ${error}`),
					].join("\n"),
		);
		return;
	}
	const server = config.servers.find((entry) => entry.name === command.server);
	if (!server) throw new McpCommandError(`MCP server "${command.server}" is not configured`);
	if (
		!("url" in server.config) ||
		server.config.auth ||
		Object.keys(server.config.headers ?? {}).some((header) => header.toLowerCase() === "authorization")
	) {
		throw new McpCommandError(`MCP server "${server.name}" does not use OAuth`);
	}
	const url = server.config.url;
	if (command.action === "logout") {
		write(
			credentials.remove(server.name, url)
				? `Signed out from ${server.name}.`
				: `No credentials stored for ${server.name}.`,
		);
		return;
	}
	if (!options.prompt) throw new McpCommandError("MCP login requires an interactive sign-in prompt");
	try {
		await signInMcpServer({
			serverUrl: url,
			store: credentials.forServer(server.name, url),
			settings: oauthSettings(server.config),
			prompt: options.prompt,
		});
		write(`Signed in to ${server.name}.`);
	} catch (error) {
		if (error instanceof McpSignInCancelledError) throw error;
		throw new McpCommandError(error instanceof Error ? error.message : String(error));
	}
}
