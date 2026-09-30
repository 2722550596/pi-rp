/**
 * Browser shim for `node:os` / `os`（15-F §5.5 开缝清单）。
 *
 * 浏览器剖面没有真实 home/tmp 目录：`homedir` 返回合成的 `/home`（`~` 展开落点，
 * 不会误前缀化虚拟路径显示），`tmpdir` 返回 `/tmp`（OPFS 命名空间内的临时子树语义
 * 由调用方的注入实现裁决；本返回值仅用于不再触发 node 专用分支）。node 剖面不经本模块。
 */

const SYNTHETIC_HOME = "/home";
const SYNTHETIC_TMP = "/tmp";

export function homedir(): string {
	return SYNTHETIC_HOME;
}

export function tmpdir(): string {
	return SYNTHETIC_TMP;
}

export function platform(): string {
	return "browser";
}

export function arch(): string {
	return "wasm32";
}

export const EOL = "\n";

const osApi = {
	homedir,
	tmpdir,
	platform,
	arch,
	EOL,
};

export default osApi;
