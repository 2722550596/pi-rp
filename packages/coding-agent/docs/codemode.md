# Codemode

Codemode gives the model a small scripting tool that can call Pi tools through the normal extension-tool dispatcher. Instead of emitting a long sequence of individual tool calls, the model can execute a JavaScript program that invokes only the tools authorized for the current session. The result is returned as one codemode result; nested calls are not added as separate transcript messages.

Enable `codemode` through `--tools codemode` or include it in `defaultTools`:

```json
{
  "defaultTools": ["read", "bash", "edit", "write", "grep", "find", "ls", "codemode"]
}
```

`codemode.mode` controls declarations during execution:

- `"on"` exposes ordinary active tools and codemode together.
- `"only"` hides direct tool declarations from the model while keeping the authorized tools available to nested calls from codemode.

The extension also accepts `codemode.inlineBudget` (non-negative number of tool-call events retained in the codemode result) and `models` as factory options. By default, codemode may expose local model-catalogue lookup helpers to scripts; it does not make provider requests on its own.

```json
{
  "codemode": {
    "mode": "only",
    "inlineBudget": 20
  }
}
```

Codemode executes scripts in a worker using QuickJS compiled to WebAssembly. This isolates script globals and enforces the runtime's execution budget, but it is **not an operating-system security boundary**. Safety depends on the exposed tools: a script can invoke any tool the current authorized snapshot allows, and tools such as `bash` retain their ordinary capabilities. The runtime also caps nested calls and propagates cancellation and tool errors.

MCP servers configured with the `codemode` exposure are reachable through this same nested-call path. MCP project configuration is subject to project trust; see [MCP servers](mcp.md).
