import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * jieba 断根检查 (13-D §11.3-6): the 2026-09-30 拍板 removed `@node-rs/jieba`
 * — the repo's only native dependency — together with its `createRequire`
 * loader. Nothing in this package may reference them again.
 */
const banned: Array<[RegExp, string]> = [
	[/@node-rs\/jieba/, "@node-rs/jieba reference"],
	[/createRequire/, "createRequire loader"],
	[/from ["']node:module["']/, "node:module import"],
];

function* sourceFiles(dir: string): Generator<string> {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) yield* sourceFiles(path);
		else if (entry.isFile() && /\.(ts|mts|cts|js|mjs|cjs)$/.test(entry.name)) yield path;
	}
}

describe("jieba eradication (拍板: 彻底移除)", () => {
	it("leaves no @node-rs/jieba or createRequire references in source or manifest", () => {
		const packageRoot = join(import.meta.dirname, "..");
		const offenders: string[] = [];
		for (const file of sourceFiles(join(packageRoot, "src"))) {
			const content = readFileSync(file, "utf8");
			for (const [pattern, label] of banned) {
				if (pattern.test(content)) offenders.push(`${relative(packageRoot, file)}: ${label}`);
			}
		}
		const manifest = readFileSync(join(packageRoot, "package.json"), "utf8");
		for (const [pattern, label] of banned) {
			if (pattern.test(manifest)) offenders.push(`package.json: ${label}`);
		}
		expect(offenders).toEqual([]);
	});
});
