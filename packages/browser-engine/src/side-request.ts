import type { Context } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "../../coding-agent/src/core/extensions/types.ts";

export interface BrowserSideRequestOptions {
	readonly modelRole?: "smol" | "default";
	readonly maxTokens?: number;
	readonly signal?: AbortSignal;
	readonly label: string;
}

export async function completeBrowserSideRequest(
	extension: ExtensionContext,
	prompt: string,
	options: BrowserSideRequestOptions,
): Promise<string> {
	if (options.signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
	const context: Context = {
		systemPrompt: "",
		messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
	};
	const role = options.modelRole ?? "smol";
	const reference = extension.settings.memory?.autoretain?.models?.[role];
	let model = extension.model;
	if (reference?.trim()) {
		const normalized = reference.trim().toLowerCase();
		const matches = extension.modelRegistry.getAll().filter((candidate) => {
			const canonical = `${candidate.provider}/${candidate.id}`.toLowerCase();
			return canonical === normalized || (!normalized.includes("/") && candidate.id.toLowerCase() === normalized);
		});
		if (matches.length !== 1)
			throw new Error(`pi-harness: ${role} model ${JSON.stringify(reference)} not found or ambiguous`);
		model = matches[0];
	}
	if (!model) throw new Error("pi-harness: completeSideRequest: no model available");
	const response = await extension.completeSideRequest({
		model,
		context,
		maxTokens: options.maxTokens,
		signal: options.signal,
		label: options.label,
	});
	return response.content
		.filter((item): item is Extract<(typeof response.content)[number], { type: "text" }> => item.type === "text")
		.map((item) => item.text)
		.join("");
}
