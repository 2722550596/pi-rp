import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveMemoryClock, WORLD_CLOCK } from "../../src/clock.ts";
import { openMemoryStore } from "../../src/index.ts";
import { renderWakeupView } from "../../src/memory-views.ts";
import { MemoryStore } from "../../src/store.ts";
import { setAwakenUris } from "../../src/tools.ts";
import { main, parseCliArgs } from "../../src/web/cli.ts";
import { invalidateStats, readMemoryDbStats } from "../../src/web/discovery.ts";
import { StoreRegistry } from "../../src/web/registry.ts";
import { ROUTES } from "../../src/web/routes.ts";
import type { ServerContext } from "../../src/web/server.ts";

const real = resolveMemoryClock({ mode: "real", timezone: "Asia/Shanghai" });
let dir: string;
let store: MemoryStore;
let registry: StoreRegistry;
let ctx: ServerContext;

async function call(route: string, body?: unknown) {
	const url = new URL(route, "http://127.0.0.1");
	const result = await ROUTES.find(
		(r) => r.path === url.pathname && r.method === (body === undefined ? "GET" : "POST"),
	)!.handler({
		req: {} as IncomingMessage,
		url,
		body,
		ctx,
	});
	expect(result.status).toBe(200);
	// These handlers produce JSON DTOs; use the serialized boundary as clients do.
	return JSON.parse(JSON.stringify(result.body));
}

async function seed(file: string) {
	mkdirSync(path.dirname(file), { recursive: true });
	const db = await openMemoryStore(file);
	db.setWorldTime("2000-01-01T00:00:00Z");
	db.put({ uri: "core://seed", content: "时钟检索" });
	db.db.close();
}

beforeEach(async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date("2026-10-16T20:00:00Z"));
	dir = mkdtempSync(path.join(tmpdir(), "memory-clock-"));
	const file = path.join(dir, "process", "memory.db");
	await seed(file);
	store = await openMemoryStore(file);
	store.setClock(real);
	registry = new StoreRegistry({ policy: { roots: [dir] }, clock: real });
	registry.adopt(file, store);
	ctx = {
		store,
		dbPath: file,
		assetsDir: dir,
		tempThreshold: 10,
		tempThresholdSource: "default",
		startedAt: new Date().toISOString(),
		registry,
		pathPolicy: { roots: [dir] },
		bindHost: "127.0.0.1",
	};
	invalidateStats();
});
afterEach(async () => {
	await registry.closeAll();
	store.db.close();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.useRealTimers();
	invalidateStats();
	rmSync(dir, { recursive: true, force: true });
});

describe("web real memory clock", () => {
	it("starts the CLI with a real process store configured from files", async () => {
		const home = path.join(dir, "cli-home");
		mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
		writeFileSync(path.join(home, ".pi", "agent", "settings.json"), JSON.stringify({ memory: { clock: real } }));
		vi.stubEnv("HOME", home);
		vi.spyOn(process, "cwd").mockReturnValue(dir);
		let log = "";
		vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
			log += String(chunk);
			return true;
		});
		let shutdown: (() => void) | undefined;
		const on = process.on.bind(process);
		vi.spyOn(process, "on").mockImplementation((event, listener) => {
			if (event === "SIGTERM" || event === "SIGINT") {
				shutdown = listener;
				return process;
			}
			return on(event, listener);
		});
		let exited: (() => void) | undefined;
		const closed = new Promise<void>((resolve) => {
			exited = resolve;
		});
		vi.spyOn(process, "exit").mockImplementation(() => {
			exited?.();
			return undefined as never;
		});
		await main(["--db", path.join(dir, "cli.db"), "--port", "0", "--temp-threshold", "19"]);
		try {
			const url = /http:\/\/127\.0\.0\.1:\d+/.exec(log)?.[0];
			expect(url).toBeDefined();
			const response = await fetch(`${url}/api/meta`);
			const meta = await response.json();
			expect(meta.world_time).toBe("2026-10-17T04:00:00+08:00");
		} finally {
			shutdown?.();
			await closed;
		}
	});
	it("reads global and field-wise project clock settings even with a CLI threshold", () => {
		const home = path.join(dir, "home");
		const cwd = path.join(dir, "project");
		mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
		mkdirSync(path.join(cwd, ".pi"), { recursive: true });
		vi.stubEnv("HOME", home);
		vi.spyOn(process, "cwd").mockReturnValue(cwd);
		const parse = () => {
			const options = parseCliArgs(["--temp-threshold", "23"]);
			if ("help" in options) throw new Error("unexpected help");
			return options;
		};
		expect(parse().clock).toEqual(WORLD_CLOCK);
		writeFileSync(
			path.join(home, ".pi", "agent", "settings.json"),
			JSON.stringify({ memory: { clock: { mode: "real", timezone: "UTC" }, temp: { threshold: 7 } } }),
		);
		expect(parse().clock).toEqual({ mode: "real", timezone: "UTC" });
		writeFileSync(
			path.join(cwd, ".pi", "settings.json"),
			JSON.stringify({ memory: { clock: { timezone: "Asia/Shanghai" } } }),
		);
		expect(parse().clock).toEqual(real);
		expect(parse().tempThreshold).toBe(23);
		writeFileSync(path.join(cwd, ".pi", "settings.json"), JSON.stringify({ memory: { clock: { mode: "world" } } }));
		expect(parse().clock).toEqual(WORLD_CLOCK);
	});

	it("serves real meta, graph, search, wakeup and POST without world-key access", async () => {
		store.put({ uri: "core://yesterday", content: "时钟检索", world_ts: "2026-10-16T23:30:00+08:00" });
		setAwakenUris(store, ["core://yesterday"]);
		vi.spyOn(store, "getWorldTime").mockImplementation(() => {
			throw new Error("world read");
		});
		vi.spyOn(store, "setWorldTime").mockImplementation(() => {
			throw new Error("world write");
		});
		const prepare = store.db.prepare.bind(store.db);
		vi.spyOn(store.db, "prepare").mockImplementation((sql) => {
			const statement = prepare(sql);
			if (!sql.includes("memory_kv")) return statement;
			return new Proxy(statement, {
				get(target, key) {
					const value = Reflect.get(target, key);
					if (typeof value !== "function") return value;
					return (...args: unknown[]) => {
						if (sql.includes("world_time") || args.includes("world_time")) throw new Error("world key SQL");
						return value.apply(target, args);
					};
				},
			});
		});
		const now = "2026-10-17T04:00:00+08:00";
		for (const route of ["/api/meta", "/api/graph", "/api/graph?domain=core"])
			expect((await call(route)).world_time).toBe(now);
		expect((await call("/api/world-time", {})).world_time).toBe(now);
		expect(
			(await call(`/api/search?q=${encodeURIComponent("时钟检索")}`)).items.map((n: { uri: string }) => n.uri),
		).toContain("core://yesterday");
		const wakeup = await call("/api/view?name=wakeup");
		expect(wakeup.items.world_time).toBe(now);
		expect(wakeup.items.focuses[0].world_ts_relative).toBe("昨天");
		expect(renderWakeupView(store, ["core://yesterday"])).toContain("，昨天)");
	});

	it("returns one fresh time for open, cached-unopened and unreachable databases", async () => {
		const unopened = path.join(dir, "unopened", "memory.db");
		const missing = path.join(dir, "missing", "memory.db");
		await seed(unopened);
		mkdirSync(path.dirname(missing), { recursive: true });
		writeFileSync(missing, "not a sqlite database");
		// World cache cannot contaminate the real partition.
		expect((await readMemoryDbStats(unopened))!.worldTime).toBe("2000-01-01T00:00:00Z");
		expect((await readMemoryDbStats(unopened, undefined, "real"))!.worldTime).toBeNull();
		const stamp = vi.spyOn(store, "nowStamp");
		for (const [instant, expected] of [
			["2026-10-16T20:00:00Z", "2026-10-17T04:00:00+08:00"],
			["2026-10-16T20:00:01Z", "2026-10-17T04:00:01+08:00"],
		]) {
			vi.setSystemTime(new Date(instant));
			stamp.mockClear();
			const list = await call("/api/databases");
			expect(list.databases.find((d: { path: string }) => d.path === unopened).registered).toBe(false);
			const unreachable = list.databases.find((d: { path: string }) => d.path === missing);
			expect(unreachable.reachable).toBe(false);
			expect(unreachable.node_count).toBeNull();
			for (const db of list.databases) expect(db.world_time).toBe(expected);
			expect(stamp).toHaveBeenCalledTimes(1);
		}
		store.setClock(WORLD_CLOCK);
		const world = await call("/api/databases");
		expect(world.databases.find((d: { path: string }) => d.path === unopened).world_time).toBe(
			"2000-01-01T00:00:00Z",
		);
		expect(world.databases.find((d: { path: string }) => d.path === missing).world_time).toBeNull();
	});

	it("configures fallback registry and both create connections with the real clock", async () => {
		delete ctx.registry;
		const file = path.join(dir, "new.db");
		const configured: MemoryStore[] = [];
		const setClock = MemoryStore.prototype.setClock;
		vi.spyOn(MemoryStore.prototype, "setClock").mockImplementation(function (this: MemoryStore, clock) {
			configured.push(this);
			setClock.call(this, clock);
		});
		let fallback: StoreRegistry | undefined;
		const register = StoreRegistry.prototype.register;
		vi.spyOn(StoreRegistry.prototype, "register").mockImplementation(function (this: StoreRegistry, raw) {
			fallback = this;
			return register.call(this, raw);
		});
		try {
			const created = await call("/api/databases/create", { path: file, confirm: true });
			expect(created.world_time).toBe("2026-10-17T04:00:00+08:00");
			expect(configured).toHaveLength(2);
			for (const connection of configured) expect(connection.getClock()).toEqual(real);
			const opened = await call("/api/databases/open", { path: file });
			expect(opened.world_time).toBe(created.world_time);
		} finally {
			fallback?.closeAll();
		}
	});

	it("configures LRU reopens and invalidates both discovery cache partitions", async () => {
		const a = path.join(dir, "a.db");
		const b = path.join(dir, "b.db");
		await seed(a);
		await seed(b);
		const lru = new StoreRegistry({ policy: { roots: [dir] }, clock: real, limit: 1 });
		try {
			for (const mode of ["world", "real"] as const)
				expect((await readMemoryDbStats(a, undefined, mode))!.nodeCount).toBe(1);
			let entry = await lru.register(a);
			expect(entry.store.getClock()).toEqual(real);
			entry.store.put({ uri: "core://new", content: "新增" });
			lru.release(entry);
			for (const mode of ["world", "real"] as const)
				expect((await readMemoryDbStats(a, undefined, mode))!.nodeCount).toBe(2);
			entry = await lru.register(b);
			lru.release(entry);
			entry = (await lru.resolve(a))!;
			expect(entry.store.nowStamp()).toBe("2026-10-17T04:00:00+08:00");
			entry.store.put({ uri: "core://third", content: "第三条" });
			lru.release(entry);
			invalidateStats();
			for (const mode of ["world", "real"] as const)
				expect((await readMemoryDbStats(a, undefined, mode))!.nodeCount).toBe(3);
		} finally {
			await lru.closeAll();
		}
	});

	it("retains world unset and set values across meta, graph, POST and cached stats", async () => {
		store.setClock(WORLD_CLOCK);
		expect((await call("/api/meta")).world_time).toBe("2000-01-01T00:00:00Z");
		expect((await call("/api/graph")).world_time).toBe("2000-01-01T00:00:00Z");
		expect((await call("/api/world-time", { value: "+1d" })).world_time).toBe("2000-01-02T00:00:00.000Z");
		store.db.prepare("DELETE FROM memory_kv WHERE key = ?").run("world_time");
		expect((await call("/api/meta")).world_time).toBeNull();
		expect((await call("/api/graph?domain=core")).world_time).toBeNull();
		expect(renderWakeupView(store, [])).toContain("> 当前世界时间: 2026-10-16T20:00:00.000Z");
	});
});

it("scores web recency against the real local day while retaining world's unset-clock fallback", async () => {
	store.put({ uri: "core://boundary", content: "calendarboundary", world_ts: "2026-10-09T23:30:00+08:00" });
	const realResult = await call("/api/search?q=calendarboundary");
	store.setClock(WORLD_CLOCK);
	store.db.prepare("DELETE FROM memory_kv WHERE key = ?").run("world_time");
	const worldResult = await call("/api/search?q=calendarboundary");
	expect(worldResult.items[0].score - realResult.items[0].score).toBeCloseTo(0.04);
});
