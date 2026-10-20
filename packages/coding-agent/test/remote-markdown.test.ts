import { describe, expect, test } from "vitest";
import { parseBlocks } from "../web/remote/src/render/markdown.ts";

describe("remote markdown block parser", () => {
	test("parses standard unindented lists", () => {
		const blocks = parseBlocks("- item 1\n- item 2");
		expect(blocks).toEqual([
			{
				kind: "list",
				ordered: false,
				items: [
					{ text: "item 1", children: [] },
					{ text: "item 2", children: [] },
				],
			},
		]);
	});

	test("parses indented lists without infinite loops", () => {
		const blocks = parseBlocks("  - item 1\n  - item 2");
		expect(blocks).toEqual([
			{
				kind: "list",
				ordered: false,
				items: [
					{ text: "item 1", children: [] },
					{ text: "item 2", children: [] },
				],
			},
		]);
	});

	test("handles nested lists with continuation text without looping", () => {
		const source = ["- Parent line", "  Continuation text of parent", "  - Child 1", "  - Child 2"].join("\n");
		const blocks = parseBlocks(source);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]?.kind).toBe("list");
		if (blocks[0]?.kind === "list") {
			expect(blocks[0].items).toHaveLength(1);
			expect(blocks[0].items[0]?.text).toBe("Parent line\nContinuation text of parent");
			expect(blocks[0].items[0]?.children).toHaveLength(1);
			expect(blocks[0].items[0]?.children[0]?.items).toEqual(["Child 1", "Child 2"]);
		}
	});

	test("does not hang when indented bullet follows paragraph or unindented text", () => {
		const source = ["- Line 1", "  text", "Paragraph text", "  - Indented bullet 1", "  - Indented bullet 2"].join(
			"\n",
		);
		const blocks = parseBlocks(source);
		expect(blocks.length).toBeGreaterThan(1);
		const lastBlock = blocks.at(-1);
		expect(lastBlock?.kind).toBe("list");
	});

	test("parses ordered lists with custom start indentation", () => {
		const blocks = parseBlocks("  1. first\n  2. second");
		expect(blocks).toEqual([
			{
				kind: "list",
				ordered: true,
				items: [
					{ text: "first", children: [] },
					{ text: "second", children: [] },
				],
			},
		]);
	});

	test("parses session 01a14ffc excerpt without timing out or overflowing memory", () => {
		const excerpt = [
			"- **查案线**：",
			"  掉马之后，两人彻底互通底牌。",
			"- **感情线（在刀尖与雨夜里长出来的纯情恋爱）**：",
			"  在第二幕掉马到第三幕决战之间，正是两人感情急速升温、把那些“血族生理小巧思”玩出花来的黄金期：",
			"  - 西奥多明明是人类，却开始笨拙地上网查（甚至旁敲侧击问里世界的老医生）“怎么把年轻血族养胖一点”；",
			"  - 米洛因为那晚尝过了西奥多的血，再喝合成配给袋只觉得难以下咽，却死活不肯再咬西奥多第二次，直到西奥多看穿他借口背后的克制，主动在雨夜的公寓里解开领口表白；",
			"  - 审讯室外的隔空心跳、正装衣领没遮住的红痕、醉血后的真言、以及大结局尘埃落定后，两人名正言顺地完成血族伴侣的深层标记。",
		].join("\n");

		const start = Date.now();
		const blocks = parseBlocks(excerpt);
		const duration = Date.now() - start;

		expect(duration).toBeLessThan(100);
		expect(blocks.length).toBeGreaterThan(0);
	});
});
