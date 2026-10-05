import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { getModel, streamSimple } from "../src/compat.ts";
import type { Context, Model, SimpleStreamOptions, Tool } from "../src/types.ts";

interface AnthropicToolChoicePayload {
	tool_choice?: { type: string; name?: string };
}

class PayloadCaptured extends Error {
	constructor() {
		super("payload captured");
		this.name = "PayloadCaptured";
	}
}

function makeContext(): Context {
	const tools: Tool[] = [
		{
			name: "ping",
			description: "Ping tool",
			parameters: Type.Object({ ok: Type.Boolean() }),
		},
	];
	return {
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
		tools,
	};
}

async function capturePayload(options?: SimpleStreamOptions): Promise<AnthropicToolChoicePayload> {
	const base = getModel("anthropic", "claude-sonnet-4-5")!;
	const model: Model<"anthropic-messages"> = { ...base, baseUrl: "http://127.0.0.1:9" };

	let captured: AnthropicToolChoicePayload | undefined;
	const s = streamSimple(model, makeContext(), {
		...options,
		apiKey: "fake-key",
		onPayload: (payload) => {
			captured = payload as AnthropicToolChoicePayload;
			throw new PayloadCaptured();
		},
	});
	await s.result().catch((error) => {
		if (!(error instanceof PayloadCaptured)) throw error;
	});
	expect(captured).toBeDefined();
	return captured!;
}

describe("anthropic-messages tool_choice", () => {
	it('maps neutral toolChoice "required" to Anthropic "any"', async () => {
		const payload = await capturePayload({ toolChoice: "required" });
		expect(payload.tool_choice).toEqual({ type: "any" });
	});

	it('maps neutral toolChoice "none" to Anthropic "none"', async () => {
		const payload = await capturePayload({ toolChoice: "none" });
		expect(payload.tool_choice).toEqual({ type: "none" });
	});

	it("maps neutral named-tool choice to Anthropic tool shape", async () => {
		const payload = await capturePayload({ toolChoice: { type: "tool", name: "ping" } });
		expect(payload.tool_choice).toEqual({ type: "tool", name: "ping" });
	});

	it("omits tool_choice when toolChoice is unset", async () => {
		const payload = await capturePayload();
		expect(payload.tool_choice).toBeUndefined();
	});
});
