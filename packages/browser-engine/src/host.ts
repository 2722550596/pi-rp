import { type AskBroker, createAskBroker, type HostQuestionRequested } from "./ask-broker.ts";
import type { BrowserPiHarness, CreateBrowserHarnessOptions } from "./extended-harness.ts";
import { createPiHarnessWithTools } from "./extended-harness.ts";
import type { HarnessEventEnvelope, HarnessEventError } from "./harness-events.ts";

export interface CreatePiHarnessHostOptions {
	readonly createHarnessOptions: (
		sessionId: string,
	) => CreateBrowserHarnessOptions | Promise<CreateBrowserHarnessOptions>;
	readonly onError?: (error: {
		readonly sessionId?: string;
		readonly code: string;
		readonly message: string;
		readonly dropped?: true;
	}) => void;
}

export type PiHarnessHostEvent = HarnessEventEnvelope | HostQuestionRequested;
export type PiHarnessHostListener = (event: PiHarnessHostEvent) => void;

export interface PiHarnessHost {
	createSession(sessionId: string): Promise<BrowserPiHarness>;
	getSession(sessionId: string): BrowserPiHarness | undefined;
	listSessions(): readonly string[];
	disposeSession(sessionId: string): Promise<boolean>;
	answerQuestion(sessionId: string, questionId: string, answer: string): boolean;
	subscribe(listener: PiHarnessHostListener): () => void;
	dispose(): Promise<void>;
}

const EVENT_CAPACITY = 1024;
type HostListenerState = {
	listener: PiHarnessHostListener;
	queue: PiHarnessHostEvent[];
	head: number;
	active: boolean;
	scheduled: boolean;
};

type SessionOwnership = { readonly manager: object; readonly promptScope: object };

function eventError(
	onError: CreatePiHarnessHostOptions["onError"],
	error:
		| HarnessEventError
		| { readonly sessionId?: string; readonly code: string; readonly message: string; readonly dropped?: true },
): void {
	try {
		onError?.(error);
	} catch (reportError) {
		console.error("pi-harness: host error reporter failed", reportError);
	}
}

export function createPiHarnessHost(options: CreatePiHarnessHostOptions): PiHarnessHost {
	const sessions = new Map<string, BrowserPiHarness>();
	const creating = new Map<string, Promise<BrowserPiHarness>>();
	const unsubscriptions = new Map<string, () => void>();
	const brokers = new Map<string, AskBroker>();
	const sequences = new Map<string, number>();
	const ownership = new Map<string, SessionOwnership>();
	const managerOwners = new WeakMap<object, string>();
	const promptScopeOwners = new WeakMap<object, string>();
	const listeners = new Set<HostListenerState>();
	let disposed = false;

	const emit = (event: PiHarnessHostEvent) => {
		for (const state of listeners) {
			if (!state.active) continue;
			if (state.queue.length - state.head >= EVENT_CAPACITY) {
				state.active = false;
				state.queue.length = 0;
				state.head = 0;
				listeners.delete(state);
				queueMicrotask(() =>
					eventError(options.onError, {
						...("sessionId" in event ? { sessionId: event.sessionId } : {}),
						code: "subscriber_overflow",
						message: "subscriber queue reached capacity; dropped=true",
						dropped: true,
					}),
				);
				continue;
			}
			state.queue.push(event);
			if (state.scheduled) continue;
			state.scheduled = true;
			queueMicrotask(() => {
				state.scheduled = false;
				while (state.active && state.head < state.queue.length) {
					const next = state.queue[state.head++]!;
					try {
						state.listener(next);
					} catch (error) {
						state.active = false;
						state.queue.length = 0;
						state.head = 0;
						listeners.delete(state);
						eventError(options.onError, {
							...("sessionId" in next ? { sessionId: next.sessionId } : {}),
							code: "subscriber_error",
							message: error instanceof Error ? error.message : String(error),
						});
					}
				}
				if (state.head === state.queue.length) {
					state.queue.length = 0;
					state.head = 0;
				}
			});
		}
	};

	const createSession = (sessionId: string): Promise<BrowserPiHarness> => {
		if (disposed) return Promise.reject(new Error("pi-harness: host is disposed"));
		if (typeof sessionId !== "string" || !sessionId.trim()) {
			return Promise.reject(new Error("pi-harness: sessionId must be a non-empty string"));
		}
		if (sessions.has(sessionId) || creating.has(sessionId)) {
			return Promise.reject(new Error(`pi-harness: sessionId ${JSON.stringify(sessionId)} already exists`));
		}
		const creation = (async () => {
			let harness: BrowserPiHarness | undefined;
			let claimedOwnership: SessionOwnership | undefined;
			const broker = createAskBroker(sessionId, emit);
			brokers.set(sessionId, broker);
			try {
				const harnessOptions = await options.createHarnessOptions(sessionId);
				harness = await createPiHarnessWithTools(harnessOptions, {
					sessionId,
					askBroker: broker,
					onEventError: (error) => eventError(options.onError, error),
				});
				if (disposed) throw new Error("pi-harness: host was disposed during session creation");
				const manager = harness.session.sessionManager;
				const promptScope = harness.session.promptRegistryScope;
				if (!promptScope) throw new Error("pi-harness: session has no prompt registry scope");
				const managerOwner = managerOwners.get(manager);
				if (managerOwner)
					throw new Error(
						`pi-harness: session manager is already owned by session ${JSON.stringify(managerOwner)}`,
					);
				const scopeOwner = promptScopeOwners.get(promptScope);
				if (scopeOwner)
					throw new Error(
						`pi-harness: prompt registry scope is already owned by session ${JSON.stringify(scopeOwner)}`,
					);
				claimedOwnership = { manager, promptScope };
				ownership.set(sessionId, claimedOwnership);
				managerOwners.set(manager, sessionId);
				promptScopeOwners.set(promptScope, sessionId);
				const unsubscribe = harness.session.subscribe((event) => {
					const sequence = (sequences.get(sessionId) ?? 0) + 1;
					sequences.set(sessionId, sequence);
					emit({ sessionId, sequence, timestamp: Date.now(), event });
				});
				unsubscriptions.set(sessionId, unsubscribe);
				sessions.set(sessionId, harness);
				return harness;
			} catch (error) {
				brokers.delete(sessionId);
				broker.dispose("pi-harness: session creation failed");
				if (claimedOwnership) {
					ownership.delete(sessionId);
					managerOwners.delete(claimedOwnership.manager);
					promptScopeOwners.delete(claimedOwnership.promptScope);
				}
				eventError(options.onError, {
					sessionId,
					code: "create_error",
					message: error instanceof Error ? error.message : String(error),
				});
				if (harness) {
					try {
						await harness.dispose();
					} catch (disposeError) {
						eventError(options.onError, { sessionId, code: "dispose_error", message: String(disposeError) });
					}
				}
				throw error;
			} finally {
				creating.delete(sessionId);
			}
		})();
		creating.set(sessionId, creation);
		return creation;
	};

	const disposeSession = async (sessionId: string): Promise<boolean> => {
		const harness = sessions.get(sessionId);
		if (!harness) return false;
		sessions.delete(sessionId);
		unsubscriptions.get(sessionId)?.();
		unsubscriptions.delete(sessionId);
		brokers.get(sessionId)?.dispose("pi-harness: session disposed");
		brokers.delete(sessionId);
		const owned = ownership.get(sessionId);
		if (owned) {
			ownership.delete(sessionId);
			managerOwners.delete(owned.manager);
			promptScopeOwners.delete(owned.promptScope);
		}
		try {
			await harness.abort();
		} catch (error) {
			eventError(options.onError, { sessionId, code: "abort_error", message: String(error) });
		}
		try {
			await harness.dispose();
		} catch (error) {
			eventError(options.onError, { sessionId, code: "dispose_error", message: String(error) });
		}
		sequences.delete(sessionId);
		return true;
	};

	return {
		createSession,
		getSession: (sessionId) => sessions.get(sessionId),
		listSessions: () => [...sessions.keys()],
		disposeSession,
		answerQuestion: (sessionId, questionId, answer) => brokers.get(sessionId)?.answer(questionId, answer) ?? false,
		subscribe(listener) {
			if (disposed) throw new Error("pi-harness: host is disposed");
			const state: HostListenerState = { listener, queue: [], head: 0, active: true, scheduled: false };
			listeners.add(state);
			return () => {
				if (!state.active) return;
				state.active = false;
				state.queue.length = 0;
				state.head = 0;
				listeners.delete(state);
			};
		},
		async dispose() {
			if (disposed) return;
			disposed = true;
			await Promise.allSettled([...creating.values()]);
			await Promise.all([...sessions.keys()].map((id) => disposeSession(id)));
			for (const broker of brokers.values()) broker.dispose("pi-harness: host disposed");
			brokers.clear();
			for (const unsubscribe of unsubscriptions.values()) unsubscribe();
			unsubscriptions.clear();
			for (const state of listeners) {
				state.active = false;
				state.queue.length = 0;
				state.head = 0;
			}
			listeners.clear();
		},
	};
}
