# High-Concurrency Optimization & Architecture Redesign Plan for pi-rp

> This plan has been merged into [multi-agent-infrastructure.md](./multi-agent-infrastructure.md) as the
> horizontal axis (process / session / transport) of one transformation: turning pi-rp from agent
> infrastructure into multi-agent infrastructure. The vertical axis (in-session loop governance:
> RequestGateway / LoopSpec / LoopRegistry) and the combined execution order live there.

## Executive Summary
Currently, `pi-rp` RPC mode operates on a single-subprocess, single-session model (`pi --mode rpc`). When external orchestration engines trigger multiple `pi` instances concurrently, spawning individual Node.js sub-processes introduces heavy cold-start latency, duplicated V8 memory overhead, and high process management IPC costs.

This plan outlines architectural enhancements to enable high-concurrency, low-latency execution for multi-agent workloads within `pi-rp`.

---

## Key Performance Bottlenecks in Current Architecture
1. **Cold Start Overhead**: Spawning `node dist/cli.js --mode rpc` takes hundreds of milliseconds per instance (V8 initialization, script loading, extension resolution).
2. **Memory Duplication**: Duplicate static metadata (model registry, prompt templates, settings, system tools) across processes.
3. **IPC Overhead**: Standard stdio JSONL piping across many independent OS processes incurs serialization and process-context switching overhead.
4. **Provider Rate Limiting / Connection Churn**: Lack of centralized HTTP connection pooling and API key load-balancing across concurrent sessions.

---

## Architectural Refactoring Roadmap

### Phase 1: Multi-Session Protocol Support (Single Process, Multi-Session)
- **Goal**: Allow a single `pi-rp` process to manage multiple concurrent `AgentSession` instances.
- **Key Changes**:
  - Extend the RPC JSONL protocol to include a `sessionId` field in requests and events.
  - Implement a `SessionManager` registry within `rpc-mode.ts` mapping `sessionId` to `AgentSession` instances.
  - Add RPC session lifecycle commands: `create_session`, `destroy_session`, `list_sessions`.

### Phase 2: Resident Server / Daemon Mode (`--mode daemon`)
- **Goal**: Eliminate CLI process startup overhead for external engines.
- **Key Changes**:
  - Implement a persistent RPC daemon supporting Unix Domain Sockets (UDS) and WebSockets.
  - Keep core infrastructure (Model Registry, Extension Engine, Settings Manager) warmed up in memory.
  - Route external engine calls to active in-process sessions instantly.

### Phase 3: Worker Thread Pool & Shared State
- **Goal**: Scale session execution across CPU cores without full process isolation overhead.
- **Key Changes**:
  - Utilize Node.js `worker_threads` for heavy computation (e.g. extension execution, file tree indexing).
  - Share read-only static state (Model Catalogs, system prompts) across threads via `SharedArrayBuffer` / immutable data structures.

### Phase 4: Network & Provider Layer Concurrency Optimizations
- **Goal**: Optimize outbound HTTP streaming to LLM providers.
- **Key Changes**:
  - Enable HTTP Keep-Alive connection pooling in `@earendil-works/pi-ai`.
  - Introduce optional API key round-robin load balancing and retry backoff throttling for high-throughput batch requests.

---

## Target Metrics
- **Session Startup Time**: < 10ms (from ~300ms)
- **Memory Consumption**: ~60% reduction under 50+ concurrent sessions
- **IPC Throughput**: 5x increase via UDS / in-process dispatch
