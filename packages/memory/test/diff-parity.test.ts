/**
 * Same-source guard for the ported `generateDiffString` (§11.3, D6).
 *
 * packages/memory/src/diff.ts is a deliberate copy of
 * packages/coding-agent/src/core/tools/edit-diff.ts's implementation, because
 * memory MUST NOT import coding-agent. Both sides are pinned to the SAME
 * fixture file, so either copy drifting turns this red.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateDiffString } from "../src/diff.ts";

interface DiffCase {
	name: string;
	before: string;
	after: string;
	expectDiff: string;
	firstChangedLine: number | null;
}

const cases = JSON.parse(
	readFileSync(fileURLToPath(new URL("./fixtures/diff-cases.json", import.meta.url)), "utf8"),
) as DiffCase[];

describe("generateDiffString parity fixtures", () => {
	it("has a non-empty fixture set", () => {
		expect(cases.length).toBeGreaterThanOrEqual(5);
	});

	for (const c of cases) {
		it(`renders ${c.name}`, () => {
			const result = generateDiffString(c.before, c.after);
			expect(result.diff).toBe(c.expectDiff);
			expect(result.firstChangedLine ?? null).toBe(c.firstChangedLine);
		});
	}

	it("emits only lines renderDiff accepts (no grey fallback, §8 T8)", () => {
		// parseDiffLine (components/diff.ts:9) is /^([+-\s])(\s*\d*)\s(.*)$/.
		const linePattern = /^([+-\s])(\s*\d*)\s(.*)$/;
		for (const c of cases) {
			for (const line of generateDiffString(c.before, c.after).diff.split("\n")) {
				if (line === "") continue;
				expect(linePattern.test(line), `${c.name}: ${JSON.stringify(line)}`).toBe(true);
			}
		}
	});
});
