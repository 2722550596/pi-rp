# Multi-Agent Infrastructure — Design & Assessment

> Review of the plan at `plan/multi-agent-infrastructure.md` based on architecture research.
> The plan's direction is correct. Its execution order is mostly right. Several design details need adjustment.

## TL;DR: Where the plan gets it right, where it gets it wrong

| Claim | Verdict | Rationale |
|---|---|---|
| "Gateway is the only pure-refactor component" | Correct | No behavioral change to single-session — can be wrapped around streamFn at construction time |
| "Phase 1 should combine session + loops + usage" | Mostly right, but LoopsRegistry is premature | 3 AbortControllers are concrete and need consolidation; full LoopsRegistry with lifecycle methods is YAGNI until there are >2 loop types |
| "Subagent usage is invisible" | Correct | Ephemeral session at `/tmp/pi-subagent-ephemeral`, no usage backpropagation |
| "completeSummarization is the choke point" | Correct | All compaction and branch-summary LLM calls go through it |
| "BackgroundLoopRuntime is YAGNI" | Correct | No consumer exists; the plan itself says this |
| "Phase 3 worker threads are orthogonal" | Correct | No dependency on other phases |
| "Phase 0 = 1-2 days" | Optimistic but feasible | Gateway wrapping is small; the harder part is verifying it doesn't change behavior |
| "Phase 1 should be done as one big chunk" | **Disagree** | Multi-session protocol, loop consolidation, and usage unification are 3 separable sub-phases that can be validated independently |
| "LoopRegistry should be a container for AbortControllers" | **Disagree** | The 3 AbortControllers + subagent running are already managed. A registry adds abstraction without leverage. The real need is a `LoopSpec` for request identity, not a registry for lifecycle |

## Detailed Assessment

### Phase 0: RequestGateway — Correct approach, specific insertion point

The plan says "in the StreamFn seam." The seam is well-defined:

- `sdk.ts` creates the `streamFn` that calls `modelRuntime.streamSimple`
- `model-runtime.ts` `streamSimple()` resolves auth then delegates to `provider.streamSimple()`
- `compaction.ts` `completeSummarization()` takes an optional `streamFn` parameter

**The right insertion point** is wrapping `modelRuntime.streamSimple` itself, not every `streamFn` call site. This catches:
- Main agent turns (via `streamFn` in sdk.ts)
- Compaction calls (via `completeSummarization` -> `streamFn` or `modelRuntime.completeSimple`)
- Branch summary calls (same path)
- Subagent calls (via `modelRuntime` in `runSubagent`)

**But**: `retryProviderRequest` in `packages/ai/src/utils/provider-retry.ts` is the actual lowest-level choke point — every SDK call flows through it. A concurrency semaphore there would be provider-agnostic but would lack per-provider granularity without plumbing the provider identity through.

**Decision**: Gateway wraps `modelRuntime.streamSimple` at the ModelRuntime level, not inside pi-ai's provider-retry layer. This keeps the change in coding-agent where it can be configured, tested, and evolved without touching pi-ai internals.

### Phase 1: Multi-session — Split into 3 sub-phases

The plan wants to do session + loops + usage in one phase. The problem:

1. **Multi-session protocol** (`sessionId` in RPC, `create_session`/`destroy_session`/`list_sessions`) is purely additive — it doesn't change existing code paths. It can be designed, implemented, and tested independently.
2. **Loop consolidation** (AbortControllers -> LoopsRegistry) is a refactor of `agent-session.ts` internals. It's a prerequisite for destory_session (must abort all loops), but it's a small, testable change.
3. **Usage unification** (subagent usage backpropagation) touches `runSubagent` and `subagent/extension.ts`. It's independent of multi-session protocol.

**This means the plan's Phase 1 can be done in 3 steps, each independently verifiable**:

1. **1a**: Loop consolidation (AbortControllers -> `SideRequestSpec` pattern) — refactor, no new behavior
2. **1b**: Multi-session protocol (`sessionId`, `create_session`, `destroy_session`, `list_sessions`) — additive, backward-compatible
3. **1c**: Usage unification (subagent usage back to parent) — additive, independent

### Phase 2: Daemon/UDS — The plan is right to defer

The plan's Phase 2 (Daemon/UDS) is gated on Phase 1. The assessment is correct: "不要一上来搬 omp 全套." The daemon work is primarily transport — UDS listener, process lifecycle, session routing — and the design is straightforward once the multi-session protocol exists.

### What the plan misses

1. **Gateway + session isolation**: Multiple sessions sharing a single gateway means session A's 429 backoff (from the gateway's semaphore) delays session B's requests to the same provider. The plan doesn't address whether this is desired or how to mitigate it. **Decision**: per-session `priority` labels on the gateway, with the main loop at highest priority, compaction at medium, subagent at low. Provider exhaustion of one session should not starve another session's main loop.

2. **LoopSpec identity in all LLM calls, not just side requests**: The plan's `LoopSpec` is only for `completeSummarization` parameters. But the main agent turn also needs identity for the gateway (priority, budget tracking). The main loop is already the highest-priority consumer; it just needs a label. **Decision**: `LoopSpec` is a lightweight identity object (not a parameter bag), attached to every LLM call through the gateway.

3. **Subagent's ephemeral session path**: The plan says "不动 /tmp 的 ephemeral 语义." But the ephemeral path `/tmp/pi-subagent-ephemeral` is shared across all subagent invocations. Multiple concurrent subagents writing to the same directory will corrupt each other's session files. **This is a bug today**, not a future concern. The ephemeral `SessionManager` should either use a unique temp dir per invocation or `SessionManager.inMemory()` (which exists — see `session-manager.ts`).

4. **Testing strategy**: The plan has no testing section. The gateway is the only component testable in isolation. Multi-session protocol integration tests need a new test harness.

## Phase 0: RequestGateway — Design

### Location

- **New file**: `packages/coding-agent/src/core/request-gateway.ts`
- **Wraps**: `ModelRuntime.streamSimple` (and `completeSimple` for non-streaming calls)
- **Injected into**: `AgentSession` constructor, `SubagentPreparation` execution, `completeSummarization`

### API

```typescript
export interface RequestGatewayConfig {
  /** Per-provider concurrency limits. Keyed by provider ID. */
  providers?: Record<string, { maxConcurrency: number }>;
  /** Default max concurrency for providers not explicitly configured */
  defaultMaxConcurrency?: number;
}

export interface RequestIdentity {
  /** Session ID for cross-session accounting */
  sessionId: string;
  /** Priority: higher = more urgent. 0=main loop, 1=compaction, 2=subagent */
  priority: number;
  /** Label for observability */
  label: string;
}

export interface RequestGateway {
  /** Wrap a stream call with concurrency control */
  streamSimple(
    model: Model<Api>,
    context: Context,
    options?: ModelsSimpleStreamOptions,
    identity?: RequestIdentity,
  ): AssistantMessageEventStream;

  /** Wrap a complete call with concurrency control */
  completeSimple(
    model: Model<Api>,
    context: Context,
    options?: ModelsSimpleStreamOptions,
    identity?: RequestIdentity,
  ): Promise<AssistantMessage>;

  /** Get current concurrency state for a provider */
  getProviderState(providerId: string): { active: number; queued: number; maxConcurrency: number };

  /** Create a gateway with a specific config (for use in tests) */
  static create(modelRuntime: ModelRuntime, config?: RequestGatewayConfig): RequestGateway;
}
```

### Behavior

1. **Per-provider semaphore**: Before calling `modelRuntime.streamSimple`, acquire a semaphore slot for the provider. Release on completion/error.
2. **Priority queue**: If the semaphore is full, queue the request by priority. Higher priority dequeues before lower priority.
3. **No 429/rate-limit logic** in Phase 0 — the plan says this is optional, and the existing per-request retry in `retryProviderRequest` already handles 429s. Add 429-aware coordination in a follow-up.
4. **Zero behavioral change**: When `maxConcurrency` is unset or `Infinity`, the gateway is a no-op pass-through.

### Integration points

| File | Change |
|---|---|
| `sdk.ts` | `createAgentSession()` creates a `RequestGateway` from `modelRuntime` and injects it into `AgentSession` config |
| `agent-session.ts` | Accept `requestGateway` in config. Pass it to compaction calls. Use it in `_runAgentPrompt` for the main turn identity |
| `compaction/compaction.ts` | `completeSummarization()` accepts optional `requestGateway` + `identity` |
| `subagent/run.ts` | Pass `requestGateway` when creating the ephemeral session |
| `model-runtime.ts` | No change — gateway wraps it externally |

## Phase 1a: Loop Consolidation — Design

### Problem

3 separate `AbortController` fields (`_compactionAbortController`, `_autoCompactionAbortController`, `_branchSummaryAbortController`) + subagent running state. `isCompacting` checks all three. `abort()` calls `abortCompaction()` + `abortBranchSummary()` individually.

### What to do

Not a full LoopsRegistry (YAGNI). Instead:

1. Create a `SideRequestSpec` type that bundles the parameters for a single summarization call (model, apiKey, headers, env, signal, streamFn, retry, callbacks, identity).
2. Extract the "create abort controller + run side request + cleanup" pattern into a shared helper.
3. Replace the 3 AbortController fields with a `Set<AbortController>` of active side requests. `isCompacting` = `set.size > 0`.
4. `abort()` iterates the set and aborts all.

### API

```typescript
// New: agent-session.ts or new file agent-session-loops.ts
export interface SideRequestIdentity {
  type: "compaction" | "auto-compaction" | "branch-summary";
  reason?: "overflow" | "threshold";
  sessionId: string;
}

export function createSideRequestAbortController(
  existingControllers: Set<AbortController>,
): AbortController {
  const ctrl = new AbortController();
  existingControllers.add(ctrl);
  return ctrl;
}

export function cleanupSideRequestAbortController(
  existingControllers: Set<AbortController>,
  ctrl: AbortController,
): void {
  existingControllers.delete(ctrl);
}
```

### Changes

| File | Change |
|---|---|
| `agent-session.ts` | Replace 3 `_*AbortController` fields with `_activeSideRequests: Set<AbortController>`. `isCompacting` checks `this._activeSideRequests.size > 0`. `abortCompaction()`/`abortBranchSummary()` collapse into `abortSideRequests()` |
| `agent-session.ts` | `compact()` and `navigateTree` use `createSideRequestAbortController`/`cleanupSideRequestAbortController` |
| `agent-session.ts` | `_runAutoCompaction` uses the same pattern |

## Phase 1b: Multi-session Protocol — Design

### Protocol changes

Add to `rpc-types.ts`:

```typescript
// New commands
| { type: "create_session"; sessionId?: string; cwd?: string }
| { type: "destroy_session"; sessionId: string }
| { type: "list_sessions" }

// Add sessionId to existing commands (optional, backward-compatible)
| { id?: string; type: "prompt"; sessionId?: string; message: string; ... }
| { id?: string; type: "abort"; sessionId?: string }
| ... etc

// New responses
| { id?: string; type: "response"; command: "create_session"; success: true; data: { sessionId: string } }
| { id?: string; type: "response"; command: "destroy_session"; success: true }
| { id?: string; type: "response"; command: "list_sessions"; success: true; data: { sessions: SessionInfo[] } }
```

### Session registry

```typescript
// New: agent-session-runtime.ts or new file session-registry.ts
export class SessionRegistry {
  private sessions = new Map<string, AgentSessionRuntime>();
  private defaultSessionId: string | null = null;

  create(cwd: string, sessionId?: string): AgentSessionRuntime;
  destroy(sessionId: string): void;
  get(sessionId?: string): AgentSessionRuntime | undefined;
  list(): SessionInfo[];
}
```

### Changes

| File | Change |
|---|---|
| `rpc-types.ts` | Add `create_session`, `destroy_session`, `list_sessions` commands. Add optional `sessionId` to existing commands |
| `rpc-mode.ts` | `handleCommand` switch gains `create_session`/`destroy_session`/`list_sessions` cases. `prompt`/`abort`/etc check `sessionId` and route to the right session |
| (new) `session-registry.ts` | Registry of `AgentSessionRuntime` instances. Shared `ModelRuntime` instance across all sessions |
| `agent-session-runtime.ts` | `newSession()` moves into the registry pattern. Each session gets its own `AgentSession` + `SessionManager` |

## Phase 1c: Usage Unification — Design

### Problem

`runSubagent` creates an ephemeral session. The parent session can't see the subagent's token usage.

### Solution

1. `runSubagent` already has access to the parent session's `modelRuntime` (passed as parameter).
2. After `runSubagent` completes, extract the last assistant message's `usage` from the ephemeral session.
3. Return `usage` in `SubagentResult`.
4. The subagent tool's execute handler (in `extension.ts`) appends the usage to the parent session as a synthetic `BranchSummaryEntry` or `CustomEntry`.

### Changes

| File | Change |
|---|---|
| `subagent/run.ts` | `SubagentResult` gains `usage?: Usage`. Extract from ephemeral session's last assistant message before disposal |
| `subagent/extension.ts` | Subagent tool execute handler captures `result.usage` and appends to parent session via `sessionManager.appendCustomEntry` or similar |
| `usage-totals.ts` | No change — `getUsageCostBreakdown` already reads `branch_summary` and `compaction` entries |
| `agent-session.ts` | `getSessionStats` automatically picks up the new entries |

## Phase 2: Daemon/UDS — Minimal design

### What it is

A persistent process that listens on a Unix Domain Socket (or stdin/stdout in RPC mode) and manages multiple sessions. The daemon owns:
- `ModelRuntime` (shared across sessions — provider auth, model registry, credential store)
- `RequestGateway` (shared — per-provider concurrency across all sessions)
- `SessionRegistry` (all active sessions)

### What it is NOT

- Not a separate binary — it's the same `pi` binary with a `--daemon` flag
- Not a process supervisor — no auto-restart, no health checks (those are the engine's job)
- Not a full omp-style runtime — no BackgroundLoopRuntime, no advisor

### Implementation sketch

```
pi --daemon [--socket /tmp/pi-world.sock]
  → Creates ModelRuntime, RequestGateway, SessionRegistry
  → Listens on UDS for JSONL commands
  → Each command is routed to the appropriate session
  → No session = route to default session (create on first command)
  → SIGTERM: graceful shutdown (abort all sessions, close socket)
```

## Worldlines validation path

### Current state

- `worldlines-mvp` uses `vendor/pi-rp` as a submodule at the same commit as `projects/pi-rp`
- 4 processes per round: world pose, player choose, elena choose, world advance
- `--session-id` continues context across rounds
- `PersistentRpcPool` doesn't exist in the codebase — it's a worldlines-mvp concept (per-role Python process pools)

### Validation order

1. **Phase 0 alone**: `worldlines-mvp` already uses per-call spawn. Gateway in per-call mode is a no-op (each process has one session, one request at a time). No behavioral change.
2. **Phase 1a + 1c** (loop consolidation + usage): Worldlines doesn't use compaction or branch summary — these are pi-rp features. No effect.
3. **Phase 1b** (multi-session protocol): This is the first phase that changes worldlines. The goal: one daemon process, 3 sessions (world, player, elena). Validation: run a single round with 3 sessions in one process, verify correctness.
4. **Phase 2** (daemon): The daemon replaces the per-call spawn. The Python engine's `tick_lw.py` starts the daemon once, then sends commands instead of spawning processes.

### Risk: worldlines doesn't use subagents

The plan's Phase 1 validates by running world with 3 sessions. But worldlines doesn't use the `subagent` tool — it uses separate sessions with different presets. The subagent usage unification (Phase 1c) is orthogonal to worldlines validation. That's fine — it validates independently through the existing test suite.

## Risk assessment

| Risk | Severity | Mitigation |
|---|---|---|
| Weekly session A's 429 backoff delays session B | Medium | Gateway priority: main loop at 0, compaction at 1, subagent at 2. Separate per-session semaphore as a later option |
| Shared ephemeral session path corrupts concurrent subagents | High (existing bug) | Fix in Phase 1a: use `SessionManager.inMemory()` or unique temp dir per subagent invocation |
| Gateway Phase 0 feature-creep into rate-limit coordination | Low | Cut scope: Phase 0 is concurrency semaphore only. 429 coordination is a follow-up |
| Multi-session protocol changes break existing RPC clients | Low | `sessionId` is optional and backward-compatible. Missing `sessionId` = use default session |
| Daemon single point of failure for worldlines | Medium | Session persistence already exists (session-backend files). Daemon restart with `--session-id` reconnects. No in-memory-only state |
| ModelRuntime shared across sessions means one session's auth refresh affects others | Low | Already handled — `ModelRuntime.getAuth` is async and idempotent. No shared mutable state at the API call level |