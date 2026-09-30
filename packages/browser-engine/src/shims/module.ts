/**
 * Browser shim for `node:module` / `module`（15-F §5.5 开缝清单）。
 *
 * 涉足方：photon-node wasm 装载器（browser 剖面被 stub 替代）、config.ts 的安装方式探测。
 * `createRequire` 返回一个「调用即结构化抛错」的 require 函数——模块顶层的
 * `createRequire(import.meta.url)` 求值安全（不炸 module eval），真正的 require() 调用
 * （node 专属面）命中装配漏洞时才抛。node 剖面不经本模块。
 */

export function createRequire(): () => never {
	return () => {
		throw new Error("pi-harness: require() is unavailable in the browser profile (no CommonJS module system)");
	};
}

export const isBuiltin = (_specifier: string): boolean => false;

export default { createRequire, isBuiltin };
