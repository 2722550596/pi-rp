import type { OpfsFileSystem } from "../../harness/env/opfs/file-system.ts";
import { joinVirtualPath } from "../../harness/env/opfs/virtual-path.ts";
import type { FileError, FileInfo } from "../../harness/types.ts";
import {
	assertObjectBytes,
	assertObjectHash,
	hashObject,
	type ObjectHash,
	type ObjectStore,
	type ObjectStoreAdmin,
	ObjectStoreError,
} from "./object-store.ts";

function mapFailure(error: FileError): ObjectStoreError {
	if (error.code === "not_found") return new ObjectStoreError("missing", error.message, error);
	return new ObjectStoreError("io", error.message, error);
}

function objectPath(root: string, hash: ObjectHash): string {
	return joinVirtualPath([root, "objects", hash.slice(0, 2), hash.slice(2, 4), hash]);
}

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: FileError }): T {
	if (!result.ok) throw mapFailure(result.error);
	return result.value;
}

async function readAt(files: OpfsFileSystem, path: string, hash: ObjectHash): Promise<Uint8Array | undefined> {
	try {
		const data = unwrap(await files.readBinaryFile(path));
		await assertObjectBytes(hash, data);
		return data;
	} catch (error) {
		if (error instanceof ObjectStoreError && error.code === "missing") return undefined;
		throw error instanceof ObjectStoreError ? error : new ObjectStoreError("io", "OPFS object read failed", error);
	}
}
async function listDirectory(files: OpfsFileSystem, path: string): Promise<FileInfo[]> {
	try {
		return unwrap(await files.listDir(path));
	} catch (error) {
		if (error instanceof ObjectStoreError && error.code === "missing") return [];
		throw error;
	}
}

export function createOpfsObjectStore(files: OpfsFileSystem, root: string): ObjectStore {
	return {
		async put(data) {
			const hash = await hashObject(data);
			const path = objectPath(root, hash);
			if (await readAt(files, path, hash)) return hash;
			const directory = joinVirtualPath([root, "objects", hash.slice(0, 2), hash.slice(2, 4)]);
			const temporary = joinVirtualPath([directory, `.tmp-${globalThis.crypto.randomUUID()}`]);
			try {
				unwrap(await files.createDir(directory));
				unwrap(await files.writeFile(temporary, data));
				unwrap(await files.renameFile(temporary, path));
				return hash;
			} catch (error) {
				if (error instanceof ObjectStoreError && error.code === "missing") {
					throw new ObjectStoreError("io", "OPFS object publish failed", error);
				}
				throw error instanceof ObjectStoreError
					? error
					: new ObjectStoreError("io", "OPFS object publish failed", error);
			} finally {
				const cleanup = await files.remove(temporary, { force: true });
				if (!cleanup.ok) {
					// Cleanup is best-effort and must not mask the operation result.
				}
			}
		},
		async get(hash) {
			assertObjectHash(hash);
			const data = await readAt(files, objectPath(root, hash), hash);
			return data;
		},
		async has(hash) {
			assertObjectHash(hash);
			return (await readAt(files, objectPath(root, hash), hash)) !== undefined;
		},
	};
}

export function createOpfsObjectStoreAdmin(files: OpfsFileSystem, root: string): ObjectStoreAdmin {
	return {
		async *listAll() {
			const objects = joinVirtualPath([root, "objects"]);
			const first = await listDirectory(files, objects);
			for (const a of first) {
				if (a.kind !== "directory" || !/^[0-9a-f]{2}$/.test(a.name)) continue;
				const second = await listDirectory(files, joinVirtualPath([objects, a.name]));
				for (const b of second) {
					if (b.kind !== "directory" || !/^[0-9a-f]{2}$/.test(b.name)) continue;
					const third = await listDirectory(files, joinVirtualPath([objects, a.name, b.name]));
					for (const entry of third) {
						if (
							entry.kind === "file" &&
							/^[0-9a-f]{64}$/.test(entry.name) &&
							entry.name.startsWith(`${a.name}${b.name}`)
						)
							yield entry.name;
					}
				}
			}
		},
		async remove(hash) {
			assertObjectHash(hash);
			const result = await files.remove(objectPath(root, hash), { force: true });
			if (!result.ok && result.error.code !== "not_found") throw mapFailure(result.error);
		},
	};
}
