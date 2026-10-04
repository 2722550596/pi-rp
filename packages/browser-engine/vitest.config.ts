import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "../../vitest.base.ts";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const RAW_ASSET_DIR = "packages/coding-agent/src/core/export-html";

// 与 build.mjs rawContentPlugin 同语义（raw:<file> 相对仓级资产目录；<x>?raw 相对 importer）。
// vitest 不经过 build.mjs raw 资源管线，Node 单测需等价解析。
function rawContentPlugin() {
	return {
		name: "raw-content",
		resolveId(id: string, importer?: string) {
			if (id.startsWith("raw:")) return `\0raw-content:${resolve(repoRoot, RAW_ASSET_DIR, id.slice(4))}`;
			if (id.endsWith("?raw") && importer) return `\0raw-content:${resolve(dirname(importer), id.slice(0, -4))}`;
			return null;
		},
		load(id: string) {
			if (id.startsWith("\0raw-content:")) {
				return { code: `export default ${JSON.stringify(readFileSync(id.slice("\0raw-content:".length), "utf8"))}` };
			}
			return null;
		},
	};
}

export default mergeConfig(
	baseConfig,
	defineConfig({
		plugins: [rawContentPlugin()],
		test: {
			environment: "node",
			testTimeout: 30_000,
			env: { PI_OFFLINE: "1" },
		},
		resolve: {
			alias: [
				{
					find: /^@earendil-works\/pi-agent-core\/web$/,
					replacement: fileURLToPath(new URL("../agent/src/web.ts", import.meta.url)),
				},
				{
					find: /^@earendil-works\/pi-protocol$/,
					replacement: fileURLToPath(new URL("../protocol/src/index.ts", import.meta.url)),
				},
				{
					find: /^@earendil-works\/pi-session-protocol$/,
					replacement: fileURLToPath(new URL("../session-protocol/src/index.ts", import.meta.url)),
				},
			],
		},
	}),
);
