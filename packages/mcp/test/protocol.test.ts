import { describe, expect, it } from "vitest";
import { isJsonRpcNotification, isJsonRpcRequest, isJsonRpcResponse, parseJsonRpcMessage } from "../src/index.ts";

describe("JSON-RPC message parsing", () => {
	it("routes valid requests, notifications, and responses by message shape", () => {
		const request = { jsonrpc: "2.0", id: "request-1", method: "tools/call", params: { name: "echo" } };
		const notification = { jsonrpc: "2.0", method: "notifications/initialized" };
		const response = { jsonrpc: "2.0", id: "request-1", result: { content: [] } };

		expect(isJsonRpcRequest(request)).toBe(true);
		expect(isJsonRpcNotification(notification)).toBe(true);
		expect(isJsonRpcResponse(response)).toBe(true);
		expect(parseJsonRpcMessage(request)).toEqual(request);
		expect(parseJsonRpcMessage(notification)).toEqual(notification);
		expect(parseJsonRpcMessage(response)).toEqual(response);
	});

	it("rejects invalid versions, IDs, and ambiguous response bodies", () => {
		const invalidMessages: unknown[] = [
			{ jsonrpc: "1.0", id: 1, method: "ping" },
			{ jsonrpc: "2.0", id: {}, method: "ping" },
			{ jsonrpc: "2.0", id: 1, result: {}, error: { code: -1, message: "ambiguous" } },
		];

		for (const message of invalidMessages) {
			expect(() => parseJsonRpcMessage(message)).toThrow("Invalid JSON-RPC message");
		}
	});
});
