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
| `defaults` | object | no | Default slot options (see [Defaults](#defaults)). |
| `delegatable` | boolean | no | Set to `true` to allow this preset to be delegated to as a subagent via the `subagent` tool or `/subagent` command. Default `false`. |
| `inheritHistory` | number | no | Number of parent conversation messages to seed as chat history when this preset is delegated (see [Subagent Delegation](#subagent-delegation)). An explicit invocation option wins over this field. Default `0` (no history). |
| `schemas` | string[] | no | State schema IDs to load into the subagent session when this preset is delegated (see [Subagent Delegation](#subagent-delegation)). The subagent invocation's `schemas` option wins over this field. Default none. |
| `thinkingLevel` | string | no | Thinking level for this preset (`"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`). Default inherits session level. |
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
| `wrap` | string or object | no | Wrap the rendered content in a custom XML tag (see [Wrapping Items](#wrapping-items)). |

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
| `wrap` | string or object | no | Wrap the slot's rendered output in a custom XML tag (see [Wrapping Items](#wrapping-items)). |

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
items: [system, chat-history, user]
output: [system, <real conversation>, user(merged)]
```

## Wrapping Items

Both `block` and `slot` items accept a `wrap` field that wraps the rendered text in a custom XML tag — a shorthand for adding structured context markers without hand-writing the tags around every item.

```json
{ "kind": "block", "id": "role", "content": "You are the world referee.", "wrap": "context" }
```

renders as:

```xml
<context>You are the world referee.</context>
```

An object form adds attributes to the opening tag:

```json
{
  "kind": "slot",
  "id": "state",
  "slot": "state",
  "wrap": { "tag": "world_state", "attrs": { "format": "yaml" } }
}
```

renders as:

```xml
<world_state format="yaml">…slot output…</world_state>
```

Rules:

- The wrap is applied **after** `{{macro}}` expansion, so macros inside the item expand normally.
- Items that render empty are skipped entirely — no empty tag pair is emitted.
- Attribute values are XML-escaped (`&`, `<`, `>`, `"`).
- An invalid tag name (not an XML name) produces a warning diagnostic and leaves the text unwrapped.

## Built-in Slots

### `tools`

Renders each active tool with its prompt snippet.

| Option | Type | Default | Description |
|---|---|---|---|
| `onlyWithSnippets` | boolean | `true` | Only show tools with a prompt snippet. |

> **Note**: The `format` option is accepted in JSON but not yet wired into the renderer. It is reserved for future implementation; the slot currently renders plain markdown lines.

### `tool-guidelines`

Renders usage rules for the active tool set.

| Option | Type | Default | Description |
|---|---|---|---|
| `heading` | string | `"Guidelines:"` | Section heading. |
| `includePiDefaultGuidelines` | boolean | `true` | Include Pi's built-in defaults. |

> **Note**: The `format` option is accepted in JSON but not yet wired into the renderer. It is reserved for future implementation; the slot currently renders plain markdown lines.

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

Current date and working directory lines. Unlike `date` or `cwd` alone, this slot renders both: a `Current date:` line followed by a `Current working directory:` line.

### `active-model`

Reserved. Currently renders empty.

### `chat-history`

The conversation insertion point. This slot determines WHERE in the message array the real conversation appears — it does not render text itself. Omit it and no conversation history is injected at all.

| Option | Type | Default | Description |
|---|---|---|---|
| `maxMessages` | number | — | Keep only most recent N messages. |
| `maxChars` | number | — | Keep only messages within this character budget. |
| `stripAssistantThinking` | `boolean`, `"previous-traces"` | `false` | Remove `thinking` blocks from assistant messages. `true` strips every assistant message; `"previous-traces"` strips only traces (agent start to agent end) completed before the current one, keeping the current trace's thinking intact — useful in the tool-calling loop where the current round's reasoning stays coherent across turns. |
| `roles` | string[] | — | Only include these roles (e.g. `["user", "assistant"]`). |
| `toolMode` | `"keep"`, `"drop"` | `"keep"` | Keep or discard tool call/result messages. |
| `includeSummaries` | boolean | `true` | Include Pi's branch/compaction summaries. Set to `false` to exclude them. |

### `variables`

Renders runtime variable key-value pairs.

> **Note**: The `includeStatic`, `includeSession`, and `includeTurn` options are accepted in JSON but not yet wired into the renderer. They are reserved for future implementation; the slot currently renders the full runtime variable set.

### `state`

Renders the current conversation state (game stats, inventory, flags).

| Option | Type | Default | Description |
|---|---|---|---|
| `format` | `"key-value"`, `"json"`, `"yaml"` | `"key-value"` | Output format. `"yaml"` renders a nested tree so values under the same key share one parent line; `"json"` renders pretty-printed JSON. |
| `omitNamespace` | boolean | `false` | Drop the top-level namespace prefix: `magnolia.character.hp` renders as `character.hp`. Namespace contents are merged into the root, so identical inner keys from different namespaces overwrite each other (last one wins) — enable only when namespaces cannot collide (e.g. a single active schema). |
| `allowNamespace` | string[] | — | Only render these top-level namespaces (e.g. `["magnolia"]`); others are omitted. Empty or unset renders all. |

## Macros

In block `content` fields, wrap a macro name in `{{}}` to expand it at compile time. Macros support an optional `:params` suffix: `{{name:params}}`.

### Built-in Macros

| Macro | Description | Static |
|---|---|---|
| `{{date}}` | Current date (YYYY-MM-DD). | yes |
| `{{time}}` | Current time (HH:MM:SS). | yes |
| `{{cwd}}` | Current working directory. | yes |
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

### Custom Macros via Extension

Extensions can register custom macros with `pi.registerMacro()`:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerMacro({
    name: "roll",
    description: "Roll dice in NdM format. Usage: {{roll:2d6}}",
    render: (ctx) => {
      const params = ctx.params ?? "1d6";
      const [count, sides] = params.split("d").map(Number);
      let total = 0;
      for (let i = 0; i < Math.min(count, 100); i++) {
        total += Math.floor(Math.random() * sides) + 1;
      }
      return String(total);
    },
  });
}
```

Macros registered without `static: true` (the default) are re-expanded each turn, giving a fresh value each time.

**Slot render context** — custom macros receive a `MacroRenderContext` with:
- `runtime` — the full `PromptRuntime` (options, messages, skills, variables)
- `variables` — `Record<string, string>` of session variables
- `params` — the string after `:` in `{{name:params}}`, or `undefined`

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

```json
{ "kind": "slot", "id": "my-block", "slot": "my-slot", "options": { "key": "value" } }
```

The slot's render function receives `ctx.item.options` for the options passed in the preset.

**Custom options passthrough** — Options not in the built-in whitelist (`heading`, `format`, `onlyWithSnippets`, etc.) are no longer silently dropped. Any unknown key in `options` is passed through to the render function as-is. This lets extension-defined slots use arbitrary options:

```json
{
  "kind": "slot",
  "id": "filtered",
  "slot": "lore-filtered",
  "options": {
    "heading": "Key Lore",
    "maxItems": 2,
    "tag": "mechanics"
  }
}
```

The render function reads them directly from `ctx.item.options.heading`, `ctx.item.options.maxItems`, etc. No changes to pi's core are needed to support new slot-specific options.


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

**Applies to actual tool registration, not just prompt text.** When a preset with a tools policy is active, denied tools are removed from `agent.state.tools` — the model cannot call them. This applies to all tools: built-in (`edit`, `write`, `bash`), extension-registered (`quick_edit`, `code-search`, `github`), and custom tools from the SDK. The policy is re-applied after every tool registry refresh (including `/reload` and extension reloads).

## Defaults

```json
{
  "defaults": {
    "unresolvedMacroPolicy": "keep"
  }
}
```

| Field | Default | Description |
|---|---|---|
| `unresolvedMacroPolicy` | `"keep"` | `"keep"` — leave as text, `"warn"` — add diagnostic, `"error"` — fail compile. |

> **Note**: `slotFormat` and `syntheticMessagesVisible` are accepted in JSON but not yet wired into the compiler. They are reserved for future implementation.


## Regex Rules

Presets can define regex-based text transformations that run at different stages of the prompt lifecycle. This is useful for stripping markup, unwrapping content tags, or hiding metadata from the LLM or the user.

```json
{
  "regex": {
    "schemaVersion": 1,
    "rules": [
      {
        "id": "strip-comments",
        "name": "Remove HTML comments",
        "enabled": true,
        "stage": "compiled",
        "effect": "finalize",
        "pattern": "<!--[\\s\\S]*?-->",
        "replace": "",
        "flags": "g"
      },
      {
        "id": "unfold-content",
        "enabled": true,
        "stage": "compiled",
        "effect": "outgoing",
        "pattern": "<content>([\\s\\S]*?)</content>",
        "replace": "$1",
        "flags": "g"
      }
    ]
  }
}
```


### Rule Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Unique identifier within the preset. |
| `name` | string | no | Display name for diagnostics/logging. |
| `enabled` | boolean | no | Set to `false` to skip. Default `true`. |
| `stage` | `"history"`, `"compiled"` | yes | When the rule runs (see [Stages](#stages)). |
| `effect` | `"outgoing"`, `"display"`, `"both"`, `"finalize"` | no | Which pipeline(s) to apply to (see [Effects](#effects)). Default `"outgoing"`. |
| `pattern` | string | yes | JavaScript regex pattern. |
| `flags` | string | no | Regex flags (`g`, `i`, `m`, `s`, `u`). **Multi-occurrence patterns should include `g`** to transform all matches. |
| `replace` | string | no | Replacement string. Supports `$&` (full match), `$1`-`$n` (capture groups), `$<name>` (named groups), `` $` `` (pre-match), `$'` (post-match), `$$` (literal `$`). Default `""` (empty). |
| `trimStrings` | string[] | no | Remove these substrings from captures before insertion. Works with `$0`/`$&` and `$<name>`. |
| `roles` | string[] | no | Only transform messages with these roles (e.g. `["assistant"]`). |
| `targets` | `("system"|"messages")[]` | no | Only for `stage: "compiled"`. `"messages"` transforms message content; `"system"` transforms the system prompt. Default affects both. |
| `maxMessages` | number | no | Only transform the last N eligible messages. |
| `maxChars` | number | no | Only transform the last N characters of each eligible message. |
| `minDepth` | number | no | Minimum message depth from the end (0 = most recent). |
| `maxDepth` | number | no | Maximum message depth from the end. |

### Stages

| Stage | Description |
|---|---|
| `history` | Runs on the raw chat-history messages, **before** they are inserted into the compiled prompt. Useful for cleaning up old assistant output before it re-enters context. |
| `compiled` | Runs on the **final compiled message array**, after all items and chat-history have been assembled. This is the most common stage for content transformations. |

### Effects

The `effect` field controls which pipeline the rule applies to. Rules can target different pipelines independently, or combine them:

| Effect | Payload (LLM sees) | Display (TUI shows) | Storage (JSONL saves) |
|---|---|---|---|
| `outgoing` | transformed | original | original |
| `display` | original | transformed | original |
| `both` | transformed | transformed | original |
| `finalize` | original | original | transformed |

**Pipeline order**: `outgoing` + `display` run at compile time, before sending to the LLM. `finalize` runs after the LLM responds, before the message is saved to the session.

- **`outgoing`** — transforms what the LLM receives. Use for tags the model should see instructions from but not include in its response context, like `<sidestory>` blocks.
- **`display`** — transforms what the user sees in the TUI, without affecting the stored data or the LLM payload. Use for hiding internal markup from the player while keeping it in context.
- **`both`** — applies to both outgoing and display pipelines. The stored JSONL retains the original content.
- **`finalize`** — destructively rewrites the assistant's response before it is persisted. The LLM's raw output is replaced in the stored transcript. Use with caution.

### Targeting System vs Messages

By default, compiled-stage rules apply to both `system` and `messages` targets. Use `targets` to restrict:

```json
{
  "id": "system-only",
  "stage": "compiled",
  "effect": "outgoing",
  "targets": ["system"],
  "pattern": "TODO",
  "replace": ""
}
```

### Limiting Scope

Use `roles`, `maxMessages`, `maxChars`, `minDepth`, and `maxDepth` to control which messages a rule affects:

```json
{
  "id": "recent-assistant-notes",
  "stage": "compiled",
  "effect": "display",
  "roles": ["assistant"],
  "maxMessages": 5,
  "minDepth": 0,
  "maxDepth": 10,
  "pattern": "<note>[\\s\\S]*?</note>",
  "replace": ""
}
```

This strips `<note>` tags from the last 5 assistant messages between depth 0-10, only in the TUI display.

### Replacement Syntax

Beyond standard JavaScript replacement patterns, the engine supports:

| Token | Description |
|---|---|
| `$&` | Full match |
| `$0` | Full match (custom alias) |
| `$1`–`$99` | Capture group |
| `$<name>` | Named capture group |
| `` $` `` | Text before the match |
| `$'` | Text after the match |
| `$$` | Literal `$` |

When `trimStrings` is set, the engine uses a custom replacement path that trims the specified substrings from captured values before insertion:

```json
{
  "pattern": "<div class=\"secret\">([\\s\\S]*?)</div>",
  "replace": "$1",
  "trimStrings": ["\n  ", "\n"]
}
```


## Hidden Prompt Overrides

Presets can override Pi's built-in implicit prompts — messages sent to the LLM on your behalf by `/continue` and `/compact`. This is useful when the default English prompts clash with your preset's language or tone.

### Field

| Field | Type | Description |
|---|---|---|
| `hiddenOverrides` | object | Optional. Overrides for implicit prompts. |

### `continueText`

When you run `/continue`, Pi sends a short message to continue the conversation. Default: `"Continue."`.

```json
{
  "hiddenOverrides": {
    "continueText": "请继续"
  }
}
```

### `compaction`

Compaction summaries are generated by sending prompts to the LLM. All five can be overridden:

| Field | Overrides | Default |
|---|---|---|
| `systemPrompt` | The summarizer system prompt | `"You are a context summarization assistant..."` |
| `initialPrompt` | The prompt for the first summarization | Contains `{conversation}` |
| `updatePrompt` | The prompt for updating an existing summary | Contains `{conversation}` and `{previous_summary}` |
| `turnPrefixPrompt` | The prompt for a split-turn prefix | Contains `{conversation}` |
| `branchSummaryPrompt` | The prompt for summarizing an abandoned branch | Contains `{conversation}` |

### Placeholders

The four prompt fields support placeholders that are replaced at runtime:

| Placeholder | Replaced with | Available in |
|---|---|---|
| `{conversation}` | The serialized conversation (formatted as `[User]:`, `[Assistant]:`, `[Tool result]:` lines) | `initialPrompt`, `updatePrompt`, `turnPrefixPrompt`, `branchSummaryPrompt` |
| `{previous_summary}` | The text of the previous compaction summary | `updatePrompt` |

If `{conversation}` is absent from an override, the conversation is not injected at all — no wrapping tags, no implicit prefix. This gives you full control over where (and whether) the dialog text appears relative to your instructions.

Example — placing conversation and summary at custom positions:

```json
{
  "hiddenOverrides": {
    "compaction": {
      "systemPrompt": "你是一个剧情总结助手。只输出结构化摘要，不要继续对话。",
      "updatePrompt": "【已有总结】：\n{previous_summary}\n\n【最新增量对话】：\n{conversation}\n\n请根据新发生的对话内容，更新已有的剧情总结。要求：\n1. 保留关键的历史剧情节点与既定事实\n2. 更新角色的心理变化、态度转变、关系走向或最新状态\n3. 记录新获得的重要道具、线索或地点变更\n4. 移除已被解决的临时冲突，保持语言精炼且信息密度高",
      "branchSummaryPrompt": "<conversation>\n{conversation}\n</conversation>\n\n为这条分支撰写结构化总结。"
    }
  }
}
```

Any field left undefined falls through to the built-in default, which wraps the conversation in `<conversation>` tags.
## Examples

### Full Replacement: Writer

Replaces the default prompt with a dedicated writing persona:

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
    { "kind": "slot", "id": "chat", "slot": "chat-history" }
  ]
}
```

Compiled output: `[system persona+tools+context+cwd] [real conversation]`

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

A filtered variant uses custom options from the preset JSON to control output:

```json
{
  "kind": "slot",
  "id": "lore-filtered",
  "slot": "lore-filtered",
  "options": {
    "heading": "Key Lore",
    "maxItems": 2,
    "tag": "mechanics"
  }
}
```

See the `lore` extension for implementation.

## Subagent Delegation

Presets can act as specialist **subagent profiles**. Setting `"delegatable": true` exposes the preset to the `subagent` tool and `/subagent` command.

```json
{
  "schemaVersion": 1,
  "id": "code-reviewer",
  "name": "Code Reviewer Subagent",
  "description": "Specialist for reviewing code changes",
  "delegatable": true,
  "model": "anthropic/claude-sonnet-4-5",
  "thinkingLevel": "high",
  "tools": { "deny": ["edit", "write", "bash"] },
  "items": [
    { "kind": "block", "id": "role", "role": "system", "content": "You are a code reviewer. Inspect code and return structured feedback." }
  ]
}
```

### Delegation Features

- **In-Process Execution**: Subagents execute in memory using the parent session's `modelRuntime` without external CLI dependencies.
- **Tool Isolation**: Subagents run with a minimal default tool set (`read`, `grep`, `find`, `ls`, `bash`) intersected with the preset's tool policy. The default includes `bash`, so the tool set is read-only only when the preset's `tools` policy denies write tools. In peer-completion mode, the parent session's extension tools are inherited as well: their definitions are carried into the subagent session, so they are registered and executable there. What does NOT carry over is the extension *runtime* — extension event handlers (`agent_start`, `tool_result`, ...) do not fire in the subagent session, only the tool definitions. Preset tool policies (`allow`/`deny`) apply to inherited extension tools just like built-in ones, so a deny-all profile still ends up with no tools.
- **Output Truncation**: Response text is truncated using `truncateTail` before returning to the parent agent.
- **Preset Overrides**: Preset model, thinking level, and resource policies apply directly to the subagent invocation.
- **Custom Slots**: Custom slots registered by extensions are process-wide (module-level registry), so a delegatable preset that uses a custom slot renders it in subagents too — the extension only needs to have run once in the parent process; no extension runtime is loaded into the subagent session.

### Subagent Context

A subagent's context is built at **prepare time** and sealed before execution: `setInitialMessages` marks the context sealed, so the preset is never recompiled during the run. Everything the subagent sees — slot rendering, state, history — is compiled into the message array up front. State changes in the parent session during the subagent run are not visible to it.

Two modes:

- **Minimal (no parent context)** — the subagent receives only the preset's compiled items plus the task text. State slots render empty, no conversation history is injected, and system-prompt options are empty.
- **Peer completion (with parent session)** — when invoked from a parent session (always the case via the `subagent` tool and `/subagent` command), the subagent inherits from the parent:

  - **Preset discovery** — the parent session's in-memory preset list is used first; disk discovery (`~/.pi/agent/prompt-presets/` and `.pi/prompt-presets/`) is the fallback, so presets added after session start are still found.
  - **State snapshot** — `state` slots render the parent's live state via `stateManager.snapshot()`, still filtered by the slot's `allowNamespace` / `format` options.
  - **Conversation history** — the `chat-history` slot is seeded with the parent's last N messages (N is passed as the `inheritHistory` option by the caller); all chat-history slot options (`maxMessages`, `maxChars`, `roles`, `stripAssistantThinking`, `toolMode`, ...) apply as usual.
  - **System-prompt options** — the parent's skills, context files, custom prompt, appended system prompt, and prompt guidelines carry over; `selectedTools` and `toolSnippets` are filtered to the preset's post-policy tool set so a deny-all-tools profile does not leak tool descriptions.
  - **Extension tools** — the parent session's extension tool definitions are inherited (see [Delegation Features](#delegation-features)); their names join the default tool set and their snippets render in the `tools` slot unless the preset's tool policy filters them out.
  - **Schemas** — schema IDs from the preset's `schemas` field (or the invocation's `schemas` option) are loaded into the subagent session, so `get_state` semantics are correct if the profile has state access. Failed loads produce warnings, not errors.

A peer-completion preset typically combines the `state` slot (full visibility), a `chat-history` slot (inherited dialogue), and the profile's own instructions:

```json
{
  "schemaVersion": 1,
  "id": "referee",
  "name": "World Referee",
  "delegatable": true,
  "model": "anthropic/claude-sonnet-4-5",
  "thinkingLevel": "high",
  "tools": { "allow": [] },
  "schemas": ["world", "secret"],
  "items": [
    { "kind": "block", "id": "role", "role": "system", "content": "You are the referee. Answer only what the asker needs to know." },
    { "kind": "slot", "id": "state", "role": "system", "slot": "state",
      "options": { "allowNamespace": ["world", "secret"], "format": "yaml" } },
    { "kind": "slot", "id": "history", "role": "user", "slot": "chat-history",
      "options": { "maxMessages": 200 } }
  ]
}
```

### Model and Thinking Resolution

The model for a subagent run resolves as: explicit `modelRef` option → preset `model` field → first available model on the parent's runtime. Thinking level: explicit option → preset `thinkingLevel` → `"medium"`.

### Execution

`runSubagent` creates a fresh in-memory session (`SessionManager.inMemory`) and calls `createAgentSession` with the compiled messages as `initialMessages`, the effective tool set, the preset id, the inherited extension tool definitions (`customTools`), and the resolved `schemas`. It then prompts with the task text and waits for idle, returning the last assistant message truncated with `truncateTail`. An `AbortSignal` or `timeoutMs` cancels the run; results carry a status of `completed`, `failed`, `cancelled`, or `timed-out`, with the final `dispose()` cleaning up the in-memory session.

## Commands

| Command | Description |
|---|---|
| `/preset` | List all loaded presets with diagnostic badges. |
| `/preset <id>` | Switch to the preset with that ID. |
| `/preset none` | Disable presets and fall back to the built-in default prompt. |
| `/subagent` | List delegatable subagent profiles (`delegatable: true`). |
| `/subagent <profileId> <task>` | Run a subagent task using the specified delegatable preset. |
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