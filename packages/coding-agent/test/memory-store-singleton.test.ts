/**
 * Memory store singleton lifecycle (docs/design/56 存档与回档 §pi-rp B,
 * 54 提示词与角色时间语境 §pi-memory).
 *
 * The session layer keys one MemoryStore per resolved dbPath and reference
 * counts it, so:
 * - two sessions on the same DB share one SQLite connection (one open);
 * - releasing one reference keeps the connection (and the other session) alive;
 * - the last release closes the connection and drops the singleton, so a
 *   rebuilt session opens the path again — which is what makes 回档 (replace
 *   the DB file, rebuild the session) read the new file;
 * - setMemoryWorldTime after release is a no-op that never reopens;
 * - a set world time is re-applied at provider prepare time.
 *
 * Observation runs through the public `sqliteFactory` seam: the wrapped
 * factory records every open/close and keeps the raw handle, so the tests
 * never reach into AgentSession internals for the store itself.
 */
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SqliteDatabase, SqliteDatabaseFactory } from "@earendil-works/pi-agent-core";
import { Agent } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, type Model } from "@earendil-works/pi-ai";
import { registerFauxProvider, streamSimple } from "@earendil-works/pi-ai/compat";
import { openDatabase, openMemoryStore } from "@earendil-works/pi-memory";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { convertToLlm } from "../src/core/messages.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

interface SessionHarness {
	session: AgentSession;
	dispose: () => Promise<void>;
}

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

/**
 * A sqlite factory over the memory package's node default that records opens
 * and closes. `raw` keeps the underlying handle so a test can read the exact
 * connection the store singleton is using.
 */
function trackingFactory() {
	const opens: string[] = [];
	const closes: string[] = [];
	const handles = new Map<string, SqliteDatabase>();
	const factory: SqliteDatabaseFactory = {
		async open(path: string): Promise<SqliteDatabase> {
			const raw = await openDatabase(path);
			opens.push(path);
			handles.set(path, raw);
			return {
				exec: (sql) => raw.exec(sql),
				prepare: (sql) => raw.prepare(sql),
				transaction: (fn) => raw.transaction(fn),
				close: () => {
					closes.push(path);
					raw.close();
				},
			};
		},
	};
	return {
		factory,
		opens,
		closes,
		raw: (path: string): SqliteDatabase => {
			const db = handles.get(path);
			if (!db) throw new Error(`no tracked connection for ${path}`);
			return db;
		},
	};
}

async function createSession(
	tempDir: string,
	dbPath: string,
	model: Model<string>,
	sqliteFactory: SqliteDatabaseFactory,
): Promise<SessionHarness> {
	const sessionManager = SessionManager.inMemory();
	const settingsManager = SettingsManager.inMemory({ memory: { dbPath } });
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRegistry = await createInMemoryModelRegistry(authStorage);
	modelRegistry.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		api: model.api,
		apiKey: "faux-key",
		models: [
			{
				id: model.id,
				name: model.name,
				api: model.api,
				reasoning: model.reasoning,
				input: model.input,
				cost: model.cost,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
				baseUrl: model.baseUrl,
			},
		],
	});

	const agent = new Agent({
		getApiKey: () => "faux-key",
		streamFn: streamSimple,
		initialState: { model, systemPrompt: "You are a test assistant.", tools: [] },
		convertToLlm,
	});
	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: tempDir,
		modelRuntime: getModelRuntime(modelRegistry),
		resourceLoader: createTestResourceLoader(),
		sqliteFactory,
		disableAutoCompaction: true,
	});
	await session._buildRuntimePromise;
	return {
		session,
		dispose: async () => {
			session.dispose();
			await session.waitForMemoryStoreRelease();
		},
	};
}

/** Build a faux provider plus an isolated temp dir; registers cleanup. */
async function setup() {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-memory-singleton-"));
	const previousAgentDir = process.env[ENV_AGENT_DIR];
	process.env[ENV_AGENT_DIR] = join(tempDir, "agent");
	const faux = registerFauxProvider({});
	const model = faux.getModel();
	cleanups.push(async () => {
		faux.unregister();
		if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = previousAgentDir;
		rmSync(tempDir, { recursive: true, force: true });
	});
	return { tempDir, faux, model, dbPath: join(tempDir, "memory.db") };
}

/** Run a memory tool through the session's public definition registry. */
async function runTool(session: AgentSession, name: string, params: Record<string, unknown>): Promise<string> {
	const definition = session.getToolDefinition(name);
	if (!definition) throw new Error(`memory tool ${name} is not registered`);
	const result = (await definition.execute(`call-${name}`, params as never, undefined, undefined, {} as never)) as {
		content: Array<{ type: string; text?: string }>;
	};
	return result.content.map((block) => block.text ?? "").join("\n");
}

function worldTimeIn(db: SqliteDatabase): string | null {
	const row = db.prepare("SELECT value FROM memory_kv WHERE key = ?").get("world_time") as
		| { value: string }
		| undefined;
	return row?.value ?? null;
}

describe("memory store singleton per dbPath", () => {
	it("shares one store across sessions and closes it only after the last release", async () => {
		const { tempDir, model, dbPath } = await setup();
		const tracked = trackingFactory();

		const a = await createSession(tempDir, dbPath, model, tracked.factory);
		const b = await createSession(tempDir, dbPath, model, tracked.factory);
		expect(a.session.getMemoryDbPath()).toBe(dbPath);
		expect(b.session.getMemoryDbPath()).toBe(dbPath);
		// Same dbPath ⇒ a single open; the second session reuses the entry.
		expect(tracked.opens).toEqual([dbPath]);

		await runTool(a.session, "memorize", { uri: "core://shared", content: "两个会话共用一棵树" });

		// Releasing one reference keeps the connection open for the other.
		await a.dispose();
		expect(tracked.closes).toEqual([]);
		expect(tracked.opens).toHaveLength(1);
		expect(await runTool(b.session, "recall", { uri: "core://shared" })).toContain("两个会话共用一棵树");

		// The last release closes the connection exactly once.
		await b.dispose();
		expect(tracked.closes).toEqual([dbPath]);

		// The singleton is gone: a rebuilt session opens the path again and
		// still sees the persisted tree.
		const c = await createSession(tempDir, dbPath, model, tracked.factory);
		expect(tracked.opens).toEqual([dbPath, dbPath]);
		expect(await runTool(c.session, "recall", { uri: "core://shared" })).toContain("两个会话共用一棵树");
		await c.dispose();
		expect(tracked.closes).toEqual([dbPath, dbPath]);
	});

	it("reads the replacement file after the singleton is released (存档回档)", async () => {
		const { tempDir, model, dbPath } = await setup();
		const tracked = trackingFactory();

		const before = await createSession(tempDir, dbPath, model, tracked.factory);
		await runTool(before.session, "memorize", { uri: "history://scene", content: "旧存档：伊莱在雨夜离开酒馆" });
		await before.dispose();

		// Build the replacement save at a separate path, checkpoint it, and
		// swap it in as the live DB file.
		const replacementPath = join(tempDir, "replacement.db");
		const replacement = await openMemoryStore(replacementPath);
		replacement.insertNode({ uri: "history://scene", content: "新存档：伊莱在清晨回到酒馆" });
		replacement.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		replacement.close();
		for (const suffix of ["", "-wal", "-shm"]) {
			rmSync(`${dbPath}${suffix}`, { force: true });
		}
		copyFileSync(replacementPath, dbPath);

		const after = await createSession(tempDir, dbPath, model, tracked.factory);
		const recalled = await runTool(after.session, "recall", { uri: "history://scene" });
		expect(recalled).toContain("新存档：伊莱在清晨回到酒馆");
		expect(recalled).not.toContain("旧存档");
		await after.dispose();
	});

	it("ignores setMemoryWorldTime after release and never reopens the store", async () => {
		const { tempDir, model, dbPath } = await setup();
		const tracked = trackingFactory();

		const harness = await createSession(tempDir, dbPath, model, tracked.factory);
		harness.session.setMemoryWorldTime("2026-05-01T00:00:00.000Z");
		expect(worldTimeIn(tracked.raw(dbPath))).toBe("2026-05-01T00:00:00.000Z");

		await harness.dispose();
		expect(tracked.closes).toEqual([dbPath]);
		expect(() => harness.session.setMemoryWorldTime("2026-06-01T00:00:00.000Z")).not.toThrow();
		// No new connection was opened by the post-release setter.
		expect(tracked.opens).toEqual([dbPath]);
		expect(tracked.closes).toEqual([dbPath]);
	});

	it("re-applies the set world time at provider prepare", async () => {
		const { tempDir, faux, model, dbPath } = await setup();
		const tracked = trackingFactory();
		const harness = await createSession(tempDir, dbPath, model, tracked.factory);
		const db = tracked.raw(dbPath);

		harness.session.setMemoryWorldTime("2026-07-01T00:00:00.000Z");
		// Simulate drift (another writer/回档 of the kv row) between set and the
		// next provider request: prepare must re-apply the session's value.
		db.prepare("DELETE FROM memory_kv WHERE key = ?").run("world_time");
		expect(worldTimeIn(db)).toBeNull();

		faux.setResponses([fauxAssistantMessage("收到")]);
		await harness.session.prompt("第一轮");
		expect(worldTimeIn(db)).toBe("2026-07-01T00:00:00.000Z");

		// A later set is picked up on the following turn as well.
		harness.session.setMemoryWorldTime("2026-07-02T00:00:00.000Z");
		db.prepare("DELETE FROM memory_kv WHERE key = ?").run("world_time");
		faux.setResponses([fauxAssistantMessage("再收到")]);
		await harness.session.prompt("第二轮");
		expect(worldTimeIn(db)).toBe("2026-07-02T00:00:00.000Z");

		await harness.dispose();
	});
});
