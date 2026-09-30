import type { ExecutionEnv, Shell } from "./types.ts";

/**
 * The single source of truth for harness environment capabilities.
 *
 * Derived exactly once by {@link negotiate} at an assembly entry point and read-only afterwards. No other module may
 * construct or spell out a `Capabilities` object itself (harness contract: capabilities have exactly one source).
 *
 * Capability absence is expressed as negotiated absence upstream of the model-visible surface (e.g. the bash tool is
 * not registered), never as a runtime error thrown from shared harness code.
 */
export interface Capabilities {
	/**
	 * Process/command execution capability (real shell or host-injected equivalent).
	 *
	 * Consumers: bash tool switch in the capability-to-tool table, extension `ctx.exec`, and npm-git installs.
	 */
	readonly shell: boolean;
	/**
	 * Availability of the extension on-disk discovery channel (jiti). The bundled-extension channel is unaffected by
	 * this field. Note: a host injecting a real filesystem does NOT light up this channel; it is negotiated per entry.
	 */
	readonly diskExtensions: boolean;
	/**
	 * Whether the filesystem has concurrent writers outside this session (other processes/windows/tabs).
	 *
	 * `false` ⇒ storage-level file locks MUST be bypassed entirely (no-op), not swapped for another implementation.
	 * `false` on a browser profile implies "single tab, single writer"; a multi-tab upgrade path (Web Locks) is a
	 * separate decision and must not silently widen this semantics.
	 */
	readonly concurrentFsAccess: boolean;
}

/**
 * The sole product of a harness assembly entry point: the environment and its negotiated capabilities share one origin
 * and one lifecycle. Downstream consumers (tool tables, storage assembly, extension runtime, distribution entry) take
 * this object as a whole; capability queries are legitimate only at assembly points and extension registration
 * boundaries — never inside tool execution contexts or the agent session.
 */
export interface HarnessEnv {
	/** Upstream execution environment interface, unchanged. */
	readonly env: ExecutionEnv;
	/** The only capability source (see {@link Capabilities}). */
	readonly capabilities: Capabilities;
}

/**
 * Derive the {@link Capabilities} object from the injected parts. This is the only legitimate constructor for
 * {@link Capabilities}; call sites must be harness assembly entry points only (node/browser/hosted).
 *
 * Derivation rules (frozen capability table):
 * - `shell` = presence of an injected {@link Shell} (a full {@link ExecutionEnv} satisfies this structurally).
 * - `diskExtensions` defaults to `false`; the node entry point must negotiate it on explicitly.
 * - `concurrentFsAccess` defaults to `true` (conservative: an undeclared host is treated as having concurrent writers).
 *
 * The returned object is frozen; capabilities are re-derived at every assembly and never persisted.
 */
export function negotiate(parts: {
	shell?: Shell;
	diskExtensions?: boolean;
	concurrentFsAccess?: boolean;
}): Capabilities {
	return Object.freeze({
		shell: parts.shell !== undefined,
		diskExtensions: parts.diskExtensions ?? false,
		concurrentFsAccess: parts.concurrentFsAccess ?? true,
	});
}

/** Specialized {@link HarnessEnv} for the node profile: full capabilities, fixed at assembly. */
export interface NodeHarnessEnv extends HarnessEnv {
	readonly capabilities: { shell: true; diskExtensions: true; concurrentFsAccess: true };
}

/** Specialized {@link HarnessEnv} for the browser profile: no shell, no disk extension channel, no external writers. */
export interface BrowserHarnessEnv extends HarnessEnv {
	readonly capabilities: { shell: false; diskExtensions: false; concurrentFsAccess: false };
}
