import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import type { ModelMetadata, SessionMetadata } from "@earendil-works/pi-protocol";
import {
	type CreateSessionOptions,
	PiServer,
	PiServerError,
	type PiServerListener,
	type PiServerService,
	type PiSessionRuntime,
	SessionNotFoundError,
} from "@earendil-works/pi-server";
import { createWebSocketListener } from "@earendil-works/pi-server/ws";
import { getRemoteWebDir } from "../config.ts";
import type { AgentSession } from "../core/agent-session.ts";
import type { ModelRuntime } from "../core/model-runtime.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import { CodingAgentRuntime, modelsForRuntime } from "./coding-agent-server.ts";

export interface RemoteShareInfo {
	port: number;
	urls: string[];
	qrUrl?: string;
}

export interface RemoteHostStatus {
	running: boolean;
	bindHost: string;
	port?: number;
	sessionId?: string;
	participantCount: number;
}

export interface RemoteHostCommandApi {
	start(): Promise<RemoteShareInfo>;
	lan(): Promise<RemoteShareInfo>;
	stop(): Promise<void>;
	status(): Promise<RemoteHostStatus>;
}

interface BoundListener extends PiServerListener {
	boundPort?: number;
}

function isIpv4(address: string): boolean {
	const parts = address.split(".").map(Number);
	return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255);
}

function isPrivateIpv4(address: string): boolean {
	if (!isIpv4(address)) return false;
	const parts = address.split(".").map(Number);
	return (
		parts[0] === 10 ||
		(parts[0] === 192 && parts[1] === 168) ||
		(parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
	);
}

function isTailscaleIpv4(address: string): boolean {
	if (!isIpv4(address)) return false;
	const parts = address.split(".").map(Number);
	// Tailscale assigns node addresses from the CGNAT 100.64.0.0/10 range.
	return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

function lanAddresses(): string[] {
	const addresses: Array<{ address: string; tailscale: boolean }> = [];
	for (const [name, entries] of Object.entries(networkInterfaces())) {
		for (const entry of entries ?? []) {
			if (entry.internal || entry.family !== "IPv4") continue;
			const tailscale = name === "tailscale0" || name.startsWith("tailscale") || isTailscaleIpv4(entry.address);
			if (isPrivateIpv4(entry.address) || tailscale) addresses.push({ address: entry.address, tailscale });
		}
	}
	return [
		...new Map(
			addresses.sort((a, b) => Number(b.tailscale) - Number(a.tailscale)).map((entry) => [entry.address, entry]),
		).values(),
	].map((entry) => entry.address);
}

export class TuiSessionService implements PiServerService {
	private readonly getSession: () => AgentSession;
	private readonly getModelRuntime: () => ModelRuntime;

	constructor(getSession: () => AgentSession, getModelRuntime: () => ModelRuntime) {
		this.getSession = getSession;
		this.getModelRuntime = getModelRuntime;
	}

	async listSessions(): Promise<SessionMetadata[]> {
		const session = this.getSession();
		const manager = session.sessionManager;
		const header = manager.getHeader();
		if (!header) return [];
		return [
			{
				id: manager.getSessionId(),
				createdAt: Date.parse(header.timestamp),
				...(manager.getEntries().length ? { updatedAt: Date.parse(manager.getEntries().at(-1)!.timestamp) } : {}),
				...(manager.getSessionName() ? { sessionName: manager.getSessionName() } : {}),
				cwd: manager.getCwd(),
			},
		];
	}
	async listModels(): Promise<ModelMetadata[]> {
		return modelsForRuntime(this.getModelRuntime());
	}

	async openSession(id: string): Promise<PiSessionRuntime> {
		const session = this.getSession();
		const manager = session.sessionManager;
		if (id !== manager.getSessionId()) throw new SessionNotFoundError(`Session not found: ${id}`);
		const metadata = (await this.listSessions())[0];
		if (!metadata) throw new SessionNotFoundError(`Session not found: ${id}`);
		return new CodingAgentRuntime(id, metadata, session, this.getModelRuntime(), async () => {});
	}

	async createSession(_options: CreateSessionOptions): Promise<never> {
		throw new PiServerError("invalid_request", "Remote host does not support creating sessions");
	}
}

export class RemoteHostController implements RemoteHostCommandApi {
	private server?: PiServer;
	private share?: RemoteShareInfo;
	private startPromise?: Promise<RemoteShareInfo>;
	private bindHost: string;
	private currentSession: AgentSession;
	private currentModelRuntime: ModelRuntime;

	private readonly options: {
		getSession: () => AgentSession;
		getModelRuntime: () => ModelRuntime;
		settings: SettingsManager;
	};

	constructor(options: {
		getSession: () => AgentSession;
		getModelRuntime: () => ModelRuntime;
		settings: SettingsManager;
	}) {
		this.options = options;
		this.bindHost = options.settings.getRemoteHost();
		this.currentSession = options.getSession();
		this.currentModelRuntime = options.getModelRuntime();
	}

	async start(): Promise<RemoteShareInfo> {
		if (this.share) return this.share;
		if (this.startPromise) return this.startPromise;
		if (this.bindHost !== "0.0.0.0") this.bindHost = this.options.settings.getRemoteHost();
		this.startPromise = this.startInternal(this.bindHost).finally(() => {
			this.startPromise = undefined;
		});
		return this.startPromise;
	}

	async lan(): Promise<RemoteShareInfo> {
		if (this.startPromise) await this.startPromise.catch(() => undefined);
		await this.stop();
		this.bindHost = "0.0.0.0";
		return this.start();
	}

	private async startInternal(host: string): Promise<RemoteShareInfo> {
		const settings = this.options.settings.getRemoteSettings();
		const staticDir = getRemoteWebDir();
		if (!existsSync(join(staticDir, "app.js"))) {
			throw new Error(
				`Remote web client assets are missing in ${staticDir}; run "npm run build:remote-web" in packages/coding-agent first`,
			);
		}
		const token = randomBytes(32).toString("base64url");
		const listener = createWebSocketListener({
			host,
			port: settings.port,
			token,
			staticDir,
		}) as BoundListener;
		const service = new TuiSessionService(
			() => this.currentSession,
			() => this.currentModelRuntime,
		);
		const server = new PiServer(service, { listeners: [listener] });
		try {
			await server.start();
			const port = listener.boundPort;
			if (port === undefined) throw new Error("WebSocket listener did not expose its bound port");
			const hosts = host === "0.0.0.0" ? lanAddresses() : [host];
			const urls = hosts.map((address) => `http://${address}:${port}/#${token}`);
			this.server = server;
			this.share = {
				port,
				urls,
				...(host === "0.0.0.0" && urls[0] ? { qrUrl: urls[0] } : {}),
			};
			return this.share;
		} catch (error) {
			await server.close().catch(() => undefined);
			this.server = undefined;
			this.share = undefined;
			throw error;
		}
	}

	async stop(): Promise<void> {
		const pendingStart = this.startPromise;
		if (pendingStart) await pendingStart.catch(() => undefined);
		this.share = undefined;
		const server = this.server;
		this.server = undefined;
		if (server) await server.close();
		this.bindHost = this.options.settings.getRemoteHost();
	}

	async status(): Promise<RemoteHostStatus> {
		const sessionId = this.currentSession.sessionManager.getSessionId();
		return {
			running: this.server !== undefined,
			bindHost: this.bindHost,
			...(this.share ? { port: this.share.port, sessionId } : {}),
			participantCount: this.server?.sessionParticipantCount(sessionId) ?? 0,
		};
	}

	async rebindSession(session: AgentSession, modelRuntime: ModelRuntime): Promise<void> {
		const oldId = this.currentSession.sessionManager.getSessionId();
		if (oldId === session.sessionManager.getSessionId()) return;
		if (this.server) await this.server.removeSession(oldId);
		this.currentSession = session;
		this.currentModelRuntime = modelRuntime;
	}

	async dispose(): Promise<void> {
		await this.stop();
	}
}
