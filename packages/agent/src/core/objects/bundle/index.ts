import type { ObjectHash, ObjectStore } from "../object-store.ts";
import { assertObjectBytes, assertObjectHash, isObjectHash } from "../object-store.ts";

export type BundleRoot = { hash: ObjectHash; codec: string };
export type BundlePin = { id: string; scope: string; root: ObjectHash; reason?: string };
export type BundleManifest = {
	format: "pi-object-bundle";
	version: 1;
	createdAt: string;
	sessions: Array<{ sessionId: string; checkpointIds: string[]; roots: BundleRoot[] }>;
	roots: BundleRoot[];
	closure: { objectCount: number; totalBytes: number; digest: string };
	pins: BundlePin[];
};
export type ClosureRef = { hash: ObjectHash; codec?: string };
export type ClosureRoot = BundleRoot | { codec: "state-root.v1"; descriptorBytes: Uint8Array };
export type ClosureObject = { hash: ObjectHash; byteLength: number };
export type ClosureWalk = {
	objects: readonly ClosureObject[];
	objectCount: number;
	totalBytes: number;
	digest: string;
};
export interface CodecClosureVisitor {
	readonly codec: string;
	decodeAndValidate(bytes: Uint8Array): unknown;
	references(value: unknown): readonly ClosureRef[];
}
export class UnsupportedCodecError extends Error {}
export class BundleError extends Error {}
export class ClosureVisitorRegistry {
	private readonly visitors = new Map<string, CodecClosureVisitor>();
	register(visitor: CodecClosureVisitor): void {
		if (this.visitors.has(visitor.codec)) throw new BundleError(`Duplicate codec ${visitor.codec}`);
		this.visitors.set(visitor.codec, visitor);
	}
	get(codec: string): CodecClosureVisitor {
		const visitor = this.visitors.get(codec);
		if (!visitor) throw new UnsupportedCodecError(`Unsupported codec ${codec}`);
		return visitor;
	}
}
const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();
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
type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function canonicalStringify(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
	if (record(value))
		return `{${Object.keys(value)
			.sort(compareCodePoints)
			.map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`)
			.join(",")}}`;
	return JSON.stringify(value);
}
function parse(bytes: Uint8Array): unknown {
	let value: unknown;
	try {
		value = JSON.parse(decoder.decode(bytes));
	} catch (error) {
		throw new BundleError(`Invalid canonical JSON: ${String(error)}`);
	}
	const canonical = encoder.encode(canonicalStringify(value));
	if (canonical.length !== bytes.length || canonical.some((byte, index) => byte !== bytes[index]))
		throw new BundleError("Object is not canonical JSON");
	return value;
}
function requireHash(value: unknown): ObjectHash {
	if (typeof value !== "string" || !isObjectHash(value)) throw new BundleError("Invalid object reference hash");
	return value;
}
function schema(codec: string): CodecClosureVisitor {
	return {
		codec,
		decodeAndValidate(bytes) {
			const value = parse(bytes);
			if (!record(value) || value.tg !== codec) throw new BundleError(`Object tag does not match ${codec}`);
			if (codec === "tree.v1") {
				if (
					Object.keys(value).some((key) => !["tg", "entries", "arr", "len"].includes(key)) ||
					!Array.isArray(value.entries) ||
					(value.arr !== undefined && value.arr !== true) ||
					(value.arr === true
						? !Number.isSafeInteger(value.len) || (value.len as number) < 0
						: value.len !== undefined)
				)
					throw new BundleError("Invalid tree object");
				for (const entry of value.entries) {
					if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string")
						throw new BundleError("Invalid tree entry");
					requireHash(entry[1]);
				}
				return value;
			}
			if (codec === "ref.v1") {
				if (Object.keys(value).length !== 3 || !Number.isSafeInteger(value.s) || (value.s as number) < 0)
					throw new BundleError("Invalid ref object");
				requireHash(value.h);
			} else if (codec === "rope.v1") {
				if (
					Object.keys(value).some((key) => !["tg", "enc", "len", "chunks"].includes(key)) ||
					value.enc !== "utf8" ||
					!Number.isSafeInteger(value.len) ||
					(value.len as number) < 0 ||
					!Array.isArray(value.chunks)
				)
					throw new BundleError("Invalid rope object");
				for (const chunk of value.chunks) {
					if (
						!record(chunk) ||
						Object.keys(chunk).some((key) => !["h", "s", "c"].includes(key)) ||
						!Number.isSafeInteger(chunk.s) ||
						(chunk.s as number) < 0 ||
						typeof chunk.c !== "string" ||
						!isObjectHash(chunk.c)
					)
						throw new BundleError("Invalid rope chunk reference");
					requireHash(chunk.h);
				}
			} else if (codec === "chunk.v1") {
				if (Object.keys(value).length !== 3 || value.enc !== "utf8" || typeof value.data !== "string")
					throw new BundleError("Invalid chunk");
			} else if (codec === "state-root.v1") {
				if (
					Object.keys(value).length !== 4 ||
					!Number.isSafeInteger(value.rev) ||
					(value.rev as number) < 0 ||
					!Number.isSafeInteger(value.s) ||
					(value.s as number) < 0
				)
					throw new BundleError("Invalid state root");
				requireHash(value.h);
			}
			return value;
		},
		references(value) {
			if (!record(value)) throw new BundleError("Invalid codec value");
			if (codec === "tree.v1")
				return (value.entries as unknown[]).map((entry) => {
					if (!Array.isArray(entry) || entry.length !== 2) throw new BundleError("Invalid tree entry");
					return { hash: requireHash(entry[1]) };
				});
			if (codec === "ref.v1") return [{ hash: requireHash(value.h) }];
			if (codec === "rope.v1")
				return (value.chunks as unknown[]).map((chunk) => {
					if (!record(chunk)) throw new BundleError("Invalid rope chunk reference");
					return { hash: requireHash(chunk.h) };
				});
			if (codec === "state-root.v1") return [{ hash: requireHash(value.h) }];
			return [];
		},
	};
}
export function createDefaultClosureVisitorRegistry(): ClosureVisitorRegistry {
	const registry = new ClosureVisitorRegistry();
	for (const codec of ["tree.v1", "ref.v1", "rope.v1", "chunk.v1", "state-root.v1"]) registry.register(schema(codec));
	return registry;
}
const domain = encoder.encode("pi-object-bundle-closure-v1\0");
function rawHash(hash: ObjectHash): Uint8Array {
	return Uint8Array.from(hash.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
}
function u64(value: number): Uint8Array {
	const bytes = new Uint8Array(8);
	new DataView(bytes.buffer).setBigUint64(0, BigInt(value));
	return bytes;
}
async function digestClosure(objects: readonly ClosureObject[]): Promise<string> {
	const chunks: Uint8Array[] = [domain, u64(objects.length)];
	for (const object of objects) chunks.push(rawHash(object.hash), u64(object.byteLength));
	const input = new Uint8Array(chunks.reduce((sum, item) => sum + item.length, 0));
	let offset = 0;
	for (const chunk of chunks) {
		input.set(chunk, offset);
		offset += chunk.length;
	}
	const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", input));
	return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
export class CodecClosureWalker {
	private readonly registry: ClosureVisitorRegistry;
	constructor(registry: ClosureVisitorRegistry) {
		this.registry = registry;
	}
	async walk(roots: readonly ClosureRoot[], store: Pick<ObjectStore, "get">): Promise<ClosureWalk> {
		const pending: Array<{ hash: ObjectHash; codec?: string }> = [];
		for (const root of roots) {
			if ("descriptorBytes" in root) {
				const descriptor = this.registry.get("state-root.v1").decodeAndValidate(root.descriptorBytes);
				pending.push(...this.registry.get("state-root.v1").references(descriptor));
			} else {
				assertObjectHash(root.hash);
				this.registry.get(root.codec);
				pending.push(root);
			}
		}
		const visited = new Map<ObjectHash, number>();
		while (pending.length) {
			const item = pending.pop()!;
			if (visited.has(item.hash)) continue;
			const bytes = await store.get(item.hash);
			if (!bytes) throw new BundleError(`Missing object ${item.hash}`);
			await assertObjectBytes(item.hash, bytes);
			let refs: readonly ClosureRef[] = [];
			const parsed = parse(bytes);
			if (record(parsed) && typeof parsed.tg === "string") {
				const codec = item.codec ?? parsed.tg;
				const visitor = this.registry.get(codec);
				refs = visitor.references(visitor.decodeAndValidate(bytes));
			} else if (item.codec !== undefined && item.codec !== "tree.v1")
				throw new BundleError(`Root tag does not match ${item.codec}`);
			else if (item.codec !== undefined && item.codec === "tree.v1") {
				const visitor = this.registry.get(item.codec);
				refs = visitor.references(visitor.decodeAndValidate(bytes));
			}
			visited.set(item.hash, bytes.byteLength);
			for (const ref of refs) pending.push(ref);
		}
		const objects = [...visited]
			.map(([hash, byteLength]) => ({ hash, byteLength }))
			.sort((a, b) => a.hash.localeCompare(b.hash));
		const totalBytes = objects.reduce((sum, object) => sum + object.byteLength, 0);
		return { objects, objectCount: objects.length, totalBytes, digest: await digestClosure(objects) };
	}
}
export type BundleSink = { write(chunk: Uint8Array): Promise<void> };
export type BundleSource = AsyncIterable<Uint8Array>;
const block = 512;
function tarHeader(name: string, size: number): Uint8Array {
	const bytes = new Uint8Array(block);
	function text(at: number, length: number, value: string): void {
		bytes.set(encoder.encode(value).subarray(0, length), at);
	}
	function octal(at: number, length: number, value: number): void {
		text(at, length - 1, value.toString(8).padStart(length - 1, "0"));
	}
	text(0, 100, name);
	octal(100, 8, 0o644);
	octal(108, 8, 0);
	octal(116, 8, 0);
	octal(124, 12, size);
	octal(136, 12, 0);
	bytes.fill(32, 148, 156);
	bytes[156] = 48;
	text(257, 6, "ustar\0");
	text(263, 2, "00");
	let sum = 0;
	for (const byte of bytes) sum += byte;
	text(148, 7, sum.toString(8).padStart(6, "0"));
	bytes[155] = 0;
	return bytes;
}
async function writeMember(sink: BundleSink, name: string, bytes: Uint8Array): Promise<void> {
	await sink.write(tarHeader(name, bytes.length));
	await sink.write(bytes);
	const padding = (block - (bytes.length % block)) % block;
	if (padding) await sink.write(new Uint8Array(padding));
}
export async function exportBundle(input: {
	roots: BundleRoot[];
	sessions?: BundleManifest["sessions"];
	pins?: BundlePin[];
	sink: BundleSink;
	store: ObjectStore;
	registry?: ClosureVisitorRegistry;
	createdAt?: string;
}): Promise<BundleManifest> {
	const registry = input.registry ?? createDefaultClosureVisitorRegistry();
	const roots = [...input.roots].sort((a, b) => a.hash.localeCompare(b.hash));
	const walk = await new CodecClosureWalker(registry).walk(roots, input.store);
	const manifest: BundleManifest = {
		format: "pi-object-bundle",
		version: 1,
		createdAt: input.createdAt ?? new Date().toISOString(),
		sessions: input.sessions ?? [],
		roots,
		closure: { objectCount: walk.objectCount, totalBytes: walk.totalBytes, digest: walk.digest },
		pins: input.pins ?? [],
	};
	await writeMember(input.sink, "manifest.json", encoder.encode(JSON.stringify(manifest)));
	for (const { hash } of walk.objects) {
		const bytes = await input.store.get(hash);
		if (!bytes) throw new BundleError(`Missing object ${hash}`);
		await assertObjectBytes(hash, bytes);
		await writeMember(input.sink, `objects/${hash}`, bytes);
	}
	await input.sink.write(new Uint8Array(block * 2));
	return manifest;
}
export async function importBundle(input: {
	source: BundleSource;
	objectStore: ObjectStore;
	registry?: ClosureVisitorRegistry;
	createImportPin?: (id: string, roots: readonly BundleRoot[]) => Promise<void>;
	releaseImportPin?: (id: string) => Promise<void>;
	signal?: AbortSignal;
}): Promise<{ importId: string; manifest: BundleManifest; roots: BundleRoot[] }> {
	const parts: Uint8Array[] = [];
	let length = 0;
	for await (const part of input.source) {
		if (input.signal?.aborted) throw input.signal.reason;
		parts.push(part);
		length += part.length;
	}
	const archive = new Uint8Array(length);
	let cursor = 0;
	for (const part of parts) {
		archive.set(part, cursor);
		cursor += part.length;
	}
	let offset = 0;
	function member(): { name: string; size: number; bytes: Uint8Array } | undefined {
		if (offset + block > archive.length) throw new BundleError("Truncated tar header");
		const header = archive.subarray(offset, offset + block);
		offset += block;
		if (header.every((byte) => byte === 0)) return undefined;
		if (decoder.decode(header.subarray(257, 263)) !== "ustar\0" || header[156] !== 48)
			throw new BundleError("Invalid tar header");
		const name = decoder.decode(header.subarray(0, 100)).replace(/\0.*$/, "");
		const sizeText = decoder.decode(header.subarray(124, 136)).replace(/\0.*$/, "").trim();
		const size = Number.parseInt(sizeText, 8);
		if (!Number.isSafeInteger(size) || size < 0 || offset + size > archive.length)
			throw new BundleError("Invalid or truncated tar member");
		const bytes = archive.slice(offset, offset + size);
		offset += size + ((block - (size % block)) % block);
		return { name, size, bytes };
	}
	const first = member();
	if (!first || first.name !== "manifest.json") throw new BundleError("Manifest must be first tar member");
	const manifest = JSON.parse(decoder.decode(first.bytes)) as BundleManifest;
	if (
		manifest.format !== "pi-object-bundle" ||
		manifest.version !== 1 ||
		!Array.isArray(manifest.roots) ||
		!manifest.closure
	)
		throw new BundleError("Unsupported or invalid manifest");
	const staged = new Map<ObjectHash, Uint8Array>();
	let previous = "";
	while (true) {
		const item = member();
		if (!item) break;
		const match = /^objects\/([0-9a-f]{64})$/.exec(item.name);
		if (!match || match[1] <= previous || item.size !== item.bytes.length)
			throw new BundleError("Invalid object member sequence");
		previous = match[1];
		await assertObjectBytes(match[1], item.bytes);
		staged.set(match[1], item.bytes);
	}
	const registry = input.registry ?? createDefaultClosureVisitorRegistry();
	const stagingStore: ObjectStore = {
		async get(hash) {
			return staged.get(hash);
		},
		async has(hash) {
			return staged.has(hash);
		},
		async put() {
			throw new BundleError("Staging store is read-only");
		},
	};
	const walk = await new CodecClosureWalker(registry).walk(manifest.roots, stagingStore);
	if (
		walk.objectCount !== manifest.closure.objectCount ||
		walk.totalBytes !== manifest.closure.totalBytes ||
		walk.digest !== manifest.closure.digest ||
		staged.size !== walk.objectCount
	)
		throw new BundleError("Bundle closure mismatch");
	for (const hash of staged.keys())
		if (!walk.objects.some((object) => object.hash === hash)) throw new BundleError("Bundle has an extra object");
	const importId = globalThis.crypto.randomUUID();
	await input.createImportPin?.(importId, manifest.roots);
	try {
		for (const { hash } of walk.objects) {
			if (input.signal?.aborted) throw input.signal.reason;
			const actual = await input.objectStore.put(staged.get(hash)!);
			if (actual !== hash) throw new BundleError(`ObjectStore returned mismatched hash for ${hash}`);
		}
	} catch (error) {
		await input.releaseImportPin?.(importId);
		throw error;
	}
	return { importId, manifest, roots: manifest.roots };
}
export async function releaseImportPin(importId: string, release: (id: string) => Promise<void>): Promise<void> {
	await release(importId);
}
