import { describe, expect, it } from "vitest";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { createFindToolDefinition } from "../src/core/tools/find.ts";
import { createGrepToolDefinition } from "../src/core/tools/grep.ts";
import { createLsToolDefinition } from "../src/core/tools/ls.ts";
import { createOpfsOperations } from "../src/core/tools/opfs/operations.ts";
import type { OpfsDirectoryHandle, OpfsEntry, OpfsFileHandle } from "../src/core/tools/opfs/types.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";
import { createWriteToolDefinition } from "../src/core/tools/write.ts";

// ===========================================================================
// In-memory OPFS double: implements the handle surface used by the operations
// and throws DOMException-flavored errors with real OPFS names.
// ===========================================================================

const encoder = new TextEncoder();

type MockNode = { kind: "file"; content: string | Uint8Array } | { kind: "dir"; children: Map<string, MockNode> };

function notFound(path: string): DOMException {
	return new DOMException(`NotFoundError: ${path}`, "NotFoundError");
}

function typeMismatch(path: string): DOMException {
	return new DOMException(`TypeMismatchError: ${path}`, "TypeMismatchError");
}

class MockBlob {
	constructor(private readonly bytes: Uint8Array) {}
	get size(): number {
		return this.bytes.length;
	}
	arrayBuffer(): Promise<ArrayBuffer> {
		return Promise.resolve(this.bytes.slice().buffer as ArrayBuffer);
	}
	slice(start = 0, end = this.bytes.length): MockBlob {
		return new MockBlob(this.bytes.slice(start, end));
	}
}

class MockWritable {
	private chunks: Array<string | Uint8Array> = [];
	constructor(
		private readonly node: MockNode & { kind: "file" },
		readonly _path: string,
	) {}
	async write(data: string | Uint8Array): Promise<void> {
		this.chunks.push(data);
	}
	async close(): Promise<void> {
		this.node.content =
			this.chunks.length === 1 && typeof this.chunks[0] === "string" ? this.chunks[0] : concatBytes(this.chunks);
	}
	async abort(): Promise<void> {
		this.chunks = [];
	}
}

function concatBytes(chunks: Array<string | Uint8Array>): Uint8Array {
	const total = chunks.reduce(
		(sum, chunk) => sum + (typeof chunk === "string" ? encoder.encode(chunk).length : chunk.length),
		0,
	);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(typeof chunk === "string" ? encoder.encode(chunk) : chunk, offset);
		offset += chunk.length;
	}
	return out;
}

class MockFileHandle implements OpfsFileHandle {
	readonly kind = "file" as const;
	constructor(
		private readonly node: MockNode & { kind: "file" },
		readonly name: string,
	) {}
	async getFile(): Promise<MockBlob> {
		return new MockBlob(
			typeof this.node.content === "string" ? encoder.encode(this.node.content) : this.node.content,
		);
	}
	async createWritable(): Promise<MockWritable> {
		return new MockWritable(this.node, this.name);
	}
}

class MockDirHandle implements OpfsDirectoryHandle {
	readonly kind = "directory" as const;
	constructor(
		private readonly node: MockNode & { kind: "dir" },
		readonly name: string,
	) {}

	private child(name: string): MockNode | undefined {
		return this.node.children.get(name);
	}

	async getFileHandle(fileName: string, options?: { create?: boolean }): Promise<OpfsFileHandle> {
		const child = this.child(fileName);
		if (child && child.kind !== "file") throw typeMismatch(`${this.name}/${fileName}`);
		if (!child) {
			if (!options?.create) throw notFound(`${this.name}/${fileName}`);
			const created: MockNode = { kind: "file", content: "" };
			this.node.children.set(fileName, created);
			return new MockFileHandle(created, fileName);
		}
		return new MockFileHandle(child, fileName);
	}

	async getDirectoryHandle(dirName: string, options?: { create?: boolean }): Promise<OpfsDirectoryHandle> {
		const child = this.child(dirName);
		if (child && child.kind !== "dir") throw typeMismatch(`${this.name}/${dirName}`);
		if (!child) {
			if (!options?.create) throw notFound(`${this.name}/${dirName}`);
			const created: MockNode = { kind: "dir", children: new Map() };
			this.node.children.set(dirName, created);
			return new MockDirHandle(created, dirName);
		}
		return new MockDirHandle(child, dirName);
	}

	async removeEntry(entryName: string): Promise<void> {
		if (!this.node.children.delete(entryName)) throw notFound(`${this.name}/${entryName}`);
	}

	async *entries(): AsyncIterableIterator<[string, OpfsEntry]> {
		for (const [name, child] of this.node.children) {
			yield [name, child.kind === "file" ? new MockFileHandle(child, name) : new MockDirHandle(child, name)];
		}
	}
}

function buildTree(root: MockNode & { kind: "dir" }, files: Record<string, string | Uint8Array>): void {
	for (const [path, content] of Object.entries(files)) {
		const parts = path.split("/").filter(Boolean);
		let dir = root;
		for (const part of parts.slice(0, -1)) {
			const next = dir.children.get(part);
			if (!next || next.kind !== "dir") {
				const created: MockNode = { kind: "dir", children: new Map() };
				dir.children.set(part, created);
				dir = created;
			} else {
				dir = next;
			}
		}
		dir.children.set(parts[parts.length - 1], { kind: "file", content });
	}
}

/** Walk the mock tree and expose final file contents by absolute virtual path. */
function snapshot(root: MockNode & { kind: "dir" }, prefix = ""): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [name, child] of root.children) {
		const path = `${prefix}/${name}`;
		if (child.kind === "file") out[path] = child.content;
		else Object.assign(out, snapshot(child, path));
	}
	return out;
}

const WORKSPACE_ROOT = "/workspace/default";

function setup(files: Record<string, string | Uint8Array>) {
	const rootNode: MockNode & { kind: "dir" } = { kind: "dir", children: new Map() };
	buildTree(rootNode, files);
	const rootDir = new MockDirHandle(rootNode, "default");
	const operations = createOpfsOperations(WORKSPACE_ROOT, async () => rootDir);
	const text = (result: { content: Array<{ type: string; text?: string }> }): string =>
		result.content
			.filter((c) => c.type === "text")
			.map((c) => c.text ?? "")
			.join("\n");
	return { operations, snapshot: () => snapshot(rootNode, WORKSPACE_ROOT), text };
}

// ===========================================================================
// Tests
// ===========================================================================

describe("opfs operations", () => {
	describe("read", () => {
		it("reads text files through the read tool", async () => {
			const { operations, text } = setup({ "src/a.txt": "one\ntwo\nthree" });
			const tool = createReadToolDefinition(WORKSPACE_ROOT, {
				operations: operations.read,
				autoResizeImages: false,
			});
			const result = await tool.execute("r1", { path: "src/a.txt" });
			expect(text(result as never)).toBe("one\ntwo\nthree");
		});

		it("reports ENOENT with the path for missing files", async () => {
			const { operations } = setup({});
			const tool = createReadToolDefinition(WORKSPACE_ROOT, {
				operations: operations.read,
				autoResizeImages: false,
			});
			await expect(tool.execute("r2", { path: "missing.txt" })).rejects.toThrow(
				`ENOENT: no such file or directory, stat '${WORKSPACE_ROOT}/missing.txt'`,
			);
		});

		it("lists directories through the read tool", async () => {
			const { operations, text } = setup({ "src/a.txt": "a", "src/sub/b.txt": "b" });
			const tool = createReadToolDefinition(WORKSPACE_ROOT, {
				operations: operations.read,
				autoResizeImages: false,
			});
			const result = await tool.execute("r3", { path: "src" });
			const output = text(result as never);
			expect(output).toContain("Directory listing of");
			expect(output).toContain("a.txt");
			expect(output).toContain("sub/");
		});

		it("detects image MIME from magic bytes", async () => {
			const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d];
			const bytes = new Uint8Array(signature.length + 4);
			signature.forEach((byte, index) => {
				bytes[index] = byte;
			});
			encoder.encode("IHDR").forEach((byte, index) => {
				bytes[signature.length + index] = byte;
			});
			const { operations } = setup({ "img.png": bytes });
			const mime = await operations.read.detectImageMimeType?.(`${WORKSPACE_ROOT}/img.png`);
			expect(mime).toBe("image/png");
		});
	});

	describe("write", () => {
		it("writes files and creates parent directories", async () => {
			const { operations, snapshot } = setup({});
			const tool = createWriteToolDefinition(WORKSPACE_ROOT, { operations: operations.write });
			await tool.execute("w1", { path: "deep/nested/new.txt", content: "hello" });
			expect(snapshot()[`${WORKSPACE_ROOT}/deep/nested/new.txt`]).toBe("hello");
		});

		it("refuses to write over a directory with EISDIR", async () => {
			const { operations } = setup({ "dir/keep.txt": "kept" });
			const tool = createWriteToolDefinition(WORKSPACE_ROOT, { operations: operations.write });
			await expect(tool.execute("w2", { path: "dir", content: "x" })).rejects.toThrow(/EISDIR/);
		});

		it("rejects paths escaping the workspace", async () => {
			const { operations } = setup({});
			const tool = createWriteToolDefinition(WORKSPACE_ROOT, { operations: operations.write });
			await expect(tool.execute("w3", { path: "/elsewhere/x.txt", content: "x" })).rejects.toThrow(/workspace root/);
		});
	});

	describe("edit", () => {
		it("applies exact replacements", async () => {
			const { operations, snapshot } = setup({ "app.ts": "const a = 1;\nconst b = 2;\n" });
			const tool = createEditToolDefinition(WORKSPACE_ROOT, { operations: operations.edit });
			const result = await tool.execute("e1", {
				path: "app.ts",
				edits: [{ oldText: "const b = 2;", newText: "const b = 3;" }],
			});
			expect((result.content[0] as { text: string }).text).toContain("Successfully replaced 1 block(s)");
			expect(snapshot()[`${WORKSPACE_ROOT}/app.ts`]).toBe("const a = 1;\nconst b = 3;\n");
		});

		it("reports ENOENT for missing edit targets", async () => {
			const { operations } = setup({});
			const tool = createEditToolDefinition(WORKSPACE_ROOT, { operations: operations.edit });
			await expect(tool.execute("e2", { path: "nope.ts", edits: [{ oldText: "a", newText: "b" }] })).rejects.toThrow(
				/ENOENT.*Could not edit file|Could not edit file.*ENOENT/s,
			);
		});
	});

	describe("ls", () => {
		it("lists entries sorted with directory suffixes", async () => {
			const { operations, text } = setup({ "b.txt": "b", ".hidden": "h", "a-dir/inner.txt": "i", "a.txt": "a" });
			const tool = createLsToolDefinition(WORKSPACE_ROOT, { operations: operations.ls });
			const result = await tool.execute("l1", { path: "." });
			const lines = text(result as never).split("\n");
			expect(lines[0]).toBe(".hidden");
			expect(lines[1]).toBe("a-dir/");
			expect(lines[2]).toBe("a.txt");
			expect(lines[3]).toBe("b.txt");
		});

		it("reports Path not found for missing directories", async () => {
			const { operations } = setup({});
			const tool = createLsToolDefinition(WORKSPACE_ROOT, { operations: operations.ls });
			await expect(tool.execute("l2", { path: "ghost" })).rejects.toThrow(`Path not found: ${WORKSPACE_ROOT}/ghost`);
		});
	});

	describe("grep", () => {
		it("matches lines with file:line:text output via the grep tool", async () => {
			const { operations, text } = setup({
				"src/a.ts": "const alpha = 1;\nconst beta = 2;\n",
				"src/deep/b.ts": "// beta here\n",
			});
			const tool = createGrepToolDefinition(WORKSPACE_ROOT, { operations: operations.grep });
			const result = await tool.execute("g1", { pattern: "beta", path: "src" });
			const lines = text(result as never).split("\n");
			expect(lines).toContain("deep/b.ts:1: // beta here");
			expect(lines).toContain("a.ts:2: const beta = 2;");
		});

		it("respects .gitignore, skips .git and binary files", async () => {
			const { operations, text } = setup({
				".gitignore": "ignored.txt\n",
				"ignored.txt": "secret needle",
				".git/config": "needle in git",
				"bin.log": "needle\x00 after nul",
				"keep.txt": "needle found",
			});
			const tool = createGrepToolDefinition(WORKSPACE_ROOT, { operations: operations.grep });
			const result = await tool.execute("g2", { pattern: "needle", path: "." });
			expect(text(result as never)).toBe("keep.txt:1: needle found");
		});

		it("supports ignoreCase, literal, glob and limit early-stop", async () => {
			const { operations, text } = setup({
				"a.ts": "HELLO\nhello\nhello\n",
				"b.md": "hello\n",
			});
			const tool = createGrepToolDefinition(WORKSPACE_ROOT, { operations: operations.grep });

			const caseResult = await tool.execute("g3", { pattern: "hello", ignoreCase: true, path: "." });
			expect(text(caseResult as never).split("\n")).toEqual([
				"a.ts:1: HELLO",
				"a.ts:2: hello",
				"a.ts:3: hello",
				"b.md:1: hello",
			]);

			const globResult = await tool.execute("g4", { pattern: "hello", glob: "*.ts", path: "." });
			expect(text(globResult as never)).not.toContain("b.md");

			const literalResult = await tool.execute("g5", { pattern: "a.c", literal: true, path: "." });
			expect(text(literalResult as never)).toContain("No matches found");

			const limitResult = await tool.execute("g6", { pattern: "hello", limit: 2, path: "." });
			expect(text(limitResult as never)).toContain(
				"[2 matches limit reached. Use limit=4 for more, or refine pattern]",
			);
		});

		it("searches a single file path", async () => {
			const { operations, text } = setup({ "only.txt": "no\nyes\n" });
			const tool = createGrepToolDefinition(WORKSPACE_ROOT, { operations: operations.grep });
			const result = await tool.execute("g7", { pattern: "yes", path: "only.txt" });
			expect(text(result as never)).toBe("only.txt:2: yes");
		});

		it("renders context lines through readFile", async () => {
			const { operations, text } = setup({ "ctx.txt": "before\nmatch\nafter\n" });
			const tool = createGrepToolDefinition(WORKSPACE_ROOT, { operations: operations.grep });
			const result = await tool.execute("g8", { pattern: "match", context: 1, path: "." });
			expect(text(result as never).split("\n")).toEqual([
				"ctx.txt-1- before",
				"ctx.txt:2: match",
				"ctx.txt-3- after",
			]);
		});

		it("reports missing search paths", async () => {
			const { operations } = setup({});
			const tool = createGrepToolDefinition(WORKSPACE_ROOT, { operations: operations.grep });
			await expect(tool.execute("g9", { pattern: "x", path: "ghost" })).rejects.toThrow(
				`Path not found: ${WORKSPACE_ROOT}/ghost`,
			);
		});
	});

	describe("find", () => {
		it("matches glob patterns with relative output", async () => {
			const { operations, text } = setup({
				"a.ts": "",
				"src/b.ts": "",
				"src/nested/c.ts": "",
				"readme.md": "",
			});
			const tool = createFindToolDefinition(WORKSPACE_ROOT, { operations: operations.find });

			const flat = text((await tool.execute("f1", { pattern: "*.ts", path: "." })) as never).split("\n");
			expect(flat).toEqual(["a.ts", "src/b.ts", "src/nested/c.ts"]);

			const nested = text((await tool.execute("f2", { pattern: "src/**/*.ts", path: "." })) as never).split("\n");
			expect(nested).toEqual(["src/b.ts", "src/nested/c.ts"]);
		});

		it("respects .gitignore and includes hidden files", async () => {
			const { operations, text } = setup({
				".gitignore": "skip.txt\n",
				"skip.txt": "",
				".secret/h.txt": "",
				"kept.txt": "",
			});
			const tool = createFindToolDefinition(WORKSPACE_ROOT, { operations: operations.find });
			const output = text((await tool.execute("f3", { pattern: "**/*", path: "." })) as never);
			expect(output).toContain(".secret/h.txt");
			expect(output).toContain("kept.txt");
			expect(output).toContain(".gitignore");
			expect(output).not.toContain("skip.txt");
		});

		it("honors the injected ignore list and limit", async () => {
			const { operations, text } = setup({
				"node_modules/pkg/index.js": "",
				"index.js": "",
				"a.js": "",
				"b.js": "",
				"c.js": "",
			});
			const tool = createFindToolDefinition(WORKSPACE_ROOT, { operations: operations.find });
			const output = text((await tool.execute("f4", { pattern: "**/*.js", path: ".", limit: 2 })) as never);
			expect(output).toContain("[2 results limit reached]");
			expect(output).not.toContain("node_modules");
		});

		it("reports missing search paths", async () => {
			const { operations } = setup({});
			const tool = createFindToolDefinition(WORKSPACE_ROOT, { operations: operations.find });
			await expect(tool.execute("f5", { pattern: "*.ts", path: "ghost" })).rejects.toThrow(
				`Path not found: ${WORKSPACE_ROOT}/ghost`,
			);
		});
	});
});
