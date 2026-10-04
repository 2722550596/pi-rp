import type { MemoryDriverOptions } from "./driver.ts";
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
export { generateDiffString } from "./diff.ts";
export {
	type MemoryDatabase,
	type MemoryDriverOptions,
	type MemoryStatement,
	openDatabase,
	openDatabaseReadonly,
	ReadonlyOpenError,
} from "./driver.ts";
export {
	type BrowserSqliteDatabaseFactoryOptions,
	createBrowserSqliteDatabaseFactory,
	OPFS_SAHPoolVfs,
} from "./driver-browser.ts";
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
	renderAuditView,
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
	buildExcerpt,
	buildGlossaryTerms,
	buildPool,
	computeVectorScores,
	EXCERPT_LEN,
	formatRelativeWorldTime,
	importanceScore,
	keywordScore,
	type RecalledItem,
	type RecallMode,
	rank,
	recencyBoost,
	type SearchOptions,
	search,
	segmentRangeInDoc,
	summarize,
	toEpochDays,
	type VectorHit,
	W_IMPORTANCE,
	W_KEYWORD,
	W_VECTOR,
} from "./recall.ts";
export {
	createSchema,
	FTS_REBUILD_KEY,
	MIGRATABLE_FROM,
	NODE_FTS_DDL,
	SCHEMA_VERSION,
	SCHEMA_VERSION_KEY,
	type SchemaOpenResult,
} from "./schema.ts";
export {
	createMemorySlots,
	type MemorySlotDefinition,
	type MemorySlotsOptions,
	type RecentSlotOptions,
} from "./slots.ts";
export {
	type ExportSnapshot,
	type MemoryAuditDetails,
	type MemoryAuditRecord,
	type MemoryNode,
	MemoryStore,
	type NodeInput,
	type NodePatch,
	type RawEntry,
	type RecallOptions,
	type VisibilityPredicate,
} from "./store.ts";
export {
	type ActiveTempRow,
	buildTempNotifyContent,
	checkTempThreshold,
	countActiveTempNodes,
	DEFAULT_TEMP_THRESHOLD,
	listActiveTempRows,
	RP_NOTIFY_TYPE,
	TEMP_TIDY_GUIDE_LINES,
	type TempNotifyMessage,
	type TempSettings,
} from "./temp-notify.ts";
export {
	type BriefingExtraction,
	buildTidyFailureContent,
	DEFAULT_TIDY_MAX_TURNS,
	DEFAULT_TIDY_TIMEOUT_MS,
	extractBriefing,
	type ParsedAutoTidy,
	parseAutoTidySettings,
	readTidyLock,
	refreshTidyLock,
	releaseTidyLock,
	renderTempList,
	runTidy,
	type SideStreamHandle,
	TIDY_BRIEFING_MAX_CHARS,
	TIDY_HEARTBEAT_MS,
	TIDY_LAST_FINISH_KEY,
	TIDY_LOCK_KEY,
	TIDY_LOCK_STALE_MS,
	TIDY_MODEL_ID,
	TIDY_RETRY_COOLDOWN_MS,
	TIDY_TEMP_LIST_MAX_ENTRIES,
	type TidyFailureReason,
	type TidyHost,
	type TidyLockHandle,
	type TidyLockValue,
	type TidyOutcome,
	type TidyRunnerOptions,
	truncateBriefing,
	tryAcquireTidyLock,
} from "./temp-tidy.ts";
export {
	DEFAULT_TIDY_SYSTEM_PROMPT,
	DEFAULT_TIDY_TASK_TEMPLATE,
	renderTidyTaskPrompt,
} from "./tidy-prompts.ts";
export {
	createMemoryTokenizer,
	type MemoryTokenizer,
	type MemoryTokenizerSpace,
	tokenizeForMatch,
	tokenizeForSearch,
} from "./tokenize.ts";
export {
	AWAKEN_URIS_KEY,
	computeRevisedContent,
	createMemoryTools,
	getAwakenUris,
	type MemoryToolContext,
	type MemoryToolDef,
	type MemoryToolResult,
	setAwakenUris,
} from "./tools.ts";

export async function openMemoryStore(path: string, options?: MemoryDriverOptions): Promise<MemoryStore> {
	const db = await openDatabase(path, options);
	createSchema(db);
	return new MemoryStore(db);
}
