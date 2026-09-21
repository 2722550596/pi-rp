/**
 * Recall benchmark (docs §9.1): associative vs descriptive queries, legacy
 * body-cosine ordering vs the disclosure-channel RRF fusion — both through
 * the SAME production path (buildPool → computeVectorScores → rank). The
 * legacy side strips the disclosure evidence from the vector scores, which
 * makes fuseVectorViews return null and the ordering collapse back to body
 * cosine bit-for-bit; no second implementation to keep honest.
 *
 * Sections:
 *  - associative/descriptive: recall metrics (MRR, hit@k) per ordering.
 *  - precision: cross-domain probes (code, science) through the production
 *    gate (TOP_K=3, MIN_SCORE=0.35) — should inject ~nothing. Mundane
 *    same-domain chatter legitimately surfaces diary memories and is NOT a
 *    precision failure, so it is measured under distribution, not here.
 *  - distribution: fused-score bands (top1/top3) per query group — decides
 *    whether a raised MIN_SCORE can separate relevant from unrelated.
 *  - rerank (--rerank): BAAI/bge-reranker-v2-m3 over the fused top-8
 *    candidates (full body, 500 chars), target vs distractor separability
 *    plus a threshold sweep (recall kept vs cross-domain leakage).
 *
 * Usage (node >= 22.19):
 *   node --experimental-strip-types scripts/benchmark-recall.ts --db <memory.db> \
 *     [--queries scripts/fixtures/recall-benchmark-queries.json] \
 *     [--descriptive-limit 30] [--rerank] [--out <report.json>]
 */
import { parseArgs } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import {
	buildPool,
	computeVectorScores,
	type MemoryNode,
	openMemoryStore,
	rank,
	type RecalledItem,
	resolveEmbeddingsConfig,
	EmbeddingClient,
	toEpochDays,
	type VectorHit,
} from "../src/index.ts";

const { values } = parseArgs({
	args: process.argv.slice(2),
	options: {
		db: { type: "string" },
		queries: { type: "string", default: new URL("./fixtures/recall-benchmark-queries.json", import.meta.url).pathname },
		"descriptive-limit": { type: "string", default: "30" },
		rerank: { type: "boolean", default: false },
		/** Dump per-query fused top-8 candidates (for external judge studies). */
		dump: { type: "string" },
		out: { type: "string" },
	},
});

if (!values.db) {
	console.error("--db <memory.db> is required");
	process.exit(1);
}

interface FixtureSample {
	uri: string;
	query: string;
}
const fixture = JSON.parse(readFileSync(values.queries as string, "utf-8")) as { samples: FixtureSample[] };

const store = await openMemoryStore(values.db);
const client = new EmbeddingClient(resolveEmbeddingsConfig({ mode: "api" }, process.env as Record<string, string>));
if (!client.enabled) {
	console.error("embedding client is not enabled (check PI_MEMORY_EMBEDDING_API_KEY / NOCTURNE_EMBEDDING_API_KEY)");
	process.exit(1);
}

const nowDays = toEpochDays(store.getWorldTime() ?? new Date().toISOString().slice(0, 10)) ?? 0;
const pool: MemoryNode[] = buildPool(store, { queries: ["*"], topK: 1, minScore: 0, nowDays });
console.error(`pool: ${pool.length} nodes`);

// Deterministic sampling: seeded shuffle over disclosure-bearing nodes.
let seed = 20260922;
const rand = (): number => {
	seed = (seed * 1103515245 + 12345) % 2147483648;
	return seed / 2147483648;
};
const disclosureNodes = pool.filter((n) => n.disclosure !== null && n.disclosure.trim().length > 0);
for (let i = disclosureNodes.length - 1; i > 0; i--) {
	const j = Math.floor(rand() * (i + 1));
	[disclosureNodes[i], disclosureNodes[j]] = [disclosureNodes[j], disclosureNodes[i]];
}
const descriptiveLimit = Number(values["descriptive-limit"]);
const descriptiveSamples: FixtureSample[] = disclosureNodes.slice(0, descriptiveLimit).map((n) => ({
	uri: n.uri,
	query: (n.disclosure as string).trim(),
}));

/** Cross-domain lines (code, science, tooling): no arc into any RP memory. */
const PRECISION_PROBES = [
	"如何在 TypeScript 里声明一个泛型函数",
	"量子比特的相干时间一般是多少",
	"git rebase 和 merge 的区别",
	"Python 的 GIL 是什么",
	"Docker 容器端口映射怎么配",
	"微积分的链式法则再讲一遍",
	"HTTP 429 状态码什么意思",
	"数据库索引为什么用 B 树不用二叉树",
	"编译器的词法分析做什么",
	"怎么配置 SSH 免密登录",
	"线性代数的特征值有什么几何意义",
	"npm peer dependency 冲突怎么解",
	"TCP 三次握手为什么不是两次",
	"正则表达式的贪婪匹配怎么关掉",
	"CPU 缓存行一般多大",
];

/** Same-domain probes: for a diary-heavy RP store several of these carry REAL
 * anchors (elias wrote down her coffee habit — "咖啡好像喝多了" genuinely hits
 * it, rerank 0.35). They exist to prove the breaker does not gate real hits;
 * judgment of injection value lives in the precision section, not here. */
const DAILY_PROBES = [
	"今天通勤路上人好多",
	"记得把快递取了",
	"这周末想睡个懒觉",
	"刚才那首歌挺好听",
	"手机又没电了",
	"晚饭吃什么好",
	"地铁上刷到一条新闻",
	"新买的键盘手感不错",
	"窗外在下雨",
	"会议推迟到下午三点",
	"咖啡好像喝多了",
	"鞋带断了随便系了个结",
	"路边的猫不怕人",
	"电脑更新卡了十分钟",
	"明天记得多喝水",
];

const idByUri = new Map(pool.map((n) => [n.uri, n.node_id]));
const bodyById = new Map(pool.map((n) => [n.node_id, n.content]));

interface Row {
	query: string;
	uri: string;
	legacyRank: number;
	fusedRank: number;
	/** Fused ordering's post-floor scores, best first (for distribution). */
	fusedScores: number[];
}

async function fusedScoresFor(query: string): Promise<{ vecScores: Map<string, VectorHit>; items: RecalledItem[] } | null> {
	const vecScores = await computeVectorScores(store, client, pool, [query]);
	if (!vecScores) return null;
	return { vecScores, items: rank(pool, { queries: [query], topK: pool.length, minScore: 0, nowDays }, vecScores, "vector") };
}

async function runGroup(group: string, samples: FixtureSample[]): Promise<Row[]> {
	const rows: Row[] = [];
	for (const sample of samples) {
		const targetId = idByUri.get(sample.uri);
		if (!targetId) {
			console.error(`skip (target not in pool): ${sample.uri}`);
			continue;
		}
		const got = await fusedScoresFor(sample.query);
		if (!got) {
			console.error("vector channel unavailable — aborting");
			process.exit(1);
		}
		// Legacy view: strip the disclosure evidence → fuseVectorViews returns
		// null → rank orders by raw body cosine, exactly the pre-fusion path.
		const legacyScores = new Map<string, VectorHit>(
			[...got.vecScores].map(([id, hit]) => [id, { score: hit.score, segIndex: hit.segIndex }]),
		);
		const rankOf = (items: RecalledItem[]): number => {
			const idx = items.findIndex((item) => item.node_id === targetId);
			return idx === -1 ? items.length + 1 : idx + 1;
		};
		rows.push({
			query: sample.query,
			uri: sample.uri,
			legacyRank: rankOf(rank(pool, { queries: [sample.query], topK: pool.length, minScore: 0, nowDays }, legacyScores, "vector")),
			fusedRank: rankOf(got.items),
			fusedScores: got.items.map((item) => item.score),
		});
	}
	return rows;
}

function stats(values: number[]): { min: number; med: number; max: number } {
	if (values.length === 0) return { min: 0, med: 0, max: 0 };
	const sorted = [...values].sort((a, b) => a - b);
	return { min: sorted[0], med: sorted[Math.floor(sorted.length / 2)], max: sorted[sorted.length - 1] };
}
const band = (s: { min: number; med: number; max: number }): string => `${s.min.toFixed(2)}/${s.med.toFixed(2)}/${s.max.toFixed(2)}`;

const associativeRows = await runGroup("associative", fixture.samples);
const descriptiveRows = await runGroup("descriptive", descriptiveSamples);

// Candidate dump for external judge studies (--dump): per query, the fused
// top-8 with bodies — everything a judge needs to re-score the same shortlist.
if (values.dump) {
	const dump = [];
	for (const [group, samples] of [
		["associative", fixture.samples],
		["descriptive", descriptiveSamples],
		["daily", DAILY_PROBES.map((query) => ({ uri: "", query }))] as Array<[string, FixtureSample[]]>,
		["cross", PRECISION_PROBES.map((query) => ({ uri: "", query }))],
	]) {
		for (const sample of samples) {
			const got = await fusedScoresFor(sample.query);
			if (!got) continue;
			dump.push({
				group,
				query: sample.query,
				targetUri: sample.uri || null,
				candidates: got.items.slice(0, 8).map((it) => ({
					node_id: it.node_id,
					uri: it.uri,
					body: (bodyById.get(it.node_id) ?? "").slice(0, 500),
				})),
			});
		}
	}
	writeFileSync(values.dump, JSON.stringify(dump, null, 1));
	console.error(`candidates dumped: ${values.dump} (${dump.length} queries)`);
	process.exit(0);
}

// Precision: injected-item count per probe through the production gate.
async function runPrecision(probes: string[]): Promise<{ legacy: number[]; fused: number[]; top1: number[] }> {
	const legacy: number[] = [];
	const fused: number[] = [];
	const top1: number[] = [];
	for (const probe of probes) {
		const options = { queries: [probe], topK: 3, minScore: 0.35, nowDays };
		const got = await fusedScoresFor(probe);
		if (!got) continue;
		const legacyScores = new Map<string, VectorHit>(
			[...got.vecScores].map(([id, hit]) => [id, { score: hit.score, segIndex: hit.segIndex }]),
		);
		legacy.push(rank(pool, options, legacyScores, "vector").length);
		const items = rank(pool, options, got.vecScores, "vector");
		fused.push(items.length);
		top1.push(items[0]?.score ?? 0);
	}
	return { legacy, fused, top1 };
}
const precision = await runPrecision(PRECISION_PROBES);
const precisionLine = (counts: number[]): string => {
	const rate = counts.filter((c) => c > 0).length;
	const avg = counts.reduce((a, b) => a + b, 0) / Math.max(counts.length, 1);
	return `inject-rate ${((rate / Math.max(counts.length, 1)) * 100).toFixed(0)}%  avg-injected ${avg.toFixed(2)}  (n=${counts.length})`;
};

// Fused-score distribution per group — the MIN_SCORE separability picture.
function distribution(rows: Row[]): string {
	const top1 = rows.map((r) => r.fusedScores[0] ?? 0);
	const top3 = rows.map((r) => r.fusedScores.slice(0, 3));
	const best = top3.map((s) => (s.length > 0 ? Math.max(...s) : 0));
	return `top1 min/med/max ${band(stats(top1))}  best-of-top3 ${band(stats(best))}`;
}

function summarize(rows: Row[], key: "legacyRank" | "fusedRank"): string {
	const n = rows.length;
	if (n === 0) return "no rows";
	let mrr = 0;
	const hits = { 1: 0, 3: 0, 5: 0, 10: 0 };
	for (const row of rows) {
		const r = row[key];
		mrr += r <= n ? 1 / r : 0;
		for (const k of [1, 3, 5, 10] as const) if (r <= k) hits[k]++;
	}
	const pct = (c: number): string => `${((c / n) * 100).toFixed(0)}%`;
	return `MRR ${(mrr / n).toFixed(3)}  @1 ${pct(hits[1])}  @3 ${pct(hits[3])}  @5 ${pct(hits[5])}  @10 ${pct(hits[10])}  (n=${n})`;
}

console.log("=== associative (surface-disjoint queries) ===");
console.log(`legacy : ${summarize(associativeRows, "legacyRank")}`);
console.log(`fused  : ${summarize(associativeRows, "fusedRank")}`);
console.log("=== descriptive (query = the node's own disclosure) ===");
console.log(`legacy : ${summarize(descriptiveRows, "legacyRank")}`);
console.log(`fused  : ${summarize(descriptiveRows, "fusedRank")}`);
console.log("=== precision (cross-domain probes through the production gate) ===");
console.log(`legacy : ${precisionLine(precision.legacy)}`);
console.log(`fused  : ${precisionLine(precision.fused)}`);
console.log("=== fused-score distribution (MIN_SCORE separability) ===");
console.log(`assoc        ${distribution(associativeRows)}`);
console.log(`descriptive  ${distribution(descriptiveRows)}`);

const dailyScores: number[][] = [];
const crossTop1: number[] = [];
for (const probe of DAILY_PROBES) {
	const got = await fusedScoresFor(probe);
	if (got) dailyScores.push(got.items.map((item) => item.score));
}
for (const t1 of precision.top1) crossTop1.push(t1);
const dailyTop1 = dailyScores.map((s) => s[0] ?? 0);
console.log(`daily        top1 min/med/max ${band(stats(dailyTop1))}`);
console.log(`cross        top1 min/med/max ${band(stats(crossTop1))}`);

// ── rerank study ────────────────────────────────────────────────────────────
const RERANK_MODEL = "BAAI/bge-reranker-v2-m3";
async function rerank(query: string, documents: string[]): Promise<number[]> {
	const res = await fetch("https://api.siliconflow.cn/v1/rerank", {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.NOCTURNE_EMBEDDING_API_KEY}` },
		body: JSON.stringify({ model: RERANK_MODEL, query, documents }),
		signal: AbortSignal.timeout(30_000),
	});
	if (!res.ok) throw new Error(`rerank HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
	const json = (await res.json()) as { results: Array<{ index: number; relevance_score: number }> };
	const scores = new Array<number>(documents.length).fill(0);
	for (const r of json.results) scores[r.index] = r.relevance_score;
	return scores;
}

if (values.rerank) {
	// Per query: fused top-8 candidates, rerank their 500-char bodies, record
	// target score (assoc/descriptive) and the whole score list. Then sweep τ:
	// a production shape of "vec top-N → rerank → keep score≥τ, cap 3" is
	// scored on assoc hit@3 (recall kept) vs cross inject-rate (leakage).
	const TOP_N = 8;
	interface RerankRow {
		group: string;
		targetScore: number | null;
		scores: number[];
	}
	async function rerankGroup(group: string, samples: FixtureSample[]): Promise<RerankRow[]> {
		const rows: RerankRow[] = [];
		for (const sample of samples) {
			const targetId = idByUri.get(sample.uri);
			const got = await fusedScoresFor(sample.query);
			if (!targetId || !got || got.items.length === 0) continue;
			const items = got.items.slice(0, TOP_N);
			const scores = await rerank(sample.query, items.map((it) => (bodyById.get(it.node_id) ?? "").slice(0, 500)));
			const ti = items.findIndex((it) => it.node_id === targetId);
			rows.push({ group, targetScore: ti === -1 ? null : scores[ti], scores });
		}
		return rows;
	}

	console.error("reranking associative…");
	const rrAssoc = await rerankGroup("assoc", fixture.samples);
	console.error("reranking descriptive…");
	const rrDesc = await rerankGroup("descriptive", descriptiveSamples);
	console.error("reranking cross-domain…");
	const rrCross = await rerankGroup("cross", PRECISION_PROBES.map((query) => ({ uri: "", query })));
	console.error("reranking daily…");
	const rrDaily = await rerankGroup("daily", DAILY_PROBES.map((query) => ({ uri: "", query })));

	const targetMed = (rows: RerankRow[]): string => {
		const t = rows.map((r) => r.targetScore).filter((s): s is number => s !== null);
		return t.length > 0 ? `med ${stats(t).med.toFixed(3)} min ${stats(t).min.toFixed(3)} (n=${t.length})` : "no targets in top-8";
	};
	const nonTargetTop1 = (rows: RerankRow[]): number => {
		const vals = rows.flatMap((r) => (r.targetScore !== null ? [...r.scores].sort((a, b) => b - a).filter((s) => s !== r.targetScore).slice(0, 1) : []));
		return stats(vals).med;
	};
	console.log(`=== rerank (${RERANK_MODEL} over fused top-${TOP_N}, 500-char bodies) ===`);
	console.log(`assoc        target ${targetMed(rrAssoc)}  | distractor best med ${nonTargetTop1(rrAssoc).toFixed(3)}`);
	console.log(`descriptive  target ${targetMed(rrDesc)}  | distractor best med ${nonTargetTop1(rrDesc).toFixed(3)}`);
	const crossTop = rrCross.map((r) => Math.max(...r.scores, 0));
	console.log(`cross        best med ${stats(crossTop).med.toFixed(3)}  max ${stats(crossTop).max.toFixed(3)}  (expect low)`);

	// Breaker study (the shape worth shipping): skip injection iff the best
	// rerank score over the fused top-8 is below τ. Unlike a reorder+floor it
	// never reorders and never demotes targets — it only answers "is this
	// query about the memory world at all".
	console.log("breaker τ sweep: skip injection iff max(rerank top-8) < τ");
	console.log("τ      assoc    daily    cross");
	for (const tau of [0.005, 0.01, 0.02, 0.05]) {
		const rate = (rows: RerankRow[]): string => {
			const off = rows.filter((r) => Math.max(...r.scores, 0) < tau).length;
			return `${((off / Math.max(rows.length, 1)) * 100).toFixed(0)}%`;
		};
		console.log(`${tau.toFixed(3)}  ${rate(rrAssoc).padEnd(8)} ${rate(rrDaily).padEnd(8)} ${rate(rrCross)}`);
	}

	console.log("τ sweep: keep rerank≥τ as inject (cap 3)");
	console.log("τ     assoc hit@3  cross inject-rate");
	for (const tau of [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]) {
		const kept = (rows: RerankRow[]): number[][] => rows.map((r) => r.scores.filter((s) => s >= tau));
		const a = kept(rrAssoc);
		const hit3 = a.filter((s) => s.length > 0).length / Math.max(a.length, 1);
		const c = kept(rrCross);
		const leak = c.filter((s) => s.length > 0).length / Math.max(c.length, 1);
		console.log(`${tau.toFixed(1)}   ${(hit3 * 100).toFixed(0)}%         ${(leak * 100).toFixed(0)}%`);
	}
}

if (values.out) {
	writeFileSync(
		values.out,
		JSON.stringify({ associative: associativeRows, descriptive: descriptiveRows, precision }, null, 2),
	);
	console.error(`detail written: ${values.out}`);
}
