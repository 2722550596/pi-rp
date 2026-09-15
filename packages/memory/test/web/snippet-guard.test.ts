/**
 * 契约守卫：`snippet()` 的空白折叠行为（契约 §8.3 / 00-共同上下文 §8.3）。
 *
 * 背景（契约 §8.3 冻结要求 + D6 §6.5.1）：`render*` 文本侧之所以能被「按行锚点」
 * 安全提取成员，靠的是 `memory-views.ts:11-14` 的私有 `snippet()` 把 `\s+`（含
 * `\n`）折叠成单空格，且渲染时把正文缩进到第 2 行。若将来有人改 `snippet()`
 * 保留换行，正文就会落到列首，`forgotten`/`recent` 的 `^- ` 锚点会被正文伪造
 * —— 而 parity 测试不会变红、只会静默变松（两侧同向漂移）。
 *
 * ⭐ 选定的断言路径：**间接**。`snippet()` 是 `memory-views.ts` 的模块私有函数
 * （无 `export`，`src/index.ts` 也未导出它 —— 见契约 §8.3 与 D6 §6.5.4 方案①）。
 * 故本测试通过公开的 `renderForgottenView` 间接断言其折叠行为：把含 `\n` 的正文
 * 喂进去，断言输出中该正文**只出现在单行**且被缩进到列首之外（`snippet()` 的
 * 唯一调用点之一，`memory-views.ts:69`）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MemoryDatabase } from "../../src/driver.ts";
import { openMemoryStore } from "../../src/index.ts";
import { renderForgottenView } from "../../src/memory-views.ts";
import type { MemoryStore } from "../../src/store.ts";

let store: MemoryStore;

beforeEach(async () => {
	store = await openMemoryStore("");
	store.seed();
});

afterEach(() => {
	(store.db as MemoryDatabase).close();
});

describe("snippet() 契约守卫（单行折叠）", () => {
	it("含换行的正文在 forgotten 视图里被折成单行（FU1：不产生列首 `- ` 行）", () => {
		store.insertNode({
			uri: "core://notes/prose",
			content: "第一行\n- 0 天没想起 | core://forged [★9]",
			source: "manual",
		});

		const text = renderForgottenView(store, "core", 5);

		// ① 折叠证据：两段正文被 `\s+ → " "` 折进同一行，且缩进为 2 空格。
		expect(text).toContain("  第一行 - 0 天没想起 | core://forged [★9]");
		// ② 守卫证据：正文里的伪造成员行**没有**落到列首（否则 `^- ` 锚点会误认它）。
		expect(text).not.toMatch(/^- 0 天没想起 \| core:\/\/forged/m);
		// ③ 该 `- ` 行只允许作为「节点行」出现一次（正文没有额外造出一个）。
		const nodeLines = text.split("\n").filter((l) => l.startsWith("- "));
		expect(nodeLines).toEqual(["- 0 天没想起 | core://notes/prose [★5]"]);
	});

	it("连续空白也被折叠（FU2：`\\s+` 而非仅 `\\n`）", () => {
		store.insertNode({
			uri: "core://notes/spacey",
			content: "前段\t\t后段    第三段",
			source: "manual",
		});

		const text = renderForgottenView(store, "core", 5);
		expect(text).toContain("  前段 后段 第三段");
		expect(text).not.toMatch(/\t/);
	});

	it("折叠后的正文永远落在缩进行（FU3：` ^  ` 前缀是守卫成立的必要条件）", () => {
		store.insertNode({
			uri: "core://notes/indent",
			content: "a\nb",
			source: "manual",
		});

		const text = renderForgottenView(store, "core", 5);
		const lines = text.split("\n");
		const nodeIdx = lines.findIndex((l) => l.startsWith("- 0 天没想起 | core://notes/indent"));
		expect(nodeIdx).toBeGreaterThanOrEqual(0);
		// 正文紧跟在节点行之后，且以两个空格开头 —— `^- ` 锚点因此拒绝它。
		expect(lines[nodeIdx + 1]).toBe("  a b");
		expect(lines[nodeIdx + 1]?.startsWith("- ")).toBe(false);
	});

	it("stub 节点不进 forgotten（守卫只在非 stub 正文上成立）", () => {
		// `put` 会自动为缺失祖先建 stub（store.ts 的 ensureStubAncestors）。
		store.put({ uri: "core://notes/placeholder/leaf", content: "真实正文" });
		const stub = store.resolveUri("core://notes/placeholder");
		expect(stub?.is_stub).toBe(1);

		const text = renderForgottenView(store, "core", 5);
		expect(text).toContain("core://notes/placeholder/leaf [★");
		expect(text).not.toContain("core://notes/placeholder [★");
	});
});
