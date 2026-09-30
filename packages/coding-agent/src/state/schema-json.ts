/**
 * Shared pure core for state-schema (.json face) loading — zero fs, zero jiti; safe for the browser graph.
 *
 * Both the node loader (`state/schema-loader.ts`) and the browser alias face
 * (`browser-engine/src/browser-schema-loader.ts`, the build.mjs WORKSPACE_ALIAS_MAP target) import this module, so
 * JSON parsing, shape validation, and inline-merge semantics cannot drift between profiles. The per-profile disk
 * scan loops stay in their respective faces (node dispatches .ts/.json; the alias face is .json-only with .ts
 * negotiated-absent hints).
 *
 * `node:path` is the only import: real basename semantics on node (Windows separators included), the posix path
 * shim in browser bundles.
 */

import { basename } from "node:path";
import type { StorageBackend } from "@earendil-works/pi-agent-core";

// ── Shared types (type authority for both loader faces) ─────────────────────

export interface LoadedSchemaDef {
	schemaId: string; // filename without extension
	namespace: string; // declared in schema file or defaults to schemaId
	schema: object; // TypeBox TSchema object compiled via typebox/compile.Compile
	filePath: string;
}

export interface LoadedSchemaDefs {
	schemas: LoadedSchemaDef[];
	errors: Array<{ filePath: string; message: string }>;
	/**
	 * 内联合并诊断（契约 §4）：仅内联通道存在时设置（node 现行扫描路径恒不设置，E6）。
	 * alias 面另承载 `.ts` 协商禁用跳过提示（warn 级，不抛错）。
	 */
	mergeDiagnostics?: SchemaMergeDiagnostic[];
}

/** 内联 schema 源（打包通道，契约 §3.2 C2 裁决定名 inlineSchemas）。 */
export interface SchemaDefSource {
	schemaId: string;
	namespace: string;
	schema: object;
	/** 缺省合成 `inline:<schemaId>`。 */
	filePath?: string;
	/** 溯源串；缺省 `inline:<schemaId>`（契约 §4）。 */
	source?: string;
}

export interface LoadSchemaDefsOptions {
	/** 存储缝；缺省 NodeStorageBackend.shared（node 逐字节等价）。 */
	storage?: StorageBackend;
	/** Explicit project config dir; omitted node callers retain PI_PROJECT_CONFIG_DIR resolution. */
	configDir?: string;
	/** 内联 schema（打包通道）。 */
	inline?: readonly SchemaDefSource[];
}

/** 合并/跳过诊断（warn 级；`source` = 胜出内联源的溯源串）。 */
export interface SchemaMergeDiagnostic {
	level: "warning";
	source: string;
	message: string;
}

// ── JSON parse + shape rules (moved verbatim from the node loader) ──────────

/**
 * Load a JSON Schema file (.json) body from text.
 * Accepts the same two shapes as the .ts loader:
 * - default: { namespace: string, schema: JSON Schema }
 * - default: bare JSON Schema object (namespace defaults to filename)
 * Throws with a diagnostic message on any invalid shape (caller surfaces it
 * in the errors list).
 */
export function parseJsonSchemaDef(filePath: string, rawText: string): LoadedSchemaDef {
	let raw: unknown;
	try {
		raw = JSON.parse(rawText);
	} catch (e) {
		throw new Error(`unparseable JSON: ${e instanceof Error ? e.message : String(e)}`);
	}
	return jsonSchemaDefFromObject(raw, filePath);
}

/** Shape rules shared by the file body and the inline channel (error texts are node-identical). */
export function jsonSchemaDefFromObject(raw: unknown, filePath: string): LoadedSchemaDef {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error("root must be a JSON object");
	}
	const obj = raw as Record<string, unknown>;
	let namespace: string;
	let schema: unknown;
	if ("schema" in obj) {
		if (obj.namespace !== undefined && typeof obj.namespace !== "string") {
			throw new Error('wrapper "namespace" must be a string');
		}
		namespace = typeof obj.namespace === "string" ? obj.namespace : basename(filePath, ".json");
		schema = obj.schema;
	} else {
		namespace = basename(filePath, ".json");
		schema = obj;
	}
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
		throw new Error('"schema" must be a JSON Schema object');
	}
	return { schemaId: basename(filePath, ".json"), namespace, schema, filePath };
}

// ── Inline merge (contract §3.3: inline > scanned; scanned order untouched) ─

/**
 * Merge inline schema sources over a scanned list. Scan order is preserved as-is (node keeps same-ID duplicates
 * coexisting; consumers `find` first-match). Only inline-present callers invoke this: same-ID scanned copies are
 * removed (inline wins, warned), inline entries append at the list tail, and inline-array-internal duplicates
 * resolve last-wins with a warning (same rule across all three resources).
 *
 * Invalid inline entries produce `errors` rows with node-identical messages; they never throw.
 */
export function mergeInlineSchemaDefs(
	scanned: LoadedSchemaDef[],
	inline: readonly SchemaDefSource[],
): { schemas: LoadedSchemaDef[]; errors: LoadedSchemaDefs["errors"]; mergeDiagnostics: SchemaMergeDiagnostic[] } {
	const schemas = [...scanned];
	const errors: LoadedSchemaDefs["errors"] = [];
	const mergeDiagnostics: SchemaMergeDiagnostic[] = [];

	// Inline array internal duplicates: later item wins + warn (replaces the earlier inline entry).
	const inlineById = new Map<string, { def: LoadedSchemaDef; source: string }>();
	for (const item of inline) {
		const filePath = item.filePath ?? `inline:${item.schemaId}`;
		const source = item.source ?? `inline:${item.schemaId}`;
		if (typeof item.namespace !== "string") {
			errors.push({ filePath, message: 'wrapper "namespace" must be a string' });
			continue;
		}
		if (!item.schema || typeof item.schema !== "object" || Array.isArray(item.schema)) {
			errors.push({ filePath, message: '"schema" must be a JSON Schema object' });
			continue;
		}
		const def: LoadedSchemaDef = {
			schemaId: item.schemaId,
			namespace: item.namespace,
			schema: item.schema,
			filePath,
		};
		const previous = inlineById.get(item.schemaId);
		if (previous) {
			mergeDiagnostics.push({
				level: "warning",
				source,
				message: `Inline schema "${item.schemaId}" (${source}) overrides inline ${previous.def.filePath}`,
			});
		}
		inlineById.set(item.schemaId, { def, source });
	}

	// Inline > scanned: drop every scanned copy with the same schemaId (warned), then append inline at the tail.
	for (const [schemaId, { def, source }] of inlineById) {
		for (let index = schemas.length - 1; index >= 0; index--) {
			const scannedDef = schemas[index]!;
			if (scannedDef.schemaId === schemaId) {
				mergeDiagnostics.push({
					level: "warning",
					source,
					message: `Inline schema "${schemaId}" (${source}) overrides scanned ${scannedDef.filePath}`,
				});
				schemas.splice(index, 1);
			}
		}
		schemas.push(def);
	}

	return { schemas, errors, mergeDiagnostics };
}
