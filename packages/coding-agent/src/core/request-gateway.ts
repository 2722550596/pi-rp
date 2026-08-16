import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	lazyStream,
	type Model,
	type ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ModelRuntime } from "./model-runtime.ts";

/**
 * Identity of an LLM request for gateway observability and prioritization.
 *
 * `sessionId` is a placeholder ("?") until Phase 1b wires real session ids.
 */
export interface RequestIdentity {
	/** Placeholder "?"; real value from Phase 1b. */
	sessionId: string;
	/** Larger value = higher priority. 2=main loop, 1=compaction, 0=subagent. */
	priority: number;
	/** "main", "compaction", "branch-summary", "subagent". */
	label: string;
}

/**
 * Per-provider concurrency limits for the request gateway.
 *
 * A provider with no entry and no `defaultMaxConcurrency` is not gated.
 * `maxConcurrency: 0` means "no limit" (avoids the footgun of accidentally
 * blocking all requests for a provider).
 */
export interface RequestGatewayConfig {
	providers?: Record<string, { maxConcurrency: number }>;
	defaultMaxConcurrency?: number;
}

interface QueuedAcquire {
	priority: number;
	resolve: () => void;
	reject: (reason: unknown) => void;
}

/**
 * Per-provider semaphore. At most `max` requests run concurrently; the rest
 * queue and are served highest priority first. A max of `Infinity` makes the
 * gate a no-op (acquire always succeeds, release does nothing).
 */
class PerProviderGate {
	private active = 0;
	private readonly max: number;
	private queue: QueuedAcquire[] = [];

	constructor(max: number) {
		this.max = max;
	}

	async acquire(priority: number, signal?: AbortSignal): Promise<void> {
		if (this.max === Infinity) return;
		if (signal?.aborted) {
			const error = new Error("The operation was aborted");
			error.name = "AbortError";
			throw error;
		}
		if (this.active < this.max) {
			this.active++;
			return;
		}
		return new Promise<void>((resolve, reject) => {
			const entry: QueuedAcquire = { priority, resolve, reject };
			const onAbort = () => {
				const idx = this.queue.indexOf(entry);
				if (idx !== -1) this.queue.splice(idx, 1);
				const error = new Error("The operation was aborted");
				error.name = "AbortError";
				reject(error);
			};
			if (signal) {
				signal.addEventListener("abort", onAbort, { once: true });
			}
			entry.resolve = () => {
				signal?.removeEventListener("abort", onAbort);
				resolve();
			};
			const idx = this.queue.findIndex((e) => e.priority < priority);
			if (idx === -1) this.queue.push(entry);
			else this.queue.splice(idx, 0, entry);
		});
	}

	release(): void {
		if (this.max === Infinity) return;
		if (this.queue.length > 0) this.queue.shift()!.resolve();
		else this.active--;
	}
}

/**
 * Per-provider concurrency gate wrapping `ModelRuntime.streamSimple` /
 * `completeSimple`. A pure wrapper: with no configured limits every request
 * passes through untouched. Queued requests are served highest priority
 * first; aborting a queued request's signal removes it from the queue.
 */
export class RequestGateway {
	private readonly modelRuntime: ModelRuntime;
	private readonly config: RequestGatewayConfig;
	private readonly gates = new Map<string, PerProviderGate>();

	constructor(modelRuntime: ModelRuntime, config?: RequestGatewayConfig) {
		this.modelRuntime = modelRuntime;
		this.config = config ?? {};
	}

	private gateFor(providerId: string): PerProviderGate {
		let gate = this.gates.get(providerId);
		if (!gate) {
			gate = new PerProviderGate(this.maxConcurrencyFor(providerId));
			this.gates.set(providerId, gate);
		}
		return gate;
	}

	private maxConcurrencyFor(providerId: string): number {
		const max = this.config.providers?.[providerId]?.maxConcurrency ?? this.config.defaultMaxConcurrency;
		// 0 means "no limit"; unset means no gating for this provider.
		if (max === undefined || max <= 0) return Infinity;
		return max;
	}

	streamSimple(
		model: Model<Api>,
		context: Context,
		options?: ModelsSimpleStreamOptions,
		identity?: RequestIdentity,
		signal?: AbortSignal,
	): AssistantMessageEventStream {
		const gate = this.gateFor(model.provider);
		const priority = identity?.priority ?? 0;
		return lazyStream(model, async () => {
			await gate.acquire(priority, signal);
			const inner = this.modelRuntime.streamSimple(model, context, options);
			return {
				async *[Symbol.asyncIterator]() {
					try {
						yield* inner;
					} finally {
						gate.release();
					}
				},
				result: () => inner.result(),
			};
		});
	}

	async completeSimple(
		model: Model<Api>,
		context: Context,
		options?: ModelsSimpleStreamOptions,
		identity?: RequestIdentity,
		signal?: AbortSignal,
	): Promise<AssistantMessage> {
		const gate = this.gateFor(model.provider);
		const priority = identity?.priority ?? 0;
		await gate.acquire(priority, signal);
		try {
			return await this.modelRuntime.completeSimple(model, context, options);
		} finally {
			gate.release();
		}
	}
}
