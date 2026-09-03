/**
 * Factory that turns tag-specific renderers into a {@link MessageContentTransformer}.
 *
 * The scanner (see `xml-tags.ts`) handles the streaming-tolerant structure;
 * this factory only decides how each recognized tag is displayed. Unrecognized
 * tags and ordinary text pass through untouched.
 */

import type { MessageContentTransformer } from "./extensions/types.ts";
import { scanXmlTags, type XmlTagSegment } from "./xml-tags.ts";

export interface XmlTagRenderContext {
	isStreaming: boolean;
	availableWidth: number;
	messageType: "user" | "assistant" | "assistant-thinking" | "custom";
	customType?: string;
}

export type XmlTagRenderer = (
	tag: Extract<XmlTagSegment, { kind: "tag" }>,
	context: XmlTagRenderContext,
) => string;

export interface XmlTagTransformerOptions {
	/** Tag name → renderer. Only these tags are scanned and projected. */
	tags: Record<string, XmlTagRenderer>;
	/**
	 * Called for tags that threw inside their renderer. Defaults to returning
	 * the raw source slice, which keeps the tag visible rather than dropping it.
	 */
	onRendererError?: (tag: Extract<XmlTagSegment, { kind: "tag" }>, error: unknown) => string;
}

/**
 * Build a message content transformer that projects XML-like tags onto
 * display text. Text outside recognized tags — including half-open headers —
 * is preserved byte-for-byte.
 */
export function createXmlTagTransformer(options: XmlTagTransformerOptions): MessageContentTransformer {
	const tagNames = new Set(Object.keys(options.tags));
	const { onRendererError } = options;

	return (content, context) => {
		const transformContext: XmlTagRenderContext = {
			isStreaming: context.isStreaming,
			availableWidth: context.availableWidth,
			messageType: context.messageType,
			customType: context.customType,
		};

		const segments = scanXmlTags(content, tagNames);
		const hasTags = segments.some((s) => s.kind === "tag");
		if (!hasTags) {
			return content;
		}

		let out = "";
		for (const segment of segments) {
			if (segment.kind === "text") {
				out += segment.text;
				continue;
			}
			const renderer = options.tags[segment.name];
			if (!renderer) {
				// Unrecognized tag (should not happen given the allow-list,
				// but keep a safe passthrough for the raw header + content).
				out += `<${segment.name}${serializeAttrs(segment.attrs)}>${segment.content}${segment.closed ? `</${segment.name}>` : ""}`;
				continue;
			}
			try {
				const rendered = renderer(segment, transformContext);
				out += typeof rendered === "string" ? rendered : "";
			} catch (err) {
				out += onRendererError
					? onRendererError(segment, err)
					: `<${segment.name}${serializeAttrs(segment.attrs)}>${segment.content}${segment.closed ? `</${segment.name}>` : ""}`;
			}
		}
		return out;
	};
}

function serializeAttrs(attrs: Record<string, string>): string {
	const entries = Object.entries(attrs);
	if (entries.length === 0) {
		return "";
	}
	return " " + entries.map(([k, v]) => (v === "" ? k : `${k}="${v}"`)).join(" ");
}