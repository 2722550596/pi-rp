/**
 * /prompt 显示渲染 —— TUI 内置命令(/prompt)与 RPC get_prompt 共用的单一实现。
 *
 * 数据源与真实 LLM payload 完全一致:
 * - system:session.lastCompiledSystemPrompt(最近一次编译捕获)
 * - messages:session.previewPrompt()(preset 注入 + 扩展 context 钩子后的真实管线产物)
 * - tools:session.agent.state.tools
 * custom message 经 convertToLlm + getCustomTypePolicy,与真实发送走同一渲染策略。
 */

import type { AgentSession } from "./agent-session.ts";
import { convertToLlm } from "./messages.ts";

export type PromptDisplaySection = "all" | "tools" | "messages";

/** Tools 清单文本(原 /prompt tools 视图)。空工具集返回 ""。 */
export async function buildPromptToolsText(session: AgentSession): Promise<string> {
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

/**
 * 渲染消息段数组(每段形如 "\n[role]\n...")。返回 [] 表示无可显示消息。
 * 与真实 payload 一致:先 previewPrompt(),再 convertToLlm + custom-type policy,
 * 相邻同角色合并,逐条按 content block 类型格式化。
 */
async function collectMessageParts(session: AgentSession): Promise<string[]> {
	const messages = await session.previewPrompt();
	if (messages.length === 0) {
		return [];
	}

	// Thread the extension custom-type policies so the preview shows the same
	// rendered view as the real payload (seam renderContent markers included).
	const llmMessages = convertToLlm(messages, (ct) => session.extensionRunner.getCustomTypePolicy(ct));

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

	const parts: string[] = [];
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

	return parts;
}

/**
 * 渲染 /prompt 显示文本。
 * - "all"(默认):[system] + 消息,与 TUI /prompt 默认视图逐字节一致;空会话返回 ""
 * - "tools":仅工具清单
 * - "messages":仅消息(无 [system] 段)
 */
export async function renderPromptDisplay(
	session: AgentSession,
	section: PromptDisplaySection = "all",
): Promise<string> {
	if (section === "tools") {
		return buildPromptToolsText(session);
	}

	const messageParts = await collectMessageParts(session);

	if (section === "messages") {
		if (messageParts.length === 0) return "";
		return messageParts.join("\n").replace(/^\n/, "");
	}

	// Show captured system prompt (extension-modified or empty)
	const sysPrompt = session.lastCompiledSystemPrompt;
	if (!sysPrompt && messageParts.length === 0) {
		return "";
	}
	const parts = sysPrompt ? [`[system]\n${sysPrompt}`, ...messageParts] : messageParts;
	return parts.length > 0 ? parts.join("\n") : "";
}
