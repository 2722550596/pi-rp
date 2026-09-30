/**
 * Browser shim for `node:fs/promises` / `fs/promises`（15-F §5.5 开缝清单）。
 * 语义契约见 ./fs.ts 头注：无宿主磁盘，异步面按 node 约定 reject ENOENT 结构化错误。
 */

import { enoent } from "./fs.ts";

function reject(syscall: string, path?: string): Promise<never> {
	return Promise.reject(enoent(syscall, path));
}

export function access(path: string): Promise<never> {
	return reject("access", path);
}
export function readFile(path: string): Promise<never> {
	return reject("readFile", path);
}
export function writeFile(path: string): Promise<never> {
	return reject("writeFile", path);
}
export function appendFile(path: string): Promise<never> {
	return reject("appendFile", path);
}
export function readdir(path: string): Promise<never> {
	return reject("readdir", path);
}
export function stat(path: string): Promise<never> {
	return reject("stat", path);
}
export function lstat(path: string): Promise<never> {
	return reject("lstat", path);
}
export function realpath(path: string): Promise<never> {
	return reject("realpath", path);
}
export function mkdir(path: string): Promise<never> {
	return reject("mkdir", path);
}
export function rm(path: string): Promise<never> {
	return reject("rm", path);
}
export function unlink(path: string): Promise<never> {
	return reject("unlink", path);
}
export function rename(path: string): Promise<never> {
	return reject("rename", path);
}
export function chmod(path: string): Promise<never> {
	return reject("chmod", path);
}
export function open(path: string): Promise<never> {
	return reject("open", path);
}
export function copyFile(path: string): Promise<never> {
	return reject("copyFile", path);
}

export default {
	access,
	readFile,
	writeFile,
	appendFile,
	readdir,
	stat,
	lstat,
	realpath,
	mkdir,
	rm,
	unlink,
	rename,
	chmod,
	open,
	copyFile,
};
