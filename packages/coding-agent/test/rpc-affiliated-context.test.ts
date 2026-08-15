// affiliated-session A/B（init_context + context_request/response）协议级单测。
// 不 spawn 真实 cli 子进程（dist 在 CI 不构建）：客户端侧 mock send / 直驱 handleLine，
// 扩展能力侧直接构造 ExtensionRunner。子进程级 context_response 分发走 rpc-mode 的
// handleParentContextResponse seam（解析挂起 promise + 回发 ack）；init_context
// handler 由本地活体验证覆盖。

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createExtensionRuntime } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";
import { handleParentContextResponse, type RpcContextResponseData } from "../src/modes/rpc/rpc-mode.ts";
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

describe("handleParentContextResponse（子进程侧 ack seam）", () => {
	type PendingEntry = { resolve: (value: RpcContextResponseData) => void; reject: (error: Error) => void };
	type PendingMap = Map<string, PendingEntry>;
	function makePending(): {
		pending: PendingMap;
		resolve: (value: RpcContextResponseData) => void;
		reject: (error: Error) => void;
	} {
		const pending: PendingMap = new Map();
		const resolve = vi.fn<(value: RpcContextResponseData) => void>();
		const reject = vi.fn<(error: Error) => void>();
		pending.set("req-1", { resolve, reject });
		return { pending, resolve, reject };
	}

	it("解析挂起的 requestParentContext 并回发声明的 success ack（不回 ack 父侧 send() 挂 30s）", () => {
		const { pending, resolve, reject } = makePending();
		const emitted: unknown[] = [];
		handleParentContextResponse(
			{ id: "req_7", type: "context_response", requestId: "req-1", messages: [{ role: "user", content: "hi" }] },
			pending,
			(o) => emitted.push(o),
		);
		expect(resolve).toHaveBeenCalledWith({ messages: [{ role: "user", content: "hi" }], state: undefined });
		expect(reject).not.toHaveBeenCalled();
		expect(pending.has("req-1")).toBe(false);
		expect(emitted).toEqual([{ id: "req_7", type: "response", command: "context_response", success: true }]);
	});

	it("error 载荷 → reject 挂起请求，且照常回 ack", () => {
		const { pending, resolve, reject } = makePending();
		const emitted: unknown[] = [];
		handleParentContextResponse(
			{ id: "req_8", type: "context_response", requestId: "req-1", error: "since anchor gone" },
			pending,
			(o) => emitted.push(o),
		);
		expect(reject).toHaveBeenCalledWith(new Error("since anchor gone"));
		expect(resolve).not.toHaveBeenCalled();
		expect(emitted).toEqual([{ id: "req_8", type: "response", command: "context_response", success: true }]);
	});

	it("requestId 未知 → 无 promise 可解析，但仍回 ack（父侧总是在等待）", () => {
		const { pending } = makePending();
		const emitted: unknown[] = [];
		handleParentContextResponse(
			{ id: "req_9", type: "context_response", requestId: "no-such-request" },
			pending,
			(o) => emitted.push(o),
		);
		expect(pending.has("req-1")).toBe(true); // 挂起的 req-1 不受影响
		expect(emitted).toEqual([{ id: "req_9", type: "response", command: "context_response", success: true }]);
	});

	it("非对象输入 → 静默忽略（不 ack 不解析）", () => {
		const { pending } = makePending();
		const emitted: unknown[] = [];
		handleParentContextResponse("garbage", pending, (o) => emitted.push(o));
		expect(pending.has("req-1")).toBe(true);
		expect(emitted).toEqual([]);
	});
});
