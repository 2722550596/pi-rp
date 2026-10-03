import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession, type ExtensionAPI } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

type FactoryRegistry = ExtensionAPI["harness"]["extensions"];

describe("extension factory registry", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-factory-registry-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	async function createSession() {
		let registry: FactoryRegistry | undefined;
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [
				(pi) => {
					registry = pi.harness.extensions;
				},
			],
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager: SessionManager.inMemory(),
			resourceLoader,
		});
		if (!registry) throw new Error("Factory registry was not exposed during extension loading");
		return { session, registry };
	}

	function registerTool(pi: ExtensionAPI, name: string): void {
		pi.registerTool({
			name,
			label: name,
			description: name,
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: name }], details: {} }),
		});
	}

	it("atomically activates all successful factories and their tools", async () => {
		const { session, registry } = await createSession();
		registry.setFactories([
			{ id: "alpha", enabled: true, factory: (pi) => registerTool(pi, "alpha_tool") },
			{ id: "beta", enabled: true, factory: (pi) => registerTool(pi, "beta_tool") },
		]);

		expect(await registry.refreshExtensions()).toEqual({ ok: true, errors: [] });
		expect(session.getAllTools().map((tool) => tool.name)).toEqual(
			expect.arrayContaining(["alpha_tool", "beta_tool"]),
		);
		session.dispose();
	});

	it("discards every staged factory when multiple factories fail", async () => {
		const { session, registry } = await createSession();
		registry.setFactories([{ id: "old", enabled: true, factory: (pi) => registerTool(pi, "old_tool") }]);
		expect((await registry.refreshExtensions()).ok).toBe(true);

		registry.setFactories([
			{ id: "staged", enabled: true, factory: (pi) => registerTool(pi, "staged_tool") },
			{
				id: "broken_a",
				enabled: true,
				factory: () => {
					throw new Error("first failure");
				},
			},
			{
				id: "broken_b",
				enabled: true,
				factory: () => {
					throw new Error("second failure");
				},
			},
		]);
		const result = await registry.refreshExtensions();

		expect(result).toEqual({
			ok: false,
			errors: [
				{ id: "broken_a", message: "first failure" },
				{ id: "broken_b", message: "second failure" },
			],
		});
		const names = session.getAllTools().map((tool) => tool.name);
		expect(names).toContain("old_tool");
		expect(names).not.toContain("staged_tool");
		session.dispose();
	});

	it("removes disabled factories while retaining enabled factory tools", async () => {
		const { session, registry } = await createSession();
		registry.setFactories([
			{ id: "kept", enabled: true, factory: (pi) => registerTool(pi, "kept_tool") },
			{ id: "removed", enabled: true, factory: (pi) => registerTool(pi, "removed_tool") },
		]);
		await registry.refreshExtensions();

		registry.setFactories([
			{ id: "kept", enabled: true, factory: (pi) => registerTool(pi, "kept_tool") },
			{ id: "removed", enabled: false, factory: (pi) => registerTool(pi, "removed_tool") },
		]);
		expect(await registry.refreshExtensions()).toEqual({ ok: true, errors: [] });
		const names = session.getAllTools().map((tool) => tool.name);
		expect(names).toContain("kept_tool");
		expect(names).not.toContain("removed_tool");
		session.dispose();
	});

	it("rejects duplicate factory ids without replacing the current registry", async () => {
		const { session, registry } = await createSession();
		registry.setFactories([{ id: "existing", enabled: true, factory: (pi) => registerTool(pi, "existing_tool") }]);
		expect(() =>
			registry.setFactories([
				{ id: "duplicate", factory: () => {} },
				{ id: "duplicate", factory: () => {} },
			]),
		).toThrow('Duplicate extension factory id "duplicate"');
		expect(registry.getFactoryEntries().map((entry) => entry.id)).toEqual(["existing"]);
		expect((await registry.refreshExtensions()).ok).toBe(true);
		expect(session.getAllTools().map((tool) => tool.name)).toContain("existing_tool");
		session.dispose();
	});
});
