export interface HostQuestionRequested {
	readonly type: "host_question";
	readonly sessionId: string;
	readonly questionId: string;
	readonly question: string;
}

export interface AskBroker {
	ask(question: string, signal?: AbortSignal): Promise<string>;
	answer(questionId: string, answer: string): boolean;
	dispose(reason?: string): void;
}

type PendingAsk = {
	resolve(answer: string): void;
	reject(error: Error): void;
	signal?: AbortSignal;
	onAbort?: () => void;
};

export function createAskBroker(sessionId: string, onQuestion: (event: HostQuestionRequested) => void): AskBroker {
	let disposed = false;
	const pending = new Map<string, PendingAsk>();
	return {
		ask(question, signal) {
			const questionId = `${sessionId}:question:${globalThis.crypto.randomUUID()}`;
			const { promise, resolve, reject } = Promise.withResolvers<string>();
			const onAbort = () => {
				pending.delete(questionId);
				reject(new DOMException("The operation was aborted", "AbortError"));
			};
			pending.set(questionId, { resolve, reject, signal, onAbort });
			signal?.addEventListener("abort", onAbort, { once: true });
			try {
				onQuestion({ type: "host_question", sessionId, questionId, question });
			} catch (error) {
				pending.delete(questionId);
				signal?.removeEventListener("abort", onAbort);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
			return promise;
		},
		answer(questionId, answer) {
			const item = pending.get(questionId);
			if (!item) return false;
			pending.delete(questionId);
			if (item.onAbort) item.signal?.removeEventListener("abort", item.onAbort);
			item.resolve(answer);
			return true;
		},
		dispose(reason = "pi-harness: ask broker disposed") {
			if (disposed) return;
			disposed = true;
			for (const [questionId, item] of pending) {
				pending.delete(questionId);
				if (item.onAbort) item.signal?.removeEventListener("abort", item.onAbort);
				item.reject(new Error(reason));
			}
		},
	};
}
