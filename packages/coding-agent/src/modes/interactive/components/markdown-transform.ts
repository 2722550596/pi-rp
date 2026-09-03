import type {
	MessageContentTransformContext,
	MessageContentTransformer,
} from "../../../core/extensions/types.ts";

/**
 * Build a transform function for {@link Markdown} from the unified message
 * content transformers. This is the entry point used by all message components
 * (assistant, assistant-thinking, user, and default custom rendering).
 */
export function createMessageContentTransform(
	messageType: MessageContentTransformContext["messageType"],
	isStreaming: boolean,
	transformers: readonly MessageContentTransformer[],
	customType?: string,
): (content: string, availableWidth: number) => string {
	return (content, availableWidth) =>
		applyMessageContentTransformers(content, { messageType, customType, isStreaming, availableWidth }, transformers);
}

function applyMessageContentTransformers(
	content: string,
	context: MessageContentTransformContext,
	transformers: readonly MessageContentTransformer[],
): string {
	let transformedContent = content;
	for (const transformer of transformers) {
		try {
			const transformed = transformer(transformedContent, context);
			if (typeof transformed === "string") {
				transformedContent = transformed;
			}
		} catch {
			// Keep the current content and continue with the next transformer.
		}
	}
	return transformedContent;
}
