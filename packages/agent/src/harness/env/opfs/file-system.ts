import { err, FileError, type FileInfo, type FileSystem, ok, type Result } from "../../types.ts";
import { type OpfsDirectoryHandle, type OpfsFileHandle, opfsErrorCode } from "./types.ts";
import { joinVirtualPath, normalizeVirtualPath, splitVirtualPath } from "./virtual-path.ts";

/** Temporary objects live in a reserved state-subtree directory; the workspace stays agent-tool visible only. */
const TEMP_ROOT = "/state/tmp";

function toFileError(error: unknown, path: string, overrideCode?: FileError["code"]): FileError {
	if (error instanceof FileError) return error;
	return new FileError(overrideCode ?? opfsErrorCode(error), describeOpfsFailure(error), path, toErrorCause(error));
}

function describeOpfsFailure(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function toErrorCause(error: unknown): Error | undefined {
	return error instanceof Error ? error : undefined;
}

function isTypeMismatch(error: unknown): boolean {
	return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "TypeMismatchError";
}

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "NotFoundError";
}

function isAbortLike(error: unknown): boolean {
	return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError";
}

function splitPath(path: string, cwd: string): { parentSegments: string[]; name: string } {
	const segments = splitVirtualPath(normalizeVirtualPath(path, cwd));
	const name = segments.pop();
	if (name === undefined) {
		throw new FileError("invalid", "Cannot address the namespace root as a directory entry", path);
	}
	return { parentSegments: segments, name };
}

function fileInfoOf(path: string, kind: "file" | "directory", size: number, mtimeMs: number): FileInfo {
	const segments = splitVirtualPath(path);
	return { name: segments[segments.length - 1] ?? "/", path, kind, size, mtimeMs };
}

function abortGuard<T>(signal: AbortSignal | undefined, path: string): Result<T, FileError> | undefined {
	return signal?.aborted ? err(new FileError("aborted", "aborted", path)) : undefined;
}

/**
 * Browser-profile {@link FileSystem} over the OPFS namespace rooted at the handle given to
 * `createBrowserHarnessEnv`. Paths are virtual absolute POSIX strings (`/state/**`, `/workspace/**` — contract §6.1);
 * relative paths resolve against {@link cwd}, the workspace subtree root.
 *
 * Never throws: every operation encodes failures in the returned `Result` (types.ts contract), with DOMException
 * names mapped per the frozen table (11-B §7.2). `renameFile` implements the three-tier strategy mandated by 11-B
 * §7.1: non-standard `move` probe → copy-through-`createWritable` (close is the atomic replace point) + `removeEntry`.
 */
export class OpfsFileSystem implements FileSystem {
	cwd: string;
	private readonly root: OpfsDirectoryHandle;

	constructor(root: OpfsDirectoryHandle, cwd: string) {
		this.root = root;
		this.cwd = cwd;
	}

	private async resolveDirectory(path: string): Promise<OpfsDirectoryHandle> {
		const segments = splitVirtualPath(normalizeVirtualPath(path, this.cwd));
		let handle = this.root;
		for (const segment of segments) {
			handle = await handle.getDirectoryHandle(segment);
		}
		return handle;
	}

	private async resolveDirectoryOrCreate(path: string, create: boolean): Promise<OpfsDirectoryHandle> {
		const segments = splitVirtualPath(normalizeVirtualPath(path, this.cwd));
		let handle = this.root;
		for (const segment of segments) {
			handle = await handle.getDirectoryHandle(segment, { create });
		}
		return handle;
	}

	private async resolveFileHandle(path: string, options?: { create?: boolean }): Promise<OpfsFileHandle> {
		const { parentSegments, name } = splitPath(path, this.cwd);
		const parent = await this.resolveDirectoryBySegments(parentSegments, options?.create === true);
		return parent.getFileHandle(name, { create: options?.create === true });
	}

	private async resolveDirectoryBySegments(segments: string[], create: boolean): Promise<OpfsDirectoryHandle> {
		let handle = this.root;
		for (const segment of segments) {
			handle = await handle.getDirectoryHandle(segment, { create });
		}
		return handle;
	}

	private async probeKind(path: string): Promise<Result<"file" | "directory", FileError>> {
		const absolute = normalizeVirtualPath(path, this.cwd);
		if (splitVirtualPath(absolute).length === 0) return ok("directory");
		const { parentSegments, name } = splitPath(absolute, "/");
		const parent = await this.resolveDirectoryBySegments(parentSegments, false);
		try {
			await parent.getFileHandle(name);
			return ok("file");
		} catch (fileError) {
			if (isTypeMismatch(fileError)) return ok("directory");
			if (!isNotFound(fileError)) throw fileError;
			try {
				await parent.getDirectoryHandle(name);
				return ok("directory");
			} catch (dirError) {
				if (isTypeMismatch(dirError)) return ok("file");
				throw dirError;
			}
		}
	}

	async absolutePath(path: string): Promise<Result<string, FileError>> {
		return ok(normalizeVirtualPath(path, this.cwd));
	}

	async joinPath(parts: string[]): Promise<Result<string, FileError>> {
		return ok(joinVirtualPath(parts));
	}

	async readTextFile(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
		const absolute = normalizeVirtualPath(path, this.cwd);
		const aborted = abortGuard<string>(abortSignal, absolute);
		if (aborted) return aborted;
		try {
			const handle = await this.resolveFileHandle(absolute);
			const file = await handle.getFile();
			return ok(await file.text());
		} catch (error) {
			if (isAbortLike(error)) return err(new FileError("aborted", "aborted", absolute));
			if (isTypeMismatch(error)) {
				return err(new FileError("is_directory", `Is a directory: ${absolute}`, absolute, toErrorCause(error)));
			}
			return err(toFileError(error, absolute));
		}
	}

	async readTextLines(
		path: string,
		options?: { maxLines?: number; abortSignal?: AbortSignal },
	): Promise<Result<string[], FileError>> {
		const absolute = normalizeVirtualPath(path, this.cwd);
		const whole = await this.readTextFile(absolute, options?.abortSignal);
		if (!whole.ok) return whole;
		if (options?.maxLines !== undefined && options.maxLines <= 0) return ok([]);
		const lines: string[] = [];
		for (const raw of whole.value.split("\n")) {
			lines.push(raw.endsWith("\r") ? raw.slice(0, -1) : raw);
			if (options?.maxLines !== undefined && lines.length >= options.maxLines) break;
		}
		// A trailing newline does not introduce a final empty line (readline semantics).
		if (options?.maxLines === undefined && lines.length > 0 && lines[lines.length - 1] === "") {
			const withoutTrailing = [...lines];
			withoutTrailing.pop();
			return ok(withoutTrailing);
		}
		return ok(lines);
	}

	async readBinaryFile(path: string, abortSignal?: AbortSignal): Promise<Result<Uint8Array, FileError>> {
		const absolute = normalizeVirtualPath(path, this.cwd);
		const aborted = abortGuard<Uint8Array>(abortSignal, absolute);
		if (aborted) return aborted;
		try {
			const handle = await this.resolveFileHandle(absolute);
			const file = await handle.getFile();
			return ok(new Uint8Array(await file.arrayBuffer()));
		} catch (error) {
			if (isAbortLike(error)) return err(new FileError("aborted", "aborted", absolute));
			if (isTypeMismatch(error)) {
				return err(new FileError("is_directory", `Is a directory: ${absolute}`, absolute, toErrorCause(error)));
			}
			return err(toFileError(error, absolute));
		}
	}

	async writeFile(
		path: string,
		content: string | Uint8Array,
		abortSignal?: AbortSignal,
	): Promise<Result<void, FileError>> {
		const absolute = normalizeVirtualPath(path, this.cwd);
		const aborted = abortGuard<void>(abortSignal, absolute);
		if (aborted) return aborted;
		try {
			const { parentSegments, name } = splitPath(absolute, "/");
			const parent = await this.resolveDirectoryBySegments(parentSegments, true);
			const writable = await parent.getFileHandle(name, { create: true }).then((handle) => handle.createWritable());
			await writable.write(content);
			await writable.close();
			return ok(undefined);
		} catch (error) {
			if (isAbortLike(error)) return err(new FileError("aborted", "aborted", absolute));
			return err(toFileError(error, absolute));
		}
	}

	async appendFile(path: string, content: string | Uint8Array): Promise<Result<void, FileError>> {
		const absolute = normalizeVirtualPath(path, this.cwd);
		try {
			const { parentSegments, name } = splitPath(absolute, "/");
			const parent = await this.resolveDirectoryBySegments(parentSegments, true);
			const handle = await parent.getFileHandle(name, { create: true });
			const existingSize = (await handle.getFile()).size;
			const writable = await handle.createWritable({ keepExistingData: true });
			await writable.seek(existingSize);
			await writable.write(content);
			await writable.close();
			return ok(undefined);
		} catch (error) {
			return err(toFileError(error, absolute));
		}
	}

	/**
	 * Three-tier strategy (11-B §7.1): prefer the non-standard in-OPFS `move` (probed, never assumed; it replaces an
	 * existing destination inside the OPFS), else copy through `createWritable` — the spec makes `close()` the atomic
	 * replace point — then `removeEntry` the source. Works for same-directory publishes (the
	 * `publishFileAtomically` shape) and across directories.
	 */
	async renameFile(sourcePath: string, destinationPath: string): Promise<Result<void, FileError>> {
		const source = normalizeVirtualPath(sourcePath, this.cwd);
		const destination = normalizeVirtualPath(destinationPath, this.cwd);
		try {
			const sourceSplit = splitPath(source, "/");
			const destinationSplit = splitPath(destination, "/");
			const sourceParent = await this.resolveDirectoryBySegments(sourceSplit.parentSegments, false);
			const destinationParent = await this.resolveDirectoryBySegments(destinationSplit.parentSegments, false);
			const sourceHandle = await sourceParent.getFileHandle(sourceSplit.name);

			const sameDirectory = sourceSplit.parentSegments.join("/") === destinationSplit.parentSegments.join("/");
			if (typeof sourceHandle.move === "function") {
				try {
					if (sameDirectory) {
						await sourceHandle.move(destinationSplit.name);
					} else {
						await sourceHandle.move(destinationParent, destinationSplit.name);
					}
					return ok(undefined);
				} catch {
					// Move rejected (e.g. exclusive lock held): fall through to the copy tier.
				}
			}

			const bytes = new Uint8Array(await (await sourceHandle.getFile()).arrayBuffer());
			const destinationWritable = await destinationParent
				.getFileHandle(destinationSplit.name, { create: true })
				.then((handle) => handle.createWritable());
			await destinationWritable.write(bytes);
			await destinationWritable.close();
			await sourceParent.removeEntry(sourceSplit.name, { force: true });
			return ok(undefined);
		} catch (error) {
			if (isNotFound(error)) {
				return err(new FileError("not_found", describeOpfsFailure(error), source, toErrorCause(error)));
			}
			return err(toFileError(error, source));
		}
	}

	async fileInfo(path: string): Promise<Result<FileInfo, FileError>> {
		const absolute = normalizeVirtualPath(path, this.cwd);
		try {
			const kind = await this.probeKind(absolute);
			if (!kind.ok) return kind;
			if (kind.value === "file") {
				const file = await (await this.resolveFileHandle(absolute)).getFile();
				return ok(fileInfoOf(absolute, "file", file.size, file.lastModified));
			}
			return ok(fileInfoOf(absolute, "directory", 0, 0));
		} catch (error) {
			return err(toFileError(error, absolute));
		}
	}

	async listDir(path: string): Promise<Result<FileInfo[], FileError>> {
		const absolute = normalizeVirtualPath(path, this.cwd);
		try {
			const directory = await this.resolveDirectory(absolute);
			const entries: FileInfo[] = [];
			for await (const child of directory.values()) {
				const childPath = joinVirtualPath([absolute, child.name]);
				if (child.kind === "file") {
					const file = await (child as OpfsFileHandle).getFile();
					entries.push(fileInfoOf(childPath, "file", file.size, file.lastModified));
				} else {
					entries.push(fileInfoOf(childPath, "directory", 0, 0));
				}
			}
			return ok(entries);
		} catch (error) {
			if (isTypeMismatch(error)) {
				// The path exists but is a file: node lists would fail with ENOTDIR.
				return err(new FileError("not_directory", `Not a directory: ${absolute}`, absolute, toErrorCause(error)));
			}
			return err(toFileError(error, absolute));
		}
	}

	async canonicalPath(path: string): Promise<Result<string, FileError>> {
		const absolute = normalizeVirtualPath(path, this.cwd);
		const existence = await this.exists(absolute);
		if (!existence.ok) return existence;
		// OPFS has no symlinks; canonical == normalized, but only for existing paths (realpath semantics).
		if (!existence.value) return err(new FileError("not_found", `Path not found: ${absolute}`, absolute));
		return ok(absolute);
	}

	async exists(path: string): Promise<Result<boolean, FileError>> {
		const absolute = normalizeVirtualPath(path, this.cwd);
		try {
			const kind = await this.probeKind(absolute);
			return kind.ok ? ok(true) : kind;
		} catch (error) {
			if (isNotFound(error)) return ok(false);
			return err(toFileError(error, absolute));
		}
	}

	async createDir(path: string, options?: { recursive?: boolean }): Promise<Result<void, FileError>> {
		const absolute = normalizeVirtualPath(path, this.cwd);
		const recursive = options?.recursive ?? true;
		try {
			if (recursive) {
				await this.resolveDirectoryOrCreate(absolute, true);
				return ok(undefined);
			}
			const { parentSegments, name } = splitPath(absolute, "/");
			const parent = await this.resolveDirectoryBySegments(parentSegments, false);
			await parent.getDirectoryHandle(name, { create: true });
			return ok(undefined);
		} catch (error) {
			if (isNotFound(error)) {
				return err(new FileError("not_found", describeOpfsFailure(error), absolute, toErrorCause(error)));
			}
			if (isTypeMismatch(error)) {
				// A file occupies the target path: node's mkdir surfaces this as EEXIST.
				return err(new FileError("unknown", describeOpfsFailure(error), absolute, toErrorCause(error)));
			}
			return err(toFileError(error, absolute));
		}
	}

	async remove(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<Result<void, FileError>> {
		const absolute = normalizeVirtualPath(path, this.cwd);
		try {
			const { parentSegments, name } = splitPath(absolute, "/");
			const parent = await this.resolveDirectoryBySegments(parentSegments, false);
			try {
				await parent.removeEntry(name, {
					recursive: options?.recursive ?? false,
					force: options?.force ?? false,
				});
				return ok(undefined);
			} catch (error) {
				if (isNotFound(error) && (options?.force ?? false)) return ok(undefined);
				if (isNotFound(error)) {
					return err(new FileError("not_found", describeOpfsFailure(error), absolute, toErrorCause(error)));
				}
				if (isTypeMismatch(error)) {
					return err(
						new FileError("not_directory", `Not a directory: ${absolute}`, absolute, toErrorCause(error)),
					);
				}
				throw error;
			}
		} catch (error) {
			return err(toFileError(error, absolute));
		}
	}

	async createTempDir(prefix: string = "tmp-"): Promise<Result<string, FileError>> {
		const dir = joinVirtualPath([TEMP_ROOT, `${prefix}${crypto.randomUUID()}`]);
		const created = await this.createDir(dir, { recursive: true });
		if (!created.ok) return created;
		return ok(dir);
	}

	async createTempFile(options?: { prefix?: string; suffix?: string }): Promise<Result<string, FileError>> {
		const dir = await this.createTempDir("tmp-");
		if (!dir.ok) return dir;
		const file = joinVirtualPath([
			dir.value,
			`${options?.prefix ?? ""}${crypto.randomUUID()}${options?.suffix ?? ""}`,
		]);
		const written = await this.writeFile(file, "");
		if (!written.ok) return written;
		return ok(file);
	}

	async cleanup(): Promise<void> {
		// Handles are opened per operation; nothing persistent to release.
	}
}
