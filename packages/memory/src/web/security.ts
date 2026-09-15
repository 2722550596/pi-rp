/**
 * S1/S2/S3 — security model (plan/memory-web/00-共同上下文.md §5).
 *
 * A local HTTP server that accepts writes is reachable by any web page in the
 * browser (CSRF) and by any hostname that resolves to 127.0.0.1 (DNS
 * rebinding). Three rules close that:
 *
 *   S1  bind loopback by default; shout when `--host` overrides it.
 *   S2  every request's `Host` header must name a loopback authority.
 *   S3  non-GET/HEAD requests carrying an `Origin` must come from this origin.
 *
 * No tokens, no sessions, no logins (§1.3 non-goal).
 */

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * Authorities we accept in `Host`. Anchored and deliberately case-sensitive:
 * browsers never send an uppercase host, so accepting one only widens the
 * attack surface (`LOCALHOST:1` is rejected).
 */
const HOST_RE = /^(?:localhost|127\.0\.0\.1|\[(?:::1|0:0:0:0:0:0:0:1)\])(?::\d+)?$/;

/** Same grammar, but pinned to the `http` scheme (this server has no TLS). */
const ORIGIN_RE = /^http:\/\/(?:localhost|127\.0\.0\.1|\[(?:::1|0:0:0:0:0:0:0:1)\])(?::\d+)?$/;

/** S1 alert threshold: is this bind address loopback-only? */
export function isLocalBind(host: string): boolean {
	return LOOPBACK.has(host);
}

/** S2 — Host header must be a loopback authority (port optional). */
export function checkHost(rawHost: string | undefined): boolean {
	if (!rawHost) return false;
	return HOST_RE.test(rawHost);
}

function splitHostPort(authority: string): { host: string; port: string } {
	const at = authority.lastIndexOf(":");
	const isIpv6 = authority.startsWith("[");
	if (at <= (isIpv6 ? authority.indexOf("]") : -1)) return { host: authority, port: "80" };
	return { host: authority.slice(0, at), port: authority.slice(at + 1) };
}

/**
 * S3 — `Origin`, when present, must be exactly this origin.
 *
 * Absent Origin passes: `curl` and scripts do not send one, and the contract
 * requires them to work. A present-but-wrong Origin fails — including
 * `https://127.0.0.1:8788`, because a page served over TLS cannot be a page
 * this plaintext server handed out.
 */
export function checkOrigin(rawOrigin: string | undefined, rawHost: string | undefined): boolean {
	if (rawOrigin === undefined) return true;
	if (!rawHost || !checkHost(rawHost)) return false;
	if (!ORIGIN_RE.test(rawOrigin)) return false;
	const origin = splitHostPort(rawOrigin.slice("http://".length));
	const host = splitHostPort(rawHost);
	return origin.host === host.host && origin.port === host.port;
}
