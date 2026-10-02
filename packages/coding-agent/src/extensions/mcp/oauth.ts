import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AuthProvider, McpFetch } from "@earendil-works/pi-mcp";
import {
	type AuthorizationServerMetadata,
	authorizeMcp,
	McpOAuthAuthorizationRequiredError,
	McpOAuthProvider,
	type McpOAuthState,
	type McpOAuthStateStore,
	OAuthCallbackServer,
	type OAuthChallenge,
	parseWwwAuthenticate,
} from "@earendil-works/pi-mcp/oauth";
import lockfile from "proper-lockfile";
import { APP_NAME } from "../../config.ts";
import { type AuthStorageBackend, FileAuthStorageBackend } from "../../core/auth-storage.ts";
import { mcpNamespace } from "../../core/mcp-servers.ts";

export interface McpOAuthSettings {
	clientId?: string;
	clientSecret?: string;
	callbackPort?: number;
	callbackUrl?: string;
	scope?: string;
	clientName?: string;
	clientRegistration?: "dcr" | "cimd";
	authServerMetadataUrl?: URL;
}
type States = Record<string, McpOAuthState>;
function parseState(text: string | undefined): States {
	if (!text?.trim()) return {};
	const value: unknown = JSON.parse(text);
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as States) : {};
}
const refreshLocks = new Map<string, Promise<unknown>>();
export interface McpOAuthServerStore extends McpOAuthStateStore {
	withRefreshLock<T>(fn: () => Promise<T>): Promise<T>;
}

/** OAuth credential file is session-agentDir scoped, separate from model-provider auth.json. */
export class McpOAuthCredentialStore {
	private readonly backend: AuthStorageBackend;
	private readonly lockDir: string | undefined;
	constructor(agentDir: string, backend?: AuthStorageBackend) {
		this.backend = backend ?? new FileAuthStorageBackend(join(agentDir, "mcp-auth.json"));
		this.lockDir = backend ? undefined : agentDir;
	}
	forServer(name: string, serverUrl: string): McpOAuthServerStore {
		const url = new URL(serverUrl).href;
		const key = `${mcpNamespace(name)}|${url}`;
		return {
			load: () => this.backend.withLock((current) => ({ result: parseState(current)[key] })),
			save: (state) => {
				this.backend.withLock((current) => {
					const states = parseState(current);
					states[key] = state;
					return { result: undefined, next: `${JSON.stringify(states, null, 2)}\n` };
				});
			},
			withRefreshLock: async <T>(fn: () => Promise<T>) => {
				const refreshKey = `${this.lockDir ?? "memory"}|${key}`;
				const previous = refreshLocks.get(refreshKey) ?? Promise.resolve();
				const task = previous
					.catch(() => undefined)
					.then(async () => {
						if (!this.lockDir) return fn();
						mkdirSync(this.lockDir, { recursive: true, mode: 0o700 });
						const hash = createHash("sha256").update(key).digest("hex").slice(0, 16);
						const release = await lockfile.lock(join(this.lockDir, `mcp-auth-refresh-${hash}`), {
							realpath: false,
							stale: 20_000,
							retries: { retries: 250, factor: 1, minTimeout: 100, maxTimeout: 100 },
							onCompromised: () => {},
						});
						try {
							return await fn();
						} finally {
							await release().catch(() => undefined);
						}
					});
				refreshLocks.set(refreshKey, task);
				try {
					return (await task) as T;
				} finally {
					if (refreshLocks.get(refreshKey) === task) refreshLocks.delete(refreshKey);
				}
			},
		};
	}
	remove(name: string, serverUrl: string): boolean {
		const key = `${mcpNamespace(name)}|${new URL(serverUrl).href}`;
		return this.backend.withLock((current) => {
			const states = parseState(current);
			if (!(key in states)) return { result: false };
			delete states[key];
			return { result: true, next: `${JSON.stringify(states, null, 2)}\n` };
		});
	}
}
export interface McpAuthProvider extends AuthProvider {
	settled(): Promise<void>;
}
export function createMcpAuthProvider(options: {
	serverUrl: string;
	store: McpOAuthServerStore;
	settings: () => McpOAuthSettings;
	onChallenge: (challenge: OAuthChallenge) => void;
}): McpAuthProvider {
	let refresh: Promise<void> | undefined;
	const refreshToken = (stale?: string, fetch?: McpFetch, challenge?: OAuthChallenge) => {
		refresh ??= options.store
			.withRefreshLock(async () => {
				const state = await options.store.load();
				if (!state) throw new McpOAuthAuthorizationRequiredError();
				if (state.tokens?.access_token !== stale) return;
				if (!state.tokens?.refresh_token) throw new McpOAuthAuthorizationRequiredError();
				const settings = options.settings();
				const registeredRedirect =
					state.clientInformation && "redirect_uris" in state.clientInformation
						? state.clientInformation.redirect_uris[0]
						: undefined;
				const redirectUrl =
					settings.callbackUrl ??
					(settings.callbackPort
						? `http://127.0.0.1:${settings.callbackPort}/callback`
						: (registeredRedirect ?? "http://127.0.0.1/callback"));
				const provider = new McpOAuthProvider({
					serverUrl: options.serverUrl,
					redirectUrl,
					clientMetadata: { client_name: settings.clientName ?? APP_NAME },
					clientMetadataDocument:
						settings.clientRegistration === "cimd"
							? (metadata) => clientMetadataDocument(options.serverUrl, redirectUrl, metadata)
							: undefined,
					clientId: settings.clientId,
					clientSecret: settings.clientSecret,
					store: options.store,
					onRedirect: () => {},
				});
				const result = await authorizeMcp(provider, {
					serverUrl: options.serverUrl,
					resourceMetadataUrl: challenge?.resourceMetadataUrl,
					authorizationServerMetadataUrl: settings.authServerMetadataUrl,
					scope: challenge?.scope,
					fetch,
				});
				if (result === "REDIRECT") throw new McpOAuthAuthorizationRequiredError();
			})
			.finally(() => {
				refresh = undefined;
			});
		return refresh;
	};
	return {
		token: async () => {
			await refresh?.catch(() => undefined);
			const state = await options.store.load();
			const token = state?.tokens?.access_token;
			if (
				state?.tokensExpireAt === undefined ||
				state.tokensExpireAt > Date.now() + 30_000 ||
				!state.tokens?.refresh_token
			)
				return token;
			await refreshToken(token).catch(() => undefined);
			return (await options.store.load())?.tokens?.access_token;
		},
		onUnauthorized: async (context) => {
			const challenge = parseWwwAuthenticate(context.response.headers.get("www-authenticate"));
			options.onChallenge(challenge);
			if (challenge.error === "insufficient_scope") throw new McpOAuthAuthorizationRequiredError();
			await refreshToken(context.token, context.fetch, challenge);
		},
		settled: async () => {
			await refresh?.catch(() => undefined);
		},
	};
}
export interface McpSignInPrompt {
	showAuthorizationUrl(url: URL): void;
	promptForRedirectUrl(signal: AbortSignal): Promise<string | undefined>;
}
export class McpSignInCancelledError extends Error {
	constructor() {
		super("Sign-in cancelled");
		this.name = "McpSignInCancelledError";
	}
}
function callbackId(serverUrl: string): string {
	const url = new URL(serverUrl);
	url.hash = "";
	return createHash("sha256").update(url.href).digest().subarray(0, 9).toString("base64url");
}
const CLIENT_METADATA_BASE_URL = "https://pi.dev/oauth";
function clientMetadataDocument(
	serverUrl: string,
	redirectUrl: string,
	metadata: AuthorizationServerMetadata | undefined,
) {
	if (
		!metadata?.client_id_metadata_document_supported ||
		!metadata.token_endpoint_auth_methods_supported?.includes("none")
	) {
		throw new Error(
			'The authorization server does not support Client ID Metadata Documents for public clients; remove oauth.clientRegistration "cimd"',
		);
	}
	if (metadata.authorization_response_iss_parameter_supported)
		return { url: `${CLIENT_METADATA_BASE_URL}/client.json`, redirectUrl };
	const id = callbackId(serverUrl);
	const redirect = new URL(redirectUrl);
	redirect.pathname = `/callback/${id}`;
	return { url: `${CLIENT_METADATA_BASE_URL}/${id}/client.json`, redirectUrl: redirect.href };
}
function mergeScopes(...scopes: (string | undefined)[]): string | undefined {
	const values = [...new Set(scopes.flatMap((scope) => scope?.split(/\s+/).filter(Boolean) ?? []))];
	return values.length ? values.join(" ") : undefined;
}
export async function signInMcpServer(options: {
	serverUrl: string;
	store: McpOAuthServerStore;
	settings: McpOAuthSettings;
	challenge?: OAuthChallenge;
	prompt: McpSignInPrompt;
}): Promise<void> {
	const configuredUrl = options.settings.callbackUrl ? new URL(options.settings.callbackUrl) : undefined;
	const host = configuredUrl?.hostname ?? "127.0.0.1";
	const port = configuredUrl?.port ? Number(configuredUrl.port) : options.settings.callbackPort;
	const path = configuredUrl?.pathname ?? "/callback";
	const callback = await OAuthCallbackServer.listen({
		host: host === "localhost" ? "127.0.0.1" : host.replace(/^\[|\]$/g, ""),
		redirectHost: host,
		path,
		extraPaths: options.settings.clientRegistration === "cimd" ? [`/callback/${callbackId(options.serverUrl)}`] : [],
		port: port ?? 0,
	});
	let redirectUrl: string;
	if (configuredUrl?.port) redirectUrl = configuredUrl.href;
	else if (port !== undefined) {
		const fixed = new URL(configuredUrl?.href ?? callback.redirectUrl);
		fixed.port = String(port);
		redirectUrl = fixed.href;
	} else redirectUrl = callback.redirectUrl;
	try {
		let authorizationUrl: URL | undefined;
		const provider = new McpOAuthProvider({
			serverUrl: options.serverUrl,
			redirectUrl,
			clientMetadata: { client_name: options.settings.clientName ?? APP_NAME },
			clientMetadataDocument:
				options.settings.clientRegistration === "cimd"
					? (metadata) => clientMetadataDocument(options.serverUrl, redirectUrl, metadata)
					: undefined,
			clientId: options.settings.clientId,
			clientSecret: options.settings.clientSecret,
			store: options.store,
			onRedirect: (url) => {
				authorizationUrl = url;
			},
		});
		const stored = await options.store.load();
		const stepUp = options.challenge?.error === "insufficient_scope";
		const flow = {
			serverUrl: options.serverUrl,
			resourceMetadataUrl: options.challenge?.resourceMetadataUrl,
			authorizationServerMetadataUrl: options.settings.authServerMetadataUrl,
			scope: mergeScopes(
				options.settings.scope,
				stepUp ? stored?.tokens?.scope : undefined,
				options.challenge?.scope,
			),
			skipRefresh: stepUp,
		};
		const result = await authorizeMcp(provider, flow);
		if (result === "AUTHORIZED") return;
		if (!authorizationUrl) throw new Error("MCP OAuth did not provide an authorization URL");
		options.prompt.showAuthorizationUrl(authorizationUrl);
		const state = await provider.state();
		const authorizationRedirect = new URL(authorizationUrl.searchParams.get("redirect_uri") ?? redirectUrl);
		const controller = new AbortController();
		const callbackResult = callback.waitForCallback(state, authorizationRedirect.pathname);
		const pasted = options.prompt.promptForRedirectUrl(controller.signal).then((input) => {
			if (!input?.trim()) throw new McpSignInCancelledError();
			const url = new URL(input.trim());
			if (url.origin !== authorizationRedirect.origin || url.pathname !== authorizationRedirect.pathname)
				throw new Error("The redirect URL does not match this sign-in");
			if (url.searchParams.get("state") !== state)
				throw new Error("The redirect URL belongs to a different sign-in");
			const error = url.searchParams.get("error");
			if (error) throw new Error(url.searchParams.get("error_description") ?? error);
			const code = url.searchParams.get("code");
			if (!code) throw new Error("The redirect URL does not contain an authorization code");
			return { code, iss: url.searchParams.get("iss") ?? undefined };
		});
		let response: { code: string; iss?: string };
		try {
			response = await Promise.race([callbackResult, pasted]);
		} finally {
			controller.abort();
			callbackResult.catch(() => undefined);
			pasted.catch(() => undefined);
		}
		await authorizeMcp(provider, { ...flow, authorizationCode: response.code, iss: response.iss });
	} finally {
		await callback.close();
	}
}
