import { minimatch } from "minimatch";
import { detectSupportedImageMimeType, IMAGE_TYPE_SNIFF_BYTES } from "../../../utils/mime-bytes.ts";
import type { EditOperations } from "../edit.ts";
import type { FindOperations } from "../find.ts";
import type { GrepOperations, GrepSearchOp } from "../grep.ts";
import type { LsOperations } from "../ls.ts";
import type { ReadDirectoryEntry, ReadOperations } from "../read.ts";
import type { WriteOperations } from "../write.ts";
import { GitIgnoreChain } from "./gitignore.ts";
import type { OpfsDirectoryHandle, OpfsFileHandle } from "./types.ts";
import { walkTree } from "./walk.ts";

/** Files whose first bytes contain NUL are skipped by content search (rg binary detection parity). */
const BINARY_SNIFF_BYTES = 8192;

// ignoreBOM:true keeps a leading U+FEFF in the output (Buffer.toString("utf-8") parity).
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

// ---------------------------------------------------------------------------
// Virtual path helpers (posix strings; no node:path — this module is browser-safe)
// ---------------------------------------------------------------------------

/** Lexically resolve "." / ".." / "//" on an absolute posix-style path. */
function normalizeAbsolutePath(input: string): string {
	const parts: string[] = [];
	for (const part of input.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			// Popping past the root clamps; containment is checked by the caller.
			if (parts.length > 0) parts.pop();
			continue;
		}
		parts.push(part);
	}
	return `/${parts.join("/")}`;
}

export interface OpfsWorkspace {
	/** Normalized workspace root (no trailing slash). */
	readonly root: string;
	/** Map an absolute virtual path to segments relative to the workspace root. Throws when it escapes the workspace. */
	toRel(absolutePath: string): string[];
	/** Join workspace-relative segments back into an absolute virtual path. */
	join(relParts: string[]): string;
}

function createWorkspace(workspaceRoot: string): OpfsWorkspace {
	const root = workspaceRoot.replace(/\/+$/, "") || "/";
	const rootPrefix = root === "/" ? "" : root;
	return {
		root,
		toRel(absolutePath: string): string[] {
			const abs = normalizeAbsolutePath(absolutePath.startsWith("/") ? absolutePath : `${root}/${absolutePath}`);
			if (abs !== rootPrefix && !abs.startsWith(`${rootPrefix}/`)) {
				throw new Error(`Path is outside the workspace root (${root}): ${absolutePath}`);
			}
			const rel = abs.slice(rootPrefix.length).replace(/^\//, "");
			return rel === "" ? [] : rel.split("/");
		},
		join(relParts: string[]): string {
			return relParts.length === 0 ? root : `${root}/${relParts.join("/")}`;
		},
	};
}

// ---------------------------------------------------------------------------
// Error mapping (14-E §3 步骤 9): OPFS DOMException names → Node errno wording
// ---------------------------------------------------------------------------

function errorName(err: unknown): string | undefined {
	return (err as { name?: string } | null)?.name;
}

function mapOpfsError(err: unknown, syscall: string, absolutePath: string, mismatchCode: "EISDIR" | "ENOTDIR"): Error {
	switch (errorName(err)) {
		case "NotFoundError":
			return new Error(`ENOENT: no such file or directory, ${syscall} '${absolutePath}'`);
		case "TypeMismatchError":
			return new Error(`${mismatchCode}: illegal operation, ${syscall} '${absolutePath}'`);
		case "QuotaExceededError":
		case "InvalidModificationError":
			return new Error(`ENOSPC: no space left on device, ${syscall} '${absolutePath}'`);
		case "AbortError":
			return new Error("Operation aborted");
		default:
			return err instanceof Error ? err : new Error(String(err));
	}
}

// ---------------------------------------------------------------------------
// Glob matching (fd/globset parity): slash-free patterns match the basename,
// path patterns match the full relative path with fd's implicit `**/` prefix.
// ---------------------------------------------------------------------------

function makeGlobMatcher(pattern: string): (relPath: string) => boolean {
	if (!pattern.includes("/")) {
		const re = minimatch.makeRe(pattern, { dot: true });
		if (!re) throw new Error(`invalid glob pattern: ${pattern}`);
		return (relPath) => {
			const base = relPath.slice(relPath.lastIndexOf("/") + 1);
			return re.test(base);
		};
	}
	let effective = pattern;
	if (!pattern.startsWith("/") && !pattern.startsWith("**/") && pattern !== "**") {
		effective = `**/${pattern}`;
	}
	const re = minimatch.makeRe(effective, { dot: true });
	if (!re) throw new Error(`invalid glob pattern: ${pattern}`);
	return (relPath) => re.test(relPath);
}

/**
 * Browser (OPFS) implementations of the read/write/edit/ls/grep/find tool
 * Operations, operating on a virtual workspace subtree rooted at
 * `workspaceRoot` (契约 §6.1 `/workspace/<project>`). Pure JS — zero `node:`
 * imports; handles arrive via `getDir`, which resolves the workspace
 * directory from the OPFS root (`getDir(["workspace", "default"])` for
 * `workspaceRoot === "/workspace/default"`).
 *
 * Error semantics align with the Node default operations (ENOENT/EISDIR/ENOSPC
 * wording including the offending path) so model-visible failures are
 * profile-independent.
 */
export function createOpfsOperations(
	workspaceRoot: string,
	getDir: (relParts: string[]) => Promise<OpfsDirectoryHandle>,
): {
	read: ReadOperations;
	write: WriteOperations;
	edit: EditOperations;
	ls: LsOperations;
	grep: GrepOperations & { search: GrepSearchOp };
	find: FindOperations;
} {
	const workspace = createWorkspace(workspaceRoot);
	const rootParts = workspace.root === "/" ? [] : workspace.root.slice(1).split("/");
	let rootPromise: Promise<OpfsDirectoryHandle> | undefined;
	const rootDir = (): Promise<OpfsDirectoryHandle> => {
		if (!rootPromise) {
			rootPromise = getDir(rootParts);
			rootPromise.catch(() => {
				rootPromise = undefined;
			});
		}
		return rootPromise;
	};

	// Directory-handle cache: repeated tool calls against the same subtree skip
	// re-descent (the warm-path lever from the 14-E §4 measurements).
	const dirCache = new Map<string, Promise<OpfsDirectoryHandle>>();
	const cachedDir = (absPath: string, resolve: () => Promise<OpfsDirectoryHandle>): Promise<OpfsDirectoryHandle> => {
		const cached = dirCache.get(absPath);
		if (cached) return cached;
		const promise = resolve();
		promise.catch(() => dirCache.delete(absPath));
		dirCache.set(absPath, promise);
		return promise;
	};

	async function rootDirChecked(): Promise<OpfsDirectoryHandle> {
		try {
			return await rootDir();
		} catch (err) {
			throw mapOpfsError(err, "scandir", workspace.root, "ENOTDIR");
		}
	}

	async function resolveDir(absolutePath: string): Promise<OpfsDirectoryHandle> {
		const rel = workspace.toRel(absolutePath);
		if (rel.length === 0) return rootDirChecked();
		return cachedDir(workspace.join(rel), async () => {
			let dir = await rootDirChecked();
			for (const part of rel) {
				try {
					dir = await dir.getDirectoryHandle(part);
				} catch (err) {
					throw mapOpfsError(err, "scandir", absolutePath, "ENOTDIR");
				}
			}
			return dir;
		});
	}

	async function resolveEntry(
		absolutePath: string,
		syscall = "stat",
	): Promise<{ kind: "file" | "directory"; file?: OpfsFileHandle; dir?: OpfsDirectoryHandle }> {
		const rel = workspace.toRel(absolutePath);
		if (rel.length === 0) return { kind: "directory", dir: await rootDirChecked() };
		let dir = await rootDirChecked();
		for (let i = 0; i < rel.length - 1; i++) {
			try {
				dir = await dir.getDirectoryHandle(rel[i]);
			} catch (err) {
				throw mapOpfsError(err, syscall, absolutePath, "ENOTDIR");
			}
		}
		const last = rel[rel.length - 1];
		try {
			return { kind: "file", file: await dir.getFileHandle(last) };
		} catch (fileErr) {
			// TypeMismatchError on getFileHandle means the entry is a directory —
			// try the directory handle before reporting failure.
			try {
				return { kind: "directory", dir: await dir.getDirectoryHandle(last) };
			} catch {
				throw mapOpfsError(fileErr, syscall, absolutePath, "EISDIR");
			}
		}
	}

	async function fileBytes(file: OpfsFileHandle, absolutePath: string, syscall: string): Promise<Uint8Array> {
		try {
			return new Uint8Array(await (await file.getFile()).arrayBuffer());
		} catch (err) {
			throw mapOpfsError(err, syscall, absolutePath, "EISDIR");
		}
	}

	async function requireFile(absolutePath: string, syscall: string): Promise<OpfsFileHandle> {
		const entry = await resolveEntry(absolutePath).catch((err) => throwMapped(err, syscall, absolutePath, "ENOTDIR"));
		if (entry.kind === "file" && entry.file) return entry.file;
		throw new Error(`EISDIR: illegal operation on a directory, ${syscall} '${absolutePath}'`);
	}

	function throwMapped(err: unknown, syscall: string, absolutePath: string, mismatch: "EISDIR" | "ENOTDIR"): never {
		throw mapOpfsError(err, syscall, absolutePath, mismatch);
	}

	async function requireDirectory(absolutePath: string, syscall: string): Promise<OpfsDirectoryHandle> {
		const entry = await resolveEntry(absolutePath).catch((err) => throwMapped(err, syscall, absolutePath, "ENOTDIR"));
		if (entry.kind === "directory" && entry.dir) return entry.dir;
		throw new Error(`ENOTDIR: not a directory, ${syscall} '${absolutePath}'`);
	}

	const exists = async (absolutePath: string): Promise<boolean> => {
		try {
			await resolveEntry(absolutePath);
			return true;
		} catch {
			return false;
		}
	};

	const stat = async (absolutePath: string): Promise<{ isDirectory: () => boolean }> => {
		const entry = await resolveEntry(absolutePath);
		return { isDirectory: () => entry.kind === "directory" };
	};

	const listDirectory = async (absolutePath: string): Promise<ReadDirectoryEntry[]> => {
		const dir = await requireDirectory(absolutePath, "scandir");
		const out: ReadDirectoryEntry[] = [];
		for await (const [name, handle] of dir.entries()) {
			out.push({ name, isDirectory: handle.kind === "directory" });
		}
		return out;
	};

	const readFileBytes = async (absolutePath: string): Promise<Uint8Array> => {
		const file = await requireFile(absolutePath, "open");
		return fileBytes(file, absolutePath, "read");
	};

	const readFileText = async (file: OpfsFileHandle, absolutePath: string): Promise<string> => {
		return decoder.decode(await fileBytes(file, absolutePath, "read"));
	};

	async function writeFileString(absolutePath: string, content: string): Promise<void> {
		const rel = workspace.toRel(absolutePath);
		if (rel.length === 0) {
			throw new Error(`EISDIR: illegal operation on a directory, open '${absolutePath}'`);
		}
		let dir = await rootDirChecked();
		try {
			for (let i = 0; i < rel.length - 1; i++) {
				dir = await dir.getDirectoryHandle(rel[i], { create: true });
			}
			const file = await dir.getFileHandle(rel[rel.length - 1], { create: true });
			const writable = await file.createWritable();
			await writable.write(content);
			// close() is the atomic replacement point (11-B §证据链).
			await writable.close();
		} catch (err) {
			throw mapOpfsError(err, "open", absolutePath, "EISDIR");
		}
	}

	// ----------------------------------------------------------------- read --

	const read: ReadOperations = {
		readFile: readFileBytes,
		access: async (absolutePath) => {
			// OPFS has no permission bits: existence is the readability floor.
			await resolveEntry(absolutePath, "access");
		},
		detectImageMimeType: async (absolutePath) => {
			const file = await requireFile(absolutePath, "open");
			const bytes = await fileBytes(file, absolutePath, "read");
			return detectSupportedImageMimeType(bytes.subarray(0, IMAGE_TYPE_SNIFF_BYTES));
		},
		stat,
		listDirectory,
	};

	// ---------------------------------------------------------------- write --

	const write: WriteOperations = {
		writeFile: writeFileString,
		mkdir: async (dirPath) => {
			const rel = workspace.toRel(dirPath);
			let dir = await rootDirChecked();
			try {
				for (const part of rel) {
					dir = await dir.getDirectoryHandle(part, { create: true });
				}
			} catch (err) {
				throw mapOpfsError(err, "mkdir", dirPath, "ENOTDIR");
			}
		},
	};

	// ----------------------------------------------------------------- edit --

	const edit: EditOperations = {
		readFile: readFileBytes,
		writeFile: writeFileString,
		access: read.access,
	};

	// ------------------------------------------------------------------- ls --

	const ls: LsOperations = {
		exists,
		stat,
		readdir: async (absolutePath) => {
			const dir = await requireDirectory(absolutePath, "scandir");
			const names: string[] = [];
			for await (const [name] of dir.entries()) names.push(name);
			return names;
		},
	};

	// ----------------------------------------------------------------- grep --

	async function search(args: {
		pattern: string;
		path: string;
		glob?: string;
		ignoreCase: boolean;
		literal: boolean;
		limit: number;
		signal?: AbortSignal;
	}): Promise<Array<{ filePath: string; lineNumber: number }>> {
		const regexSource = args.literal ? args.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : args.pattern;
		// Throws SyntaxError on invalid patterns; the tool surfaces the message.
		const regex = new RegExp(regexSource, args.ignoreCase ? "i" : "");
		const globMatcher = args.glob ? makeGlobMatcher(args.glob) : undefined;
		const results: Array<{ filePath: string; lineNumber: number }> = [];

		const collectFromLines = (filePath: string, text: string): boolean => {
			const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
			for (let i = 0; i < lines.length; i++) {
				if (regex.test(lines[i])) {
					results.push({ filePath, lineNumber: i + 1 });
					if (results.length >= args.limit) return false;
				}
			}
			return true;
		};

		const target = await resolveEntry(args.path);
		if (target.kind === "file" && target.file) {
			// rg parity: explicitly given files are searched verbatim (glob filters
			// apply only to traversed paths).
			const bytes = await fileBytes(target.file, args.path, "read");
			if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return results;
			collectFromLines(args.path, decoder.decode(bytes));
			return results;
		}
		if (!target.dir) return results;
		await walkTree({
			rootDir: target.dir,
			rootPath: args.path,
			gitignore: new GitIgnoreChain(),
			signal: args.signal,
			callbacks: {
				readText: readFileText,
				onFile: async (absolutePath, _relParts, file) => {
					if (args.signal?.aborted) return false;
					if (globMatcher && !globMatcher(absolutePath.slice(args.path.length + 1))) return;
					const bytes = await fileBytes(file, absolutePath, "read");
					if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return;
					return collectFromLines(absolutePath, decoder.decode(bytes));
				},
			},
		});
		return results;
	}

	const grep: GrepOperations & { search: GrepSearchOp } = {
		isDirectory: async (absolutePath) => {
			const entry = await resolveEntry(absolutePath);
			return entry.kind === "directory";
		},
		readFile: async (absolutePath) => {
			const file = await requireFile(absolutePath, "read");
			return readFileText(file, absolutePath);
		},
		search,
	};

	// ----------------------------------------------------------------- find --

	const find: FindOperations = {
		exists,
		glob: async (pattern, searchPath, options) => {
			const searchDir = await resolveDir(searchPath);
			const matcher = makeGlobMatcher(pattern);
			const extraIgnores: RegExp[] = [];
			for (const ignorePattern of options.ignore ?? []) {
				const re = minimatch.makeRe(ignorePattern, { dot: true });
				if (re) extraIgnores.push(re);
			}
			const results: string[] = [];
			await walkTree({
				rootDir: searchDir,
				rootPath: searchPath,
				gitignore: new GitIgnoreChain(),
				callbacks: {
					readText: readFileText,
					onFile: (absolutePath, relParts) => {
						const relPath = relParts.join("/");
						if (extraIgnores.some((re) => re.test(relPath))) return;
						if (!matcher(relPath)) return;
						results.push(absolutePath);
						return results.length >= options.limit ? false : undefined;
					},
				},
			});
			return results;
		},
	};

	return { read, write, edit, ls, grep, find };
}
