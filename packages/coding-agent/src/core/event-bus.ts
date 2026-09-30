/**
 * Event bus contract shared by all runtime profiles.
 *
 * Only the interface lives here; implementations are profile-specific and selected at the assembly point:
 * `event-bus-node.ts` (Node EventEmitter) and `event-bus-memory.ts` (platform EventTarget, bundleable for browser
 * profiles). Consumers only ever see the `EventBus` interface.
 */

export interface EventBus {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}

export interface EventBusController extends EventBus {
	clear(): void;
}

export { createEventBus } from "./event-bus-node.ts";
