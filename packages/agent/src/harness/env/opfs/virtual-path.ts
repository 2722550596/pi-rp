/**
 * Pure POSIX-style helpers for the browser virtual path namespace (contract §6.1): `/` is the OPFS root obtained from
 * `navigator.storage.getDirectory()`, and every path entering the storage seams is an absolute string in that
 * namespace. Pure string manipulation — no runtime fs access, shared by the async face and the sync face.
 */

/** Normalize to an absolute virtual path. Relative inputs resolve against `cwd`. */
export function normalizeVirtualPath(input: string, cwd: string): string {
	const segments = splitToSegments(input, cwd);
	return `/${segments.join("/")}`;
}

/**
 * Join path segments and normalize the result, mirroring `node:path.join`: the first absolute segment restarts the
 * join; a join with no absolute segment stays relative and is returned unslashed.
 */
export function joinVirtualPath(parts: string[]): string {
	const cleaned = parts.filter((part) => part.length > 0);
	const firstAbsolute = cleaned.findIndex((part) => part.startsWith("/"));
	if (firstAbsolute === -1) {
		return splitToSegments(cleaned.join("/"), "/").join("/");
	}
	return normalizeVirtualPath(cleaned.slice(firstAbsolute).join("/"), "/");
}

/** Split an absolute virtual path into its segments ("." and ".." already normalized by callers). */
export function splitVirtualPath(absolute: string): string[] {
	return splitToSegments(absolute, "/");
}

function splitToSegments(input: string, cwd: string): string[] {
	const base = input.startsWith("/") ? [] : splitToSegments(cwd.startsWith("/") ? cwd : `/${cwd}`, "/");
	const segments = [...base];
	for (const raw of input.split("/")) {
		const segment = raw.trim();
		if (segment.length === 0 || segment === ".") continue;
		if (segment === "..") {
			segments.pop();
			continue;
		}
		segments.push(segment);
	}
	return segments;
}
