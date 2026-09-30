/**
 * Minimal structural surface of the OPFS handles consumed by the browser
 * operations. Declared locally (instead of lib.dom) so the module compiles
 * against every TS DOM-lib vintage; real `navigator.storage` handles satisfy
 * these structurally.
 */

export interface OpfsWritableFileStream {
	write(data: string | Uint8Array): Promise<void>;
	close(): Promise<void>;
	abort?(reason?: unknown): Promise<void>;
}

/** Minimal Blob surface used for partial reads (magic-byte sniffing). */
export interface OpfsFileBlob {
	readonly size: number;
	arrayBuffer(): Promise<ArrayBuffer>;
	slice(start?: number, end?: number): OpfsFileBlob;
}

export interface OpfsFileHandle {
	readonly kind: "file";
	readonly name: string;
	getFile(): Promise<OpfsFileBlob>;
	createWritable(options?: { keepExistingData?: boolean }): Promise<OpfsWritableFileStream>;
}

export interface OpfsDirectoryHandle {
	readonly kind: "directory";
	readonly name: string;
	getFileHandle(name: string, options?: { create?: boolean }): Promise<OpfsFileHandle>;
	getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<OpfsDirectoryHandle>;
	removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
	entries(): AsyncIterableIterator<[string, OpfsFileHandle | OpfsDirectoryHandle]>;
}

export type OpfsEntry = OpfsFileHandle | OpfsDirectoryHandle;
