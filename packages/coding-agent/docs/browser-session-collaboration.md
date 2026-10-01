# Browser session collaboration

`@earendil-works/pi-browser` can run the Pi executor in a browser while multiple `PiClient` participants attach to the same server session. The browser owns the live `AgentSession`; PiServer serves participants through its existing session protocol. The browser connection is an executor channel, not a participant `PiClient` connection.

## Responsibility boundary

Pi-rp provides `startBrowserExecutor()` and the server-side `createExecutorSessionBridge()`. The host platform supplies an authenticated, ordered byte transport and is responsible for authenticating the browser, binding the executor to a session, routing its connection to the matching bridge, and storing/recovering platform session records. Pi-rp does not provide a hosted broker, authentication, room/member management, or a WebSocket endpoint.

The browser harness and PiServer runtime must use the same session ID. The platform must ensure that a connection is authenticated and bound before passing its raw `ByteConnection` to the matching `ExecutorSessionBridge`.

## Browser executor lifecycle

Create the harness first, then create one executor for its session. The host-provided `ByteTransportFactory` must establish an authenticated connection and deliver ordered byte chunks. `flowControl` limits the command window and total queued plus in-flight encoded bytes. Configure at least two ordinary command slots; `maxAbortControlBytes` must reserve one maximum-sized abort result plus `MIN_ABORT_CONTROL_BYTES` for the control error/rejection frame, and `maxQueuedOutboundBytes` must be at least `MAX_EXECUTOR_INBOUND_CHUNK_BYTES + maxAbortControlBytes`. These constants are exported by `@earendil-works/pi-browser`. Choose larger finite limits to match the host transport. Connect, handshake, and bootstrap deadlines are configurable.

The transport must also split inbound data so each browser `onData` callback receives at most `MAX_EXECUTOR_INBOUND_CHUNK_BYTES` bytes (a 16 MiB frame plus its 4-byte length prefix); preserve byte order across those chunks.

```ts
import {
  startBrowserExecutor,
  MAX_EXECUTOR_INBOUND_CHUNK_BYTES,
  MIN_ABORT_CONTROL_BYTES,
} from "@earendil-works/pi-browser";

const abortControlBudget = MAX_EXECUTOR_INBOUND_CHUNK_BYTES + MIN_ABORT_CONTROL_BYTES;
const transportByteBudget = MAX_EXECUTOR_INBOUND_CHUNK_BYTES + abortControlBudget;
// `harness` and `transportFactory` come from the host platform.
const executor = startBrowserExecutor({
  harness,
  sessionId: harness.session.sessionId,
  transportFactory, // host-provided authenticated ByteTransportFactory
  flowControl: {
    maxPendingCommands: 8,
    maxQueuedOutboundBytes: transportByteBudget,
    maxAbortControlBytes: abortControlBudget,
  },
  onError(error) {
    console.error(error);
  },
});

await executor.ready;
```

`ready` resolves only after the executor handshake and initial snapshot bootstrap are accepted. If the transport is lost, the local harness remains usable and the active model run is not restarted. Call `reconnect()` explicitly after the platform has routed a new authenticated connection to the same logical bridge; the new generation sends a current snapshot. A command interrupted by disconnection has an unknown outcome and is not replayed. `dispose()` stops the driver, best-effort queues a terminal close signal when online, and closes its transport without waiting for a stalled write; it does not dispose the harness.

## Shared-mode commands

While shared mode is active, send local changes through `executor.commands`:

```ts
await executor.commands.prompt("Summarize the current files");
await executor.commands.steer("Also include the tests");
await executor.commands.setThinking("medium");
```

The same command arbiter handles local calls and server commands. A conflicting prompt is rejected as busy; steering remains FIFO and can be accepted while a run is active; abort uses a reserved control slot. Direct calls to `harness.prompt()`, `harness.abort()`, or mutating methods on `harness.session` bypass that arbiter and are unsupported in shared mode. They remain available for local-only harness use.

Participants continue to use `PiClient` and the existing participant protocol. They attach to the PiServer session as usual; they do not connect through the executor API.

## Transcript and limits

The runtime projects the active, compaction-aware session context into the standard participant transcript. It forwards standard user, assistant, and tool-result items with live assistant/tool progress. Custom messages, extension-only entries, bash execution details, and other nonstandard roles are not represented as participant transcript items.

Executor frames use the protocol's existing 16 MiB frame cap. Snapshots are not paged or fragmented: if the active transcript cannot fit, bootstrap/attach is rejected with the existing safe invalid-request behavior; reduce the active branch or retained transcript before retrying. If a command has already executed but its resulting snapshot is too large, the operation is not rolled back and its result may be unknown to the caller. Already attached participants continue receiving progress; the protocol does not promise event replay or exactly-once command execution.

See the [browser harness SDK section](sdk.md#browser-and-hosted-harnesses) for harness setup and the [executor design](../../../docs/design/browser-session-collaboration/02-browser-runtime-adapter.md) for the wire and lifecycle contract.