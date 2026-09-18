// append_entry 协议级单测（角色 session 记忆写入的地基能力，**不进 LLM
// 上下文**）。与 append-message.test.ts 对照：append_message 落 custom_message
// 以 user 角色进上下文；append_entry 落 custom entry（type=custom），由扩展
// get_entries 扫描重建内部状态（增量水位、缺席经过档案等），TUI 无渲染器
// 时不显示、前端未知 customType 静默忽略。不 spawn 真实 cli 子进程：客户端侧
// mock send 验证命令形状与 entryId 解析；服务端持久化语义直接构造 SessionManager 验证。

import type { Mock } from "vitest";
import { describe, expect, it, vi } from "vitest";
import { convertToLlm } from "../src/core/messages.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

type SendMock = Mock<(command: { type: string }) => Promise<unknown>>;

interface MockedClient {
	client: RpcClient;
	send: SendMock;
}

function mockClient(): MockedClient {
	const client = new RpcClient();
	const priv = client as unknown as {
		send: (command: { type: string }) => Promise<unknown>;
		getData: <T>(response: unknown) => T;
	};
	const send = vi.fn<(command: { type: string }) => Promise<unknown>>(async () => ({
		type: "response",
		command: "ok",
		success: true,
	}));
	priv.send = send;
	priv.getData = <T>(response: unknown): T => (response as { data: T }).data;
	return { client, send };
}

describe("RpcClient appendEntry", () => {
	it("sends append_entry with customType/data", async () => {
		const { client, send } = mockClient();
		await client.appendEntry({
			customType: "character_backlog",
			data: { since: "entry-1", segments: 3 },
		});
		expect(send).toHaveBeenCalledWith({
			type: "append_entry",
			customType: "character_backlog",
			data: { since: "entry-1", segments: 3 },
		});
	});

	it("omits optional data when not provided", async () => {
		const { client, send } = mockClient();
		await client.appendEntry({ customType: "party_ack" });
		expect(send).toHaveBeenCalledWith({ type: "append_entry", customType: "party_ack" });
	});

	it("resolves the persisted entry id from the response", async () => {
		const { client, send } = mockClient();
		send.mockResolvedValueOnce({
			type: "response",
			command: "append_entry",
			success: true,
			data: { entryId: "entry-42" },
		});
		const result = await client.appendEntry({ customType: "party_ack", data: { at: 1 } });
		expect(result).toEqual({ entryId: "entry-42" });
	});
});

describe("append_entry 服务端持久化语义（SessionManager）", () => {
	it("appends a custom entry to the current active leaf and returns the entry id", () => {
		const sm = SessionManager.inMemory();
		const entryId = sm.appendCustomEntry("party_ack", { at: 123 });
		expect(entryId).toBeTruthy();
		expect(sm.getLeafId()).toBe(entryId);
		const entry = sm.getEntry(entryId);
		expect(entry?.type).toBe("custom");
		if (entry?.type === "custom") {
			expect(entry.customType).toBe("party_ack");
			expect(entry.data).toEqual({ at: 123 });
		}
	});

	it("appends as a child of the current leaf (append-only at active leaf)", () => {
		const sm = SessionManager.inMemory();
		sm.appendMessage({ role: "user", content: "玩家输入" });
		const leafBefore = sm.getLeafId();
		const entryId = sm.appendCustomEntry("party_ack", {});
		expect(sm.getLeafId()).toBe(entryId);
		const entry = sm.getEntry(entryId);
		expect(entry?.parentId).toBe(leafBefore);
	});

	it("custom entry does NOT enter LLM context（与 append_message 的关键差异）", () => {
		const sm = SessionManager.inMemory();
		sm.appendMessage({ role: "user", content: "玩家输入" });
		sm.appendCustomEntry("party_ack", { at: 123 });
		sm.appendCustomEntry("character_backlog", { segments: 3 });
		// 纯 custom entry 是 display/state 条目：buildSessionContext 直接排除
		const ctx = sm.buildSessionContext();
		expect(ctx.messages.map((m) => m.role)).toEqual(["user"]);
		// convertToLlm 后仍然只有玩家输入（custom 条目不进 LLM 上下文）
		const llm = convertToLlm(ctx.messages);
		expect(llm.map((m) => m.role)).toEqual(["user"]);
		const text = typeof llm[0].content === "string" ? llm[0].content : JSON.stringify(llm[0].content);
		expect(text).toContain("玩家输入");
	});

	it("custom entries remain readable via getEntries for extension state reconstruction", () => {
		const sm = SessionManager.inMemory();
		sm.appendCustomEntry("party_ack", { at: 1 });
		sm.appendCustomEntry("character_backlog", { segments: 3 });
		const entries = sm.getEntries();
		const customs = entries.filter((e) => e.type === "custom");
		expect(customs.map((e) => (e as { customType: string }).customType)).toEqual(["party_ack", "character_backlog"]);
	});
});
