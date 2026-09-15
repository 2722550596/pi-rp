/**
 * 搜索失效回归测试（2026-09-15）。
 *
 * 症状：Web 搜索框「根本搜不出东西」。实测根因在**候选选择**与**打分**之间的口径断裂：
 *
 * 1. **单字 CJK 查询恒 0 结果**。`tokenizeForMatch` 对单字查询会产出单字 token
 *    （见其 `cjk.length === 1` 分支），文档侧却只产 bigram。于是 FTS（jieba 空间）
 *    选中了几十个确实含该字的候选，`rank` 的 `requireKeywordHit` 却因 `kw === 0`
 *    把它们**全部**过滤掉。真库实测：`日` FTS 51 候选 / 字面命中 51 / kw>0 的 0 条
 *    → 返回 0 结果。这不是「jieba 不索引单字」—— 实例证 `9 月 25 日` 里的 `日`
 *    正是独立 token（真库 51 个命中全部如此）。
 *
 * 2. **`import()` 不重建 glossary 的 FTS**。节点循环在 glossary 行插入**之前**执行，
 *    而 `reindexNode` 才是把触发词追加进 `node_fts` 文本的地方 —— 导入快照里的
 *    触发词进了 `glossary` 表却不在 `node_fts` 里，那个词永远搜不到。
 *    真库实测：49 个触发词有 30 个处于此状态（含「枯萎」「拿铁」「周明瑞」等）。
 *
 * 3. （前端 IME，见 `test/web/`）组字中的 Enter 被当成搜索提交，拿拼音去搜。
 *
 * 全部驱动公开 API：`store.recall()` / `search()` / `import()`。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type MemoryDatabase, openDatabase } from "../src/driver.ts";
import { search } from "../src/recall.ts";
import { createSchema } from "../src/schema.ts";
import { type MemoryNode, MemoryStore } from "../src/store.ts";

let db: MemoryDatabase;
let store: MemoryStore;

beforeEach(async () => {
	db = await openDatabase(":memory:");
	createSchema(db);
	store = new MemoryStore(db);
});

afterEach(() => {
	db.close();
});

/** 关键字模式（无 embedding client）的纯词法检索 —— `/api/search` 走的正是这条。 */
function keywordSearch(query: string, limit = 10): MemoryNode[] {
	return store.recall(query, { limit });
}

describe("单字 CJK 查询（搜索框搜不出东西的主因）", () => {
	it("FTS 选中的候选不会被 kw>0 过滤掉：单字查询能返回结果", () => {
		store.insertNode({ uri: "history://dated", content: "2020年9月28日 星期一 晴" });
		store.insertNode({ uri: "history://other", content: "完全不同的主题，毫无关系。" });
		// 前提：FTS 确实选中了候选（否则这条测试测不到那个 bug）。
		expect(store.searchNodeFts(["日"]).size).toBeGreaterThan(0);
		// 修正前：候选被选中却全部 kw===0 → 空结果。
		expect(keywordSearch("日").map((h) => h.uri)).toContain("history://dated");
	});

	it("单字查询只召回真正含该字的节点，不误伤无关文档", () => {
		store.insertNode({ uri: "history://painted", content: "他画了一幅画。" });
		store.insertNode({ uri: "history://unrelated", content: "完全不同的主题，毫无关系。" });
		const hits = keywordSearch("画").map((h) => h.uri);
		expect(hits).toContain("history://painted");
		expect(hits).not.toContain("history://unrelated");
	});

	it("多字查询保持 bigram 精确性：不因单字放宽而召回只含其中一个字的文档", () => {
		// partial 含「薇」与「拉」但**不相邻** —— bigram 口径下不该被召回。
		store.insertNode({ uri: "history://split", content: "薇在左边，拉在右边，隔了很远。" });
		store.insertNode({ uri: "history://adjacent", content: "薇拉走进房间。" });
		const hits = keywordSearch("薇拉").map((h) => h.uri);
		expect(hits).toContain("history://adjacent");
		expect(hits).not.toContain("history://split");
	});

	it("byDoc 覆盖率分母不被单字稀释：长文档不会因此挤掉精确匹配", () => {
		// 长文档含大量去重汉字 —— 若单字混入 doc 集合，其分母被放大、byDoc 被压低。
		const long =
			"甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥东南西北中上下左右前后内外春夏秋冬天地人山水火木金土风雨雷电云雾霜雪冰";
		store.insertNode({ uri: "history://exact", content: "目标词" });
		store.insertNode({ uri: "history://verbose", content: `${long} 目标词在这里` });
		const hits = keywordSearch("目标词").map((h) => h.uri);
		expect(hits).toContain("history://exact");
		// 精确匹配必须排在冗长文档之前。
		expect(hits.indexOf("history://exact")).toBeLessThan(hits.indexOf("history://verbose"));
	});
});

describe("import() 必须重建 glossary 的 FTS 索引", () => {
	async function importSnapshotWithGlossary() {
		const nodeId = store.insertNode({ uri: "core://t/a", content: "花园里的花开了。" }).node_id;
		const snapshot = {
			nodes: store.listNodes().map((n) => ({ ...n })),
			revisions: [],
			kv: {},
			aliases: [],
			edges: [],
			glossary: [{ keyword: "枯萎", node_id: nodeId }],
		};
		const db2 = await openDatabase(":memory:");
		createSchema(db2);
		const store2 = new MemoryStore(db2);
		store2.import(snapshot);
		return { db2, store2, nodeId };
	}

	it("导入后，快照里的触发词能被搜到（修正前 keyword 进了表却没进 FTS）", async () => {
		const { db2, store2, nodeId } = await importSnapshotWithGlossary();
		// 直接核 FTS 文本 —— 这是「用户能搜到什么」的事实来源。
		const row = db2.prepare("SELECT text FROM node_fts WHERE node_id = ?").get(nodeId) as
			| { text: string }
			| undefined;
		expect(row?.text).toContain("枯萎");
		expect(store2.recall("枯萎").map((n) => n.uri)).toContain("core://t/a");
		db2.close();
	});

	it("导入的触发词同时落在 glossary 表里（两条路径都要在）", async () => {
		const { db2, store2 } = await importSnapshotWithGlossary();
		expect(store2.listGlossary().map((g) => g.keyword)).toContain("枯萎");
		db2.close();
	});
});

describe("端到端：三类查询在同一个库里都应出结果", () => {
	it("单字 / 多字词 / 拉丁词 都能命中含它的节点（含 search() 入口）", async () => {
		store.insertNode({ uri: "core://identity", content: "埃利亚斯的核心认知与 identity 设定。" });
		store.insertNode({ uri: "history://scene", content: "2020年9月28日 星期一 晴" });

		expect(keywordSearch("日").map((n) => n.uri)).toContain("history://scene");
		expect(keywordSearch("埃利亚斯").map((n) => n.uri)).toContain("core://identity");
		expect(keywordSearch("identity").map((n) => n.uri)).toContain("core://identity");

		// `/api/search` 实际调用的是 search()，同样要对。
		const viaSearch = await search(store, undefined, {
			queries: ["日"],
			topK: 10,
			minScore: 0,
			keywordMinScore: 0,
			nowDays: 0,
			domainBlocklist: [],
		});
		expect(viaSearch.items.map((i) => i.uri)).toContain("history://scene");
	});
});
