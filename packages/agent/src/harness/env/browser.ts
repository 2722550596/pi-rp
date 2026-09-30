import { type BrowserHarnessEnv, negotiate } from "../capabilities.ts";
import { HostedExecutionEnv } from "./hosted.ts";
import { BROWSER_DEFAULT_WORKSPACE, OpfsFileSystem, opfsErrorCode } from "./opfs/index.ts";
import type { OpfsDirectoryHandle } from "./opfs/types.ts";

/**
 * Structural view of the WHATWG `FileSystemDirectoryHandle` the OPFS implementations consume.
 *
 * Declared locally because pi-agent-core must stay free of DOM lib dependencies (browser-smoke constraint: no
 * `lib: "dom"` in this package's TS program). A browser-provided handle satisfies this structurally; the full
 * WHATWG surface lives behind the OPFS implementation layer (module B).
 */
export type FileSystemDirectoryHandle = OpfsDirectoryHandle;

/**
 * Options for the browser-profile assembly entry: the OPFS namespace root and the workspace subtree the file tools
 * operate on. The root is obtained by the caller from `navigator.storage.getDirectory()` (or a layout subtree of it);
 * the canonical `cwd` value is the frozen default workspace `/workspace/default` (contract §6.1, exported as
 * `BROWSER_DEFAULT_WORKSPACE`).
 */
export interface BrowserHarnessEnvOptions {
	/** Root of the single-root POSIX-style addressing namespace presented by the environment. */
	readonly root: FileSystemDirectoryHandle;
	/** Workspace subtree root; required, never defaulted (the canonical value is `BROWSER_DEFAULT_WORKSPACE`). */
	readonly cwd: string;
}

/**
 * Frozen signature of the browser-profile assembly entry: assembles the OPFS {@link FileSystem} over the caller's
 * root handle and wraps it in a shell-absent execution environment.
 *
 * Contract: asynchronous because OPFS handle acquisition is async; an unusable root MUST reject with
 * {@link BrowserEnvAcquireError} — never a silent in-memory fallback; capabilities are negotiated to the fixed
 * browser values (`shell: false, diskExtensions: false, concurrentFsAccess: false`) via `negotiate`, the only
 * capabilities constructor.
 */
export type CreateBrowserHarnessEnv = (options: BrowserHarnessEnvOptions) => Promise<BrowserHarnessEnv>;

/**
 * Typed rejection for OPFS root acquisition failure. Callers decide on an explicit storage downgrade (e.g. rebuilding
 * on an in-memory environment); the assembly entry itself never degrades silently.
 */
export class BrowserEnvAcquireError extends Error {
	constructor(message: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "BrowserEnvAcquireError";
	}
}

/**
 * Best-effort persistent-storage request for the browser profile (`navigator.storage.persist()`). Per the storage
 * design, a rejected request does not block assembly: callers surface the "data may be evicted" degradation in their
 * UI. Resolves to `false` when the API is unavailable or the request was declined.
 */
export async function requestOpfsPersistence(): Promise<boolean> {
	const storage = (globalThis as { navigator?: { storage?: { persist?: () => Promise<boolean> } } }).navigator
		?.storage;
	if (!storage?.persist) return false;
	try {
		return await storage.persist();
	} catch {
		return false;
	}
}

/**
 * Browser-profile assembly entry. The environment presents the caller's OPFS root as a single POSIX-style namespace;
 * `cwd` addresses the workspace subtree the file tools operate on. Storage is a hard existence premise of the
 * harness (contract §4 principle 2 does not apply): a structurally unusable root rejects with a typed error instead
 * of degrading.
 */
export async function createBrowserHarnessEnv(options: BrowserHarnessEnvOptions): Promise<BrowserHarnessEnv> {
	try {
		// Acquisition smoke: the entry refuses to assemble over a handle that cannot perform namespace operations.
		await options.root.values().next();
	} catch (error) {
		throw new BrowserEnvAcquireError(
			`Failed to acquire the OPFS root namespace: ${error instanceof Error ? error.message : String(error)}` +
				(opfsErrorCode(error) === "not_supported"
					? " (OPFS requires a secure context; check browser settings/private mode)"
					: ""),
			error instanceof Error ? error : undefined,
		);
	}
	const env = new HostedExecutionEnv(new OpfsFileSystem(options.root, options.cwd), undefined);
	const capabilities = negotiate({
		diskExtensions: false,
		concurrentFsAccess: false,
	}) as BrowserHarnessEnv["capabilities"];
	return { env, capabilities };
}

export { BROWSER_DEFAULT_WORKSPACE };
