import type { SessionSnapshot, SessionTreeNodeProjection, TranscriptItem } from "@earendil-works/pi-protocol";

interface Services {
	handle(): { active: boolean; getTree(): Promise<{ tree: SessionTreeNodeProjection[]; leafId: string }>; navigateTree(id: string): Promise<{ cancelled: boolean; editorText?: string; session: SessionSnapshot }> } | undefined;
	snapshot(): SessionSnapshot | undefined;
	generation(): number;
	onSnapshot(snapshot: SessionSnapshot): void;
	onEdit(item: TranscriptItem): void;
	onEditorText(text: string): void;
	onError(error: unknown): void;
}

export class TreePanel {
	readonly #services: Services;
	readonly #trigger: HTMLButtonElement;
	readonly #overlay = document.createElement("div");
	readonly #list = document.createElement("div");
	readonly #status = document.createElement("div");
	#open = false;
	#busy = false;
	#tree: SessionTreeNodeProjection[] = [];
	#leaf = "";
	#loadedGeneration = -1;

	constructor(services: Services, trigger: HTMLButtonElement, mount: HTMLElement) {
		this.#services = services;
		this.#trigger = trigger;
		this.#overlay.className = "tree-overlay";
		const sheet = document.createElement("section");
		sheet.className = "tree-sheet";
		const heading = document.createElement("div"); heading.className = "panel-heading"; heading.textContent = "会话树";
		const refresh = document.createElement("button"); refresh.type = "button"; refresh.className = "panel-close"; refresh.textContent = "刷新"; refresh.addEventListener("click", () => void this.#load());
		const close = document.createElement("button"); close.type = "button"; close.className = "panel-close"; close.textContent = "关闭"; close.addEventListener("click", () => this.close());
		heading.append(refresh, close);
		this.#list.className = "tree-list"; this.#status.className = "panel-status";
		sheet.append(heading, this.#status, this.#list); this.#overlay.append(sheet); mount.append(this.#overlay); this.#overlay.hidden = true;
		this.#trigger.addEventListener("click", () => this.#open ? this.close() : this.open());
		this.#overlay.addEventListener("click", (event) => { if (event.target === this.#overlay) this.close(); });
		document.addEventListener("keydown", (event) => { if (event.key === "Escape" && this.#open) this.close(); });
	}

	open(): void { this.#open = true; this.#overlay.hidden = false; this.#trigger.setAttribute("aria-expanded", "true"); void this.#load(); }
	close(): void { this.#open = false; this.#overlay.hidden = true; this.#trigger.setAttribute("aria-expanded", "false"); }
	isOpen(): boolean { return this.#open; }
	refresh(): Promise<void> { return this.#load(); }
	
	async #load(): Promise<void> {
		const handle = this.#services.handle(); if (!handle?.active || this.#busy) return;
		const generation = this.#services.generation(); this.#busy = true; this.#status.textContent = "正在加载…";
		try { const result = await handle.getTree(); if (generation !== this.#services.generation()) return; this.#tree = result.tree; this.#leaf = result.leafId; this.#loadedGeneration = generation; this.#status.textContent = ""; this.#render(); }
		catch (error) { if (generation === this.#services.generation()) { this.#status.textContent = error instanceof Error ? error.message : String(error); this.#services.onError(error); } }
		finally { this.#busy = false; this.#render(); }
	}

	#render(): void {
		const oldScroll = this.#list.scrollTop;
		const snapshot = this.#services.snapshot();
		const byId = new Map(snapshot?.transcript.map((item) => [item.id, item]) ?? []);
		this.#list.replaceChildren();
		const visit = (nodes: SessionTreeNodeProjection[], depth: number): void => {
			for (const node of nodes) {
				const row = document.createElement("div"); row.className = `tree-node${node.id === this.#leaf && this.#leaf ? " leaf" : ""}`; row.style.paddingInlineStart = `${depth * 1.1}rem`;
				const select = document.createElement("button"); select.type = "button"; select.className = "tree-select"; select.setAttribute("aria-current", node.id === this.#leaf && this.#leaf ? "true" : "false");
				select.textContent = `${node.kind}${node.customType ? ` [${node.customType}]` : ""} · ${node.summary}${node.label ? ` · ${node.label}` : ""} · ${new Date(node.timestamp).toLocaleString()}`;
				select.disabled = this.#busy; select.addEventListener("click", () => void this.#navigate(node.id)); row.append(select);
				const item = byId.get(node.id); if (item && (item.role === "user" || item.role === "custom")) { const edit = document.createElement("button"); edit.type = "button"; edit.className = "entry-action"; edit.textContent = "编辑"; edit.addEventListener("click", () => this.#services.onEdit(item)); row.append(edit); }
				this.#list.append(row); visit(node.children, depth + 1);
			}
		};
		visit(this.#tree, 0); this.#list.scrollTop = oldScroll;
	}

	async #navigate(id: string): Promise<void> {
		const handle = this.#services.handle(); if (!handle?.active || this.#busy) return;
		const generation = this.#services.generation(); this.#busy = true; this.#render();
		try { const result = await handle.navigateTree(id); if (generation !== this.#services.generation()) return; this.#services.onSnapshot(result.session); if (result.editorText !== undefined) this.#services.onEditorText(result.editorText); if (!result.cancelled) { this.#leaf = ""; } else { this.#leaf = id; this.#render(); } }
		catch (error) { if (generation === this.#services.generation()) this.#services.onError(error); }
		finally { this.#busy = false; this.#render(); if (generation === this.#services.generation() && this.#open) await this.#load(); }
	}
}
