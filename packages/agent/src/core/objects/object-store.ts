export type ObjectHash = string;

export interface ObjectStore {
	put(data: Uint8Array): Promise<ObjectHash>;
	get(hash: ObjectHash): Promise<Uint8Array | undefined>;
	has(hash: ObjectHash): Promise<boolean>;
}

/** Internal capability for object-store maintenance; do not pass to ordinary consumers. */
export interface ObjectStoreAdmin {
	listAll(): AsyncIterable<ObjectHash>;
	remove(hash: ObjectHash): Promise<void>;
}

export type ObjectStoreErrorCode = "missing" | "corrupt" | "io" | "invalid_hash";

export class ObjectStoreError extends Error {
	readonly code: ObjectStoreErrorCode;

	constructor(code: ObjectStoreErrorCode, message: string, cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "ObjectStoreError";
		this.code = code;
	}
}

export function isObjectHash(value: string): boolean {
	return /^[0-9a-f]{64}$/.test(value);
}

export function assertObjectHash(hash: string): asserts hash is ObjectHash {
	if (!isObjectHash(hash)) throw new ObjectStoreError("invalid_hash", `Invalid object hash: ${hash}`);
}

const HEX_DIGITS = "0123456789abcdef";

export async function hashObject(data: Uint8Array): Promise<ObjectHash> {
	// 运行时 digest 接受任意 ArrayBufferLike 视图；此处仅收窄 TS 泛型（不含 SharedArrayBuffer 的调用方不受影响）。
	const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>));
	let hash = "";
	for (const byte of digest) hash += HEX_DIGITS[byte >> 4] + HEX_DIGITS[byte & 0x0f];
	return hash;
}

export async function assertObjectBytes(hash: ObjectHash, data: Uint8Array): Promise<void> {
	if ((await hashObject(data)) !== hash) {
		throw new ObjectStoreError("corrupt", `Object content does not match address ${hash}`);
	}
}
