import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { McpClient, StdioTransport } from "../src/index.ts";

const fixture = fileURLToPath(new URL("./fixtures/stdio-server.mjs", import.meta.url));
const stubborn = fileURLToPath(new URL("./fixtures/stubborn-server.mjs", import.meta.url));
const limitsFixture = fileURLToPath(new URL("./fixtures/stdio-limits-server.mjs", import.meta.url));

describe("StdioTransport", () => {
	it("connects to a newline-delimited MCP server and captures stderr", async () => {
		const stderr: string[] = [];
		let markStderrReady: (() => void) | undefined;
		const stderrReady = new Promise<void>((resolve) => {
			markStderrReady = resolve;
		});
		const transport = new StdioTransport({
			command: process.execPath,
			args: [fixture],
			onStderr: (chunk) => {
				stderr.push(chunk);
				if (stderr.join("").includes("stdio fixture ready")) markStderrReady?.();
			},
		});
		const client = new McpClient({ name: "stdio-test", version: "1.0.0" });
		try {
			await client.connect(transport);
			expect(await client.listTools()).toEqual([
				{ name: "echo", inputSchema: { type: "object" } },
				{ name: "get-env", inputSchema: { type: "object" } },
			]);
			expect(await client.callTool("echo", { text: "hello" })).toEqual({
				content: [{ type: "text", text: "hello" }],
			});
			expect(transport.pid).toBeTypeOf("number");
			await stderrReady;
			expect(stderr.join("")).toContain("stdio fixture ready");
			expect(transport.stderr).toContain("stdio fixture ready");
		} finally {
			await client.close();
		}
		expect(client.connectionState).toBe("closed");
	});

	it("inherits ambient environment by default and merges explicit overrides", async () => {
		const inheritedName = `PI_MCP_TEST_INHERITED_${process.pid}`;
		const overriddenName = `PI_MCP_TEST_OVERRIDE_${process.pid}`;
		const previousInherited = process.env[inheritedName];
		const previousOverridden = process.env[overriddenName];
		process.env[inheritedName] = "ambient-value";
		process.env[overriddenName] = "ambient-override";

		let inheritedClient: McpClient | undefined;
		let isolatedClient: McpClient | undefined;
		try {
			inheritedClient = new McpClient({ name: "stdio-test", version: "1.0.0" });
			await inheritedClient.connect(
				new StdioTransport({
					command: process.execPath,
					args: [fixture],
					env: { [overriddenName]: "configured-value" },
				}),
			);
			expect(await inheritedClient.callTool("get-env", { key: inheritedName })).toEqual({
				content: [{ type: "text", text: "ambient-value" }],
			});
			expect(await inheritedClient.callTool("get-env", { key: overriddenName })).toEqual({
				content: [{ type: "text", text: "configured-value" }],
			});

			isolatedClient = new McpClient({ name: "stdio-test", version: "1.0.0" });
			await isolatedClient.connect(
				new StdioTransport({
					command: process.execPath,
					args: [fixture],
					env: { [overriddenName]: "explicit-only" },
					inheritEnv: false,
				}),
			);
			expect(await isolatedClient.callTool("get-env", { key: inheritedName })).toEqual({
				content: [{ type: "text", text: "<unset>" }],
			});
			expect(await isolatedClient.callTool("get-env", { key: overriddenName })).toEqual({
				content: [{ type: "text", text: "explicit-only" }],
			});
		} finally {
			await inheritedClient?.close();
			await isolatedClient?.close();
			if (previousInherited === undefined) delete process.env[inheritedName];
			else process.env[inheritedName] = previousInherited;
			if (previousOverridden === undefined) delete process.env[overriddenName];
			else process.env[overriddenName] = previousOverridden;
		}
	});

	it("surfaces child spawn failures", async () => {
		const missingCommand = join(tmpdir(), `pi-mcp-missing-${process.pid}-${Date.now()}`);
		const transport = new StdioTransport({ command: missingCommand });
		try {
			await expect(transport.start()).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await transport.close();
		}
	});

	it("parses errors from framed stdout and bounds buffered stderr", async () => {
		const errors: Error[] = [];
		const stderrChunks: string[] = [];
		let markStderrReady: (() => void) | undefined;
		const stderrReady = new Promise<void>((resolve) => {
			markStderrReady = resolve;
		});
		const transport = new StdioTransport({
			command: process.execPath,
			args: [limitsFixture],
			maxMessageBytes: 8,
			maxStderrBytes: 8,
			onStderr: (chunk) => {
				stderrChunks.push(chunk);
				if (stderrChunks.join("").length >= 16) markStderrReady?.();
			},
		});
		const receivedErrors = new Promise<void>((resolve) => {
			transport.onError((error) => {
				errors.push(error);
				if (errors.length === 2) resolve();
			});
		});
		try {
			await transport.start();
			await Promise.all([receivedErrors, stderrReady]);
			expect(errors[0]).toBeInstanceOf(SyntaxError);
			expect(errors[1]?.message).toBe("MCP stdio message exceeds 8 bytes");
			expect(stderrChunks.join("")).toBe("0123456789abcdef");
			expect(transport.stderr).toBe("89abcdef");
		} finally {
			await transport.close();
		}
	});

	it.skipIf(process.platform === "win32")(
		"kills a server that ignores shutdown, including its children",
		async () => {
			const transport = new StdioTransport({
				command: process.execPath,
				args: [stubborn],
				closeTimeoutMs: 100,
			});
			const client = new McpClient({ name: "stdio-test", version: "1.0.0" });
			await client.connect(transport);
			let grandchild: number | undefined;
			for (let i = 0; i < 100 && grandchild === undefined; i++) {
				const match = /grandchild (\d+)/.exec(transport.stderr);
				if (match) grandchild = Number(match[1]);
				else await new Promise((resolve) => setTimeout(resolve, 10));
			}
			expect(grandchild).toBeTypeOf("number");

			const startedAt = Date.now();
			await client.close();
			expect(Date.now() - startedAt).toBeLessThan(5_000);
			let alive = true;
			for (let i = 0; i < 100 && alive; i++) {
				try {
					process.kill(grandchild as number, 0);
					await new Promise((resolve) => setTimeout(resolve, 20));
				} catch {
					alive = false;
				}
			}
			expect(alive).toBe(false);
		},
		10_000,
	);
});
