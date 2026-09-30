/**
 * Browser shim for `node:url` / `url`（15-F §5.5 开缝清单）。
 *
 * 浏览器剖面只有合成 URL 语义：`fileURLToPath` 解码 file: URL 为路径字符串
 * （虚拟命名空间内即 posix 路径），`pathToFileURL` 反向构造（渲染器超链接 sugar，
 * 浏览器剖面渲染器不被宿主调用，构造结果仅供显示）。node 剖面不经本模块。
 */

function fileURLToPath(url: URL | string): string {
	const raw = typeof url === "string" ? url : url.href;
	const parsed = new URL(raw);
	if (!parsed.protocol.startsWith("http") && parsed.protocol !== "file:") {
		throw new TypeError(`The URL must be of scheme file (got: ${raw.slice(0, 32)})`);
	}
	// file: → 虚拟 posix 路径；http(s)（bundle 内 import.meta.url 形态，config.ts __dirname 推导）
	// → 解码后的 pathname（虚拟命名空间内同为 posix 路径）。
	const pathname = parsed.protocol === "file:" ? parsed.pathname : parsed.pathname;
	return decodeURIComponent(pathname.replace(/^\/{2,}/, "/"));
}

function pathToFileURL(path: string): URL {
	const normalized = path.replaceAll("\\", "/");
	return new URL(
		`file://${normalized.startsWith("/") ? "" : "/"}${encodeURI(normalized)
			.replace(/#/g, "%23")
			.replace(/\?/g, "%3F")}`,
	);
}

export { fileURLToPath, pathToFileURL };
