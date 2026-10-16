import { describe, expect, it } from "vitest";
import { streamSimple as stream } from "../src/api/anthropic-messages.ts";
import { transformMessages } from "../src/api/transform-messages.ts";
import { getModel } from "../src/compat.ts";
import type { AssistantMessage, Message, StreamOptions } from "../src/types.ts";

const model = getModel("anthropic", "claude-haiku-4-5");
const user = (content: string): Message => ({ role: "user", content, timestamp: 0 });
const assistant = (content = "A"): AssistantMessage => ({
	role: "assistant",
	content: [{ type: "text", text: content }],
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
});
type Payload = {
	messages: Array<{ role: string; content: string | Array<{ type: string; cache_control?: unknown }> }>;
	system: unknown;
};
async function capture(messages: Message[], options: StreamOptions = {}): Promise<Payload> {
	let payload: Payload | undefined;
	await stream(
		model,
		{ messages },
		{
			apiKey: "fake-key",
			cacheRetention: "short",
			...options,
			onPayload: (value) => {
				payload = value as Payload;
				throw new Error("captured");
			},
		},
	).result();
	expect(payload).toBeDefined();
	return payload!;
}
const markers = (payload: Payload) =>
	payload.messages.flatMap((message, index) =>
		Array.isArray(message.content) && message.content.some((block) => block.cache_control) ? [index] : [],
	);

describe("Anthropic compiled cache boundary", () => {
	it.each(["U2\n\nTAIL", "TAIL"])("anchors before tail %s after system extraction", async (tail) => {
		const messages: Message[] = [
			{ role: "system", content: "SYS", timestamp: 0 },
			user("H"),
			assistant(),
			user(tail),
		];
		const bounded = await capture(messages, { volatileFrom: 3 });
		expect(markers(bounded)).toEqual([1]);
		const legacy = await capture(messages);
		expect(markers(legacy)).toEqual([2]);
		const strip = (value: unknown) =>
			JSON.stringify(value, (key, item) => (key === "cache_control" ? undefined : item));
		// Cache-control normalization may wrap string content; compare the message bytes in normalized form.
		const normalize = (payload: Payload) =>
			payload.messages.map((message) => ({
				...message,
				content: typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content,
			}));
		expect(strip(normalize(bounded))).toBe(strip(normalize(legacy)));
	});
	it("does not cache a tail at zero and falls back for an invalid map", async () => {
		expect(markers(await capture([user("TAIL")], { volatileFrom: 0 }))).toEqual([]);
		expect(markers(await capture([user("TAIL")], { volatileFrom: 0, sourceIndices: [] }))).toEqual([0]);
	});
	it("uses explicit source coordinates after exclusions and stops before reordered volatile content", async () => {
		expect(
			markers(await capture([user("H"), assistant(), user("T")], { volatileFrom: 4, sourceIndices: [1, 3, 4] })),
		).toEqual([1]);
		expect(
			markers(
				await capture([user("H"), user("volatile"), assistant(), user("T")], {
					volatileFrom: 3,
					sourceIndices: [0, 3, 1, 4],
				}),
			),
		).toEqual([0]);
	});
	it("anchors tool results but excludes a group crossing the boundary", async () => {
		const call = assistant();
		call.content = ["one", "two"].map((id) => ({ type: "toolCall", id, name: "read", arguments: {} }));
		const results: Message[] = ["one", "two"].map((id) => ({
			role: "toolResult",
			toolCallId: id,
			toolName: "read",
			content: [{ type: "text", text: id }],
			isError: false,
			timestamp: 0,
		}));
		const messages = [user("H"), call, ...results, user("T")];
		expect(markers(await capture(messages, { volatileFrom: 4 }))).toEqual([2]);
		expect(markers(await capture(messages, { volatileFrom: 3 }))).toEqual([0]);
	});
	it("tracks failed assistants and synthetic tool results without assigning them a real source", async () => {
		const failed = { ...assistant(), stopReason: "aborted" as const };
		const call = assistant();
		call.content = [{ type: "toolCall", id: "missing", name: "read", arguments: {} }];
		const sources = [0, 1, 2, 3];
		const transformed = transformMessages([user("H"), failed, call, user("T")], model, undefined, sources);
		expect(transformed.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "user"]);
		expect(sources).toEqual([0, 2, -1, 3]);
		expect(markers(await capture([user("H"), failed, call, user("T")], { volatileFrom: 3 }))).toEqual([0]);
	});
});
