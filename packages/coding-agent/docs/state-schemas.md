# State Schemas

State schemas enforce structural constraints on conversation state managed by the `state_update` tool. They validate state writes before they're persisted, ensuring data integrity in RPG sessions, interactive fiction, or any scenario where structured state matters.

The system has two layers:

- **Schema** (static): TypeBox validates structure, types, and value ranges
- **Custom validators** (runtime): `.ts` files that run arbitrary logic — clamp values, enforce cross-field invariants, or reject writes

Schemas are **not** immutable session properties. They're runtime constraints you load, unload, and swap freely — just like presets.

## Quick Start

Create a schema file in `.pi/schemas/`:

```typescript
// .pi/schemas/character.ts
import { Type } from "typebox";

export default Type.Object({
  name: Type.String(),
  hp: Type.Number({ minimum: 0 }),
  max_hp: Type.Number({ minimum: 1 }),
  level: Type.Number({ minimum: 1 }),
});
```

In Pi, load it:

```
/schema load character
```

Or start a session with it preloaded from the CLI:

```bash
pi --schema character --strict
```

Now `state_update` calls to `character.*` paths are validated:

| Operation | Result |
|---|---|
| `state_update character.hp -> 50` | Accepted (0 <= 50) |
| `state_update character.hp -> -5` | Rejected (minimum: 0) |
| `state_update character.level -> 0` | Rejected (minimum: 1) |
| `state_update notes.todo -> "buy milk"` | Accepted (no schema for `notes`) |

Add a custom validator to clamp HP overflow:

```typescript
// .pi/validators/character-clamp.ts
export const validators = [
  {
    namespace: "character",
    path: "hp",
    validate(value, _path, state) {
      if (typeof value === "number" && state.max_hp !== undefined) {
        return Math.min(Math.max(0, value), state.max_hp);
      }
      return value;
    },
  },
];
```

Now `state_update character.hp -> 999` clamps to `max_hp` instead of being rejected.

## Concepts

### Namespaces

Each schema declares a **namespace** — the top-level key in the state tree it governs. The namespace defaults to the filename (without extension), or you can set it explicitly:

```typescript
// Default: namespace = "character"
export default Type.Object({ hp: Type.Number() });

// Explicit: namespace = "persona"
export default {
  namespace: "persona",
  schema: Type.Object({ hp: Type.Number() }),
};
```

A path like `persona.character.hp` routes to the `persona` namespace — the schema validates the entire namespace subtree, not just the mutated key.

Multiple schemas can coexist in different namespaces:

```
/schema load character    # namespace: character
/schema load world        # namespace: world
/schema load inventory    # namespace: inventory
```

Loading a schema into an already-occupied namespace replaces the previous one silently. Two schemas can't share a namespace, but they don't need to.

### Validation Layers

**Schema validation** runs first. It checks the projected namespace subtree (current state + the pending mutation) against the compiled TypeBox validator. If it fails, the write is rejected with a human-readable error.

**Custom validators** run second. Each validator matches on `namespace` + `path` (dot notation within the namespace, `"*"` for all paths). Validators can:

- **Accept** the value unchanged (return it)
- **Correct** the value (return a modified version)
- **Reject** the write (return `null`)

The corrected value from one validator feeds into the next matching validator. The final corrected value is what gets persisted.

### Strict Mode

When strict mode is on, writes to paths **not covered by any loaded schema** are rejected:

```
/schema strict          # enable
/schema strict off      # disable
/schema list            # shows active schemas + [strict] if enabled
```

Without strict mode (default), uncovered paths are freeform — the model can write anything to them.

Strict mode can also be enabled at startup by combining the CLI flags: `pi --schema <id> --strict` loads the schema and enables strict mode before the first turn.

### Default Values & Initial State

TypeBox `default` keywords double as initial state. On `/schema load`, the system generates an object from the schema's defaults (TypeBox `Create()`) and seeds it into state — no `state_update` needed:

```typescript
export default Type.Object({
  name: Type.String({ default: "无名" }),
  hp: Type.Number({ default: 100 }),
  level: Type.Number({ default: 1 }),
});
```

`/schema load character` immediately seeds `character.name = "无名"`, `character.hp = 100`, `character.level = 1` into state.

The seed is **fill-missing only**: existing keys are never overwritten. Values already written survive a schema reload; only keys absent from state receive their defaults. Nested objects are filled recursively the same way. Session recovery behaves identically — schemas restored from `schema_change` entries re-seed defaults for any keys missing from the restored state.

This pairs naturally with validation: seeded defaults are valid by construction, so the model can start mutating state right away. `Optional` fields get no default and are omitted until written.

## Schema Files

### Locations

| Scope | Path |
|---|---|
| Global | `~/.pi/agent/schemas/*.ts` |
| Project | `.pi/schemas/*.ts` |

When a project schema and a global schema share the same filename, the global version takes priority (the first match wins). Changes take effect on `/reload` or restart.

### TypeScript Schemas

Use TypeBox to define schemas with full type safety and IntelliSense:

```typescript
import { Type } from "typebox";

// Define reusable sub-schemas
const Attributes = Type.Object({
  strength: Type.Number({ default: 10 }),
  dexterity: Type.Number({ default: 10 }),
  constitution: Type.Number({ default: 10 }),
  intelligence: Type.Number({ default: 10 }),
  wisdom: Type.Number({ default: 10 }),
  charisma: Type.Number({ default: 10 }),
});

const StatusEffect = Type.Object({
  name: Type.String(),
  duration: Type.Number({ minimum: 0 }),
  source: Type.Optional(Type.String()),
});

// Export as default (namespace = filename)
export default Type.Object({
  name: Type.String(),
  hp: Type.Number({ minimum: 0 }),
  max_hp: Type.Number({ minimum: 1 }),
  mp: Type.Optional(Type.Number({ minimum: 0 })),
  max_mp: Type.Optional(Type.Number({ minimum: 0 })),
  level: Type.Number({ minimum: 1 }),
  attributes: Attributes,
  status_effects: Type.Optional(Type.Array(StatusEffect)),
}, { additionalProperties: true });
```

The default export can be:

- A bare `TSchema` object (namespace = filename)
- An object `{ namespace: string, schema: TSchema }` (explicit namespace)

## Custom Validators

Custom validators are `.ts` files that run arbitrary logic after schema validation. They're loaded from:

| Scope | Path |
|---|---|
| Global | `~/.pi/agent/validators/*.ts`, `*.js` |
| Project | `.pi/validators/*.ts`, `*.js` |

### Validator Interface

```typescript
interface CustomValidator {
  namespace: string;   // Which schema namespace this applies to
  path: string;        // Dot-notation path within the namespace, "*" for all
  validate: (
    value: JsonValue | undefined,  // The value being written
    path: string,                  // Full dot-notation path within the namespace
    state: Readonly<JsonValue>,    // Readonly PRE-WRITE snapshot of the namespace subtree
  ) => JsonValue | null;           // Return corrected value, or null to reject
}
```

### Export Format

The module can export validators in three ways:

```typescript
// 1. Named export (preferred)
export const validators: CustomValidator[] = [...];

// 2. Default array export
export default [...];

// 3. Default object with validators key
export default { validators: [...] };
```

### Examples

**Clamp a value to a range:**

```typescript
export const validators = [
  {
    namespace: "character",
    path: "hp",
    validate(value, _path, state) {
      if (typeof value !== "number") return value;
      const max = (state as any).max_hp ?? Infinity;
      return Math.min(Math.max(0, value), max);
    },
  },
];
```

**Cross-field invariant — reject if mana exceeds intelligence * 10:**

```typescript
export const validators = [
  {
    namespace: "character",
    path: "mp",
    validate(value, _path, state) {
      if (typeof value !== "number") return value;
      const attrs = (state as any).attributes;
      const intel = attrs?.intelligence ?? 10;
      if (value > intel * 10) return null; // reject
      return value;
    },
  },
];
```

**Auto-calculate derived stats:**

```typescript
export const validators = [
  {
    namespace: "character",
    path: "*",
    validate(value, _path, state) {
      // When any field changes, update derived stats
      // NOTE: `state` is a PRE-WRITE snapshot of the namespace subtree.
      // It does NOT reflect the pending mutation yet - the value being
      // written is passed as the `value` argument, not in `state`.
      // Return the value unchanged - we're just doing side-effect computation
      // (Note: you'd need to call state_update for the derived stat in a real ext)
      return value;
    },
  },
];
```

## Commands

| Command | Description |
|---|---|
| `/schema list` | Show active schemas and strict mode status |
| `/schema load [id]` | Load a schema by filename (without extension). With no argument, lists available schemas. |
| `/schema unload <ns>` | Unload a schema by namespace |
| `/schema strict` | Enable strict mode |
| `/schema strict off` | Disable strict mode |
| `/validator list` | Show loaded custom validators (namespace + path for each) |
| `/state [path]` | Show conversation state, optionally at a specific path. Tab-completes from current state keys. |

Schema load/unload is recorded as `schema_change` entries and strict mode toggles as `strict_change` entries in the session tree, just like `preset_change`. On session recovery, these entries are replayed in reverse order (latest action per namespace wins for schemas; latest `strict_change` wins for strict mode), and schema defaults are reapplied to fill any missing keys. `/reload` re-reads schema and validator files from disk and re-applies the session's schema/strict entries, so file changes take effect without restarting.

## The `get_state` Tool

In addition to `state_update`, pi-rp provides `get_state` — a read-only tool the LLM can call to inspect current state without modifying it:

```
> get_state
> (no path)
Response: {"character": {"name": "无名", "hp": 100, "level": 1}}
```

Pass an optional path to read a subtree:

```
> get_state character.hp
Response: 100
```

Both `state_update` and `get_state` are active by default in SDK sessions.

### Path Notation

Paths support both dot notation (`character.hp`) and JSON Pointer (`/character/hp`). Both are equivalent — use whichever is more natural.

## Extension Integration

Extensions can read and subscribe to state changes via the ExtensionAPI:

| Method | Description |
|---|---|
| `pi.getState(path?)` | Read the current state snapshot, optionally at a specific path. |
| `pi.subscribeState(handler)` | Register a callback invoked on every state change. Receives `(path, value, previousValue)`. |

```ts
export default function (pi: ExtensionAPI) {
  pi.subscribeState((path, value, prev) => {
    if (path === "character.hp" && value < 10) {
      pi.ui.notify("Low HP!", "warn");
    }
  });
}
```

### Tab Completion

Both `/state` and `/schema` commands support tab completion:

- `/state` — completes dot-separated paths by walking the current state tree, with type-aware descriptions (`{...}`, `[...]`, `42`, `"str"`).
- `/schema` — completes subcommands (`list`, `load`, `unload`, `strict`), schema IDs for `load`, namespaces for `unload`, and `off` for `strict`.

## Validation Pipeline

When the model calls `state_update`, the following happens in order:

1. **Schema validation** — the projected namespace subtree is checked against the compiled TypeBox validator. If it fails, the write is rejected with an error message including the specific validation failures.

2. **Custom validators** - matching validators (by `namespace` + `path`) run in sequence. Each receives the value from the previous validator, along with a **pre-write** snapshot of the namespace subtree (`state`). The pending mutation is NOT yet reflected in `state` - it is passed separately as `value`. If any validator returns `null`, the write is rejected.

3. **Persist** — if both layers pass, the (possibly corrected) value is applied to the state and persisted as a `state` session entry.

For `merge` operations (bulk writes), each namespace subtree is validated independently. In strict mode, merge keys that don't map to any loaded schema are rejected.

### Error Messages

Schema validation errors include the `instancePath` (where in the subtree the error occurred) and a human-readable message:

```
Schema validation failed for "character": /hp: Expected number to be greater or equal to 0
```

Custom validator rejections are simpler:

```
Custom validator rejected write to "character.mp"
```

## Complete Example: RPG Character + Inventory

**Schema files:**

```typescript
// .pi/schemas/character.ts
import { Type } from "typebox";

const Attributes = Type.Object({
  strength: Type.Number({ minimum: 0 }),
  dexterity: Type.Number({ minimum: 0 }),
  constitution: Type.Number({ minimum: 0 }),
  intelligence: Type.Number({ minimum: 0 }),
  wisdom: Type.Number({ minimum: 0 }),
  charisma: Type.Number({ minimum: 0 }),
});

export default Type.Object({
  name: Type.String(),
  hp: Type.Number({ minimum: 0 }),
  max_hp: Type.Number({ minimum: 1 }),
  mp: Type.Number({ minimum: 0 }),
  max_mp: Type.Number({ minimum: 0 }),
  level: Type.Number({ minimum: 1 }),
  attributes: Attributes,
  status_effects: Type.Optional(Type.Array(Type.Object({
    name: Type.String(),
    duration: Type.Number({ minimum: 0 }),
  }))),
}, { additionalProperties: true });
```

```typescript
// .pi/schemas/inventory.ts
import { Type } from "typebox";

export default Type.Object({
  gold: Type.Number({ minimum: 0 }),
  items: Type.Array(
    Type.Object({
      id: Type.String(),
      name: Type.String(),
      quantity: Type.Integer({ minimum: 1 }),
      type: Type.Union([
        Type.Literal("weapon"),
        Type.Literal("armor"),
        Type.Literal("consumable"),
        Type.Literal("key"),
        Type.Literal("misc"),
      ]),
    }),
  ),
}, { additionalProperties: true });
```

**Custom validators:**

```typescript
// .pi/validators/character-guards.ts
export const validators = [
  {
    namespace: "character",
    path: "hp",
    validate(value, _path, state) {
      if (typeof value !== "number") return value;
      const max = (state as any).max_hp ?? 9999;
      return Math.min(Math.max(0, value), max);
    },
  },
  {
    namespace: "character",
    path: "mp",
    validate(value, _path, state) {
      if (typeof value !== "number") return value;
      const max = (state as any).max_mp ?? 9999;
      return Math.min(Math.max(0, value), max);
    },
  },
  {
    namespace: "character",
    path: "level",
    validate(value, _path, state) {
      // Level can only increase, never decrease
      if (typeof value !== "number") return value;
      const current = (state as any).level ?? 0;
      return value < current ? null : value;
    },
  },
];
```

**Usage in session:**

```
/schema load character
/schema load inventory
/schema strict

# Now the model can only write to character.* and inventory.* paths
# HP, MP are clamped; level can't decrease; gold can't go negative
```