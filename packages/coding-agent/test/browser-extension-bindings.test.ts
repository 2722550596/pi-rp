/**
 * Browser extension binding (S8.5) integration tests — 19 号 §3 B1/B5/B9/B10/B11 + §10
 * T1(集成面)/T2/T3/T6/T9/T10/T11。
 *
 * 不经 createPiHarness 全链（其 OPFS/sqlite 装配不进 node 测试；19 号 §10 基线）：
 * 以 createAgentSession + `bindExtensions(assembleExtensionBindings(...))` 复刻 S8.5 的
 * 恒绑定时序（与 assemble.ts 插入点同一调用形状），在真实 AgentSession/ExtensionRunner
 * 上断言 session_start 发射、ctx.hasUI/mode 语义、reload 重挂、双绑定禁令与子代理继承。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CreatePiHarnessOptions } from "../../browser-engine/src/assemble.ts";
import { assembleExtensionBindings, createHostExtensionUIContext } from "../../browser-engine/src/extension-ui.ts";
import { AgentSession } from "../src/core/agent-session.ts";
import type { ExtensionUIContext } from "../src/core/extensions/types.ts";
import { spawnAgent } from "../src/core/subagent/spawn.ts";
import { createOpeningExtension } from "../src/extensions/opening/index.ts";
import type { OpeningPresetSource } from "../src/extensions/opening/preset.ts";
import { createHarnessWithExtensions, type Harness } from "./test-harness.ts";

/** 测试缝：S8.5 装配器只读 ui/opening 字段。 */
function harnessOptions(partial: Partial<CreatePiHarnessOptions>): CreatePiHarnessOptions {
	return partial as CreatePiHarnessOptions;
}

function hostUiContext(): ExtensionUIContext {
	return createHostExtensionUIContext({ request: async () => undefined, fire: () => {} });
}

interface SeenStart {
	reason: string;
	mode: string;
	hasUI: boolean;
	ui: ExtensionUIContext;
}

const OPENING_INLINE: OpeningPresetSource[] = [
	{ id: "a", name: "Preset A", messages: [{ role: "user", content: "cold open" }] },
];

async function createSeededHarness(): Promise<Harness> {
	return await createHarnessWithExtensions({
		extensionFactories: [
			createOpeningExtension({ getOpeningId: () => "a", inline: OPENING_INLINE }),
			(pi) => {
				pi.on("session_start", (event, ctx) => {
					seen.push({ reason: event.reason, mode: ctx.mode, hasUI: ctx.hasUI, ui: ctx.ui });
				});
			},
		],
	});
}

const seen: SeenStart[] = [];

afterEach(() => {
	seen.length = 0;
});

describe("S8.5 constant binding (C3)", () => {
	it("T1: default bindings fire session_start(startup) once with honest no-op UI face", async () => {
		const harness = await createHarnessWithExtensions({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", (event, ctx) => {
						seen.push({ reason: event.reason, mode: ctx.mode, hasUI: ctx.hasUI, ui: ctx.ui });
					});
				},
			],
		});
		try {
			await harness.session.bindExtensions(assembleExtensionBindings(harnessOptions({})));

			expect(seen).toHaveLength(1);
			expect(seen[0]).toMatchObject({ reason: "startup", mode: "rpc", hasUI: false });
			// ctx.ui 是 noOpUIContext：notify 静默 no-op（缺省签收口径，B1）。
			expect(() => seen[0]!.ui.notify("dropped", "info")).not.toThrow();
			expect(harness.session.extensionRunner.hasUI()).toBe(false);
			expect(harness.session.extensionRunner.getMode()).toBe("rpc");
		} finally {
			harness.cleanup();
		}
	});

	it("T2/T6: ui.uiContext lights hasUI and passes through unwrapped; opening seeds message + audit", async () => {
		const uiContext = hostUiContext();
		const harness = await createSeededHarness();
		try {
			await harness.session.bindExtensions(assembleExtensionBindings(harnessOptions({ ui: { uiContext } })));

			expect(seen).toHaveLength(1);
			expect(seen[0]).toMatchObject({ reason: "startup", hasUI: true });
			expect(seen[0]!.ui).toBe(uiContext);
			expect(harness.session.extensionRunner.getUIContext()).toBe(uiContext);
			expect(harness.session.extensionRunner.hasUI()).toBe(true);

			// B6：播种发生在 bindExtensions 内——harness 返回即已就位（真实 message entry + audit）。
			const entries = harness.sessionManager.getEntries();
			expect(entries.filter((e) => e.type === "message")).toHaveLength(1);
			// audit 落账形状 = custom entry（appendCustomEntry("opening", {name, seededAt})，§5）。
			expect(entries.some((e) => e.type === "custom" && e.customType === "opening")).toBe(true);
		} finally {
			harness.cleanup();
		}
	});

	it("T3: ui with mode only keeps noOp uiContext but still fires the lifecycle", async () => {
		const harness = await createHarnessWithExtensions({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", (event, ctx) => {
						seen.push({ reason: event.reason, mode: ctx.mode, hasUI: ctx.hasUI, ui: ctx.ui });
					});
				},
			],
		});
		try {
			await harness.session.bindExtensions(assembleExtensionBindings(harnessOptions({ ui: { mode: "json" } })));

			expect(seen).toHaveLength(1);
			expect(seen[0]).toMatchObject({ reason: "startup", mode: "json", hasUI: false });
			expect(harness.session.extensionRunner.hasUI()).toBe(false);
		} finally {
			harness.cleanup();
		}
	});
});

describe("reload / double-bind semantics", () => {
	it("T9: reload re-attaches the same uiContext on the rebuilt runner and fires session_start(reload) without reseeding", async () => {
		const uiContext = hostUiContext();
		const harness = await createSeededHarness();
		try {
			await harness.session.bindExtensions(assembleExtensionBindings(harnessOptions({ ui: { uiContext } })));
			expect(seen.map((s) => s.reason)).toEqual(["startup"]);

			await harness.session.reload();

			expect(seen.map((s) => s.reason)).toEqual(["startup", "reload"]);
			expect(seen[1]!.ui).toBe(uiContext);
			// B7：reload 重建 runner 后 UI 重挂（_applyExtensionBindings on rebuild）。
			expect(harness.session.extensionRunner.getUIContext()).toBe(uiContext);

			// skipIfSeeded：已播会话不重播（B9/T7）。
			const entries = harness.sessionManager.getEntries();
			expect(entries.filter((e) => e.type === "message")).toHaveLength(1);
			expect(entries.filter((e) => e.type === "custom" && e.customType === "opening")).toHaveLength(1);
		} finally {
			harness.cleanup();
		}
	});

	it("T10: a second bindExtensions re-emits session_start (the ban is documentation-level)", async () => {
		const harness = await createHarnessWithExtensions({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", (event, ctx) => {
						seen.push({ reason: event.reason, mode: ctx.mode, hasUI: ctx.hasUI, ui: ctx.ui });
					});
				},
			],
		});
		try {
			const bindings = assembleExtensionBindings(harnessOptions({}));
			await harness.session.bindExtensions(bindings);
			await harness.session.bindExtensions(bindings);

			expect(seen.map((s) => s.reason)).toEqual(["startup", "startup"]);
		} finally {
			harness.cleanup();
		}
	});
});

describe("T11: subagent inherits the bound UI seam (B11, zero new code)", () => {
	it("spawnAgent binds the child session with the parent's uiContext instance and mode", async () => {
		const uiContext = hostUiContext();
		const harness = await createSeededHarness();
		const bindSpy = vi.spyOn(AgentSession.prototype, "bindExtensions");
		try {
			await harness.session.bindExtensions(assembleExtensionBindings(harnessOptions({ ui: { uiContext } })));

			// 可委派 preset（spawnAgent 的 profileId 解析面）。
			const presetDir = join(harness.tempDir, ".pi", "prompt-presets");
			mkdirSync(presetDir, { recursive: true });
			writeFileSync(
				join(presetDir, "spawn-test.json"),
				JSON.stringify({
					schemaVersion: 1,
					id: "spawn-test",
					delegatable: true,
					items: [{ kind: "block", id: "role", enabled: true, role: "system", content: "spawn peer." }],
				}),
			);
			harness.session.reloadPresets();

			await spawnAgent(harness.session, { profileId: "spawn-test", task: "t" });

			// run.ts:189-193：子会话 bindExtensions 收父 runner 的 uiContext 实例与 mode。
			const childBindings = bindSpy.mock.calls.at(-1)?.[0];
			expect(childBindings?.uiContext).toBe(uiContext);
			expect(childBindings?.mode).toBe("rpc");
			expect(typeof childBindings?.onError).toBe("function");
		} finally {
			bindSpy.mockRestore();
			harness.cleanup();
		}
	});
});
