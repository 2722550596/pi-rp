import type { ImageContent, JsonValue, TextContent } from "@earendil-works/pi-ai";
import type {
	ContentBlock,
	ListResourcesResult,
	ListResourceTemplatesResult,
	McpRequestOptions,
	ReadResourceResult,
	Resource,
	ResourceTemplate,
} from "@earendil-works/pi-mcp";
import type { TSchema } from "typebox";
import type { ToolAnnotations, ToolDefinition } from "../../core/extensions/types.ts";
import type { McpExposure } from "./config.ts";
import {
	limitMcpContent,
	type McpToolDetails,
	READ_MCP_RESOURCE_TOOL,
	toModelContent,
	toToolExposure,
} from "./tools.ts";
export const LIST_MCP_RESOURCES_TOOL = "list_mcp_resources";
export const LIST_MCP_RESOURCE_TEMPLATES_TOOL = "list_mcp_resource_templates";
export { READ_MCP_RESOURCE_TOOL };
export interface McpResourceServer {
	name: string;
	timeoutMs: number;
	resourcesPage(cursor: string | undefined, options: McpRequestOptions): Promise<ListResourcesResult>;
	resourceTemplatesPage(cursor: string | undefined, options: McpRequestOptions): Promise<ListResourceTemplatesResult>;
	allResources(options: McpRequestOptions): Promise<Resource[]>;
	allResourceTemplates(options: McpRequestOptions): Promise<ResourceTemplate[]>;
	readResource(uri: string, options: McpRequestOptions): Promise<ReadResourceResult>;
}
export function isMcpAppResource(item: { uri?: string; uriTemplate?: string; mimeType?: string }): boolean {
	const uri = item.uri ?? item.uriTemplate ?? "";
	return uri.startsWith("ui://") || /;\s*profile\s*=\s*"?mcp-app"?/i.test(item.mimeType ?? "");
}
function itemWithServer<T extends { _meta?: unknown; icons?: unknown }>(
	server: string,
	item: T,
): Record<string, unknown> {
	const { _meta, icons, ...rest } = item;
	void _meta;
	void icons;
	return { server, ...rest };
}
function stringValue(params: unknown, key: string): string | undefined {
	const value = (params as Record<string, unknown> | undefined)?.[key];
	if (value == null) return;
	if (typeof value !== "string") throw new Error(`${key} must be a string`);
	return value.trim() || undefined;
}
const schema = (properties: Record<string, unknown>, required: string[] = []) =>
	({ type: "object", properties, required, additionalProperties: false }) as unknown as TSchema;
const serverProperty = { type: "string", description: "MCP server name" };
const cursorProperty = { type: "string", description: "Opaque cursor for the next page" };
const readOnly: ToolAnnotations = { readOnlyHint: true };
function result(
	tool: string,
	server: string | undefined,
	payload: Record<string, unknown>,
	content: (TextContent | ImageContent)[] = [{ type: "text", text: JSON.stringify(payload) }],
) {
	return limitMcpContent(content).then(({ content: limited, fullOutputPath }) => ({
		content: limited,
		details: { server: server ?? "", tool, ...(fullOutputPath ? { fullOutputPath } : {}) },
		structuredContent: payload as unknown as JsonValue,
	}));
}
export function createMcpResourceToolDefinitions(options: {
	exposure: McpExposure;
	servers: () => readonly McpResourceServer[];
}): ToolDefinition<TSchema, McpToolDetails>[] {
	const findServer = (name: string) => {
		const server = options.servers().find((item) => item.name === name);
		if (!server) throw new Error(`MCP server "${name}" has no connected resources`);
		return server;
	};
	const paginate = async <
		T extends { uri?: string; uriTemplate?: string; mimeType?: string; _meta?: unknown; icons?: unknown },
	>(
		params: unknown,
		signal: AbortSignal | undefined,
		key: string,
		one: (
			server: McpResourceServer,
			cursor: string | undefined,
			options: McpRequestOptions,
		) => Promise<{ items: T[]; nextCursor?: string }>,
		all: (server: McpResourceServer, options: McpRequestOptions) => Promise<T[]>,
	) => {
		const name = stringValue(params, "server");
		const cursor = stringValue(params, "cursor");
		const visible = (item: T) => !isMcpAppResource(item);
		if (name) {
			const server = findServer(name);
			const page = await one(server, cursor, { signal, timeoutMs: server.timeoutMs });
			return {
				server: name,
				[key]: page.items.filter(visible).map((item) => itemWithServer(name, item)),
				...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
			};
		}
		if (cursor) throw new Error("cursor can only be used when a server is specified");
		const servers = [...options.servers()].sort((a, b) => a.name.localeCompare(b.name));
		const results = await Promise.allSettled(
			servers.map((server) => all(server, { signal, timeoutMs: server.timeoutMs })),
		);
		const items: Record<string, unknown>[] = [];
		const errors: { server: string; error: string }[] = [];
		for (let index = 0; index < results.length; index++) {
			const response = results[index];
			const server = servers[index];
			if (response.status === "fulfilled")
				items.push(...response.value.filter(visible).map((item) => itemWithServer(server.name, item)));
			else
				errors.push({
					server: server.name,
					error: response.reason instanceof Error ? response.reason.message : String(response.reason),
				});
		}
		return { [key]: items, ...(errors.length ? { errors } : {}) };
	};
	const tool = (
		name: string,
		description: string,
		properties: Record<string, unknown>,
		required: string[],
		execute: (params: unknown, signal?: AbortSignal) => Promise<Record<string, unknown>>,
	): ToolDefinition<TSchema, McpToolDetails> => ({
		name,
		label: name,
		description,
		parameters: schema(properties, required),
		outputSchema: { type: "object" } as TSchema,
		exposure: toToolExposure(options.exposure),
		annotations: readOnly,
		async execute(_id, params, signal) {
			const payload = await execute(params, signal);
			return result(name, stringValue(params, "server"), payload);
		},
	});
	return [
		tool(
			LIST_MCP_RESOURCES_TOOL,
			"Lists resources provided by connected MCP servers.",
			{ server: serverProperty, cursor: cursorProperty },
			[],
			(params, signal) =>
				paginate(
					params,
					signal,
					"resources",
					async (server, cursor, requestOptions) => {
						const page = await server.resourcesPage(cursor, requestOptions);
						return { items: page.resources, nextCursor: page.nextCursor };
					},
					(server, requestOptions) => server.allResources(requestOptions),
				),
		),
		tool(
			LIST_MCP_RESOURCE_TEMPLATES_TOOL,
			"Lists resource templates provided by connected MCP servers.",
			{ server: serverProperty, cursor: cursorProperty },
			[],
			(params, signal) =>
				paginate(
					params,
					signal,
					"resourceTemplates",
					async (server, cursor, requestOptions) => {
						const page = await server.resourceTemplatesPage(cursor, requestOptions);
						return { items: page.resourceTemplates, nextCursor: page.nextCursor };
					},
					(server, requestOptions) => server.allResourceTemplates(requestOptions),
				),
		),
		{
			name: READ_MCP_RESOURCE_TOOL,
			label: READ_MCP_RESOURCE_TOOL,
			description: "Read a specific resource from an MCP server given the server name and resource URI.",
			parameters: schema({ server: serverProperty, uri: { type: "string" } }, ["server", "uri"]),
			outputSchema: { type: "object" } as TSchema,
			exposure: toToolExposure(options.exposure),
			annotations: readOnly,
			async execute(_toolCallId, params, signal) {
				const serverName = stringValue(params, "server");
				const uri = stringValue(params, "uri");
				if (!serverName || !uri) throw new Error("server and uri are required");
				const server = findServer(serverName);
				const response = await server.readResource(uri, { signal, timeoutMs: server.timeoutMs });
				const blocks: ContentBlock[] = response.contents.flatMap((item) => [
					...(response.contents.length > 1 ? [{ type: "text" as const, text: `${item.uri}:` }] : []),
					{ type: "resource" as const, resource: item },
				]);
				const converted = await toModelContent(server.name, blocks);
				const limited = await limitMcpContent(
					converted.length ? converted : [{ type: "text", text: `Resource ${uri} is empty.` }],
				);
				const contents = response.contents.map(({ _meta: ignored, ...content }) => {
					void ignored;
					return content;
				});
				return {
					content: limited.content,
					details: {
						server: server.name,
						tool: READ_MCP_RESOURCE_TOOL,
						...(limited.fullOutputPath ? { fullOutputPath: limited.fullOutputPath } : {}),
					},
					structuredContent: { server: server.name, uri, contents } as unknown as JsonValue,
				};
			},
		},
	];
}
