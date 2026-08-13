import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateStore } from "../src/state/state-store.ts";

describe("StateStore", () => {
	let dir: string;
	let store: StateStore;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-state-store-"));
		store = new StateStore(dir);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns { revision: 0, state: undefined } for a missing namespace", () => {
		expect(store.readNamespace("world")).toEqual({ revision: 0, state: undefined });
	});

	it("commits and reads back with monotonically increasing revisions", () => {
		const r1 = store.commitNamespace("world", 0, [{ op: "merge", path: "", value: { hp: 10 } }]);
		expect(r1).toEqual({ ok: true, revision: 1 });

		const r2 = store.commitNamespace("world", 1, [{ op: "merge", path: "", value: { name: "x" } }]);
		expect(r2).toEqual({ ok: true, revision: 2 });

		expect(store.readNamespace("world")).toEqual({ revision: 2, state: { hp: 10, name: "x" } });
	});

	it("retries on CAS conflict and replays ops onto the newer baseline", () => {
		// Writer A: revision 1
		store.commitNamespace("world", 0, [{ op: "merge", path: "", value: { base: true } }]);
		// Writer B (ahead of our stale expected=1): revision 2
		store.commitNamespace("world", 1, [{ op: "merge", path: "", value: { other: 1 } }]);

		// Our commit with stale expected=1 must re-read (rev 2), replay, land on 3.
		const result = store.commitNamespace("world", 1, [{ op: "merge", path: "", value: { mine: 2 } }]);
		expect(result).toEqual({ ok: true, revision: 3 });
		expect(store.readNamespace("world").state).toEqual({ base: true, other: 1, mine: 2 });
	});

	it("reports a revision conflict when retries are exhausted", () => {
		store.commitNamespace("world", 0, [{ op: "merge", path: "", value: { a: 1 } }]);
		const result = store.commitNamespace("world", 0, [{ op: "merge", path: "", value: { b: 2 } }], {
			maxRetries: 0,
		});
		expect(result).toEqual({ ok: false, reason: "revision conflict" });
	});

	it("replaces the whole namespace with path === ''", () => {
		store.commitNamespace("world", 0, [{ op: "merge", path: "", value: { a: 1, b: 2 } }]);
		store.commitNamespace("world", 1, [{ op: "replace", path: "", value: { c: 3 } }]);
		expect(store.readNamespace("world").state).toEqual({ c: 3 });
	});

	it("merge with a null value deletes the key (RFC 7396)", () => {
		store.commitNamespace("world", 0, [{ op: "merge", path: "", value: { a: 1, b: 2 } }]);
		store.commitNamespace("world", 1, [{ op: "merge", path: "", value: { a: null } }]);
		expect(store.readNamespace("world").state).toEqual({ b: 2 });
	});

	it("replays add ops: array push and numeric increment", () => {
		store.commitNamespace("world", 0, [{ op: "replace", path: "", value: { list: [1], count: 5 } }]);
		const result = store.commitNamespace("world", 1, [
			{ op: "add", path: "list", value: 2 },
			{ op: "add", path: "count", value: 3 },
		]);
		expect(result).toEqual({ ok: true, revision: 2 });
		expect(store.readNamespace("world").state).toEqual({ list: [1, 2], count: 8 });
	});

	it("replays add ops: missing key is created", () => {
		store.commitNamespace("world", 0, [{ op: "add", path: "newKey", value: "v" }]);
		expect(store.readNamespace("world").state).toEqual({ newKey: "v" });
	});

	it("removes a key via remove op", () => {
		store.commitNamespace("world", 0, [{ op: "replace", path: "", value: { a: 1, b: 2 } }]);
		store.commitNamespace("world", 1, [{ op: "remove", path: "a" }]);
		expect(store.readNamespace("world").state).toEqual({ b: 2 });
	});

	it("listNamespaces ignores tmp files", () => {
		store.commitNamespace("world", 0, [{ op: "replace", path: "", value: { a: 1 } }]);
		writeFileSync(join(dir, "stale.json.tmp"), "{}");
		expect(store.listNamespaces()).toEqual(["world"]);
	});

	it("cleanTmp removes orphan tmp files but keeps real files", () => {
		store.commitNamespace("world", 0, [{ op: "replace", path: "", value: { a: 1 } }]);
		writeFileSync(join(dir, "stale.json.tmp"), "{}");
		store.cleanTmp();
		expect(existsSync(join(dir, "stale.json.tmp"))).toBe(false);
		expect(existsSync(join(dir, "world.json"))).toBe(true);
	});
});
