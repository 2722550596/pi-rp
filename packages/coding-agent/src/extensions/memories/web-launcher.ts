/**
 * 「记忆浏览器」启动器（/memories web）。
 *
 * 定位：**启动器，不是服务**。这个模块的全部职责是「帮用户把 web 进程拉起来，
 * 或者发现它已经在跑就直接开浏览器」，然后把控制权还回去 —— 它自身不监听端口、
 * 不持有 store、不参与请求处理。
 *
 * 为什么不进程内起 server：web 是给使用者长期开着的独立工具（挂在第二个屏幕、
 * 缩在后台标签页），寿命应当长过任何一次 pi 会话。进程内起服务会让它随 session
 * 退出而消失，还平白把 session 的 fd 与事件循环拖着。所以这里 spawn 一个
 * **detached** 子进程 —— 我们借给它的只有「用哪个库」这一条信息，生命周期不借。
 *
 * 复用判据不是「端口上有人监听」，而是「端口上监听的实例正服务着我要看的那个库」：
 * 同一个 world 下作家与角色各有一个库，各自都可能起了 web。只凭端口占用就复用，
 * 会把用户带到别人的库上。
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

/** 探测结果三态。`free` 才允许 spawn；`occupied` 必须让路，换端口再试。 */
export type ProbeResult =
	| { kind: "match" } // 已有实例，且服务的正是本库 → 复用
	| { kind: "occupied" } // 端口被别的程序占用（或服务的是别的库）→ 让路
	| { kind: "free" }; // 无人监听 → 可在此端口拉起

/** 默认起始端口，与 `pi-memory-web` CLI 的默认值一致。 */
export const DEFAULT_WEB_PORT = 8788;
/** 连续探测的端口数：从起始端口向后找这么多个位置。 */
const PORT_SCAN_SPAN = 10;
/** 单次探测超时。本地回环，超过这个时间基本可以认为不是本服务。 */
const PROBE_TIMEOUT_MS = 500;

export interface LaunchOptions {
	/** 要打开的库（绝对路径）。 */
	dbPath: string;
	/** 起始端口；默认 `PI_MEMORY_WEB_PORT` 或 8788。 */
	port?: number;
	/** 单次探测超时（测试用）。 */
	probeTimeoutMs?: number;
}

export type LaunchOutcome =
	| { kind: "reused"; url: string } // 已有实例在服务本库
	| { kind: "started"; url: string; pid: number } // 新拉起
	| { kind: "no-cli" } // 找不到 pi-memory-web 入口
	| { kind: "no-port" } // 连续若干端口都被占
	| { kind: "failed"; port: number }; // spawn 了但迟迟没起来

/**
 * 探测某个端口上是否已有「服务本库的」web 实例。
 *
 * 三态判据：
 * - 拿到合法 `/api/meta` 且 `db_path` 相同 → `match`
 * - 端口有响应，但不是本服务 / 不是本库 → `occupied`（让路，别抢也别误连）
 * - 连接被拒（ECONNREFUSED）→ `free`
 *
 * 其余失败（超时等）保守归为 `occupied`：宁可不 spawn，也不要在一个可能已被
 * 占用的端口上撞 EADDRINUSE。
 */
export async function probePort(port: number, dbPath: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<ProbeResult> {
	try {
		const res = await fetch(`http://127.0.0.1:${port}/api/meta`, {
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!res.ok) return { kind: "occupied" };
		const body: unknown = await res.json();
		const reported = typeof body === "object" && body !== null ? (body as { db_path?: unknown }).db_path : undefined;
		return reported === dbPath ? { kind: "match" } : { kind: "occupied" };
	} catch (error) {
		// fetch 把底层错误塞进 cause；ECONNREFUSED 才证明这个端口是空的。
		const cause = (error as { cause?: { code?: string } }).cause;
		return cause?.code === "ECONNREFUSED" ? { kind: "free" } : { kind: "occupied" };
	}
}

/**
 * 定位 `pi-memory-web` 的入口脚本。
 *
 * 走 `require.resolve('@earendil-works/pi-memory/package.json')` 而不是依赖
 * PATH 里的 `pi-memory-web`：workspace 里 npm 不会把子包的 bin 链接进
 * `node_modules/.bin`（实测），而 coding-agent 声明了该依赖，解析一定成功。
 */
export function resolveWebCliPath(): string | null {
	try {
		const require = createRequire(import.meta.url);
		const pkgJson = require.resolve("@earendil-works/pi-memory/package.json");
		return path.join(path.dirname(pkgJson), "dist", "web", "cli.js");
	} catch {
		return null;
	}
}

/**
 * 解释器选择。bun 编译出的单文件二进制里 `process.execPath` 指向 pi 自己，
 * 拿它跑一个 .js 会把参数喂错；此时改用 PATH 上的 `bun`。
 */
function interpreter(): string {
	return process.versions.bun ? "bun" : process.execPath;
}

/** spawn 一个 detached 的 web 进程，随即与它脱钩。 */
export function spawnWebServer(cliPath: string, dbPath: string, port: number): number {
	const child = spawn(interpreter(), [cliPath, "--db", dbPath, "--port", String(port)], {
		detached: true,
		// 不留管道：子进程要比父进程活得久，stdout 管道会随父进程关闭而断裂。
		stdio: "ignore",
	});
	// 启动器无法补救子进程的任何失败（它已经脱钩），这里只避免未捕获的 error 事件
	// 把 pi 自己带崩。真正的失败由上层 probe 超时发现。
	child.on("error", () => {});
	child.unref();
	return child.pid ?? -1;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 打开本库的记忆浏览器：已开则复用，未开则拉起，最后返回它的 URL。
 *
 * 不做浏览器跳转 —— 那是调用方的决定（扩展会用 coding-agent 自己的
 * `openBrowser`，它处理了 Windows 下 `cmd /c start` 的元字符注入问题）。
 */
export async function ensureWebServer(opts: LaunchOptions): Promise<LaunchOutcome> {
	const dbPath = path.resolve(opts.dbPath);
	const startPort = opts.port ?? Number(process.env.PI_MEMORY_WEB_PORT ?? DEFAULT_WEB_PORT);
	const timeoutMs = opts.probeTimeoutMs ?? PROBE_TIMEOUT_MS;

	// 1) 先找已有实例；顺手记下第一个空端口，免得找到后还要再扫一遍。
	let freePort: number | null = null;
	for (let i = 0; i < PORT_SCAN_SPAN; i++) {
		const port = startPort + i;
		const probe = await probePort(port, dbPath, timeoutMs);
		if (probe.kind === "match") {
			return { kind: "reused", url: `http://127.0.0.1:${port}/` };
		}
		if (probe.kind === "free" && freePort === null) freePort = port;
	}
	if (freePort === null) return { kind: "no-port" };

	// 2) 拉起独立进程。
	const cliPath = resolveWebCliPath();
	if (!cliPath) return { kind: "no-cli" };
	const pid = spawnWebServer(cliPath, dbPath, freePort);

	// 3) 等它真正开始服务再回报 —— 起个 Node 进程要几百毫秒，直接返回 URL 会
	//    让用户点开一个「拒绝连接」的标签页。spawn 出错（路径错、权限）时这里
	//    必然等满，于是失败被收敛成同一个出口，不必另立错误面。
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		await sleep(120);
		if ((await probePort(freePort, dbPath, timeoutMs)).kind === "match") {
			return { kind: "started", url: `http://127.0.0.1:${freePort}/`, pid };
		}
	}
	return { kind: "failed", port: freePort };
}
