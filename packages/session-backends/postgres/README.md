# @earendil-works/pi-session-backend-postgres

PostgreSQL backend for the `@earendil-works/pi-agent-core` `SessionRepo` contract.

```ts
import { Pool } from "pg";
import { PostgresSessionRepository } from "@earendil-works/pi-session-backend-postgres";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  await using repository = new PostgresSessionRepository({ pool });
  const session = await repository.create({ cwd: process.cwd() });
  await session.appendCustomEntry("example", { hello: "world" });
} finally {
  // The caller owns the injected Pool; close the repository before the Pool.
  await pool.end();
}
```

The repository stores session entries, operation records, lanes, facts, and indexes in the dedicated `pi_session` schema. It does not own or close the injected Pool. The Pool role needs permission to create and read/write this schema.

This backend implements the new agent-core `SessionRepo`; it does not replace the legacy JSONL `SessionManager` used by coding-agent. It has no JSONL import, fallback, or dual-write path.

Requires Node.js `>=22.19.0`.
