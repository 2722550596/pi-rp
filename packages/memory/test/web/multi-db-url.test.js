/**
 * V13 — URL construction: build the WHOLE url first, then inject `?db=`.
 *
 * Source of truth: `plan/memory-web/15-多库测试与文档.md` §3.7 and contract §7.7.
 *
 * This is the only file in the matrix that needs no server, no DB and no DOM: it
 * imports the pure functions from `views/url.js`, which is a separate module
 * precisely so that importing it does not evaluate `app.js` (whose top level
 * touches `document` — measured `ReferenceError`).
 *
 * The three-part criterion, all of which must hold:
 *   ① `?` appears EXACTLY once;
 *   ② the `db` value is non-empty and contains no `?`;
 *   ③ every OTHER parameter round-trips to its original value.
 *
 * ⚠️ Asserting only ① is not enough, and that is not hypothetical: with a second
 *    `?` the URL is still syntactically valid — it is SEMANTICALLY broken,
 *    because `domain=core` gets swallowed into the `db` value. The measured bad
 *    artifact was `/api/tree?db=%2F…memory.db?domain=core`, which makes every
 *    query-carrying request after a switch land on the wrong db (or 404).
 * ⚠️ `+` in a db path is the other silent-corruption case: `URLSearchParams`
 *    turns `+` into a space when it PARSES a query string, so a path containing
 *    `+` becomes a path that does not exist. Encoding correctly is the frontend's
 *    only defense (the server cannot recover it).
 */
import { beforeEach, describe, expect, it } from "vitest";
// ⚠️ This test file is `.js`, not `.ts`, ON PURPOSE, and it is the designed shape
// rather than a way around a checker: `views/url.js` is plain browser ESM that no
// build step compiles, and the repo's relative-`.js`-import rule exists to stop
// *TypeScript sources* from resolving to unemitted output — it never scanned `.js`
// test files. Writing the file in `.js` therefore satisfies the rule's intent, and
// the import below is a real static import of the real module: no indirection, no
// `allowJs`, no lint exemption.
//
// The trade-off, stated explicitly: `.js` means `tsgo` does NOT type-check this
// file, so the discipline has to come from the code itself. Hence: no `any`, no
// `as`, and every assertion keeps its own runtime check.
import {
	DB_ADMIN,
	DB_KEY,
	DB_PARAM,
	buildQuery,
	getProcessDbPath,
	getSelectedDb,
	setProcessDbPath,
	setSelectedDb,
	withDbParam,
} from "../../src/web/assets/views/url.js";

// ── helpers ─────────────────────────────────────────────────────────────────

/** Parse a produced URL the way the SERVER does (`new URL(...).searchParams`). */
function parse(url) {
	return new URL(url, "http://localhost").searchParams;
}

/**
 * The full criterion from the header. Note ② is conditional: a *path* may
 * legitimately contain `?`, and it round-trips verbatim — what must never happen
 * is a `?` appearing in the value when the selected path has none, because that
 * is the signature of a swallowed query parameter (the measured bad artifact).
 */
function assertInjected(url, path, selected, expected) {
	expect(url.split("?").length - 1, `exactly one "?" in ${url}`).toBe(1);
	const params = parse(url);
	expect(params.get(DB_PARAM), `db value in ${url}`).toBe(selected);
	if (!selected.includes("?")) {
		expect(params.get(DB_PARAM) ?? "", `db value must not contain ? in ${url}`).not.toContain("?");
	}
	expect(params.getAll(DB_PARAM).length, `db appears once in ${url}`).toBe(1);
	expect(url.startsWith(`${path}?`), `path preserved in ${url}`).toBe(true);
	for (const [key, value] of Object.entries(expected)) {
		expect(params.get(key), `${key} in ${url}`).toBe(value);
	}
}

beforeEach(() => {
	setSelectedDb(null);
	setProcessDbPath(null);
});

// ── V13a: the frozen keys and the ordering rule ─────────────────────────────

describe("V13a · full URL first, then `?db=`", () => {
	it("the three frozen identifiers are exactly as the contract names them", () => {
		expect(DB_KEY).toBe("mw:db");
		expect(DB_PARAM).toBe("db");
		expect(DB_ADMIN).toBe("/api/databases");
	});

	it("⭐ `path + buildQuery(query)` then inject ⇒ one `?`, domain readable", () => {
		setSelectedDb("/tmp/memory.db");
		const out = withDbParam(`/api/tree${buildQuery({ domain: "core" })}`);
		assertInjected(out, "/api/tree", "/tmp/memory.db", { domain: "core" });
	});

	it("⭐ the bad shape is detectably bad (documents what this test prevents)", () => {
		// Reproducing the failure mode explicitly: injecting into a bare path and
		// appending the query afterwards yields `?db=<path>?domain=core`. This
		// asserts the criterion actually discriminates, rather than merely passing
		// on the correct output.
		setSelectedDb("/tmp/memory.db");
		const good = withDbParam("/api/tree");
		const brokenByConstruction = `${good}${buildQuery({ domain: "core" }).replace("?", "?")}`;
		const params = parse(brokenByConstruction);
		// The misuse is what `withDbParam` reserves for itself; here it is applied
		// by hand to show the criterion fails on it.
		expect(params.get("domain")).toBeNull();
		expect(params.get(DB_PARAM)).toContain("?");
	});
});

// ── V13b: pathological paths round-trip ─────────────────────────────────────

describe("V13b · `db` values with URL metacharacters survive", () => {
	// Six kinds, and `+` is the one that motivated the whole rule: `URLSearchParams`
	// decodes `+` as a space when parsing a query STRING, so a hand-built value
	// silently becomes a different (nonexistent) path.
	const odd = [
		"/tmp/a+b/x.db",
		"/tmp/a b/x.db",
		"/tmp/a&b/x.db",
		"/tmp/a?b/x.db",
		"/tmp/a#b/x.db",
		"/tmp/世界/记忆.db",
	];

	it.each(odd)("%s round-trips through withDbParam", (dbPath) => {
		setSelectedDb(dbPath);
		const out = withDbParam(`/api/node${buildQuery({ uri: "core://a" })}`);
		assertInjected(out, "/api/node", dbPath, { uri: "core://a" });
	});

	it("the `+` case specifically: it is NOT silently turned into a space", () => {
		// Isolated from the loop above because this is the one that corrupts data
		// rather than erroring: a space-containing path 404s, and the user cannot
		// tell why.
		setSelectedDb("/tmp/a+b/x.db");
		const out = withDbParam("/api/meta");
		expect(parse(out).get(DB_PARAM)).toBe("/tmp/a+b/x.db");
		expect(parse(out).get(DB_PARAM)).not.toBe("/tmp/a b/x.db");
		expect(out, "a literal space would mean the encoder was bypassed").not.toContain("%20+");
	});

	it("pathological paths also survive a second injection (idempotent-ish)", () => {
		setSelectedDb("/tmp/a+b/x.db");
		const once = withDbParam("/api/meta");
		const twice = withDbParam(once);
		expect(parse(twice).get(DB_PARAM)).toBe("/tmp/a+b/x.db");
		expect(parse(twice).getAll(DB_PARAM).length).toBe(1);
	});
});

// ── V13c: real data routes with their real queries ──────────────────────────

describe("V13c · every data route's own parameters survive", () => {
	const routes = [
		{ path: "/api/tree", query: { domain: "core" } },
		{ path: "/api/raw", query: { activeOnly: 1, limit: 20 } },
		{ path: "/api/view", query: { name: "forgotten", domain: "core" } },
		{ path: "/api/search", query: { q: "茶 与 剑", limit: 10 } },
		{ path: "/api/revisions", query: { uri: "core://identity/habits" } },
	];

	it.each(routes)("$path keeps every parameter", ({ path, query }) => {
		setSelectedDb("/tmp/memory.db");
		const out = withDbParam(path + buildQuery(query));
		const expected = {};
		for (const [key, value] of Object.entries(query)) {
			expected[key] = value === true ? "1" : value === false ? "0" : String(value);
		}
		assertInjected(out, path, "/tmp/memory.db", expected);
	});

	it("a parameter whose value contains `+` is not corrupted either", () => {
		// The same encoder serves every parameter, so this is the same bug class as
		// V13b — asserted separately because it would break search/uri lookups.
		setSelectedDb("/tmp/memory.db");
		const out = withDbParam(`/api/node${buildQuery({ uri: "core://a+b" })}`);
		expect(parse(out).get("uri")).toBe("core://a+b");
	});
});

// ── V13g: replacement, never appending ──────────────────────────────────────

describe("V13g · ⭐ an existing `db=` is REPLACED, exactly once", () => {
	it("`/api/node?db=<old>` becomes `db=<new>` with a single occurrence", () => {
		// Hand-appending would produce `db=<old>&db=<new>`, and the server reads the
		// FIRST value (`.get()`), so the request would silently hit the OLD db. That
		// is worse than the bug this feature is fixing: it reads the wrong db and
		// reports success.
		setSelectedDb("/tmp/new.db");
		const out = withDbParam(`/api/node?db=${encodeURIComponent("/tmp/old.db")}`);
		expect(parse(out).get(DB_PARAM)).toBe("/tmp/new.db");
		expect(parse(out).getAll(DB_PARAM).length).toBe(1);
		expect(out.split("?").length - 1).toBe(1);
	});

	it("a base with TWO existing db values still collapses to one", () => {
		// Reachable: any URL pasted into the hash route can carry a stale pair.
		setSelectedDb("/tmp/new.db");
		const out = withDbParam("/api/meta?db=%2Fold-a.db&db=%2Fold-b.db&x=1");
		expect(parse(out).get(DB_PARAM)).toBe("/tmp/new.db");
		expect(parse(out).getAll(DB_PARAM).length).toBe(1);
		expect(parse(out).get("x")).toBe("1");
	});

	it("`buildQuery` refuses a caller-supplied `db` (single owner of the key)", () => {
		// Otherwise a caller could smuggle a second value in and re-create the
		// ambiguity above through the front door.
		setSelectedDb("/tmp/new.db");
		expect(buildQuery({ db: "/tmp/smuggled.db", domain: "core" })).toBe("?domain=core");
		const out = withDbParam(`/api/tree${buildQuery({ db: "/tmp/smuggled.db", domain: "core" })}`);
		assertInjected(out, "/api/tree", "/tmp/new.db", { domain: "core" });
	});
});

// ── V13d/e/f: the lazy cases (no injection at all) ──────────────────────────

describe("V13d · the three management paths never carry `?db=`", () => {
	it("each of them, with and without a query, is returned UNCHANGED", () => {
		// Identity, not deep equality: a parse-and-rebuild implementation would
		// reorder or re-encode these and still "look" equal after parsing, while
		// silently changing what the browser caches.
		setSelectedDb("/tmp/memory.db");
		for (const url of [
			DB_ADMIN,
			`${DB_ADMIN}/open`,
			`${DB_ADMIN}/create`,
			`${DB_ADMIN}?x=1`,
			`${DB_ADMIN}/open?x=1`,
		]) {
			expect(withDbParam(url), url).toBe(url);
		}
		// The other side of the same rule: a data route DOES get the parameter.
		expect(withDbParam("/api/tree")).toContain("db=");
	});
});

describe("V13e · static assets never carry `?db=`", () => {
	it("assets are returned unchanged", () => {
		setSelectedDb("/tmp/memory.db");
		for (const url of ["/assets/app.js", "/assets/app.css", "/", "index.html"]) {
			expect(withDbParam(url), url).toBe(url);
		}
	});
});

describe("V13f · no db selected ⇒ no injection", () => {
	it("returns the input unchanged when `getSelectedDb()` is null", () => {
		setSelectedDb(null);
		expect(getSelectedDb()).toBeNull();
		expect(withDbParam("/api/tree")).toBe("/api/tree");
		expect(withDbParam("/api/tree?domain=core")).toBe("/api/tree?domain=core");
	});

	it("the empty string is treated as 'not selected', not as a db path", () => {
		// `?db=` is a lookup key the server resolves; an empty value would be
		// meaningless and must not be emitted (`db=` with no value).
		setSelectedDb("");
		expect(getSelectedDb()).toBeNull();
		expect(withDbParam("/api/tree")).toBe("/api/tree");
	});

	it("the process db path is tracked separately from the selection", () => {
		// `/api/databases` reports `current` = the process db; the SELECTION is
		// frontend-only state (contract §6.3). Conflating them is how the first
		// screen would start injecting `?db=` before the user chose anything.
		setProcessDbPath("/tmp/process.db");
		expect(getProcessDbPath()).toBe("/tmp/process.db");
		expect(getSelectedDb()).toBeNull();
		expect(withDbParam("/api/tree")).toBe("/api/tree");
	});

	it("`buildQuery` returns the empty string for no query", () => {
		expect(buildQuery(undefined)).toBe("");
		expect(buildQuery({})).toBe("");
		// So an existing caller that never passed a query is byte-identical.
		setSelectedDb("/tmp/memory.db");
		expect(buildQuery(undefined)).toBe("");
	});
});

// ── V13 degenerate inputs ───────────────────────────────────────────────────

describe("V13 degenerate inputs stay well-formed", () => {
	it("a trailing `?`, a bare `&`, and a dangling `=` do not produce a second `?`", () => {
		setSelectedDb("/tmp/memory.db");
		for (const input of ["/api/meta?", "/api/meta?&x=1", "/api/meta?a=1&", "/api/meta?x=1"]) {
			const out = withDbParam(input);
			expect(out.split("?").length - 1, input).toBe(1);
			expect(parse(out).get(DB_PARAM), input).toBe("/tmp/memory.db");
			expect(parse(out).getAll(DB_PARAM).length, input).toBe(1);
		}
	});

	it("a hash fragment survives and stays after the query", () => {
		// The hash is part of a URL the frontend may hand over; dropping it would
		// silently navigate elsewhere.
		setSelectedDb("/tmp/memory.db");
		const out = withDbParam("/api/meta#frag");
		expect(out).toContain("#frag");
		expect(out.indexOf("?")).toBeLessThan(out.indexOf("#frag"));
		expect(parse(out).get(DB_PARAM)).toBe("/tmp/memory.db");
	});
});
