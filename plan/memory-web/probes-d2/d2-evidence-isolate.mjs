// D2 证据脚本 1/3 —— 三段隔离（契约 §7 门槛 1，主 agent 修订后）。
//
// 回答三个可分的问题：
//   (a) DDL/列布局：同一 token 多重集下，2 列（disclosure 并入 text）vs 3 列（独立列）
//                    → MUST 为 0 差异，否则列布局改了语义
//   (b) 权重：      固定文本，bare(=1.0,1.0) → 0.0,2.5,1.0
//   (b') 恒等校验： bare vs 0.0,1.0,1.0（两者数学恒等，见 README）
//   (c) 文本修复：  固定权重，存量(可能陈旧) text vs 重算 text
//
// 运行（需要一份 v2 真库快照，见下方「快照制备」）：
//   cd packages/memory
//   SRC=/tmp/d2exp/cur.db node --experimental-strip-types <此文件>
//
// 快照制备（MUST checkpoint，否则丢失未合并 WAL —— 见 22 §5.2 方法学事故）：
//   cp /path/to/memory.db /tmp/d2exp/cur.db
//   sqlite3 /tmp/d2exp/cur.db "PRAGMA journal_mode=DELETE; PRAGMA wal_checkpoint(TRUNCATE);"
//   rm -f /tmp/d2exp/cur.db-wal /tmp/d2exp/cur.db-shm
//
// 不依赖被测源码（只读快照 + 在 :memory: 建索引），因此不受实现改动影响。
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";

// 解析 @node-rs/jieba：从本仓库 packages/memory 的 node_modules。
// 若把本文件移到别处，改这个路径。
const req = createRequire("file:///home/yoshix7ti/projects/pi-rp/packages/memory/package.json");
const { Jieba } = req("@node-rs/jieba");
const { dict } = req("@node-rs/jieba/dict");
const jieba = Jieba.withDict(dict);
const tok = (s) => (s.length === 0 ? "" : jieba.cutForSearch(s).join(" "));

// —— tokenizeForMatch 的逐字移植（src/tokenize.ts:22-30）——
function tokMatch(t) {
	const s = new Set();
	for (const w of t.toLowerCase().match(/[a-z0-9]+/g) ?? []) s.add(w);
	const c = t.match(/[\u4e00-\u9fff]/g) ?? [];
	for (let i = 0; i < c.length - 1; i++) s.add(c[i] + c[i + 1]);
	if (c.length === 1) s.add(c[0]);
	return [...s];
}
// —— keywordScore 的逐字移植（src/recall.ts:157-182）——
function kw(qt, doc, ex) {
	if (!qt.length) return 0;
	const text = `${doc.uri} ${doc.disclosure ?? ""} ${ex} ${doc.content}`;
	const dt = tokMatch(text);
	if (!dt.length) return 0;
	const dts = new Set(dt);
	const dm = new Set(dt);
	for (const ch of text.match(/[\u4e00-\u9fff]/g) ?? []) dm.add(ch);
	const qs = new Set(qt);
	let h = 0;
	for (const t of qs) if (dm.has(t)) h++;
	let cov = 0;
	for (const t of dts) if (qs.has(t)) cov++;
	return Math.max(h / qs.size, Math.min(1, (cov / dts.size) * 1.4));
}
const RT = [
	{ max: 7, b: 0.08 },
	{ max: 30, b: 0.04 },
	{ max: 90, b: 0.02 },
];
const ed = (t) => {
	if (!t) return null;
	const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
	return m ? Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000) : null;
};
const rb = (t, n) => {
	const d = ed(t);
	if (d == null) return 0;
	const l = n - d;
	if (l < 0) return RT[0].b;
	for (const x of RT) if (l <= x.max) return x.b;
	return 0;
};

const SRC = process.env.SRC;
if (!SRC) {
	console.error("usage: SRC=/tmp/d2exp/cur.db node --experimental-strip-types d2-evidence-isolate.mjs");
	process.exit(1);
}
const d0 = new DatabaseSync(SRC, { readOnly: true });
const nodes = d0.prepare("SELECT * FROM nodes WHERE is_stub=0").all();
const gk = new Map();
for (const g of d0.prepare("SELECT node_id,keyword FROM glossary").all()) {
	if (!gk.has(g.node_id)) gk.set(g.node_id, []);
	gk.get(g.node_id).push(g.keyword);
}
const now = ed(d0.prepare("SELECT value FROM memory_kv WHERE key='world_time'").get()?.value ?? "") ?? 0;
const storedFts = new Map(d0.prepare("SELECT node_id, text FROM node_fts").all().map((r) => [r.node_id, r.text]));

const scratch = new DatabaseSync(":memory:");
scratch.exec(
	"CREATE TABLE nodes (node_id TEXT, uri TEXT, content TEXT, disclosure TEXT, importance INTEGER, world_ts TEXT, updated_ts TEXT)",
);
const insN = scratch.prepare("INSERT INTO nodes VALUES (?,?,?,?,?,?,?)");
for (const n of nodes) insN.run(n.node_id, n.uri, n.content, n.disclosure, n.importance, n.world_ts, n.updated_ts);
const bI = new Map(nodes.map((n) => [n.node_id, n]));

let WSQL = null;
function build(cols, textMode, weights) {
	scratch.exec("DROP TABLE IF EXISTS t");
	scratch.exec(
		cols === "3"
			? "CREATE VIRTUAL TABLE t USING fts5(node_id UNINDEXED, text, disclosure, tokenize='unicode61')"
			: "CREATE VIRTUAL TABLE t USING fts5(node_id UNINDEXED, text, tokenize='unicode61')",
	);

	WSQL = weights;
	const ins =
		cols === "3" ? scratch.prepare("INSERT INTO t VALUES(?,?,?)") : scratch.prepare("INSERT INTO t VALUES(?,?)");
	for (const n of nodes) {
		const k = (gk.get(n.node_id) ?? []).filter((x) => x.trim());
		const disc = tok(n.disclosure ?? "");
		let text;
		if (textMode === "stored") {
			// 真库里那一行（v2 产出，可能陈旧）：disclosure 已在 text 内
			text = storedFts.get(n.node_id) ?? "";
		} else {
			// reindexNode 的新输出（v3 语义：text = uri+content+glossary）
			text = tok([n.uri, n.content].join(" "));
			const ex = k.join(" ");
			if (ex) text = `${text} ${ex}`;
		}
		// 2 列 = 旧布局，整个载荷（含 disclosure）在一列；3 列 = 新布局，disclosure 拆出。
		// (a) 要保持 token 多重集恒定：2 列必须折入 disclosure，3 列必须不在 text 里。
		if (cols === "3") ins.run(n.node_id, text, textMode === "stored" ? "" : disc);
		else ins.run(n.node_id, textMode === "stored" ? text : `${text} ${disc}`.trim());
	}
}
function pipe(q, topK = 10) {
	const m = tok(q)
		.split(/\s+/)
		.filter(Boolean)
		.map((t) => `"${t.replace(/"/g, '""')}"`)
		.join(" OR ");
	if (!m) return [];
	const rows = scratch
		.prepare(`SELECT node_id, bm25(t${WSQL ? ", " + WSQL : ""}) AS bm FROM t WHERE t MATCH ?`)
		.all(m);
	const fts = new Map();
	for (const r of rows) {
		const p = fts.get(r.node_id);
		if (p === undefined || r.bm < p) fts.set(r.node_id, r.bm);
	}
	const pool = nodes.filter((n) => fts.has(n.node_id));
	const qtl = [q].map(tokMatch);
	const sc = pool.map((doc) => {
		const ex = (gk.get(doc.node_id) ?? []).join(" ");
		let kk = 0;
		for (const qt of qtl) {
			const v = kw(qt, doc, ex);
			if (v > kk) kk = v;
		}
		return {
			uri: doc.uri,
			kw: kk,
			score: 0.3 * kk + (0.15 * Math.min(Math.max(doc.importance ?? 5, 0), 10)) / 10 + rb(doc.world_ts, now),
			bm25: fts.get(doc.node_id) ?? null,
			id: doc.node_id,
		};
	});
	sc.sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score;
		if (b.kw !== a.kw) return b.kw - a.kw;
		const x = a.bm25 ?? Number.POSITIVE_INFINITY;
		const y = b.bm25 ?? Number.POSITIVE_INFINITY;
		if (x !== y) return x - y;
		const A = bI.get(a.id);
		const B = bI.get(b.id);
		if ((B?.importance ?? 0) !== (A?.importance ?? 0)) return (B?.importance ?? 0) - (A?.importance ?? 0);
		const uA = A?.updated_ts ?? "";
		const uB = B?.updated_ts ?? "";
		if (uB !== uA) return uB < uA ? -1 : 1;
		return a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0;
	});
	return sc.filter((s) => s.kw > 0).slice(0, topK).map((s) => s.uri);
}
const qs = nodes.filter((n) => n.disclosure).map((n) => n.disclosure);
const runAll = () => new Map(qs.map((q) => [q, pipe(q)]));
const cmp = (A, B) => {
	let same = 0,
		t1 = 0;
	for (const q of qs) {
		const a = A.get(q);
		const b = B.get(q);
		if (JSON.stringify(a) === JSON.stringify(b)) same++;
		if (a[0] === b[0]) t1++;
	}
	return [same, t1];
};

console.log(`SRC=${SRC}  nodes=${nodes.length}  disclosure-queries=${qs.length}`);

build("2", "fresh", null);
const a2 = runAll();
build("3", "fresh", null);
const a3 = runAll();
let [s, t] = cmp(a2, a3);
console.log(`(a) DDL layout  2col(fold) vs 3col(split), no weights, fresh, same token multiset : identical ${s}/${qs.length}  top1 ${t}/${qs.length}`);

build("3", "fresh", null);
const b0 = runAll();
build("3", "fresh", "0.0, 2.5, 1.0");
const bw = runAll();
[s, t] = cmp(b0, bw);
console.log(`(b) weights     3col bare vs 0.0,2.5,1.0, fresh text  : identical ${s}/${qs.length}  top1 ${t}/${qs.length}`);

build("3", "fresh", "0.0, 1.0, 1.0");
const b1 = runAll();
[s, t] = cmp(b0, b1);
console.log(`(b') identity   3col bare vs 0.0,1.0,1.0, fresh text  : identical ${s}/${qs.length}  top1 ${t}/${qs.length}  [恒等校验，非回归证明]`);

build("3", "stored", "0.0, 1.0, 1.0");
const cStale = runAll();
build("3", "fresh", "0.0, 1.0, 1.0");
const cFresh = runAll();
[s, t] = cmp(cStale, cFresh);
console.log(`(c) text repair 3col 0.0,1.0,1.0, stored vs fresh text      : identical ${s}/${qs.length}  top1 ${t}/${qs.length}`);

let missing = 0,
	total = 0;
const samples = [];
for (const [nodeId, kws] of gk) {
	const text = storedFts.get(nodeId) ?? "";
	for (const k of kws.filter((x) => x.trim())) {
		total++;
		if (!text.includes(k)) {
			missing++;
			if (samples.length < 6) samples.push(k);
		}
	}
}
console.log(`\nstaleness(literal substring): ${missing}/${total} glossary keywords absent from stored node_fts.text  samples=${samples.join(" / ")}`);
// ── 附加证据（本文档 §3.2 / §3.4 的引用）────────────────────────────
// (i) token 空间接缝：tok(join(uri,disc,content)) == tok(uri+content) ∪ tok(disc)
//     证明「把 disclosure 拆到独立列」不改变任何 token 命中。
{
	let same = 0;
	for (const n of nodes) {
		const a = new Set(tok([n.uri, n.disclosure ?? "", n.content].join(" ")).split(/\s+/).filter(Boolean));
		const b = new Set(
			[...tok([n.uri, n.content].join(" ")).split(/\s+/), ...tok(n.disclosure ?? "").split(/\s+/)].filter(Boolean),
		);
		if (a.size === b.size && [...a].every((x) => b.has(x))) same++;
	}
	console.log(`\nseam: tok(join) == tok(union) token-set ${same}/${nodes.length} nodes`);
}
// (ii) bare bm25 == 显式 1.0,1.0 == 0.0,1.0,1.0（FTS5 默认权重即全 1.0）
//      证明「推荐值 == 现状默认，行为保持」。
{
	const tiny = new DatabaseSync(":memory:");
	tiny.exec("CREATE VIRTUAL TABLE t USING fts5(node_id UNINDEXED, text, disclosure, tokenize='unicode61')");
	tiny.prepare("INSERT INTO t VALUES (?,?,?)").run("D", tok("共享 正文"), tok("独门词"));
	tiny.prepare("INSERT INTO t VALUES (?,?,?)").run("T", tok("共享 正文 独门词 独门词"), tok(""));
	const m = `"${tok("独门词")}"`;
	const score = (w) => tiny.prepare(`SELECT node_id, bm25(t${w}) bm FROM t WHERE t MATCH ?`).all(m);
	const bare = JSON.stringify(score(""));
	const one = JSON.stringify(score(", 1.0, 1.0"));
	const mine = JSON.stringify(score(", 0.0, 1.0, 1.0"));
	const two = JSON.stringify(score(", 0.0, 2.5, 1.0"));
	console.log(`bare == (1.0,1.0)      : ${bare === one}`);
	console.log(`bare == (0.0,1.0,1.0)  : ${bare === mine}   ← 推荐值 = FTS5 默认，行为保持`);
	console.log(`bare == (0.0,2.5,1.0)  : ${bare === two}   ← 契约初版建议：不同`);
}
// (iii) bm25 的列数错配**静默**（不报错）——E1/E2/E3 的证据。
//   覆盖三种错配：权重多于列、少于列、以及对 2 列表喂 3 个权重（E1 的旧库场景）。
{
	const tiny = new DatabaseSync(":memory:");
	tiny.exec("CREATE VIRTUAL TABLE t3 USING fts5(node_id UNINDEXED, text, disclosure, tokenize='unicode61')");
	tiny.exec("CREATE VIRTUAL TABLE t2 USING fts5(node_id UNINDEXED, text, tokenize='unicode61')");
	tiny.prepare("INSERT INTO t3 VALUES (?,?,?)").run("A", tok("词"), "");
	tiny.prepare("INSERT INTO t2 VALUES (?,?)").run("A", tok("词"));
	const q = tok("词");
	const b = (sql) => tiny.prepare(sql).get(q).b;
	// E2: 权重多于列数（5 喂 3）——静默忽略多余的
	const e2 = b("SELECT bm25(t3, 0.0, 1.0, 1.0, 9.0, 9.0) FROM t3 WHERE t3 MATCH ?");
	const e2base = b("SELECT bm25(t3, 0.0, 1.0, 1.0) FROM t3 WHERE t3 MATCH ?");
	console.log(`arity E2 (5 weights on 3 cols): ${e2 === e2base}  (extra silently ignored)`);
	// E3: 权重少于列数（2 喂 3）——同样静默
	const e3 = b("SELECT bm25(t3, 0.0, 1.0) FROM t3 WHERE t3 MATCH ?");
	console.log(`arity E3 (2 weights on 3 cols): ${typeof e3 === "number"}  (no throw)`);
	// E1: 对 2 列表喂 3 个权重（旧库 + 新代码）——不报错
	const e1a = b("SELECT bm25(t2, 0.0, 1.0, 1.0) FROM t2 WHERE t2 MATCH ?");
	const e1b = b("SELECT bm25(t2, 0.0, 1.0) FROM t2 WHERE t2 MATCH ?");
	console.log(`arity E1 (3 weights on 2 cols): no-throw=${typeof e1a === "number"}  extra-ignored=${e1a === e1b}`);
}

// (iv) `ORDER BY rank` 忽略 SELECT 里的自定义 bm25 权重（本文 §3.2 的结论）。
//      证明：rank 用 FTS5 默认权重（全 1.0）；自定义权重只影响 SELECT 出来的 bm 值，
//      不改变 ORDER BY rank 的排序。⇒ searchNodeFts 里的 `ORDER BY rank` 与权重无关。
{
	const t = new DatabaseSync(":memory:");
	t.exec("CREATE VIRTUAL TABLE t USING fts5(node_id UNINDEXED, text, disclosure, tokenize='unicode61')");
	const pad = (n) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
	t.prepare("INSERT INTO t VALUES (?,?,?)").run("A", pad(40), tok("词"));      // 词只在 disclosure
	t.prepare("INSERT INTO t VALUES (?,?,?)").run("B", pad(40) + " " + tok("词"), tok("x")); // 词只在 text
	const M = `"${tok("词")}"`;
	const order = (sql) => t.prepare(sql).all(M).map((r) => r.node_id).join("");
	const byRank = order("SELECT node_id FROM t WHERE t MATCH ? ORDER BY rank");
	const byDefault = order("SELECT node_id FROM t WHERE t MATCH ? ORDER BY bm25(t,1.0,1.0)");
	const byCustom = order("SELECT node_id FROM t WHERE t MATCH ? ORDER BY bm25(t,0.0,2.5,1.0)");
	console.log(`\nrank-vs-custom: ORDER BY rank=${byRank}  bm25(1.0,1.0)=${byDefault}  bm25(0,2.5,1.0)=${byCustom}`);
	console.log(`rank ignores custom weights: ${byRank === byDefault && byRank !== byCustom}`);
}
