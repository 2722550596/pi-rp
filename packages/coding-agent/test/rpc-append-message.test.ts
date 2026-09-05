// append_message 协议级单测（角色 session 记忆写入的地基能力）。
// 不 spawn 真实 cli 子进程（dist 在 CI 不构建）：客户端侧 mock send 验证
// 命令形状与 entryId 解析；服务端持久化语义直接构造 SessionManager 验证
// （追加到当前 active leaf、返回 entry id、custom message 以 user 角色进入
// LLM 上下文——角色子进程 --no-extensions 也能读取 cast_profile 的依据）。

import type { Mock } from "vitest";
import { describe, expect, it, vi } from "vitest";
import { convertToLlm } from "../src/core/messages.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";
import { createTestSession } from "./utilities.ts";

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

describe("RpcClient appendMessage", () => {
	it("sends append_message with customType/content/display/details", async () => {
		const { client, send } = mockClient();
		await client.appendMessage({
			customType: "cast_profile",
			content: "# 你的角色设定\n\n{{角色卡正文}}",
			display: false,
			details: { cast_def_entry_id: "def-1" },
		});
		expect(send).toHaveBeenCalledWith({
			type: "append_message",
			customType: "cast_profile",
			content: "# 你的角色设定\n\n{{角色卡正文}}",
			display: false,
			details: { cast_def_entry_id: "def-1" },
		});
	});

	it("omits optional display/details when not provided", async () => {
		const { client, send } = mockClient();
		await client.appendMessage({ customType: "cast_profile", content: "人设" });
		expect(send).toHaveBeenCalledWith({
			type: "append_message",
			customType: "cast_profile",
			content: "人设",
		});
	});

	it("resolves the persisted entry id from the response", async () => {
		const { client, send } = mockClient();
		send.mockResolvedValueOnce({
			type: "response",
			command: "append_message",
			success: true,
			data: { entryId: "entry-42" },
		});
		const result = await client.appendMessage({ customType: "cast_profile", content: "人设" });
		expect(result).toEqual({ entryId: "entry-42" });
	});
});

describe("append_message 服务端持久化语义（SessionManager）", () => {
	it("appends to the current active leaf and returns the entry id", () => {
		const sm = SessionManager.inMemory();
		const entryId = sm.appendCustomMessageEntry("cast_profile", "人设", false, { cast_def_entry_id: "def-1" });
		expect(entryId).toBeTruthy();
		expect(sm.getLeafId()).toBe(entryId);
		const entry = sm.getEntry(entryId);
		expect(entry?.type).toBe("custom_message");
		if (entry?.type === "custom_message") {
			expect(entry.customType).toBe("cast_profile");
			expect(entry.details).toEqual({ cast_def_entry_id: "def-1" });
		}
	});

	it("appends as a child of the current leaf (append-only at active leaf)", () => {
		const sm = SessionManager.inMemory();
		sm.appendMessage({ role: "user", content: "玩家输入" });
		const leafBefore = sm.getLeafId();
		const entryId = sm.appendCustomMessageEntry("background", "situation", false, {});
		expect(sm.getLeafId()).toBe(entryId);
		const entry = sm.getEntry(entryId);
		expect(entry?.parentId).toBe(leafBefore);
	});

	it("custom message enters LLM context as a user message (default policy)", () => {
		const sm = SessionManager.inMemory();
		sm.appendMessage({ role: "user", content: "玩家输入" });
		sm.appendCustomMessageEntry("cast_profile", "人设正文", false, {});
		// buildSessionContext 层 role 为 "custom"；默认 custom message 语义在
		// convertToLlm 处转成 user 消息进入 LLM 上下文（角色子进程 --no-extensions
		// 也能读取 cast_profile 的依据）。
		const ctx = sm.buildSessionContext();
		const last = ctx.messages[ctx.messages.length - 1];
		expect(last.role).toBe("custom");
		const llm = convertToLlm(ctx.messages);
		const llmLast = llm[llm.length - 1];
		expect(llmLast.role).toBe("user");
		const text = typeof llmLast.content === "string" ? llmLast.content : JSON.stringify(llmLast.content);
		expect(text).toContain("人设正文");
	});
});

describe("navigateTree no-op 分支重放 agent state（append_message 后的角色 session 记忆）", () => {
	it("navigateTree 到当前 leaf 时同步 state.messages，cast_profile 进入上下文", async () => {
		// 场景：角色子进程已通过 append_message 写入 cast_profile（append 推进
		// leaf 到该条目，但不触碰 agent state）；随后作家调用 navigateTree 到
		// 该条目（target === oldLeaf，走 no-op 分支）作为「重放上下文」信号。
		// 修复前 no-op 分支直接返回，agent.state.messages 保持空，prompt 时
		// cast_profile 不在 payload 里（两个角色收到相同上下文、丢人设）。
		const { session, sessionManager, cleanup } = await createTestSession({ inMemory: true });
		try {
			// 构造：user 消息 → cast_profile custom message（leaf 推进到 cast_profile）
			sessionManager.appendMessage({ role: "user", content: "玩家输入" });
			const profileId = sessionManager.appendCustomMessageEntry(
				"cast_profile",
				"# 你的角色设定\n\n圣玛格丽特超能高中的学生会副会长。",
				false,
				{ cast_def_entry_id: "def-1" },
			);
			expect(sessionManager.getLeafId()).toBe(profileId);

			// navigateTree 到当前 leaf（no-op 分支）：修复后应重放 session 上下文
			const result = await session.navigateTree(profileId, { summarize: false });
			expect(result.cancelled).toBe(false);

			const messages = session.agent.state.messages;
			// 修复前为 0 条（no-op 短路，未重放）；修复后包含 user + cast_profile
			expect(messages.length).toBeGreaterThanOrEqual(2);
			const profile = messages.find((m) => m.role === "custom" && m.customType === "cast_profile");
			expect(profile).toBeDefined();
			const text = typeof profile?.content === "string" ? profile.content : JSON.stringify(profile?.content);
			expect(text).toContain("学生会副会长");
		} finally {
			cleanup();
		}
	}, 30000);
});
