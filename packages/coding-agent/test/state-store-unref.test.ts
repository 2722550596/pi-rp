import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, type Mock, vi } from "vitest";
import { StateManager } from "../src/state/state-manager.ts";
import { StateStore } from "../src/state/state-store.ts";

// ESM 命名空间不可 spy（vitest 限制），模块级 mock node:fs 的 watch。
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		watch: vi.fn().mockReturnValue({ unref: vi.fn(), close: vi.fn() }),
	};
});

import { watch } from "node:fs";

/**
 * 回归：共享 state store 的 fs.watch 句柄必须 unref。
 *
 * 背景：print 模式（`-p`，一次性处理 prompt 后退出）代码跑完后事件循环只剩
 * watcher 句柄时会卡死进程（main 不调 process.exit）。症状：`./run.sh -p …`
 * + 开场预设（播种写 .pi/state → attachStore → fs.watch）永远不退出，timeout
 * 杀掉后 pi 变孤儿残留。交互/rpc 常驻模式有其他活跃句柄，unref 不影响 watcher
 * 工作——只是不再独自持住事件循环。
 */
describe("StateManager.attachStore", () => {
	it("attachStore 的 fs.watch 句柄调用 unref（不阻止进程退出）", () => {
		const watchMock = watch as unknown as Mock;
		watchMock.mockClear();
		const dir = mkdtempSync(path.join(tmpdir(), "state-store-unref-"));
		try {
			const manager = new StateManager();
			manager.attachStore(new StateStore(dir));
			expect(watchMock).toHaveBeenCalledTimes(1);
			const watcher = watchMock.mock.results[0]?.value as { unref: Mock };
			expect(watcher.unref).toHaveBeenCalledTimes(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
