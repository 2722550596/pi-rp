/**
 * Discovery: "is this path a memory DB?", "which memory DBs live under these
 * roots?", and read-only stats for the DB list (plan/memory-web/11-多库发现与注册表.md §6–§7).
 *
 * Two rules shape everything here:
 *
 *   1. **Probing must never write.** A probe opens the file `readOnly`, reads
 *      one `memory_kv` row, closes. It MUST NOT go through `openMemoryStore`
 *      (which would run `createSchema` and pour the memory schema into whatever
 *      SQLite file the user picked — score 1 for every wrong path). Probing
 *      stays read-only even for an in-place-migratable version (v2): the
 *      upgrade happens on the WRITE-open path (`openMemoryStore` →
 *      `createSchema`), never here. This is the only admission gate a path
 *      ever passes.
 *   2. **Read-only opens must never wedge the process.** `DatabaseSync` is
 *      synchronous, so a FIFO would block the event loop forever. The guard for
 *      that lives inside `openDatabaseReadonly` (one sinking point for all
 *      read-only entry points), and scan candidates are filtered by
 *      `Dirent.isFile()` — the second reachable chain into the same hazard.
 *
 * This module MUST NOT import `registry.ts`; the dependency runs the other way
 * (`registry` imports `invalidateStats` so an opened DB's cached stats go stale
 * immediately).
 */
import { type Dirent, readdirSync, type Stats, statSync } from "node:fs";
import path from "node:path";
import { type MemoryDatabase, openDatabaseReadonly, ReadonlyOpenError } from "../driver.ts";
import { MIGRATABLE_FROM, SCHEMA_VERSION } from "../schema.ts";

/** The result of probing a candidate path (§7.1, frozen in the contract §8.1). */
export type ProbeOutcome =
	| { ok: true; schemaVersion: string }
	| {
			ok: false;
			reason: "missing" | "not-a-file" | "not-memory-db" | "incompatible" | "unreadable";
			detail: string;
	  };

/** Read-only stats for one DB, as consumed by `GET /api/databases` (§6.1). */
export interface MemoryDbStats {
	schemaVersion: string;
	nodeCount: number;
	worldTime: string | null;
}

/** Scan result. `scanned` counts DIRECTORIES actually read, never DBs (§6.1). */
export interface DiscoveryResult {
	/** Absolute paths, in traversal order (stable for a stable directory tree). */
	paths: string[];
	/** Directories whose `readdir` was attempted. Not a DB count, not a file count. */
	scanned: number;
	/** Human-readable errors (path + errno name). Never mixed into `paths`. */
	errors: string[];
}

export interface DiscoveryOptions {
	/** Recursion depth cap; the root itself is depth 0. Default 6 (§6.2.1). */
	maxDepth?: number;
	/** Extra directory names to skip, merged into `DEFAULT_SKIP_DIRS`. */
	extraSkipDirs?: readonly string[];
	/** Result cache TTL in ms; 0 disables caching. Default 5000. */
	ttlMs?: number;
	/** Clock injection, for tests. */
	now?: () => number;
}

/**
 * Directories that never hold our DBs and can be enormous. Compared by exact
 * name (NOT `startsWith`, NOT case-insensitive — on Linux `Node_Modules` is a
 * different directory).
 *
 * ⚠️ `.pi` MUST NOT be skipped: it is the directory every DB necessarily lives
 * in (`characters/<char>/.pi/memory.db`).
 */
export const DEFAULT_SKIP_DIRS: readonly string[] = [".git", "node_modules"];

/**
 * Depth 6, not 4. Measured on a real tree: `worlds/<world>/characters/<char>/
 * .pi/memory.db` puts the file in the 5th directory, so depth 4 misses 8 DBs
 * (25 found vs 33). Depth 8 and 10 find the same 33 — the extra two levels cost
 * nothing in completeness and buy a level of headroom.
 */
export const DEFAULT_MAX_DEPTH = 6;

/** Defensive cap on discovered DBs (§6.3); the response shape has no pagination. */
export const MAX_DISCOVERED = 512;

const DEFAULT_TTL_MS = 5000;

interface CacheEntry<T> {
	value: T;
	at: number;
}

interface ScanCache extends CacheEntry<DiscoveryResult> {
	key: string;
}

let scanCache: ScanCache | null = null;
const statsCache = new Map<string, CacheEntry<MemoryDbStats | null>>();

function ttlOf(opts: DiscoveryOptions | undefined): number {
	return opts?.ttlMs ?? DEFAULT_TTL_MS;
}

function clockOf(opts: DiscoveryOptions | undefined): () => number {
	return opts?.now ?? Date.now;
}

/**
 * `MemoryStatement.get()` returns `unknown`. Every row this module reads is
 * either a single `value` column or a `COUNT(*) AS c`; narrowing here keeps the
 * reads checked instead of asserting a shape the compiler never verified.
 */
function rowValue(row: unknown): string | null {
	if (row && typeof row === "object" && "value" in row && typeof row.value === "string") return row.value;
	return null;
}

function rowCount(row: unknown): number {
	if (row && typeof row === "object" && "c" in row) {
		const count = Number(row.c);
		if (Number.isFinite(count)) return count;
	}
	return 0;
}

/**
 * Is this path a memory DB? The single admission gate (§7).
 *
 * Does NOT normalize (no `path.resolve`): the caller owns normalization because
 * the contract puts it BEFORE the probe. A relative path is not rejected either
 * — `statSync` and `DatabaseSync` resolve it against the same cwd, so the answer
 * is simply about whatever that string points at.
 */
export async function probeMemoryDb(candidate: string): Promise<ProbeOutcome> {
	// ── ① Existence + file type, up front. SQLite reports "unable to open
	// database file" for BOTH a missing file and a permission error, so this
	// step is what keeps "the DB is gone" (which the user must be told about)
	// from degrading into an unreadable-catch-all.
	let stats: Stats;
	try {
		stats = statSync(candidate); // follows symlinks, on purpose
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") {
			return { ok: false, reason: "missing", detail: `路径不存在：${candidate}` };
		}
		return { ok: false, reason: "unreadable", detail: `无法访问 ${candidate}：${code ?? String(error)}` };
	}
	if (!stats.isFile()) {
		return { ok: false, reason: "not-a-file", detail: `不是普通文件（目录/管道/设备）：${candidate}` };
	}

	// ── ② Read-only open. Its `isFile()` guard is a redundant second layer; the
	// authoritative one is inside `openDatabaseReadonly`.
	let db: MemoryDatabase;
	try {
		db = await openDatabaseReadonly(candidate);
	} catch (error) {
		if (error instanceof ReadonlyOpenError) {
			return { ok: false, reason: error.reason, detail: error.message };
		}
		return { ok: false, reason: "unreadable", detail: (error as Error).message };
	}

	try {
		// ── ③ Read schema_version. Deliberately NOT `readSchemaVersion`: that one
		// catches everything, and we need to tell "no such table" from "table but
		// no row" from "a version we do not understand".
		let stored: string | null;
		try {
			stored = rowValue(db.prepare("SELECT value FROM memory_kv WHERE key = ?").get("schema_version"));
		} catch (error) {
			// "no such table: memory_kv", "file is not a database", …
			const message = (error as Error).message;
			return {
				ok: false,
				reason: "not-memory-db",
				detail: `不是记忆库（读 memory_kv.schema_version 失败）：${candidate} —— ${message}`,
			};
		}
		if (stored === null) {
			// The table is there but the row is not. Still not a DB we recognize —
			// registering it would let `createSchema` pour 22 tables into it.
			return {
				ok: false,
				reason: "not-memory-db",
				detail: `不是记忆库（memory_kv 里没有 schema_version 行）：${candidate}`,
			};
		}
		// ── ④ Version comparison: same predicate as `createSchema` — only a
		// version with no migrator is refused. An in-place-migratable version
		// (v2) is admitted; the write-open path upgrades it. Probing stays
		// READ-ONLY either way: migration never happens here.
		if (stored !== SCHEMA_VERSION && !MIGRATABLE_FROM.includes(stored)) {
			return {
				ok: false,
				reason: "incompatible",
				detail: `记忆库 schema v${stored} 与本版本 v${SCHEMA_VERSION} 不兼容（该版本无就地迁移）：${candidate}`,
			};
		}
		return { ok: true, schemaVersion: stored };
	} finally {
		// Probing owns its handle: every return path goes through here.
		try {
			db.close();
		} catch {
			/* already closed — repeated close throws ERR_INVALID_STATE */
		}
	}
}

/**
 * Read-only stats for one DB: schema version, node count, world time.
 *
 * `null` means "no stats available" (unreachable, or not a memory DB at all);
 * the richer reason lives in `probeMemoryDb`. Cached for 5s because
 * `GET /api/databases` would otherwise open one read-only connection per DB on
 * every call (~1 ms each), and `registry` invalidates a path as soon as it
 * opens it for writing.
 *
 * The `isFile()` guard that keeps a FIFO from wedging the process is NOT here —
 * it is inside `openDatabaseReadonly`, which covers this entry point and
 * `probeMemoryDb` both. A local guard would only protect one of them.
 */
export async function readMemoryDbStats(candidate: string, opts?: DiscoveryOptions): Promise<MemoryDbStats | null> {
	const ttl = ttlOf(opts);
	const now = clockOf(opts)();
	const hit = statsCache.get(candidate);
	if (hit && ttl > 0 && now - hit.at < ttl) return hit.value;

	let db: MemoryDatabase | null = null;
	let value: MemoryDbStats | null = null;
	try {
		db = await openDatabaseReadonly(candidate);
		const stats: MemoryDbStats = {
			schemaVersion: rowValue(db.prepare("SELECT value FROM memory_kv WHERE key = ?").get("schema_version")) ?? "",
			nodeCount: rowCount(db.prepare("SELECT COUNT(*) AS c FROM nodes").get()),
			worldTime: rowValue(db.prepare("SELECT value FROM memory_kv WHERE key = ?").get("world_time")),
		};
		value = stats;
	} catch {
		// Unreachable or not a memory DB ("no such table: nodes" lands here too).
		// Deciding *why* is `probeMemoryDb`'s job.
		value = null;
	} finally {
		try {
			db?.close();
		} catch {
			/* already closed */
		}
	}
	statsCache.set(candidate, { value, at: now });
	return value;
}

/**
 * Drop cached stats. Called with a path when `registry` opens that DB (it is
 * about to be written to, so the cached `node_count` is instantly stale), or
 * with no argument to clear everything (tests).
 */
export function invalidateStats(candidate?: string): void {
	if (candidate === undefined) statsCache.clear();
	else statsCache.delete(candidate);
}

function skipSet(opts: DiscoveryOptions | undefined): Set<string> {
	const names = new Set(DEFAULT_SKIP_DIRS);
	for (const extra of opts?.extraSkipDirs ?? []) names.add(extra);
	return names;
}

/**
 * Scan `roots` for memory DBs (recursively, synchronously).
 *
 * ⚠️ Synchronous on purpose: `readdirSync` order is stable, which is what makes
 * `paths` deterministic. The cost is that a wide `roots` blocks the event loop
 * for the duration (seconds on a huge tree) — a known limitation, recorded in
 * `15-多库测试与文档.md` §9.8, mitigated in frequency (not in duration) by the
 * 5s result cache.
 *
 * Symlinks are NOT followed: `Dirent.isDirectory()`/`isFile()` do not follow
 * them, so cycles are impossible and the scan cannot wander outside `roots`
 * (listing paths is itself information disclosure). The cost is that a DB
 * reached only through a symlink is not discovered — a manually entered symlink
 * path still works, because the probe's `statSync` DOES follow.
 *
 * An unreadable directory is recorded in `errors` and skipped; it never aborts
 * the scan. A nonexistent root is skipped silently (the default roots is
 * `[cwd]`, and most directories hold no DB — reporting that as an error would
 * be noise on every start).
 */
export async function discoverMemoryDbs(roots: readonly string[], opts?: DiscoveryOptions): Promise<DiscoveryResult> {
	const now = clockOf(opts)();
	const ttl = ttlOf(opts);
	const maxDepth = opts?.maxDepth ?? DEFAULT_MAX_DEPTH;
	const skip = skipSet(opts);
	const key = JSON.stringify([roots.map((r) => path.resolve(r)), maxDepth, [...skip].sort()]);

	if (scanCache && scanCache.key === key && ttl > 0 && now - scanCache.at < ttl) return scanCache.value;

	const result: DiscoveryResult = { paths: [], scanned: 0, errors: [] };
	let truncated = false;

	const walk = (dir: string, depth: number): void => {
		if (truncated) return;
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			// A root that does not exist (or is not a directory) is not an error.
			if (!(code === "ENOENT" || code === "ENOTDIR")) {
				result.errors.push(`${dir}：${code ?? String(error)} 无法读取目录`);
			}
			return;
		}
		result.scanned++;
		for (const entry of entries) {
			if (truncated) return;
			const abs = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (skip.has(entry.name)) continue;
				if (depth + 1 > maxDepth) continue;
				walk(abs, depth + 1);
				continue;
			}
			// ⭐ Hard requirement, not a performance nicety: the candidate MUST be
			// typed by `Dirent.isFile()`. Filtering by name instead
			// (`entry.name === "memory.db"`) would let a FIFO into `paths`, and
			// `readMemoryDbStats` would then block the whole process forever.
			// `Dirent.isFile()` is false for FIFOs and follows no symlinks.
			if (!entry.isFile()) continue;
			if (entry.name !== "memory.db") continue;
			if (result.paths.length >= MAX_DISCOVERED) {
				truncated = true;
				result.errors.push(`发现结果已达上限 ${MAX_DISCOVERED} 个记忆库，后续目录未遍历。请用 --roots 收窄范围。`);
				return;
			}
			result.paths.push(abs);
		}
	};

	for (const root of roots) {
		if (truncated) break;
		walk(path.resolve(root), 0);
	}

	if (ttl > 0) scanCache = { value: result, key, at: now };
	return result;
}
