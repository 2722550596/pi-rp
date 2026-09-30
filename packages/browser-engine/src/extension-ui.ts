/**
 * Browser/hosted 剖面的扩展 UI 接缝（19 号 §2.3/§2.4/§3 B12；契约 §3.5 E4）。
 *
 * 纯模块：零 node:、零 OPFS/sqlite、零 pi-tui 运行时 import。
 * - `theme` 引既有 modes/interactive/theme/theme.ts（runner.ts / rpc-mode.ts 同源）；
 *   browser 构建期该模块被 piTuiStubPlugin 拦截为恒空对象，扩展读 `ctx.ui.theme.*` 得
 *   undefined 而非崩溃（19 号 §7 E6）。
 * - wire 类型 type-only import rpc-types（U2 裁决：打包期擦除，modes/rpc 零运行时进包）。
 *
 * `createHostExtensionUIContext` 与 modes/rpc/rpc-mode.ts 的 `createExtensionUIContext`
 * 逐成员同构（B12 对照表）；两实现各自独立维护、不抽共享纯函数（评审门复杂度②裁决，
 * modes/rpc 零改动维持），防漂移由 coding-agent/test/extension-ui.test.ts 的 T14
 * 双实现 diff 断言承担。
 */

import type { ExtensionBindings } from "../../coding-agent/src/core/agent-session.ts";
import type {
	ExtensionError,
	ExtensionMode,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	WorkingIndicatorOptions,
} from "../../coding-agent/src/core/extensions/types.ts";
import { type Theme, theme } from "../../coding-agent/src/modes/interactive/theme/theme.ts";
import type { RpcExtensionUIRequest, RpcExtensionUIResponse } from "../../coding-agent/src/modes/rpc/rpc-types.ts";
import type { CreatePiHarnessOptions } from "./assemble.ts";

/**
 * 宿主回调面（§2.3）。request 双程、fire 单程均必填（U7），notify 也通过 fire
 * 发同 RPC 协议的 extension_ui_request，供现有 extension_ui_request 消费端直接复用。
 */
export interface HostExtensionUiHandlers {
	/** 双程通道：select/confirm/input/editor。返回 undefined 视同 cancelled。
	 *  timeout/signal 的到期兜底由本工厂在引擎侧执行（对齐 rpc-mode createDialogPromise
	 *  语义：signal 已中止 ⇒ 立即缺省值；timeout 到期 ⇒ 缺省值），宿主无须自行计时，
	 *  只面对未到期的活跃请求。 */
	request(req: RpcExtensionUIRequest): Promise<RpcExtensionUIResponse | undefined>;
	/** 所有单程 UI 请求（notify/setStatus/setWidget/setTitle/set_editor_text）的必需出口。 */
	fire(req: RpcExtensionUIRequest): void;
}

/**
 * E1（§7）：扩展错误通道缺省记录器。emitError 无监听器时静默丢弃（runner.ts 空 Set 循环），
 * 全仓唯一订阅点是 bindExtensions 的 bindings.onError——恒传 onError 才不让对话框失败
 * 灭在半路。console 在浏览器宿主可用且可见（与 RPC 模式同权重的 extension_error 输出）。
 */
function defaultExtensionOnError(error: ExtensionError): void {
	console.error("[pi-extension]", error.extensionPath, error.event, error.error);
}

/**
 * S8.5 的纯装配函数（C3 裁决）：从 options 恒推导 ExtensionBindings，无 undefined 分支——
 * 「无 ui 无 opening」缺省装配也返回 bindings（noOp UIContext + mode "rpc" + 内置记录器），
 * session_start 生命周期因此必达。mode "tui" 组装期拒绝（U5）。
 */
export function assembleExtensionBindings(options: CreatePiHarnessOptions): ExtensionBindings {
	const mode: ExtensionMode = options.ui?.mode ?? "rpc";
	if (mode === "tui") {
		// 宿主没有 TUI 对象可交给组件工厂；声明与注入形状不一致即报错（S1 剖面纯断言同构）。
		throw new Error('pi-harness: ui.mode "tui" is not meaningful without a terminal TUI; use "rpc"');
	}
	return {
		uiContext: options.ui?.uiContext,
		mode,
		onError: options.ui?.onError ?? defaultExtensionOnError,
	};
}

/**
 * 宿主回调工厂（B12 对照表的实现规格 = RPC 形状投影）：双程超时/中止兜底在引擎侧执行，
 * 单程异常吞并 console.warn（E2：单程通道不允许反压扩展事件循环）。
 */
export function createHostExtensionUIContext(handlers: HostExtensionUiHandlers): ExtensionUIContext {
	/** 双程对话框：signal 已中止 ⇒ 缺省值；timeout 到期 ⇒ 缺省值；request 抛/reject ⇒ promise reject；
	 *  response undefined = cancelled（与显式 cancelled 响应同落缺省值通道，§2.3）。 */
	function createDialogPromise<T>(
		opts: ExtensionUIDialogOptions | undefined,
		defaultValue: T,
		request: Record<string, unknown>,
		parseResponse: (response: RpcExtensionUIResponse) => T,
	): Promise<T> {
		if (opts?.signal?.aborted) return Promise.resolve(defaultValue);

		const id = crypto.randomUUID();
		const wire = { type: "extension_ui_request", id, ...request } as RpcExtensionUIRequest;
		const { promise, resolve, reject } = Promise.withResolvers<T>();
		let timeoutId: ReturnType<typeof setTimeout> | undefined;

		const cleanup = () => {
			clearTimeout(timeoutId);
			opts?.signal?.removeEventListener("abort", onAbort);
		};

		const onAbort = () => {
			cleanup();
			resolve(defaultValue);
		};
		opts?.signal?.addEventListener("abort", onAbort, { once: true });

		if (opts?.timeout) {
			timeoutId = setTimeout(() => {
				cleanup();
				resolve(defaultValue);
			}, opts.timeout);
		}

		let requestPromise: Promise<RpcExtensionUIResponse | undefined>;
		try {
			requestPromise = handlers.request(wire);
		} catch (err) {
			// 同步 throw 与 reject 同通道（E2）。
			cleanup();
			reject(err);
			return promise;
		}
		void requestPromise.then(
			(response) => {
				cleanup();
				resolve(response === undefined ? defaultValue : parseResponse(response));
			},
			(error) => {
				cleanup();
				reject(error);
			},
		);
		return promise;
	}

	/** 单程 fire：宿主异常吞并 console.warn，不让宿主 bug 反压扩展事件循环（E2）。 */
	function fireChecked(req: RpcExtensionUIRequest): void {
		try {
			handlers.fire(req);
		} catch (err) {
			console.warn("[pi-extension-ui] host fire handler threw:", err);
		}
	}

	return {
		select: (title, options, opts) =>
			createDialogPromise(opts, undefined, { method: "select", title, options, timeout: opts?.timeout }, (r) =>
				"cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined,
			),

		confirm: (title, message, opts) =>
			createDialogPromise(opts, false, { method: "confirm", title, message, timeout: opts?.timeout }, (r) =>
				"cancelled" in r && r.cancelled ? false : "confirmed" in r ? r.confirmed : false,
			),

		input: (title, placeholder, opts) =>
			createDialogPromise(opts, undefined, { method: "input", title, placeholder, timeout: opts?.timeout }, (r) =>
				"cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined,
			),

		notify(message: string, type?: "info" | "warning" | "error"): void {
			fireChecked({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "notify",
				message,
				notifyType: type,
			});
		},
		onTerminalInput(): () => void {
			// Raw terminal input not supported without a terminal
			return () => {};
		},

		setStatus(key: string, text: string | undefined): void {
			fireChecked({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "setStatus",
				statusKey: key,
				statusText: text,
			});
		},

		setWorkingMessage(_message?: string): void {
			// Working message not supported without a TUI loader
		},

		setWorkingVisible(_visible: boolean): void {
			// Working visibility not supported without a TUI loader
		},

		setWorkingIndicator(_options?: WorkingIndicatorOptions): void {
			// Working indicator customization not supported without a TUI loader
		},

		setHiddenThinkingLabel(_label?: string): void {
			// Hidden thinking label not supported without TUI message rendering access
		},

		setWidget(key: string, content: unknown, options?: ExtensionWidgetOptions): void {
			// Only string arrays cross the wire - component factories are dropped (TUI-only)
			if (content === undefined || Array.isArray(content)) {
				fireChecked({
					type: "extension_ui_request",
					id: crypto.randomUUID(),
					method: "setWidget",
					widgetKey: key,
					widgetLines: content as string[] | undefined,
					widgetPlacement: options?.placement,
				});
			}
		},

		setFooter(_factory: unknown): void {
			// Custom footer not supported without TUI access
		},

		setHeader(_factory: unknown): void {
			// Custom header not supported without TUI access
		},

		setTitle(title: string): void {
			fireChecked({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "setTitle",
				title,
			});
		},

		async custom() {
			// Custom UI not supported without a terminal
			return undefined as never;
		},

		pasteToEditor(text: string): void {
			// Paste handling falls back to setEditorText
			this.setEditorText(text);
		},

		setEditorText(text: string): void {
			fireChecked({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "set_editor_text",
				text,
			});
		},

		getEditorText(): string {
			// Synchronous method can't wait across the host channel;
			// host should track editor state locally if needed
			return "";
		},

		async editor(title: string, prefill?: string): Promise<string | undefined> {
			const id = crypto.randomUUID();
			const { promise, resolve, reject } = Promise.withResolvers<string | undefined>();
			let requestPromise: Promise<RpcExtensionUIResponse | undefined>;
			try {
				requestPromise = handlers.request({
					type: "extension_ui_request",
					id,
					method: "editor",
					title,
					prefill,
				});
			} catch (err) {
				reject(err);
				return promise;
			}
			void requestPromise.then(
				(response) => {
					if (response === undefined || ("cancelled" in response && response.cancelled)) {
						resolve(undefined);
					} else if ("value" in response) {
						resolve(response.value);
					} else {
						resolve(undefined);
					}
				},
				(error) => {
					reject(error);
				},
			);
			return promise;
		},

		addAutocompleteProvider(): void {
			// Autocomplete provider composition is not supported without a TUI
		},

		setEditorComponent(): void {
			// Custom editor components not supported without a TUI
		},

		getEditorComponent() {
			// Custom editor components not supported without a TUI
			return undefined;
		},

		get theme() {
			return theme;
		},

		getAllThemes() {
			return [];
		},

		getTheme(_name: string) {
			return undefined;
		},

		setTheme(_theme: string | Theme) {
			// Theme switching is a pure TUI concern (契约 §3.6：主题扫描不做)
			return { success: false, error: "Theme switching not supported in RPC mode" };
		},

		getToolsExpanded() {
			// Tool expansion not supported - no TUI
			return false;
		},

		setToolsExpanded(_expanded: boolean) {
			// Tool expansion not supported - no TUI
		},
	};
}
