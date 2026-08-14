import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SUPPORTED_SLOTS } from "../src/core/prompt-preset/slot-renderers.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";

/**
 * Docs-drift guard: asserts code-derived interface facts against the docs
 * with plain fs reads. Deterministic, no network, no LLM.
 *
 * The point is to stop documented interfaces from silently diverging from
 * the code again — it guards, it does not rewrite docs. When a doc change is
 * intentional, update this test (or the doc) in the same commit.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..", "..");

const DOC_FILES = [
	...readdirSync(join(repoRoot, "packages", "coding-agent", "docs"))
		.filter((f) => f.endsWith(".md"))
		.map((f) => join(repoRoot, "packages", "coding-agent", "docs", f)),
	join(repoRoot, "README.md"),
	join(repoRoot, "README.zh-CN.md"),
	join(repoRoot, "plan.md"),
];

function readDocs(): string {
	return DOC_FILES.map((f) => readFileSync(f, "utf-8")).join("\n");
}

/** Feature names (`| **Name** | ...`) in the first table under the given heading. */
function featureNames(markdown: string, heading: string): string[] {
	const lines = markdown.split("\n");
	const start = lines.findIndex((l) => l.trim() === heading);
	expect(start, `heading "${heading}" not found`).toBeGreaterThanOrEqual(0);
	const names: string[] = [];
	for (let i = start + 1; i < lines.length; i++) {
		const line = lines[i];
		if (line.startsWith("#")) break;
		const m = line.match(/^\|\s*\*\*(.+?)\*\*\s*\|/);
		if (m) names.push(m[1].replace(/^`|`$/g, ""));
	}
	return names;
}

describe("docs drift guard", () => {
	it("documents every built-in slash command", () => {
		const readme = readFileSync(join(repoRoot, "packages", "coding-agent", "README.md"), "utf-8");
		const usage = readFileSync(join(repoRoot, "packages", "coding-agent", "docs", "usage.md"), "utf-8");
		const text = `${readme}\n${usage}`;
		for (const cmd of BUILTIN_SLASH_COMMANDS) {
			expect(
				text,
				`slash command /${cmd.name} is missing from the package README command table or docs/usage.md`,
			).toContain(`/${cmd.name}`);
		}
	});

	it("documents every built-in prompt preset slot", () => {
		const presetDocs = readFileSync(join(repoRoot, "packages", "coding-agent", "docs", "prompt-presets.md"), "utf-8");
		for (const slot of SUPPORTED_SLOTS) {
			expect(presetDocs, `slot "${slot}" is missing from docs/prompt-presets.md`).toContain(`\`${slot}\``);
		}
	});

	it("documents every RP session entry type", () => {
		const sessionFormat = readFileSync(
			join(repoRoot, "packages", "coding-agent", "docs", "session-format.md"),
			"utf-8",
		);
		const sessionManager = readFileSync(
			join(repoRoot, "packages", "coding-agent", "src", "core", "session-manager.ts"),
			"utf-8",
		);
		// RP entry types from the SessionEntry union (session-manager.ts). Each
		// must exist as a `type` literal in code and as a section in the docs.
		const rpEntries = [
			{ type: "state", heading: "### StateEntry" },
			{ type: "preset_change", heading: "### PresetChangeEntry" },
			{ type: "schema_change", heading: "### SchemaChangeEntry" },
			{ type: "strict_change", heading: "### StrictChangeEntry" },
			{ type: "model_change", heading: "### ModelChangeEntry" },
			{ type: "thinking_level_change", heading: "### ThinkingLevelChangeEntry" },
		];
		for (const entry of rpEntries) {
			expect(sessionManager, `entry type "${entry.type}" is missing from src/core/session-manager.ts`).toContain(
				`type: "${entry.type}"`,
			);
			expect(sessionFormat, `entry type "${entry.type}" is missing from docs/session-format.md`).toContain(
				entry.heading,
			);
		}
	});

	it("keeps forbidden stale claims out of the docs", () => {
		const docs = readDocs();
		// The LLM get_state tool takes no arguments — no path-argument examples.
		expect(docs).not.toContain("get_state character.hp");
		expect(docs).not.toContain('pi.getState("character.hp")');
		// /preset has no list/use/reload subcommands.
		expect(docs).not.toContain("/preset use");
		expect(docs).not.toContain("/preset reload");
		// State-change handlers receive the full snapshot, not (path, value, previousValue).
		expect(docs).not.toContain("subscribeState((path, value, previousValue)");
	});

	it("keeps the English and Chinese feature tables in sync", () => {
		const en = readFileSync(join(repoRoot, "README.md"), "utf-8");
		const zh = readFileSync(join(repoRoot, "README.zh-CN.md"), "utf-8");
		const enFeatures = featureNames(en, "### Implemented");
		const zhFeatures = featureNames(zh, "### 已实现");
		// The tables are localized; this maps each English feature to its
		// Chinese counterpart so both tables must list exactly the same set.
		const enToZh = new Map<string, string>([
			["Prompt preset system", "预设提示词系统"],
			["/reroll", "/reroll"],
			["/continue", "/continue"],
			["Live message editing", "实时消息编辑"],
			["State validation", "状态校验"],
			["State management", "状态管理"],
			["Native Subagent", "原生 Subagent"],
		]);
		expect(enFeatures).toEqual([...enToZh.keys()]);
		expect(zhFeatures).toEqual([...enToZh.values()]);
	});
});
