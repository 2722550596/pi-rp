import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { streamSimple as anthropicStream } from "../../ai/src/api/anthropic-messages.ts";
import { getModel } from "../../ai/src/compat.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { PromptPreset } from "../src/core/prompt-preset/types.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

const model = { ...getModel("anthropic", "claude-haiku-4-5"), provider: "boundary-capture" };
const user = (content: string): AgentMessage => ({ role: "user", content, timestamp: 0 });
function assistant(content: AssistantMessage["content"] = [{ type: "text", text: "A" }]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "stop",
		timestamp: 0,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}
const preset: PromptPreset = {
	schemaVersion: 1,
	id: "boundary",
	items: [
		{ kind: "block", id: "system", content: "SYS" },
		{ kind: "history", id: "history", ops: [] },
		{ kind: "block", id: "tail", role: "user", content: "TAIL" },
	],
};
type Payload = {
	messages: Array<{ role: string; content: string | Array<{ type: string; text?: string; cache_control?: unknown }> }>;
};
const cleanup: Array<() => void> = [];
afterEach(() => {
	for (const dispose of cleanup.splice(0).reverse()) dispose();
});

async function fixture(extension?: string, selectedPreset = preset) {
	const cwd = mkdtempSync(join(tmpdir(), "pi-sdk-boundary-"));
	cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
	const agentDir = join(cwd, "agent");
	mkdirSync(agentDir, { recursive: true });
	if (extension) {
		mkdirSync(join(agentDir, "extensions"));
		writeFileSync(join(agentDir, "extensions", "context.ts"), `export default function(pi) { ${extension} }`);
	}
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	let customPrompt: string | undefined;
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		systemPromptOverride: () => customPrompt,
	});
	await loader.reload();
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "test-key" }));
	const registry = await createModelRegistry(authStorage, join(agentDir, "models.json"));
	const requests: Array<{ options: SimpleStreamOptions; context: Context; payload: Payload }> = [];
	registry.registerProvider(model.provider, {
		api: model.api,
		streamSimple: (_model, context, options) => {
			const stream = createAssistantMessageEventStream();
			void (async () => {
				try {
					let payload: Payload | undefined;
					await anthropicStream(model, context, {
						...options,
						apiKey: "test-key",
						onPayload: (value) => {
							payload = value as Payload;
							throw new Error("payload captured");
						},
					}).result();
					if (!payload) throw new Error("Expected Anthropic payload");
					// Tools carry execute closures, so only the message array is snapshotted.
					requests.push({
						options: { ...options },
						context: { ...context, messages: structuredClone(context.messages) },
						payload,
					});
					stream.end(assistant());
				} catch (error) {
					stream.end({ ...assistant(), stopReason: "error", errorMessage: String(error) });
				}
			})();
			return stream;
		},
	});
	cleanup.push(() => registry.unregisterProvider(model.provider));
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model,
		modelRuntime: getModelRuntime(registry),
		settingsManager,
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(cwd),
		inlinePresets: [{ filePath: "inline:boundary", diagnostics: [], preset: selectedPreset }],
		noTools: true,
	});
	cleanup.push(() => session.dispose());
	expect((await session.setActivePreset(selectedPreset.id)).ok).toBe(true);
	return {
		session,
		requests,
		async useCustomPrompt() {
			customPrompt = "CUSTOM";
			await loader.reload();
		},
	};
}

// B1: run the real SDK transform, extension runner, conversion and stream options channel.
describe("SDK compiled cache boundary integration", () => {
	it.each([
		["return { messages: event.messages.slice(1) };", false],
		["return { messages: [...event.messages] };", false],
		["event.messages.reverse();", false],
		["event.messages[0].content = [{ type: 'text', text: 'changed' }];", true],
	])("preserves provenance only for content edits: %s", async (body, valid) => {
		const f = await fixture(`pi.on('context', event => { ${body} });`);
		f.session.agent.state.messages = [user("H"), assistant()];
		await f.session.prompt("U");
		expect(f.requests).toHaveLength(1);
		const request = f.requests[0];
		if (valid) {
			expect(request.options.volatileFrom).toBe(3);
			expect(request.options.sourceIndices).toEqual([0, 1, 2, 3]);
		} else {
			expect(request.options).not.toHaveProperty("volatileFrom");
			expect(request.options).not.toHaveProperty("sourceIndices");
		}
	});

	it("maps held custom and excluded custom messages through a real session", async () => {
		const f = await fixture(`pi.registerCustomType('hidden', { context: 'exclude', llmRole: 'user' });`);
		f.session.agent.state.messages = [
			user("H"),
			assistant([{ type: "toolCall", id: "read", name: "read", arguments: {} }]),
			{ role: "custom", customType: "held", content: "held", display: false, timestamp: 0 },
			{ role: "custom", customType: "hidden", content: "excluded", display: false, timestamp: 0 },
			{
				role: "toolResult",
				toolCallId: "read",
				toolName: "read",
				content: [{ type: "text", text: "result" }],
				isError: false,
				timestamp: 0,
			},
		];
		await f.session.prompt("U");
		const request = f.requests[0];
		expect(request.options.sourceIndices).toEqual([0, 1, 2, 5, 3, 6]);
		expect(JSON.stringify(request.payload)).not.toContain("excluded");
		const marked = request.payload.messages.filter(
			(message) => Array.isArray(message.content) && message.content.some((block) => block.cache_control),
		);
		expect(marked).toHaveLength(1);
		expect(JSON.stringify(marked)).toContain("held");
		expect(JSON.stringify(marked)).not.toContain("TAIL");
	});

	it("does not anchor a provider tool-result group that spans the compiled boundary", async () => {
		const f = await fixture(`pi.on('context', event => {
			const tail = event.messages[event.messages.length - 1];
			Object.assign(tail, { role: 'toolResult', toolCallId: 'two', toolName: 'read', isError: false, content: [{ type: 'text', text: 'volatile result' }] });
		});`);
		f.session.agent.state.messages = [
			user("H"),
			assistant(["one", "two"].map((id) => ({ type: "toolCall", id, name: "read", arguments: {} }))),
			{
				role: "toolResult",
				toolCallId: "one",
				toolName: "read",
				content: [{ type: "text", text: "stable result" }],
				isError: false,
				timestamp: 0,
			},
		];
		await f.session.agent.continue();
		expect(f.requests).toHaveLength(1);
		const request = f.requests[0];
		expect(request.options).toHaveProperty("volatileFrom");
		const marked = request.payload.messages.filter(
			(message) => Array.isArray(message.content) && message.content.some((block) => block.cache_control),
		);
		expect(marked).toHaveLength(1);
		expect(JSON.stringify(marked)).toContain('"H"');
		expect(JSON.stringify(marked)).not.toContain("volatile result");
	});

	it("does not use synthetic tool results as a cache anchor", async () => {
		const f = await fixture();
		f.session.agent.state.messages = [
			user("H"),
			assistant([{ type: "toolCall", id: "missing", name: "read", arguments: {} }]),
		];
		await f.session.prompt("U");
		const request = f.requests[0];
		expect(request.options).toHaveProperty("volatileFrom");
		const marked = request.payload.messages.filter(
			(message) => Array.isArray(message.content) && message.content.some((block) => block.cache_control),
		);
		expect(marked).toHaveLength(1);
		expect(JSON.stringify(marked)).toContain('"H"');
		expect(JSON.stringify(marked)).not.toContain("No result provided");
	});

	// B2: metadata from the first request must not survive either early return.
	it.each(["sealed", "custom"])("clears prior request metadata for %s context", async (mode) => {
		const f = await fixture();
		await f.session.prompt("first");
		expect(f.requests[0].options).toHaveProperty("volatileFrom");
		expect(f.requests[0].options).toHaveProperty("sourceIndices");
		if (mode === "sealed") f.session.setInitialMessages([user("sealed")]);
		else await f.useCustomPrompt();
		await f.session.prompt("second");
		expect(f.requests).toHaveLength(2);
		expect(f.requests[1].options).not.toHaveProperty("volatileFrom");
		expect(f.requests[1].options).not.toHaveProperty("sourceIndices");
	});

	// B3: permanent checks describe structure, leaving byte comparison to the throwaway script.
	it("sends writer compiled roles and text without adding or splitting conversation messages", async () => {
		const writer = JSON.parse(
			readFileSync(new URL("../../../.pi/prompt-presets/writer.json", import.meta.url), "utf8"),
		) as PromptPreset;
		const f = await fixture(undefined, writer);
		f.session.agent.state.messages = [user("H"), assistant()];
		await f.session.prompt("latest");
		expect(f.requests).toHaveLength(1);
		// The completed assistant is persisted after the request; remove it for this comparison.
		f.session.agent.state.messages.pop();
		const outgoing = await f.session.getPresetInjectMessages();
		const expected = outgoing
			.filter((message) => message.role !== "system")
			.map((message) => ({
				role: message.role,
				text:
					"content" in message
						? typeof message.content === "string"
							? message.content
							: message.content
									.filter((block) => block.type === "text")
									.map((block) => block.text)
									.join("\n")
						: "",
			}));
		const actual = f.requests[0].payload.messages.map((message) => ({
			role: message.role,
			text:
				typeof message.content === "string"
					? message.content
					: message.content
							.filter((block) => block.type === "text")
							.map((block) => block.text)
							.join("\n"),
		}));
		expect(actual).toEqual(expected);
		const bounded = f.requests[0].payload;
		expect(
			bounded.messages.flatMap((message, index) =>
				Array.isArray(message.content) && message.content.some((block) => block.cache_control) ? [index] : [],
			),
		).toEqual([1]);
		let legacy: Payload | undefined;
		await anthropicStream(model, f.requests[0].context, {
			apiKey: "test-key",
			cacheRetention: "short",
			onPayload: (value) => {
				legacy = value as Payload;
				throw new Error("payload captured");
			},
		}).result();
		expect(
			legacy?.messages.flatMap((message, index) =>
				Array.isArray(message.content) && message.content.some((block) => block.cache_control) ? [index] : [],
			),
		).toEqual([2]);
		const clean = (payload: Payload) =>
			payload.messages.map((message) => ({
				...message,
				content: Array.isArray(message.content)
					? message.content.map(({ cache_control: _cache, ...block }) => block)
					: message.content,
			}));
		expect(clean(bounded)).toEqual(clean(legacy!));
	});
});
