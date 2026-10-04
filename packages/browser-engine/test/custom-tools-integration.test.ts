import { Type } from "typebox";
import { expect, it } from "vitest";
import { convertToLlm } from "../../coding-agent/src/core/messages.ts";
import { createHarnessWithExtensions } from "../../coding-agent/test/test-harness.ts";
import { createAskBroker, type HostQuestionRequested } from "../src/ask-broker.ts";
import { createBrowserCustomToolFactory } from "../src/custom-tools.ts";

it("awaits custom tools, forwards progress, appends policy-aware messages, and resumes the same tool loop", async () => {
	const { promise: requested, resolve: reportQuestion } = Promise.withResolvers<HostQuestionRequested>();
	const broker = createAskBroker("integration-session", reportQuestion);
	let asynchronousCalls = 0;
	let synchronousCalls = 0;
	const extensionFactory = createBrowserCustomToolFactory(
		[
			{
				definition: {
					name: "ask_tool",
					label: "Ask tool",
					description: "Wait for the host before completing.",
					parameters: Type.Object({}),
				},
				async handler(_toolCallId, _params, context, onUpdate) {
					asynchronousCalls += 1;
					onUpdate?.({ content: [{ type: "text", text: "waiting" }], details: { phase: "ask" } });
					context.appendMessage({
						customType: "test.policy-message",
						content: [{ type: "text", text: "policy-visible snapshot" }],
						display: false,
						details: { snapshot: 7 },
					});
					context.appendMessage({
						customType: "test.hidden-message",
						content: [{ type: "text", text: "excluded snapshot" }],
						display: false,
					});
					const answer = await context.askHost("May I continue?");
					return { content: [{ type: "text", text: answer }], details: { resumed: true } };
				},
			},
			{
				definition: {
					name: "sync_tool",
					label: "Sync tool",
					description: "Return synchronously.",
					parameters: Type.Object({}),
				},
				handler() {
					synchronousCalls += 1;
					return { content: [{ type: "text", text: "sync result" }] };
				},
			},
		],
		[
			{
				customType: "test.policy-message",
				policy: { context: "include", llmRole: "user", compaction: "exclude" },
			},
			{
				customType: "test.hidden-message",
				policy: { context: "exclude", llmRole: "user", compaction: "exclude" },
			},
		],
		"integration-session",
		broker,
	);
	const harness = await createHarnessWithExtensions({
		responses: [
			{ toolCalls: [{ id: "ask-call", name: "ask_tool", args: {} }] },
			{ toolCalls: [{ id: "sync-call", name: "sync_tool", args: {} }] },
			"done",
		],
		extensionFactories: [extensionFactory],
	});
	harness.agent.convertToLlm = (messages) =>
		convertToLlm(messages, (customType) => harness.session.extensionRunner.getCustomTypePolicy(customType));
	try {
		let runFinished = false;
		const run = harness.session.prompt("start").then(() => {
			runFinished = true;
		});
		const question = await requested;
		expect(question).toMatchObject({
			type: "host_question",
			sessionId: "integration-session",
			question: "May I continue?",
		});
		expect(runFinished).toBe(false);
		expect(broker.answer(question.questionId, "approved")).toBe(true);
		await run;

		expect(asynchronousCalls).toBe(1);
		expect(synchronousCalls).toBe(1);
		expect(harness.faux.callCount).toBe(3);
		expect(harness.eventsOfType("tool_execution_update")).toHaveLength(1);
		const nextRequest = JSON.stringify(harness.faux.contexts[1]!.messages);
		expect(nextRequest).toContain("policy-visible snapshot");
		expect(nextRequest).not.toContain("excluded snapshot");
		const llmMessages = convertToLlm(harness.session.messages, (customType) =>
			harness.session.extensionRunner.getCustomTypePolicy(customType),
		);
		const llmPrompt = JSON.stringify(llmMessages);
		expect(llmPrompt).toContain("policy-visible snapshot");
		expect(llmPrompt).not.toContain("excluded snapshot");
		const appendedEntries = harness.sessionManager.getBranch().filter((entry) => entry.type === "custom_message");
		expect(appendedEntries).toHaveLength(2);
		expect(harness.eventsOfType("agent_start")).toHaveLength(1);
	} finally {
		broker.dispose("test complete");
		harness.cleanup();
	}
});
