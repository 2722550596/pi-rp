/**
 * Storage seams for pi-owned state (sessions, settings, auth, models, trust, keybindings, resources).
 *
 * Three parallel injection points, assembled as one {@link HarnessStores} object at profile entries:
 * - {@link StorageBackend}: synchronous fs face — point-for-point stand-in for the `node:fs` synchronous calls the
 *   coding-agent state code used to make directly.
 * - {@link StateLocks}: mutual-exclusion face — the seam that replaced the three duplicated proper-lockfile wrappers.
 * - {@link StatePaths}: path-resolution face — the seam for `getAgentDir()` and its derivations.
 *
 * The browser profile assembles the OPFS implementations from `@earendil-works/pi-agent-core/web`; the node profile
 * assembles the node implementations from `@earendil-works/pi-agent-core/node`. The lock contract is tied to the
 * `Capabilities.concurrentFsAccess` field: `false` ⇒ locks MUST be bypassed entirely (a structural no-op), which is a
 * safe degradation because JS gives synchronous functions within one context no interleaving — never a second lock
 * implementation.
 *
 * Virtual path namespace (frozen contract §6): every path entering these seams is an absolute POSIX-style string. On
 * the node profile that string is a real absolute path; on the browser profile it addresses the OPFS root obtained
 * from `navigator.storage.getDirectory()` (`/state/**` for pi state, `/workspace/**` for the agent workspace).
 */

/**
 * Synchronous storage face. Method-for-method counterpart of the `node:fs` synchronous calls in the state code —
 * one method per former call site shape, none more (dead code) and none less (a call site would fall through).
 */
export interface StorageBackend {
	/** Implementation tag, usable by diagnostics without profile-name sniffing. */
	readonly kind: "node-fs" | "opfs" | "host-fs";

	existsSync(path: string): boolean;
	readTextFileSync(path: string): string;
	/**
	 * Read UTF-8 text lines synchronously. `maxLines` stops reading early, mirroring the bounded streaming scans the
	 * session manager performs on session headers.
	 */
	readTextLinesSync(path: string, maxLines?: number): string[];
	/**
	 * Write UTF-8 text. `flag: "wx"` is create-exclusive (the `openSync(path, "wx")` semantics): it fails when the
	 * target exists. `flag: "w"` truncates or creates.
	 */
	writeTextFileSync(path: string, data: string, options?: { flag?: "w" | "wx" }): void;
	appendTextFileSync(path: string, data: string): void;
	/**
	 * `mode` is the node `mkdirSync` creation-mode (e.g. credential dirs 0700); the OPFS profile ignores it (no POSIX
	 * permissions).
	 */
	mkdirSync(path: string, options?: { recursive?: boolean; mode?: number }): void;
	/**
	 * `isSymbolicLink` is filled by the node profile (real dirent flag); the OPFS profile never sets it (no symlinks).
	 * Consumers that branch on it must treat absent as false.
	 */
	readdirSync(path: string): Array<{ name: string; isFile: boolean; isDirectory: boolean; isSymbolicLink?: boolean }>;
	statSync(path: string): { size: number; mtimeMs: number; isFile: boolean; isDirectory: boolean };
	/** Atomic on the node profile (same-filesystem rename). */
	renameSync(source: string, destination: string): void;
	/**
	 * Node profile: `realpathSync`, falling back to the input path when resolution fails (existing canonicalizePath
	 * behavior). OPFS profile: lexical normalization (OPFS has no symlinks).
	 */
	canonicalizeSync(path: string): string;
	/**
	 * Revision stamp used to detect foreign modifications of tracked files (models-store). Node profile:
	 * `dev:ino:size:mtimeNs:ctimeNs` from a bigint stat. OPFS profile: `size:mtimeMs` composite. Absent when the path
	 * cannot be stat'ed.
	 */
	fileRevisionSync?(path: string): string | undefined;
	/**
	 * POSIX permission stamp for credential files (auth 0600). Node profile: real `chmodSync`. OPFS profile: no-op —
	 * OPFS has no POSIX permissions; the credential boundary is the origin (11-B §7.3). Optional: only credential
	 * flows need it.
	 */
	chmodSync?(path: string, mode: number): void;
}

/**
 * Mutual-exclusion face for state files. `concurrentFsAccess: false` ⇒ both members are structural no-ops (bypass,
 * not a second implementation). Implementations must never throw for capability absence.
 */
export interface StateLocks {
	/** Acquire a synchronous lock around `path`; returns the release function. */
	lockSync(path: string, options?: { lockfilePath?: string }): () => void;
	/**
	 * Acquire an asynchronous lock (auth-storage semantics: stale release after 30s, abortable). `onCompromised`
	 * receives proper-lockfile's stolen-lock notification instead of the default rethrow — the auth backend tracks
	 * compromised locks in its own error surface; the no-op browser implementation ignores it.
	 */
	lockAsync(
		path: string,
		options?: { signal?: AbortSignal; onCompromised?: (error: Error) => void },
	): Promise<() => Promise<void>>;
}

/**
 * Path-resolution face. The only member is the agent-state root; every derived state path (sessions, models, auth,
 * settings, trust, keybindings, prompts, themes, tools, bin) is built by callers via `join(paths.agentDir(), …)`.
 * Project-side paths (`getProjectConfigDir(cwd, …)`) stay out of this interface: they already receive `cwd` from the
 * caller, and on the browser profile that is the workspace virtual path.
 */
export interface StatePaths {
	/** Node profile: the current `getAgentDir()` resolution. Browser profile: `/state/agent` (contract §6.1). */
	agentDir(): string;
}

/**
 * The three storage seams as one assembly object, constructed at profile entries alongside {@link HarnessEnv} —
 * parallel to it (not merged into it: `HarnessEnv = { env, capabilities }` is frozen upstream).
 */
export interface HarnessStores {
	storage: StorageBackend;
	locks: StateLocks;
	paths: StatePaths;
}

/**
 * Assembly-facing name for {@link HarnessStores} (15-F入口字段 `stores: StateStores`); one object, two names —
 * {@link HarnessStores} is the 11-B seam vocabulary, `StateStores` the createPiHarness option vocabulary.
 */
export type StateStores = HarnessStores;
