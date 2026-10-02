import { redactSensitiveText } from "../protocol/redact.ts";

export class OAuthError extends Error {
	readonly code: string;
	readonly errorUri: string | undefined;

	constructor(code: string, message: string, errorUri?: string) {
		super(redactSensitiveText(message || code));
		this.name = "OAuthError";
		this.code = code;
		this.errorUri = errorUri === undefined ? undefined : redactSensitiveText(errorUri);
	}
}

export class OAuthIssuerMismatchError extends Error {
	readonly expected: string;
	/** `undefined` when an authorization response lacks the `iss` parameter its server promised (RFC 9207). */
	readonly received: string | undefined;

	constructor(expected: string, received: string | undefined) {
		const safeExpected = redactSensitiveText(expected);
		const safeReceived = received === undefined ? undefined : redactSensitiveText(received);
		super(
			`OAuth issuer mismatch: expected ${JSON.stringify(safeExpected)}, received ${safeReceived === undefined ? "none" : JSON.stringify(safeReceived)}`,
		);
		this.name = "OAuthIssuerMismatchError";
		this.expected = safeExpected;
		this.received = safeReceived;
	}
}

export class OAuthInsecureEndpointError extends Error {
	readonly endpoint: string;

	constructor(endpoint: string) {
		const safeEndpoint = redactSensitiveText(endpoint);
		super(`Refusing to send OAuth credentials to non-HTTPS endpoint ${safeEndpoint}`);
		this.name = "OAuthInsecureEndpointError";
		this.endpoint = safeEndpoint;
	}
}

export class OAuthRegistrationError extends Error {
	readonly status: number;
	readonly body: string;

	constructor(status: number, body: string) {
		const safeBody = redactSensitiveText(body);
		super(`OAuth dynamic client registration failed with status ${status}: ${safeBody}`);
		this.name = "OAuthRegistrationError";
		this.status = status;
		this.body = safeBody;
	}
}

export class McpOAuthAuthorizationRequiredError extends Error {
	constructor() {
		super("MCP OAuth authorization requires user interaction");
		this.name = "McpOAuthAuthorizationRequiredError";
	}
}
