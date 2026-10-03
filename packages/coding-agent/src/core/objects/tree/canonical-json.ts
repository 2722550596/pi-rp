import type { JsonValue } from "../../../state/merge.ts";

export class CanonicalJsonError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CanonicalJsonError";
	}
}

function compareCodePoints(left: string, right: string): number {
	let leftIndex = 0;
	let rightIndex = 0;
	while (leftIndex < left.length && rightIndex < right.length) {
		const leftPoint = left.codePointAt(leftIndex)!;
		const rightPoint = right.codePointAt(rightIndex)!;
		if (leftPoint !== rightPoint) return leftPoint - rightPoint;
		leftIndex += leftPoint > 0xffff ? 2 : 1;
		rightIndex += rightPoint > 0xffff ? 2 : 1;
	}
	return leftIndex === left.length ? (rightIndex === right.length ? 0 : -1) : 1;
}

function quote(value: string): string {
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(i + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) throw new CanonicalJsonError("Unpaired surrogate");
			i++;
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			throw new CanonicalJsonError("Unpaired surrogate");
		}
	}
	return JSON.stringify(value).replace(/\u2028|\u2029/g, (char) => char);
}

function encode(value: unknown, ancestors: Set<object>, depth: number): string {
	if (depth > 256) throw new CanonicalJsonError("Maximum JSON depth exceeded");
	if (value === null) return "null";
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "string") return quote(value);
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new CanonicalJsonError("Non-finite number");
		if (Object.is(value, -0)) return "0";
		// ECMAScript NumberToString specifies shortest binary64 round-tripping digits;
		// normalize only JSON.stringify's exponent punctuation for the wire format.
		return JSON.stringify(value)
			.replace(/e\+?(-?)0+(\d+)/, "e$1$2")
			.replace("e+", "e");
	}
	if (typeof value !== "object" || value === undefined) throw new CanonicalJsonError("Not a JSON value");
	if (ancestors.has(value)) throw new CanonicalJsonError("Cyclic JSON value");
	if (
		Object.getPrototypeOf(value) !== Object.prototype &&
		Object.getPrototypeOf(value) !== null &&
		!Array.isArray(value)
	) {
		throw new CanonicalJsonError("Non-plain object");
	}
	if (Object.getOwnPropertySymbols(value).length > 0) throw new CanonicalJsonError("Symbol keys are not JSON data");
	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			const items: string[] = [];
			for (let i = 0; i < value.length; i++)
				items.push(i in value ? encode(value[i], ancestors, depth + 1) : "null");
			return `[${items.join(",")}]`;
		}
		const record = value as Record<string, unknown>;
		const keys = Object.keys(record).sort(compareCodePoints);
		return `{${keys.map((key) => `${quote(key)}:${encode(record[key], ancestors, depth + 1)}`).join(",")}}`;
	} finally {
		ancestors.delete(value);
	}
}

export function canonicalJson(value: JsonValue): string {
	return encode(value, new Set(), 0);
}

export function canonicalJsonBytes(value: JsonValue): Uint8Array {
	return new TextEncoder().encode(canonicalJson(value));
}
