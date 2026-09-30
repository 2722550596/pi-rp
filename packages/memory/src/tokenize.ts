/**
 * Two token spaces, deliberately (docs/memory-system.md §3/§15.2).
 *
 * - tokenizeForSearch() — the FTS space: Intl.Segmenter("zh", word)
 *   segmentation (2026-09-30 拍板: ONE tokenizer for all profiles — node,
 *   browser and hosted share this implementation and the same ICU/CLDR data,
 *   so token sequences are bit-identical everywhere; the former native jieba
 *   dependency is gone). One segmenter is built once (module-level singleton)
 *   and used by BOTH the FTS write side (reindexNode / _reindexRawFts) and the
 *   FTS query side (searchNodeFts), so indexed rows and MATCH queries never
 *   live in two token spaces. The database records its token space in
 *   `memory_kv.fts_tokenizer` (value "segmenter"); MemoryStore's constructor
 *   migration gate DROPs and fully re-backfills the FTS tables of databases
 *   whose key predates this (or is missing).
 * - tokenizeForMatch() — the scoring space: latin words + CJK bigrams, used by
 *   keywordScore() to measure query/doc overlap for candidates the FTS filter
 *   already selected.
 *
 * The split is intentional: candidate SELECTION is an FTS MATCH (segmenter
 * space), candidate SCORING is a cheap bigram overlap (no segmentation per doc
 * per query). Keep it that way — do not "unify" scoring onto the segmenter
 * without also measuring the per-recall cost.
 */

/** Query-side tokenizer: CJK bigrams + latin words (scoring space). */
export function tokenizeForMatch(text: string): string[] {
	const tokens = new Set<string>();
	const latin = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
	for (const w of latin) tokens.add(w);
	const cjk = text.match(/[\u4e00-\u9fff]/g) ?? [];
	for (let i = 0; i < cjk.length - 1; i++) tokens.add(cjk[i] + cjk[i + 1]);
	if (cjk.length === 1) tokens.add(cjk[0]);
	return [...tokens];
}

/** The only `memory_kv.fts_tokenizer` value, past and future (拍板: single value). */
export type MemoryTokenizerSpace = "segmenter";

/**
 * The FTS tokenizer as an injectable object. The interface exists purely so
 * tests can stub segmentation — there is exactly one implementation for every
 * runtime profile, hence a zero-argument factory (no profile names, no kind
 * unions).
 */
export interface MemoryTokenizer {
	readonly space: "segmenter";
	/** FTS space (write side AND query side share one instance). */
	tokenizeForSearch(text: string): string;
}

function createSegmenter(): Intl.Segmenter {
	try {
		return new Intl.Segmenter("zh", { granularity: "word" });
	} catch (error) {
		// No silent fallback (I6 非静默): a runtime without ICU word segmentation
		// must fail loudly instead of quietly degrading the token space. Node
		// official builds ship full-icu by default (this package requires
		// >= 22.19); Chrome 87+ / Safari 14.1+ / Firefox 125+ have it built in.
		throw new Error(
			`Intl.Segmenter("zh") is unavailable in this runtime (${String(error)}). ` +
				"The memory tokenizer requires ICU word segmentation: use a Node build with full-icu " +
				"(official builds, node >= 13) or a browser from Chrome 87+ / Safari 14.1+ / Firefox 125+.",
		);
	}
}

export function createMemoryTokenizer(): MemoryTokenizer {
	const segmenter = createSegmenter();
	return {
		space: "segmenter",
		tokenizeForSearch(text: string): string {
			if (text.length === 0) return "";
			const tokens: string[] = [];
			for (const { segment, isWordLike } of segmenter.segment(text)) {
				if (isWordLike) tokens.push(segment);
			}
			return tokens.join(" ");
		},
	};
}

let sharedTokenizer: MemoryTokenizer | undefined;

/**
 * FTS tokenizer (write side AND query side): segmenter word tokens,
 * space-joined. Both FTS sides always call this same function. Not used by
 * keyword scoring (see the header).
 */
export function tokenizeForSearch(text: string): string {
	if (sharedTokenizer === undefined) sharedTokenizer = createMemoryTokenizer();
	return sharedTokenizer.tokenizeForSearch(text);
}
