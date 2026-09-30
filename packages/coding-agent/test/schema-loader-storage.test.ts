import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSchemaDefs as loadSchemaDefsAlias } from "../../browser-engine/src/browser-schema-loader.ts";
import { ENV_PROJECT_CONFIG_DIR } from "../src/config.ts";
import type { SchemaDefSource } from "../src/state/schema-json.ts";
import { loadSchemaDefs } from "../src/state/schema-loader.ts";
import { MemoryStorageBackend } from "./resource-supply-mocks.ts";

/**
 * 18 号 §10.2 — schema .json 面的 storage 参数化 + 内联合并 + alias 面同构。
 * (a) node 磁盘 .json 双目录 = 既有 schema-loader.test.ts 零改动回归门；
 * (b) OPFS mock / 内存 storage 扫描（node 真身与 alias 面同结果 = 零漂移）；
 * (c) 内联形状校验错误进 errors（文案同 node）；(d) 内联×扫描去重 + mergeDiagnostics；
 * 无内联时保序、无 mergeDiagnostics（node 同 ID 双条目共存语义，E6）。
 */

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function seedStorage(seedTs: boolean): MemoryStorageBackend {
	const storage = new MemoryStorageBackend("opfs");
	storage.seedJson("/state/agent/schemas/world.json", {
		namespace: "world",
		schema: { type: "object", properties: { day: { type: "number", default: 1 } } },
	});
	storage.seedJson("/state/agent/schemas/dup.json", { namespace: "from-agent-dir", schema: { type: "object" } });
	storage.seedJson("/workspace/default/.pi/schemas/player.json", { type: "object", properties: {} });
	storage.seedJson("/workspace/default/.pi/schemas/dup.json", {
		namespace: "from-project",
		schema: { type: "object" },
	});
	storage.seed("/state/agent/schemas/broken.json", "{not json");
	if (seedTs) storage.seed("/state/agent/schemas/world.ts", "export default {}");
	return storage;
}

describe("schema loader over storage (18 号 §10.2)", () => {
	it("(a) node disk .json dual-dir scan stays byte-identical through the storage seam", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-schema-storage-"));
		tempDirs.push(dir);
		mkdirSync(join(dir, "schemas"), { recursive: true });
		writeFileSync(
			join(dir, "schemas", "world.json"),
			JSON.stringify({
				namespace: "world",
				schema: { type: "object", properties: { day: { type: "number", default: 1 } } },
			}),
		);

		const { schemas, errors, mergeDiagnostics } = await loadSchemaDefs(dir, dir);
		expect(errors).toEqual([]);
		expect(mergeDiagnostics).toBeUndefined();
		expect(schemas).toHaveLength(1);
		expect(schemas[0]).toMatchObject({ schemaId: "world", namespace: "world" });
	});

	it("(b) scans a memory storage with .json dispatch, error rows, and node/alias face parity", async () => {
		const storage = seedStorage(false);
		const nodeFace = await loadSchemaDefs("/workspace/default", "/state/agent", { storage });
		const aliasFace = await loadSchemaDefsAlias("/workspace/default", "/state/agent", { storage });

		// Both faces share parseJsonSchemaDef + merge core: identical results on the .json face.
		expect(nodeFace.schemas.map((s) => [s.schemaId, s.namespace, s.filePath])).toEqual(
			aliasFace.schemas.map((s) => [s.schemaId, s.namespace, s.filePath]),
		);
		expect(nodeFace.errors).toEqual([
			{ filePath: "/state/agent/schemas/broken.json", message: expect.stringContaining("unparseable JSON") },
		]);
		expect(aliasFace.errors).toEqual(nodeFace.errors);
		// No inline, no .ts: neither face sets mergeDiagnostics.
		expect(nodeFace.mergeDiagnostics).toBeUndefined();
		expect(aliasFace.mergeDiagnostics).toBeUndefined();

		// Scan order preserved (agent dir before project dir): dup.json keeps both copies, agent first.
		expect(nodeFace.schemas.filter((s) => s.schemaId === "dup").map((s) => s.namespace)).toEqual([
			"from-agent-dir",
			"from-project",
		]);
	});

	it("(b2) alias face negotiates .ts schemas absent with a warn hint; node face keeps its jiti channel", async () => {
		const aliasFace = await loadSchemaDefsAlias("/workspace/default", "/state/agent", { storage: seedStorage(true) });
		expect(aliasFace.errors.some((e) => e.filePath === "/state/agent/schemas/world.ts")).toBe(false);
		expect(aliasFace.mergeDiagnostics?.some((d) => d.level === "warning" && d.message.includes("world.ts"))).toBe(
			true,
		);
		expect(aliasFace.schemas.some((s) => s.filePath.endsWith(".ts"))).toBe(false);
	});

	it("(c) inline shape errors land in errors with node-identical messages", async () => {
		const storage = new MemoryStorageBackend("opfs");
		const inline: SchemaDefSource[] = [
			{ schemaId: "bad-ns", namespace: 42 as unknown as string, schema: { type: "object" } },
			{ schemaId: "bad-schema", namespace: "ns", schema: "not-an-object" as unknown as object },
			{ schemaId: "good", namespace: "good", schema: { type: "object" } },
		];
		const { schemas, errors } = await loadSchemaDefs("/workspace/default", "/state/agent", { storage, inline });
		expect(errors).toEqual([
			{ filePath: "inline:bad-ns", message: 'wrapper "namespace" must be a string' },
			{ filePath: "inline:bad-schema", message: '"schema" must be a JSON Schema object' },
		]);
		expect(schemas.map((s) => s.schemaId)).toEqual(["good"]);
	});

	it("(d) inline wins over scanned copies with mergeDiagnostics; no inline keeps order and omits the field", async () => {
		const storage = seedStorage(false);
		const inline: SchemaDefSource[] = [
			{
				schemaId: "world",
				namespace: "world",
				schema: { type: "object", properties: { fromInline: { type: "boolean" } } },
				filePath: "bundled:world.json",
				source: "inline:bundled-world",
			},
		];
		const merged = await loadSchemaDefs("/workspace/default", "/state/agent", { storage, inline });

		// Scanned copies removed (both dirs), inline appended at tail with synthesized-respecting filePath.
		expect(merged.schemas.map((s) => [s.schemaId, s.filePath])).toEqual([
			["dup", "/state/agent/schemas/dup.json"],
			["player", "/workspace/default/.pi/schemas/player.json"],
			["dup", "/workspace/default/.pi/schemas/dup.json"],
			["world", "bundled:world.json"],
		]);
		expect(merged.mergeDiagnostics).toEqual([
			{
				level: "warning",
				source: "inline:bundled-world",
				message: 'Inline schema "world" (inline:bundled-world) overrides scanned /state/agent/schemas/world.json',
			},
		]);

		// Inline-array internal duplicate: later wins + warned.
		const both: SchemaDefSource[] = [
			{ schemaId: "twin", namespace: "a", schema: { type: "object" }, filePath: "inline:twin-1" },
			{
				schemaId: "twin",
				namespace: "b",
				schema: { type: "object" },
				filePath: "inline:twin-2",
				source: "inline:twin-two",
			},
		];
		const twinMerged = await loadSchemaDefs("/workspace/default", "/state/agent", { storage, inline: both });
		expect(twinMerged.schemas.filter((s) => s.schemaId === "twin").map((s) => s.namespace)).toEqual(["b"]);
		expect(twinMerged.mergeDiagnostics?.some((d) => d.message.includes("overrides inline inline:twin-1"))).toBe(true);
	});
	it("(b3) Browser alias project root is selected by explicit configDir, not the process default", async () => {
		const storage = new MemoryStorageBackend("opfs");
		storage.seedJson("/workspace/default/ip/aurora/schemas/from-ip.json", {
			namespace: "ip",
			schema: { type: "object" },
		});
		storage.seedJson("/workspace/default/global-env/schemas/from-env.json", {
			namespace: "env",
			schema: { type: "object" },
		});
		const previousConfigDir = process.env[ENV_PROJECT_CONFIG_DIR];
		process.env[ENV_PROJECT_CONFIG_DIR] = "global-env";
		try {
			const loaded = await loadSchemaDefsAlias("/workspace/default", "/state/agent", {
				storage,
				configDir: "ip/aurora",
			});
			expect(loaded.schemas.map((schema) => schema.schemaId)).toEqual(["from-ip"]);
			expect(loaded.schemas[0]?.filePath).toBe("/workspace/default/ip/aurora/schemas/from-ip.json");
		} finally {
			if (previousConfigDir === undefined) delete process.env[ENV_PROJECT_CONFIG_DIR];
			else process.env[ENV_PROJECT_CONFIG_DIR] = previousConfigDir;
		}
	});
});
