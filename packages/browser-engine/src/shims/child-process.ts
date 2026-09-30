/**
 * Browser shim for `node:child_process` / `child_process`（15-F §5.5 开缝清单）。
 *
 * shell 能力在 browser 剖面协商禁用（E7）：命中本 shim 的运行时调用只可能来自
 * 未注入替代实现（rg/fd runner、bash 默认 Operations、包管理器）的装配漏洞，
 * 一律结构化抛错而非静默。node 剖面不经本模块。
 */

export class ChildProcess {
	constructor() {
		throw new Error(
			"pi-harness: child_process is unavailable in the browser profile (shell capability negotiated off)",
		);
	}
}

export type ChildProcessByStdio = ChildProcess;
export type SpawnSyncReturns = never;

function unavailable(syscall: string): never {
	throw new Error(
		`pi-harness: child_process.${syscall} is unavailable in the browser profile (shell capability negotiated off)`,
	);
}

export function spawn(command: string): never {
	return unavailable(`spawn ${command}`);
}
export function spawnSync(command: string): never {
	return unavailable(`spawnSync ${command}`);
}
export function execSync(command: string): never {
	return unavailable(`execSync ${command}`);
}
export function exec(command: string): never {
	return unavailable(`exec ${command}`);
}
export function execFile(file: string): never {
	return unavailable(`execFile ${file}`);
}
export function execFileSync(file: string): never {
	return unavailable(`execFileSync ${file}`);
}
export function fork(modulePath: string): never {
	return unavailable(`fork ${modulePath}`);
}

export default {
	ChildProcess,
	spawn,
	spawnSync,
	execSync,
	exec,
	execFile,
	execFileSync,
	fork,
};
