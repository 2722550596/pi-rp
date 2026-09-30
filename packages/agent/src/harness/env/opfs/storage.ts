import type { FileError, Result } from "../../types.ts";
import type { StateLocks, StatePaths, StorageBackend } from "../storage-backend.ts";
import { OpfsFileSystem } from "./file-system.ts";
import type { OpfsDirectoryHandle, OpfsFileHandle } from "./types.ts";
import { normalizeVirtualPath, splitVirtualPath } from "./virtual-path.ts";

/**
 * Browser-profile OPFS layout (frozen contract §6.1): `/` is the `navigator.storage.getDirectory()` root; pi state
 * lives under `/state/agent` (the `agentDir()` value) and the agent workspace under `/workspace/<project>`.
 */
export const BROWSER_AGENT_DIR = "/state/agent";
export const BROWSER_WORKSPACE_ROOT = "/workspace";
/**
 * Default workspace (v1, single workspace). This is the canonical value for the required `cwd` of
 * `createBrowserHarnessEnv`; multiple workspaces are sibling directories under {@link BROWSER_WORKSPACE_ROOT}.
 */
export const BROWSER_DEFAULT_WORKSPACE = "/workspace/default";

export function browserWorkspacePath(name: string = "default"): string {
	return `${BROWSER_WORKSPACE_ROOT}/${name}`;
}

/** Browser-profile {@link StatePaths}: the frozen `/state/agent` agent-state root. */
export function opfsStatePaths(agentDir: string = BROWSER_AGENT_DIR): StatePaths {
	return {
		agentDir: () => agentDir,
	};
}

/**
 * Browser-profile {@link StateLocks}: structural no-op. The browser profile negotiates `concurrentFsAccess: false`
 * (single tab, single writer), and the lock contract mandates total bypass in that case — synchronous functions in
 * one JS context cannot interleave, so the no-op is a safe degradation, never a weaker lock.
 */
export class OpfsStateLocks implements StateLocks {
	static readonly shared: OpfsStateLocks = new OpfsStateLocks();

	chmodSync(_path: string, _mode: number): void {
		// OPFS has no POSIX permissions; the credential boundary is the origin (11-B §7.3).
	}

	lockSync(): () => void {
		return () => undefined;
	}

	async lockAsync(
		_path: string,
		_options?: { signal?: AbortSignal; onCompromised?: (error: Error) => void },
	): Promise<() => Promise<void>> {
		return async () => undefined;
	}
}

interface MirrorFile {
	data: Uint8Array;
	mtimeMs: number;
}

function errnoError(code: string, message: string): Error {
	const error = new Error(`${code}: ${message}`);
	(error as { code?: string }).code = code;
	return error;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Browser-profile {@link StorageBackend}: the synchronous state face over OPFS.
 *
 * Synchronous method signatures are frozen by the consumers (the session/state code), but OPFS offers no synchronous
 * main-thread API whose handles can be acquired on demand (`createSyncAccessHandle` is worker-only, and even there it
 * is asynchronous to obtain). The design therefore keeps an in-memory authoritative mirror of the state subtree:
 *
 * - `create()` hydrates the configured scopes (default `/state`, including sessions — v1 state subtrees are small)
 *   from OPFS once, asynchronously, at assembly time.
 * - Synchronous reads are served from the mirror; synchronous writes mutate the mirror immediately. This is sound
 *   under the negotiated `concurrentFsAccess: false` (no out-of-session writer exists).
 * - Every mutation is enqueued as a write-through task against the async OPFS face (an {@link OpfsFileSystem} over
 *   the same root) and serialized through one promise chain; `flush()` awaits durability.
 *
 * Crash between a synchronous write and its flush can lose that write — declared v1 semantics for the sync face; the
 * session JSONL surface (durable-critical) runs on the async face with strict atomic publishing instead.
 *
 * Error parity: methods throw `Error` objects carrying node `code` fields (ENOENT/EEXIST/EISDIR/ENOTDIR/ENOTEMPTY)
 * so consumer-side error handling written against node:fs keeps working unchanged.
 */
export class OpfsStorageBackend implements StorageBackend {
	readonly kind = "opfs" as const;

	private readonly root: OpfsDirectoryHandle;
	private readonly asyncFs: OpfsFileSystem;
	private readonly files = new Map<string, MirrorFile>();
	private readonly dirs = new Set<string>();
	private queue: Promise<void> = Promise.resolve();
	private lastQueueError: unknown;

	private constructor(root: OpfsDirectoryHandle) {
		this.root = root;
		this.asyncFs = new OpfsFileSystem(root, "/");
	}

	/**
	 * Assemble the backend over an OPFS root. `hydrateScopes` lists virtual directories mirrored at startup; the
	 * default covers the pi state subtree. Scopes that do not exist yet are skipped (fresh profile).
	 */
	static async create(root: OpfsDirectoryHandle, options?: { hydrateScopes?: string[] }): Promise<OpfsStorageBackend> {
		const backend = new OpfsStorageBackend(root);
		for (const scope of options?.hydrateScopes ?? ["/state"]) {
			await backend.hydrateScope(scope);
		}
		return backend;
	}

	private async hydrateScope(scope: string): Promise<void> {
		const segments = splitVirtualPath(normalizeVirtualPath(scope, "/"));
		let handle = this.root;
		for (const segment of segments) {
			try {
				handle = await handle.getDirectoryHandle(segment);
			} catch {
				return; // Scope absent: fresh profile, nothing to hydrate.
			}
		}
		await this.hydrateDirectory(handle, normalizeVirtualPath(scope, "/"));
	}

	private async hydrateDirectory(handle: OpfsDirectoryHandle, absolute: string): Promise<void> {
		this.dirs.add(absolute);
		for await (const child of handle.values()) {
			const childPath = absolute === "/" ? `/${child.name}` : `${absolute}/${child.name}`;
			if (child.kind === "file") {
				const file = await (child as OpfsFileHandle).getFile();
				this.files.set(childPath, {
					data: new Uint8Array(await file.arrayBuffer()),
					mtimeMs: file.lastModified,
				});
			} else {
				await this.hydrateDirectory(child as OpfsDirectoryHandle, childPath);
			}
		}
	}

	/** Await durability of every write-through mutation enqueued so far; rethrows the first failed task. */
	async flush(): Promise<void> {
		await this.queue;
		if (this.lastQueueError !== undefined) {
			const error = this.lastQueueError;
			this.lastQueueError = undefined;
			throw error;
		}
	}

	// ── mirror bookkeeping ───────────────────────────────────────────────────

	private ensureDirPath(path: string): void {
		this.dirs.add("/");
		let current = "";
		for (const segment of splitVirtualPath(path)) {
			current = `${current}/${segment}`;
			this.dirs.add(current);
		}
	}

	private parentOf(path: string): string {
		const segments = splitVirtualPath(path);
		segments.pop();
		return `/${segments.join("/")}`;
	}

	private assertParentExists(path: string): void {
		const parent = this.parentOf(path);
		if (parent !== "/" && !this.dirs.has(parent)) {
			throw errnoError("ENOENT", `no such file or directory, ${path}`);
		}
	}

	private assertFileTarget(path: string, operation: string): void {
		if (this.dirs.has(path)) {
			throw errnoError("EISDIR", `illegal operation on a directory, ${operation}`);
		}
	}

	private childrenOf(path: string): Array<{ name: string; isFile: boolean; isDirectory: boolean }> {
		const prefix = path === "/" ? "/" : `${path}/`;
		const names = new Map<string, { name: string; isFile: boolean; isDirectory: boolean }>();
		for (const file of this.files.keys()) {
			if (!file.startsWith(prefix)) continue;
			const rest = file.slice(prefix.length);
			if (rest.includes("/") || rest.length === 0) continue;
			names.set(rest, { name: rest, isFile: true, isDirectory: false });
		}
		for (const dir of this.dirs) {
			if (dir === "/" || !dir.startsWith(prefix)) continue;
			const rest = dir.slice(prefix.length);
			if (rest.includes("/") || rest.length === 0) continue;
			names.set(rest, { name: rest, isFile: false, isDirectory: true });
		}
		return [...names.values()];
	}

	/**
	 * Queue one write-through operation. The operation is a thunk so it starts only when the chain reaches it —
	 * completion-order of independent OPFS writes must match enqueue order. `FileSystem` operations never throw
	 * (Result contract), so a failed Result is rethrown here to make the write-through failure visible on `flush()`;
	 * multi-step operations may instead throw directly and resolve void.
	 */
	private enqueue(persist: () => Promise<Result<unknown, FileError> | undefined>): void {
		this.queue = this.queue
			.then(async () => {
				const result = await persist();
				if (result !== undefined && !result.ok) throw result.error;
			})
			.catch((error: unknown) => {
				this.lastQueueError = error;
			});
	}

	// ── StorageBackend ───────────────────────────────────────────────────────

	existsSync(path: string): boolean {
		const absolute = normalizeVirtualPath(path, "/");
		return this.files.has(absolute) || this.dirs.has(absolute);
	}

	readTextFileSync(path: string): string {
		const absolute = normalizeVirtualPath(path, "/");
		const file = this.files.get(absolute);
		if (file) return textDecoder.decode(file.data);
		if (this.dirs.has(absolute)) throw errnoError("EISDIR", `illegal operation on a directory, ${path}`);
		throw errnoError("ENOENT", `no such file or directory, ${path}`);
	}

	readTextLinesSync(path: string, maxLines?: number): string[] {
		if (maxLines !== undefined && maxLines <= 0) return [];
		const whole = this.readTextFileSync(path);
		const lines: string[] = [];
		for (const raw of whole.split("\n")) {
			lines.push(raw.endsWith("\r") ? raw.slice(0, -1) : raw);
			if (maxLines !== undefined && lines.length >= maxLines) break;
		}
		if (maxLines === undefined && lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
		return lines;
	}

	writeTextFileSync(path: string, data: string, options?: { flag?: "w" | "wx" }): void {
		const absolute = normalizeVirtualPath(path, "/");
		if (options?.flag !== "wx") this.assertFileTarget(absolute, path);
		this.assertParentExists(absolute);
		if (options?.flag === "wx" && (this.files.has(absolute) || this.dirs.has(absolute))) {
			throw errnoError("EEXIST", `file already exists, ${path}`);
		}
		this.dirs.delete(absolute);
		this.files.set(absolute, { data: textEncoder.encode(data), mtimeMs: Date.now() });
		this.enqueue(() => this.asyncFs.writeFile(absolute, data));
	}

	appendTextFileSync(path: string, data: string): void {
		const absolute = normalizeVirtualPath(path, "/");
		this.assertFileTarget(absolute, path);
		this.assertParentExists(absolute);
		const existing = this.files.get(absolute);
		const merged = existing ? new Uint8Array(existing.data.length + data.length) : textEncoder.encode(data);
		if (existing) {
			merged.set(existing.data, 0);
			merged.set(textEncoder.encode(data), existing.data.length);
		}
		this.files.set(absolute, { data: merged, mtimeMs: Date.now() });
		this.enqueue(() => this.asyncFs.appendFile(absolute, data));
	}

	mkdirSync(path: string, options?: { recursive?: boolean }): void {
		const absolute = normalizeVirtualPath(path, "/");
		if (this.files.has(absolute)) throw errnoError("EEXIST", `file already exists, ${path}`);
		if (options?.recursive ?? false) {
			this.ensureDirPath(absolute);
			this.enqueue(() => this.asyncFs.createDir(absolute, { recursive: true }));
			return;
		}
		this.assertParentExists(absolute);
		if (this.dirs.has(absolute)) throw errnoError("EEXIST", `directory already exists, ${path}`);
		this.dirs.add(absolute);
		this.enqueue(() => this.asyncFs.createDir(absolute, { recursive: false }));
	}

	readdirSync(path: string): Array<{ name: string; isFile: boolean; isDirectory: boolean }> {
		const absolute = normalizeVirtualPath(path, "/");
		if (this.files.has(absolute)) throw errnoError("ENOTDIR", `not a directory, ${path}`);
		if (!this.dirs.has(absolute)) throw errnoError("ENOENT", `no such file or directory, ${path}`);
		return this.childrenOf(absolute);
	}

	statSync(path: string): { size: number; mtimeMs: number; isFile: boolean; isDirectory: boolean } {
		const absolute = normalizeVirtualPath(path, "/");
		const file = this.files.get(absolute);
		if (file) return { size: file.data.length, mtimeMs: file.mtimeMs, isFile: true, isDirectory: false };
		if (this.dirs.has(absolute)) return { size: 0, mtimeMs: 0, isFile: false, isDirectory: true };
		throw errnoError("ENOENT", `no such file or directory, ${path}`);
	}

	renameSync(source: string, destination: string): void {
		const from = normalizeVirtualPath(source, "/");
		const to = normalizeVirtualPath(destination, "/");
		const file = this.files.get(from);
		if (!file && !this.dirs.has(from)) {
			throw errnoError("ENOENT", `no such file or directory, ${source}`);
		}
		this.assertParentExists(to);
		if (file) {
			if (this.dirs.has(to)) throw errnoError("EISDIR", `is a directory, ${destination}`);
			this.files.delete(from);
			this.files.set(to, file);
			this.enqueue(() => this.asyncFs.renameFile(from, to));
			return;
		}
		// Directory rename: POSIX replaces an existing empty directory, refuses non-empty ones and file targets.
		if (this.files.has(to)) throw errnoError("ENOTDIR", `not a directory, ${destination}`);
		if (this.dirs.has(to) && this.childrenOf(to).length > 0) {
			throw errnoError("ENOTEMPTY", `directory not empty, ${destination}`);
		}
		const movedFilePaths = [...this.files.keys()].filter((key) => key === from || key.startsWith(`${from}/`));
		if (this.dirs.has(to)) this.dirs.delete(to);
		this.dirs.delete(from);
		this.ensureDirPath(to);
		const movedFiles = new Map<string, MirrorFile>();
		for (const key of movedFilePaths) {
			const moved = this.files.get(key)!;
			this.files.delete(key);
			const target = to + key.slice(from.length);
			this.files.set(target, moved);
			movedFiles.set(target, moved);
		}
		for (const dir of [...this.dirs]) {
			if (dir.startsWith(`${from}/`)) {
				this.dirs.delete(dir);
				this.dirs.add(to + dir.slice(from.length));
			}
		}
		this.enqueue(async (): Promise<Result<unknown, FileError> | undefined> => {
			const created = await this.asyncFs.createDir(to, { recursive: true });
			if (!created.ok) throw created.error;
			for (const [target, moved] of movedFiles) {
				const written = await this.asyncFs.writeFile(target, moved.data);
				if (!written.ok) throw written.error;
			}
			const removed = await this.asyncFs.remove(from, { recursive: true, force: true });
			if (!removed.ok) throw removed.error;
			return undefined;
		});
	}

	canonicalizeSync(path: string): string {
		// OPFS has no symlinks: canonical == lexical normalization, and like the node implementation the input is
		// returned unchanged when nothing exists to canonicalize.
		return normalizeVirtualPath(path, "/");
	}

	fileRevisionSync(path: string): string | undefined {
		const absolute = normalizeVirtualPath(path, "/");
		const file = this.files.get(absolute);
		if (file) return `${file.data.length}:${file.mtimeMs}`;
		if (this.dirs.has(absolute)) return "0:0";
		return undefined;
	}
}
