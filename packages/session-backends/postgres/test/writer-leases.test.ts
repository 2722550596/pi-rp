import { describe, expect, it } from "vitest";
import { createPool, createRepository, databaseUrl, deleteSessions, uniqueId } from "./test-utils.ts";

const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres("PostgreSQL writer lease integration", () => {
	if (!databaseUrl) it.skip("requires PI_TEST_DATABASE_URL (real PostgreSQL integration)", () => {});

	it("rejects a stale writer after an expired lease is taken over with a higher fence", async () => {
		const oldPool = createPool();
		const takeoverPool = createPool();
		const firstRepo = createRepository(oldPool, { ttlMs: 60_000, heartbeatIntervalMs: 30_000 });
		const secondRepo = createRepository(takeoverPool, { ttlMs: 60_000, heartbeatIntervalMs: 30_000 });
		const cwd = "/pi-rp-postgres-test";
		const id = uniqueId("fence");
		try {
			const staleSession = await firstRepo.create({ cwd, id });
			const metadata = await staleSession.getMetadata();
			await oldPool.query("UPDATE pi_session.writer_leases SET expires_at_ms = 0 WHERE session_id = $1", [
				metadata.id,
			]);
			const currentSession = await secondRepo.open(metadata);

			await expect(staleSession.appendCustomEntry("test", { stale: true })).rejects.toMatchObject({
				code: "storage",
				message: expect.stringContaining("writer lease was lost"),
			});
			expect(await currentSession.findEntries()).toEqual([]);
			const lease = await takeoverPool.query<{ owner_id: string; fence: string }>(
				"SELECT owner_id, fence::text FROM pi_session.writer_leases WHERE session_id = $1",
				[metadata.id],
			);
			expect(lease.rows).toHaveLength(1);
			expect(Number(lease.rows[0]!.fence)).toBeGreaterThan(1);
			await expect(currentSession.appendCustomEntry("test", { current: true })).resolves.toEqual(expect.any(String));
		} finally {
			await firstRepo.close();
			await deleteSessions(secondRepo, cwd, [id]);
			await secondRepo.close();
		}
	});
});
