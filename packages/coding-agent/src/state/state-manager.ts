import * as fs from "node:fs";
import type { StateStore } from "./state-store.ts";

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

/** A store-bound op: namespace-relative path ("" = whole namespace). */
interface StoreOp {
	op: StateOp;
	path: string;
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

/** Replace `target`'s contents with `src`'s keys, keeping the reference. */
function replaceAllKeys(target: Record<string, JsonValue>, src: Record<string, JsonValue>): void {
	for (const k of Object.keys(target)) delete target[k];
	for (const [k, v] of Object.entries(src)) target[k] = v;
}

/** Set a value at `path` inside `root` (creates intermediate objects). */
function setDeep(root: Record<string, JsonValue>, path: string, value: JsonValue | undefined): void {
	if (path === "") {
		if (isObject(value)) replaceAllKeys(root, value);
		return;
	}

	const parts = path.startsWith("/") ? path.split("/").slice(1) : path.split(".");
	let current: Record<string, JsonValue> = root;

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

function getPath(root: Record<string, JsonValue>, path: string): JsonValue | undefined {
	if (path === "") return root;
	const resolved = resolvePath(root, path);
	return resolved?.current;
}

/**
 * Apply one state op against `root`, mutating it in place. Shared between the
 * in-memory StateManager and the cross-process StateStore so file replay and
 * memory semantics can never drift. Handles add's push / numeric-increment /
 * key==="" whole-replace branches.
 */
export function applyOp(
	root: Record<string, JsonValue>,
	op: StateOp,
	path: string,
	value: JsonValue | undefined,
): StateDiffResult {
	const resolved = resolvePath(root, path);
	const oldValue = resolved?.current;

	switch (op) {
		case "add": {
			if (!resolved) {
				setDeep(root, path, value);
				return { op, path, oldValue: undefined, newValue: value };
			}

			const { parent, key } = resolved;
			if (key === "") {
				const old = structuredClone(root) as JsonValue;
				replaceAllKeys(root, isObject(value) ? value : {});
				return { op, path, oldValue: old, newValue: root };
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
			setDeep(root, path, value);
			return { op, path, oldValue, newValue: value };
		}

		case "merge": {
			const oldSnapshot = structuredClone(root) as JsonValue;
			if (isObject(value)) {
				deepMerge(root, value);
			} else {
				replaceAllKeys(root, {});
			}
			return {
				op: "merge" as StateOp,
				path: "",
				oldValue: oldSnapshot,
				newValue: structuredClone(root) as JsonValue,
			};
		}

		default:
			return { op, path, oldValue: undefined, newValue: undefined };
	}
}

export class StateManager {
	private _data: Record<string, JsonValue> = {};
	private _subscribers = new Set<(snapshot: Record<string, unknown>) => void>();
	private _dirty = false;
	private _revision = 0;

	// Cross-process shared state store (see state-store.ts). All `_store*`
	// fields are inert until attachStore() is called (settings opt-in).
	private _store: StateStore | undefined;
	private _storeDebounceMs = 200;
	private _storeWatchDebounceMs = 100;
	private _storeCanLoad: ((ns: string) => boolean) | undefined;
	private _storeFillDefaults: ((ns: string) => void) | undefined;
	private _storeSeenRevs = new Map<string, number>();
	private _storeOwnedNs = new Set<string>();
	private _storePendingOps = new Map<string, StoreOp[]>();
	private _storeFlushTimer: ReturnType<typeof setTimeout> | undefined;
	private _storeWatchTimer: ReturnType<typeof setTimeout> | undefined;
	private _storeWatcher: fs.FSWatcher | undefined;

	/** Monotonic state revision: increments on every mutation/load.
	 *  Peers (subagent, RPC) use it to skip unchanged snapshots. */
	get revision(): number {
		return this._revision;
	}

	/** Apply one state mutation. Path supports dot notation and JSON Pointer. */
	apply(pathOrOp: string, op?: StateOp, val?: JsonValue): StateDiffResult;
	/** Sugar: apply({op, path, value}) or apply({op: "merge", value}) */
	apply(input: ApplyCallArg): StateDiffResult;
	apply(pathOrOp: string | ApplyCallArg, op?: StateOp, val?: JsonValue): StateDiffResult {
		let result: StateDiffResult;
		let raw: StoreOp;
		if (typeof pathOrOp === "object") {
			const input = pathOrOp;
			if (input.op === "merge") {
				result = this._applyMerge(input.value);
				raw = { op: "merge", path: "", value: input.value };
			} else {
				result = this._applyOp(input.op, input.path ?? "", input.value);
				raw = { op: input.op, path: input.path ?? "", value: input.value };
			}
		} else {
			result = this._applyOp(op as StateOp, pathOrOp, val);
			raw = { op: op as StateOp, path: pathOrOp, value: val };
		}
		this._notify();
		this._dirty = true;
		this._revision++;
		this._queueStoreOps(raw);
		return result;
	}

	private _applyOp(op: StateOp, path: string, value: JsonValue | undefined): StateDiffResult {
		return applyOp(this._data, op, path, value);
	}

	private _applyMerge(value: JsonValue | undefined): StateDiffResult {
		return applyOp(this._data, "merge", "", value);
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
		this._revision++;
	}

	/** Fill missing keys from `defaults` (existing values win, recursively). */
	applyDefaults(defaults: Record<string, JsonValue>): void {
		fillMissing(this._data, defaults);
		this._notify();
		this._revision++;
	}

	// ── Cross-process shared store ─────────────────────────────────────────

	/**
	 * Mount a StateStore. Local applies are forwarded to the store (debounced
	 * commit, default 200ms); external file changes reload namespaces via
	 * fs.watch (debounced 100ms) and notify subscribers. Unmounted behavior is
	 * unchanged.
	 */
	attachStore(
		store: StateStore,
		options?: {
			debounceMs?: number;
			watchDebounceMs?: number;
			canLoadNamespace?: (ns: string) => boolean;
			/**
			 * Called after a namespace is replaced from the store. Files are
			 * authoritative but often partial (only explicitly written keys),
			 * so the owner re-applies schema defaults to keep validation-visible
			 * required keys present.
			 */
			fillDefaults?: (ns: string) => void;
		},
	): void {
		if (this._store) this.detachStore();
		this._store = store;
		this._storeDebounceMs = options?.debounceMs ?? 200;
		this._storeWatchDebounceMs = options?.watchDebounceMs ?? 100;
		this._storeCanLoad = options?.canLoadNamespace;
		this._storeFillDefaults = options?.fillDefaults;
		// Mark gate-passing namespaces as seen. Gate-rejected ones stay unseen
		// so a later schema load (or foreign change) can still pick them up.
		for (const ns of store.listNamespaces()) {
			if (this._storeCanLoad && !this._storeCanLoad(ns)) continue;
			this._storeSeenRevs.set(ns, store.readNamespace(ns).revision);
		}
		try {
			fs.mkdirSync(store.dir, { recursive: true });
			this._storeWatcher = fs.watch(store.dir, (_event, filename) => this._onStoreWatchEvent(filename));
		} catch (err) {
			console.warn(`[state-store] fs.watch failed on ${store.dir}: ${(err as Error).message}`);
		}
	}

	/** Flush pending commits, unwatch, clear timers and store state. Idempotent. */
	detachStore(): void {
		this.flushStore();
		if (this._storeWatchTimer) {
			clearTimeout(this._storeWatchTimer);
			this._storeWatchTimer = undefined;
		}
		if (this._storeWatcher) {
			try {
				this._storeWatcher.close();
			} catch {
				// watcher already closed
			}
			this._storeWatcher = undefined;
		}
		this._store = undefined;
		this._storeSeenRevs.clear();
		this._storeOwnedNs.clear();
		this._storePendingOps.clear();
		this._storeCanLoad = undefined;
		this._storeFillDefaults = undefined;
	}

	/**
	 * Replace one namespace's value in memory (cross-process authoritative
	 * mirror). Replacement, not deep merge: the file is the authority, and
	 * merging would leave deleted keys behind. Notifies subscribers and bumps
	 * revision. When a defaults filler is attached, absent schema-default keys
	 * are restored after the replace (file values win).
	 */
	loadNamespace(ns: string, state: JsonValue): void {
		this._data[ns] = state;
		this._storeFillDefaults?.(ns);
		this._notify();
		this._revision++;
	}

	/** Immediately commit all pending ops for every namespace. */
	flushStore(): void {
		if (this._storeFlushTimer) {
			clearTimeout(this._storeFlushTimer);
			this._storeFlushTimer = undefined;
		}
		if (!this._store || this._storePendingOps.size === 0) return;
		const pending = this._storePendingOps;
		this._storePendingOps = new Map();
		for (const [ns, ops] of pending) {
			const expected = this._storeSeenRevs.get(ns) ?? 0;
			const result = this._store.commitNamespace(ns, expected, ops, { maxRetries: 3 });
			if (result.ok) {
				this._storeSeenRevs.set(ns, result.revision);
			} else {
				console.warn(`[state-store] commitNamespace("${ns}") failed: ${result.reason}; keeping local state`);
			}
		}
	}

	/**
	 * Flush pending ops, then commit a whole-namespace replace for every
	 * namespace this process has written (rollback path: after memory is
	 * rewound, files must not stay ahead of it, or the next apply would replay
	 * onto a stale baseline).
	 */
	commitOwnedToStore(): void {
		this.flushStore();
		if (!this._store) return;
		for (const ns of this._storeOwnedNs) {
			const expected = this._storeSeenRevs.get(ns) ?? 0;
			const result = this._store.commitNamespace(
				ns,
				expected,
				[{ op: "replace", path: "", value: this._data[ns] }],
				{ maxRetries: 3 },
			);
			if (result.ok) {
				this._storeSeenRevs.set(ns, result.revision);
			} else {
				console.warn(`[state-store] commitOwnedToStore("${ns}") failed: ${result.reason}`);
			}
		}
	}

	/** Forward one raw apply input to the store, split per namespace. */
	private _queueStoreOps(op: StoreOp): void {
		if (!this._store) return;
		const split = this._splitStoreOp(op);
		if (split.length === 0) return;
		for (const so of split) {
			const list = this._storePendingOps.get(so.ns);
			const entry: StoreOp = { op: so.op, path: so.path, value: so.value };
			if (list) list.push(entry);
			else this._storePendingOps.set(so.ns, [entry]);
			this._storeOwnedNs.add(so.ns);
		}
		this._scheduleStoreFlush();
	}

	/**
	 * Split a full-state op into per-namespace store ops. Paths in store ops
	 * are namespace-relative.
	 */
	private _splitStoreOp(op: StoreOp): Array<{ ns: string; op: StateOp; path: string; value: JsonValue | undefined }> {
		if (op.path === "") {
			if (op.op === "merge") {
				// Root merge: one merge op per namespace (top-level key).
				if (!isObject(op.value)) return []; // degenerate: memory cleared, nothing to persist
				const out: Array<{ ns: string; op: StateOp; path: string; value: JsonValue | undefined }> = [];
				for (const [ns, v] of Object.entries(op.value as Record<string, JsonValue>)) {
					out.push({ ns, op: "merge", path: "", value: v });
				}
				return out;
			}
			// Root add/replace (key === "" whole-replace branch): one replace per namespace.
			const out: Array<{ ns: string; op: StateOp; path: string; value: JsonValue | undefined }> = [];
			if (isObject(op.value)) {
				for (const [ns, v] of Object.entries(op.value as Record<string, JsonValue>)) {
					out.push({ ns, op: "replace", path: "", value: v });
				}
			}
			return out;
		}
		// Namespace = first path segment (dot or JSON Pointer); the rest is ns-relative.
		const parts = op.path.startsWith("/") ? op.path.split("/").slice(1) : op.path.split(".");
		return [{ ns: parts[0], op: op.op, path: parts.slice(1).join("."), value: op.value }];
	}

	private _scheduleStoreFlush(): void {
		clearTimeout(this._storeFlushTimer);
		this._storeFlushTimer = setTimeout(() => {
			this._storeFlushTimer = undefined;
			this.flushStore();
		}, this._storeDebounceMs);
	}

	private _onStoreWatchEvent(filename: string | null): void {
		clearTimeout(this._storeWatchTimer);
		this._storeWatchTimer = setTimeout(() => {
			this._storeWatchTimer = undefined;
			if (!this._store) return;
			const targets = filename?.endsWith(".json")
				? [filename.slice(0, -".json".length)]
				: filename !== null
					? [] // tmp writes etc.
					: this._store.listNamespaces();
			for (const ns of targets) this.reloadNamespaceFromStore(ns);
		}, this._storeWatchDebounceMs);
	}

	/**
	 * Reload one namespace from the store file if it is newer than what this
	 * manager has seen. Applies the load gate, bumps the seen revision, and
	 * replaces the in-memory namespace (file is the authoritative mirror).
	 * Used by the fs.watch path and by schema loads (attach can precede
	 * --schema application, so the initial file load must be re-attempted
	 * once the namespace's schema is loaded).
	 */
	reloadNamespaceFromStore(ns: string): void {
		if (!this._store) return;
		if (this._storeCanLoad && !this._storeCanLoad(ns)) return;
		const snap = this._store.readNamespace(ns);
		const seen = this._storeSeenRevs.get(ns) ?? 0;
		if (snap.revision <= seen) return; // own write or no change
		this._storeSeenRevs.set(ns, snap.revision);
		if (snap.state !== undefined) this.loadNamespace(ns, snap.state);
	}
}
