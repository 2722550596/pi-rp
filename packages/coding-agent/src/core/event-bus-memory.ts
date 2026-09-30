/**
 * EventBus implementation on the platform EventTarget — no Node dependencies, bundleable for browser profiles.
 *
 * Handler-error semantics match the Node implementation: a throwing handler is contained by a safe wrapper and logged,
 * never propagated into the dispatcher.
 */
import type { EventBusController } from "./event-bus.ts";

export function createMemoryEventBus(): EventBusController {
	const target = new EventTarget();
	const listeners = new Map<string, Set<(event: Event) => void>>();

	return {
		emit: (channel, data) => {
			target.dispatchEvent(new CustomEvent(channel, { detail: data }));
		},
		on: (channel, handler) => {
			const safeHandler = async (event: Event) => {
				try {
					await handler((event as CustomEvent).detail);
				} catch (err) {
					console.error(`Event handler error (${channel}):`, err);
				}
			};
			let channelListeners = listeners.get(channel);
			if (!channelListeners) {
				channelListeners = new Set();
				listeners.set(channel, channelListeners);
			}
			channelListeners.add(safeHandler);
			target.addEventListener(channel, safeHandler);
			return () => {
				channelListeners.delete(safeHandler);
				target.removeEventListener(channel, safeHandler);
			};
		},
		clear: () => {
			for (const [channel, channelListeners] of listeners) {
				for (const listener of channelListeners) {
					target.removeEventListener(channel, listener);
				}
			}
			listeners.clear();
		},
	};
}
