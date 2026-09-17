/**
 * 样式层零第三方变量哨兵(01-设计系统 §10.1 提案;Main 2026-09-18 裁定:随样式层重写批次落地)。
 *
 * 为什么是静态断言:与本目录 multi-db-frontend.test.ts 同理——CSS 无法在 node 里"真跑",
 * 哨兵守住的是「颜色语义全部收敛到自有 --mw-* token 体系」这条已声明的架构决定,
 * 防止未来有人图省事把第三方变量体系引回样式层(重写前 app.css 有 52 处第三方变量
 * 引用,颜色体系 100% 寄生在外部变量上,正是这条断言要钉死的前车之鉴)。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const assets = path.join(here, "..", "..", "src", "web", "assets");

describe("style layer carries no third-party variable references", () => {
	it.each(["app.css", "tokens.css"])("%s resolves zero `var(--pico-`", (file) => {
		const css = readFileSync(path.join(assets, file), "utf8");
		expect(css, file).not.toMatch(/var\(--pico-/);
	});
});
