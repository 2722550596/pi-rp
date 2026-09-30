import { describe, expect, it } from "vitest";
import { createMemoryTokenizer, tokenizeForMatch, tokenizeForSearch } from "../src/tokenize.ts";

/**
 * Unified tokenizer unit tests (2026-09-30 拍板: one Intl.Segmenter("zh")
 * tokenizer for node/browser/hosted; @node-rs/jieba removed). The
 * quality-level regression harness is 13-D §11.3-4; these pin the space
 * identity and the word-segmentation contract the FTS sides rely on.
 */
describe("unified Intl.Segmenter tokenizer", () => {
	it("records the single token-space value", () => {
		expect(createMemoryTokenizer().space).toBe("segmenter");
	});

	it("segments CJK sentences into words on the FTS space", () => {
		expect(tokenizeForSearch("今天天气不错")).toBe("今天 天气 不错");
	});

	it("keeps latin words and numbers and drops punctuation", () => {
		expect(tokenizeForSearch("你好，世界！Hello World 42")).toBe("你好 世界 Hello World 42");
	});

	it("returns the empty string for punctuation-only and empty input", () => {
		expect(tokenizeForSearch("。。。")).toBe("");
		expect(tokenizeForSearch("")).toBe("");
	});

	it("keeps single CJK characters tokenizable (bigram space could not)", () => {
		// tokenizeForMatch produces a lone bigram document side and a lone char
		// query side — the recall.ts:305-309 zero-recall defect. The segmenter
		// space keeps single CJK chars word-like, so `日` stays queryable.
		expect(tokenizeForSearch("日")).toBe("日");
	});

	it("is deterministic across calls (one shared segmenter instance)", () => {
		expect(tokenizeForSearch("记忆树（memory tree）检索")).toBe(tokenizeForSearch("记忆树（memory tree）检索"));
	});

	it("leaves the scoring space (latin + CJK bigrams) untouched", () => {
		expect(tokenizeForMatch("日")).toEqual(["日"]);
		expect(tokenizeForMatch("记忆")).toEqual(["记忆"]);
		expect(tokenizeForMatch("Hello 世界")).toEqual(["hello", "世界"]);
	});
});
