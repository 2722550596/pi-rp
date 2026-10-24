/**
 * 宿主（如手机端的输出层）用 scanXmlTags 解析模型输出里的标签；pi-browser 入口直接导出它，宿主不必深导入 coding-agent。
 */

import { expect, it } from "vitest";
import { scanXmlTags } from "../src/index.ts";

it("exports scanXmlTags from the pi-browser entry", () => {
	const segments = scanXmlTags('<message>hi</message> tail <sticker id="a">', new Set(["message", "sticker"]));
	expect(segments.map((segment) => (segment.kind === "tag" ? `${segment.name}:${segment.closed}` : "text"))).toEqual([
		"message:true",
		"text",
		"sticker:false",
	]);
});
