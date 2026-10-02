import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool, AgentToolCallOutcome, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	type CodemodeResult,
	CodemodeSandbox,
	type CodemodeTool,
	parseCodemodeSource,
	renderToolSample,
} from "@earendil-works/pi-codemode";
import type { ExtensionToolContext, ToolNamespace } from "../../core/extensions/types.ts";
import type { SessionEntry } from "../../core/session-manager.ts";
import {
	searchTools as rankTools,
	type SearchableTool,
	TOOL_SEARCH_LIMIT_DEFAULT,
} from "../../core/tool-search/search.ts";
import {
	CODEMODE_STORE_ENTRY_TYPE,
	type CodemodeNestedCall,
	type CodemodeStoreEntryData,
	type CodemodeToolDetails,
	type CodemodeToolInput,
	type CodemodeToolOptions,
	getCodemodeCallableTools,
	toCodemodeDeclaration,
} from "./tool.ts";

const MAX_NESTED_CALLS = 128;
const preview = (value: unknown, length: number): string => {
	try {
		const text = JSON.stringify(value) ?? "";
		return text.length > length ? `${text.slice(0, length - 3)}...` : text;
	} catch {
		return "";
	}
};

function validStoreData(data: unknown): data is CodemodeStoreEntryData {
	if (typeof data !== "object" || data === null) return false;
	const candidate = data as Partial<CodemodeStoreEntryData>;
	return (
		typeof candidate.set === "object" &&
		candidate.set !== null &&
		Array.isArray(candidate.delete) &&
		candidate.delete.every((key) => typeof key === "string")
	);
}

export function readCodemodeStore(branch: readonly SessionEntry[]): Record<string, unknown> {
	const values = new Map<string, unknown>();
	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== CODEMODE_STORE_ENTRY_TYPE || !validStoreData(entry.data))
			continue;
		for (const key of entry.data.delete) values.delete(key);
		for (const [key, value] of Object.entries(entry.data.set)) values.set(key, value);
	}
	return Object.fromEntries(values);
}

function textContent(outcome: AgentToolCallOutcome): string {
	return (outcome.result.content ?? [])
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function nestedValue(tool: { outputSchema?: unknown; name: string }, outcome: AgentToolCallOutcome): unknown {
	if (tool.outputSchema && "structuredContent" in outcome.result && outcome.result.structuredContent !== undefined) {
		return outcome.result.structuredContent;
	}
	const text = textContent(outcome);
	if (outcome.isError) throw new Error(text || `Tool "${tool.name}" failed`);
	return text;
}

function namespaceFor(options: CodemodeToolOptions, name: string): ToolNamespace | undefined {
	return options.getToolNamespace?.(name);
}

function createDiscoveryGlobals(tools: readonly AgentTool[], options: CodemodeToolOptions): CodemodeTool[] {
	const samples = new Map(tools.map((tool) => [tool.name, renderToolSample(toCodemodeDeclaration(tool))]));
	return [
		{
			name: "searchTools",
			spread: true,
			execute: (args) => {
				const [query, searchOptions] = args as [unknown, { limit?: unknown; namespace?: unknown } | undefined];
				if (typeof query !== "string") throw new Error("searchTools() expects a query string");
				const limit = searchOptions?.limit ?? TOOL_SEARCH_LIMIT_DEFAULT;
				if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1)
					throw new Error("searchTools() limit must be a positive integer");
				const namespace = searchOptions?.namespace;
				if (namespace !== undefined && namespace !== null && typeof namespace !== "string")
					throw new Error("searchTools() namespace must be a string");
				const snapshot: SearchableTool[] = tools
					.filter((tool) => {
						const group = namespaceFor(options, tool.name);
						return !namespace || group?.name === namespace;
					})
					.map((tool) => ({
						name: tool.name,
						description: tool.description,
						...(tool.promptSnippet ? { promptSnippet: tool.promptSnippet } : {}),
						parameters: [],
						deferrable: true,
					}));
				const result = rankTools(snapshot, { keywords: query.trim().split(/\s+/).filter(Boolean), limit });
				return result.status === "ok"
					? result.matchedToolNames.map((name) => ({ name, description: samples.get(name) }))
					: [];
			},
		},
		{
			name: "describeTool",
			spread: true,
			execute: (args) => {
				const [name] = args as unknown[];
				if (typeof name !== "string") throw new Error("describeTool() expects a tool name");
				const tool = tools.find((item) => item.name === name || item.name.replace(/[^\w$]/g, "_") === name);
				return tool ? samples.get(tool.name) : undefined;
			},
		},
		{
			name: "describeNamespace",
			spread: true,
			execute: (args) => {
				const [name] = args as unknown[];
				if (typeof name !== "string") throw new Error("describeNamespace() expects a namespace name");
				const namespace = tools.map((tool) => namespaceFor(options, tool.name)).find((item) => item?.name === name);
				if (!namespace) return undefined;
				return {
					...namespace,
					tools: tools
						.filter((tool) => namespaceFor(options, tool.name)?.name === name)
						.map((tool) => tool.name.replace(/[^\w$]/g, "_")),
				};
			},
		},
	];
}

function modelType(value: unknown): string {
	if (value !== "chat" && value !== "image" && value !== "classifier") {
		throw new Error(`Unknown model type ${JSON.stringify(value)}. Use "chat", "image", or "classifier".`);
	}
	return value;
}

function modelInfo(model: Model<Api>): Record<string, unknown> {
	const info: Record<string, unknown> = { ...model };
	delete info.headers;
	return info;
}

function createModelGlobals(ctx: ExtensionToolContext): CodemodeTool[] {
	const registry = ctx.modelRegistry;
	return [
		{
			name: "models.getModelsOfType",
			spread: true,
			execute: (args) => {
				const [type, provider] = args as [unknown, unknown];
				const expected = modelType(type);
				if (provider !== undefined && provider !== null && typeof provider !== "string")
					throw new Error("provider must be a string");
				return registry
					.getAll()
					.filter((model) => model.api === expected && (!provider || model.provider === provider))
					.map(modelInfo);
			},
		},
		{
			name: "models.getAvailableOfType",
			spread: true,
			execute: async (args) => {
				const [type, provider] = args as [unknown, unknown];
				const expected = modelType(type);
				if (provider !== undefined && provider !== null && typeof provider !== "string")
					throw new Error("provider must be a string");
				return registry
					.getAvailable()
					.filter((model) => model.api === expected && (!provider || model.provider === provider))
					.map(modelInfo);
			},
		},
		{
			name: "models.getModelOfType",
			spread: true,
			execute: (args) => {
				const [type, provider, id] = args as [unknown, unknown, unknown];
				const expected = modelType(type);
				if (typeof provider !== "string" || typeof id !== "string")
					throw new Error("models.getModelOfType(type, provider, id) expects three strings");
				const model = registry.find(provider, id);
				return model?.api === expected ? modelInfo(model) : undefined;
			},
		},
	];
}

async function limitOutput(
	content: AgentToolResult<unknown>["content"],
	maxTokens: number,
): Promise<{ content: AgentToolResult<unknown>["content"]; fullOutputPath?: string }> {
	const text = content
		.filter((item) => item.type === "text")
		.map((item) => item.text)
		.join("\n");
	const budget = Math.max(0, maxTokens) * 4;
	if (text.length <= budget) return { content };
	const startLength = Math.floor(budget / 2);
	const endLength = budget - startLength;
	const omitted = text.length - startLength - endLength;
	const path = join(tmpdir(), `pi-codemode-${randomBytes(8).toString("hex")}.txt`);
	let location: string;
	try {
		await writeFile(path, text);
		location = `\n\n[Full output: ${path} (read with offset/limit)]`;
	} catch (error) {
		location = `\n\n[Could not save full output: ${error instanceof Error ? error.message : String(error)}]`;
	}
	const shortened = `Warning: truncated output (original token count: ${Math.ceil(text.length / 4)})\nTotal output lines: ${text.split("\n").length}\n\n${text.slice(0, startLength)}…${Math.ceil(omitted / 4)} tokens truncated…${endLength ? text.slice(-endLength) : ""}${location}`;
	return {
		content: [{ type: "text", text: shortened }, ...content.filter((item) => item.type === "image")],
		...(location.includes(path) ? { fullOutputPath: path } : {}),
	};
}

export async function executeCodemode(
	toolCallId: string,
	input: CodemodeToolInput,
	signal: AbortSignal | undefined,
	onUpdate: ((result: AgentToolResult<CodemodeToolDetails>) => void) | undefined,
	ctx: ExtensionToolContext,
	options: CodemodeToolOptions = {},
): Promise<AgentToolResult<CodemodeToolDetails>> {
	const { code, options: scriptOptions } = parseCodemodeSource(input.code);
	const callable = getCodemodeCallableTools(ctx.tools);
	const calls: CodemodeNestedCall[] = [];
	const publish = () => onUpdate?.({ content: [], details: { calls: calls.map((call) => ({ ...call })) } });
	const sandboxTools: CodemodeTool[] = callable.map((tool) => ({
		...toCodemodeDeclaration(tool),
		description: renderToolSample(toCodemodeDeclaration(tool)),
		execute: async (args, { signal: nestedSignal }) => {
			if (calls.length >= MAX_NESTED_CALLS) {
				throw new Error(`Codemode supports at most ${MAX_NESTED_CALLS} nested tool calls per script`);
			}
			const callNumber = calls.length + 1;
			const call: CodemodeNestedCall = {
				id: `${toolCallId}/${callNumber}`,
				name: tool.name,
				args: preview(args, 200),
				status: "running",
			};
			calls.push(call);
			publish();
			const started = performance.now();
			const outcome = await ctx.executeTool(tool.name, args, { signal: nestedSignal });
			call.durationMs = performance.now() - started;
			call.status = outcome.isError
				? outcome.status === "aborted" || nestedSignal.aborted
					? "cancelled"
					: "error"
				: "ok";
			if (outcome.isError) call.error = textContent(outcome).slice(0, 500);
			publish();
			return nestedValue(tool, outcome);
		},
	}));
	const sandbox = new CodemodeSandbox({
		tools: sandboxTools,
		globals: [...createDiscoveryGlobals(callable, options), ...(options.models ? createModelGlobals(ctx) : [])],
		memoryLimitBytes: 256 * 1024 * 1024,
	});
	let result: CodemodeResult;
	try {
		result = await sandbox.execute(code, {
			signal,
			store: readCodemodeStore(ctx.sessionManager.getBranch()),
			timeoutMs: scriptOptions.timeoutMs,
		});
	} finally {
		await sandbox.close();
	}
	for (const call of calls) if (call.status === "running") call.status = "cancelled";
	const content: AgentToolResult<unknown>["content"] = result.output.map((item) =>
		item.type === "text" ? item : { type: "image", data: item.data, mimeType: item.mimeType },
	);
	if (result.ok) {
		const writes = result.storeWrites;
		if (Object.keys(writes.set).length || writes.delete.length)
			options.appendEntry?.(CODEMODE_STORE_ENTRY_TYPE, writes);
		if (result.value !== undefined)
			content.push({
				type: "text",
				text:
					typeof result.value === "string" ? result.value : (JSON.stringify(result.value) ?? String(result.value)),
			});
	} else {
		content.push({ type: "text", text: `Script error: ${result.error.message}` });
	}
	const limited = await limitOutput(content, scriptOptions.maxOutputTokens ?? 10_000);
	return {
		content: limited.content,
		details: {
			calls: calls.map((call) => ({ ...call })),
			...(limited.fullOutputPath ? { fullOutputPath: limited.fullOutputPath } : {}),
		},
		...(result.ok ? {} : { isError: true }),
	};
}
