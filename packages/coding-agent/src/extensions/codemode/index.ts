import type { ExtensionAPI, ExtensionFactory, SessionStartEvent } from "../../core/extensions/types.ts";
import { type CodemodeToolOptions, createCodemodeToolDefinition } from "./tool.ts";

export interface CodemodeExtensionOptions {
	/** Overrides the `codemode.mode` setting. */
	mode?: "on" | "only";
	/** Overrides the `codemode.inlineBudget` setting. */
	inlineBudget?: number;
	/** Expose model catalog helpers to scripts. Defaults to true. */
	models?: boolean;
}

export function createCodemodeExtension(options: CodemodeExtensionOptions = {}): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		let configuredMode: "on" | "only" = "on";
		let configuredBudget: number | undefined;
		pi.on("session_start", (_event: SessionStartEvent, ctx) => {
			configuredMode = ctx.settings.codemode?.mode ?? "on";
			configuredBudget = ctx.settings.codemode?.inlineBudget;
		});
		const runtimeOptions: CodemodeToolOptions = {
			appendEntry: (customType, data) => pi.appendEntry(customType, data),
			models: options.models ?? true,
			getToolNamespace: (name) => pi.getAllTools().find((tool) => tool.name === name)?.namespace,
			getMode: () => options.mode ?? configuredMode,
			getInlineBudget: () => options.inlineBudget ?? configuredBudget,
		};
		pi.registerTool({ ...createCodemodeToolDefinition(runtimeOptions), defaultActive: false });
	};
}

export default createCodemodeExtension();
