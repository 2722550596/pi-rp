import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type SessionInfo, SessionManager } from "../../src/core/session-manager.ts";
import { MemoryStorageBackend } from "../resource-supply-mocks.ts";

const PROJECT_CWD = "/list-session-info-cwd";

const TOOL_FILLER = "TOOL_FILLER_".repeat(200_000);

function sessionLines(): string[] {
	return [
		JSON.stringify({
			type: "session",
			version: 3,
			id: "sess-1",
			timestamp: "2025-01-01T00:00:00.000Z",
			cwd: PROJECT_CWD,
		}),
		JSON.stringify({
			type: "message",
			id: "u1",
			parentId: null,
			timestamp: "2025-01-01T00:00:01.000Z",
			message: {
				role: "user",
				content: [{ type: "text", text: "first prompt" }],
				timestamp: Date.parse("2025-02-01T00:00:00.000Z"),
			},
		}),
		JSON.stringify({
			type: "message",
			id: "a1",
			parentId: "u1",
			timestamp: "2025-01-01T00:00:02.000Z",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "assistant reply" }],
				timestamp: Date.parse("2025-03-01T00:00:00.000Z"),
			},
		}),
		JSON.stringify({
			type: "message",
			id: "t1",
			parentId: "a1",
			timestamp: "2025-01-01T00:00:03.000Z",
			message: {
				role: "toolResult",
				content: [{ type: "text", text: TOOL_FILLER }],
				timestamp: Date.parse("2025-04-01T00:00:00.000Z"),
			},
		}),
		JSON.stringify({
			type: "message",
			id: "u2",
			parentId: "t1",
			timestamp: "2025-01-01T00:00:04.000Z",
			message: {
				role: "user",
				content: [{ type: "text", text: "second prompt" }],
				timestamp: Date.parse("2025-02-15T00:00:00.000Z"),
			},
		}),
		JSON.stringify({
			type: "session_info",
			id: "n1",
			parentId: "u2",
			timestamp: "2025-01-01T00:00:05.000Z",
			name: "My Session",
		}),
		JSON.stringify({
			type: "label",
			id: "l1",
			parentId: "n1",
			timestamp: "2025-01-01T00:00:06.000Z",
			targetId: "u1",
			label: "x",
		}),
		"",
		"not json",
	];
}

function expectedInfo(): Pick<
	SessionInfo,
	"id" | "cwd" | "name" | "messageCount" | "firstMessage" | "allMessagesText"
> {
	return {
		id: "sess-1",
		cwd: PROJECT_CWD,
		name: "My Session",
		messageCount: 4,
		firstMessage: "first prompt",
		allMessagesText: "first prompt assistant reply second prompt",
	};
}

describe("SessionManager.list session-info scan", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `list-session-info-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function writeSession(fileName: string, lines: string[]): string {
		const file = join(tempDir, fileName);
		writeFileSync(file, `${lines.join("\n")}\n`);
		return file;
	}

	async function listWithNodeStorage(): Promise<SessionInfo[]> {
		// Default storage is NodeStorageBackend.shared: exercises the byte fast scan.
		return SessionManager.list(PROJECT_CWD, tempDir);
	}

	it("extracts list metadata and counts tool results without searching their content", async () => {
		writeSession("s1.jsonl", sessionLines());
		const sessions = await listWithNodeStorage();
		expect(sessions).toHaveLength(1);
		const session = sessions[0];
		expect(session).toMatchObject(expectedInfo());
		expect(session.allMessagesText).not.toContain("TOOL_FILLER_");
		// modified comes from the latest user/assistant activity, not the tool result.
		expect(session.modified.toISOString()).toBe("2025-03-01T00:00:00.000Z");
	});

	it("matches the line-scan fallback for the same fixture", async () => {
		const content = `${sessionLines().join("\n")}\n`;
		const memory = new MemoryStorageBackend();
		memory.mkdirSync(tempDir);
		memory.seed(join(tempDir, "s1.jsonl"), content);
		// MemoryStorageBackend has no readFileBytesSync: exercises the readTextLinesSync fallback.
		const sessions = await SessionManager.list(PROJECT_CWD, tempDir, undefined, memory);
		expect(sessions).toHaveLength(1);
		expect(sessions[0]).toMatchObject(expectedInfo());
		expect(sessions[0].modified.toISOString()).toBe("2025-03-01T00:00:00.000Z");
	});

	it("counts message entries with foreign key order via the parse fallback", async () => {
		const foreign = JSON.stringify({
			id: "f1",
			parentId: null,
			type: "message",
			timestamp: "2025-01-01T00:00:01.000Z",
			message: { role: "user", content: [{ type: "text", text: "foreign order" }] },
		});
		writeSession("s2.jsonl", [sessionLines()[0], foreign]);
		const sessions = await listWithNodeStorage();
		expect(sessions).toHaveLength(1);
		expect(sessions[0].messageCount).toBe(1);
		expect(sessions[0].firstMessage).toBe("foreign order");
	});

	it("rejects files whose first parsed entry is not the session header", async () => {
		const lines = sessionLines();
		writeSession("bad.jsonl", [lines[6], ...lines.slice(0, 6)]);
		const sessions = await listWithNodeStorage();
		expect(sessions).toEqual([]);
	});

	it("parses a BOM-prefixed session file", async () => {
		const lines = sessionLines();
		const file = join(tempDir, "bom.jsonl");
		writeFileSync(file, `\uFEFF${lines.join("\n")}\n`);
		const sessions = await listWithNodeStorage();
		expect(sessions).toHaveLength(1);
		expect(sessions[0].id).toBe("sess-1");
	});
});
