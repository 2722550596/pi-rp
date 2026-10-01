import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "../../vitest.base.ts";

export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			environment: "node",
			testTimeout: 30_000,
			env: { PI_OFFLINE: "1" },
		},
		resolve: {
			alias: [
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
