/**
 * Browser shim for `node:readline` / `readline`（15-F §5.5 开缝清单）。
 *
 * 唯一涉足方是 rg/fd 输出行的流式读取（node-tool-defaults 的默认实现，浏览器剖面
 * 被 createOpfsOperations 的 search/glob 绕行整体替代）。命中即装配漏洞，结构化抛错。
 */

export interface ReadlineInterface {
	close(): void;
	[Symbol.asyncIterator](): AsyncIterableIterator<string>;
}

export function createInterface(): ReadlineInterface {
	throw new Error(
		"pi-harness: node:readline is unavailable in the browser profile; inject tool Operations (search/glob bypass) at the assembly entry",
	);
}

export default { createInterface };
