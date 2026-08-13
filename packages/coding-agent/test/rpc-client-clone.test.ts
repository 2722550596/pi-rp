import { describe, expect, it, vi } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

type RpcClientPrivate = {
	send: (command: { type: string }) => Promise<unknown>;
	getData: <T>(response: unknown) => T;
};

describe("RpcClient clone", () => {
	it("sends the clone RPC command", async () => {
		const client = new RpcClient();
		const privateClient = client as unknown as RpcClientPrivate;
		const send = vi.fn(async () => ({
			type: "response",
			command: "clone",
			success: true,
			data: { cancelled: false },
		}));
		privateClient.send = send;
		privateClient.getData = <T>(response: unknown): T => {
			return (response as { data: T }).data;
		};

		const result = await client.clone();

		expect(send).toHaveBeenCalledWith({ type: "clone" });
		expect(result).toEqual({ cancelled: false });
	});
});

describe("RpcClient watchState", () => {
	// Test seam: exercise the private handleLine line parser directly (bound so
	// `this` stays the client instance).
	const handleLineOf = (client: RpcClient): ((line: string) => void) =>
		(client as unknown as { handleLine: (line: string) => void }).handleLine.bind(client);

	it("delivers the initial push, registers, and unsubscribes", async () => {
		const client = new RpcClient();
		const privateClient = client as unknown as RpcClientPrivate;
		const send = vi.fn(async () => ({
			type: "response",
			command: "watch_state",
			success: true,
			data: { stateRevision: 7, path: "world", value: { hp: 10 } },
		}));
		privateClient.send = send;
		privateClient.getData = <T>(response: unknown): T => {
			return (response as { data: T }).data;
		};

		const received: unknown[] = [];
		const unsubscribe = await client.watchState((event) => received.push(event), { path: "world" });
		const handleLine = handleLineOf(client);

		expect(send).toHaveBeenCalledWith({ type: "watch_state", path: "world", ifVersion: undefined });
		expect(received).toEqual([{ type: "state_changed", stateRevision: 7, path: "world", value: { hp: 10 } }]);

		// Stale push (same revision) → deduped by stateRevision.
		handleLine(JSON.stringify({ type: "state_changed", stateRevision: 7, path: "world", value: { hp: 10 } }));
		expect(received.length).toBe(1);

		// New revision → delivered.
		handleLine(JSON.stringify({ type: "state_changed", stateRevision: 8, path: "world", value: { hp: 11 } }));
		expect(received.length).toBe(2);
		expect(received[1]).toEqual({ type: "state_changed", stateRevision: 8, path: "world", value: { hp: 11 } });

		// Unsubscribed → further pushes ignored.
		unsubscribe();
		handleLine(JSON.stringify({ type: "state_changed", stateRevision: 9, path: "world", value: { hp: 12 } }));
		expect(received.length).toBe(2);
	});

	it("does not dispatch state_changed to generic event listeners", () => {
		const client = new RpcClient();
		const handleLine = handleLineOf(client);
		const listener = vi.fn();
		client.onEvent(listener);

		handleLine(JSON.stringify({ type: "state_changed", stateRevision: 1, value: {} }));
		expect(listener).not.toHaveBeenCalled();
	});
});
