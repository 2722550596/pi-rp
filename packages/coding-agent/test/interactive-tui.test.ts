import type { Component, Terminal, TUI } from "@earendil-works/pi-tui";
import { Container, isViewportTUI, Text } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { registerBuiltinCommandEntries } from "../src/commands/builtins.ts";
import type { TuiMode } from "../src/core/settings-manager.ts";
import { getCommandEntries } from "../src/core/slash-commands.ts";
import {
	createInteractiveTui,
	createInteractiveTuiReference,
	InteractiveMode,
} from "../src/modes/interactive/interactive-mode.ts";

const clipboardMocks = vi.hoisted(() => ({
	copyToClipboard: vi.fn<(text: string) => Promise<void>>(),
	readClipboardText: vi.fn<() => Promise<string | null>>(),
}));

vi.mock("../src/utils/clipboard.ts", () => clipboardMocks);

class RecordingTerminal extends VirtualTerminal implements Terminal {
	readonly writes: string[] = [];
	startCount = 0;
	stopCount = 0;

	override start(onInput: (data: string) => void, onResize: () => void): void {
		this.startCount += 1;
		super.start(onInput, onResize);
	}

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}

	override stop(): void {
		this.stopCount += 1;
		super.stop();
	}
}

describe("createInteractiveTui", () => {
	it("selects the alternate-screen renderer only when requested", async () => {
		const mainTerminal = new RecordingTerminal();
		const mainTui = createInteractiveTui({
			tuiMode: "regular",
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal: mainTerminal,
		});
		expect(mainTui.mode).toBe("regular");
		expect(isViewportTUI(mainTui)).toBe(false);
		mainTui.start();
		await mainTerminal.waitForRender();
		expect(mainTerminal.writes.some((write) => write.includes("\x1b[?1049h"))).toBe(false);
		mainTui.stop();

		const altTerminal = new RecordingTerminal();
		const altTui = createInteractiveTui({
			tuiMode: "fullscreen",
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal: altTerminal,
		});
		expect(altTui.mode).toBe("fullscreen");
		expect(isViewportTUI(altTui)).toBe(true);
		altTui.start();
		await altTerminal.waitForRender();
		expect(altTerminal.writes.some((write) => write.includes("\x1b[?1049h"))).toBe(true);
		altTui.stop();
	});

	it("replaces the renderer while preserving components and focus", async () => {
		const terminal = new RecordingTerminal(40, 8);
		const renderer = createInteractiveTui({
			tuiMode: "regular",
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal,
		});
		let stableUi: TUI;
		const invalidatedModes: TuiMode[] = [];
		const component: Component & { focused: boolean } = {
			focused: false,
			render: () => ["content"],
			invalidate: () => invalidatedModes.push(stableUi.mode),
		};
		renderer.addChild(component);
		renderer.setFocus(component);

		type SwitchContext = {
			renderer: ReturnType<typeof createInteractiveTui>;
			ui: TUI;
			fullscreenLayoutRoot: Component;
			options: { tuiMode?: TuiMode };
			themeController: { rebindTui: () => void };
			extensionTerminalInputSubscriptions: Set<never>;
		};
		const context = Object.assign(Object.create(InteractiveMode.prototype), {
			renderer,
			ui: undefined as unknown as TUI,
			fullscreenLayoutRoot: component,
			options: { tuiMode: "regular" as TuiMode },
			themeController: { rebindTui: () => {} },
			extensionTerminalInputSubscriptions: new Set<never>(),
		}) as SwitchContext;
		stableUi = createInteractiveTuiReference(() => context.renderer);
		context.ui = stableUi;
		const { stopInteractiveTui, switchTuiMode } = InteractiveMode.prototype as unknown as {
			stopInteractiveTui(this: SwitchContext): void;
			switchTuiMode(this: SwitchContext, mode: TuiMode, restoreProgress?: boolean): boolean;
		};

		renderer.start();
		await terminal.waitForRender();
		expect(switchTuiMode.call(context, "fullscreen", false)).toBe(true);
		await terminal.waitForRender();

		expect(stableUi.mode).toBe("fullscreen");
		expect(context.renderer.children).toEqual([component]);
		expect(context.renderer.getFocusedComponent()).toBe(component);
		expect(component.focused).toBe(true);
		expect(invalidatedModes).toEqual(["fullscreen"]);
		expect([terminal.startCount, terminal.stopCount]).toEqual([2, 1]);

		stopInteractiveTui.call(context);

		expect(stableUi.mode).toBe("regular");
		expect([terminal.startCount, terminal.stopCount]).toEqual([2, 3]);
	});
});

describe("InteractiveMode right-click paste", () => {
	it("feeds clipboard text to the focused component as a bracketed paste", async () => {
		clipboardMocks.readClipboardText.mockResolvedValue("clipboard text");
		const handleInput = vi.fn<(data: string) => void>();
		const target = { render: () => [], invalidate: () => {}, handleInput } satisfies Component;
		const requestRender = vi.fn();
		const context = {
			renderer: { getFocusedComponent: () => target },
			ui: { requestRender },
		};
		const prototype = InteractiveMode.prototype as unknown as {
			handleRightClickPaste(this: typeof context): Promise<void>;
		};

		await prototype.handleRightClickPaste.call(context);

		expect(handleInput).toHaveBeenCalledWith("\x1b[200~clipboard text\x1b[201~");
		expect(requestRender).toHaveBeenCalledOnce();
	});
});

type CopyCommandView = {
	flash: (message: string) => void;
	showStatus: (message: string, severity?: "info" | "warning" | "error") => void;
	showSelector: (kind: string, payload?: unknown) => void;
	renderMessage: (content: string, options?: { markdown?: boolean }) => void;
	invalidateFooter: () => void;
	updateEditorBorder: () => void;
};

function createCopyCommandView(overrides: Partial<CopyCommandView> = {}): CopyCommandView {
	return {
		flash: vi.fn(),
		showStatus: vi.fn(),
		showSelector: vi.fn(),
		renderMessage: vi.fn(),
		invalidateFooter: vi.fn(),
		updateEditorBorder: vi.fn(),
		...overrides,
	};
}

async function runCopyCommand(
	session: { getLastAssistantText: () => string | undefined },
	view: CopyCommandView,
): Promise<void> {
	registerBuiltinCommandEntries();
	const entry = getCommandEntries().find(({ name }) => name === "copy")?.entry;
	if (!entry) throw new Error("copy command not registered");
	await entry.execute({
		args: [],
		session: session as never,
		view: view as never,
	});
}

describe("InteractiveMode copy confirmation", () => {
	beforeEach(() => {
		clipboardMocks.copyToClipboard.mockReset();
		clipboardMocks.copyToClipboard.mockResolvedValue(undefined);
	});

	it("copies the last assistant message and delegates the confirmation to view.flash", async () => {
		const view = createCopyCommandView();
		await runCopyCommand({ getLastAssistantText: () => "assistant response" }, view);

		expect(clipboardMocks.copyToClipboard).toHaveBeenCalledWith("assistant response");
		expect(view.flash).toHaveBeenCalledWith("Copied!");
		expect(view.showStatus).not.toHaveBeenCalled();
	});

	it("reports an error status when there is nothing to copy", async () => {
		const view = createCopyCommandView();
		await runCopyCommand({ getLastAssistantText: () => undefined }, view);

		expect(clipboardMocks.copyToClipboard).not.toHaveBeenCalled();
		expect(view.showStatus).toHaveBeenCalledWith("No agent messages to copy yet.", "error");
	});

	it("flashes the confirmation in fullscreen mode via the view adapter", async () => {
		const ui = createInteractiveTui({
			tuiMode: "fullscreen",
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal: new RecordingTerminal(),
		});
		const flash = vi
			.spyOn(ui as unknown as { flash: (message: string) => void }, "flash")
			.mockImplementation(() => {});
		const showStatus = vi.fn();
		const prototype = InteractiveMode.prototype as unknown as {
			showCommandFlash(this: { ui: typeof ui; showStatus: (message: string) => void }, message: string): void;
		};

		prototype.showCommandFlash.call({ ui, showStatus }, "Copied!");

		expect(flash).toHaveBeenCalledWith("Copied!");
		expect(showStatus).not.toHaveBeenCalled();
	});

	it("falls back to a status line in regular mode via the view adapter", async () => {
		const ui = createInteractiveTui({
			tuiMode: "regular",
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal: new RecordingTerminal(),
		});
		const showStatus = vi.fn();
		const prototype = InteractiveMode.prototype as unknown as {
			showCommandFlash(this: { ui: typeof ui; showStatus: (message: string) => void }, message: string): void;
		};

		prototype.showCommandFlash.call({ ui, showStatus }, "Copied!");

		expect(showStatus).toHaveBeenCalledWith("Copied!");
	});
});

type ClearStatusContext = {
	activeStatusIndicator: { kind: "working"; dispose: () => void } | undefined;
	statusContainer: Container;
	options: { tuiMode?: TuiMode };
	ui: { getClearOnShrink: () => boolean };
	idleStatus: Component;
};

type InteractiveModePrototype = {
	clearStatusIndicator(this: ClearStatusContext, kind?: "working"): void;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

describe("clear-on-shrink status spacing", () => {
	it("reserves status height only on the main-screen renderer", () => {
		for (const [tuiMode, expectedChildren] of [
			["regular", 1],
			["fullscreen", 0],
		] as const) {
			const dispose = vi.fn();
			const context: ClearStatusContext = {
				activeStatusIndicator: { kind: "working", dispose },
				statusContainer: new Container(),
				options: { tuiMode },
				ui: { getClearOnShrink: () => true },
				idleStatus: new Text("", 0, 0),
			};

			interactiveModePrototype.clearStatusIndicator.call(context);

			expect(dispose).toHaveBeenCalledOnce();
			expect(context.statusContainer.children).toHaveLength(expectedChildren);
		}
	});
});
