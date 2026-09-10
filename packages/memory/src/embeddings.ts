/**
 * Embeddings — the vector half of hybrid recall (docs/memory-system.md §9/§12).
 *
 * API mode only, per §12: a zero-dependency fetch client against an
 * OpenAI-shaped `/embeddings` endpoint (default siliconflow BGE), plus the
 * vector cache stored in `memory_embeddings`. `mode: "off"` — or a missing
 * API key, or any request failure — degrades recall to pure FTS/keyword
 * scoring; the memory system never blocks on the embedding provider.
 *
 * The API key comes from the environment, never from settings.
 */
import { createHash } from "node:crypto";
import type { MemorySettings } from "./config.ts";

export const DEFAULT_EMBEDDING_MODEL = "BAAI/bge-large-zh-v1.5";
export const DEFAULT_EMBEDDING_API_URL = "https://api.siliconflow.cn/v1";

/**
 * Official query instruction for bge-*-zh-v1.5 retrieval (BAAI README):
 * prepend to SHORT QUERIES only, never to passages/documents.
 */
export const QUERY_INSTRUCTION = "为这个句子生成表示以用于检索相关文章：";

/**
 * BAAI/bge-large-zh-v1.5 max sequence is 512 tokens; ~1 zh char per token.
 * Long memories are chunked with this overlap so sentence-level semantics
 * survive segment boundaries (§9: chunk 500 / overlap 80).
 */
export const EMBED_INPUT_MAX = 500;
export const EMBED_CHUNK_OVERLAP = 80;

/** siliconflow accepts at most 32 inputs per request. */
const EMBED_BATCH = 32;
/** Fixed 10s deadline per request (§27.1 — no prompt stalls for minutes). */
const EMBED_TIMEOUT_MS = 10_000;

/** Environment variables searched for the API key, in order. */
const API_KEY_ENV = ["PI_MEMORY_EMBEDDING_API_KEY", "NOCTURNE_EMBEDDING_API_KEY"];

export interface EmbeddingsConfig {
	mode: "api" | "off";
	model: string;
	apiUrl: string;
	apiKey: string;
}

/** settings.memory.embeddings + env key → an effective config. */
export function resolveEmbeddingsConfig(
	settings: MemorySettings["embeddings"] | undefined,
	env: Record<string, string | undefined> = process.env,
): EmbeddingsConfig {
	let apiKey = "";
	for (const name of API_KEY_ENV) {
		const value = env[name];
		if (value) {
			apiKey = value;
			break;
		}
	}
	// Privacy-first default (§27.1): WITHOUT explicit `mode: "api"` the memory
	// system never leaves the machine, even when a key sits in the env. Only a
	// deliberate opt-in reads the key and dials out.
	const mode = settings?.mode ?? "off";
	return {
		mode: mode === "api" ? "api" : "off",
		model: settings?.model ?? DEFAULT_EMBEDDING_MODEL,
		apiUrl: (settings?.apiUrl ?? DEFAULT_EMBEDDING_API_URL).replace(/\/$/, ""),
		apiKey,
	};
}

/**
 * Chunk text into overlapping segments. Returns `[""]` for empty input so
 * callers always get at least one segment.
 */
export function chunkText(text: string, maxLen = EMBED_INPUT_MAX, overlap = EMBED_CHUNK_OVERLAP): string[] {
	if (text.length === 0) return [""];
	if (text.length <= maxLen) return [text];
	const chunks: string[] = [];
	const step = Math.max(1, maxLen - overlap);
	for (let start = 0; start < text.length; start += step) {
		chunks.push(text.slice(start, start + maxLen));
	}
	return chunks;
}

/** Cosine similarity of two L2-normalized vectors (dot product). */
export function cosine(a: Float32Array, b: Float32Array): number {
	const len = Math.min(a.length, b.length);
	let dot = 0;
	for (let i = 0; i < len; i++) dot += a[i] * b[i];
	return dot;
}

/** md5 of the exact text that was embedded — the cache validity key. */
export function embedHash(text: string): string {
	return createHash("md5").update(text, "utf-8").digest("hex");
}

/** The document text fed to the embedder (uri + 想起条件 + 正文). */
export function embedDocText(uri: string, disclosure: string | null, content: string): string {
	return `${uri}\n${disclosure ?? ""}\n${content}`;
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/**
 * Embedding API client. `embed()` returns null on any failure (no key, HTTP
 * error, malformed body, timeout) — callers treat null as "keyword mode".
 */
export class EmbeddingClient {
	readonly config: EmbeddingsConfig;
	private readonly fetchImpl: FetchLike;
	/** Sticky failure latch: one failed call disables the client for this session. */
	private failed = false;

	constructor(config: EmbeddingsConfig, fetchImpl: FetchLike = fetch as unknown as FetchLike) {
		this.config = config;
		this.fetchImpl = fetchImpl;
	}

	get enabled(): boolean {
		return this.config.mode === "api" && this.config.apiKey.length > 0 && !this.failed;
	}

	/**
	 * Embed texts in batches. Returns null on any FAILURE (no key, HTTP
	 * error, malformed body, timeout) — callers treat null as "keyword mode".
	 * An external `signal` abort (session dispose, superseded recall) does NOT
	 * trip the sticky failure latch: it is cancellation, not an outage, and
	 * the next recall may legitimately retry. Timeout is fixed at 10s.
	 */
	async embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[] | null> {
		if (texts.length === 0) return [];
		if (!this.enabled) return null;
		if (signal?.aborted) return null;
		const vectors: Float32Array[] = [];
		for (let i = 0; i < texts.length; i += EMBED_BATCH) {
			const batch = texts.slice(i, i + EMBED_BATCH);
			try {
				const res = await this.fetchImpl(`${this.config.apiUrl}/embeddings`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${this.config.apiKey}`,
					},
					body: JSON.stringify({ model: this.config.model, input: batch }),
					signal: signal
						? AbortSignal.any([signal, AbortSignal.timeout(EMBED_TIMEOUT_MS)])
						: AbortSignal.timeout(EMBED_TIMEOUT_MS),
				});
				if (signal?.aborted) return null;
				if (!res.ok) {
					this.failed = true;
					return null;
				}
				const json = (await res.json()) as { data?: Array<{ embedding: number[] }> };
				if (!json?.data || json.data.length !== batch.length) {
					this.failed = true;
					return null;
				}
				for (const item of json.data) vectors.push(normalize(new Float32Array(item.embedding)));
			} catch {
				if (signal?.aborted) return null;
				this.failed = true;
				return null;
			}
		}
		return vectors;
	}
}

function normalize(v: Float32Array): Float32Array {
	let norm = 0;
	for (const x of v) norm += x * x;
	norm = Math.sqrt(norm);
	if (norm > 0) for (let i = 0; i < v.length; i++) v[i] /= norm;
	return v;
}
