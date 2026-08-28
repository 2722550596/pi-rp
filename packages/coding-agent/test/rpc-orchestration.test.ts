// orchestration_request/response（pass_mic 编排）协议级单测。
// 不 spawn 真实 cli 子进程（dist 在 CI 不构建）：客户端侧 mock send / 直驱 handleLine，
// 扩展能力侧直接构造 ExtensionRunner。子进程级 orchestration_response 分发走 rpc-mode 的
// handleParentOrchestrationResponse seam（解析挂起 promise + 回发 ack）。

import { describe, expect, it, type Mock, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createExtensionRuntime } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";
import { handleParentOrchestrationResponse, type RpcOrchestrationAckData } from "../src/modes/rpc/rpc-mode.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

type RpcClientPrivate = {
	send: (command: { type: string }) => Promise<unknown>;
	handleLine: (line: string) => void;
};

function mockClient(): { client: RpcClient; send: Mock; handleLine: (line: string) => void } {
	const client = new RpcClient();
	const priv = client as unknown as RpcClientPrivate;
	const send = vi.fn(async () => ({ type: "response", command: "ok", success: true }));
	priv.send = send;
	const handleLine = priv.handleLine.bind(client);
	return { client, send, handleLine };
}

/** 等一轮 microtask（respond* 走异步 send）。 */
function flushMicrotasks(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}

describe("RpcClient orchestration commands", () => {
	it("respondOrchestrationRequest sends orchestration_response with ack", async () => {
		const { client, send } = mockClient();
		await client.respondOrchestrationRequest("r1", { status: "approved" });
		expect(send).toHaveBeenCalledWith({
			type: "orchestration_response",
			requestId: "r1",
			ack: { status: "approved" },
		});
	});

	it("handleLine dispatches orchestration_request to onOrchestrationRequest listeners", () => {
		const { client, handleLine } = mockClient();
		const listener = vi.fn();
		const unsub = client.onOrchestrationRequest(listener);
		handleLine(
			JSON.stringify({ type: "orchestration_request", requestId: "r1", kind: "pass_mic", from: "A", target: "B" }),
		);
		expect(listener).toHaveBeenCalledWith({
			type: "orchestration_request",
			requestId: "r1",
			kind: "pass_mic",
			from: "A",
			target: "B",
		});
		unsub();
		handleLine(
			JSON.stringify({
				type: "orchestration_request",
				requestId: "r2",
				kind: "pass_mic",
				from: "A",
				target: "player",
			}),
		);
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it("auto-responds with error ack when no listener (child fails fast, no timeout)", async () => {
		const { handleLine, send } = mockClient();
		handleLine(
			JSON.stringify({ type: "orchestration_request", requestId: "r1", kind: "pass_mic", from: "A", target: "B" }),
		);
		await flushMicrotasks();
		expect(send).toHaveBeenCalledWith({
			type: "orchestration_response",
			requestId: "r1",
			ack: { status: "error", error: expect.stringContaining("no onOrchestrationRequest") },
		});
	});

	it("auto-responds with error ack when listener throws", async () => {
		const { client, handleLine, send } = mockClient();
		client.onOrchestrationRequest(() => {
			throw new Error("handler boom");
		});
		handleLine(
			JSON.stringify({ type: "orchestration_request", requestId: "r1", kind: "pass_mic", from: "A", target: "B" }),
		);
		await flushMicrotasks();
		expect(send).toHaveBeenCalledWith({
			type: "orchestration_response",
			requestId: "r1",
			ack: { status: "error", error: "handler boom" },
		});
	});
});

describe("ExtensionRunner orchestrationRequest binding", () => {
	it("未绑定 → ctx.requestOrchestration 为 undefined；绑定后按 getter 暴露", async () => {
		const sessionManager = SessionManager.inMemory();
		const registry = await createInMemoryModelRegistry(AuthStorage.inMemory());
		const runner = new ExtensionRunner(
			[],
			createExtensionRuntime(),
			process.cwd(),
			sessionManager,
			registry,
			SettingsManager.inMemory(),
		);

		expect(runner.createContext().requestOrchestration).toBeUndefined();

		const fn = async (_request: { kind: "pass_mic"; from: string; target: string }) => {
			return { ack: { status: "approved" as const } };
		};
		runner.setOrchestrationRequest(fn);
		expect(runner.createContext().requestOrchestration).toBe(fn);
	});
});

describe("handleParentOrchestrationResponse（子进程侧 ack seam）", () => {
	type PendingEntry = { resolve: (value: RpcOrchestrationAckData) => void; reject: (error: Error) => void };
	type PendingMap = Map<string, PendingEntry>;
	function makePending(): {
		pending: PendingMap;
		resolve: Mock;
		reject: Mock;
	} {
		const pending: PendingMap = new Map();
		const resolve = vi.fn();
		const reject = vi.fn();
		pending.set("req-1", { resolve, reject });
		return { pending, resolve, reject };
	}

	it("解析挂起的 requestOrchestration 并回发声明的 success ack（不回 ack 父侧 send() 挂 30s）", () => {
		const { pending, resolve, reject } = makePending();
		const emitted: unknown[] = [];
		handleParentOrchestrationResponse(
			{ id: "req_7", type: "orchestration_response", requestId: "req-1", ack: { status: "approved" } },
			pending,
			(o) => emitted.push(o),
		);
		expect(resolve).toHaveBeenCalledWith({ ack: { status: "approved" } });
		expect(reject).not.toHaveBeenCalled();
		expect(pending.has("req-1")).toBe(false);
		expect(emitted).toEqual([{ id: "req_7", type: "response", command: "orchestration_response", success: true }]);
	});

	it("error ack 是正常裁决载荷 → resolve（不 reject），由调用方按 ack 分支", () => {
		const { pending, resolve, reject } = makePending();
		const emitted: unknown[] = [];
		handleParentOrchestrationResponse(
			{
				id: "req_8",
				type: "orchestration_response",
				requestId: "req-1",
				ack: { status: "error", error: "empty prose" },
			},
			pending,
			(o) => emitted.push(o),
		);
		expect(resolve).toHaveBeenCalledWith({ ack: { status: "error", error: "empty prose" } });
		expect(reject).not.toHaveBeenCalled();
		expect(emitted).toEqual([{ id: "req_8", type: "response", command: "orchestration_response", success: true }]);
	});

	it("缺 ack 字段 → reject 挂起请求（传输层异常），且照常回 ack", () => {
		const { pending, resolve, reject } = makePending();
		const emitted: unknown[] = [];
		handleParentOrchestrationResponse(
			{ id: "req_9", type: "orchestration_response", requestId: "req-1" },
			pending,
			(o) => emitted.push(o),
		);
		expect(reject).toHaveBeenCalledWith(new Error("orchestration_response missing ack"));
		expect(resolve).not.toHaveBeenCalled();
		expect(emitted).toEqual([{ id: "req_9", type: "response", command: "orchestration_response", success: true }]);
	});

	it("requestId 未知 → 无 promise 可解析，但仍回 ack（父侧总是在等待）", () => {
		const { pending } = makePending();
		const emitted: unknown[] = [];
		handleParentOrchestrationResponse(
			{ id: "req_10", type: "orchestration_response", requestId: "no-such-request", ack: { status: "blocked" } },
			pending,
			(o) => emitted.push(o),
		);
		expect(pending.has("req-1")).toBe(true); // 挂起的 req-1 不受影响
		expect(emitted).toEqual([{ id: "req_10", type: "response", command: "orchestration_response", success: true }]);
	});

	it("非对象输入 → 静默忽略（不 ack 不解析）", () => {
		const { pending } = makePending();
		const emitted: unknown[] = [];
		handleParentOrchestrationResponse("garbage", pending, (o) => emitted.push(o));
		expect(pending.has("req-1")).toBe(true);
		expect(emitted).toEqual([]);
	});
});
