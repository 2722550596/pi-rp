# Prompt Presets

Prompt presets replace Pi's built-in system prompt with a composable, reorderable definition in JSON. They control what goes into the model's context window: system instructions, tool listings, project context, and conversation history placement.

Presets live in `.pi/prompt-presets/` as `.json` files. Each file defines one preset. Pi loads them on startup and on `/reload`.

## Quick Start

Create `.pi/prompt-presets/simple.json`:

```json
{
  "schemaVersion": 1,
  "id": "simple",
  "name": "Minimal Preset",
  "items": [
    {
      "kind": "block",
      "id": "role",
      "role": "system",
      "content": "You are a helpful coding assistant."
    },
    {
      "kind": "slot",
      "id": "tools",
      "role": "system",
      "slot": "tools"
    },
    {
      "kind": "slot",
      "id": "chat",
      "slot": "chat-history"
    }
  ]
}
```

Switch to it with `/preset simple`. Verify with `/prompt`.

## Schema

### Top-Level Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `schemaVersion` | `1` | yes | Schema version. Currently always `1`. |
| `id` | string | yes | Unique identifier. Used with `/preset <id>`. |
| `name` | string | no | Human-readable name. |
| `description` | string | no | Shown by `/preset` autocomplete. |
| `autoActivate` | boolean | no | Auto-select this preset if it has no errors. Default `true`. |
| `mode` | `"replace"`, `"append"`, `"prepend"` | no | How this preset merges with Pi's internal base. `"replace"` is the norm. |
| `defaults` | object | no | Default slot options (see [Defaults](#defaults)). |
| `tools` | object | no | Filter tool visibility (see [Resource Policies](#resource-policies)). |
| `skills` | object | no | Filter skill visibility (see [Resource Policies](#resource-policies)). |
| `variables` | object | no | Static variable values available as `{{name}}` in block content. |
| `items` | array | yes | Ordered list of items composing the prompt. |

### Items

Each item is either a **block** (static text) or a **slot** (dynamic content rendered at compile time).

#### Block Item

```json
{
  "kind": "block",
  "id": "my-instruction",
  "name": "Custom Instruction",
  "enabled": true,
  "role": "system",
  "content": "Focus on writing clean, idiomatic code."
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `kind` | `"block"` | yes | Must be `"block"`. |
| `id` | string | yes | Unique within the preset. |
| `name` | string | no | Display name for diagnostics. |
| `enabled` | boolean | no | Set to `false` to skip. Default `true`. |
| `role` | string | no | Message role: `"system"`, `"user"`, `"assistant"`, `"custom"`. Default `"system"`. |
| `content` | string | yes | The prompt text. Supports `{{macro}}` expansion. |

#### Slot Item

```json
{
  "kind": "slot",
  "id": "tools",
  "name": "Available Tools",
  "enabled": true,
  "role": "system",
  "slot": "tools",
  "options": { "onlyWithSnippets": true }
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `kind` | `"slot"` | yes | Must be `"slot"`. |
| `slot` | string | yes | One of the [built-in slots](#built-in-slots) or a custom extension slot. |
| `options` | object | no | Slot-specific options (see per-slot docs below). |

### Role and Compilation

The `role` field determines which output stream an item feeds into:

- **`"system"`** (default) — goes into `compileSystemPrompt()` output and the system-prompt portion of `compileMessages()`.
- **`"user"`** or **`"assistant"`** — goes only into `compileMessages()` as a synthetic message at its position in the items array.
- **`"custom"`** — same as non-system roles, but the message `role` field in the compiled output is `"custom"`.

This is how the **writer** example positions the `{{lastUserMessage}}` *after* chat-history as a synthetic user message:

```json
[
  { "kind": "slot", "id": "chat", "slot": "chat-history", "options": { "omitLatestUser": true } },
  { "kind": "block", "id": "latest", "role": "user", "content": "{{lastUserMessage}}" }
]
```

## Built-in Slots

### `tools`

Renders each active tool followed by its prompt snippet.

| Option | Type | Default | Description |
|---|---|---|---|
| `onlyWithSnippets` | boolean | `true` | Only show tools that have a prompt snippet. |
| `format` | `"plain"`, `"xml"`, `"json"` | `"plain"` | Output format. |

### `tool-guidelines`

Renders usage guidelines for the selected tools.

| Option | Type | Default | Description |
|---|---|---|---|
| `heading` | string | `"Guidelines:"` | Section heading text. |
| `includePiDefaultGuidelines` | boolean | `true` | Include Pi's built-in guideline defaults. |
| `format` | `"plain"`, `"xml"`, `"json"` | `"plain"` | Output format. |

### `project-context`

Renders project context files (from `CONTEXT.md`, etc.) wrapped in `<project_context>` tags.

No options.

### `skills`

Renders available skill descriptions.

| Option | Type | Default | Description |
|---|---|---|---|
| `requireReadTool` | boolean | `true` | Only render skills if the `read` tool is active. |

### `append-system-prompt`

Renders any system prompt content appended via Pi's settings or API (typically empty unless the user explicitly sets it).

No options.

### `pi-docs`

Injects a static reference block pointing to Pi's documentation paths. Only meaningful when the model needs to answer questions about Pi itself.

No options.

### `date`

| Option | Type | Default | Description |
|---|---|---|---|
| `includeTime` | boolean | `false` | Also show the current time. |

### `cwd`

Current working directory.

No options.

### `date-cwd`

Shortcut that renders the working directory line (equivalent to `cwd` but slightly different label for legacy compatibility).

No options.

### `active-model`

Reserved for future use. Currently renders empty.

### `chat-history`

The conversation history insertion point. This slot determines **where** in the message array the actual conversation gets placed — it does not render text directly.

| Option | Type | Default | Description |
|---|---|---|---|
| `maxMessages` | number | — | Keep only the most recent N messages. |
| `maxChars` | number | — | Keep only the most recent messages within this character budget. |
| `omitLatestUser` | boolean | `false` | Skip the latest user message (for re-insertion via `{{lastUserMessage}}`). |
| `stripAssistantThinking` | boolean | `false` | Remove `thinking` content blocks from past assistant messages. |
| `roles` | string[] | — | Only include messages with these roles (e.g. `["user", "assistant"]`). |
| `toolMode` | `"keep"`, `"drop"` | `"keep"` | Keep or discard tool call/result messages. |
| `includeSummaries` | boolean | `false` | Include Pi's synthetic branch/compaction summary messages. |

### `variables`

Renders runtime variable key-value pairs (not user-defined). Supports `includeStatic`, `includeSession`, `includeTurn` sub-options.

## Macros

In block `content` fields, wrap a macro name in double braces to expand it at compile time:

| Macro | Description |
|---|---|
| `{{date}}` | Current date (YYYY-MM-DD). |
| `{{time}}` | Current time (HH:MM:SS). |
| `{{cwd}}` | Current working directory. |
| `{{lastUserMessage}}` | The user's most recent message content. |
| `{{tools}}` / `{{selectedTools}}` | Comma-separated list of active tool names. |
| `{{activeModel}}` | Reserved — currently renders empty. |

User-defined variables from the preset's `variables` field are also available as `{{name}}` and take precedence over custom-registered macros.

## Resource Policies

The `tools` and `skills` top-level fields control visibility:

```json
{
  "tools": { "deny": ["edit", "write", "bash"] },
  "skills": { "allow": ["diagnose", "tdd"] }
}
```

- `allow` — only these resources are visible to the model.
- `deny` — all resources except these are visible.
- Values are glob patterns: `"bash*"`, `"*"`, `"read"`.

## Defaults

```json
{
  "defaults": {
    "slotFormat": "plain",
    "syntheticMessagesVisible": false,
    "unresolvedMacroPolicy": "warn"
  }
}
```

| Field | Default | Description |
|---|---|---|
| `slotFormat` | `"plain"` | Default `format` for all slot items. |
| `syntheticMessagesVisible` | `false` | Whether Pi's internal branch/continue messages appear in chat-history. |
| `unresolvedMacroPolicy` | `"keep"` | How to handle `{{macros}}` that don't resolve: `"keep"`, `"warn"`, or `"error"`. |

## Examples

### Full Replacement: Writer

`.pi/prompt-presets/writer.json` replaces the entire system prompt with a creative writing persona. Chat-history is placed before the latest user message to simulate turn-by-turn conversation:

```json
{
  "schemaVersion": 1,
  "id": "writer",
  "name": "Creative Writer",
  "items": [
    { "kind": "block", "id": "persona", "role": "system", "content": "You are a creative writing partner..." },
    { "kind": "slot", "id": "tools", "slot": "tools", "options": { "onlyWithSnippets": true } },
    { "kind": "slot", "id": "context", "slot": "project-context" },
    { "kind": "slot", "id": "cwd", "slot": "date-cwd" },
    { "kind": "slot", "id": "chat", "slot": "chat-history", "options": { "omitLatestUser": true } },
    { "kind": "block", "id": "latest-msg", "role": "user", "content": "{{lastUserMessage}}" }
  ]
}
```

### Read-Only: Code Reviewer

`.pi/prompt-presets/reviewer.json` denies write tools and only injects a review block with custom guidelines — no tools section, no project context:

```json
{
  "schemaVersion": 1,
  "id": "reviewer",
  "name": "Strict Code Reviewer",
  "tools": { "deny": ["edit", "write", "bash"] },
  "items": [
    {
      "kind": "block", "id": "role", "role": "system",
      "content": "You are in strict code review mode..."
    },
    {
      "kind": "slot", "id": "guidelines", "slot": "tool-guidelines",
      "options": { "heading": "Review Guidelines:", "includePiDefaultGuidelines": false }
    }
  ]
}
```

## Commands

| Command | Description |
|---|---|
| `/preset` | List all loaded presets with diagnostics badges. |
| `/preset <id>` | Switch to the preset with that ID. |
| `/prompt` | Show the full compiled messages array that would be sent to the model. |
| `/prompt tools` | Show the active tool definitions and their JSON schemas. |

## Loading Rules

- Presets are loaded from `.pi/prompt-presets/*.json` relative to the project root.
- `/reload` re-reads the directory, picking up new, modified, or removed presets.
- On startup, the first preset with `autoActivate: true` (default) that has no validation errors is selected.
- A preset with errors (parse failure, duplicate IDs, invalid structure) is skipped by `chooseDefaultPreset` and marked with an error badge in `/preset` listing.
- Duplicate `id` values across files produce an error on all duplicates; only the first is usable.

## Diagnostics

When Pi loads a preset, it validates the structure and collects diagnostics. Run `/preset` to see error/warning counts:

```
Prompt presets:
  pi-default
  writer
  reviewer
  broken-preset [2e/1w]
```

Use `/preset` to verify your preset loaded cleanly before switching to it.