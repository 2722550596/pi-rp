import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "web", "assets");

function jsFiles(dir) {
	const out = [];
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		if (e.name === "vendor") continue;
		const p = join(dir, e.name);
		if (e.isDirectory()) out.push(...jsFiles(p));
		else if (e.name.endsWith(".js")) out.push(p);
	}
	return out;
}

describe("frontend hard rules", () => {
	it("no source file uses innerHTML (textContent/DOM API only)", () => {
		const offenders = jsFiles(ASSETS)
			.map((f) => {
				const hits = readFileSync(f, "utf8")
					.split("\n")
					.map((line, i) => ({
						line: i + 1,
						text: line.trimStart().startsWith("//") ? "" : line.replace(/\s\/\/.*$/, ""),
					}))
					.filter(({ text }) => /\binnerHTML\b/.test(text));
				return { file: f, hits };
			})
			.filter(({ hits }) => hits.length > 0);
		expect(offenders, offenders.map((o) => `${o.file}: ${o.hits.map((h) => h.line).join(",")}`).join("\n")).toEqual(
			[],
		);
	});
});
