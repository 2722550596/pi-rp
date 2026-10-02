import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type JsonRpcMessage,
	LATEST_PROTOCOL_VERSION,
	type McpTransport,
	type McpTransportCloseListener,
	type McpTransportErrorListener,
	type McpTransportMessageListener,
} from "@earendil-works/pi-mcp";
import { afterEach, describe, expect, it } from "vitest";
import { parseMcpCommand } from "../../../src/cli/mcp-command.ts";
import type { AuthStorageBackend } from "../../../src/core/auth-storage.ts";
import type { ExtensionAPI, ExtensionContext } from "../../../src/core/extensions/types.ts";
import { getMcpToolExposure, McpServerRegistry, validateMcpServerConfig } from "../../../src/core/mcp-servers.ts";
import { loadMcpConfig } from "../../../src/extensions/mcp/config.ts";
import { createMcpExtension } from "../../../src/extensions/mcp/index.ts";
import { McpOAuthCredentialStore } from "../../../src/extensions/mcp/oauth.ts";
import { createMcpResourceToolDefinitions, type McpResourceServer } from "../../../src/extensions/mcp/resources.ts";
import { McpServerConnection } from "../../../src/extensions/mcp/runtime.ts";
import { convertMcpResult, createMcpToolDefinition } from "../../../src/extensions/mcp/tools.ts";

const directories: string[] = [];
function tempDir(): string {
	const path = mkdtempSync(join(tmpdir(), "pi-mcp-host-test-"));
	directories.push(path);
	return path;
}
afterEach(() => {
	for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

class MemoryAuthBackend implements AuthStorageBackend {
	value: string | undefined;
	withLock<T>(fn: (current: string | undefined) => { result: T; next?: string }): T {
		const result = fn(this.value);
		if (result.next !== undefined) this.value = result.next;
		return result.result;
	}
	async withLockAsync<T>(fn: (current: string | undefined) => Promise<{ result: T; next?: string }>): Promise<T> {
		const result = await fn(this.value);
		if (result.next !== undefined) this.value = result.next;
		return result.result;
	}
}

class FakeTransport implements McpTransport {
	private readonly messages = new Set<McpTransportMessageListener>();
	private readonly closes = new Set<McpTransportCloseListener>();
	private readonly errors = new Set<McpTransportErrorListener>();
	closed = false;
	readonly methods: string[] = [];
	async start(): Promise<void> {}
	async send(message: JsonRpcMessage): Promise<void> {
		this.methods.push("method" in message ? message.method : "");
		if (!("id" in message) || !("method" in message) || message.method === "tools/call") return;
		const result =
			message.method === "initialize"
				? {
						protocolVersion: LATEST_PROTOCOL_VERSION,
						capabilities: { tools: {}, resources: {} },
						serverInfo: { name: "fake", version: "1" },
					}
				: message.method === "tools/list"
					? { tools: [{ name: "search", inputSchema: { type: "object", properties: {} } }] }
					: message.method === "resources/list"
						? { resources: [] }
						: message.method === "resources/templates/list"
							? { resourceTemplates: [] }
							: {};
		queueMicrotask(() => {
			for (const listener of this.messages) listener({ jsonrpc: "2.0", id: message.id, result } as JsonRpcMessage);
		});
	}
	async close(): Promise<void> {
		this.drop();
	}
	onMessage(listener: McpTransportMessageListener) {
		this.messages.add(listener);
		return () => this.messages.delete(listener);
	}
	onError(listener: McpTransportErrorListener) {
		this.errors.add(listener);
		return () => this.errors.delete(listener);
	}
	onClose(listener: McpTransportCloseListener) {
		this.closes.add(listener);
		return () => this.closes.delete(listener);
	}
	drop(): void {
		if (this.closed) return;
		this.closed = true;
		for (const listener of this.closes) listener();
	}
	notify(method: string): void {
		for (const listener of this.messages) listener({ jsonrpc: "2.0", method } as JsonRpcMessage);
	}
}

describe("MCP host config and registry contracts", () => {
	it("validates modern transports, aliases, OAuth callbacks, and exposure precedence", () => {
		const valid = validateMcpServerConfig("docs", {
			url: "https://example.test/mcp",
			exposure: "hidden",
			toolExposure: { lookup_exact: "direct", "lookup_*": "deferred" },
			oauth: { callbackUrl: "http://localhost:4321/callback" },
		});
		expect(typeof valid).not.toBe("string");
		if (typeof valid === "string" || !("url" in valid)) throw new Error("test fixture was rejected");
		expect(getMcpToolExposure(valid, "lookup_exact")).toBe("direct");
		expect(getMcpToolExposure(valid, "lookup_more")).toBe("deferred");
		expect(getMcpToolExposure(valid, "other")).toBe("hidden");
		expect(validateMcpServerConfig("legacy", { command: "node", exposure: "codemode-deferred" })).toMatchObject({
			exposure: "codemode",
		});
		expect(validateMcpServerConfig("legacy", { type: "sse", url: "https://example.test" })).toContain("legacy SSE");
		expect(validateMcpServerConfig("bad", { url: "ftp://example.test" })).toContain("http or https");
		expect(
			validateMcpServerConfig("bad", {
				url: "https://example.test",
				oauth: { callbackUrl: "https://example.test/callback" },
			}),
		).toContain("callbackUrl");
	});
	it("isolates extension ownership, defensive copies, and change notifications", () => {
		const registry = new McpServerRegistry();
		let changes = 0;
		registry.setChangeListener(() => changes++);
		registry.register({ name: "docs", config: { command: "node", args: ["server.js"] }, extensionPath: "/ext/a" });
		const copy = registry.get("docs");
		if (copy && "command" in copy.config) copy.config.args?.push("mutated");
		expect(registry.list()[0].config).toMatchObject({ command: "node", args: ["server.js"] });
		registry.unregister("docs", "/ext/b");
		expect(registry.get("docs")).toBeDefined();
		expect(registry.list()).toMatchObject([
			{ name: "docs", extensionPath: "/ext/a", config: { command: "node", args: ["server.js"] } },
		]);
		expect(changes).toBe(1);
	});
	it("merges global, trusted project overrides, and process settings while preserving global secrets", () => {
		const root = tempDir();
		const agentDir = join(root, "agent");
		const project = join(root, "project");
		mkdirSync(agentDir);
		mkdirSync(join(project, ".pi"), { recursive: true });
		const global = join(agentDir, "mcp.json");
		const projectConfig = join(project, ".pi", "mcp.json");
		const settings = join(root, "settings.json");
		writeFileSync(
			global,
			JSON.stringify({
				mcpServers: {
					docs: { url: "https://docs.test/mcp", headers: { Authorization: "Bearer secret" }, enabled: true },
				},
			}),
		);
		writeFileSync(
			projectConfig,
			JSON.stringify({
				mcpServers: {
					docs: { enabled: false, exposure: "hidden" },
					local: { command: "node", args: ["local.js"] },
				},
			}),
		);
		writeFileSync(
			settings,
			JSON.stringify({ mcpServers: { local: { command: "node", args: ["settings.js"], enabled: false } } }),
		);
		const loaded = loadMcpConfig({
			agentDir,
			cwd: project,
			projectTrusted: true,
			projectConfigPath: projectConfig,
			settingsFile: settings,
		});
		expect(loaded.servers.find((entry) => entry.name === "docs")).toMatchObject({
			config: {
				url: "https://docs.test/mcp",
				headers: { Authorization: "Bearer secret" },
				enabled: false,
				exposure: "hidden",
			},
			override: projectConfig,
		});
		expect(loaded.servers.find((entry) => entry.name === "local")?.config).toMatchObject({
			command: "node",
			args: ["settings.js"],
			enabled: false,
		});
		const untrusted = loadMcpConfig({
			agentDir,
			cwd: project,
			projectTrusted: false,
			projectConfigPath: projectConfig,
		});
		expect(untrusted.servers.map((entry) => entry.name)).toEqual(["docs"]);
	});
	it("parses isolated top-level MCP command forms", () => {
		expect(parseMcpCommand(["run", "--help"])).toBeUndefined();
		expect(parseMcpCommand(["mcp", "list", "--json"])).toEqual({ action: "list", json: true });
		expect(parseMcpCommand(["mcp", "login", "docs"])).toEqual({ action: "login", server: "docs", json: false });
		expect(() => parseMcpCommand(["mcp", "login"])).toThrow("Usage:");
		expect(() => parseMcpCommand(["mcp", "list", "--unexpected"])).toThrow("Usage:");
	});
});

describe("MCP tool and resource adapters", () => {
	it("keeps tool provenance and structured errors in model results", async () => {
		const raw = {
			content: [{ type: "text" as const, text: "remote output" }],
			structuredContent: { source: "docs" },
			isError: true,
		};
		const converted = await convertMcpResult("docs", "lookup", raw);
		expect(converted.details).toMatchObject({ server: "docs", tool: "lookup" });
		expect(converted.isError).toBe(true);
		expect(converted.structuredContent).toMatchObject({ structuredContent: { source: "docs" }, isError: true });
		const definition = createMcpToolDefinition({
			server: "docs",
			tool: { name: "lookup", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
			name: "mcp__docs__lookup",
			exposure: "direct",
			timeoutMs: 500,
			getClient: async () => ({ callTool: async () => raw }),
		});
		expect(definition.exposure).toBe("direct");
		expect(definition.annotations).toEqual({ readOnlyHint: true });
		const result = await definition.execute("call", {}, undefined, undefined, {} as never);
		expect(result.details).toMatchObject({ server: "docs", tool: "lookup" });
	});
	it("attributes resources to their origin and excludes UI resources", async () => {
		const server = {
			name: "docs",
			timeoutMs: 1000,
			resourcesPage: async () => ({
				resources: [
					{ uri: "file:///docs", name: "docs" },
					{ uri: "ui://app", name: "app" },
				],
			}),
			resourceTemplatesPage: async () => ({ resourceTemplates: [] }),
			allResources: async () => [
				{ uri: "file:///docs", name: "docs" },
				{ uri: "ui://app", name: "app" },
			],
			allResourceTemplates: async () => [],
			readResource: async (uri: string) => ({ contents: [{ uri, text: "resource text" }] }),
		} as unknown as McpResourceServer;
		const [list, , read] = createMcpResourceToolDefinitions({ exposure: "direct", servers: () => [server] });
		const listing = await list.execute("list", {}, undefined, undefined, {} as never);
		expect(listing.structuredContent).toMatchObject({ resources: [{ server: "docs", uri: "file:///docs" }] });
		const result = await read.execute(
			"read",
			{ server: "docs", uri: "file:///docs" },
			undefined,
			undefined,
			{} as never,
		);
		expect(result.structuredContent).toMatchObject({
			server: "docs",
			uri: "file:///docs",
			contents: [{ text: "resource text" }],
		});
	});
});

describe("MCP OAuth credential boundaries", () => {
	it("isolates credentials by server name and URL and serializes refresh work", async () => {
		const backend = new MemoryAuthBackend();
		const credentials = new McpOAuthCredentialStore("unused-agent-dir", backend);
		const first = credentials.forServer("docs", "https://example.test/mcp");
		const same = credentials.forServer("docs", "https://example.test/mcp");
		const otherName = credentials.forServer("other", "https://example.test/mcp");
		const otherUrl = credentials.forServer("docs", "https://other.test/mcp");
		await first.save({
			serverUrl: "https://example.test/mcp",
			tokens: { access_token: "one", token_type: "Bearer" },
		});
		expect((await same.load())?.tokens?.access_token).toBe("one");
		expect(await otherName.load()).toBeUndefined();
		expect(await otherUrl.load()).toBeUndefined();
		let active = 0;
		let maximum = 0;
		await Promise.all([
			same.withRefreshLock(async () => {
				active++;
				maximum = Math.max(maximum, active);
				await Promise.resolve();
				active--;
			}),
			first.withRefreshLock(async () => {
				active++;
				maximum = Math.max(maximum, active);
				active--;
			}),
		]);
		expect(maximum).toBe(1);
		expect(credentials.remove("docs", "https://example.test/mcp")).toBe(true);
		expect(await same.load()).toBeUndefined();
	});
});

describe("MCP connection lifecycle", () => {
	it("connects, refreshes tools, reconnects after disconnect, and cancels calls", async () => {
		const transports: FakeTransport[] = [];
		let toolChanges = 0;
		let refreshed = Promise.withResolvers<void>();
		const entry = {
			name: "docs",
			source: "test",
			config: { type: "http" as const, url: "https://example.test/mcp" },
		};
		const connection = new McpServerConnection({
			entry,
			cwd: "/tmp",
			createTransport: () => {
				const transport = new FakeTransport();
				transports.push(transport);
				return transport;
			},
			onTools: () => {
				toolChanges++;
				refreshed.resolve();
			},
		});
		await connection.getClient();
		expect(connection.state).toBe("connected");
		expect(connection.tools.map((tool) => tool.name)).toEqual(["search"]);
		const initialChanges = toolChanges;
		refreshed = Promise.withResolvers<void>();
		transports[0].notify("notifications/tools/list_changed");
		await refreshed.promise;
		expect(toolChanges).toBeGreaterThan(initialChanges);
		transports[0].drop();
		expect(connection.state).toBe("disconnected");
		await connection.getClient();
		expect(transports).toHaveLength(2);
		const controller = new AbortController();
		controller.abort();
		await expect(connection.callTool("search", {}, { signal: controller.signal })).rejects.toThrow();
		await connection.close();
		expect(connection.state).toBe("closed");
	});
	it("settles startup transport errors as a failed connection", async () => {
		const entry = { name: "broken", source: "test", config: { command: "missing-server" } };
		const connection = new McpServerConnection({
			entry,
			cwd: "/tmp",
			createTransport: () => {
				throw new Error("spawn denied");
			},
			onTools: () => {},
		});
		await expect(connection.getClient()).rejects.toThrow("spawn denied");
		expect(connection.state).toBe("failed");
		expect(connection.error).toContain("spawn denied");
		await connection.close();
	});
	it("connects configured servers when the session starts", async () => {
		const root = tempDir();
		const handlers = new Map<string, (...args: never[]) => unknown>();
		const registeredTools: string[] = [];
		const api = {
			on: (event: string, handler: (...args: never[]) => unknown) => handlers.set(event, handler),
			registerTool: (tool: { name: string }) => registeredTools.push(tool.name),
			registerCommand: () => {},
			getMcpServers: () => [],
			getAllTools: () => [],
			getActiveTools: () => [],
			setActiveTools: () => {},
		};
		const transport = new FakeTransport();
		createMcpExtension({
			agentDir: root,
			loadConfig: () => ({
				servers: [
					{
						name: "docs",
						source: "test",
						scope: "global",
						config: { type: "http", url: "https://docs.test/mcp", exposure: "direct" },
					},
				],
				errors: [],
			}),
			createTransport: () => transport,
			startupWaitMs: 100,
		})(api as unknown as ExtensionAPI);
		const notifications: string[] = [];
		const context = {
			cwd: root,
			isProjectTrusted: () => true,
			ui: { notify: (message: string) => notifications.push(message) },
		} as unknown as ExtensionContext;
		await handlers.get("session_start")?.({} as never, context as never);
		expect(notifications).toEqual([]);
		await handlers.get("before_agent_start")?.({} as never, context as never);
		expect(transport.methods).toContain("tools/list");
		expect(registeredTools).toContain("mcp__docs__search");
		await handlers.get("session_shutdown")?.({} as never, context as never);
	});
});
