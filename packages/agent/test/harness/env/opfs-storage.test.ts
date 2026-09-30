import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OpfsFileSystem } from "../../../src/harness/env/opfs/file-system.ts";
import {
	BROWSER_AGENT_DIR,
	BROWSER_DEFAULT_WORKSPACE,
	browserWorkspacePath,
	OpfsStateLocks,
	OpfsStorageBackend,
	opfsStatePaths,
} from "../../../src/harness/env/opfs/storage.ts";
import { createMockOpfsRoot } from "./opfs-mock.ts";

const tempDirs: string[] = [];

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-agent-opfs-storage-"));
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

describe("OpfsStorageBackend", () => {
	it("hydrates the state subtree at assembly and serves synchronous reads", async () => {
		const root = createMockOpfsRoot(createTempDir(), { withMove: true });
		const seed = new OpfsFileSystem(root, "/");
		await seed.writeFile("/state/agent/settings.json", '{"theme":"dark"}');
		await seed.writeFile("/state/agent/sessions/s1.jsonl", '{"kind":"header"}\n');

		const backend = await OpfsStorageBackend.create(root);
		expect(backend.kind).toBe("opfs");
		expect(backend.existsSync("/state/agent/settings.json")).toBe(true);
		expect(backend.readTextFileSync("/state/agent/settings.json")).toBe('{"theme":"dark"}');
		expect(backend.readTextFileSync("/state/agent/sessions/s1.jsonl")).toBe('{"kind":"header"}\n');
		expect(backend.readTextLinesSync("/state/agent/sessions/s1.jsonl", 1)).toEqual(['{"kind":"header"}']);
	});

	it("applies writes to the mirror immediately and flushes them through the async face", async () => {
		const root = createMockOpfsRoot(createTempDir(), { withMove: true });
		const backend = await OpfsStorageBackend.create(root);
		backend.mkdirSync("/state/agent", { recursive: true });
		backend.writeTextFileSync("/state/agent/auth.json", "{}");

		// Synchronous read-back happens without awaiting durability.
		expect(backend.readTextFileSync("/state/agent/auth.json")).toBe("{}");
		expect(backend.statSync("/state/agent/auth.json").isFile).toBe(true);

		await backend.flush();
		const asyncFace = new OpfsFileSystem(root, "/");
		const persisted = await asyncFsRead(asyncFace, "/state/agent/auth.json");
		expect(persisted).toBe("{}");
	});

	it("preserves flushed state across rehydration (reload semantics)", async () => {
		const root = createMockOpfsRoot(createTempDir(), { withMove: true });
		const first = await OpfsStorageBackend.create(root);
		first.mkdirSync("/state/agent", { recursive: true });
		first.writeTextFileSync("/state/agent/models.json", "[]");
		await first.flush();

		const second = await OpfsStorageBackend.create(root);
		expect(second.readTextFileSync("/state/agent/models.json")).toBe("[]");
	});

	it("appends multi-byte text byte-accurately (session JSONL resume path)", async () => {
		const root = createMockOpfsRoot(createTempDir(), { withMove: true });
		const backend = await OpfsStorageBackend.create(root);
		backend.mkdirSync("/state/agent/sessions", { recursive: true });
		backend.writeTextFileSync("/state/agent/sessions/s.jsonl", '{"kind":"header"}\n');

		// Regression: the merge buffer was sized by UTF-16 string length while the payload is
		// UTF-8 — CJK appends threw RangeError "offset is out of bounds", which is the
		// post-first-assistant persist path (_persist → appendTextFileSync), i.e. every turn
		// of a resumed session died before reaching the model.
		const line = `${JSON.stringify({ role: "assistant", content: "灰烬堡的壁炉里住着永不熄灭的那位。" })}\n`;
		expect(() => backend.appendTextFileSync("/state/agent/sessions/s.jsonl", line)).not.toThrow();
		expect(backend.readTextFileSync("/state/agent/sessions/s.jsonl")).toBe(`{"kind":"header"}\n${line}`);
		expect(() => backend.appendTextFileSync("/state/agent/sessions/s.jsonl", line)).not.toThrow();
		expect(backend.readTextFileSync("/state/agent/sessions/s.jsonl")).toBe(`{"kind":"header"}\n${line}${line}`);

		await backend.flush();
		const asyncFace = new OpfsFileSystem(root, "/");
		expect(await asyncFsRead(asyncFace, "/state/agent/sessions/s.jsonl")).toBe(`{"kind":"header"}\n${line}${line}`);
	});

	it("enforces node parity for wx/writes/mkdir/readdir/stat error surfaces", async () => {
		const root = createMockOpfsRoot(createTempDir(), { withMove: true });
		const backend = await OpfsStorageBackend.create(root);

		expect(errnoOf(() => backend.writeTextFileSync("/state/agent/a.json", "{}", { flag: "wx" }))).toBe("ENOENT");
		backend.mkdirSync("/state/agent", { recursive: true });
		backend.writeTextFileSync("/state/agent/a.json", "one");
		expect(errnoOf(() => backend.writeTextFileSync("/state/agent/a.json", "two", { flag: "wx" }))).toBe("EEXIST");
		expect(backend.readTextFileSync("/state/agent/a.json")).toBe("one");
		expect(errnoOf(() => backend.writeTextFileSync("/state/none/b.json", "x"))).toBe("ENOENT");
		expect(errnoOf(() => backend.readTextFileSync("/state/agent/missing.json"))).toBe("ENOENT");
		expect(() => backend.mkdirSync("/state/agent", { recursive: true })).not.toThrow(); // node recursive mkdir is idempotent
		backend.mkdirSync("/state/agent/sub");
		expect(errnoOf(() => backend.mkdirSync("/state/agent/sub"))).toBe("EEXIST");
		expect(errnoOf(() => backend.readdirSync("/state/agent/a.json"))).toBe("ENOTDIR");
		expect(errnoOf(() => backend.readdirSync("/state/none"))).toBe("ENOENT");
		expect(errnoOf(() => backend.appendTextFileSync("/deep/missing/file", "x"))).toBe("ENOENT");

		const entries = backend.readdirSync("/state/agent").map((entry) => `${entry.name}:${entry.isFile}`);
		expect(entries.sort()).toEqual(["a.json:true", "sub:false"]);
		expect(backend.statSync("/state/agent").isDirectory).toBe(true);
	});

	it("renames files with replace semantics and persists through the async face", async () => {
		const root = createMockOpfsRoot(createTempDir(), { withMove: true });
		const backend = await OpfsStorageBackend.create(root);
		backend.mkdirSync("/state/agent/sessions", { recursive: true });
		backend.writeTextFileSync("/state/agent/sessions/staged.jsonl.tmp", "staged");

		backend.renameSync("/state/agent/sessions/staged.jsonl.tmp", "/state/agent/sessions/live.jsonl");
		expect(backend.existsSync("/state/agent/sessions/staged.jsonl.tmp")).toBe(false);
		expect(backend.readTextFileSync("/state/agent/sessions/live.jsonl")).toBe("staged");
		await backend.flush();

		const asyncFace = new OpfsFileSystem(root, "/");
		expect(await asyncFsRead(asyncFace, "/state/agent/sessions/live.jsonl")).toBe("staged");
		expect(await asyncFace.exists("/state/agent/sessions/staged.jsonl.tmp")).toEqual({ ok: true, value: false });

		expect(errnoOf(() => backend.renameSync("/state/agent/ghost", "/state/agent/here"))).toBe("ENOENT");
	});

	it("reports revisions and canonical forms without touching the disk", async () => {
		const root = createMockOpfsRoot(createTempDir(), { withMove: true });
		const backend = await OpfsStorageBackend.create(root);
		expect(backend.fileRevisionSync("/state/none")).toBeUndefined();
		backend.mkdirSync("/state/agent", { recursive: true });
		backend.writeTextFileSync("/state/agent/keybindings.json", "[]");
		const revision = backend.fileRevisionSync("/state/agent/keybindings.json");
		expect(revision).toMatch(/^\d+:\d+$/);
		backend.writeTextFileSync("/state/agent/keybindings.json", '["a"]');
		expect(backend.fileRevisionSync("/state/agent/keybindings.json")).not.toBe(revision);
		expect(backend.canonicalizeSync("/state/agent/../agent/x")).toBe("/state/agent/x");
	});

	it("surfaces write-through failures on flush without poisoning the queue", async () => {
		const real = createMockOpfsRoot(createTempDir(), { withMove: true });
		let detached = false;
		const root = new Proxy(real, {
			get(target, property) {
				if (property === "getDirectoryHandle" && detached) {
					return () => Promise.reject(new DOMException("storage detached", "InvalidStateError"));
				}
				// Bind to the real target: handle methods use private fields and cannot run against the proxy receiver.
				const value = Reflect.get(target, property);
				return typeof value === "function" ? value.bind(target) : value;
			},
		}) as MockDirectoryHandle;

		const backend = await OpfsStorageBackend.create(root);
		backend.mkdirSync("/state", { recursive: true });
		backend.writeTextFileSync("/state/x.txt", "one");

		detached = true;
		await expect(backend.flush()).rejects.toThrow();
		expect(backend.existsSync("/state/x.txt")).toBe(true); // mirror unaffected by persistence failure

		detached = false;
		backend.writeTextFileSync("/state/x.txt", "two");
		await expect(backend.flush()).resolves.toBeUndefined();
	});
});

describe("Opfs layout and paths", () => {
	it("exposes the frozen contract layout values", () => {
		expect(BROWSER_AGENT_DIR).toBe("/state/agent");
		expect(BROWSER_DEFAULT_WORKSPACE).toBe("/workspace/default");
		expect(browserWorkspacePath()).toBe("/workspace/default");
		expect(browserWorkspacePath("other")).toBe("/workspace/other");
		const paths = opfsStatePaths();
		expect(paths.agentDir()).toBe("/state/agent");
		expect(opfsStatePaths("/state/custom").agentDir()).toBe("/state/custom");
	});
});

describe("OpfsStateLocks", () => {
	it("is a structural no-op for both lock modes", async () => {
		const locks = new OpfsStateLocks();
		const releaseSync = locks.lockSync("/state/agent/settings.json");
		expect(typeof releaseSync).toBe("function");
		expect(() => releaseSync()).not.toThrow();
		const releaseAsync = await locks.lockAsync("/state/agent/auth.json");
		expect(typeof releaseAsync).toBe("function");
		await expect(releaseAsync()).resolves.toBeUndefined();
	});
});

async function asyncFsRead(fs: OpfsFileSystem, path: string): Promise<string> {
	const result = await fs.readTextFile(path);
	if (!result.ok) throw result.error;
	return result.value;
}
