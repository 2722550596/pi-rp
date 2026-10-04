import { describe, expect, it } from "vitest";
import {
	type BrowserSqliteDatabaseFactoryOptions,
	createBrowserSqliteDatabaseFactory,
	OPFS_SAHPoolVfs,
} from "../src/index.ts";

/**
 * 公开导出契约（sefirot 消费面）：browser SQLite 工厂必须可从包入口导入。
 * 回归背景：driver-browser.ts 一直导出该工厂，但包级 index 未 re-export，
 * 消费方（sefirot context pool）无法从受支持的包入口获取（10-D 前置侦查）。
 */
describe("browser SQLite factory public export", () => {
	it("exposes the factory and VFS constant from the package entry", () => {
		expect(typeof createBrowserSqliteDatabaseFactory).toBe("function");
		expect(OPFS_SAHPoolVfs).toBe("opfs-sahpool");
	});

	it("deferred wasm init: factory is created without opening a database", () => {
		const options: BrowserSqliteDatabaseFactoryOptions = {};
		const factory = createBrowserSqliteDatabaseFactory(options);
		expect(typeof factory.open).toBe("function");
	});
});
