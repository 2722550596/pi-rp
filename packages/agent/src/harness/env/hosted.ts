import { type HarnessEnv, negotiate } from "../capabilities.ts";
import {
	type ExecutionEnv,
	ExecutionError,
	err,
	type FileError,
	type FileInfo,
	type FileSystem,
	type Result,
	type Shell,
	type ShellExecOptions,
} from "../types.ts";

/**
 * Host shell contributions for the hosted profile (desktop shells such as Tauri/Electron/custom webviews).
 *
 * A host wanting full capability parity with the node profile must contribute a real {@link FileSystem} bridge
 * (all members, honoring the never-throw `Result` contract of the `FileSystem` methods), a real {@link Shell}, and
 * declare {@link HostContributions.concurrentFsAccess} truthfully. A host contributing only a filesystem (e.g. a
 * read-only viewer) legitimately receives a `shell: false` subset. Cross-language bridge serialization (Tauri
 * commands, postMessage, ...) is host-private; this interface freezes only the JS-side shape.
 */
export interface HostContributions {
	/** Required: the host's real filesystem bridge. Must honor the never-throw `Result` contract. */
	fs: FileSystem;
	/** Optional: the host's shell bridge. Omitted ⇒ the negotiated `shell` capability is `false`. */
	shell?: Shell;
	/**
	 * Whether the contributed filesystem has writers outside this session. Defaults to `true` (conservative: an
	 * undeclared host is treated as having concurrent writers, keeping storage-level file locks active).
	 */
	concurrentFsAccess?: boolean;
	/** Working directory of the agent workspace inside the contributed namespace. Applied to `fs.cwd` at assembly. */
	cwd: string;
}

/** Typed assembly failure when host contributions violate the structural contract. The entry refuses to assemble. */
export class HostContributionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "HostContributionError";
	}
}

/** `FileSystem` members that must be callable functions on a host-contributed bridge. */
const FILE_SYSTEM_METHODS = [
	"absolutePath",
	"joinPath",
	"readTextFile",
	"readTextLines",
	"readBinaryFile",
	"writeFile",
	"appendFile",
	"renameFile",
	"fileInfo",
	"listDir",
	"canonicalPath",
	"exists",
	"createDir",
	"remove",
	"createTempDir",
	"createTempFile",
] as const;

/** `Shell` members that must be callable functions on a host-contributed bridge. */
const SHELL_METHODS = ["exec", "cleanup"] as const;

function assertMethods(value: unknown, methods: readonly string[], label: string): void {
	if (typeof value !== "object" || value === null) {
		throw new HostContributionError(`${label} must be an object`);
	}
	for (const method of methods) {
		if (typeof (value as Record<string, unknown>)[method] !== "function") {
			throw new HostContributionError(`${label}.${method} must be a function`);
		}
	}
}

/**
 * Execution environment adapter for injected host contributions: every {@link FileSystem} member delegates to the
 * contributed bridge; `exec` delegates to the contributed shell or, when none was contributed, always resolves to
 * `ExecutionError("shell_unavailable")` (method retained, typed error — never a throw; capability absence is normally
 * already enforced upstream by negotiated absence of the bash tool).
 *
 * Also usable as the shell-absent base for other assembly entries (e.g. a browser environment over an OPFS-backed
 * {@link FileSystem}).
 */
export class HostedExecutionEnv implements ExecutionEnv {
	private readonly fs: FileSystem;
	private readonly shell: Shell | undefined;

	constructor(fs: FileSystem, shell: Shell | undefined) {
		this.fs = fs;
		this.shell = shell;
	}

	get cwd(): string {
		return this.fs.cwd;
	}

	set cwd(value: string) {
		this.fs.cwd = value;
	}

	absolutePath(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
		return this.fs.absolutePath(path, abortSignal);
	}

	joinPath(parts: string[], abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
		return this.fs.joinPath(parts, abortSignal);
	}

	readTextFile(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
		return this.fs.readTextFile(path, abortSignal);
	}

	readTextLines(
		path: string,
		options?: { maxLines?: number; abortSignal?: AbortSignal },
	): Promise<Result<string[], FileError>> {
		return this.fs.readTextLines(path, options);
	}

	readBinaryFile(path: string, abortSignal?: AbortSignal): Promise<Result<Uint8Array, FileError>> {
		return this.fs.readBinaryFile(path, abortSignal);
	}

	writeFile(path: string, content: string | Uint8Array, abortSignal?: AbortSignal): Promise<Result<void, FileError>> {
		return this.fs.writeFile(path, content, abortSignal);
	}

	appendFile(path: string, content: string | Uint8Array, abortSignal?: AbortSignal): Promise<Result<void, FileError>> {
		return this.fs.appendFile(path, content, abortSignal);
	}

	renameFile(
		sourcePath: string,
		destinationPath: string,
		abortSignal?: AbortSignal,
	): Promise<Result<void, FileError>> {
		return this.fs.renameFile(sourcePath, destinationPath, abortSignal);
	}

	fileInfo(path: string, abortSignal?: AbortSignal): Promise<Result<FileInfo, FileError>> {
		return this.fs.fileInfo(path, abortSignal);
	}

	listDir(path: string, abortSignal?: AbortSignal): Promise<Result<FileInfo[], FileError>> {
		return this.fs.listDir(path, abortSignal);
	}

	canonicalPath(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
		return this.fs.canonicalPath(path, abortSignal);
	}

	exists(path: string, abortSignal?: AbortSignal): Promise<Result<boolean, FileError>> {
		return this.fs.exists(path, abortSignal);
	}

	createDir(
		path: string,
		options?: { recursive?: boolean; abortSignal?: AbortSignal },
	): Promise<Result<void, FileError>> {
		return this.fs.createDir(path, options);
	}

	remove(
		path: string,
		options?: { recursive?: boolean; force?: boolean; abortSignal?: AbortSignal },
	): Promise<Result<void, FileError>> {
		return this.fs.remove(path, options);
	}

	createTempDir(prefix?: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
		return this.fs.createTempDir(prefix, abortSignal);
	}

	createTempFile(options?: {
		prefix?: string;
		suffix?: string;
		abortSignal?: AbortSignal;
	}): Promise<Result<string, FileError>> {
		return this.fs.createTempFile(options);
	}

	exec(
		command: string,
		options?: ShellExecOptions,
	): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>> {
		if (!this.shell) {
			return Promise.resolve(
				err(new ExecutionError("shell_unavailable", "Shell capability not negotiated for this environment")),
			);
		}
		return this.shell.exec(command, options);
	}

	async cleanup(): Promise<void> {
		const cleanups = [this.fs.cleanup(), this.shell?.cleanup()].filter((p): p is Promise<void> => p !== undefined);
		await Promise.allSettled(cleanups);
	}
}

/**
 * Hosted-profile assembly entry: synchronously derive {@link HarnessEnv} from host contributions.
 *
 * The declared `cwd` is applied to the contributed bridge (`fs.cwd = contributions.cwd`) so that relative-path
 * resolution inside the bridge and the environment-facing `cwd` stay consistent. Before assembling, contributions are
 * smoke-checked structurally (every contract member present as a function); violations reject assembly with
 * {@link HostContributionError} instead of running with a broken bridge. Disk extension discovery is never negotiated
 * on here: a host filesystem injection does not light up the jiti channel — extensions must use the bundled channel.
 */
export function createHostedHarnessEnv(contributions: HostContributions): HarnessEnv {
	assertMethods(contributions.fs, [...FILE_SYSTEM_METHODS, "cleanup"], "HostContributions.fs");
	if (typeof contributions.fs.cwd !== "string") {
		throw new HostContributionError("HostContributions.fs.cwd must be a string");
	}
	if (contributions.shell !== undefined) {
		assertMethods(contributions.shell, SHELL_METHODS, "HostContributions.shell");
	}
	if (typeof contributions.cwd !== "string") {
		throw new HostContributionError("HostContributions.cwd must be a string");
	}

	contributions.fs.cwd = contributions.cwd;
	return {
		env: new HostedExecutionEnv(contributions.fs, contributions.shell),
		capabilities: negotiate({
			shell: contributions.shell,
			diskExtensions: false,
			concurrentFsAccess: contributions.concurrentFsAccess ?? true,
		}),
	};
}
