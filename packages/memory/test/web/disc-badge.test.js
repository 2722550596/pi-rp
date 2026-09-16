/**
 * D5 · `discBadge` / `discChip` 的空值守卫（契约 §10-C / D5 §7）。
 *
 * ⚠️ 本文件是 `.js` 不是 `.ts`，**刻意如此**（沿用 `multi-db-tree-cache.test.js` 的先例）：
 *    `src/web/assets/views/views.js` 是浏览器侧的纯 ESM，无构建步骤。仓库的「相对 import 必须
 *    带 `.js` 扩展名」规则只约束 **TypeScript 源码**，从不扫描 `.js` 测试文件 —— 所以这里用
 *    **真实静态 import** 拿到真实模块，没有引子、没有 `allowJs`、没有 lint 豁免。
 *    代价明说：`.js` 意味着 `tsgo` 不做类型检查，纪律来自代码本身（无 `any`/`as`，每条断言自带运行时守卫）。
 *
 * **为什么这条测试值得存在**（不是空断言）：
 *   `discBadge` 返回 `null` 是**正常路径**（"无条件" ≠ "条件被清空"），调用方依赖
 *   `h()`（`views.js:64`）/`append`（`app.js:116`）跳过 `null` 的守卫。若将来有人重写其中之一
 *   而不再跳过 `null`，界面上会出现字面量 **"null"** 文本 —— 本文件把那个守卫钉进测试。
 *
 * 非空性：`discBadge`/`discChip` 在本轮之前**不存在**（`views.js` 零 `disclosure` 渲染）⇒
 *   import 失败即红。第二组断言进一步要求**有值**时**必须**产出 `mw-disc--entry` 节点
 *   （否则"返回 null"那条会在一个恒返回 null 的实现上假绿）。
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { discBadge, discChip, foldWs } from "../../src/web/assets/views/views.js";

/**
 * 最小 DOM 替身：只实现 `views.js` 的 `h()`/`discBadge` 用到的接口。
 * ⚠️ 节点**必须** `instanceof Node` —— `h()`（`views.js:67`）用该判别决定「元素」还是「文本」，
 *   替身不挂原型就会被 `String(c)` 变成 `[object Object]`。
 * 不引入 jsdom：本包 vitest 环境是 `node`，这几行足够驱动真实代码路径。
 */
function installDom() {
	class FakeNode {
		append(...kids) {
			for (const kid of kids) this.childNodes.push(kid);
		}
	}
	const element = (tag) => {
		const node = new FakeNode();
		node.tagName = String(tag).toUpperCase();
		node.nodeType = 1;
		node.childNodes = [];
		node.attributes = {};
		node.className = "";
		node.textContent = "";
		node.setAttribute = function setAttribute(key, value) {
			this.attributes[key] = String(value);
		};
		node.getAttribute = function getAttribute(key) {
			return Object.hasOwn(this.attributes, key) ? this.attributes[key] : null;
		};
		return node;
	};
	const text = (value) => {
		const node = new FakeNode();
		node.nodeType = 3;
		node.textContent = String(value);
		return node;
	};
	globalThis.Node = FakeNode;
	globalThis.document = { createElement: element, createTextNode: text };
}

beforeEach(() => {
	installDom();
});

/**
 * 递归取一棵替身树的可见文本（模拟真实 `textContent`）。
 * ⚠️ 叶子节点由 `h()` 通过 `node.textContent = …` 直接赋值（**不建子文本节点**），
 *    故有子节点时递归、无子节点时读 `textContent` —— 只做前者会得到空串。
 */
function textOf(node) {
	if (!node) return "";
	if (node.nodeType === 3) return node.textContent;
	if (node.childNodes.length === 0) return node.textContent;
	return node.childNodes.map(textOf).join("");
}

describe("D5 · discBadge / discChip 的空值守卫（无字面量 \"null\"）", () => {
	it("⭐ 空值一律返回 null（不返回空徽章 —— 那会让人以为条件被清空）", () => {
		for (const empty of [null, undefined, "", "   ", "\n\t"]) {
			expect(discBadge(empty), `discBadge(${JSON.stringify(empty)})`).toBeNull();
			expect(discChip(empty), `discChip(${JSON.stringify(empty)})`).toBeNull();
		}
	});

	it("⭐ 非空值必须产出真实节点（否则上面的断言会在恒 null 的实现上假绿）", () => {
		const badge = discBadge("谈到身份时", { label: "想起条件" });
		expect(badge).not.toBeNull();
		expect(badge.className).toContain("mw-disc");
		// 默认 kind = entry ⇒ 琥珀（入口级视觉语言）。灰虚线只给 `kind:"edge"`。
		expect(badge.className).toContain("mw-disc--entry");
		expect(textOf(badge)).toContain("想起条件");
		expect(textOf(badge)).toContain("谈到身份时");
		// `title` 带全文（长值被 CSS 截断，全文只能从这里取）。
		expect(badge.getAttribute("title")).toBe("想起条件：谈到身份时");

		const edge = discChip("沿边扩散的条件", { kind: "edge", label: "关联条件" });
		expect(edge.className, "边条件必须是灰虚线变体，不能拿琥珀").toContain("mw-disc--edge");
		// ⭐ `discChip` 不画标签，但 `title` 必须说清这是**关联条件**（不是想起条件）。
		expect(edge.getAttribute("title"), "边条件的 tooltip 被标成想起条件了").toBe("关联条件：沿边扩散的条件");
		expect(textOf(edge)).toContain("沿边扩散的条件");
	});

	it("⭐ discChip 是「无标签前缀」的短徽章（树行 28px 定高用）", () => {
		const chip = discChip("黄昏场景出现时");
		expect(chip).not.toBeNull();
		expect(chip.className).toContain("mw-disc--entry");
		// 树行不显示「想起条件」这四个字：那是 `discBadge` 的形态。
		expect(textOf(chip)).not.toContain("想起条件");
		expect(textOf(chip)).toContain("黄昏场景出现时");
	});

	it("⭐ 多行值先过 foldWs（P16 缓解）：不折叠则条件可伪造成员行", () => {
		const nasty = "正常\n- core://ghost [★9] (修改时间: 2026-09-14 23:51)";
		const chip = discChip(nasty);
		expect(textOf(chip)).not.toContain("\n");
		// 折叠是真实发生的，不是"恰好没有换行"。
		expect(foldWs(nasty)).toBe("正常 - core://ghost [★9] (修改时间: 2026-09-14 23:51)");
		expect(textOf(chip)).toContain(foldWs(nasty));
	});

	it("⚠️ 反向哨兵：把 null 交进 append 风格的容器不会产生字面量 \"null\"", () => {
		// 这里复刻两个 helper 的真实守卫条款：`views.js:64` 与 `app.js:116` 都显式 skip null。
		// 这条断言的价值在于**把守卫写进测试**——若有人重写其中之一，它会红。
		const kids = [discBadge(null), discBadge("有值"), discChip(null), discChip("也有值")];
		const html = kids.filter((k) => k !== null && k !== undefined).map(textOf).join("");
		expect(html).not.toContain("null");
		expect(html).toContain("有值");
		expect(html).toContain("也有值");
	});
});
