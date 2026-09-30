/**
 * Browser shim for `node:http` / `node:https` / `node:net` / `node:worker_threads` /
 * `node:assert` / `node:timers`（15-F §5.5 开缝清单；零散 node 面集中一处）。
 *
 * 涉足方均为 node 运行时路径（OAuth loopback 回调服务器、unix socket 传输、
 * image resize worker、断言与延时工具）——浏览器剖面不可达；命中即装配漏洞，
 * 结构化抛错。类型导入（Server/Socket/HttpsAgent）随编译擦除，不进本模块。
 */

// —— node:http ——
export class Server {
	constructor() {
		throw new Error("pi-harness: node:http Server is unavailable in the browser profile");
	}
}

export function createServer(): never {
	throw new Error(
		"pi-harness: node:http createServer is unavailable in the browser profile (OAuth loopback is a node flow)",
	);
}

export function request(): never {
	throw new Error(
		"pi-harness: node:http request is unavailable in the browser profile (global fetch is the browser transport)",
	);
}

// —— node:net ——
export function createConnection(): never {
	throw new Error(
		"pi-harness: node:net createConnection is unavailable in the browser profile (unix socket transport is node-only)",
	);
}

// —— node:worker_threads ——
export class Worker {
	constructor() {
		throw new Error(
			"pi-harness: node:worker_threads Worker is unavailable in the browser profile (image resize falls back in-process)",
		);
	}
}

export const parentPort: undefined = undefined;

export const isMainThread = true;

// —— node:assert ——
function fail(message?: string): never {
	throw new Error(`Assertion failed${message ? `: ${message}` : ""}`);
}

export function ok(value: unknown, message?: string): void {
	if (!value) fail(message);
}
export { ok as strictOk };
export function strictEqual(actual: unknown, expected: unknown, message?: string): void {
	if (actual !== expected) fail(message ?? `${String(actual)} !== ${String(expected)}`);
}
export function deepStrictEqual(actual: unknown, expected: unknown, message?: string): void {
	ok(actual === expected || JSON.stringify(actual) === JSON.stringify(expected), message);
}
export function assert(value: unknown, message?: string): void {
	ok(value, message);
}

// —— glob（package-manager 的磁盘包发现面；浏览器剖面 NullPackageManager 接管）——
// —— cross-spawn（utils/child-process.ts 的 spawnSync 兼容引用；shell 协商禁用语义）——
const crossSpawn = {
	spawn: (): never => {
		throw new Error(
			"pi-harness: cross-spawn is unavailable in the browser profile (shell capability negotiated off)",
		);
	},
	sync: (): never => {
		throw new Error(
			"pi-harness: cross-spawn is unavailable in the browser profile (shell capability negotiated off)",
		);
	},
};
export default crossSpawn;

export function globSync(): never {
	throw new Error(
		"pi-harness: glob is unavailable in the browser profile (npm/git package channel is negotiated off)",
	);
}

// —— node:timers ——
export function setTimeout(
	callback: (...args: unknown[]) => void,
	after?: number,
): ReturnType<typeof globalThis.setTimeout> {
	return globalThis.setTimeout(callback, after);
}
export function clearTimeout(timer: ReturnType<typeof globalThis.setTimeout> | undefined): void {
	if (timer !== undefined) globalThis.clearTimeout(timer);
}
