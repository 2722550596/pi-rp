/**
 * Tolerant, streaming-friendly XML-like tag scanner for message content.
 *
 * This is intentionally NOT a full XML parser. Model output written in a
 * narrative that borrows XML tags is rarely well-formed and, while streaming,
 * is frequently *incomplete*. The scanner is designed for that reality:
 *
 * - It never throws on malformed input.
 * - It treats an unterminated tag as a "pending" segment (`closed: false`)
 *   whose content is everything up to the end of the input. Next frame, when
 *   the closing tag arrives, the same tag becomes `closed: true` and the
 *   projection converges. This makes the projection idempotent across frames.
 * - A half-open tag (e.g. `<speak from="eli`) has no closing `>` yet and is
 *   kept as plain text. It resolves as soon as the tag header completes.
 * - Only tags explicitly requested via the `tags` allow-list are recognized;
 *   anything else (including stray `<b>`, `<ooc>` when unlisted, or HTML the
 *   model happened to emit) stays untouched as ordinary text.
 */

export type XmlTagSegment =
	| { kind: "text"; text: string }
	| {
			kind: "tag";
			name: string;
			attrs: Record<string, string>;
			/** Text between the opening tag and the closing tag (or EOF). */
			content: string;
			/** False when the closing tag has not arrived yet (streaming). */
			closed: boolean;
			/** True when the source ended inside the tag's content (opening tag complete, no closing tag yet). */
			pending: boolean;
	  };

const TAG_NAME_RE = /^<([A-Za-z][A-Za-z0-9_-]*)/;
const ATTR_RE = /([A-Za-z_][A-Za-z0-9_.:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/**
 * Scan `source` for the given tags. Only tags whose name appears in `tags`
 * are recognized; all other content passes through as text segments.
 *
 * @param source The full current message text (each streaming frame re-scans
 *   the whole message; the scanner is stateless by design).
 * @param tags Allow-list of tag names to recognize.
 */
export function scanXmlTags(source: string, tags: ReadonlySet<string>): XmlTagSegment[] {
	const segments: XmlTagSegment[] = [];
	// Start of the current run of plain text (everything up to the next
	// recognized tag). Unrecognized '<' stays inside this run.
	let textStart = 0;
	// Scan position; skips over non-tag '<' one character at a time.
	let cursor = 0;

	while (cursor < source.length) {
		const lt = source.indexOf("<", cursor);
		if (lt === -1) {
			break;
		}

		// Does this '<' start a recognized tag header?
		const headerMatch = TAG_NAME_RE.exec(source.slice(lt));
		if (!headerMatch || !tags.has(headerMatch[1])) {
			// Not a recognized tag — '<' belongs to the plain text run.
			cursor = lt + 1;
			continue;
		}

		const name = headerMatch[1];
		const headerBodyStart = lt + headerMatch[0].length;

		// The opening tag header must be closed by '>' in this frame; if not,
		// everything from '<' on stays plain text (the header will resolve
		// once it completes next frame).
		const headerEnd = source.indexOf(">", headerBodyStart);
		if (headerEnd === -1) {
			cursor = lt + 1;
			continue;
		}
		const headerEndExclusive = headerEnd + 1;

		const attrs = parseAttrs(source.slice(headerBodyStart, headerEnd));

		// Emit the plain text run that precedes this tag.
		if (lt > textStart) {
			segments.push({ kind: "text", text: source.slice(textStart, lt) });
		}

		// Find the closing tag in the remaining source.
		const closeStart = findClosingTag(source, name, headerEndExclusive);
		if (closeStart === -1) {
			// Unterminated: everything up to EOF is the tag content. The rest
			// of the input belongs to this tag, so we are done after this.
			segments.push({
				kind: "tag",
				name,
				attrs,
				content: source.slice(headerEndExclusive),
				closed: false,
				pending: true,
			});
			textStart = source.length;
			break;
		}

		segments.push({
			kind: "tag",
			name,
			attrs,
			content: source.slice(headerEndExclusive, closeStart),
			closed: true,
			pending: false,
		});

		// Advance past the closing tag.
		cursor = skipClosingTag(source, closeStart, name);
		textStart = cursor;
	}

	if (textStart < source.length) {
		segments.push({ kind: "text", text: source.slice(textStart) });
	}

	return segments;
}

function parseAttrs(headerBody: string): Record<string, string> {
	const attrs: Record<string, string> = {};
	if (!headerBody.trim()) {
		return attrs;
	}
	ATTR_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = ATTR_RE.exec(headerBody)) !== null) {
		const key = match[1];
		const value = match[2] ?? match[3] ?? match[4] ?? "";
		attrs[key] = value;
	}
	return attrs;
}

/**
 * Find the position of the closing tag `</name>` starting the search after
 * `from`. Returns -1 when no well-formed closing tag exists in the remainder.
 */
function findClosingTag(source: string, name: string, from: number): number {
	let searchFrom = from;
	while (true) {
		const closeLt = source.indexOf(`</${name}`, searchFrom);
		if (closeLt === -1) {
			return -1;
		}
		// `</name` must be followed (allowing whitespace) by '>'.
		let look = closeLt + 2 + name.length;
		while (look < source.length && /[\s]/.test(source[look] ?? "")) {
			look++;
		}
		if ((source[look] ?? "") === ">") {
			return closeLt;
		}
		searchFrom = closeLt + 2 + name.length;
	}
}

/** Advance past `</name ... >` starting at the closing tag's '<'. */
function skipClosingTag(source: string, closeLt: number, name: string): number {
	let look = closeLt + 2 + name.length;
	while (look < source.length && source[look] !== ">") {
		look++;
	}
	return Math.min(source.length, look + 1);
}