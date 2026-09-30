import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capabilities } from "@earendil-works/pi-agent-core";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const BUILTIN_TOOL_NAMES = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);
const SHELL_FREE: Capabilities = { shell: false, diskExtensions: false, concurrentFsAccess: false };

describe("bash complement tool switch (capabilities.shell)", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-bash-complement-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	async function createSession(options: {
		capabilities?: Capabilities;
		tools?: string[];
		excludeTools?: string[];
		defaultTools?: string[];
	}) {
		const settingsManager = SettingsManager.inMemory(
			options.defaultTools ? { defaultTools: options.defaultTools } : {},
		);
		const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager: SessionManager.inMemory(tempDir),
			resourceLoader,
			capabilities: options.capabilities,
			tools: options.tools,
			excludeTools: options.excludeTools,
		});
		return session;
	}

	const builtinActive = (session: { getActiveToolNames(): string[] }): string[] =>
		session
			.getActiveToolNames()
			.filter((name) => BUILTIN_TOOL_NAMES.has(name))
			.sort();

	it("shell-free profile: bash not registered, grep/find/ls activated by default", async () => {
		const session = await createSession({ capabilities: SHELL_FREE });

		const registered = session.getAllTools().map((tool) => tool.name);
		expect(registered).not.toContain("bash");
		expect(registered).toEqual(expect.arrayContaining(["read", "edit", "write", "grep", "find", "ls"]));

		expect(builtinActive(session)).toEqual(["edit", "find", "grep", "ls", "read", "write"]);

		const prompt = await session.compileSystemPrompt();
		expect(prompt).not.toContain("- bash:");
		expect(prompt).not.toContain("Use bash for file operations");
		session.dispose();
	});

	it("shell profile keeps the node default face (bash active, grep/find/ls inactive)", async () => {
		const session = await createSession({});

		const registered = session.getAllTools().map((tool) => tool.name);
		expect(registered).toEqual(expect.arrayContaining(["bash", "read", "edit", "write", "grep", "find", "ls"]));
		expect(builtinActive(session)).toEqual(["bash", "edit", "read", "write"]);
		session.dispose();
	});

	it("explicit SDK tools option overrides the shell-free profile default", async () => {
		const session = await createSession({ capabilities: SHELL_FREE, tools: ["read"] });
		expect(builtinActive(session)).toEqual(["read"]);
		session.dispose();
	});

	it("settings defaultTools override the shell-free profile default", async () => {
		const session = await createSession({ capabilities: SHELL_FREE, defaultTools: ["read"] });
		expect(builtinActive(session)).toEqual(["read"]);
		session.dispose();
	});

	it("host excludeTools merge with the negotiated bash absence", async () => {
		const session = await createSession({ capabilities: SHELL_FREE, excludeTools: ["find"] });

		const registered = session.getAllTools().map((tool) => tool.name);
		expect(registered).not.toContain("bash");
		expect(registered).not.toContain("find");
		expect(builtinActive(session)).toEqual(["edit", "grep", "ls", "read", "write"]);
		session.dispose();
	});
});
