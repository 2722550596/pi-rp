# Opening Presets

Opening presets seed a "cold open" into a session: a batch of messages plus optional initial state from a single JSON file. They replace the manually typed first prompt — write the scene once, apply it to any session.

This is the generic core: there is no process-role concept here. Every message and every state namespace in a preset applies to the current session as-is. Deployments that need role-specific seeding transform the preset before applying it.

## Locations

- Project: `.pi/openings/<id>.json`
- Override: `PI_OPENINGS_DIR=/path/to/dir`

The preset id is the file name without the `.json` extension. There is no global openings directory — openings are project-scoped by default.

## Quick Start

Create `.pi/openings/tavern.json`:

```json
{
  "name": "The Crooked Tavern",
  "description": "Fantasy opening. A stranger slides a sealed letter across your table.",
  "messages": [
    {
      "role": "assistant",
      "content": "The fire had burned low, and the rain outside had not stopped since dusk.\n\nThe stranger sat down across from you without asking, set a sealed letter on the table, and pushed it over..."
    }
  ],
  "state": {
    "quest": { "stage": 1, "letterOpened": false }
  }
}
```

Apply it with `/opening tavern`, or launch a fresh session with `PI_OPENING=tavern pi`. Inspect seeded messages in the session tree with `/tree`.

## Schema

### Top-Level Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | no | Human-readable name, shown by `/opening` (falls back to the id). |
| `description` | string | no | One-line description, shown by `/opening`. |
| `messages` | array | no | Ordered messages to seed (see below). |
| `state` | object | no | State subtrees keyed by namespace (see [State Seeding](#state-seeding)). |

### Messages

Each entry in `messages` is either a **real message** (`role`) or a **custom message** (`customType`) — the two are mutually exclusive.

| Field | Type | Description |
|---|---|---|
| `role` | `"user"` \| `"assistant"` | Appended as a real message entry (LLM context, TUI). |
| `customType` | string | Sent as a custom message of this type. How the type is converted for a given model is owned by the extension that declares it. |
| `content` | unknown | Message content. Coerced to a string when applied. |
| `display` | boolean | Custom messages only. Whether the message is visible in the TUI. Default `true`. |
| `details` | object | Custom messages only. Free-form payload (e.g. a target entity id). |

Entries with neither `role` nor `customType` are skipped with a warning.

## State Seeding

The `state` object maps state namespaces to subtrees. Each subtree is flattened into leaf paths, and every leaf is applied one by one with `updateState(path, "replace", value)`:

- Nested objects are walked recursively.
- Arrays and scalars are leaves — they replace the target path as a whole.
- Leaves rejected by a state schema are warned about and skipped; the rest still apply.

This means a preset can partially initialize state: namespaces and paths absent from the preset keep whatever the session already has.

```json
{
  "state": {
    "quest": { "stage": 1 },
    "party.members": ["rin", "shen"]
  }
}
```

Applies `quest.stage = 1` and replaces `party.members` wholesale, without touching anything else under `quest` or `party`.

## Applying

### `/opening [<id>]`

- `/opening` with no argument lists all presets in the openings directory as `name (id) — description`.
- `/opening <id>` applies a preset explicitly. This works even when the session already has messages — seeded entries are appended to the existing conversation. Each application writes an `opening` audit entry into the session file.

### `PI_OPENING` auto-apply

When the `PI_OPENING` environment variable is set, the preset is applied automatically on session start — but only if the session has no message entries yet (a fresh session bootstrap). Resume and reload hit the message guard and become no-ops, so launchers can leave the variable set for a save without re-seeding on every restart.

```bash
PI_OPENING=tavern pi
```

The variable is read per session start, so `/reload` re-applies only to still-empty sessions.

### Bash completion

`/opening <Tab>` completes against preset ids in the current project.

## See Also

- [Prompt presets](prompt-presets.md) — system prompt composition; opening presets pair with them for scenario bootstrapping.
- [State schemas](state-schemas.md) — validating the state paths that opening presets write.
