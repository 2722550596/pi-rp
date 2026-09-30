import { describe, expect, it, vi } from "vitest";
import { createGrepToolDefinition, type GrepOperations } from "../src/core/tools/grep.ts";

// Guard: if the bypass regresses and falls through to the rg path, these fail
// loudly instead of silently spawning/downloading ripgrep.
vi.mock("../src/utils/tools-manager.ts", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	ensureTool: async () => {
		throw new Error("rg resolution attempted despite search bypass");
	},
}));

const FILES: Record<string, string> = {
	"/proj/src/a.ts": "const alpha = 1;\nconst beta = 2;\nconst gamma = 3;",
	"/proj/src/deep/b.ts": "// beta here\n",
	"/proj/only.txt": "no\nyes beta\n",
};

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("\n");
}

function searchOverFiles(
	limitHits: (pattern: string, path: string) => Array<{ filePath: string; lineNumber: number }>,
) {
	const searched: Array<Record<string, unknown>> = [];
	const operations: GrepOperations = {
		isDirectory: (p) => !p.endsWith(".txt"),
		readFile: async (p) => FILES[p] ?? "",
		search: async (args) => {
			searched.push({ ...args, signal: args.signal?.aborted ?? null });
			return limitHits(args.pattern, args.path).slice(0, args.limit);
		},
	};
	return { operations, searched };
}

describe("grep tool search bypass (GrepOperations.search)", () => {
	it("routes through operations.search and renders rg-identical output", async () => {
		const { operations, searched } = searchOverFiles((pattern, path) => {
			const matches: Array<{ filePath: string; lineNumber: number }> = [];
			for (const [filePath, content] of Object.entries(FILES)) {
				if (!filePath.startsWith(`${path}/`)) continue;
				content.split("\n").forEach((line, index) => {
					if (line.includes(pattern)) matches.push({ filePath, lineNumber: index + 1 });
				});
			}
			return matches;
		});
		const tool = createGrepToolDefinition("/proj", { operations });

		const result = await tool.execute("b1", { pattern: "beta", path: "/proj" });
		expect(searched).toHaveLength(1);
		expect(searched[0]).toMatchObject({
			pattern: "beta",
			path: "/proj",
			ignoreCase: false,
			literal: false,
			limit: 100,
		});

		const lines = text(result as never).split("\n");
		expect(lines).toContain("src/a.ts:2: const beta = 2;");
		expect(lines).toContain("src/deep/b.ts:1: // beta here");
		expect(lines).toContain("only.txt:2: yes beta");
	});

	it("reports match-limit truncation when the search returns a full page", async () => {
		const { operations } = searchOverFiles(() => [
			{ filePath: "/proj/src/a.ts", lineNumber: 1 },
			{ filePath: "/proj/src/a.ts", lineNumber: 2 },
		]);
		const tool = createGrepToolDefinition("/proj", { operations });

		const result = await tool.execute("b2", { pattern: "x", path: "/proj", limit: 2 });
		const output = text(result as never);
		expect(output).toContain("src/a.ts:1:");
		expect(output).toContain("[2 matches limit reached. Use limit=4 for more, or refine pattern]");
		expect(result.details).toMatchObject({ matchLimitReached: 2 });
	});

	it("renders context lines through the shared readFile formatting", async () => {
		const { operations } = searchOverFiles(() => [{ filePath: "/proj/src/a.ts", lineNumber: 2 }]);
		const tool = createGrepToolDefinition("/proj", { operations });

		const result = await tool.execute("b3", { pattern: "beta", path: "/proj", context: 1 });
		expect(text(result as never).split("\n")).toEqual([
			"src/a.ts-1- const alpha = 1;",
			"src/a.ts:2: const beta = 2;",
			"src/a.ts-3- const gamma = 3;",
		]);
	});

	it("returns No matches found for an empty result page", async () => {
		const { operations } = searchOverFiles(() => []);
		const tool = createGrepToolDefinition("/proj", { operations });

		const result = await tool.execute("b4", { pattern: "ghost", path: "/proj" });
		expect(text(result as never)).toBe("No matches found");
	});

	it("uses basename formatting for single-file search paths", async () => {
		const { operations } = searchOverFiles(() => [{ filePath: "/proj/only.txt", lineNumber: 2 }]);
		const tool = createGrepToolDefinition("/proj", { operations });

		const result = await tool.execute("b5", { pattern: "beta", path: "/proj/only.txt" });
		expect(text(result as never)).toBe("only.txt:2: yes beta");
	});

	it("reports missing paths without touching rg", async () => {
		const operations: GrepOperations = {
			isDirectory: () => {
				throw new Error("ENOENT style failure");
			},
			readFile: async () => "",
			search: async () => {
				throw new Error("search must not run for missing paths");
			},
		};
		const tool = createGrepToolDefinition("/proj", { operations });

		await expect(tool.execute("b6", { pattern: "x", path: "/proj/ghost" })).rejects.toThrow(
			"Path not found: /proj/ghost",
		);
	});

	it("maps aborted searches to the standard abort error", async () => {
		const operations: GrepOperations = {
			isDirectory: () => true,
			readFile: async () => "",
			search: async () => {
				throw new DOMException("The operation was aborted.", "AbortError");
			},
		};
		const tool = createGrepToolDefinition("/proj", { operations });

		await expect(tool.execute("b7", { pattern: "x", path: "/proj" })).rejects.toThrow("Operation aborted");
	});
});
