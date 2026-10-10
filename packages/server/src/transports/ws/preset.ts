import { PiServer } from "../../server.ts";
import type { PiServerService } from "../../types.ts";
import { createWebSocketListener } from "./listener.ts";
import type { WebSocketServerOptions } from "./types.ts";

export function createWebSocketServer(service: PiServerService, options: WebSocketServerOptions): PiServer {
	const listener = createWebSocketListener({
		host: options.host,
		port: options.port,
		token: options.token,
		staticDir: options.staticDir,
		maxFrameLength: options.maxFrameLength,
		maxPendingBytes: options.maxPendingBytes,
		gracefulCloseTimeoutMs: options.gracefulCloseTimeoutMs,
		onError: options.onError,
	});
	return new PiServer(service, {
		listeners: [listener],
		maxFrameLength: options.maxFrameLength,
		handshakeTimeoutMs: options.handshakeTimeoutMs,
		serverId: options.serverId,
		onError: options.onError,
	});
}
