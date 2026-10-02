export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export function isObject(value: JsonValue | undefined): value is Record<string, JsonValue> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Deep merge `src` into `target` (RFC 7396). If a value in `src` is null, the
 * key is deleted from `target`.
 */
export function deepMerge(target: Record<string, JsonValue>, src: Record<string, JsonValue>): void {
	for (const key of Object.keys(src)) {
		const sourceValue = src[key];
		if (sourceValue === null) {
			delete target[key];
		} else if (isObject(sourceValue) && isObject(target[key])) {
			deepMerge(target[key] as Record<string, JsonValue>, sourceValue);
		} else {
			target[key] = sourceValue;
		}
	}
}

/**
 * Apply an opening override to a complete defaults object using RFC 7396
 * semantics. The returned state is independent of both input objects.
 */
export function mergeStateDefaults(
	defaults: Record<string, JsonValue>,
	openingOverride: Record<string, JsonValue>,
): Record<string, JsonValue> {
	const result = structuredClone(defaults);
	deepMerge(result, structuredClone(openingOverride));
	return result;
}
