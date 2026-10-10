import type { PiServerOptions } from "../../types.ts";

export interface WebSocketListenerOptions {
	host: string;
	port: number;
	token: string;
	staticDir?: string;
	maxPendingBytes?: number;
	gracefulCloseTimeoutMs?: number;
	maxFrameLength?: number;
	onError?: (error: Error) => void;
}

export interface WebSocketServerOptions extends Omit<PiServerOptions, "listeners">, WebSocketListenerOptions {}
