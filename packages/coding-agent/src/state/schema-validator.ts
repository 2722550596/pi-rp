import type { TSchema } from "typebox";
import { Compile } from "typebox/compile";
import { Create } from "typebox/value";
import { deepMerge, isObject, type JsonValue } from "./state-manager.ts";

export interface ValidationResult {
	ok: boolean;
	/** If ok=false, human-readable reason for rejection */
	reason?: string;
	/** If the value was corrected by a custom validator, the corrected value */
	correctedValue?: JsonValue;
}

export interface CustomValidator {
	/** Namespace this validator applies to */
	namespace: string;
	/** Path pattern (dot notation) within the namespace. "*" matches all paths. */
	path: string;
	/**
	 * Validate (and optionally correct) a value.
	 * - Return the value (possibly modified) to accept.
	 * - Return null to reject.
	 * - `state` is a readonly snapshot of the full namespace subtree.
	 */
	validate: (value: JsonValue | undefined, path: string, state: Readonly<JsonValue>) => JsonValue | null;
}

interface LoadedSchema {
	schemaId: string;
	namespace: string;
	/** Compiled validator from typebox/compile.Compile — works for both TypeBox TSchema and raw JSON Schema objects */
	validator: { Check: (v: unknown) => boolean; Errors: (v: unknown) => unknown };
	raw: unknown;
}

export class SchemaValidator {
	private _schemas = new Map<string, LoadedSchema>(); // keyed by namespace
	private _validators: CustomValidator[] = [];
	private _strict = false;

	setStrict(enabled: boolean): void {
		this._strict = enabled;
	}
	isStrict(): boolean {
		return this._strict;
	}

	/** Load a schema into a namespace. Replaces any existing schema for that namespace.
	 *  Uses typebox/compile.Compile which accepts both TypeBox TSchema objects and raw JSON Schema objects. */
	loadSchema(schemaId: string, namespace: string, schema: object): void {
		const validator = Compile(schema as Record<string, unknown>);
		this._schemas.set(namespace, { schemaId, namespace, validator, raw: schema });
	}

	unloadSchema(namespace: string): void {
		this._schemas.delete(namespace);
	}

	/** Register custom validators (typically loaded from .ts files) */
	setCustomValidators(validators: CustomValidator[]): void {
		this._validators = validators;
	}

	getActiveNamespaces(): string[] {
		return [...this._schemas.keys()];
	}

	/** Check if a path is covered by any loaded schema */
	getSchemaForPath(fullPath: string): LoadedSchema | undefined {
		const ns = fullPath.split(/\.|\//).filter((p) => p.length > 0)[0];
		return this._schemas.get(ns);
	}

	/** Generate the initial state object from a loaded schema's `default` values (TypeBox Create). */
	getDefaultValue(namespace: string): JsonValue | undefined {
		const loaded = this._schemas.get(namespace);
		if (!loaded || !loaded.raw || typeof loaded.raw !== "object") return undefined;
		try {
			return Create(loaded.raw as TSchema) as unknown as JsonValue;
		} catch {
			return undefined;
		}
	}

	/**
	 * Validate a state mutation.
	 * @param fullPath - Full state path (e.g. "persona.character.hp"), or "" for merge at root
	 * @param op - The state operation
	 * @param value - The value being written (undefined for "remove")
	 * @param currentState - Readonly snapshot of full current state
	 * @returns validation result
	 */
	validate(
		fullPath: string,
		op: "add" | "remove" | "replace" | "merge",
		value: JsonValue | undefined,
		currentState: Readonly<Record<string, JsonValue>>,
	): ValidationResult {
		// Merge at root: validate each namespace subtree that has a schema
		if (op === "merge" && (fullPath === "" || fullPath === undefined)) {
			if (!isObject(value)) return { ok: true }; // non-object merge is a full reset, skip
			const mergeObj = value as Record<string, JsonValue>;
			for (const [ns, schema] of this._schemas) {
				const nsState = (currentState[ns] as Record<string, JsonValue>) ?? {};
				const projected = structuredClone(nsState) as Record<string, JsonValue>;
				deepMerge(projected, (mergeObj[ns] as Record<string, JsonValue>) ?? {});
				if (!schema.validator.Check(projected)) {
					const errors = schema.validator.Errors(projected);
					return { ok: false, reason: `Schema validation failed for "${ns}": ${formatErrors(errors)}` };
				}
			}
			// Strict mode: reject merge keys not in any schema namespace
			if (this._strict) {
				for (const key of Object.keys(mergeObj)) {
					if (!this._schemas.has(key)) {
						return { ok: false, reason: `Strict mode: no schema loaded for namespace "${key}"` };
					}
				}
			}
			return { ok: true };
		}

		const parts = fullPath.split(/\.|\//).filter((p) => p.length > 0);
		const ns = parts[0];
		const schema = this._schemas.get(ns);

		// Strict mode: reject writes to uncovered paths
		if (!schema) {
			if (this._strict) {
				return { ok: false, reason: `Strict mode: no schema loaded for namespace "${ns}"` };
			}
			return { ok: true }; // freeform
		}

		// For "remove", we only need to check the path exists in the schema.
		if (op === "remove") {
			return { ok: true }; // removal is always allowed if the namespace has a schema
		}

		// Compute what the namespace subtree would look like after the mutation
		const nsState = (currentState[ns] as Record<string, JsonValue>) ?? {};
		const subPath = parts.slice(1).join("."); // normalize to dot notation for projectMutation
		const projected = projectMutation(nsState, subPath, op, value);

		// Schema validation: check the projected namespace subtree
		if (!schema.validator.Check(projected)) {
			const errors = schema.validator.Errors(projected);
			return { ok: false, reason: `Schema validation failed for "${ns}": ${formatErrors(errors)}` };
		}

		// Custom validators: run matching validators for the path
		let resultValue = value;
		for (const v of this._validators) {
			if (v.namespace !== ns) continue;
			if (v.path !== "*" && v.path !== subPath) continue;
			const corrected = v.validate(resultValue, subPath, nsState as Readonly<JsonValue>);
			if (corrected === null) {
				return { ok: false, reason: `Custom validator rejected write to "${fullPath}"` };
			}
			resultValue = corrected;
		}

		return resultValue === value ? { ok: true } : { ok: true, correctedValue: resultValue };
	}
}

/**
 * Given the current namespace subtree, the sub-path, op, and value, compute what
 * the subtree would look like after the mutation. This is a shallow projection —
 * it doesn't need to be a full StateManager; it just needs to produce the structure
 * that the schema validator checks against.
 */
function projectMutation(
	nsState: Record<string, JsonValue>,
	subPath: string,
	op: "add" | "remove" | "replace" | "merge",
	value: JsonValue | undefined,
): Record<string, JsonValue> {
	// Deep clone the namespace subtree
	const projected = structuredClone(nsState) as Record<string, JsonValue>;

	if (op === "merge" && subPath === "") {
		// Merge at namespace root: deep merge value into projected
		if (value && typeof value === "object" && !Array.isArray(value)) {
			deepMerge(projected, value as Record<string, JsonValue>);
		}
		return projected;
	}

	const parts = subPath === "" ? [] : subPath.split(".");
	let current = projected;
	for (let i = 0; i < parts.length - 1; i++) {
		if (!current[parts[i]] || typeof current[parts[i]] !== "object") {
			current[parts[i]] = {};
		}
		current = current[parts[i]] as Record<string, JsonValue>;
	}
	const key = parts[parts.length - 1];

	if (op === "remove" && key !== undefined) {
		delete current[key];
	} else if (op === "add" && key !== undefined && key in current) {
		const existing = current[key];
		if (typeof existing === "number" && typeof value === "number") {
			current[key] = (existing + value) as JsonValue;
		} else if (Array.isArray(existing) && !Array.isArray(value)) {
			(existing as JsonValue[]).push(value as JsonValue);
		} else {
			current[key] = value as JsonValue;
		}
	} else if (key !== undefined) {
		// replace, or add to new key
		current[key] = value as JsonValue;
	}

	return projected;
}

/**
 * Convert TypeBox error objects to a human-readable string.
 * typebox/compile Validator.Errors() returns TLocalizedValidationError[].
 * Handles both tuple (from schema Compile) and bare-array return shapes.
 */
function formatErrors(errors: unknown): string {
	const arr =
		Array.isArray(errors) && Array.isArray(errors[0])
			? (errors[1] as Array<{ instancePath?: string; message?: string }>)
			: (errors as Array<{ instancePath?: string; message?: string }>);
	if (!arr || arr.length === 0) return "validation failed";
	return arr
		.slice(0, 3)
		.map((e) => `${e.instancePath ?? "/"}: ${e.message ?? "invalid"}`)
		.join("; ");
}
