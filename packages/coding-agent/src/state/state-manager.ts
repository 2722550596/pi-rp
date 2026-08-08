export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type StateOp = "add" | "remove" | "replace" | "merge";

export interface StateDiffResult {
	op: StateOp;
	path: string;
	oldValue?: JsonValue;
	newValue?: JsonValue;
}

interface ApplyCallArg {
	op: StateOp;
	path?: string;
	value?: JsonValue;
}

/**
 * Resolve a path against root, returning the parent object and leaf key.
 * Supports dot notation ("character.hp") and JSON Pointer ("/character/hp").
 */
function resolvePath(
	root: Record<string, JsonValue>,
	path: string,
): { parent: Record<string, JsonValue>; key: string; current?: JsonValue } | undefined {
	if (path === "") return { parent: root, key: "" };

	const parts = path.startsWith("/") ? path.split("/").slice(1) : path.split(".");
	let current: Record<string, JsonValue> = root;

	for (let i = 0; i < parts.length - 1; i++) {
		const part = parts[i];
		const val = current[part];
		if (!val || typeof val !== "object" || Array.isArray(val)) {
			return undefined;
		}
		current = val as Record<string, JsonValue>;
	}

	const key = parts[parts.length - 1];
	return { parent: current, key, current: current[key] };
}

export function isObject(val: JsonValue | undefined): val is Record<string, JsonValue> {
	return typeof val === "object" && val !== null && !Array.isArray(val);
}

/**
 * Deep merge `src` into `target` (RFC 7396). If a value in `src` is null, the
 * key is deleted from `target`.
 */
export function deepMerge(target: Record<string, JsonValue>, src: Record<string, JsonValue>): void {
	for (const key of Object.keys(src)) {
		const sv = src[key];
		if (sv === null) {
			delete target[key];
		} else if (isObject(sv) && isObject(target[key])) {
			deepMerge(target[key] as Record<string, JsonValue>, sv);
		} else {
			target[key] = sv;
		}
	}
}

/**
 * Recursively fill missing keys in `target` from `defaults`. Existing keys
 * win (unlike deepMerge, primitive defaults never overwrite). Used to seed
 * initial state from schema `default` values.
 */
function fillMissing(target: Record<string, JsonValue>, defaults: Record<string, JsonValue>): void {
	for (const key of Object.keys(defaults)) {
		const dv = defaults[key];
		const tv = target[key];
		if (tv === undefined) {
			target[key] = structuredClone(dv);
		} else if (isObject(dv) && isObject(tv)) {
			fillMissing(tv, dv);
		}
	}
}

function getPath(root: Record<string, JsonValue>, path: string): JsonValue | undefined {
	if (path === "") return root;
	const resolved = resolvePath(root, path);
	return resolved?.current;
}

export class StateManager {
	private _data: Record<string, JsonValue> = {};
	private _subscribers = new Set<(snapshot: Record<string, unknown>) => void>();
	private _dirty = false;

	/** Apply one state mutation. Path supports dot notation and JSON Pointer. */
	apply(pathOrOp: string, op?: StateOp, val?: JsonValue): StateDiffResult;
	/** Sugar: apply({op, path, value}) or apply({op: "merge", value}) */
	apply(input: ApplyCallArg): StateDiffResult;
	apply(pathOrOp: string | ApplyCallArg, op?: StateOp, val?: JsonValue): StateDiffResult {
		let result: StateDiffResult;
		if (typeof pathOrOp === "object") {
			const input = pathOrOp;
			if (input.op === "merge") {
				result = this._applyMerge(input.value);
			} else {
				result = this._applyOp(input.op, input.path ?? "", input.value);
			}
		} else {
			result = this._applyOp(op as StateOp, pathOrOp, val);
		}
		this._notify();
		this._dirty = true;
		return result;
	}

	private _applyOp(op: StateOp, path: string, value: JsonValue | undefined): StateDiffResult {
		const resolved = resolvePath(this._data, path);
		const oldValue = resolved?.current;

		switch (op) {
			case "add": {
				if (!resolved) {
					this._setDeep(path, value);
					return { op, path, oldValue: undefined, newValue: value };
				}

				const { parent, key } = resolved;
				if (key === "") {
					const old = this._data;
					this._data = isObject(value) ? (value as Record<string, JsonValue>) : {};
					return { op, path, oldValue: old, newValue: this._data };
				}

				if (!(key in parent)) {
					parent[key] = value as JsonValue;
					return { op, path, oldValue: undefined, newValue: value };
				}

				const current = parent[key];
				if (typeof current === "number" && typeof value === "number") {
					const newVal = (current + value) as JsonValue;
					parent[key] = newVal;
					return { op, path, oldValue: current, newValue: newVal };
				}

				if (Array.isArray(current) && !Array.isArray(value)) {
					(current as JsonValue[]).push(value as JsonValue);
					return { op, path, oldValue: [...current], newValue: current };
				}

				parent[key] = value as JsonValue;
				return { op, path, oldValue: current, newValue: value };
			}

			case "remove": {
				if (!resolved || !(resolved.key in resolved.parent)) {
					return { op, path, oldValue: undefined };
				}
				const old = resolved.parent[resolved.key];
				delete resolved.parent[resolved.key];
				return { op, path, oldValue: old, newValue: undefined };
			}

			case "replace": {
				this._setDeep(path, value);
				return { op, path, oldValue, newValue: value };
			}

			case "merge": {
				return this._applyMerge(value);
			}

			default:
				return { op, path, oldValue: undefined, newValue: undefined };
		}
	}

	private _applyMerge(value: JsonValue | undefined): StateDiffResult {
		const oldSnapshot = structuredClone(this._data) as JsonValue;
		if (isObject(value)) {
			deepMerge(this._data, value);
		} else {
			this._data = {};
		}
		return {
			op: "merge" as StateOp,
			path: "",
			oldValue: oldSnapshot,
			newValue: structuredClone(this._data) as JsonValue,
		};
	}

	private _setDeep(path: string, value: JsonValue | undefined): void {
		if (path === "") {
			if (isObject(value)) {
				this._data = value;
			}
			return;
		}

		const parts = path.startsWith("/") ? path.split("/").slice(1) : path.split(".");
		let current: Record<string, JsonValue> = this._data;

		for (let i = 0; i < parts.length - 1; i++) {
			const part = parts[i];
			if (!current[part] || typeof current[part] !== "object" || Array.isArray(current[part])) {
				current[part] = {} as JsonValue;
			}
			current = current[part] as Record<string, JsonValue>;
		}

		const key = parts[parts.length - 1];
		if (value === undefined) {
			delete current[key];
		} else {
			(current as Record<string, JsonValue>)[key] = value;
		}
	}

	get(path?: string): JsonValue | undefined {
		if (!path || path === "") return this._data;
		return getPath(this._data, path);
	}

	snapshot(): Record<string, unknown> {
		return structuredClone(this._data);
	}

	/** Whether state has been mutated since the last snapshot was persisted. */
	get dirty(): boolean {
		return this._dirty;
	}

	/** Mark state as clean (persisted). Called after appending a snapshot to the session. */
	clearDirty(): void {
		this._dirty = false;
	}

	/** Subscribe to state changes. Returns unsubscribe function. */
	subscribe(handler: (snapshot: Record<string, unknown>) => void): () => void {
		this._subscribers.add(handler);
		return () => {
			this._subscribers.delete(handler);
		};
	}

	private _notify(): void {
		if (this._subscribers.size === 0) return;
		const snap = this.snapshot();
		for (const handler of this._subscribers) {
			handler(snap);
		}
	}

	load(data: Record<string, unknown>): void {
		this._data = structuredClone(data) as Record<string, JsonValue>;
		this._notify();
	}

	/** Fill missing keys from `defaults` (existing values win, recursively). */
	applyDefaults(defaults: Record<string, JsonValue>): void {
		fillMissing(this._data, defaults);
		this._notify();
	}
}
