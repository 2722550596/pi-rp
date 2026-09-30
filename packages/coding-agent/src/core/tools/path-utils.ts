import { normalizePath, resolvePath } from "../../utils/paths.ts";
import { fileExistsSync, pathExistsAsync } from "./node-tool-defaults.ts";

/** `access(path, F_OK)` parity; node default moved to node-tool-defaults (15-F §5.5). */
export const pathExists = pathExistsAsync;

const NARROW_NO_BREAK_SPACE = "\u202F";

function tryMacOSScreenshotPath(filePath: string): string {
	return filePath.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`);
}

function tryNFDVariant(filePath: string): string {
	// macOS stores filenames in NFD (decomposed) form, try converting user input to NFD
	return filePath.normalize("NFD");
}

function tryCurlyQuoteVariant(filePath: string): string {
	// macOS uses U+2019 (right single quotation mark) in screenshot names like "Capture d'écran"
	// Users typically type U+0027 (straight apostrophe)
	return filePath.replace(/'/g, "\u2019");
}

export function expandPath(filePath: string): string {
	return normalizePath(filePath, { normalizeUnicodeSpaces: true, stripAtPrefix: true });
}

/**
 * Resolve a path relative to the given cwd.
 * Handles ~ expansion and absolute paths.
 */
export function resolveToCwd(filePath: string, cwd: string): string {
	return resolvePath(filePath, cwd, { normalizeUnicodeSpaces: true, stripAtPrefix: true });
}

export function resolveReadPath(filePath: string, cwd: string): string {
	const resolved = resolveToCwd(filePath, cwd);

	if (fileExistsSync(resolved)) {
		return resolved;
	}

	// Try macOS AM/PM variant (narrow no-break space before AM/PM)
	const amPmVariant = tryMacOSScreenshotPath(resolved);
	if (amPmVariant !== resolved && fileExistsSync(amPmVariant)) {
		return amPmVariant;
	}

	// Try NFD variant (macOS stores filenames in NFD form)
	const nfdVariant = tryNFDVariant(resolved);
	if (nfdVariant !== resolved && fileExistsSync(nfdVariant)) {
		return nfdVariant;
	}

	// Try curly quote variant (macOS uses U+2019 in screenshot names)
	const curlyVariant = tryCurlyQuoteVariant(resolved);
	if (curlyVariant !== resolved && fileExistsSync(curlyVariant)) {
		return curlyVariant;
	}

	// Try combined NFD + curly quote (for French macOS screenshots like "Capture d'écran")
	const nfdCurlyVariant = tryCurlyQuoteVariant(nfdVariant);
	if (nfdCurlyVariant !== resolved && fileExistsSync(nfdCurlyVariant)) {
		return nfdCurlyVariant;
	}

	return resolved;
}

export async function resolveReadPathAsync(filePath: string, cwd: string): Promise<string> {
	const resolved = resolveToCwd(filePath, cwd);

	if (await pathExists(resolved)) {
		return resolved;
	}

	// Try macOS AM/PM variant (narrow no-break space before AM/PM)
	const amPmVariant = tryMacOSScreenshotPath(resolved);
	if (amPmVariant !== resolved && (await pathExists(amPmVariant))) {
		return amPmVariant;
	}

	// Try NFD variant (macOS stores filenames in NFD form)
	const nfdVariant = tryNFDVariant(resolved);
	if (nfdVariant !== resolved && (await pathExists(nfdVariant))) {
		return nfdVariant;
	}

	// Try curly quote variant (macOS uses U+2019 in screenshot names)
	const curlyVariant = tryCurlyQuoteVariant(resolved);
	if (curlyVariant !== resolved && (await pathExists(curlyVariant))) {
		return curlyVariant;
	}

	// Try combined NFD + curly quote (for French macOS screenshots like "Capture d'écran")
	const nfdCurlyVariant = tryCurlyQuoteVariant(nfdVariant);
	if (nfdCurlyVariant !== resolved && (await pathExists(nfdCurlyVariant))) {
		return nfdCurlyVariant;
	}

	return resolved;
}
