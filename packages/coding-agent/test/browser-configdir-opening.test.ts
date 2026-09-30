/**
 * T15 end-to-end: same cwd + same StorageBackend, distinct per-harness configDir roots.
 * Exercises the public createPiHarness path through resource pre-scan, default InlineExtension
 * assembly, createAgentSession, and S8.5 session_start seeding (19 号 §10 T15 / 17 §3.1-3.2).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { type ExecutionEnv, type HarnessEnv, negotiate } from "../../agent/src/harness/capabilities.ts";
import { type CreatePiHarnessOptions, createPiHarness, type PiHarness } from "../../browser-engine/src/assemble.ts";
import { MemoryStorageBackend } from "./resource-supply-mocks.ts";

// The raw:template assets are build-time only; keep the real assembly path while stubbing this unrelated asset seam.
vi.mock("../../browser-engine/src/export-html-assets.ts", () => ({ execExportTemplateAssets: () => {} }));

const cwd = "/workspace/default";
const agentDir = "/state/agent";
const configDirEnv = "PI_PROJECT_CONFIG_DIR";
const originalConfigDirEnv = process.env[configDirEnv];
const createdHarnesses: PiHarness[] = [];

afterEach(async () => {
	await Promise.all(createdHarnesses.splice(0).map((harness) => harness.dispose()));
	if (originalConfigDirEnv === undefined) delete process.env[configDirEnv];
	else process.env[configDirEnv] = originalConfigDirEnv;
});

function hostedEnv(): HarnessEnv {
	const env = {
		cwd,
		exec: async () => {
			throw new Error("T15 must not execute shell commands");
		},
		cleanup: async () => {},
	} as unknown as ExecutionEnv;
	return { env, capabilities: negotiate({ shell: env }) };
}

function getSeededMessage(harness: PiHarness): string[] {
	return harness.session.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "message")
		.map((entry) => {
			const content = entry.message.content;
			if (typeof content === "string") return content;
			return content.map((part) => (part.type === "text" ? part.text : "")).join("");
		});
}

function getOpeningAuditCount(harness: PiHarness): number {
	return harness.session.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom" && entry.customType === "opening").length;
}

describe("T15: per-harness configDir isolates openings for the same cwd", () => {
	it("same ID resolves independently in parallel roots and defaults to .pi", async () => {
		const storage = new MemoryStorageBackend("opfs");
		for (const [configDir, content] of [
			["ip-a", "opening from ip-a"],
			["ip-b", "opening from ip-b"],
			[".pi", "opening from default .pi"],
		] as const) {
			storage.seedJson(`${cwd}/${configDir}/openings/shared.json`, {
				name: configDir,
				messages: [{ role: "user", content }],
			});
		}

		// If any layer consults the process env instead of its per-harness argument, all three
		// lookups miss this root and createPiHarness rejects before constructing a session.
		process.env[configDirEnv] = "global-env-must-not-win";

		const stores = {
			storage,
			locks: { lockSync: () => () => {}, lockAsync: async () => async () => {} },
			paths: { agentDir: () => agentDir },
		};
		const model = { provider: "smoke", id: "smoke-model" } as CreatePiHarnessOptions["model"];
		const llm = {
			streamFn: async () => ({ stopReason: "error" }),
		} as unknown as NonNullable<CreatePiHarnessOptions["llm"]>;
		const base = {
			profile: "hosted" as const,
			env: hostedEnv(),
			cwd,
			model,
			llm,
			stores,
			opening: "shared",
		};
		const inputs: CreatePiHarnessOptions[] = [{ ...base, configDir: "ip-a" }, { ...base, configDir: "ip-b" }, base];
		const outcomes = await Promise.allSettled(inputs.map((options) => createPiHarness(options)));
		createdHarnesses.push(...outcomes.flatMap((outcome) => (outcome.status === "fulfilled" ? [outcome.value] : [])));
		const rejected = outcomes.find((outcome) => outcome.status === "rejected");
		if (rejected?.status === "rejected") throw rejected.reason;

		const first = createdHarnesses[0];
		const second = createdHarnesses[1];
		const defaultRoot = createdHarnesses[2];
		if (!first || !second || !defaultRoot) throw new Error("expected all three harnesses to assemble");

		expect(getSeededMessage(first)).toEqual(["opening from ip-a"]);
		expect(getSeededMessage(second)).toEqual(["opening from ip-b"]);
		expect(getSeededMessage(defaultRoot)).toEqual(["opening from default .pi"]);
		expect(process.env[configDirEnv]).toBe("global-env-must-not-win");
		expect(getOpeningAuditCount(first)).toBe(1);
		expect(getOpeningAuditCount(second)).toBe(1);
		expect(getOpeningAuditCount(defaultRoot)).toBe(1);
	});
});
