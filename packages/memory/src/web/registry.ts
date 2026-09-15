/**
 * StoreRegistry: the process's connection lifecycle for registered memory DBs
 * (plan/memory-web/11-多库发现与注册表.md §5).
 *
 * The process used to hold exactly one `MemoryStore`. Multi-db relaxes that to
 * N, without changing a single handler: a request resolves `?db=` to one entry
 * here and gets a `ServerContext` whose `store` is that entry's.
 *
 * Five semantics hold, and each one has a mechanism rather than a convention:
 *
 *   1. **Lazy open.** `register` records a path, nothing more. Connections are
 *      created on first `resolve`. The machine has dozens of empty DBs; opening
 *      them all at startup would waste fds and slow the boot.
 *   2. **One connection per path.** The only place `openMemoryStore` is called
 *      is `openInto`, and concurrent resolves of the same path dedupe through
 *      `inflight`. This matters because `ChangeDetector` binds `PRAGMA
 *      data_version` to the connection it was built on — two connections for
 *      one path would silently make `changed` permanently false.
 *   3. **LRU cap (default 8).** `evictBeyondLimit` retires the least recently
 *      used entry that is neither pinned nor in flight. It runs before opening,
 *      and targets `limit - 1` so the peak is exactly `limit`.
 *   4. **Closing failures are not fatal.** A failed `close()` is logged and the
 *      entry is dropped anyway.
 *   5. **A vanished file is never silently forgotten.** `resolve` stats the
 *      path and throws `DbUnavailableError`; the registration stays.
 *
 * Ownership rule, in one line: **whoever opens it closes it.** This registry
 * closes only the connections it opened itself. The process DB was opened by
 * `cli.ts` and is `adopt`ed — `server.ts` closes it.
 */
import { type Stats, statSync } from "node:fs";
import path from "node:path";
import { openMemoryStore } from "../index.ts";
import type { MemoryStore } from "../store.ts";
import { admitForRegistration, checkPathAllowed, type PathPolicy } from "./db-path-policy.ts";
import { invalidateStats } from "./discovery.ts";

/** A registered path and its connection, if it currently has one (§3.2 frozen shape). */
export interface RegisteredDb {
	/** Absolute path, which is also the DB id. `path.resolve` output — never a realpath. */
	path: string;
	/** The open DB, or null while unopened (lazy loading). */
	entry: StoreEntry | null;
}

/** A live connection plus the bookkeeping that keeps it alive (§3.2 frozen shape + `inFlight`). */
export interface StoreEntry {
	store: MemoryStore;
	/** Pairs 1:1 with the connection. For display in `/api/databases`, not a decision input. */
	openedAt: string;
	/** For LRU ordering. */
	lastUsedAt: number;
	/** In-flight request count. An entry with `inFlight > 0` MUST NOT be evicted. */
	inFlight: number;
}

/**
 * A registered DB cannot serve a request right now.
 *
 * `path-escalated` is the one reason that is not about the file itself: it means
 * the path resolved outside the allowed roots at (re)open time, which is what a
 * symlink that was re-pointed after registration looks like.
 *
 * `hardlink` is a registration-time rejection only — a file with more than one
 * link cannot be proven to be the file inside `roots`, since hard links have no
 * "target" for `realpath` to follow.
 */
export class DbUnavailableError extends Error {
	readonly reason: "missing" | "not-a-file" | "path-escalated" | "hardlink";
	readonly path: string;

	constructor(reason: DbUnavailableError["reason"], path_: string, detail: string) {
		super(detail);
		this.name = "DbUnavailableError";
		this.reason = reason;
		this.path = path_;
	}
}

export interface StoreRegistryOptions {
	/** Cap on simultaneously open DBs. Default 8. Injectable so tests can shrink it. */
	limit?: number;
	/**
	 * ⭐ Path policy. REQUIRED, and deliberately not `PathPolicy | null`.
	 *
	 * A policy that may be omitted means a forgotten policy silently disables the
	 * roots check — the failure mode this round kept hitting ("tests green,
	 * production dead code"). Required means forgetting it is a compile error.
	 *
	 * `--allow-any-path` is expressed as `{ roots: [], allowAnyPath: true }`, NOT
	 * as a missing policy: a second "no check" truth source would be fail-open.
	 */
	policy: PathPolicy;
	onLog?: (line: string) => void;
}

const DEFAULT_LIMIT = 8;

export class StoreRegistry {
	private readonly dbs = new Map<string, RegisteredDb>();
	/** Path → in-progress open. This IS the "one connection per path" mechanism. */
	private readonly inflight = new Map<string, Promise<StoreEntry>>();
	/** Paths that must never be evicted (adopted process DBs). */
	private readonly pinned = new Set<string>();
	private readonly limitValue: number;
	private readonly onLog: (line: string) => void;
	private readonly policy: PathPolicy;
	private closed = false;

	/**
	 * ⚠️ `opts` itself is required, not just `policy`. Making the container
	 * optional would let `new StoreRegistry()` compile, and the required-field
	 * guarantee would be void: a required field's requirement is cancelled by its
	 * container's optionality.
	 */
	constructor(opts: StoreRegistryOptions) {
		if (!opts || typeof opts !== "object") {
			throw new Error(
				"StoreRegistry 需要一个选项对象（至少要提供 policy），不能省略构造参数。" +
					"policy 必填是安全要求（roots 检查不能靠忘了就静默关掉）。",
			);
		}
		if (!opts.policy || typeof opts.policy !== "object") {
			throw new Error(
				"StoreRegistry 需要 policy（roots 包含性检查的唯一依据）。" +
					"允许任意路径请显式传 { roots: [], allowAnyPath: true }。",
			);
		}
		this.policy = opts.policy;
		this.limitValue = opts.limit ?? DEFAULT_LIMIT;
		this.onLog = opts.onLog ?? (() => {});
	}

	/**
	 * The single key normalization. `path.resolve` is idempotent, so this is
	 * free for already-normalized values, and it is applied at every entry point
	 * (`resolve` / `register` / `adopt` / `entryOf`) so no caller has to
	 * remember it. The alternative — each caller normalizing — produces a silent
	 * 404 the moment one of them forgets.
	 *
	 * Deliberately NOT a realpath: the DB id must stay the `path.resolve` result
	 * so it equals what `--db` produced and what `POST /api/databases/open`
	 * stored. `:memory:` is rejected outright — `path.resolve(":memory:")` would
	 * fabricate `<cwd>/:memory:`.
	 */
	private static key(raw: string): string {
		if (raw === ":memory:") throw new Error("StoreRegistry 不接受 :memory:");
		return path.resolve(raw);
	}

	/** Pure lookup: normalizes, then reads the map. No stat, no open, no throw. */
	entryOf(raw: string): StoreEntry | null {
		return this.dbs.get(StoreRegistry.key(raw))?.entry ?? null;
	}

	/**
	 * Is this path registered? Registered, NOT "open": an entry evicted by the
	 * LRU keeps its registration (`entry: null`), and the caller that asks
	 * (`POST /api/databases/open` computing `already_registered`) is asking about
	 * registration. Answering "open" would report a false `false` for a DB the
	 * user registered earlier and the LRU has since retired.
	 */
	has(raw: string): boolean {
		return this.dbs.has(StoreRegistry.key(raw));
	}

	get openCount(): number {
		let open = 0;
		for (const reg of this.dbs.values()) if (reg.entry) open++;
		return open;
	}

	get limit(): number {
		return this.limitValue;
	}

	/** Snapshot of every registration, opened or not, in insertion order. */
	list(): RegisteredDb[] {
		return [...this.dbs.values()].map((reg) => ({ path: reg.path, entry: reg.entry }));
	}

	/**
	 * The only way a request reaches a DB. Returns null for an unregistered path
	 * — it never registers on the caller's behalf, because registration is the
	 * admission gate (`probeMemoryDb` + the roots check) and must stay an
	 * explicit user action.
	 *
	 * Every successful return increments the entry's `inFlight`; the caller MUST
	 * `release(entry)` in a `finally`, or the entry can never be evicted.
	 */
	async resolve(raw: string): Promise<StoreEntry | null> {
		if (this.closed) throw new Error("registry is closed");
		const p = StoreRegistry.key(raw);
		const reg = this.dbs.get(p);
		if (!reg) return null;

		// ① The file must still be there. Checked even for a live entry: POSIX
		// keeps the fd valid, but serving a snapshot of a deleted DB is exactly
		// what "never silently forget a vanished DB" forbids.
		let stats: Stats;
		try {
			stats = statSync(p);
		} catch {
			throw new DbUnavailableError("missing", p, `记忆库文件不存在：${p}`);
		}
		if (!stats.isFile()) {
			throw new DbUnavailableError("not-a-file", p, `记忆库路径不是普通文件：${p}`);
		}

		// ② ⭐ R5: re-run the path policy on EVERY resolve, before the entry
		// check — not only on the lazy-open branch. Registration and opening are
		// separated in time: a symlink inside `roots` can be re-pointed outside
		// them afterwards, and the next reopen (which LRU eviction makes
		// inevitable) would otherwise pour the memory schema into a file outside
		// `roots`. No race has to be won for this: one eviction is enough.
		//
		// ⭐ `pinned` is exempt: the process DB is explicitly chosen via `--db`
		// and is not subject to `roots` (a legal configuration). Without the
		// exemption, the frontend attaching `?db=<process db>` to every request
		// would 409 the entire UI while the same DB still answers without `?db=`.
		if (!this.pinned.has(p) && !checkPathAllowed(this.policy, p).ok) {
			throw new DbUnavailableError(
				"path-escalated",
				p,
				`记忆库路径已超出允许范围（roots 内的符号链接被重定向？）：${p}`,
			);
		}

		if (reg.entry) {
			reg.entry.lastUsedAt = Date.now();
			reg.entry.inFlight++;
			return reg.entry;
		}

		// ③ Lazy open, deduped. Between the entry check above and this write
		// there is no `await` (both stats are synchronous), so no other request
		// can interleave here — which is why this needs no lock. The only real
		// interleaving window is the open itself, and that is what `inflight`
		// covers.
		const existing = this.inflight.get(p);
		if (existing) {
			const entry = await existing;
			entry.lastUsedAt = Date.now();
			entry.inFlight++;
			return entry;
		}

		// Make room BEFORE opening, so the peak never exceeds `limit`.
		this.evictBeyondLimit(p);
		const opening = this.openInto(p);
		this.inflight.set(p, opening);
		try {
			return await opening;
		} finally {
			// MUST clear: a permanently rejected promise pinned to this path would
			// fail every later request with the same stale error.
			this.inflight.delete(p);
		}
	}

	/**
	 * Register a path whose probe already passed, then open it.
	 *
	 * Registration-time admission runs here — including `admitForRegistration`
	 * (the hard-link guard) — because `/api/databases/open` is only ONE caller of
	 * `register`. Putting the guard in that handler would mean "every caller must
	 * remember to call it", which is the discipline-as-defense pattern this
	 * round rejected three times.
	 */
	async register(raw: string): Promise<StoreEntry> {
		const p = StoreRegistry.key(raw);
		const reg = this.dbs.get(p);
		// Already registered AND open: idempotent, and the admission guard is NOT
		// re-run. Re-running it here would break documented `/open` idempotency
		// and re-create the false positive on a DB that was hard-link-backed up
		// (`cp -al` bumps the user's own DB to nlink=2) after registration.
		if (reg?.entry) {
			reg.entry.lastUsedAt = Date.now();
			return reg.entry;
		}
		// ⚠️ The condition is `!reg`, not "after the early return": an entry that
		// was evicted leaves the registration behind (`entry: null`), and
		// re-checking nlink then would refuse a DB the user already registered.
		if (!reg) {
			const admission = admitForRegistration(p);
			if (!admission.ok) throw new DbUnavailableError("hardlink", p, admission.detail);
			this.dbs.set(p, { path: p, entry: null });
		}
		// MUST go through `resolve`'s dedupe path: calling `openInto` directly
		// would race a concurrent resolve into building a second connection.
		const entry = (await this.resolve(p)) ?? (await this.resolve(this.ensureRegistered(p)));
		if (!entry) throw new DbUnavailableError("missing", p, `无法打开记忆库：${p}`);
		this.release(entry); // register holds no request: return the reference it raised
		return entry;
	}

	/**
	 * Take ownership of an already-open store. The ONLY legal caller is
	 * `cli.ts` adopting the process DB.
	 *
	 * ⚠️ `adopt` unconditionally pins, and pinned entries are never closed by
	 * this registry — deliberately so for the process DB (`server.ts` closes
	 * it). But that makes it wrong for anything else: a connection adopted for,
	 * say, a newly created DB would live until process exit (fd leak, and the
	 * LRU cap would stop holding). Newly created/opened DBs MUST use
	 * `register`, which owns what it opens.
	 */
	adopt(raw: string, store: MemoryStore): StoreEntry {
		const p = StoreRegistry.key(raw);
		const entry: StoreEntry = { store, openedAt: new Date().toISOString(), lastUsedAt: Date.now(), inFlight: 0 };
		this.dbs.set(p, { path: p, entry });
		this.pinned.add(p);
		return entry;
	}

	/**
	 * Hand back a lease. Idempotent and safe for an entry that has since been
	 * evicted.
	 *
	 * Takes the `entry`, not a path: with a path, the sequence "A holds entry →
	 * entry evicted → B reopens the same path → A releases by path" would
	 * decrement B's count, and the reference count would drift by one without
	 * anyone noticing.
	 */
	release(entry: StoreEntry): void {
		entry.inFlight = Math.max(0, entry.inFlight - 1);
		entry.lastUsedAt = Date.now();
	}

	/**
	 * Retire least-recently-used entries until there is room for one more open.
	 *
	 * The target is `limit - 1` because the caller is about to open one: using
	 * `limit` would make the peak `limit + 1`.
	 *
	 * Pinned entries occupy a slot but are never candidates. So if pinned count
	 * alone reaches the limit, nothing can be evicted and this logs and allows
	 * the overage — correctness beats the cap: closing an in-use or owned
	 * connection would produce a 500, which is far worse than a few extra fds.
	 */
	evictBeyondLimit(keepPath: string): void {
		const target = Math.max(0, this.limitValue - 1);
		const candidates: RegisteredDb[] = [];
		for (const reg of this.dbs.values()) {
			if (!reg.entry) continue;
			if (reg.path === keepPath) continue;
			if (this.pinned.has(reg.path)) continue;
			if (reg.entry.inFlight > 0) continue;
			candidates.push(reg);
		}
		candidates.sort((a, b) => (a.entry?.lastUsedAt ?? 0) - (b.entry?.lastUsedAt ?? 0));
		let open = this.openCount;
		for (const reg of candidates) {
			if (open <= target) break;
			this.closeEntry(reg);
			open--;
		}
		if (open > this.limitValue) {
			this.onLog(`⚠️ 注册表超出上限（${open}/${this.limitValue}）：候选都在使用中或已固定。`);
		}
	}

	/** Close every connection this registry opened. Idempotent. */
	closeAll(): void {
		this.closed = true;
		for (const reg of this.dbs.values()) this.closeEntry(reg);
		this.dbs.clear();
		this.pinned.clear();
		this.inflight.clear();
	}

	/** Re-register after a `closeAll` race, then hand the path back for another resolve. */
	private ensureRegistered(p: string): string {
		if (!this.dbs.has(p)) this.dbs.set(p, { path: p, entry: null });
		return p;
	}

	/**
	 * The ONLY place `openMemoryStore` is called. `resolve` is its only caller,
	 * and `register` reaches it through `resolve` — so there is no second opening
	 * path to break "one connection per path".
	 */
	private openInto(p: string): Promise<StoreEntry> {
		return openMemoryStore(p).then((store) => {
			const entry: StoreEntry = {
				store,
				openedAt: new Date().toISOString(),
				lastUsedAt: Date.now(),
				inFlight: 1,
			};
			// A closeAll may have landed while the open was in flight. Close
			// immediately rather than leak the fd.
			if (this.closed) {
				try {
					store.db.close();
				} catch {
					/* already closed */
				}
				throw new Error("registry is closed");
			}
			// This DB is about to be written to, so its cached stats are stale.
			invalidateStats(p);
			const reg = this.dbs.get(p);
			if (reg) reg.entry = entry;
			return entry;
		});
	}

	/**
	 * Drop one connection. Failing to close is logged, not fatal — the entry is
	 * dropped either way.
	 *
	 * Pinned entries are only dereferenced, never closed: ownership of an adopted
	 * connection is not ours.
	 */
	private closeEntry(reg: RegisteredDb): void {
		const entry = reg.entry;
		if (!entry) return;
		reg.entry = null;
		if (this.pinned.has(reg.path)) return;
		try {
			entry.store.db.close();
		} catch (error) {
			this.onLog(`⚠️ 关闭记忆库失败（${reg.path}）：${(error as Error).message}`);
		}
	}
}
