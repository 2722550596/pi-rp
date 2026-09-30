/**
 * Browser shim for `node:crypto` / `crypto`（15-F §5.5 开缝清单）。
 *
 * 随机面直接落在 Web Crypto（`crypto.randomUUID` 在 Node ≥16.7 与全部常青浏览器
 * 同为标准面；node 剖面不经本模块，字节格式不变——同为 RFC 4122 v4）。
 * `createHash` 无 Web 等价物：涉足方（models-store 修订戳等）在浏览器剖面走
 * StorageBackend 注入实现的对应方法，命中本 shim 即装配错误。
 */

export function randomUUID(): `${string}-${string}-${string}-${string}-${string}` {
	const cryptoApi = globalThis.crypto;
	if (!cryptoApi?.randomUUID) {
		throw new Error("pi-harness: crypto.randomUUID unavailable (secure context required)");
	}
	return cryptoApi.randomUUID();
}

export function randomBytes(byteLength: number): Uint8Array {
	const cryptoApi = globalThis.crypto;
	if (!cryptoApi?.getRandomValues) {
		throw new Error("pi-harness: crypto.getRandomValues unavailable (secure context required)");
	}
	const bytes = new Uint8Array(byteLength);
	cryptoApi.getRandomValues(bytes);
	return bytes;
}

export function createHash(_algorithm: string): never {
	throw new Error(
		"pi-harness: node:crypto createHash has no browser implementation; inject a StorageBackend-backed alternative at the assembly entry",
	);
}

const cryptoApi = {
	randomUUID,
	randomBytes,
	createHash,
};

export default cryptoApi;
