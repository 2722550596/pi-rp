import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	BrowserEnvAcquireError,
	createBrowserHarnessEnv,
	requestOpfsPersistence,
} from "../../../src/harness/env/browser.ts";
import { createMockOpfsRoot } from "./opfs-mock.ts";

const tempDirs: string[] = [];

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-agent-browser-env-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("createBrowserHarnessEnv", () => {
	it("assembles the frozen browser capabilities over the OPFS namespace", async () => {
		const root = createMockOpfsRoot(createTempDir(), { withMove: true });
		const { env, capabilities } = await createBrowserHarnessEnv({ root, cwd: "/workspace/default" });

		expect(capabilities.shell).toBe(false);
		expect(capabilities.diskExtensions).toBe(false);
		expect(capabilities.concurrentFsAccess).toBe(false);
		expect(Object.isFrozen(capabilities)).toBe(true);
		expect(env.cwd).toBe("/workspace/default");
	});

	it("exposes filesystem operations and the typed shell-absent exec", async () => {
		const root = createMockOpfsRoot(createTempDir(), { withMove: true });
		const { env } = await createBrowserHarnessEnv({ root, cwd: "/workspace/default" });

		const written = await env.writeFile("/workspace/default/.pi/settings.json", "{}");
		expect(written.ok).toBe(true);
		const read = await env.readTextFile("/workspace/default/.pi/settings.json");
		expect(read).toEqual({ ok: true, value: "{}" });

		const exec = await env.exec("ls");
		expect(exec.ok).toBe(false);
		if (!exec.ok) expect(exec.error.code).toBe("shell_unavailable");
	});

	it("rejects with BrowserEnvAcquireError when the root cannot serve the namespace", async () => {
		const hostileRoot = {
			kind: "directory" as const,
			name: "root",
			values() {
				return {
					[Symbol.asyncIterator]() {
						return {
							next: () => Promise.reject(new DOMException("storage unavailable", "NotSupportedError")),
						};
					},
				} as AsyncIterableIterator<never>;
			},
		};
		await expect(createBrowserHarnessEnv({ root: hostileRoot, cwd: "/workspace/default" })).rejects.toBeInstanceOf(
			BrowserEnvAcquireError,
		);
	});
});

describe("requestOpfsPersistence", () => {
	it("reports false without a storage API (plain node) instead of throwing", async () => {
		await expect(requestOpfsPersistence()).resolves.toBe(false);
	});
});
