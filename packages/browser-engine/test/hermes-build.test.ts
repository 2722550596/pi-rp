import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { afterEach, expect, it } from "vitest";
// @ts-expect-error build.mjs is an untyped build script
import { browserHarnessEsbuildOptions, buildHermesHarness, rewriteDynamicImportsForHermes } from "../build.mjs";

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

async function bundledInputs(options: Record<string, unknown>): Promise<string[]> {
	const result = await build({
		...browserHarnessEsbuildOptions("packages/browser-engine/src/index.ts", { metafile: true, ...options }),
		write: false,
	});
	const output = Object.values(result.metafile.outputs)[0] as { inputs: Record<string, unknown> };
	return Object.keys(output.inputs).map((path) => path.replaceAll("\\", "/"));
}

const providerSdk = /node_modules\/(openai|@anthropic-ai\/sdk|@google\/genai|@mistralai)\//;
const providerCatalog = /ai\/src\/providers\/(anthropic|openai|google|mistral|openrouter)\.ts$/;
const exportTemplates = /export-html\/(template\.(html|css|js)|vendor\/)/;

it("streamFnOnly + exportHtml:false drop provider SDKs, the built-in catalog and export templates", async () => {
	const trimmed = await bundledInputs({ streamFnOnly: true, exportHtml: false });
	expect(trimmed.filter((path) => providerSdk.test(path))).toEqual([]);
	expect(trimmed.filter((path) => providerCatalog.test(path))).toEqual([]);
	expect(trimmed.filter((path) => exportTemplates.test(path))).toEqual([]);
	expect(trimmed.some((path) => path.endsWith("src/stub/provider-api.ts"))).toBe(true);
}, 60_000);

it("keeps the default browser bundle untrimmed", async () => {
	const full = await bundledInputs({});
	expect(full.some((path) => providerSdk.test(path))).toBe(true);
	expect(full.some((path) => providerCatalog.test(path))).toBe(true);
	expect(full.some((path) => exportTemplates.test(path))).toBe(true);
}, 60_000);
