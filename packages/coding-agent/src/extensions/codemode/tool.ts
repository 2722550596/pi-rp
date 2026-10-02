import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { CodemodeJsonSchema, CodemodeTool } from "@earendil-works/pi-codemode";
import { renderToolSample, toCodemodeIdentifier } from "@earendil-works/pi-codemode";
import type { Static } from "typebox";
import { Type } from "typebox";
import type { ToolDefinition, ToolLoadout, ToolLoadoutChanges, ToolNamespace } from "../../core/extensions/types.ts";
import { executeCodemode } from "./execute.ts";

export const CODEMODE_TOOL_NAME = "codemode";
export const CODEMODE_STORE_ENTRY_TYPE = "codemode-store";
export interface CodemodeStoreEntryData {
	set: Record<string, unknown>;
	delete: string[];
}

export interface CodemodeToolOptions {
	models?: boolean;
	appendEntry?: (customType: string, data: CodemodeStoreEntryData) => void;
	getToolNamespace?: (toolName: string) => ToolNamespace | undefined;
	getMode?: () => "on" | "only";
	getInlineBudget?: () => number | undefined;
}

export const codemodeSchema = Type.Object({ code: Type.String({ description: "Raw JavaScript source." }) });
export type CodemodeToolInput = Static<typeof codemodeSchema>;
export interface CodemodeNestedCall {
	id: string;
	name: string;
	args: string;
	status: "running" | "ok" | "error" | "cancelled";
	durationMs?: number;
	error?: string;
	cost?: number;
}
export interface CodemodeToolDetails {
	calls: CodemodeNestedCall[];
	fullOutputPath?: string;
}

const intro = `Run JavaScript that calls other tools. The input is raw JavaScript (not JSON, no code fence), run as an async function body in a QuickJS sandbox: top-level \`await\` and \`return\` work. No Node, file system, network, or timers.\n- \`await tools.<name>({ ...args })\` resolves to a string, or an object if the tool's declaration says so, and rejects with an Error on failure. Calls still running when the script ends are cancelled.\n- Optional first line: \`// @options: {"max_output_tokens": 10000, "timeout_ms": 60000}\``;

export function toCodemodeDeclaration(tool: AgentTool): Omit<CodemodeTool, "execute"> {
	return {
		name: tool.name,
		description: tool.description,
		inputSchema: tool.parameters as CodemodeJsonSchema,
		outputSchema: (tool.outputSchema as CodemodeJsonSchema | undefined) ?? { type: "string" },
	};
}

export function getCodemodeCallableTools(tools: readonly AgentTool[]): AgentTool[] {
	return tools.filter((tool) => tool.name !== CODEMODE_TOOL_NAME);
}

function declarationSection(tool: AgentTool): string {
	const id = toCodemodeIdentifier(tool.name);
	return `### \`${id}\`${id === tool.name ? "" : ` (\`${tool.name}\`)`}\n${renderToolSample(toCodemodeDeclaration(tool)).trim()}`;
}

export function createCodemodeDescription(
	tools: readonly AgentTool[],
	options: {
		models?: boolean;
		deferred?: ReadonlySet<string>;
		inlineBudget?: number;
		namespaces?: ReadonlyMap<string, ToolNamespace>;
	} = {},
): string {
	const sections = [
		intro,
		[
			"Globals:",
			"- `text(value)`, `image(dataUrlOrImageBlock)`, `console.log(...)`, and top-level `return` add output; `exit()` ends the script.",
			"- `store(key, value)` and `load(key)` keep JSON values across codemode calls.",
			"- `ALL_TOOLS`, `searchTools(query, { limit?, namespace? })`, `describeTool(name)`, `describeNamespace(name)`: find unlisted tools.",
			...(options.models ? ["- `models`: list and resolve models from the session catalogue."] : []),
		].join("\n"),
	];
	const callable = getCodemodeCallableTools(tools).filter((tool) => !options.deferred?.has(tool.name));
	if (!callable.length) return sections.join("\n\n");
	const maxChars = options.inlineBudget === undefined ? Infinity : Math.max(0, options.inlineBudget) * 4;
	const groups = new Map<string, { namespace?: ToolNamespace; sections: string[] }>();
	for (const tool of callable) {
		const namespace = options.namespaces?.get(tool.name);
		const key = namespace?.name ?? "";
		const group = groups.get(key) ?? { namespace, sections: [] };
		group.sections.push(declarationSection(tool));
		groups.set(key, group);
	}
	const ordered = [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
	const shown: string[] = [];
	let used = 0;
	for (const [, group] of ordered) {
		const groupSections = group.sections.filter((section) => {
			if (used + section.length > maxChars) return false;
			used += section.length;
			return true;
		});
		if (group.namespace) {
			const detail = [group.namespace.description?.trim(), group.namespace.instructions?.trim()]
				.filter(Boolean)
				.join("\n");
			shown.push(`## ${group.namespace.name}${detail ? `\n${detail}` : ""}`);
		}
		shown.push(...groupSections);
	}
	sections.push(["Nested tools:", ...shown].join("\n\n"));
	return sections.join("\n\n");
}

function prepareLoadout(loadout: ToolLoadout, options: CodemodeToolOptions): ToolLoadoutChanges {
	const callable = getCodemodeCallableTools(loadout.callable);
	const callableNames = new Set(callable.map((tool) => tool.name));
	const descriptions: Record<string, string> = {};
	const mode = options.getMode?.() ?? "on";
	if (mode === "on") {
		for (const tool of loadout.declared) {
			if (callableNames.has(tool.name))
				descriptions[tool.name] =
					`${tool.description.trim()}\n\nCodemode: \`tools.${toCodemodeIdentifier(tool.name)}(args)\``;
		}
	}
	const listed = mode === "only" ? callable : callable.filter((tool) => loadout.getExposure(tool.name) !== "direct");
	const deferred = new Set(
		listed.filter((tool) => loadout.getExposure(tool.name) === "deferred").map((tool) => tool.name),
	);
	const namespaces = new Map(
		listed.flatMap((tool) => {
			const namespace = loadout.getNamespace(tool.name);
			return namespace ? [[tool.name, namespace] as const] : [];
		}),
	);
	descriptions[CODEMODE_TOOL_NAME] = createCodemodeDescription(listed, {
		models: options.models,
		deferred,
		inlineBudget: options.getInlineBudget?.() ?? 3000,
		namespaces,
	});
	const declared = new Set(loadout.declared.map((tool) => tool.name));
	return {
		descriptions,
		hiddenDeclarations:
			mode === "only"
				? callable
						.filter((tool) => loadout.getExposure(tool.name) === "direct" && declared.has(tool.name))
						.map((tool) => tool.name)
				: [],
	};
}

export function createCodemodeToolDefinition(
	options: CodemodeToolOptions = {},
): ToolDefinition<typeof codemodeSchema, CodemodeToolDetails> {
	return {
		name: CODEMODE_TOOL_NAME,
		label: CODEMODE_TOOL_NAME,
		description: createCodemodeDescription([], { models: options.models }),
		promptSnippet: "Run JavaScript that calls other tools",
		promptGuidelines: ["Use codemode to batch independent tool calls, chain them, or filter large output."],
		parameters: codemodeSchema,
		exposure: "model-only",
		prepareLoadout: (loadout) => prepareLoadout(loadout, options),
		execute: (id, params, signal, onUpdate, ctx) => executeCodemode(id, params, signal, onUpdate, ctx, options),
	};
}
