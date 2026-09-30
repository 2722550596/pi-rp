import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExecutionEnv, ExecutionError, type Shell } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createExtensionRuntime as createCoreRuntime,
	loadExtensionsFromFactories,
} from "../src/core/extensions/api.ts";
import { refusalExec, shellBridgeExec } from "../src/core/extensions/exec-impl.ts";
import { createExtensionRuntime as createNodeRuntime } from "../src/core/extensions/loader.ts";
import type { ExtensionAPI, ExtensionRuntime } from "../src/core/extensions/types.ts";

/** Capture the ExtensionAPI a factory receives, then return it for post-load invocation. */
async function captureApi(runtime: ExtensionRuntime, factory: (pi: ExtensionAPI) => void, tempDir: string) {
	let captured: ExtensionAPI | undefined;
	await loadExtensionsFromFactories(
		[
			(pi) => {
				captured = pi;
				factory(pi);
			},
		],
		tempDir,
		undefined,
		runtime,
	);
	if (!captured) throw new Error("factory was never invoked");
	return captured;
}

describe("pi.exec negotiated absence", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-exec-negotiation-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("resolves a structured refusal on an assembly-core runtime (never rejects, never throws)", async () => {
		const runtime = createCoreRuntime();
		const pi = await captureApi(runtime, () => {}, tempDir);

		await expect(pi.exec("echo", ["hi"])).resolves.toEqual({
			stdout: "",
			stderr: "pi.exec unavailable: shell_unavailable",
			code: 127,
			killed: false,
		});
	});

	it("honors an explicit refusalExec injected through the node loader wrapper", async () => {
		const runtime = createNodeRuntime({ exec: refusalExec() });
		const pi = await captureApi(runtime, () => {}, tempDir);

		await expect(pi.exec("anything", [])).resolves.toMatchObject({
			code: 127,
			stderr: "pi.exec unavailable: shell_unavailable",
		});
	});

	it("keeps the node default wired to a real command execution", async () => {
		const runtime = createNodeRuntime();
		const pi = await captureApi(runtime, () => {}, tempDir);

		await expect(pi.exec("echo", ["node-default"], { cwd: tempDir })).resolves.toEqual({
			stdout: "node-default\n",
			stderr: "",
			code: 0,
			killed: false,
		});
	});
});

describe("shellBridgeExec (hosted shell bridge)", () => {
	// The bridge only touches Shell; a fake cannot practically implement the 18 FileSystem methods.
	const envWith = (exec: Shell["exec"]): ExecutionEnv =>
		({ exec, cleanup: async () => {} }) as unknown as ExecutionEnv;

	it("maps an ok shell result straight through", async () => {
		const exec = vi.fn(async () => ({ ok: true as const, value: { stdout: "out", stderr: "err", exitCode: 3 } }));
		const impl = shellBridgeExec(envWith(exec));

		const signal = new AbortController().signal;
		const result = await impl("ls", ["-l", "it's"], "/tmp/dir", { timeout: 2500, signal });

		expect(result).toEqual({ stdout: "out", stderr: "err", code: 3, killed: false });
		// spawn argv semantics become one POSIX-quoted shell string; timeout converts ms → s; signal → abortSignal.
		expect(exec).toHaveBeenCalledWith("'ls' '-l' 'it'\\''s'", {
			cwd: "/tmp/dir",
			timeout: 2.5,
			abortSignal: signal,
		});
	});

	it("maps timeout and abort errors to killed results", async () => {
		const timedOut = shellBridgeExec(
			envWith(async () => ({ ok: false as const, error: new ExecutionError("timeout", "timed out") })),
		);
		const aborted = shellBridgeExec(
			envWith(async () => ({ ok: false as const, error: new ExecutionError("aborted", "aborted") })),
		);

		await expect(timedOut("cmd", [], "/tmp")).resolves.toEqual({
			stdout: "",
			stderr: "timed out",
			code: 127,
			killed: true,
		});
		await expect(aborted("cmd", [], "/tmp")).resolves.toEqual({
			stdout: "",
			stderr: "aborted",
			code: 127,
			killed: true,
		});
	});

	it("maps a host shell_unavailable to the negotiated-absence marker", async () => {
		const impl = shellBridgeExec(
			envWith(async () => ({ ok: false as const, error: new ExecutionError("shell_unavailable", "no shell") })),
		);

		await expect(impl("cmd", [], "/tmp")).resolves.toEqual({
			stdout: "",
			stderr: "pi.exec unavailable: shell_unavailable",
			code: 127,
			killed: false,
		});
	});

	it("maps other execution errors to code 127 with the error message on stderr", async () => {
		const impl = shellBridgeExec(
			envWith(async () => ({ ok: false as const, error: new ExecutionError("spawn_error", "binary missing") })),
		);

		await expect(impl("cmd", [], "/tmp")).resolves.toEqual({
			stdout: "",
			stderr: "binary missing",
			code: 127,
			killed: false,
		});
	});
});
