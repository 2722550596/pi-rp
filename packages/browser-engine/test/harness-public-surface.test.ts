import { describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../../coding-agent/src/core/agent-session.ts";
import { createAskBroker, type HostQuestionRequested } from "../src/ask-broker.ts";
import type { CreateBrowserHarnessOptions } from "../src/extended-harness.ts";
import { subscribeHarnessEvents } from "../src/harness-events.ts";
import { createPiHarnessHost } from "../src/host.ts";

function fakeSession() {
	let current: ((event: AgentSessionEvent) => void) | undefined;
	const unsubscribe = vi.fn(() => {
		current = undefined;
	});
	return {
		session: {
			subscribe(listener: (event: AgentSessionEvent) => void) {
				current = listener;
				return unsubscribe;
			},
		},
		emit(event: AgentSessionEvent) {
			current?.(event);
		},
		unsubscribe,
	};
}

const event = { type: "agent_start" } as AgentSessionEvent;

describe("browser harness event subscriptions", () => {
	it("delivers ordered session envelopes asynchronously and unsubscribes idempotently", async () => {
		const fixture = fakeSession();
		const subscribe = subscribeHarnessEvents(fixture.session, "writer");
		const received: Array<{ sequence: number; sessionId: string }> = [];
		const unsubscribe = subscribe((envelope) => received.push(envelope));
		fixture.emit(event);
		fixture.emit(event);
		expect(received).toEqual([]);
		await Promise.resolve();
		expect(received.map(({ sequence }) => sequence)).toEqual([1, 2]);
		expect(received.map(({ sessionId }) => sessionId)).toEqual(["writer", "writer"]);
		unsubscribe();
		unsubscribe();
		expect(fixture.unsubscribe).toHaveBeenCalledTimes(1);
	});

	it("stops a full subscriber queue and reports dropped events asynchronously", async () => {
		const fixture = fakeSession();
		const errors: Array<{ code: string; sessionId: string; dropped?: true }> = [];
		const subscribe = subscribeHarnessEvents(fixture.session, "chat", (error) => errors.push(error), 2);
		const listener = vi.fn();
		const cancel = subscribe(listener);
		fixture.emit(event);
		fixture.emit(event);
		fixture.emit(event);
		expect(errors).toEqual([]);
		await Promise.resolve();
		expect(errors).toEqual([
			{
				code: "subscriber_overflow",
				sessionId: "chat",
				message: "subscriber queue reached capacity; dropped=true",
				dropped: true,
			},
		]);
		expect(listener).not.toHaveBeenCalled();
		fixture.emit(event);
		expect(errors).toHaveLength(1);
		cancel();
	});

	it("deactivates a subscriber when its callback throws", async () => {
		const fixture = fakeSession();
		const errors: string[] = [];
		const subscribe = subscribeHarnessEvents(fixture.session, "screenwriter", (error) => errors.push(error.code));
		const listener = vi.fn(() => {
			throw new Error("broken listener");
		});
		subscribe(listener);
		fixture.emit(event);
		expect(listener).not.toHaveBeenCalled();
		await Promise.resolve();
		expect(listener).toHaveBeenCalledTimes(1);
		await Promise.resolve();
		fixture.emit(event);
		expect(listener).toHaveBeenCalledTimes(1);
		expect(errors).toEqual(["subscriber_error"]);
		expect(fixture.unsubscribe).toHaveBeenCalledTimes(1);
	});
});

describe("browser host ask broker", () => {
	it("routes an answer to the pending execution promise and rejects unknown or expired ids", async () => {
		const requests: HostQuestionRequested[] = [];
		const broker = createAskBroker("writer", (request) => requests.push(request));
		const pending = broker.ask("Approve this draft?");
		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({
			type: "host_question",
			sessionId: "writer",
			question: "Approve this draft?",
		});
		expect(broker.answer("wrong-id", "yes")).toBe(false);
		expect(broker.answer(requests[0]!.questionId, "keep editing")).toBe(true);
		await expect(pending).resolves.toBe("keep editing");
		expect(broker.answer(requests[0]!.questionId, "yes")).toBe(false);
	});

	it("removes aborted and disposed pending requests without answering them", async () => {
		const requests: HostQuestionRequested[] = [];
		const broker = createAskBroker("chat", (request) => requests.push(request));
		const controller = new AbortController();
		const aborted = broker.ask("continue?", controller.signal);
		controller.abort();
		await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
		expect(broker.answer(requests[0]!.questionId, "yes")).toBe(false);
		const pending = broker.ask("ready?");
		broker.dispose("session disposed");
		await expect(pending).rejects.toThrow("session disposed");
		expect(broker.answer(requests[1]!.questionId, "yes")).toBe(false);
	});

	it("does not register failed creations and reserves an id while creation is pending", async () => {
		const { promise, reject } = Promise.withResolvers<CreateBrowserHarnessOptions>();
		const host = createPiHarnessHost({ createHarnessOptions: () => promise });
		const creating = host.createSession("writer");
		await expect(host.createSession("writer")).rejects.toThrow("already exists");
		reject(new Error("assembly failed"));
		await expect(creating).rejects.toThrow("assembly failed");
		expect(host.getSession("writer")).toBeUndefined();
		expect(host.listSessions()).toEqual([]);
		await host.dispose();
	});
});
