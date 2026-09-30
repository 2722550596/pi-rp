/**
 * Browser shims for `node:stream` / `stream` / `stream/promises` / `node:events` /
 * `node:util` / `node:process` 等零散内建（15-F §5.5 开缝清单）。
 *
 * 涉足方均为 node 运行时路径（rg 下载器、CLI 解析、bedrock 链）——浏览器剖面
 * 不可达；命中即装配漏洞，结构化抛错。`Readable` 以惰性占位类满足具名导入的
 * 构建期解析（tools-manager 的值导入）。
 */

export class Readable {
	constructor() {
		throw new Error("pi-harness: node:stream Readable is unavailable in the browser profile");
	}
}

export class Writable {
	constructor() {
		throw new Error("pi-harness: node:stream Writable is unavailable in the browser profile");
	}
}

export class Transform {
	constructor() {
		throw new Error("pi-harness: node:stream Transform is unavailable in the browser profile");
	}
}

export function pipeline(): never {
	throw new Error("pi-harness: stream/promises pipeline is unavailable in the browser profile");
}

export class EventEmitter {
	private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();

	on(event: string, listener: (...args: unknown[]) => void): this {
		const existing = this.listeners.get(event) ?? [];
		existing.push(listener);
		this.listeners.set(event, existing);
		return this;
	}

	off(event: string, listener: (...args: unknown[]) => void): this {
		this.listeners.set(
			event,
			(this.listeners.get(event) ?? []).filter((entry) => entry !== listener),
		);
		return this;
	}

	once(event: string, listener: (...args: unknown[]) => void): this {
		const wrapped = (...args: unknown[]) => {
			this.off(event, wrapped);
			listener(...args);
		};
		return this.on(event, wrapped);
	}

	emit(event: string, ...args: unknown[]): boolean {
		for (const listener of this.listeners.get(event) ?? []) listener(...args);
		return (this.listeners.get(event)?.length ?? 0) > 0;
	}

	removeListener(event: string, listener: (...args: unknown[]) => void): this {
		return this.off(event, listener);
	}
}

export function parseArgs(): never {
	throw new Error("pi-harness: node:util parseArgs is unavailable in the browser profile (CLI surface)");
}

export function deprecate<T>(fn: T): T {
	return fn;
}
