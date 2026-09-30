import ignore from "ignore";

/**
 * Stacked `.gitignore` matchers with git anchoring semantics: each `.gitignore`
 * file anchors to the directory that contains it, rules apply to paths below
 * that directory, and the deepest matching file wins (14-E §4.1 engine notes).
 * A semantic subset of full gitignore — the `ignore` package handles per-file
 * negation/anchoring; this class stacks per-directory instances.
 */
export class GitIgnoreChain {
	private readonly rules: Array<{ depth: number; matcher: ignore.Ignore }> = [];

	/** Register rules found in `<dir-at-depth>/.gitignore`. Depth = segment count of that dir relative to the walk root. */
	add(depth: number, content: string): void {
		if (!content.trim()) return;
		this.rules.push({ depth, matcher: ignore().add(content) });
	}

	/**
	 * Whether a path (relative to the walk root, as segments) is ignored.
	 * `isDir` appends "/" so dir-only rules (`dist/`) match directory candidates.
	 */
	ignores(relParts: string[], isDir: boolean): boolean {
		for (let i = this.rules.length - 1; i >= 0; i--) {
			const rule = this.rules[i];
			// Rules only apply to entries strictly below their anchoring directory.
			if (relParts.length <= rule.depth) continue;
			const sub = relParts.slice(rule.depth).join("/");
			if (rule.matcher.ignores(isDir ? `${sub}/` : sub)) return true;
		}
		return false;
	}
}
