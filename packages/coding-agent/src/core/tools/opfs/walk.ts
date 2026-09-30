import type { GitIgnoreChain } from "./gitignore.ts";
import type { OpfsDirectoryHandle, OpfsEntry, OpfsFileHandle } from "./types.ts";

export interface WalkCallbacks {
	/** Read a file as text (used for `.gitignore` files encountered during descent). */
	readText(file: OpfsFileHandle, absolutePath: string): Promise<string>;
	/**
	 * Visit a non-ignored file (hidden files included). Return `false` to stop
	 * the whole walk (limit early-stop / abort).
	 */
	onFile(
		absolutePath: string,
		relParts: string[],
		file: OpfsFileHandle,
	): Promise<boolean | undefined> | boolean | undefined;
}

export interface WalkOptions {
	/** Directory handle to start from (the resolved search root). */
	rootDir: OpfsDirectoryHandle;
	/** Absolute virtual path of the root dir (posix, no trailing slash). */
	rootPath: string;
	/** Fresh per-walk chain; rules are collected from `.gitignore` files during descent. */
	gitignore: GitIgnoreChain;
	callbacks: WalkCallbacks;
	signal?: AbortSignal;
}

/**
 * Shared traversal core for the OPFS grep/find engines: depth-first walk with
 * sorted (deterministic) entry order, `.git` directories skipped, hidden files
 * included (rg/fd `--hidden` parity), gitignore pruning, and limit early-stop.
 * Directory-level gitignore matches prune the whole subtree.
 */
export async function walkTree(opts: WalkOptions): Promise<void> {
	let stopped = false;

	const visit = async (dir: OpfsDirectoryHandle, absDir: string, relParts: string[]): Promise<void> => {
		if (stopped) return;
		if (opts.signal?.aborted) {
			stopped = true;
			return;
		}
		const entries: Array<[string, OpfsEntry]> = [];
		for await (const entry of dir.entries()) entries.push(entry);
		entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

		// Consume .gitignore rules before visiting siblings so they apply to all of them.
		for (const [name, handle] of entries) {
			if (name !== ".gitignore" || handle.kind !== "file") continue;
			try {
				opts.gitignore.add(relParts.length, await opts.callbacks.readText(handle, `${absDir}/${name}`));
			} catch {
				// Unreadable .gitignore: skip its rules, keep walking (rg parity).
			}
		}

		for (const [name, handle] of entries) {
			if (stopped) return;
			if (name === ".git" && handle.kind === "directory") continue;
			const childRel = [...relParts, name];
			const isDir = handle.kind === "directory";
			if (opts.gitignore.ignores(childRel, isDir)) continue;
			const childAbs = `${absDir}/${name}`;
			if (isDir) {
				await visit(handle, childAbs, childRel);
			} else {
				const stop = await opts.callbacks.onFile(childAbs, childRel, handle);
				if (stop === false) {
					stopped = true;
					return;
				}
			}
		}
	};

	await visit(opts.rootDir, opts.rootPath, []);
}
