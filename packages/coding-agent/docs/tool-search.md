# Tool Search

Pi registers non-disabled tools — built-in, extension, and SDK — into the model's function list. Large registries can flood the context and degrade tool selection. Tool search folds eligible `direct` tools out of the request when needed and exposes a synthetic `tool_search` for discovering them.

The mechanism is entirely client-side. No provider protocol is required — it works on Anthropic, OpenAI, Google, and every other provider. On providers with native deferred-loading support the fold rides the existing deferred-tools channel (see [Provider behavior](#provider-behavior)).

## Activation

| `toolSearch.mode` | Behavior |
|---|---|
| `"auto"` (default) | Folds when the estimated potential folding set reaches `toolSearch.thresholdPercent` (default 10) percent of the model's context window |
| `"on"` | Always folds, regardless of size |
| `"off"` | Never auto-folds direct tools; explicit `deferred` tools remain discoverable |

When no direct tools fold and no `deferred` tools exist, no `tool_search` tool is injected. An invalid context window keeps auto mode conservatively inactive.

## Exposure and folding

`exposure` declares the tool's channel, while the active preset's `tools.allow`/`tools.deny` policy grants or revokes user authorization. Tool authors do not configure fold eligibility separately.

- `direct` tools are declared while active; auto-folding can remove them from the request when the token threshold is reached.
- `deferred` tools are never declared directly, remain callable by other tools, and stay discoverable through `tool_search`.
- `codemode` tools are reached through codemode rather than direct model declarations.
- `model-only` tools are declared to the model but are not available to nested calls.
- `hidden` tools are not declared, callable, or searchable.

The built-in tools `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls`, tools listed in `tools.allow`, `toolSearch.reservedTools`, and non-`direct` tools are excluded from the auto-fold estimate.

## How the model discovers tools

While tool search is available the system prompt carries a category section listing searchable tools with a one-line description. `tool_search` accepts a regex `pattern`, `keywords`, and a `limit` (1–100), and matches tool and namespace names, descriptions and instructions, prompt snippets, and recursively flattened parameter names and descriptions.

Direct tools folded by the token threshold become declared after discovery. Deferred tools remain undeclared even after they are found; other tools can still call them.

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

1. **Exposure** — use `exposure: "deferred"` for tools that should remain searchable and callable by other tools without becoming a model-declared function. `direct` tools participate in token-threshold auto-folding.
2. **Description quality** — search includes tool and namespace metadata, prompt snippets, and nested parameter names/descriptions. Write these fields the way a model would search for the capability.

