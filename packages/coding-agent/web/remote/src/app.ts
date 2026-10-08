import { PiClient, PiServerError } from "@earendil-works/pi-client";
import type { ByteTransportFactory, PiSessionHandle } from "@earendil-works/pi-client";
import type { ModelMetadata, SessionSnapshot, ServerEvent, SessionMetadata, TranscriptItem } from "@earendil-works/pi-protocol";
import { TranscriptState } from "./render/state.ts";
import { renderStatus, renderQueue } from "./render/status.ts";
import { TranscriptRenderer } from "./render/transcript.ts";
import { ModelPanel } from "./ui/panel.ts";

import { EditLayer } from "./ui/edit-layer.ts";
import { TreePanel } from "./ui/tree-panel.ts";
type AppState = "no-token" | "connecting" | "attached" | "terminal";

const MAX_COMPOSER_ROWS = 6;

export class RemoteApp {
	readonly #factory: ByteTransportFactory;
	readonly #status: HTMLElement;
	readonly #transcript: HTMLElement;
	readonly #queue: HTMLElement;
	readonly #error: HTMLElement;
	readonly #input: HTMLTextAreaElement;
	readonly #send: HTMLButtonElement;
	readonly #abort: HTMLButtonElement;
	readonly #state2 = new TranscriptState();
	readonly #view: TranscriptRenderer;
	#panel: ModelPanel | undefined;
	#edit: EditLayer;
	#tree: TreePanel | undefined;
	#rerollBusy = false;
	#models: readonly ModelMetadata[] | undefined;
	#state: AppState = "connecting";
	#client: PiClient | undefined;
	#handle: PiSessionHandle | undefined;
	#snapshot: SessionSnapshot | undefined;
	#generation = 0;
	#retry = 0;
	#timer: number | undefined;
	#connectionSubscribed = false;
	#unsubscribers: Array<() => void> = [];

	constructor(factory: ByteTransportFactory) {
		this.#factory = factory;
		this.#status = document.getElementById("connection-status")!;
		this.#transcript = document.getElementById("transcript")!;
		this.#queue = document.getElementById("queue")!;
		this.#error = document.getElementById("error")!;
		this.#input = document.getElementById("prompt") as HTMLTextAreaElement;
		this.#send = document.getElementById("send") as HTMLButtonElement;
		this.#abort = document.getElementById("abort") as HTMLButtonElement;
		this.#edit = new EditLayer(document.getElementById("app") ?? document.body, async (id, value) => {
			const handle = this.#handle;
			if (!handle?.active) throw new Error("会话未连接");
			const generation = this.#generation;
			const result = await handle.editMessage(id, value);
			if (generation !== this.#generation) throw new Error("会话已切换");
			this.#acceptSnapshot(result);
		});
		this.#view = new TranscriptRenderer(this.#transcript, {
			canReroll: () => this.#state === "attached" && !!this.#handle?.active && this.#snapshot?.phase === "idle" && !this.#rerollBusy,
			onReroll: () => { void this.#reroll(); },
			onEdit: (item) => this.#edit.open(item),
		});
		this.#send.addEventListener("click", () => this.#submit());
		this.#input.addEventListener("keydown", (event) => {
			if (event.isComposing) return;
			if (event.key === "Enter" && !event.shiftKey) {
				event.preventDefault();
				this.#submit();
			}
		});
		this.#input.addEventListener("input", () => this.#autoSize());
		this.#abort.addEventListener("click", () => this.#abortTurn());
		const panelTrigger = document.getElementById("model-trigger") as HTMLButtonElement | null;
		const panelMount = document.getElementById("app") ?? document.body;
		if (panelTrigger) {
			this.#panel = new ModelPanel(
				{
					client: () => this.#client,
					handle: () => this.#handle,
					snapshot: () => this.#snapshot,
					generation: () => this.#generation,
					onSnapshot: (snapshot) => this.#acceptSnapshot(snapshot),
					onTransientError: (message) => this.#showError(new Error(message)),
				},
				panelTrigger,
				panelMount,
			);
		}
		const treeTrigger = document.getElementById("tree-trigger") as HTMLButtonElement | null;
		if (treeTrigger) this.#tree = new TreePanel({
			handle: () => this.#handle,
			snapshot: () => this.#snapshot,
			generation: () => this.#generation,
			onSnapshot: (snapshot) => this.#acceptSnapshot(snapshot),
			onEdit: (item) => this.#edit.open(item),
			onEditorText: (value) => { this.#input.value = value; this.#autoSize(); },
			onError: (error) => this.#showError(error),
		}, treeTrigger, document.getElementById("app") ?? document.body);
		window.addEventListener("online", () => {
			if (this.#state !== "terminal") void this.#recover();
		});
		document.addEventListener("visibilitychange", () => {
			if (!document.hidden && this.#client?.connected === false && this.#state !== "terminal") void this.#recover();
		});
		this.#layoutViewport();
		if (window.visualViewport) {
			window.visualViewport.addEventListener("resize", () => this.#layoutViewport());
			window.visualViewport.addEventListener("scroll", () => this.#layoutViewport());
		}
		window.addEventListener("resize", () => this.#layoutViewport());
	}

	start(): void {
		void this.#recover();
	}

	#layoutViewport(): void {
		const height = window.visualViewport?.height ?? window.innerHeight;
		document.documentElement.style.setProperty("--visible-height", `${height}px`);
	}

	#autoSize(): void {
		this.#input.style.height = "auto";
		const lineHeight = parseFloat(getComputedStyle(this.#input).lineHeight) || this.#input.scrollHeight;
		this.#input.style.height = `${Math.min(this.#input.scrollHeight, lineHeight * MAX_COMPOSER_ROWS)}px`;
	}


	async #recover(): Promise<void> {
		if (this.#state === "terminal" || this.#state === "no-token") return;
		if (this.#timer) {
			window.clearTimeout(this.#timer);
			this.#timer = undefined;
		}
		if (this.#client?.connected) {
			if (this.#handle?.active) return;
			await this.#attachCurrent(++this.#generation);
			return;
		}
		const generation = ++this.#generation;
		this.#state = "connecting";
		this.#status.textContent = "Connecting…";
		this.#setControls();
		try {
			if (this.#client) await this.#client.reconnect();
			else this.#client = await PiClient.connect({ transportFactory: this.#factory });
			// Subscribe right after the client exists — including the very first connect,
			// otherwise a host stop during the first connection never reaches #terminal.
			if (!this.#connectionSubscribed) {
				this.#connectionSubscribed = true;
				this.#client.onConnectionStateChange((change) => {
					if (change.state !== "disconnected") return;
					const message = change.error?.message ?? "";
					if (message.indexOf("server shutdown") >= 0) this.#terminal();
					else this.#disconnected();
				});
			}
			if (generation !== this.#generation || this.#state === "terminal") return;
			this.#retry = 0;
			await this.#attachCurrent(generation);
		} catch (error) {
			if (generation !== this.#generation || this.#state === "terminal") return;
			this.#showError(error);
			this.#scheduleRetry();
		}
	}

	async #attachCurrent(generation: number): Promise<void> {
		if (!this.#client) return;
		this.#clearHandle();
		try {
			const sessions: readonly SessionMetadata[] = await this.#client.listSessions();
			if (generation !== this.#generation) return;
			if (sessions.length === 0) throw new Error("宿主会话切换中");
			const handle = await this.#client.attachSession(sessions[0]!.id);
			if (generation !== this.#generation || this.#state === "terminal") {
				await handle.detach();
				return;
			}
			this.#handle = handle;
			this.#unsubscribers.push(handle.subscribe((snapshot) => this.#acceptSnapshot(snapshot)));
			this.#unsubscribers.push(handle.onEvent((event) => this.#onEvent(event)));
			if (this.#models === undefined && this.#client.connected) {
				try {
					this.#models = await this.#client.listModels();
					this.#panel?.setModels(this.#models);
				} catch {
					this.#models = []; // status falls back to provider/id labels
				}
			}
			if (handle.snapshot) this.#acceptSnapshot(handle.snapshot);
			this.#state = "attached";
			this.#retry = 0;
			this.#setControls();
		} catch (error) {
			if (generation === this.#generation) {
				this.#showError(error);
				this.#scheduleRetry();
			}
		}
	}

	#modelLookup(): { name?: string; contextWindow?: number } | undefined {
		if (!this.#snapshot || !this.#models) return undefined;
		const meta = this.#models.find((model) => model.provider === this.#snapshot?.model.provider && model.id === this.#snapshot?.model.id);
		return meta ? { name: meta.name, contextWindow: meta.contextWindow } : undefined;
	}

	#acceptSnapshot(snapshot: SessionSnapshot): void {
		if (this.#snapshot?.id === snapshot.id && snapshot.revision < this.#snapshot.revision) return;
		this.#snapshot = snapshot;
		if (!this.#state2.applySnapshot(snapshot)) return;
		this.#view.clearPending();
		const merged: Array<[string, TranscriptItem]> = [];
		for (const pair of this.#state2.entries) merged.push(pair);
		for (const pair of this.#state2.live) merged.push(pair);
		this.#view.reconcile(merged);
		renderStatus(this.#status, snapshot, this.#modelLookup());
		renderQueue(this.#queue, snapshot);
		this.#panel?.syncFromSnapshot();
		this.#setControls();
	}

	#onEvent(event: ServerEvent): void {
		if (event.type === "session_removed" && event.sessionId === this.#handle?.id) {
			const generation = ++this.#generation;
			this.#clearHandle();
			this.#snapshot = undefined;
			this.#state2.clear();
			this.#view.clear();
			this.#status.textContent = "宿主会话切换中…";
			this.#setControls();
			this.#timer = window.setTimeout(() => {
				this.#timer = undefined;
				if (generation === this.#generation) void this.#attachCurrent(generation);
			}, 200);
		} else if (event.type === "session_progress" && event.sessionId === this.#handle?.id && this.#snapshot) {
			const key = this.#state2.applyProgress(event.progress);
			if (key === undefined) return;
			const item = this.#state2.live.get(key);
			if (!item) return;
			if (event.progress.type === "assistant_delta") {
				this.#view.stageItem(key, item);
				this.#view.markDirty(key);
			} else {
				this.#view.stageItem(key, item);
				this.#view.markDirty(key);
			}
		}
	}

	/**
	 * Fire-and-forget send: prompt/steer commands resolve only when the whole turn
	 * completes (server awaits runtime.prompt), so awaiting them would disable the
	 * composer for the entire turn and queue abort behind it. Instead the command
	 * is issued and the UI is driven by progress/snapshot events; a rejected
	 * command restores the text for an explicit retry (06 §4.6).
	 */
	#submit(): void {
		const text = this.#input.value.trim();
		const handle = this.#handle;
		const snapshot = handle?.snapshot;
		if (!text || !handle?.active || !snapshot) return;
		if (snapshot.phase !== "idle" && snapshot.phase !== "turn") {
			this.#showError(new Error(`Cannot send while session phase is ${snapshot.phase}`));
			return;
		}
		const wasIdle = snapshot.phase === "idle";
		const command = wasIdle ? handle.prompt(text) : handle.steer(text);
		this.#input.value = "";
		this.#autoSize();
		this.#hideError();
		if (wasIdle) this.#input.blur();
		command.then(
			(result) => this.#acceptSnapshot(result),
			(error) => {
				if (error instanceof PiServerError) {
					this.#showError(error, () => {
						this.#input.value = text;
						this.#submit();
					});
					this.#acceptSnapshot(handle.snapshot ?? snapshot);
				} else {
					this.#showError(
						new Error(`${error instanceof Error ? error.message : String(error)}（结果未知，请确认会话状态后重新发送）`),
					);
				}
			},
		);
	}

	/** Fire-and-forget abort: the UI returns to idle via events, not by awaiting the command. */
	#abortTurn(): void {
		const handle = this.#handle;
		if (!handle?.active || !this.#snapshot || this.#snapshot.phase === "idle") return;
		handle.abort().then(
			(result) => this.#acceptSnapshot(result),
			(error) => this.#showError(error),
		);
	}
	async #reroll(): Promise<void> {
		const handle = this.#handle;
		if (!handle?.active || !this.#snapshot || this.#snapshot.phase !== "idle" || this.#rerollBusy) return;
		this.#rerollBusy = true; this.#setControls();
		const generation = this.#generation;
		try {
			const result = await handle.reroll();
			if (generation !== this.#generation) return;
			this.#acceptSnapshot(result.session);
			if (!result.ok) this.#showError(new Error("无法重新生成"));
			else if (this.#tree?.isOpen()) await this.#tree.refresh();
		} catch (error) { if (generation === this.#generation) this.#showError(error); }
		finally { this.#rerollBusy = false; this.#setControls(); }
	}

	#clearHandle(): void {
		for (const unsubscribe of this.#unsubscribers.splice(0)) unsubscribe();
		const old = this.#handle;
		this.#handle = undefined;
		if (old) void old.detach().catch(() => {});
	}

	#disconnected(): void {
		if (this.#state === "terminal") return;
		this.#state = "connecting";
		this.#status.textContent = "连接中断，重连中…";
		this.#clearHandle();
		this.#setControls();
		this.#scheduleRetry();
	}

	#terminal(): void {
		this.#state = "terminal";
		if (this.#timer) window.clearTimeout(this.#timer);
		this.#clearHandle();
		this.#status.textContent = "Host stopped sharing";
		this.#showError(new Error("宿主已停止分享"));
		this.#setControls();
	}

	#scheduleRetry(): void {
		if (this.#state === "terminal" || this.#timer || document.hidden) return;
		const delay = Math.min(30000, 500 * 2 ** Math.min(this.#retry++, 6));
		this.#timer = window.setTimeout(() => {
			this.#timer = undefined;
			void this.#recover();
		}, delay);
	}

	#showError(error: unknown, retry?: () => void): void {
		this.#error.textContent = "";
		this.#error.appendChild(document.createTextNode(error instanceof Error ? error.message : String(error)));
		if (retry) {
			const button = document.createElement("button");
			button.type = "button";
			button.className = "retry";
			button.appendChild(document.createTextNode("重试"));
			button.addEventListener("click", () => {
				this.#hideError();
				retry();
			});
			this.#error.appendChild(button);
		}
		this.#error.hidden = false;
	}

	#hideError(): void {
		this.#error.hidden = true;
		this.#error.textContent = "";
	}

	#setControls(): void {
		const snapshot = this.#handle?.snapshot;
		// snapshot.locked is a server durable-lock flag reported as true by CodingAgentRuntime;
		// it does not gate shared attach, so it must not disable input. The composer also
		// stays enabled during a turn: sends become queued steers (04 §3.5, 06 §4.6).
		this.#input.disabled = !this.#handle?.active || this.#state !== "attached";
		this.#send.disabled = this.#input.disabled;
		this.#abort.hidden = !(this.#state === "attached" && !!this.#handle?.active && !!snapshot && snapshot.phase !== "idle");
		this.#abort.disabled = !this.#handle?.active;
		const trigger = document.getElementById("tree-trigger") as HTMLButtonElement | null;
		if (trigger) trigger.disabled = !(this.#state === "attached" && !!this.#handle?.active);
		this.#view.setActionsEnabled();
	}
}
