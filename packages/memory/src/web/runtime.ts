/**
 * Per-process web runtime state (plan/memory-web/01-服务端与API.md §4.2, §10.3).
 *
 * `PRAGMA data_version` is a PER-CONNECTION counter, so `ChangeDetector` must
 * read it off the one connection the process owns. `dispatch` receives a bare
 * `ServerContext`, so the detector is attached to the store instance and reused
 * across requests — deriving a fresh baseline every request would make
 * `changed` permanently false.
 */
import type { MemoryStore } from "../store.ts";
import { ChangeDetector } from "./change-detect.ts";
import type { ServerContext } from "./server.ts";
import { createVisibility, type Visibility } from "./visibility.ts";

const detectors = new WeakMap<MemoryStore, ChangeDetector>();

export function borrowDetector(ctx: ServerContext): ChangeDetector {
	let detector = detectors.get(ctx.store);
	if (!detector) {
		detector = new ChangeDetector(ctx.store);
		detectors.set(ctx.store, detector);
	}
	return detector;
}

/**
 * The visibility predicates for this request. Derived FRESH every time: the
 * branch state it reads (`raw_log.active`) moves under external writes, so a
 * cached index would keep reporting a rolled-back node as visible. `shadowed`
 * is step 1 (the unconditional Web default, §6.6); views receive both so they
 * can label foreign-session nodes without re-deriving the rule.
 */
export function visibilityFor(ctx: ServerContext): Visibility {
	return createVisibility(ctx.store);
}
