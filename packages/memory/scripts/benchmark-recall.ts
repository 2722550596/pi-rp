/**
 * Recall benchmark (docs §9.1): associative vs descriptive queries, legacy
 * body-cosine ordering vs the disclosure-channel RRF fusion — both through
 * the SAME production path (buildPool → computeVectorScores → rank). The
 * legacy side strips the disclosure evidence from the vector scores, which
 * makes fuseVectorViews return null and the ordering collapse back to body
 * cosine bit-for-bit; no second implementation to keep honest.
 *
 * Associative queries come from the fixture (synthetic lines written to
 * surface a target memory through its semantic arc, not its wording).
 * Descriptive queries are generated on the fly from each sampled node's own
 * disclosure text — a fusion must not lose what the old ordering already
 * caught. Targets are addressed by URI, so the fixture stays portable across
 * databases that share a tree shape.
 *
 * Usage (bun):
 *   bun run scripts/benchmark-recall.ts --db <memory.db> \
 *     [--queries scripts/fixtures/recall-benchmark-queries.json] \
 *     [--descriptive-limit 30] [--out <report.json>]
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

// Deterministic descriptive sampling: seeded shuffle over disclosure-bearing nodes.
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

const idByUri = new Map(pool.map((n) => [n.uri, n.node_id]));

interface Row {
	group: string;
	query: string;
	uri: string;
	legacyRank: number;
	fusedRank: number;
}

async function runGroup(group: string, samples: FixtureSample[]): Promise<Row[]> {
	const rows: Row[] = [];
	for (const sample of samples) {
		const targetId = idByUri.get(sample.uri);
		if (!targetId) {
			console.error(`skip (target not in pool): ${sample.uri}`);
			continue;
		}
		const options = { queries: [sample.query], topK: pool.length, minScore: 0, nowDays };
		const vecScores = await computeVectorScores(store, client, pool, options.queries);
		if (!vecScores) {
			console.error("vector channel unavailable — aborting");
			process.exit(1);
		}
		// Legacy view: strip the disclosure evidence → fuseVectorViews returns
		// null → rank orders by raw body cosine, exactly the pre-fusion path.
		const legacyScores = new Map<string, VectorHit>(
			[...vecScores].map(([id, hit]) => [id, { score: hit.score, segIndex: hit.segIndex }]),
		);
		const rankOf = (items: RecalledItem[]): number => {
			const idx = items.findIndex((item) => item.node_id === targetId);
			return idx === -1 ? items.length + 1 : idx + 1;
		};
		rows.push({
			group,
			query: sample.query,
			uri: sample.uri,
			legacyRank: rankOf(rank(pool, options, legacyScores, "vector")),
			fusedRank: rankOf(rank(pool, options, vecScores, "vector")),
		});
	}
	return rows;
}

const associativeRows = await runGroup("associative", fixture.samples);
const descriptiveRows = await runGroup("descriptive", descriptiveSamples);

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

if (values.out) {
	writeFileSync(
		values.out,
		JSON.stringify({ associative: associativeRows, descriptive: descriptiveRows }, null, 2),
	);
	console.error(`detail written: ${values.out}`);
}
