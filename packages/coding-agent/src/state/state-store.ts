import * as fs from "node:fs";
import * as path from "node:path";
import { applyOp, isObject, type JsonValue } from "./state-manager.ts";

export interface NamespaceSnapshot {
	revision: number;
	state: JsonValue | undefined;
}

export interface StateOp {
	op: "add" | "remove" | "replace" | "merge" | "seed";
	/** Namespace-relative path ("" = whole namespace). */
	path: string;
	value?: JsonValue;
}

export type CommitResult = { ok: true; revision: number } | { ok: false; reason: string };

/**
 * Cross-process shared state store: one file per namespace under a shared
 * directory, `{ "revision": N, "state": {…} }`, written atomically via
 * tmp + rename. Single-writer-multi-reader; `commitNamespace` uses the file
 * revision as a CAS token to defend against concurrent writers.
 */
export class StateStore {
	readonly dir: string;

	constructor(dir: string) {
		this.dir = dir;
	}

	/** Read a namespace. Missing/corrupt file → `{ revision: 0, state: undefined }`. */
	readNamespace(ns: string): NamespaceSnapshot {
		try {
			const raw = fs.readFileSync(path.join(this.dir, `${ns}.json`), "utf8");
			const parsed = JSON.parse(raw) as { revision?: unknown; state?: JsonValue };
			return {
				revision: typeof parsed.revision === "number" ? parsed.revision : 0,
				state: parsed.state,
			};
		} catch {
			return { revision: 0, state: undefined };
		}
	}

	/** Namespace names present as `*.json` files (ignores `*.json.tmp`). */
	listNamespaces(): string[] {
		let entries: string[];
		try {
			entries = fs.readdirSync(this.dir);
		} catch {
			return [];
		}
		return entries
			.filter((e) => e.endsWith(".json") && !e.endsWith(".json.tmp"))
			.map((e) => e.slice(0, -".json".length));
	}

	/**
	 * CAS commit: read file → check file revision === expectedRevision → replay
	 * all ops onto the file state → write back with revision+1. On conflict,
	 * re-read and replay against the new baseline, up to `maxRetries` (default
	 * 3). Still conflicting → `{ ok: false, reason: "revision conflict" }`.
	 */
	commitNamespace(
		ns: string,
		expectedRevision: number,
		ops: StateOp[],
		options?: { maxRetries?: number },
	): CommitResult {
		const maxRetries = options?.maxRetries ?? 3;
		let expected = expectedRevision;
		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			const snap = this.readNamespace(ns);
			if (snap.revision !== expected) {
				expected = snap.revision;
				continue;
			}
			const root: Record<string, JsonValue> = isObject(snap.state) ? (snap.state as Record<string, JsonValue>) : {};
			for (const op of ops) {
				applyOp(root, op.op, op.path, op.value);
			}
			const revision = snap.revision + 1;
			this._writeNamespace(ns, revision, root);
			return { ok: true, revision };
		}
		return { ok: false, reason: "revision conflict" };
	}

	/** Delete orphaned `*.json.tmp` files (crash leftovers). */
	cleanTmp(): void {
		let entries: string[];
		try {
			entries = fs.readdirSync(this.dir);
		} catch {
			return;
		}
		for (const e of entries) {
			if (!e.endsWith(".json.tmp")) continue;
			try {
				fs.unlinkSync(path.join(this.dir, e));
			} catch {
				// ignore races with a concurrent writer
			}
		}
	}

	private _writeNamespace(ns: string, revision: number, state: Record<string, JsonValue>): void {
		fs.mkdirSync(this.dir, { recursive: true });
		const tmpPath = path.join(this.dir, `${ns}.json.tmp`);
		const finalPath = path.join(this.dir, `${ns}.json`);
		fs.writeFileSync(tmpPath, JSON.stringify({ revision, state }, null, 2), "utf8");
		fs.renameSync(tmpPath, finalPath);
	}
}
