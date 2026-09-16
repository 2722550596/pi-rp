// probes-d3/wal-vs-cp.mjs — 为什么迁移前备份 MUST 用 VACUUM INTO 而不是裸 cp
//
// 用法：node probes-d3/wal-vs-cp.mjs
//
// 结论：裸 cp <db>（不带 -wal）读到的是「主库文件 + 最后一次 checkpoint」的快照，
//       会**静默丢掉** WAL 里已提交但尚未 checkpoint 的事务。
//       VACUUM INTO 读的是连接视角，因此包含 WAL。
//
// ⚠️ 本对照**只在不带 -wal 复制时才有差异**，而差异是否出现取决于那一刻 WAL 是否非空
//    （checkpoint 时机由 SQLite 决定，也受 `PRAGMA wal_checkpoint(TRUNCATE)` 影响）。
//    ⇒ 为了让危害**必现**，本脚本用合成库显式构造一个非空 WAL 来演示；
//      真库上的同型实测见 README「真库实测记录」。
import { copyFileSync, existsSync, rmSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const TMP = "/tmp/d3probe";
const SRC = `${TMP}/wal-demo-src.db`;
const CP = `${TMP}/wal-demo-cp.db`;
const VAC = `${TMP}/wal-demo-vac.db`;

// ── ① 造一个「有未 checkpoint 事务」的 WAL 库 ─────────────────────────────────
for (const p of [SRC, `${SRC}-wal`, `${SRC}-shm`, CP, VAC]) rmSync(p, { force: true });
const db = new DatabaseSync(SRC);
db.exec("PRAGMA journal_mode = WAL");            // 与 driver.ts:52 一致
db.exec("CREATE TABLE nodes (node_id TEXT PRIMARY KEY, disclosure TEXT)");
db.exec("CREATE TABLE raw_log (raw_id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT)");
db.prepare("INSERT INTO nodes VALUES (?, ?)").run("n1", "早期条件");
db.exec("PRAGMA wal_checkpoint(TRUNCATE)");      // 把 n1 落到主库文件
// 之后的写入留在 WAL 里（不 checkpoint）—— 这就是「最近的事务」
db.prepare("INSERT INTO nodes VALUES (?, ?)").run("n2", "当又提到小苍兰时");
db.prepare("INSERT INTO raw_log (text) VALUES (?)").run("最近一条对话");
const liveN = Number(db.prepare("SELECT COUNT(*) c FROM nodes").get().c);
const liveR = Number(db.prepare("SELECT COUNT(*) c FROM raw_log").get().c);
// ⚠️ MUST NOT close here: closing the LAST connection checkpoints the WAL, erasing
//    exactly the state this demo needs. Copy while the connection is still open.

const walSize = existsSync(`${SRC}-wal`) ? statSync(`${SRC}-wal`).size : 0;
console.log(`合成库: ${SRC}`);
console.log(`  -wal size: ${walSize} bytes  ${walSize === 0 ? "⚠️ WAL 为空，本对照无法演示（重跑一次）" : ""}`);
console.log(`  live 视角:   nodes=${liveN}, raw_log=${liveR}\n`);

// ── ② 裸 cp（只复制主库文件，不带 -wal）──────────────────────────────────────
copyFileSync(SRC, CP);
const cp = new DatabaseSync(CP, { readOnly: true });
const cpN = Number(cp.prepare("SELECT COUNT(*) c FROM nodes").get().c);
const cpR = Number(cp.prepare("SELECT COUNT(*) c FROM raw_log").get().c);
cp.close();

// ── ③ VACUUM INTO（从连接视角导出）───────────────────────────────────────────
const src = new DatabaseSync(SRC, { readOnly: true });
src.exec(`VACUUM INTO '${VAC}'`);
src.close();
const vac = new DatabaseSync(VAC, { readOnly: true });
db.close();                                       // 复制/导出都做完后再关
const vacN = Number(vac.prepare("SELECT COUNT(*) c FROM nodes").get().c);
const vacR = Number(vac.prepare("SELECT COUNT(*) c FROM raw_log").get().c);
vac.close();

console.log(`  裸 cp（不带 -wal）: nodes=${cpN}, raw_log=${cpR}   ${cpN === liveN ? "" : `← 丢了 ${liveN - cpN} 行 nodes、${liveR - cpR} 行 raw_log`}`);
console.log(`  VACUUM INTO      : nodes=${vacN}, raw_log=${vacR}\n`);

const vacOk = vacN === liveN && vacR === liveR;
const cpLost = cpN !== liveN || cpR !== liveR;
console.log(`${cpLost ? "PASS" : "FAIL"}  裸 cp 会丢 WAL 里的事务（本对照的**阳性对照**：必须看到丢失）`);
console.log(`${vacOk ? "PASS" : "FAIL"}  VACUUM INTO == live 视角（备份 MUST 用这个）`);
console.log(`\n⇒ ${vacOk ? "结论成立" : "结论不成立"}：备份 MUST 用 \`VACUUM INTO\`。`);
process.exit(vacOk ? 0 : 1);
