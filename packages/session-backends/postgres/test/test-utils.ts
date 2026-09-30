import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterEach } from "vitest";
import { PostgresSessionRepository } from "../src/index.ts";

export const databaseUrl = process.env.PI_TEST_DATABASE_URL;

let pools: Pool[] = [];

afterEach(async () => {
	const active = pools;
	pools = [];
	await Promise.all(active.map((pool) => pool.end()));
});

export function createPool(applicationName = uniqueId("pi-session-test")): Pool {
	if (!databaseUrl) throw new Error("PI_TEST_DATABASE_URL is required for PostgreSQL integration tests");
	const pool = new Pool({ connectionString: databaseUrl, application_name: applicationName });
	pools.push(pool);
	return pool;
}

export function createRepository(pool = createPool(), options: { ttlMs?: number; heartbeatIntervalMs?: number } = {}) {
	return new PostgresSessionRepository({
		pool,
		...(options.ttlMs === undefined
			? {}
			: {
					writerLease: {
						ttlMs: options.ttlMs,
						heartbeatIntervalMs: options.heartbeatIntervalMs ?? Math.max(1, Math.floor(options.ttlMs / 2)),
					},
				}),
	});
}

export function uniqueId(prefix: string): string {
	return `${prefix}-${randomUUID()}`;
}

export async function deleteSessions(
	repository: PostgresSessionRepository,
	cwd: string,
	ids: readonly string[],
): Promise<void> {
	const wanted = new Set(ids);
	for (const metadata of await repository.list({ cwd })) {
		if (wanted.has(metadata.id)) await repository.delete(metadata);
	}
}
