# @earendil-works/pi-server

Experimental. This package is under active development and may change or be removed without notice. Its APIs and behavior are not yet stable.

Server package for pi.

## Session server core

The package exports the `PiServer` session server.

```ts
import type { PiServerService } from "@earendil-works/pi-server";
import { createUnixServer } from "@earendil-works/pi-server/unix";

const service: PiServerService = {
  async listSessions() {
    return storage.listSessions();
  },
  async listModels() {
    return modelRegistry.listModels();
  },
  async createSession(options) {
    return storage.createAndOpen(options);
  },
  async openSession(sessionId) {
    return storage.open(sessionId);
  },
};

const server = createUnixServer(service, {
  path: "/tmp/pi/server.sock",
});
await server.start();
```

`PiServer` composes transport listeners through the `PiServerListener` interface. Each listener must complete any transport-specific authentication and authorization before passing a connection to `PiServer`. For example, a WebSocket listener can validate credentials during the HTTP upgrade, while the Unix listener relies on socket filesystem permissions. The Unix submodule exports the `createUnixListener()` building block and `createUnixServer()` preset, keeping the common case concise without coupling the primary server to Unix sockets. The listener uses length-prefixed CBOR messages from `@earendil-works/pi-protocol`.

This package does not provide a standalone CLI or coding-agent service. Applications supply the `PiServerService` implementation.

`PiServerService.listSessions()` returns protocol `SessionMetadata`, not acquired runtime state. Services should map the durable fields their storage supports and may omit `updatedAt`, `parentSessionId`, `sessionName`, and `cwd`. `PiServer` refreshes available metadata from live snapshots without requiring stored sessions to fabricate phase, model, thinking-level, attachment, or lock values.

## Browser executor sessions

`createExecutorSessionBridge()` connects a browser-owned `AgentSession` to `PiServer` through a separate executor byte channel. Keep one bridge for the authorized `(sessionId, bindingId)` and call `bridge.acquireRuntime()` from the matching `PiServerService.createSession()` / `openSession()` path. Pass only an already-authenticated `ByteConnection` to `bridge.attachTransport()`; adapt that connection's ordered data/close/error callbacks to the returned `ByteConnectionHandler`.

```ts
import {
  createExecutorSessionBridge,
  MAX_EXECUTOR_INBOUND_CHUNK_BYTES,
  MIN_ABORT_CONTROL_BYTES,
} from "@earendil-works/pi-server";

const bridge = createExecutorSessionBridge({
  sessionId,
  bindingId,
  maxPendingCommands: 8,
  maxQueuedOutboundBytes: MAX_EXECUTOR_INBOUND_CHUNK_BYTES + MIN_ABORT_CONTROL_BYTES,
  maxAbortControlBytes: MIN_ABORT_CONTROL_BYTES,
});
```

The platform owns browser authentication, session/binding lookup, connection routing, and durable storage. Preserve the same logical bridge when replacing a physical transport; call `bridge.dispose()` only when the binding is permanently revoked. See [Browser session collaboration](../coding-agent/docs/browser-session-collaboration.md) for browser lifecycle, shared-mode controls, and limits.

## Transport testing

Custom transports can use `@earendil-works/pi-server/testing` for deterministic protocol conformance tests. It exports `createTestServer()`, `TestServerService`, `ProtocolTestClient`, and the transport-neutral `WireChannel` contract. `connectUnixTestClient()` is provided for Unix transport tests.

## `pi-ai` protocol bridge

`@earendil-works/pi-ai` domain objects and `@earendil-works/pi-protocol` wire DTOs remain independent. `@earendil-works/pi-session-protocol` contains the browser-safe user/assistant/tool-result, usage, JSON, and diagnostic-detail adapters. `pi-server` retains `toProtocolModelMetadata()` and re-exports its existing transcript converter API for consumers.

The shared adapters reject invalid tool inputs, identifiers, timestamps, and mismatched tool results; `toProtocolToolResultMessage()` requires the original `ToolCall` so it can verify the association and convert its arguments itself. Diagnostic details are explicitly sanitized. Closed `pi-ai` unions are mapped exhaustively, and compile-time field manifests enumerate current `pi-ai` properties so additions require an explicit review. The shared package tests summary conversion, tool-call association, and transcript reducer behavior; protocol schemas enforce consistent lifecycle states. The protocol mirrors `pi-ai` vocabulary such as `toolCall` and `toolUse` where the semantics are identical.
