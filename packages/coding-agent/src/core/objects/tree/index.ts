import type { ObjectHash, ObjectStore } from "@earendil-works/pi-agent-core";
import type { JsonValue } from "../../../state/merge.ts";
import { canonicalJsonBytes } from "./canonical-json.ts";

export type TreeErrorCode =
	| "invalid_input"
	| "limit_exceeded"
	| "missing_object"
	| "corrupt_object"
	| "hash_mismatch"
	| "unsupported_tag"
	| "invalid_path"
	| "invalid_edit"
	| "store_io";
export class TreeError extends Error {
	readonly code: TreeErrorCode;
	constructor(code: TreeErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.code = code;
		this.name = "TreeError";
	}
}
export type TreeEdit =
	| { op: "set"; path: readonly string[]; value: JsonValue }
	| { op: "remove"; path: readonly string[] }
	| { op: "replaceRoot"; value: JsonValue };

const decoder = new TextDecoder("utf-8", { fatal: true });
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_DEPTH = 256;
const MAX_ENTRIES = 1_000_000;
const HEX_DIGITS = "0123456789abcdef";
function encodeBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
	if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
		fail("corrupt_object", "Invalid base64 chunk");
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

interface StoredBranch {
	tg: "tree.v1";
	entries: [string, ObjectHash][];
	arr?: true;
	len?: number;
}
async function sha256(bytes: Uint8Array): Promise<string> {
	const input = new DataView(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
	const digest = await globalThis.crypto.subtle.digest("SHA-256", input);
	let hash = "";
	for (const byte of new Uint8Array(digest)) hash += HEX_DIGITS[byte >> 4] + HEX_DIGITS[byte & 0x0f];
	return hash;
}
function logicalPayloadSize(value: JsonValue): number {
	return typeof value === "string" ? new TextEncoder().encode(value).byteLength : bytesFor(value).byteLength;
}
function fail(code: TreeErrorCode, message: string): never {
	throw new TreeError(code, message);
}
function compareCodePoints(left: string, right: string): number {
	let leftIndex = 0;
	let rightIndex = 0;
	while (leftIndex < left.length && rightIndex < right.length) {
		const leftPoint = left.codePointAt(leftIndex)!;
		const rightPoint = right.codePointAt(rightIndex)!;
		if (leftPoint !== rightPoint) return leftPoint - rightPoint;
		leftIndex += leftPoint > 0xffff ? 2 : 1;
		rightIndex += rightPoint > 0xffff ? 2 : 1;
	}
	return leftIndex === left.length ? (rightIndex === right.length ? 0 : -1) : 1;
}
function bytesFor(value: unknown): Uint8Array {
	try {
		return canonicalJsonBytes(value as JsonValue);
	} catch (error) {
		throw new TreeError("invalid_input", "Invalid JSON value", { cause: error });
	}
}
function parseCanonical(bytes: Uint8Array): unknown {
	let parsed: unknown;
	try {
		parsed = JSON.parse(decoder.decode(bytes));
	} catch (error) {
		throw new TreeError("corrupt_object", "Invalid UTF-8 or JSON object", { cause: error });
	}
	let canonical: Uint8Array;
	try {
		canonical = bytesFor(parsed);
	} catch (error) {
		throw new TreeError("corrupt_object", "Invalid JSON object", { cause: error });
	}
	if (canonical.byteLength !== bytes.byteLength || canonical.some((byte, index) => byte !== bytes[index]))
		fail("corrupt_object", "Object is not canonical JSON");
	return parsed;
}
function isContainer(value: JsonValue): value is JsonValue[] | Record<string, JsonValue> {
	return value !== null && typeof value === "object";
}
function validIndex(segment: string): number | undefined {
	if (!/^(0|[1-9][0-9]*)$/.test(segment)) return undefined;
	const index = Number(segment);
	return Number.isSafeInteger(index) ? index : undefined;
}

export class JsonTree {
	private readonly store: ObjectStore;
	constructor(store: ObjectStore) {
		this.store = store;
	}

	async build(value: JsonValue): Promise<{ root: ObjectHash; byteSize: number }> {
		const logical = bytesFor(value);
		if (logical.byteLength > MAX_BYTES) fail("limit_exceeded", "Logical value exceeds limit");
		const root = await this.writeValue(value, 0);
		return { root, byteSize: logical.byteLength };
	}

	async update(
		root: ObjectHash | undefined,
		edits: readonly TreeEdit[],
	): Promise<{ root: ObjectHash; byteSize: number }> {
		if (!Array.isArray(edits)) fail("invalid_edit", "Edits must be an array");
		for (const edit of edits) {
			if (edit === null || typeof edit !== "object" || !("op" in edit)) fail("invalid_edit", "Invalid edit");
			if (edit.op === "replaceRoot") bytesFor(edit.value);
			else if (
				(edit.op === "set" || edit.op === "remove") &&
				"path" in edit &&
				Array.isArray(edit.path) &&
				edit.path.every((part: unknown) => typeof part === "string")
			) {
				if (edit.op === "set" && "value" in edit) bytesFor(edit.value);
				else if (edit.op === "set") fail("invalid_edit", "Set edit is missing value");
			} else fail("invalid_edit", "Invalid edit");
		}
		if (edits.some((edit) => edit.op === "replaceRoot") && (edits.length !== 1 || edits[0].op !== "replaceRoot")) {
			fail("invalid_edit", "replaceRoot must be the only edit");
		}
		if (root === undefined) root = (await this.build({})).root;
		for (const edit of edits) {
			if (edit.op === "replaceRoot") root = await this.writeValue(edit.value, 0);
			else root = await this.updateAt(root, edit.path, edit, 0);
		}
		const value = await this.read(root);
		if (value === undefined) fail("corrupt_object", "Root resolved to no value");
		const byteSize = bytesFor(value).byteLength;
		if (byteSize > MAX_BYTES) fail("limit_exceeded", "Logical value exceeds limit");
		return { root, byteSize };
	}

	private async updateAt(
		hash: ObjectHash,
		path: readonly string[],
		edit: Exclude<TreeEdit, { op: "replaceRoot" }>,
		depth: number,
	): Promise<ObjectHash> {
		if (depth > MAX_DEPTH) fail("limit_exceeded", "Maximum tree depth exceeded");
		if (path.length === 0) {
			if (edit.op === "remove") fail("invalid_edit", "Cannot remove root");
			return this.writeValue(edit.value, depth);
		}
		const bytes = await this.getBytes(hash);
		const parsed = parseCanonical(bytes);
		if (
			parsed !== null &&
			typeof parsed === "object" &&
			!Array.isArray(parsed) &&
			"tg" in parsed &&
			parsed.tg === "ref.v1"
		) {
			if (
				Object.keys(parsed).length !== 3 ||
				!("h" in parsed) ||
				typeof parsed.h !== "string" ||
				!/^[0-9a-f]{64}$/.test(parsed.h) ||
				!("s" in parsed) ||
				!Number.isSafeInteger(parsed.s) ||
				(parsed.s as number) < 0
			)
				fail("corrupt_object", "Invalid reference");
			const updated = await this.updateAt(parsed.h, path, edit, depth + 1);
			if (updated === parsed.h) return hash;
			const value = await this.loadValue(updated, depth + 1);
			return this.put(bytesFor({ tg: "ref.v1", h: updated, s: logicalPayloadSize(value) }));
		}
		if (parsed === null || typeof parsed !== "object" || !("tg" in parsed) || parsed.tg !== "tree.v1")
			fail("invalid_path", "Intermediate path is not a container");
		if (
			Object.keys(parsed).some((key) => !["tg", "entries", "arr", "len"].includes(key)) ||
			!("entries" in parsed) ||
			!Array.isArray(parsed.entries) ||
			parsed.entries.length > MAX_ENTRIES
		)
			fail("corrupt_object", "Invalid tree node");
		const isArray = "arr" in parsed && parsed.arr === true;
		if ("arr" in parsed && parsed.arr !== true) fail("corrupt_object", "Invalid array marker");
		const length = "len" in parsed && Number.isSafeInteger(parsed.len) ? (parsed.len as number) : undefined;
		if (isArray ? length === undefined || length < 0 || length > MAX_ENTRIES : "len" in parsed)
			fail("corrupt_object", "Invalid array length");
		const entries = new Map<string, ObjectHash>();
		let previous: string | undefined;
		for (const entry of parsed.entries) {
			if (
				!Array.isArray(entry) ||
				typeof entry[0] !== "string" ||
				typeof entry[1] !== "string" ||
				!/^[0-9a-f]{64}$/.test(entry[1])
			)
				fail("corrupt_object", "Invalid tree entry");
			if (
				previous !== undefined &&
				(isArray ? Number(previous) >= Number(entry[0]) : compareCodePoints(previous, entry[0]) >= 0)
			)
				fail("corrupt_object", "Tree entries are not strictly sorted");
			if (isArray) {
				const index = validIndex(entry[0]);
				if (index === undefined || length === undefined || index >= length)
					fail("corrupt_object", "Invalid array entry index");
			}
			previous = entry[0];
			entries.set(entry[0], entry[1]);
		}
		const segment = path[0];
		if (isArray) {
			const index = validIndex(segment);
			if (index === undefined || length === undefined) fail("invalid_path", "Invalid array index");
			if (edit.op === "remove" && (index >= length || !entries.has(segment))) return hash;
			if (index > length || (index === length && path.length > 1)) fail("invalid_path", "Array index out of range");
			if (path.length === 1 && edit.op === "set" && (index === length || !entries.has(segment))) {
				entries.set(segment, await this.writeValue(edit.value, depth + 1));
				return this.writeBranch(true, index === length ? length + 1 : length, entries);
			}
		}
		const child = entries.get(segment);
		if (edit.op === "remove" && child === undefined) return hash;
		if (path.length === 1 && edit.op === "remove") {
			entries.delete(segment);
		} else if (child === undefined) {
			if (edit.op === "remove") return hash;
			if (path.length > 1 || isArray) fail("invalid_path", "Missing intermediate path");
			entries.set(segment, await this.writeValue(edit.value, depth + 1));
		} else {
			entries.set(segment, await this.updateAt(child, path.slice(1), edit, depth + 1));
		}
		return this.writeBranch(isArray, length ?? 0, entries);
	}

	private async getBytes(hash: ObjectHash): Promise<Uint8Array> {
		let bytes: Uint8Array | undefined;
		try {
			bytes = await this.store.get(hash);
		} catch (error) {
			throw new TreeError("store_io", "ObjectStore get failed", { cause: error });
		}
		if (!bytes) fail("missing_object", `Missing object ${hash}`);
		if (bytes.byteLength > MAX_BYTES) fail("limit_exceeded", "Object exceeds limit");
		if ((await sha256(bytes)) !== hash) fail("hash_mismatch", `Hash mismatch for ${hash}`);
		return bytes;
	}

	private writeBranch(isArray: boolean, length: number, entries: Map<string, ObjectHash>): Promise<ObjectHash> {
		if (entries.size > MAX_ENTRIES) fail("limit_exceeded", "Too many tree entries");
		const ordered = [...entries.entries()].sort(([left], [right]) =>
			isArray ? Number(left) - Number(right) : compareCodePoints(left, right),
		);
		const node: StoredBranch = { tg: "tree.v1", entries: ordered, ...(isArray ? { arr: true, len: length } : {}) };
		return this.put(bytesFor(node));
	}
	async read(root: ObjectHash, path: readonly string[] = []): Promise<JsonValue | undefined> {
		if (!/^[0-9a-f]{64}$/.test(root)) fail("invalid_path", "Invalid root hash");
		if (!Array.isArray(path) || !path.every((segment) => typeof segment === "string"))
			fail("invalid_path", "Path must be string segments");
		let value = await this.loadValue(root, 0);
		for (const segment of path) {
			if (!isContainer(value)) return undefined;
			if (Array.isArray(value)) {
				if (!/^(0|[1-9][0-9]*)$/.test(segment)) fail("invalid_path", `Invalid array index: ${segment}`);
				const index = Number(segment);
				if (!Number.isSafeInteger(index) || index >= value.length || !(index in value)) return undefined;
				value = value[index];
			} else {
				if (!Object.hasOwn(value, segment)) return undefined;
				value = value[segment];
			}
		}
		if (value !== undefined && bytesFor(value).byteLength > MAX_BYTES)
			fail("limit_exceeded", "Logical value exceeds limit");
		return value;
	}

	private async writeValue(value: JsonValue, depth: number): Promise<ObjectHash> {
		const logical = bytesFor(value);
		if (logical.byteLength > MAX_BYTES) fail("limit_exceeded", "Logical value exceeds limit");
		if (logical.byteLength > 64 * 1024) {
			const target =
				typeof value === "string" ? await this.writeRope(value) : await this.writeRawValue(value, depth);
			return this.put(bytesFor({ tg: "ref.v1", h: target, s: logicalPayloadSize(value) }));
		}
		return this.writeRawValue(value, depth);
	}

	private async writeRawValue(value: JsonValue, depth: number): Promise<ObjectHash> {
		if (depth > MAX_DEPTH) fail("limit_exceeded", "Maximum tree depth exceeded");
		const isArray = Array.isArray(value);
		if (isArray && value.length > MAX_ENTRIES) fail("limit_exceeded", "Array length exceeds limit");
		if (!isContainer(value)) return this.put(bytesFor(value));
		const entries: [string, ObjectHash][] = [];
		if (isArray) {
			for (let i = 0; i < value.length; i++)
				if (i in value) entries.push([String(i), await this.writeValue(value[i], depth + 1)]);
		} else {
			const keys = Object.keys(value).sort(compareCodePoints);
			for (const key of keys) entries.push([key, await this.writeValue(value[key], depth + 1)]);
		}
		if (entries.length > MAX_ENTRIES) fail("limit_exceeded", "Too many tree entries");
		return this.writeBranch(isArray, isArray ? value.length : 0, new Map(entries));
	}

	private async writeRope(value: string): Promise<ObjectHash> {
		const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
		const chunks: { h: ObjectHash; s: number; c: string }[] = [];
		let text = "";
		let byteLength = 0;
		const flush = async (): Promise<void> => {
			if (text.length === 0) return;
			const data = new TextEncoder().encode(text);
			const chunk = await this.put(bytesFor({ tg: "chunk.v1", enc: "utf8", data: encodeBase64(data) }));
			chunks.push({ h: chunk, s: data.byteLength, c: await sha256(data) });
			text = "";
			byteLength = 0;
		};
		const lines = value.match(/[^\n]*\n|[^\n]+$/g) ?? [];
		for (const line of lines) {
			const lineBytes = new TextEncoder().encode(line).byteLength;
			if (lineBytes <= 8 * 1024) {
				if (byteLength + lineBytes > 8 * 1024) await flush();
				text += line;
				byteLength += lineBytes;
				if (byteLength >= 4 * 1024) await flush();
				continue;
			}
			await flush();
			for (const grapheme of segmenter.segment(line)) {
				const part = grapheme.segment;
				const size = new TextEncoder().encode(part).byteLength;
				if (size > 8 * 1024) fail("limit_exceeded", "A grapheme exceeds rope chunk maximum");
				if (byteLength + size > 8 * 1024) await flush();
				text += part;
				byteLength += size;
				if (byteLength >= 4 * 1024) await flush();
			}
		}
		await flush();
		const manifest = { tg: "rope.v1", enc: "utf8", len: new TextEncoder().encode(value).byteLength, chunks };
		return this.put(bytesFor(manifest));
	}
	private async put(bytes: Uint8Array): Promise<ObjectHash> {
		if (bytes.byteLength > MAX_BYTES) fail("limit_exceeded", "Object exceeds limit");
		try {
			const hash = await this.store.put(bytes);
			if (hash !== (await sha256(bytes))) fail("hash_mismatch", "ObjectStore returned a mismatched hash");
			return hash;
		} catch (error) {
			if (error instanceof TreeError) throw error;
			throw new TreeError("store_io", "ObjectStore put failed", { cause: error });
		}
	}

	private async loadValue(hash: ObjectHash, depth: number): Promise<JsonValue> {
		if (depth > MAX_DEPTH) fail("limit_exceeded", "Maximum tree depth exceeded");
		const bytes = await this.getBytes(hash);
		const parsed = parseCanonical(bytes);
		if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
			const record = parsed as Record<string, unknown>;
			if (record.tg === "tree.v1") {
				if (
					Object.keys(record).some((key) => !["tg", "entries", "arr", "len"].includes(key)) ||
					!Array.isArray(record.entries) ||
					record.entries.length > MAX_ENTRIES
				)
					fail("corrupt_object", "Invalid tree node");
				const isArray = record.arr === true;
				if (record.arr !== undefined && !isArray) fail("corrupt_object", "Invalid array marker");
				if (
					isArray
						? !Number.isSafeInteger(record.len) ||
							(record.len as number) < 0 ||
							(record.len as number) > MAX_ENTRIES
						: record.len !== undefined
				)
					fail("corrupt_object", "Invalid array length");
				const output: JsonValue[] | Record<string, JsonValue> = isArray ? new Array(record.len as number) : {};
				let previous: string | undefined;
				for (const item of record.entries) {
					if (
						!Array.isArray(item) ||
						typeof item[0] !== "string" ||
						typeof item[1] !== "string" ||
						!/^[0-9a-f]{64}$/.test(item[1])
					)
						fail("corrupt_object", "Invalid tree entry");
					if (
						previous !== undefined &&
						(isArray ? Number(previous) >= Number(item[0]) : compareCodePoints(previous, item[0]) >= 0)
					)
						fail("corrupt_object", "Tree entries are not strictly sorted");
					previous = item[0];
					const resolved = await this.loadValue(item[1], depth + 1);
					if (Array.isArray(output)) {
						const index = validIndex(item[0]);
						if (index === undefined || index >= output.length)
							fail("corrupt_object", "Invalid array entry index");
						output[index] = resolved;
					} else
						Object.defineProperty(output, item[0], {
							value: resolved,
							enumerable: true,
							writable: true,
							configurable: true,
						});
				}
				return output as JsonValue;
			}
			if (record.tg === "ref.v1") {
				if (
					Object.keys(record).length !== 3 ||
					typeof record.h !== "string" ||
					!/^[0-9a-f]{64}$/.test(record.h) ||
					!Number.isSafeInteger(record.s) ||
					(record.s as number) < 0
				)
					fail("corrupt_object", "Invalid reference");
				if ((record.s as number) > MAX_BYTES) fail("limit_exceeded", "Reference exceeds logical size limit");
				const value = await this.loadValue(record.h, depth + 1);
				if (logicalPayloadSize(value) !== record.s) fail("corrupt_object", "Reference length mismatch");
				return value;
			}
			if (record.tg === "rope.v1") return this.readRope(record);
			if (typeof record.tg === "string") fail("unsupported_tag", `Unsupported object tag ${record.tg}`);
		}
		return parsed as JsonValue;
	}

	private async readRope(manifest: Record<string, unknown>): Promise<string> {
		if (
			Object.keys(manifest).some((key) => !["tg", "enc", "len", "chunks"].includes(key)) ||
			manifest.enc !== "utf8" ||
			!Number.isSafeInteger(manifest.len) ||
			(manifest.len as number) < 0 ||
			(manifest.len as number) > MAX_BYTES ||
			!Array.isArray(manifest.chunks)
		)
			fail("corrupt_object", "Invalid rope manifest");
		if (manifest.chunks.length > MAX_ENTRIES) fail("limit_exceeded", "Too many rope chunks");
		const parts: string[] = [];
		let total = 0;
		for (const chunk of manifest.chunks) {
			if (chunk === null || typeof chunk !== "object") fail("corrupt_object", "Invalid rope chunk reference");
			const item = chunk as Record<string, unknown>;
			if (
				typeof item.h !== "string" ||
				!/^[0-9a-f]{64}$/.test(item.h) ||
				!Number.isSafeInteger(item.s) ||
				(item.s as number) < 0 ||
				typeof item.c !== "string" ||
				!/^[0-9a-f]{64}$/.test(item.c)
			)
				fail("corrupt_object", "Invalid rope chunk reference");
			const bytes = await this.getBytes(item.h);
			const dataObject = parseCanonical(bytes);
			if (
				dataObject === null ||
				typeof dataObject !== "object" ||
				!("tg" in dataObject) ||
				dataObject.tg !== "chunk.v1" ||
				!("enc" in dataObject) ||
				dataObject.enc !== "utf8" ||
				!("data" in dataObject) ||
				typeof dataObject.data !== "string" ||
				Object.keys(dataObject).length !== 3
			)
				fail("unsupported_tag", "Invalid chunk tag or encoding");
			const data = decodeBase64(dataObject.data);
			if (data.byteLength > 8 * 1024) fail("limit_exceeded", "Chunk exceeds hard maximum");
			if (data.byteLength !== item.s || (await sha256(data)) !== item.c)
				fail("corrupt_object", "Chunk length or checksum mismatch");
			total += data.byteLength;
			if (total > MAX_BYTES) fail("limit_exceeded", "Rope exceeds logical size limit");
			try {
				parts.push(decoder.decode(data));
			} catch (error) {
				throw new TreeError("corrupt_object", "Chunk contains invalid UTF-8", { cause: error });
			}
		}
		if (total !== manifest.len) fail("corrupt_object", "Rope length mismatch");
		return parts.join("");
	}
}

export { canonicalJson, canonicalJsonBytes } from "./canonical-json.ts";
