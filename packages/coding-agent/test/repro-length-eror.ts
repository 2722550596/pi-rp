/**
 * Reproduction harness v2 - try with compaction enabled, more message types, and various edge cases.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createHarness } from "./suite/harness.ts";

function buildSessionMessages(): AgentMessage[] {
	const messages: AgentMessage[] = [];
	const ts = Date.now() - 60000;

	// Basic conversation
	messages.push({ role: "user", content: [{ type: "text", text: "Hello" }], timestamp: ts });
	messages.push({ role: "assistant", content: [{ type: "text", text: "Hi!" }], stopReason: "stop", timestamp: ts + 1000 } as AgentMessage);

	// Tool call conversation
	messages.push({ role: "user", content: [{ type: "text", text: "Read file" }], timestamp: ts + 2000 });
	messages.push({
		role: "assistant",
		content: [
			{ type: "text", text: "Reading..." },
			{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "x.ts" } },
		],
		stopReason: "toolUse",
		timestamp: ts + 3000,
	} as AgentMessage);
	messages.push({ role: "toolResult", toolCallId: "tc1", toolName: "read", content: [{ type: "text", text: "content" }], isError: false, timestamp: ts + 4000 } as AgentMessage);
	messages.push({ role: "assistant", content: [{ type: "text", text: "Done." }], stopReason: "stop", timestamp: ts + 5000 } as AgentMessage);

	// bash execution
	messages.push({ role: "bashExecution", command: "ls", output: "file.ts", exitCode: 0, timestamp: ts + 6000 } as AgentMessage);
	messages.push({ role: "user", content: [{ type: "text", text: "Run ls" }], timestamp: ts + 6500 });
	messages.push({ role: "assistant", content: [{ type: "text", text: "Listed." }], stopReason: "stop", timestamp: ts + 7000 } as AgentMessage);

	// Compaction summary (has summary instead of content)
	messages.push({
		role: "compactionSummary",
		summary: "Previous conversation about project setup.",
		tokensBefore: 50000,
		timestamp: ts + 8000,
	} as AgentMessage);

	// More messages after compaction
	messages.push({ role: "user", content: [{ type: "text", text: "Continue" }], timestamp: ts + 9000 });
	messages.push({ role: "assistant", content: [{ type: "text", text: "OK continuing..." }], stopReason: "stop", timestamp: ts + 10000 } as AgentMessage);

	// Branch summary
	messages.push({
		role: "branchSummary",
		summary: "Experimental branch work",
		fromId: "abc",
		timestamp: ts + 11000,
	} as AgentMessage);

	// Assistant message with content as string (older format)
	messages.push({ role: "user", content: "Legacy message format" as unknown as any[], timestamp: ts + 12000 });
	messages.push({ role: "assistant", content: "Legacy response" as unknown as any[], stopReason: "stop", timestamp: ts + 13000 } as AgentMessage);

	return messages;
}

async function main() {
	console.log("Creating harness...");
	const harness = await createHarness({
		withConfiguredAuth: true,
	});

	try {
		const sessionMessages = buildSessionMessages();
		harness.session.agent.state.messages = sessionMessages;
		console.log(`Agent state has ${sessionMessages.length} messages.`);

		// Simulate /prompt
		console.log("Running compilePromptMessages() [simulates /prompt]...");
		try {
			const compiled = harness.session.compilePromptMessages();
			console.log(`Compiled ${compiled.length} messages.`);
		} catch (e: unknown) {
			const err = e instanceof Error ? e : new Error(String(e));
			console.error(`compilePromptMessages FAILED: ${err.message}`);
			throw e;
		}

		// Simulate sending a new message
		console.log("Sending prompt 'test'...");
		harness.setResponses([{ role: "assistant", content: [{ type: "text", text: "OK" }] }]);
		await harness.session.prompt("test");
		console.log("SUCCESS: No error.");
	} catch (error: unknown) {
		const err = error instanceof Error ? error : new Error(String(error));
		console.error(`\nERROR: ${err.message}`);
		if (err.stack) {
			const lines = err.stack.split("\n");
			console.error(lines.slice(0, 20).join("\n"));
		}
		process.exit(1);
	} finally {
		harness.cleanup();
	}
}

main();