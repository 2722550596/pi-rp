/**
 * Browser-profile schema loader — alias target for `packages/coding-agent/src/state/schema-loader.ts`
 * (build.mjs workspace alias; node builds untouched).
 *
 * Disk schema discovery walks jiti (jiti/static + extensions/loader 的模块别名表)——node
 * 专属通道（A2 禁入链）。浏览器剖面的 state schema 走打包/注入形态，磁盘发现协商为空集
 * （契约 §4 原则 2：协商禁用而非运行时报错——空集 = 无磁盘 schema 可载）。
 */
import type { CustomValidator } from "../../coding-agent/src/state/schema-validator.ts";

/** Browser-profile shape of schema-loader's discovery result (empty = negotiated absence). */
export interface LoadedSchemaDef {
	schemaId: string;
	namespace: string;
	[name: string]: unknown;
}

export interface LoadedSchemaDefs {
	schemas: LoadedSchemaDef[];
	diagnostics: Array<{ type: string; message: string; path?: string }>;
}

const EMPTY: LoadedSchemaDefs = { schemas: [], diagnostics: [] };

export async function loadSchemaDefs(_cwd: string, _agentDir?: string): Promise<LoadedSchemaDefs> {
	return EMPTY;
}

export async function loadCustomValidators(_cwd: string, _agentDir?: string): Promise<CustomValidator[]> {
	return [];
}

export type { CustomValidator };
