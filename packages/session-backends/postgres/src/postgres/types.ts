import type { SessionCreateOptions, SessionMetadata } from "@earendil-works/pi-agent-core";
import type { Pool } from "pg";

export interface PostgresSessionMetadata extends SessionMetadata {
	cwd: string;
	name?: string;
	metadata?: Record<string, unknown>;
	projectId?: string;
}

export interface PostgresSessionCreateOptions extends SessionCreateOptions {
	cwd: string;
	metadata?: Record<string, unknown>;
	projectId?: string;
}

export interface PostgresSessionListOptions {
	cwd?: string;
}

export interface PostgresWriterLeaseOptions {
	ttlMs?: number;
	heartbeatIntervalMs?: number;
}
export interface PostgresSessionRepositoryOptions {
	pool: Pool;
	writerLease?: PostgresWriterLeaseOptions;
}
