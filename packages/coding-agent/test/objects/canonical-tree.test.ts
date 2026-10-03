import type { ObjectHash, ObjectStore } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { canonicalJson, canonicalJsonBytes } from "../../src/core/objects/tree/canonical-json.ts";
import { JsonTree, TreeError } from "../../src/core/objects/tree/index.ts";
import { stateOpToTreeEdits } from "../../src/core/objects/tree/state-op-diff.ts";
import type { JsonValue } from "../../src/state/merge.ts";
import { applyOp, type SeedOp, type StateOp } from "../../src/state/state-manager.ts";

class FakeStore implements ObjectStore {
	readonly objects = new Map<ObjectHash, Uint8Array>();
	async put(data: Uint8Array): Promise<ObjectHash> {
		const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", data)), (part) =>
			part.toString(16).padStart(2, "0"),
		).join("");
		this.objects.set(hash, data.slice());
		return hash;
	}
	async get(hash: ObjectHash): Promise<Uint8Array | undefined> {
		return this.objects.get(hash)?.slice();
	}
	async has(hash: ObjectHash): Promise<boolean> {
		return this.objects.has(hash);
	}
}

describe("canonical JSON", () => {
	it.each([
		["0", -0],
		["0.1", 0.1],
		["1e-7", 1e-7],
		["1e21", 1e21],
		["5e-324", Number.MIN_VALUE],
		["1.7976931348623157e308", Number.MAX_VALUE],
	])("encodes %s", (expected, value) => expect(canonicalJson(value)).toBe(expected));
	it("locks number vector text and hashes, including the binary64 precision boundary", async () => {
		const vectors: [number, string, string][] = [
			[-0, "0", "5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9"],
			[0.1, "0.1", "14be4b45f18e0d8c67b4f719b5144eee88497e413709d11d85b096d8e2346310"],
			[1e-7, "1e-7", "5b33e02f2c5103a05d32f6ba9cb058294452bfbf393967f68bb30c1bdcbbab22"],
			[1e21, "1e21", "e607aaf738f67fc2879a2a52672c599e9337b4cacd57582c6d3cf9526f5aa222"],
			[Number.MIN_VALUE, "5e-324", "c46e7ca1be4c8734f373a56530787288fa2058d73d07855e9247e949f811a42a"],
			[
				Number.MAX_VALUE,
				"1.7976931348623157e308",
				"217ab4b30c6f536b285884e38da73315e3c6e694910dbbd5ae36f396b6f835bb",
			],
			[9007199254740991, "9007199254740991", "f40b423c2dd95ff2b2f027e22208f438cf7242862e5e746860e697308c9add26"],
			[9007199254740992, "9007199254740992", "c681da39d7273a6a24c15c9cac3a75526ff2ecf8ba4ee60346a0c70c8163bdb2"],
			[
				Number("9007199254740993"),
				"9007199254740992",
				"c681da39d7273a6a24c15c9cac3a75526ff2ecf8ba4ee60346a0c70c8163bdb2",
			],
			[1.0000000000000002, "1.0000000000000002", "19119a03721db7fc2a2f06afad179bdd384cc44b54e1d4f4f57e374c5b44fbd0"],
		];
		for (const [input, text, hash] of vectors) {
			const encoded = canonicalJson(input);
			expect(encoded).toBe(text);
			const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(encoded));
			expect(Array.from(new Uint8Array(digest), (part) => part.toString(16).padStart(2, "0")).join("")).toBe(hash);
			expect(JSON.parse(encoded)).toBe(input === 0 ? 0 : input);
		}
	});
	it("locks string, Unicode-key, and array-hole golden bytes and hashes", async () => {
		const sparse = new Array(3) as unknown as JsonValue[];
		(sparse as unknown[])[0] = 1;
		(sparse as unknown[])[2] = 3;
		const sparseValue = sparse as unknown as JsonValue;
		const vectors: [JsonValue, string, string][] = [
			[{ b: 2, a: 1 }, '{"a":1,"b":2}', "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777"],
			[
				{ e: 3, "e\u0301": 4, "": 2, 𐀀: 1 },
				'{"e":3,"é":4,"":2,"𐀀":1}',
				"86d37e910fa55abd546e05b48a7bc014a2891567d5297d1c7f8b8799d6e5e2ca",
			],
			["é", '"é"', "f2886017e9c7abacf804b54d64787dce2b611c9544ba21f3affdd126a6e50086"],
			["e\u0301", '"é"', "3d68ce21f2899a475713cdbe7562ba9bdb6b1dfde8af1f221bdff4a0935b53b2"],
			[
				"/\b\t\n\f\r\u0001",
				'"/\\b\\t\\n\\f\\r\\u0001"',
				"021d1a59732e84897f115f1c46cc81df467e7119bdca9c44f710e32c0af7e904",
			],
			["🌞", '"🌞"', "2bf0bf894479c440498e5236c9076ed07979c5bc178039e4eaaffc19020141c1"],
			[sparseValue, "[1,null,3]", "7db5b36a1553a4e31914df4beb60752bd07320e3056ac1d3790660c4cad6a173"],
		];
		for (const [value, text, expectedHash] of vectors) {
			const bytes = canonicalJsonBytes(value);
			expect(new TextDecoder().decode(bytes)).toBe(text);
			const digest = await crypto.subtle.digest("SHA-256", bytes);
			expect(Array.from(new Uint8Array(digest), (part) => part.toString(16).padStart(2, "0")).join("")).toBe(
				expectedHash,
			);
		}
		expect(canonicalJsonBytes({ a: 1, b: 2 })).toEqual(canonicalJsonBytes({ b: 2, a: 1 }));
	});
	it("emits fixed short escapes and leaves slash unescaped", () => {
		expect(canonicalJson("/\b\t\n\f\r\u0001")).toBe('"/\\b\\t\\n\\f\\r\\u0001"');
	});
	it("orders keys by Unicode scalar value and preserves normalization", () => {
		expect(canonicalJson({ 𐀀: 1, "": 2, e: 3, "e\u0301": 4 })).toBe('{"e":3,"é":4,"":2,"𐀀":1}');
	});
	it("escapes JSON controls and rejects invalid values", () => {
		expect(canonicalJson("/\n\t\u0000")).toBe('"/\\n\\t\\u0000"');
		expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow();
		expect(() => canonicalJson(Number.NaN)).toThrow();
		expect(() => canonicalJson(Number.NEGATIVE_INFINITY)).toThrow();
		expect(() => canonicalJson(Number("1e400"))).toThrow();
		expect(() => canonicalJson("\ud800")).toThrow();
		const cyclic: { self?: unknown } = {};
		cyclic.self = cyclic;
		expect(() => canonicalJson(cyclic as unknown as JsonValue)).toThrow();
		expect(() => canonicalJson(new Date() as unknown as JsonValue)).toThrow();
	});
	it("produces fixed UTF-8 golden bytes and digest", async () => {
		const bytes = canonicalJsonBytes({ b: 2, a: "é" });
		expect(new TextDecoder().decode(bytes)).toBe('{"a":"é","b":2}');
		expect(
			Array.from(bytes)
				.map((part) => part.toString(16).padStart(2, "0"))
				.join(""),
		).toBe("7b2261223a22c3a9222c2262223a327d");
		expect(
			Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (part) =>
				part.toString(16).padStart(2, "0"),
			).join(""),
		).toBe("06c264c46ad5ada9493abd3aa2383fb205ae99d7d0bad40b03a43bfec8a1b8de");
	});
});

describe("JsonTree", () => {
	it.each([
		null,
		true,
		false,
		0,
		0.1,
		"",
		"Unicode 🌞",
		[],
		{},
		{ items: Array.from({ length: 11 }, (_, index) => index) },
	] satisfies JsonValue[])("builds, reads, and rebuilds %j idempotently", async (value) => {
		const tree = new JsonTree(new FakeStore());
		const first = await tree.build(value);
		expect(await tree.read(first.root)).toEqual(value);
		expect(await tree.build(value)).toEqual(first);
	});
	it("round-trips containers and preserves sparse array holes", async () => {
		const store = new FakeStore();
		const tree = new JsonTree(store);
		const nestedInput = new Array(3) as unknown as JsonValue[];
		(nestedInput as unknown[])[0] = "x";
		(nestedInput as unknown[])[2] = { "a/b": true };
		const input: JsonValue = {
			["__proto__"]: { safe: true },
			nested: nestedInput as unknown as JsonValue,
			empty: {},
		};
		const { root } = await tree.build(input);
		const result = await tree.read(root);
		expect(result).toEqual(input);
		if (result === undefined || result === null || Array.isArray(result) || typeof result !== "object")
			throw new Error("Expected object root");
		const nested = result.nested;
		expect(Array.isArray(nested)).toBe(true);
		if (!Array.isArray(nested)) throw new Error("Expected nested array");
		expect(1 in nested).toBe(false);
		expect(Object.hasOwn(result, "__proto__")).toBe(true);
		expect(await tree.read(root, ["missing"])).toBeUndefined();
		expect(await tree.read(root, ["nested", "99"])).toBeUndefined();
		await expect(tree.read(root, ["nested", "01"])).rejects.toMatchObject({ code: "invalid_path" });
	});
	it("reuses hashes for identical builds and empty update", async () => {
		const store = new FakeStore();
		const tree = new JsonTree(store);
		const first = await tree.build({ a: 1, b: 2 });
		expect(await tree.build({ b: 2, a: 1 })).toEqual(first);
		expect(await tree.update(first.root, [])).toEqual(first);
	});
	it("updates a path and keeps the old root readable", async () => {
		const tree = new JsonTree(new FakeStore());
		const old = await tree.build({ left: { value: 1 }, right: { value: 2 } });
		const changed = await tree.update(old.root, [{ op: "set", path: ["left", "value"], value: 3 }]);
		expect(changed.root).not.toBe(old.root);
		expect(await tree.read(old.root, ["left", "value"])).toBe(1);
		expect(await tree.read(changed.root, ["left", "value"])).toBe(3);
	});
	it("path-copies through a large ref-wrapped branch", async () => {
		const tree = new JsonTree(new FakeStore());
		const original = await tree.build({
			branch: { count: 1, payload: "x".repeat(70 * 1024) },
			sibling: { stable: true },
		});
		const updated = await tree.update(original.root, [{ op: "set", path: ["branch", "count"], value: 2 }]);
		expect(await tree.read(updated.root, ["branch", "count"])).toBe(2);
		expect(await tree.read(original.root, ["branch", "count"])).toBe(1);
	});
	it("path-copies only changed ancestors and retains the untouched sibling hash", async () => {
		const store = new FakeStore();
		const tree = new JsonTree(store);
		const old = await tree.build({ left: { x: 1 }, middle: { x: 2 }, right: { x: 3 } });
		const oldRoot = JSON.parse(new TextDecoder().decode(store.objects.get(old.root)!)) as {
			entries: [string, string][];
		};
		const rightHash = oldRoot.entries.find(([key]) => key === "right")?.[1];
		const oldHashes = new Set(store.objects.keys());
		const changed = await tree.update(old.root, [{ op: "set", path: ["left", "x"], value: 9 }]);
		const newRoot = JSON.parse(new TextDecoder().decode(store.objects.get(changed.root)!)) as {
			entries: [string, string][];
		};
		expect(newRoot.entries.find(([key]) => key === "right")?.[1]).toBe(rightHash);
		expect(newRoot.entries.find(([key]) => key === "middle")?.[1]).toBe(
			oldRoot.entries.find(([key]) => key === "middle")?.[1],
		);
		expect(changed.root).not.toBe(old.root);
		expect(newRoot.entries.find(([key]) => key === "left")?.[1]).not.toBe(
			oldRoot.entries.find(([key]) => key === "left")?.[1],
		);
		expect([...store.objects.keys()].filter((hash) => !oldHashes.has(hash))).toHaveLength(3);
	});
	it("reports explicit errors for missing, corrupt, and unsupported objects", async () => {
		const store = new FakeStore();
		const tree = new JsonTree(store);
		await expect(tree.read("0".repeat(64))).rejects.toMatchObject({ code: "missing_object" });
		const ordinary = await tree.build({ value: 1 });
		store.objects.set(ordinary.root, new TextEncoder().encode("{}"));
		await expect(tree.read(ordinary.root)).rejects.toMatchObject({ code: "hash_mismatch" });
		const unknown = await store.put(new TextEncoder().encode('{"tg":"unknown.v9"}'));
		await expect(tree.read(unknown)).rejects.toBeInstanceOf(TreeError);
		await expect(tree.read(unknown)).rejects.toMatchObject({ code: "unsupported_tag" });
		const duplicateKey = await store.put(new TextEncoder().encode('{"key":1,"key":2}'));
		await expect(tree.read(duplicateKey)).rejects.toMatchObject({ code: "corrupt_object" });
	});

	it("round-trips long rope strings with bounded grapheme-safe chunks", async () => {
		const store = new FakeStore();
		const tree = new JsonTree(store);
		const family = "👩‍👩‍👧‍👦";
		const source = `${"line\n".repeat(1200)}${family.repeat(3000)}`;
		const { root } = await tree.build(source);
		expect(await tree.read(root)).toBe(source);
		const manifestBytes = [...store.objects.values()].find((data) =>
			new TextDecoder().decode(data).includes('"rope.v1"'),
		);
		expect(manifestBytes).toBeDefined();
		const manifest = JSON.parse(new TextDecoder().decode(manifestBytes!)) as { chunks: { h: string; s: number }[] };
		const decoded = manifest.chunks.map(({ h, s }) => {
			const chunk = JSON.parse(new TextDecoder().decode(store.objects.get(h)!)) as { data: string };
			const data = Uint8Array.from(atob(chunk.data), (char) => char.charCodeAt(0));
			expect(s).toBe(data.byteLength);
			expect(data.byteLength).toBeLessThanOrEqual(8 * 1024);
			return new TextDecoder().decode(data);
		});
		expect(manifest.chunks.some(({ s }) => s >= 4 * 1024 && s <= 8 * 1024)).toBe(true);
		expect(decoded.join("")).toBe(source);
		const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
		for (let i = 0; i < decoded.length - 1; i++) {
			const left = Array.from(segmenter.segment(decoded[i])).at(-1)?.segment ?? "";
			const right = Array.from(segmenter.segment(decoded[i + 1]))[0]?.segment ?? "";
			expect(Array.from(segmenter.segment(left + right))).toHaveLength(2);
		}
	});

	it("uses only put/get/has without hidden store capabilities", async () => {
		const store = new FakeStore();
		const trapped = new Proxy(store, {
			get(target, property, receiver) {
				if (
					property === "list" ||
					property === "delete" ||
					property === "transaction" ||
					property === "remove" ||
					property === "listAll"
				) {
					throw new Error(`Forbidden ObjectStore capability: ${String(property)}`);
				}
				return Reflect.get(target, property, receiver);
			},
		});
		const tree = new JsonTree(trapped);
		const built = await tree.build({ value: "safe" });
		expect(await tree.read(built.root)).toEqual({ value: "safe" });
		await tree.update(built.root, [{ op: "set", path: ["value"], value: "updated" }]);
	});

	it.each([
		{ op: "add", path: "count", value: 2, initial: { count: 4 } },
		{ op: "add", path: "items", value: "x", initial: { items: ["a"] } },
		{ op: "add", path: "items", value: ["x"], initial: { items: ["a"] } },
		{ op: "add", path: "missing.deep", value: 7, initial: {} },
		{ op: "add", path: "value", value: false, initial: { value: "old" } },
		{ op: "replace", path: "items/3", value: true, initial: { items: [] } },
		{ op: "replace", path: "", value: { replacement: 1 }, initial: { old: true } },
		{ op: "replace", path: "", value: "ignored", initial: { retained: true } },
		{ op: "remove", path: "missing", value: undefined, initial: { retained: true } },
		{ op: "remove", path: "items/1", value: undefined, initial: { items: ["a", "b", "c"] } },
		{ op: "merge", path: "", value: { a: null, b: { x: 2 } }, initial: { a: 1, b: { x: 1 }, c: true } },
		{ op: "merge", path: "", value: 5, initial: { a: 1 } },
		{ op: "seed", path: "", value: { a: 3, b: { x: 2 } }, initial: { a: null, b: { keep: true } } },
	] satisfies {
		op: StateOp | SeedOp;
		path: string;
		value: JsonValue | undefined;
		initial: Record<string, JsonValue>;
	}[])("matches full-build oracle for $op at $path", async ({ op, path, value, initial }) => {
		const state = structuredClone(initial);
		const expected = structuredClone(initial);
		applyOp(expected, op, path, value);
		const tree = new JsonTree(new FakeStore());
		const original = await tree.build(state);
		const edits = stateOpToTreeEdits(state, op, path, value);
		const actual = await tree.update(original.root, edits);
		const oracle = await tree.build(expected);
		expect(actual.root).toBe(oracle.root);
	});
});
