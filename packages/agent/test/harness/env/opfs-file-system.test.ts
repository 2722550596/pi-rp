import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OpfsFileSystem } from "../../../src/harness/env/opfs/file-system.ts";
import type { OpfsDirectoryHandle } from "../../../src/harness/env/opfs/types.ts";
import { JsonlSessionRepo, type SessionRepo } from "../../../src/harness/session/index.ts";
import {
	createSessionBackendConformance,
	type SessionBackendFixture,
} from "../../../src/harness/session/testing/index.ts";
import { createMockOpfsRoot, type MockDirectoryHandle } from "./opfs-mock.ts";

const tempDirs: string[] = [];

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-agent-opfs-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function createFs(root: MockDirectoryHandle, cwd = "/workspace/default"): OpfsFileSystem {
	return new OpfsFileSystem(root as OpfsDirectoryHandle, cwd);
}

function withDefaultSessionCwd(repository: JsonlSessionRepo, cwd: string): SessionRepo {
	return {
		create(options) {
			const optionsWithCwd = { ...options, cwd };
			return repository.create(optionsWithCwd);
		},
		open: (metadata) => repository.open(metadata),
		list: () => repository.list(),
		delete: (metadata) => repository.delete(metadata),
		fork(source, options) {
			const optionsWithCwd = { ...options, cwd };
			return repository.fork(source, optionsWithCwd);
		},
	};
}

for (const withMove of [true, false]) {
	const label = withMove ? "move tier available" : "copy tier (no move)";

	describe(`OpfsFileSystem JSONL conformance (${label})`, () => {
		const conformance = createSessionBackendConformance(async () => {
			const root = createMockOpfsRoot(createTempDir(), { withMove });
			const fs = createFs(root);
			const repository = withDefaultSessionCwd(
				new JsonlSessionRepo({ fs, sessionsRoot: "/state/agent/sessions" }),
				"/workspace/default",
			);
			return {
				repository,
				[Symbol.asyncDispose]: () => Promise.resolve(),
			} satisfies SessionBackendFixture;
		});

		for (const group of new Set(conformance.map((testCase) => testCase.group))) {
			describe(group, () => {
				for (const testCase of conformance.filter((candidate) => candidate.group === group)) {
					it(testCase.name, () => testCase.run());
				}
			});
		}
	});
}

describe("OpfsFileSystem behavior", () => {
	it("round-trips text and binary writes with implicit parent creation", async () => {
		const fs = createFs(createMockOpfsRoot(createTempDir(), { withMove: false }));
		const written = await fs.writeFile("/state/agent/settings.json", '{"model":"claude"}');
		expect(written.ok).toBe(true);
		const text = await fs.readTextFile("/state/agent/settings.json");
		expect(text).toEqual({ ok: true, value: '{"model":"claude"}' });

		const binary = await fs.writeFile("/workspace/default/blob.bin", new Uint8Array([0, 1, 254, 255]));
		expect(binary.ok).toBe(true);
		const read = await fs.readBinaryFile("/workspace/default/blob.bin");
		expect(read.ok).toBe(true);
		if (read.ok) expect([...read.value]).toEqual([0, 1, 254, 255]);
	});

	it("appends via keepExistingData + seek without truncation", async () => {
		const fs = createFs(createMockOpfsRoot(createTempDir(), { withMove: false }));
		await fs.writeFile("/state/agent/log.txt", "one\n");
		const appended = await fs.appendFile("/state/agent/log.txt", "two\n");
		expect(appended.ok).toBe(true);
		const text = await fs.readTextFile("/state/agent/log.txt");
		expect(text.ok && text.value).toBe("one\ntwo\n");
	});

	it("implements the copy rename tier when move is unavailable", async () => {
		const root = createMockOpfsRoot(createTempDir(), { withMove: false });
		const fs = createFs(root);
		await fs.writeFile("/state/agent/sessions/a.jsonl.tmp", "staged");
		const renamed = await fs.renameFile("/state/agent/sessions/a.jsonl.tmp", "/state/agent/sessions/a.jsonl");
		expect(renamed.ok).toBe(true);
		const tmpGone = await fs.exists("/state/agent/sessions/a.jsonl.tmp");
		const published = await fs.readTextFile("/state/agent/sessions/a.jsonl");
		expect(tmpGone).toEqual({ ok: true, value: false });
		expect(published).toEqual({ ok: true, value: "staged" });
	});

	it("rename replaces an existing destination and reports missing sources", async () => {
		const root = createMockOpfsRoot(createTempDir(), { withMove: true });
		const fs = createFs(root);
		await fs.writeFile("/state/agent/a.txt", "new");
		await fs.writeFile("/state/agent/b.txt", "old");
		const renamed = await fs.renameFile("/state/agent/a.txt", "/state/agent/b.txt");
		expect(renamed.ok).toBe(true);
		expect(await fs.readTextFile("/state/agent/b.txt")).toEqual({ ok: true, value: "new" });
		expect(await fs.exists("/state/agent/a.txt")).toEqual({ ok: true, value: false });

		const missing = await fs.renameFile("/state/agent/ghost.txt", "/state/agent/c.txt");
		expect(missing.ok).toBe(false);
		if (!missing.ok) expect(missing.error.code).toBe("not_found");
	});

	it("maps missing reads to not_found and directory reads to is_directory", async () => {
		const fs = createFs(createMockOpfsRoot(createTempDir(), { withMove: true }));
		await fs.createDir("/state/agent/themes");
		const missing = await fs.readTextFile("/state/agent/none.json");
		expect(missing.ok).toBe(false);
		if (!missing.ok) expect(missing.error.code).toBe("not_found");
		const isDirectory = await fs.readTextFile("/state/agent/themes");
		expect(isDirectory.ok).toBe(false);
		if (!isDirectory.ok) expect(isDirectory.error.code).toBe("is_directory");
	});

	it("reports file metadata and directory listings with kind/size/mtime", async () => {
		const root = createMockOpfsRoot(createTempDir(), { withMove: true });
		const fs = createFs(root);
		await fs.writeFile("/state/agent/models.json", "1234567890");
		await fs.createDir("/state/agent/themes");
		const info = await fs.fileInfo("/state/agent/models.json");
		expect(info.ok).toBe(true);
		if (info.ok) {
			expect(info.value.kind).toBe("file");
			expect(info.value.size).toBe(10);
			expect(info.value.mtimeMs).toBeGreaterThan(0);
			expect(info.value.name).toBe("models.json");
		}
		const listed = await fs.listDir("/state/agent");
		expect(listed.ok).toBe(true);
		if (listed.ok) {
			const names = listed.value.map((entry) => `${entry.name}:${entry.kind}`).sort();
			expect(names).toEqual(["models.json:file", "themes:directory"]);
		}
		const listedFile = await fs.listDir("/state/agent/models.json");
		expect(listedFile.ok).toBe(false);
		if (!listedFile.ok) expect(listedFile.error.code).toBe("not_directory");
	});

	it("createDir honors recursive=false and remove honors force/recursive semantics", async () => {
		const fs = createFs(createMockOpfsRoot(createTempDir(), { withMove: true }));
		const shallowMissingParent = await fs.createDir("/state/agent/prompts", { recursive: false });
		expect(shallowMissingParent.ok).toBe(false);
		if (!shallowMissingParent.ok) expect(shallowMissingParent.error.code).toBe("not_found");

		await fs.createDir("/state/agent", { recursive: true });
		const shallow = await fs.createDir("/state/agent/prompts", { recursive: false });
		expect(shallow.ok).toBe(true);

		await fs.writeFile("/state/agent/prompts/a.md", "x");
		const nonRecursiveRemove = await fs.remove("/state/agent/prompts");
		expect(nonRecursiveRemove.ok).toBe(false);
		if (!nonRecursiveRemove.ok) expect(nonRecursiveRemove.error.code).toBe("invalid");

		const recursiveRemove = await fs.remove("/state/agent/prompts", { recursive: true });
		expect(recursiveRemove.ok).toBe(true);
		const forcedMissing = await fs.remove("/state/agent/prompts", { force: true });
		expect(forcedMissing.ok).toBe(true);
		const strictMissing = await fs.remove("/state/agent/prompts");
		expect(strictMissing.ok).toBe(false);
		if (!strictMissing.ok) expect(strictMissing.error.code).toBe("not_found");
	});

	it("readTextLines honors maxLines and trailing-newline semantics", async () => {
		const fs = createFs(createMockOpfsRoot(createTempDir(), { withMove: true }));
		await fs.writeFile("/state/agent/s.jsonl", '{"n":1}\n{"n":2}\n{"n":3}\n');
		const all = await fs.readTextLines("/state/agent/s.jsonl");
		expect(all).toEqual({ ok: true, value: ['{"n":1}', '{"n":2}', '{"n":3}'] });
		const head = await fs.readTextLines("/state/agent/s.jsonl", { maxLines: 1 });
		expect(head).toEqual({ ok: true, value: ['{"n":1}'] });
		const zero = await fs.readTextLines("/state/agent/s.jsonl", { maxLines: 0 });
		expect(zero).toEqual({ ok: true, value: [] });
		await fs.writeFile("/state/agent/t.jsonl", '{"n":1}\n{"n":2}');
		const unterminated = await fs.readTextLines("/state/agent/t.jsonl");
		expect(unterminated).toEqual({ ok: true, value: ['{"n":1}', '{"n":2}'] });
	});

	it("canonicalPath normalizes and rejects missing paths", async () => {
		const fs = createFs(createMockOpfsRoot(createTempDir(), { withMove: true }));
		const nested = await fs.canonicalPath("/state/agent/../agent/sessions");
		expect(nested.ok).toBe(false);
		if (!nested.ok) expect(nested.error.code).toBe("not_found");
		await fs.createDir("/state/agent/sessions", { recursive: true });
		const canonical = await fs.canonicalPath("/state/agent/../agent/sessions");
		expect(canonical).toEqual({ ok: true, value: "/state/agent/sessions" });
	});

	it("creates temp objects under the reserved state tmp subtree", async () => {
		const fs = createFs(createMockOpfsRoot(createTempDir(), { withMove: true }));
		const dir = await fs.createTempDir("skill-");
		expect(dir.ok).toBe(true);
		if (dir.ok) expect(dir.value.startsWith("/state/tmp/skill-")).toBe(true);
		const file = await fs.createTempFile({ prefix: "x-", suffix: ".tmp" });
		expect(file.ok).toBe(true);
		if (file.ok) {
			expect(file.value.startsWith("/state/tmp/")).toBe(true);
			expect(await fs.exists(file.value)).toEqual({ ok: true, value: true });
		}
	});

	it("resolves relative paths against the workspace cwd", async () => {
		const fs = createFs(createMockOpfsRoot(createTempDir(), { withMove: true }), "/workspace/default");
		const written = await fs.writeFile("notes/hello.txt", "hi");
		expect(written.ok).toBe(true);
		const absolute = await fs.absolutePath("notes/hello.txt");
		expect(absolute).toEqual({ ok: true, value: "/workspace/default/notes/hello.txt" });
		expect(await fs.readTextFile("/workspace/default/notes/hello.txt")).toEqual({ ok: true, value: "hi" });
	});
});
