/**
 * Browser shim for `node:path` / `path` (15-F §5.5 开缝清单 · node:path sugar)。
 *
 * pi 的虚拟路径命名空间是单根 POSIX 风格（契约 §6），故本 shim 只实现 posix 语义；
 * `win32` 命名空间以 posix 实现兜底（仅 config.ts 的平台探测与显示分支触达，
 * 浏览器剖面不执行 Windows 路径语义）。node 剖面不经本模块（alias 只存在于
 * browser 构建的 esbuild 配置中）。
 */

function assertString(value: unknown, caller: string): string {
	if (typeof value !== "string") {
		throw new TypeError(`Path must be a string. Received ${typeof value} (path.${caller})`);
	}
	return value;
}

function isAbsolute(p: string): boolean {
	return p.startsWith("/");
}

function normalize(p: string): string {
	assertString(p, "normalize");
	const absolute = p.startsWith("/");
	const trailingSlash = p.endsWith("/") && p !== "/";
	const parts = p.split("/");
	const out: string[] = [];
	for (const part of parts) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			if (out.length > 0 && out[out.length - 1] !== "..") {
				out.pop();
			} else if (!absolute) {
				out.push("..");
			}
			continue;
		}
		out.push(part);
	}
	let normalized = out.join("/");
	if (absolute) normalized = `/${normalized}`;
	if (trailingSlash && normalized !== "/") normalized += "/";
	return normalized || (absolute ? "/" : ".");
}

function join(...parts: string[]): string {
	const joined = parts.filter((part) => part !== "").join("/");
	return joined === "" ? "." : normalize(joined);
}

function resolve(...parts: string[]): string {
	let resolved = "";
	for (let index = parts.length - 1; index >= 0; index -= 1) {
		const part = assertString(parts[index], "resolve");
		if (part === "") continue;
		resolved = `${part}/${resolved}`;
		if (isAbsolute(part)) break;
	}
	resolved = normalize(resolved.replace(/\/{2,}/g, "/"));
	return resolved === "" ? "/" : resolved;
}

/** 命名契约：`path.parse` 的结果形状（node:path ParsePath 的浏览器等价面）。 */
export interface ParsedPath {
	root: string;
	dir: string;
	base: string;
	ext: string;
	name: string;
}

function parse(p: string): ParsedPath {
	const normalized = normalize(p);
	const root = normalized.startsWith("/") ? "/" : "";
	const lastSlash = normalized.lastIndexOf("/");
	const base = lastSlash === -1 ? normalized : normalized.slice(lastSlash + 1);
	const dir = lastSlash <= 0 ? root || "." : normalized.slice(0, lastSlash);
	const dot = base.lastIndexOf(".");
	const ext = dot > 0 ? base.slice(dot) : "";
	const name = ext ? base.slice(0, -ext.length) : base;
	return { root, dir, base, ext, name };
}

function format(pathObject: Partial<ParsedPath>): string {
	const dir = pathObject.dir ?? "";
	const base = pathObject.base ?? (pathObject.name ?? "") + (pathObject.ext ?? "");
	return dir ? join(dir, base) : base;
}

function dirname(p: string): string {
	assertString(p, "dirname");
	const normalized = normalize(p);
	if (normalized === "/" || normalized === ".") return ".";
	const lastSlash = normalized.lastIndexOf("/");
	return lastSlash <= 0 ? "/" : normalized.slice(0, lastSlash);
}

function basename(p: string, suffix?: string): string {
	assertString(p, "basename");
	const normalized = normalize(p);
	const base = normalized.slice(normalized.lastIndexOf("/") + 1);
	if (suffix !== undefined && base.endsWith(suffix) && base.length > suffix.length) {
		return base.slice(0, -suffix.length);
	}
	return base;
}

function extname(p: string): string {
	assertString(p, "extname");
	return parse(p).ext;
}

function relative(from: string, to: string): string {
	assertString(from, "relative");
	assertString(to, "relative");
	const absoluteFrom = isAbsolute(from);
	const absoluteTo = isAbsolute(to);
	if (absoluteFrom !== absoluteTo) {
		return absoluteTo ? resolve(to) : resolve(to.replace(/^\/+/, ""));
	}
	const fromParts = resolve(from)
		.split("/")
		.filter((part) => part !== "");
	const toParts = resolve(to)
		.split("/")
		.filter((part) => part !== "");
	let common = 0;
	while (common < fromParts.length && common < toParts.length && fromParts[common] === toParts[common]) {
		common += 1;
	}
	const up = fromParts.length - common;
	const segments = [...new Array(up).fill(".."), ...toParts.slice(common)];
	return segments.length === 0 ? "." : segments.join("/");
}

export { basename, dirname, isAbsolute, join, normalize, relative, resolve, extname, parse, format };

export const posix = {
	basename,
	dirname,
	isAbsolute,
	join,
	normalize,
	relative,
	resolve,
	sep: "/",
	extname,
	parse,
	format,
	toNamespacedPath: (p: string): string => p,
	delimiter: ":",
};

/** Windows 命名空间兜底：浏览器剖面无 Windows 路径语义，posix 实现占位（显示层分支安全）。 */
export const win32 = {
	...posix,
	sep: "\\",
	delimiter: ";",
	isAbsolute: (p: string) => /^[a-zA-Z]:[\\/]/.test(p),
};

export const sep = "/";
export const delimiter = ":";

const pathApi = {
	...posix,
	win32,
	posix,
	default: undefined as unknown,
};
pathApi.default = pathApi;

export default pathApi;
