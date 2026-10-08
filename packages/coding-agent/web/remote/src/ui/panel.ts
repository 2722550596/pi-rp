/**
 * Model / thinking panel — mobile bottom drawer, desktop dropdown (06 §4.5).
 * Reads: client.listModels() (authenticated only), snapshot.model/thinkingLevel.
 * Writes: handle.setModel / handle.setThinking, single-flight; the returned
 * snapshot is handed back through the app's acceptSnapshot entry point.
 */
import type { ModelMetadata, SessionSnapshot, ThinkingLevel } from "@earendil-works/pi-protocol";
import type { PiClient, PiSessionHandle } from "@earendil-works/pi-client";

const THINKING_LEVELS: ReadonlyArray<Exclude<ThinkingLevel, "max">> = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
];

export interface ModelPanelServices {
	client(): PiClient | undefined;
	handle(): PiSessionHandle | undefined;
	snapshot(): SessionSnapshot | undefined;
	generation(): number;
	onSnapshot(snapshot: SessionSnapshot): void;
	onTransientError(message: string): void;
}

function text(parent: Node, value: string): void {
	parent.appendChild(document.createTextNode(value));
}

export class ModelPanel {
	readonly #services: ModelPanelServices;
	readonly #trigger: HTMLButtonElement;
	readonly #overlay: HTMLElement;
	readonly #sheet: HTMLElement;
	readonly #modelList: HTMLElement;
	readonly #thinkingList: HTMLElement;
	readonly #statusLine: HTMLElement;
	#open = false;
	#busy = false;
	#models: readonly ModelMetadata[] | undefined;

	constructor(services: ModelPanelServices, trigger: HTMLButtonElement, mount: HTMLElement) {
		this.#services = services;
		this.#trigger = trigger;
		this.#overlay = document.createElement("div");
		this.#overlay.className = "panel-overlay";
		this.#overlay.hidden = true;
		this.#sheet = document.createElement("div");
		this.#sheet.className = "panel-sheet";
		this.#sheet.setAttribute("role", "dialog");
		this.#sheet.setAttribute("aria-label", "Model settings");
		this.#overlay.appendChild(this.#sheet);
		const heading = document.createElement("div");
		heading.className = "panel-heading";
		text(heading, "模型与思考档");
		const close = document.createElement("button");
		close.type = "button";
		close.className = "panel-close";
		text(close, "关闭");
		close.addEventListener("click", () => this.close());
		heading.appendChild(close);
		this.#sheet.appendChild(heading);
		const modelHeading = document.createElement("div");
		modelHeading.className = "panel-section";
		text(modelHeading, "模型");
		this.#sheet.appendChild(modelHeading);
		this.#modelList = document.createElement("div");
		this.#modelList.className = "panel-models";
		this.#sheet.appendChild(this.#modelList);
		const thinkingHeading = document.createElement("div");
		thinkingHeading.className = "panel-section";
		text(thinkingHeading, "思考档");
		this.#sheet.appendChild(thinkingHeading);
		this.#thinkingList = document.createElement("div");
		this.#thinkingList.className = "panel-thinking";
		this.#sheet.appendChild(this.#thinkingList);
		this.#statusLine = document.createElement("div");
		this.#statusLine.className = "panel-status";
		this.#sheet.appendChild(this.#statusLine);
		mount.appendChild(this.#overlay);
		this.#overlay.addEventListener("click", (event) => {
			if (event.target === this.#overlay) this.close();
		});
		document.addEventListener("keydown", (event) => {
			if (event.key === "Escape" && this.#open) this.close();
		});
		trigger.addEventListener("click", () => {
			if (this.#open) this.close();
			else this.open();
		});
	}

	open(): void {
		this.#open = true;
		this.#overlay.hidden = false;
		this.#trigger.setAttribute("aria-expanded", "true");
		this.#refresh();
		if (this.#models === undefined) void this.#loadModels();
	}

	close(): void {
		this.#open = false;
		this.#overlay.hidden = true;
		this.#trigger.setAttribute("aria-expanded", "false");
	}

	/** Snapshot-driven refresh; never resets open state (06 §4.1.5). */
	syncFromSnapshot(): void {
		if (this.#open) this.#refresh();
		const snapshot = this.#services.snapshot();
		if (snapshot) {
			const meta = this.#findModel(snapshot.model.provider, snapshot.model.id);
			this.#trigger.textContent = meta?.name ?? `${snapshot.model.provider}/${snapshot.model.id}`;
		}
	}

	#findModel(provider: string, id: string): ModelMetadata | undefined {
		return this.#models?.find((model) => model.provider === provider && model.id === id);
	}


	/** Shares models prefetched by the app so the trigger can show names before first open. */
	setModels(models: readonly ModelMetadata[]): void {
		if (this.#models === undefined) this.#models = models.filter((model) => model.authenticated);
	}
	#status(message: string): void {
		this.#statusLine.textContent = "";
		text(this.#statusLine, message);
	}

	async #loadModels(): Promise<void> {
		const client = this.#services.client();
		if (!client) return;
		const generation = this.#services.generation();
		try {
			const models = await client.listModels();
			if (generation !== this.#services.generation()) return;
			this.#models = models.filter((model) => model.authenticated);
			if (this.#open) this.#refresh();
		} catch (error) {
			if (!this.#open) return;
			this.#status(`模型列表加载失败：${error instanceof Error ? error.message : String(error)}`);
			const retry = document.createElement("button");
			retry.type = "button";
			text(retry, "重试");
			retry.addEventListener("click", () => {
				void this.#loadModels();
			});
			this.#statusLine.appendChild(retry);
		}
	}

	#refresh(): void {
		const snapshot = this.#services.snapshot();
		if (!snapshot) return;
		this.#renderModels(snapshot);
		this.#renderThinking(snapshot);
	}

	#renderModels(snapshot: SessionSnapshot): void {
		this.#modelList.textContent = "";
		if (this.#models === undefined) {
			text(this.#modelList, "加载中…");
			return;
		}
		if (this.#models.length === 0) {
			text(this.#modelList, "无可用模型");
			return;
		}
		const current = snapshot.model;
		const known = this.#findModel(current.provider, current.id);
		if (!known) {
			const notice = document.createElement("div");
			notice.className = "panel-notice";
			text(notice, `当前模型 ${current.provider}/${current.id} 未认证或不在列表中`);
			this.#modelList.appendChild(notice);
		}
		for (const model of this.#models) {
			const row = document.createElement("button");
			row.type = "button";
			row.className = `panel-option${model.provider === current.provider && model.id === current.id ? " selected" : ""}`;
			const title = document.createElement("span");
			text(title, model.name ?? `${model.provider}/${model.id}`);
			row.appendChild(title);
			if (model.provider === current.provider && model.id === current.id) {
				const mark = document.createElement("span");
				mark.className = "panel-check";
				text(mark, "✓");
				row.appendChild(mark);
			} else {
				const sub = document.createElement("span");
				sub.className = "panel-sub";
				text(sub, `${model.provider}/${model.id}`);
				row.appendChild(sub);
			}
			row.disabled = this.#busy;
			row.addEventListener("click", () => {
				void this.#setModel(model);
			});
			this.#modelList.appendChild(row);
		}
	}

	#renderThinking(snapshot: SessionSnapshot): void {
		this.#thinkingList.textContent = "";
		const currentModel = this.#findModel(snapshot.model.provider, snapshot.model.id);
		const supported = currentModel?.supportedThinkingLevels;
		const levels: ReadonlyArray<string> = supported && supported.length > 0 ? supported : THINKING_LEVELS;
		const current = snapshot.thinkingLevel;
		if (!levels.includes(current)) {
			const notice = document.createElement("div");
			notice.className = "panel-notice";
			text(notice, `当前档位 ${current}（当前模型支持列表外，维持原值）`);
			this.#thinkingList.appendChild(notice);
		}
		for (const level of levels) {
			const row = document.createElement("button");
			row.type = "button";
			row.className = `panel-option${level === current ? " selected" : ""}`;
			text(row, level);
			row.disabled = this.#busy;
			row.addEventListener("click", () => {
				void this.#setThinking(level as ThinkingLevel);
			});
			this.#thinkingList.appendChild(row);
		}
	}

	async #setModel(model: ModelMetadata): Promise<void> {
		const handle = this.#services.handle();
		if (!handle?.active || this.#busy) return;
		this.#busy = true;
		this.#refresh();
		try {
			const snapshot = await handle.setModel({ provider: model.provider, id: model.id });
			this.#services.onSnapshot(snapshot);
			this.#status(`已切换到 ${model.name ?? model.id}`);
		} catch (error) {
			this.#services.onTransientError(error instanceof Error ? error.message : String(error));
			this.#status(`切换失败：${error instanceof Error ? error.message : String(error)}`);
		} finally {
			this.#busy = false;
			if (this.#open) this.#refresh();
		}
	}

	async #setThinking(level: ThinkingLevel): Promise<void> {
		const handle = this.#services.handle();
		if (!handle?.active || this.#busy) return;
		this.#busy = true;
		this.#refresh();
		try {
			const snapshot = await handle.setThinking(level);
			this.#services.onSnapshot(snapshot);
			this.#status(`思考档已设为 ${level}`);
		} catch (error) {
			this.#services.onTransientError(error instanceof Error ? error.message : String(error));
			this.#status(`设置失败：${error instanceof Error ? error.message : String(error)}`);
		} finally {
			this.#busy = false;
			if (this.#open) this.#refresh();
		}
	}
}
