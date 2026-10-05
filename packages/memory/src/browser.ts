import type { MemoryDriverOptions } from "./driver.ts";
import { createSchema } from "./schema.ts";
import { MemoryStore } from "./store.ts";

export { type MemorySettings, type PresetMemoryDeclaration, resolveMemoryDbPath } from "./config.ts";
export { generateDiffString } from "./diff.ts";
export {
	createMemoryModule,
	MEMORY_TOOL_NAMES,
	type MemoryBranchSnapshot,
	type MemoryModule,
	type MemoryModuleHost,
	type MemoryModuleSessionInfo,
	type MemoryTurnMessage,
	shouldCaptureCustomType,
} from "./module.ts";
export type { MemorySlotDefinition } from "./slots.ts";
export type { MemoryStore } from "./store.ts";
export { computeRevisedContent } from "./tools.ts";

/** Browser assembly always injects its SQLite-WASM factory; never import the Node default driver. */
export async function openMemoryStore(path: string, options: MemoryDriverOptions): Promise<MemoryStore> {
	if (!options?.sqlite) throw new Error("Browser memory store requires an injected SQLite factory");
	const db = await options.sqlite.open(path === "" ? ":memory:" : path);
	createSchema(db);
	return new MemoryStore(db);
}
