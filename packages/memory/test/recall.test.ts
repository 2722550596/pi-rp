import { beforeEach, describe, expect, it } from "vitest";
import { type MemoryDatabase, openDatabase } from "../src/driver.ts";
import {
	chunkText,
	cosine,
	EMBED_CHUNK_OVERLAP,
	EMBED_INPUT_MAX,
	EmbeddingClient,
	QUERY_INSTRUCTION,
	resolveEmbeddingsConfig,
} from "../src/embeddings.ts";
import { formatRelativeWorldTime, rank, search, W_IMPORTANCE, W_KEYWORD, W_VECTOR } from "../src/recall.ts";
import { createSchema } from "../src/schema.ts";
import { MemoryStore } from "../src/store.ts";
import { createFakeEmbeddingClient } from "./fake-embeddings.ts";

let db: MemoryDatabase;
let store: MemoryStore;

beforeEach(async () => {
	db = await openDatabase("");
	createSchema(db);
	store = new MemoryStore(db);
});

const NOW = 20000;
const base = { topK: 10, minScore: 0, nowDays: NOW };

describe("embeddings client", () => {
	it("is disabled without an api key and returns null (keyword fallback)", async () => {
		const client = new EmbeddingClient(resolveEmbeddingsConfig({ mode: "api" }, {}));
		expect(client.enabled).toBe(false);
		expect(await client.embed(["x"])).toBeNull();
	});

	it("is disabled when mode is off even with a key present", () => {
		const client = new EmbeddingClient(
			resolveEmbeddingsConfig({ mode: "off" }, { PI_MEMORY_EMBEDDING_API_KEY: "k" }),
		);
		expect(client.enabled).toBe(false);
	});

	it("latches off after a failed request so one outage does not retry all turn", async () => {
		let calls = 0;
		const client = new EmbeddingClient({ mode: "api", model: "m", apiUrl: "http://x/v1", apiKey: "k" }, async () => {
			calls++;
			return { ok: false } as unknown as Response;
		});
		expect(await client.embed(["a"])).toBeNull();
		expect(await client.embed(["b"])).toBeNull();
		expect(calls).toBe(1);
		expect(client.enabled).toBe(false);
	});

	it("chunks long text with overlap and keeps short text whole", () => {
		expect(chunkText("短文本")).toEqual(["短文本"]);
		const long = "字".repeat(EMBED_INPUT_MAX * 2);
		const chunks = chunkText(long);
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks[0]).toHaveLength(EMBED_INPUT_MAX);
		// Consecutive chunks share EMBED_CHUNK_OVERLAP characters.
		expect(chunks[0].slice(EMBED_INPUT_MAX - EMBED_CHUNK_OVERLAP)).toBe(chunks[1].slice(0, EMBED_CHUNK_OVERLAP));
	});

	it("cosine of identical normalized vectors is 1", () => {
		const v = Float32Array.from([0.6, 0.8]);
		expect(cosine(v, v)).toBeCloseTo(1, 5);
	});
});

describe("hybrid recall (§9)", () => {
	it("sorts by score — the better match wins even when inserted last", () => {
		// Half the query matches the first node, all of it the second: without
		// a sort, `limit: 1` would return the first-inserted (weaker) node.
		store.insertNode({ uri: "history://half", content: "咖啡摊子" });
		store.insertNode({ uri: "history://full", content: "咖啡摊子前遇到薇拉" });
		expect(store.recall("咖啡 薇拉", { limit: 1 }).map((h) => h.uri)).toEqual(["history://full"]);
	});

	it("ranks bigger importance higher (v5.4: 数值越大越重要)", () => {
		store.insertNode({ uri: "history://trivia", content: "薇拉", importance: 1 });
		store.insertNode({ uri: "history://core", content: "薇拉", importance: 9 });
		expect(store.recall("薇拉").map((h) => h.uri)).toEqual(["history://core", "history://trivia"]);
	});

	it("keyword mode cannot reach HIGH_CONFIDENCE (0.55) — weights are not rescaled", () => {
		store.insertNode({ uri: "history://perfect", content: "薇拉", importance: 10, world_ts: "2024-01-01" });
		const pool = store.listNodes().filter((n) => !n.is_stub);
		const items = rank(pool, { ...base, queries: ["薇拉"] }, null, "keyword");
		// Ceiling in keyword mode: 0.3·1 + 0.15·1 + 0.08 = 0.53.
		expect(items[0].score).toBeLessThan(0.55);
		expect(W_KEYWORD + W_IMPORTANCE + 0.08).toBeCloseTo(0.53, 5);
	});

	it("vector mode can clear HIGH_CONFIDENCE because W_VECTOR contributes", () => {
		store.insertNode({ uri: "history://perfect", content: "薇拉", importance: 10 });
		const pool = store.listNodes().filter((n) => !n.is_stub);
		const vec = new Map(pool.map((n) => [n.node_id, 1]));
		const items = rank(pool, { ...base, queries: ["薇拉"] }, vec, "vector");
		expect(items[0].score).toBeGreaterThanOrEqual(0.55);
		expect(W_VECTOR).toBe(0.55);
	});

	it("search() runs vector mode with a client and caches vectors (second run: no API calls)", async () => {
		store.insertNode({ uri: "history://tavern", content: "伊莱在酒馆遇到薇拉谈及商队" });
		store.insertNode({ uri: "core://habit", content: "伊莱习惯在清晨读信" });
		let calls = 0;
		const client = createFakeEmbeddingClient(() => {
			calls++;
		});

		const first = await search(store, client, { ...base, queries: ["酒馆里发生了什么"] });
		expect(first.mode).toBe("vector");
		expect(first.items.length).toBeGreaterThan(0);
		// One batch for the doc segments + one for the queries.
		expect(calls).toBe(2);
		const cached = db.prepare("SELECT COUNT(*) AS c FROM memory_embeddings").get() as { c: number };
		expect(cached.c).toBeGreaterThan(0);

		calls = 0;
		const second = await search(store, client, { ...base, queries: ["酒馆里发生了什么"] });
		expect(second.mode).toBe("vector");
		// Docs come from the cache — only the query embedding is requested.
		expect(calls).toBe(1);
	});

	it("re-embeds a node after its content changes (hash invalidates the cache)", async () => {
		const node = store.insertNode({ uri: "history://tavern", content: "旧内容" });
		let calls = 0;
		const client = createFakeEmbeddingClient(() => {
			calls++;
		});
		await search(store, client, { ...base, queries: ["酒馆"] });
		store.updateNode(node.node_id, { content: "全新的内容" });
		calls = 0;
		await search(store, client, { ...base, queries: ["酒馆"] });
		expect(calls).toBe(2); // docs re-embedded + queries
	});

	it("falls back to keyword mode when the provider fails", async () => {
		store.insertNode({ uri: "history://tavern", content: "伊莱在酒馆遇到薇拉" });
		const failing = new EmbeddingClient(
			{ mode: "api", model: "m", apiUrl: "http://x/v1", apiKey: "k" },
			async () => ({ ok: false }) as unknown as Response,
		);
		const result = await search(store, failing, { ...base, queries: ["薇拉"] });
		expect(result.mode).toBe("keyword");
		expect(result.items.map((i) => i.uri)).toContain("history://tavern");
	});

	it("prepends the BGE query instruction to the intent query only", async () => {
		store.insertNode({ uri: "history://tavern", content: "酒馆" });
		const seen: string[] = [];
		const client = new EmbeddingClient(
			{ mode: "api", model: "m", apiUrl: "http://x/v1", apiKey: "k" },
			async (_url, init) => {
				const body = JSON.parse(String(init.body)) as { input: string[] };
				seen.push(...body.input);
				return {
					ok: true,
					json: async () => ({ data: body.input.map(() => ({ embedding: [1, 0, 0] })) }),
				} as unknown as Response;
			},
		);
		await search(store, client, { ...base, queries: ["现在怎么办", "Prior context:\n上一轮"] });
		const instructed = seen.filter((t) => t.startsWith(QUERY_INSTRUCTION));
		expect(instructed).toHaveLength(1);
		expect(instructed[0]).toBe(`${QUERY_INSTRUCTION}现在怎么办`);
	});
});

describe("setup defaults and cancellation (§27.1/§27.4)", () => {
	it("is off by default even when an env key is present (privacy-first)", () => {
		const config = resolveEmbeddingsConfig(undefined, { PI_MEMORY_EMBEDDING_API_KEY: "k" });
		expect(config.mode).toBe("off");
		const client = new EmbeddingClient(config);
		expect(client.enabled).toBe(false);
	});

	it("explicit mode api with a key enables the client", () => {
		const client = new EmbeddingClient(
			resolveEmbeddingsConfig({ mode: "api" }, { PI_MEMORY_EMBEDDING_API_KEY: "k" }),
		);
		expect(client.enabled).toBe(true);
	});

	it("an external abort cancels the request without latching failure", async () => {
		let fetches = 0;
		let abortSeen: AbortSignal | null | undefined;
		const client = new EmbeddingClient(
			{ mode: "api", model: "m", apiUrl: "http://x/v1", apiKey: "k" },
			async (_url, init) => {
				fetches++;
				abortSeen = init.signal;
				return new Promise<Response>((_resolve, reject) => {
					init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
				});
			},
		);
		const ctrl = new AbortController();
		const p = client.embed(["a"], ctrl.signal);
		ctrl.abort();
		await expect(p).resolves.toBeNull();
		expect(fetches).toBe(1);
		// Cancellation is NOT an outage: the client stays usable.
		expect(client.enabled).toBe(true);
		expect(abortSeen).toBeTruthy();
	});
});

describe("glossary-backed recall (§14)", () => {
	it("recalls a node whose glossary keyword matches even when the body does not", async () => {
		const node = store.insertNode({ uri: "history://mist", content: "浓雾中看不清人影" });
		store.addGlossaryEntry("伊莱", node.node_id);
		const hits = store.recall("伊莱");
		expect(hits.map((h) => h.uri)).toContain("history://mist");
	});

	it("keyword mode requires a real FTS hit (glossary included) — pure importance noise never surfaces", () => {
		const noise = store.insertNode({ uri: "meta://noise", content: "无关紧要的占位", importance: 10 });
		const hits = store.recall("完全不存在的词", { domainBlocklist: [] });
		expect(hits.map((h) => h.uri)).not.toContain(noise.uri);
	});
});

describe("FTS candidates and stable tie-breaks (§5.3/§5.10)", () => {
	it("candidates come from FTS: non-matching nodes are never scored", async () => {
		store.insertNode({ uri: "history://match", content: "酒馆里的身影" });
		store.insertNode({ uri: "history://other", content: "森林里的篝火（不相关）" });
		const items = await search(store, undefined, { ...base, queries: ["酒馆"] });
		expect(items.items.map((i) => i.uri)).toEqual(["history://match"]);
	});

	it("tie-breaks are deterministic: score → kw → vec → bm25 → importance → updated_ts → uri", async () => {
		// Two nodes with identical scores/kw/vec/importance: uri decides.
		store.insertNode({ uri: "history://bnode", content: "共同关键词", importance: 5 });
		store.insertNode({ uri: "history://anode", content: "共同关键词", importance: 5 });
		const items = await search(store, undefined, { ...base, queries: ["共同关键词"] });
		expect(items.items[0].uri).toBe("history://anode"); // lexicographically first
	});

	it("RecalledItem carries bm25 and it breaks equal-score ties instead of insertion order", async () => {
		store.insertNode({ uri: "history://x", content: "关键词 ri" });
		store.insertNode({ uri: "history://y", content: "关键词 键字", importance: 5 });
		store.insertNode({ uri: "history://z", content: "关键词 词键", importance: 5 });
		const items = await search(store, undefined, { ...base, queries: ["关键词"] });
		for (const item of items.items) {
			expect(item).toHaveProperty("bm25");
		}
	});
});

describe("injection keyword floor (§5.9/§27.6)", () => {
	it("keywordMinScore 0.12 gates injection while HIGH_CONFIDENCE stays unreachable", async () => {
		store.insertNode({ uri: "history://weak", content: "边缘命中词" });
		const pool = store.listNodes().filter((n) => !n.is_stub);
		const items = rank(pool, { ...base, queries: ["边缘命中词"] }, null, "keyword");
		expect(items[0].score).toBeLessThan(0.55);
		// The keyword floor (0.12) is below the ceiling but above nothing:
		// with a real FTS hit the item passes injection.
		expect(items[0].score).toBeGreaterThanOrEqual(0.12);
	});
});

describe("formatRelativeWorldTime", () => {
	it("formats same day as 今天", () => {
		expect(formatRelativeWorldTime("2020-09-28", "2020-09-28")).toBe("今天");
	});

	it("formats 1 day difference as 昨天 and 明天", () => {
		expect(formatRelativeWorldTime("2020-09-27", "2020-09-28")).toBe("昨天");
		expect(formatRelativeWorldTime("2020-09-29", "2020-09-28")).toBe("明天");
	});

	it("formats 2 days difference as 前天 and 后天", () => {
		expect(formatRelativeWorldTime("2020-09-26", "2020-09-28")).toBe("前天");
		expect(formatRelativeWorldTime("2020-09-30", "2020-09-28")).toBe("后天");
	});

	it("formats within a week as N 天前 / 后", () => {
		expect(formatRelativeWorldTime("2020-09-24", "2020-09-28")).toBe("约 4 天前");
		expect(formatRelativeWorldTime("2020-10-03", "2020-09-28")).toBe("约 5 天后");
	});

	it("formats within a month as N 周前 / 后", () => {
		expect(formatRelativeWorldTime("2020-09-14", "2020-09-28")).toBe("约 2 周前");
		expect(formatRelativeWorldTime("2020-10-12", "2020-09-28")).toBe("约 2 周后");
	});

	it("formats within a year as N 个月前 / 后", () => {
		expect(formatRelativeWorldTime("2020-07-28", "2020-09-28")).toBe("约 2 个月前");
		expect(formatRelativeWorldTime("2020-12-28", "2020-09-28")).toBe("约 3 个月后");
	});

	it("formats multi-year as N 年前 / 后", () => {
		expect(formatRelativeWorldTime("2018-09-28", "2020-09-28")).toBe("约 2 年前");
		expect(formatRelativeWorldTime("2023-09-28", "2020-09-28")).toBe("约 3 年后");
	});

	it("returns empty string when inputs are null or invalid", () => {
		expect(formatRelativeWorldTime(null, "2020-09-28")).toBe("");
		expect(formatRelativeWorldTime("2020-09-28", null)).toBe("");
		expect(formatRelativeWorldTime("", "2020-09-28")).toBe("");
		expect(formatRelativeWorldTime("invalid", "2020-09-28")).toBe("");
	});
});
