import { beforeEach, describe, expect, it, vi } from "vitest";
import { getModel, streamSimple } from "../src/compat.ts";
import type { Tool } from "../src/types.ts";
import { createStateUpdateToolDefinition } from "../../coding-agent/src/core/tools/state-update.ts";
import { StateManager } from "../../coding-agent/src/state/state-manager.ts";
import { SchemaValidator } from "../../coding-agent/src/state/schema-validator.ts";

// Regression: the built-in `state_update` tool's parameters must serialize to a
// JSON Schema with root `type: "object"` (and a flat string-enum `op`), because
// strict OpenAI-compatible backends (e.g. deepseek) reject the whole request with
// `400: schema must be a JSON Schema of 'type: "object"', got 'type: null'` when
// `parameters` is a TypeBox `Union` (`{ anyOf: [...] }` with no root `type`).
// This test would have caught the original bug.

const mockState = vi.hoisted(() => ({
	lastParams: undefined as unknown,
	lastClientOptions: undefined as unknown,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		constructor(options: unknown) {
			mockState.lastClientOptions = options;
		}

		chat = {
			completions: {
				create: (params: unknown) => {
					mockState.lastParams = params;
					const stream = {
						async *[Symbol.asyncIterator]() {
							yield {
								choices: [{ delta: {}, finish_reason: "stop" }],
								usage: {
									prompt_tokens: 1,
									completion_tokens: 1,
									prompt_tokens_details: { cached_tokens: 0 },
									completion_tokens_details: { reasoning_tokens: 0 },
								},
							};
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{
							data: typeof stream;
							response: { status: number; headers: Headers };
						}>;
					};
					promise.withResponse = async () => ({
						data: stream,
						response: { status: 200, headers: new Headers() },
					});
					return promise;
				},
			},
		};
	}

	return { default: FakeOpenAI };
});

describe("openai-completions state_update schema", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
		mockState.lastClientOptions = undefined;
	});

	it("serializes state_update parameters as a root object schema with a flat string-enum op", async () => {
		// Build the real built-in state_update tool definition; its `parameters` is the
		// schema that previously was a Type.Union (anyOf, no root type).
		const definition = createStateUpdateToolDefinition(new StateManager(), new SchemaValidator());
		const tool: Tool = {
			name: definition.name,
			description: definition.description,
			parameters: definition.parameters,
		};

		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
		const model = { ...baseModel, api: "openai-completions" } as const;

		await streamSimple(
			model,
			{
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
				tools: [tool],
			},
			{ apiKey: "test" },
		).result();

		const params = mockState.lastParams as {
			tools?: Array<{ function?: { parameters?: Record<string, unknown> } }>;
		};
		expect(Array.isArray(params.tools)).toBe(true);
		expect(params.tools).toHaveLength(1);

		const parameters = params.tools![0]!.function!.parameters!;

		// Root must be an object schema - the exact check strict backends enforce.
		expect(parameters.type).toBe("object");
		expect("anyOf" in parameters).toBe(false);
		expect("oneOf" in parameters).toBe(false);

		// op must be a flat string enum, not a nested anyOf of const literals.
		const op = (parameters.properties as Record<string, unknown>).op as Record<string, unknown>;
		expect(op.type).toBe("string");
		expect(op.enum).toEqual(["add", "remove", "replace", "merge"]);
		expect("anyOf" in op).toBe(false);
	});
});
