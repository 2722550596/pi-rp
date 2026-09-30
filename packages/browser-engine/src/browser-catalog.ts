/**
 * Browser-profile provider catalog — alias target for `@earendil-works/pi-ai/providers/all`
 * (wired in build.mjs `workspaceSrcPlugin`, mirroring the `pi-agent-core/node` stub pattern).
 *
 * The full catalog (packages/ai/src/providers/all.ts) pulls every provider SDK, the generated
 * model catalog, and the @aws-sdk bedrock chain — all forbidden in the browser bundle
 * (check-browser-harness A3). The browser direct-connect set is frozen by contract §8:
 * anthropic / openai / google / mistral / openrouter — all five passed live CORS preflight
 * (2026-09-30, 契约 §8 回写) plus the custom-baseUrl gateway shape.
 *
 * `radiusProvider` is retained as a structured failure: radius gateway providers need the
 * node catalog surface and are unreachable with `modelsPath: null` assembly (empty config),
 * but the symbol must resolve for model-runtime.ts's namespace import.
 */

import type { Provider } from "../../ai/src/models.ts";
import { anthropicProvider } from "../../ai/src/providers/anthropic.ts";
import { googleProvider } from "../../ai/src/providers/google.ts";
import { mistralProvider } from "../../ai/src/providers/mistral.ts";
import { openaiProvider } from "../../ai/src/providers/openai.ts";
import { openrouterProvider } from "../../ai/src/providers/openrouter.ts";

/** The frozen browser direct-connect set (契约 §8). */
export function builtinProviders(): Provider[] {
	return [anthropicProvider(), openaiProvider(), googleProvider(), mistralProvider(), openrouterProvider()];
}

/**
 * Hydration timestamp of shipped model data. The browser catalog ships no generated-data
 * manifest (the full catalog's data hydration is a node-side build step), so this resolves
 * `undefined` — remote-catalog refresh stays conservative, static provider models remain
 * available (ModelRuntime `refreshOnCreate` semantic).
 */
export function getBuiltinModelDataGeneratedAt(): number | undefined {
	return undefined;
}

export function radiusProvider(): Provider {
	throw new Error(
		"pi-harness: radius gateway providers are not available in the browser bundle; configure a direct-connect or custom-baseUrl provider instead",
	);
}
