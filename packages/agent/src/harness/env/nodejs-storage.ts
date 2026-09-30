import {
	appendFileSync as fsAppendFileSync,
	chmodSync as fsChmodSync,
	closeSync as fsCloseSync,
	existsSync as fsExistsSync,
	mkdirSync as fsMkdirSync,
	openSync as fsOpenSync,
	readdirSync as fsReaddirSync,
	readFileSync as fsReadFileSync,
	readSync as fsReadSync,
	realpathSync as fsRealpathSync,
	renameSync as fsRenameSync,
	statSync as fsStatSync,
	writeFileSync as fsWriteFileSync,
} from "node:fs";
import lockfile from "proper-lockfile";
import type { StateLocks, StatePaths, StorageBackend } from "./storage-backend.ts";

const LOCK_RETRY_ATTEMPTS = 10;
const LOCK_RETRY_DELAY_MS = 20;
const ASYNC_LOCK_STALE_MS = 30_000;
const ASYNC_LOCK_MAX_DELAY_MS = 2_000;
const READ_BUFFER_SIZE = 1024 * 1024;

function errnoCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as { code?: unknown }).code)
		: undefined;
}

/**
 * Node-profile {@link StorageBackend}: a thin, faithful wrapper over the `node:fs` synchronous API. Every method maps
 * one-to-one onto the synchronous calls the state code previously made directly, so node-profile behavior is
 * byte-for-byte unchanged. Reachable only via the `./node` subexport (browser builds substitute a stub for that
 * module), keeping the main export chain browser-clean.
 */
export class NodeStorageBackend implements StorageBackend {
	readonly kind = "node-fs" as const;

	/** Shared stateless instance for node-profile default assembly. */
	static readonly shared: NodeStorageBackend = new NodeStorageBackend();

	existsSync(path: string): boolean {
		return fsExistsSync(path);
	}

	readTextFileSync(path: string): string {
		return fsReadFileSync(path, "utf-8");
	}

	readTextLinesSync(path: string, maxLines?: number): string[] {
		if (maxLines !== undefined && maxLines <= 0) return [];
		const fd = fsOpenSync(path, "r");
		try {
			// Stream-decode so multibyte UTF-8 characters split across chunk boundaries survive intact (the former
			// StringDecoder-based session scans depended on this).
			const decoder = new TextDecoder();
			const buffer = Buffer.allocUnsafe(READ_BUFFER_SIZE);
			const lines: string[] = [];
			let pending = "";
			let done = false;
			while (!done) {
				const bytesRead = fsReadSync(fd, buffer, 0, buffer.length, null);
				if (bytesRead === 0) break;
				pending += decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
				let lineStart = 0;
				let newlineIndex = pending.indexOf("\n", lineStart);
				while (newlineIndex !== -1) {
					const line = pending.slice(lineStart, newlineIndex);
					lines.push(line.endsWith("\r") ? line.slice(0, -1) : line);
					if (maxLines !== undefined && lines.length >= maxLines) {
						done = true;
						break;
					}
					lineStart = newlineIndex + 1;
					newlineIndex = pending.indexOf("\n", lineStart);
				}
				pending = pending.slice(lineStart);
			}
			pending += decoder.decode();
			if (!done && pending.length > 0) {
				lines.push(pending.endsWith("\r") ? pending.slice(0, -1) : pending);
			}
			return lines;
		} finally {
			fsCloseSync(fd);
		}
	}

	writeTextFileSync(path: string, data: string, options?: { flag?: "w" | "wx" }): void {
		if (options?.flag === "wx") {
			fsWriteFileSync(path, data, { encoding: "utf-8", flag: "wx" });
			return;
		}
		fsWriteFileSync(path, data, "utf-8");
	}

	appendTextFileSync(path: string, data: string): void {
		fsAppendFileSync(path, data, "utf-8");
	}

	mkdirSync(path: string, options?: { recursive?: boolean; mode?: number }): void {
		fsMkdirSync(path, { recursive: options?.recursive ?? false, mode: options?.mode });
	}

	readdirSync(path: string): Array<{ name: string; isFile: boolean; isDirectory: boolean; isSymbolicLink?: boolean }> {
		return fsReaddirSync(path, { withFileTypes: true }).map((entry) => ({
			name: entry.name,
			isFile: entry.isFile(),
			isDirectory: entry.isDirectory(),
			isSymbolicLink: entry.isSymbolicLink(),
		}));
	}

	statSync(path: string): { size: number; mtimeMs: number; isFile: boolean; isDirectory: boolean } {
		const stats = fsStatSync(path);
		return { size: stats.size, mtimeMs: stats.mtimeMs, isFile: stats.isFile(), isDirectory: stats.isDirectory() };
	}

	renameSync(source: string, destination: string): void {
		fsRenameSync(source, destination);
	}

	canonicalizeSync(path: string): string {
		try {
			return fsRealpathSync(path);
		} catch {
			return path;
		}
	}

	fileRevisionSync(path: string): string | undefined {
		try {
			const stats = fsStatSync(path, { bigint: true });
			return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;
		} catch {
			return undefined;
		}
	}

	chmodSync(path: string, mode: number): void {
		fsChmodSync(path, mode);
	}
}

/**
 * Node-profile {@link StateLocks}: proper-lockfile behind one seam. The synchronous member preserves the shared retry
 * discipline the three former per-file wrappers (settings/auth/trust) each duplicated: at most 10 attempts, 20ms busy
 * wait between attempts, immediate rethrow for non-ELOCKED errors and on the final attempt, `realpath: false`.
 */
export class NodeStateLocks implements StateLocks {
	static readonly shared: NodeStateLocks = new NodeStateLocks();

	lockSync(path: string, _options?: { lockfilePath?: string }): () => void {
		let lastError: unknown;
		for (let attempt = 1; attempt <= LOCK_RETRY_ATTEMPTS; attempt++) {
			try {
				return lockfile.lockSync(path, { realpath: false });
			} catch (error) {
				if (errnoCode(error) !== "ELOCKED" || attempt === LOCK_RETRY_ATTEMPTS) {
					throw error;
				}
				lastError = error;
				const start = Date.now();
				while (Date.now() - start < LOCK_RETRY_DELAY_MS) {
					// Busy wait: callers are synchronous by contract.
				}
			}
		}
		throw (lastError as Error) ?? new Error(`Failed to acquire lock for ${path}`);
	}

	async lockAsync(
		path: string,
		options?: { signal?: AbortSignal; onCompromised?: (error: Error) => void },
	): Promise<() => Promise<void>> {
		const signal = options?.signal;
		const onCompromised =
			options?.onCompromised ??
			((error: Error) => {
				throw error;
			});
		const deadline = Date.now() + ASYNC_LOCK_STALE_MS;
		let retry = 0;
		while (true) {
			signal?.throwIfAborted();
			let release: (() => Promise<void>) | undefined;
			try {
				release = await lockfile.lock(path, {
					realpath: false,
					retries: 0,
					stale: ASYNC_LOCK_STALE_MS,
					onCompromised,
				});
			} catch (error) {
				signal?.throwIfAborted();
				const remainingMs = deadline - Date.now();
				if (errnoCode(error) !== "ELOCKED" || remainingMs <= 0) throw error;
				const baseDelayMs = Math.min(10 * 2 ** retry, ASYNC_LOCK_MAX_DELAY_MS / 2);
				retry++;
				const delayMs = Math.min(Math.round(baseDelayMs * (1 + Math.random())), remainingMs);
				const { promise: slept, resolve: wake } = Promise.withResolvers<void>();
				setTimeout(wake, delayMs);
				await slept;
				continue;
			}
			if (signal?.aborted) {
				await release();
				signal.throwIfAborted();
			}
			return release;
		}
	}
}

/**
 * Node-profile {@link StatePaths}: pass-through of the caller-provided agent-dir resolver. The coding-agent node
 * assembly wires `() => getAgentDir()` so env overrides keep resolving at call time, exactly as before.
 */
export class NodeStatePaths implements StatePaths {
	private readonly resolveAgentDir: () => string;

	constructor(agentDir: string | (() => string)) {
		this.resolveAgentDir = typeof agentDir === "function" ? agentDir : () => agentDir;
	}

	agentDir(): string {
		return this.resolveAgentDir();
	}
}
