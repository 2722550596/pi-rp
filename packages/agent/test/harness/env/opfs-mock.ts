import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
	OpfsDirectoryHandle,
	OpfsFile,
	OpfsFileHandle,
	OpfsWritableFileStream,
} from "../../../src/harness/env/opfs/types.ts";

/**
 * Filesystem-backed mock of the WHATWG OPFS handle protocol (Node has no `navigator.storage`), faithful to the
 * behaviors the OPFS implementations rely on: async handles, `createWritable` as buffered stream whose `close()` is
 * the atomic replace point (temp + rename, mirroring the spec's "write to temp, replace on close"), NotFoundError /
 * TypeMismatchError / InvalidModificationError DOMExceptions, and the non-standard `move` only when explicitly
 * enabled (it must be an own property so the `"move" in handle` probe is meaningful).
 */

function domException(name: DOMException["name"], message: string): DOMException {
	return new DOMException(message, name);
}

function bytesOf(chunks: Array<{ offset: number; bytes: Uint8Array }>, base: Uint8Array | undefined): Uint8Array {
	let length = base?.length ?? 0;
	for (const { offset, bytes } of chunks) length = Math.max(length, offset + bytes.length);
	const out = new Uint8Array(length);
	if (base) out.set(base, 0);
	for (const { offset, bytes } of chunks) out.set(bytes, offset);
	return out;
}

function toBytes(chunk: string | Uint8Array | Blob): Uint8Array {
	if (typeof chunk === "string") return new TextEncoder().encode(chunk);
	return chunk;
}

class MockWritableFileStream implements OpfsWritableFileStream {
	#chunks: Array<{ offset: number; bytes: Uint8Array }> = [];
	#cursor = 0;
	#closed = false;

	constructor(
		private readonly filePath: string,
		private readonly keepExistingData: boolean,
	) {}

	async write(chunk: string | Uint8Array | Blob): Promise<void> {
		if (this.#closed) throw domException("InvalidStateError", "writable stream is closed");
		const bytes = toBytes(chunk);
		this.#chunks.push({ offset: this.#cursor, bytes });
		this.#cursor += bytes.length;
	}

	async seek(position: number): Promise<void> {
		if (this.#closed) throw domException("InvalidStateError", "writable stream is closed");
		this.#cursor = position;
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		const base =
			this.keepExistingData && existsSync(this.filePath) ? new Uint8Array(readFileSync(this.filePath)) : undefined;
		const final = bytesOf(this.#chunks, base);
		// Atomic replace point: browsers implement createWritable as temp file + swap on close (spec §2.3.2).
		const temp = `${this.filePath}.opfs-mock-tmp`;
		writeFileSync(temp, final);
		renameSync(temp, this.filePath);
	}
}

export class MockFileHandle implements OpfsFileHandle {
	readonly kind = "file" as const;
	/** Present only when the mock is built with `withMove` — mirrors the non-standard Chromium extension. */
	move?: ((newName: string) => Promise<void>) & ((destination: OpfsDirectoryHandle, newName: string) => Promise<void>);

	constructor(
		readonly name: string,
		private readonly parentDir: string,
		withMove: boolean,
	) {
		if (withMove) {
			const move = (target: string | OpfsDirectoryHandle, maybeName?: string) => {
				const destinationDir =
					typeof target === "string" ? this.parentDir : (target as MockDirectoryHandle).diskPath;
				const newName = typeof target === "string" ? target : (maybeName as string);
				if (destinationDir !== this.parentDir && !existsSync(destinationDir)) {
					throw domException("NotFoundError", `move destination not found: ${newName}`);
				}
				renameSync(join(this.parentDir, this.name), join(destinationDir, newName));
				return Promise.resolve();
			};
			this.move = move as typeof this.move;
		}
	}

	private get diskPath(): string {
		return join(this.parentDir, this.name);
	}

	async getFile(): Promise<OpfsFile> {
		if (!existsSync(this.diskPath)) {
			throw domException("NotFoundError", `file not found: ${this.name}`);
		}
		const stats = statSync(this.diskPath);
		const bytes = new Uint8Array(readFileSync(this.diskPath));
		return {
			size: bytes.length,
			lastModified: stats.mtimeMs,
			text: () => Promise.resolve(new TextDecoder().decode(bytes)),
			arrayBuffer: () => Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
		};
	}

	async createWritable(options?: { keepExistingData?: boolean }): Promise<OpfsWritableFileStream> {
		return new MockWritableFileStream(this.diskPath, options?.keepExistingData ?? false);
	}
}

export class MockDirectoryHandle implements OpfsDirectoryHandle {
	readonly kind = "directory" as const;

	constructor(
		readonly name: string,
		readonly diskPath: string,
		private readonly withMove: boolean,
	) {}

	#getChildDiskPath(name: string): string {
		if (name.length === 0 || name.includes("/")) {
			throw new TypeError(`Invalid entry name: ${JSON.stringify(name)}`);
		}
		return join(this.diskPath, name);
	}

	async getFileHandle(name: string, options?: { create?: boolean }): Promise<OpfsFileHandle> {
		const childPath = this.#getChildDiskPath(name);
		const existsAsDirectory = existsSync(childPath) && statSync(childPath).isDirectory();
		if (existsAsDirectory) {
			throw domException("TypeMismatchError", `entry is a directory: ${name}`);
		}
		if (!existsSync(childPath)) {
			if (!options?.create) throw domException("NotFoundError", `file not found: ${name}`);
			writeFileSync(childPath, "");
		}
		return new MockFileHandle(name, this.diskPath, this.withMove);
	}

	async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<OpfsDirectoryHandle> {
		const childPath = this.#getChildDiskPath(name);
		const existsAsFile = existsSync(childPath) && statSync(childPath).isFile();
		if (existsAsFile) {
			throw domException("TypeMismatchError", `entry is a file: ${name}`);
		}
		if (!existsSync(childPath)) {
			if (!options?.create) throw domException("NotFoundError", `directory not found: ${name}`);
			mkdirSync(childPath, { recursive: true });
		}
		return new MockDirectoryHandle(name, childPath, this.withMove);
	}

	async removeEntry(name: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
		const childPath = this.#getChildDiskPath(name);
		if (!existsSync(childPath)) {
			throw domException("NotFoundError", `entry not found: ${name}`);
		}
		const isDirectory = statSync(childPath).isDirectory();
		if (isDirectory && !options?.recursive && readdirSync(childPath).length > 0) {
			throw domException("InvalidModificationError", `directory not empty: ${name}`);
		}
		rmSync(childPath, { recursive: isDirectory, force: options?.force ?? false });
	}

	async *values(): AsyncIterableIterator<OpfsFileHandle | OpfsDirectoryHandle> {
		if (!existsSync(this.diskPath)) return;
		for (const name of readdirSync(this.diskPath).sort()) {
			const childPath = join(this.diskPath, name);
			yield statSync(childPath).isDirectory()
				? new MockDirectoryHandle(name, childPath, this.withMove)
				: new MockFileHandle(name, this.diskPath, this.withMove);
		}
	}
}

/** Create a mock OPFS root over a real directory; `withMove` toggles the non-standard `move` extension. */
export function createMockOpfsRoot(rootDir: string, options?: { withMove?: boolean }): MockDirectoryHandle {
	return new MockDirectoryHandle("", rootDir, options?.withMove ?? true);
}
