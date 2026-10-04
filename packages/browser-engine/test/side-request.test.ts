import { expect, it } from "vitest";
import type { ExtensionContext } from "../../coding-agent/src/core/extensions/types.ts";
import { fauxModel } from "../../coding-agent/test/test-harness.ts";
import { completeBrowserSideRequest } from "../src/side-request.ts";

it("sends only the explicit side prompt with an empty system prompt and selected model", async () => {
	const requests: Array<Parameters<ExtensionContext["completeSideRequest"]>[0]> = [];
	const extension = {
		model: fauxModel,
		modelRegistry: { getAll: () => [fauxModel] },
		settings: { memory: { autoretain: { models: { smol: "faux/faux-1" } } } },
		async completeSideRequest(options: Parameters<ExtensionContext["completeSideRequest"]>[0]) {
			requests.push(options);
			return { content: [{ type: "text", text: "native side response" }] };
		},
	} as unknown as ExtensionContext;
	const answer = await completeBrowserSideRequest(extension, "explicit side prompt", {
		maxTokens: 64,
		label: "side request",
	});

	expect(answer).toBe("native side response");
	expect(requests).toHaveLength(1);
	expect(requests[0]).toMatchObject({
		model: fauxModel,
		context: {
			systemPrompt: "",
			messages: [{ role: "user", content: "explicit side prompt" }],
		},
		maxTokens: 64,
		label: "side request",
	});
});

it("uses the requested default model and rejects a side request aborted before dispatch", async () => {
	const defaultModel = { ...fauxModel, id: "faux-default" };
	const requests: Array<Parameters<ExtensionContext["completeSideRequest"]>[0]> = [];
	const extension = {
		model: fauxModel,
		modelRegistry: { getAll: () => [fauxModel, defaultModel] },
		settings: { memory: { autoretain: { models: { default: "faux/faux-default" } } } },
		async completeSideRequest(options: Parameters<ExtensionContext["completeSideRequest"]>[0]) {
			requests.push(options);
			return { content: [] };
		},
	} as unknown as ExtensionContext;
	await completeBrowserSideRequest(extension, "select default", { modelRole: "default", label: "model role" });
	const controller = new AbortController();
	controller.abort();
	await expect(
		completeBrowserSideRequest(extension, "cancel before dispatch", { signal: controller.signal, label: "cancel" }),
	).rejects.toMatchObject({ name: "AbortError" });

	expect(requests).toHaveLength(1);
	expect(requests[0]?.model).toBe(defaultModel);
});
