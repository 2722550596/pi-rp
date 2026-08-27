import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
	compileMessages,
	compileSystemPrompt,
	deriveSystemPrompt,
	deriveSystemPromptString,
} from "../src/core/prompt-preset/compiler.ts";
import {
	expandContentMacros,
	expandMacros,
	getAllMacros,
	registerMacro,
} from "../src/core/prompt-preset/macro-engine.ts";
import { getAllSlots, getSlot, registerSlot } from "../src/core/prompt-preset/slot-renderers.ts";
import type { PromptPreset, PromptRuntime, SlotDefinition } from "../src/core/prompt-preset/types.ts";

function userMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 0 };
}

function assistantMessage(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

function runtime(messages: AgentMessage[], extra?: Partial<PromptRuntime>): PromptRuntime {
	return {
		options: { cwd: "" },
		messages,
		now: new Date(0),
		variables: {},
		skills: [],
		...extra,
	};
}

function messageText(message: AgentMessage): string {
	if (!("content" in message) || !Array.isArray(message.content)) return "";
	const parts: string[] = [];
	for (const block of message.content) {
		if (typeof block !== "object" || block === null) continue;
		const part = block as { type?: string; text?: string };
		if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
	}
	return parts.join("\n");
}

function presetWithItems(items: PromptPreset["items"], defaults?: PromptPreset["defaults"]): PromptPreset {
	return { schemaVersion: 1, id: "test", defaults, items };
}

describe("{{lastUserMessage}} derivation", () => {
	const lastUserPreset = presetWithItems([
		{ kind: "block", id: "persona", content: "You are a helpful assistant." },
		{ kind: "block", id: "latest", role: "user", content: "{{lastUserMessage}}" },
	]);

	it("derives the last user message when latestUserMessage is unset", () => {
		const messages = [userMessage("first"), assistantMessage("answer 1"), userMessage("second")];
		const compiled = compileMessages(lastUserPreset, runtime(messages)).messages;
		// No chat-history slot, so only the preset items compile.
		expect(compiled).toHaveLength(2);
		expect(compiled[0].role).toBe("system");
		expect(compiled[1].role).toBe("user");
		expect(messageText(compiled[1])).toBe("second");
	});

	it("prefers an explicitly provided latestUserMessage", () => {
		const messages = [userMessage("first"), userMessage("second")];
		const compiled = compileMessages(lastUserPreset, runtime(messages, { latestUserMessage: "explicit" })).messages;
		expect(messageText(compiled[compiled.length - 1])).toBe("explicit");
	});

	it("skips trailing empty-text user messages", () => {
		const messages = [userMessage("first"), userMessage("")];
		const compiled = compileMessages(lastUserPreset, runtime(messages)).messages;
		expect(messageText(compiled[compiled.length - 1])).toBe("first");
	});

	it("renders the derived message through compileSystemPrompt too", () => {
		const messages = [userMessage("hello"), assistantMessage("hi"), userMessage("world")];
		const systemResult = compileSystemPrompt(lastUserPreset, runtime(messages), "");
		expect(systemResult.systemPrompt).toContain("You are a helpful assistant.");
		// The user-role item is not part of the system string.
		expect(systemResult.systemPrompt).not.toContain("world");
		// But the derived message array carries it:
		const compiled = compileMessages(lastUserPreset, runtime(messages)).messages;
		expect(messageText(compiled[compiled.length - 1])).toBe("world");
	});

	it("keeps the synthetic Continue. edge case documented: a trailing continue-style user message is picked up", () => {
		// continueSession injects { role: "user", content: [{type:"text", text:"Continue."}] }
		// with no marker field, so it is indistinguishable from a real user message.
		const messages = [userMessage("real question"), userMessage("Continue.")];
		const compiled = compileMessages(lastUserPreset, runtime(messages)).messages;
		expect(messageText(compiled[compiled.length - 1])).toBe("Continue.");
	});
});

describe("chat-history position contract", () => {
	const positionedPreset = presetWithItems([
		{ kind: "block", id: "a", content: "System A" },
		{ kind: "slot", id: "chat", slot: "chat-history" },
		{ kind: "block", id: "b", role: "user", content: "Tail" },
	]);

	it("injects runtime.messages at the built-in chat-history slot position", () => {
		const history = [userMessage("h1"), assistantMessage("a1"), userMessage("h2")];
		const compiled = compileMessages(positionedPreset, runtime(history)).messages;
		// The trailing user block merges with the adjacent history user message.
		expect(compiled.map(messageText)).toEqual(["System A", "h1", "a1", "h2\n\nTail"]);
	});

	it("treats a custom slot with position chat-history as the insertion point", () => {
		registerSlot({
			name: "custom-history",
			description: "Custom history insertion point",
			position: "chat-history",
			render: () => "should never render",
		});
		const preset = presetWithItems([
			{ kind: "block", id: "a", content: "System A" },
			{ kind: "slot", id: "chat", slot: "custom-history" },
			{ kind: "block", id: "b", role: "user", content: "Tail" },
		]);
		const history = [userMessage("h1"), userMessage("h2")];
		const compiled = compileMessages(preset, runtime(history)).messages;
		expect(compiled.map(messageText)).toEqual(["System A", "h1\n\nh2\n\nTail"]);
		expect(messageText(compiled[0])).toBe("System A");
	});

	it("keeps the built-in chat-history slot name working (preset JSON format unchanged)", () => {
		const slot = getSlot("chat-history");
		expect(slot?.position).toBe("chat-history");
	});

	it("renders a custom slot without a position at its position", () => {
		registerSlot({
			name: "plain-slot",
			description: "Plain content slot",
			render: () => "custom content",
		});
		const preset = presetWithItems([
			{ kind: "block", id: "a", content: "System A" },
			{ kind: "slot", id: "custom", slot: "plain-slot" },
		]);
		const compiled = compileMessages(preset, runtime([])).messages;
		// Adjacent system-role messages merge (documented squash behavior).
		expect(compiled.map(messageText)).toEqual(["System A\n\ncustom content"]);
	});
});

describe("implicit chat-history fallback", () => {
	const noSlotPreset = presetWithItems([
		{ kind: "block", id: "a", content: "System A" },
		{ kind: "block", id: "b", role: "user", content: "Tail" },
	]);

	it("appends runtime.messages at the end when no chat-history slot exists", () => {
		const history = [userMessage("h1"), assistantMessage("a1"), userMessage("h2")];
		const compiled = compileMessages(noSlotPreset, runtime(history));
		// History appends after all preset items; the user-role "Tail" block
		// merges with the adjacent history user message (documented squash).
		expect(compiled.messages.map(messageText)).toEqual(["System A", "Tail\n\nh1", "a1", "h2"]);
		expect(compiled.sources.map((s) => s.kind)).toEqual([
			"preset-item",
			"preset-item",
			"implicit-history",
			"implicit-history",
			"implicit-history",
		]);
	});

	it("does not fire when the conversation is empty", () => {
		const compiled = compileMessages(noSlotPreset, runtime([]));
		expect(compiled.messages.map(messageText)).toEqual(["System A", "Tail"]);
		expect(compiled.sources.some((s) => s.kind === "implicit-history")).toBe(false);
	});

	it("stays silent for the stateless {{lastUserMessage}} one-shot pattern", () => {
		const oneShotPreset = presetWithItems([
			{ kind: "block", id: "persona", content: "You are a translator." },
			{ kind: "block", id: "latest", role: "user", content: "{{lastUserMessage}}" },
		]);
		const history = [userMessage("first"), assistantMessage("answer"), userMessage("second")];
		const compiled = compileMessages(oneShotPreset, runtime(history));
		// Injecting history here would duplicate the latest user message.
		expect(compiled.messages).toHaveLength(2);
		expect(compiled.sources.some((s) => s.kind === "implicit-history")).toBe(false);
		expect(messageText(compiled.messages[1])).toBe("second");
	});
});

describe("item wrap (custom XML tag)", () => {
	it("wraps a block in a plain tag", () => {
		const preset = presetWithItems([{ kind: "block", id: "b", content: "inner", wrap: "context" }]);
		const compiled = compileMessages(preset, runtime([])).messages;
		expect(compiled).toHaveLength(1);
		expect(messageText(compiled[0])).toBe("<context>inner</context>");
	});

	it("wraps with attributes and escapes attribute values", () => {
		const preset = presetWithItems([
			{
				kind: "block",
				id: "b",
				content: "x",
				wrap: { tag: "note", attrs: { lang: "zh-CN", title: 'a "quoted" & <b>' } },
			},
		]);
		const compiled = compileMessages(preset, runtime([])).messages;
		expect(messageText(compiled[0])).toBe('<note lang="zh-CN" title="a &quot;quoted&quot; &amp; &lt;b&gt;">x</note>');
	});

	it("wraps slot output", () => {
		registerSlot({ name: "wrap-slot", description: "test", render: () => "slot content" });
		const preset = presetWithItems([{ kind: "slot", id: "s", slot: "wrap-slot", wrap: "slot_wrap" }]);
		const compiled = compileMessages(preset, runtime([])).messages;
		expect(messageText(compiled[0])).toBe("<slot_wrap>slot content</slot_wrap>");
	});

	it("expands macros inside the wrapped content", () => {
		registerMacro({ name: "wrapMacro", description: "test", render: () => "expanded" });
		const preset = presetWithItems([{ kind: "block", id: "b", content: "Hello {{wrapMacro}}", wrap: "ctx" }]);
		const compiled = compileMessages(preset, runtime([])).messages;
		expect(messageText(compiled[0])).toBe("<ctx>Hello expanded</ctx>");
	});

	it("skips wrapping when the item renders empty", () => {
		registerSlot({ name: "wrap-empty-slot", description: "test", render: () => "" });
		const preset = presetWithItems([{ kind: "slot", id: "s", slot: "wrap-empty-slot", wrap: "ctx" }]);
		const compiled = compileMessages(preset, runtime([])).messages;
		expect(compiled).toHaveLength(0);
	});

	it("warns and leaves text unwrapped on an invalid tag name", () => {
		const preset = presetWithItems([{ kind: "block", id: "b", content: "x", wrap: "bad tag!" }]);
		const result = compileMessages(preset, runtime([]));
		expect(messageText(result.messages[0])).toBe("x");
		expect(result.diagnostics.some((d) => d.level === "warning" && d.message.includes("bad tag!"))).toBe(true);
	});
});

describe("unresolvedMacroPolicy", () => {
	const unresolvedPreset = (policy: "warn" | "keep" | "error") =>
		presetWithItems([{ kind: "block", id: "b", content: "Hello {{doesNotExist}}" }], {
			unresolvedMacroPolicy: policy,
		});

	it("keeps the placeholder and reports no diagnostics by default", () => {
		const result = compileMessages(unresolvedPreset("keep"), runtime([]));
		expect(result.diagnostics.filter((d) => d.message.includes("doesNotExist"))).toHaveLength(0);
		expect(messageText(result.messages[0])).toBe("Hello {{doesNotExist}}");
	});

	it("adds a warning diagnostic under warn and keeps the placeholder", () => {
		const result = compileMessages(unresolvedPreset("warn"), runtime([]));
		const diags = result.diagnostics.filter((d) => d.message.includes("doesNotExist"));
		expect(diags).toHaveLength(1);
		expect(diags[0].level).toBe("warning");
		expect(messageText(result.messages[0])).toBe("Hello {{doesNotExist}}");
	});

	it("adds an error diagnostic under error (compile fails where error diagnostics are honored)", () => {
		const result = compileMessages(unresolvedPreset("error"), runtime([]));
		const diags = result.diagnostics.filter((d) => d.message.includes("doesNotExist"));
		expect(diags).toHaveLength(1);
		expect(diags[0].level).toBe("error");
	});

	it("does not flag deferred dynamic macros (mode static) as unresolved", () => {
		// {{user}} is a known non-static macro; with mode "static" it is
		// intentionally left as a placeholder, not an unresolved macro.
		registerMacro({ name: "testVarMacro", description: "test", render: () => "x" });
		const expanded = expandMacros("{{testVarMacro}}", runtime([]), {
			mode: "static",
			unresolvedPolicy: "error",
			diagnostics: [],
		});
		expect(expanded).toBe("{{testVarMacro}}");
	});
});

describe("derived compileSystemPrompt (single compile entry)", () => {
	const preset = presetWithItems([
		{ kind: "block", id: "a", content: "System A" },
		{ kind: "block", id: "b", role: "user", content: "Not system" },
		{ kind: "block", id: "c", content: "System C" },
	]);

	it("is the system-role view of the same compileMessages output", () => {
		const compiled = compileMessages(preset, runtime([]));
		const systemResult = compileSystemPrompt(preset, runtime([]), "fallback");
		const derived = deriveSystemPrompt(compiled, preset, "fallback");
		expect(systemResult.systemPrompt).toBe("System A\n\nSystem C");
		expect(derived.systemPrompt).toBe(systemResult.systemPrompt);
		expect(deriveSystemPromptString(compiled.messages, preset)).toBe("System A\n\nSystem C");
	});

	it("falls back to baseSystemPrompt when the preset produces no system content", () => {
		const noSystem = presetWithItems([{ kind: "block", id: "u", role: "user", content: "only user" }]);
		expect(compileSystemPrompt(noSystem, runtime([]), "base").systemPrompt).toBe("base");
	});

	it("keeps diagnostics from the shared pipeline", () => {
		const withUnknownSlot = presetWithItems([{ kind: "slot", id: "s", slot: "no-such-slot" }]);
		const systemResult = compileSystemPrompt(withUnknownSlot, runtime([]), "");
		expect(systemResult.diagnostics.some((d) => d.message.includes("no-such-slot"))).toBe(true);
	});
});

describe("public extension surface stays intact", () => {
	it("exports the slot/macro introspection surface", () => {
		expect(typeof getAllSlots).toBe("function");
		expect(typeof getAllMacros).toBe("function");
		expect(typeof expandContentMacros).toBe("function");
		expect(getAllSlots().some((s) => s.name === "chat-history")).toBe(true);
		expect(getAllMacros().some((m) => m.name === "lastUserMessage")).toBe(true);
	});

	it("registerSlot accepts the position field without breaking the signature", () => {
		const def: SlotDefinition = {
			name: "position-probe",
			description: "probe",
			position: "content",
			render: () => "probe",
		};
		registerSlot(def);
		expect(getSlot("position-probe")?.position).toBe("content");
	});
});

describe("chat-history toolMode drop 与 dropToolNames 白名单", () => {
	function toolCallMessage(
		parts: Array<{ type: "toolCall"; name: string; id: string; arguments?: Record<string, unknown> }>,
	): AgentMessage {
		return {
			role: "assistant",
			content: parts.map((p) => ({ ...p, arguments: p.arguments ?? {} })),
			api: "openai-responses",
			provider: "openai",
			model: "gpt-4o-mini",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 0,
		};
	}

	function toolResultMessage(toolCallId: string, toolName: string): AgentMessage {
		return {
			role: "toolResult",
			toolCallId,
			toolName,
			content: [{ type: "text", text: `result of ${toolName}` }],
			isError: false,
			timestamp: 0,
		};
	}

	function dropPreset(options: Record<string, unknown>): PromptPreset {
		return presetWithItems([
			{ kind: "block", id: "a", content: "System A" },
			{ kind: "slot", id: "chat", slot: "chat-history", options },
		]);
	}

	function toolNamesOf(compiled: AgentMessage[]): string[] {
		const names: string[] = [];
		for (const msg of compiled) {
			if (msg.role === "toolResult") {
				names.push(`result:${(msg as { toolName?: string }).toolName}`);
			} else if (msg.role === "assistant" && Array.isArray(msg.content)) {
				for (const part of msg.content as Array<{ type?: string; name?: string }>) {
					if (part?.type === "toolCall") names.push(`call:${part.name}`);
				}
			}
		}
		return names;
	}

	const history = (): AgentMessage[] => [
		userMessage("请展示现场图片"),
		toolCallMessage([
			{ type: "toolCall", name: "show_html", id: "c1" },
			{ type: "toolCall", name: "read_file", id: "c2" },
		]),
		toolResultMessage("c1", "show_html"),
		toolResultMessage("c2", "read_file"),
		assistantMessage("好的，图片已展示。"),
	];

	it("dropToolNames 白名单：只删名单内工具的 toolCall 块 + toolResult，其余历史保留", () => {
		const compiled = compileMessages(
			dropPreset({ toolMode: "drop", dropToolNames: ["show_html"] }),
			runtime(history()),
		).messages;
		expect(toolNamesOf(compiled)).toEqual(["call:read_file", "result:read_file"]);
		// 文本消息与 toolResult 之外的历史原样保留
		expect(messageText(compiled[0])).toBe("System A");
		expect(compiled.map(messageText)).toContain("好的，图片已展示。");
	});

	it("dropToolNames 名单外工具完整保留（含同一条 assistant 消息里的其他 toolCall 块）", () => {
		const compiled = compileMessages(
			dropPreset({ toolMode: "drop", dropToolNames: ["show_html"] }),
			runtime([
				userMessage("开电脑"),
				toolCallMessage([
					{ type: "toolCall", name: "show_html", id: "c1" },
					{ type: "toolCall", name: "read_file", id: "c2" },
					{ type: "toolCall", name: "bash", id: "c3" },
				]),
				toolResultMessage("c1", "show_html"),
				toolResultMessage("c2", "read_file"),
				toolResultMessage("c3", "bash"),
			]),
		).messages;
		// show_html 的 toolCall 块被剥离；read_file/bash 的块原样保留
		// （toolResult 相邻时会被 squash 合并，这里只按 call 块断言）
		expect(toolNamesOf(compiled).filter((n) => n.startsWith("call:"))).toEqual(["call:read_file", "call:bash"]);
		// show_html 的 toolResult 被删；其余工具结果内容保留（相邻 toolResult 被 squash 合并）
		expect(JSON.stringify(compiled)).not.toContain("show_html");
		expect(compiled.map(messageText).join("\n")).toContain("result of read_file");
		expect(compiled.map(messageText).join("\n")).toContain("result of bash");
	});

	it("无 dropToolNames + toolMode drop = 全删（向后兼容回归）", () => {
		const compiled = compileMessages(dropPreset({ toolMode: "drop" }), runtime(history())).messages;
		expect(toolNamesOf(compiled)).toEqual([]);
		// toolCall 块被剥离后 assistant 消息仍含文本 → 保留
		expect(compiled.some((m) => m.role === "assistant" && messageText(m).length > 0)).toBe(true);
	});

	it("toolCall 块被全部剥离后 assistant 消息为空 → 整条删除", () => {
		const compiled = compileMessages(
			dropPreset({ toolMode: "drop", dropToolNames: ["show_html"] }),
			runtime([
				userMessage("开电脑"),
				toolCallMessage([{ type: "toolCall", name: "show_html", id: "c1" }]),
				toolResultMessage("c1", "show_html"),
			]),
		).messages;
		expect(toolNamesOf(compiled)).toEqual([]);
		// 仅剩 system 块与 user 消息
		expect(compiled.map((m) => m.role)).toEqual(["system", "user"]);
	});
});
