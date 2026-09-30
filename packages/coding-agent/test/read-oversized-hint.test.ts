import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReadToolDefinition } from "../src/core/tools/read.ts";

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("\n");
}

describe("read tool oversized line hint", () => {
	let testDir: string;
	let filePath: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "read-hint-"));
		filePath = join(testDir, "big.txt");
		// First line alone exceeds the 50KB byte limit.
		writeFileSync(filePath, `${"x".repeat(60 * 1024)}\nsecond line\n`);
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("defaults to the bash fallback wording (shell profiles)", async () => {
		const tool = createReadToolDefinition(testDir, { autoResizeImages: false });
		const result = await tool.execute("h1", { path: filePath });
		const output = text(result as never);
		expect(output).toContain("Use bash: sed -n '1p'");
	});

	it("renders an injected bash-free hint template", async () => {
		const tool = createReadToolDefinition(testDir, {
			autoResizeImages: false,
			oversizedLineHint:
				"[Line {line} is {size}. The full line cannot be displayed; split the file with edit or use offset/limit around it.]",
		});
		const result = await tool.execute("h2", { path: filePath });
		const output = text(result as never);
		expect(output).toContain("Line 1 is");
		expect(output).toContain("split the file with edit or use offset/limit around it.");
		expect(output).not.toContain("Use bash");
	});
});
