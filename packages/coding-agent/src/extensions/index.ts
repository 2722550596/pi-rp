import type { InlineExtension } from "../core/extensions/types.ts";
import llamaExtension from "./llama/index.ts";
import memoriesExtension from "./memories/index.ts";
import openingExtension from "./opening/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "llama.cpp", factory: llamaExtension, hidden: true },
	{ name: "memories", factory: memoriesExtension, hidden: true },
	{ name: "opening", factory: openingExtension, hidden: true },
];
