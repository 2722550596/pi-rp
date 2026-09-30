import { describe, expect, it } from "vitest";
import { negotiate } from "../../src/harness/capabilities.ts";
import { createHostedHarnessEnv, HostContributionError } from "../../src/harness/env/hosted.ts";
import { ExecutionError, err, type FileSystem, ok, type Result, type Shell } from "../../src/harness/types.ts";

function createFsStub(overrides?: Partial<FileSystem>): FileSystem {
	const base: FileSystem = {
		cwd: "/",
		absolutePath: () => Promise.resolve(ok("/stub")),
		joinPath: () => Promise.resolve(ok("/stub")),
		readTextFile: () => Promise.resolve(ok("")),
		readTextLines: () => Promise.resolve(ok([])),
		readBinaryFile: () => Promise.resolve(ok(new Uint8Array())),
		writeFile: () => Promise.resolve(ok(undefined)),
		appendFile: () => Promise.resolve(ok(undefined)),
		renameFile: () => Promise.resolve(ok(undefined)),
		fileInfo: () => Promise.resolve(ok({ name: "stub", path: "/stub", kind: "file" as const, size: 0, mtimeMs: 0 })),
		listDir: () => Promise.resolve(ok([])),
		canonicalPath: () => Promise.resolve(ok("/stub")),
		exists: () => Promise.resolve(ok(false)),
		createDir: () => Promise.resolve(ok(undefined)),
		remove: () => Promise.resolve(ok(undefined)),
		createTempDir: () => Promise.resolve(ok("/stub-tmp")),
		createTempFile: () => Promise.resolve(ok("/stub-tmp-file")),
		cleanup: () => Promise.resolve(),
	};
	return { ...base, ...overrides };
}

function createShellStub(exec?: Shell["exec"]): Shell {
	return {
		exec: exec ?? (() => Promise.resolve(ok({ stdout: "", stderr: "", exitCode: 0 }))),
		cleanup: () => Promise.resolve(),
	};
}

describe("negotiate", () => {
	it("derives shell from injected shell presence", () => {
		expect(negotiate({})).toEqual({ shell: false, diskExtensions: false, concurrentFsAccess: true });
		expect(negotiate({ shell: createShellStub() }).shell).toBe(true);
	});

	it("passes explicit diskExtensions and concurrentFsAccess through", () => {
		const caps = negotiate({ diskExtensions: true, concurrentFsAccess: false });
		expect(caps.diskExtensions).toBe(true);
		expect(caps.concurrentFsAccess).toBe(false);
	});

	it("defaults diskExtensions to false and concurrentFsAccess to true (conservative)", () => {
		const caps = negotiate({ shell: createShellStub() });
		expect(caps.diskExtensions).toBe(false);
		expect(caps.concurrentFsAccess).toBe(true);
	});

	it("returns a frozen object", () => {
		const caps = negotiate({});
		expect(Object.isFrozen(caps)).toBe(true);
		expect(() => {
			(caps as unknown as { shell: boolean }).shell = true;
		}).toThrow();
	});
});

describe("createHostedHarnessEnv", () => {
	it("negotiates full shell capability with a contributed shell", () => {
		const harnessEnv = createHostedHarnessEnv({ fs: createFsStub(), shell: createShellStub(), cwd: "/w" });
		expect(harnessEnv.capabilities).toEqual({ shell: true, diskExtensions: false, concurrentFsAccess: true });
		expect(Object.isFrozen(harnessEnv.capabilities)).toBe(true);
	});

	it("negotiates shell:false and keeps exec a typed error when no shell is contributed", async () => {
		const harnessEnv = createHostedHarnessEnv({ fs: createFsStub(), cwd: "/w" });
		expect(harnessEnv.capabilities.shell).toBe(false);
		const result = await harnessEnv.env.exec("ls");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toBeInstanceOf(ExecutionError);
			expect(result.error.code).toBe("shell_unavailable");
		}
	});

	it("honors a declared concurrentFsAccess:false", () => {
		const harnessEnv = createHostedHarnessEnv({ fs: createFsStub(), concurrentFsAccess: false, cwd: "/w" });
		expect(harnessEnv.capabilities.concurrentFsAccess).toBe(false);
	});

	it("delegates exec to the contributed shell with options untouched", async () => {
		const calls: Array<{ command: string; options?: unknown }> = [];
		const shell = createShellStub((command, options) => {
			calls.push({ command, options });
			return Promise.resolve(ok({ stdout: "hi", stderr: "", exitCode: 0 }));
		});
		const harnessEnv = createHostedHarnessEnv({ fs: createFsStub(), shell, cwd: "/w" });
		const result = await harnessEnv.env.exec("echo hi", { timeout: 5 });
		expect(result).toEqual({ ok: true, value: { stdout: "hi", stderr: "", exitCode: 0 } });
		expect(calls).toEqual([{ command: "echo hi", options: { timeout: 5 } }]);
	});

	it("applies the declared cwd to the contributed bridge and exposes it", () => {
		const fs = createFsStub();
		fs.cwd = "/elsewhere";
		const harnessEnv = createHostedHarnessEnv({ fs, cwd: "/w" });
		expect(fs.cwd).toBe("/w");
		expect(harnessEnv.env.cwd).toBe("/w");
	});

	it("delegates filesystem operations to the contributed bridge", async () => {
		const fs = createFsStub({ readTextFile: () => Promise.resolve(ok("contents")) });
		const harnessEnv = createHostedHarnessEnv({ fs, cwd: "/w" });
		await expect(harnessEnv.env.readTextFile("a.txt")).resolves.toEqual({ ok: true, value: "contents" });
	});

	it("cleans up both fs and shell and never rejects", async () => {
		const cleaned: string[] = [];
		const fs = createFsStub({
			cleanup: () => {
				cleaned.push("fs");
				return Promise.resolve();
			},
		});
		const shell: Shell = {
			exec: () =>
				Promise.resolve(
					err(new ExecutionError("unknown", "unused")) as Result<
						{ stdout: string; stderr: string; exitCode: number },
						ExecutionError
					>,
				),
			cleanup: () => {
				cleaned.push("shell");
				return Promise.reject(new Error("bridge exploded"));
			},
		};
		const harnessEnv = createHostedHarnessEnv({ fs, shell, cwd: "/w" });
		await expect(harnessEnv.env.cleanup()).resolves.toBeUndefined();
		expect(cleaned.sort()).toEqual(["fs", "shell"]);
	});

	it("rejects contributions with missing or non-function members at assembly", () => {
		const fs = createFsStub();
		delete (fs as Partial<FileSystem>).renameFile;
		expect(() => createHostedHarnessEnv({ fs: fs as FileSystem, cwd: "/w" })).toThrow(HostContributionError);

		const shell = createShellStub();
		delete (shell as Partial<Shell>).cleanup;
		expect(() => createHostedHarnessEnv({ fs: createFsStub(), shell: shell as Shell, cwd: "/w" })).toThrow(
			HostContributionError,
		);

		const brokenFs = createFsStub();
		(brokenFs as unknown as { exists: number }).exists = 1;
		expect(() => createHostedHarnessEnv({ fs: brokenFs, cwd: "/w" })).toThrow(HostContributionError);
	});
});
