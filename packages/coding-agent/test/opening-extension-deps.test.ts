/**
 * Opening extension deps injection tests（19 号 §2.4/§3 B3 + §10 T6/T7/T12 扩展层面）。
 *
 * `createOpeningExtension(deps)` 的判定式与装载缝参数化：注入 `getOpeningId` 即不读 env
 * （B3 二选一）；`storage`/`inline` 直通模块 A 的参数化 loader。无参 default export 与旧
 * env-only 行为逐字节等价（T12 的既有套件 opening-extension.test.ts 守护，此处补无参工厂
 * 等价冒烟）。组装期 createPiHarness 级的 T6/T8 集成断言归 A 的资源块测试
 * （opening-storage / reject），本文件只钉扩展消费端语义。
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpfsFileSystem } from "../../agent/src/harness/env/opfs/file-system.ts";
import { OpfsStorageBackend } from "../../agent/src/harness/env/opfs/storage.ts";
import { createMockOpfsRoot, type MockDirectoryHandle } from "../../agent/test/harness/env/opfs-mock.ts";
import openingExtension, {
	createOpeningExtension,
	type OpeningExtensionDeps,
} from "../src/extensions/opening/index.ts";
import type { OpeningPresetSource } from "../src/extensions/opening/preset.ts";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, SessionStartEvent } from "../src/index.ts";

// ── Recording stub（与 opening-extension.test.ts 同款）───────────────────────

interface RecordedCall {
	op: "appendEntry" | "sendMessage" | "updateState";
	args: unknown[];
}

function createStub() {
	const calls: RecordedCall[] = [];
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
	const commands: Array<{ name: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }> = [];

	const pi = {
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => void) => {
			handlers.set(event, handler);
		},
		registerCommand: (
			name: string,
			options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
		) => {
			commands.push({ name, handler: options.handler });
		},
		appendEntry: (...args: unknown[]) => {
			calls.push({ op: "appendEntry", args });
		},
		sendMessage: (...args: unknown[]) => {
			calls.push({ op: "sendMessage", args });
		},
		updateState: (...args: unknown[]) => {
			calls.push({ op: "updateState", args });
			return { ok: true, path: String(args[0] ?? "") };
		},
	} as unknown as ExtensionAPI & {
		appendEntry: (...args: unknown[]) => void;
		sendMessage: (...args: unknown[]) => void;
		updateState: (...args: unknown[]) => { ok: boolean; path?: string; reason?: string };
	};

	return { pi, calls, handlers, commands };
}

function sessionCtx(cwd: string, entries: Array<{ type: string }>): ExtensionContext {
	return {
		cwd,
		mode: "rpc",
		hasUI: false,
		sessionManager: {
			getEntries: () => entries,
		},
	} as unknown as ExtensionContext;
}

const sessionStart = (reason: SessionStartEvent["reason"] = "startup"): SessionStartEvent => ({
	type: "session_start",
	reason,
});

// ── Fixtures ────────────────────────────────────────────────────────────────

const roots: string[] = [];

function fixture(name: string): { root: string; cwd: string } {
	const root = join(tmpdir(), `pi-opening-deps-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const cwd = join(root, "cfg");
	mkdirSync(join(cwd, ".pi", "openings"), { recursive: true });
	roots.push(root);
	return { root, cwd };
}

const INLINE_A: OpeningPresetSource = {
	id: "a",
	name: "Preset A",
	description: "inline fixture",
	messages: [{ role: "user", content: "inline cold open" }],
};
function openingDefinition(deps?: OpeningExtensionDeps) {
	const definition = createOpeningExtension(deps);
	if (typeof definition === "function") throw new Error("expected the opening InlineExtension object form");
	return definition;
}

function openingFactory(deps?: OpeningExtensionDeps) {
	return openingDefinition(deps).factory;
}

const originalEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	for (const key of ["PI_OPENING", "PI_OPENINGS_DIR"]) {
		originalEnv[key] = process.env[key];
		delete process.env[key];
	}
});

afterEach(() => {
	for (const [key, value] of Object.entries(originalEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	while (roots.length > 0) {
		rmSync(roots.pop()!, { recursive: true, force: true });
	}
});

async function opfsStorageWithOpenings(files: Record<string, string>): Promise<OpfsStorageBackend> {
	const root: MockDirectoryHandle = createMockOpfsRoot(
		join(tmpdir(), `pi-opening-deps-opfs-${Date.now()}-${Math.random().toString(36).slice(2)}`),
	);
	// 镜像装配前经裸 handle 面播种（hydration 才能看到）。
	const fs = new OpfsFileSystem(root, "/");
	for (const [path, content] of Object.entries(files)) {
		await fs.writeFile(path, content);
	}
	return await OpfsStorageBackend.create(root, {
		hydrateScopes: ["/workspace/default/.pi", "/workspace/default/world"],
	});
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("opening extension deps injection (B3)", () => {
	it("injected getOpeningId wins and env is never read (either/or, no fallback stacking)", async () => {
		const { cwd } = fixture("injected");
		process.env.PI_OPENING = "ghost"; // 注入后必须被无视（env 通道仅 node）
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { pi, calls, handlers } = createStub();
		const extension = openingFactory({
			getOpeningId: () => "a",
			inline: [INLINE_A],
		});
		extension(pi);

		await handlers.get("session_start")!(sessionStart(), sessionCtx(cwd, []));

		const messages = calls.filter((c) => c.op === "appendEntry" && c.args[0] === "message");
		expect(messages.map((c) => c.args[1])).toEqual([{ role: "user", content: "inline cold open" }]);
		const audit = calls.filter((c) => c.op === "appendEntry" && c.args[0] === "opening");
		expect(audit).toHaveLength(1);
		expect(audit[0]?.args[1]).toMatchObject({ name: "a" });
		expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("ghost"));
		warn.mockRestore();
	});

	it("without getOpeningId the env trigger stays active (node default)", async () => {
		const { cwd } = fixture("env-default");
		writeFileSync(join(cwd, ".pi", "openings", "envid.json"), JSON.stringify({ messages: [] }));
		process.env.PI_OPENING = "envid";
		const { pi, calls, handlers } = createStub();
		openingFactory()(pi);

		await handlers.get("session_start")!(sessionStart(), sessionCtx(cwd, []));

		expect(calls.some((c) => c.op === "appendEntry" && c.args[0] === "opening")).toBe(true);
	});

	it("T6 (extension face): deps.storage loads the opening from the OPFS-backed openings dir", async () => {
		const storage = await opfsStorageWithOpenings({
			"/workspace/default/.pi/openings/b.json": JSON.stringify({
				name: "From OPFS",
				messages: [{ role: "assistant", content: "opfs seeded" }],
			}),
		});
		const { pi, calls, handlers } = createStub();
		const opening = openingDefinition({ getOpeningId: () => "b", storage });
		expect(opening).toMatchObject({ name: "opening", hidden: true });
		opening.factory(pi);
		await handlers.get("session_start")!(sessionStart(), sessionCtx("/workspace/default", []));

		const messages = calls.filter((c) => c.op === "appendEntry" && c.args[0] === "message");
		expect(messages.map((c) => c.args[1])).toEqual([{ role: "assistant", content: "opfs seeded" }]);
		expect(calls.some((c) => c.op === "appendEntry" && c.args[0] === "opening")).toBe(true);
	});
	it("per-harness configDir selects the opening root and suppresses node env triggers", async () => {
		const storage = await opfsStorageWithOpenings({
			"/workspace/default/.pi/openings/b.json": JSON.stringify({
				name: "Legacy env root",
				messages: [{ role: "user", content: "wrong root" }],
			}),
			"/workspace/default/world/openings/b.json": JSON.stringify({
				name: "World root",
				messages: [{ role: "user", content: "configured root" }],
			}),
		});
		process.env.PI_OPENING = "b";
		process.env.PI_OPENINGS_DIR = "/workspace/default/.pi/openings";

		const { pi, calls, handlers } = createStub();
		openingFactory({ configDir: "world", getOpeningId: () => "b", storage })(pi);
		await handlers.get("session_start")!(sessionStart(), sessionCtx("/workspace/default", []));
		const messages = calls.filter((c) => c.op === "appendEntry" && c.args[0] === "message");
		expect(messages.map((c) => c.args[1])).toEqual([{ role: "user", content: "configured root" }]);

		// With configDir explicitly supplied but no getOpeningId, PI_OPENING is not a trigger source.
		const { pi: noTriggerPi, calls: noTriggerCalls, handlers: noTriggerHandlers } = createStub();
		openingFactory({ configDir: "world", storage })(noTriggerPi);
		await noTriggerHandlers.get("session_start")!(sessionStart(), sessionCtx("/workspace/default", []));
		expect(noTriggerCalls).toHaveLength(0);
	});

	it("T7: skipIfSeeded guard holds with injected deps (resume/reload no-op)", async () => {
		const { cwd } = fixture("seeded-deps");
		const { pi, calls, handlers } = createStub();
		const extension = openingFactory({ getOpeningId: () => "a", inline: [INLINE_A] });
		extension(pi);

		await handlers.get("session_start")!(sessionStart("reload"), sessionCtx(cwd, [{ type: "message" }]));

		expect(calls).toHaveLength(0);
	});

	it("inline beats a same-id scanned preset and list merges both (injected deps)", async () => {
		const storage = await opfsStorageWithOpenings({
			"/workspace/default/.pi/openings/a.json": JSON.stringify({
				name: "Scanned A",
				messages: [{ role: "user", content: "from scan" }],
			}),
			"/workspace/default/.pi/openings/z.json": JSON.stringify({
				name: "Only Scanned",
				messages: [],
			}),
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { pi, calls, handlers, commands } = createStub();
		const extension = openingFactory({ getOpeningId: () => "a", storage, inline: [INLINE_A] });
		extension(pi);

		// session_start：同 id 内联胜出（seeds 内联内容，不读扫描副本）。
		await handlers.get("session_start")!(sessionStart(), sessionCtx("/workspace/default", []));
		const messages = calls.filter((c) => c.op === "appendEntry" && c.args[0] === "message");
		expect(messages.map((c) => c.args[1])).toEqual([{ role: "user", content: "inline cold open" }]);

		// /opening 无参列表：内联 + 扫描合并（a 去重为内联、z 保留）。
		const notifications: string[] = [];
		const cmdCtx = {
			...sessionCtx("/workspace/default", []),
			ui: { notify: (message: string) => notifications.push(message) },
		} as unknown as ExtensionCommandContext;
		await commands[0]!.handler("", cmdCtx);
		const list = notifications.join("\n");
		expect(list).toContain("Preset A (a)");
		expect(list).toContain("Only Scanned (z)");
		// 内联×扫描同 id 冲突诊断（D1：opening 无 diagnostics 通道 → console.warn 一次）。
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	it("/opening command applies through injected deps and reports via ctx.ui", async () => {
		const { cwd } = fixture("command-deps");
		const { pi, calls, commands } = createStub();
		const extension = openingFactory({ getOpeningId: () => undefined, inline: [INLINE_A] });
		extension(pi);

		const notifications: string[] = [];
		const cmdCtx = {
			...sessionCtx(cwd, []),
			ui: { notify: (message: string) => notifications.push(message) },
		} as unknown as ExtensionCommandContext;

		await commands[0]!.handler("a", cmdCtx);
		const messages = calls.filter((c) => c.op === "appendEntry" && c.args[0] === "message");
		expect(messages.map((c) => c.args[1])).toEqual([{ role: "user", content: "inline cold open" }]);
		expect(calls.some((c) => c.op === "appendEntry" && c.args[0] === "opening")).toBe(true);
		expect(notifications.some((n) => n.includes('Opening "Preset A" applied'))).toBe(true);

		await commands[0]!.handler("missing", cmdCtx);
		expect(notifications.some((n) => n.includes('Opening preset "missing" not found'))).toBe(true);
	});
});

describe("T12: parameterless factory equals the legacy default export", () => {
	it("createOpeningExtension() env path seeds from disk exactly like openingExtension", async () => {
		const { cwd } = fixture("t12");
		writeFileSync(
			join(cwd, ".pi", "openings", "legacy.json"),
			JSON.stringify({ name: "Legacy", messages: [{ role: "user", content: "legacy open" }] }),
		);
		process.env.PI_OPENING = "legacy";

		for (const extension of [openingExtension, openingFactory()]) {
			const { pi, calls, handlers } = createStub();
			extension(pi);
			await handlers.get("session_start")!(sessionStart(), sessionCtx(cwd, [{ type: "session" }]));
			const messages = calls.filter((c) => c.op === "appendEntry" && c.args[0] === "message");
			expect(messages.map((c) => c.args[1])).toEqual([{ role: "user", content: "legacy open" }]);
			expect(calls.some((c) => c.op === "appendEntry" && c.args[0] === "opening")).toBe(true);
		}
	});

	it("createOpeningExtension() warns on a missing preset id like the legacy path", () => {
		const { cwd } = fixture("t12-miss");
		process.env.PI_OPENING = "nope";
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { pi, calls, handlers } = createStub();
		openingFactory()(pi);
		handlers.get("session_start")!(sessionStart(), sessionCtx(cwd, [{ type: "session" }]));
		expect(calls).toHaveLength(0);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('"nope" not found'));
		warn.mockRestore();
	});
});
