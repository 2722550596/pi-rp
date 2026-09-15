/**
 * V11b — the tree cache's db identity, driven for real.
 *
 * Source of truth: `plan/memory-web/15-多库测试与文档.md` §3.6 and contract §7.6/§7.10.
 *
 * ⚠️ This test file is `.js`, not `.ts`, ON PURPOSE — and it is the designed
 * shape, not a way around a checker. `views/tree-cache.js` is plain browser ESM
 * that no build step compiles, and the repo's relative-`.js`-import rule exists to
 * stop *TypeScript sources* from resolving to unemitted output; it never scanned
 * `.js` test files. So this file imports the REAL module with a REAL static
 * import: no indirection, no `allowJs`, no lint exemption.
 *
 * The trade-off, stated explicitly: `.js` means `tsgo` does NOT type-check this
 * file, so the discipline comes from the code — no `any`, no `as`, and every
 * assertion carries its own runtime check.
 *
 * ## Why this file must exist separately from `multi-db-frontend.test.ts`
 *
 * `tree-cache.js` was extracted precisely so these assertions CAN run: it has no
 * evaluation-time side effects, unlike `app.js`/`tree.js` (importing those throws
 * `ReferenceError: document is not defined`). V11a/V11c/V11d and V12 stay in the
 * `.ts` file as static sentinels because they inspect source that cannot be
 * imported; THIS file is the behavioural half — the part that would actually go
 * red if the guard were removed rather than merely renamed.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { currentGen, ensureCacheFor, parentOf, treeCache } from "../../src/web/assets/views/tree-cache.js";

beforeEach(() => {
	// Each case needs a clean module-level cache and an unclaimed owner.
	treeCache.clear();
	ensureCacheFor("__reset__");
	ensureCacheFor("__case_start__");
});

describe("V11b · switching dbs empties the cache", () => {
	it("⭐⭐ a switch flushes the cache; a repeat mount does not", () => {
		// This is the "read A, write B" defect stated as an assertion: the cache key
		// is `${domain}|${parentUri}` with NO db identity, so without this guard a
		// request after a switch hits A's cached subtree while the write goes to B.
		ensureCacheFor("A"); // first claim adopts A without clearing (a mount is not a switch)
		treeCache.set("core|", { items: [{ uri: "core://a" }], total: 1 });
		treeCache.set("core|core://a", { items: [], total: 0 });
		expect(treeCache.size).toBe(2);

		// Re-entering with the SAME db must not flush — otherwise every mount would
		// throw the cache away and the guard would cost more than it protects.
		ensureCacheFor("A");
		expect(treeCache.size).toBe(2);

		// A different db must flush ALL of it, not just the matching keys.
		ensureCacheFor("B");
		expect(treeCache.size).toBe(0);
	});

	it("⭐ the generation advances on a switch, so in-flight responses can be dropped", () => {
		// `loadLayer` captures the generation before awaiting and re-reads it after;
		// a difference means the response belongs to the previous db and is discarded.
		ensureCacheFor("A");
		const genA = currentGen();
		ensureCacheFor("A");
		expect(currentGen(), "same db ⇒ no bump").toBe(genA);
		ensureCacheFor("B");
		expect(currentGen(), "switch ⇒ bump").not.toBe(genA);
	});

	it("a missing/blank db id counts as ONE db, not as a switch", () => {
		// `ctx.currentDb` can be absent on legacy call paths. Normalizing both
		// `undefined` and `""` to one value keeps the behavior predictable (no
		// repeated clearing on every call) instead of flushing each time.
		ensureCacheFor(undefined);
		treeCache.set("k", 1);
		ensureCacheFor("");
		expect(treeCache.size).toBe(1);
		// …while a real path still differs, so the guard is not inert.
		ensureCacheFor("A");
		expect(treeCache.size).toBe(0);
	});
});

describe("V11 control · `parentOf` keeps its frozen semantics (moved verbatim)", () => {
	it("resolves ancestors, and the known first-level quirk stays as-is", () => {
		// It moved from `tree.js` to `tree-cache.js` alongside the cache, so a
		// silent behavior edit during the move would otherwise be invisible.
		expect(parentOf("core://a/b/c")).toBe("core://a/b");
		expect(parentOf("")).toBe("");
		// ⚠️ REAL, PRE-EXISTING DEFECT, asserted as-is: `parentOf("core://a")` is
		//    `"core:/"` — a malformed uri — not the root `""`. Consequence:
		//    `invalidateTreeFor`'s parent-layer branch never matches a first-level
		//    node's parent (the root layer and the node's own layer still
		//    invalidate correctly). Registered as `12-多库安全与路径校验.md` §11 U17
		//    and deliberately NOT fixed here: this feature only MOVED the function,
		//    and changing its semantics would alter existing cache-invalidation
		//    behavior. Pinning the wrong value on purpose keeps the defect visible
		//    to the next reader instead of looking like an accident.
		expect(parentOf("core://a")).toBe("core:/");
	});
});
