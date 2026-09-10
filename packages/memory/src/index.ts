import { openDatabase } from "./driver.ts";
import { createSchema } from "./schema.ts";
import { MemoryStore } from "./store.ts";

export {
	AUTORETAIN_JSON_CONTRACT,
	type AutoretainHost,
	type AutoretainLanding,
	type AutoretainOutcome,
	type AutoretainTask,
	buildTaskPrompt,
	DEFAULT_AUTORETAIN_EVERY_N_TURNS,
	DEFAULT_AUTORETAIN_MAX_INPUT_CHARS,
	DEFAULT_AUTORETAIN_MAX_OUTPUT_TOKENS,
	DEFAULT_AUTORETAIN_TASKS,
	dueTasks,
	parseAutoretainJson,
	redactSecrets,
	runAutoretainTask,
} from "./autoretain.ts";
export { type MemorySettings, type PresetMemoryDeclaration, resolveMemoryDbPath } from "./config.ts";
export { type MemoryDatabase, type MemoryStatement, openDatabase } from "./driver.ts";
export {
	chunkText,
	cosine,
	DEFAULT_EMBEDDING_API_URL,
	DEFAULT_EMBEDDING_MODEL,
	EMBED_CHUNK_OVERLAP,
	EMBED_INPUT_MAX,
	EmbeddingClient,
	type EmbeddingsConfig,
	embedDocText,
	embedHash,
	QUERY_INSTRUCTION,
	resolveEmbeddingsConfig,
} from "./embeddings.ts";
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
	RECALL_KEYWORD_MIN_SCORE,
	RECALL_MIN_SCORE,
	RECALL_TOP_K,
	RP_MEMORIES_TYPE,
	rebuildInjectedFromEntries,
	shouldCaptureCustomType,
} from "./module.ts";
export {
	buildGlossaryTerms,
	buildPool,
	computeVectorScores,
	importanceScore,
	keywordScore,
	type RecalledItem,
	type RecallMode,
	rank,
	recencyBoost,
	type SearchOptions,
	search,
	summarize,
	toEpochDays,
	W_IMPORTANCE,
	W_KEYWORD,
	W_VECTOR,
} from "./recall.ts";
export { createSchema, SCHEMA_VERSION, SCHEMA_VERSION_KEY } from "./schema.ts";
export {
	createMemorySlots,
	type MemorySlotDefinition,
	type MemorySlotsOptions,
	type RecentSlotOptions,
} from "./slots.ts";
export {
	type ExportSnapshot,
	type MemoryAuditDetails,
	type MemoryNode,
	MemoryStore,
	type NodeInput,
	type NodePatch,
	type RawEntry,
	type RecallOptions,
	type VisibilityPredicate,
} from "./store.ts";
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
