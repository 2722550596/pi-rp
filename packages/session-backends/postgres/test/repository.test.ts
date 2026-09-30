import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { createPool, createRepository, databaseUrl, deleteSessions, uniqueId } from "./test-utils.ts";

function createUserMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres("PostgreSQL session repository integration", () => {
	if (!databaseUrl) it.skip("requires PI_TEST_DATABASE_URL (real PostgreSQL integration)", () => {});

	it("persists sessions across repositories and assigns one database-wide sequence", async () => {
		const firstPool = createPool();
		const secondPool = createPool();
		const firstRepo = createRepository(firstPool);
		const secondRepo = createRepository(secondPool);
		const cwd = "/pi-rp-postgres-test";
		const id = uniqueId("reopen");
		try {
			const session = await firstRepo.create({ cwd, id });
			const metadata = await session.getMetadata();
			const initialEntryId = await session.appendCustomEntry("test", { order: 0 });
			await firstRepo.close();

			const reopened = await secondRepo.open(metadata);
			const appended = await Promise.all(
				Array.from({ length: 12 }, (_, order) => reopened.appendCustomEntry("test", { order: order + 1 })),
			);
			const entries = await reopened.findEntries({ order: "oldestFirst" });
			const entryIds = entries.map((entry) => entry.id);
			expect(entryIds[0]).toBe(initialEntryId);
			expect(new Set(entryIds.slice(1))).toEqual(new Set(appended));
			expect(new Set(entryIds).size).toBe(entryIds.length);
			const log = await reopened.getLog();
			expect(log.map((item) => item.seq)).toEqual(log.map((_, index) => index + 1));
			const fromAnotherPool = await secondRepo.list({ cwd: metadata.cwd });
			expect(fromAnotherPool.map((item) => item.id)).toContain(metadata.id);
		} finally {
			await firstRepo.close();
			await deleteSessions(secondRepo, cwd, [id]);
			await secondRepo.close();
		}
	});

	it("does not decode entries excluded by bounded database queries", async () => {
		const pool = createPool();
		const repository = createRepository(pool);
		const cwd = "/pi-rp-postgres-test";
		const id = uniqueId("bounded-read");
		try {
			const session = await repository.create({ cwd, id });
			const corruptId = await session.appendCustomEntry("corrupt", { order: 1 });
			const latestId = await session.appendCustomEntry("latest", { order: 2 });
			await pool.query("UPDATE pi_session.entries SET payload='[]'::jsonb WHERE session_id=$1 AND id=$2", [
				id,
				corruptId,
			]);

			expect((await session.findEntries({ order: "newestFirst", limit: 1 })).map((entry) => entry.id)).toEqual([
				latestId,
			]);
			expect((await session.getLog({ afterSeq: 1, limit: 1 })).map((item) => item.seq)).toEqual([2]);
			expect(
				(await session.findEntriesOnBranch({ start: latestId, stopAtId: latestId, limit: 1 })).map(
					(entry) => entry.id,
				),
			).toEqual([latestId]);
			await expect(session.findEntries()).rejects.toMatchObject({ code: "invalid_entry" });
		} finally {
			await deleteSessions(repository, cwd, [id]);
			await repository.close();
		}
	});

	it("serializes concurrent duplicate session creation", async () => {
		const pool = createPool();
		const repoA = createRepository(pool);
		const repoB = createRepository(pool);
		const cwd = "/pi-rp-postgres-test";
		const id = uniqueId("duplicate");
		try {
			const results = await Promise.allSettled([repoA.create({ cwd, id }), repoB.create({ cwd, id })]);
			expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
			expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
			const list = await repoA.list({ cwd });
			expect(list.filter((item) => item.id === id)).toHaveLength(1);
		} finally {
			await repoA.close();
			await repoB.close();
			const cleanupRepo = createRepository(pool);
			await deleteSessions(cleanupRepo, cwd, [id]);
			await cleanupRepo.close();
		}
	});

	it("keeps public same-named tables untouched while using the pi_session schema", async () => {
		const pool = createPool();
		const repository = createRepository(pool);
		const cwd = "/pi-rp-postgres-test";
		const id = uniqueId("schema");
		const sentinelId = uniqueId("public-sentinel");
		let tableCreated = false;
		try {
			await pool.query("CREATE TABLE public.sessions (id TEXT PRIMARY KEY, marker TEXT NOT NULL)");
			tableCreated = true;
			await pool.query("INSERT INTO public.sessions (id, marker) VALUES ($1, $2)", [sentinelId, "untouched"]);

			const session = await repository.create({ cwd, id });
			const entryId = await session.appendCustomEntry("schema-check", { persisted: true });
			const entries = await session.findEntries({ order: "oldestFirst" });
			expect(entries.map((entry) => entry.id)).toEqual([entryId]);
			const sentinel = await pool.query<{ marker: string }>("SELECT marker FROM public.sessions WHERE id = $1", [
				sentinelId,
			]);
			expect(sentinel.rows).toEqual([{ marker: "untouched" }]);
		} finally {
			await deleteSessions(repository, cwd, [id]);
			await repository.close();
			if (tableCreated) await pool.query("DROP TABLE public.sessions");
		}
	});

	it("copies every branch entry and large payload with its tree facts and statistics", async () => {
		const repository = createRepository();
		const cwd = "/pi-rp-postgres-test";
		const sourceId = uniqueId("large-tree-source");
		const forkId = uniqueId("large-tree-fork");
		try {
			const source = await repository.create({ cwd, id: sourceId });
			const root = await source.appendMessage(createUserMessage("root"));
			await source.createLane("thread", root);
			const mainChild = await source.appendMessage(createUserMessage("main child"));
			const threadChild = await source.view("thread").appendMessage(createUserMessage("thread child"));
			const largeData = { body: "fork-payload-".repeat(12_000), index: [0, 1, 2, 3] };
			const customId = await source.appendCustomEntry("large-payload", largeData);
			await source.setName("tree source");
			await source.setLabel(threadChild, "thread tip");

			const fork = await repository.fork(await source.getMetadata(), {
				scope: "tree",
				id: forkId,
				cwd,
			});
			const sourceEntries = await source.findEntries({ order: "oldestFirst" });
			const forkEntries = await fork.findEntries({ order: "oldestFirst" });
			const comparable = (entries: typeof sourceEntries) =>
				entries.map((entry) => ({
					id: entry.id,
					parentId: entry.parentId,
					type: entry.type,
					message: entry.type === "message" ? entry.message : undefined,
					customType: entry.type === "custom" ? entry.customType : undefined,
					data: entry.type === "custom" ? entry.data : undefined,
				}));

			expect(comparable(forkEntries)).toEqual(comparable(sourceEntries));
			expect(forkEntries.map((entry) => entry.id)).toEqual([root, mainChild, threadChild, customId]);
			expect(await fork.getLanes()).toEqual(await source.getLanes());
			expect(await fork.getName()).toBe("tree source");
			expect(await fork.getLabel(threadChild)).toBe("thread tip");
			expect(await fork.getStats()).toMatchObject({ messageCount: 3 });
		} finally {
			await deleteSessions(repository, cwd, [sourceId, forkId]);
			await repository.close();
		}
	});

	it("does not resurrect unset names or labels in branch and tree forks", async () => {
		const repository = createRepository();
		const cwd = "/pi-rp-postgres-test";
		const sourceId = uniqueId("fact-tombstone");
		const branchId = uniqueId("fact-tombstone-branch");
		const treeId = uniqueId("fact-tombstone-tree");
		try {
			const source = await repository.create({ cwd, id: sourceId });
			const root = await source.appendMessage(createUserMessage("root"));
			const child = await source.appendMessage(createUserMessage("child"));
			await source.setName("temporary name");
			await source.setLabel(child, "temporary label");
			await source.setName(undefined);
			await source.setLabel(child, undefined);

			const metadata = await source.getMetadata();
			const branchFork = await repository.fork(metadata, {
				scope: "branch",
				entryId: child,
				position: "at",
				id: branchId,
				cwd,
			});
			const treeFork = await repository.fork(metadata, {
				scope: "tree",
				id: treeId,
				cwd,
			});
			for (const fork of [branchFork, treeFork]) {
				expect(await fork.getName()).toBeUndefined();
				expect(await fork.getLabel(child)).toBeUndefined();
			}
			expect((await branchFork.findEntries({ order: "oldestFirst" })).map((entry) => entry.id)).toEqual([
				root,
				child,
			]);
		} finally {
			await deleteSessions(repository, cwd, [sourceId, branchId, treeId]);
			await repository.close();
		}
	});

	it("rejects non-JSON metadata and leaves invalid create/fork targets absent", async () => {
		const repository = createRepository();
		const cwd = "/pi-rp-postgres-test";
		const sourceId = uniqueId("metadata-source");
		const createUndefinedId = uniqueId("metadata-create-undefined");
		const createCircularId = uniqueId("metadata-create-circular");
		const forkUndefinedId = uniqueId("metadata-fork-undefined");
		const forkCircularId = uniqueId("metadata-fork-circular");
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		const undefinedValue = { omitted: undefined };
		try {
			const source = await repository.create({ cwd, id: sourceId });
			const metadata = await source.getMetadata();
			await expect(
				repository.create({ cwd, id: createUndefinedId, metadata: undefinedValue }),
			).rejects.toMatchObject({ code: "invalid_payload" });
			await expect(repository.create({ cwd, id: createCircularId, metadata: circular })).rejects.toMatchObject({
				code: "invalid_payload",
			});
			await expect(
				repository.fork(metadata, {
					scope: "tree",
					id: forkUndefinedId,
					cwd,
					metadata: undefinedValue,
				}),
			).rejects.toMatchObject({ code: "invalid_payload" });
			await expect(
				repository.fork(metadata, {
					scope: "tree",
					id: forkCircularId,
					cwd,
					metadata: circular,
				}),
			).rejects.toMatchObject({ code: "invalid_payload" });

			const visibleIds = (await repository.list({ cwd })).map((session) => session.id);
			expect(visibleIds).toContain(sourceId);
			expect(visibleIds).not.toContain(createUndefinedId);
			expect(visibleIds).not.toContain(createCircularId);
			expect(visibleIds).not.toContain(forkUndefinedId);
			expect(visibleIds).not.toContain(forkCircularId);
		} finally {
			await deleteSessions(repository, cwd, [
				sourceId,
				createUndefinedId,
				createCircularId,
				forkUndefinedId,
				forkCircularId,
			]);
			await repository.close();
		}
	});

	it("leaves the caller-owned pool usable after repository.close", async () => {
		const pool = createPool();
		const repository = createRepository(pool);
		await repository.list();
		await repository.close();
		const result = await pool.query<{ value: number }>("SELECT 42 AS value");
		expect(result.rows).toEqual([{ value: 42 }]);
	});

	it("runs concurrent migrations safely and remains usable on repeated initialization", async () => {
		const cwd = "/pi-rp-postgres-test";
		const ids = Array.from({ length: 4 }, () => uniqueId("concurrent-migration"));
		const pools = Array.from({ length: 4 }, () => createPool());
		const repositories = pools.map((pool) => createRepository(pool));
		try {
			await Promise.all(
				repositories.map((repository, index) =>
					repository.create({
						cwd,
						id: ids[index]!,
					}),
				),
			);
			const listings = await Promise.all(repositories.map((repository) => repository.list({ cwd })));
			for (const listed of listings) {
				expect(ids.every((id) => listed.some((session) => session.id === id))).toBe(true);
			}
		} finally {
			await Promise.all(repositories.map((repository, index) => deleteSessions(repository, cwd, [ids[index]!])));
			await Promise.all(repositories.map((repository) => repository.close()));
		}
	});
});
