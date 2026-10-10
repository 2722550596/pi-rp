import { createHash, timingSafeEqual } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { Duplex } from "node:stream";
import { DEFAULT_MAX_FRAME_LENGTH } from "@earendil-works/pi-protocol";
import { type RawData, WebSocket, WebSocketServer } from "ws";
import type { ByteConnection, ByteConnectionAcceptor, ByteConnectionHandler } from "../../connection.ts";
import type { PiServerListener } from "../../listener.ts";
import type { WebSocketListenerOptions } from "./types.ts";

const DEFAULT_GRACEFUL_CLOSE_TIMEOUT_MS = 5_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MIME_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".wasm": "application/wasm",
	".map": "application/json",
};
interface ResolvedOptions {
	host: string;
	port: number;
	token: Buffer;
	staticDir?: string;
	maxPendingBytes: number;
	gracefulCloseTimeoutMs: number;
	maxFrameLength: number;
	onError?: (error: Error) => void;
}

class WebSocketListener implements PiServerListener {
	private readonly options: ResolvedOptions;
	private readonly wss = new WebSocketServer({ noServer: true, maxPayload: DEFAULT_MAX_FRAME_LENGTH });
	private readonly connections = new Set<WebSocketByteConnection>();
	private readonly httpSockets = new Set<Duplex>();
	private server?: Server;
	private accept?: ByteConnectionAcceptor;
	private closing = false;
	private closePromise?: Promise<void>;
	private boundPortValue?: number;
	constructor(options: ResolvedOptions) {
		this.options = options;
		this.wss.on("error", (error) => this.reportError(error));
	}
	get boundPort(): number | undefined {
		return this.boundPortValue;
	}
	get address(): string | undefined {
		if (this.boundPortValue === undefined) return undefined;
		const host =
			this.options.host.includes(":") && !this.options.host.startsWith("[")
				? `[${this.options.host}]`
				: this.options.host;
		return `http://${host}:${this.boundPortValue}`;
	}
	async start(accept: ByteConnectionAcceptor): Promise<void> {
		if (this.server) throw new Error("WebSocket listener is already started");
		if (this.closing) throw new Error("WebSocket listener is closing or closed");
		this.accept = accept;
		const server = createServer((request, response) => void this.handleRequest(request, response));
		this.server = server;
		server.on("connection", (socket) => {
			this.httpSockets.add(socket);
			socket.once("close", () => this.httpSockets.delete(socket));
		});
		server.on("error", (error) => this.reportError(error));
		server.on("upgrade", (request, socket, head) => {
			if (this.closing) {
				socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
				return;
			}
			const pathname = parsePathname(request.url);
			const match = pathname?.match(/^\/ws\/([^/]+)$/);
			if (request.method !== "GET" || !match) {
				socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
				return;
			}
			let candidate: Buffer;
			try {
				candidate = Buffer.from(decodeURIComponent(match[1]!), "utf8");
			} catch {
				socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
				return;
			}
			if (candidate.length !== this.options.token.length || !timingSafeEqual(candidate, this.options.token)) {
				socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
				return;
			}
			// Once upgraded, the socket's lifetime belongs to the ws connection; keeping it in
			// httpSockets would make close() destroy the TCP socket mid close-handshake (clients see 1006).
			this.httpSockets.delete(socket);
			this.wss.handleUpgrade(request, socket, head, (ws) => this.acceptWebSocket(ws));
		});
		try {
			await new Promise<void>((resolvePromise, reject) => {
				const onError = (error: Error) => {
					server.off("listening", onListening);
					reject(error);
				};
				const onListening = () => {
					server.off("error", onError);
					resolvePromise();
				};
				server.once("error", onError);
				server.once("listening", onListening);
				server.listen(this.options.port, this.options.host);
			});
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("WebSocket listener did not bind a TCP address");
			this.boundPortValue = address.port;
		} catch (error) {
			await this.closeServer(server);
			this.server = undefined;
			throw error;
		}
	}
	close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.closing = true;
		this.closePromise = this.closeInternal();
		return this.closePromise;
	}
	private async closeInternal(): Promise<void> {
		this.boundPortValue = undefined;
		const server = this.server;
		if (server) server.close();
		for (const socket of this.httpSockets) socket.destroy();
		// Await the graceful 1001 close handshakes before tearing down the ws server;
		// calling wss.close() first terminates the sockets mid-handshake (clients see 1006).
		const closures = [...this.connections].map((connection) => connection.closeWithCode(1001, "server shutdown"));
		await Promise.all(closures);
		this.wss.close();
		if (server) await closeHttpServer(server);
		this.server = undefined;
		this.connections.clear();
	}
	private async closeServer(server: Server): Promise<void> {
		this.wss.close();
		for (const socket of this.httpSockets) socket.destroy();
		await closeHttpServer(server);
	}
	private acceptWebSocket(ws: WebSocket): void {
		if (this.closing) {
			ws.close(1001, "server shutdown");
			return;
		}
		const connection = new WebSocketByteConnection(
			ws,
			this.options.gracefulCloseTimeoutMs,
			this.options.maxPendingBytes,
		);
		this.connections.add(connection);
		if (!this.accept) {
			void connection.close();
			return;
		}
		let handler: ByteConnectionHandler;
		try {
			handler = this.accept(connection);
		} catch (error) {
			this.reportError(asError(error));
			void connection.close();
			return;
		}
		connection.install(handler, () => this.connections.delete(connection));
	}
	private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
		if (this.closing || !this.options.staticDir || (request.method !== "GET" && request.method !== "HEAD")) {
			response.writeHead(404).end();
			return;
		}
		try {
			const pathname = parsePathname(request.url);
			if (pathname === null) {
				response.writeHead(404).end();
				return;
			}
			const decoded = decodeURIComponent(pathname);
			if (decoded.includes("\\") || decoded.includes("\0") || decoded.split("/").some((part) => part === "..")) {
				response.writeHead(404).end();
				return;
			}
			const relPath = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
			const contentType = MIME_TYPES[extname(relPath).toLowerCase()];
			if (!contentType) {
				response.writeHead(404).end();
				return;
			}
			const root = await realpath(this.options.staticDir);
			const candidate = resolve(root, relPath);
			const rel = relative(root, candidate);
			if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
				response.writeHead(404).end();
				return;
			}
			const file = await realpath(candidate);
			const realRel = relative(root, file);
			if (
				realRel === ".." ||
				realRel.startsWith(`..${sep}`) ||
				isAbsolute(realRel) ||
				!(await stat(file)).isFile()
			) {
				response.writeHead(404).end();
				return;
			}
			const contents = await readFile(file);
			const etag = `"${createHash("sha256").update(contents).digest("hex")}"`;
			const headers = { "Content-Type": contentType, "Cache-Control": "no-cache", ETag: etag };
			if (request.headers["if-none-match"]?.split(/\s*,\s*/).includes(etag)) {
				response.writeHead(304, headers).end();
				return;
			}
			response.writeHead(200, { ...headers, "Content-Length": contents.length });
			response.end(request.method === "HEAD" ? undefined : contents);
		} catch {
			if (!response.headersSent) response.writeHead(404).end();
			else response.destroy();
		}
	}
	private reportError(error: unknown): void {
		try {
			this.options.onError?.(asError(error));
		} catch {
			/* observer errors are isolated */
		}
	}
}

class WebSocketByteConnection implements ByteConnection {
	private readonly ws: WebSocket;
	private readonly timeoutMs: number;
	private readonly maxPendingBytes: number;
	private pendingBytes = 0;
	private closedValue = false;
	private closing = false;
	private tail: Promise<void> = Promise.resolve();
	private closePromise?: Promise<void>;
	private handler?: ByteConnectionHandler;
	private onRemoved?: () => void;
	private closeResolver?: () => void;
	private timer?: NodeJS.Timeout;
	constructor(ws: WebSocket, timeoutMs: number, maxPendingBytes: number) {
		this.ws = ws;
		this.timeoutMs = timeoutMs;
		this.maxPendingBytes = maxPendingBytes;
	}
	get closed(): boolean {
		return this.closedValue;
	}
	install(handler: ByteConnectionHandler, onRemoved: () => void): void {
		this.handler = handler;
		this.onRemoved = onRemoved;
		this.ws.on("message", (data, isBinary) => {
			if (this.closedValue) return;
			if (!isBinary) {
				this.reportError(new Error("Text WebSocket frames are not supported"));
				void this.closeWithCode(1002, "binary frames required");
				return;
			}
			try {
				handler.onData(toBytes(data));
			} catch (error) {
				this.reportError(asError(error));
				void this.close();
			}
		});
		this.ws.on("error", (error) => {
			this.reportError(error);
			this.closeValue();
		});
		this.ws.on("close", () => this.closeValue());
	}
	send(chunk: Uint8Array): Promise<void> {
		if (!(chunk instanceof Uint8Array)) return Promise.reject(new TypeError("WebSocket chunks must be Uint8Array"));
		if (this.closedValue || this.closing) return Promise.reject(new Error("WebSocket connection is closed"));
		if (this.pendingBytes + chunk.byteLength > this.maxPendingBytes)
			return Promise.reject(new Error("WebSocket connection exceeded its pending byte limit"));
		const bytes = chunk.slice();
		this.pendingBytes += bytes.byteLength;
		const tracked = this.tail
			.then(() => this.write(bytes))
			.finally(() => {
				this.pendingBytes -= bytes.byteLength;
			});
		this.tail = tracked.catch(() => {});
		return tracked;
	}
	close(finalChunk?: Uint8Array): Promise<void> {
		if (finalChunk !== undefined && !(finalChunk instanceof Uint8Array))
			return Promise.reject(new TypeError("WebSocket final chunk must be Uint8Array"));
		if (this.closePromise) return this.closePromise;
		if (this.closedValue) return Promise.resolve();
		this.closing = true;
		const finalBytes = finalChunk?.slice();
		const { promise, resolve } = Promise.withResolvers<void>();
		this.closePromise = promise;
		this.closeResolver = resolve;
		this.timer = setTimeout(() => {
			this.ws.terminate();
			this.closeValue();
		}, this.timeoutMs);
		this.timer.unref();
		void this.tail.then(async () => {
			try {
				if (finalBytes) await this.write(finalBytes, true);
				if (this.ws.readyState === WebSocket.OPEN) this.ws.close(1000);
				else this.closeValue();
			} catch {
				this.ws.terminate();
				this.closeValue();
			}
		});
		return promise;
	}
	closeWithCode(code: number, reason: string): Promise<void> {
		if (this.closePromise) return this.closePromise;
		if (this.closedValue) return Promise.resolve();
		this.closing = true;
		const { promise, resolve } = Promise.withResolvers<void>();
		this.closePromise = promise;
		this.closeResolver = resolve;
		this.timer = setTimeout(() => {
			this.ws.terminate();
			this.closeValue();
		}, this.timeoutMs);
		this.timer.unref();
		if (this.ws.readyState === WebSocket.OPEN) this.ws.close(code, reason);
		else if (this.ws.readyState !== WebSocket.CLOSED) this.ws.terminate();
		else this.closeValue();
		return promise;
	}
	private write(bytes: Uint8Array, duringClose = false): Promise<void> {
		if (this.closedValue || (!duringClose && this.closing) || this.ws.readyState !== WebSocket.OPEN)
			return Promise.reject(new Error("WebSocket connection is closed"));
		return new Promise<void>((resolvePromise, reject) => {
			try {
				this.ws.send(bytes, { binary: true }, (error) => (error ? reject(error) : resolvePromise()));
			} catch (error) {
				reject(asError(error));
			}
		});
	}
	private reportError(error: Error): void {
		try {
			this.handler?.onError(error);
		} catch {
			/* handler errors are isolated */
		}
	}
	private closeValue(): void {
		if (this.closedValue) return;
		this.closedValue = true;
		this.closing = true;
		clearTimeout(this.timer);
		this.onRemoved?.();
		this.closeResolver?.();
		this.closeResolver = undefined;
		try {
			this.handler?.onClose();
		} catch (error) {
			this.reportError(asError(error));
		}
	}
}
function toBytes(data: RawData): Uint8Array {
	if (Array.isArray(data)) return Buffer.concat(data);
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}
function parsePathname(url: string | undefined): string | null {
	if (!url) return null;
	try {
		return new URL(url, "http://localhost").pathname;
	} catch {
		return null;
	}
}
function resolveOptions(options: WebSocketListenerOptions): ResolvedOptions {
	if (!options.host || typeof options.host !== "string")
		throw new TypeError("WebSocket listener host must not be empty");
	if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)
		throw new TypeError("WebSocket listener port must be between 0 and 65535");
	const token = Buffer.from(options.token, "utf8");
	if (!token.length) throw new TypeError("WebSocket listener token must not be empty");
	const maxFrameLength = options.maxFrameLength ?? DEFAULT_MAX_FRAME_LENGTH;
	const maxPendingBytes = options.maxPendingBytes ?? maxFrameLength * 4;
	const gracefulCloseTimeoutMs = options.gracefulCloseTimeoutMs ?? DEFAULT_GRACEFUL_CLOSE_TIMEOUT_MS;
	for (const [name, value] of [
		["maxFrameLength", maxFrameLength],
		["maxPendingBytes", maxPendingBytes],
		["gracefulCloseTimeoutMs", gracefulCloseTimeoutMs],
	] as const)
		if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMER_DELAY_MS)
			throw new TypeError(`WebSocket ${name} must be a positive safe integer`);
	return {
		host: options.host,
		port: options.port,
		token,
		staticDir: options.staticDir ? resolve(options.staticDir) : undefined,
		maxFrameLength,
		maxPendingBytes,
		gracefulCloseTimeoutMs,
		onError: options.onError,
	};
}
function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
function closeHttpServer(server: Server): Promise<void> {
	return new Promise<void>((resolvePromise, reject) => {
		if (!server.listening) {
			resolvePromise();
			return;
		}
		server.close((error) => (error ? reject(error) : resolvePromise()));
	});
}
export function createWebSocketListener(
	options: WebSocketListenerOptions,
): PiServerListener & { readonly boundPort?: number } {
	return new WebSocketListener(resolveOptions(options));
}
