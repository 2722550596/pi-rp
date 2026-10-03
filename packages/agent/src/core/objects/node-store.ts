import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	assertObjectBytes,
	assertObjectHash,
	hashObject,
	type ObjectHash,
	type ObjectStore,
	type ObjectStoreAdmin,
	ObjectStoreError,
} from "./object-store.ts";

function objectPath(root: string, hash: ObjectHash): string {
	return join(root, "objects", hash.slice(0, 2), hash.slice(2, 4), hash);
}

function isCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function ioError(error: unknown): ObjectStoreError {
	return new ObjectStoreError("io", "Object store filesystem operation failed", error);
}

async function readExisting(path: string, hash: ObjectHash): Promise<Uint8Array | undefined> {
	try {
		const bytes = new Uint8Array(await readFile(path));
		await assertObjectBytes(hash, bytes);
		return bytes;
	} catch (error) {
		if (isCode(error, "ENOENT")) return undefined;
		if (error instanceof ObjectStoreError) throw error;
		throw ioError(error);
	}
}

export function createNodeObjectStore(root: string): ObjectStore {
	return {
		async put(data) {
			const hash = await hashObject(data);
			const path = objectPath(root, hash);
			const existing = await readExisting(path, hash);
			if (existing) return hash;
			const directory = join(root, "objects", hash.slice(0, 2), hash.slice(2, 4));
			const temporary = join(directory, `.tmp-${randomUUID()}`);
			try {
				await mkdir(directory, { recursive: true });
				await writeFile(temporary, data, { flag: "wx" });
				await rename(temporary, path);
				return hash;
			} catch (error) {
				if (isCode(error, "EEXIST") || isCode(error, "ENOTEMPTY")) {
					const winner = await readExisting(path, hash);
					if (winner) return hash;
				}
				throw ioError(error);
			} finally {
				try {
					await unlink(temporary);
				} catch (error) {
					if (!isCode(error, "ENOENT")) {
						// A failed best-effort cleanup must not replace the write/publish result.
					}
				}
			}
		},
		async get(hash) {
			assertObjectHash(hash);
			const path = objectPath(root, hash);
			let bytes: Uint8Array;
			try {
				bytes = new Uint8Array(await readFile(path));
			} catch (error) {
				if (isCode(error, "ENOENT")) return undefined;
				throw ioError(error);
			}
			await assertObjectBytes(hash, bytes);
			return bytes;
		},
		async has(hash) {
			assertObjectHash(hash);
			try {
				const bytes = new Uint8Array(await readFile(objectPath(root, hash)));
				await assertObjectBytes(hash, bytes);
				return true;
			} catch (error) {
				if (isCode(error, "ENOENT")) return false;
				if (error instanceof ObjectStoreError) throw error;
				throw ioError(error);
			}
		},
	};
}

export function createNodeObjectStoreAdmin(root: string): ObjectStoreAdmin {
	return {
		async *listAll() {
			const objects = join(root, "objects");
			let first: Dirent[];
			try {
				first = await readdir(objects, { withFileTypes: true });
			} catch (error) {
				if (isCode(error, "ENOENT")) return;
				throw ioError(error);
			}
			for (const a of first) {
				if (!a.isDirectory() || !/^[0-9a-f]{2}$/.test(a.name)) continue;
				const secondPath = join(objects, a.name);
				let second: Dirent[];
				try {
					second = await readdir(secondPath, { withFileTypes: true });
				} catch (error) {
					if (isCode(error, "ENOENT")) continue;
					throw ioError(error);
				}
				for (const b of second) {
					if (!b.isDirectory() || !/^[0-9a-f]{2}$/.test(b.name)) continue;
					const thirdPath = join(secondPath, b.name);
					let third: Dirent[];
					try {
						third = await readdir(thirdPath, { withFileTypes: true });
					} catch (error) {
						if (isCode(error, "ENOENT")) continue;
						throw ioError(error);
					}
					for (const entry of third) {
						const hash = entry.name;
						if (entry.isFile() && /^[0-9a-f]{64}$/.test(hash) && hash.startsWith(`${a.name}${b.name}`))
							yield hash;
					}
				}
			}
		},
		async remove(hash) {
			assertObjectHash(hash);
			try {
				const path = objectPath(root, hash);
				if ((await lstat(path)).isFile()) await unlink(path);
			} catch (error) {
				if (!isCode(error, "ENOENT")) throw ioError(error);
			}
		},
	};
}
