import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StateManager } from "../src/state/state-manager.ts";
import { StateStore } from "../src/state/state-store.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("StateManager store integration", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-state-manager-store-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("writes applied state to the store on flushStore", () => {
		const sm = new StateManager();
		const store = new StateStore(dir);
		sm.attachStore(store);
		sm.apply("world.character.hp", "replace", 10);
		sm.flushStore();

		expect(store.readNamespace("world")).toEqual({ revision: 1, state: { character: { hp: 10 } } });
	});

	it("auto-flushes after the debounce window", async () => {
		const sm = new StateManager();
		const store = new StateStore(dir);
		sm.attachStore(store, { debounceMs: 20 });
		sm.apply("world.a", "replace", 1);

		await vi.waitFor(() => {
			expect(store.readNamespace("world").state).toEqual({ a: 1 });
		});
	});

	it("seeds schema defaults into the file before replaying ops (add on defaulted array appends)", () => {
		const sm = new StateManager();
		const store = new StateStore(dir);
		sm.attachStore(store, { fillDefaults: (_ns) => ({ present: [], situation: "开局" }) });
		sm.loadNamespace("world", { present: [], situation: "开局" });
		sm.apply("world.present", "add", "lizeyan");
		sm.flushStore();

		// 旧行为：文件基线 {} 上 replay add → present 写成字符串 "lizeyan"
		expect(store.readNamespace("world")).toEqual({
			revision: 1,
			state: { present: ["lizeyan"], situation: "开局" },
		});
	});

	it("seeds newly-added schema defaults into an existing file (schema evolution)", () => {
		const sm = new StateManager();
		const store = new StateStore(dir);
		sm.attachStore(store, { fillDefaults: (_ns) => ({ present: [], situation: "开局" }) });
		// 文件已存在（旧 schema 时代），缺 present 键；内存经 fillDefaults 有 present: []
		store.commitNamespace("world", 0, [{ op: "replace", path: "", value: { situation: "旧档" } }]);
		sm.loadNamespace("world", { situation: "旧档" });
		sm.apply("world.present", "add", "lizeyan");
		sm.flushStore();

		expect(store.readNamespace("world")).toEqual({
			revision: 2,
			state: { situation: "旧档", present: ["lizeyan"] }, // 既有值保留，缺失键补 default
		});
	});

	it("seed op is idempotent under a foreign-baseline CAS race (foreign keys kept)", () => {
		const sm = new StateManager();
		const store = new StateStore(dir);
		sm.attachStore(store, { fillDefaults: (_ns) => ({ present: [], situation: "开局" }) });
		sm.loadNamespace("world", { present: [] });
		sm.apply("world.present", "add", "lizeyan");
		// 他进程在 seed 提交前抢先写了 revision 1（本进程 _storeSeenRevs 仍为 0）
		store.commitNamespace("world", 0, [{ op: "replace", path: "", value: { foreign: 1, situation: "他人档" } }]);
		sm.flushStore();

		// CAS 重读后 seed 只补缺失键、不覆盖他人值；本进程 op 落在 revision 2
		expect(store.readNamespace("world")).toEqual({
			revision: 2,
			state: { foreign: 1, situation: "他人档", present: ["lizeyan"] },
		});
	});

	it("does not seed when no defaults are provided (ops replay only)", () => {
		const sm = new StateManager();
		const store = new StateStore(dir);
		sm.attachStore(store);
		// 他人已写 revision 1
		store.commitNamespace("world", 0, [{ op: "replace", path: "", value: { a: 1 } }]);
		sm.loadNamespace("world", { a: 1 });
		sm.apply("world.b", "replace", 2);
		sm.flushStore();

		expect(store.readNamespace("world")).toEqual({ revision: 2, state: { a: 1, b: 2 } });
	});

	it("reloads a namespace when the file changes externally and notifies subscribers", async () => {
		const sm = new StateManager();
		const store = new StateStore(dir);
		sm.attachStore(store);
		sm.apply("world.a", "replace", 1);
		sm.flushStore();
		expect(sm.get("world.a")).toBe(1);

		const notified = vi.fn();
		sm.subscribe(notified);

		// Simulate another process committing a whole-namespace replace at rev 2.
		store.commitNamespace("world", 1, [{ op: "replace", path: "", value: { b: 2 } }]);

		await vi.waitFor(
			() => {
				expect(notified).toHaveBeenCalled();
			},
			{ timeout: 3000 },
		);
		expect(sm.get("world.b")).toBe(2);
		expect(sm.get("world.a")).toBeUndefined(); // replacement, not deep merge
	});

	it("does not reload after its own write (seen revision equality)", async () => {
		const sm = new StateManager();
		const store = new StateStore(dir);
		sm.attachStore(store);
		const notified = vi.fn();
		sm.subscribe(notified);

		sm.apply("world.a", "replace", 1);
		expect(notified).toHaveBeenCalledTimes(1); // in-memory apply notify

		sm.flushStore();
		// Let the watcher see the rename and run its debounce.
		await sleep(400);
		expect(notified).toHaveBeenCalledTimes(1); // no reload-loop notify
	});

	it("skips namespaces rejected by canLoadNamespace", async () => {
		const sm = new StateManager();
		const store = new StateStore(dir);
		sm.attachStore(store, { canLoadNamespace: (ns) => ns !== "secret" });

		const notified = vi.fn();
		sm.subscribe(notified);
		store.commitNamespace("secret", 0, [{ op: "replace", path: "", value: { token: "x" } }]);

		await sleep(400);
		expect(notified).not.toHaveBeenCalled();
		expect(sm.get("secret")).toBeUndefined();
	});

	it("detachStore stops file writes", () => {
		const sm = new StateManager();
		const store = new StateStore(dir);
		sm.attachStore(store);
		sm.detachStore();

		sm.apply("world.a", "replace", 1);
		sm.flushStore();
		expect(store.listNamespaces()).toEqual([]);
	});

	it("commitOwnedToStore rewinds owned namespaces, leaves foreign ones alone", async () => {
		const sm = new StateManager();
		const store = new StateStore(dir);
		sm.attachStore(store, { canLoadNamespace: () => true });

		// Owned: world (locally written)
		sm.apply("world.a", "replace", 1);
		sm.flushStore();

		// Foreign: char — another process's file; the watcher loads it into memory.
		store.commitNamespace("char", 0, [{ op: "replace", path: "", value: { hp: 5 } }]);
		await vi.waitFor(
			() => {
				expect(sm.get("char")).toEqual({ hp: 5 });
			},
			{ timeout: 3000 },
		);

		// External change puts the world file ahead of memory.
		store.commitNamespace("world", 1, [{ op: "replace", path: "", value: { z: 99 } }]);
		await vi.waitFor(
			() => {
				expect(sm.get("world")).toEqual({ z: 99 });
			},
			{ timeout: 3000 },
		);

		// Rollback: memory rewound to the older value.
		sm.loadNamespace("world", { a: 1 });
		sm.commitOwnedToStore();

		expect(store.readNamespace("world")).toEqual({ revision: 3, state: { a: 1 } });
		// Foreign namespace untouched by the rollback commit.
		expect(store.readNamespace("char")).toEqual({ revision: 1, state: { hp: 5 } });
	});

	it("splits a root merge into per-namespace file commits", () => {
		const sm = new StateManager();
		const store = new StateStore(dir);
		sm.attachStore(store);
		sm.apply({ op: "merge", value: { world: { a: 1 }, char: { hp: 5 } } });
		sm.flushStore();

		expect(store.readNamespace("world")).toEqual({ revision: 1, state: { a: 1 } });
		expect(store.readNamespace("char")).toEqual({ revision: 1, state: { hp: 5 } });
	});

	it("splits a root replace into per-namespace replaces", () => {
		const sm = new StateManager();
		const store = new StateStore(dir);
		sm.attachStore(store);
		sm.apply("", "replace", { world: { a: 1 }, char: { hp: 5 } });
		sm.flushStore();

		expect(store.readNamespace("world")).toEqual({ revision: 1, state: { a: 1 } });
		expect(store.readNamespace("char")).toEqual({ revision: 1, state: { hp: 5 } });
	});

	it("invokes fillDefaults after replacing a namespace from the store", () => {
		const sm = new StateManager();
		const store = new StateStore(dir);
		const filled: string[] = [];
		sm.attachStore(store, { canLoadNamespace: () => true, fillDefaults: (ns) => filled.push(ns) });
		sm.loadNamespace("world", { a: 1 });
		expect(filled).toEqual(["world"]);
	});

	it("initial load re-attempts gated-out namespaces once the gate passes", async () => {
		const sm = new StateManager();
		const store = new StateStore(dir);
		let allowed = false; // emulates schemas loading after attach
		sm.attachStore(store, { canLoadNamespace: () => allowed });

		store.commitNamespace("world", 0, [{ op: "replace", path: "", value: { a: 1 } }]);
		await sleep(300);
		expect(sm.get("world")).toBeUndefined(); // gated out at attach time

		allowed = true; // schema lands → re-attempt the load
		sm.reloadNamespaceFromStore("world");
		expect(sm.get("world")).toEqual({ a: 1 });
	});
});
