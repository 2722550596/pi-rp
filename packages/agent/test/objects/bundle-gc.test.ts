import { describe, expect, it } from "vitest";
import { type BundleRoot, exportBundle, importBundle } from "../../src/core/objects/bundle/index.ts";
import { ObjectGarbageCollector } from "../../src/core/objects/gc.ts";
import {
	hashObject,
	type ObjectHash,
	type ObjectStore,
	type ObjectStoreAdmin,
} from "../../src/core/objects/object-store.ts";

function memoryStore(): { store: ObjectStore; admin: ObjectStoreAdmin; objects: Map<ObjectHash, Uint8Array> } {
	const objects = new Map<ObjectHash, Uint8Array>();
	return {
		objects,
		store: {
			async put(bytes) {
				const hash = await hashObject(bytes);
				objects.set(hash, bytes.slice());
				return hash;
			},
			async get(hash) {
				return objects.get(hash)?.slice();
			},
			async has(hash) {
				return objects.has(hash);
			},
		},
		admin: {
			async *listAll() {
				yield* objects.keys();
			},
			async remove(hash) {
				objects.delete(hash);
			},
		},
	};
}
function canonical(value: unknown): Uint8Array {
	if (Array.isArray(value))
		return new TextEncoder().encode(`[${value.map((item) => new TextDecoder().decode(canonical(item))).join(",")}]`);
	if (value !== null && typeof value === "object")
		return new TextEncoder().encode(
			`{${Object.entries(value)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, item]) => `${JSON.stringify(key)}:${new TextDecoder().decode(canonical(item))}`)
				.join(",")}}`,
		);
	return new TextEncoder().encode(JSON.stringify(value));
}
async function sourceBytes(chunks: readonly Uint8Array[]): Promise<AsyncIterable<Uint8Array>> {
	return (async function* () {
		yield* chunks;
	})();
}

describe("SaveBundle and object GC", () => {
	it("exports and imports a deduplicated tree closure", async () => {
		const from = memoryStore();
		const leaf = await from.store.put(canonical("shared"));
		const rootBytes = canonical({
			tg: "tree.v1",
			entries: [
				["a", leaf],
				["b", leaf],
			],
		});
		const root = await from.store.put(rootBytes);
		const chunks: Uint8Array[] = [];
		const roots: BundleRoot[] = [{ hash: root, codec: "tree.v1" }];
		const manifest = await exportBundle({
			roots,
			store: from.store,
			sink: {
				async write(chunk) {
					chunks.push(chunk.slice());
				},
			},
			createdAt: "2026-01-01T00:00:00.000Z",
		});
		const target = memoryStore();
		const imported = await importBundle({ source: await sourceBytes(chunks), objectStore: target.store });
		expect(imported.manifest.closure).toEqual(manifest.closure);
		expect([...target.objects.keys()].sort()).toEqual([leaf, root].sort());
		expect(await target.store.get(root)).toEqual(rootBytes);
	});
	it("rejects a truncated tar before mutating destination", async () => {
		const from = memoryStore();
		const leaf = await from.store.put(canonical({ tg: "chunk.v1", enc: "utf8", data: "bGVhZg==" }));
		const chunks: Uint8Array[] = [];
		await exportBundle({
			roots: [{ hash: leaf, codec: "chunk.v1" }],
			store: from.store,
			sink: {
				async write(chunk) {
					chunks.push(chunk.slice());
				},
			},
		});
		const target = memoryStore();
		await expect(
			importBundle({ source: await sourceBytes(chunks.slice(0, 1)), objectStore: target.store }),
		).rejects.toThrow();
		expect(target.objects.size).toBe(0);
	});
	it("dry-runs and then sweeps only unreachable objects", async () => {
		const memory = memoryStore();
		const live = await memory.store.put(canonical({ tg: "chunk.v1", enc: "utf8", data: "bGl2ZQ==" }));
		const orphan = await memory.store.put(canonical("orphan"));
		const snapshotId = "roots-1";
		const window = {
			id: "gc-1",
			isOpen: () => true,
			writeBarrierActive: () => true,
			currentRootsSnapshotId: () => snapshotId,
		};
		const gc = new ObjectGarbageCollector(memory.store, memory.admin, window);
		const rootsSnapshot = { id: snapshotId, roots: [{ hash: live, codec: "chunk.v1" }] };
		const dry = await gc.collectGarbage({ rootsSnapshot, gcWindowId: "gc-1", mode: { kind: "dry-run" } });
		expect(dry.candidates).toEqual([orphan]);
		expect(memory.objects.has(orphan)).toBe(true);
		await gc.collectGarbage({ rootsSnapshot, gcWindowId: "gc-1", mode: { kind: "sweep", dryRunId: dry.dryRunId } });
		expect(memory.objects.has(live)).toBe(true);
		expect(memory.objects.has(orphan)).toBe(false);
	});
});
