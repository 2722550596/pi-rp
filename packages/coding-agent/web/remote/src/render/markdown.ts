/**
 * Restricted markdown renderer — pure DOM, no innerHTML, no dependencies.
 * Coverage and degradation rules are frozen in docs/design/remote-web-control/06-web-frontend.md §5.
 * Blocks: fenced code, headings, hr, blockquote, lists (one nesting level), paragraphs.
 * Inline: `code`, **bold**, *italic*, [label](http(s)://…). Everything else renders as literal text.
 */

function text(parent: Node, value: string): Text {
	const node = document.createTextNode(value);
	parent.appendChild(node);
	return node;
}

const FENCE_RE = /^ {0,3}```/;
const FENCE_LANG_RE = /^ {0,3}```\s*([A-Za-z0-9_+.-]+)?\s*$/;
const HEADING_RE = /^ {0,3}(#{1,6})\s+(.*)$/;
const HR_RE = /^ {0,3}((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/;
const QUOTE_RE = /^ {0,3}>\s?(.*)$/;
const UL_RE = /^(\s*)([-*+])\s+(.*)$/;
const OL_RE = /^(\s*)(\d+)[.)]\s+(.*)$/;

type Block =
	| { kind: "code"; language: string | undefined; lines: string[] }
	| { kind: "heading"; level: number; text: string }
	| { kind: "hr" }
	| { kind: "quote"; lines: string[] }
	| { kind: "list"; ordered: boolean; items: Array<{ text: string; children: Array<{ ordered: boolean; items: string[] }> }> }
	| { kind: "paragraph"; lines: string[] };

function parseBlocks(source: string): Block[] {
	const lines = source.split("\n");
	const blocks: Block[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i]!;
		if (FENCE_RE.test(line)) {
			const match = line.match(FENCE_LANG_RE);
			const language = match?.[1];
			const body: string[] = [];
			i++;
			while (i < lines.length && !FENCE_RE.test(lines[i]!)) {
				body.push(lines[i]!);
				i++;
			}
			if (i < lines.length) i++; // consume closing fence
			blocks.push({ kind: "code", language, lines: body });
			continue;
		}
		if (HR_RE.test(line)) {
			blocks.push({ kind: "hr" });
			i++;
			continue;
		}
		const heading = line.match(HEADING_RE);
		if (heading) {
			blocks.push({ kind: "heading", level: heading[1]!.length, text: heading[2]! });
			i++;
			continue;
		}
		const quote = line.match(QUOTE_RE);
		if (quote) {
			const body = [quote[1]!];
			i++;
			while (i < lines.length) {
				const next = lines[i]!.match(QUOTE_RE);
				if (!next) break;
				body.push(next[1]!);
				i++;
			}
			blocks.push({ kind: "quote", lines: body });
			continue;
		}
		const ul = line.match(UL_RE);
		const ol = line.match(OL_RE);
		if (ul || ol) {
			const ordered = Boolean(ol);
			const items: Array<{ text: string; children: Array<{ ordered: boolean; items: string[] }> }> = [];
			while (i < lines.length) {
				const raw = lines[i]!;
				const mu = raw.match(UL_RE);
				const mo = raw.match(OL_RE);
				const entry = ordered ? mo : mu;
				const other = ordered ? mu : mo;
				if (entry && entry[1]!.length === 0) {
					items.push({ text: entry[3]!, children: [] });
					i++;
					// collect one nesting level under this item
					while (i < lines.length) {
						const cu = lines[i]!.match(UL_RE);
						const co = lines[i]!.match(OL_RE);
						const child = cu ?? co;
						if (child && child[1]!.length >= 2) {
							const childOrdered = Boolean(co);
							let bucket = items[items.length - 1]!.children.find((c) => c.ordered === childOrdered);
							if (!bucket) {
								bucket = { ordered: childOrdered, items: [] };
								items[items.length - 1]!.children.push(bucket);
							}
							bucket.items.push(child[3]!);
							i++;
						} else if (!cu && !co && lines[i]!.trim().length > 0 && items[items.length - 1]!.children.length > 0) {
							// continuation text of the nested item — keep as plain line in last child
							const bucket = items[items.length - 1]!.children[items[items.length - 1]!.children.length - 1]!;
							bucket.items[bucket.items.length - 1] += `\n${lines[i]!.trim()}`;
							i++;
						} else break;
					}
				} else if (other && other[1]!.length === 0) {
					break; // marker type switch ends the list
				} else break;
			}
			blocks.push({ kind: "list", ordered, items });
			continue;
		}
		if (line.trim().length === 0) {
			i++;
			continue;
		}
		const para: string[] = [line];
		i++;
		while (i < lines.length) {
			const next = lines[i]!;
			if (
				next.trim().length === 0 ||
				FENCE_RE.test(next) ||
				HEADING_RE.test(next) ||
				HR_RE.test(next) ||
				QUOTE_RE.test(next) ||
				UL_RE.test(next) ||
				OL_RE.test(next)
			) {
				break;
			}
			para.push(next);
			i++;
		}
		blocks.push({ kind: "paragraph", lines: para });
	}
	return blocks;
}

function safeUrl(raw: string): string | null {
	try {
		const url = new URL(raw);
		if (url.protocol === "http:" || url.protocol === "https:") return url.toString();
		return null;
	} catch {
		return null;
	}
}

/** Renders inline markup into `parent`: `code`, **bold**, *italic*, [label](url). */
function renderInline(parent: HTMLElement, source: string): void {
	let buffer = "";
	const flush = () => {
		if (buffer.length > 0) {
			text(parent, buffer);
			buffer = "";
		}
	};
	let i = 0;
	while (i < source.length) {
		const ch = source[i]!;
		if (ch === "`") {
			const end = source.indexOf("`", i + 1);
			if (end > i) {
				flush();
				const code = document.createElement("code");
				text(code, source.slice(i + 1, end));
				parent.appendChild(code);
				i = end + 1;
				continue;
			}
		} else if (ch === "*" && source[i + 1] === "*") {
			const end = source.indexOf("**", i + 2);
			if (end > i + 1) {
				flush();
				const strong = document.createElement("strong");
				renderPlain(strong, source.slice(i + 2, end));
				parent.appendChild(strong);
				i = end + 2;
				continue;
			}
		} else if (ch === "*" && source[i + 1] !== " " && source[i + 1] !== "*") {
			const end = source.indexOf("*", i + 1);
			if (end > i + 1) {
				flush();
				const em = document.createElement("em");
				renderPlain(em, source.slice(i + 1, end));
				parent.appendChild(em);
				i = end + 1;
				continue;
			}
		} else if (ch === "[") {
			const close = source.indexOf("]", i + 1);
			if (close > i && source[close + 1] === "(") {
				const paren = source.indexOf(")", close + 2);
				if (paren > close + 1) {
					const label = source.slice(i + 1, close);
					const url = safeUrl(source.slice(close + 2, paren));
					if (url) {
						flush();
						const anchor = document.createElement("a");
						anchor.href = url;
						anchor.target = "_blank";
						anchor.rel = "noopener";
						renderPlain(anchor, label);
						parent.appendChild(anchor);
						i = paren + 1;
						continue;
					}
				}
			}
		}
		buffer += ch;
		i++;
	}
	flush();
}

/** Bold/italic/link delimiters inside inline containers stay literal (no nested emphasis). */
function renderPlain(parent: HTMLElement, source: string): void {
	text(parent, source);
}

function renderBlock(parent: HTMLElement, block: Block): void {
	if (block.kind === "code") {
		const wrap = document.createElement("div");
		wrap.className = "code-block";
		if (block.language) {
			const tag = document.createElement("span");
			tag.className = "code-language";
			text(tag, block.language);
			wrap.appendChild(tag);
		}
		const pre = document.createElement("pre");
		const code = document.createElement("code");
		text(code, block.lines.join("\n"));
		pre.appendChild(code);
		wrap.appendChild(pre);
		parent.appendChild(wrap);
		return;
	}
	if (block.kind === "heading") {
		const h = document.createElement(`h${Math.min(block.level, 6)}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6");
		renderInline(h, block.text);
		parent.appendChild(h);
		return;
	}
	if (block.kind === "hr") {
		parent.appendChild(document.createElement("hr"));
		return;
	}
	if (block.kind === "quote") {
		const q = document.createElement("blockquote");
		const p = document.createElement("p");
		renderInline(p, block.lines.join("\n"));
		q.appendChild(p);
		parent.appendChild(q);
		return;
	}
	if (block.kind === "list") {
		const list = document.createElement(block.ordered ? "ol" : "ul");
		for (const item of block.items) {
			const li = document.createElement("li");
			renderInline(li, item.text);
			for (const child of item.children) {
				const sub = document.createElement(child.ordered ? "ol" : "ul");
				for (const entry of child.items) {
					const subLi = document.createElement("li");
					renderPlain(subLi, entry);
					sub.appendChild(subLi);
				}
				li.appendChild(sub);
			}
			list.appendChild(li);
		}
		parent.appendChild(list);
		return;
	}
	const p = document.createElement("p");
	renderInline(p, block.lines.join("\n"));
	parent.appendChild(p);
}

/**
 * Renders `source` as restricted markdown into `parent` (cleared first).
 * Safe to call repeatedly on streaming content: each call re-parses the
 * accumulated text, tolerating unclosed fences and markers (06 §4.3).
 */
export function renderMarkdown(parent: HTMLElement, source: string): void {
	while (parent.firstChild) parent.removeChild(parent.firstChild);
	for (const block of parseBlocks(source)) renderBlock(parent, block);
}
