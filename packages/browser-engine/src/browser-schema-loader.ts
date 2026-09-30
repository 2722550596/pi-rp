/**
 * Browser-profile schema loader — alias target for `packages/coding-agent/src/state/schema-loader.ts`
 * (build.mjs WORKSPACE_ALIAS_MAP; node builds untouched).
 *
 * 重定义（18 号 §2.5）：从「恒空集 stub」升级为 storage + inline 参数化的 JSON-only 实现。
 * 磁盘发现只走 `.json` 分支（经 StorageBackend 扫描，格式与 node 逐字节一致）；`.ts`
 * schema/validator 属 jiti 域 = 协商禁用（契约 §3.6）：遇到 `.ts` 记一条 warn 级
 * mergeDiagnostics 提示后跳过，不报错——「协商禁用而非运行时报错」。
 *
 * 解析与内联合并逻辑来自共享纯核 `state/schema-json.ts`（与 node 真身零漂移）；类型权威
 * 也在该文件（type-only 复用，bundle 期擦除）。`loadCustomValidators` 恒 []（jiti 协商禁用）。
 */
import { NodeStorageBackend } from "@earendil-works/pi-agent-core/node";
import { getAgentDir, getProjectConfigDirFor } from "../../coding-agent/src/config.ts";
import {
	type LoadedSchemaDef,
	type LoadedSchemaDefs,
	type LoadSchemaDefsOptions,
	mergeInlineSchemaDefs,
	parseJsonSchemaDef,
} from "../../coding-agent/src/state/schema-json.ts";
import type { CustomValidator } from "../../coding-agent/src/state/schema-validator.ts";
import { join } from "../../coding-agent/src/utils/node-globals.ts";

export type {
	LoadedSchemaDef,
	LoadedSchemaDefs,
	LoadSchemaDefsOptions,
	SchemaDefSource,
	SchemaMergeDiagnostic,
} from "../../coding-agent/src/state/schema-json.ts";

const SCHEMA_DIR = "schemas";

/** Discover and load schema definitions: `.json` from the storage seam + inline sources. */
export async function loadSchemaDefs(
	cwd: string,
	agentDir?: string,
	options?: LoadSchemaDefsOptions,
): Promise<LoadedSchemaDefs> {
	const { storage = NodeStorageBackend.shared, configDir, inline } = options ?? {};
	const resolvedAgentDir = agentDir ?? getAgentDir();
	const dirs = [join(resolvedAgentDir, SCHEMA_DIR), getProjectConfigDirFor(cwd, configDir, SCHEMA_DIR)];
	const schemas: LoadedSchemaDef[] = [];
	const errors: LoadedSchemaDefs["errors"] = [];
	const tsSkipHints: Array<{ source: string; message: string }> = [];

	for (const dir of dirs) {
		if (!storage.existsSync(dir)) continue;
		const entries: Array<{ name: string; isFile: boolean; isDirectory: boolean; isSymbolicLink?: boolean }> =
			storage.readdirSync(dir);
		for (const entry of entries) {
			const file = entry.name;
			const filePath = join(dir, file);
			if (file.endsWith(".ts")) {
				// jiti 域协商禁用：提示后跳过，不抛错（契约 §3.6）。
				tsSkipHints.push({
					source: filePath,
					message: `TypeScript schema "${file}" skipped: .ts validators are negotiated absent on this profile (JSON schemas only)`,
				});
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

	if (inline && inline.length > 0) {
		const merged = mergeInlineSchemaDefs(schemas, inline);
		return {
			schemas: merged.schemas,
			errors: [...errors, ...merged.errors],
			mergeDiagnostics:
				merged.mergeDiagnostics.length > 0 || tsSkipHints.length > 0
					? [...merged.mergeDiagnostics, ...tsSkipHints.map((hint) => ({ level: "warning" as const, ...hint }))]
					: [],
		};
	}

	if (tsSkipHints.length > 0) {
		return {
			schemas,
			errors,
			mergeDiagnostics: tsSkipHints.map((hint) => ({ level: "warning" as const, ...hint })),
		};
	}

	return { schemas, errors };
}

/** Custom validators are jiti-domain: negotiated absent on this profile (contract §3.6). */
export async function loadCustomValidators(_cwd: string, _agentDir?: string): Promise<CustomValidator[]> {
	return [];
}

export type { CustomValidator };
