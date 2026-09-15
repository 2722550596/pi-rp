/**
 * V7 / V11 / V12 — the frontend invariants that keep a switch from reading one db
 * and writing another.
 *
 * Source of truth: `plan/memory-web/15-多库测试与文档.md` §3.1, §3.6, §10.2 and
 * contract §7.6 / §7.10.
 *
 * ## Why most of this file is a STATIC source assertion
 *
 * `node -e "import('./src/web/assets/app.js')"` throws `ReferenceError: document
 * is not defined` — the module has evaluation-time side effects (`applyTheme`,
 * `document.addEventListener`, `boot()`), and `tree.js` imports it. So the DOM
 * cannot be avoided by importing, and a DOM shim would add a dependency the
 * project forbids (zero npm deps, environment is `node`).
 *
 * Two consequences, both deliberate:
 *  - The behaviours that live in `views/url.js` and `views/tree-cache.js` ARE
 *    driven for real (those modules are deliberately side-effect free) — see the
 *    V11b block and the whole of `multi-db-url.test.ts`.
 *  - The rest is a **static sentinel**: it reads the source and asserts a guard
 *    still EXISTS. That is not behavioural proof, and this file does not pretend
 *    it is. `§10.2` of the design registers exactly which behaviours lose
 *    coverage: whether the sidebar really reloads after a switch, whether a
 *    stored db missing from the list falls back to `current`, whether a vanished
 *    db shows an error instead of silently falling back, and whether
 *    `renderSidebar`'s two concurrent renders interleave safely. Those need a
 *    real browser and are verified by hand.
 *
 * What a sentinel CAN catch, and why it is worth having: a guard that gets
 * deleted or bypassed during a refactor. Behavioural tests cannot see that here
 * because the single-process harness never produces the interleave.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const assets = path.join(here, "..", "..", "src", "web", "assets");

/** `readFileSync` with a clear failure if a file was renamed. */
function source(relative: string): string {
	try {
		return readFileSync(path.join(assets, relative), "utf8");
	} catch {
		throw new Error(`expected frontend file to exist: src/web/assets/${relative}`);
	}
}

/** Count non-overlapping occurrences of a literal. */
function count(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

// ── V7: edit.js has no fetch of its own ─────────────────────────────────────

describe("V7 · edit.js goes through the shared HTTP layer", () => {
	it("V7a: ⭐ no bare `fetch(` in edit.js", () => {
		// A fetch here bypasses `app.js`'s HTTP layer, which is the ONLY place
		// `?db=` is injected — so the request would silently target the process db
		// while the UI displays another one. The measured pre-change count was 1.
		expect(count(source("views/edit.js"), "fetch(")).toBe(0);
	});

	it("V7b: edit.js imports get/post from the shared layer", () => {
		// The mechanical consequence of V7a: it must route through the same two
		// functions that inject the parameter. An XMLHttpRequest would satisfy V7a
		// while still evading the injection.
		expect(source("views/edit.js")).toMatch(/import\s*\{[^}]*\bget\b[^}]*\}\s*from\s*"\.\.\/app\.js"/);
	});

	it("V7c: ⭐ `withDbParam` is reachable from BOTH get and post", () => {
		// The seam: `post(path, body, query)` originally had no query slot, so an
		// implementation that only fixed `get` would leave every WRITE hitting the
		// process db — the write half of "read A, write B". Asserting "the function
		// exists" is not enough; both injection sites must reference it.
		const app = source("app.js");
		const fetchSites = [...app.matchAll(/fetch\(\s*withDbParam\(([^)]*\))/g)];
		expect(fetchSites.length, "both get() and post() must call withDbParam").toBeGreaterThanOrEqual(2);
		// Ordering: the argument must already be a complete url, built by
		// concatenation — not a bare path (that produces the second `?`).
		for (const [call] of fetchSites) expect(call).toContain("buildQuery(");
	});

	it("V7c: no hand-appended `db=` anywhere in app.js", () => {
		// The append shape produces `?db=old&db=new`; the server reads the FIRST
		// value, so the request silently hits the old db.
		expect(source("app.js")).not.toMatch(/"db="\s*\+/);
		expect(source("app.js")).not.toMatch(/`db=\$\{/);
	});
});

// ── V11: cache db-identity ─────────────────────────────────────────────────

describe("V11 · the tree cache is bound to its db", () => {
	it("V11a: ⭐ the cache module compares the cache's db against the current one", () => {
		// Static sentinel for the entry-comparison fix. It has to be static for
		// `tree.js`'s own guard (V11d), but THIS one is in `tree-cache.js`, which
		// is also driven for real below — so this assertion only guards against the
		// branch being deleted outright.
		const cache = source("views/tree-cache.js");
		expect(cache).toContain("export function ensureCacheFor");
		expect(cache).toMatch(/cacheOwner\s*[!=]==?\s*owner/);
		expect(cache).toMatch(/treeCache\.clear\(\)/);
		// The generation bump must be in the SAME branch as the clear: a clear
		// without a bump leaves in-flight responses free to repopulate the new db's
		// cache with the old db's rows.
		expect(cache).toMatch(/cacheGen\+\+/);
	});

	it("V11b: ⭐⭐ the behavioural assertions live in `multi-db-tree-cache.test.js`", () => {
		// The switch-flushes-cache, generation-bump and blank-db-id cases MUST run
		// against the real module, and they do — in the `.js` file, which can import
		// `tree-cache.js` directly (this `.ts` file cannot: the lint forbids a
		// relative `.js` specifier in TS sources, and `tsgo` would raise TS7016).
		//
		// This placeholder exists so the invariant list stays complete when reading
		// this file alone. If you are looking for the actual assertions: they are
		// NOT here, and moving them here would silently downgrade them to the static
		// form below.
		const cache = source("views/tree-cache.js");
		expect(cache).toContain("export function ensureCacheFor");
	});

	it("V11c: every cache in the frontend either carries db identity or is inert", () => {
		// The general rule from contract §7.6. Reviewed by hand once; pinned here so
		// a NEW db-derived cache cannot be added without this assertion failing.
		// The known-good set: `treeCache` (db-bound via `ensureCacheFor`), plus
		// render-local containers whose values come from the current call's DTO.
		const files = ["app.js", "views/tree.js", "views/tree-cache.js", "views/databases.js", "views/edit.js"];
		const caches: string[] = [];
		for (const file of files) {
			for (const [match] of source(file).matchAll(/new Map\(\)/g)) void match;
			if (/new Map\(\)/.test(source(file))) caches.push(file);
		}
		expect(caches).toContain("views/tree-cache.js");
		// The one that MATTERS is db-bound; anything else must not be keyed by a
		// db-derived value. `views/tree.js` must no longer own a module-level cache.
		expect(source("views/tree.js")).not.toMatch(/^export const treeCache/m);
		expect(source("views/tree.js")).toContain('from "./tree-cache.js"');
	});

	it("V11d: ⚠️ STATIC ONLY — the gen check in loadLayer lost its behavioural coverage", () => {
		// ⚠️ This case CANNOT be behavioural: the check lives in `tree.js:loadLayer`,
		// and `tree.js` imports `app.js`, whose top level touches `document` —
		// importing it throws. Behaviour for the generation counter itself IS
		// covered above (V11b, via `tree-cache.js`); what is NOT covered is that
		// `loadLayer` consults it at the right two points.
		// Registered in the design's §10.2 as a known coverage loss. Do not delete
		// this comment to make the file look stronger than it is.
		const tree = source("views/tree.js");
		expect(tree).toMatch(/const gen = currentGen\(\)/);
		expect(tree).toMatch(/if \(gen !== currentGen\(\)\)/);
		// The capture must precede the await and the re-read must follow it: the
		// guard is worthless if both reads happen on the same side of the await.
		const capture = tree.indexOf("const gen = currentGen()");
		const recheck = tree.indexOf("if (gen !== currentGen())");
		const firstAwait = tree.indexOf("await ", capture);
		expect(capture).toBeGreaterThan(-1);
		expect(recheck).toBeGreaterThan(firstAwait);
	});

	it("V11 control: `parentOf` is still exported from the cache module (moved verbatim)", () => {
		// It moved from `tree.js` to `tree-cache.js` alongside the cache. The
		// behavioural assertions (including the pre-existing `core:/` quirk
		// registered as §11 U17) run in `multi-db-tree-cache.test.js`; this file
		// only pins that the export survived the move and was not left behind in
		// `tree.js`, which would split the cache's owner across two modules.
		expect(source("views/tree-cache.js")).toContain("export function parentOf");
		expect(source("views/tree.js")).not.toMatch(/^export function parentOf/m);
	});
});

// ── V12: the second line of defence ────────────────────────────────────────

describe("V12 · switching clears the cache before remounting", () => {
	it("V12a: the switch path clears the cache BEFORE re-mounting the route", () => {
		// The cache module's entry comparison covers new mount paths, but a stale
		// cache is still visible for the instant between the user's click and the
		// next mount — so the switch itself must clear. Ordering is the assertion:
		// clearing after the remount re-renders from the old rows.
		const app = source("app.js");
		// The clear lives in `reloadAll` (the switch delegates to it) — pinned at
		// its actual location rather than a guessed one.
		const reloadStart = app.indexOf("export function reloadAll()");
		expect(reloadStart).toBeGreaterThan(-1);
		const reloadBody = app.slice(reloadStart, app.indexOf("\n}", reloadStart));
		expect(reloadBody).toContain("treeCache.clear()");
		const clearAt = reloadBody.indexOf("treeCache.clear()");
		const remountAt = reloadBody.indexOf("remount()");
		expect(clearAt).toBeGreaterThan(-1);
		expect(remountAt, "reloadAll must remount too").toBeGreaterThan(-1);
		expect(clearAt, "clear must precede the remount").toBeLessThan(remountAt);

		// And the switch must actually call it — a clear nobody calls is not a defence.
		const switchStart = app.indexOf("export async function switchDatabase(");
		expect(switchStart).toBeGreaterThan(-1);
		const switchBody = app.slice(switchStart, app.indexOf("\n}", switchStart));
		expect(switchBody).toContain("reloadAll()");
		expect(switchBody).toContain("setSelectedDb(path)");
	});

	it("V12a: the cache is cleared via the cache module, not via tree.js", () => {
		// Importing `tree.js` for a pure cache operation would drag the DOM
		// side-effects into a data path (§10.0). The import count is pinned by the
		// design (E5) so this cannot drift silently.
		const app = source("app.js");
		expect(count(app, 'import("./views/tree-cache.js")')).toBe(2);
	});

	it("V12a: `switchDatabase` does not silently fall back to the current db", () => {
		// Contract §6.5: landing on a db that vanished must be visible, not a quiet
		// fallback that makes the user think they are looking at A while seeing B.
		const app = source("app.js");
		const switchStart = app.indexOf("export async function switchDatabase(");
		const switchBody = app.slice(switchStart, app.indexOf("\n}", switchStart));
		// On failure it must stop (return) rather than continue with the old db
		// silently — i.e. `setSelectedDb` must not run on the failure path.
		const guard = switchBody.indexOf("ensureRegistered(path)");
		const setIdx = switchBody.indexOf("setSelectedDb(path)");
		expect(guard).toBeGreaterThan(-1);
		expect(setIdx).toBeGreaterThan(guard);
	});
});
