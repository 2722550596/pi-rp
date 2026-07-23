# Prompt Presets

Prompt presets replace Pi's built-in system prompt with a composable, reorderable definition in JSON. They control what goes into the model's context window: system instructions, tool listings, project context, conversation history placement, and synthetic user/assistant messages — all in one flat message array.

Presets are `.json` files placed in either the global or project directory. Pi loads them on startup and on `/reload`.

## Locations

- Global: `~/.pi/agent/prompt-presets/*.json`
- Project: `.pi/prompt-presets/*.json`

Global presets are available to all projects. Project presets override global ones with the same `id`. Pi loads from both directories and merges them, with project files taking priority.

## Quick Start

Create `.pi/prompt-presets/simple.json`:

```json
{
  "schemaVersion": 1,
  "id": "simple",
  "items": [
    { "kind": "block", "id": "role", "content": "You are a helpful coding assistant." },
    { "kind": "slot", "id": "tools", "slot": "tools" },
    { "kind": "slot", "id": "chat", "slot": "chat-history" }
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
| `mode` | `"replace"`, `"append"`, `"prepend"` | no | How this preset merges with Pi's base. `"replace"` discards the default. |
| `defaults` | object | no | Default slot options (see [Defaults](#defaults)). |
| `tools` | object | no | Filter tool visibility (see [Resource Policies](#resource-policies)). |
| `skills` | object | no | Filter skill visibility (see [Resource Policies](#resource-policies)). |
| `variables` | object | no | Static variable values available as `{{name}}` in block content. |
| `items` | array | yes | Ordered list of items composing the prompt. |

### Items

Each item is either a **block** (static text) or a **slot** (dynamic content rendered at compile time).

#### Block Item

```json
{ "kind": "block", "id": "my-rule", "role": "system", "content": "Be concise." }
```

| Field | Type | Required | Description |
|---|---|---|---|
| `kind` | `"block"` | yes | Must be `"block"`. |
| `id` | string | yes | Unique within the preset. |
| `name` | string | no | Display name for diagnostics. |
| `enabled` | boolean | no | Set to `false` to skip. Default `true`. |
| `role` | string | no | Message role: `"system"`, `"user"`, `"assistant"`, `"custom"`. Default `"system"` (when omitted). |
| `content` | string | yes | Prompt text. Supports `{{macro}}` expansion. |

#### Slot Item

```json
{ "kind": "slot", "id": "tools", "slot": "tools", "options": { "onlyWithSnippets": true } }
```

| Field | Type | Required | Description |
|---|---|---|---|
| `kind` | `"slot"` | yes | Must be `"slot"`. |
| `slot` | string | yes | One of the [built-in slots](#built-in-slots) or a custom extension slot. |
| `name` | string | no | Display name for diagnostics. |
| `enabled` | boolean | no | Default `true`. |
| `role` | string | no | Slot output role. Default `"system"`. |
| `options` | object | no | Slot-specific options (see per-slot docs below). |

### Compilation Model

All items are compiled into a **single flat message array**, in order:

- `block` items produce one message with the item's role and content
- `slot` items render dynamic text at the item's position
- `chat-history` slot injects the real conversation at its position
- Consecutive messages with the same role are automatically merged into one (e.g. adjacent `[system]` blocks become one `[system]` with `\n\n` separation)

This message array is sent to the model. System-role messages are extracted by the provider adapter into the API-specific system field (e.g. Anthropic `system`, Google `systemInstruction`) where needed; on OpenAI they are passed as-is.

Examples:

```
items: [system, system, user, assistant, system]
output: [system(merged), user, assistant, system]
```

```
items: [system, chat-history, user/assistant({{lastUserMessage}})]
output: [system, <real conversation>, latest-user-message]
```

## Built-in Slots

### `tools`

Renders each active tool with its prompt snippet.

| Option | Type | Default | Description |
|---|---|---|---|
| `onlyWithSnippets` | boolean | `true` | Only show tools with a prompt snippet. |
| `format` | `"plain"`, `"json"` | `"plain"` | Output format. |

### `tool-guidelines`

Renders usage rules for the active tool set.

| Option | Type | Default | Description |
|---|---|---|---|
| `heading` | string | `"Guidelines:"` | Section heading. |
| `includePiDefaultGuidelines` | boolean | `true` | Include Pi's built-in defaults. |
| `format` | `"plain"`, `"json"` | `"plain"` | Output format. |

### `project-context`

Renders context files (`CONTEXT.md` settings) wrapped in `<project_context>` tags.

### `skills`

Renders available skill descriptions.

| Option | Type | Default | Description |
|---|---|---|---|
| `requireReadTool` | boolean | `true` | Only render skills when `read` tool is active. |

### `append-system-prompt`

Renders user-appended system prompt content (from settings or `--system-prompt`).

### `pi-docs`

Injects Pi documentation paths for self-referential questions about Pi itself.

### `date`

| Option | Type | Default | Description |
|---|---|---|---|
| `includeTime` | boolean | `false` | Also show current time. |

### `cwd`

Current working directory.

### `date-cwd`

Working directory line (alias for `cwd` with different label for legacy compat).

### `active-model`

Reserved. Currently renders empty.

### `chat-history`

The conversation insertion point. This slot determines WHERE in the message array the real conversation appears — it does not render text itself. Omit it and the conversation is appended at the end.

| Option | Type | Default | Description |
|---|---|---|---|
| `maxMessages` | number | — | Keep only most recent N messages. |
| `maxChars` | number | — | Keep only messages within this character budget. |
| `omitLatestUser` | boolean | `false` | Drop latest user message (for re-insertion via `{{lastUserMessage}}`). |
| `stripAssistantThinking` | boolean | `false` | Remove `thinking` blocks from past assistant messages. |
| `roles` | string[] | — | Only include these roles (e.g. `["user", "assistant"]`). |
| `toolMode` | `"keep"`, `"drop"` | `"keep"` | Keep or discard tool call/result messages. |
| `includeSummaries` | boolean | `false` | Include Pi's branch/compaction summaries. |

### `variables`

Renders runtime variable key-value pairs.

## Macros

In block `content` fields, wrap a macro name in `{{}}` to expand it at compile time. Macros support an optional `:params` suffix: `{{name:params}}`.

### Built-in Macros

| Macro | Description | Static |
|---|---|---|
| `{{date}}` | Current date (YYYY-MM-DD). | yes |
| `{{time}}` | Current time (HH:MM:SS). | yes |
| `{{cwd}}` | Current working directory. | yes |
| `{{lastUserMessage}}` | The user's most recent message content. | yes |
| `{{tools}}` / `{{selectedTools}}` | Comma-separated active tool names. | yes |
| `{{activeModel}}` | Reserved. | yes |
| `{{user}}` | User display name (from `settings.json` `userName`). | no |
| `{{setvar::key::value}}` | Set a session variable. | no |
| `{{addvar::key::value}}` | Append text to a session variable. | no |
| `{{getvar::key}}` | Read a session variable. | no |
| `{{trim}}` | Remove surrounding whitespace from adjacent text. | no |
| `{{//…}}` | Comment — stripped entirely from output. | — |

**Static vs Dynamic**: A `static` macro is expanded once when the preset is compiled. A dynamic macro (default, no `static: true`) is re-expanded each turn. This matters for macros like `{{roll:1d100}}` that should produce a fresh value on every LLM call.

### Variable Macros (SillyTavern-style)

```
{{setvar::name::value}}     → sets variable "name" to "value", renders empty
{{addvar::name::text}}      → appends "text" to variable "name", renders empty
{{getvar::name}}            → renders the current value of "name"
```

These work together to build dynamic prompts:

```
{{setvar::lang::法语}}{{setvar::min::1500}}{{setvar::max::2000}}
请使用{{getvar::lang}}，字数{{getvar::min}}-{{getvar::max}}
```

Variables are scoped to the current `PromptRuntime` (one per turn). `{{setvar}}` and `{{addvar}}` render empty so they can be placed anywhere in the prompt without producing visible output.

### User Name

`{{user}}` reads from `settings.json`:

```json
{ "userName": "Mingyue" }
```

Default value is `"user"`. Set it globally at `~/.pi/agent/settings.json` or per-project at `.pi/settings.json`.

### Comments

Anything inside `{{//…}}` is stripped from the output entirely:

```
{{//这个prompt用于创作}}{{trim}}
```

### Nesting

Macros use a depth-tracking parser (not regex) so nested macros work safely:

```
{{setvar::lang::{{user}}的语言}}  → inner {{user}} expanded first → {{setvar::lang::Mingyue的语言}}
```
## Custom Slots via Extension

Extensions can register custom slots with `pi.registerSlot()`:

```ts
import type { ExtensionAPI, SlotDefinition, SlotRenderContext } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerSlot({
    name: "my-slot",
    description: "Custom slot description",
    render: (ctx: SlotRenderContext): string => {
      // ctx.runtime.options — build system prompt options
      // ctx.preset           — the active preset
      // ctx.item             — the slot item with its options
      // ctx.diagnostics      — push warnings/errors here
      return `<custom>\ndynamic content\n</custom>`;
    },
  });
}
```

Then use it in a preset:

```json
{ "kind": "slot", "id": "my-block", "slot": "my-slot", "options": { "key": "value" } }
```

The slot's render function receives `ctx.item.options` for the options passed in the preset.

## Resource Policies

The `tools` and `skills` top-level fields filter visibility using glob patterns:

```json
{
  "tools": { "deny": ["edit", "write", "bash"] },
  "skills": { "allow": ["diagnose", "tdd"] }
}
```

- `allow` — only matching resources are visible.
- `deny` — matching resources are hidden.
- Values are glob patterns: `"bash*"`, `"*"`, `"read"`.

## Defaults

```json
{
  "defaults": {
    "slotFormat": "plain",
    "syntheticMessagesVisible": false,
    "unresolvedMacroPolicy": "keep"
  }
}
```

| Field | Default | Description |
|---|---|---|
| `slotFormat` | `"plain"` | Default `format` for slot items without explicit format. |
| `syntheticMessagesVisible` | `false` | Whether Pi's internal branch/continue messages appear in chat-history. |
| `unresolvedMacroPolicy` | `"keep"` | `"keep"` — leave as text, `"warn"` — add diagnostic, `"error"` — fail compile. |

## Examples

### Full Replacement: Writer

Places chat-history before the latest user message to simulate natural turn flow:

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
    { "kind": "block", "id": "latest", "role": "user", "content": "{{lastUserMessage}}" }
  ]
}
```

Compiled output: `[system persona+tools+context+cwd] [real conversation] [user: lastUserMessage]`

### Read-Only: Code Reviewer

Denies write tools and outputs only a review block with custom guidelines:

```json
{
  "schemaVersion": 1,
  "id": "reviewer",
  "name": "Strict Code Reviewer",
  "tools": { "deny": ["edit", "write", "bash"] },
  "items": [
    { "kind": "block", "id": "role", "role": "system", "content": "You are in strict code review mode..." },
    { "kind": "slot", "id": "guidelines", "slot": "tool-guidelines",
      "options": { "heading": "Review Guidelines:", "includePiDefaultGuidelines": false } }
  ]
}
```

### Assistant Message in System Block

The unified message array preserves the position of user/assistant role items even when placed between system items:

```json
{
  "schemaVersion": 1, "id": "mixed",
  "items": [
    { "kind": "block", "id": "a", "content": "System instruction 1" },
    { "kind": "block", "id": "b", "role": "assistant", "content": "Example response" },
    { "kind": "block", "id": "c", "content": "System instruction 2" },
    { "kind": "slot", "id": "chat", "slot": "chat-history" }
  ]
}
```

Compiled output: `[system: A] [assistant: B] [system: C] [real conversation]`

### Lore Slot (Extension)

A custom slot that reads markdown files from disk, strips frontmatter, and wraps them in `<lore_item>` tags:

```json
{ "kind": "slot", "id": "lore", "slot": "lore" }
```

See the `lore` extension for implementation.

## Commands

| Command | Description |
|---|---|
| `/preset` | List all loaded presets with diagnostic badges. |
| `/preset <id>` | Switch to the preset with that ID. |
| `/prompt` | Show the full compiled message array. |
| `/prompt tools` | Show active tool definitions with JSON schemas. |
| `/reload` | Reload presets, extensions, skills, and settings. |

## Loading Rules

- Presets are loaded from `~/.pi/agent/prompt-presets/` (global) and `.pi/prompt-presets/` (project).
- On startup, the first valid preset with `autoActivate: true` (default) is selected.
- If no user-defined presets exist, Pi uses a built-in default preset that mirrors the legacy system prompt.
- A preset with errors (parse failure, duplicate IDs, invalid structure) is skipped during auto-activation and marked with diagnostic badges in `/preset`.
- Duplicate `id` values across files produce errors on all duplicates; the last-loaded (project) wins.
- `/reload` re-reads both directories.

## Diagnostics

Run `/preset` to see error/warning counts per preset:

```
Prompt presets:
  pi-default
  writer
  reviewer
  broken-preset [2e/1w]
```

Diagnostics are generated during loading (JSON parse, schema validation) and during compilation (unknown slots, unresolved macros with `"warn"` or `"error"` policy).