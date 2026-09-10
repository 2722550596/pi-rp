/**
 * DB path resolution (docs/memory-system.md §2).
 *
 * Precedence: CLI --memory-db > settings memory.dbPath > preset declaration >
 * default <cwd>/.pi/memory.db. Result is always absolute.
 */
import { isAbsolute, join, resolve } from "node:path";
import type { AutoretainTask } from "./autoretain.ts";

/** settings.memory.* shape (coding-agent Settings.memory, §15.3). */
export interface MemorySettings {
	dbPath?: string;
	rawLog?: { customTypes?: "all-display-true" | "none" | string[] };
	autoretain?: {
		everyNTurns?: number;
		tasks?: AutoretainTask[];
		models?: { smol?: string; default?: string };
	};
	recall?: {
		topK?: number;
		minScore?: number;
		/** Keyword-mode injection floor; default 0.12 (§5.9). */
		keywordMinScore?: number;
		blocklist?: string[];
	};
	temp?: { threshold?: number };
	embeddings?: { mode?: "api" | "off"; model?: string; apiUrl?: string };
	/** Revision retention (§12 decision 20): max versions kept per node; undefined = unlimited. */
	revisions?: { maxVersionsPerNode?: number };
}

/** Prompt-preset memory declaration (preset > default). */
export interface PresetMemoryDeclaration {
	memory?: { dbPath?: string };
}

export function resolveMemoryDbPath(
	cliFlag: string | undefined,
	settings: { memory?: MemorySettings } | undefined,
	preset: PresetMemoryDeclaration | undefined,
	cwd: string,
): string {
	const declared = cliFlag ?? settings?.memory?.dbPath ?? preset?.memory?.dbPath ?? join(cwd, ".pi", "memory.db");
	return isAbsolute(declared) ? declared : resolve(cwd, declared);
}
