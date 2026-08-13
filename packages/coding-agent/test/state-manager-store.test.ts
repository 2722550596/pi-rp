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
