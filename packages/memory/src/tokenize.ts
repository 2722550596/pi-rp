import { createRequire } from "node:module";

/**
 * Query-side tokenizer: CJK bigrams + latin words. Used for keyword scoring
 * in recall; FTS write-side uses jieba cutForSearch (space-joined) instead.
 */
export function tokenizeForMatch(text: string): string[] {
	const tokens = new Set<string>();
	const latin = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
	for (const w of latin) tokens.add(w);
	const cjk = text.match(/[\u4e00-\u9fff]/g) ?? [];
	for (let i = 0; i < cjk.length - 1; i++) tokens.add(cjk[i] + cjk[i + 1]);
	if (cjk.length === 1) tokens.add(cjk[0]);
	return [...tokens];
}

type JiebaModule = {
	Jieba: new (dict: unknown, idf: unknown) => { cutForSearch(text: string): string[] };
	dict: unknown;
	idf: unknown;
};

let jieba: JiebaModule | null | undefined;

function loadJieba(): JiebaModule | null {
	if (jieba !== undefined) return jieba;
	try {
		const req = createRequire(import.meta.url);
		jieba = req("@node-rs/jieba") as JiebaModule;
	} catch {
		jieba = null;
	}
	return jieba;
}

/**
 * FTS write-side tokenizer: jieba cutForSearch, space-joined. Falls back to
 * the bigram mixer if the optional native dependency is unavailable (e.g.
 * missing platform binary), so indexing still works.
 */
export function tokenizeForSearch(text: string): string {
	if (text.length === 0) return "";
	const mod = loadJieba();
	if (mod) return new mod.Jieba(mod.dict, mod.idf).cutForSearch(text).join(" ");
	return tokenizeForMatch(text).join(" ");
}
