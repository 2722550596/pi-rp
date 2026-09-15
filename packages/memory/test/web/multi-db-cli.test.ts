/**
 * V4d — the CLI keeps working without the new flags, and gains them safely.
 *
 * Source of truth: `plan/memory-web/15-多库测试与文档.md` §3.1 (V4d) and
 * `11-多库发现与注册表.md` §8 (the `--roots` / `--allow-any-path` contract).
 *
 * Why this file exists at all: `web-launcher.test.ts` (coding-agent) spawns the
 * CLI with **only** `--db` / `--port`, and it uses a fake http server for the port
 * probe. So it can prove the launcher's own three-state logic, but it CANNOT
 * catch "the CLI grew a required flag" — the launcher would just fail to spawn a
 * server and the reuse path would look merely `free`. These cases close that gap
 * by calling `parseCliArgs` directly: it is the single place the argv contract
 * lives, and multi-db must leave it backwards compatible.
 *
 * ⚠️ `parseCliArgs` mutates nothing and starts nothing, so these are pure
 * assertions — no server, no DB, no temp dir needed except where the default
 * root (`cwd`) has to be compared.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../../src/web/cli.ts";

/** Narrow the union result, failing loudly if the parser chose `--help`. */
function optionsOf(argv: string[]): {
	dbPath: string;
	port: number;
	host: string;
	roots: string[];
	allowAnyPath: boolean;
} {
	const parsed = parseCliArgs(argv);
	if ("help" in parsed) throw new Error(`parseCliArgs(${argv.join(" ")}) returned --help`);
	return parsed;
}

describe("V4d · CLI multi-db flags are additive", () => {
	it("accepts the launcher's exact argv without the new flags", () => {
		// This is the argv `web-launcher.ts` builds: nothing but an absolute `--db`
		// and a port. If multi-db made either flag mandatory, spawning would throw
		// and `/memories web` would report a port conflict on a healthy machine.
		expect(() => optionsOf(["--db", "/tmp/x.db", "--port", "5788"])).not.toThrow();
	});

	it("defaults roots to the current directory and allowAnyPath to false", () => {
		// The defaults ARE the security posture: `[cwd]` (never `$HOME`, never `/`)
		// and no escape hatch. Asserted on the parsed object, not on prose.
		const options = optionsOf(["--db", "/tmp/x.db"]);
		expect(options.roots).toEqual([process.cwd()]);
		expect(options.allowAnyPath).toBe(false);
	});

	it("is repeatable: each --roots appends, and each is resolved to absolute", () => {
		// Repeatability is what makes "point it at the worlds directory" usable for
		// more than one tree. Resolution happens here (once) rather than per
		// request, so the policy never sees a relative path.
		const options = optionsOf(["--db", "/tmp/x.db", "--roots", "a/b", "--roots", "/abs/other"]);
		expect(options.roots).toEqual([path.resolve("a/b"), "/abs/other"]);
		for (const root of options.roots) expect(path.isAbsolute(root), root).toBe(true);
	});

	it("--allow-any-path is opt-in and nothing else turns it on", () => {
		expect(optionsOf(["--db", "/tmp/x.db", "--roots", "/tmp"]).allowAnyPath).toBe(false);
		expect(optionsOf(["--db", "/tmp/x.db", "--allow-any-path"]).allowAnyPath).toBe(true);
	});

	it("--db and --host keep their existing meaning", () => {
		const options = optionsOf(["--db", "/tmp/x.db", "--host", "0.0.0.0", "--port", "6000"]);
		expect(options.dbPath).toBe("/tmp/x.db");
		expect(options.host).toBe("0.0.0.0");
		expect(options.port).toBe(6000);
	});

	it("rejects a misspelled flag instead of silently ignoring it", () => {
		// A silently-ignored `--root` would look like the scan range was applied
		// while it was not — the failure mode is invisible in the UI.
		expect(() => optionsOf(["--db", "/tmp/x.db", "--root", "/tmp"])).toThrow();
	});
});
