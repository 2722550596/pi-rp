/**
 * /memories web 启动器（`src/extensions/memories/web-launcher.ts`）。
 *
 * 这个模块的风险不在「能不能拉起进程」，而在**复用判据**：同一个 world 下作家与
 * 角色各有一个库，端口上「有人监听」完全可能是**别人的库**。只凭端口占用就复用，
 * 会把用户静默带到错误的记忆库上 —— 那比打不开更糟，因为它看起来是成功的。
 *
 * 因此这里的核心断言是：探测只对「服务的正是本库」的实例报 match；对别人的库
 * 必须报 occupied 并让路。用一个真实 http server 充当「别人的实例」，比 mock
 * fetch 更能钉住行为。
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { probePort, resolveWebCliPath } from "../src/extensions/memories/web-launcher.ts";

const servers: Server[] = [];

afterEach(async () => {
	while (servers.length > 0) {
		const server = servers.pop();
		await new Promise<void>((resolve) => server?.close(() => resolve()));
	}
});

/** 起一个假的记忆浏览器：/api/meta 回报给定的 db_path。 */
async function fakeMemWeb(dbPath: string): Promise<number> {
	const server = createServer((req, res) => {
		if (req.url === "/api/meta") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ db_path: dbPath }));
			return;
		}
		res.writeHead(404).end();
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return (server.address() as AddressInfo).port;
}

describe("/memories web 的端口探测", () => {
	it("空端口报 free —— 这是唯一允许 spawn 的状态", async () => {
		// 端口 0 上没人监听；直接找一个空闲端口来测。
		const port = await fakeMemWeb("/tmp/placeholder.db");
		const server = servers.pop();
		await new Promise<void>((resolve) => server?.close(() => resolve()));
		expect((await probePort(port, "/tmp/anything.db")).kind).toBe("free");
	});

	it("已有实例服务的正是本库 → match（复用，不再 spawn）", async () => {
		const db = "/world/elias/.pi/memory.db";
		const port = await fakeMemWeb(db);
		expect((await probePort(port, db)).kind).toBe("match");
	});

	it("端口上是别的库 → occupied（让路，绝不误连）", async () => {
		const port = await fakeMemWeb("/world/gm/.pi/memory.db");
		// 作家进程要为角色库开浏览器：端口有响应，但那不是它的库。
		expect((await probePort(port, "/world/elias/.pi/memory.db")).kind).toBe("occupied");
	});

	it("端口被非本服务的程序占用 → occupied（不能撞 EADDRINUSE）", async () => {
		const server = createServer((_req, res) => {
			res.writeHead(500).end("boom");
		});
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const port = (server.address() as AddressInfo).port;
		// 5xx 不是记忆浏览器，但端口确实占着 —— 必须让路。
		expect((await probePort(port, "/world/elias/.pi/memory.db")).kind).toBe("occupied");
	});

	it("超时按 occupied 处理（保守：宁可让路也不抢端口）", async () => {
		const server = createServer(() => {
			/* 永不响应 */
		});
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const port = (server.address() as AddressInfo).port;
		expect((await probePort(port, "/tmp/x.db", 150)).kind).toBe("occupied");
	});
});

describe("/memories web 的入口定位", () => {
	it("能解析到 pi-memory-web 的 cli.js 绝对路径", () => {
		const cli = resolveWebCliPath();
		expect(cli).not.toBeNull();
		expect(cli?.endsWith("/dist/web/cli.js")).toBe(true);
	});
});
