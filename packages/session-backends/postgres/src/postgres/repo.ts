import { readFile } from "node:fs/promises";
import {
	assertJsonSerializable,
	type BranchBounds,
	type Entry,
	type EntryQuery,
	type ForkOptions,
	type LaneRecord,
	type LogItem,
	type NewRecord,
	type OperationStartedRecord,
	type ProvisionedEntry,
	type RecordQuery,
	Session,
	SessionError,
	type SessionRepo,
	type SessionStats,
	type SessionStorage,
} from "@earendil-works/pi-agent-core";
import { uuidv7 } from "@earendil-works/pi-ai";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import type {
	PostgresSessionCreateOptions,
	PostgresSessionListOptions,
	PostgresSessionMetadata,
	PostgresSessionRepositoryOptions,
} from "./types.ts";

interface DbRow extends QueryResultRow {
	[key: string]: unknown;
}
interface Lease {
	ownerId: string;
	fence: number;
}
const numeric = (value: unknown): number => Number(value);
function raise(code: ConstructorParameters<typeof SessionError>[0], message: string, cause?: unknown): never {
	throw new SessionError(code, message, cause instanceof Error ? cause : undefined);
}
function serializeMetadata(value: unknown): string | null {
	if (value === undefined) return null;
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		raise("invalid_payload", "PostgreSQL session metadata must be an object");
	}
	assertJsonSerializable(value);
	return JSON.stringify(value);
}
function databaseFailure(error: unknown): never {
	if (error instanceof SessionError) throw error;
	const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
	if (code === "23505") raise("already_exists", "PostgreSQL record already exists", error);
	raise("storage", "PostgreSQL session storage operation failed", error);
}
function metadata(row: DbRow): PostgresSessionMetadata {
	let opaque: unknown = row.metadata;
	if (typeof opaque === "string") {
		try {
			opaque = JSON.parse(opaque);
		} catch (e) {
			raise("storage", `Invalid metadata for session ${String(row.id)}`, e);
		}
	}
	if (opaque !== null && (typeof opaque !== "object" || Array.isArray(opaque)))
		raise("storage", `Invalid metadata for session ${String(row.id)}`);
	const data = (opaque ?? {}) as Record<string, unknown>;
	return {
		id: String(row.id),
		createdAt: numeric(row.created_at),
		cwd: String(row.cwd),
		...(typeof row.session_name === "string" ? { name: row.session_name } : {}),
		...(row.parent_session_id == null ? {} : { parentSessionId: String(row.parent_session_id) }),
		...(row.project_id ? { projectId: String(row.project_id) } : {}),
		...(Object.keys(data).length ? { metadata: data } : {}),
	};
}
function decodeEntry(row: DbRow): Entry {
	try {
		const p =
			typeof row.payload === "string"
				? (JSON.parse(row.payload) as Record<string, unknown>)
				: (row.payload as Record<string, unknown>);
		if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error("payload is not an object");
		const base = {
			id: String(row.id),
			seq: numeric(row.seq),
			parentId: row.parent_id == null ? null : String(row.parent_id),
			timestamp: numeric(row.timestamp),
		};
		switch (row.type) {
			case "message":
				if (typeof p.message !== "object" || p.message === null) throw new Error("invalid message");
				return {
					...base,
					type: "message",
					message: p.message as Extract<Entry, { type: "message" }>["message"],
					...(p.terminate === true ? { terminate: true as const } : {}),
				};
			case "model_change":
				if (typeof p.provider !== "string" || typeof p.modelId !== "string")
					throw new Error("invalid model change");
				return { ...base, type: "model_change", provider: p.provider, modelId: p.modelId };
			case "thinking_level_change":
				if (typeof p.thinkingLevel !== "string") throw new Error("invalid thinking level");
				return { ...base, type: "thinking_level_change", thinkingLevel: p.thinkingLevel };
			case "active_tools_change":
				if (!Array.isArray(p.activeToolNames) || p.activeToolNames.some((x) => typeof x !== "string"))
					throw new Error("invalid tools");
				return { ...base, type: "active_tools_change", activeToolNames: p.activeToolNames as string[] };
			case "compaction":
				if (typeof p.summary !== "string" || !Array.isArray(p.retainedTail) || typeof p.tokensBefore !== "number")
					throw new Error("invalid compaction");
				return { ...base, type: "compaction", ...p } as Entry;
			case "branch_summary":
				if (typeof p.fromId !== "string" || typeof p.summary !== "string")
					throw new Error("invalid branch summary");
				return { ...base, type: "branch_summary", ...p } as Entry;
			case "custom":
				if (typeof p.customType !== "string") throw new Error("invalid custom entry");
				return { ...base, type: "custom", ...p } as Entry;
			default:
				throw new Error(`unknown type ${String(row.type)}`);
		}
	} catch (e) {
		raise("invalid_entry", `Invalid PostgreSQL session entry ${String(row.id)}`, e);
	}
}
function decodeRecord(row: DbRow): LaneRecord {
	try {
		const p = typeof row.payload === "string" ? (JSON.parse(row.payload) as object) : (row.payload as object);
		return { ...p, seq: numeric(row.seq), timestamp: numeric(row.timestamp) } as LaneRecord;
	} catch (e) {
		raise("storage", `Invalid record payload at sequence ${String(row.seq)}`, e);
	}
}
function checkLimit(limit: number | undefined): void {
	if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0))
		raise("invalid_query", "limit must be a positive integer");
}
function runId(record: NewRecord): string | null {
	return record.type === "operation_started" ? record.id : "runId" in record ? (record.runId ?? null) : null;
}
function opKind(record: NewRecord): string | null {
	return record.type === "operation_started" ? record.intent.kind : null;
}

export class PostgresSessionRepository
	implements
		SessionRepo<PostgresSessionMetadata, PostgresSessionCreateOptions, PostgresSessionListOptions>,
		AsyncDisposable
{
	private readonly pool: Pool;
	private readonly leaseTiming: { ttlMs: number; heartbeatIntervalMs: number };
	private readonly active = new Map<string, PgStorage>();
	private migrations?: Promise<void>;
	private closing = false;
	private closePromise?: Promise<void>;
	private pendingTransactions = 0;
	private transactionDrain?: () => void;
	private closed = false;
	constructor(options: PostgresSessionRepositoryOptions) {
		this.pool = options.pool;
		const ttlMs = options.writerLease?.ttlMs ?? 30_000;
		const heartbeatIntervalMs = options.writerLease?.heartbeatIntervalMs ?? 10_000;
		if (
			!Number.isSafeInteger(ttlMs) ||
			ttlMs <= 0 ||
			!Number.isSafeInteger(heartbeatIntervalMs) ||
			heartbeatIntervalMs <= 0 ||
			heartbeatIntervalMs >= ttlMs
		)
			throw new RangeError("writerLease requires positive heartbeatIntervalMs less than ttlMs");
		this.leaseTiming = { ttlMs, heartbeatIntervalMs };
	}
	private async ready(allowClosing = false): Promise<void> {
		if (this.closed || (this.closing && !allowClosing)) raise("storage", "PostgreSQL session repository is closed");
		if (!this.migrations) this.migrations = this.migrate();
		const migration = this.migrations;
		try {
			await migration;
		} catch (error) {
			if (this.migrations === migration) this.migrations = undefined;
			databaseFailure(error);
		}
		if (this.closed || (this.closing && !allowClosing)) raise("storage", "PostgreSQL session repository is closed");
	}
	private async migrate(): Promise<void> {
		const client = await this.pool.connect();
		try {
			await client.query("SELECT pg_advisory_lock($1)", [0x50535250]);
			await client.query("CREATE SCHEMA IF NOT EXISTS pi_session");
			await client.query("SET search_path TO pi_session, pg_catalog");
			await client.query("BEGIN");
			await client.query(
				"CREATE TABLE IF NOT EXISTS migrations(id TEXT PRIMARY KEY,applied_at TIMESTAMPTZ NOT NULL DEFAULT now())",
			);
			const exists = await client.query("SELECT 1 FROM migrations WHERE id=$1", ["001_initial.sql"]);
			if (!exists.rowCount) {
				await client.query(await readFile(new URL("./migrations/001_initial.sql", import.meta.url), "utf8"));
				await client.query("INSERT INTO migrations(id) VALUES($1)", ["001_initial.sql"]);
			}
			await client.query("COMMIT");
		} catch (e) {
			try {
				await client.query("ROLLBACK");
			} catch {}
			databaseFailure(e);
		} finally {
			try {
				await client.query("RESET search_path");
				await client.query("SELECT pg_advisory_unlock($1)", [0x50535250]);
			} finally {
				client.release();
			}
		}
	}
	async query<T extends DbRow = DbRow>(text: string, values?: unknown[]): Promise<T[]> {
		await this.ready();
		if (this.closing) raise("storage", "PostgreSQL session repository is closed");
		this.pendingTransactions++;
		try {
			const client = await this.pool.connect();
			try {
				await client.query("BEGIN");
				await client.query("SET LOCAL search_path TO pi_session, pg_catalog");
				const result = await client.query<T>(text, values);
				await client.query("COMMIT");
				return result.rows;
			} catch (e) {
				try {
					await client.query("ROLLBACK");
				} catch {}
				databaseFailure(e);
			} finally {
				client.release();
			}
		} finally {
			this.finishTransaction();
		}
	}
	async transaction<T>(fn: (client: PoolClient) => Promise<T>, allowClosing = false): Promise<T> {
		await this.ready(allowClosing);
		if (this.closing && !allowClosing) raise("storage", "PostgreSQL session repository is closed");
		this.pendingTransactions++;
		try {
			const client = await this.pool.connect();
			try {
				await client.query("BEGIN");
				await client.query("SET LOCAL search_path TO pi_session, pg_catalog");
				const value = await fn(client);
				await client.query("COMMIT");
				return value;
			} catch (e) {
				try {
					await client.query("ROLLBACK");
				} catch {}
				databaseFailure(e);
			} finally {
				client.release();
			}
		} finally {
			this.finishTransaction();
		}
	}
	private finishTransaction(): void {
		this.pendingTransactions--;
		if (this.pendingTransactions === 0) {
			this.transactionDrain?.();
			this.transactionDrain = undefined;
		}
	}
	private async drainTransactions(): Promise<void> {
		if (this.pendingTransactions > 0)
			await new Promise<void>((resolve) => {
				this.transactionDrain = resolve;
			});
	}
	private async claim(client: PoolClient, id: string): Promise<Lease> {
		const ownerId = uuidv7();
		const now = Date.now();
		const r = await client.query<DbRow>(
			`INSERT INTO writer_leases(session_id,owner_id,fence,expires_at_ms) VALUES($1,$2,1,$3) ON CONFLICT(session_id) DO UPDATE SET owner_id=EXCLUDED.owner_id,fence=writer_leases.fence+1,expires_at_ms=EXCLUDED.expires_at_ms WHERE writer_leases.expires_at_ms <= $4 RETURNING owner_id,fence`,
			[id, ownerId, now + this.leaseTiming.ttlMs, now],
		);
		if (!r.rows[0]) raise("storage", `PostgreSQL session ${id} already has an active writer`);
		return { ownerId, fence: numeric(r.rows[0].fence) };
	}
	private session(id: string, lease: Lease): Session<PostgresSessionMetadata> {
		const storage = new PgStorage(this, id, lease, this.leaseTiming, () => this.active.delete(id));
		this.active.set(id, storage);
		return new Session(storage);
	}
	async create(options: PostgresSessionCreateOptions): Promise<Session<PostgresSessionMetadata>> {
		const serializedMetadata = serializeMetadata(options.metadata);
		await this.ready();
		const id = options.id ?? uuidv7();
		try {
			const lease = await this.transaction(async (client) => {
				await client.query(
					"INSERT INTO sessions(id,created_at,cwd,parent_session_id,metadata,project_id) VALUES($1,$2,$3,$4,$5::jsonb,$6)",
					[
						id,
						Date.now(),
						options.cwd,
						options.parentSessionId ?? null,
						serializedMetadata,
						options.projectId ?? "",
					],
				);
				await client.query("INSERT INTO session_sequences VALUES($1,1)", [id]);
				await client.query("INSERT INTO session_stats VALUES($1,0,0,0,0,0)", [id]);
				await client.query("INSERT INTO lanes(session_id,lane,leaf_id) VALUES($1,'main',NULL)", [id]);
				return this.claim(client, id);
			});
			return this.session(id, lease);
		} catch (error) {
			if (error instanceof SessionError) throw error;
			if (error && typeof error === "object" && "code" in error && error.code === "23505") {
				raise("already_exists", `Session already exists: ${id}`, error);
			}
			raise("storage", `Failed to create PostgreSQL session ${id}`, error);
		}
	}
	async open(value: PostgresSessionMetadata): Promise<Session<PostgresSessionMetadata>> {
		await this.ready();
		const active = this.active.get(value.id);
		if (active) return new Session(active);
		const lease = await this.transaction(async (c) => {
			const row = await c.query("SELECT id FROM sessions WHERE id=$1 FOR UPDATE", [value.id]);
			if (!row.rowCount) raise("not_found", `Session not found: ${value.id}`);
			return this.claim(c, value.id);
		});
		return this.session(value.id, lease);
	}
	async list(options: PostgresSessionListOptions = {}): Promise<PostgresSessionMetadata[]> {
		const rows = await this.query(
			options.cwd === undefined
				? "SELECT s.*, (SELECT value #>> '{}' FROM facts f WHERE f.session_id=s.id AND f.kind='name' AND f.key IS NULL ORDER BY f.seq DESC LIMIT 1) AS session_name FROM sessions s ORDER BY s.created_at DESC,s.id"
				: "SELECT s.*, (SELECT value #>> '{}' FROM facts f WHERE f.session_id=s.id AND f.kind='name' AND f.key IS NULL ORDER BY f.seq DESC LIMIT 1) AS session_name FROM sessions s WHERE s.cwd=$1 ORDER BY s.created_at DESC,s.id",
			options.cwd === undefined ? undefined : [options.cwd],
		);
		return rows.map(metadata);
	}
	async delete(value: PostgresSessionMetadata): Promise<void> {
		await this.ready();
		const active = this.active.get(value.id);
		if (active) await active.release();
		await this.transaction(async (c) => {
			const row = await c.query("SELECT id FROM sessions WHERE id=$1 FOR UPDATE", [value.id]);
			if (!row.rowCount) return;
			await this.claim(c, value.id);
			await c.query("DELETE FROM sessions WHERE id=$1", [value.id]);
		});
	}
	async fork(
		source: PostgresSessionMetadata,
		options: ForkOptions & PostgresSessionCreateOptions,
	): Promise<Session<PostgresSessionMetadata>> {
		await this.ready();
		const id = options.id ?? uuidv7();
		try {
			const lease = await this.transaction(async (client) => {
				const sequenceLock = await client.query(
					"SELECT next_seq FROM session_sequences WHERE session_id=$1 FOR SHARE",
					[source.id],
				);
				if (!sequenceLock.rowCount) raise("not_found", `Session not found: ${source.id}`);
				const sourceResult = await client.query<DbRow>("SELECT * FROM sessions WHERE id=$1", [source.id]);
				if (!sourceResult.rows[0]) raise("not_found", `Session not found: ${source.id}`);
				const sourceMetadata = metadata(sourceResult.rows[0]);
				let lanes: DbRow[] = [];
				let tips: string[] = [];
				let targetId: string | null = null;
				if (options.scope === "tree") {
					lanes = (
						await client.query<DbRow>("SELECT lane,leaf_id FROM lanes WHERE session_id=$1 ORDER BY lane", [
							source.id,
						])
					).rows;
					tips = (
						await client.query<DbRow>("SELECT tip_id FROM branch_tips WHERE session_id=$1 ORDER BY tip_id", [
							source.id,
						])
					).rows.map((row) => String(row.tip_id));
				} else {
					const main = (
						await client.query<DbRow>("SELECT leaf_id FROM lanes WHERE session_id=$1 AND lane='main'", [
							source.id,
						])
					).rows[0];
					if (!main) raise("invalid_lane", "Lane not found: main");
					const selectedId = options.entryId ?? main.leaf_id;
					if (selectedId !== null) {
						const selected = (
							await client.query<DbRow>(
								"SELECT e.id,e.type,e.parent_id,EXISTS(SELECT 1 FROM branch_entries b WHERE b.session_id=e.session_id AND b.entry_id=e.id) AS on_branch FROM entries e WHERE e.session_id=$1 AND e.id=$2",
								[source.id, selectedId],
							)
						).rows[0];
						if (!selected || selected.type !== "message" || selected.on_branch !== true)
							raise(
								"invalid_fork_target",
								`Fork target is not a message entry on a cached branch: ${String(selectedId)}`,
							);
						targetId =
							(options.position ?? (options.entryId === undefined ? "at" : "before")) === "at"
								? String(selected.id)
								: selected.parent_id == null
									? null
									: String(selected.parent_id);
					}
					lanes = [{ lane: "main", leaf_id: targetId }];
					if (targetId !== null) tips = [targetId];
				}

				const projectId = options.projectId ?? sourceMetadata.projectId ?? "";
				const opaqueMetadata = options.metadata ?? sourceMetadata.metadata;
				const serializedMetadata = serializeMetadata(opaqueMetadata);
				await client.query(
					"INSERT INTO sessions(id,created_at,cwd,parent_session_id,metadata,project_id) VALUES($1,$2,$3,$4,$5::jsonb,$6)",
					[id, Date.now(), options.cwd, options.parentSessionId ?? source.id, serializedMetadata, projectId],
				);
				await client.query("INSERT INTO session_sequences VALUES($1,1)", [id]);
				if (options.scope === "tree") {
					await client.query(
						`WITH copied AS (
						SELECT id,parent_id,type,timestamp,payload,row_number() OVER (ORDER BY seq) AS target_seq
						FROM entries WHERE session_id=$2
					)
					INSERT INTO entries(session_id,seq,id,parent_id,type,timestamp,payload)
					SELECT $1,target_seq,id,parent_id,type,timestamp,payload FROM copied ORDER BY target_seq`,
						[id, source.id],
					);
				} else if (targetId !== null) {
					await client.query(
						`WITH RECURSIVE path AS (
						SELECT e.id,e.parent_id,e.type,e.timestamp,e.payload,e.seq FROM entries e WHERE e.session_id=$2 AND e.id=$3
						UNION ALL
						SELECT p.id,p.parent_id,p.type,p.timestamp,p.payload,p.seq FROM entries p JOIN path child ON p.id=child.parent_id WHERE p.session_id=$2
					), copied AS (
						SELECT id,parent_id,type,timestamp,payload,row_number() OVER (ORDER BY seq) AS target_seq FROM path
					)
					INSERT INTO entries(session_id,seq,id,parent_id,type,timestamp,payload)
					SELECT $1,target_seq,id,parent_id,type,timestamp,payload FROM copied ORDER BY target_seq`,
						[id, source.id, targetId],
					);
				}
				const stats = await client.query<DbRow>(
					"SELECT count(*) FILTER (WHERE type='message') AS message_count FROM entries WHERE session_id=$1",
					[id],
				);
				await client.query("INSERT INTO session_stats VALUES($1,$2,0,0,0,0)", [
					id,
					Number(stats.rows[0]?.message_count ?? 0),
				]);
				const sequence = await client.query<DbRow>(
					"SELECT coalesce(max(seq),0)+1 AS next_seq FROM entries WHERE session_id=$1",
					[id],
				);
				let nextSeq = Number(sequence.rows[0]?.next_seq ?? 1);
				if (options.scope === "tree") {
					for (const lane of lanes) {
						await client.query("INSERT INTO lanes(session_id,lane,leaf_id) VALUES($1,$2,$3)", [
							id,
							lane.lane,
							lane.leaf_id,
						]);
						await client.query("INSERT INTO lane_moves(session_id,seq,lane,leaf_id) VALUES($1,$2,$3,$4)", [
							id,
							nextSeq++,
							lane.lane,
							lane.leaf_id,
						]);
					}
				} else {
					await client.query("INSERT INTO lanes(session_id,lane,leaf_id) VALUES($1,'main',$2)", [id, targetId]);
				}
				const name = await client.query(
					`INSERT INTO facts(session_id,seq,kind,key,value)
					SELECT $1,$2,'name',NULL,latest.value FROM (
						SELECT value FROM facts WHERE session_id=$3 AND kind='name' AND key IS NULL ORDER BY seq DESC LIMIT 1
					) latest WHERE latest.value IS NOT NULL`,
					[id, nextSeq, source.id],
				);
				if (name.rowCount) nextSeq++;
				const copiedLabels = await client.query(
					`WITH latest AS (
					SELECT DISTINCT ON (key) key,value FROM facts
					WHERE session_id=$2 AND kind='label' ORDER BY key,seq DESC
				), selected AS (
					SELECT key,value FROM latest WHERE value IS NOT NULL AND ($3::boolean OR EXISTS (SELECT 1 FROM entries e WHERE e.session_id=$1 AND e.id=latest.key))
				), numbered AS (
					SELECT key,value,row_number() OVER (ORDER BY key) AS label_index FROM selected
				)
				INSERT INTO facts(session_id,seq,kind,key,value)
				SELECT $1,$4+label_index-1,'label',key,value FROM numbered`,
					[id, source.id, options.scope === "tree", nextSeq],
				);
				nextSeq += copiedLabels.rowCount ?? 0;
				await client.query("UPDATE session_sequences SET next_seq=$2 WHERE session_id=$1", [id, nextSeq]);
				for (const tip of tips) await buildBranch(client, id, tip);
				return this.claim(client, id);
			});
			return this.session(id, lease);
		} catch (error) {
			if (error instanceof SessionError) throw error;
			if (error && typeof error === "object" && "code" in error && error.code === "23505")
				raise("already_exists", `Session already exists: ${id}`, error);
			raise("storage", `Failed to fork PostgreSQL session ${id}`, error);
		}
	}
	async repairBranchCache(value: PostgresSessionMetadata): Promise<void> {
		await this.ready();
		const active = this.active.get(value.id);
		if (active) await active.release();
		await this.transaction(async (c) => {
			await this.claim(c, value.id);
			await c.query("DELETE FROM branch_entries WHERE session_id=$1", [value.id]);
			await c.query("DELETE FROM branch_tips WHERE session_id=$1", [value.id]);
			const tips = await c.query<DbRow>(
				"SELECT e.id FROM entries e WHERE e.session_id=$1 AND NOT EXISTS(SELECT 1 FROM entries ch WHERE ch.session_id=e.session_id AND ch.parent_id=e.id) ORDER BY e.seq",
				[value.id],
			);
			for (const tip of tips.rows) await buildBranch(c, value.id, String(tip.id));
			await c.query("UPDATE writer_leases SET expires_at_ms=$2 WHERE session_id=$1", [value.id, Date.now()]);
		});
	}
	close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.closing = true;
		this.closePromise = (async () => {
			try {
				await this.migrations;
				await this.drainTransactions();
				for (const storage of [...this.active.values()]) await storage.release();
			} finally {
				this.closed = true;
			}
		})();
		return this.closePromise;
	}
	async [Symbol.asyncDispose](): Promise<void> {
		await this.close();
	}
}

async function buildBranch(client: PoolClient, sessionId: string, tipId: string): Promise<void> {
	const branchId = uuidv7();
	const path = await client.query(
		`WITH RECURSIVE path AS (
		SELECT id,parent_id,seq,type,payload FROM entries WHERE session_id=$1 AND id=$2
		UNION ALL
		SELECT parent.id,parent.parent_id,parent.seq,parent.type,parent.payload
		FROM entries parent JOIN path child ON parent.id=child.parent_id
		WHERE parent.session_id=$1
	)
	INSERT INTO branch_entries(session_id,branch_id,entry_id,entry_seq,entry_type,custom_type)
	SELECT $1,$3,id,seq,type,CASE WHEN type='custom' THEN payload->>'customType' ELSE NULL END FROM path`,
		[sessionId, tipId, branchId],
	);
	if (!path.rowCount) raise("invalid_entry", `Entry ${tipId} not found`);
	await client.query("INSERT INTO branch_tips(session_id,branch_id,tip_id) VALUES($1,$2,$3)", [
		sessionId,
		branchId,
		tipId,
	]);
}

class PgStorage implements SessionStorage<PostgresSessionMetadata> {
	private readonly repo: PostgresSessionRepository;
	private readonly id: string;
	private readonly lease: Lease;
	private readonly timing: { ttlMs: number; heartbeatIntervalMs: number };
	private readonly released: () => void;
	private timer?: ReturnType<typeof setTimeout>;
	private closing = false;
	private lost = false;
	private releasing?: Promise<void>;
	constructor(
		repo: PostgresSessionRepository,
		id: string,
		lease: Lease,
		timing: { ttlMs: number; heartbeatIntervalMs: number },
		released: () => void,
	) {
		this.repo = repo;
		this.id = id;
		this.lease = lease;
		this.timing = timing;
		this.released = released;
		this.heartbeat();
	}
	private async write<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
		if (this.closing || this.lost) raise("storage", `Session ${this.id} writer is closed or fenced`);
		return this.repo.transaction(async (c) => {
			const now = Date.now();
			const r = await c.query(
				"UPDATE writer_leases SET expires_at_ms=$4 WHERE session_id=$1 AND owner_id=$2 AND fence=$3 AND expires_at_ms>$5",
				[this.id, this.lease.ownerId, this.lease.fence, now + this.timing.ttlMs, now],
			);
			if (r.rowCount !== 1) {
				this.lost = true;
				raise("storage", `PostgreSQL session ${this.id} writer lease was lost`);
			}
			return operation(c);
		});
	}
	private heartbeat(): void {
		if (this.closing || this.lost) return;
		this.timer = setTimeout(async () => {
			try {
				await this.write(async () => undefined);
			} catch {
			} finally {
				this.heartbeat();
			}
		}, this.timing.heartbeatIntervalMs);
		this.timer.unref();
	}
	async release(): Promise<void> {
		this.releasing ??= (async () => {
			this.closing = true;
			clearTimeout(this.timer);
			try {
				await this.repo.transaction(async (c) => {
					await c.query(
						"UPDATE writer_leases SET expires_at_ms=$4 WHERE session_id=$1 AND owner_id=$2 AND fence=$3",
						[this.id, this.lease.ownerId, this.lease.fence, Date.now()],
					);
				}, true);
			} finally {
				this.released();
			}
		})();
		await this.releasing;
	}
	async getMetadata(): Promise<PostgresSessionMetadata> {
		const r = await this.repo.query<DbRow>(
			"SELECT s.*, (SELECT value #>> '{}' FROM facts f WHERE f.session_id=s.id AND f.kind='name' AND f.key IS NULL ORDER BY f.seq DESC LIMIT 1) AS session_name FROM sessions s WHERE s.id=$1",
			[this.id],
		);
		if (!r[0]) raise("not_found", `Session not found: ${this.id}`);
		return metadata(r[0]);
	}
	async getLanes(): Promise<{ lane: string; leafId: string | null }[]> {
		return (await this.repo.query("SELECT lane,leaf_id FROM lanes WHERE session_id=$1 ORDER BY lane", [this.id])).map(
			(r) => ({ lane: String(r.lane), leafId: r.leaf_id == null ? null : String(r.leaf_id) }),
		);
	}
	async createLane(lane: string, at: string | null): Promise<void> {
		return this.write(async (c) => {
			if ((await c.query("SELECT 1 FROM lanes WHERE session_id=$1 AND lane=$2", [this.id, lane])).rowCount)
				raise("already_exists", `Lane already exists: ${lane}`);
			if (
				at !== null &&
				!(await c.query("SELECT 1 FROM entries WHERE session_id=$1 AND id=$2", [this.id, at])).rowCount
			)
				raise("not_found", `Entry not found: ${at}`);
			const seq = await seqNext(c, this.id);
			await c.query("INSERT INTO lanes(session_id,lane,leaf_id) VALUES($1,$2,$3)", [this.id, lane, at]);
			await c.query("INSERT INTO lane_moves(session_id,seq,lane,leaf_id) VALUES($1,$2,$3,$4)", [
				this.id,
				seq,
				lane,
				at,
			]);
		});
	}
	async moveLane(lane: string, to: string | null): Promise<void> {
		return this.write(async (c) => {
			if (!(await c.query("SELECT 1 FROM lanes WHERE session_id=$1 AND lane=$2", [this.id, lane])).rowCount)
				raise("invalid_lane", `Lane not found: ${lane}`);
			if (
				to !== null &&
				!(await c.query("SELECT 1 FROM entries WHERE session_id=$1 AND id=$2", [this.id, to])).rowCount
			)
				raise("not_found", `Entry not found: ${to}`);
			const seq = await seqNext(c, this.id);
			await c.query("UPDATE lanes SET leaf_id=$3 WHERE session_id=$1 AND lane=$2", [this.id, lane, to]);
			await c.query("INSERT INTO lane_moves(session_id,seq,lane,leaf_id) VALUES($1,$2,$3,$4)", [
				this.id,
				seq,
				lane,
				to,
			]);
		});
	}
	async appendEntry<T extends Entry>(entry: ProvisionedEntry<T>, lane: string): Promise<T> {
		return this.write(async (c) => {
			const head = (
				await c.query<DbRow>("SELECT leaf_id FROM lanes WHERE session_id=$1 AND lane=$2", [this.id, lane])
			).rows[0];
			if (!head) raise("invalid_lane", `Lane not found: ${lane}`);
			await assertId(c, this.id, entry.id);
			const seq = await seqNext(c, this.id);
			const committed = { ...entry, parentId: head.leaf_id ?? null, seq, timestamp: Date.now() } as Entry;
			const { id, parentId, type, timestamp, ...payload } = committed;
			await c.query(
				"INSERT INTO entries(session_id,seq,id,parent_id,type,timestamp,payload) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)",
				[this.id, seq, id, parentId, type, timestamp, JSON.stringify(payload)],
			);
			await c.query("UPDATE lanes SET leaf_id=$3 WHERE session_id=$1 AND lane=$2", [this.id, lane, id]);
			await updateBranch(c, this.id, committed);
			if (type === "message")
				await c.query("UPDATE session_stats SET message_count=message_count+1 WHERE session_id=$1", [this.id]);
			return structuredClone(committed as T);
		});
	}
	async appendRecord<T extends LaneRecord>(record: NewRecord<T>): Promise<T> {
		return this.write(async (c) => {
			if (!(await c.query("SELECT 1 FROM lanes WHERE session_id=$1 AND lane=$2", [this.id, record.lane])).rowCount)
				raise("invalid_lane", `Lane not found: ${record.lane}`);
			await assertId(c, this.id, record.id);
			const seq = await seqNext(c, this.id);
			const saved = { ...record, seq, timestamp: Date.now() } as LaneRecord;
			if (record.type === "operation_started") {
				const r = await c.query(
					"UPDATE lanes SET open_operation_id=$3 WHERE session_id=$1 AND lane=$2 AND open_operation_id IS NULL",
					[this.id, record.lane, record.id],
				);
				if (r.rowCount !== 1) raise("storage", `Lane ${record.lane} already has an open operation`);
			}
			await c.query(
				"INSERT INTO records(session_id,seq,id,lane,run_id,type,op_kind,timestamp,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)",
				[
					this.id,
					seq,
					record.id,
					record.lane,
					runId(record),
					record.type,
					opKind(record),
					saved.timestamp,
					JSON.stringify(saved),
				],
			);
			if (record.type === "operation_finished")
				await c.query(
					"UPDATE lanes SET open_operation_id=NULL WHERE session_id=$1 AND lane=$2 AND open_operation_id=$3",
					[this.id, record.lane, record.runId],
				);
			if (record.type === "usage")
				await c.query(
					"UPDATE session_stats SET cached_tokens=cached_tokens+$2,uncached_tokens=uncached_tokens+$3,total_tokens=total_tokens+$4,cost_total=cost_total+$5 WHERE session_id=$1",
					[
						this.id,
						record.usage.cacheRead,
						record.usage.input + record.usage.cacheWrite,
						record.usage.totalTokens,
						record.usage.cost.total,
					],
				);
			return structuredClone(saved as T);
		});
	}
	async getEntry(id: string): Promise<Entry | undefined> {
		const r = await this.repo.query<DbRow>("SELECT * FROM entries WHERE session_id=$1 AND id=$2", [this.id, id]);
		return r[0] ? decodeEntry(r[0]) : undefined;
	}
	async findEntries(q: EntryQuery = {}): Promise<Entry[]> {
		checkLimit(q.limit);
		const p: unknown[] = [this.id];
		const w = ["session_id=$1"];
		if (q.type) {
			p.push(q.type);
			w.push(`type=$${p.length}`);
		}
		if (q.customType !== undefined) {
			p.push(q.customType);
			w.push(`payload->>'customType'=$${p.length}`);
		}
		if (q.cursor) {
			if (!Number.isSafeInteger(q.cursor.afterSeq) || q.cursor.afterSeq < 0)
				raise("invalid_query", "Invalid entry cursor");
			p.push(q.cursor.afterSeq);
			w.push(`seq ${q.order === "oldestFirst" ? ">" : "<"} $${p.length}`);
		}
		let sql = `SELECT * FROM entries WHERE ${w.join(" AND ")} ORDER BY seq ${q.order === "oldestFirst" ? "ASC" : "DESC"}`;
		if (q.limit !== undefined) {
			p.push(q.limit);
			sql += ` LIMIT $${p.length}`;
		}
		return (await this.repo.query<DbRow>(sql, p)).map(decodeEntry);
	}
	async findEntriesOnBranch(q: EntryQuery & BranchBounds & { start: string }): Promise<Entry[]> {
		checkLimit(q.limit);
		if (!(await this.repo.query("SELECT 1 FROM entries WHERE session_id=$1 AND id=$2", [this.id, q.start])).length)
			raise("not_found", `Entry not found: ${q.start}`);
		const p: unknown[] = [this.id, q.start];
		const filters: string[] = [];
		if (q.stopAtId !== undefined || q.stopAtType !== undefined) {
			const stops: string[] = [];
			if (q.stopAtId !== undefined) {
				p.push(q.stopAtId);
				stops.push(`id=$${p.length}`);
			}
			if (q.stopAtType !== undefined) {
				p.push(q.stopAtType);
				stops.push(`type=$${p.length}`);
			}
			const agg = q.order === "oldestFirst" ? "min" : "max";
			const cmp = q.order === "oldestFirst" ? "<=" : ">=";
			const fallback = q.order === "oldestFirst" ? "(SELECT max(seq) FROM path)" : "0";
			filters.push(`seq ${cmp} COALESCE((SELECT ${agg}(seq) FROM path WHERE ${stops.join(" OR ")}),${fallback})`);
		}
		if (q.cursor) {
			if (!Number.isSafeInteger(q.cursor.afterSeq) || q.cursor.afterSeq < 0)
				raise("invalid_query", "Invalid entry cursor");
			p.push(q.cursor.afterSeq);
			filters.push(`seq ${q.order === "oldestFirst" ? ">" : "<"} $${p.length}`);
		}
		if (q.type) {
			p.push(q.type);
			filters.push(`type=$${p.length}`);
		}
		if (q.customType !== undefined) {
			p.push(q.customType);
			filters.push(`payload->>'customType'=$${p.length}`);
		}
		const dir = q.order === "oldestFirst" ? "ASC" : "DESC";
		let sql = `WITH RECURSIVE path AS (SELECT e.* FROM entries e WHERE e.session_id=$1 AND e.id=$2 UNION ALL SELECT p.* FROM entries p JOIN path n ON p.id=n.parent_id WHERE p.session_id=$1) SELECT * FROM path${filters.length ? ` WHERE ${filters.join(" AND ")}` : ""} ORDER BY seq ${dir}`;
		if (q.limit !== undefined) {
			p.push(q.limit);
			sql += ` LIMIT $${p.length}`;
		}
		return (await this.repo.query<DbRow>(sql, p)).map(decodeEntry);
	}
	async findOpenOperations(lane: string, options?: { limit?: number }): Promise<OperationStartedRecord[]> {
		checkLimit(options?.limit);
		const row = (
			await this.repo.query<DbRow>(
				"SELECT l.open_operation_id, r.* FROM lanes l LEFT JOIN records r ON r.session_id=l.session_id AND r.id=l.open_operation_id WHERE l.session_id=$1 AND l.lane=$2",
				[this.id, lane],
			)
		)[0];
		if (!row || row.open_operation_id == null) return [];
		if (row.id == null)
			raise("storage", `Lane ${lane} points at missing open operation ${String(row.open_operation_id)}`);
		const record = decodeRecord(row);
		if (record.lane !== lane || record.type !== "operation_started") {
			raise("storage", `Lane ${lane} points at invalid open operation ${String(row.open_operation_id)}`);
		}
		return [record];
	}
	findRecords<K extends LaneRecord["type"]>(
		query: RecordQuery & { type: K },
	): Promise<Extract<LaneRecord, { type: K }>[]>;
	findRecords(query?: RecordQuery): Promise<LaneRecord[]>;
	async findRecords(q: RecordQuery = {}): Promise<LaneRecord[]> {
		checkLimit(q.limit);
		if (q.afterSeq !== undefined && (!Number.isSafeInteger(q.afterSeq) || q.afterSeq < 0))
			raise("invalid_query", "Invalid record cursor");
		if (q.operationKind !== undefined && q.type !== "operation_started")
			raise("invalid_query", "operationKind requires operation_started type");
		const p: unknown[] = [this.id];
		const w = ["session_id=$1"];
		for (const [key, col] of [
			["lane", "lane"],
			["type", "type"],
			["runId", "run_id"],
			["operationKind", "op_kind"],
		] as const) {
			const v = q[key];
			if (v !== undefined) {
				p.push(v);
				w.push(`${col}=$${p.length}`);
			}
		}
		if (q.afterSeq !== undefined) {
			p.push(q.afterSeq);
			w.push(`seq>$${p.length}`);
		}
		let sql = `SELECT * FROM records WHERE ${w.join(" AND ")} ORDER BY seq ${q.order === "oldestFirst" ? "ASC" : "DESC"}`;
		if (q.limit !== undefined) {
			p.push(q.limit);
			sql += ` LIMIT $${p.length}`;
		}
		return (await this.repo.query<DbRow>(sql, p)).map(decodeRecord);
	}
	async getLog(options: { afterSeq?: number; limit?: number } = {}): Promise<LogItem[]> {
		const afterSeq = options.afterSeq ?? 0;
		checkLimit(options.limit);
		if (!Number.isSafeInteger(afterSeq) || afterSeq < 0)
			raise("invalid_query", "afterSeq must be a non-negative integer");
		const params: unknown[] = [this.id, afterSeq];
		let limitClause = "";
		if (options.limit !== undefined) {
			params.push(options.limit);
			limitClause = ` LIMIT $${params.length}`;
		}
		const rows = await this.repo.query<DbRow>(
			`SELECT seq,kind,data FROM (
			SELECT e.seq,'entry'::text AS kind,to_jsonb(e) AS data FROM entries e WHERE e.session_id=$1 AND e.seq>$2
			UNION ALL SELECT r.seq,'record'::text,to_jsonb(r) FROM records r WHERE r.session_id=$1 AND r.seq>$2
			UNION ALL SELECT l.seq,'lane'::text,to_jsonb(l) FROM lane_moves l WHERE l.session_id=$1 AND l.seq>$2
			UNION ALL SELECT f.seq,'fact'::text,to_jsonb(f) FROM facts f WHERE f.session_id=$1 AND f.seq>$2
		) AS log_items ORDER BY seq ASC${limitClause}`,
			params,
		);
		return rows.map((row) => {
			const data = row.data as DbRow;
			const seq = numeric(row.seq);
			if (row.kind === "entry") return { kind: "entry", seq, entry: decodeEntry(data) };
			if (row.kind === "record") return { kind: "record", seq, record: decodeRecord(data) };
			if (row.kind === "lane")
				return {
					kind: "lane",
					seq,
					lane: String(data.lane),
					leafId: data.leaf_id == null ? null : String(data.leaf_id),
				};
			if (data.kind === "name")
				return { kind: "fact", seq, fact: "name", name: data.value == null ? undefined : (data.value as string) };
			return {
				kind: "fact",
				seq,
				fact: "label",
				targetId: String(data.key),
				label: data.value == null ? undefined : (data.value as string),
			};
		});
	}
	async getName(): Promise<string | undefined> {
		return this.fact("name", null);
	}
	async setName(name: string | undefined): Promise<void> {
		return this.setFact("name", null, name);
	}
	async getLabel(id: string): Promise<string | undefined> {
		return this.fact("label", id);
	}
	async setLabel(id: string, label: string | undefined): Promise<void> {
		if (!(await this.getEntry(id))) raise("not_found", `Entry not found: ${id}`);
		return this.setFact("label", id, label);
	}
	private async fact(kind: string, key: string | null): Promise<string | undefined> {
		const rows = await this.repo.query<DbRow>(
			"SELECT value FROM facts WHERE session_id=$1 AND kind=$2 AND key IS NOT DISTINCT FROM $3 ORDER BY seq DESC LIMIT 1",
			[this.id, kind, key],
		);
		const value = rows[0]?.value;
		return value == null ? undefined : (value as string);
	}
	private async setFact(kind: string, key: string | null, value: string | undefined): Promise<void> {
		return this.write(async (c) => {
			const seq = await seqNext(c, this.id);
			await c.query("INSERT INTO facts(session_id,seq,kind,key,value) VALUES($1,$2,$3,$4,$5::jsonb)", [
				this.id,
				seq,
				kind,
				key,
				value === undefined ? null : JSON.stringify(value),
			]);
		});
	}
	async getStats(): Promise<SessionStats> {
		const r = (await this.repo.query<DbRow>("SELECT * FROM session_stats WHERE session_id=$1", [this.id]))[0];
		if (!r) raise("storage", `Missing stats row for session ${this.id}`);
		return {
			messageCount: numeric(r.message_count),
			cachedTokens: numeric(r.cached_tokens),
			uncachedTokens: numeric(r.uncached_tokens),
			totalTokens: numeric(r.total_tokens),
			costTotal: numeric(r.cost_total),
		};
	}
}
async function seqNext(c: PoolClient, id: string): Promise<number> {
	const r = await c.query<DbRow>(
		"UPDATE session_sequences SET next_seq=next_seq+1 WHERE session_id=$1 RETURNING next_seq-1 AS seq",
		[id],
	);
	if (!r.rows[0]) raise("storage", `Missing sequence row for session ${id}`);
	return numeric(r.rows[0].seq);
}
async function assertId(c: PoolClient, id: string, entryId: string): Promise<void> {
	if (
		(
			await c.query(
				"SELECT 1 FROM entries WHERE session_id=$1 AND id=$2 UNION ALL SELECT 1 FROM records WHERE session_id=$1 AND id=$2 LIMIT 1",
				[id, entryId],
			)
		).rowCount
	)
		raise("already_exists", `ID already exists: ${entryId}`);
}
async function updateBranch(c: PoolClient, id: string, e: Entry): Promise<void> {
	const rows = await c.query<DbRow>(
		"SELECT branch_id FROM branch_tips WHERE session_id=$1 AND tip_id IS NOT DISTINCT FROM $2",
		[id, e.parentId],
	);
	if (!rows.rowCount) {
		await buildBranch(c, id, e.id);
		return;
	}
	for (const r of rows.rows) {
		await c.query(
			"INSERT INTO branch_entries(session_id,branch_id,entry_id,entry_seq,entry_type,custom_type) VALUES($1,$2,$3,$4,$5,$6)",
			[id, r.branch_id, e.id, e.seq, e.type, e.type === "custom" ? e.customType : null],
		);
		await c.query("UPDATE branch_tips SET tip_id=$3 WHERE session_id=$1 AND branch_id=$2", [id, r.branch_id, e.id]);
	}
}
