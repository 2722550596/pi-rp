import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { createPool, createRepository, databaseUrl, deleteSessions, uniqueId } from "./test-utils.ts";

const describePostgres = databaseUrl ? describe : describe.skip;

async function waitForLockWait(pool: Pool, queryText: string, applicationName: string): Promise<void> {
	for (let attempt = 0; attempt < 2_000; attempt++) {
		const result = await pool.query<{ waiting: boolean }>(
			`SELECT EXISTS (
				SELECT 1 FROM pg_stat_activity
				WHERE datname = current_database()
				  AND application_name = $2
				  AND wait_event_type = 'Lock'
				  AND query LIKE $1
			) AS waiting`,
			[`%${queryText}%`, applicationName],
		);
		if (result.rows[0]?.waiting) return;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	const blocked = await pool.query<{ pid: number; state: string; wait_event: string | null; query: string }>(
		"SELECT pid, state, wait_event, query FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1 AND wait_event_type='Lock'",
		[applicationName],
	);
	throw new Error(`Timed out waiting for PostgreSQL lock wait: ${queryText}; blocked=${JSON.stringify(blocked.rows)}`);
}

describePostgres("PostgreSQL repository transaction lifecycle", () => {
	if (!databaseUrl) it.skip("requires PI_TEST_DATABASE_URL (real PostgreSQL integration)", () => {});

	it("forks one committed source snapshot while a concurrent append waits", async () => {
		const applicationName = uniqueId("snapshot-test");
		const pool = createPool(applicationName);
		const repository = createRepository(pool);
		const lockClient = await pool.connect();
		const cwd = "/pi-rp-postgres-test";
		const sourceId = uniqueId("snapshot-source");
		const forkId = uniqueId("snapshot-fork");
		let forkSettled: Promise<void> | undefined;
		let appendPromise: Promise<string> | undefined;
		try {
			const source = await repository.create({ cwd, id: sourceId });
			const sourceMetadata = await source.getMetadata();
			const firstId = await source.appendCustomEntry("snapshot", { value: "before" });
			await lockClient.query("BEGIN");
			await lockClient.query("LOCK TABLE pi_session.entries IN SHARE MODE");
			const forkPromise = repository.fork(sourceMetadata, {
				scope: "tree",
				id: forkId,
				cwd,
			});
			forkSettled = forkPromise.then(
				() => undefined,
				() => undefined,
			);
			await waitForLockWait(pool, "INSERT INTO entries", applicationName);

			appendPromise = source.appendCustomEntry("snapshot", { value: "after" });
			await waitForLockWait(pool, "UPDATE session_sequences SET next_seq=next_seq+1", applicationName);
			await lockClient.query("COMMIT");
			const fork = await forkPromise;
			const appendedId = await appendPromise;

			const forkEntries = await fork.findEntries({ order: "oldestFirst" });
			const sourceEntries = await source.findEntries({ order: "oldestFirst" });
			expect(forkEntries.map((entry) => entry.id)).toEqual([firstId]);
			expect(sourceEntries.map((entry) => entry.id)).toEqual([firstId, appendedId]);
			expect(sourceEntries.map((entry) => entry.data)).toEqual([{ value: "before" }, { value: "after" }]);
		} finally {
			try {
				await lockClient.query("ROLLBACK");
			} catch {}
			lockClient.release();
			await forkSettled;
			await appendPromise?.catch(() => undefined);
			await deleteSessions(repository, cwd, [sourceId, forkId]);
			await repository.close();
		}
	});

	it("rejects new operations during close and drains an in-flight transaction", async () => {
		const applicationName = uniqueId("close-test");
		const pool = createPool(applicationName);
		const repository = createRepository(pool);
		const lockClient = await pool.connect();
		let closeResolved = false;
		try {
			await repository.list();
			await lockClient.query("BEGIN");
			await lockClient.query("LOCK TABLE pi_session.sessions IN ACCESS EXCLUSIVE MODE");
			const inFlight = repository.list();
			await waitForLockWait(pool, "FROM sessions s ORDER BY", applicationName);

			const closing = repository.close().then(() => {
				closeResolved = true;
			});
			await expect(repository.list()).rejects.toMatchObject({ code: "storage" });
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(closeResolved).toBe(false);
			await lockClient.query("COMMIT");
			await inFlight;
			await closing;
			expect(closeResolved).toBe(true);
			await expect(repository.close()).resolves.toBeUndefined();
		} finally {
			try {
				await lockClient.query("ROLLBACK");
			} catch {}
			lockClient.release();
			await repository.close();
		}
	});
});
