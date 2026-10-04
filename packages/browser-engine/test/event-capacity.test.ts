import { expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../../coding-agent/src/core/agent-session.ts";
import { subscribeHarnessEvents } from "../src/harness-events.ts";

it("bounds each listener queue at exactly 1024 pending session events", async () => {
	let emit: ((event: AgentSessionEvent) => void) | undefined;
	const session = {
		subscribe(listener: (event: AgentSessionEvent) => void) {
			emit = listener;
			return () => {
				emit = undefined;
			};
		},
	};
	const errors: Array<{ code: string; dropped?: true }> = [];
	const listener = vi.fn();
	subscribeHarnessEvents(session, "writer", (error) => errors.push(error))(listener);
	const event = { type: "agent_start" } as AgentSessionEvent;
	for (let index = 0; index < 1024; index++) emit?.(event);
	expect(errors).toEqual([]);
	expect(listener).not.toHaveBeenCalled();
	emit?.(event);
	expect(errors).toEqual([]);
	await Promise.resolve();
	expect(errors).toEqual([
		{
			code: "subscriber_overflow",
			message: "subscriber queue reached capacity; dropped=true",
			sessionId: "writer",
			dropped: true,
		},
	]);
	expect(listener).not.toHaveBeenCalled();
});
