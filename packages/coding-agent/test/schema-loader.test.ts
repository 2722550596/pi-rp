import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSchemaDefs } from "../src/state/schema-loader.ts";

/** Temp dir whose agentDir (first discovery root) holds a schemas/ subdir. */
function tempSchemasDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-schema-loader-"));
	mkdirSync(join(dir, "schemas"));
	return dir;
}

describe("loadSchemaDefs — .json schemas", () => {
	it("loads a {namespace, schema} wrapper file", () => {
		const dir = tempSchemasDir();
		writeFileSync(
			join(dir, "schemas", "world.json"),
			JSON.stringify({
				namespace: "world",
				schema: { type: "object", properties: { day: { type: "number", default: 1 } } },
			}),
		);
		try {
			const { schemas, errors } = loadSchemaDefs(dir, dir);
			expect(errors).toEqual([]);
			expect(schemas).toHaveLength(1);
			expect(schemas[0].schemaId).toBe("world");
			expect(schemas[0].namespace).toBe("world");
			expect(schemas[0].schema).toEqual({
				type: "object",
				properties: { day: { type: "number", default: 1 } },
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("loads a bare JSON Schema file with namespace defaulting to filename", () => {
		const dir = tempSchemasDir();
		writeFileSync(join(dir, "schemas", "secret.json"), JSON.stringify({ type: "object", properties: {} }));
		try {
			const { schemas, errors } = loadSchemaDefs(dir, dir);
			expect(errors).toEqual([]);
			expect(schemas).toHaveLength(1);
			expect(schemas[0].schemaId).toBe("secret");
			expect(schemas[0].namespace).toBe("secret");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reports unparseable .json files as errors", () => {
		const dir = tempSchemasDir();
		writeFileSync(join(dir, "schemas", "broken.json"), "{not json");
		try {
			const { schemas, errors } = loadSchemaDefs(dir, dir);
			expect(schemas).toEqual([]);
			expect(errors).toHaveLength(1);
			expect(errors[0].filePath).toContain("broken.json");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
