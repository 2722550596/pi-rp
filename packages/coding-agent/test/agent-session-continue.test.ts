import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type Context,
	EventStream,
	getModel,
} from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function assistantMessage(text: string, overrides?: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

/**
 * /continue behavior: when the transcript ends on a user/toolResult turn the
 * agent loop continues natively and NO synthetic "Continue." message is sent
 * to the provider; when it ends on an assistant turn (or is empty) the
 * continue message is still injected. Verified against the actual request
 * payload (context.messages passed to streamFn).
 */
describe("AgentSession continueSession", () => {
	let session: AgentSession;
	let tempDir: string;
	let seenContexts: Context[] = [];

	beforeEach(async () => {
		tempDir = join(tmpdir(), `pi-continue-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		seenContexts = [];
	});

	afterEach(() => {
		if (session) {
			session.dispose();
		}
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	async function createSession(): Promise<AgentSession> {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: (_model, context) => {
				seenContexts.push(context);
				const stream = new MockAssistantStream();
				const msg = assistantMessage("Done");
				queueMicrotask(() => {
					stream.push({ type: "start", partial: msg });
					stream.push({ type: "done", reason: "stop", message: msg });
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = await createModelRegistry(authStorage, tempDir);
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: createTestResourceLoader(),
		});
		// AgentSession construction wires the extension runner asynchronously;
		// wait for it (same as createAgentSession in sdk.ts) before driving.
		await session._buildRuntimePromise;
		return session;
	}

	/** LLM-visible messages captured from the streamFn call. */
	function seenLlmMessages(): AssistantMessage[] {
		expect(seenContexts.length).toBeGreaterThan(0);
		return seenContexts[0].messages as AssistantMessage[];
	}

	it("continues from a trailing toolResult without injecting Continue.", async () => {
		const s = await createSession();
		// Simulate the post-abort mid-turn state: assistant(toolCall) → toolResult,
		// next assistant turn never happened.
		s.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "list files" }], timestamp: Date.now() },
			assistantMessage("Let me check.", {
				content: [{ type: "toolCall", id: "tc_1", name: "bash", arguments: { cmd: "ls" } }],
				stopReason: "toolUse",
			}),
			{
				role: "toolResult",
				toolCallId: "tc_1",
				toolName: "bash",
				content: [{ type: "text", text: "file-a.txt" }],
				timestamp: Date.now(),
			},
		];

		const started = await s.continueSession();
		expect(started).toBe(true);

		const llmMessages = seenLlmMessages();
		expect(llmMessages.length).toBe(3);
		const last = llmMessages[llmMessages.length - 1];
		expect(last.role).toBe("toolResult");
		// The agent state gains only the new assistant turn, no synthetic user message.
		expect(s.agent.state.messages.length).toBe(4);
		expect(s.agent.state.messages[3].role).toBe("assistant");
	});

	it("continues from a trailing user message without injecting Continue.", async () => {
		const s = await createSession();
		s.agent.state.messages = [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() }];

		await s.continueSession();

		const llmMessages = seenLlmMessages();
		expect(llmMessages.length).toBe(1);
		expect(llmMessages[0].role).toBe("user");
		expect(s.agent.state.messages.length).toBe(2);
		expect(s.agent.state.messages[1].role).toBe("assistant");
	});

	it("injects Continue. when the transcript ends on an assistant turn", async () => {
		const s = await createSession();
		s.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() },
			assistantMessage("Hi there."),
		];

		await s.continueSession();

		const llmMessages = seenLlmMessages();
		const last = llmMessages[llmMessages.length - 1];
		expect(last.role).toBe("user");
		expect((last.content as { type: string; text: string }[])[0].text).toBe("Continue.");
	});

	it("strips trailing aborted empty assistant messages, then injects Continue. for an assistant ending", async () => {
		const s = await createSession();
		s.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() },
			assistantMessage("Real response."),
			assistantMessage("", { stopReason: "aborted" }),
		];

		await s.continueSession();

		// The aborted empty assistant was popped; Continue. injected after the real one.
		const llmMessages = seenLlmMessages();
		expect(llmMessages.length).toBe(3);
		expect(llmMessages[1].role).toBe("assistant");
		expect(llmMessages[2].role).toBe("user");
		expect((llmMessages[2].content as { type: string; text: string }[])[0].text).toBe("Continue.");
	});

	it("pops an aborted assistant with only toolCall content, then continues from the prior user turn", async () => {
		const s = await createSession();
		// Abort right after a toolCall streamed but no text: contentText() is
		// empty for toolCall-only content, so the strip loop removes it (and
		// its toolCall with it — no orphan toolCall reaches the request).
		s.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "list files" }], timestamp: Date.now() },
			assistantMessage("", {
				content: [{ type: "toolCall", id: "tc_1", name: "bash", arguments: { cmd: "ls" } }],
				stopReason: "aborted",
			}),
		];

		await s.continueSession();

		const llmMessages = seenLlmMessages();
		expect(llmMessages.length).toBe(1);
		expect(llmMessages[0].role).toBe("user");
		// Agent state: user + new assistant only — aborted assistant and its
		// toolCall are gone, and no Continue. was injected.
		expect(s.agent.state.messages.length).toBe(2);
		expect(s.agent.state.messages[1].role).toBe("assistant");
	});

	it("keeps an aborted assistant with text+toolCall and injects Continue. (orphan handled downstream)", async () => {
		const s = await createSession();
		// Abort after partial text + toolCall: non-empty text keeps the message,
		// so the transcript ends on an assistant turn and Continue. is injected.
		// The orphaned toolCall is handled by downstream transformMessages
		// (synthesized "No result provided"), not by continueSession.
		s.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "list files" }], timestamp: Date.now() },
			assistantMessage("Let me check.", {
				content: [
					{ type: "text", text: "Let me check." },
					{ type: "toolCall", id: "tc_1", name: "bash", arguments: { cmd: "ls" } },
				],
				stopReason: "aborted",
			}),
		];

		await s.continueSession();

		const llmMessages = seenLlmMessages();
		expect(llmMessages.length).toBe(3);
		const last = llmMessages[llmMessages.length - 1];
		expect(last.role).toBe("user");
		expect((last.content as { type: string; text: string }[])[0].text).toBe("Continue.");
	});
});
