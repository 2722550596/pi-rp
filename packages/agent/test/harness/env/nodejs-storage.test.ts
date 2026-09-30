import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodeStateLocks, NodeStatePaths, NodeStorageBackend } from "../../../src/harness/env/nodejs-storage.ts";

const tempDirs: string[] = [];

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-agent-node-storage-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function errnoOf(fn: () => unknown): string {
	try {
		fn();
	} catch (error) {
		return String((error as { code?: unknown }).code);
	}
	throw new Error("expected the operation to throw");
}

describe("NodeStorageBackend", () => {
	it("wraps node:fs write/append/read semantics exactly", () => {
		const dir = createTempDir();
		const backend = new NodeStorageBackend();
		expect(backend.kind).toBe("node-fs");

		expect(backend.existsSync(join(dir, "missing"))).toBe(false);
		expect(errnoOf(() => backend.writeTextFileSync(join(dir, "nested", "a.txt"), "x"))).toBe("ENOENT");
		backend.mkdirSync(join(dir, "nested"), { recursive: true });
		backend.writeTextFileSync(join(dir, "nested", "a.txt"), "one");
		backend.appendTextFileSync(join(dir, "nested", "a.txt"), "two");
		expect(backend.readTextFileSync(join(dir, "nested", "a.txt"))).toBe("onetwo");
		expect(errnoOf(() => backend.writeTextFileSync(join(dir, "nested", "a.txt"), "x", { flag: "wx" }))).toBe(
			"EEXIST",
		);
		backend.writeTextFileSync(join(dir, "nested", "a.txt"), "three");
		expect(readFileSync(join(dir, "nested", "a.txt"), "utf-8")).toBe("three");
	});

	it("readTextLinesSync mirrors the streaming line semantics", () => {
		const dir = createTempDir();
		const backend = new NodeStorageBackend();
		const file = join(dir, "s.jsonl");
		writeFileSync(file, '{"n":1}\n{"n":2}\r\n{"n":3}\n', "utf-8");
		expect(backend.readTextLinesSync(file)).toEqual(['{"n":1}', '{"n":2}', '{"n":3}']);
		expect(backend.readTextLinesSync(file, 2)).toEqual(['{"n":1}', '{"n":2}']);
		expect(backend.readTextLinesSync(file, 0)).toEqual([]);
		writeFileSync(file, '{"n":1}\n{"n":2}', "utf-8");
		expect(backend.readTextLinesSync(file)).toEqual(['{"n":1}', '{"n":2}']);
	});

	it("readdir/stat/rename/canonicalize/revision match the node:fs shapes", () => {
		const dir = createTempDir();
		const backend = new NodeStorageBackend();
		backend.mkdirSync(join(dir, "sub"), { recursive: true });
		backend.writeTextFileSync(join(dir, "sub", "f.txt"), "12345");

		expect(backend.readdirSync(dir)).toEqual([
			{ name: "sub", isFile: false, isDirectory: true, isSymbolicLink: false },
		]);
		expect(backend.readdirSync(join(dir, "sub"))).toEqual([
			{ name: "f.txt", isFile: true, isDirectory: false, isSymbolicLink: false },
		]);

		const stats = backend.statSync(join(dir, "sub", "f.txt"));
		expect(stats.isFile).toBe(true);
		expect(stats.size).toBe(5);
		expect(stats.mtimeMs).toBeGreaterThan(0);

		backend.writeTextFileSync(join(dir, "stage.txt"), "staged");
		backend.renameSync(join(dir, "stage.txt"), join(dir, "sub", "final.txt"));
		expect(backend.existsSync(join(dir, "stage.txt"))).toBe(false);
		expect(backend.readTextFileSync(join(dir, "sub", "final.txt"))).toBe("staged");

		expect(backend.canonicalizeSync(join(dir, "sub", "..", "sub"))).toBe(realpathSync(join(dir, "sub")));
		expect(backend.canonicalizeSync(join(dir, "never-exists"))).toBe(join(dir, "never-exists"));

		const revision = backend.fileRevisionSync(join(dir, "sub", "f.txt"));
		expect(revision).toMatch(/^\d+:\d+:\d+:\d+:\d+$/);
		expect(backend.fileRevisionSync(join(dir, "ghost"))).toBeUndefined();
	});

	it("canonicalizeSync resolves symlinks like realpathSync", () => {
		const dir = createTempDir();
		const backend = new NodeStorageBackend();
		backend.mkdirSync(join(dir, "real"), { recursive: true });
		symlinkSync(join(dir, "real"), join(dir, "link"));
		expect(backend.canonicalizeSync(join(dir, "link"))).toBe(realpathSync(join(dir, "real")));
	});
});

describe("NodeStateLocks", () => {
	it("lockSync excludes a second holder and recovers after release", () => {
		const dir = createTempDir();
		const locks = new NodeStateLocks();
		const target = join(dir, "settings.json");
		writeFileSync(target, "{}", "utf-8");

		const release = locks.lockSync(target);
		expect(errnoOf(() => locks.lockSync(target))).toBe("ELOCKED");
		release();
		const reacquire = locks.lockSync(target);
		reacquire();
	});

	it("lockAsync acquires and releases", async () => {
		const dir = createTempDir();
		const locks = new NodeStateLocks();
		const target = join(dir, "auth.json");
		writeFileSync(target, "{}", "utf-8");

		const release = await locks.lockAsync(target);
		await expect(locks.lockAsync(target, { signal: AbortSignal.abort() })).rejects.toThrow();
		await release();
		const reacquire = await locks.lockAsync(target);
		await reacquire();
	});
});

describe("NodeStatePaths", () => {
	it("resolves from a static value or a live resolver", () => {
		expect(new NodeStatePaths("/state/agent").agentDir()).toBe("/state/agent");
		let current = "/first";
		const paths = new NodeStatePaths(() => current);
		expect(paths.agentDir()).toBe("/first");
		current = "/second";
		expect(paths.agentDir()).toBe("/second");
	});
});
