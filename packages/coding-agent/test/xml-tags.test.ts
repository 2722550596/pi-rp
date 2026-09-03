import { describe, expect, test } from "vitest";
import { createXmlTagTransformer, scanXmlTags } from "../src/index.ts";

const SPEAK = new Set(["speak", "ooc"]);

describe("scanXmlTags", () => {
	test("scans a complete tag with quoted attributes", () => {
		const segments = scanXmlTags(`前言 <speak from="elena" emo="cold">台词</speak> 后记`, SPEAK);
		expect(segments).toEqual([
			{ kind: "text", text: "前言 " },
			{
				kind: "tag",
				name: "speak",
				attrs: { from: "elena", emo: "cold" },
				content: "台词",
				closed: true,
				pending: false,
			},
			{ kind: "text", text: " 后记" },
		]);
	});

	test("treats an unterminated tag as a pending segment with the tail as content", () => {
		const segments = scanXmlTags(`<speak from="elena">还没说完`, SPEAK);
		expect(segments).toEqual([
			{
				kind: "tag",
				name: "speak",
				attrs: { from: "elena" },
				content: "还没说完",
				closed: false,
				pending: true,
			},
		]);
	});

	test("converges across frames as the closing tag arrives", () => {
		const frames = [
			`<speak from="elena">你`,
			`<speak from="elena">你好`,
			`<speak from="elena">你好。</speak>`,
		];
		const states = frames.map((frame) => scanXmlTags(frame, SPEAK)[0]);
		expect(states[0]).toMatchObject({ content: "你", closed: false, pending: true });
		expect(states[1]).toMatchObject({ content: "你好", closed: false, pending: true });
		expect(states[2]).toMatchObject({ content: "你好。", closed: true, pending: false });
	});

	test("keeps a half-open tag header as plain text", () => {
		const segments = scanXmlTags(`<speak from="eli`, SPEAK);
		expect(segments).toEqual([{ kind: "text", text: `<speak from="eli` }]);
	});

	test("ignores tags outside the allow-list, preserving them as text", () => {
		const segments = scanXmlTags(`<b>bold</b> <speak>hi</speak>`, SPEAK);
		expect(segments).toEqual([
			{ kind: "text", text: "<b>bold</b> " },
			{ kind: "tag", name: "speak", attrs: {}, content: "hi", closed: true, pending: false },
		]);
	});

	test("keeps a tag header that matches the name but not a `<tag` boundary as text", () => {
		// `<<speak>` starts with a double '<'; only the real `<speak>` is tagged.
		const segments = scanXmlTags(`<<speak>hi</speak>`, SPEAK);
		expect(segments[0]).toEqual({ kind: "text", text: "<" });
		expect(segments[1]).toMatchObject({ kind: "tag", name: "speak", content: "hi", closed: true });
	});

	test("supports single-quoted and bare attribute values", () => {
		const segments = scanXmlTags(`<speak from='elena' emo=cold>嗨</speak>`, SPEAK);
		expect(segments).toEqual([
			{
				kind: "tag",
				name: "speak",
				attrs: { from: "elena", emo: "cold" },
				content: "嗨",
				closed: true,
				pending: false,
			},
		]);
	});

	test("tolerates whitespace in the closing tag", () => {
		const segments = scanXmlTags(`<speak>嗨</speak >`, SPEAK);
		expect(segments[0]).toMatchObject({ kind: "tag", name: "speak", content: "嗨", closed: true });
	});

	test("keeps a tag pending when no closing tag exists (closing-like text inside content)", () => {
		// A different closing tag inside the content does not close `<speak>`.
		const segments = scanXmlTags(`<speak>a</b>c`, SPEAK);
		expect(segments).toEqual([
			{
				kind: "tag",
				name: "speak",
				attrs: {},
				content: "a</b>c",
				closed: false,
				pending: true,
			},
		]);
	});

	test("handles multiple tags and surrounding text", () => {
		const segments = scanXmlTags(
			`<ooc>作者按</ooc>然后 <speak from="gar">让让</speak>。`,
			SPEAK,
		);
		expect(segments).toEqual([
			{ kind: "tag", name: "ooc", attrs: {}, content: "作者按", closed: true, pending: false },
			{ kind: "text", text: "然后 " },
			{ kind: "tag", name: "speak", attrs: { from: "gar" }, content: "让让", closed: true, pending: false },
			{ kind: "text", text: "。" },
		]);
	});

	test("handles tag content containing markdown", () => {
		const segments = scanXmlTags(`<speak>*轻笑* 你好</speak>`, SPEAK);
		expect(segments[0]).toMatchObject({ content: "*轻笑* 你好", closed: true });
	});

	test("handles empty content", () => {
		const segments = scanXmlTags(`<speak></speak>`, SPEAK);
		expect(segments[0]).toMatchObject({ kind: "tag", name: "speak", content: "", closed: true });
	});
});

describe("createXmlTagTransformer", () => {
	test("projects recognized tags through the renderer and preserves surrounding text", () => {
		const transformer = createXmlTagTransformer({
			tags: {
				speak: (tag, ctx) =>
					`**${tag.attrs.from ?? "?"}**：${tag.content}${ctx.isStreaming && !tag.closed ? "█" : ""}`,
			},
		});
		const out = transformer(`旁白 <speak from="elena">你好</speak> 继续`, {
			messageType: "assistant",
			isStreaming: false,
			availableWidth: 80,
		});
		expect(out).toBe(`旁白 **elena**：你好 继续`);
	});

	test("adds a streaming cursor for pending tags while streaming", () => {
		const transformer = createXmlTagTransformer({
			tags: {
				speak: (tag, ctx) => `**${tag.attrs.from}**：${tag.content}${!tag.closed && ctx.isStreaming ? "█" : ""}`,
			},
		});
		const pending = transformer(`<speak from="elena">你`, {
			messageType: "assistant",
			isStreaming: true,
			availableWidth: 80,
		});
		expect(pending).toBe(`**elena**：你█`);
		const settled = transformer(`<speak from="elena">你好。</speak>`, {
			messageType: "assistant",
			isStreaming: false,
			availableWidth: 80,
		});
		expect(settled).toBe(`**elena**：你好。`);
	});

	test("passes through text with no recognized tags unchanged", () => {
		const transformer = createXmlTagTransformer({ tags: { speak: (t) => t.content } });
		const input = "纯正文，没有标签。";
		expect(
			transformer(input, { messageType: "assistant", isStreaming: false, availableWidth: 80 }),
		).toBe(input);
	});

	test("falls back to raw rendering when a renderer throws", () => {
		const transformer = createXmlTagTransformer({
			tags: {
				speak: () => {
					throw new Error("boom");
				},
			},
		});
		const out = transformer(`前 <speak from="x">内容</speak> 后`, {
			messageType: "assistant",
			isStreaming: false,
			availableWidth: 80,
		});
		expect(out).toBe(`前 <speak from="x">内容</speak> 后`);
	});

	test("passes customType through to the renderer context", () => {
		const transformer = createXmlTagTransformer({
			tags: {
				speak: (tag, ctx) => `${ctx.customType ?? ""}:${tag.content}`,
			},
		});
		const out = transformer(`<speak>hi</speak>`, {
			messageType: "custom",
			customType: "character_reply",
			isStreaming: false,
			availableWidth: 80,
		});
		expect(out).toBe("character_reply:hi");
	});
});