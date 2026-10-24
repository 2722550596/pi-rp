import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
// @ts-expect-error build.mjs is an untyped build script
import { buildHermesHarness, rewriteDynamicImportsForHermes } from "../build.mjs";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("rewrites dynamic import() calls but leaves methods named import alone", () => {
	const { code, count } = rewriteDynamicImportsForHermes(
		'const a = import("x"); const b = import(name); obj.import("y"); const o = { import(x) { return x; } };',
	);
	expect(count).toBe(2);
	expect(code).toContain('__piHermesImport("x")');
	expect(code).toContain("__piHermesImport(name)");
	expect(code).toContain('obj.import("y")');
	expect(code).toContain("import(x) {");
});

it("builds a CommonJS bundle without import.meta or dynamic import()", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-hermes-"));
	dirs.push(dir);
	const entry = join(dir, "entry.ts");
	writeFileSync(entry, "export const here = import.meta.url;\nexport const load = (name: string) => import(name);\n");
	const outfile = join(dir, "out.cjs");
	const { rewrites } = await buildHermesHarness(entry, {
		outfile,
		minify: false,
		importMetaUrl: "file:///app/engine.js",
	});
	const code = readFileSync(outfile, "utf8");
	expect(rewrites).toBe(1);
	expect(code).toContain("module.exports");
	expect(code).toContain('"file:///app/engine.js"');
	expect(code).not.toMatch(/import\.meta/);
	expect(code).not.toMatch(/(?<![\w$.])import\(/);
});
