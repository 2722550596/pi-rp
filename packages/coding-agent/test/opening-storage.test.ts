import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpfsFileSystem } from "../../agent/src/harness/env/opfs/file-system.ts";
import { OpfsStorageBackend } from "../../agent/src/harness/env/opfs/storage.ts";
import { createMockOpfsRoot } from "../../agent/test/harness/env/opfs-mock.ts";
import { createOpeningExtension } from "../src/extensions/opening/index.ts";
import { listOpeningPresets, loadOpeningPreset, type OpeningPresetSource } from "../src/extensions/opening/preset.ts";
import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "../src/index.ts";
import { MemoryStorageBackend } from "./resource-supply-mocks.ts";

/**
 * 18 号 §10.3 — opening 装载器的 storage 参数化 + 内联优先 + createOpeningExtension 工厂。
 * （default export env 通道回归门 = 既有 opening-extension.test.ts 零改动。）
 */

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function createStub() {
	const calls: Array<{ op: string; args: unknown[] }> = [];
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => void) => {
			handlers.set(event, handler);
		},
		registerCommand: () => {},
		appendEntry: (...args: unknown[]) => calls.push({ op: "appendEntry", args }),
		sendMessage: (...args: unknown[]) => calls.push({ op: "sendMessage", args }),
		updateState: (...args: unknown[]) => {
			calls.push({ op: "updateState", args });
			return { ok: true };
		},
	} as unknown as ExtensionAPI;
	return { pi, calls, handlers };
}

function sessionCtx(cwd: string, entries: Array<{ type: string }>): ExtensionContext {
	return {
		cwd,
		mode: "json",
		hasUI: false,
		sessionManager: { getEntries: () => entries },
	} as unknown as ExtensionContext;
}

const sessionStart = (): SessionStartEvent => ({ type: "session_start", reason: "startup" });
function createOpeningObject(deps?: Parameters<typeof createOpeningExtension>[0]) {
	const extension = createOpeningExtension(deps);
	if (typeof extension === "function") throw new Error("Expected an object-shaped InlineExtension");
	return extension;
}

describe("opening presets over storage (18 号 §10.3)", () => {
	it("lists and loads from an OPFS mock with inline-first merge on ID collision", async () => {
		const root = createMockOpfsRoot(mkdtempSync(join(tmpdir(), "pi-opening-opfs-")), { withMove: true });
		tempDirs.push(root.diskPath);
		const fs = new OpfsFileSystem(root, "/");
		await fs.writeFile(
			"/workspace/default/.pi/openings/disk.json",
			JSON.stringify({ name: "Disk Copy", description: "from disk", messages: [{ role: "user", content: "disk" }] }),
		);
		await fs.writeFile("/workspace/default/.pi/openings/zzz.json", JSON.stringify({ name: "Zed", messages: [] }));
		const storage = await OpfsStorageBackend.create(root, { hydrateScopes: ["/workspace/default/.pi"] });

		const inline: OpeningPresetSource[] = [
			{
				id: "disk",
				name: "Inline Copy",
				messages: [{ role: "user", content: "inline" }],
				source: "inline:bundled-disk",
			},
			{ id: "aaa", name: "Alpha", messages: [] },
		];

		const list = listOpeningPresets("/workspace/default", { storage, inline });
		// Scanned (sorted, minus overridden) + inline (sorted) concatenation.
		expect(list.map((entry) => [entry.id, entry.name, entry.source])).toEqual([
			["zzz", "Zed", "opfs:/workspace/default/.pi/openings/zzz.json"],
			["aaa", "Alpha", "inline:aaa"],
			["disk", "Inline Copy", "inline:bundled-disk"],
		]);

		// loadOpeningPreset: inline wins before the scan.
		const loaded = loadOpeningPreset("/workspace/default", "disk", { storage, inline });
		expect(loaded?.name).toBe("Inline Copy");
		expect(loaded?.messages).toEqual([{ role: "user", content: "inline" }]);
		const scanned = loadOpeningPreset("/workspace/default", "zzz", { storage });
		expect(scanned?.name).toBe("Zed");
	});
	it("ignores directories named like JSON opening presets", () => {
		const storage = new MemoryStorageBackend("opfs");
		storage.mkdirSync("/workspace/default/.pi/openings/missing.json");

		expect(listOpeningPresets("/workspace/default", { storage })).toEqual([]);
		expect(loadOpeningPreset("/workspace/default", "missing", { storage })).toBeUndefined();
	});

	it("warns once when an inline opening overrides a scanned preset", () => {
		const storage = new MemoryStorageBackend("opfs");
		storage.seedJson("/workspace/default/.pi/openings/clash.json", { name: "Disk", messages: [] });
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const list = listOpeningPresets("/workspace/default", {
			storage,
			inline: [{ id: "clash", name: "Inline", messages: [] }],
		});
		expect(list.map((entry) => entry.id)).toEqual(["clash"]);
		expect(list[0]!.name).toBe("Inline");
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining('Inline opening "clash" (inline:clash) overrides scanned'),
		);
		warn.mockRestore();
	});

	it("uses the later duplicate inline opening and warns", () => {
		const storage = new MemoryStorageBackend("opfs");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const list = listOpeningPresets("/workspace/default", {
				storage,
				inline: [
					{ id: "same", name: "Earlier", source: "inline:first", messages: [] },
					{ id: "same", name: "Later", source: "inline:later", messages: [] },
				],
			});
			expect(list).toEqual([{ id: "same", name: "Later", source: "inline:later" }]);
			expect(warn).toHaveBeenCalledWith(
				expect.stringContaining('Inline opening "same" (inline:later) overrides inline inline:first'),
			);
		} finally {
			warn.mockRestore();
		}
	});

	it("createOpeningExtension: deps.getOpeningId seeds an inline opening through session_start", () => {
		const storage = new MemoryStorageBackend("opfs");
		const inline: OpeningPresetSource[] = [
			{
				id: "cold-open",
				name: "Cold Open",
				messages: [{ role: "assistant", content: "RESOURCE-SMOKE-OPENING-LINE" }],
				state: { world: { scene: "门口" } },
			},
		];
		const extension = createOpeningObject({ getOpeningId: () => "cold-open", storage, inline });
		expect(extension).toMatchObject({ name: "opening", hidden: true });
		const { pi, calls, handlers } = createStub();
		extension.factory(pi);
		handlers.get("session_start")!(sessionStart(), sessionCtx("/workspace/default", [{ type: "session" }]));

		const seededMessages = calls.filter((call) => call.op === "appendEntry" && call.args[0] === "message");
		expect(seededMessages.map((call) => call.args[1])).toEqual([
			{ role: "assistant", content: "RESOURCE-SMOKE-OPENING-LINE" },
		]);
		const stateOps = calls.filter((call) => call.op === "updateState");
		expect(stateOps.map((call) => call.args[0])).toEqual(["world.scene"]);
		const audit = calls.filter((call) => call.op === "appendEntry" && call.args[0] === "opening");
		expect(audit).toHaveLength(1);
		expect(audit[0]!.args[1]).toMatchObject({ name: "cold-open" });
	});

	it("createOpeningExtension: skipIfSeeded guard leaves sessions that already have messages untouched", () => {
		const storage = new MemoryStorageBackend("opfs");
		const inline: OpeningPresetSource[] = [{ id: "cold-open", messages: [{ role: "user", content: "hi" }] }];
		const extension = createOpeningObject({ getOpeningId: () => "cold-open", storage, inline });
		const { pi, calls, handlers } = createStub();
		extension.factory(pi);
		handlers.get("session_start")!(sessionStart(), sessionCtx("/workspace/default", [{ type: "message" }]));
		expect(calls).toHaveLength(0);
	});

	it("createOpeningExtension: injecting getOpeningId stops the env channel (either/or, no stacking)", () => {
		const storage = new MemoryStorageBackend("opfs");
		storage.seedJson("/workspace/default/.pi/openings/from-env.json", {
			messages: [{ role: "user", content: "env" }],
		});
		process.env.PI_OPENING = "from-env";
		try {
			const extension = createOpeningObject({ getOpeningId: () => undefined, storage });
			const { pi, handlers } = createStub();
			extension.factory(pi);
			handlers.get("session_start")!(sessionStart(), sessionCtx("/workspace/default", [{ type: "session" }]));
		} finally {
			delete process.env.PI_OPENING;
		}
	});
});
