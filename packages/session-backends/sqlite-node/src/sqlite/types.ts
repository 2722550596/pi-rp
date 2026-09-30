import type { FileSystem, SessionCreateOptions, SessionMetadata } from "@earendil-works/pi-agent-core";

// The SQLite capability types live in `@earendil-works/pi-agent-core` (13-D
// §3.1: one shared vocabulary for every SQLite consumer). Re-exported here so
// this package's public surface is unchanged.
export type {
	SqliteDatabase,
	SqliteDatabaseFactory,
	SqliteRunResult,
	SqliteStatement,
} from "@earendil-works/pi-agent-core";

export interface SqliteSessionMetadata extends SessionMetadata {
	cwd: string;
	path: string;
	parentSessionId?: string;
	/** Current session name projected from SQLite global facts. */
	name?: string;
	/** Opaque application-owned metadata. */
	metadata?: Record<string, unknown>;
	/** Project identifier for cross-session querying. */
	projectId?: string;
}

export interface SqliteSessionCreateOptions extends SessionCreateOptions {
	cwd: string;
	parentSessionId?: string;
	metadata?: Record<string, unknown>;
	projectId?: string;
}

export interface SqliteSessionListOptions {
	cwd?: string;
}

export type SqliteSessionRepositoryEnv = Pick<FileSystem, "absolutePath" | "createDir" | "exists">;
