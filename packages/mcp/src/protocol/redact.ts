const SENSITIVE_KEYS = [
	"access[_-]?token",
	"refresh[_-]?token",
	"id[_-]?token",
	"client[_-]?secret",
	"client[_-]?assertion",
	"secret",
	"password",
	"authorization",
	"api[_-]?key",
	"token",
	"authorization[_-]?code",
	"code[_-]?verifier",
	"software[_-]?statement",
	"private[_-]?key",
	"credential",
	"state",
];
const SENSITIVE_KEY = SENSITIVE_KEYS.join("|");
const SENSITIVE_PAIR = new RegExp(
	`(?<![?&])(["']?(?:${SENSITIVE_KEY})["']?\\s*[:=]\\s*)(?:"[^"]*"|'[^']*'|[^\\s&,}]+)`,
	"gi",
);
const BEARER_CREDENTIAL = /\b(Bearer|Basic)\s+[^\s,;"']+/gi;
const URL_USERINFO = /\b(https?:\/\/)[^/@\s]+@/gi;
const SENSITIVE_QUERY = new RegExp(`([?&](?:${SENSITIVE_KEY}|code)=)[^&#\\s]*`, "gi");

/** Removes credential values from protocol-provided error text before exposing or logging it. */
export function redactSensitiveText(value: string, knownSecrets: readonly string[] = []): string {
	let safe = value;
	for (const secret of knownSecrets) {
		if (secret.length >= 4) safe = safe.replaceAll(secret, "[redacted]");
	}
	return safe
		.replace(BEARER_CREDENTIAL, "$1 [redacted]")
		.replace(SENSITIVE_PAIR, '$1"[redacted]"')
		.replace(SENSITIVE_QUERY, "$1[redacted]")
		.replace(URL_USERINFO, "$1[redacted]@");
}
