import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeObjectStore, createNodeObjectStoreAdmin } from "../../src/core/objects/node-store.ts";
import type {
	ObjectHash,
	ObjectStore,
	ObjectStoreAdmin,
	ObjectStoreError,
} from "../../src/core/objects/object-store.ts";
import { createOpfsObjectStore, createOpfsObjectStoreAdmin } from "../../src/core/objects/opfs-store.ts";
import { OpfsFileSystem } from "../../src/harness/env/opfs/file-system.ts";
import { createMockOpfsRoot } from "../harness/env/opfs-mock.ts";

type StoreInstance = {
	store: ObjectStore;
	admin: ObjectStoreAdmin;
	reopen(): ObjectStore;
	injectReadFailure(hash: ObjectHash): Promise<void>;
	teardown(): Promise<void>;
};

interface StoreProvider {
	name: string;
	create(): Promise<StoreInstance>;
}

function expectError(promise: Promise<unknown>, code: ObjectStoreError["code"]): Promise<void> {
	return expect(promise).rejects.toMatchObject({ code });
}
async function collectHashes(admin: ObjectStoreAdmin): Promise<ObjectHash[]> {
	const hashes: ObjectHash[] = [];
	for await (const hash of admin.listAll()) hashes.push(hash);
	return hashes;
}

export function createObjectStoreConformance(providers: readonly StoreProvider[]): void {
	for (const provider of providers) {
		describe(`ObjectStore conformance: ${provider.name}`, () => {
			let store: ObjectStore;
			let admin: ObjectStoreAdmin;
			let reopen: () => ObjectStore;
			let injectReadFailure: (hash: ObjectHash) => Promise<void>;
			let corrupt: (hash: ObjectHash) => Promise<void>;
			let teardown: () => Promise<void>;

			beforeEach(async () => {
				const opened = await provider.create();
				store = opened.store;
				admin = opened.admin;
				corrupt = opened.corrupt;
				teardown = opened.teardown;
				reopen = opened.reopen;
				injectReadFailure = opened.injectReadFailure;
			});
			afterEach(async () => teardown());

			it("stores empty and arbitrary bytes at their SHA-256 addresses", async () => {
				for (const data of [new Uint8Array(), new Uint8Array([0, 255, 128, 1, 240, 159, 146, 169])]) {
					const hash = await store.put(data);
					if (data.length === 0)
						expect(hash).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
					expect(await store.get(hash)).toEqual(data);
				}
			});

			it("is idempotent and retains separate objects", async () => {
				const first = new Uint8Array([1, 2, 3]);
				const second = new Uint8Array([1, 2, 4]);
				const hash = await store.put(first);
				expect(await store.put(first)).toBe(hash);
				const another = await store.put(second);
				expect(another).not.toBe(hash);
				expect(await store.get(hash)).toEqual(first);
				expect(await store.get(another)).toEqual(second);
			});

			it("distinguishes missing, existing, and corrupt objects", async () => {
				const missing = "a".repeat(64);
				expect(await store.get(missing)).toBeUndefined();
				expect(await store.has(missing)).toBe(false);
				const hash = await store.put(new Uint8Array([9, 8, 7]));
				expect(await store.has(hash)).toBe(true);
				await corrupt(hash);
				await expectError(store.get(hash), "corrupt");
				await expectError(store.has(hash), "corrupt");
				await expectError(store.put(new Uint8Array([9, 8, 7])), "corrupt");
			});
			it("keeps stored bytes readable through a new store instance", async () => {
				const bytes = new Uint8Array([3, 1, 4]);
				const hash = await store.put(bytes);
				expect(await reopen().get(hash)).toEqual(bytes);
			});

			it("reports backend read failures as I/O errors", async () => {
				const hash = await store.put(new Uint8Array([2, 7]));
				await injectReadFailure(hash);
				await expectError(store.get(hash), "io");
				await expectError(store.has(hash), "io");
			});

			it("rejects invalid hashes and exposes admin enumeration/removal", async () => {
				await expectError(store.get("../"), "invalid_hash");
				await expectError(store.has("../"), "invalid_hash");
				const hash = await store.put(new Uint8Array([4, 5]));
				expect(await collectHashes(admin)).toEqual([hash]);
				await admin.remove(hash);
				await admin.remove(hash);
				expect(await store.get(hash)).toBeUndefined();
				expect(await collectHashes(admin)).toEqual([]);
			});
		});
	}
}

async function createNodeProvider(): Promise<StoreInstance> {
	const root = await mkdtemp(join(tmpdir(), "object-store-node-"));
	const store = createNodeObjectStore(root);
	const admin = createNodeObjectStoreAdmin(root);
	return {
		store,
		admin,
		async corrupt(hash) {
			const path = join(root, "objects", hash.slice(0, 2), hash.slice(2, 4), hash);
			await writeFile(path, new Uint8Array([0]));
		},
		async injectReadFailure(hash) {
			const path = join(root, "objects", hash.slice(0, 2), hash.slice(2, 4), hash);
			await rm(path);
			await mkdir(path);
		},
		reopen() {
			return createNodeObjectStore(root);
		},
		async teardown() {
			await rm(root, { recursive: true, force: true });
		},
	};
}

async function createOpfsProvider(): Promise<StoreInstance> {
	const diskRoot = await mkdtemp(join(tmpdir(), "object-store-opfs-"));
	const fs = new OpfsFileSystem(createMockOpfsRoot(diskRoot), "/");
	const store = createOpfsObjectStore(fs, "/save");
	const admin = createOpfsObjectStoreAdmin(fs, "/save");
	const created = await fs.createDir("/save");
	if (!created.ok) throw created.error;
	return {
		store,
		admin,
		async corrupt(hash) {
			const path = `/save/objects/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`;
			const result = await fs.writeFile(path, new Uint8Array([0]));
			if (!result.ok) throw result.error;
		},
		async injectReadFailure(hash) {
			const path = `/save/objects/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`;
			const removed = await fs.remove(path);
			if (!removed.ok) throw removed.error;
			const created = await fs.createDir(path);
			if (!created.ok) throw created.error;
		},
		reopen() {
			return createOpfsObjectStore(fs, "/save");
		},
		async teardown() {
			await rm(diskRoot, { recursive: true, force: true });
		},
	};
}

const providers: StoreProvider[] = [
	{ name: "Node fs/promises", create: createNodeProvider },
	{ name: "OPFS via filesystem mock", create: createOpfsProvider },
];

createObjectStoreConformance(providers);
