import { openDatabase } from "./driver.ts";
import { createSchema } from "./schema.ts";
import { MemoryStore } from "./store.ts";

export {
	AUTORETAIN_JSON_CONTRACT,
	type AutoretainHost,
	type AutoretainLanding,
	type AutoretainOutcome,
	type AutoretainTask,
	DEFAULT_AUTORETAIN_EVERY_N_TURNS,
	DEFAULT_AUTORETAIN_TASKS,
	dueTasks,
	parseAutoretainJson,
	runAutoretainTask,
} from "./autoretain.ts";
export { type MemorySettings, type PresetMemoryDeclaration, resolveMemoryDbPath } from "./config.ts";
export { type MemoryDatabase, type MemoryStatement, openDatabase } from "./driver.ts";
export {
	buildMemoriesBlock,
	collectPriorContext,
	createMemoryModule,
	DEFAULT_DOMAIN_BLOCKLIST,
	MEMORY_TOOL_NAMES,
	type MemoryBranchSnapshot,
	type MemoryModule,
	type MemoryModuleHost,
	type MemoryModuleOptions,
	type MemoryModuleSessionInfo,
	type MemoryTurnMessage,
	RECALL_HIGH_CONFIDENCE,
	RECALL_MIN_SCORE,
	RECALL_TOP_K,
	RP_MEMORIES_TYPE,
	rebuildInjectedFromEntries,
	shouldCaptureCustomType,
} from "./module.ts";
export { createSchema } from "./schema.ts";
export { createMemorySlots, type MemorySlotDefinition, type RecentSlotOptions } from "./slots.ts";
export {
	type ExportSnapshot,
	type MemoryNode,
	MemoryStore,
	type NodeInput,
	type NodePatch,
	type RawEntry,
	type RecallOptions,
	type VisibilityPredicate,
} from "./store.ts";
export {
	renderDiagnosticView,
	renderForgottenView,
	renderGlossaryView,
	renderIndexView,
	renderRecentView,
	renderTimelineView,
	renderWakeupView,
} from "./memory-views.ts";
export {
	buildTempNotifyContent,
	checkTempThreshold,
	countActiveTempNodes,
	DEFAULT_TEMP_THRESHOLD,
	RP_NOTIFY_TYPE,
	type TempNotifyMessage,
	type TempSettings,
} from "./temp-notify.ts";
export { tokenizeForMatch, tokenizeForSearch } from "./tokenize.ts";
export {
	AWAKEN_URIS_KEY,
	createMemoryTools,
	getAwakenUris,
	type MemoryToolContext,
	type MemoryToolDef,
	type MemoryToolResult,
	setAwakenUris,
} from "./tools.ts";

export async function openMemoryStore(path: string): Promise<MemoryStore> {
	const db = await openDatabase(path);
	createSchema(db);
	return new MemoryStore(db);
}
