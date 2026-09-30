/**
 * Browser shim for `node:events` / `events`（15-F §5.5 开缝清单）。
 *
 * 涉足方：http-dispatcher 的 undici dispatcher error-listener 绑定（浏览器剖面
 * configure 路径不可达）与 event-bus-node（禁入文件）。实现保持真实 EventEmitter
 * 语义的最小面，`instanceof EventEmitter` 判定不致误伤。
 */

type EventListener = (...args: unknown[]) => void;

export class EventEmitter {
	private readonly listeners = new Map<string, EventListener[]>();

	on(event: string, listener: EventListener): this {
		const existing = this.listeners.get(event) ?? [];
		existing.push(listener);
		this.listeners.set(event, existing);
		return this;
	}

	once(event: string, listener: EventListener): this {
		const wrapped: EventListener = (...args) => {
			this.off(event, wrapped);
			listener(...args);
		};
		return this.on(event, wrapped);
	}

	off(event: string, listener: EventListener): this {
		this.listeners.set(
			event,
			(this.listeners.get(event) ?? []).filter((entry) => entry !== listener),
		);
		return this;
	}

	removeListener(event: string, listener: EventListener): this {
		return this.off(event, listener);
	}

	emit(event: string, ...args: unknown[]): boolean {
		const registered = this.listeners.get(event) ?? [];
		for (const listener of [...registered]) listener(...args);
		return registered.length > 0;
	}
}

export default EventEmitter;
