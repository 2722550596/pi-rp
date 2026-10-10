import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createWebSocketListener } from "./listener.ts";

const listeners: Array<ReturnType<typeof createWebSocketListener>> = [];
const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(listeners.splice(0).map((listener) => listener.close()));
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
function listener(options: Partial<Parameters<typeof createWebSocketListener>[0]> = {}) {
	const value = createWebSocketListener({ host: "127.0.0.1", port: 0, token: "secret-token", ...options });
	listeners.push(value);
	return value;
}
async function start(value: ReturnType<typeof createWebSocketListener>): Promise<number> {
	await value.start(() => ({ onData: () => {}, onClose: () => {}, onError: () => {} }));
	return value.boundPort!;
}
function connect(port: number, path: string): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
		ws.once("open", () => resolve(ws));
		ws.once("unexpected-response", (_request, response) => {
			response.resume();
			reject(new Error(String(response.statusCode)));
		});
		ws.once("error", reject);
	});
}
describe("WebSocket listener", () => {
	it("authenticates token paths before upgrade", async () => {
		const port = await start(listener());
		for (const [path, status] of [
			["/ws/wrong-token", "401"],
			["/ws/secret-token/extra", "404"],
			["/other", "404"],
		])
			await expect(connect(port, path)).rejects.toThrow(status);
		const ws = await connect(port, "/ws/secret-token");
		ws.close();
	});
	it("round-trips binary data and rejects text frames", async () => {
		let received: Uint8Array | undefined;
		const value = listener();
		await value.start((connection) => ({
			onData: (chunk) => {
				received = chunk;
				void connection.send(chunk);
			},
			onClose: () => {},
			onError: () => {},
		}));
		const ws = await connect(value.boundPort!, "/ws/secret-token");
		const result = new Promise<Uint8Array>((resolve) =>
			ws.once("message", (data) => resolve(new Uint8Array(data as Buffer))),
		);
		ws.send(Uint8Array.of(1, 2, 3), { binary: true });
		expect([...(await result)]).toEqual([1, 2, 3]);
		const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
		ws.send("not binary");
		await closed;
		expect(received).toEqual(Uint8Array.of(1, 2, 3));
	});
	it("serves static files with MIME and ETag and refuses traversal", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-ws-"));
		dirs.push(dir);
		await writeFile(join(dir, "index.html"), "hello");
		await writeFile(join(dir, "app.js"), "code");
		const port = await start(listener({ staticDir: dir }));
		const index = await fetch(`http://127.0.0.1:${port}/`);
		expect(await index.text()).toBe("hello");
		expect(index.headers.get("content-type")).toContain("text/html");
		const etag = index.headers.get("etag")!;
		expect((await fetch(`http://127.0.0.1:${port}/`, { headers: { "If-None-Match": etag } })).status).toBe(304);
		expect((await fetch(`http://127.0.0.1:${port}/app.js`)).headers.get("content-type")).toContain("text/javascript");
		expect((await fetch(`http://127.0.0.1:${port}/%2e%2e/secret`)).status).toBe(404);
	});
	it("closes idempotently and releases its port", async () => {
		const value = listener();
		const port = await start(value);
		await Promise.all([value.close(), value.close()]);
		const server = createHttpServer();
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(port, "127.0.0.1", resolve);
		});
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	});
});
