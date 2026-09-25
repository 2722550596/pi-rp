# Tool Search

Pi registers every non-disabled tool — built-in, extension, and SDK — into the model's function list. With large registries (many extensions, MCP servers, SDK integrations) this floods the context and degrades tool selection. Tool search fixes this: low-frequency tools are **folded** out of the request and replaced by a synthetic `tool_search` tool the model can query to load them on demand.

The mechanism is entirely client-side. No provider protocol is required — it works on Anthropic, OpenAI, Google, and every other provider. On providers with native deferred-loading support the fold rides the existing deferred-tools channel (see [Provider behavior](#provider-behavior)).

## Activation

| `toolSearch.mode` | Behavior |
|---|---|
| `"auto"` (default) | Folds when the estimated potential folding set reaches `toolSearch.thresholdPercent` (default 10) percent of the model's context window |
| `"on"` | Always folds, regardless of size |
| `"off"` | Never folds; requests are byte-identical to pre-feature behavior |

Small setups pay nothing: if nothing folds, no `tool_search` tool is injected and behavior is unchanged. An invalid context window keeps auto mode conservatively inactive.

## What folds

By default, tools registered by extensions and SDK integrations are foldable. Tool authors can opt out with `deferrable: false` on the definition (see [Extensions](extensions.md)).

Never folded, regardless of declaration:

- Built-in tools: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`
- `tool_search` itself
- Tools listed in `tools.allow` (a preset allow-list means "always available") or `toolSearch.reservedTools`

## How the model discovers tools

While folding is active the system prompt carries a category section listing every searchable tool with a one-line description, so the model knows what to look for. `tool_search` accepts a regex `pattern`, `keywords`, and a `limit` (1–100), and matches against tool names, descriptions, prompt snippets, and parameter descriptions.

Discovery is sticky for the session: once a tool is discovered its full schema is available in subsequent turns, and repeated searches for it are idempotent. When every foldable tool has been discovered, `tool_search` drops out of the function list (but stays callable if the model hallucinates it). If the tool set changes mid-session — an MCP server connects, an extension reloads — the model receives a delta notice on its next turn.

Discovery survives compaction and resume: the state is recovered by replaying the session transcript (search calls plus deferred-tool markers) and the compaction boundary records the discovered set as a fallback. Switching branches resets discovery to what the new branch's transcript actually shows.

## Provider behavior

- **Anthropic** (`supportsToolReferences`): discovered-but-not-yet-called tools are sent with `defer_loading` and expanded in history via `tool_reference` — their schema never enters the cached prefix. Once called, a tool stays on the deferred channel; history already carries the expanded schema.
- **OpenAI Responses** (`supportsToolSearch`/`supportsAdditionalTools`): discovery rides the native `additional_tools` / `tool_search_call` channel.
- **Kimi** (`deferredToolsMode: "kimi"`) and all other providers: discovered tools appear as ordinary function schemas in the request.

In every case the model can keep calling a tool it has already used — only the schema placement differs.

## Configuration

Settings keys (see [Settings](settings.md)): `toolSearch.enabled`, `toolSearch.mode`, `toolSearch.thresholdPercent`, `toolSearch.reservedTools`.

CLI flags (see `pi --help`): `--tool-search on|off|auto`, `--tool-search-threshold <n>`, `--reserve-tools <name,...>` (replaces the configured reserved list for this session).

## For extension authors

Two things make your tools discoverable:

1. **`deferrable`** — set `false` on the tool definition if the tool must always be in the function list (default is foldable for extensions).
2. **Description quality** — the search matches your tool's name, description, and parameter descriptions, and the system-prompt section shows a one-line summary. Write them the way a model would search for the capability.

Design notes and the full behavioral contract live in `plan/tool-search/` in the repository.
