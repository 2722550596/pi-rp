import { expect, it } from "vitest";
import { createAskBroker } from "../src/ask-broker.ts";

it("does not reuse expired question IDs when a session id is recreated", async () => {
	const firstRequests: string[] = [];
	const firstBroker = createAskBroker("writer", ({ questionId }) => firstRequests.push(questionId));
	const firstPending = firstBroker.ask("old request");
	firstBroker.dispose("session closed");
	await expect(firstPending).rejects.toThrow("session closed");

	const secondRequests: string[] = [];
	const secondBroker = createAskBroker("writer", ({ questionId }) => secondRequests.push(questionId));
	const secondPending = secondBroker.ask("new request");
	expect(secondRequests[0]).not.toBe(firstRequests[0]);
	expect(firstRequests[0]).toMatch(/^writer:question:[0-9a-f-]{36}$/);
	expect(secondBroker.answer(firstRequests[0]!, "stale answer")).toBe(false);
	expect(secondBroker.answer(secondRequests[0]!, "new answer")).toBe(true);
	await expect(secondPending).resolves.toBe("new answer");
	secondBroker.dispose();
});
