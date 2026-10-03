# Object Store

Pi ships a content-addressed object store for data that is too large to keep inside session entries. Session state stays append-only in the session file as before; when a snapshot grows beyond 64 KiB, pi automatically persists it as a Merkle tree in the object store and appends a small `state-root.v1` entry instead. External consumers (embedded hosts such as game engines or knowledge bases) can use the same store for their own bulk data so that visibility follows branch and rollback semantics without copying or rewriting large payloads.

The store lives in `@earendil-works/pi-agent-core` and works identically on Node (filesystem) and in the browser (OPFS).

## Creating a store

Node — objects are stored under `<root>/objects/xx/yy/<hash>`:

```ts
import { createNodeObjectStore } from "@earendil-works/pi-agent-core/node";

const store = createNodeObjectStore("./data/objects");
```

Browser — objects live under a host-chosen root directory (typically save-scoped, e.g. `/workspace/<ws>/saves/<saveId>/objects`), created from an `OpfsFileSystem` handle. Browser hosts wire this in the harness assembly; the store instance is then the same interface.

Both factories accept the root at creation time. Pi never derives data paths on its own — hosts decide where data lives.

## Injecting into a session

Pass the store when creating a session. Snapshots at or below 64 KiB stay inline in the session file exactly as before; larger ones are written as a tree and referenced by root hash. Restores resolve the tree during the preflight phase — a missing or corrupted object aborts the restore before the leaf moves, leaving the session untouched.

```ts
import { createAgentSession } from "@earendil-works/pi-coding-agent";

const session = await createAgentSession({
  // ...
  objectStore: store,
});
```

Without an injected store, sessions with snapshots above 64 KiB fail explicitly rather than silently falling back — a partially working object store is treated as an error, not a degradation.

## Using the store directly

```ts
const hash = await store.put(bytes);          // content-addressed, idempotent; verifies SHA-256
const bytes = await store.get(hash);          // undefined if absent; throws on corruption
const exists = await store.has(hash);
```

- `put` never writes silently inconsistent data: the returned hash is always verified against the bytes.
- `get` validates the hash on read and throws `ObjectStoreError` with a `code` of `"missing" | "corrupt" | "io" | "invalid_hash"`. Failed IO and quota exhaustion are reported as errors — there is no in-memory fallback.
- There is no `delete` on the public interface. Reclamation is the garbage collector's job.

## Writing structured data

For JSON-shaped payloads, use the tree helpers instead of hand-rolling serialization. The tree (`JsonTree`) serializes values canonically (sorted keys, no whitespace, shortest round-trip numbers), splits long strings into rope chunks along line boundaries, and copies only the changed path on update — an unchanged 50 MiB subtree costs nothing to re-persist.

```ts
import { JsonTree } from "@earendil-works/pi-coding-agent";

const tree = new JsonTree(store);
const { root } = await tree.build(value);                 // full rebuild
const updated = await tree.update(root, edits);           // path-copy: only changed nodes are written
const hp = await tree.read(updated.root, ["party", "0", "hp"]);
```

Diffs between consecutive state revisions are produced by the same engine that applies state operations, so the tree always matches what `StateManager` did — the rebuild-from-scratch result is kept as a test oracle to enforce this.

## Exporting and importing bundles

A bundle is an uncompressed POSIX tar archive: `manifest.json` first, then every object reachable from the manifest's roots. Export collects that closure for you:

```ts
import { exportBundle, importBundle } from "@earendil-works/pi-agent-core";

const manifest = await exportBundle({
  roots: [{ hash: stateRootHash, codec: "state-root.v1" }],
  sessions: [{ path: "sessions/main.jsonl", bytes: sessionBytes.byteLength }],
  pins: [{ id: "pin-1", scope: "save", root: stateRootHash }],
  sink,   // { write(chunk): Promise<void> } — write to a file stream, a download, or memory
  store,
});
```

Import is a two-phase contract:

1. **Pi's part** — stream the archive, verify every object's hash and length, and `put` each one. Object writes are idempotent, so a retry never duplicates anything. If verification fails midway, nothing was published: interrupted imports leave only unreferenced objects.
2. **Host's part** — after `importBundle` resolves, the host records the returned manifest/roots in its own storage (for example a single IndexedDB transaction). Host-side registration is atomic on its own; there is deliberately no cross-system transaction. Orphaned objects from an abandoned import are reclaimed by GC.

The optional `createImportPin` callback registers a temporary pin during import so a concurrent sweep cannot reclaim objects that are verified but not yet registered.

## Space maintenance (optional)

Most archives never need explicit reclamation. Two zero-mechanism options cover the common cases first:

- **Deleting an archive deletes its object directory.** Object storage is save-scoped, so the objects' lifetime follows the archive's lifetime — no marking required.
- **Export → import compresses naturally.** A bundle carries only objects reachable from its roots; re-importing leaves orphans behind. One round-trip is a full cleanup.

What remains is a rare maintenance path for a single long-lived archive: reclaiming the objects orphaned by rollbacks and overwrites. Orphans accumulate slowly (deduplicated old tree nodes, typically megabytes against gigabyte quotas), so treat GC as an occasional tool, not a running concern.

GC is mark-and-sweep over the object store. Roots are: active branch heads, retained checkpoints, in-progress import pins, and explicit user pins. Everything unreachable from those is a candidate.

GC runs in two steps and only inside an explicit **GC window** — a host-declared interval where session writes are paused and a write barrier is active:

```ts
import { ObjectGarbageCollector } from "@earendil-works/pi-agent-core";

const gc = new ObjectGarbageCollector(store, admin, gcWindow);

// Step 1: dry run — compute candidates, keep the plan
const report = await gc.collectGarbage({
  rootsSnapshot,        // { id, roots, importPins? } from the window's current roots
  gcWindowId: gcWindow.id,
  mode: { kind: "dry-run" },
});

// Step 2: sweep — must target the same window and a fresh roots snapshot
await gc.collectGarbage({
  rootsSnapshot: window.refreshRootsSnapshot(),
  gcWindowId: gcWindow.id,
  mode: { kind: "sweep", dryRunId: report.dryRunId },
});
```

The sweep re-verifies its preconditions (window open, barrier active, roots snapshot fresh, candidate set unchanged). If anything moved between dry run and sweep, it throws instead of guessing.

**Constraints to know about:** GC is single-writer **by design, not provisionally**: cross-writer reclamation is a permanently rejected design, because two writers with independent root views cannot safely sweep each other's objects. Multi-open is solved by export → import as a fork (isolated roots, zero coordination). If a deployment ever needs in-place multi-tab access, gate GC on an exclusive ownership lock (Web Locks / file lock — "skip this round if anyone else is alive") rather than coordinating root views. Import buffers the archive in memory before verification; hosts distributing very large bundles should chunk at the bundle level rather than streaming through this API.

## Where pi uses this today

- Session state snapshots above 64 KiB (`state-root.v1` entries in the session file).
- Nothing else stores objects automatically. Extensions and embedded hosts are expected to use the store for their own bulk data; visibility across branches and rollbacks is then the host's ancestry query over the roots it tracks.
