/**
 * `GET /api/events` — change detection via `PRAGMA data_version` (§7.4).
 *
 * `data_version` is a PER-CONNECTION counter, measured on node 22 + this
 * machine (plan/memory-web/00-共同上下文.md §7.4 实测记录):
 *
 *   this connection's own committed write   -> unchanged   ⚠️
 *   another connection's committed write    -> increments
 *   read-only                               -> unchanged
 *
 * Two consequences the server must honour:
 *   1. Reads must happen on ONE connection. The process opens exactly one
 *      `MemoryStore` (§4.2), so the prepared statement below is stable.
 *   2. The server cannot see its own writes, so the client must refresh after
 *      its own POST instead of waiting for the poll to notice.
 *
 * `changed` is false on the first call: there is no baseline yet, and
 * reporting a phantom change would make every page load look like a write.
 */
import type { MemoryStatement } from "../driver.ts";
import type { MemoryStore } from "../store.ts";

export interface ChangeEvent {
	version: number;
	changed: boolean;
}

export class ChangeDetector {
	private last: number | null = null;
	private readonly stmt: MemoryStatement;

	constructor(store: MemoryStore) {
		this.stmt = store.db.prepare("PRAGMA data_version");
	}

	read(): ChangeEvent {
		// The row object is null-prototype (no `hasOwnProperty`), so read the
		// column directly and never call a host method on it.
		const row = this.stmt.get() as { data_version: number } | undefined;
		const version = Number(row ? row.data_version : 0);
		const changed = this.last !== null && version !== this.last;
		this.last = version;
		return { version, changed };
	}
}
