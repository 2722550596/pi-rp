import type { TranscriptItem } from "@earendil-works/pi-protocol";

export class EditLayer {
	readonly #overlay = document.createElement("div");
	readonly #textarea = document.createElement("textarea");
	readonly #status = document.createElement("div");
	readonly #save = document.createElement("button");
	readonly #submit: (id: string, text: string) => Promise<void>;
	#item: TranscriptItem | undefined;
	#busy = false;

	constructor(mount: HTMLElement, submit: (id: string, text: string) => Promise<void>) {
		this.#submit = submit;
		this.#overlay.className = "edit-overlay";
		const sheet = document.createElement("section");
		sheet.className = "edit-sheet";
		const heading = document.createElement("div");
		heading.className = "panel-heading";
		heading.textContent = "编辑消息";
		const close = document.createElement("button");
		close.type = "button";
		close.className = "panel-close";
		close.textContent = "取消";
		close.addEventListener("click", () => this.close());
		heading.append(close);
		this.#textarea.setAttribute("enterkeyhint", "send");
		this.#textarea.addEventListener("input", () => this.#size());
		this.#textarea.addEventListener("keydown", (event) => {
			if (!event.isComposing && event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void this.#saveMessage(); }
		});
		this.#status.className = "edit-status";
		this.#save.type = "button";
		this.#save.textContent = "保存";
		this.#save.addEventListener("click", () => void this.#saveMessage());
		sheet.append(heading, this.#textarea, this.#status, this.#save);
		this.#overlay.append(sheet);
		this.#overlay.addEventListener("click", (event) => { if (event.target === this.#overlay) this.close(); });
		mount.append(this.#overlay);
		this.#overlay.hidden = true;
	}

	open(item: TranscriptItem): void {
		if (item.role !== "user" && item.role !== "custom") return;
		this.#item = item;
		this.#textarea.value = item.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
		this.#status.textContent = item.content.some((part) => part.type === "image") ? "保存后将丢失图片部分" : "";
		this.#overlay.hidden = false;
		this.#size();
		this.#textarea.focus();
	}

	close(): void {
		if (this.#busy) return;
		this.#overlay.hidden = true;
		this.#textarea.blur();
		this.#item = undefined;
	}

	#size(): void {
		this.#textarea.style.height = "auto";
		const lineHeight = parseFloat(getComputedStyle(this.#textarea).lineHeight) || this.#textarea.scrollHeight;
		this.#textarea.style.height = `${Math.min(this.#textarea.scrollHeight, lineHeight * 6)}px`;
	}

	async #saveMessage(): Promise<void> {
		const item = this.#item;
		const value = this.#textarea.value;
		if (!item || this.#busy || !value.trim()) return;
		this.#busy = true;
		this.#save.disabled = true;
		this.#status.textContent = "保存中…";
		try {
			await this.#submit(item.id, value);
			this.#busy = false; // release before close: close() no-ops while busy
			this.close();
		}
		catch (error) { this.#status.textContent = error instanceof Error ? error.message : String(error); }
		finally { this.#busy = false; this.#save.disabled = false; }
	}
}
