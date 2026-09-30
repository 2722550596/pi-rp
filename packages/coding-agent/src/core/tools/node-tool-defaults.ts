/**
 * Node-profile default implementations for the built-in tools (15-F §5.5 开缝清单:
 * 「默认实现工厂移至子模块」).
 *
 * This module is the ONLY home of tool default implementations that touch node
 * built-ins (`fs`, `child_process`, `readline`). The tool definition files
 * (read/bash/edit/write/grep/find/ls, all on the browser CI watch list) import
 * their defaults from here, so their own top-level `node:` imports disappear.
 *
 * Browser profile: the harness always injects OPFS-backed Operations
 * (`createOpfsOperations`) for the six file tools, so these defaults are
 * unreachable; the browser build aliases the underlying `node:` specifiers to
 * packages/browser-engine/src/shims/* (structured ENOENT / shell-negotiated-off
 * errors — see each shim's header). Node profile: byte-identical behavior.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, constants, createWriteStream, type WriteStream } from "node:fs";
import {
	access as fsAccess,
	mkdir as fsMkdir,
	readdir as fsReaddir,
	readFile as fsReadFile,
	realpath as fsRealpathNative,
	stat as fsStat,
	writeFile as fsWriteFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { waitForChildProcess } from "../../utils/child-process.ts";
import { detectSupportedImageMimeTypeFromFile } from "../../utils/mime.ts";
import {
	getShellConfig,
	getShellEnv,
	killProcessTree,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "../../utils/shell.ts";
import type { BashOperations } from "./bash.ts";
import type { EditOperations } from "./edit.ts";
import type { FindOperations } from "./find.ts";
import type { GrepOperations } from "./grep.ts";
import type { LsOperations } from "./ls.ts";
import type { ReadOperations } from "./read.ts";
import type { WriteOperations } from "./write.ts";

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

export const defaultReadOperations: ReadOperations = {
	readFile: (path) => fsReadFile(path),
	access: (path) => fsAccess(path, constants.R_OK),
	detectImageMimeType: detectSupportedImageMimeTypeFromFile,
	stat: fsStat,
	listDirectory: async (absolutePath) => {
		const entries = await fsReaddir(absolutePath, { withFileTypes: true });
		return entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }));
	},
};

// ---------------------------------------------------------------------------
// bash
// ---------------------------------------------------------------------------

const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;

function resolveTimeoutMs(timeout: number | undefined): number | undefined {
	if (timeout === undefined) return undefined;
	if (!Number.isFinite(timeout) || timeout <= 0) {
		throw new Error("Invalid timeout: must be a finite number of seconds");
	}

	const timeoutMs = timeout * 1000;
	if (timeoutMs > MAX_TIMEOUT_MS) {
		throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
	}
	return timeoutMs;
}

export function createLocalBashOperations(options?: { shellPath?: string }): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout, env }) => {
			const timeoutMs = resolveTimeoutMs(timeout);
			if (signal?.aborted) {
				throw new Error("aborted");
			}
			const shellConfig = getShellConfig(options?.shellPath);
			try {
				await fsAccess(cwd, constants.F_OK);
			} catch {
				throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
			}

			const commandFromStdin = shellConfig.commandTransport === "stdin";
			const child = spawn(shellConfig.shell, commandFromStdin ? shellConfig.args : [...shellConfig.args, command], {
				cwd,
				detached: process.platform !== "win32",
				env: env ?? getShellEnv(),
				stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
				windowsHide: true,
			});
			if (commandFromStdin) {
				child.stdin?.on("error", () => {});
				child.stdin?.end(command);
			}
			if (child.pid) trackDetachedChildPid(child.pid);
			let timedOut = false;
			let timeoutHandle: NodeJS.Timeout | undefined;
			const onAbort = () => {
				if (child.pid) killProcessTree(child.pid);
			};

			try {
				// Set timeout if provided.
				if (timeoutMs !== undefined) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						if (child.pid) killProcessTree(child.pid);
					}, timeoutMs);
				}
				// Stream stdout and stderr.
				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);
				// Handle abort signal by killing the entire process tree.
				if (signal) {
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}
				// Handle shell spawn errors and wait for the process to terminate without hanging
				// on inherited stdio handles held by detached descendants.
				const exitCode = await waitForChildProcess(child);
				if (signal?.aborted) {
					throw new Error("aborted");
				}
				if (timedOut) {
					throw new Error(`timeout:${timeout}`);
				}
				return { exitCode };
			} finally {
				if (child.pid) untrackDetachedChildPid(child.pid);
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (signal) signal.removeEventListener("abort", onAbort);
			}
		},
	};
}

// ---------------------------------------------------------------------------
// edit / write / grep / find / ls
// ---------------------------------------------------------------------------

export const defaultEditOperations: EditOperations = {
	readFile: (path) => fsReadFile(path),
	writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
	access: (path) => fsAccess(path, constants.R_OK | constants.W_OK),
};

export const defaultWriteOperations: WriteOperations = {
	writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
	mkdir: (dir) => fsMkdir(dir, { recursive: true }).then(() => {}),
};

export const defaultGrepOperations: GrepOperations = {
	isDirectory: async (p) => (await fsStat(p)).isDirectory(),
	readFile: (p) => fsReadFile(p, "utf-8"),
};

export const defaultFindOperations: FindOperations = {
	exists: async (p) => {
		try {
			await fsAccess(p, constants.F_OK);
			return true;
		} catch {
			return false;
		}
	},
	// This is a placeholder. Actual fd execution happens in execute() when no custom glob is provided.
	glob: () => [],
};

export const defaultLsOperations: LsOperations = {
	exists: pathExistsAsync,
	stat: fsStat,
	readdir: fsReaddir,
};

// ---------------------------------------------------------------------------
// ripgrep / fd streaming collectors (spawn + readline wiring lives here so the
// grep/find tool files stay node:-free; both return structured results and let
// the tool files keep ownership of messages, limits, and rendering).
// ---------------------------------------------------------------------------

export interface RipgrepMatch {
	filePath: string;
	lineNumber: number;
	lineText?: string;
}

/** Structured result shared by the rg/fd collectors: tool files keep message ownership. */
export type SpawnCollectResult<Output> =
	| { ok: true; output: Output; matchLimitReached: boolean }
	| { ok: false; kind: "spawn-error"; error: Error }
	| { ok: false; kind: "exit-error"; message: string }
	| { ok: false; kind: "aborted" };

/** Output contract for {@link collectRipgrepMatches}: rg --json match events. */
export interface RipgrepCollectOutput {
	matches: RipgrepMatch[];
}

/** Output contract for {@link collectFdMatches}: raw fd stdout lines + exit code. */
export interface FdCollectOutput {
	lines: string[];
	/** fd exit code (null when killed by signal); nonzero with output is tolerated by the caller (rg parity). */
	code: number | null;
}

/** Narrowed shape of one rg `--json` event line this collector consumes. */
interface RipgrepJsonEvent {
	type?: unknown;
	data?: {
		path?: { text?: unknown };
		line_number?: unknown;
		lines?: { text?: unknown };
	};
}

export function collectRipgrepMatches(options: {
	rgPath: string;
	args: string[];
	limit: number;
	signal?: AbortSignal;
}): Promise<SpawnCollectResult<RipgrepCollectOutput>> {
	const { rgPath, args, limit, signal } = options;
	const { promise, resolve } = Promise.withResolvers<SpawnCollectResult<RipgrepCollectOutput>>();
	const child = spawn(rgPath, args, { stdio: ["ignore", "pipe", "pipe"] });
	const rl = createInterface({ input: child.stdout });
	let stderr = "";
	let matchCount = 0;
	let matchLimitReached = false;
	let aborted = false;
	let killedDueToLimit = false;

	const cleanup = () => {
		rl.close();
		signal?.removeEventListener("abort", onAbort);
	};
	const stopChild = (dueToLimit = false) => {
		if (!child.killed) {
			killedDueToLimit = dueToLimit;
			child.kill();
		}
	};
	const onAbort = () => {
		aborted = true;
		stopChild();
	};
	signal?.addEventListener("abort", onAbort, { once: true });
	child.stderr?.on("data", (chunk) => {
		stderr += chunk.toString();
	});

	// Collect matches during streaming, then hand them over after rg exits.
	const matches: RipgrepMatch[] = [];
	rl.on("line", (line) => {
		if (!line.trim() || matchCount >= limit) return;
		let event: RipgrepJsonEvent;
		try {
			event = JSON.parse(line) as RipgrepJsonEvent;
		} catch {
			return;
		}
		if (event.type !== "match") return;
		matchCount++;
		const filePath = event.data?.path?.text;
		const lineNumber = event.data?.line_number;
		const lineText = event.data?.lines?.text;
		if (typeof filePath === "string" && typeof lineNumber === "number") {
			matches.push({
				filePath,
				lineNumber,
				lineText: typeof lineText === "string" ? lineText : undefined,
			});
		}
		if (matchCount >= limit) {
			matchLimitReached = true;
			stopChild(true);
		}
	});

	child.on("error", (error) => {
		cleanup();
		resolve({ ok: false, kind: "spawn-error", error });
	});
	child.on("close", (code) => {
		cleanup();
		if (aborted) {
			resolve({ ok: false, kind: "aborted" });
			return;
		}
		if (!killedDueToLimit && code !== 0 && code !== 1) {
			resolve({ ok: false, kind: "exit-error", message: stderr.trim() || `ripgrep exited with code ${code}` });
			return;
		}
		resolve({ ok: true, output: { matches }, matchLimitReached });
	});
	return promise;
}

export function collectFdMatches(options: {
	fdPath: string;
	args: string[];
	signal?: AbortSignal;
}): Promise<SpawnCollectResult<FdCollectOutput>> {
	const { fdPath, args, signal } = options;
	const { promise, resolve } = Promise.withResolvers<SpawnCollectResult<FdCollectOutput>>();
	const child = spawn(fdPath, args, { stdio: ["ignore", "pipe", "pipe"] });
	const rl = createInterface({ input: child.stdout });
	let stderr = "";
	const lines: string[] = [];

	const onAbort = () => {
		if (!child.killed) child.kill();
	};
	signal?.addEventListener("abort", onAbort, { once: true });

	const cleanup = () => {
		rl.close();
		signal?.removeEventListener("abort", onAbort);
	};

	child.stderr?.on("data", (chunk) => {
		stderr += chunk.toString();
	});

	rl.on("line", (line) => {
		lines.push(line);
	});

	child.on("error", (error) => {
		cleanup();
		resolve({ ok: false, kind: "spawn-error", error });
	});

	child.on("close", (code) => {
		cleanup();
		if (signal?.aborted) {
			resolve({ ok: false, kind: "aborted" });
			return;
		}
		if (code !== 0 && lines.length === 0) {
			resolve({ ok: false, kind: "exit-error", message: stderr.trim() || `fd exited with code ${code}` });
			return;
		}
		resolve({ ok: true, output: { lines, code }, matchLimitReached: false });
	});
	return promise;
}

// ---------------------------------------------------------------------------
// Shared fs helpers consumed by watch-list files (path-utils / file-mutation-queue /
// edit-diff). Each helper keeps the exact node semantics; the browser build reaches
// them through the fs shims (structured ENOENT / existsSync false).
// ---------------------------------------------------------------------------

/** `accessSync(path, F_OK)` parity: false on any failure (incl. ENOENT). */
export function fileExistsSync(filePath: string): boolean {
	try {
		accessSync(filePath, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

/** `access(path, F_OK)` parity: false on any failure (incl. ENOENT). */
export async function pathExistsAsync(filePath: string): Promise<boolean> {
	try {
		await fsAccess(filePath, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

/** `realpath` parity: rejects with the node error shape (ENOENT fallback lives at call sites). */
export const fsRealpath = fsRealpathNative;

/** `access(path, R_OK)` parity: throws the node error on failure. */
export function accessReadable(filePath: string): Promise<void> {
	return fsAccess(filePath, constants.R_OK);
}

/** `readFile(path, "utf-8")` parity for edit-diff preview rendering. */
export function readTextFileUtf8(filePath: string): Promise<string> {
	return fsReadFile(filePath, "utf-8");
}

// ---------------------------------------------------------------------------
// Temp spill file for OutputAccumulator (bash tool full-output persistence).
// ---------------------------------------------------------------------------

/** Minimal write face OutputAccumulator needs from a spill file (node parity: fs WriteStream). */
export interface OutputSpillFile {
	readonly path: string;
	write(chunk: Uint8Array): void;
	end(): Promise<void>;
}

export function createTempOutputSpillFile(prefix: string): OutputSpillFile {
	const id = randomBytes(8).toString("hex");
	const path = join(tmpdir(), `${prefix}-${id}.log`);
	const stream: WriteStream = createWriteStream(path);
	return {
		path,
		write: (chunk) => {
			stream.write(chunk);
		},
		end: () => {
			const { promise, resolve, reject } = Promise.withResolvers<void>();
			const onError = (error: Error) => {
				stream.off("finish", onFinish);
				reject(error);
			};
			const onFinish = () => {
				stream.off("error", onError);
				resolve();
			};
			stream.once("error", onError);
			stream.once("finish", onFinish);
			stream.end();
			return promise;
		},
	};
}
