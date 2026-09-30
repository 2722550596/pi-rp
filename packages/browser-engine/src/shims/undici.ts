/**
 * Browser shim for `undici`（15-F §5.5 开缝清单）。
 *
 * 涉足方：coding-agent http-dispatcher 的连接池配置（configureHttpDispatcher——
 * 仅 CLI/rpc/main 调用；浏览器剖面 runtime 不可达）。浏览器剖面直接使用全局
 * `fetch`（BYOK 直连五家均已实测 CORS 可用）。类命中构造即装配漏洞，结构化抛错。
 */

function unavailable(api: string): never {
	throw new Error(
		`pi-harness: undici.${api} is unavailable in the browser profile (global fetch is the browser transport)`,
	);
}

export class Dispatcher {
	constructor() {
		unavailable("Dispatcher");
	}
}

export class Client extends Dispatcher {}

export class Pool extends Dispatcher {}

export class EnvHttpProxyAgent extends Dispatcher {}

export function setGlobalDispatcher(): void {
	unavailable("setGlobalDispatcher");
}

export function getGlobalDispatcher(): never {
	return unavailable("getGlobalDispatcher");
}

export function install(): void {
	unavailable("install");
}

export function fetch(): never {
	return unavailable("fetch");
}
