/**
 * streamFnOnly 构建的空 provider 目录（替换 browser-catalog.ts，build.mjs `streamFnOnlyPlugin`）。
 * 模型全由宿主注入并经 streamFn 调用，内置五家的模型表（约 180 KB）用不上。导出面与 browser-catalog.ts 一致。
 */

import type { Provider } from "../../../ai/src/models.ts";

export function builtinProviders(): Provider[] {
	return [];
}

export function getBuiltinModelDataGeneratedAt(): number | undefined {
	return undefined;
}

export function radiusProvider(): Provider {
	throw new Error("pi-harness: radius gateway providers are not available in the browser bundle");
}
