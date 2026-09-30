/**
 * Photon image processing wrapper.
 *
 * This module provides a unified interface to @silvia-odwyer/photon-node that works in:
 * 1. Node.js (development, npm run build)
 * 2. Bun compiled binaries (standalone distribution)
 *
 * The challenge: photon-node's CJS entry uses fs.readFileSync(__dirname + '/photon_rs_bg.wasm')
 * which bakes the build machine's absolute path into Bun compiled binaries.
 *
 * Solution:
 * 1. Patch fs.readFileSync to redirect missing photon_rs_bg.wasm reads
 * 2. Copy photon_rs_bg.wasm next to the executable in build:binary
 */

import { createRequire, dirname, fileURLToPath, join } from "./node-globals.ts";

// require() targets the node fs module. Browser builds alias `node:module`/`node:fs`
// to shims: createRequire() then yields a structured-throw function, so the fs
// acquisition below fails inside patchPhotonWasmRead (no-op patch) and the wasm
// glue import fails in loadPhoton — loadPhoton resolves to null (image processing
// gracefully unavailable), never a module-eval crash.
const require = createRequire(import.meta.url);

/** Node fs face used by the wasm-path patch (node only; see module comment). */
interface PatchFs {
	readFileSync: (...args: unknown[]) => unknown;
	existsSync: (path: string) => boolean;
}

let patchFs: PatchFs | undefined;
function nodeFs(): PatchFs {
	patchFs ??= require("fs") as PatchFs;
	return patchFs;
}

// Re-export types from the main package
export type { PhotonImage as PhotonImageType } from "@silvia-odwyer/photon-node";

type ReadFileSync = (file: string | URL | number, options?: string | number | undefined) => unknown;

const WASM_FILENAME = "photon_rs_bg.wasm";

// Lazy-loaded photon module
let photonModule: typeof import("@silvia-odwyer/photon-node") | null = null;
let loadPromise: Promise<typeof import("@silvia-odwyer/photon-node") | null> | null = null;

function pathOrNull(file: string | URL | number): string | null {
	if (typeof file === "string") {
		return file;
	}
	if (file instanceof URL) {
		return fileURLToPath(file);
	}
	return null;
}

function getFallbackWasmPaths(): string[] {
	const execDir = dirname(process.execPath);
	return [join(execDir, WASM_FILENAME), join(execDir, "photon", WASM_FILENAME), join(process.cwd(), WASM_FILENAME)];
}

function patchPhotonWasmRead(): () => void {
	let fs: PatchFs;
	try {
		fs = nodeFs();
	} catch {
		// Browser profile (shimmed node:module): no fs to patch; the wasm glue
		// import in loadPhoton fails and resolves to null instead.
		return () => {};
	}
	const originalReadFileSync: ReadFileSync = fs.readFileSync.bind(fs);
	const fallbackPaths = getFallbackWasmPaths();
	const mutableFs = fs as { readFileSync: ReadFileSync };

	const patchedReadFileSync: ReadFileSync = ((...args: Parameters<ReadFileSync>) => {
		const [file, options] = args;
		const resolvedPath = pathOrNull(file);

		if (resolvedPath?.endsWith(WASM_FILENAME)) {
			try {
				return originalReadFileSync(...args);
			} catch (error) {
				const err = error as NodeJS.ErrnoException;
				if (err?.code && err.code !== "ENOENT") {
					throw error;
				}

				for (const fallbackPath of fallbackPaths) {
					if (!fs.existsSync(fallbackPath)) {
						continue;
					}
					if (options === undefined) {
						return originalReadFileSync(fallbackPath);
					}
					return originalReadFileSync(fallbackPath, options);
				}

				throw error;
			}
		}

		return originalReadFileSync(...args);
	}) as ReadFileSync;

	try {
		mutableFs.readFileSync = patchedReadFileSync;
	} catch {
		Object.defineProperty(fs, "readFileSync", {
			value: patchedReadFileSync,
			writable: true,
			configurable: true,
		});
	}

	return () => {
		try {
			mutableFs.readFileSync = originalReadFileSync;
		} catch {
			Object.defineProperty(fs, "readFileSync", {
				value: originalReadFileSync,
				writable: true,
				configurable: true,
			});
		}
	};
}

/**
 * Load the photon module asynchronously.
 * Returns cached module on subsequent calls.
 */
export async function loadPhoton(): Promise<typeof import("@silvia-odwyer/photon-node") | null> {
	if (photonModule) {
		return photonModule;
	}

	if (loadPromise) {
		return loadPromise;
	}

	loadPromise = (async () => {
		const restoreReadFileSync = patchPhotonWasmRead();
		try {
			photonModule = await import("@silvia-odwyer/photon-node");
			return photonModule;
		} catch {
			photonModule = null;
			return photonModule;
		} finally {
			restoreReadFileSync();
		}
	})();

	return loadPromise;
}
