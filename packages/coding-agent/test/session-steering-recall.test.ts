import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, createAssistantMessageEventStream, type Message } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../../ai/src/compat.ts";
import type { MemoryModule } from "../../memory/src/module.ts";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

const model = { ...getModel("anthropic", "claude-haiku-4-5"), provider: "steering-capture" };
const cleanup: Array<() => void> = [];
afterEach(() => {
	for (const dispose of cleanup.splice(0).reverse()) dispose();
	vi.restoreAllMocks();
});

async function fixture() {
	const cwd = mkdtempSync(join(tmpdir(), "pi-session-steering-"));
	cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
	const agentDir = join(cwd, "agent");
	mkdirSync(agentDir);
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
	await loader.reload();
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "test-key" }));
	const registry = await createModelRegistry(authStorage, join(agentDir, "models.json"));
	const requests: Message[][] = [];
	registry.registerProvider(model.provider, {
		api: model.api,
		streamSimple: (_model, context) => {
			requests.push(structuredClone(context.messages));
			const stream = createAssistantMessageEventStream();
			const message: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "done" }],
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
			queueMicrotask(() => stream.end(message));
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
		noTools: true,
	});
	cleanup.push(() => session.dispose());
	const events: AgentSessionEvent[] = [];
	session.subscribe((event) => {
		events.push(event);
	});
	// Exercise the real session/agent pipeline with a controlled module boundary.
	const memorySlot = session as unknown as { _memoryModule?: MemoryModule };
	memorySlot._memoryModule?.dispose();
	memorySlot._memoryModule = undefined;
	return { session, requests, events, memorySlot };
}

function text(message: { content?: unknown }): string {
	return typeof message.content === "string"
		? message.content
		: Array.isArray(message.content)
			? message.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("\n")
			: "";
}

function moduleWithRecall(onSteeringMessages: MemoryModule["onSteeringMessages"]): MemoryModule {
	return { onSteeringMessages, registerSession() {}, async onLeafChange() {}, async onTurnEnd() {}, dispose() {} };
}

describe("session steering recall", () => {
	it.each(["during-run", "boundary"] as const)(
		"emits each %s batch once before recall and message delivery",
		async (path) => {
			const f = await fixture();
			f.session.agent.steeringMode = "all";
			const observed: string[] = [];
			f.session.subscribe((event) => {
				if (event.type === "steering_injected") {
					observed.push("injected");
					expect(f.session.agent.state.messages.some((message) => text(message) === "first steering")).toBe(false);
				}
				if (event.type === "message_start" && text(event.message) === "first steering") observed.push("message");
			});
			const recall = vi.fn(async () => {
				observed.push("recall");
				return {
					message: {
						customType: "rp-memories",
						content: "garden memory",
						display: false,
						details: { ids: ["history://garden"] },
					},
				};
			});
			f.memorySlot._memoryModule = moduleWithRecall(recall);
			const queue = async () => {
				await f.session.steer("first steering");
				await f.session.steer("second steering");
			};
			if (path === "boundary") {
				await f.session.prompt("start");
				await queue();
				await f.session.agent.continue();
			} else {
				let queued = false;
				f.session.agent.subscribe(async (event) => {
					if (event.type === "turn_end" && !queued) {
						queued = true;
						await queue();
					}
				});
				await f.session.prompt("start");
			}
			const injected = f.events.filter((event) => event.type === "steering_injected");
			expect(injected).toHaveLength(1);
			expect(injected[0].messages.map(text)).toEqual(["first steering", "second steering"]);
			expect(recall).toHaveBeenCalledTimes(1);
			expect(recall).toHaveBeenCalledWith(injected[0].messages);
			expect(observed).toEqual(["injected", "recall", "message"]);
			const requestText = f.requests.at(-1)!.map(text).join("\n");
			expect(requestText).toContain("garden memory");
			expect(requestText.indexOf("first steering")).toBeLessThan(requestText.indexOf("second steering"));
			expect(requestText.indexOf("second steering")).toBeLessThan(requestText.indexOf("garden memory"));
			const custom = f.session.agent.state.messages.find(
				(message) => message.role === "custom" && message.customType === "rp-memories",
			);
			expect(custom).toMatchObject({
				role: "custom",
				content: "garden memory",
				display: false,
				details: { ids: ["history://garden"] },
			});
			const entries = f.session.sessionManager.buildContextEntries();
			expect(entries.some((entry) => entry.type === "custom_message" && entry.customType === "rp-memories")).toBe(
				true,
			);
		},
	);

	it("does not trigger recall or steering events for follow-ups", async () => {
		const f = await fixture();
		const recall = vi.fn(async () => undefined);
		f.memorySlot._memoryModule = moduleWithRecall(recall);
		await f.session.followUp("follow-up");
		await f.session.prompt("start");
		expect(recall).not.toHaveBeenCalled();
		expect(f.events.filter((event) => event.type === "steering_injected")).toEqual([]);
		expect(f.requests.at(-1)!.map(text).join("\n")).toContain("follow-up");
	});

	it.each(["absent", "empty", "throws"] as const)(
		"delivers steering without injecting memories when module is %s",
		async (mode) => {
			const f = await fixture();
			const recall = vi.fn(async () => {
				if (mode === "throws") throw new Error("recall unavailable");
				return undefined;
			});
			if (mode !== "absent") f.memorySlot._memoryModule = moduleWithRecall(recall);
			const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
			await f.session.prompt("start");
			await f.session.steer("steering survives");
			await f.session.agent.continue();
			expect(f.events.filter((event) => event.type === "steering_injected")).toHaveLength(1);
			expect(f.requests.at(-1)!.map(text).join("\n")).toContain("steering survives");
			expect(
				f.session.agent.state.messages.filter(
					(message) => message.role === "custom" && message.customType === "rp-memories",
				),
			).toEqual([]);
			expect(warning).toHaveBeenCalledTimes(mode === "throws" ? 1 : 0);
		},
	);

	it("clearing queued steering prevents both injection events and recall", async () => {
		const f = await fixture();
		const recall = vi.fn(async () => undefined);
		f.memorySlot._memoryModule = moduleWithRecall(recall);
		await f.session.steer("discard me");
		f.session.clearQueue();
		await f.session.prompt("start");
		expect(recall).not.toHaveBeenCalled();
		expect(f.events.filter((event) => event.type === "steering_injected")).toEqual([]);
		expect(f.requests[0].map(text).join("\n")).not.toContain("discard me");
	});

	it("keeps queued steering across abort for a subsequent continuation", async () => {
		const f = await fixture();
		const recall = vi.fn(async () => undefined);
		f.memorySlot._memoryModule = moduleWithRecall(recall);
		await f.session.prompt("start");
		await f.session.steer("retained steering");
		await f.session.abort();
		await f.session.agent.continue();
		expect(recall).toHaveBeenCalledTimes(1);
		expect(f.events.filter((event) => event.type === "steering_injected")).toHaveLength(1);
		expect(f.requests.at(-1)!.map(text).join("\n")).toContain("retained steering");
	});

	it("uses the currently installed memory module for each new batch", async () => {
		const f = await fixture();
		const oldRecall = vi.fn(async () => undefined);
		const currentRecall = vi.fn<MemoryModule["onSteeringMessages"]>(async () => undefined);
		f.memorySlot._memoryModule = moduleWithRecall(oldRecall);
		await f.session.prompt("start");
		await f.session.steer("first batch");
		await f.session.agent.continue();
		f.memorySlot._memoryModule = undefined;
		await f.session.steer("unmounted batch");
		await f.session.agent.continue();
		f.memorySlot._memoryModule = moduleWithRecall(currentRecall);
		await f.session.steer("current batch");
		await f.session.agent.continue();
		expect(oldRecall).toHaveBeenCalledTimes(1);
		expect(currentRecall).toHaveBeenCalledTimes(1);
		expect(currentRecall.mock.calls[0][0].map((message) => text(message as { content?: unknown }))).toEqual([
			"current batch",
		]);
		expect(f.events.filter((event) => event.type === "steering_injected")).toHaveLength(3);
	});
});
