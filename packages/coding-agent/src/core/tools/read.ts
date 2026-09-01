import { basename, dirname, isAbsolute, relative, resolve as resolvePath, sep } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model, TextContent } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { constants } from "fs";
import { access as fsAccess, readdir as fsReaddir, readFile as fsReadFile, stat as fsStat } from "fs/promises";
import { type Static, Type } from "typebox";
import { getReadmePath } from "../../config.ts";
import { keyHint, keyText } from "../../modes/interactive/components/keybinding-hints.ts";
import { getLanguageFromPath, highlightCode, type Theme } from "../../modes/interactive/theme/theme.ts";
import { processImage } from "../../utils/image-process.ts";
import { detectSupportedImageMimeTypeFromFile } from "../../utils/mime.ts";
import { formatPathRelativeToCwdOrAbsolute } from "../../utils/paths.ts";
import { getExperimentalToolSampling } from "../experimental.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { resolveReadPathAsync, resolveToCwd } from "./path-utils.ts";
import { getTextOutput, renderToolPath, replaceTabs, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateHead } from "./truncate.ts";

const readSchema = Type.Object({
	// Array branch MUST come first: Vertex/Gemini function-declaration validation rejects
	// `anyOf: [string, array]` with "For schema with items, schema type should be ARRAY"
	// (its schema merger conflates the scalar branch with the array branch's `items`).
	// Order is semantically irrelevant to JSON Schema, but array-first passes everywhere.
	path: Type.Union([
		Type.Array(
			Type.String({
				description: "Path to a file or directory to read (relative or absolute). Directories are returned as their entry listing.",
			}),
			{ description: "Read multiple paths in one call. Each path is read independently with its own truncation." },
		),
		Type.String({
			description:
				"Path to a file or directory to read (relative or absolute). Directories are returned as their entry listing.",
		}),
	]),
	offset: Type.Optional(
		Type.Number({
			description: "Line number to start reading from (1-indexed). For directories, the entry index to start from.",
		}),
	),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines (or directory entries) to read" })),
});

export const readToolSystemPromptContribution = {
	snippet: "Read file contents (single file, multiple files, or directory listing)",
	guidelines: ["Use read to examine files instead of cat or sed."],
} as const;

export type ReadToolInput = Static<typeof readSchema>;

export interface ReadToolDetails {
	truncation?: TruncationResult;
}

interface CompactReadClassification {
	kind: "docs" | "resource" | "skill";
	label: string;
}

const COMPACT_RESOURCE_FILE_NAMES = new Set(["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]);

/** Default cap on directory entries returned by a single read (matches the ls tool). */
const DEFAULT_DIRECTORY_ENTRY_LIMIT = 500;

export interface ReadDirectoryEntry {
	name: string;
	isDirectory: boolean;
}

/**
 * Pluggable operations for the read tool.
 * Override these to delegate file reading to remote systems (for example SSH).
 */
export interface ReadOperations {
	/** Read file contents as a Buffer */
	readFile: (absolutePath: string) => Promise<Buffer>;
	/** Check if file is readable (throw if not) */
	access: (absolutePath: string) => Promise<void>;
	/** Detect image MIME type, return null or undefined for non-images */
	detectImageMimeType?: (absolutePath: string) => Promise<string | null | undefined>;
	/**
	 * Stat a path to distinguish files from directories.
	 * Optional: custom operations may omit it, in which case directories are
	 * only recognized through the EISDIR error from readFile.
	 */
	stat?: (absolutePath: string) => Promise<{ isDirectory: () => boolean }>;
	/**
	 * List directory entries.
	 * Optional: custom operations that omit it cannot list directories and
	 * reading one fails with a clear error.
	 */
	listDirectory?: (absolutePath: string) => Promise<ReadDirectoryEntry[]>;
}

const defaultReadOperations: ReadOperations = {
	readFile: (path) => fsReadFile(path),
	access: (path) => fsAccess(path, constants.R_OK),
	detectImageMimeType: detectSupportedImageMimeTypeFromFile,
	stat: fsStat,
	listDirectory: async (absolutePath) => {
		const entries = await fsReaddir(absolutePath, { withFileTypes: true });
		return entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }));
	},
};

export interface ReadToolOptions {
	/** Whether to auto-resize images to 2000x2000 max. Default: true */
	autoResizeImages?: boolean;
	/** Custom operations for file reading. Default: local filesystem */
	operations?: ReadOperations;
}

type ReadRenderArgs = { path?: string | string[]; file_path?: string | string[]; offset?: number; limit?: number };

function formatReadLineRange(args: ReadRenderArgs | undefined, theme: Theme): string {
	if (args?.offset === undefined && args?.limit === undefined) return "";
	const startLine = args.offset ?? 1;
	const endLine = args.limit !== undefined ? startLine + args.limit - 1 : "";
	return theme.fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
}

function formatReadCall(args: ReadRenderArgs | undefined, theme: Theme, cwd: string): string {
	const rawPath = args?.file_path ?? args?.path;
	const pathDisplay = Array.isArray(rawPath)
		? rawPath.map((p) => renderToolPath(str(p), theme, cwd)).join(", ")
		: renderToolPath(str(rawPath), theme, cwd);
	return `${theme.fg("toolTitle", theme.bold("read"))} ${pathDisplay}${formatReadLineRange(args, theme)}`;
}

function trimTrailingEmptyLines(lines: string[]): string[] {
	let end = lines.length;
	while (end > 0 && lines[end - 1] === "") {
		end--;
	}
	return lines.slice(0, end);
}

function getNonVisionImageNote(model: Model<Api> | undefined): string | undefined {
	if (!model || model.input.includes("image")) {
		return undefined;
	}
	return "[Current model does not support images. The image will be omitted from this request.]";
}

function toPosixPath(filePath: string): string {
	return filePath.split(sep).join("/");
}

function getPiDocsClassification(absolutePath: string): CompactReadClassification | undefined {
	const packageRoot = dirname(getReadmePath());
	const relativePath = relative(resolvePath(packageRoot), resolvePath(absolutePath));
	if (
		relativePath === "" ||
		relativePath === ".." ||
		relativePath.startsWith(`..${sep}`) ||
		isAbsolute(relativePath)
	) {
		return undefined;
	}

	const label = toPosixPath(relativePath);
	if (label === "README.md" || label.startsWith("docs/") || label.startsWith("examples/")) {
		return { kind: "docs", label };
	}
	return undefined;
}

function getCompactReadClassification(
	args: ReadRenderArgs | undefined,
	cwd: string,
): CompactReadClassification | undefined {
	// Compact classification only applies to a single file path, never to
	// arrays (multiple paths) or directory listings.
	const rawPathValue = args?.file_path ?? args?.path;
	if (typeof rawPathValue !== "string" || !rawPathValue) return undefined;
	const rawPath = rawPathValue;

	const absolutePath = resolveToCwd(rawPath, cwd);
	const fileName = basename(absolutePath);
	if (fileName === "SKILL.md") {
		return { kind: "skill", label: basename(dirname(absolutePath)) || fileName };
	}

	const docsClassification = getPiDocsClassification(absolutePath);
	if (docsClassification) return docsClassification;

	if (COMPACT_RESOURCE_FILE_NAMES.has(fileName)) {
		return { kind: "resource", label: formatPathRelativeToCwdOrAbsolute(absolutePath, cwd) };
	}

	return undefined;
}

function formatCompactReadCall(
	classification: CompactReadClassification,
	args: ReadRenderArgs | undefined,
	theme: Theme,
): string {
	const expandHint = theme.fg("dim", ` (${keyText("app.tools.expand")} to expand)`);
	if (classification.kind === "skill") {
		return (
			theme.fg("customMessageLabel", `\x1b[1m[skill]\x1b[22m `) +
			theme.fg("customMessageText", classification.label) +
			formatReadLineRange(args, theme) +
			expandHint
		);
	}

	return (
		theme.fg("toolTitle", theme.bold(`read ${classification.kind}`)) +
		" " +
		theme.fg("accent", classification.label) +
		formatReadLineRange(args, theme) +
		expandHint
	);
}

function formatReadResult(
	args: ReadRenderArgs | undefined,
	result: { content: (TextContent | ImageContent)[]; details?: ReadToolDetails },
	options: ToolRenderResultOptions,
	theme: Theme,
	showImages: boolean,
	_cwd: string,
	isError: boolean,
): string {
	if (!options.expanded && !isError) {
		return "";
	}

	// Syntax highlighting only applies to a single text file; multi-path
	// results mix languages and cannot be highlighted as a whole.
	const rawPathValue = args?.file_path ?? args?.path;
	const rawPath = typeof rawPathValue === "string" ? rawPathValue : null;
	const output = getTextOutput(result, showImages);
	const lang = !isError && rawPath ? getLanguageFromPath(rawPath) : undefined;
	const renderedLines = lang ? highlightCode(replaceTabs(output), lang) : output.split("\n");
	const lines = trimTrailingEmptyLines(renderedLines);
	const maxLines = options.expanded ? lines.length : 10;
	const displayLines = lines.slice(0, maxLines);
	const remaining = lines.length - maxLines;
	let text = `\n${displayLines.map((line) => (lang ? replaceTabs(line) : theme.fg("toolOutput", replaceTabs(line)))).join("\n")}`;
	if (remaining > 0) {
		text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
	}

	const truncation = result.details?.truncation;
	if (truncation?.truncated) {
		if (truncation.firstLineExceedsLimit) {
			text += `\n${theme.fg("warning", `[First line exceeds ${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit]`)}`;
		} else if (truncation.truncatedBy === "lines") {
			text += `\n${theme.fg("warning", `[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${truncation.maxLines ?? DEFAULT_MAX_LINES} line limit)]`)}`;
		} else {
			text += `\n${theme.fg("warning", `[Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)]`)}`;
		}
	}
	return text;
}

function formatReadFailure(rawPath: string, error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return `[Error reading ${rawPath}: ${message}]`;
}

/** Read a single file (text or image) and build its content blocks. */
async function readFileBlock(
	ops: ReadOperations,
	absolutePath: string,
	rawPath: string,
	offset: number | undefined,
	limit: number | undefined,
	nonVisionImageNote: string | undefined,
	autoResizeImages: boolean,
): Promise<{ content: (TextContent | ImageContent)[]; truncation?: TruncationResult }> {
	// Check if file exists and is readable.
	await ops.access(absolutePath);
	const mimeType = ops.detectImageMimeType ? await ops.detectImageMimeType(absolutePath) : undefined;
	if (mimeType) {
		// Read image as binary.
		const buffer = await ops.readFile(absolutePath);
		const processed = await processImage(buffer, mimeType, { autoResizeImages });
		if (!processed.ok) {
			let textNote = `Read image file [${mimeType}]\n${processed.message}`;
			if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
			return { content: [{ type: "text", text: textNote }] };
		}
		let textNote = `Read image file [${processed.mimeType}]`;
		if (processed.hints.length > 0) textNote += `\n${processed.hints.join("\n")}`;
		if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
		return {
			content: [
				{ type: "text", text: textNote },
				{ type: "image", data: processed.data, mimeType: processed.mimeType },
			],
		};
	}

	// Read text content.
	const buffer = await ops.readFile(absolutePath);
	const textContent = buffer.toString("utf-8");
	const allLines = textContent.split("\n");
	const totalFileLines = allLines.length;
	// Apply offset if specified. Convert from 1-indexed input to 0-indexed array access.
	const startLine = offset ? Math.max(0, offset - 1) : 0;
	const startLineDisplay = startLine + 1;
	// Check if offset is out of bounds.
	if (startLine >= allLines.length) {
		throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
	}
	let selectedContent: string;
	let userLimitedLines: number | undefined;
	// If limit is specified by the user, honor it first. Otherwise truncateHead decides.
	if (limit !== undefined) {
		const endLine = Math.min(startLine + limit, allLines.length);
		selectedContent = allLines.slice(startLine, endLine).join("\n");
		userLimitedLines = endLine - startLine;
	} else {
		selectedContent = allLines.slice(startLine).join("\n");
	}
	// Apply truncation, respecting both line and byte limits.
	const truncation = truncateHead(selectedContent);
	let outputText: string;
	if (truncation.firstLineExceedsLimit) {
		// First line alone exceeds the byte limit. Point the model at a bash fallback.
		const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine], "utf-8"));
		outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${rawPath} | head -c ${DEFAULT_MAX_BYTES}]`;
	} else if (truncation.truncated) {
		// Truncation occurred. Build an actionable continuation notice.
		const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
		const nextOffset = endLineDisplay + 1;
		outputText = truncation.content;
		if (truncation.truncatedBy === "lines") {
			outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
		} else {
			outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
		}
	} else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
		// User-specified limit stopped early, but the file still has more content.
		const remaining = allLines.length - (startLine + userLimitedLines);
		const nextOffset = startLine + userLimitedLines + 1;
		outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
	} else {
		// No truncation and no remaining user-limited content.
		outputText = truncation.content;
	}
	return { content: [{ type: "text", text: outputText }], truncation: truncation.truncated ? truncation : undefined };
}

/** Read a directory and format its entry listing. */
async function readDirectoryBlock(
	ops: ReadOperations,
	absolutePath: string,
	offset: number | undefined,
	limit: number | undefined,
): Promise<string> {
	if (!ops.listDirectory) {
		throw new Error("Directory listing is not supported by the current operations");
	}
	let entries: ReadDirectoryEntry[];
	try {
		entries = await ops.listDirectory(absolutePath);
	} catch (error: any) {
		throw new Error(`Cannot read directory: ${error instanceof Error ? error.message : String(error)}`);
	}

	// Sort alphabetically, case-insensitive (matches the ls tool).
	entries.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

	// Apply offset if specified. Convert from 1-indexed input to 0-indexed array access.
	const startIndex = offset ? Math.max(0, offset - 1) : 0;
	if (offset !== undefined && startIndex >= entries.length) {
		throw new Error(`Offset ${offset} is beyond end of directory (${entries.length} entries total)`);
	}

	const entryLimit = limit ?? DEFAULT_DIRECTORY_ENTRY_LIMIT;
	const selected = entries.slice(startIndex, startIndex + entryLimit);
	const entryLimitReached = startIndex + selected.length < entries.length;

	const lines = selected.map((entry) => entry.name + (entry.isDirectory ? "/" : ""));
	let output = lines.length > 0 ? lines.join("\n") : "(empty directory)";

	// Apply byte truncation. There is no separate line limit because entry count is already capped.
	const truncation = truncateHead(output, { maxLines: Number.MAX_SAFE_INTEGER });
	output = truncation.content;

	const notices: string[] = [];
	if (entryLimitReached) {
		notices.push(`${entryLimit} entries limit reached. Use limit=${entryLimit * 2} for more`);
	}
	if (truncation.truncated) {
		notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
	}

	const header = `Directory listing of ${absolutePath} (${entries.length} entries):`;
	return notices.length > 0 ? `${header}\n${output}\n\n[${notices.join(". ")}]` : `${header}\n${output}`;
}

export function createReadToolDefinition(
	cwd: string,
	options?: ReadToolOptions,
): ToolDefinition<typeof readSchema, ReadToolDetails | undefined> {
	const autoResizeImages = options?.autoResizeImages ?? true;
	const ops = options?.operations ?? defaultReadOperations;
	return {
		name: "read",
		label: "read",
		description: `Read the contents of one or more files. Pass a single path or an array of paths. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. Directories are returned as their entry listing. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB per file (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
		promptSnippet: readToolSystemPromptContribution.snippet,
		promptGuidelines: [...readToolSystemPromptContribution.guidelines],
		parameters: readSchema,
		constrainedSampling: getExperimentalToolSampling(),
		async execute(
			_toolCallId,
			{ path, offset, limit }: { path: string | string[]; offset?: number; limit?: number },
			signal?: AbortSignal,
			_onUpdate?,
			ctx?,
		) {
			return new Promise<{ content: (TextContent | ImageContent)[]; details: ReadToolDetails | undefined }>(
				(resolve, reject) => {
					if (signal?.aborted) {
						reject(new Error("Operation aborted"));
						return;
					}
					let aborted = false;
					const onAbort = () => {
						aborted = true;
						reject(new Error("Operation aborted"));
					};
					signal?.addEventListener("abort", onAbort, { once: true });

					(async () => {
						try {
							// Normalize input: accept a single path or an array, deduplicate, reject empties.
							const rawPaths = Array.isArray(path) ? path : [path];
							if (rawPaths.length === 0) {
								throw new Error("No paths specified. Pass at least one file or directory path to read.");
							}
							const paths: string[] = [];
							for (const rawPath of rawPaths) {
								if (rawPath.trim() === "") {
									throw new Error(`Invalid empty path in read paths: ${JSON.stringify(rawPath)}`);
								}
								if (!paths.includes(rawPath)) {
									paths.push(rawPath);
								}
							}
							const multi = paths.length > 1;

							const content: (TextContent | ImageContent)[] = [];
							const failures: { rawPath: string; error: unknown }[] = [];
							const nonVisionImageNote = getNonVisionImageNote(ctx?.model);
							let singleFileTruncation: TruncationResult | undefined;

							for (const rawPath of paths) {
								if (aborted) return;
								try {
									const absolutePath = await resolveReadPathAsync(rawPath, cwd);
									if (aborted) return;
									// Distinguish files from directories so directories can be listed.
									let isDirectory = false;
									if (ops.stat) {
										const stat = await ops.stat(absolutePath);
										isDirectory = stat.isDirectory();
									}
									if (aborted) return;

									if (isDirectory) {
										const block = await readDirectoryBlock(ops, absolutePath, offset, limit);
										if (multi) {
											content.push({ type: "text", text: `=== ${rawPath} ===` });
										}
										content.push({ type: "text", text: block });
									} else {
										const block = await readFileBlock(
											ops,
											absolutePath,
											rawPath,
											offset,
											limit,
											nonVisionImageNote,
											autoResizeImages,
										);
										if (!multi && block.truncation) {
											singleFileTruncation = block.truncation;
										}
										if (multi) {
											content.push({ type: "text", text: `=== ${rawPath} ===` });
										}
										content.push(...block.content);
									}
								} catch (error: any) {
									if (aborted) return;
									failures.push({ rawPath, error });
								}
							}

							if (aborted) return;
							signal?.removeEventListener("abort", onAbort);

							if (failures.length > 0) {
								if (content.length === 0) {
									// Nothing succeeded. Preserve the original error for a single path.
									if (paths.length === 1) {
										reject(failures[0].error);
									} else {
										reject(new Error(failures.map((f) => formatReadFailure(f.rawPath, f.error)).join("\n")));
									}
									return;
								}
								// Partial failure: report each failed path inline and keep the successful reads.
								for (const failure of failures) {
									content.push({ type: "text", text: formatReadFailure(failure.rawPath, failure.error) });
								}
							}

							// Truncation details are only carried for the single-file case to
							// preserve the established contract; multi-path and directory reads
							// embed their truncation notices in the text output itself.
							const details: ReadToolDetails | undefined = singleFileTruncation
								? { truncation: singleFileTruncation }
								: undefined;
							resolve({ content, details });
						} catch (error: any) {
							signal?.removeEventListener("abort", onAbort);
							if (!aborted) reject(error);
						}
					})();
				},
			);
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const classification = !context.expanded ? getCompactReadClassification(args, context.cwd) : undefined;
			text.setText(
				classification
					? formatCompactReadCall(classification, args, theme)
					: formatReadCall(args, theme, context.cwd),
			);
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(
				formatReadResult(context.args, result, options, theme, context.showImages, context.cwd, context.isError),
			);
			return text;
		},
	};
}

export function createReadTool(cwd: string, options?: ReadToolOptions): AgentTool<typeof readSchema> {
	return wrapToolDefinition(createReadToolDefinition(cwd, options));
}
