/** Extract text from an LLM content array, joining text-type parts. */
export function contentToText(content: { type: string; text?: string }[]): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("\n");
}
