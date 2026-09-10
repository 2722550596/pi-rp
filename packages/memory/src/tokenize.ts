import { createRequire } from "node:module";

/**
 * Two token spaces, deliberately (docs/memory-system.md §3/§15.2).
 *
 * - tokenizeForSearch() — the FTS space: one real jieba instance is built once
 *   (module-level singleton) and used by BOTH the FTS write side (reindexNode /
 *   _reindexRawFts) and the FTS query side (searchNodeFts), so indexed rows and
 *   MATCH queries never live in two token spaces. Falls back to the bigram
 *   mixer when the native dependency is unavailable.
 * - tokenizeForMatch() — the scoring space: latin words + CJK bigrams, used by
 *   keywordScore() to measure query/doc overlap for candidates the FTS filter
 *   already selected.
 *
 * The split is intentional: candidate SELECTION is an FTS MATCH (jieba space),
 * candidate SCORING is a cheap bigram overlap (no jieba call per doc per
 * query). Keep it that way — do not "unify" scoring onto jieba without also
 * measuring the per-recall cost.
 */

/** Query-side tokenizer: CJK bigrams + latin words (fallback space). */
export function tokenizeForMatch(text: string): string[] {
	const tokens = new Set<string>();
	const latin = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
	for (const w of latin) tokens.add(w);
	const cjk = text.match(/[\u4e00-\u9fff]/g) ?? [];
	for (let i = 0; i < cjk.length - 1; i++) tokens.add(cjk[i] + cjk[i + 1]);
	if (cjk.length === 1) tokens.add(cjk[0]);
	return [...tokens];
}

type JiebaInstance = { cutForSearch(sentence: string): string[] };

type JiebaModule = {
	Jieba: { withDict(dict: Uint8Array): JiebaInstance };
};

let jiebaInstance: JiebaInstance | null | undefined;

function loadJieba(): JiebaInstance | null {
	if (jiebaInstance !== undefined) return jiebaInstance;
	try {
		const req = createRequire(import.meta.url);
		const mod = req("@node-rs/jieba") as JiebaModule;
		const { dict } = req("@node-rs/jieba/dict") as { dict: Uint8Array };
		jiebaInstance = mod.Jieba.withDict(dict);
	} catch {
		jiebaInstance = null;
	}
	return jiebaInstance;
}

/**
 * FTS tokenizer (write side AND query side): jieba cutForSearch,
 * space-joined. Falls back to the bigram mixer when the native dependency is
 * unavailable, so indexing still works — and both FTS sides always call this
 * same function. Not used by keyword scoring (see the header).
 */
export function tokenizeForSearch(text: string): string {
	if (text.length === 0) return "";
	const jieba = loadJieba();
	if (jieba) return jieba.cutForSearch(text).join(" ");
	return tokenizeForMatch(text).join(" ");
}
