import { describe, expect, it, vi } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

type PendingEntry = { resolve: (response: unknown) => void; reject: (error: Error) => void };
type RpcClientPrivate = {
	handleLine: (line: string) => void;
	pendingRequests: Map<string, PendingEntry>;
};

const privateOf = (client: RpcClient): RpcClientPrivate => client as unknown as RpcClientPrivate;

describe("RpcClient late responses", () => {
	it("resolves a pending request and never forwards it to event listeners", () => {
		const client = new RpcClient();
		const p = privateOf(client);
		const resolve = vi.fn();
		const reject = vi.fn();
		p.pendingRequests.set("req_1", { resolve, reject });

		const listener = vi.fn();
		client.onEvent(listener);

		p.handleLine(JSON.stringify({ type: "response", id: "req_1", command: "prompt", success: true }));

		expect(resolve).toHaveBeenCalledTimes(1);
		expect(reject).not.toHaveBeenCalled();
		expect(p.pendingRequests.has("req_1")).toBe(false);
		expect(listener).not.toHaveBeenCalled();
	});

	it("drops a response whose id is no longer pending instead of emitting it as an event", () => {
		// A reply to a request that already timed out: `send()` removed the entry
		// when its timer fired. It must not reach generic event listeners.
		const client = new RpcClient();
		const p = privateOf(client);

		const listener = vi.fn();
		client.onEvent(listener);

		p.handleLine(JSON.stringify({ type: "response", id: "req_gone", command: "prompt", success: true }));

		expect(listener).not.toHaveBeenCalled();
	});

	it("still delivers real events to event listeners", () => {
		const client = new RpcClient();
		const p = privateOf(client);

		const listener = vi.fn();
		client.onEvent(listener);

		p.handleLine(JSON.stringify({ type: "agent_settled" }));

		expect(listener).toHaveBeenCalledTimes(1);
		expect(listener).toHaveBeenCalledWith({ type: "agent_settled" });
	});
});
