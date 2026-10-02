import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	type McpExposure,
	type McpServerConfig,
	mcpNamespace,
	validateMcpServerConfig,
} from "../../core/mcp-servers.ts";

export type {
	McpExposure,
	McpHttpServerConfig,
	McpOAuthConfig,
	McpServerConfig,
	McpStdioServerConfig,
} from "../../core/mcp-servers.ts";
export { getMcpToolExposure } from "../../core/mcp-servers.ts";
export interface McpServerEntry {
	name: string;
	config: McpServerConfig;
	source: string;
	scope?: "global" | "project" | "settings" | "extension";
	override?: string;
}
export interface LoadedMcpConfig {
	servers: McpServerEntry[];
	autoEnableCodemode?: boolean;
	errors: string[];
	projectConfig?: string;
}
const OVERRIDE_KEYS = ["enabled", "exposure", "toolExposure"] as const;
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isOverride(value: Record<string, unknown>): boolean {
	return value.command === undefined && value.url === undefined && value.type === undefined;
}
interface State {
	servers: Map<string, McpServerEntry>;
	autoEnableCodemode?: boolean;
	errors: string[];
}
function readConfigFile(path: string, scope: "global" | "project" | "settings", state: State): void {
	if (!existsSync(path)) return;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		state.errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}
	if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) {
		state.errors.push(`${path}: expected an object with an "mcpServers" object`);
		return;
	}
	if (typeof parsed.autoEnableCodemode === "boolean") state.autoEnableCodemode = parsed.autoEnableCodemode;
	else if (parsed.autoEnableCodemode !== undefined) state.errors.push(`${path}: autoEnableCodemode must be a boolean`);
	for (const [name, raw] of Object.entries(parsed.mcpServers ?? {})) {
		if (scope === "project" && isRecord(raw) && isOverride(raw)) {
			const base = state.servers.get(name);
			const extra = Object.keys(raw).filter((key) => !(OVERRIDE_KEYS as readonly string[]).includes(key));
			if (!base)
				state.errors.push(`${path}: server "${name}" needs "command" or "url", or a global server to override`);
			else if (extra.length)
				state.errors.push(`${path}: server "${name}": an override can only set ${OVERRIDE_KEYS.join(", ")}`);
			else {
				const config = validateMcpServerConfig(name, { ...base.config, ...raw });
				if (typeof config === "string") state.errors.push(`${path}: ${config}`);
				else state.servers.set(name, { ...base, config, override: path });
			}
			continue;
		}
		const config = validateMcpServerConfig(name, raw);
		if (typeof config === "string") {
			state.errors.push(`${path}: ${config}`);
			continue;
		}
		const clash = [...state.servers.keys()].find(
			(other) => other !== name && mcpNamespace(other) === mcpNamespace(name),
		);
		if (clash) {
			state.errors.push(`${path}: server "${name}" conflicts with "${clash}"`);
			continue;
		}
		if (scope === "project" && "url" in config && config.auth) {
			state.errors.push(`${path}: server "${name}": auth is only allowed in the global mcp.json`);
			continue;
		}
		state.servers.set(name, { name, config, source: path, scope });
	}
}

/** Paths are resolved by the session host only after project trust approval. Later sources win. */
export function loadMcpConfig(options: {
	agentDir: string;
	cwd: string;
	projectTrusted: boolean;
	globalConfigPath?: string;
	projectConfigPath?: string;
	settingsFile?: string;
}): LoadedMcpConfig {
	const state: State = { servers: new Map(), errors: [] };
	readConfigFile(options.globalConfigPath ?? join(options.agentDir, "mcp.json"), "global", state);
	const projectConfig = options.projectTrusted
		? (options.projectConfigPath ?? join(options.cwd, ".pi", "mcp.json"))
		: undefined;
	if (projectConfig) readConfigFile(projectConfig, "project", state);
	if (options.settingsFile) readConfigFile(options.settingsFile, "settings", state);
	return {
		servers: [...state.servers.values()],
		...(state.autoEnableCodemode === undefined ? {} : { autoEnableCodemode: state.autoEnableCodemode }),
		errors: state.errors,
		...(projectConfig ? { projectConfig } : {}),
	};
}

export interface McpServerConfigPatch {
	enabled?: boolean;
	exposure?: McpExposure;
}
export function updateMcpServerConfig(
	path: string,
	name: string,
	patch: McpServerConfigPatch,
	options: { override?: boolean } = {},
): void {
	editMcpServers(path, (servers, parsed) => {
		let server = servers?.[name];
		if (server === undefined && options.override) {
			server = {};
			parsed.mcpServers = { ...servers, [name]: server };
		}
		if (!isRecord(server)) throw new Error(`${path} does not define MCP server "${name}"`);
		const keepDefaults = isOverride(server);
		if (patch.enabled !== undefined) {
			if (patch.enabled && !keepDefaults) delete server.enabled;
			else server.enabled = patch.enabled;
		}
		if (patch.exposure !== undefined) {
			if (patch.exposure === "codemode" && !keepDefaults) delete server.exposure;
			else server.exposure = patch.exposure;
		}
		return true;
	});
}
export function addMcpServerConfig(path: string, name: string, config: McpServerConfig): boolean {
	let replaced = false;
	editMcpServers(path, (servers, parsed) => {
		const target = servers ?? {};
		replaced = target[name] !== undefined;
		target[name] = config;
		parsed.mcpServers = target;
		return true;
	});
	return replaced;
}
export function removeMcpServerConfig(path: string, name: string): boolean {
	if (!existsSync(path)) return false;
	let removed = false;
	editMcpServers(path, (servers) => {
		if (!servers || servers[name] === undefined) return false;
		delete servers[name];
		removed = true;
		return true;
	});
	return removed;
}
function editMcpServers(
	path: string,
	edit: (servers: Record<string, unknown> | undefined, parsed: Record<string, unknown>) => boolean,
): void {
	const text = existsSync(path) ? readFileSync(path, "utf8") : undefined;
	const parsed: unknown = text === undefined ? {} : JSON.parse(text);
	if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers)))
		throw new Error(`${path}: expected an object with an "mcpServers" object`);
	const servers = isRecord(parsed.mcpServers) ? parsed.mcpServers : undefined;
	if (!edit(servers, parsed)) return;
	const indent = (text && /^([ \t]+)\S/m.exec(text)?.[1]) || "  ";
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(parsed, null, indent)}\n`);
}
