import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { ModelRuntime } from "../../coding-agent/src/core/model-runtime.ts";
import { resolveLlmAssembly } from "../src/llm.ts";

it("initializes runtime credentials and uses the injected transport on every native request", async () => {
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	runtime.registerProvider("platform-test", {
		baseUrl: "https://platform.invalid/v1",
		api: "openai-completions",
		apiKey: "$NO_PLATFORM_TEST_KEY",
		models: [
			{
				id: "official-model",
				name: "Official model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 32768,
				maxTokens: 4096,
			},
		],
	});
	let accessToken = "first-session";
	const requests: string[] = [];
	const fetchImpl: typeof globalThis.fetch = async (_url, init) => {
		const headers = new Headers(init?.headers);
		headers.set("Authorization", `Bearer ${accessToken}`);
		requests.push(headers.get("Authorization")!);
		const chunk = (delta: Record<string, unknown>, finish_reason: string | null) =>
			`data: ${JSON.stringify({ id: "completion", object: "chat.completion.chunk", created: 1, model: "official-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
		return new Response(
			chunk({ role: "assistant", content: `delivered-${requests.length}` }, null) +
				chunk({}, "stop") +
				"data: [DONE]\n\n",
			{ headers: { "content-type": "text/event-stream" } },
		);
	};
	const model = runtime.getModel("platform-test", "official-model")!;
	const assembly = await resolveLlmAssembly(
		runtime,
		undefined,
		{ byok: [{ provider: "platform-test", apiKey: "initial-session" }], fetch: fetchImpl },
		model,
	);
	expect(runtime.hasConfiguredAuth("platform-test")).toBe(true);
	if (assembly.kind !== "gateway") throw new Error("injected native transport was not assembled");
	const context = { messages: [{ role: "user" as const, content: "Continue", timestamp: 1 }] };
	const first = await assembly.gateway.streamSimple(model, context).result();
	accessToken = "rotated-session";
	const second = await assembly.gateway.streamSimple(model, context).result();
	expect(first.stopReason).toBe("stop");
	expect(first.content).toEqual([{ type: "text", text: "delivered-1" }]);
	expect(second.stopReason).toBe("stop");
	expect(second.content).toEqual([{ type: "text", text: "delivered-2" }]);
	expect(requests).toEqual(["Bearer first-session", "Bearer rotated-session"]);
});
it("allows a model-free offline session while preserving configured-model LLM validation", async () => {
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const offline = await resolveLlmAssembly(runtime, undefined, undefined, undefined);
	expect(offline).toEqual({
		kind: "unavailable",
		reason: "pi-harness: generation unavailable (no model or LLM access configured)",
	});

	runtime.registerProvider("platform-test", {
		baseUrl: "https://platform.invalid/v1",
		api: "openai-completions",
		apiKey: "$NO_PLATFORM_TEST_KEY",
		models: [
			{
				id: "official-model",
				name: "Official model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 32768,
				maxTokens: 4096,
			},
		],
	});
	await expect(
		resolveLlmAssembly(runtime, undefined, undefined, runtime.getModel("platform-test", "official-model")),
	).rejects.toThrow("pi-harness: no LLM access configured (streamFn | proxyUrl | byok)");
});
