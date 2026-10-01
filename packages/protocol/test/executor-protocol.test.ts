import { describe, expect, test } from "vitest";
import {
	ExecutorToHostDecoder,
	encodeExecutorToHost,
	encodeFrame,
	FrameDecoder,
	parseExecutorToHost,
} from "../src/index.ts";

const identity = {
	sessionId: "session-1",
	bindingId: "binding-1",
	generationId: "00000000-0000-4000-8000-000000000000",
};

describe("incremental frame and executor protocol decoding", () => {
	test("pushEach visits complete frames in stream order across arbitrary chunk boundaries", () => {
		const decoder = new FrameDecoder();
		const received: number[] = [];
		const bytes = new Uint8Array([...encodeFrame(new Uint8Array([1, 2])), ...encodeFrame(new Uint8Array([3]))]);
		decoder.pushEach(bytes.subarray(0, 3), (frame) => received.push(...frame));
		decoder.pushEach(bytes.subarray(3, 7), (frame) => received.push(...frame));
		decoder.pushEach(bytes.subarray(7), (frame) => received.push(...frame));
		decoder.end();
		expect(received).toEqual([1, 2, 3]);
	});

	test("callback decoding dispatches each decoded message without an array-returning path", () => {
		const messages = [
			{
				type: "runtime_progress",
				...identity,
				progress: {
					type: "item_finished",
					item: {
						id: "a",
						role: "assistant",
						content: [{ type: "text", text: "one" }],
						model: { provider: "p", id: "m" },
						status: "complete",
						stopReason: "stop",
						timestamp: 1,
					},
				},
			},
			{ type: "executor_close", ...identity, reason: "disposed" },
		] as const;
		const chunks = messages.map((message) => encodeExecutorToHost(message as never));
		const input = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
		let offset = 0;
		for (const chunk of chunks) {
			input.set(chunk, offset);
			offset += chunk.length;
		}
		const decoder = new ExecutorToHostDecoder();
		const received: string[] = [];
		decoder.pushEach(input, (message) => received.push(message.type));
		decoder.end();
		expect(received).toEqual(["runtime_progress", "executor_close"]);
	});

	test("snapshot rejection requires commandId only for command-result scope", () => {
		const base = {
			type: "executor_snapshot_rejected",
			...identity,
			code: "invalid_snapshot",
			encodedPayloadBytes: 99,
			maxPayloadBytes: 50,
			message: "too large",
		};
		expect(parseExecutorToHost({ ...base, scope: "runtime_snapshot" })).toMatchObject({ scope: "runtime_snapshot" });
		expect(() => parseExecutorToHost({ ...base, scope: "command_result" })).toThrow();
		expect(
			parseExecutorToHost({ ...base, scope: "command_result", commandId: "00000000-0000-4000-8000-000000000001" }),
		).toMatchObject({ scope: "command_result" });
		expect(() =>
			parseExecutorToHost({ ...base, scope: "runtime_snapshot", commandId: "00000000-0000-4000-8000-000000000001" }),
		).toThrow();
	});
	test("applies the identifier bound in UTF-8 bytes rather than JavaScript characters", () => {
		const valid = { ...identity, sessionId: "😀".repeat(32) };
		expect(parseExecutorToHost({ type: "executor_close", ...valid, reason: "disposed" })).toMatchObject({
			sessionId: valid.sessionId,
		});
		expect(() =>
			parseExecutorToHost({ type: "executor_close", ...identity, sessionId: "😀".repeat(33), reason: "disposed" }),
		).toThrow();
	});
});
