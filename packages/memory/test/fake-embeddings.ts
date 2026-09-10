import { EmbeddingClient } from "../src/embeddings.ts";

/**
 * Deterministic offline embedder for tests: hashes CJK bigrams / latin words
 * into a 64-dim bag-of-tokens vector, so cosine similarity tracks real token
 * overlap without touching the network.
 */
function fakeVector(text: string): number[] {
	const dim = 64;
	const v = new Array<number>(dim).fill(0);
	const tokens: string[] = [];
	for (const w of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) tokens.push(w);
	const cjk = text.match(/[一-鿿]/g) ?? [];
	for (let i = 0; i < cjk.length - 1; i++) tokens.push(cjk[i] + cjk[i + 1]);
	for (const t of tokens) {
		let h = 0;
		for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
		v[h % dim] += 1;
	}
	return v;
}

/**
 * An EmbeddingClient wired to the fake embedder (no fetch, no API key needed).
 * `onCall` fires once per HTTP request the client would have made — used to
 * assert cache hits.
 */
export function createFakeEmbeddingClient(onCall?: () => void): EmbeddingClient {
	const fetchImpl = async (_url: string, init: RequestInit): Promise<Response> => {
		onCall?.();
		const body = JSON.parse(String(init.body)) as { input: string[] };
		return {
			ok: true,
			json: async () => ({ data: body.input.map((text) => ({ embedding: fakeVector(text) })) }),
		} as unknown as Response;
	};
	return new EmbeddingClient(
		{ mode: "api", model: "test-embed", apiUrl: "http://test.invalid/v1", apiKey: "test-key" },
		fetchImpl,
	);
}
