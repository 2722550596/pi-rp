// affiliated-session A/B（init_context + context_request/response）协议级单测。
// 不 spawn 真实 cli 子进程（dist 在 CI 不构建）：客户端侧 mock send / 直驱 handleLine，
// 扩展能力侧直接构造 ExtensionRunner。子进程级行为（init_context handler /
// context_response 分发）由本地活体验证覆盖（rpc-mode 闭包无单测 seam）。

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createExtensionRuntime } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

type RpcClientPrivate = {
	send: (command: { type: string }) => Promise<unknown>;
	getData: <T>(response: unknown) => T;
	handleLine: (line: string) => void;
};

function mockClient(): { client: RpcClient; send: ReturnType<typeof vi.fn>; handleLine: (line: string) => void } {
	const client = new RpcClient();
	const priv = client as unknown as RpcClientPrivate;
	const send = vi.fn(async () => ({ type: "response", command: "ok", success: true }));
	priv.send = send;
	priv.getData = <T>(response: unknown): T => (response as { data: T }).data;
	const handleLine = priv.handleLine.bind(client);
	return { client, send, handleLine };
}

describe("RpcClient affiliated-session commands", () => {
	it("initContext sends init_context with history and state", async () => {
		const { client, send } = mockClient();
		const history = [{ role: "user", content: "继承的历史" }] as unknown as AgentMessage[];
		await client.initContext(history, { world: { a: 1 } });
		expect(send).toHaveBeenCalledWith({
			type: "init_context",
			history,
			state: { world: { a: 1 } },
		});
	});

	it("respondContextRequest sends context_response", async () => {
		const { client, send } = mockClient();
		await client.respondContextRequest("r1", {
			messages: [{ role: "user", content: "过滤后的上下文" }],
			state: { world: { b: 2 } },
		});
		expect(send).toHaveBeenCalledWith({
			type: "context_response",
			requestId: "r1",
			messages: [{ role: "user", content: "过滤后的上下文" }],
			state: { world: { b: 2 } },
		});
	});

	it("handleLine dispatches context_request to onContextRequest listeners", () => {
		const { client, handleLine } = mockClient();
		const listener = vi.fn();
		const unsub = client.onContextRequest(listener);
		handleLine(
			JSON.stringify({ type: "context_request", requestId: "r1", since: "anchor-1", namespaces: ["world"] }),
		);
		expect(listener).toHaveBeenCalledWith({
			type: "context_request",
			requestId: "r1",
			since: "anchor-1",
			namespaces: ["world"],
		});
		unsub();
		handleLine(JSON.stringify({ type: "context_request", requestId: "r2" }));
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it("auto-responds with error when no listener (child fails fast, no timeout)", async () => {
		const { handleLine, send } = mockClient();
		handleLine(JSON.stringify({ type: "context_request", requestId: "r1" }));
		// respondContextRequest 走异步 send，等一轮 microtask
		await new Promise((resolve) => setImmediate(resolve));
		expect(send).toHaveBeenCalledWith({
			type: "context_response",
			requestId: "r1",
			error: expect.stringContaining("no onContextRequest"),
		});
	});

	it("auto-responds with error when listener throws", async () => {
		const { client, handleLine, send } = mockClient();
		client.onContextRequest(() => {
			throw new Error("handler boom");
		});
		handleLine(JSON.stringify({ type: "context_request", requestId: "r1" }));
		await new Promise((resolve) => setImmediate(resolve));
		expect(send).toHaveBeenCalledWith({
			type: "context_response",
			requestId: "r1",
			error: "handler boom",
		});
	});
});

describe("ExtensionRunner parentContextRequest binding", () => {
	it("未绑定 → ctx.requestParentContext 为 undefined；绑定后按 getter 暴露", async () => {
		const sessionManager = SessionManager.inMemory();
		const registry = await createInMemoryModelRegistry(AuthStorage.inMemory());
		const runner = new ExtensionRunner([], createExtensionRuntime(), process.cwd(), sessionManager, registry);

		expect(runner.createContext().requestParentContext).toBeUndefined();

		const fn = async (request: { since?: string; namespaces?: string[] }) => {
			return { messages: [{ role: "user", content: request.since ?? "" }] };
		};
		runner.setParentContextRequest(fn);
		expect(runner.createContext().requestParentContext).toBe(fn);
	});
});
