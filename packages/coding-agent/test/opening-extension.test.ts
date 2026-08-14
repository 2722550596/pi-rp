/**
 * Opening extension tests — generic seeding through the public factory.
 *
 * The builtin opening extension is role-agnostic: every message (user/assistant
 * real entries, arbitrary customTypes) and every state namespace applies to the
 * current process. Role-filtered deployments (e.g. worldlines) transform the
 * preset before applying — out of scope here.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import openingExtension from "../src/extensions/opening/index.ts";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, SessionStartEvent } from "../src/index.ts";

// ── Recording stub ───────────────────────────────────────────────────────────

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
			// Reject unknown paths so the warn-and-skip path is observable.
			const path = String(args[0] ?? "");
			return path.startsWith("bad.") ? { ok: false, reason: "schema rejected" } : { ok: true, path };
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
		mode: "json",
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

// ── Fixture ─────────────────────────────────────────────────────────────────

const roots: string[] = [];

function fixture(name: string): { root: string; cwd: string } {
	const root = join(tmpdir(), `pi-opening-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const cwd = join(root, "cfg");
	// Presets resolve to <cwd>/<projectConfigDir>/openings (default .pi).
	mkdirSync(join(cwd, ".pi", "openings"), { recursive: true });
	roots.push(root);
	return { root, cwd };
}

function writePreset(cwd: string, id: string, preset: unknown): void {
	writeFileSync(join(cwd, ".pi", "openings", `${id}.json`), JSON.stringify(preset));
}

const PRESET = {
	name: "Smoke Test",
	description: "smoke fixture",
	messages: [
		{ role: "assistant", content: "旁白" },
		{ customType: "narration", content: "场景叙事：清晨的门口。" },
		{ customType: "character_reply", display: true, details: { character_id: "lin" }, content: "林说：来了？" },
		{ role: "user", content: "玩家输入" },
	],
	state: { world: { scene: "门口" }, lin: { location: "门口" } },
};

const originalEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	for (const key of ["PI_OPENING", "WL_OPENING", "PI_OPENINGS_DIR"]) {
		originalEnv[key] = process.env[key];
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

// ── Tests ───────────────────────────────────────────────────────────────────

describe("opening extension", () => {
	it("auto-applies on session_start when PI_OPENING is set", () => {
		const { cwd } = fixture("writer");
		writePreset(cwd, "test", PRESET);
		process.env.PI_OPENING = "test";
		const { pi, calls, handlers } = createStub();
		openingExtension(pi);
		const handler = handlers.get("session_start");
		expect(handler).toBeDefined();

		handler!(sessionStart(), sessionCtx(cwd, [{ type: "session" }]));

		const appendedMessages = calls.filter((c) => c.op === "appendEntry" && c.args[0] === "message");
		expect(appendedMessages.map((c) => c.args[1])).toEqual([
			{ role: "assistant", content: "旁白" },
			{ role: "user", content: "玩家输入" },
		]);

		const custom = calls.filter((c) => c.op === "sendMessage");
		expect(custom).toHaveLength(2);
		expect(custom[0].args[0]).toMatchObject({ customType: "narration", display: true });
		expect(custom[1].args[0]).toMatchObject({
			customType: "character_reply",
			details: { character_id: "lin" },
		});

		const stateOps = calls.filter((c) => c.op === "updateState");
		expect(stateOps.map((c) => c.args[0])).toEqual(["world.scene", "lin.location"]);

		const audit = calls.filter((c) => c.op === "appendEntry" && c.args[0] === "opening");
		expect(audit).toHaveLength(1);
		expect(audit[0].args[1]).toMatchObject({ name: "test" });
	});

	it("ignores WL_OPENING (worldlines layer owns the legacy env)", () => {
		const { cwd } = fixture("wl-env");
		writePreset(cwd, "test", { name: "T", messages: [] });
		process.env.WL_OPENING = "test";
		const { pi, calls, handlers } = createStub();
		openingExtension(pi);
		handlers.get("session_start")!(sessionStart(), sessionCtx(cwd, [{ type: "session" }]));
		expect(calls).toHaveLength(0);
	});

	it("skips when the session already has messages (resume/reload)", () => {
		const { cwd } = fixture("seeded");
		writePreset(cwd, "test", PRESET);
		process.env.PI_OPENING = "test";
		const { pi, calls, handlers } = createStub();
		openingExtension(pi);
		handlers.get("session_start")!(sessionStart("reload"), sessionCtx(cwd, [{ type: "message" }]));
		expect(calls).toHaveLength(0);
	});

	it("does nothing without the env (zero overhead)", () => {
		const { cwd } = fixture("noenv");
		const { pi, calls, handlers } = createStub();
		openingExtension(pi);
		handlers.get("session_start")!(sessionStart(), sessionCtx(cwd, []));
		expect(calls).toHaveLength(0);
	});

	it("warns and skips messages without role or customType", () => {
		const { cwd } = fixture("malformed");
		writePreset(cwd, "test", { messages: [{ content: "orphan" }] });
		process.env.PI_OPENING = "test";
		const { pi, calls, handlers } = createStub();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		openingExtension(pi);
		handlers.get("session_start")!(sessionStart(), sessionCtx(cwd, [{ type: "session" }]));

		expect(calls.filter((c) => c.args[0] === "message" || c.op === "sendMessage")).toHaveLength(0);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("without role or customType"));
		warn.mockRestore();
	});

	it("skips schema-rejected state leaves with a warning, applies the rest", () => {
		const { cwd } = fixture("badstate");
		writePreset(cwd, "test", {
			messages: [],
			state: { world: { scene: "门口" }, bad: { x: 1 } },
		});
		process.env.PI_OPENING = "test";
		const { pi, calls, handlers } = createStub();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		openingExtension(pi);
		handlers.get("session_start")!(sessionStart(), sessionCtx(cwd, [{ type: "session" }]));

		const stateOps = calls.filter((c) => c.op === "updateState");
		expect(stateOps.map((c) => c.args[0])).toEqual(["world.scene", "bad.x"]);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("bad.x"));
		warn.mockRestore();
	});

	it("registers the /opening command: no-arg lists presets, id applies", async () => {
		const { cwd } = fixture("command");
		writePreset(cwd, "test", PRESET);
		const { pi, calls, commands } = createStub();
		openingExtension(pi);
		expect(commands.map((c) => c.name)).toEqual(["opening"]);

		const notifications: string[] = [];
		const ctx = {
			...sessionCtx(cwd, []),
			ui: { notify: (message: string) => notifications.push(message) },
		} as unknown as ExtensionCommandContext;

		// no arg → list
		await commands[0].handler("", ctx);
		expect(notifications.join("\n")).toContain("Smoke Test (test)");

		// id → apply
		await commands[0].handler("test", ctx);
		expect(calls.some((c) => c.op === "sendMessage")).toBe(true);
		expect(notifications.some((n) => n.includes('Opening "Smoke Test" applied'))).toBe(true);

		// unknown id → error
		await commands[0].handler("missing", ctx);
		expect(notifications.some((n) => n.includes('Opening preset "missing" not found'))).toBe(true);
	});

	it("resolves presets from PI_OPENINGS_DIR when set", () => {
		const { root } = fixture("customdir");
		const customDir = join(root, "custom");
		mkdirSync(customDir, { recursive: true });
		// PI_OPENINGS_DIR IS the openings directory (files live directly in it).
		writeFileSync(join(customDir, "alt.json"), JSON.stringify({ name: "Alt", messages: [] }));
		process.env.PI_OPENINGS_DIR = customDir;
		process.env.PI_OPENING = "alt";

		const { pi, calls, handlers } = createStub();
		openingExtension(pi);
		handlers.get("session_start")!(sessionStart(), sessionCtx(join(root, "elsewhere"), [{ type: "session" }]));
		expect(calls.some((c) => c.op === "appendEntry" && c.args[0] === "opening")).toBe(true);
	});

	it("warns when the preset file is missing or malformed", () => {
		const { cwd } = fixture("missing");
		process.env.PI_OPENING = "nope";
		const { pi, calls, handlers } = createStub();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		openingExtension(pi);
		handlers.get("session_start")!(sessionStart(), sessionCtx(cwd, [{ type: "session" }]));
		expect(calls).toHaveLength(0);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('"nope" not found'));
		warn.mockRestore();
	});
});
