import type { AgentSession, AgentSessionEvent } from "../../coding-agent/src/core/agent-session.ts";

export interface HarnessEventEnvelope {
	readonly sessionId: string;
	readonly sequence: number;
	readonly timestamp: number;
	readonly event: AgentSessionEvent;
}

export type HarnessEventListener = (event: HarnessEventEnvelope) => void;
export type HarnessEventError = {
	readonly sessionId: string;
	readonly code: string;
	readonly message: string;
	readonly dropped?: true;
};

const DEFAULT_CAPACITY = 1024;

/** Adapts synchronous AgentSession emits to isolated, bounded asynchronous listener queues. */
export function subscribeHarnessEvents(
	session: Pick<AgentSession, "subscribe">,
	sessionId: string,
	onError?: (error: HarnessEventError) => void,
	capacity = DEFAULT_CAPACITY,
): (listener: HarnessEventListener) => () => void {
	if (!Number.isSafeInteger(capacity) || capacity < 1) {
		throw new RangeError("event queue capacity must be a positive integer");
	}
	let sequence = 0;
	const report = (error: HarnessEventError) => {
		try {
			onError?.(error);
		} catch (reportError) {
			console.error("pi-harness: event error reporter failed", reportError);
		}
	};
	return (listener) => {
		let active = true;
		let unsubscribed = false;
		let scheduled = false;
		let head = 0;
		let unsubscribeSession = () => {};
		const queue: HarnessEventEnvelope[] = [];
		const unsubscribe = () => {
			active = false;
			queue.length = 0;
			head = 0;
			if (unsubscribed) return;
			unsubscribed = true;
			unsubscribeSession();
		};
		const drain = () => {
			scheduled = false;
			while (active && head < queue.length) {
				const next = queue[head++]!;
				try {
					listener(next);
				} catch (error) {
					unsubscribe();
					queueMicrotask(() =>
						report({
							sessionId,
							code: "subscriber_error",
							message: error instanceof Error ? error.message : String(error),
						}),
					);
				}
			}
			if (head === queue.length) {
				queue.length = 0;
				head = 0;
			}
		};
		const schedule = () => {
			if (scheduled || !active) return;
			scheduled = true;
			queueMicrotask(drain);
		};
		unsubscribeSession = session.subscribe((event) => {
			if (!active) return;
			if (queue.length - head >= capacity) {
				unsubscribe();
				queueMicrotask(() =>
					report({
						sessionId,
						code: "subscriber_overflow",
						message: "subscriber queue reached capacity; dropped=true",
						dropped: true,
					}),
				);
				return;
			}
			queue.push({ sessionId, sequence: ++sequence, timestamp: Date.now(), event });
			schedule();
		});
		return unsubscribe;
	};
}
