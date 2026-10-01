import type { SessionSnapshot } from "@earendil-works/pi-protocol";
import { describe, expect, test } from "vitest";
import {
	applyTranscriptProgress,
	applyTranscriptSnapshot,
	createTranscriptState,
	selectTranscript,
	summaryToUserMessage,
	toProtocolToolResultMessage,
} from "../src/index.ts";

function snapshot(revision: number, text: string): SessionSnapshot {
	return {
		id: "session",
		cwd: "/workspace",
		createdAt: 1,
		updatedAt: 2,
		phase: "turn",
		model: { provider: "p", id: "m" },
		thinkingLevel: "off",
		attached: true,
		locked: true,
		revision,
		transcript: [
			{
				id: "assistant",
				role: "assistant",
				content: [{ type: "text", text }],
				model: { provider: "p", id: "m" },
				status: "streaming",
				timestamp: 1,
			},
		],
		queuedSteer: [],
		queuedSteerCount: 0,
	};
}
describe("shared transcript protocol", () => {
	test("retains the public state shape and overlays delta-only parts without copying untouched items", () => {
		const initial = snapshot(2, "prefix");
		let state = createTranscriptState(initial);
		expect(Object.keys(state).sort()).toEqual(["progressItems", "progressOrder", "snapshot", "toolCallBuffers"]);
		const before = state.snapshot.transcript[0]!;
		state = applyTranscriptProgress(state, {
			type: "assistant_delta",
			messageId: "assistant",
			contentIndex: 0,
			kind: "text",
			delta: " tail",
		});
		expect(selectTranscript(state)[0]).toMatchObject({ content: [{ text: "prefix tail" }] });
		expect(state.snapshot.transcript[0]).toBe(before);
	});

	test("ignores lower revisions for the same session and accepts a new session baseline", () => {
		let state = createTranscriptState(snapshot(40, "old"));
		state = applyTranscriptProgress(state, {
			type: "assistant_delta",
			messageId: "assistant",
			contentIndex: 0,
			kind: "text",
			delta: " partial",
		});
		state = applyTranscriptSnapshot(state, snapshot(0, "stale"));
		expect(state.snapshot.revision).toBe(40);
		expect(selectTranscript(state)[0]).toMatchObject({ content: [{ type: "text", text: "old partial" }] });
		state = applyTranscriptSnapshot(state, { ...snapshot(0, "fresh session"), id: "new-session" });
		expect(state.snapshot.revision).toBe(0);
		expect(selectTranscript(state)[0]).toMatchObject({ content: [{ text: "fresh session" }] });
		expect(state.progressItems.size).toBe(0);
	});

	test("summary projection uses the convertToLlm prefixes and preserves stable item identifiers", () => {
		const summary = summaryToUserMessage({ id: "entry-9", timestamp: 90, kind: "compaction", summary: "compressed" });
		expect(summary).toMatchObject({
			id: "entry-9",
			role: "user",
			timestamp: 90,
			content: [
				{
					type: "text",
					text: "The conversation history before this point was compacted into the following summary:\n\n<summary>\ncompressed\n</summary>",
				},
			],
		});
		expect(
			summaryToUserMessage({ id: "entry-10", timestamp: 91, kind: "branch", summary: "returned" }).content,
		).toEqual([
			{
				type: "text",
				text: "The following is a summary of a branch that this conversation came back from:\n\n<summary>\nreturned</summary>",
			},
		]);
	});

	test("tool result projections preserve the originating call id, name, and JSON arguments", () => {
		const call = { type: "toolCall" as const, id: "call-1", name: "read", arguments: { path: "file" } };
		const result = toProtocolToolResultMessage(
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read",
				content: [{ type: "text", text: "ok" }],
				isError: false,
				timestamp: 5,
			},
			{ id: "tool-entry", call },
		);
		expect(result).toMatchObject({
			id: "tool-entry",
			toolCallId: "call-1",
			toolName: "read",
			input: { path: "file" },
		});
	});
});
