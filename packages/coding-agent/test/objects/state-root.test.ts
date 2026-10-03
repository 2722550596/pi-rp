import type { ObjectHash, ObjectStore } from "@earendil-works/pi-agent-core";
import { getModel } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { canonicalJsonBytes, JsonTree } from "../../src/core/objects/tree/index.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import type { JsonValue } from "../../src/state/merge.ts";
import { StateManager } from "../../src/state/state-manager.ts";

class FakeStore implements ObjectStore {
	readonly objects = new Map<ObjectHash, Uint8Array>();
	failPut = false;
	async put(data: Uint8Array): Promise<ObjectHash> {
		if (this.failPut) throw new Error("put failed");
		const digest = await crypto.subtle.digest("SHA-256", data);
		const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
		this.objects.set(hash as ObjectHash, data.slice());
		return hash as ObjectHash;
	}
	async get(hash: ObjectHash): Promise<Uint8Array | undefined> {
		return this.objects.get(hash)?.slice();
	}
	async has(hash: ObjectHash): Promise<boolean> {
		return this.objects.has(hash);
	}
}

function manager(store: FakeStore): SessionManager {
	return new SessionManager(process.cwd(), "", undefined, false, undefined, undefined, undefined, {
		objectStore: store,
	});
}

describe("state-root session snapshots", () => {
	it("keeps snapshots at or below 64 KiB inline and roots larger snapshots", async () => {
		const store = new FakeStore();
		const sessions = manager(store);
		const tree = new JsonTree(store);
		// canonical 形状 {"data":"<xs>"} = 11 + xs.length 字节；从目标值附近起步，仅微调数次（避免 O(n²) 全量重序列化）
		const target = 64 * 1024;
		let value: Record<string, unknown> = { data: "x".repeat(target - 12) };
		while (canonicalJsonBytes(value as JsonValue).byteLength > target)
			value.data = (value.data as string).slice(0, -1);
		expect(canonicalJsonBytes(value as JsonValue).byteLength).toBeLessThanOrEqual(target);
		await sessions.appendState(value, 1, []);
		const boundary = sessions.getEntries().find((entry) => entry.type === "state");
		expect(boundary?.type).toBe("state");
		if (boundary?.type === "state") expect(boundary.state).toEqual(value);

		// +2 字符：65525+2=65527 字符 → 65538 字节 > 64 KiB 阈值，触发 root 形态
		value = { data: `${value.data as string}xx` };
		await sessions.appendState(value, 2, []);
		const rooted = sessions
			.getEntries()
			.filter((entry) => entry.type === "state")
			.at(-1);
		expect(rooted?.type).toBe("state");
		if (rooted?.type === "state") {
			expect(rooted.state).toMatchObject({
				tg: "state-root.v1",
				s: canonicalJsonBytes(value as JsonValue).byteLength,
				rev: 2,
			});
			if (typeof rooted.state === "object" && rooted.state !== null && "tg" in rooted.state)
				expect(await tree.read(rooted.state.h as ObjectHash, [])).toEqual(value);
		}
	});

	it("rejects missing/corrupt roots and never appends an entry after object write failure", async () => {
		const store = new FakeStore();
		const sessions = manager(store);
		await expect(sessions.resolveStateRoot({ tg: "state-root.v1", h: "0".repeat(64), s: 1, rev: 1 })).rejects.toThrow(
			/missing/i,
		);
		store.failPut = true;
		await expect(sessions.appendState({ data: "x".repeat(70 * 1024) }, 1, [])).rejects.toThrow("put failed");
		expect(sessions.getEntries().filter((entry) => entry.type === "state")).toHaveLength(0);
	});

	it("matches ordered StateManager edits against a full-build oracle", async () => {
		const store = new FakeStore();
		const tree = new JsonTree(store);
		const state = new StateManager();
		const initial = state.snapshotWithRevision(0);
		const base = await tree.update(undefined, [{ op: "replaceRoot", value: initial.snapshot as JsonValue }]);
		const baseRevision = initial.revision;
		state.apply("player.hp", "replace", 12);
		state.apply("items", "add", "sword");
		state.apply({ op: "merge", value: { world: { day: 3 } } });
		const sample = state.snapshotWithRevision(baseRevision);
		const incremental = await tree.update(base.root, sample.edits);
		const oracle = await tree.build(sample.snapshot as JsonValue);
		expect(incremental.root).toBe(oracle.root);
		expect(await tree.read(incremental.root, [])).toEqual(sample.snapshot);
	});
	it("restores root snapshots through AgentSession preflight", async () => {
		const store = new FakeStore();
		const sessions = manager(store);
		sessions.appendMessage({ role: "user", content: "existing session" } as never);
		const state = { ns: { value: "r".repeat(70 * 1024) } };
		await sessions.appendState(state, 1, []);
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();
		const { session } = await createAgentSession({
			cwd: process.cwd(),
			agentDir: process.cwd(),
			model: model!,
			sessionManager: sessions,
			settingsManager: SettingsManager.inMemory(),
		});
		expect(session.stateManager.snapshot()).toEqual(state);
		session.stateManager.apply("ns.extra", "replace", "after resume");
		const sample = session.stateManager.snapshotWithRevision(sessions.getStateRootRevision());
		await sessions.appendState(sample.snapshot, sample.revision, sample.edits);
		const latestRoot = sessions
			.getEntries()
			.filter((entry) => entry.type === "state")
			.at(-1);
		expect(latestRoot?.type).toBe("state");
		if (latestRoot?.type === "state" && typeof latestRoot.state === "object" && "tg" in latestRoot.state)
			expect(await sessions.resolveStateRoot(latestRoot.state)).toEqual(sample.snapshot);
		session.dispose();
	});
	it("rejects missing root objects before installing restored state", async () => {
		const store = new FakeStore();
		const sessions = manager(store);
		sessions.appendMessage({ role: "user", content: "existing session" } as never);
		await sessions.appendState({ ns: { value: "x".repeat(70 * 1024) } }, 1, []);
		const entry = sessions.getEntries().find((item) => item.type === "state");
		expect(entry?.type).toBe("state");
		if (entry?.type !== "state" || typeof entry.state !== "object" || !("h" in entry.state))
			throw new Error("Missing root test fixture");
		store.objects.delete(entry.state.h as ObjectHash);
		const leafBefore = sessions.getLeafId();
		const entriesBefore = sessions.getEntries().map((item) => item.type);
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();
		await expect(
			createAgentSession({
				cwd: process.cwd(),
				agentDir: process.cwd(),
				model: model!,
				sessionManager: sessions,
				settingsManager: SettingsManager.inMemory(),
			}),
		).rejects.toThrow(/missing/i);
		expect(sessions.getEntries().map((item) => item.type)).toEqual(entriesBefore);
		expect(sessions.getLeafId()).toBe(leafBefore);
	});
	it("restores the nearest state on the selected ancestry, not a later sibling", async () => {
		const store = new FakeStore();
		const sessions = manager(store);
		const rootMessageId = sessions.appendMessage({ role: "user", content: "root" } as never);
		await sessions.appendState({ branch: "ancestor" }, 1, []);
		sessions.appendMessage({ role: "user", content: "target branch" } as never);
		const targetState = { branch: "target", value: "t".repeat(70 * 1024) };
		const targetStateId = await sessions.appendState(targetState, 2, []);
		sessions.branch(rootMessageId);
		await sessions.appendState({ branch: "sibling" }, 3, []);
		sessions.branch(targetStateId);
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();
		const { session } = await createAgentSession({
			cwd: process.cwd(),
			agentDir: process.cwd(),
			model: model!,
			sessionManager: sessions,
			settingsManager: SettingsManager.inMemory(),
		});
		expect(session.stateManager.snapshot()).toEqual(targetState);
		session.dispose();
	});

	it("rejects a corrupted object hash during preflight", async () => {
		const store = new FakeStore();
		const sessions = manager(store);
		sessions.appendMessage({ role: "user", content: "existing session" } as never);
		await sessions.appendState({ ns: { value: "x".repeat(70 * 1024) } }, 1, []);
		const entry = sessions.getEntries().find((item) => item.type === "state");
		if (entry?.type !== "state" || typeof entry.state !== "object" || !("h" in entry.state))
			throw new Error("Missing root test fixture");
		const original = store.objects.get(entry.state.h as ObjectHash);
		if (!original) throw new Error("Missing stored root test fixture");
		const corrupted = original.slice();
		corrupted[0] ^= 1;
		store.objects.set(entry.state.h as ObjectHash, corrupted);
		const leafBefore = sessions.getLeafId();
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();
		await expect(
			createAgentSession({
				cwd: process.cwd(),
				agentDir: process.cwd(),
				model: model!,
				sessionManager: sessions,
				settingsManager: SettingsManager.inMemory(),
			}),
		).rejects.toThrow();
		expect(sessions.getLeafId()).toBe(leafBefore);
	});
});
