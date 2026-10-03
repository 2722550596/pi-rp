# MCP servers

Pi can connect to Model Context Protocol (MCP) servers over stdio or Streamable HTTP. Add servers to `~/.pi/agent/mcp.json`:

```json
{
  "mcpServers": {
    "local-tools": {
      "command": "node",
      "args": ["./server.mjs"],
      "exposure": "codemode"
    },
    "remote-tools": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${REMOTE_TOKEN}" },
      "exposure": "deferred"
    }
  }
}
```

The project config directory can also contain `mcp.json` (by default `.pi/mcp.json`). Project MCP configuration is loaded only after the project is trusted. `--config-dir` and `--settings-file` affect the same trust check and effective paths used by the loader. Until trust is granted, Pi does not parse that file, interpolate its environment references, launch its stdio processes, or connect to its HTTP endpoints. Run a normal Pi session in the project to review and grant project trust first.

Each server may set `enabled` (default `true`), `timeout`, `env`, `headers`, and a default `exposure`; per-tool `toolExposure` overrides the default. Exposures are:

- `direct`: expose the server's tools as ordinary model-callable tools.
- `deferred`: keep tools callable through codemode but discover declarations with `tool_search` when needed.
- `codemode`: expose them for nested calls from codemode without listing them as direct model declarations.
- `hidden`: do not expose the server's tools to model or nested calls.

MCP tool names are namespaced by server. Connected servers with resources also provide resource-reading tools. Stdio uses the server's child process; HTTP uses Streamable HTTP. The client supports OAuth authorization-code/PKCE where the server requires it.

Manage configured servers from the terminal:

```sh
pi mcp list
pi mcp list --json
pi mcp login <server>
pi mcp logout <server>
```

Interactive sessions also provide `/mcp` to inspect status, reconnect, enable/disable configured entries, change exposure, and manage OAuth credentials.

`mcp.json` is executable configuration, not passive metadata. A trusted stdio server runs as a child process and, by default, inherits the process environment; do not put untrusted commands or server configuration in a trusted project. HTTP servers receive configured credentials and can return untrusted tool data. Tool output remains data in the conversation; it is not promoted to system or developer instructions. MCP tool calls still pass through Pi's normal tool authorization, validation, hooks, abort handling, and result processing.

This client currently supports stdio and Streamable HTTP. It does not implement an MCP server endpoint, SSE transport, prompts, sampling, task APIs, or batch operations.
