import { createHash, randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ImageContent, JsonValue, TextContent } from "@earendil-works/pi-ai";
import {
	type CallToolResult,
	type ContentBlock,
	type McpRequestOptions,
	type Tool as McpTool,
	toLlmContent,
} from "@earendil-works/pi-mcp";
import type { TSchema } from "typebox";
import type { ToolAnnotations, ToolDefinition } from "../../core/extensions/types.ts";
import type { McpExposure } from "./config.ts";

export const READ_MCP_RESOURCE_TOOL = "read_mcp_resource";
export const MCP_OUTPUT_MAX_BYTES = 20 * 1024;
export interface McpToolDetails {
	server: string;
	tool: string;
	fullOutputPath?: string;
}
export type McpOutputSaver = (data: string | Uint8Array, extension: string) => Promise<string>;
export async function saveToTempFile(data: string | Uint8Array, extension: string): Promise<string> {
	const path = join(tmpdir(), `pi-mcp-${randomBytes(8).toString("hex")}${extension}`);
	await writeFile(path, data, { mode: 0o600 });
	return path;
}
export interface McpToolCaller {
	callTool(name: string, args: Record<string, unknown>, options: McpRequestOptions): Promise<CallToolResult>;
}
export function toToolExposure(exposure: McpExposure): "direct" | "deferred" | "hidden" | "codemode" {
	return exposure;
}
export function createMcpToolName(
	server: string,
	tool: string,
	isTaken: (name: string) => boolean = () => false,
): string {
	const clean = `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_]/g, "_");
	if (clean.length <= 64 && !isTaken(clean)) return clean;
	const suffix = createHash("sha256").update(`${server}\0${tool}`).digest("hex").slice(0, 8);
	return `${clean.slice(0, 55)}_${suffix}`;
}
function textOf(content: readonly (TextContent | ImageContent)[]): string {
	return content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}
function truncate(text: string, max: number): { content: string; truncated: boolean; bytes: number; lines: number } {
	const bytes = Buffer.byteLength(text);
	if (bytes <= max) return { content: text, truncated: false, bytes, lines: text.split("\n").length };
	const buffer = Buffer.from(text);
	const kept = Math.floor(max / 2);
	return {
		content: `${buffer.subarray(0, kept).toString("utf8")}\n…[middle omitted]…\n${buffer.subarray(buffer.length - kept).toString("utf8")}`,
		truncated: true,
		bytes,
		lines: text.split("\n").length,
	};
}
export async function limitMcpContent(
	content: (TextContent | ImageContent)[],
	saveOutput: McpOutputSaver = saveToTempFile,
): Promise<{ content: (TextContent | ImageContent)[]; fullOutputPath?: string }> {
	const combined = textOf(content);
	const result = truncate(combined, MCP_OUTPUT_MAX_BYTES);
	if (!result.truncated) return { content };
	let fullOutputPath: string | undefined;
	try {
		fullOutputPath = await saveOutput(combined, ".txt");
	} catch {
		/* Result remains useful without the optional archive file. */
	}
	const note = fullOutputPath ? `Full output saved at ${fullOutputPath}.` : "Full output could not be saved.";
	const prefix: TextContent = {
		type: "text",
		text: `Warning: truncated output (${result.bytes} bytes, ${result.lines} lines). ${note}\n\n${result.content}`,
	};
	return {
		content: [prefix, ...content.filter((block) => block.type === "image")],
		...(fullOutputPath ? { fullOutputPath } : {}),
	};
}
function isTextMimeType(value: string | undefined): boolean {
	if (!value) return false;
	const mime = value.split(";", 1)[0].trim().toLowerCase();
	return mime.startsWith("text/") || mime === "application/json" || mime.endsWith("+json") || mime.endsWith("+xml");
}
async function blockToContent(
	server: string,
	block: ContentBlock,
	saveOutput: McpOutputSaver,
): Promise<(TextContent | ImageContent)[]> {
	if (block.type === "resource_link")
		return [
			{
				type: "text",
				text: `[Resource ${block.uri} "${block.title ?? block.name}"; read with ${READ_MCP_RESOURCE_TOOL} (server "${server}")]`,
			},
		];
	if (block.type === "resource" && "blob" in block.resource && !block.resource.mimeType?.startsWith("image/")) {
		const bytes = Buffer.from(block.resource.blob, "base64");
		if (isTextMimeType(block.resource.mimeType)) return [{ type: "text", text: bytes.toString("utf8") }];
		const ext = /\.[A-Za-z0-9]{1,8}$/.exec(new URL(block.resource.uri).pathname)?.[0] ?? ".bin";
		try {
			return [
				{ type: "text", text: `[Binary resource ${block.resource.uri} saved to ${await saveOutput(bytes, ext)}]` },
			];
		} catch (error) {
			return [
				{
					type: "text",
					text: `[Binary resource ${block.resource.uri} could not be saved: ${error instanceof Error ? error.message : String(error)}]`,
				},
			];
		}
	}
	return toLlmContent({ content: [block] });
}
export async function toModelContent(
	server: string,
	blocks: readonly ContentBlock[],
	saveOutput: McpOutputSaver = saveToTempFile,
): Promise<(TextContent | ImageContent)[]> {
	return (await Promise.all(blocks.map((block) => blockToContent(server, block, saveOutput)))).flat();
}
export async function convertMcpResult(
	server: string,
	tool: string,
	result: CallToolResult,
	saveOutput?: McpOutputSaver,
): Promise<AgentToolResult<McpToolDetails>> {
	const converted = result.content.length
		? await toModelContent(server, result.content, saveOutput)
		: toLlmContent(result);
	if (result.isError && !textOf(converted))
		converted.push({ type: "text", text: `MCP tool ${server}/${tool} returned an error` });
	const limited = await limitMcpContent(converted, saveOutput);
	const { _meta: ignored, ...structured } = result;
	void ignored;
	return {
		content: limited.content,
		details: { server, tool, ...(limited.fullOutputPath ? { fullOutputPath: limited.fullOutputPath } : {}) },
		structuredContent: structured as unknown as JsonValue,
		...(result.isError ? { isError: true } : {}),
	} as AgentToolResult<McpToolDetails>;
}
function annotationsOf(tool: McpTool): ToolAnnotations | undefined {
	const values = tool.annotations;
	if (!values) return;
	const annotations: ToolAnnotations = {};
	for (const key of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) {
		if (typeof values[key] === "boolean") annotations[key] = values[key];
	}
	return Object.keys(annotations).length ? annotations : undefined;
}
export function createMcpToolDefinition(options: {
	server: string;
	tool: McpTool;
	name: string;
	exposure: McpExposure;
	timeoutMs: number;
	getClient: () => Promise<McpToolCaller>;
}): ToolDefinition<TSchema, McpToolDetails> {
	const { server, tool } = options;
	const inputSchema = {
		...tool.inputSchema,
		type: tool.inputSchema.type ?? "object",
		properties: tool.inputSchema.properties ?? {},
	} as unknown as TSchema;
	return {
		name: options.name,
		label: `${server}/${tool.name}`,
		description: tool.description?.trim() || tool.title || `MCP tool ${tool.name} from server ${server}`,
		parameters: inputSchema,
		outputSchema: {
			type: "object",
			properties: {
				content: { type: "array" },
				structuredContent: tool.outputSchema ?? { type: "object" },
				isError: { type: "boolean" },
			},
		} as unknown as TSchema,
		exposure: toToolExposure(options.exposure),
		namespace: { name: `mcp__${server.replace(/-/g, "_")}`, description: `${server} MCP server` },
		...(annotationsOf(tool) ? { annotations: annotationsOf(tool) } : {}),
		async execute(_id, params, signal) {
			const result = await (await options.getClient()).callTool(tool.name, params as Record<string, unknown>, {
				signal,
				timeoutMs: options.timeoutMs,
			});
			return convertMcpResult(server, tool.name, result);
		},
	};
}
