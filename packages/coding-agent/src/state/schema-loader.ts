import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { NodeStorageBackend } from "@earendil-works/pi-agent-core/node";
import { createJiti } from "jiti/static";
import { getAgentDir, getProjectConfigDir, getProjectConfigDirFor, isBunBinary } from "../config.ts";
import { getAliases, VIRTUAL_MODULES } from "../core/extensions/loader.ts";
import {
	type LoadedSchemaDef,
	type LoadedSchemaDefs,
	type LoadSchemaDefsOptions,
	mergeInlineSchemaDefs,
	parseJsonSchemaDef,
} from "./schema-json.ts";
import type { CustomValidator } from "./schema-validator.ts";

export type {
	LoadedSchemaDef,
	LoadedSchemaDefs,
	LoadSchemaDefsOptions,
	SchemaDefSource,
	SchemaMergeDiagnostic,
} from "./schema-json.ts";

// node 真身（browser 构建经 build.mjs WORKSPACE_ALIAS_MAP 改写到 browser-schema-loader.ts，本文件
// 不进 browser 图）：顶层 node:fs 仅为 jiti 域的 loadCustomValidators 保留（18 号 §12 Q4「不参数化」）；
// schema .json 扫描面已收敛到 StorageBackend（loadSchemaDefs 的 storage + inline 缝）。

const SCHEMA_DIR = "schemas";
const VALIDATOR_DIR = "validators";

/** Create a jiti instance with the same config used by the extension loader.
 *
 * `moduleCache: false` keeps user schema/validator files re-evaluated on every
 * load (so /reload picks up edits), but that must not re-execute their
 * dependencies: the sync `jiti(path)` require path re-transforms and
 * re-executes the whole typebox ESM tree (~280 small modules, ~300ms) for
 * every file. The async `jiti.import()` path resolves dependencies through
 * native ESM imports, so Node's module cache evaluates typebox once per
 * process while the user-authored entry file itself stays uncached.
 */
function createSchemaJiti() {
	return createJiti(import.meta.url, {
		moduleCache: false,
		...(isBunBinary ? { virtualModules: VIRTUAL_MODULES, tryNative: false } : { alias: getAliases() }),
	});
}

/** Discover and load schema definitions from standard locations. */
export async function loadSchemaDefs(
	cwd: string,
	agentDir?: string,
	options?: LoadSchemaDefsOptions,
): Promise<LoadedSchemaDefs> {
	const { storage = NodeStorageBackend.shared, configDir, inline } = options ?? {};
	const resolvedAgentDir = agentDir ?? getAgentDir();
	const dirs = [join(resolvedAgentDir, SCHEMA_DIR), getProjectConfigDirFor(cwd, configDir, SCHEMA_DIR)];
	const schemas: LoadedSchemaDef[] = [];
	const errors: Array<{ filePath: string; message: string }> = [];

	for (const dir of dirs) {
		if (!storage.existsSync(dir)) continue;
		const entries = storage.readdirSync(dir);
		for (const entry of entries) {
			const file = entry.name;
			const filePath = join(dir, file);
			if (file.endsWith(".ts")) {
				const result = await loadSchemaFile(filePath);
				if (result) schemas.push(result);
				else errors.push({ filePath, message: "Failed to load schema" });
			} else if (file.endsWith(".json")) {
				try {
					schemas.push(parseJsonSchemaDef(filePath, storage.readTextFileSync(filePath)));
				} catch (e) {
					errors.push({
						filePath,
						message: `Failed to load schema: ${e instanceof Error ? e.message : String(e)}`,
					});
				}
			}
		}
	}

	// 内联合并（契约 §3.3）：仅内联存在时执行 —— 同 schemaId 扫描副本被内联胜出去重（warn 记入
	// mergeDiagnostics），内联条目追加于列表尾；无内联时保序返回（node 同 ID 双条目共存语义，E6）。
	if (inline && inline.length > 0) {
		const merged = mergeInlineSchemaDefs(schemas, inline);
		return {
			schemas: merged.schemas,
			errors: [...errors, ...merged.errors],
			mergeDiagnostics: merged.mergeDiagnostics,
		};
	}

	return { schemas, errors };
}

async function loadSchemaFile(filePath: string): Promise<LoadedSchemaDef | null> {
	const jiti = createSchemaJiti();
	const mod = await jiti.import(filePath, { default: true });

	// Accept either:
	// - default: { namespace: string, schema: TSchema }
	// - default: TSchema (namespace defaults to filename)
	let namespace: string;
	let schema: unknown;
	if (mod !== null && typeof mod === "object" && "schema" in mod) {
		const obj = mod as Record<string, unknown>;
		namespace = typeof obj.namespace === "string" ? obj.namespace : basename(filePath, ".ts");
		schema = obj.schema;
	} else {
		namespace = basename(filePath, ".ts");
		schema = mod;
	}

	if (!schema || typeof schema !== "object") return null;
	return { schemaId: basename(filePath, ".ts"), namespace, schema, filePath };
}

/** Discover and load custom validators from standard locations. */
export async function loadCustomValidators(cwd: string, agentDir?: string): Promise<CustomValidator[]> {
	const resolvedAgentDir = agentDir ?? getAgentDir();
	const dirs = [join(resolvedAgentDir, VALIDATOR_DIR), getProjectConfigDir(cwd, VALIDATOR_DIR)];
	const validators: CustomValidator[] = [];

	for (const dir of dirs) {
		if (!existsSync(dir)) continue;
		const files = readdirSync(dir).filter((f) => f.endsWith(".ts") || f.endsWith(".js"));
		for (const file of files) {
			const filePath = join(dir, file);
			try {
				const jiti = createSchemaJiti();
				const mod: unknown = await jiti.import(filePath, { default: true });
				const found = extractValidators(mod);
				if (found) validators.push(...found);
			} catch {
				// Silently skip failed validator files — errors are non-fatal
			}
		}
	}

	return validators;
}

/** Extract CustomValidator[] from a jiti-loaded module: named export "validators", default array, or default { validators }. */
function extractValidators(mod: unknown): CustomValidator[] | null {
	if (mod !== null && typeof mod === "object" && "validators" in mod) {
		const named = (mod as Record<string, unknown>).validators;
		if (Array.isArray(named)) return named as CustomValidator[];
	}
	if (mod !== null && typeof mod === "object" && "default" in mod) {
		const def = (mod as Record<string, unknown>).default;
		if (Array.isArray(def)) return def as CustomValidator[];
		if (def !== null && typeof def === "object" && "validators" in def) {
			const nested = (def as Record<string, unknown>).validators;
			if (Array.isArray(nested)) return nested as CustomValidator[];
		}
	}
	return null;
}
