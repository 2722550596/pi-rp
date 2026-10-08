/**
 * Incremental transcript renderer — keyed DOM diff per 06-web-frontend.md §6.
 * - Snapshot: full reconcile of entries + live (authoritative, clears live).
 * - Progress: item_started/item_updated/item_finished reconcile single entries;
 *   assistant_delta marks keys dirty and coalesces into one rAF pass.
 * - Scroll: follow within 80px of bottom, preserve position when scrolled up,
 *   floating "back to bottom" pill on new content.
 */
import type { TranscriptItem } from "@earendil-works/pi-protocol";
import { renderMarkdown } from "./markdown.ts";

const NEAR_BOTTOM_PX = 80;

interface ContentBlockCache {
	el: HTMLElement;
	signature: string;
}

interface EntryCache {
	el: HTMLElement;
	content: HTMLElement;
	blocks: Map<number, ContentBlockCache>;
	signature: string;
}

function text(parent: Node, value: string): void {
	parent.appendChild(document.createTextNode(value));
}

function block(parent: HTMLElement, className: string, value: string): HTMLElement {
	const node = document.createElement("div");
	node.className = className;
	text(node, value);
	parent.appendChild(node);
	return node;
}

function signatureOf(item: TranscriptItem): string {
	if (item.role === "assistant") {
		return `${item.status}|${item.content.map((part) =>
			part.type === "text" ? `t:${part.text.length}:${part.text.slice(-32)}` :
			part.type === "thinking" ? `k:${part.thinking.length}:${part.thinking.slice(-16)}` :
			part.type === "toolCall" ? `c:${part.toolName}:${part.status}:${JSON.stringify(part.input).length}` : "?",
		).join(",")}`;
	}
	if (item.role === "user" || item.role === "custom") {
		return `${item.role === "custom" ? `custom:${item.customType}|` : "u|"}${item.content.map((part) => part.type === "text" ? `t:${part.text}` : `i:${part.mimeType}:${part.data}`).join(",")}`;
	}
	return `tool|${item.toolName}|${item.status}|${item.isError ? 1 : 0}|${item.content.map((part) => (part.type === "text" ? `t:${part.text.length}` : `i:${part.data.length}`)).join(",")}`;
}

function copyText(): void {
	const area = document.createElement("textarea");
	area.className = "copy-helper";
	area.readOnly = true;
	document.body.appendChild(area);
	try {
		area.select();
		document.execCommand("copy");
	} catch {
		/* clipboard unavailable */
	}
	document.body.removeChild(area);
}

function copyButton(value: () => string): HTMLButtonElement {
	const button = document.createElement("button");
	button.type = "button";
	button.className = "copy";
	text(button, "复制");
	button.addEventListener("click", () => {
		const helper = document.createElement("textarea");
		helper.className = "copy-helper";
		helper.readOnly = true;
		helper.value = value();
		document.body.appendChild(helper);
		try {
			helper.select();
			document.execCommand("copy");
			button.textContent = "已复制";
			window.setTimeout(() => {
				button.textContent = "复制";
			}, 1500);
		} catch {
			button.textContent = "选择文本复制";
		}
		document.body.removeChild(helper);
	});
	return button;
}

function plainTextOf(item: TranscriptItem): string {
	if (item.role === "assistant") {
		return item.content
			.filter((part) => part.type === "text")
			.map((part) => (part as { type: "text"; text: string }).text)
			.join("\n");
	}
	if (item.role === "user") {
		return item.content
			.filter((part) => part.type === "text")
			.map((part) => (part as { type: "text"; text: string }).text)
			.join("\n");
	}
	return item.content
		.filter((part) => part.type === "text")
		.map((part) => (part as { type: "text"; text: string }).text)
		.join("\n");
}

function renderToolCall(card: HTMLElement, part: { toolName: string; input: unknown; status: string }): void {
	const head = document.createElement("div");
	head.className = "tool-head";
	const dot = document.createElement("span");
	dot.className = `tool-dot ${part.status === "running" || part.status === "pending" ? "running" : part.status === "error" ? "error" : "done"}`;
	head.appendChild(dot);
	block(head, "tool-name", part.toolName);
	const details = document.createElement("details");
	details.className = "tool-input";
	const summary = document.createElement("summary");
	text(summary, "输入");
	details.appendChild(summary);
	const pre = document.createElement("pre");
	const code = document.createElement("code");
	try {
		text(code, JSON.stringify(part.input, null, 2));
	} catch {
		text(code, String(part.input));
	}
	pre.appendChild(code);
	details.appendChild(pre);
	card.appendChild(head);
	card.appendChild(details);
}

function renderImage(parent: HTMLElement, mimeType: string, data: string): void {
	const img = document.createElement("img");
	img.src = `data:${mimeType};base64,${data}`;
	img.alt = `image (${mimeType})`;
	img.loading = "lazy";
	img.addEventListener("error", () => {
		if (img.parentElement) {
			const fallback = document.createElement("div");
			fallback.className = "image-broken";
			text(fallback, `[图片无法显示 (${mimeType})]`);
			img.replaceWith(fallback);
		}
	});
	parent.appendChild(img);
}

function renderContentBlock(parent: HTMLElement, item: TranscriptItem, index: number): HTMLElement {
	const holder = document.createElement("div");
	holder.className = "content";
	const part = item.content[index];
	if (!part) return holder;
	if (part.type === "text") {
		if (item.role === "assistant" || item.role === "custom") {
			const md = document.createElement("div");
			md.className = "markdown";
			renderMarkdown(md, part.text);
			holder.appendChild(md);
		} else {
			text(holder, part.text);
		}
	} else if (part.type === "thinking") {
		const details = document.createElement("details");
		details.className = "thinking";
		const summary = document.createElement("summary");
		text(summary, part.redacted ? "Thinking (redacted)" : "Thinking");
		details.appendChild(summary);
		block(details, "thinking-body", part.thinking);
		holder.appendChild(details);
	} else if (part.type === "image") {
		renderImage(holder, part.mimeType, part.data);
	} else if (part.type === "toolCall") {
		const card = document.createElement("article");
		card.className = "tool-card";
		renderToolCall(card, part);
		holder.appendChild(card);
	}
	parent.appendChild(holder);
	return holder;
}

const TOOL_RESULT_TRUNCATE = 4000;

/**
 * Tool results render as a collapsed <details> with a preview summary; long text
 * is truncated inside with an explicit "show all" toggle. Copy uses the full text.
 */
function renderToolResult(parent: HTMLElement, item: TranscriptItem): HTMLElement {
	const details = document.createElement("details");
	details.className = `tool-result${item.isError ? " is-error" : ""}`;
	if (item.isError) details.open = true;
	const summary = document.createElement("summary");
	const preview = plainTextOf(item).replace(/\s+/g, " ").trim();
	if (preview.length === 0 && item.content.some((part) => part.type === "image")) {
		text(summary, `${item.toolName} 结果（图片）`);
	} else if (preview.length > 90) {
		text(summary, `${preview.slice(0, 90)}… · ${preview.length} 字符`);
	} else if (preview.length > 0) {
		text(summary, preview);
	} else {
		text(summary, `${item.toolName} 结果（空）`);
	}
	details.appendChild(summary);
	const body = document.createElement("div");
	body.className = "tool-body";
	const expanded = new Set<number>();
	const render = () => {
		body.textContent = "";
		for (let index = 0; index < item.content.length; index++) {
			const part = item.content[index]!;
			if (part.type === "image") {
				renderImage(body, part.mimeType, part.data);
				continue;
			}
			if (part.type !== "text") continue;
			if (part.text.length <= TOOL_RESULT_TRUNCATE || expanded.has(index)) {
				block(body, "tool-text", part.text);
				continue;
			}
			block(body, "tool-text", `${part.text.slice(0, TOOL_RESULT_TRUNCATE)}\n…（已截断，共 ${part.text.length} 字符）`);
			const more = document.createElement("button");
			more.type = "button";
			more.className = "tool-more";
			text(more, "显示全部");
			more.addEventListener("click", () => {
				expanded.add(index);
				render();
			});
			body.appendChild(more);
		}
	};
	render();
	details.appendChild(body);
	parent.appendChild(details);
	return details;
}

export interface TranscriptActions {
	canReroll(): boolean;
	onReroll(): void;
	onEdit(item: TranscriptItem): void;
}
export class TranscriptRenderer {
	readonly #target: HTMLElement;
	readonly #cache = new Map<string, EntryCache>();
	readonly #dirty = new Set<string>();
	readonly #actions: TranscriptActions | undefined;
	#framePending = false;
	#backToBottom: HTMLElement | undefined;
	#items: Array<[string, TranscriptItem]> = [];

	constructor(target: HTMLElement, actions?: TranscriptActions) {
		this.#target = target;
		this.#actions = actions;
		target.addEventListener("scroll", () => {
			this.#updateBackToBottomVisibility();
		});
	}

	#backToBottomButton(): HTMLElement {
		if (this.#backToBottom && this.#backToBottom.isConnected) return this.#backToBottom;
		const button = document.createElement("button");
		button.type = "button";
		button.className = "back-to-bottom";
		text(button, "↓ 回到底部");
		button.hidden = true;
		button.addEventListener("click", () => {
			this.#target.scrollTop = this.#target.scrollHeight;
			this.#updateBackToBottomVisibility();
		});
		this.#target.parentElement?.appendChild(button);
		this.#backToBottom = button;
		return button;
	}

	#isNearBottom(): boolean {
		return this.#target.scrollHeight - this.#target.scrollTop - this.#target.clientHeight <= NEAR_BOTTOM_PX;
	}

	#updateBackToBottomVisibility(): void {
		const button = this.#backToBottomButton();
		button.hidden = this.#isNearBottom();
	}

	#createEntry(key: string, item: TranscriptItem): EntryCache {
		const article = document.createElement("article");
		article.className = `entry ${item.role}`;
		article.dataset.key = key;
		const label = document.createElement("div");
		label.className = "entry-label";
		if (item.role === "user") text(label, "You");
		else if (item.role === "custom") text(label, `[${item.customType}]`);
		else if (item.role === "assistant") {
			text(label, "Assistant");
			const streaming = item.status === "streaming";
			if (streaming) {
				const badge = document.createElement("span");
				badge.className = "streaming-badge";
				text(badge, " · streaming");
				label.appendChild(badge);
			}
			if (item.status === "error" || item.status === "aborted") {
				const badge = document.createElement("span");
				badge.className = `status-badge ${item.status}`;
				text(badge, ` · ${item.status}`);
				label.appendChild(badge);
			}
			label.appendChild(copyButton(() => plainTextOf(item)));
		} else {
			text(label, `Tool result · ${item.toolName}${item.isError ? " · error" : ""}`);
		}
		if (this.#actions && (item.role === "user" || item.role === "custom")) {
			const edit = document.createElement("button"); edit.type = "button"; edit.className = "entry-action"; text(edit, "编辑");
			edit.addEventListener("click", () => this.#actions?.onEdit(item)); label.append(edit);
		}
		if (this.#actions && item.role === "assistant" && [...this.#items].reverse().find(([, candidate]) => candidate.role === "assistant")?.[1].id === item.id) {
			const reroll = document.createElement("button"); reroll.type = "button"; reroll.className = "entry-action reroll"; text(reroll, "重新生成");
			reroll.disabled = !this.#actions.canReroll(); reroll.addEventListener("click", () => this.#actions?.onReroll()); label.append(reroll);
		}
		article.appendChild(label);
		if (item.role !== "assistant" && (item.status === "error" || item.status === "aborted")) {
			block(article, "content error-text", (item as { errorMessage?: string }).errorMessage ?? item.status);
		}
		const content = document.createElement("div");
		content.className = "entry-content";
		article.appendChild(content);
		const cache: EntryCache = { el: article, content, blocks: new Map(), signature: "" };
		this.#syncContent(cache, item);
		return cache;
	}

	#syncContent(cache: EntryCache, item: TranscriptItem): void {
		// Tool results fold as one collapsible block (truncated preview, optional full text).
		if (item.role === "tool") {
			const signature = signatureOf(item);
			let holder = cache.blocks.get(-1);
			if (!holder || holder.signature !== signature) {
				if (holder) holder.el.remove();
				const el = renderToolResult(cache.content, item);
				cache.blocks.set(-1, { el, signature });
			}
			cache.signature = signature;
			return;
		}
		// Rebuild only content blocks whose signature changed (06 §4.2 contentIndex granularity).
		for (let index = 0; index < item.content.length; index++) {
			const part = item.content[index]!;
			const partSignature =
				part.type === "text" ? `text:${part.text.length}:${part.text.slice(-24)}` :
				part.type === "thinking" ? `thinking:${part.thinking.length}:${part.thinking.slice(-16)}` :
				part.type === "image" ? `image:${part.data.length}` :
				`toolCall:${part.toolName}:${part.status}:${JSON.stringify(part.input ?? null).length}`;
			const existing = cache.blocks.get(index);
			if (existing && existing.signature === partSignature) continue;
			if (existing) existing.el.remove();
			const el = renderContentBlock(cache.content, item, index);
			cache.content.appendChild(el);
			cache.blocks.set(index, { el, signature: partSignature });
		}
		for (const index of [...cache.blocks.keys()]) {
			if (index >= item.content.length) {
				cache.blocks.get(index)!.el.remove();
				cache.blocks.delete(index);
			}
		}
		const tail = item.role === "assistant" && (item.status === "error" || item.status === "aborted")
			? (item as { errorMessage?: string }).errorMessage ?? item.status
			: null;
		let notice = cache.content.querySelector(".error-text") as HTMLElement | null;
		if (tail) {
			if (notice) notice.textContent = tail;
			else {
				notice = document.createElement("div");
				notice.className = "content error-text";
				text(notice, tail);
				cache.content.appendChild(notice);
			}
		} else if (notice) notice.remove();
		cache.signature = signatureOf(item);
	}

	#reconcileOne(key: string, item: TranscriptItem): void {
		const cached = this.#cache.get(key);
		if (!cached) return;
		if (cached.signature === signatureOf(item)) return;
		this.#syncContent(cached, item);
	}

	reconcile(items: Array<[string, TranscriptItem]>): void {
		this.#items = items;
		const nearBottom = this.#isNearBottom();
		const seen = new Set<string>();
		let anchor: HTMLElement | null = null;
		for (const [key, item] of items) {
			seen.add(key);
			const cached = this.#cache.get(key);
			if (cached) {
				if (cached.signature !== signatureOf(item)) {
					const fresh = this.#createEntry(key, item);
					cached.el.replaceWith(fresh.el);
					this.#cache.set(key, fresh);
					anchor = fresh.el;
					continue;
				}
				// ensure order: move node after previous anchor when out of place
				if (anchor && cached.el.previousSibling !== anchor) anchor.after(cached.el);
				anchor = cached.el;
			} else {
				const fresh = this.#createEntry(key, item);
				if (anchor) anchor.after(fresh.el);
				else this.#target.prepend(fresh.el);
				this.#cache.set(key, fresh);
				anchor = fresh.el;
			}
		}
		for (const [key, cached] of [...this.#cache]) {
			if (!seen.has(key)) {
				cached.el.remove();
				this.#cache.delete(key);
			}
		}
		if (nearBottom) this.#target.scrollTop = this.#target.scrollHeight;
		this.#syncActionState();
		this.#updateBackToBottomVisibility();
	}

	setActionsEnabled(): void {
		this.#syncActionState();
	}

	#syncActionState(): void {
		const latest = [...this.#items].reverse().find(([, item]) => item.role === "assistant")?.[1];
		const latestKey = this.#items.find(([, item]) => item.id === latest?.id)?.[0];
		for (const entry of this.#target.querySelectorAll<HTMLElement>(".entry")) {
			const button = entry.querySelector<HTMLButtonElement>(".reroll");
			if (button) button.disabled = !latestKey || entry.dataset.key !== latestKey || !this.#actions?.canReroll();
		}
	}

	/** Mark a key dirty for the next animation frame (assistant_delta coalescing). */
	markDirty(key: string): void {
		this.#dirty.add(key);
		if (this.#framePending) return;
		this.#framePending = true;
		const frame = () => {
			this.#framePending = false;
			const nearBottom = this.#isNearBottom();
			for (const key of this.#dirty) {
				const item = this.#pendingItems.get(key);
				if (item) this.#reconcileOne(key, item);
			}
			this.#dirty.clear();
			if (nearBottom) this.#target.scrollTop = this.#target.scrollHeight;
			this.#updateBackToBottomVisibility();
		};
		if (typeof requestAnimationFrame === "function") requestAnimationFrame(frame);
		else window.setTimeout(frame, 16);
	}

	readonly #pendingItems = new Map<string, TranscriptItem>();

	/** Track the latest item for a dirty key so the rAF pass renders final state. */
	stageItem(key: string, item: TranscriptItem): void {
		this.#pendingItems.set(key, item);
		// Key might not have a cache node yet (item_started path already creates it
		// through reconcile; delta-only arrival falls back to creating here).
		if (!this.#cache.has(key)) {
			const fresh = this.#createEntry(key, item);
			this.#target.appendChild(fresh.el);
			this.#cache.set(key, fresh);
		}
	}

	clearPending(): void {
		this.#pendingItems.clear();
		this.#dirty.clear();
	}

	clear(): void {
		this.clearPending();
		for (const [, cached] of this.#cache) cached.el.remove();
		this.#cache.clear();
		this.#updateBackToBottomVisibility();
	}
}
