/**
 * Extension UI seam tests（19 号 §10：T1-T5 纯模块 + T14 双实现防漂移）。
 *
 * - `assembleExtensionBindings`（browser-engine S8.5 纯装配）与
 *   `createHostExtensionUIContext`（B12 宿主回调工厂）是纯模块，直接单测。
 * - T14：同一组 mock handlers 喂 rpc-mode 的 `createRpcExtensionUIContext`（test-only 出口，
 *   output/pending 注入参）与宿主工厂，逐成员 diff wire 请求与返回映射——两实现各自独立
 *   维护（评审门复杂度②：不抽共享纯函数），漂移由本文件拦截。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreatePiHarnessOptions } from "../../browser-engine/src/assemble.ts";
import { assembleExtensionBindings, createHostExtensionUIContext } from "../../browser-engine/src/extension-ui.ts";
import type { ExtensionUIContext } from "../src/core/extensions/types.ts";
import { theme } from "../src/modes/interactive/theme/theme.ts";
import { createRpcExtensionUIContext, type RpcPendingExtensionRequests } from "../src/modes/rpc/rpc-mode.ts";
import type { RpcExtensionUIRequest, RpcExtensionUIResponse } from "../src/modes/rpc/rpc-types.ts";

/** 测试缝：装配器只读 ui/opening 字段，Partial 注入即可（其余字段为装配期早于 S8.5 的输入）。 */
function harnessOptions(partial: Partial<CreatePiHarnessOptions>): CreatePiHarnessOptions {
	return partial as CreatePiHarnessOptions;
}

// ── S8.5 绑定装配（T1-T4，C3 恒绑定）────────────────────────────────────────

describe("assembleExtensionBindings", () => {
	it("T1: default (no ui / no opening) yields constant bindings with builtin console onError", () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const bindings = assembleExtensionBindings(harnessOptions({}));
			expect("uiContext" in bindings).toBe(true);
			expect(bindings.uiContext).toBeUndefined();
			expect(bindings.mode).toBe("rpc");
			expect(typeof bindings.onError).toBe("function");

			// E1：内置记录器形状 = console.error("[pi-extension]", extensionPath, event, error)。
			bindings.onError?.({ extensionPath: "/ext/x.ts", event: "session_start", error: "boom" });
			expect(errorSpy).toHaveBeenCalledWith("[pi-extension]", "/ext/x.ts", "session_start", "boom");
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("T2: ui.uiContext / onError pass through unwrapped; explicit mode wins", () => {
		const uiContext = createHostExtensionUIContext({ request: async () => undefined, fire: () => {} });
		const onError = () => {};
		const bindings = assembleExtensionBindings(harnessOptions({ ui: { uiContext, mode: "json", onError } }));
		expect(bindings.uiContext).toBe(uiContext);
		expect(bindings.mode).toBe("json");
		expect(bindings.onError).toBe(onError);
	});

	it("T3: ui with mode only keeps noOp uiContext (lifecycle without dialogs, U3)", () => {
		const bindings = assembleExtensionBindings(harnessOptions({ ui: { mode: "print" } }));
		expect(bindings.uiContext).toBeUndefined();
		expect(bindings.mode).toBe("print");
		expect(typeof bindings.onError).toBe("function");
	});

	it("T4: ui.mode tui is rejected at assembly with an rpc hint (U5/E8)", () => {
		expect(() => assembleExtensionBindings(harnessOptions({ ui: { mode: "tui" } }))).toThrowError(
			/ui\.mode "tui" is not meaningful without a terminal TUI; use "rpc"/,
		);
	});
});

// ── B12 宿主回调工厂逐成员（T5）─────────────────────────────────────────────

describe("createHostExtensionUIContext", () => {
	let warnSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		warnSpy.mockRestore();
	});

	it("T5: select resolves value; cancelled and timeout fall back to undefined", async () => {
		const ctx = createHostExtensionUIContext({
			request: async (req) => ({ type: "extension_ui_response", id: req.id, value: "b" }),
			fire: () => {},
		});
		await expect(ctx.select("Pick", ["a", "b"])).resolves.toBe("b");

		const cancelled = createHostExtensionUIContext({
			request: async (req) => ({ type: "extension_ui_response", id: req.id, cancelled: true }),
			fire: () => {},
		});
		await expect(cancelled.select("Pick", ["a"])).resolves.toBeUndefined();

		const silent = createHostExtensionUIContext({ request: async () => undefined, fire: () => {} });
		await expect(silent.select("Pick", ["a"], { timeout: 25 })).resolves.toBeUndefined();
	});

	it("T5: confirm falls back to false (never true) on timeout/cancelled", async () => {
		const silent = createHostExtensionUIContext({ request: async () => undefined, fire: () => {} });
		await expect(silent.confirm("Sure?", "msg", { timeout: 25 })).resolves.toBe(false);

		const cancelled = createHostExtensionUIContext({
			request: async (req) => ({ type: "extension_ui_response", id: req.id, cancelled: true }),
			fire: () => {},
		});
		await expect(cancelled.confirm("Sure?", "msg")).resolves.toBe(false);

		const yes = createHostExtensionUIContext({
			request: async (req) => ({ type: "extension_ui_response", id: req.id, confirmed: true }),
			fire: () => {},
		});
		await expect(yes.confirm("Sure?", "msg")).resolves.toBe(true);
	});

	it("T5: dialog wire payloads carry method/fields/timeout; aborted signal short-circuits", async () => {
		const wire: RpcExtensionUIRequest[] = [];
		const ctx = createHostExtensionUIContext({ request: async () => undefined, fire: () => {} });
		// 用带 wire 捕获的工厂重放一次 select，校验载荷字段（B12 行 1）。
		const capture = createHostExtensionUIContext({
			request: async (req) => {
				wire.push(req);
				return undefined;
			},
			fire: () => {},
		});
		await capture.select("Pick", ["a", "b"], { timeout: 1000 });
		expect(wire[0]).toMatchObject({ method: "select", title: "Pick", options: ["a", "b"], timeout: 1000 });

		const ac = new AbortController();
		const abortP = ctx.select("Abort", ["y"], { signal: ac.signal });
		ac.abort();
		await expect(abortP).resolves.toBeUndefined();
	});

	it("T5: notify emits the RPC-shaped extension_ui_request through required fire", () => {
		const fired: RpcExtensionUIRequest[] = [];
		const ctx = createHostExtensionUIContext({
			request: async () => undefined,
			fire: (req) => fired.push(req),
		});
		ctx.notify("hello", "warning");
		ctx.notify("plain");

		expect(fired).toHaveLength(2);
		expect(fired[0]).toMatchObject({
			type: "extension_ui_request",
			method: "notify",
			message: "hello",
			notifyType: "warning",
		});
		expect(fired[0]?.id).toMatch(/^[\da-f-]{36}$/i);
		expect(fired[1]).toMatchObject({
			type: "extension_ui_request",
			method: "notify",
			message: "plain",
		});
		expect(fired[1]).toHaveProperty("notifyType", undefined);
	});

	it("T5: single-channel members dispatch through fire; widget factories are dropped", () => {
		const fired: RpcExtensionUIRequest[] = [];
		const ctx = createHostExtensionUIContext({
			request: async () => undefined,
			fire: (req) => fired.push(req),
		});

		ctx.setStatus("k", "v");
		ctx.setWidget("w", ["l1", "l2"], { placement: "belowEditor" });
		ctx.setWidget("w", undefined);
		const widgetFactory = () => ({}) as never;
		ctx.setWidget("f", widgetFactory);
		ctx.setTitle("T");
		ctx.setEditorText("edit");
		ctx.pasteToEditor("pasted");

		const stripped = fired.map((req) => {
			const { id: _id, type: _type, ...rest } = req;
			return rest;
		});
		expect(stripped).toEqual([
			{ method: "setStatus", statusKey: "k", statusText: "v" },
			{ method: "setWidget", widgetKey: "w", widgetLines: ["l1", "l2"], widgetPlacement: "belowEditor" },
			{ method: "setWidget", widgetKey: "w", widgetLines: undefined, widgetPlacement: undefined },
			{ method: "setTitle", title: "T" },
			{ method: "set_editor_text", text: "edit" },
			{ method: "set_editor_text", text: "pasted" },
		]);
		expect(fired.some((req) => "method" in req && req.method === "setWidget" && req.widgetKey === "f")).toBe(false);
	});

	it("T5: TUI-only faces are honest no-ops (getEditorText '', theme stub identity, themes rejected)", async () => {
		const ctx = createHostExtensionUIContext({ request: async () => undefined, fire: () => {} });
		expect(ctx.getEditorText()).toBe("");
		expect(ctx.setTheme("dark")).toEqual({ success: false, error: "Theme switching not supported in RPC mode" });
		expect(ctx.getAllThemes()).toEqual([]);
		expect(ctx.getTheme("dark")).toBeUndefined();
		expect(ctx.getToolsExpanded()).toBe(false);
		expect(ctx.theme).toBe(theme);
		await expect(ctx.custom()).resolves.toBeUndefined();
		expect(typeof ctx.onTerminalInput(() => undefined)).toBe("function");
		expect(ctx.getEditorComponent()).toBeUndefined();
	});

	it("T5/E2: editor resolves undefined on cancelled; host request reject/throw rejects the dialog", async () => {
		const cancelled = createHostExtensionUIContext({
			request: async (req) => ({ type: "extension_ui_response", id: req.id, cancelled: true }),
			fire: () => {},
		});
		await expect(cancelled.editor("Edit", "pre")).resolves.toBeUndefined();

		const rejecting = createHostExtensionUIContext({
			request: async () => {
				throw new Error("host exploded");
			},
			fire: () => {},
		});
		await expect(rejecting.select("t", ["x"])).rejects.toThrow("host exploded");

		const syncThrow = createHostExtensionUIContext({
			request: () => {
				throw new Error("sync host boom");
			},
			fire: () => {},
		});
		await expect(syncThrow.input("t", "ph")).rejects.toThrow("sync host boom");
	});

	it("E2: throwing fire handlers are contained (including notify, no propagation into extensions)", () => {
		const ctx = createHostExtensionUIContext({
			request: async () => undefined,
			fire: () => {
				throw new Error("fire boom");
			},
		});
		expect(() => ctx.setStatus("k", "v")).not.toThrow();
		expect(() => ctx.notify("m", "info")).not.toThrow();
		expect(warnSpy).toHaveBeenCalledTimes(2);
	});
});

// ── T14：双实现防漂移 diff（rpc-mode test-only 出口 vs 宿主工厂）────────────

type Responseish = { value?: string; confirmed?: boolean; cancelled?: true };

function stripWire(req: RpcExtensionUIRequest): Record<string, unknown> {
	const { id: _id, type: _type, ...rest } = req;
	return { ...rest };
}

function toResponse(id: string, r: Responseish): RpcExtensionUIResponse {
	// 测试夹具：形状由各实现的 parse 回调校验（value/confirmed/cancelled 三键）。
	return { type: "extension_ui_response", id, ...r } as RpcExtensionUIResponse;
}

/** 同一调用脚本：双程（含缺省值路径）+ 单程 + no-op 面；返回逐步结果供映射比对。 */
async function runScript(ctx: ExtensionUIContext, respond: (r: Responseish) => void): Promise<unknown[]> {
	const results: unknown[] = [];

	const selectP = ctx.select("Pick", ["a", "b"]);
	respond({ value: "b" });
	results.push(await selectP);

	const confirmP = ctx.confirm("Sure?", "msg");
	respond({ confirmed: true });
	results.push(await confirmP);

	const inputP = ctx.input("Name", "ph");
	respond({ cancelled: true });
	results.push(await inputP);

	const editorP = ctx.editor("Edit", "pre");
	respond({ cancelled: true });
	results.push(await editorP);

	// 缺省值路径：不 respond，靠 timeout 兜底（select → undefined，confirm → false）。
	results.push(await ctx.select("Slow", ["x"], { timeout: 25 }));
	results.push(await ctx.confirm("Slower", "m", { timeout: 25 }));

	// signal 中止 → 缺省值。
	const ac = new AbortController();
	const abortP = ctx.select("Abort", ["y"], { signal: ac.signal });
	ac.abort();
	results.push(await abortP);

	ctx.notify("hello", "warning");
	ctx.notify("plain");
	ctx.setStatus("k", "v");
	ctx.setWidget("w", ["l1", "l2"], { placement: "belowEditor" });
	ctx.setWidget("w", undefined);
	ctx.setWidget("f", () => ({}) as never); // 工厂形态：两侧都丢弃
	ctx.setTitle("T");
	ctx.setEditorText("edit");
	ctx.pasteToEditor("pasted");
	ctx.setWorkingMessage("wm");
	ctx.setWorkingVisible(true);
	ctx.setWorkingIndicator({ frames: [] });
	ctx.setHiddenThinkingLabel("l");
	ctx.setFooter(undefined);
	ctx.setHeader(undefined);
	ctx.addAutocompleteProvider(undefined as never);
	ctx.setEditorComponent(undefined);
	ctx.setToolsExpanded(true);
	ctx.onTerminalInput(() => undefined)();

	results.push(ctx.getEditorText());
	results.push(await ctx.custom());
	results.push(ctx.setTheme("dark"));
	results.push(ctx.getAllThemes());
	results.push(ctx.getTheme("dark"));
	results.push(ctx.getToolsExpanded());
	results.push(ctx.theme === theme);

	return results;
}

describe("T14: rpc vs host dual-implementation drift diff", () => {
	it("identical wire payloads (sans type/id) and return mappings over the same script", async () => {
		// rpc 侧：output spy + 注入 pending 表（test-only 出口，运行时零变化）。
		const rpcWire: RpcExtensionUIRequest[] = [];
		const rpcPending: RpcPendingExtensionRequests = new Map();
		const rpcCtx = createRpcExtensionUIContext((event) => rpcWire.push(event as RpcExtensionUIRequest), rpcPending);
		const respondRpc = (r: Responseish) => {
			const ids = [...rpcPending.keys()];
			const lastId = ids[ids.length - 1];
			if (lastId === undefined) throw new Error("no pending rpc extension UI request");
			rpcPending.get(lastId)!.resolve(toResponse(lastId, r));
		};

		// 宿主侧：request 双程、所有单程（含 notify）经必填 fire，统一收集 RPC wire 事件。
		// 响应时序与 rpc 的 pending 表同形：respond() 作用于「线上已发出、等待回包」的请求。
		const hostWire: RpcExtensionUIRequest[] = [];
		const hostResolvers: Array<{
			id: string;
			resolve: (response: RpcExtensionUIResponse | undefined) => void;
		}> = [];
		const hostCtx = createHostExtensionUIContext({
			request: async (req) => {
				hostWire.push(req);
				const { promise, resolve } = Promise.withResolvers<RpcExtensionUIResponse | undefined>();
				hostResolvers.push({ id: req.id, resolve });
				return await promise;
			},
			fire: (req) => {
				hostWire.push(req);
			},
		});
		const respondHost = (r: Responseish) => {
			const pending = hostResolvers.shift();
			if (!pending) throw new Error("no pending host extension UI request");
			pending.resolve(toResponse(pending.id, r));
		};

		const hostResults = await runScript(hostCtx, respondHost);
		const rpcResults = await runScript(rpcCtx, respondRpc);

		expect(hostWire.length).toBeGreaterThanOrEqual(14);
		expect(hostWire.map(stripWire)).toEqual(rpcWire.map(stripWire));
		expect(hostResults).toEqual(rpcResults);

		// 映射锚点（T5 对应 B12 关键行）：缺省值方向、theme 恒等、编辑器文本恒空。
		for (const results of [hostResults, rpcResults]) {
			expect(results[0]).toBe("b"); // select value
			expect(results[1]).toBe(true); // confirm confirmed
			expect(results[2]).toBeUndefined(); // input cancelled
			expect(results[3]).toBeUndefined(); // editor cancelled
			expect(results[4]).toBeUndefined(); // select timeout → undefined
			expect(results[5]).toBe(false); // confirm timeout → false（安全对话框失败方向）
			expect(results[6]).toBeUndefined(); // signal aborted → undefined
			expect(results[7]).toBe(""); // getEditorText
			expect(results[9]).toEqual({ success: false, error: "Theme switching not supported in RPC mode" });
			expect(results[13]).toBe(true); // theme === 既有 stub theme（E6 同源）
		}
	});
});
