import type { SessionSnapshot, SessionTreeEntryProjection, TranscriptItem } from "@earendil-works/pi-protocol";
import { filterTreeRows, flattenSessionTree, type TreeFilterMode } from "./tree-model.ts";

interface Services {
	handle(): {
		active: boolean;
		getTree(): Promise<{ entries: SessionTreeEntryProjection[]; leafId: string }>;
		navigateTree(id: string): Promise<{ cancelled: boolean; editorText?: string; session: SessionSnapshot }>;
	} | undefined;
	snapshot(): SessionSnapshot | undefined;
	generation(): number;
	onSnapshot(snapshot: SessionSnapshot): void;
	onEdit(item: TranscriptItem): void;
	onEditorText(text: string): void;
	onError(error: unknown): void;
}

const TREE_WIDTH_KEY = "pi-remote:v1:tree-width";
const MIN_TREE_WIDTH = 240;
const MAX_TREE_WIDTH = 840;
const MIN_CONTENT_WIDTH = 360;

export class TreePanel {
	readonly #services: Services;
	readonly #trigger: HTMLButtonElement;
	readonly #sidebar = document.getElementById("tree-sidebar") as HTMLElement;
	readonly #overlay = document.getElementById("sidebar-overlay") as HTMLElement;
	readonly #resizer = document.getElementById("sidebar-resizer") as HTMLElement;
	readonly #list = document.getElementById("tree-list") as HTMLElement;
	readonly #status = document.getElementById("tree-status") as HTMLElement;
	readonly #search = document.getElementById("tree-search") as HTMLInputElement;
	readonly #mobile = window.matchMedia("(max-width: 899px)");
	#open: boolean;
	#busy = false;
	#entries: SessionTreeEntryProjection[] = [];
	#leaf = "";
	#filter: TreeFilterMode = "default";

	constructor(services: Services, trigger: HTMLButtonElement) {
		this.#services = services;
		this.#trigger = trigger;
		this.#open = !this.#mobile.matches;
		this.#trigger.addEventListener("click", () => this.#open ? this.close() : this.open());
		document.getElementById("tree-refresh")?.addEventListener("click", () => void this.#load());
		document.getElementById("tree-close")?.addEventListener("click", () => this.close());
		this.#overlay.addEventListener("click", () => this.close());
		this.#search.addEventListener("input", () => this.#render());
		document.getElementById("tree-filters")?.addEventListener("click", (event) => {
			const button = (event.target as Element).closest<HTMLButtonElement>("[data-filter]");
			if (!button) return;
			this.#filter = button.dataset.filter as TreeFilterMode;
			for (const candidate of document.querySelectorAll<HTMLButtonElement>(".tree-filter")) {
				candidate.classList.toggle("active", candidate === button);
			}
			this.#render();
		});
		document.addEventListener("keydown", (event) => {
			if (event.key === "Escape" && this.#open && this.#mobile.matches) this.close();
		});
		this.#mobile.addEventListener("change", (event) => {
			this.#open = !event.matches;
			this.#syncVisibility();
			if (this.#open) void this.#load();
		});
		this.#setupResize();
		this.#loadSavedWidth();
		this.#syncVisibility();
	}

	open(): void {
		this.#open = true;
		this.#syncVisibility();
		void this.#load();
	}

	close(): void {
		this.#open = false;
		this.#syncVisibility();
	}

	isOpen(): boolean {
		return this.#open;
	}

	refresh(): Promise<void> {
		return this.#load();
	}

	#syncVisibility(): void {
		this.#sidebar.classList.toggle("open", this.#open);
		this.#trigger.setAttribute("aria-expanded", String(this.#open));
		this.#overlay.hidden = !this.#mobile.matches || !this.#open;
	}

	async #load(): Promise<void> {
		const handle = this.#services.handle();
		if (!handle?.active || this.#busy || !this.#open) return;
		const generation = this.#services.generation();
		this.#busy = true;
		this.#status.textContent = "正在加载…";
		this.#render();
		try {
			const result = await handle.getTree();
			if (generation !== this.#services.generation()) return;
			this.#entries = result.entries;
			this.#leaf = result.leafId;
			this.#status.textContent = "";
		} catch (error) {
			if (generation === this.#services.generation()) {
				this.#status.textContent = error instanceof Error ? error.message : String(error);
				this.#services.onError(error);
			}
		} finally {
			this.#busy = false;
			this.#render();
		}
	}

	#render(): void {
		const oldScroll = this.#list.scrollTop;
		const snapshotItems = new Map(this.#services.snapshot()?.transcript.map((item) => [item.id, item]) ?? []);
		const allRows = flattenSessionTree(this.#entries, this.#leaf);
		const rows = filterTreeRows(allRows, this.#filter, this.#search.value, this.#leaf);
		const fragment = document.createDocumentFragment();
		for (const row of rows) {
			const entry = row.entry;
			const wrapper = document.createElement("div");
			wrapper.className = "tree-node";
			wrapper.classList.toggle("in-path", row.inPath);
			wrapper.classList.toggle("leaf", entry.id === this.#leaf && this.#leaf.length > 0);
			const select = document.createElement("button");
			select.type = "button";
			select.className = "tree-select";
			select.disabled = this.#busy;
			select.setAttribute("aria-current", entry.id === this.#leaf && this.#leaf ? "true" : "false");
			const prefix = document.createElement("span");
			prefix.className = "tree-prefix";
			prefix.textContent = row.prefix;
			const marker = document.createElement("span");
			marker.className = "tree-marker";
			marker.textContent = row.inPath ? "•" : " ";
			const content = document.createElement("span");
			content.className = "tree-content";
			const role = document.createElement("span");
			role.className = `tree-kind ${entry.kind}`;
			role.textContent = entry.customType ? `[${entry.customType}]` : entry.kind;
			const summary = document.createElement("span");
			summary.className = "tree-summary";
			summary.textContent = entry.summary;
			content.append(role, document.createTextNode(": "), summary);
			if (entry.label) {
				const label = document.createElement("span");
				label.className = "tree-label";
				label.textContent = `[${entry.label}]`;
				content.prepend(label, document.createTextNode(" "));
			}
			const time = document.createElement("time");
			time.className = "tree-time";
			time.dateTime = new Date(entry.timestamp).toISOString();
			time.textContent = new Date(entry.timestamp).toLocaleTimeString([], {
				hour: "2-digit",
				minute: "2-digit",
			});
			select.append(prefix, marker, content, time);
			select.addEventListener("click", () => void this.#navigate(entry.id));
			wrapper.append(select);
			const item = snapshotItems.get(entry.id);
			if (item && (item.role === "user" || item.role === "custom")) {
				const edit = document.createElement("button");
				edit.type = "button";
				edit.className = "tree-edit";
				edit.textContent = "编辑";
				edit.disabled = this.#busy;
				edit.addEventListener("click", () => this.#services.onEdit(item));
				wrapper.append(edit);
			}
			fragment.append(wrapper);
		}
		this.#list.replaceChildren(fragment);
		this.#list.scrollTop = oldScroll;
		const pathCount = allRows.filter((row) => row.inPath).length;
		this.#status.textContent = this.#busy ? "正在加载…" : `${rows.length} / ${allRows.length} 条 · 当前路径 ${pathCount}`;
		requestAnimationFrame(() => {
			this.#list.querySelector('[aria-current="true"]')?.scrollIntoView({ block: "nearest" });
		});
	}

	async #navigate(id: string): Promise<void> {
		const handle = this.#services.handle();
		if (!handle?.active || this.#busy) return;
		const generation = this.#services.generation();
		this.#busy = true;
		this.#render();
		try {
			const result = await handle.navigateTree(id);
			if (generation !== this.#services.generation()) return;
			this.#services.onSnapshot(result.session);
			if (result.editorText !== undefined) this.#services.onEditorText(result.editorText);
			if (!result.cancelled) await this.#loadAfterOperation(generation);
		} catch (error) {
			if (generation === this.#services.generation()) this.#services.onError(error);
		} finally {
			this.#busy = false;
			this.#render();
		}
	}

	async #loadAfterOperation(generation: number): Promise<void> {
		const handle = this.#services.handle();
		if (!handle?.active) return;
		const result = await handle.getTree();
		if (generation !== this.#services.generation()) return;
		this.#entries = result.entries;
		this.#leaf = result.leafId;
	}

	#setupResize(): void {
		this.#resizer.addEventListener("pointerdown", (event) => {
			if (this.#mobile.matches) return;
			event.preventDefault();
			this.#resizer.setPointerCapture(event.pointerId);
			document.body.classList.add("tree-resizing");
			const onMove = (move: PointerEvent): void => {
				const max = Math.min(MAX_TREE_WIDTH, window.innerWidth - MIN_CONTENT_WIDTH);
				const width = Math.max(MIN_TREE_WIDTH, Math.min(max, move.clientX));
				document.documentElement.style.setProperty("--tree-width", `${Math.round(width)}px`);
			};
			const onEnd = (): void => {
				this.#resizer.removeEventListener("pointermove", onMove);
				this.#resizer.removeEventListener("pointerup", onEnd);
				document.body.classList.remove("tree-resizing");
				localStorage.setItem(TREE_WIDTH_KEY, getComputedStyle(document.documentElement).getPropertyValue("--tree-width"));
			};
			this.#resizer.addEventListener("pointermove", onMove);
			this.#resizer.addEventListener("pointerup", onEnd);
		});
	}

	#loadSavedWidth(): void {
		const saved = Number.parseFloat(localStorage.getItem(TREE_WIDTH_KEY) ?? "");
		if (!Number.isFinite(saved)) return;
		const max = Math.min(MAX_TREE_WIDTH, window.innerWidth - MIN_CONTENT_WIDTH);
		document.documentElement.style.setProperty("--tree-width", `${Math.max(MIN_TREE_WIDTH, Math.min(max, saved))}px`);
	}
}
