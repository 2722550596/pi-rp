/**
 * Browser shim for `node:fs` / `fs`（15-F §5.5 开缝清单）。
 *
 * 浏览器剖面没有宿主磁盘：pi 自身状态走注入的 StorageBackend，agent 工作区走注入的
 * 工具 Operations（六工具 OPFS 实现体）。因此本 shim 的语义是「无宿主磁盘」：
 * - `existsSync` 恒 false（资源扫描降级为空集 = 协商禁用语义，而非崩溃）；
 * - 其余同步面按 node 约定抛 ENOENT 结构化错误（canonicalizePath 的 try/catch 回退、
 *   config.ts 的目录回退等都依赖该形态）。
 *
 * 命中本 shim 的运行时写/读 = 装配漏洞（I4：无第三条落盘路径），错误消息显式指回装配。
 */

const ENOENT_MESSAGE =
	"pi-harness: no host filesystem in the browser profile; inject StorageBackend/tool Operations at the assembly entry";

function enoent(syscall: string, path?: string): Error {
	const error = new Error(`${ENOENT_MESSAGE} (${syscall}${path ? ` ${path}` : ""})`);
	(error as Error & { code?: string }).code = "ENOENT";
	(error as Error & { errno?: number }).errno = -2;
	(error as Error & { syscall?: string }).syscall = syscall;
	return error;
}

export const constants = {
	F_OK: 0,
	R_OK: 4,
	W_OK: 2,
	X_OK: 1,
	S_IFREG: 0o100000,
	S_IFDIR: 0o40000,
	O_RDONLY: 0,
	O_WRONLY: 1,
	O_RDWR: 2,
};

export function existsSync(_path: string): boolean {
	return false;
}

function throwSync(syscall: string, path?: string): never {
	throw enoent(syscall, path);
}

export function readFileSync(path: string): never {
	throwSync("readFileSync", path);
}
export function writeFileSync(path: string): never {
	throwSync("writeFileSync", path);
}
export function appendFileSync(path: string): never {
	throwSync("appendFileSync", path);
}
export function readdirSync(path: string): never {
	throwSync("readdirSync", path);
}
export function statSync(path: string): never {
	throwSync("statSync", path);
}
export function lstatSync(path: string): never {
	throwSync("lstatSync", path);
}
export function realpathSync(path: string): never {
	throwSync("realpathSync", path);
}
export function mkdirSync(path: string): never {
	throwSync("mkdirSync", path);
}
export function rmSync(path: string): never {
	throwSync("rmSync", path);
}
export function rmdirSync(path: string): never {
	throwSync("rmdirSync", path);
}
export function unlinkSync(path: string): never {
	throwSync("unlinkSync", path);
}
export function renameSync(path: string, destination: string): never {
	throwSync(`renameSync ${path} -> ${destination}`);
}
export function chmodSync(path: string): never {
	throwSync("chmodSync", path);
}
export function copyFileSync(path: string): never {
	throwSync("copyFileSync", path);
}
export function accessSync(path: string): never {
	throwSync("accessSync", path);
}
export function createReadStream(path: string): never {
	throwSync("createReadStream", path);
}
export function createWriteStream(path: string): never {
	throwSync("createWriteStream", path);
}
export function openSync(path: string): never {
	throwSync("openSync", path);
}
export function closeSync(): void {}
export function globSync(path: string): never {
	throwSync("globSync", path);
}

export function watch(): never {
	throwSync("watch");
}
export function watchFile(): void {}
export function unwatchFile(): void {}

export { enoent };
export default {
	constants,
	existsSync,
	readFileSync,
	writeFileSync,
	appendFileSync,
	readdirSync,
	statSync,
	lstatSync,
	realpathSync,
	mkdirSync,
	rmSync,
	rmdirSync,
	unlinkSync,
	renameSync,
	chmodSync,
	copyFileSync,
	accessSync,
	createReadStream,
	createWriteStream,
	openSync,
	closeSync,
	globSync,
	watch,
	watchFile,
	unwatchFile,
};
