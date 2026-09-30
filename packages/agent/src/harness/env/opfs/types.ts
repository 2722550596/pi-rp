/**
 * Structural subsets of the WHATWG File System Standard handle surfaces, declared locally because pi-agent-core must
 * stay free of DOM lib dependencies (browser-smoke constraint). Real browser handles satisfy these shapes
 * structurally; the OPFS tests run them against a filesystem-backed mock of the same protocol.
 *
 * Only the members the OPFS implementations consume are declared — no `any` leaks, no DOM lib.
 */

/** Minimal view of a `File` as returned by `FileSystemFileHandle.getFile()`. */
export interface OpfsFile {
	readonly size: number;
	readonly lastModified: number;
	text(): Promise<string>;
	arrayBuffer(): Promise<ArrayBuffer>;
}

/** Minimal view of `FileSystemWritableFileStream`. */
export interface OpfsWritableFileStream {
	write(chunk: string | Uint8Array | Blob): Promise<void>;
	/** Position the next write; used to append with `keepExistingData` without re-reading the file. */
	seek(position: number): Promise<void>;
	close(): Promise<void>;
}

/** Minimal view of `FileSystemSyncAccessHandle` (worker/Node-only; never required by the async face). */
export interface OpfsSyncAccessHandle {
	read(buffer: Uint8Array, options?: { at?: number }): number;
	write(buffer: Uint8Array, options?: { at?: number }): number;
	truncate(size: number): void;
	getSize(): number;
	flush(): void;
	close(): void;
}

/** Structural `FileSystemFileHandle`. */
export interface OpfsFileHandle {
	readonly kind: "file";
	readonly name: string;
	getFile(): Promise<OpfsFile>;
	createWritable(options?: { keepExistingData?: boolean }): Promise<OpfsWritableFileStream>;
	/**
	 * Non-standard Chromium extension (`FileSystemFileHandle.move`, Chrome 102+): rename within the OPFS, replacing an
	 * existing destination. Probed with `"move" in handle` — never assumed (the WHATWG standard has no rename/move).
	 */
	move?(newName: string): Promise<void>;
	move?(destination: OpfsDirectoryHandle, newName: string): Promise<void>;
}

/** Structural `FileSystemDirectoryHandle`. */
export interface OpfsDirectoryHandle {
	readonly kind: "directory";
	readonly name: string;
	getFileHandle(name: string, options?: { create?: boolean }): Promise<OpfsFileHandle>;
	getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<OpfsDirectoryHandle>;
	removeEntry(name: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
	values(): AsyncIterableIterator<OpfsFileHandle | OpfsDirectoryHandle>;
}

/** Error codes of the harness `FileError`, duplicated structurally to avoid an import cycle. */
export type OpfsFileErrorCode =
	| "aborted"
	| "not_found"
	| "permission_denied"
	| "not_directory"
	| "is_directory"
	| "invalid"
	| "not_supported"
	| "unknown";

/**
 * Map a DOMException from the File System Standard onto the backend-independent FileErrorCode, per the frozen
 * mapping table (11-B §7.2): NotFoundError → not_found, TypeMismatchError → not_directory/is_directory by probe
 * direction, NoModificationAllowedError/NotAllowedError/SecurityError → permission_denied,
 * InvalidStateError/NotSupportedError → not_supported, TypeError/InvalidModificationError → invalid,
 * QuotaExceededError → unknown (matching the node ENOSPC landing point).
 */
export function opfsErrorCode(error: unknown): OpfsFileErrorCode {
	const name =
		typeof error === "object" && error !== null && "name" in error ? String((error as { name: unknown }).name) : "";
	switch (name) {
		case "NotFoundError":
			return "not_found";
		case "NotAllowedError":
		case "SecurityError":
		case "NoModificationAllowedError":
			return "permission_denied";
		case "InvalidStateError":
		case "NotSupportedError":
			return "not_supported";
		case "TypeError":
		case "InvalidModificationError":
			return "invalid";
		default:
			return "unknown";
	}
}
