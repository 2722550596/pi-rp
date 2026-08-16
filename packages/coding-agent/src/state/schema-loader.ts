import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createJiti } from "jiti/static";
import { getAgentDir, getProjectConfigDir, isBunBinary } from "../config.ts";
import { getAliases, VIRTUAL_MODULES } from "../core/extensions/loader.ts";
import type { CustomValidator } from "./schema-validator.ts";

const SCHEMA_DIR = "schemas";
const VALIDATOR_DIR = "validators";

export interface LoadedSchemaDef {
	schemaId: string; // filename without extension
	namespace: string; // declared in schema file or defaults to schemaId
	schema: object; // TypeBox TSchema object compiled via typebox/compile.Compile
	filePath: string;
}

export interface LoadedSchemaDefs {
	schemas: LoadedSchemaDef[];
	errors: Array<{ filePath: string; message: string }>;
}

/** Create a jiti instance with the same config used by the extension loader. */
function createSchemaJiti() {
	return createJiti(import.meta.url, {
		moduleCache: false,
		...(isBunBinary ? { virtualModules: VIRTUAL_MODULES, tryNative: false } : { alias: getAliases() }),
	});
}

/** Discover and load schema definitions from standard locations. */
export function loadSchemaDefs(cwd: string, agentDir?: string): LoadedSchemaDefs {
	const resolvedAgentDir = agentDir ?? getAgentDir();
	const dirs = [join(resolvedAgentDir, SCHEMA_DIR), getProjectConfigDir(cwd, SCHEMA_DIR)];
	const schemas: LoadedSchemaDef[] = [];
	const errors: Array<{ filePath: string; message: string }> = [];

	for (const dir of dirs) {
		if (!existsSync(dir)) continue;
		const files = readdirSync(dir);
		for (const file of files) {
			const filePath = join(dir, file);
			if (file.endsWith(".ts")) {
				const result = loadSchemaFile(filePath);
				if (result) schemas.push(result);
				else errors.push({ filePath, message: "Failed to load schema" });
			} else if (file.endsWith(".json")) {
				try {
					const result = loadJsonSchemaFile(filePath);
					if (result) schemas.push(result);
				} catch (e) {
					errors.push({
						filePath,
						message: `Failed to load schema: ${e instanceof Error ? e.message : String(e)}`,
					});
				}
			}
		}
	}

	return { schemas, errors };
}

function loadSchemaFile(filePath: string): LoadedSchemaDef | null {
	const jiti = createSchemaJiti();
	// Sync jiti call (jiti extends NodeRequire, so jiti(path) works synchronously)
	const mod: unknown = jiti(filePath);

	// Extract the default export (jiti sync call returns the full module namespace)
	let defaultExport: unknown = mod;
	if (mod !== null && typeof mod === "object" && "default" in mod) {
		defaultExport = (mod as Record<string, unknown>).default;
	}

	// Accept either:
	// - default: { namespace: string, schema: TSchema }
	// - default: TSchema (namespace defaults to filename)
	let namespace: string;
	let schema: unknown;
	if (defaultExport !== null && typeof defaultExport === "object" && "schema" in defaultExport) {
		const obj = defaultExport as Record<string, unknown>;
		namespace = typeof obj.namespace === "string" ? obj.namespace : basename(filePath, ".ts");
		schema = obj.schema;
	} else {
		namespace = basename(filePath, ".ts");
		schema = defaultExport;
	}

	if (!schema || typeof schema !== "object") return null;
	return { schemaId: basename(filePath, ".ts"), namespace, schema, filePath };
}

/**
 * Load a JSON Schema file (.json) from a schemas/ directory.
 * Accepts the same two shapes as the .ts loader:
 * - default: { namespace: string, schema: JSON Schema }
 * - default: bare JSON Schema object (namespace defaults to filename)
 * Throws with a diagnostic message on any invalid shape (caller surfaces it
 * in the errors list).
 */
function loadJsonSchemaFile(filePath: string): LoadedSchemaDef | null {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(filePath, "utf-8"));
	} catch (e) {
		throw new Error(`unparseable JSON: ${e instanceof Error ? e.message : String(e)}`);
	}
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

/** Discover and load custom validators from standard locations. */
export function loadCustomValidators(cwd: string, agentDir?: string): CustomValidator[] {
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
				const mod: unknown = jiti(filePath);
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
