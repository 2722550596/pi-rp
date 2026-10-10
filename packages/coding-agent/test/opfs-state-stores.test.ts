import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessStores } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import { OpfsFileSystem } from "../../agent/src/harness/env/opfs/file-system.ts";
import { OpfsStateLocks, OpfsStorageBackend } from "../../agent/src/harness/env/opfs/storage.ts";
import { createMockOpfsRoot, type MockDirectoryHandle } from "../../agent/test/harness/env/opfs-mock.ts";
import { FileAuthStorageBackend, ReadOnlyAuthStorage } from "../src/core/auth-storage.ts";
import { getDefaultSessionDir, SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { loadSkills } from "../src/core/skills.ts";
import { ProjectTrustStore } from "../src/core/trust-manager.ts";

/**
 * Browser-side unit tests for the 11-B state-store conversion: the coding-agent stores run against the OPFS mirror
 * backend over a filesystem-backed mock of the handle protocol (Node has no navigator.storage). Durability assertions
 * go through `flush()` + a rehydrated second backend, mirroring what a page reload does.
 */

interface OpfsStores {
	storage: OpfsStorageBackend;
	stores: HarnessStores;
}

const tempDirs: string[] = [];

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-agent-opfs-stores-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

async function createOpfsStores(root: MockDirectoryHandle, hydrateScopes?: string[]): Promise<OpfsStores> {
	const storage = await OpfsStorageBackend.create(root, { hydrateScopes });
	return {
		storage,
		stores: {
			storage,
			locks: OpfsStateLocks.shared,
			paths: { agentDir: () => "/state/agent" },
		},
	};
}

describe("SessionManager over OPFS storage", () => {
	it("creates, flushes, and reopens a session from a rehydrated mirror", async () => {
		const root = createMockOpfsRoot(createTempDir(), { withMove: true });
		const first = await createOpfsStores(root);
		const sessionDir = getDefaultSessionDir("/workspace/default", "/state/agent", first.storage);
		expect(sessionDir.startsWith("/state/agent/sessions/")).toBe(true);

		const manager = SessionManager.create("/workspace/default", sessionDir, undefined, first.storage);
		// appendMessage takes the raw pi-ai message; _persist intentionally defers until the first assistant turn.
		const turn = (role: "user" | "assistant", text: string) => ({
			role,
			content: text,
			provider: "p",
			model: "m",
			usage: { input: 0, output: 0 },
		});
		manager.appendMessage(turn("user", "hello") as never);
		manager.appendMessage(turn("assistant", "hi") as never);
		await first.storage.flush();

		const second = await OpfsStorageBackend.create(root);
		const reopened = SessionManager.open(manager.getSessionFile()!, undefined, undefined, second);
		// getEntries excludes the header entry
		expect(reopened.getEntries().length).toBe(2);
		expect(reopened.getHeader()?.cwd).toBe("/workspace/default");
		expect(second.existsSync(manager.getSessionFile()!)).toBe(true);
	});

	it("keeps a new conversation-free session unpersisted when flushed", async () => {
		const root = createMockOpfsRoot(createTempDir(), { withMove: true });
		const { storage } = await createOpfsStores(root);
		const sessionDir = getDefaultSessionDir("/workspace/default", "/state/agent", storage);
		const manager = SessionManager.create("/workspace/default", sessionDir, undefined, storage);
		manager.appendModelChange("test", "model");
		manager.appendThinkingLevelChange("medium");
		manager.appendPresetChange("default");
		const sessionFile = manager.getSessionFile()!;

		manager.flush();
		await storage.flush();

		expect(storage.existsSync(sessionFile)).toBe(false);
	});

	it("flushes and restores a custom-message-only session", async () => {
		const root = createMockOpfsRoot(createTempDir(), { withMove: true });
		const { storage } = await createOpfsStores(root);
		const sessionDir = getDefaultSessionDir("/workspace/default", "/state/agent", storage);
		const manager = SessionManager.create("/workspace/default", sessionDir, undefined, storage);
		const openingId = manager.appendCustomMessageEntry("side-chat", "Opening snapshot", true, { source: "initial" });
		const sessionFile = manager.getSessionFile()!;

		manager.flush();
		await storage.flush();

		const rehydrated = await OpfsStorageBackend.create(root);
		const reopened = SessionManager.open(sessionFile, undefined, undefined, rehydrated);
		expect(reopened.getBranch().map((entry) => entry.id)).toEqual([openingId]);
		expect(reopened.getEntry(openingId)).toMatchObject({
			type: "custom_message",
			customType: "side-chat",
			content: "Opening snapshot",
			details: { source: "initial" },
		});
	});

	it("flushes user-only conversations and appends later pre-assistant messages exactly once", async () => {
		const root = createMockOpfsRoot(createTempDir(), { withMove: true });
		const { storage } = await createOpfsStores(root);
		const sessionDir = getDefaultSessionDir("/workspace/default", "/state/agent", storage);
		const manager = SessionManager.create("/workspace/default", sessionDir, undefined, storage);
		const sessionFile = manager.getSessionFile()!;
		const firstUser = manager.appendMessage({ role: "user", content: "first", timestamp: 1 } as never);

		manager.flush();
		await storage.flush();

		const firstRehydrated = await OpfsStorageBackend.create(root);
		const firstRestore = SessionManager.open(sessionFile, undefined, undefined, firstRehydrated);
		expect(firstRestore.getBranch().map((entry) => entry.id)).toEqual([firstUser]);
		expect(firstRestore.getEntry(firstUser)).toMatchObject({
			type: "message",
			message: { role: "user", content: "first" },
		});

		const secondUser = manager.appendMessage({ role: "user", content: "second", timestamp: 2 } as never);
		const customId = manager.appendCustomMessageEntry("side-chat", "Queued context", false);
		const thirdUser = manager.appendMessage({ role: "user", content: "third", timestamp: 3 } as never);
		const assistant = manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "first response" }],
			api: "openai-completions",
			provider: "test",
			model: "test",
			stopReason: "stop",
			timestamp: 4,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0,
				},
			},
		} as never);
		manager.flush();
		await storage.flush();

		const finalStorage = await OpfsStorageBackend.create(root);
		const reopened = SessionManager.open(sessionFile, undefined, undefined, finalStorage);
		const expectedIds = [firstUser, secondUser, customId, thirdUser, assistant];
		expect(reopened.getEntries().map((entry) => entry.id)).toEqual(expectedIds);
		expect(reopened.getBranch().map((entry) => entry.id)).toEqual(expectedIds);
	});

	it("persists edits before the first assistant without recreating or duplicating the session", async () => {
		const userMsg = (text: string) => ({ role: "user" as const, content: text, timestamp: 1 });
		const root = createMockOpfsRoot(createTempDir(), { withMove: true });
		const { storage } = await createOpfsStores(root);
		const sessionDir = getDefaultSessionDir("/workspace/default", "/state/agent", storage);
		const manager = SessionManager.create("/workspace/default", sessionDir, undefined, storage);
		const initial = manager.appendMessage(userMsg("original"));
		const left = manager.appendMessage(userMsg("left"));
		manager.branch(initial);
		const right = manager.appendMessage(userMsg("right"));
		expect(manager.updateMessageContent(initial, "edited")).toBe(true);
		const reply = manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "first response" }],
			api: "openai-completions",
			provider: "test",
			model: "test",
			stopReason: "stop",
			timestamp: 2,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});
		await storage.flush();

		const rehydrated = await OpfsStorageBackend.create(root);
		const reopened = SessionManager.open(manager.getSessionFile()!, undefined, undefined, rehydrated);
		expect(reopened.getSessionId()).toBe(manager.getSessionId());
		expect(reopened.getEntries().map((entry) => entry.id)).toEqual([initial, left, right, reply]);
		expect(reopened.getLeafId()).toBe(reply);
		expect(reopened.getChildren(initial).map((entry) => entry.id)).toEqual([left, right]);
		const edited = reopened.getEntry(initial);
		expect(edited?.type === "message" && edited.message.content).toEqual([{ type: "text", text: "edited" }]);
	});

	it("forks through the seam without touching node:fs", async () => {
		const root = createMockOpfsRoot(createTempDir(), { withMove: true });
		const { storage } = await createOpfsStores(root);
		const sessionDir = getDefaultSessionDir("/workspace/default", "/state/agent", storage);
		const manager = SessionManager.create("/workspace/default", sessionDir, undefined, storage);
		const turn = (role: "user" | "assistant", text: string) => ({
			role,
			content: text,
			provider: "p",
			model: "m",
			usage: { input: 0, output: 0 },
		});
		manager.appendMessage(turn("user", "hello") as never);
		manager.appendMessage(turn("assistant", "hi") as never);
		await storage.flush();

		const forked = SessionManager.forkFrom(
			manager.getSessionFile()!,
			"/workspace/other",
			undefined,
			undefined,
			storage,
		);
		expect(forked.getCwd()).toBe("/workspace/other");
		await storage.flush();

		const reopened = SessionManager.open(forked.getSessionFile()!, undefined, undefined, storage);
		expect(reopened.getHeader()?.cwd).toBe("/workspace/other");
	});
});

describe("SettingsManager over OPFS storage", () => {
	it("persists global settings through the lock seam and reloads them", async () => {
		const root = createMockOpfsRoot(createTempDir(), { withMove: true });
		const first = await createOpfsStores(root);
		const settings = SettingsManager.create("/workspace/default", "/state/agent", { stores: first.stores });
		settings.setLastChangelogVersion("9.9.9");
		await settings.flush();
		await first.storage.flush();

		const second = await createOpfsStores(root);
		const reloaded = SettingsManager.create("/workspace/default", "/state/agent", { stores: second.stores });
		expect(reloaded.getLastChangelogVersion()).toBe("9.9.9");
	});
});

describe("Auth storage over OPFS storage", () => {
	it("writes credentials through the no-op lock seam and reads them back after reload", async () => {
		const root = createMockOpfsRoot(createTempDir(), { withMove: true });
		const { storage, stores } = await createOpfsStores(root);
		const backend = new FileAuthStorageBackend("/state/agent/auth.json", storage, stores.locks);
		backend.withLock(() => {
			return { result: undefined, next: JSON.stringify({ acme: { type: "api_key", key: "sk-test" } }) };
		});
		await storage.flush();

		const rehydrated = await OpfsStorageBackend.create(root);
		const reader = new ReadOnlyAuthStorage("/state/agent/auth.json", rehydrated);
		expect((reader as unknown as { load(): unknown }).load()).toEqual({
			acme: { type: "api_key", key: "sk-test" },
		});
	});
});

describe("ProjectTrustStore over OPFS storage", () => {
	it("persists trust decisions and reloads them", async () => {
		const root = createMockOpfsRoot(createTempDir(), { withMove: true });
		const first = await createOpfsStores(root);
		const store = new ProjectTrustStore("/state/agent", first.stores);
		store.set("/workspace/default", true);
		await first.storage.flush();

		const second = await createOpfsStores(root);
		const reloaded = new ProjectTrustStore("/state/agent", second.stores);
		expect(reloaded.get("/workspace/default")).toBe(true);
		expect(reloaded.get("/workspace/other")).toBe(null);
	});
});

describe("Skill scanner over OPFS storage", () => {
	it("discovers user and workspace-project skills from the OPFS namespace", async () => {
		const root = createMockOpfsRoot(createTempDir(), { withMove: true });
		// Seed through the raw handle face BEFORE the mirror assembles, so hydration sees the files (a page reload
		// reads whatever the previous session wrote to OPFS).
		const fs = new OpfsFileSystem(root, "/");
		await fs.writeFile(
			"/state/agent/skills/greet/SKILL.md",
			"---\nname: greet\ndescription: Greets people\n---\n\nSay hello.\n",
		);
		await fs.writeFile(
			"/workspace/default/.pi/skills/deploy/SKILL.md",
			"---\nname: deploy\ndescription: Deploys the app\n---\n\nDeploy steps.\n",
		);
		// The sync face hydrates the state subtree plus every subtree synchronous scanners must read; skills
		// discovery reads the workspace .pi config, which F's assembly includes in the hydrate scopes.
		const { storage } = await createOpfsStores(root, ["/state", "/workspace/default/.pi"]);

		const result = loadSkills({
			cwd: "/workspace/default",
			agentDir: "/state/agent",
			skillPaths: [],
			includeDefaults: true,
			storage,
		});
		const names = result.skills.map((skill) => skill.name).sort();
		expect(names).toEqual(["deploy", "greet"]);
		expect(result.diagnostics).toEqual([]);
	});
});
