import { createInterface } from "node:readline";

console.error("stdio fixture ready");
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of lines) {
	const message = JSON.parse(line);
	if (!("id" in message)) continue;
	let result;
	if (message.method === "initialize") {
		result = {
			protocolVersion: "2025-06-18",
			capabilities: { tools: {} },
			serverInfo: { name: "stdio-fixture", version: "1.0.0" },
		};
	} else if (message.method === "tools/list") {
		result = {
			tools: [
				{ name: "echo", inputSchema: { type: "object" } },
				{ name: "get-env", inputSchema: { type: "object" } },
			],
		};
	} else if (message.method === "tools/call") {
		const args = message.params.arguments ?? {};
		const text =
			message.params.name === "get-env"
				? (process.env[String(args.key)] ?? "<unset>")
				: String(args.text);
		result = { content: [{ type: "text", text }] };
	} else if (message.method === "ping") {
		result = {};
	} else {
		process.stdout.write(
			`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "not found" } })}\n`,
		);
		continue;
	}
	const response = `${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`;
	const split = Math.floor(response.length / 2);
	process.stdout.write(response.slice(0, split));
	await new Promise((resolve) => setImmediate(resolve));
	process.stdout.write(response.slice(split));
}
