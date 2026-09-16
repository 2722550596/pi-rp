// D3 accepted v2 fixture builder — the ONE way to regenerate
// `packages/memory/test/fixtures/memory-v2.db` after the source has been bumped
// to v3. Uses the pinned raw DDL in `v2.sql` (dumped from the pre-bump build),
// so the fixture stays a true v2 shape.
//
//   node probes-d3/make-fixture-v2.mjs
import { readFileSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const OUT = "/home/yoshix7ti/projects/pi-rp/packages/memory/test/fixtures/memory-v2.db";
rmSync(OUT, { force: true });
rmSync(`${OUT}-wal`, { force: true });
rmSync(`${OUT}-shm`, { force: true });
const db = new DatabaseSync(OUT);

// `v2.sql` also lists the five FTS shadow tables per virtual table; creating
// those by hand is an SQLite error ("reserved for internal use") — the
// `CREATE VIRTUAL TABLE` line makes them. Drop those lines.
const ddl = readFileSync("/home/yoshix7ti/projects/pi-rp/plan/memory-web/probes-d3/v2.sql", "utf8")
  .split("\n")
  .filter((line) => !/CREATE TABLE '(node|raw)_fts_/.test(line))
  .join("\n");
db.exec(ddl);
db.prepare("INSERT OR REPLACE INTO memory_kv (key, value, updated_at) VALUES (?, ?, ?)").run(
  "schema_version", "2", "2026-09-16T01:51:36.000Z",
);
const put = (uri, domain, content, disclosure) =>
  db.prepare(
    `INSERT INTO nodes (node_id, parent_id, domain, uri, content, disclosure, importance, source,
      created_at, updated_ts, content_hash, is_stub) VALUES (?, NULL, ?, ?, ?, ?, 5, 'manual', ?, ?, ?, 0)`,
  ).run(`n_${domain}_${Math.random().toString(36).slice(2, 8)}`, domain, uri, content, disclosure,
        "2026-09-16T01:51:36.000Z", "2026-09-16T01:51:36.000Z", Math.random().toString(36).slice(2, 10));
put("index://", "index", "Index domain root", null);
put("history://", "history", "Scene summary domain", null);
put("meta://", "meta", "Self-reflection domain", null);
put("core://a", "core", "alpha body", "node-level A");
put("core://b", "core", "beta body", "node-level B");
db.prepare("INSERT INTO aliases (alias_uri, target_node_id) VALUES (?, (SELECT node_id FROM nodes WHERE uri = ?))").run("diary://b_entry", "core://b");
db.prepare("INSERT INTO aliases (alias_uri, target_node_id) VALUES (?, (SELECT node_id FROM nodes WHERE uri = ?))").run("core://a", "core://b"); // dead alias
db.prepare("INSERT INTO edges (node_id, target_uri, kind) VALUES ((SELECT node_id FROM nodes WHERE uri = ?), ?, ?)").run("core://a", "core://b", "related");
// v2 FTS rows: the two-column shape, jieba-ish space-joined text.
for (const r of db.prepare("SELECT node_id, uri, content, disclosure FROM nodes").all()) {
  db.prepare("INSERT INTO node_fts (node_id, text) VALUES (?, ?)").run(
    r.node_id, [r.uri, r.disclosure ?? "", r.content].join(" ").toLowerCase(),
  );
}
console.log("v2 fixture written:", OUT, JSON.stringify({
  schema: db.prepare("SELECT value FROM memory_kv WHERE key='schema_version'").get().value,
  ftsCols: db.prepare("PRAGMA table_info(node_fts)").all().map((r) => r.name),
  nodes: db.prepare("SELECT COUNT(*) c FROM nodes").get().c,
  fts: db.prepare("SELECT COUNT(*) c FROM node_fts").get().c,
  aliases: db.prepare("SELECT COUNT(*) c FROM aliases").get().c,
  edges: db.prepare("SELECT COUNT(*) c FROM edges").get().c,
}));
db.close();
