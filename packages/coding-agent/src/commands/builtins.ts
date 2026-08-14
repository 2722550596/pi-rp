/**
 * Builtin slash-command bodies.
 *
 * Command bodies live outside any mode: they only use ctx.session (the real
 * AgentSession, shared by TUI and RPC) and ctx.view (a narrow CommandView
 * implemented by InteractiveMode and by the RPC responder). No TUI imports —
 * the same bodies work headless.
 */

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fuzzyFilter } from "@earendil-works/pi-tui";
import { getShareViewerUrl } from "../config.ts";
import type { AgentSession } from "../core/agent-session.ts";
import { computeCacheWaste } from "../core/cache-stats.ts";
import { convertToLlm } from "../core/messages.ts";
import type { CommandEntry } from "../core/slash-commands.ts";
import { registerBuiltinCommand as registerBuiltin } from "../core/slash-commands.ts";
import { isPrepareError, prepareSubagentConversation, runSubagent } from "../core/subagent/index.ts";
import { getModelSearchText } from "../modes/interactive/model-search.ts";
import { getChangelogPath, normalizeChangelogLinks, parseChangelog } from "../utils/changelog.ts";
import { copyToClipboard } from "../utils/clipboard.ts";
import { formatTokens } from "../utils/format.ts";

/** Extract a path-style argument: a quoted string (spaces allowed) or the first token. */
export function getPathArg(args: string[]): string | undefined {
	if (args.length === 0) return undefined;
	const first = args[0]!;
	if (first.startsWith('"') || first.startsWith("'")) {
		const quote = first[0]!;
		const joined = args.join(" ");
		const closing = joined.indexOf(quote, 1);
		return closing === -1 ? joined.slice(1) : joined.slice(1, closing);
	}
	return first;
}

function startsWith(prefix: string, value: string): boolean {
	return value.toLowerCase().startsWith(prefix.toLowerCase());
}

/** Display label for a login auth type ("subscription" for OAuth, "API key" otherwise). */
function formatAuthType(authType: "oauth" | "api_key"): string {
	return authType === "oauth" ? "subscription" : "API key";
}

// ============================================================================
// Pure session+view bodies
// ============================================================================

const exportCommand: CommandEntry = {
	execute: async (ctx) => {
		const outputPath = getPathArg(ctx.args);
		try {
			if (outputPath?.endsWith(".jsonl")) {
				const filePath = ctx.session.exportToJsonl(outputPath);
				ctx.view.showStatus(`Session exported to: ${filePath}`);
			} else {
				const filePath = await ctx.session.exportToHtml(outputPath);
				ctx.view.showStatus(`Session exported to: ${filePath}`);
			}
		} catch (error) {
			ctx.view.showStatus(
				`Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`,
				"error",
			);
		}
	},
	usage: "/export [path (.html|.jsonl)]",
};

const shareCommand: CommandEntry = {
	execute: async (ctx) => {
		try {
			const authResult = spawnSync("gh", ["auth", "status"], { encoding: "utf-8" });
			if (authResult.status !== 0) {
				ctx.view.showStatus("GitHub CLI is not logged in. Run 'gh auth login' first.", "error");
				return;
			}
		} catch {
			ctx.view.showStatus("GitHub CLI (gh) is not installed. Install it from https://cli.github.com/", "error");
			return;
		}

		const tmpFile = path.join(os.tmpdir(), "session.html");
		try {
			await ctx.session.exportToHtml(tmpFile);
		} catch (error) {
			ctx.view.showStatus(
				`Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`,
				"error",
			);
			return;
		}

		try {
			const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
				const proc = spawn("gh", ["gist", "create", "--public=false", tmpFile]);
				let stdout = "";
				let stderr = "";
				proc.stdout?.on("data", (data) => {
					stdout += data.toString();
				});
				proc.stderr?.on("data", (data) => {
					stderr += data.toString();
				});
				proc.on("close", (code) => resolve({ stdout, stderr, code }));
			});

			if (result.code !== 0) {
				ctx.view.showStatus(`Failed to create gist: ${result.stderr?.trim() || "Unknown error"}`, "error");
				return;
			}

			const gistUrl = result.stdout?.trim();
			const gistId = gistUrl?.split("/").pop();
			if (!gistId) {
				ctx.view.showStatus("Failed to parse gist ID from gh output", "error");
				return;
			}

			const previewUrl = getShareViewerUrl(gistId);
			ctx.view.showStatus(`Share URL: ${previewUrl}\nGist: ${gistUrl}`);
		} catch (error) {
			ctx.view.showStatus(
				`Failed to create gist: ${error instanceof Error ? error.message : "Unknown error"}`,
				"error",
			);
		} finally {
			try {
				fs.unlinkSync(tmpFile);
			} catch {
				// Ignore cleanup errors
			}
		}
	},
	usage: "/share",
};

const copyCommand: CommandEntry = {
	execute: async (ctx) => {
		const text = ctx.session.getLastAssistantText();
		if (!text) {
			ctx.view.showStatus("No agent messages to copy yet.", "error");
			return;
		}
		try {
			await copyToClipboard(text);
			ctx.view.flash("Copied!");
		} catch (error) {
			ctx.view.showStatus(error instanceof Error ? error.message : String(error), "error");
		}
	},
	usage: "/copy",
};

const nameCommand: CommandEntry = {
	execute: (ctx) => {
		const name = ctx.args.join(" ").trim();
		if (!name) {
			const currentName = ctx.session.sessionManager.getSessionName();
			if (currentName) {
				ctx.view.renderMessage(`Session name: ${currentName}`);
			} else {
				ctx.view.showStatus("Usage: /name <name>", "warning");
			}
			return;
		}

		ctx.session.setSessionName(name);
		const sessionName = ctx.session.sessionManager.getSessionName();
		if (sessionName !== name) {
			ctx.view.showStatus(
				`Session name was normalized from ${JSON.stringify(name)} to ${JSON.stringify(sessionName)}`,
				"warning",
			);
		}
		ctx.view.renderMessage(`Session name set: ${sessionName ?? name}`);
	},
	usage: "/name <name>",
	argHint: "<name>",
};

const sessionCommand: CommandEntry = {
	execute: (ctx) => {
		const stats = ctx.session.getSessionStats();
		const sessionName = ctx.session.sessionManager.getSessionName();
		const entries = ctx.session.sessionManager.getEntries();
		const cacheWaste = computeCacheWaste(entries, ctx.session.modelRuntime);

		// Cost/token totals per provider/model actually used (e.g. OpenRouter `auto`
		// resolves to a concrete responseModel), sorted by cost descending.
		const perModelMap = new Map<string, { key: string; cost: number; tokens: number }>();
		for (const entry of entries) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			const message = entry.message;
			if (!message.usage || !message.provider) continue;
			const usage = message.usage;
			const key = `${message.provider}/${message.responseModel ?? message.model}`;
			let bucket = perModelMap.get(key);
			if (!bucket) {
				bucket = { key, cost: 0, tokens: 0 };
				perModelMap.set(key, bucket);
			}
			bucket.cost += usage.cost.total;
			bucket.tokens += usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
		}
		const perModel = Array.from(perModelMap.values()).sort((a, b) => b.cost - a.cost);

		let info = `Session Info\n\n`;
		if (sessionName) {
			info += `Name: ${sessionName}\n`;
		}
		info += `File: ${stats.sessionFile ?? "In-memory"}\n`;
		info += `ID: ${stats.sessionId}\n\n`;
		info += `Messages\n`;
		info += `Total: ${stats.totalMessages}\n`;
		info += `User: ${stats.userMessages}\n`;
		info += `Assistant: ${stats.assistantMessages}\n`;
		info += `Tools: ${stats.toolCalls} calls, ${stats.toolResults} results\n\n`;
		info += `Tokens\n`;
		// "Input" is the full prompt volume. With cache activity, split it into
		// cached (served from cache) vs uncached (everything else) - the only
		// provider-independent split. Cache writes, where reported, are a detail
		// of the uncached portion.
		const { input, cacheRead, cacheWrite } = stats.tokens;
		const promptTokens = input + cacheRead + cacheWrite;
		info += `Input: ${promptTokens.toLocaleString()}\n`;
		if (promptTokens > 0 && (cacheRead > 0 || cacheWrite > 0)) {
			const hitRate = `(${((cacheRead / promptTokens) * 100).toFixed(1)}%)`;
			info += `  Cached: ${cacheRead.toLocaleString()} ${hitRate}\n`;
			const written = cacheWrite > 0 ? ` (${cacheWrite.toLocaleString()} written to cache)` : "";
			info += `  Uncached: ${(input + cacheWrite).toLocaleString()}${written}\n`;
		}
		info += `Output: ${stats.tokens.output.toLocaleString()}\n`;
		info += `Total: ${stats.tokens.total.toLocaleString()}\n`;

		if (stats.cost > 0 || cacheWaste.missedTokens > 0) {
			info += `\nCost\n`;
			info += `Total: $${stats.cost.toFixed(3)}`;
			if (perModel.length > 1) {
				for (const entry of perModel) {
					info += `\n  ${entry.key}: $${entry.cost.toFixed(3)} (${formatTokens(entry.tokens)} tokens)`;
				}
			}
			if (cacheWaste.missedTokens > 0) {
				const missLabel = cacheWaste.missCount === 1 ? "1 miss" : `${cacheWaste.missCount} misses`;
				const detail = `${cacheWaste.missedTokens.toLocaleString()} tokens, ${missLabel}`;
				info +=
					cacheWaste.missedCost >= 0.0001
						? `\nCache Re-billed: $${cacheWaste.missedCost.toFixed(3)} (${detail})`
						: `\nCache Re-billed: ${detail}`;
			}
		}

		ctx.view.renderMessage(info);
	},
	usage: "/session",
};

const stateCommand: CommandEntry = {
	execute: (ctx) => {
		const pathArg = ctx.args[0];
		let value: unknown;
		if (pathArg) {
			value = ctx.session.stateManager.get(pathArg);
		} else {
			value = ctx.session.stateManager.snapshot();
		}
		const formatted = JSON.stringify(value, null, 2);
		ctx.view.showStatus(`State${pathArg ? ` (${pathArg})` : ""}:\n${formatted}`);
	},
	autocomplete: (prefix, ctx) => {
		const snapshot = ctx.session.stateManager.snapshot();
		if (typeof snapshot !== "object" || snapshot === null) return null;
		const parts = prefix.split(/[./]/);
		const lastPart = parts[parts.length - 1] ?? "";
		const pathParts = parts.slice(0, -1);
		let current: unknown = snapshot;
		for (const p of pathParts) {
			if (typeof current !== "object" || current === null || Array.isArray(current)) return null;
			current = (current as Record<string, unknown>)[p];
			if (current === undefined) return null;
		}
		if (typeof current !== "object" || current === null || Array.isArray(current)) return null;
		const basePath = pathParts.join(".");
		return Object.keys(current as Record<string, unknown>)
			.filter((key) => key.toLowerCase().startsWith(lastPart.toLowerCase()))
			.map((key) => (basePath ? `${basePath}.${key}` : key));
	},
	usage: "/state [path]",
	argHint: "<path>",
};

const schemaCommand: CommandEntry = {
	execute: (ctx) => {
		const sub = ctx.args[0];

		if (!sub || sub === "list") {
			const namespaces = ctx.session.schemaValidator.getActiveNamespaces();
			if (namespaces.length === 0) {
				ctx.view.showStatus("No schemas loaded. Use /schema load <id> to load a schema.");
				return;
			}
			const strict = ctx.session.schemaValidator.isStrict() ? " [strict]" : "";
			ctx.view.showStatus(`Active schemas${strict}:\n${namespaces.map((n) => `  ${n}`).join("\n")}`);
			return;
		}

		if (sub === "load") {
			const schemaId = ctx.args[1];
			if (!schemaId) {
				// List available schemas
				const defs = ctx.session.getLoadedSchemaDefs();
				if (defs.length === 0) {
					ctx.view.showStatus("No schema files found. Create a .ts file in .pi/schemas/ or ~/.pi/agent/schemas/.");
					return;
				}
				ctx.view.showStatus(
					`Available schemas:\n${defs.map((d) => `  ${d.schemaId} (ns: ${d.namespace})`).join("\n")}`,
				);
				return;
			}
			const result = ctx.session.loadSchema(schemaId);
			if (result.ok) {
				ctx.view.showStatus(`Schema "${schemaId}" loaded into namespace "${result.namespace}".`);
			} else {
				ctx.view.showStatus(result.error ?? `Schema "${schemaId}" not found.`, "error");
			}
			return;
		}

		if (sub === "unload") {
			const namespace = ctx.args[1];
			if (!namespace) {
				ctx.view.showStatus("Usage: /schema unload <namespace>", "error");
				return;
			}
			ctx.session.unloadSchema(namespace);
			ctx.view.showStatus(`Schema unloaded from namespace "${namespace}".`);
			return;
		}

		if (sub === "strict") {
			const enabled = ctx.args[1] !== "off";
			ctx.session.setStrictMode(enabled);
			ctx.view.showStatus(`Strict mode ${enabled ? "enabled" : "disabled"}.`);
			return;
		}

		ctx.view.showStatus("Usage: /schema [list|load <id>|unload <ns>|strict [off]]", "error");
	},
	autocomplete: (prefix, ctx) => {
		if (!prefix.includes(" ")) {
			return ["list", "load", "unload", "strict"].filter((s) => startsWith(prefix, s));
		}
		const spaceIdx = prefix.indexOf(" ");
		const sub = prefix.slice(0, spaceIdx);
		if (sub === "load") {
			const defs = ctx.session.getLoadedSchemaDefs();
			if (defs.length === 0) return null;
			return defs.map((d) => `${sub} ${d.schemaId}`).filter((v) => startsWith(prefix, v));
		}
		if (sub === "unload") {
			const namespaces = ctx.session.schemaValidator.getActiveNamespaces();
			if (namespaces.length === 0) return null;
			return namespaces.map((n) => `${sub} ${n}`).filter((v) => startsWith(prefix, v));
		}
		if (sub === "strict") {
			return [`${sub} off`].filter((v) => startsWith(prefix, v));
		}
		return null;
	},
	usage: "/schema [list|load <id>|unload <ns>|strict [off]]",
	argHint: "[list|load <id>|unload <ns>|strict [off]]",
};

const validatorCommand: CommandEntry = {
	execute: (ctx) => {
		const sub = ctx.args[0];

		if (!sub || sub === "list") {
			const validators = ctx.session.getLoadedCustomValidators();
			if (validators.length === 0) {
				ctx.view.showStatus(
					"No custom validators loaded. Create a .ts file in .pi/validators/ or ~/.pi/agent/validators/. Use /reload after changes.",
				);
				return;
			}
			const lines = validators.map((v) => `  ${v.namespace}.${v.path}`);
			ctx.view.showStatus(`Custom validators (${validators.length}):\n${lines.join("\n")}`);
			return;
		}

		ctx.view.showStatus("Usage: /validator [list]", "error");
	},
	usage: "/validator [list]",
};

const changelogCommand: CommandEntry = {
	execute: (ctx) => {
		const changelogPath = getChangelogPath();
		const allEntries = parseChangelog(changelogPath);

		const changelogMarkdown =
			allEntries.length > 0
				? allEntries
						.reverse()
						.map((e) => normalizeChangelogLinks(e.content, e))
						.join("\n\n")
				: "No changelog entries found.";

		ctx.view.renderMessage(changelogMarkdown, { markdown: true });
	},
	usage: "/changelog",
};

const promptCommand: CommandEntry = {
	execute: async (ctx) => {
		const sub = ctx.args[0];
		if (sub === "tools") {
			ctx.view.renderMessage(buildPromptToolsMessage(ctx.session), { markdown: true });
			return;
		}

		const parts: string[] = [];

		// Show captured system prompt (extension-modified or empty)
		const sysPrompt = ctx.session.lastCompiledSystemPrompt;
		if (sysPrompt) {
			parts.push(`[system]\n${sysPrompt}`);
		}

		const messages = await ctx.session.previewPrompt();

		if (!sysPrompt && messages.length === 0) {
			ctx.view.showStatus("No prompt is active.");
			return;
		}

		const llmMessages = convertToLlm(messages);

		// Merge adjacent messages with the same role for cleaner display
		const merged: typeof llmMessages = [];
		const extractText = (c: string | readonly { type: string; text?: string }[]): string => {
			if (typeof c === "string") return c;
			return c
				.filter((b) => b.type === "text")
				.map((b) => b.text ?? "")
				.join("\n");
		};
		for (const msg of llmMessages) {
			const last = merged[merged.length - 1];
			if (last && last.role === msg.role) {
				const t1 = extractText(last.content);
				const t2 = extractText(msg.content);
				last.content = t1 ? (t2 ? `${t1}\n\n${t2}` : t1) : t2;
			} else {
				merged.push(msg);
			}
		}
		const displayMessages = merged.length > 0 ? merged : llmMessages;

		for (const msg of displayMessages) {
			const lines: string[] = [];
			const role = msg.role;
			const content = msg.content;

			if (typeof content === "string") {
				if (!content.trim()) continue;
				lines.push(content);
			} else if (Array.isArray(content)) {
				for (const block of content) {
					if (!block || typeof block !== "object") continue;
					const type = "type" in block ? String(block.type) : "";
					switch (type) {
						case "text":
							if ("text" in block && typeof block.text === "string") {
								lines.push(`[text] ${block.text}`);
							}
							break;
						case "thinking":
							if ("thinking" in block) lines.push(`[thinking] ${String(block.thinking)}`);
							break;
						case "toolCall":
							if ("name" in block) {
								const name = String(block.name ?? "");
								const args = "arguments" in block ? JSON.stringify(block.arguments) : "";
								lines.push(`[toolCall: ${name}] ${args}`);
							}
							break;
						case "image":
							lines.push(`[image]`);
							break;
						default:
							lines.push(`[${type}] ${JSON.stringify(block)}`);
							break;
					}
				}
			}

			if (lines.length === 0) continue;
			parts.push(`\n[${role}]\n${lines.join("\n")}`);
		}

		if (parts.length === 0) {
			ctx.view.showStatus("No prompt is active.");
			return;
		}

		ctx.view.renderMessage(parts.join("\n"), { markdown: true });
		ctx.view.showStatus("Full prompt shown above.");
	},
	autocomplete: (prefix) => ["tools", "messages"].filter((s) => startsWith(prefix, s)),
	usage: "/prompt [tools|messages]",
	argHint: "<tools|messages>",
};

function buildPromptToolsMessage(session: AgentSession): string {
	const tools = session.agent.state.tools;
	if (!tools || tools.length === 0) {
		return "";
	}
	const parts: string[] = [];
	for (const tool of tools) {
		parts.push(`## ${tool.name}`);
		if (tool.description) {
			parts.push(`\n${tool.description}`);
		}
		if (tool.parameters) {
			parts.push(`\n\`\`\`json\n${JSON.stringify(tool.parameters, null, 2)}\n\`\`\``);
		}
		parts.push("");
	}
	parts.push(`---\nAvailable: ${tools.map((t) => t.name).join(", ")}`);
	return parts.join("\n").trim();
}

const cloneCommand: CommandEntry = {
	execute: async (ctx) => {
		const leafId = ctx.session.sessionManager.getLeafId();
		if (!leafId) {
			ctx.view.showStatus("Nothing to clone yet");
			return;
		}
		try {
			const result = await ctx.session.extensionRunner.createCommandContext().fork(leafId, { position: "at" });
			if (result.cancelled) {
				return;
			}
			ctx.view.showStatus("Cloned to new session");
		} catch (error) {
			ctx.view.showStatus(error instanceof Error ? error.message : String(error), "error");
		}
	},
	usage: "/clone",
};

const newCommand: CommandEntry = {
	execute: async (ctx) => {
		try {
			const result = await ctx.session.extensionRunner.createCommandContext().newSession();
			if (!result.cancelled) {
				ctx.view.renderMessage("✓ New session started");
			}
		} catch (error) {
			ctx.view.showStatus(
				`Failed to create session: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		}
	},
	usage: "/new",
};

const compactCommand: CommandEntry = {
	execute: async (ctx) => {
		if (ctx.session.isStreaming || ctx.session.isCompacting) {
			ctx.view.showStatus("Wait for the current response to finish before compacting.", "warning");
			return;
		}
		const customInstructions = ctx.args.length > 0 ? ctx.args.join(" ") : undefined;
		try {
			await ctx.session.compact(customInstructions);
		} catch {
			// Ignore, will be emitted as an event
		}
	},
	usage: "/compact [instructions]",
};

const continueCommand: CommandEntry = {
	execute: async (ctx) => {
		if (ctx.session.isStreaming || ctx.session.isCompacting) {
			ctx.view.showStatus("Wait for the current response to finish before continuing.", "warning");
			return;
		}
		const started = await ctx.session.continueSession();
		if (started) {
			ctx.view.showStatus("Continuing...");
		} else {
			ctx.view.showStatus("Nothing to continue from.");
		}
	},
	usage: "/continue",
};

const rerollCommand: CommandEntry = {
	execute: async (ctx) => {
		if (ctx.session.isStreaming || ctx.session.isCompacting) {
			ctx.view.showStatus("Wait for the current response to finish before rerolling.", "warning");
			return;
		}

		// Phase 1: branch session tree to the last user message and restore state.
		// The leaf_changed event (emitted by reroll() after state restore) rebuilds the chat.
		if (!(await ctx.session.reroll())) {
			ctx.view.showStatus("Nothing to reroll — no user message found.", "warning");
			return;
		}

		ctx.view.showStatus("Rerolling last response...");

		// Phase 2: start agent run (continue from user message)
		await ctx.session.startRerollRun();
	},
	usage: "/reroll",
};

const presetCommand: CommandEntry = {
	execute: async (ctx) => {
		const arg = ctx.args[0];

		if (!arg) {
			const presets = ctx.session.getAllPresets();
			if (presets.length === 0) {
				ctx.view.showStatus("No prompt presets found. Create a .json file in .pi/prompt-presets/.");
				return;
			}
			const lines = presets.map((p) => {
				const active = p.preset.id === ctx.session.activePreset.id ? " (active)" : "";
				const errors = p.diagnostics.filter((d) => d.level === "error").length;
				const warnings = p.diagnostics.filter((d) => d.level === "warning").length;
				const badge = errors ? ` [${errors}e/${warnings}w]` : warnings ? ` [0e/${warnings}w]` : "";
				return `  ${p.preset.id}${badge}${active}`;
			});
			ctx.view.showStatus(`Prompt presets:\n${lines.join("\n")}`);
			return;
		}

		const result = await ctx.session.setActivePreset(arg);
		if (!result.ok) {
			ctx.view.showStatus(`Prompt preset "${arg}" not found. Use /preset to see available presets.`, "error");
			return;
		}

		// preset_activated event (emitted by setActivePreset) refreshes the
		// footer and editor border — no manual view calls here.

		if (result.model) {
			ctx.view.showStatus(`Active prompt preset: ${arg} · Model: ${result.model.id}`);
		} else {
			ctx.view.showStatus(`Active prompt preset: ${arg}`);
		}

		if (result.error) {
			ctx.view.showStatus(result.error, "error");
		}
	},
	autocomplete: (prefix, ctx) => {
		const presets = ctx.session.getAllPresets();
		return ["none", ...presets.map((p) => p.preset.id)].filter((id) => startsWith(prefix, id));
	},
	usage: "/preset [<id>|none]",
	argHint: "<id|none>",
};

const subagentCommand: CommandEntry = {
	execute: async (ctx) => {
		const arg = ctx.args[0];

		// /subagent or /subagent list — list delegatable presets
		if (!arg || arg === "list") {
			const presets = ctx.session.getAllPresets().filter((p) => p.preset.delegatable === true);
			if (presets.length === 0) {
				ctx.view.showStatus('No delegatable subagent profiles found. Add "delegatable": true to a preset.');
				return;
			}
			const lines = presets.map((p) => {
				const preset = p.preset;
				return `  ${preset.id} — ${preset.name ?? preset.id}: ${preset.description ?? "(no description)"}`;
			});
			ctx.view.showStatus(`Subagent profiles:\n${lines.join("\n")}`);
			return;
		}

		// /subagent <profileId> <task...>
		const profileId = arg;
		const task = ctx.args.slice(1).join(" ");

		if (!task) {
			ctx.view.showStatus("Usage: /subagent <profileId> <task>", "error");
			return;
		}

		const isDelegatable = ctx.session
			.getAllPresets()
			.some((p) => p.preset.id === profileId && p.preset.delegatable === true);
		if (!isDelegatable) {
			ctx.view.showStatus(`Profile "${profileId}" is not delegatable. Use /subagent list.`, "error");
			return;
		}

		ctx.view.showStatus(`Running subagent "${profileId}"...`);
		const preparation = await prepareSubagentConversation({
			cwd: ctx.session.sessionManager.getCwd(),
			profileId,
			task,
			modelRuntime: ctx.session.modelRuntime,
			session: ctx.session,
		});
		if (isPrepareError(preparation)) {
			ctx.view.showStatus(`Subagent preparation failed: ${preparation.error}`, "error");
			return;
		}
		const result = await runSubagent(preparation, ctx.session.modelRuntime, {
			requestGateway: ctx.session.requestGateway,
		});
		if (result.status === "completed") {
			ctx.view.showStatus(`Subagent completed:\n${result.text}`);
		} else {
			ctx.view.showStatus(`Subagent ${result.status}: ${result.error ?? result.text}`, "error");
		}
	},
	usage: "/subagent [list|<profileId> <task>]",
	argHint: "[list|<profileId> <task>]",
};

const modelCommand: CommandEntry = {
	execute: (ctx) => {
		ctx.view.showSelector("model", { searchTerm: ctx.args[0] });
	},
	autocomplete: (prefix, ctx) => {
		const models =
			ctx.session.scopedModels.length > 0
				? ctx.session.scopedModels.map((s) => s.model)
				: ctx.session.modelRuntime.getAvailableSnapshot();
		if (models.length === 0) return null;
		const items = models.map((m) => ({
			id: m.id,
			provider: m.provider,
			name: m.name,
			label: `${m.provider}/${m.id}`,
		}));
		const filtered = fuzzyFilter(items, prefix, (m) => getModelSearchText(m));
		if (filtered.length === 0) return null;
		return filtered.map((m) => m.label);
	},
	usage: "/model [<provider>/<model>]",
	argHint: "<provider/model>",
};

const loginCommand: CommandEntry = {
	execute: (ctx) => {
		ctx.view.showSelector("login", { providerRef: ctx.args[0] });
	},
	autocomplete: (prefix, ctx) => {
		const providers = ctx.session.modelRuntime.getProviders();
		const byId = new Map<string, { id: string; name: string; authTypes: Array<"oauth" | "api_key"> }>();
		for (const provider of providers) {
			const authTypes: Array<"oauth" | "api_key"> = [];
			if (provider.auth.oauth) authTypes.push("oauth");
			if (provider.auth.apiKey) authTypes.push("api_key");
			if (authTypes.length === 0) continue;
			const existing = byId.get(provider.id);
			if (existing) {
				for (const t of authTypes) if (!existing.authTypes.includes(t)) existing.authTypes.push(t);
			} else {
				byId.set(provider.id, { id: provider.id, name: provider.name, authTypes });
			}
		}
		const options = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
		const filtered = fuzzyFilter(
			options,
			prefix,
			(p) => `${p.id} ${p.name} ${p.authTypes.map((t) => `${t} ${formatAuthType(t)}`).join(" ")}`,
		);
		if (filtered.length === 0) return null;
		return filtered.map((p) => ({
			value: p.id,
			label: p.id,
			description:
				p.name === p.id
					? p.authTypes.map(formatAuthType).join("/")
					: `${p.name} · ${p.authTypes.map(formatAuthType).join("/")}`,
		}));
	},
	usage: "/login [<provider>]",
	argHint: "<provider>",
};

// ============================================================================
// View-delegated bodies
//
// These commands are inherently mode-coupled (selectors, keybindings, dialogs,
// runtime-host operations); the body dispatches to the view, which owns the
// mode-specific implementation. The RPC view adapter stubs selectors.
// ============================================================================

function viewSelectorCommand(kind: string, usage: string, argHint?: string): CommandEntry {
	return {
		execute: (ctx) => {
			ctx.view.showSelector(kind);
		},
		usage,
		...(argHint && { argHint }),
	};
}

const builtinEntries: Array<{ name: string; entry: CommandEntry }> = [
	{ name: "settings", entry: viewSelectorCommand("settings", "/settings") },
	{ name: "model", entry: modelCommand },
	{ name: "scoped-models", entry: viewSelectorCommand("models", "/scoped-models") },
	{ name: "export", entry: exportCommand },
	{
		name: "import",
		entry: {
			execute: (ctx) => {
				ctx.view.showSelector("import", { path: getPathArg(ctx.args) });
			},
			usage: "/import <path.jsonl>",
			argHint: "<path.jsonl>",
		},
	},
	{ name: "share", entry: shareCommand },
	{ name: "copy", entry: copyCommand },
	{ name: "name", entry: nameCommand },
	{ name: "session", entry: sessionCommand },
	{ name: "state", entry: stateCommand },
	{ name: "schema", entry: schemaCommand },
	{ name: "validator", entry: validatorCommand },
	{ name: "changelog", entry: changelogCommand },
	{ name: "hotkeys", entry: viewSelectorCommand("hotkeys", "/hotkeys") },
	{ name: "fork", entry: viewSelectorCommand("fork", "/fork") },
	{ name: "clone", entry: cloneCommand },
	{ name: "tree", entry: viewSelectorCommand("tree", "/tree") },
	{ name: "trust", entry: viewSelectorCommand("trust", "/trust") },
	{ name: "prompt", entry: promptCommand },
	{ name: "login", entry: loginCommand },
	{ name: "logout", entry: viewSelectorCommand("logout", "/logout") },
	{ name: "new", entry: newCommand },
	{ name: "compact", entry: compactCommand },
	{ name: "continue", entry: continueCommand },
	{ name: "reload", entry: viewSelectorCommand("reload", "/reload") },
	{ name: "reroll", entry: rerollCommand },
	{ name: "resume", entry: viewSelectorCommand("resume", "/resume") },
	{ name: "preset", entry: presetCommand },
	{ name: "subagent", entry: subagentCommand },
	// Hidden commands (not in BUILTIN_SLASH_COMMANDS): dispatch works, autocomplete stays hidden.
	{ name: "debug", entry: viewSelectorCommand("debug", "/debug") },
	{
		name: "arminsayshi",
		entry: { execute: (ctx) => ctx.view.showSelector("easterEgg", "arminsayshi"), usage: "/arminsayshi" },
	},
	{
		name: "dementedelves",
		entry: { execute: (ctx) => ctx.view.showSelector("easterEgg", "dementedelves"), usage: "/dementedelves" },
	},
];

/**
 * Register all builtin commands. Called once at module load from
 * src/commands/index.ts.
 */
let builtinsRegistered = false;

/**
 * Register all builtin command entries into the registry. Idempotent —
 * safe to call from multiple import paths (the registry is module-global).
 */
export function registerBuiltinCommandEntries(): void {
	if (builtinsRegistered) return;
	builtinsRegistered = true;
	for (const { name, entry } of builtinEntries) {
		registerBuiltin(name, entry);
	}
}
