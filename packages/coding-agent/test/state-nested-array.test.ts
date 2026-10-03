import type { ObjectHash, ObjectStore } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { JsonTree } from "../src/core/objects/tree/index.ts";
import { stateOpToTreeEdits } from "../src/core/objects/tree/state-op-diff.ts";
import type { JsonValue } from "../src/state/merge.ts";
import { StateManager } from "../src/state/state-manager.ts";

class FakeStore implements ObjectStore {
	readonly objects = new Map<ObjectHash, Uint8Array>();
	async put(data: Uint8Array): Promise<ObjectHash> {
		const digest = await crypto.subtle.digest("SHA-256", data);
		const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
		this.objects.set(hash as ObjectHash, data.slice());
		return hash as ObjectHash;
	}
	async get(hash: ObjectHash): Promise<Uint8Array | undefined> {
		return this.objects.get(hash)?.slice();
	}
	async has(hash: ObjectHash): Promise<boolean> {
		return this.objects.has(hash);
	}
}

describe("StateManager nested array paths (regression: resolvePath array traversal)", () => {
	it("replaces fields inside nested array elements", () => {
		const sm = new StateManager();
		sm.apply("party", "replace", [
			{ name: "alice", hp: 10 },
			{ name: "bob", hp: 8 },
		]);
		sm.apply("/party/0/hp", "replace", 99);
		const party = sm.get("party") as Array<Record<string, unknown>>;
		expect(party[0].hp).toBe(99);
		expect(party[1].hp).toBe(8);
	});

	it("removes keys inside array elements keeping array identity", () => {
		const sm = new StateManager();
		sm.apply("party", "replace", [{ name: "alice", hp: 10 }, { name: "bob" }]);
		sm.apply("/party/0/hp", "remove");
		const party = sm.get("party") as Array<Record<string, unknown>>;
		expect(party).toHaveLength(2);
		expect(party[0]).toEqual({ name: "alice" });
	});

	it("increments numeric fields inside array elements via add", () => {
		const sm = new StateManager();
		sm.apply("party", "replace", [{ hp: 10 }]);
		sm.apply("/party/0/hp", "add", 5);
		expect((sm.get("party") as Array<Record<string, unknown>>)[0].hp).toBe(15);
	});

	it("reads through nested arrays with dot and JSON Pointer notation", () => {
		const sm = new StateManager();
		sm.apply("party", "replace", [{ hp: 10 }]);
		expect(sm.get("/party/0/hp")).toBe(10);
		expect(sm.get("party.0.hp")).toBe(10);
	});

	it("add beyond array end is a no-op and never creates sparse holes", () => {
		const sm = new StateManager();
		sm.apply("party", "replace", [{ hp: 10 }]);
		const result = sm.apply("/party/5/hp", "replace", 1);
		expect(result.newValue).toBeUndefined();
		const party = sm.get("party") as Array<Record<string, unknown>>;
		expect(party).toHaveLength(1);
		expect(1 in (sm.get("party") as unknown[])).toBe(false);
	});

	it("add to array element one past the end appends without holes", () => {
		const sm = new StateManager();
		sm.apply("party", "replace", [{ hp: 10 }]);
		sm.apply("/party/1", "add", { hp: 5 });
		const party = sm.get("party") as Array<Record<string, unknown>>;
		expect(party).toHaveLength(2);
		expect(party[1]).toEqual({ hp: 5 });
	});

	it("setDeep fallback never destroys an existing array (old data-loss bug)", () => {
		const sm = new StateManager();
		sm.apply("party", "replace", [{ name: "alice" }]);
		// 旧行为：resolvePath 不可达 → setDeep 把 party 数组整个替换成 {}（数据丢失）
		sm.apply("/party/0/profile/bio", "add", "hello");
		const party = sm.get("party") as Array<Record<string, unknown>>;
		expect(Array.isArray(party)).toBe(true);
		expect(party[0].name).toBe("alice");
	});

	it("non-numeric segment on an array stays unreachable (no object keys on arrays)", () => {
		const sm = new StateManager();
		sm.apply("party", "replace", [{ hp: 10 }]);
		sm.apply("/party/name", "replace", "x");
		const party = sm.get("party") as unknown[];
		expect(party).toHaveLength(1);
		expect((party as unknown as Record<string, unknown>).name).toBeUndefined();
	});
});

describe("nested array ops stay consistent with the tree oracle", () => {
	it("differ output matches a full rebuild root hash for nested array ops", async () => {
		const store = new FakeStore();
		const tree = new JsonTree(store);
		const base: Record<string, JsonValue> = { party: [{ name: "alice", hp: 10 }] };
		const rootHash = (await tree.build(base)).root;

		// 与 StateManager.apply 相同序列：replace 嵌套字段 → remove 键 → add 递增（每个 op 基于其真实前置态）
		const mid: Record<string, JsonValue> = structuredClone(base);
		(mid.party as Array<Record<string, JsonValue>>)[0].hp = 99;
		const after: Record<string, JsonValue> = structuredClone(mid);
		delete (after.party as Array<Record<string, JsonValue>>)[0].name;

		const edits = [
			...stateOpToTreeEdits(base, "replace", "/party/0/hp", 99),
			...stateOpToTreeEdits(mid, "remove", "/party/0/name", undefined),
			...stateOpToTreeEdits(after, "add", "/party/0/hp", 5),
		];
		const updated = await tree.update(rootHash, edits);
		// 第三个 op（add hp=5）作用于 after（hp=99）→ 最终态 hp=104
		const after3: Record<string, JsonValue> = structuredClone(after);
		(after3.party as Array<Record<string, JsonValue>>)[0].hp = 104;
		const expected = (await tree.build(after3)).root;
		expect(updated.root).toBe(expected);
		// 读回一致性
		expect(await tree.read(updated.root, ["party", "0", "hp"])).toBe(104);
	});
});
