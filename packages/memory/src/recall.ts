/**
 * Recall — the single hybrid scorer shared by injection and the retrieve tool
 * (docs/memory-system.md §9).
 *
 * Ported from the production-tuned extension
 * (~/.pi/agent/extensions/nocturne-memory-recall.ts): dual query, per-query
 * best-wins, keyword double normalization (query-precision vs
 * doc-coverage×1.4), world-clock recency tiers, and the fixed weight blend
 *
 *     score = 0.55·vector + 0.3·keyword + 0.15·importance + recency
 *
 * Weights are NOT rescaled when the vector channel is unavailable: in keyword
 * mode the ceiling is 0.3 + 0.15 + 0.08 = 0.53, deliberately below
 * HIGH_CONFIDENCE (0.55), so "高度相关，建议读取" can only be earned with real
 * semantic evidence. Thresholds (topK / minScore) are per-caller: injection
 * uses §9's TOP_K/MIN_SCORE, the explicit retrieve tool ranks without a floor.
 * Candidate selection comes from the node FTS MATCH (store.searchNodeFts):
 * keyword mode ranks ONLY FTS hits, vector mode ranks the whole visible pool.
 * Scoring is independent of that filter — every candidate gets a keyword
 * overlap score (bigram space, see tokenize.ts), which is why vector mode can
 * surface semantic hits with kw=0. Glossary terms ride into both the index and
 * the query as whole tokens, keeping proper nouns recallable without touching
 * the global jieba dictionary.
 */
import {
	chunkText,
	cosine,
	EMBED_CHUNK_OVERLAP,
	EMBED_INPUT_MAX,
	type EmbeddingClient,
	embedDocText,
	embedHash,
	QUERY_INSTRUCTION,
} from "./embeddings.ts";
import type { MemoryNode, MemoryStore } from "./store.ts";
import { tokenizeForMatch } from "./tokenize.ts";

export const W_VECTOR = 0.55;
export const W_KEYWORD = 0.3;
export const W_IMPORTANCE = 0.15;
/** doc-coverage keyword normalization alignment gain. */
export const DOC_COVERAGE_GAIN = 1.4;
export const MAX_SUMMARY_LEN = 80;
/**
 * RRF constant for fusing the two vector views (docs §9.1). Same order of
 * magnitude as T-Mem's k=30: rank differences inside the top few must move
 * the fused score, differences past ~30 must wash out.
 */
export const RRF_K = 30;
/**
 * Absolute floor for the disclosure channel and for RRF participation: a
 * node whose body AND disclosure cosine both sit below this gains nothing
 * from the fusion. RRF is relative ordering — without this gate an unrelated
 * pool's rank-1 node normalizes to vec'=1 and sails past `minScore`.
 */
export const VEC_ABS_FLOOR = 0.3;

/** World-clock recency boost tiers (days delta → boost). */
const RECENCY_TIERS: Array<{ max: number; boost: number }> = [
	{ max: 7, boost: 0.08 },
	{ max: 30, boost: 0.04 },
	{ max: 90, boost: 0.02 },
];

export type RecallMode = "vector" | "keyword";

export interface RecalledItem {
	node_id: string;
	uri: string;
	disclosure: string | null;
	summary: string;
	/**
	 * Hit-anchored excerpt (≤ EXCERPT_LEN chars) centered on what matched:
	 * vector mode uses the best-scoring chunk's original-text range, keyword
	 * mode centers on the earliest query-token hit. Falls back to `summary`
	 * when nothing locatable matched. This is what injection and the retrieve
	 * tool render — `summary` stays for the web DTO and as the fallback shape.
	 */
	excerpt: string;
	/** Full body: the injection dedup hash is version-sensitive. */
	content: string;
	score: number;
	kw: number;
	vec: number;
	/** BM25 of the node's best FTS hit (null when no FTS hit / vector-only). */
	bm25: number | null;
}

/**
 * Per-node vector evidence: the best segment score AND which chunk earned it
 * (chunkText order over embedDocText(uri, disclosure, content)). The index is
 * what lets vector-mode excerpts point at the matching passage instead of the
 * document head — segment-level cosine already picks the winner, we just used
 * to throw the position away.
 *
 * `disc` is the disclosure-channel cosine (docs §9.1): the 想起条件 line
 * embedded on its own, best across queries. Absent when the node has no
 * disclosure — rank() then keeps the legacy body-only ordering bit-for-bit.
 */
export interface VectorHit {
	score: number;
	segIndex: number;
	disc?: number;
}

export interface SearchOptions {
	/** Query[0] = retrieval intent (gets the BGE instruction); rest = context. */
	queries: string[];
	domain?: string;
	domainBlocklist?: string[];
	/** URIs already present elsewhere in the prompt (awaken slot). */
	excludeUris?: Set<string>;
	isVisible?: (node: MemoryNode) => boolean;
	topK: number;
	/** Absolute score floor. 0 disables the filter (explicit tool search). */
	minScore: number;
	/**
	 * Keyword-mode floor, independent of the vector-mode `minScore` (§27.6 /
	 * §5.9): injection uses 0.35 vector / 0.12 keyword; the explicit retrieve
	 * tool passes 0 for both. Defaults to `minScore`.
	 */
	keywordMinScore?: number;
	/** Current world-clock day, for the recency tiers. */
	nowDays: number;
	/** Keyword mode requires ≥1 query-term hit; vector mode does not. */
	requireKeywordHit?: boolean;
}

export function summarize(content: string): string {
	const flat = content.replace(/\r?\n+/g, " ").trim();
	return flat.length > MAX_SUMMARY_LEN ? `${flat.slice(0, MAX_SUMMARY_LEN)}……` : flat;
}

/** Injection/retrieve excerpt budget — matches the retrieve tool's old cap. */
export const EXCERPT_LEN = 200;

/**
 * Best-effort token hit inside `content`. Tokens come from the intent query
 * (tokenizeForMatch space: latin words lowercased + CJK bigrams), so matching
 * runs on a lowercased copy; BMP text keeps the offsets valid on the original.
 */
function firstTokenHit(content: string, tokens: string[]): { start: number; end: number } | null {
	if (tokens.length === 0 || content.length === 0) return null;
	const lower = content.toLowerCase();
	let best: { start: number; end: number } | null = null;
	for (const t of tokens) {
		if (!t) continue;
		const idx = lower.indexOf(t);
		if (idx >= 0 && (best === null || idx < best.start)) best = { start: idx, end: idx + t.length };
	}
	return best;
}

/**
 * Flatten a window into a readable excerpt, marking elisions: `……` heads a
 * window that starts mid-document, tails one that ends mid-document or was
 * clipped by the budget. Window always contains the hit range; leftover
 * budget extends left/right symmetrically, clamped to the content bounds.
 */
function windowAround(content: string, hitStart: number, hitEnd: number, maxLen: number): string {
	const hitLen = hitEnd - hitStart;
	let winStart: number;
	let winEnd: number;
	if (hitLen >= maxLen) {
		winStart = hitStart;
		winEnd = hitStart + maxLen;
	} else {
		const budget = maxLen - hitLen;
		const leftRoom = hitStart;
		const rightRoom = content.length - hitEnd;
		let left = Math.min(Math.floor(budget / 2), leftRoom);
		const right = Math.min(budget - left, rightRoom);
		left += Math.min(budget - left - right, leftRoom - left);
		winStart = hitStart - left;
		winEnd = hitEnd + right;
	}
	const flat = content.slice(winStart, winEnd).replace(/\s+/g, " ").trim();
	const clipped = flat.length > maxLen ? `${flat.slice(0, maxLen)}……` : flat;
	return `${winStart > 0 ? "……" : ""}${clipped}${winEnd < content.length ? "……" : ""}`;
}

/**
 * Map a chunkText segment index back into the node's content coordinates.
 * Vectors embed `embedDocText` output (`uri\ndisclosure\ncontent`), so the
 * content offset is the segment range minus that prefix length; step is
 * deterministic (maxLen - overlap), same math as chunkText.
 */
export function segmentRangeInDoc(
	doc: Pick<MemoryNode, "uri" | "disclosure" | "content">,
	segIndex: number,
): {
	start: number;
	end: number;
} | null {
	const prefixLen = doc.uri.length + 1 + (doc.disclosure?.length ?? 0) + 1;
	const segStart = segIndex * (EMBED_INPUT_MAX - EMBED_CHUNK_OVERLAP);
	const start = Math.min(Math.max(segStart - prefixLen, 0), doc.content.length);
	const end = Math.min(Math.max(segStart + EMBED_INPUT_MAX - prefixLen, 0), doc.content.length);
	return start < end ? { start, end } : null;
}

/**
 * Hit-anchored excerpt for an item about to be injected/rendered. Priority:
 * a token hit inside the vector chunk (word + semantic evidence agree) → the
 * chunk range itself (pure semantic hit) → earliest token hit anywhere
 * (keyword mode) → the deterministic head summary. Whichever fires, the
 * window is ≤ maxLen chars, flattened, with elisions marked.
 */
export function buildExcerpt(
	content: string,
	queryTokens: string[],
	hit?: { start: number; end: number } | null,
	maxLen = EXCERPT_LEN,
): string {
	const tokenHit = firstTokenHit(content, queryTokens);
	if (hit && tokenHit && tokenHit.start >= hit.start && tokenHit.end <= hit.end) {
		return windowAround(content, tokenHit.start, tokenHit.end, maxLen);
	}
	if (hit) {
		const start = Math.min(Math.max(hit.start, 0), content.length);
		const end = Math.min(Math.max(hit.end, 0), content.length);
		if (start < end) return windowAround(content, start, end, maxLen);
	}
	if (tokenHit) return windowAround(content, tokenHit.start, tokenHit.end, maxLen);
	return summarize(content);
}

export function toEpochDays(ts: string | null): number | null {
	if (!ts) return null;
	const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ts);
	if (!m) return null;
	return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000);
}

/**
 * Relative time calculation between target date and current world date.
 * Port of Nocturne calculate_relative_world_time.
 */
export function formatRelativeWorldTime(
	targetTs: string | null | undefined,
	currentTs: string | null | undefined,
): string {
	if (!targetTs || !currentTs) return "";
	const targetDays = toEpochDays(targetTs);
	const currentDays = toEpochDays(currentTs);
	if (targetDays == null || currentDays == null) return "";

	const diff = targetDays - currentDays;
	const absDiff = Math.abs(diff);
	const isFuture = diff > 0;

	if (absDiff === 0) return "今天";
	if (absDiff === 1) return isFuture ? "明天" : "昨天";
	if (absDiff === 2) return isFuture ? "后天" : "前天";

	let val: number;
	let unit: string;
	if (absDiff < 7) {
		val = absDiff;
		unit = "天";
	} else if (absDiff < 30) {
		val = Math.floor(absDiff / 7);
		unit = "周";
	} else if (absDiff < 365) {
		val = Math.floor(absDiff / 30);
		unit = "个月";
	} else {
		val = Math.floor(absDiff / 365);
		unit = "年";
	}

	const direction = isFuture ? "后" : "前";
	return `约 ${val} ${unit}${direction}`;
}

/** 10 = most important → 1.0; 0 = trivia → 0.0 (docs §3, v5.4 单列且大为重). */
export function importanceScore(importance: number): number {
	return Math.min(Math.max(importance, 0), 10) / 10;
}

export function recencyBoost(docTs: string | null, nowDays: number): number {
	const days = toEpochDays(docTs);
	if (days == null) return 0;
	const delta = nowDays - days;
	if (delta < 0) return RECENCY_TIERS[0].boost; // future-dated entries get the recent tier
	for (const tier of RECENCY_TIERS) {
		if (delta <= tier.max) return tier.boost;
	}
	return 0;
}

/**
 * Two complementary normalizations, max wins: query-precision (share of query
 * tokens the doc matches) and doc-coverage×1.4 (share of the doc the query
 * covers — rescues short, on-point memories). `extraTerms` carries glossary
 * keywords so proper-noun-only hits still score keyword overlap.
 */
export function keywordScore(queryTokens: string[], doc: MemoryNode, extraTerms = ""): number {
	if (queryTokens.length === 0) return 0;
	const text = `${doc.uri} ${doc.disclosure ?? ""} ${extraTerms} ${doc.content}`;
	const docTokens = tokenizeForMatch(text);
	if (docTokens.length === 0) return 0;
	const docTokenSet = new Set(docTokens);
	// ⭐ CJK 单字只进**命中判定**，不进下面的覆盖率分母（2026-09-15）。
	//   缺陷：tokenizeForMatch 对单字查询产出单字 token（其 `cjk.length === 1` 分支），
	//   文档侧却只有 bigram —— 「日」「画」这类单字查询，FTS（jieba 空间）明明选中了
	//   几十个确实含该字的候选，却全被 `requireKeywordHit` 的 `kw > 0` 过滤成 0 结果。
	//   真库实测：`日` FTS 51 候选 / 字面命中 51 / kw>0 的 0 条。
	//   ⚠️ 单字**不能**加进 `docTokenSet`：那会把分母从「bigram 数」涨成「bigram + 去重汉字数」，
	//   使所有文档的 byDoc 一起缩小 —— 实测会把 `history://manual` 挤出 topK
	//   （test/module.test.ts「hides this-session auto nodes…」因此变红）。
	//   多字查询的 token 本就是 bigram，加单字不影响其 hits → 现有排序逐位不变。
	const docMembership = new Set(docTokens);
	for (const ch of text.match(/[\u4e00-\u9fff]/g) ?? []) docMembership.add(ch);
	const querySet = new Set(queryTokens);
	let hits = 0;
	for (const t of querySet) if (docMembership.has(t)) hits++;
	let covered = 0;
	for (const t of docTokenSet) if (querySet.has(t)) covered++;
	const byQuery = hits / querySet.size;
	const byDoc = Math.min(1, (covered / docTokenSet.size) * DOC_COVERAGE_GAIN);
	return Math.max(byQuery, byDoc);
}

/** The candidate set: non-stub, not blocklisted, visible, not already shown. */
export function buildPool(store: MemoryStore, options: SearchOptions): MemoryNode[] {
	const blockSet = new Set(options.domainBlocklist ?? []);
	const byUri = new Map<string, MemoryNode>();
	for (const node of store.listNodes({ domain: options.domain })) {
		if (node.is_stub) continue;
		if (blockSet.has(node.domain)) continue;
		if (options.isVisible && !options.isVisible(node)) continue;
		if (options.excludeUris?.has(node.uri)) continue;
		if (byUri.has(node.uri)) continue;
		byUri.set(node.uri, node);
	}
	return [...byUri.values()];
}

/**
 * Injection breaker (docs §9.1): cross-encoder gate over the fused top-8.
 * Skips injection iff the BEST rerank score is below tau — the breaker asks
 * "is this query about the memory world at all", it never reorders and never
 * demotes individual targets (a reorder+floor was benchmarked to hurt
 * associative recall: target cross-encoder medians are only ~0.06 there).
 * Empty/missing scores fail OPEN — a reranker outage must not change recall
 * behavior.
 */
export function breakerShouldSkip(scores: number[] | null, tau: number): boolean {
	if (!scores || scores.length === 0) return false;
	return Math.max(...scores) < tau;
}

/**
 * Entry point for callers that already hold a filtered candidate set plus the
 * glossary terms per candidate (node_id → space-joined keywords).
 */
export function buildGlossaryTerms(store: MemoryStore, nodes: MemoryNode[]): Map<string, string> {
	const terms = new Map<string, string>();
	if (nodes.length === 0) return terms;
	for (const node of nodes) {
		const kws = store.listGlossary(node.node_id);
		if (kws.length > 0) terms.set(node.node_id, kws.map((k) => k.keyword).join(" "));
	}
	return terms;
}

/**
 * Fuse the two vector views in rank space (docs §9.1): body segments and the
 * disclosure channel each form a ranklist over the pool; per node the RRF sum
 * (1/(K+rank), summed over the lists it appears on) becomes the new `vec`
 * component after pool-max normalization. Rationale (2026-09-22 elias
 * benchmark, 30 associative queries): score-space fusion — max, gated max —
 * barely moves associative recall because a short trigger line and a long
 * body live on incomparable cosine scales; rank space is where the gain is
 * (MRR 0.395 → 0.541, top-1 hit 20% → 40%).
 *
 * Absolute guard: a node whose best view sits under VEC_ABS_FLOOR gets 0 —
 * normalization would otherwise hand an unrelated pool's rank-1 node a
 * perfect vec score and let it past `minScore`. Returns null when the pool
 * has no disclosure signal at all, in which case rank() keeps the legacy
 * body-cosine ordering bit-for-bit.
 */
export function fuseVectorViews(vecScores: Map<string, VectorHit>): Map<string, number> | null {
	const bodyIds: string[] = [];
	const discIds: Array<{ id: string; disc: number }> = [];
	for (const [id, hit] of vecScores) {
		if (hit.score > 0) bodyIds.push(id);
		if (hit.disc !== undefined && hit.disc >= VEC_ABS_FLOOR) discIds.push({ id, disc: hit.disc });
	}
	if (discIds.length === 0) return null;
	bodyIds.sort((a, b) => (vecScores.get(b)?.score ?? 0) - (vecScores.get(a)?.score ?? 0));
	discIds.sort((a, b) => b.disc - a.disc);
	const bodyRank = new Map(bodyIds.map((id, i) => [id, i + 1]));
	const discRank = new Map(discIds.map(({ id }, i) => [id, i + 1]));
	const fused = new Map<string, number>();
	let max = 0;
	for (const [id, hit] of vecScores) {
		if (Math.max(hit.score, hit.disc ?? 0) < VEC_ABS_FLOOR) {
			fused.set(id, 0);
			continue;
		}
		let s = 0;
		const br = bodyRank.get(id);
		if (br !== undefined) s += 1 / (RRF_K + br);
		const dr = discRank.get(id);
		if (dr !== undefined) s += 1 / (RRF_K + dr);
		fused.set(id, s);
		if (s > max) max = s;
	}
	if (max > 0) for (const [id, s] of fused) fused.set(id, s / max);
	return fused;
}

/** Score + sort + threshold. Pure: no I/O, vectors supplied by the caller. */
export function rank(
	pool: MemoryNode[],
	options: SearchOptions,
	vecScores: Map<string, VectorHit> | null,
	mode: RecallMode,
	bm25: Map<string, number> | null = null,
	glossaryTerms?: Map<string, string>,
): RecalledItem[] {
	const queryTokensList = options.queries.map(tokenizeForMatch);
	const intentTokens = queryTokensList[0] ?? [];
	// Disclosure-channel fusion (docs §9.1): rank-space RRF over body +
	// disclosure views; null keeps the legacy body-cosine ordering.
	const rrfVec = mode === "vector" && vecScores ? fuseVectorViews(vecScores) : null;
	const scored: RecalledItem[] = pool.map((doc) => {
		const vecHit = mode === "vector" ? vecScores?.get(doc.node_id) : undefined;
		const vec = mode === "vector" ? (rrfVec ? (rrfVec.get(doc.node_id) ?? 0) : (vecHit?.score ?? 0)) : 0;
		let kw = 0;
		const extraTerms = glossaryTerms?.get(doc.node_id) ?? "";
		for (const qTokens of queryTokensList) {
			const k = keywordScore(qTokens, doc, extraTerms);
			if (k > kw) kw = k;
		}
		const score =
			W_VECTOR * vec +
			W_KEYWORD * kw +
			W_IMPORTANCE * importanceScore(doc.importance) +
			recencyBoost(doc.world_ts, options.nowDays);
		return {
			node_id: doc.node_id,
			uri: doc.uri,
			disclosure: doc.disclosure,
			summary: summarize(doc.content),
			excerpt: buildExcerpt(doc.content, intentTokens, vecHit ? segmentRangeInDoc(doc, vecHit.segIndex) : null),
			content: doc.content,
			score,
			kw,
			vec,
			// Stored raw (FTS5 bm25() is negative; lower = better ready for
			// the deterministic ASC tiebreak, nulls last).
			bm25: bm25?.get(doc.node_id) ?? null,
		};
	});
	// Deterministic tiebreak (§27.5 v5.5): score → kw → vec → bm25 (ASC,
	// nulls last) → importance → updated_ts → uri. Never insertion order.
	const byId = new Map(pool.map((n) => [n.node_id, n]));
	scored.sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score;
		if (b.kw !== a.kw) return b.kw - a.kw;
		if (b.vec !== a.vec) return b.vec - a.vec;
		const ab = a.bm25 ?? Number.POSITIVE_INFINITY;
		const bb = b.bm25 ?? Number.POSITIVE_INFINITY;
		if (ab !== bb) return ab - bb;
		const docA = byId.get(a.node_id);
		const docB = byId.get(b.node_id);
		const impA = docA?.importance ?? 0;
		const impB = docB?.importance ?? 0;
		if (impB !== impA) return impB - impA;
		const upA = docA?.updated_ts ?? "";
		const upB = docB?.updated_ts ?? "";
		if (upB !== upA) return upB < upA ? -1 : 1;
		return a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0;
	});
	const requireHit = options.requireKeywordHit ?? mode === "keyword";
	const floor = mode === "keyword" ? (options.keywordMinScore ?? options.minScore) : options.minScore;
	return (
		scored
			.filter((s) => s.score >= floor)
			// Without a semantic signal the score can be gamed by importance and
			// recency alone — demand at least one query-term hit.
			.filter((s) => !requireHit || s.kw > 0)
			.slice(0, options.topK)
	);
}

/**
 * Vector scores for the pool: cache hit → zero API calls; misses are embedded
 * in chunks and written back. Returns null when the client is unavailable or
 * any request fails (caller falls back to keyword mode).
 */
export async function computeVectorScores(
	store: MemoryStore,
	client: EmbeddingClient | undefined,
	pool: MemoryNode[],
	queries: string[],
	signal?: AbortSignal,
): Promise<Map<string, VectorHit> | null> {
	if (!client?.enabled || pool.length === 0 || queries.length === 0) return null;
	if (signal?.aborted) return null;
	const model = client.config.model;
	const texts = new Map<string, string>();
	for (const doc of pool) texts.set(doc.node_id, embedDocText(doc.uri, doc.disclosure, doc.content));
	const wanted = pool.map((doc) => ({ node_id: doc.node_id, hash: embedHash(texts.get(doc.node_id) as string) }));
	const cached = store.loadEmbeddings(wanted, model);

	const missing = wanted.filter((w) => !cached.get(w.node_id)?.length);
	if (missing.length > 0) {
		const segsById = new Map<string, string[]>();
		for (const w of missing) segsById.set(w.node_id, chunkText(texts.get(w.node_id) as string));
		const flat = [...segsById.values()].flat();
		const vectors = await client.embed(flat, signal);
		if (!vectors) return null;
		let vi = 0;
		for (const w of missing) {
			const segs = segsById.get(w.node_id) ?? [];
			const own = vectors.slice(vi, vi + segs.length);
			vi += segs.length;
			if (own.length === 0) continue;
			try {
				store.saveEmbeddings(w.node_id, w.hash, model, own);
			} catch {
				// Cache write failed (db closed mid-flight, disk full…): the
				// vectors still score this round, they just are not persisted.
			}
			cached.set(w.node_id, own);
		}
	}
	if (signal?.aborted) return null;

	// One embed call for all queries AND the disclosure-channel misses; only
	// the intent query carries the BGE instruction — context queries are
	// declarative text, closer to the passage side, and so is a 想起条件.
	const queryInputs = queries.map((q, i) =>
		i === 0 ? `${QUERY_INSTRUCTION}${q.slice(0, 500 - QUERY_INSTRUCTION.length)}` : q.slice(0, 500),
	);
	// Disclosure channel (docs §9.1): the 想起条件 line embedded on its own,
	// cached per node keyed on the disclosure text hash — editing the body
	// must not invalidate it, and editing the disclosure must not invalidate
	// the body segments.
	const discTextById = new Map<string, string>();
	for (const doc of pool) {
		if (doc.disclosure != null && doc.disclosure.trim().length > 0) {
			discTextById.set(doc.node_id, doc.disclosure.trim());
		}
	}
	const discWanted = [...discTextById].map(([node_id, text]) => ({ node_id, hash: embedHash(text) }));
	const discVecs = store.loadDisclosureEmbeddings(discWanted, model);
	const discMissing = discWanted.filter((w) => !discVecs.get(w.node_id));
	const embedVecs = await client.embed(
		[...queryInputs, ...discMissing.map((w) => discTextById.get(w.node_id) as string)],
		signal,
	);
	if (!embedVecs || embedVecs.length !== queryInputs.length + discMissing.length) return null;
	const queryVecs = embedVecs.slice(0, queries.length);
	for (let i = 0; i < discMissing.length; i++) {
		const vec = embedVecs[queries.length + i];
		discVecs.set(discMissing[i].node_id, vec);
		try {
			store.saveDisclosureEmbedding(discMissing[i].node_id, discMissing[i].hash, model, vec);
		} catch {
			// Cache write failed (db closed mid-flight, disk full…): the channel
			// still scores this round, it just is not persisted.
		}
	}

	const scores = new Map<string, VectorHit>();
	for (const doc of pool) {
		const segs = cached.get(doc.node_id);
		if (!segs || segs.length === 0) continue;
		// Per query: segment-level cosine, best segment wins — and the winning
		// segment index rides along as the vector-mode excerpt anchor. Across
		// queries: best query wins — any view (intent or context) justifies
		// recalling.
		let best = 0;
		let bestSeg = 0;
		for (const qv of queryVecs) {
			for (let si = 0; si < segs.length; si++) {
				const sv = segs[si];
				if (!sv) continue;
				const c = cosine(qv, sv);
				if (c > best) {
					best = c;
					bestSeg = si;
				}
			}
		}
		const dv = discVecs.get(doc.node_id);
		let disc: number | undefined;
		if (dv) {
			let bestDisc = 0;
			for (const qv of queryVecs) {
				const c = cosine(qv, dv);
				if (c > bestDisc) bestDisc = c;
			}
			disc = bestDisc;
		}
		scores.set(doc.node_id, { score: best, segIndex: bestSeg, disc });
	}
	return scores;
}

/**
 * buildPool → FTS candidate filter → vectors (when available) → rank.
 * Keyword mode keeps ONLY FTS-hit candidates. Vector mode keeps the whole
 * visible pool as the semantic space and scores keyword overlap for every
 * candidate — FTS non-hits are not skipped, they simply compete on vector +
 * importance + recency (bm25 stays null for them, so the tiebreak sorts them
 * last among equals).
 */
export async function search(
	store: MemoryStore,
	client: EmbeddingClient | undefined,
	options: SearchOptions,
	signal?: AbortSignal,
): Promise<{ items: RecalledItem[]; mode: RecallMode }> {
	const pool = buildPool(store, options);
	if (pool.length === 0 || options.queries.length === 0) return { items: [], mode: "keyword" };
	const fts = store.searchNodeFts(options.queries);
	const glossaryTerms = buildGlossaryTerms(store, pool);
	if (!client?.enabled) {
		// Keyword path: only FTS hits are candidates.
		const candidates = pool.filter((n) => fts.has(n.node_id));
		if (candidates.length === 0) return { items: [], mode: "keyword" };
		return { items: rank(candidates, options, null, "keyword", fts, glossaryTerms), mode: "keyword" };
	}
	const vecScores = await computeVectorScores(store, client, pool, options.queries, signal);
	if (signal?.aborted || !vecScores) {
		const candidates = pool.filter((n) => fts.has(n.node_id));
		if (candidates.length === 0) return { items: [], mode: "keyword" };
		return { items: rank(candidates, options, null, "keyword", fts, glossaryTerms), mode: "keyword" };
	}
	// Vector path: the full pool is the semantic space; every candidate gets
	// a kw score, FTS hits additionally carry bm25 for the tiebreak.
	return { items: rank(pool, options, vecScores, "vector", fts, glossaryTerms), mode: "vector" };
}
